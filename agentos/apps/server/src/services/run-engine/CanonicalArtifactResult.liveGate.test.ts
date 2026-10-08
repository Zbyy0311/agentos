import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SqliteStore } from '../../store/SqliteStore.js';
import { RunSnapshotRepository } from '../../store/RunSnapshotRepository.js';
import { WorkspaceAdmissionRepository } from '../../store/WorkspaceAdmissionRepository.js';
import { MemoryCandidateRepository } from '../../store/MemoryCandidateRepository.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { createProviderExecutionChain } from './providerExecutionChain.js';

/**
 * LITE-07-104 live gate.
 *
 * The requirement is that a REAL review/test piece of work produces an Artifact
 * that reaches its terminal completion, and that the completion then flows into a
 * Memory Candidate, a canonical Event, the review queue, and finally a Memory
 * Entry. Posting a completion directly would only prove the infrastructure is
 * reachable, so this gate drives the canonical PRODUCTION composition root
 * (`createProviderExecutionChain`) with a real CLI provider at a real file and
 * asserts the whole chain, ending in an accepted Entry.
 *
 * It is env-gated because it needs a provider CLI that only exists on the operator
 * machine: CI has no OpenCode/Kimi/Codex binary, so the gate is skipped there and
 * run locally for evidence, exactly like the other M4_P4_REAL_* gates.
 *
 *   M4_P4_REAL_ARTIFACT_GATE=1 \
 *   AGENTOS_OPENCODE_CLI=<exe> AGENTOS_OPENCODE_MODEL=<provider/model> \
 *   node --import tsx --test src/services/run-engine/CanonicalArtifactResult.liveGate.test.ts
 */

const GATE = process.env.M4_P4_REAL_ARTIFACT_GATE === '1';
const EXE = process.env.AGENTOS_OPENCODE_CLI;
const MODEL = process.env.AGENTOS_OPENCODE_MODEL;

const NOW = new Date().toISOString();
const WS = 'ws_live_artifact';
const TASK = 'task_live_artifact';
const RUN = 'run_live_artifact';
/** Entity ids are validated as <prefix>_<26 ULID characters>. */
const OP = 'op_' + 'A'.repeat(26);
const AGENT = 'agent_live_artifact';
const PROVIDER = 'pcfg_live_artifact';
/** The frozen legacy-pipeline v2 definition is the only V2 workflow a fresh store seeds. */
const STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'] as const;

interface CanonicalArtifactRow {
  readonly id: string;
  readonly artifact_type: string;
  readonly canonical_run_id: string;
  readonly source_stage_id: string;
  readonly summary: string;
}

interface CompletionRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly artifact_type: string;
  readonly conclusion: string;
  readonly candidate_id: string;
  readonly source_key: string;
}

test('LITE-07-104 a real Provider drives the canonical chain from review work to an accepted Memory Entry',
  { skip: !GATE, timeout: 600_000 }, async () => {
    if (!EXE || !MODEL) {
      throw new Error('AGENTOS_OPENCODE_CLI and AGENTOS_OPENCODE_MODEL are required when M4_P4_REAL_ARTIFACT_GATE=1');
    }

    const projectRoot = mkdtempSync(join(tmpdir(), 'agentos-live-artifact-'));
    const workspaceRoot = join(projectRoot, 'workspace');
    mkdirSync(workspaceRoot, { recursive: true });
    // A real file with a real, reviewable defect: the model has to actually read
    // it (and may run node on it) to produce a truthful conclusion.
    writeFileSync(join(workspaceRoot, 'port-parser.mjs'), [
      'export function parsePort(value) {',
      '  const port = Number.parseInt(value, 10);',
      '  if (Number.isNaN(port)) return null;',
      '  if (port < 1 || port > 65535) return null;',
      '  return port;',
      '}',
      '',
    ].join('\n'), 'utf8');

    const store = new SqliteStore(projectRoot);
    try {
      const db = store.getDatabase();
      db.prepare('INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(WS, 'Live artifact gate', workspaceRoot, workspaceRoot, NOW, NOW, NOW);
      db.prepare('INSERT INTO provider_configurations (id, workspace_id, name, provider_type, adapter_id, runtime_mode, capabilities_json, timeout_policy_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(PROVIDER, WS, 'OpenCode live', 'opencode', 'builtin.opencode', 'cli', '{}', '{}', NOW, NOW);
      db.prepare('INSERT INTO agent_profiles (id, workspace_id, name, agent_role, role_title, system_prompt, permissions_json, enabled, cli_command, cli_args_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)')
        .run(AGENT, WS, 'Reviewer', 'opencode', 'Reviewer',
          // Deliberately tight: a gate must measure the AgentOS chain, not how a
          // model improvises around a broad task. Asking for one small file and a
          // single JSON answer keeps the real invocation deterministic enough to
          // re-run, while the answer still depends on actually reading the file.
          'Read port-parser.mjs. Then answer with the required JSON object and nothing else.',
          '["read"]', EXE, '[]', NOW, NOW);
      db.prepare('INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
        .run(TASK, WS, 'Review the port parser', 'open', 'live-gate', NOW, NOW);
      db.prepare('INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, next_event_sequence, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)')
        .run(RUN, WS, TASK, RUN, 'queued', 'initial', 'v2_api', 'live-gate', NOW, NOW);
      db.prepare('INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
        .run(OP, 'run.start', 'queued', WS, 'run', RUN, RUN, OP, NOW, NOW);

      const providerSnapshot = {
        providerConfigId: PROVIDER, name: 'OpenCode live', providerType: 'opencode', adapterId: 'builtin.opencode',
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
        approvalMode: 'disabled', outputMode: 'parsed-text', enabled: true, version: 1,
      };
      const agentSnapshot = {
        agentId: AGENT, name: 'Reviewer', role: 'opencode', roleTitle: 'Reviewer',
        systemPrompt: 'Review port-parser.mjs in this workspace. Read it, check it against real inputs, and answer.',
        permissions: ['read'], providerConfigId: PROVIDER, enabled: true, version: 1,
      };
      // The repository canonicalizes the JSON and derives the content hash, so the
      // read-back integrity checks hold by construction rather than by hand.
      new RunSnapshotRepository(db).insert({
        workspaceId: WS,
        runId: RUN,
        workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
        payload: {
          schemaVersion: 2,
          capturedAt: NOW,
          run: { workspaceId: WS, taskId: TASK, origin: 'v2_api', reason: 'initial', parentRunId: null, rootRunId: RUN },
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
      const snapshotId = (db.prepare('SELECT id FROM run_snapshots WHERE workspace_id = ? AND run_id = ?').get(WS, RUN) as { id: string }).id;
      STAGE_KEYS.forEach((key, index) => {
        db.prepare('INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 1)')
          .run('stage_live_' + index, WS, RUN, snapshotId, key, key, index + 1, 'pending', NOW, NOW);
      });
      // `runtime_artifacts.source_stage_id` is the run_stages ROW id, so map it
      // back to the workflow key for the assertions below.
      const stageKeyById = new Map<string, string>(
        (db.prepare('SELECT id, workflow_stage_key FROM run_stages WHERE workspace_id = ? AND run_id = ?')
          .all(WS, RUN) as Array<{ id: string; workflow_stage_key: string }>)
          .map(row => [row.id, row.workflow_stage_key]),
      );
      new WorkspaceAdmissionRepository(db).insertAdmission({
        id: 'adm_live_artifact', workspaceId: WS, subjectKind: 'CANONICAL_RUN', canonicalRunId: RUN, legacyRunId: null,
        requestedMutationClass: 'MODIFYING', effectiveMutationClass: 'MODIFYING', enforcementEvidenceJson: null,
        requestOrder: 1, state: 'GRANTED', queueReason: null, releaseReason: null,
        requestedAt: NOW, grantedAt: NOW, releasedAt: null, createdAt: NOW, updatedAt: NOW, version: 1,
      });

      // The canonical production composition root, exactly as the server builds it.
      const chain = createProviderExecutionChain({
        store,
        artifactRoot: join(projectRoot, '.agentos', 'artifacts'),
        workspaceRootFor: () => workspaceRoot,
        worktreePathFor: () => workspaceRoot,
      });

      const driven = await chain.dispatcher.drive(WS, RUN);
      assert.equal(driven.outcome, 'claimed-and-progressed');
      const run = store.runRepository().findById(WS, RUN);
      assert.equal(run?.status, 'completed', `Live gate did not complete: ${run?.failureCode} ${run?.failureMessage}`);
      assert.ok(
        store.runStageRepository().listByRun(WS, RUN).every(stage => stage.status === 'completed'),
        'every stage must complete for the artifact chain to be reached',
      );

      // 1. Real review work produced canonical Artifacts.
      const artifacts = db.prepare(
        "SELECT id, artifact_type, canonical_run_id, source_stage_id, summary FROM runtime_artifacts WHERE workspace_id = ? AND provenance_kind = 'CANONICAL' ORDER BY created_at, id",
      ).all(WS) as CanonicalArtifactRow[];
      assert.ok(artifacts.length >= 1, 'a real review must produce at least one canonical Artifact');
      for (const artifact of artifacts) {
        assert.equal(artifact.canonical_run_id, RUN);
        assert.ok(stageKeyById.has(artifact.source_stage_id),
          `artifact names an unknown stage: ${artifact.source_stage_id}`);
        assert.ok(artifact.summary.trim().length > 0, 'the Artifact must carry the reviewed evidence');
      }

      // 2. Each Artifact reached a type-matched terminal completion, and the
      //    completion came from the canonical result seam rather than a hand-made row.
      const completions = db.prepare(
        'SELECT id, artifact_id, artifact_type, conclusion, candidate_id, source_key FROM artifact_completions WHERE workspace_id = ? ORDER BY decided_at, id',
      ).all(WS) as CompletionRow[];
      assert.ok(completions.length >= 1, 'the canonical result seam must record a completion');
      assert.deepEqual(
        completions.map(completion => completion.artifact_id).sort(),
        artifacts.map(artifact => artifact.id).sort(),
        'every artifact must have exactly one completion',
      );
      for (const completion of completions) {
        assert.ok(completion.source_key.startsWith('canonical-result:'),
          `completion did not come from the canonical result seam: ${completion.source_key}`);
        if (completion.artifact_type === 'review') {
          assert.ok(['approved', 'changes_requested'].includes(completion.conclusion));
        } else {
          assert.ok(['pass', 'fail'].includes(completion.conclusion));
        }
      }

      // 3. Each completion produced a review-required Candidate that references the
      //    actual Artifact as its stable source.
      const candidates = new MemoryCandidateRepository(db);
      for (const completion of completions) {
        const candidate = candidates.findCandidateById(WS, completion.candidate_id);
        assert.ok(candidate !== undefined, `completion ${completion.id} has no Candidate`);
        assert.equal(candidate.outcome, 'review-required', 'an automatic fact must not auto-promote');
        assert.ok(candidate.authority !== 'user-explicit', 'a machine-produced fact must not claim user authority');
        // The Candidate cites the Artifact it came from; an additional Run source
        // is truthful provenance for the same fact and must not be forbidden.
        assert.ok(
          candidate.sources.some(source => source.kind === 'artifact' && source.id === completion.artifact_id),
          `the Candidate must cite the Artifact as its source, saw ${JSON.stringify(candidate.sources)}`,
        );
      }

      // 4. Every completion's Candidate became a canonical Runtime Event. A
      //    run-scoped Artifact fact belongs to the Run stream (the Workspace Event
      //    vocabulary is for artifacts that carry no Run), and the whole Run
      //    stream has exactly one Outbox handoff per Event.
      const candidateEvents = db.prepare(
        "SELECT payload_json FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND type = 'memory.candidate_created'",
      ).all(WS, RUN) as Array<{ payload_json: string }>;
      const eventCandidateIds = new Set(candidateEvents.map(row => (JSON.parse(row.payload_json) as { candidateId?: string }).candidateId));
      for (const completion of completions) {
        assert.ok(eventCandidateIds.has(completion.candidate_id),
          `no canonical memory.candidate_created Event for completion ${completion.id}`);
      }
      const eventCount = (db.prepare('SELECT COUNT(*) AS c FROM runtime_events WHERE workspace_id = ?').get(WS) as { c: number }).c;
      const outboxCount = (db.prepare('SELECT COUNT(*) AS c FROM outbox_messages WHERE aggregate_id = ?').get(RUN) as { c: number }).c;
      assert.ok(eventCount > 0, 'the Run must have produced canonical Runtime Events');
      assert.equal(outboxCount, eventCount, 'every Runtime Event must have exactly one Outbox row');

      // 5. The review queue accepted one Candidate on the production path and that
      //    produced a Memory Entry carrying the same Artifact provenance.
      const target = completions[0]!;
      const pending = candidates.findCandidateById(WS, target.candidate_id)!;
      const reviewed = candidates.reviewCandidate({
        workspaceId: WS,
        candidateId: pending.id,
        expectedVersion: pending.version,
        outcome: 'accept',
        reviewedAt: new Date().toISOString(),
      }, { writer: store.workspaceEventWriter() });
      assert.ok(reviewed.mergedIntoEntryId, 'accepting a Candidate must promote a Memory Entry');
      const entry = db.prepare('SELECT id, scope, category, content FROM memory_entries WHERE workspace_id = ? AND id = ?')
        .get(WS, reviewed.mergedIntoEntryId) as { id: string; scope: string; category: string; content: string } | undefined;
      assert.ok(entry !== undefined, 'the promoted Memory Entry must be durable');
      assert.ok(entry.content.trim().length > 0);
      const entrySources = db.prepare(
        'SELECT source_kind, source_id FROM memory_entry_sources WHERE memory_entry_id = ? ORDER BY source_kind, source_id',
      ).all(entry.id) as Array<{ source_kind: string; source_id: string }>;
      assert.ok(
        entrySources.some(source => source.source_kind === 'artifact' && source.source_id === target.artifact_id),
        `the Memory Entry must keep the Artifact provenance, saw ${JSON.stringify(entrySources)}`,
      );
    } finally {
      store.close();
      // Kept on failure so the captured provider output stays inspectable.
      if (process.env.M4_P4_KEEP_ROOT === '1') console.error('LITE-07-104 kept root: ' + projectRoot);
      else rmSync(projectRoot, { recursive: true, force: true });
    }
  });
