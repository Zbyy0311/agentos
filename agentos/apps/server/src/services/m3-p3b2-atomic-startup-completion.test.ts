import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  type AgentSnapshotV1,
  type ApiOperation,
  type ApiProblem,
  type ProviderConfigurationSnapshotV1,
  type RunSnapshotPayloadV2,
} from '@agentos/shared';
import { M3_013_LEGACY_WORKFLOW_V2_ID } from '../migrations/migrations/013-workflow-creation-metadata-v2.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { inTransaction } from '../store/Transaction.js';
import { OperationService } from './OperationService.js';
import { OutboxRepository } from '../store/OutboxRepository.js';
import { RunRepository } from '../store/RunRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { createM3RuntimeEventRegistry } from '@agentos/shared';
import { LifecycleTransactionService } from './LifecycleTransactionService.js';
import { RunEngine, type RunEngineDependencies } from './run-engine/RunEngine.js';
import { StageExecutor, type StageExecutorResult } from './run-engine/StageExecutor.js';

type Database = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
  };
  close(): void;
};

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Database;
};

const NOW = '2026-08-05T00:00:00.000Z';
const WORKSPACE_ID = 'workspace-p3b2-test';
const TASK_ID = 'task-p3b2-test';
const RUN_ID = 'run-p3b2-test';
const SNAPSHOT_ID = 'snapshot-p3b2-test';
const OPERATION_ID = 'operation-p3b2-test';
const STAGE_KEYS = ['codex_manager', 'kimi_worker', 'opencode_reviewer', 'codex_final_review'];

const AGENT_SNAPSHOT: AgentSnapshotV1 = {
  agentId: 'agent-p3b2-test',
  name: 'P3B-2B Agent',
  role: 'codex',
  roleTitle: 'Executor',
  systemPrompt: 'Execute the requested work.',
  permissions: ['read', 'write'],
  providerConfigId: 'provider-p3b2-test',
  enabled: true,
  version: 1,
};

const PROVIDER_SNAPSHOT: ProviderConfigurationSnapshotV1 = {
  providerConfigId: 'provider-p3b2-test',
  name: 'P3B-2B Provider',
  providerType: 'codex',
  adapterId: 'codex-cli',
  runtimeMode: 'cli',
  executable: 'codex',
  argsTemplate: [],
  model: 'gpt-5',
  environmentProfileId: null,
  secretProfileId: null,
  workingDirectoryMode: 'worktree',
  workspaceRelativeWorkingDirectory: null,
  capabilities: {
    sessionResume: true,
    structuredEvents: true,
    nativeApprovals: true,
    subagents: true,
    toolEvents: true,
    fileEvents: true,
    usageEvents: true,
    reasoningStream: true,
    interactiveInput: true,
    pause: true,
    cancellation: true,
    modelSelection: true,
    workspaceAwareness: true,
    nativeSandbox: true,
    outputContracts: true,
  },
  timeoutPolicy: {
    discoveryTimeoutMs: 1000,
    validationTimeoutMs: 1000,
    startupTimeoutMs: 1000,
    idleTimeoutMs: null,
    totalTimeoutMs: null,
    cancelGracePeriodMs: 1000,
    approvalTimeoutMs: null,
  },
  approvalMode: 'disabled',
  outputMode: 'structured',
  enabled: true,
  version: 1,
};

const PROBLEM: ApiProblem = {
  type: 'https://agentos.dev/problems/provider-start-failed',
  title: 'Provider start failed',
  status: 502,
  code: 'PROVIDER_START_FAILED',
  detail: 'The injected provider start failed.',
  instance: '/runs/run-p3b2-test',
  requestId: 'request-p3b2-test',
  retryable: false,
  context: { workspaceId: WORKSPACE_ID, runId: RUN_ID, operationId: OPERATION_ID },
};

function problemFor(operationId: string, stageId?: string): ApiProblem {
  return {
    ...PROBLEM,
    context: {
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      operationId,
      ...(stageId === undefined ? {} : { stageId }),
    },
  };
}

function snapshotPayload(): RunSnapshotPayloadV2 {
  return {
    schemaVersion: 2,
    capturedAt: NOW,
    run: {
      workspaceId: WORKSPACE_ID,
      taskId: TASK_ID,
      origin: 'v2_api',
      reason: 'initial',
      parentRunId: null,
      rootRunId: RUN_ID,
    },
    workflow: {
      definitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
      definitionKey: 'legacy-pipeline',
      definitionVersion: 2,
      name: 'legacy-pipeline-v2',
      definitionHash: '9ea35ef455c5fefa45d0b28d1433933b2cc6b3fb9e412b4d4452afb7862a6b6d',
      worktreeMode: 'preferred',
      stages: [
        { workflowStageKey: 'codex_manager', name: 'codex_manager', sequence: 1, agent: AGENT_SNAPSHOT, provider: PROVIDER_SNAPSHOT, dependsOn: [] },
        { workflowStageKey: 'kimi_worker', name: 'kimi_worker', sequence: 2, agent: AGENT_SNAPSHOT, provider: PROVIDER_SNAPSHOT, dependsOn: ['codex_manager'] },
        { workflowStageKey: 'opencode_reviewer', name: 'opencode_reviewer', sequence: 3, agent: AGENT_SNAPSHOT, provider: PROVIDER_SNAPSHOT, dependsOn: ['kimi_worker'] },
        { workflowStageKey: 'codex_final_review', name: 'codex_final_review', sequence: 4, agent: AGENT_SNAPSHOT, provider: PROVIDER_SNAPSHOT, dependsOn: ['opencode_reviewer'] },
      ],
    },
    security: { redactionApplied: false },
  };
}

interface Fixture {
  db: Database;
  operationService: OperationService;
  runRepository: RunRepository;
  runStageRepository: RunStageRepository;
  snapshotRepository: RunSnapshotRepository;
  engine: RunEngine;
  operation: ApiOperation;
  close(): void;
}

function createFixture(
  outcome: () => StageExecutorResult = () => ({ outcome: 'active' }),
  databasePath = ':memory:',
): Fixture {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  db.exec(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'P3B-2B', '.', 'p3b2-root', '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at)
    VALUES ('${TASK_ID}', '${WORKSPACE_ID}', 'P3B-2B task', 'test', '${NOW}', '${NOW}');
    INSERT INTO runs (
      id, workspace_id, task_id, root_run_id, status, reason, origin,
      next_event_sequence, created_by, created_at, updated_at, version, recovery_required
    ) VALUES (
      '${RUN_ID}', '${WORKSPACE_ID}', '${TASK_ID}', '${RUN_ID}', 'queued', 'initial', 'v2_api',
      1, 'test', '${NOW}', '${NOW}', 1, 0
    );
  `);
  const snapshotRepository = new RunSnapshotRepository(db);
  const snapshot = snapshotRepository.insert({
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    workflowDefinitionId: M3_013_LEGACY_WORKFLOW_V2_ID,
    payload: snapshotPayload(),
  });
  const runStageRepository = new RunStageRepository(db);
  STAGE_KEYS.forEach((workflowStageKey, index) => {
    runStageRepository.insertInitial({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      runSnapshotId: snapshot.id,
      workflowStageKey,
      sequence: index + 1,
    });
  });
  const runtimeEventRepository = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const outboxRepository = new OutboxRepository(db, runtimeEventRepository, { now: () => NOW });
  const runRepository = new RunRepository(db);
  const operationService = new OperationService(db, { now: () => NOW });
  const lifecycleTransactionService = new LifecycleTransactionService({
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    runSequenceAllocator: new RunSequenceAllocator(db),
    outboxRepository,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  }, { now: () => NOW });
  const operation = operationService.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });
  const dependencies: RunEngineDependencies = {
    runRepository,
    operationService,
    lifecycleTransactionService,
    snapshotRepository,
    runStageRepository,
    stageExecutor: new StageExecutor(input => {
      const result = outcome();
      if (result.outcome !== 'failed') return result;
      return {
        ...result,
        problem: {
          ...result.problem,
          context: problemFor(operation.id, input.stageId).context,
        },
      };
    }),
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  };
  return {
    db,
    operationService,
    runRepository,
    runStageRepository,
    snapshotRepository,
    engine: new RunEngine(dependencies),
    operation,
    close: () => db.close(),
  };
}

function dispatchToStarting(fixture: Fixture): void {
  fixture.engine.tick({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
  fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
  fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
}

function state(fixture: Fixture): { run: unknown; stages: unknown[]; operation: ApiOperation; events: unknown[]; outboxes: unknown[] } {
  const runRow = fixture.db.prepare('SELECT status, version, next_event_sequence FROM runs WHERE id = ?').get(RUN_ID) as {
    status: string;
    version: number;
    next_event_sequence: number;
  };
  const stageRows = fixture.db.prepare('SELECT workflow_stage_key, status, version FROM run_stages WHERE run_id = ? ORDER BY sequence ASC, id ASC').all(RUN_ID) as Array<{
    workflow_stage_key: string;
    status: string;
    version: number;
  }>;
  const eventRows = fixture.db.prepare('SELECT type, sequence, timestamp, correlation_id FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC').all(RUN_ID) as Array<{
    type: string;
    sequence: number;
    timestamp: string;
    correlation_id: string;
  }>;
  return {
    run: { status: runRow.status, version: runRow.version, next_event_sequence: runRow.next_event_sequence },
    stages: stageRows.map(row => ({ workflow_stage_key: row.workflow_stage_key, status: row.status, version: row.version })),
    operation: fixture.operationService.findById(WORKSPACE_ID, fixture.operation.id),
    events: eventRows.map(row => ({ type: row.type, sequence: row.sequence, timestamp: row.timestamp, correlation_id: row.correlation_id })),
    outboxes: fixture.db.prepare('SELECT event_id FROM outbox_messages WHERE aggregate_id = ? ORDER BY created_at ASC, id ASC').all(RUN_ID),
  };
}

function assertHealthy(fixture: Fixture): void {
  assert.equal((fixture.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  assert.deepEqual(fixture.db.prepare('PRAGMA foreign_key_check').all(), []);
}

test('Start success completes the twelve-step atomic startup outcome with one timestamp', () => {
  const fixture = createFixture();
  try {
    dispatchToStarting(fixture);
    const result = fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
    assert.ok(result);
    const current = state(fixture);
    assert.deepEqual(current.run, { status: 'running', version: 3, next_event_sequence: 6 });
    assert.equal((current.stages[0] as { status: string; version: number }).status, 'running');
    assert.equal((current.stages[0] as { status: string; version: number }).version, 4);
    assert.equal(current.operation.status, 'completed');
    assert.deepEqual(current.operation.result, { resourceType: 'run', resourceId: RUN_ID });
    assert.equal(current.operation.error, undefined);
    assert.deepEqual(current.events.slice(-2), [
      { type: 'stage.started', sequence: 4, timestamp: NOW, correlation_id: fixture.operation.id },
      { type: 'run.started', sequence: 5, timestamp: NOW, correlation_id: fixture.operation.id },
    ]);
    assert.equal(current.outboxes.length, 5);
    assertHealthy(fixture);
  } finally {
    fixture.close();
  }
});

test('C1b Branch A atomically fails Stage, Run, and Start operation in Shared order', () => {
  const fixture = createFixture(() => ({ outcome: 'failed', problem: PROBLEM, phase: 'provider-start', retryScheduled: false }));
  try {
    dispatchToStarting(fixture);
    fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
    const current = state(fixture);
    assert.equal((current.run as { status: string }).status, 'failed');
    assert.equal((current.stages[0] as { status: string }).status, 'failed');
    assert.equal(current.operation.status, 'failed');
    assert.deepEqual(current.events.slice(-2), [
      { type: 'stage.failed', sequence: 4, timestamp: NOW, correlation_id: fixture.operation.id },
      { type: 'run.failed', sequence: 5, timestamp: NOW, correlation_id: fixture.operation.id },
    ]);
    assert.equal(current.outboxes.length, 5);
    assertHealthy(fixture);
  } finally {
    fixture.close();
  }
});

test('C1b Branch B fails only Run and Operation before any Stage enters starting', () => {
  const fixture = createFixture();
  try {
    fixture.engine.tick({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
    fixture.engine.dispatch({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      startupFailure: { problem: problemFor(fixture.operation.id), phase: 'snapshot-validation' },
    });
    const current = state(fixture);
    assert.equal((current.run as { status: string }).status, 'failed');
    assert.ok(current.stages.every(stage => (stage as { status: string }).status === 'pending'));
    assert.equal(current.operation.status, 'failed');
    assert.deepEqual(current.events, [
      { type: 'run.dequeued', sequence: 1, timestamp: NOW, correlation_id: fixture.operation.id },
      { type: 'run.failed', sequence: 2, timestamp: NOW, correlation_id: fixture.operation.id },
    ]);
    assert.equal(current.outboxes.length, 2);
    assertHealthy(fixture);
  } finally {
    fixture.close();
  }
});

test('C1a explicit pre-claim failure changes only the queued Operation', () => {
  const fixture = createFixture();
  try {
    const result = fixture.engine.recordPreClaimFailure({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      operationId: fixture.operation.id,
      expectedOperationVersion: fixture.operation.version,
      problem: problemFor(fixture.operation.id),
    });
    assert.equal(result.status, 'failed');
    const current = state(fixture);
    assert.equal((current.run as { status: string }).status, 'queued');
    assert.equal(current.operation.status, 'failed');
    assert.deepEqual(current.events, []);
    assert.deepEqual(current.outboxes, []);
    assertHealthy(fixture);
  } finally {
    fixture.close();
  }
});

test('C2 completion keeps the completed Start operation immutable', () => {
  let executorCalls = 0;
  const fixture = createFixture(() => {
    executorCalls += 1;
    return executorCalls === 1
      ? { outcome: 'active' }
      : {
          outcome: 'completed',
          durationMs: 10,
          artifactIds: [],
          outputContractSatisfied: true,
        };
  });
  try {
    dispatchToStarting(fixture);
    fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
    const completedOperation = fixture.operationService.findById(WORKSPACE_ID, fixture.operation.id);
    assert.equal((state(fixture).run as { status: string }).status, 'running');
    let dispatches = 0;
    while ((state(fixture).run as { status: string }).status === 'running') {
      assert.ok(fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID }));
      dispatches += 1;
      assert.ok(dispatches < 20);
    }
    const currentOperation = fixture.operationService.findById(WORKSPACE_ID, fixture.operation.id);
    assert.deepEqual(currentOperation, completedOperation);
    assert.equal((state(fixture).run as { status: string }).status, 'completed');
    assertHealthy(fixture);
  } finally {
    fixture.close();
  }
});

test('C2 failure skips only downstream pending descendants and leaves Start operation immutable', () => {
  let executorCalls = 0;
  const fixture = createFixture(() => {
    executorCalls += 1;
    return executorCalls === 1
      ? { outcome: 'active' }
      : { outcome: 'failed', problem: PROBLEM, phase: 'stage-run', retryScheduled: false };
  });
  try {
    dispatchToStarting(fixture);
    fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID });
    const completedOperation = fixture.operationService.findById(WORKSPACE_ID, fixture.operation.id);
    let dispatches = 0;
    while ((state(fixture).run as { status: string }).status === 'running') {
      assert.ok(fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID }));
      dispatches += 1;
      assert.ok(dispatches < 20);
    }
    const current = state(fixture);
    assert.equal((current.run as { status: string }).status, 'failed');
    assert.deepEqual(current.stages.map(stage => (stage as { status: string }).status), [
      'failed', 'skipped', 'skipped', 'skipped',
    ]);
    assert.deepEqual(fixture.operationService.findById(WORKSPACE_ID, fixture.operation.id), completedOperation);
    assertHealthy(fixture);
  } finally {
    fixture.close();
  }
});

test('file-backed startup success and failure have one complete winner', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p3b2b-'));
  const databasePath = join(root, 'startup.sqlite');
  const fixture = createFixture(() => ({ outcome: 'active' }), databasePath);
  try {
    assert.ok(fixture.engine.dispatch({ workspaceId: WORKSPACE_ID, runId: RUN_ID }));
    assertHealthy(fixture);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
