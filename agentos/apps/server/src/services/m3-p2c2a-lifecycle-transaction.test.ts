import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createM3RuntimeEventRegistry, type M3RunStatus, type M3StageStatus } from '@agentos/shared';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { inTransaction } from '../store/Transaction.js';
import { OutboxRepository } from '../store/OutboxRepository.js';
import { RunRepository } from '../store/RunRepository.js';
import { RunSequenceAllocator } from '../store/RunSequenceAllocator.js';
import { RunStageRepository } from '../store/RunStageRepository.js';
import { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import {
  LifecycleTransactionError,
  LifecycleTransactionService,
  type LifecycleTransactionServiceOptions,
  type RunTransitionInput,
  type StageTransitionInput,
} from './LifecycleTransactionService.js';

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

const WORKSPACE_ID = 'workspace-lifecycle-test';
const TASK_ID = 'task-lifecycle-test';
const RUN_ID = 'run-lifecycle-test';
const SECOND_RUN_ID = 'run-lifecycle-test-2';
const STAGE_ID = 'stage-lifecycle-test';
const SNAPSHOT_ID = 'snapshot-lifecycle-test';
const NOW = '2026-08-02T12:00:00.000Z';

interface Fixture {
  db: Database;
  runRepository: RunRepository;
  runStageRepository: RunStageRepository;
  runtimeEventRepository: RuntimeEventRepository;
  runSequenceAllocator: RunSequenceAllocator;
  outboxRepository: OutboxRepository;
  service: LifecycleTransactionService;
}

function newFixture(databasePath = ':memory:', options: LifecycleTransactionServiceOptions = {}): Fixture {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  db.exec(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES ('${WORKSPACE_ID}', 'Lifecycle Test', '.', 'lifecycle-test-root', '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO tasks (
      id, workspace_id, title, created_by, created_at, updated_at
    ) VALUES ('${TASK_ID}', '${WORKSPACE_ID}', 'Lifecycle task', 'test', '${NOW}', '${NOW}');
    INSERT INTO runs (
      id, workspace_id, task_id, root_run_id, status, reason, origin,
      next_event_sequence, created_by, created_at, updated_at, version, recovery_required
    ) VALUES (
      '${RUN_ID}', '${WORKSPACE_ID}', '${TASK_ID}', '${RUN_ID}', 'queued', 'initial', 'v2_api',
      1, 'test', '${NOW}', '${NOW}', 1, 0
    );
    INSERT INTO run_snapshots (
      id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
      snapshot_json, content_hash, redaction_applied, captured_at
    ) VALUES (
      '${SNAPSHOT_ID}', '${WORKSPACE_ID}', '${RUN_ID}',
      'workflow_00000000000000000000000002', 1, '{}',
      '${'0'.repeat(64)}', 0, '${NOW}'
    );
    INSERT INTO run_stages (
      id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
      sequence, attempt, status, created_at, updated_at, version
    ) VALUES (
      '${STAGE_ID}', '${WORKSPACE_ID}', '${RUN_ID}', '${SNAPSHOT_ID}',
      'stage_one', 'stage_one', 1, 1, 'pending', '${NOW}', '${NOW}', 1
    );
  `);

  const runRepository = new RunRepository(db);
  const runStageRepository = new RunStageRepository(db);
  const runtimeEventRepository = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const runSequenceAllocator = new RunSequenceAllocator(db);
  const outboxRepository = new OutboxRepository(db, runtimeEventRepository);
  const service = new LifecycleTransactionService({
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    runSequenceAllocator,
    outboxRepository,
    runInTransaction: fn => inTransaction(db, fn),
  }, { now: () => NOW, ...options });
  return {
    db,
    runRepository,
    runStageRepository,
    runtimeEventRepository,
    runSequenceAllocator,
    outboxRepository,
    service,
  };
}

async function withFixture<T>(fn: (fixture: Fixture) => T | Promise<T>, options: LifecycleTransactionServiceOptions = {}): Promise<T> {
  const fixture = newFixture(':memory:', options);
  try {
    return await fn(fixture);
  } finally {
    fixture.db.close();
  }
}

function setRunStatus(fixture: Fixture, status: M3RunStatus): void {
  fixture.db.prepare(`
    UPDATE runs
    SET status = ?, version = 1, failure_code = NULL, failure_message = NULL,
      started_at = NULL, completed_at = NULL, cancellation_requested_at = NULL,
      next_event_sequence = 1, updated_at = ?
    WHERE workspace_id = ? AND id = ?
  `).run(status, NOW, WORKSPACE_ID, RUN_ID);
}

function setStageStatus(fixture: Fixture, status: M3StageStatus): void {
  fixture.db.prepare(`
    UPDATE run_stages
    SET status = ?, version = 1, failure_code = NULL, failure_message = NULL,
      started_at = NULL, completed_at = NULL, updated_at = ?
    WHERE workspace_id = ? AND run_id = ? AND id = ?
  `).run(status, NOW, WORKSPACE_ID, RUN_ID, STAGE_ID);
}

function runInput(fixture: Fixture, expectedFrom: M3RunStatus, to: M3RunStatus): RunTransitionInput {
  const common = {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    expectedVersion: 1,
    expectedFrom,
    to,
    correlationId: `correlation-${expectedFrom}-${to}`,
  };
  if (to === 'starting') return common as RunTransitionInput;
  if (to === 'failed') {
    return {
      ...common,
      errorCode: 'E_LIFECYCLE',
      message: 'lifecycle failure',
      phase: 'execution',
      retryable: false,
    } as RunTransitionInput;
  }
  if (to === 'paused') {
    return { ...common, reason: 'user', resumable: true } as RunTransitionInput;
  }
  return { ...common, resumeMode: 'native-session' } as RunTransitionInput;
}

function stageInput(fixture: Fixture, expectedFrom: M3StageStatus, to: M3StageStatus): StageTransitionInput {
  const common = {
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    stageId: STAGE_ID,
    expectedVersion: 1,
    expectedFrom,
    to,
    correlationId: `correlation-stage-${expectedFrom}-${to}`,
  };
  if (to === 'ready') return { ...common, dependenciesCompleted: [] } as StageTransitionInput;
  if (to === 'skipped') return { ...common, condition: 'false', reason: 'condition not met' } as StageTransitionInput;
  if (to === 'failed') {
    return {
      ...common,
      errorCode: 'E_STAGE',
      message: 'stage failure',
      retryable: true,
      retryScheduled: false,
    } as StageTransitionInput;
  }
  if (to === 'paused') return { ...common, reason: 'operator hold', resumable: true } as StageTransitionInput;
  if (to === 'completed') {
    return {
      ...common,
      durationMs: 42,
      artifactIds: ['artifact-output'],
      outputContractSatisfied: true,
    } as StageTransitionInput;
  }
  return { ...common, resumeMode: 'process-restart' } as StageTransitionInput;
}

function assertRunResult(fixture: Fixture, result: ReturnType<LifecycleTransactionService['transitionRun']>, expectedStatus: M3RunStatus, expectedType: string, expectedPayload: Record<string, unknown>): void {
  assert.equal(result.run.status, expectedStatus);
  assert.equal(result.run.version, 2);
  assert.equal(result.event.type, expectedType);
  assert.equal(result.event.sequence, 1);
  assert.deepEqual(result.event.payload, expectedPayload);
  assert.equal(result.event.taskId, TASK_ID);
  assert.equal(result.event.stageId, undefined);
  assert.equal(result.outbox.eventId, result.event.id);
  assert.equal(result.outbox.aggregateType, 'run');
  assert.equal(result.outbox.aggregateId, RUN_ID);
  assert.deepEqual(result.outbox.event, result.event);
  assert.equal((fixture.db.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get(RUN_ID) as { next_event_sequence: number }).next_event_sequence, 2);
}

function assertStageResult(fixture: Fixture, result: ReturnType<LifecycleTransactionService['transitionStage']>, expectedStatus: M3StageStatus, expectedType: string, expectedPayload: Record<string, unknown>): void {
  assert.equal(result.stage.status, expectedStatus);
  assert.equal(result.stage.version, 2);
  assert.equal(result.event.type, expectedType);
  assert.equal(result.event.sequence, 1);
  assert.deepEqual(result.event.payload, expectedPayload);
  assert.equal(result.event.taskId, TASK_ID);
  assert.equal(result.event.stageId, STAGE_ID);
  assert.equal(result.outbox.eventId, result.event.id);
  assert.equal(result.outbox.aggregateId, RUN_ID);
  assert.deepEqual(result.outbox.event, result.event);
  assert.equal((fixture.db.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get(RUN_ID) as { next_event_sequence: number }).next_event_sequence, 2);
}

test('P2C-2A Run queued -> starting emits run.dequeued with service timestamp', () => withFixture(fixture => {
  const result = fixture.service.transitionRun(runInput(fixture, 'queued', 'starting'));
  assertRunResult(fixture, result, 'starting', 'run.dequeued', { dequeuedAt: NOW });
}));

test('P2C-2A Run starting -> failed persists failure fields and emits run.failed', () => withFixture(fixture => {
  setRunStatus(fixture, 'starting');
  const result = fixture.service.transitionRun(runInput(fixture, 'starting', 'failed'));
  assertRunResult(fixture, result, 'failed', 'run.failed', {
    errorCode: 'E_LIFECYCLE', message: 'lifecycle failure', phase: 'execution', retryable: false,
  });
  assert.deepEqual(fixture.runRepository.findById(WORKSPACE_ID, RUN_ID), result.run);
}));

test('P2C-2A Run running -> paused emits run.paused', () => withFixture(fixture => {
  setRunStatus(fixture, 'running');
  const result = fixture.service.transitionRun(runInput(fixture, 'running', 'paused'));
  assertRunResult(fixture, result, 'paused', 'run.paused', { reason: 'user', resumable: true });
}));

test('P2C-2A Run running -> failed emits run.failed', () => withFixture(fixture => {
  setRunStatus(fixture, 'running');
  const result = fixture.service.transitionRun(runInput(fixture, 'running', 'failed'));
  assertRunResult(fixture, result, 'failed', 'run.failed', {
    errorCode: 'E_LIFECYCLE', message: 'lifecycle failure', phase: 'execution', retryable: false,
  });
}));

test('P2C-2A Run paused -> running emits run.resumed', () => withFixture(fixture => {
  setRunStatus(fixture, 'paused');
  const result = fixture.service.transitionRun(runInput(fixture, 'paused', 'running'));
  assertRunResult(fixture, result, 'running', 'run.resumed', { resumeMode: 'native-session' });
}));

test('P2C-2A Run paused -> failed emits run.failed', () => withFixture(fixture => {
  setRunStatus(fixture, 'paused');
  const result = fixture.service.transitionRun(runInput(fixture, 'paused', 'failed'));
  assertRunResult(fixture, result, 'failed', 'run.failed', {
    errorCode: 'E_LIFECYCLE', message: 'lifecycle failure', phase: 'execution', retryable: false,
  });
}));

test('P2C-2A Stage pending -> ready emits stage.ready', () => withFixture(fixture => {
  const result = fixture.service.transitionStage(stageInput(fixture, 'pending', 'ready'));
  assertStageResult(fixture, result, 'ready', 'stage.ready', { dependenciesCompleted: [] });
}));

test('P2C-2A Stage pending -> skipped writes completed_at and emits stage.skipped', () => withFixture(fixture => {
  const result = fixture.service.transitionStage(stageInput(fixture, 'pending', 'skipped'));
  assertStageResult(fixture, result, 'skipped', 'stage.skipped', { condition: 'false', reason: 'condition not met' });
  assert.equal(result.stage.completedAt, NOW);
}));

test('P2C-2A Stage ready -> starting emits stage.starting with service timestamp', () => withFixture(fixture => {
  setStageStatus(fixture, 'ready');
  const result = fixture.service.transitionStage(stageInput(fixture, 'ready', 'starting'));
  assertStageResult(fixture, result, 'starting', 'stage.starting', {
    workflowStageKey: 'stage_one', name: 'stage_one', attempt: 1, startingAt: NOW,
  });
}));

test('P2C-2A Stage starting -> failed persists failure fields and emits stage.failed', () => withFixture(fixture => {
  setStageStatus(fixture, 'starting');
  const result = fixture.service.transitionStage(stageInput(fixture, 'starting', 'failed'));
  assertStageResult(fixture, result, 'failed', 'stage.failed', {
    attempt: 1, errorCode: 'E_STAGE', message: 'stage failure', retryable: true, retryScheduled: false,
  });
  assert.equal(result.stage.failureCode, 'E_STAGE');
  assert.equal(result.stage.failureMessage, 'stage failure');
}));

test('P2C-2A Stage running -> paused emits stage.paused', () => withFixture(fixture => {
  setStageStatus(fixture, 'running');
  const result = fixture.service.transitionStage(stageInput(fixture, 'running', 'paused'));
  assertStageResult(fixture, result, 'paused', 'stage.paused', { reason: 'operator hold', resumable: true });
}));

test('P2C-2A Stage running -> completed writes completed_at without run completion', () => withFixture(fixture => {
  setStageStatus(fixture, 'running');
  const result = fixture.service.transitionStage(stageInput(fixture, 'running', 'completed'));
  assertStageResult(fixture, result, 'completed', 'stage.completed', {
    attempt: 1, durationMs: 42, artifactIds: ['artifact-output'], outputContractSatisfied: true,
  });
  assert.equal(result.stage.completedAt, NOW);
  assert.equal(result.run.status, 'queued');
  assert.equal(fixture.runtimeEventRepository.listByRunAfterSequence(RUN_ID, 0).length, 1);
}));

test('P2C-2A Stage running -> failed persists failure fields and emits stage.failed', () => withFixture(fixture => {
  setStageStatus(fixture, 'running');
  const result = fixture.service.transitionStage(stageInput(fixture, 'running', 'failed'));
  assertStageResult(fixture, result, 'failed', 'stage.failed', {
    attempt: 1, errorCode: 'E_STAGE', message: 'stage failure', retryable: true, retryScheduled: false,
  });
}));

test('P2C-2A Stage paused -> running emits stage.resumed', () => withFixture(fixture => {
  setStageStatus(fixture, 'paused');
  const result = fixture.service.transitionStage(stageInput(fixture, 'paused', 'running'));
  assertStageResult(fixture, result, 'running', 'stage.resumed', { resumeMode: 'process-restart' });
}));

function snapshot(fixture: Fixture): Record<string, unknown> {
  return {
    run: fixture.db.prepare('SELECT status, version, failure_code, failure_message, next_event_sequence FROM runs WHERE id = ?').get(RUN_ID),
    stage: fixture.db.prepare('SELECT status, version, failure_code, failure_message, started_at, completed_at FROM run_stages WHERE id = ?').get(STAGE_ID),
    events: (fixture.db.prepare('SELECT COUNT(*) AS count FROM runtime_events').get() as { count: number }).count,
    outbox: (fixture.db.prepare('SELECT COUNT(*) AS count FROM outbox_messages').get() as { count: number }).count,
  };
}

function assertLifecycleError(fn: () => unknown, code: LifecycleTransactionError['code']): void {
  assert.throws(fn, (error: unknown) => error instanceof LifecycleTransactionError && error.code === code);
}

test('P2C-2A rejects all unsupported Run composite transitions without writes', () => withFixture(fixture => {
  const before = snapshot(fixture);
  assertLifecycleError(() => fixture.service.transitionRun({
    workspaceId: WORKSPACE_ID, runId: RUN_ID, expectedVersion: 1,
    expectedFrom: 'queued', to: 'running', correlationId: 'composite-run',
  } as RunTransitionInput), 'LIFECYCLE_COMPOSITE_TRANSITION_REQUIRED');
  assert.deepEqual(snapshot(fixture), before);
}));

test('P2C-2A rejects all unsupported Stage composite transitions without writes', () => withFixture(fixture => {
  const before = snapshot(fixture);
  assertLifecycleError(() => fixture.service.transitionStage({
    workspaceId: WORKSPACE_ID, runId: RUN_ID, stageId: STAGE_ID, expectedVersion: 1,
    expectedFrom: 'starting', to: 'running', correlationId: 'composite-stage',
  } as StageTransitionInput), 'LIFECYCLE_COMPOSITE_TRANSITION_REQUIRED');
  assert.deepEqual(snapshot(fixture), before);
}));

test('P2C-2A rollback matrix preserves current state, sequence, events, and outbox on every failure', async () => {
  const cases: Array<{ name: string; invoke: (fixture: Fixture) => void; prepare?: (fixture: Fixture) => void }> = [
    {
      name: 'registry payload rejection',
      prepare: fixture => setRunStatus(fixture, 'starting'),
      invoke: fixture => fixture.service.transitionRun({
        ...runInput(fixture, 'starting', 'failed'),
        providerType: 'invalid-provider' as never,
      } as RunTransitionInput),
    },
    {
      name: 'duplicate event id',
      prepare: fixture => {
        const eventId = 'evt_01J6J3Z7V6T5C4D3E2F1G0H9K8';
        inTransaction(fixture.db, () => fixture.runtimeEventRepository.appendWithinTransaction({
          id: eventId, schemaVersion: 1, type: 'run.dequeued', workspaceId: WORKSPACE_ID,
          taskId: TASK_ID, runId: RUN_ID, sequence: 99, timestamp: NOW,
          correlationId: 'existing-event', payload: { dequeuedAt: NOW },
        }));
        fixture.db.prepare('UPDATE runs SET next_event_sequence = 1 WHERE id = ?').run(RUN_ID);
        fixture.service = new LifecycleTransactionService({
          runRepository: fixture.runRepository, runStageRepository: fixture.runStageRepository,
          runtimeEventRepository: fixture.runtimeEventRepository, runSequenceAllocator: fixture.runSequenceAllocator,
          outboxRepository: fixture.outboxRepository, runInTransaction: fn => inTransaction(fixture.db, fn),
        }, { now: () => NOW, createEventId: () => eventId });
      },
      invoke: fixture => fixture.service.transitionRun(runInput(fixture, 'queued', 'starting')),
    },
    {
      name: 'duplicate outbox id',
      prepare: fixture => {
        const event = inTransaction(fixture.db, () => fixture.runtimeEventRepository.appendWithinTransaction({
          id: 'evt_01J6J3Z7V6T5C4D3E2F1G0H9K7', schemaVersion: 1, type: 'run.dequeued', workspaceId: WORKSPACE_ID,
          taskId: TASK_ID, runId: RUN_ID, sequence: 99, timestamp: NOW,
          correlationId: 'existing-outbox-event', payload: { dequeuedAt: NOW },
        }));
        fixture.outboxRepository.insertWithinTransaction({ id: 'outbox_duplicate', eventId: event.id, availableAt: NOW, createdAt: NOW });
        fixture.service = new LifecycleTransactionService({
          runRepository: fixture.runRepository, runStageRepository: fixture.runStageRepository,
          runtimeEventRepository: fixture.runtimeEventRepository, runSequenceAllocator: fixture.runSequenceAllocator,
          outboxRepository: fixture.outboxRepository, runInTransaction: fn => inTransaction(fixture.db, fn),
        }, { now: () => NOW, createOutboxId: () => 'outbox_duplicate' });
      },
      invoke: fixture => fixture.service.transitionRun(runInput(fixture, 'queued', 'starting')),
    },
    {
      name: 'runtime event trigger failure',
      prepare: fixture => fixture.db.exec("CREATE TRIGGER test_runtime_event_failure BEFORE INSERT ON runtime_events BEGIN SELECT RAISE(ABORT, 'TEST_RUNTIME_EVENT_FAILURE'); END"),
      invoke: fixture => fixture.service.transitionRun(runInput(fixture, 'queued', 'starting')),
    },
    {
      name: 'outbox trigger failure',
      prepare: fixture => fixture.db.exec("CREATE TRIGGER test_outbox_failure BEFORE INSERT ON outbox_messages BEGIN SELECT RAISE(ABORT, 'TEST_OUTBOX_FAILURE'); END"),
      invoke: fixture => fixture.service.transitionRun(runInput(fixture, 'queued', 'starting')),
    },
    {
      name: 'stale version',
      invoke: fixture => fixture.service.transitionRun({ ...runInput(fixture, 'queued', 'starting'), expectedVersion: 2 } as RunTransitionInput),
    },
    {
      name: 'wrong expected state',
      invoke: fixture => fixture.service.transitionRun(runInput(fixture, 'running', 'paused')),
    },
    {
      name: 'wrong workspace',
      invoke: fixture => fixture.service.transitionRun({ ...runInput(fixture, 'queued', 'starting'), workspaceId: 'workspace-other' } as RunTransitionInput),
    },
    {
      name: 'stage belongs to another run',
      prepare: fixture => {
        fixture.db.prepare(`
          INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, next_event_sequence, created_by, created_at, updated_at, version, recovery_required)
          VALUES (?, ?, ?, ?, 'failed', 'initial', 'v2_api', 1, 'test', ?, ?, 1, 0)
        `).run(SECOND_RUN_ID, WORKSPACE_ID, TASK_ID, SECOND_RUN_ID, NOW, NOW);
      },
      invoke: fixture => fixture.service.transitionStage({
        ...stageInput(fixture, 'pending', 'ready'), runId: SECOND_RUN_ID,
      } as StageTransitionInput),
    },
  ];

  for (const failureCase of cases) {
    await withFixture(fixture => {
      const before = snapshot(fixture);
      failureCase.prepare?.(fixture);
      const prepared = snapshot(fixture);
      assert.throws(() => failureCase.invoke(fixture), failureCase.name);
      assert.deepEqual(snapshot(fixture), prepared, failureCase.name);
      if (failureCase.name === 'registry payload rejection') {
        assert.notDeepEqual(prepared, before, failureCase.name);
      }
    });
  }
});

function runConcurrentLifecycleChild(databasePath: string, correlationId: string): Promise<Record<string, unknown>> {
  const childSource = `
    import { createRequire } from 'node:module';
    import { createM3RuntimeEventRegistry } from '@agentos/shared';
    import { inTransaction } from './src/store/Transaction.ts';
    import { OutboxRepository } from './src/store/OutboxRepository.ts';
    import { RunRepository } from './src/store/RunRepository.ts';
    import { RunSequenceAllocator } from './src/store/RunSequenceAllocator.ts';
    import { RunStageRepository } from './src/store/RunStageRepository.ts';
    import { RuntimeEventRepository } from './src/store/RuntimeEventRepository.ts';
    import { LifecycleTransactionService } from './src/services/LifecycleTransactionService.ts';
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(process.env.LIFECYCLE_DB);
    db.exec('PRAGMA foreign_keys = ON');
    const runtimeEventRepository = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
    const service = new LifecycleTransactionService({
      runRepository: new RunRepository(db),
      runStageRepository: new RunStageRepository(db),
      runtimeEventRepository,
      runSequenceAllocator: new RunSequenceAllocator(db),
      outboxRepository: new OutboxRepository(db, runtimeEventRepository),
      runInTransaction: fn => inTransaction(db, fn),
    }, { now: () => '${NOW}' });
    try {
      const result = service.transitionRun({
        workspaceId: '${WORKSPACE_ID}', runId: '${RUN_ID}', expectedVersion: 1,
        expectedFrom: 'queued', to: 'starting', correlationId: '${correlationId}',
      });
      process.stdout.write(JSON.stringify({ ok: true, status: result.run.status, version: result.run.version }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        name: error instanceof Error ? error.name : 'unknown',
        code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      db.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', childSource,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, LIFECYCLE_DB: databasePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`lifecycle child exited ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`lifecycle child output was invalid: ${stdout || stderr}`, { cause: error }));
      }
    });
  });
}

test('P2C-2A file database concurrency allows one conditional transition and rejects the other', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'agentos-p2c2a-'));
  const databasePath = join(tempRoot, 'lifecycle.sqlite');
  const seed = newFixture(databasePath);
  seed.db.close();
  try {
    const results = await Promise.all([
      runConcurrentLifecycleChild(databasePath, 'concurrent-a'),
      runConcurrentLifecycleChild(databasePath, 'concurrent-b'),
    ]);
    assert.equal(results.filter(result => result.ok === true).length, 1);
    assert.equal(results.filter(result => result.ok === false).length, 1);
    const check = new DatabaseSync(databasePath);
    try {
      const run = check.prepare('SELECT status, version, next_event_sequence FROM runs WHERE id = ?').get(RUN_ID) as {
        status: string;
        version: number;
        next_event_sequence: number;
      };
      assert.equal(run.status, 'starting');
      assert.equal(run.version, 2);
      assert.equal(run.next_event_sequence, 2);
      assert.equal((check.prepare('SELECT COUNT(*) AS count FROM runtime_events').get() as { count: number }).count, 1);
      assert.equal((check.prepare('SELECT COUNT(*) AS count FROM outbox_messages').get() as { count: number }).count, 1);
      assert.deepEqual(
        (check.prepare('SELECT sequence FROM runtime_events WHERE run_id = ? ORDER BY sequence').all(RUN_ID) as Array<{ sequence: number }>).map(row => row.sequence),
        [1],
      );
      assert.equal((check.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.deepEqual(check.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      check.close();
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
