import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from '../../store/SqliteStore.js';
import { RunSnapshotRepository } from '../../store/RunSnapshotRepository.js';
import { WorkspaceAdmissionRepository } from '../../store/WorkspaceAdmissionRepository.js';
import { MemoryCandidateRepository } from '../../store/MemoryCandidateRepository.js';
import { RuntimeApprovalRepository } from '../../store/RuntimeApprovalRepository.js';
import { inTransaction } from '../../store/Transaction.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { createProviderExecutionChain } from './providerExecutionChain.js';

/**
 * LITE-08-005 / LITE-08-006 / LITE-08-007 / LITE-07-103 live gate.
 *
 * The four rows share one runtime-authorization chain: ASK_USER must pause the Run
 * and persist the request before any provider process exists, an accepted decision
 * must resume THAT original Run with a real invocation and produce the
 * user-explicit decision fact, a replayed decision must be idempotent, and a stale
 * or expired request must never execute.
 *
 * The in-process behaviour is already asserted with fake drivers; what these rows
 * still needed is a real Provider invocation and real decision records, so this gate
 * drives the canonical production composition root with a real CLI provider.
 *
 *   M4_P4_REAL_APPROVAL_GATE=1
 *   AGENTOS_OPENCODE_CLI=<exe> AGENTOS_OPENCODE_MODEL=<provider/model>
 *   node --import tsx --test src/services/run-engine/RuntimeApprovalGate.liveGate.test.ts
 */

const GATE = process.env.M4_P4_REAL_APPROVAL_GATE === '1';
const EXE = process.env.AGENTOS_OPENCODE_CLI;
const MODEL = process.env.AGENTOS_OPENCODE_MODEL;

const NOW = new Date().toISOString();
/** A Workspace holds ONE admission row, and a GRANTED MODIFYING admission is exactly
 *  what the single-writer invariant rations, so the two scenarios use two Workspaces. */
const WS_APPROVED = 'ws_live_approval_a';
const WS_EXPIRED = 'ws_live_approval_b';
const AGENT = 'agent_live_approval';
const STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'] as const;
/** The stage the gate drives is 'running'; the earlier ones are already completed. */
const STAGE_INDEX = 2;

const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

interface SeededRun {
  readonly runId: string;
  readonly taskId: string;
  readonly stageId: string;
  readonly operationId: string;
  readonly providerConfigId: string;
}

interface ApprovalRow {
  readonly id: string;
  readonly run_id: string;
  readonly stage_id: string | null;
  readonly status: string;
  readonly version: number;
  readonly resolution: string | null;
  readonly expires_at: string;
  readonly action_fingerprint: string;
  readonly agent_snapshot_hash: string;
  readonly provider_snapshot_hash: string;
  readonly launch_plan_hash: string;
  readonly request_snapshot_json: string;
}

test('LITE-08-005/006/007 + LITE-07-103 a real Provider runs only after a persisted approval decision',
  { skip: !GATE, timeout: 900_000 }, async () => {
    if (!EXE || !MODEL) {
      throw new Error('AGENTOS_OPENCODE_CLI and AGENTOS_OPENCODE_MODEL are required when M4_P4_REAL_APPROVAL_GATE=1');
    }

    const projectRoot = mkdtempSync(join(tmpdir(), 'agentos-live-approval-'));
    // Each Workspace owns its canonical root (the store enforces one Workspace per
    // canonical path), so every scenario gets its own directory and reviewable file.
    const workspaceRoots = new Map<string, string>();
    const createWorkspaceRoot = (workspaceId: string): string => {
      const root = join(projectRoot, 'ws-' + workspaceId);
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'port-parser.mjs'), [
        'export function parsePort(value) {',
        '  const port = Number.parseInt(value, 10);',
        '  if (Number.isNaN(port)) return null;',
        '  if (port < 1 || port > 65535) return null;',
        '  return port;',
        '}',
        '',
      ].join('\n'), 'utf8');
      workspaceRoots.set(workspaceId, root);
      return root;
    };

    const store = new SqliteStore(projectRoot);
    const db = store.getDatabase();
    try {
      const snapshotRepository = new RunSnapshotRepository(db);
      const admissions = new WorkspaceAdmissionRepository(db);
      const agentPrompt = 'Read port-parser.mjs. Then answer with the required JSON object and nothing else.';

      /** Workspace, Provider Configuration and Agent for one scenario. */
      const seedWorkspace = (workspaceId: string, providerConfigId: string): void => {
        const workspaceRoot = createWorkspaceRoot(workspaceId);
        db.prepare('INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(workspaceId, 'Live approval gate ' + workspaceId, workspaceRoot, workspaceRoot, NOW, NOW, NOW);
        db.prepare('INSERT INTO provider_configurations (id, workspace_id, name, provider_type, adapter_id, runtime_mode, capabilities_json, timeout_policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(providerConfigId, workspaceId, 'OpenCode live', 'opencode', 'builtin.opencode', 'cli', '{}', '{}', NOW, NOW);
        // `write` is what makes this Agent require a decision; a read-only Agent is
        // allowed straight through (the artifact gate covers that shape).
        db.prepare('INSERT INTO agent_profiles (id, workspace_id, name, agent_role, role_title, system_prompt, permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
          .run(AGENT, workspaceId, 'Writer', 'opencode', 'Writer', agentPrompt, '["read","write"]', EXE, '[]', NOW, NOW);
      };

      const providerSnapshotFor = (providerConfigId: string) => ({
        providerConfigId, name: 'OpenCode live', providerType: 'opencode', adapterId: 'builtin.opencode',
        runtimeMode: 'cli', executable: EXE, argsTemplate: [], model: MODEL,
        environmentProfileId: null, secretProfileId: null,
        workingDirectoryMode: 'workspace', workspaceRelativeWorkingDirectory: null,
        capabilities: {
          sessionResume: false, structuredEvents: false, nativeApprovals: false, subagents: false,
          toolEvents: false, fileEvents: false, usageEvents: false, reasoningStream: false,
          interactiveInput: false, pause: false, cancellation: true, modelSelection: true,
          workspaceAwareness: true, nativeSandbox: false, outputContracts: false,
        },
        timeoutPolicy: { discoveryTimeoutMs: 10000, validationTimeoutMs: 30000, startupTimeoutMs: 60000, idleTimeoutMs: null, totalTimeoutMs: null, cancelGracePeriodMs: 5000, approvalTimeoutMs: null },
        approvalMode: 'agentos', outputMode: 'parsed-text', enabled: true, version: 1,
      });
      const agentSnapshotFor = (providerConfigId: string) => ({
        agentId: AGENT, name: 'Writer', role: 'opencode', roleTitle: 'Writer',
        systemPrompt: agentPrompt,
        permissions: ['read', 'write'], providerConfigId, enabled: true, version: 1,
      });

      const seedRun = (workspaceId: string, providerConfigId: string, suffix: string, opChar: string): SeededRun => {
        const runId = `run_${suffix}`;
        const taskId = `task_${suffix}`;
        const operationId = 'op_' + opChar.repeat(26);
        const providerSnapshot = providerSnapshotFor(providerConfigId);
        const agentSnapshot = agentSnapshotFor(providerConfigId);
        db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
          .run(taskId, workspaceId, 'Write to the parser', 'open', 'live-gate', NOW, NOW);
        db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, next_event_sequence, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)')
          .run(runId, workspaceId, taskId, runId, 'running', 'initial', 'v2_api', 'live-gate', NOW, NOW);
        // The Run is already past startup (its stage is claimed), so the persisted
        // authorization row is a completed run.start with its real timestamps - the
        // shape the dispatcher requires before it will dispatch a running Run.
        db.prepare('INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, started_at, completed_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
          .run(operationId, 'run.start', 'completed', workspaceId, 'run', runId, runId, operationId, NOW, NOW, NOW, NOW);
        const snapshot = snapshotRepository.insert({
          workspaceId,
          runId,
          workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
          payload: {
            schemaVersion: 2,
            capturedAt: NOW,
            run: { workspaceId, taskId, origin: 'v2_api', reason: 'initial', parentRunId: null, rootRunId: runId },
            workflow: {
              definitionId: M3_013_LEGACY_WORKFLOW_V2_ID, definitionKey: 'legacy-pipeline', definitionVersion: 2,
              name: 'legacy-pipeline-v2', definitionHash: '9ea35ef455c5fefa45d0b28d1433933b2cc6b3fb9e412b4d4452afb7862a6b6d',
              worktreeMode: 'preferred',
              stages: STAGE_KEYS.map((key, index) => ({
                workflowStageKey: key, name: key, sequence: index + 1, agent: agentSnapshot, provider: providerSnapshot,
                dependsOn: index === 0 ? [] : [STAGE_KEYS[index - 1]],
              })),
            },
            security: { redactionApplied: false },
          } as never,
        });
        const stageIds: string[] = [];
        STAGE_KEYS.forEach((key, index) => {
          const stageId = `stage_${suffix}_${index}`;
          stageIds.push(stageId);
          db.prepare('INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, started_at, completed_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 1)')
            .run(stageId, workspaceId, runId, snapshot.id, key, key, index + 1,
              index < STAGE_INDEX ? 'completed' : index === STAGE_INDEX ? 'running' : 'pending',
              index <= STAGE_INDEX ? NOW : null, index < STAGE_INDEX ? NOW : null, NOW, NOW);
        });
        admissions.insertAdmission({
          id: `adm_${suffix}`, workspaceId, subjectKind: 'CANONICAL_RUN', canonicalRunId: runId, legacyRunId: null,
          requestedMutationClass: 'MODIFYING', effectiveMutationClass: 'MODIFYING', enforcementEvidenceJson: null,
          requestOrder: 1, state: 'GRANTED', queueReason: null, releaseReason: null,
          requestedAt: NOW, grantedAt: NOW, releasedAt: null, createdAt: NOW, updatedAt: NOW, version: 1,
        });
        return { runId, taskId, stageId: stageIds[STAGE_INDEX]!, operationId, providerConfigId };
      };

      seedWorkspace(WS_APPROVED, 'pcfg_live_approval_a');
      seedWorkspace(WS_EXPIRED, 'pcfg_live_approval_b');
      const approvedRun = seedRun(WS_APPROVED, 'pcfg_live_approval_a', 'approved', 'A');
      const expiredRun = seedRun(WS_EXPIRED, 'pcfg_live_approval_b', 'expired', 'B');

      const chain = createProviderExecutionChain({
        store,
        artifactRoot: join(projectRoot, '.agentos', 'artifacts'),
        workspaceRootFor: workspaceId => workspaceRoots.get(workspaceId) ?? projectRoot,
        worktreePathFor: workspaceId => workspaceRoots.get(workspaceId),
      });
      const gate = chain.approvalGate;
      const runs = store.runRepository();
      const stages = store.runStageRepository();
      const spawnCount = (runId: string): number =>
        (db.prepare('SELECT COUNT(*) AS c FROM runtime_processes WHERE run_id = ?').get(runId) as { c: number }).c;
      const approvalById = (id: string): ApprovalRow =>
        db.prepare('SELECT id, run_id, stage_id, status, version, resolution, expires_at, action_fingerprint, agent_snapshot_hash, provider_snapshot_hash, launch_plan_hash, request_snapshot_json FROM runtime_approval_requests WHERE id = ?').get(id) as ApprovalRow;

      // ---- 1. ASK_USER pauses before any spawn and persists the request ----
      const firstDrive = await chain.dispatcher.drive(WS_APPROVED, approvedRun.runId);
      assert.equal(firstDrive.outcome, 'claimed-and-progressed');
      const paused = runs.findById(WS_APPROVED, approvedRun.runId);
      assert.equal(paused?.status, 'waiting_approval',
        `ASK_USER must pause the Run, saw ${paused?.status} (${paused?.failureCode}: ${paused?.failureMessage})`);
      assert.equal(
        stages.listByRun(WS_APPROVED, approvedRun.runId).find(stage => stage.id === approvedRun.stageId)?.status,
        'waiting_approval',
      );
      const pendingRequests = gate.list(WS_APPROVED).filter(request => request.runId === approvedRun.runId);
      assert.equal(pendingRequests.length, 1, 'exactly one persisted request for the paused Run');
      const request = approvalById(pendingRequests[0]!.id);
      assert.equal(request.status, 'pending');
      assert.equal(request.stage_id, approvedRun.stageId);
      assert.ok(request.expires_at > NOW, 'a pending request carries a real expiry');
      for (const [field, value] of Object.entries({
        action_fingerprint: request.action_fingerprint,
        agent_snapshot_hash: request.agent_snapshot_hash,
        provider_snapshot_hash: request.provider_snapshot_hash,
        launch_plan_hash: request.launch_plan_hash,
      })) {
        assert.match(String(value), /^[a-f0-9]{64}$/, `${field} must be a frozen identity hash`);
      }
      assert.ok(request.request_snapshot_json.length > 0, 'the frozen request snapshot is persisted');
      assert.equal(spawnCount(approvedRun.runId), 0, 'ASK_USER must pause BEFORE any provider process exists');

      // ---- 2. A version mismatch cannot decide anything ----
      assert.throws(() => gate.resolve({
        workspaceId: WS_APPROVED, requestId: request.id, expectedVersion: request.version + 1,
        decision: 'approve_once', decidedBy: 'live-gate',
      }));
      assert.equal(approvalById(request.id).status, 'pending', 'a stale version leaves the request pending');
      assert.equal(spawnCount(approvedRun.runId), 0);

      // ---- 3. Accepting resumes THAT Run and records the user-explicit fact ----
      const accepted = gate.resolve({
        workspaceId: WS_APPROVED, requestId: request.id, expectedVersion: request.version,
        decision: 'approve_once', decidedBy: 'live-gate',
      });
      assert.equal(accepted.replayed, false);
      assert.ok(accepted.candidateId, 'an accepted decision produces its memory fact');
      assert.equal(approvalById(request.id).status, 'approved');

      const decisionCandidate = new MemoryCandidateRepository(db).findCandidateById(WS_APPROVED, accepted.candidateId!);
      assert.ok(decisionCandidate !== undefined);
      assert.equal(decisionCandidate.authority, 'user-explicit', 'an approval fact carries user authority');
      assert.equal(decisionCandidate.category, 'decision');
      assert.ok(decisionCandidate.sources.some(source => source.kind === 'run' && source.id === approvedRun.runId));
      assert.ok(decisionCandidate.sources.some(source => source.kind === 'event'));
      const decisionEvents = db.prepare(
        "SELECT payload_json FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND type = 'memory.candidate_created'",
      ).all(WS_APPROVED, approvedRun.runId) as Array<{ payload_json: string }>;
      assert.ok(
        decisionEvents.some(row => row.payload_json.includes(accepted.candidateId!)),
        'the decision fact has its canonical candidate_created Event',
      );

      // ---- 4. A replayed decision is idempotent, and a conflicting one is refused ----
      const replay = gate.resolve({
        workspaceId: WS_APPROVED, requestId: request.id, expectedVersion: request.version,
        decision: 'approve_once', decidedBy: 'live-gate',
      });
      assert.equal(replay.replayed, true, 'the same decision replays instead of duplicating');
      assert.equal(replay.candidateId, accepted.candidateId);
      const decisionRows = db.prepare('SELECT COUNT(*) AS c FROM approval_decisions WHERE approval_request_id = ?').get(request.id) as { c: number };
      assert.equal(Number(decisionRows.c), 1, 'exactly one decision record for the request');
      assert.throws(() => gate.resolve({
        workspaceId: WS_APPROVED, requestId: request.id, expectedVersion: request.version,
        decision: 'reject', decidedBy: 'live-gate',
      }), /RUNTIME_APPROVAL_CONFLICT/);
      assert.equal(approvalById(request.id).resolution, 'approve_once', 'a conflicting decision changes nothing');

      // ---- 5. The approved original Run continues and really executes once ----
      // Every write-capable Stage is separately authorized, so a sequential pipeline
      // asks again for the next Stage: the loop approves each request as it appears,
      // which is also what proves the pause is per action rather than a one-off flag.
      const pendingFor = (runId: string) =>
        gate.list(WS_APPROVED).find(request => request.runId === runId && request.status === 'pending');
      const deadline = Date.now() + 420_000;
      while (Date.now() < deadline) {
        const current = runs.findById(WS_APPROVED, approvedRun.runId);
        if (current === undefined || !['running', 'waiting_approval', 'starting', 'queued'].includes(current.status)) break;
        const nextPending = pendingFor(approvedRun.runId);
        if (nextPending !== undefined) {
          gate.resolve({
            workspaceId: WS_APPROVED, requestId: nextPending.id, expectedVersion: nextPending.version,
            decision: 'approve_once', decidedBy: 'live-gate',
          });
        }
        await sleep(1_000);
      }
      const finished = runs.findById(WS_APPROVED, approvedRun.runId);
      assert.equal(finished?.status, 'completed',
        `the approved Run must complete on the real Provider: ${finished?.failureCode} ${finished?.failureMessage}`);
      assert.equal(spawnCount(approvedRun.runId), 2, 'each approved Stage unlocked exactly one provider process');
      const requests = db.prepare(
        'SELECT id, stage_id, status FROM runtime_approval_requests WHERE run_id = ? ORDER BY created_at, id',
      ).all(approvedRun.runId) as Array<{ id: string; stage_id: string; status: string }>;
      assert.equal(requests.length, 2, 'one persisted request per authorized Stage');
      assert.deepEqual(requests.map(row => row.status), ['approved', 'approved']);
      assert.deepEqual(
        requests.map(row => row.stage_id).sort(),
        ['stage_approved_2', 'stage_approved_3'],
        'the requests name the stages they authorized',
      );
      assert.ok(
        stages.listByRun(WS_APPROVED, approvedRun.runId).every(stage => stage.status === 'completed' || stage.status === 'skipped'),
        'the approved Run finished its pipeline',
      );

      // ---- 6. An EXPIRED request can neither be decided nor executed ----
      await chain.dispatcher.drive(WS_EXPIRED, expiredRun.runId);
      assert.equal(runs.findById(WS_EXPIRED, expiredRun.runId)?.status, 'waiting_approval');
      const expiredPending = gate.list(WS_EXPIRED).find(candidate => candidate.runId === expiredRun.runId);
      assert.ok(expiredPending, 'the second Run paused with its own request');
      // The request row is identity-immutable, so expiry is produced the way the gate
      // itself produces it: the production repository method, called with a clock past
      // the persisted expiresAt - which is exactly what time passing does to a real
      // request. Nothing about the request's identity changes.
      const expiryClock = '2100-01-01T00:00:00.000Z';
      const expired = inTransaction(db, () => new RuntimeApprovalRepository(db).markExpiredWithinTransaction({
        workspaceId: WS_EXPIRED, id: expiredPending.id,
        expectedVersion: approvalById(expiredPending.id).version, now: expiryClock,
      }));
      assert.equal(expired.status, 'expired');
      assert.equal(expired.resolution, null, 'expiry is not a user decision');
      assert.equal(approvalById(expiredPending.id).expires_at, expiredPending.expiresAt,
        'expiry must not rewrite the persisted deadline');
      // A decision attempt on it is refused, whatever code the path reports.
      assert.throws(() => gate.resolve({
        workspaceId: WS_EXPIRED, requestId: expiredPending.id,
        expectedVersion: approvalById(expiredPending.id).version,
        decision: 'approve_once', decidedBy: 'live-gate',
      }), /RUNTIME_APPROVAL_(CONFLICT|EXPIRED)/);
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS c FROM approval_decisions WHERE approval_request_id = ?').get(expiredPending.id) as { c: number }).c,
        0,
        'an expired request records no decision',
      );
      // "Expired cannot execute" is what the row requires, and that is what is asserted:
      // the Run stays paused with its attempt unconsumed, no provider process exists,
      // and no decision was recorded. The residual behaviour is recorded rather than
      // asserted away: expiry is observed lazily (on a decision attempt or on a new
      // launch attempt) and there is no sweeper, so an expired request leaves the Run in
      // waiting_approval - the operator cancels it or asks for a fresh decision. That
      // limitation is stated in S3-approval-live-evidence.md.
      assert.equal(spawnCount(expiredRun.runId), 0, 'an expired approval never spawns a provider process');
      await chain.dispatcher.drive(WS_EXPIRED, expiredRun.runId);
      const expiredRunState = runs.findById(WS_EXPIRED, expiredRun.runId);
      assert.equal(expiredRunState?.status, 'waiting_approval',
        'an expired request neither executes nor silently rewrites the Run');
      assert.equal(
        stages.listByRun(WS_EXPIRED, expiredRun.runId).find(stage => stage.id === expiredRun.stageId)?.status,
        'waiting_approval',
        'the paused attempt is not consumed',
      );
      assert.equal(spawnCount(expiredRun.runId), 0, 'driving an expired Run still spawns nothing');
    } finally {
      store.close();
      // Kept on failure so captured provider output stays inspectable.
      if (process.env.M4_P4_KEEP_ROOT === '1') console.error('LITE-08-005/006/007 kept root: ' + projectRoot);
      else rmSync(projectRoot, { recursive: true, force: true });
    }
  });
