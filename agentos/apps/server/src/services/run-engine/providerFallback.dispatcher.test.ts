/**
 * P5D Provider Fallback dispatch-chain tests (04-Provider-Specification §42).
 *
 * The coordinator is scripted (no real provider processes); the store,
 * RunEngine, LifecycleTransactionService, RunSnapshotRepository chain
 * projection, provider.switch Event persistence, and the real
 * ProviderSwitchApprovalGate are exercised for real.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  createM3RuntimeEventRegistry,
  type AgentSnapshotV1,
  type ProviderConfigurationSnapshotV1,
  type ProviderFallbackChainEntryV1,
  type RunSnapshotPayloadV2,
} from '@agentos/shared';
import { MigrationRegistry } from '../../migrations/registry.js';
import { MigrationRunner } from '../../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../../migrations/default-registry.js';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { RunRepository } from '../../store/RunRepository.js';
import { RunStageRepository } from '../../store/RunStageRepository.js';
import { RunSnapshotRepository } from '../../store/RunSnapshotRepository.js';
import { RunProviderFallbackChainRepository } from '../../store/RunProviderFallbackChainRepository.js';
import { ProviderConfigurationRepository, type ProviderConfiguration } from '../../store/ProviderConfigurationRepository.js';
import { OutboxRepository } from '../../store/OutboxRepository.js';
import { RuntimeEventOutboxWriter, RuntimeEventRepository } from '../../store/RuntimeEventRepository.js';
import { RunSequenceAllocator } from '../../store/RunSequenceAllocator.js';
import { inTransaction } from '../../store/Transaction.js';
import { LifecycleTransactionService } from '../LifecycleTransactionService.js';
import { OperationService } from '../OperationService.js';
import { RuntimeApprovalGate } from '../RuntimeApprovalGate.js';
import { RunEngine } from './RunEngine.js';
import { StageExecutor } from './StageExecutor.js';
import { RunEngineProviderDispatcher } from './RunEngineProviderDispatcher.js';
import type { StageExecutionCoordinator } from './StageExecutionCoordinator.js';
import type { StageExecutionInput, StageExecutionOutcome } from './StageExecutionCoordinator.js';
import { ProviderSwitchApprovalGate, emitProviderSwitchEvent } from './providerFallback.js';
import type { SqliteStore } from '../../store/SqliteStore.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown; }; close(): void; } };
type Db = InstanceType<typeof DatabaseSync>;

const NOW = '2026-10-17T00:00:00.000Z';
const WS = 'ws_p5d';
const OTHER_WS = 'ws_p5d_other';
const TASK = 'task_p5d';
const RUN = 'run_p5d';
const OP = 'op_' + 'B'.repeat(26);
const STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'] as const;

const PRIMARY_ID = 'pcfg_p5d_primary';
const FALLBACK_ID = 'pcfg_p5d_fallback';
const DISABLED_ID = 'pcfg_p5d_disabled';
const OTHER_WS_ID = 'pcfg_p5d_other_ws';

const CAPABILITIES = {
  sessionResume: false, structuredEvents: true, nativeApprovals: false, subagents: false,
  toolEvents: false, fileEvents: false, usageEvents: false, reasoningStream: false,
  interactiveInput: false, pause: false, cancellation: true, modelSelection: true,
  workspaceAwareness: true, nativeSandbox: false, outputContracts: false,
} as const;

const TIMEOUT_POLICY = {
  discoveryTimeoutMs: 10000, validationTimeoutMs: 30000, startupTimeoutMs: 60000,
  idleTimeoutMs: null, totalTimeoutMs: null, cancelGracePeriodMs: 5000, approvalTimeoutMs: null,
} as const;

interface Behavior {
  readonly permissions?: readonly ('read' | 'write' | 'review')[];
  readonly policy?: Partial<{
    enabled: boolean;
    fallbackProviderConfigIds: string[];
    triggerErrorCodes: string[];
    maxFallbacks: number;
    requireUserApproval: boolean;
  }>;
  readonly outcomeFor: (providerConfigId: string, executeIndex: number) => StageExecutionOutcome;
  readonly useRealSwitchGate?: boolean;
}

function defaultPolicy(): NonNullable<Behavior['policy']> {
  return {
    enabled: true,
    fallbackProviderConfigIds: [FALLBACK_ID],
    triggerErrorCodes: ['PROVIDER_RATE_LIMITED'],
    maxFallbacks: 1,
    requireUserApproval: false,
  };
}

function providerSnapshot(fallbackPolicy?: ProviderConfigurationSnapshotV1['fallbackPolicy']): ProviderConfigurationSnapshotV1 {
  return {
    providerConfigId: PRIMARY_ID,
    name: 'Primary provider',
    providerType: 'custom-cli',
    adapterId: 'builtin.custom-cli',
    runtimeMode: 'cli',
    executable: 'C:/provider.exe',
    argsTemplate: [],
    ...(fallbackPolicy === undefined ? {} : { fallbackPolicy }),
    model: null,
    environmentProfileId: null,
    secretProfileId: null,
    workingDirectoryMode: 'workspace',
    workspaceRelativeWorkingDirectory: null,
    capabilities: { ...CAPABILITIES },
    timeoutPolicy: { ...TIMEOUT_POLICY },
    approvalMode: 'disabled',
    outputMode: 'structured',
    enabled: true,
    version: 1,
  };
}

function agentSnapshot(permissions: readonly ('read' | 'write' | 'review')[]): AgentSnapshotV1 {
  return {
    agentId: 'agent_p5d', name: 'Agent', role: 'kimi', roleTitle: 'Worker',
    systemPrompt: 'Execute the requested task.', permissions: [...permissions],
    providerConfigId: PRIMARY_ID, enabled: true, version: 1,
  };
}

function snapshotPayload(policy: ProviderConfigurationSnapshotV1['fallbackPolicy'], permissions: readonly ('read' | 'write' | 'review')[]): RunSnapshotPayloadV2 {
  const agent = agentSnapshot(permissions);
  const provider = providerSnapshot(policy);
  return {
    schemaVersion: 2, capturedAt: NOW,
    run: { workspaceId: WS, taskId: TASK, origin: 'v2_api', reason: 'initial', parentRunId: null, rootRunId: RUN },
    workflow: {
      definitionId: M3_013_LEGACY_WORKFLOW_V2_ID, definitionKey: 'legacy-pipeline', definitionVersion: 2,
      name: 'legacy-pipeline-v2',
      definitionHash: '9ea35ef455c5fefa45d0b28d1433933b2cc6b3fb9e412b4d4452afb7862a6b6d',
      worktreeMode: 'preferred',
      stages: STAGE_KEYS.map((key, index) => ({
        workflowStageKey: key, name: key, sequence: index + 1,
        agent: structuredClone(agent), provider: structuredClone(provider),
        dependsOn: index === 0 ? [] : [STAGE_KEYS[index - 1]],
      })) as never,
    },
    security: { redactionApplied: false },
  };
}

function insertProviderConfiguration(db: Db, config: Partial<ProviderConfiguration> & { id: string }): void {
  const full: ProviderConfiguration = {
    workspaceId: WS, name: config.id, providerType: 'custom-cli', adapterId: 'builtin.custom-cli',
    runtimeMode: 'cli', workingDirectoryMode: 'workspace', capabilities: { ...CAPABILITIES },
    timeoutPolicy: { ...TIMEOUT_POLICY }, approvalMode: 'disabled', outputMode: 'structured',
    enabled: true, version: 1, createdAt: NOW, updatedAt: NOW, ...config,
  };
  new ProviderConfigurationRepository(db as never).insert(full);
}

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  return db;
}

function seed(db: Db, behavior: Behavior): void {
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, '/tmp/p5d', '/tmp/p5d', ?, ?, ?)`)
    .run(WS, 'WS P5D', NOW, NOW, NOW);
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, '/tmp/p5d-other', '/tmp/p5d-other', ?, ?, ?)`)
    .run(OTHER_WS, 'WS P5D other', NOW, NOW, NOW);
  db.prepare(`INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at) VALUES (?, ?, 'P5D task', 'open', 'normal', 'test', ?, ?)`)
    .run(TASK, WS, NOW, NOW);
  db.prepare(`INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, next_event_sequence, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 'initial', 'v2_api', 1, 'test', ?, ?)`)
    .run(RUN, WS, TASK, RUN, NOW, NOW);
  db.prepare(`INSERT INTO operations (id, type, status, workspace_id, aggregate_type, aggregate_id, run_id, correlation_id, created_at, updated_at, version) VALUES (?, 'run.start', 'queued', ?, 'run', ?, ?, ?, ?, ?, 1)`)
    .run(OP, WS, RUN, RUN, OP, NOW, NOW);

  const policy = { ...defaultPolicy(), ...behavior.policy };
  insertProviderConfiguration(db, {
    id: PRIMARY_ID,
    fallbackPolicy: {
      enabled: policy.enabled ?? true,
      fallbackProviderConfigIds: policy.fallbackProviderConfigIds ?? [FALLBACK_ID],
      triggerErrorCodes: policy.triggerErrorCodes ?? ['PROVIDER_RATE_LIMITED'],
      maxFallbacks: policy.maxFallbacks ?? 1,
      requireUserApproval: policy.requireUserApproval ?? false,
    },
  });
  insertProviderConfiguration(db, { id: FALLBACK_ID, name: 'Fallback provider' });
  insertProviderConfiguration(db, { id: DISABLED_ID, name: 'Disabled provider', enabled: false });
  insertProviderConfiguration(db, { id: OTHER_WS_ID, name: 'Other workspace provider', workspaceId: OTHER_WS });

  const snapshot = new RunSnapshotRepository(db as never).insert({
    workspaceId: WS, runId: RUN, workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
    payload: snapshotPayload(
      {
        enabled: policy.enabled ?? true,
        fallbackProviderConfigIds: policy.fallbackProviderConfigIds ?? [FALLBACK_ID],
        triggerErrorCodes: policy.triggerErrorCodes ?? ['PROVIDER_RATE_LIMITED'],
        maxFallbacks: policy.maxFallbacks ?? 1,
        requireUserApproval: policy.requireUserApproval ?? false,
      },
      behavior.permissions ?? ['read'],
    ),
  });
  STAGE_KEYS.forEach((key, index) => {
    db.prepare(`INSERT INTO run_stages (id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name, sequence, attempt, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, 1)`)
      .run('stage_p5d_' + index, WS, RUN, snapshot.id, key, key, index + 1, NOW, NOW);
  });
}

function problem(code: string, detail = code): StageExecutionOutcome {
  return {
    kind: 'failed', phase: 'runtime',
    problem: {
      type: 'https://agentos.dev/problems/' + code.toLowerCase(), title: 'Provider stage failed',
      status: 429, code, detail, instance: '/runs/' + RUN, requestId: 'provider-' + OP, retryable: true,
    },
  };
}

const OUTCOMES = {
  rateLimited: () => problem('PROVIDER_RATE_LIMITED'),
  startFailed: () => problem('PROVIDER_START_FAILED'),
  completed: (): StageExecutionOutcome => ({
    kind: 'completed', durationMs: 5, artifactIds: [], outputContractSatisfied: true,
  }),
};

interface Fixture {
  db: Db;
  dispatcher: RunEngineProviderDispatcher;
  approvalGate: RuntimeApprovalGate | undefined;
  calls: StageExecutionInput[];
  trace: string[];
  switchEvents: Array<Record<string, unknown>>;
  dispatchFailures: Array<{ code: string }>;
  runRepo: RunRepository;
  runStageRepo: RunStageRepository;
  runSnapshotRepo: RunSnapshotRepository;
  events: RuntimeEventRepository;
}

function fixture(behavior: Behavior): Fixture {
  const db = migratedDb();
  seed(db, behavior);
  const events = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const outbox = new OutboxRepository(db, events);
  const factWriter = new RuntimeEventOutboxWriter(events, new RunSequenceAllocator(db), outbox, db);
  const runRepo = new RunRepository(db);
  const runStageRepo = new RunStageRepository(db);
  const runSnapshotRepo = new RunSnapshotRepository(db);
  const lifecycle = new LifecycleTransactionService({
    runRepository: runRepo, runStageRepository: runStageRepo, runtimeEventRepository: events,
    runSequenceAllocator: new RunSequenceAllocator(db), outboxRepository: outbox,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  }, { now: () => NOW });
  const operationService = new OperationService(db, { now: () => NOW, lifecycleTransactionService: lifecycle });
  const engine = new RunEngine({
    runRepository: runRepo, operationService, lifecycleTransactionService: lifecycle,
    snapshotRepository: runSnapshotRepo, runStageRepository: runStageRepo,
    stageExecutor: new StageExecutor(() => ({ outcome: 'active' })),
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  });
  const calls: StageExecutionInput[] = [];
  const trace: string[] = [];
  const switchEvents: Array<Record<string, unknown>> = [];
  const dispatchFailures: Array<{ code: string; message: string }> = [];
  const fakeStore = {
    getDatabase: () => db,
    runRepository: () => runRepo,
    runStageRepository: () => runStageRepo,
    runSnapshotRepository: () => runSnapshotRepo,
    operationService: () => operationService,
    lifecycleTransactionService: () => lifecycle,
    runtimeEventOutboxWriter: () => factWriter,
  } as unknown as SqliteStore;
  let dispatcher!: RunEngineProviderDispatcher;
  const continuations: Promise<void>[] = [];
  const approvalGate = new RuntimeApprovalGate(fakeStore, {
    now: () => NOW,
    continueRun: async (workspaceId, runId) => {
      const continuation = dispatcher.driveSafely(workspaceId, runId);
      continuations.push(continuation);
      await continuation;
    },
  });
  const switchGate = new ProviderSwitchApprovalGate({ store: fakeStore, now: () => NOW });
  const stubCoordinator = {
    execute: async (input: StageExecutionInput) => {
      calls.push(input);
      trace.push('execute:' + input.providerSnapshot.providerConfigId + ':' + input.stageId);
      return behavior.outcomeFor(input.providerSnapshot.providerConfigId, calls.length);
    },
    cancelAttempt: async () => {
      throw new Error('cancel not expected in provider fallback tests');
    },
  } as unknown as StageExecutionCoordinator;
  dispatcher = new RunEngineProviderDispatcher({
    engine,
    coordinator: stubCoordinator,
    admissionGate: {
      authorizeCanonicalRun: async () => ({ authorized: true as const, reason: 'ADMISSION_GRANTED' as const }),
    },
    runRepository: runRepo,
    runStageRepository: runStageRepo,
    runSnapshotRepository: runSnapshotRepo,
    operationService,
    lifecycleTransactionService: lifecycle,
    workspaceRootFor: () => 'C:/ws-p5d',
    providerConfigurations: new ProviderConfigurationRepository(db as never),
    providerSwitchApproval: {
      gateSwitch: (descriptor, agentSnapshotValue, toSnapshot, requireApproval) =>
        switchGate.gateSwitch(descriptor, agentSnapshotValue, toSnapshot, requireApproval),
      findApprovedSwitch: (workspaceId, runId, stageId) =>
        switchGate.findApprovedSwitch(workspaceId, runId, stageId),
      consumeSwitch: (requestId, workspaceId) => switchGate.consumeSwitch(requestId, workspaceId),
    },
    emitProviderSwitch: input => {
      trace.push('switch:' + input.fromProviderConfigId + '->' + input.toProviderConfigId + ':' + input.stageId);
      switchEvents.push({ ...input });
      emitProviderSwitchEvent(fakeStore, input);
    },
    recordProviderFallbackChainEntry: (workspaceId, runId, runSnapshotId, entry) => {
      new RunProviderFallbackChainRepository(db as never).append(workspaceId, runId, runSnapshotId, entry);
    },
    listProviderFallbackChain: (workspaceId, runId) =>
      new RunProviderFallbackChainRepository(db as never).listByRun(workspaceId, runId),
    onDispatchFailure: report => { dispatchFailures.push({ code: report.code, message: report.message }); },
    now: () => NOW,
  });
  void approvalGate;
  void continuations;
  return {
    db, dispatcher, approvalGate: undefined, calls, trace, switchEvents, dispatchFailures,
    runRepo, runStageRepo, runSnapshotRepo, events,
  };
}

function stageRows(fx: Fixture): Array<{ id: string; status: string; failureCode: string | null; attempt: number }> {
  return fx.db.prepare(`
    SELECT id, status, failure_code AS failureCode, attempt FROM run_stages
    WHERE workspace_id = ? AND run_id = ? ORDER BY sequence
  `).all(WS, RUN) as never;
}

interface PersistedSwitchEvent { type: string; stageId: string; payloadJson: string; correlationId: string }

function persistedSwitchEvents(fx: Fixture): PersistedSwitchEvent[] {
  const rows = fx.db.prepare(`
    SELECT type, stage_id, payload_json, correlation_id
    FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND type = 'provider.switch'
    ORDER BY sequence
  `).all(WS, RUN) as Array<{ type: string; stage_id: string; payload_json: string; correlation_id: string }>;
  return rows.map(row => ({
    type: row.type,
    stageId: row.stage_id,
    payloadJson: row.payload_json,
    correlationId: row.correlation_id,
  }));
}

function fallbackChain(fx: Fixture): ProviderFallbackChainEntryV1[] {
  return new RunProviderFallbackChainRepository(fx.db as never).listByRun(WS, RUN);
}

function close(fx: Fixture): void { fx.db.close(); }

describe('P5D provider fallback dispatch chain', () => {
  it('switches on a trigger error code: event before target launch, new claim attempt, snapshot chain', async () => {
    const fx = fixture({
      outcomeFor: id => (id === PRIMARY_ID ? OUTCOMES.rateLimited() : OUTCOMES.completed()),
    });
    try {
      await fx.dispatcher.driveSafely(WS, RUN);
      assert.deepEqual(fx.dispatchFailures, [], JSON.stringify(fx.dispatchFailures));
      const stages = stageRows(fx);
      assert.ok(stages.every(stage => stage.status === 'completed'), JSON.stringify(stages));
      // Every stage executed primary then fallback, switch event preceding the
      // fallback execute for that stage.
      for (let index = 0; index < STAGE_KEYS.length; index += 1) {
        const stageId = 'stage_p5d_' + index;
        const switchIndex = fx.trace.findIndex(entry => entry === 'switch:' + PRIMARY_ID + '->' + FALLBACK_ID + ':' + stageId);
        const primaryIndex = fx.trace.findIndex(entry => entry === 'execute:' + PRIMARY_ID + ':' + stageId);
        const fallbackIndex = fx.trace.findIndex(entry => entry === 'execute:' + FALLBACK_ID + ':' + stageId);
        assert.ok(switchIndex !== -1 && primaryIndex !== -1 && fallbackIndex !== -1);
        assert.ok(primaryIndex < switchIndex, 'switch must not be silent: event after primary failure, before target launch');
        assert.ok(switchIndex < fallbackIndex, 'provider.switch must be emitted before the fallback attempt launches');
      }
      // New claim attempt for the fallback: never reuses the failed Session key.
      for (const call of fx.calls.filter(candidate => candidate.providerSnapshot.providerConfigId === FALLBACK_ID)) {
        assert.equal(call.providerClaimAttempt, call.stageAttempt + 1);
      }
      // Public provider.switch events persisted on the same Run with causation.
      const persisted = persistedSwitchEvents(fx);
      assert.equal(persisted.length, STAGE_KEYS.length);
      for (const event of persisted) {
        const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
        assert.equal(payload['fromProviderConfigId'], PRIMARY_ID);
        assert.equal(payload['toProviderConfigId'], FALLBACK_ID);
        assert.equal(payload['triggerErrorCode'], 'PROVIDER_RATE_LIMITED');
        assert.equal(payload['attempt'], 1);
        assert.equal(event.correlationId, OP);
      }
      // Snapshot records the executed fallback chain.
      const chain = fallbackChain(fx);
      assert.equal(chain.length, STAGE_KEYS.length);
      chain.forEach((entry, index) => {
        assert.equal(entry.sequence, index + 1);
        assert.equal(entry.fromProviderConfigId, PRIMARY_ID);
        assert.equal(entry.toProviderConfigId, FALLBACK_ID);
        assert.equal(entry.triggerErrorCode, 'PROVIDER_RATE_LIMITED');
        assert.equal(entry.stageId, 'stage_p5d_' + index);
      });
      const run = fx.runRepo.findById(WS, RUN);
      assert.equal(run?.status, 'completed');
    } finally {
      close(fx);
    }
  });

  it('does not switch when the error code is not a trigger code', async () => {
    const fx = fixture({ outcomeFor: () => OUTCOMES.startFailed() });
    try {
      await fx.dispatcher.driveSafely(WS, RUN);
      assert.equal(fx.switchEvents.length, 0);
      assert.equal(persistedSwitchEvents(fx).length, 0);
      assert.equal(fallbackChain(fx).length, 0);
      const stages = stageRows(fx);
      assert.equal(stages[0]!.status, 'failed');
      assert.equal(stages[0]!.failureCode, 'PROVIDER_START_FAILED');
      assert.equal(fx.calls.filter(call => call.providerSnapshot.providerConfigId === FALLBACK_ID).length, 0);
    } finally {
      close(fx);
    }
  });

  it('never switches when the policy is disabled or maxFallbacks is zero', async () => {
    for (const policy of [{ enabled: false }, { maxFallbacks: 0 }] as const) {
      const fx = fixture({ policy, outcomeFor: () => OUTCOMES.rateLimited() });
      try {
        await fx.dispatcher.driveSafely(WS, RUN);
        assert.equal(fx.switchEvents.length, 0);
        const stages = stageRows(fx);
        assert.equal(stages[0]!.status, 'failed');
        assert.equal(stages[0]!.failureCode, 'PROVIDER_RATE_LIMITED');
      } finally {
        close(fx);
      }
    }
  });

  it('stops after maxFallbacks and preserves the last provider failure', async () => {
    const fx = fixture({
      policy: { maxFallbacks: 1, fallbackProviderConfigIds: [FALLBACK_ID, DISABLED_ID] },
      outcomeFor: () => OUTCOMES.rateLimited(),
    });
    try {
      await fx.dispatcher.driveSafely(WS, RUN);
      // Stage 0: primary fails → one switch → fallback also hits the trigger
      // code, but maxFallbacks=1 is exhausted, so the stage keeps the LAST
      // provider failure. The Run then fails and dependent stages are skipped.
      assert.equal(fx.switchEvents.length, 1);
      const stages = stageRows(fx);
      assert.equal(stages[0]!.status, 'failed');
      assert.equal(stages[0]!.failureCode, 'PROVIDER_RATE_LIMITED');
      const run = fx.runRepo.findById(WS, RUN);
      assert.equal(run?.status, 'failed');
      const chain = fallbackChain(fx);
      assert.equal(chain.length, 1);
      assert.equal(chain[0]!.toProviderConfigId, FALLBACK_ID);
      assert.equal(chain[0]!.attempt, 1);
      assert.equal(chain[0]!.sequence, 1);
      // The second (disabled) candidate was never attempted.
      assert.equal(fx.calls.filter(call => call.providerSnapshot.providerConfigId === DISABLED_ID).length, 0);
    } finally {
      close(fx);
    }
  });

  it('skips cross-workspace and disabled candidates and uses the first valid one', async () => {
    const fx = fixture({
      policy: { fallbackProviderConfigIds: [OTHER_WS_ID, DISABLED_ID, FALLBACK_ID] },
      outcomeFor: id => (id === PRIMARY_ID ? OUTCOMES.rateLimited() : OUTCOMES.completed()),
    });
    try {
      await fx.dispatcher.driveSafely(WS, RUN);
      assert.ok(fx.switchEvents.every(event => event['toProviderConfigId'] === FALLBACK_ID));
      assert.equal(fx.calls.filter(call => call.providerSnapshot.providerConfigId === OTHER_WS_ID).length, 0);
      assert.equal(fx.calls.filter(call => call.providerSnapshot.providerConfigId === DISABLED_ID).length, 0);
      assert.ok(stageRows(fx).every(stage => stage.status === 'completed'));
    } finally {
      close(fx);
    }
  });

  it('fails with the original provider error when no valid candidate exists', async () => {
    const fx = fixture({
      policy: { fallbackProviderConfigIds: [DISABLED_ID, OTHER_WS_ID] },
      outcomeFor: () => OUTCOMES.rateLimited(),
    });
    try {
      await fx.dispatcher.driveSafely(WS, RUN);
      assert.equal(fx.switchEvents.length, 0);
      assert.equal(fallbackChain(fx).length, 0);
      const stages = stageRows(fx);
      assert.equal(stages[0]!.status, 'failed');
      assert.equal(stages[0]!.failureCode, 'PROVIDER_RATE_LIMITED');
    } finally {
      close(fx);
    }
  });

  it('requireUserApproval: low-risk target switches without an approval request', async () => {
    const fx = fixture({
      permissions: ['read'],
      policy: { requireUserApproval: true },
      outcomeFor: id => (id === PRIMARY_ID ? OUTCOMES.rateLimited() : OUTCOMES.completed()),
    });
    try {
      await fx.dispatcher.driveSafely(WS, RUN);
      const approvalRequests = fx.db.prepare(`
        SELECT COUNT(*) AS count FROM runtime_approval_requests WHERE workspace_id = ? AND run_id = ?
      `).get(WS, RUN) as { count: number };
      assert.equal(approvalRequests.count, 0);
      assert.equal(fx.switchEvents.length, STAGE_KEYS.length);
      assert.ok(stageRows(fx).every(stage => stage.status === 'completed'));
    } finally {
      close(fx);
    }
  });

  it('requireUserApproval: high-risk target waits for approval, then switches once via the approval flow', async () => {
    const fx = fixture({
      permissions: ['write'],
      policy: { requireUserApproval: true },
      outcomeFor: id => (id === PRIMARY_ID ? OUTCOMES.rateLimited() : OUTCOMES.completed()),
    });
    try {
      await fx.dispatcher.driveSafely(WS, RUN);
      // The first stage hit the switch approval gate and waits; nothing switched silently.
      assert.equal(fx.switchEvents.length, 0);
      const runWaiting = fx.runRepo.findById(WS, RUN);
      assert.equal(runWaiting?.status, 'waiting_approval');
      const requests = fx.db.prepare(`
        SELECT id, stage_id AS stageId, status, version, request_snapshot_json AS snapshotJson
        FROM runtime_approval_requests WHERE workspace_id = ? AND run_id = ?
      `).all(WS, RUN) as Array<{ id: string; stageId: string; status: string; version: number; snapshotJson: string }>;
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.status, 'pending');
      const requestSnapshot = JSON.parse(requests[0]!.snapshotJson) as Record<string, unknown>;
      assert.equal(requestSnapshot['action'], 'provider.switch');
      assert.equal(requestSnapshot['fromProviderConfigId'], PRIMARY_ID);
      assert.equal(requestSnapshot['toProviderConfigId'], FALLBACK_ID);

      // The user approves through the existing RuntimeApprovalGate.resolve path.
      const gate = new RuntimeApprovalGate({
        getDatabase: () => fx.db,
        runRepository: () => fx.runRepo,
        runStageRepository: () => fx.runStageRepo,
        runSnapshotRepository: () => fx.runSnapshotRepo,
        operationService: () => new OperationService(fx.db, { now: () => NOW }),
        lifecycleTransactionService: () => new LifecycleTransactionService({
          runRepository: fx.runRepo, runStageRepository: fx.runStageRepo, runtimeEventRepository: fx.events,
          runSequenceAllocator: new RunSequenceAllocator(fx.db),
          outboxRepository: new OutboxRepository(fx.db, fx.events),
          runInTransaction: <T>(fn: () => T): T => inTransaction(fx.db, fn),
        }, { now: () => NOW }),
        runtimeEventOutboxWriter: () => new RuntimeEventOutboxWriter(fx.events, new RunSequenceAllocator(fx.db), new OutboxRepository(fx.db, fx.events), fx.db),
      } as unknown as SqliteStore, {
        now: () => NOW,
        continueRun: async (workspaceId, runId) => {
          continuation = fx.dispatcher.driveSafely(workspaceId, runId);
          await continuation;
        },
      });
      let continuation: Promise<void> | undefined;
      gate.resolve({
        workspaceId: WS, requestId: requests[0]!.id, expectedVersion: requests[0]!.version,
        decision: 'approve_once', decidedBy: 'tester',
      });
      await continuation;

      // After approval: the switch committed with the approval id attached, the
      // request was consumed, and the fallback ran to completion.
      assert.equal(fx.switchEvents.length, 1);
      assert.equal(fx.switchEvents[0]!['approvalRequestId'], requests[0]!.id);
      const consumed = fx.db.prepare(`
        SELECT consumed_at AS consumedAt FROM runtime_approval_requests WHERE id = ?
      `).get(requests[0]!.id) as { consumedAt: string | null };
      assert.notEqual(consumed.consumedAt, null);
      const persisted = persistedSwitchEvents(fx);
      assert.equal(persisted.length, 1);
      const payload = JSON.parse(persisted[0]!.payloadJson) as Record<string, unknown>;
      assert.equal(payload['approvalRequestId'], requests[0]!.id);
      assert.equal(payload['triggerErrorCode'], 'PROVIDER_RATE_LIMITED');
      const chain = fallbackChain(fx);
      assert.equal(chain.length, 1);
      assert.equal(chain[0]!.approvalRequestId, requests[0]!.id);

      // Drive the remaining stages; each repeats fail → approval → switch.
      // (No approvals are pending for them, so they must wait, not switch.)
      await fx.dispatcher.driveSafely(WS, RUN);
      assert.equal(fx.switchEvents.length, 1, 'no silent fallback while later stages await approval');
    } finally {
      close(fx);
    }
  });
});
