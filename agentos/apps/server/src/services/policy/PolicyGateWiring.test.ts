import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSnapshotV1, ProviderConfigurationSnapshotV1, RunSnapshotPayloadV2 } from '@agentos/shared';
import type { ProviderLaunchPlan } from '@agentos/agent-core/providers';

import {
  M3_013_LEGACY_DEFINITION_HASH,
  M3_013_LEGACY_WORKFLOW_KEY,
  M3_013_LEGACY_WORKFLOW_NAME,
  M3_013_LEGACY_WORKFLOW_V2_ID,
} from '../../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { RuntimeApprovalGate } from '../RuntimeApprovalGate.js';
import type { StageExecutionInput } from '../run-engine/StageExecutionCoordinator.js';
import type { PolicyEvaluationInput } from './PolicyEngine.js';
import { createEntityId } from '../../store/Identity.js';
import { PolicyRepository, type PolicyDecisionRecord } from '../../store/PolicyRepository.js';
import { RunSnapshotRepository } from '../../store/RunSnapshotRepository.js';
import { SqliteStore } from '../../store/SqliteStore.js';
import { WorkspaceManager } from '../../managers/WorkspaceManager.js';

const NOW = '2026-10-12T10:00:00.000Z';
const TASK_ID = createEntityId('task');
const RUN_ID = createEntityId('run');
const STAGE_ID = createEntityId('stage');
const OPERATION_ID = createEntityId('operation');
const AGENT_ID = 'policy-gate-agent';
const PROVIDER_CONFIG_ID = 'policy-gate-provider';

interface GateFixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly gate: RuntimeApprovalGate;
  readonly policy: PolicyRepository;
  readonly workspaceId: string;
  readonly input: StageExecutionInput;
  readonly plan: ProviderLaunchPlan;
  close(): void;
}

async function createFixture(options: { permissions: string[]; policyEngine?: { evaluate(input: PolicyEvaluationInput): never } }): Promise<GateFixture> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-policy-gate-'));
  const store = new SqliteStore(root);
  const workspaceManager = new WorkspaceManager(store);
  const workspace = await workspaceManager.create('Policy Gate Workspace', join(root, 'workspace'), {
    git: false, memory: false, readme: false, docs: false,
  });
  seedRun(store, workspace.id);

  const gate = options.policyEngine === undefined
    ? new RuntimeApprovalGate(store, { now: () => NOW, ttlMs: 30_000 })
    : new RuntimeApprovalGate(store, { now: () => NOW, ttlMs: 30_000, policyEngine: options.policyEngine });

  const agentSnapshot: AgentSnapshotV1 = {
    agentId: AGENT_ID,
    name: 'Policy Gate Agent',
    role: 'codex',
    roleTitle: 'Executor',
    systemPrompt: 'Execute the task.',
    permissions: options.permissions as AgentSnapshotV1['permissions'],
    providerConfigId: PROVIDER_CONFIG_ID,
    enabled: true,
    version: 1,
  };
  const input: StageExecutionInput = {
    workspaceId: workspace.id,
    taskId: TASK_ID,
    runId: RUN_ID,
    stageId: STAGE_ID,
    stageAttempt: 1,
    workflowStageKey: 'codex_manager',
    agentSnapshot,
    providerSnapshot: providerSnapshot(),
    workspaceRoot: workspace.rootPath,
    prompt: 'perform the operation',
    operationId: OPERATION_ID,
  };
  const plan: ProviderLaunchPlan = {
    runtimeMode: 'cli',
    executable: 'provider',
    args: ['--safe'],
    cwd: workspace.rootPath,
    environment: {},
    redactedEnvironmentKeys: [],
    secretRefs: [],
    stdinMode: 'none',
    promptDelivery: 'argument',
    structuredOutput: 'text',
    cleanupFiles: [],
    shell: false,
    metadata: {},
  };
  return {
    root, store, gate, policy: new PolicyRepository(store.getDatabase()),
    workspaceId: workspace.id, input, plan,
    close() { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function seedRun(store: SqliteStore, workspaceId: string): void {
  const db = store.getDatabase();
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, 'policy gate', 'open', 'normal', 'test', ?, ?)
  `).run(TASK_ID, workspaceId, NOW, NOW);
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'running', 'initial', 'v2_api', 'test', ?, ?)
  `).run(RUN_ID, workspaceId, TASK_ID, RUN_ID, NOW, NOW);
  const snapshot = new RunSnapshotRepository(db).insert({
    workspaceId,
    runId: RUN_ID,
    workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
    payload: snapshotPayload(workspaceId),
  });
  db.prepare(`
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'codex_manager', 'codex_manager', 1, 1, 'running', ?, ?)
  `).run(STAGE_ID, workspaceId, RUN_ID, snapshot.id, NOW, NOW);
  db.prepare(`
    INSERT INTO operations (
      id, type, status, workspace_id, aggregate_type, aggregate_id, run_id,
      correlation_id, started_at, completed_at, created_at, updated_at
    ) VALUES (?, 'run.start', 'completed', ?, 'run', ?, ?, ?, ?, ?, ?, ?)
  `).run(OPERATION_ID, workspaceId, RUN_ID, RUN_ID, OPERATION_ID, NOW, NOW, NOW, NOW);
}

function snapshotPayload(workspaceId: string): RunSnapshotPayloadV2 {
  const stages = [
    { workflowStageKey: 'codex_manager', name: 'codex_manager', sequence: 1, dependsOn: [] },
    { workflowStageKey: 'kimi_worker', name: 'kimi_worker', sequence: 2, dependsOn: ['codex_manager'] },
    { workflowStageKey: 'opencode_reviewer', name: 'opencode_reviewer', sequence: 3, dependsOn: ['kimi_worker'] },
    { workflowStageKey: 'codex_final_review', name: 'codex_final_review', sequence: 4, dependsOn: ['opencode_reviewer'] },
  ].map(stage => ({ ...stage, agent: agentSnapshot(['read', 'write']), provider: providerSnapshot() }));
  return {
    schemaVersion: 2,
    capturedAt: NOW,
    run: {
      workspaceId,
      taskId: TASK_ID,
      origin: 'v2_api',
      reason: 'initial',
      parentRunId: null,
      rootRunId: RUN_ID,
    },
    workflow: {
      definitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
      definitionKey: M3_013_LEGACY_WORKFLOW_KEY,
      definitionVersion: 2,
      name: M3_013_LEGACY_WORKFLOW_NAME,
      definitionHash: M3_013_LEGACY_DEFINITION_HASH,
      worktreeMode: 'preferred',
      stages,
    },
    security: { redactionApplied: false },
  };
}

function agentSnapshot(permissions: string[]): AgentSnapshotV1 {
  return {
    agentId: AGENT_ID,
    name: 'Policy Gate Agent',
    role: 'codex',
    roleTitle: 'Executor',
    systemPrompt: 'Execute the task.',
    permissions: permissions as AgentSnapshotV1['permissions'],
    providerConfigId: PROVIDER_CONFIG_ID,
    enabled: true,
    version: 1,
  };
}

function providerSnapshot(): ProviderConfigurationSnapshotV1 {
  return {
    providerConfigId: PROVIDER_CONFIG_ID,
    name: 'Policy Gate Provider',
    providerType: 'custom-cli',
    adapterId: 'builtin.custom-cli',
    runtimeMode: 'cli',
    executable: 'provider',
    argsTemplate: [],
    model: null,
    environmentProfileId: null,
    secretProfileId: null,
    workingDirectoryMode: 'workspace',
    workspaceRelativeWorkingDirectory: null,
    capabilities: {
      sessionResume: false,
      structuredEvents: false,
      nativeApprovals: false,
      subagents: false,
      toolEvents: false,
      fileEvents: false,
      usageEvents: false,
      reasoningStream: false,
      interactiveInput: false,
      pause: false,
      cancellation: true,
      modelSelection: true,
      workspaceAwareness: true,
      nativeSandbox: false,
      outputContracts: false,
    },
    timeoutPolicy: {
      discoveryTimeoutMs: 10_000,
      validationTimeoutMs: 30_000,
      startupTimeoutMs: 60_000,
      idleTimeoutMs: null,
      totalTimeoutMs: null,
      cancelGracePeriodMs: 5_000,
      approvalTimeoutMs: null,
    },
    approvalMode: 'agentos',
    outputMode: 'structured',
    enabled: true,
    version: 1,
  };
}

function decisions(fx: GateFixture): PolicyDecisionRecord[] {
  return fx.policy.listDecisions(fx.workspaceId);
}

function policyEvents(fx: GateFixture, type: string): Array<{ type: string; payload: Record<string, unknown> }> {
  const rows = fx.store.getDatabase()
    .prepare('SELECT type, payload_json FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND type = ? ORDER BY sequence')
    .all(fx.workspaceId, RUN_ID, type) as Array<{ type: string; payload_json: string }>;
  return rows.map(row => ({ type: row.type, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

test('PR-2B default profile: a write-capable Agent still waits, and the evaluation is audited beside the request', async () => {
  const fx = await createFixture({ permissions: ['read', 'write'] });
  try {
    const result = fx.gate.beforeLaunch(fx.input, fx.plan);
    assert.equal(result.kind, 'wait');

    const rows = decisions(fx);
    assert.equal(rows.length, 1, 'exactly one persisted policy decision');
    const row = rows[0]!;
    assert.equal(row.action, 'provider.launch');
    assert.equal(row.decision, 'require_approval');
    assert.equal(row.runId, RUN_ID);
    assert.equal(row.stageId, STAGE_ID);
    assert.ok(row.profileId !== null);
    assert.equal(row.matchedRuleIds.length, 2, 'the write rule and the allow fallback both matched');

    // The decision row commits in the SAME transaction as the approval request,
    // so its fingerprint equals the persisted request action fingerprint.
    const request = fx.gate.list(fx.workspaceId)[0]!;
    assert.equal(row.fingerprint, request.actionFingerprint);
    assert.equal(row.evaluatedAt, NOW);

    const events = policyEvents(fx, 'policy.evaluated');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.payload.action, 'provider.launch');
    assert.equal(events[0]!.payload.decision, 'require_approval');
    assert.equal(events[0]!.payload.profileId, row.profileId);
    assert.equal(events[0]!.payload.matchedRuleCount, 2);
    assert.match(String(events[0]!.payload.evaluatedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(policyEvents(fx, 'policy.denied').length, 0);
  } finally { fx.close(); }
});

test('PR-2B default profile: a read-only Agent is allowed straight through, exactly like the old heuristic', async () => {
  const fx = await createFixture({ permissions: ['read', 'review'] });
  try {
    const result = fx.gate.beforeLaunch(fx.input, fx.plan);
    assert.deepEqual(result, { kind: 'allow' });
    assert.equal(fx.gate.list(fx.workspaceId).length, 0, 'no approval request is created');

    const rows = decisions(fx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.decision, 'allow');
    assert.equal(rows[0]!.fingerprint, null, 'no identity is computed on the allow fast path');
    const events = policyEvents(fx, 'policy.evaluated');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.payload.decision, 'allow');
    assert.equal(events[0]!.payload.matchedRuleCount, 1, 'the allow fallback rule matched');
  } finally { fx.close(); }
});

test('PR-2B legacy parity: a permission outside the read/review/write enum still requires approval', async () => {
  const fx = await createFixture({ permissions: ['admin'] });
  try {
    const result = fx.gate.beforeLaunch(fx.input, fx.plan);
    assert.equal(result.kind, 'wait', 'legacy heuristic behaviour is preserved');
    assert.equal(decisions(fx)[0]!.decision, 'require_approval');
  } finally { fx.close(); }
});

test('PR-2B deny rule: a matching deny rule rejects the launch and emits policy.denied', async () => {
  const fx = await createFixture({ permissions: ['read', 'review'] });
  try {
    const profile = fx.policy.createProfile({
      id: createEntityId('policyProfile'), workspaceId: fx.workspaceId,
      name: 'default', isDefault: true, createdAt: NOW, updatedAt: NOW,
    });
    fx.policy.createRule({
      id: createEntityId('policyRule'), profileId: profile.id, action: 'provider.launch',
      selector: {}, decision: 'allow', priority: 0, specificity: 0, createdAt: NOW,
    });
    fx.policy.createRule({
      id: createEntityId('policyRule'), profileId: profile.id, action: 'provider.launch',
      selector: {}, decision: 'deny', priority: 200, specificity: 0, createdAt: NOW,
    });

    const result = fx.gate.beforeLaunch(fx.input, fx.plan);
    assert.deepEqual(result, {
      kind: 'deny',
      code: 'POLICY_DENIED',
      message: 'Policy denied this provider launch (action: provider.launch)',
    });
    assert.equal(fx.gate.list(fx.workspaceId).length, 0, 'a policy deny never creates an approval request');

    const rows = decisions(fx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.decision, 'deny');
    assert.equal(rows[0]!.matchedRuleIds.length, 2, 'both fallback and deny rules matched; deny wins by rank');

    assert.equal(policyEvents(fx, 'policy.evaluated').length, 1);
    const denied = policyEvents(fx, 'policy.denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0]!.payload.action, 'provider.launch');
    assert.equal(denied[0]!.payload.decision, 'deny');
    assert.equal(denied[0]!.payload.profileId, profile.id);
    assert.match(String(denied[0]!.payload.evaluatedAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally { fx.close(); }
});

test('PR-2B fail-closed: an engine failure degrades to require_approval and emits policy.evaluation_failed', async () => {
  const fx = await createFixture({
    permissions: ['read', 'review'],
    policyEngine: {
      evaluate(_input: PolicyEvaluationInput): never {
        throw new Error('policy store unavailable');
      },
    },
  });
  try {
    const result = fx.gate.beforeLaunch(fx.input, fx.plan);
    assert.equal(result.kind, 'wait', 'a broken engine never allows a launch');
    assert.equal(fx.gate.list(fx.workspaceId).length, 1, 'the fail-closed path creates a normal approval request');

    const rows = decisions(fx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.decision, 'require_approval');
    assert.equal(rows[0]!.profileId, null, 'no profile was loaded');
    assert.deepEqual(rows[0]!.matchedRuleIds, []);

    assert.equal(policyEvents(fx, 'policy.evaluated').length, 0, 'no evaluated fact without a profile');
    const failures = policyEvents(fx, 'policy.evaluation_failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.payload.action, 'provider.launch');
    assert.equal(failures[0]!.payload.errorCode, 'Error');

    // The Run itself is untouched: no 500, no failure state. The fail-closed
    // path creates a normal approval request, so the Run pauses exactly like
    // any other require_approval outcome.
    assert.equal(fx.store.runRepository().findById(fx.workspaceId, RUN_ID)?.status, 'waiting_approval');
  } finally { fx.close(); }
});

test('PR-2B repeat evaluation: every gate check appends its own audit row', async () => {
  const fx = await createFixture({ permissions: ['read', 'review'] });
  try {
    fx.policy.createProfile({
      id: createEntityId('policyProfile'), workspaceId: fx.workspaceId,
      name: 'default', isDefault: true, createdAt: NOW, updatedAt: NOW,
    });
    fx.policy.createRule({
      id: createEntityId('policyRule'), profileId: fx.policy.findDefaultProfile(fx.workspaceId)!.id,
      action: 'provider.launch', selector: {}, decision: 'allow', priority: 0, specificity: 0, createdAt: NOW,
    });
    assert.equal(fx.gate.beforeLaunch(fx.input, fx.plan).kind, 'allow');
    assert.equal(fx.gate.beforeLaunch(fx.input, fx.plan).kind, 'allow');
    assert.equal(decisions(fx).length, 2, 'each beforeLaunch evaluation is its own immutable audit row');
    assert.equal(policyEvents(fx, 'policy.evaluated').length, 2);
  } finally { fx.close(); }
});
