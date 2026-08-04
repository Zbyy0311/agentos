import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import test from 'node:test';
import type {
  ApiOperation,
  RuntimeEventDraft,
  RuntimeEventEnvelope,
} from '@agentos/shared';
import { createM3RuntimeEventRegistry } from '@agentos/shared';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../../migrations/default-registry.js';
import { MigrationRunner } from '../../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../../migrations/registry.js';
import { inTransaction } from '../../store/Transaction.js';
import { createEntityId } from '../../store/Identity.js';
import type { OperationType } from '../../store/OperationRepository.js';
import {
  OutboxRepository,
  type InsertOutboxMessageInput,
  type OutboxMessage,
} from '../../store/OutboxRepository.js';
import { RunRepository } from '../../store/RunRepository.js';
import { RunSequenceAllocator } from '../../store/RunSequenceAllocator.js';
import { RunStageRepository } from '../../store/RunStageRepository.js';
import { RuntimeEventRepository } from '../../store/RuntimeEventRepository.js';
import { OperationService } from '../OperationService.js';
import { LifecycleTransactionService } from '../LifecycleTransactionService.js';
import {
  RunEngine,
  RunEngineError,
  type RunEngineDependencies,
} from './RunEngine.js';

interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...parameters: unknown[]): unknown[];
    get(...parameters: unknown[]): unknown;
    run(...parameters: unknown[]): unknown;
  };
  close(): void;
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => Database;
};

const NOW = '2026-08-04T12:00:00.000Z';

interface SeedIds {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
}

interface FixtureOptions {
  readonly retryRun?: boolean;
  readonly eventFailure?: boolean;
  readonly outboxFailure?: boolean;
}

interface FixtureBase {
  readonly db: Database;
  readonly workspaceId: string;
  readonly runId: string;
  readonly runRepository: RunRepository;
  readonly operationService: OperationService;
  readonly lifecycleTransactionService: LifecycleTransactionService;
  readonly runtimeEventRepository: RuntimeEventRepository;
  readonly outboxRepository: OutboxRepository;
}

interface Fixture extends FixtureBase {
  readonly engine: RunEngine;
}

class EventInsertFailureRepository extends RuntimeEventRepository {
  override appendWithinTransaction<TPayload>(
    _draft: RuntimeEventDraft<TPayload>,
  ): RuntimeEventEnvelope<TPayload> {
    throw new Error('injected runtime event insert failure');
  }
}

class OutboxInsertFailureRepository extends OutboxRepository {
  override insertWithinTransaction(_input: InsertOutboxMessageInput): OutboxMessage {
    throw new Error('injected outbox insert failure');
  }
}

function insertRun(
  db: Database,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly taskId: string;
    readonly parentRunId?: string;
    readonly rootRunId: string;
    readonly status: 'queued' | 'failed';
    readonly reason: 'initial' | 'retry';
  },
): void {
  db.prepare(`
    INSERT INTO runs (
      id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin,
      next_event_sequence, started_at, completed_at, created_by, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'v2_api', 1, ?, ?, 'test', ?, ?, 1)
  `).run(
    input.id,
    input.workspaceId,
    input.taskId,
    input.parentRunId ?? null,
    input.rootRunId,
    input.status,
    input.reason,
    input.status === 'failed' ? NOW : null,
    input.status === 'failed' ? NOW : null,
    NOW,
    NOW,
  );
}

function seedDatabase(db: Database, retryRun: boolean): SeedIds {
  const workspaceId = createEntityId('workspace');
  const taskId = createEntityId('task');
  const runId = createEntityId('run');
  db.prepare(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(workspaceId, 'P3B-1 Engine test', '.', 'p3b1-engine', NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(taskId, workspaceId, 'P3B-1 Engine task', 'test', NOW, NOW);

  if (retryRun) {
    const parentRunId = createEntityId('run');
    insertRun(db, {
      id: parentRunId,
      workspaceId,
      taskId,
      rootRunId: parentRunId,
      status: 'failed',
      reason: 'initial',
    });
    insertRun(db, {
      id: runId,
      workspaceId,
      taskId,
      parentRunId,
      rootRunId: parentRunId,
      status: 'queued',
      reason: 'retry',
    });
  } else {
    insertRun(db, {
      id: runId,
      workspaceId,
      taskId,
      rootRunId: runId,
      status: 'queued',
      reason: 'initial',
    });
  }
  return { workspaceId, taskId, runId };
}

function buildFixtureBase(db: Database, ids: SeedIds, options: FixtureOptions): FixtureBase {
  const runtimeEventRegistry = createM3RuntimeEventRegistry();
  const runtimeEventRepository = options.eventFailure
    ? new EventInsertFailureRepository(db, runtimeEventRegistry)
    : new RuntimeEventRepository(db, runtimeEventRegistry);
  const outboxRepository = options.outboxFailure
    ? new OutboxInsertFailureRepository(db, runtimeEventRepository, { now: () => NOW })
    : new OutboxRepository(db, runtimeEventRepository, { now: () => NOW });
  const runRepository = new RunRepository(db);
  const operationService = new OperationService(db, { now: () => NOW });
  const lifecycleTransactionService = new LifecycleTransactionService({
    runRepository,
    runStageRepository: new RunStageRepository(db),
    runtimeEventRepository,
    runSequenceAllocator: new RunSequenceAllocator(db),
    outboxRepository,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  }, { now: () => NOW });
  return {
    db,
    workspaceId: ids.workspaceId,
    runId: ids.runId,
    runRepository,
    operationService,
    lifecycleTransactionService,
    runtimeEventRepository,
    outboxRepository,
  };
}

function createEngine(fixture: FixtureBase, overrides: Partial<RunEngineDependencies> = {}): RunEngine {
  const dependencies: RunEngineDependencies = {
    runRepository: fixture.runRepository,
    operationService: fixture.operationService,
    lifecycleTransactionService: fixture.lifecycleTransactionService,
    runInTransaction: <T>(fn: () => T): T => inTransaction(fixture.db, fn),
  };
  return new RunEngine({ ...dependencies, ...overrides });
}

function createFixture(databasePath = ':memory:', options: FixtureOptions = {}): Fixture {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  const ids = seedDatabase(db, options.retryRun === true);
  const base = buildFixtureBase(db, ids, options);
  return { ...base, engine: createEngine(base) };
}

async function withFixture<T>(
  callback: (fixture: Fixture) => T | Promise<T>,
  options: FixtureOptions = {},
): Promise<T> {
  const fixture = createFixture(':memory:', options);
  try {
    return await callback(fixture);
  } finally {
    fixture.db.close();
  }
}

function createOperation(fixture: FixtureBase, type: OperationType): ApiOperation {
  return fixture.operationService.create({
    workspaceId: fixture.workspaceId,
    runId: fixture.runId,
    type,
  });
}

function transitionOperationToRunning(fixture: FixtureBase, operation: ApiOperation): ApiOperation {
  return fixture.operationService.transition({
    workspaceId: fixture.workspaceId,
    operationId: operation.id,
    expectedVersion: operation.version,
    to: 'running',
  });
}

function runState(fixture: FixtureBase): {
  readonly status: string;
  readonly version: number;
  readonly nextEventSequence: number;
} {
  const row = fixture.db.prepare(`
    SELECT status, version, next_event_sequence
    FROM runs WHERE workspace_id = ? AND id = ?
  `).get(fixture.workspaceId, fixture.runId) as {
    status: string;
    version: number;
    next_event_sequence: number;
  };
  return {
    status: row.status,
    version: row.version,
    nextEventSequence: row.next_event_sequence,
  };
}

function operationState(fixture: FixtureBase): Array<{
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly version: number;
  readonly result?: unknown;
  readonly error?: unknown;
}> {
  return fixture.operationService.listByRun(fixture.workspaceId, fixture.runId).map(operation => ({
    id: operation.id,
    type: operation.type,
    status: operation.status,
    version: operation.version,
    result: operation.result,
    error: operation.error,
  }));
}

function eventsForRun(fixture: FixtureBase): Array<{
  readonly type: string;
  readonly correlation_id: string;
  readonly sequence: number;
}> {
  const rows = fixture.db.prepare(`
    SELECT type, correlation_id, sequence
    FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC
  `).all(fixture.runId) as Array<{
    type: string;
    correlation_id: string;
    sequence: number;
  }>;
  return rows.map(row => ({
    type: row.type,
    correlation_id: row.correlation_id,
    sequence: row.sequence,
  }));
}

function outboxesForRun(fixture: FixtureBase): Array<{
  readonly event_id: string;
  readonly aggregate_id: string;
}> {
  const rows = fixture.db.prepare(`
    SELECT event_id, aggregate_id
    FROM outbox_messages WHERE aggregate_id = ? ORDER BY created_at ASC, id ASC
  `).all(fixture.runId) as Array<{
    event_id: string;
    aggregate_id: string;
  }>;
  return rows.map(row => ({
    event_id: row.event_id,
    aggregate_id: row.aggregate_id,
  }));
}

function assertIntegrity(db: Database): void {
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  assert.equal(integrity.integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
}

function assertNoClaimWrites(
  fixture: FixtureBase,
  beforeRun: ReturnType<typeof runState>,
  beforeOperations: ReturnType<typeof operationState>,
): void {
  assert.deepEqual(runState(fixture), beforeRun);
  assert.deepEqual(operationState(fixture), beforeOperations);
  assert.deepEqual(eventsForRun(fixture), []);
  assert.deepEqual(outboxesForRun(fixture), []);
  assertIntegrity(fixture.db);
}

interface ClaimWorkerData {
  readonly mode: 'claim';
  readonly dbPath: string;
  readonly workspaceId: string;
  readonly runId: string;
}

interface ClaimWorkerMessage {
  readonly ok: boolean;
  readonly outcome?: 'claimed' | 'noop';
  readonly reason?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function runClaimWorker(data: ClaimWorkerData): void {
  const db = new DatabaseSync(data.dbPath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  const runtimeEventRepository = new RuntimeEventRepository(db, createM3RuntimeEventRegistry());
  const outboxRepository = new OutboxRepository(db, runtimeEventRepository, { now: () => NOW });
  const runRepository = new RunRepository(db);
  const operationService = new OperationService(db, { now: () => NOW });
  const lifecycleTransactionService = new LifecycleTransactionService({
    runRepository,
    runStageRepository: new RunStageRepository(db),
    runtimeEventRepository,
    runSequenceAllocator: new RunSequenceAllocator(db),
    outboxRepository,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  }, { now: () => NOW });
  const engine = new RunEngine({
    runRepository,
    operationService,
    lifecycleTransactionService,
    runInTransaction: <T>(fn: () => T): T => inTransaction(db, fn),
  });
  try {
    const result = engine.tick({ workspaceId: data.workspaceId, runId: data.runId });
    parentPort!.postMessage(result.outcome === 'claimed'
      ? { ok: true, outcome: 'claimed' }
      : { ok: true, outcome: 'noop', reason: result.reason });
  } catch (error) {
    parentPort!.postMessage({
      ok: false,
      errorCode: errorCode(error),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
    parentPort!.close();
  }
}

function spawnClaimWorker(data: ClaimWorkerData): Promise<ClaimWorkerMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./RunEngine.test.ts', import.meta.url), {
      workerData: data,
      execArgv: ['--import', 'tsx'],
    });
    let received = false;
    worker.once('message', message => {
      received = true;
      resolve(message as ClaimWorkerMessage);
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (!received && code !== 0) reject(new Error(`claim worker exited with ${code}`));
    });
  });
}

const currentWorkerData = workerData as ClaimWorkerData | undefined;

if (!isMainThread && currentWorkerData?.mode === 'claim' && parentPort) {
  runClaimWorker(currentWorkerData);
} else {
  test('RunEngine construction and no tick perform no writes and register no background behavior', async () => {
    await withFixture(async fixture => {
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      const source = readFileSync(new URL('./RunEngine.ts', import.meta.url), 'utf8');
      const forbiddenTimerNames = [['set', 'Interval'], ['set', 'Timeout']]
        .map(parts => parts.join(''));
      assert.equal(forbiddenTimerNames.some(name => source.includes(name)), false);
      const schedulerTableName = ['scheduler', '_jobs'].join('');
      assert.equal(source.includes(schedulerTableName), false);
      const engine = createEngine(fixture);
      assert.ok(engine);
      assert.deepEqual(runState(fixture), beforeRun);
      assert.deepEqual(operationState(fixture), beforeOperations);
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assert.equal(
        fixture.db.prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${schedulerTableName}'`,
        ).get(),
        undefined,
      );
      assertIntegrity(fixture.db);
    });
  });

  test('queued Run without active authorization is a repeatable no-op', async () => {
    await withFixture(async fixture => {
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      assert.deepEqual(fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }), {
        outcome: 'noop',
        reason: 'no-authorization',
        runId: fixture.runId,
      });
      assert.deepEqual(fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }), {
        outcome: 'noop',
        reason: 'no-authorization',
        runId: fixture.runId,
      });
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    });
  });

  test('run.create and run.cancel never authorize an execution claim', async () => {
    await withFixture(async fixture => {
      createOperation(fixture, 'run.create');
      createOperation(fixture, 'run.cancel');
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.deepEqual(result, { outcome: 'noop', reason: 'no-authorization', runId: fixture.runId });
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    });
    await withFixture(async fixture => {
      createOperation(fixture, 'run.create');
      createOperation(fixture, 'run.cancel');
      const authorization = createOperation(fixture, 'run.start');
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.equal(result.outcome, 'claimed');
      if (result.outcome !== 'claimed') return;
      assert.equal(result.operation.id, authorization.id);
      assert.equal(result.event.correlationId, authorization.id);
      assert.equal(result.run.status, 'starting');
      assertIntegrity(fixture.db);
    });
  });

  test('unique queued run.start claims Operation and Run atomically with run.dequeued', async () => {
    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.equal(result.outcome, 'claimed');
      if (result.outcome !== 'claimed') return;
      assert.equal(result.operation.id, authorization.id);
      assert.equal(result.operation.status, 'running');
      assert.equal(result.operation.version, authorization.version + 1);
      assert.equal(result.operation.result, undefined);
      assert.equal(result.operation.error, undefined);
      assert.equal('progress' in result.operation, false);
      assert.equal(result.run.status, 'starting');
      assert.equal(result.run.version, 2);
      assert.equal(result.event.type, 'run.dequeued');
      assert.equal(result.event.correlationId, authorization.id);
      assert.equal(result.event.sequence, 1);
      assert.equal(result.outbox.eventId, result.event.id);
      assert.deepEqual(eventsForRun(fixture), [{
        type: 'run.dequeued',
        correlation_id: authorization.id,
        sequence: 1,
      }]);
      assert.deepEqual(outboxesForRun(fixture), [{
        event_id: result.event.id,
        aggregate_id: fixture.runId,
      }]);
      assertIntegrity(fixture.db);
    });
  });

  test('unique queued run.retry claims an existing Child Run with Operation correlation identity', async () => {
    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.retry');
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.equal(result.outcome, 'claimed');
      if (result.outcome !== 'claimed') return;
      assert.equal(result.operation.id, authorization.id);
      assert.equal(result.operation.status, 'running');
      assert.equal(result.run.status, 'starting');
      assert.equal(result.event.type, 'run.dequeued');
      assert.equal(result.event.correlationId, authorization.id);
      assert.notEqual(result.event.correlationId, fixture.runId);
      assert.equal(result.outbox.eventId, result.event.id);
      assertIntegrity(fixture.db);
    }, { retryRun: true });
  });

  test('non-queued Run is a no-op without evaluating or modifying active authorization', async () => {
    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      fixture.db.prepare(
        "UPDATE runs SET status = 'starting', version = 2 WHERE workspace_id = ? AND id = ?",
      ).run(fixture.workspaceId, fixture.runId);
      const beforeOperations = operationState(fixture);
      const result = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.deepEqual(result, { outcome: 'noop', reason: 'run-not-queued', runId: fixture.runId });
      assert.equal(operationState(fixture).find(item => item.id === authorization.id)?.status, 'queued');
      assert.deepEqual(operationState(fixture), beforeOperations);
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assertIntegrity(fixture.db);
    });
  });

  test('duplicate and coexisting active authorizations fail closed without choosing by order', async () => {
    const combinations: Array<{ first: OperationType; second: OperationType; runningSecond?: boolean }> = [
      { first: 'run.start', second: 'run.start' },
      { first: 'run.retry', second: 'run.retry' },
      { first: 'run.start', second: 'run.retry' },
      { first: 'run.start', second: 'run.start', runningSecond: true },
    ];
    for (const combination of combinations) {
      await withFixture(async fixture => {
        createOperation(fixture, combination.first);
        const second = createOperation(fixture, combination.second);
        if (combination.runningSecond) transitionOperationToRunning(fixture, second);
        const beforeRun = runState(fixture);
        const beforeOperations = operationState(fixture);
        assert.throws(
          () => fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
          error => error instanceof RunEngineError
            && error.code === 'RUN_ENGINE_AUTHORIZATION_AMBIGUOUS',
        );
        assertNoClaimWrites(fixture, beforeRun, beforeOperations);
      });
    }
    await withFixture(async fixture => {
      createOperation(fixture, 'run.start');
      createOperation(fixture, 'run.retry');
      const engine = createEngine(fixture, {
        operationService: {
          listByRun: (workspaceId, runId) => fixture.operationService
            .listByRun(workspaceId, runId)
            .reverse(),
          transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
        },
      });
      assert.throws(
        () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_AMBIGUOUS',
      );
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assert.equal(runState(fixture).status, 'queued');
      assertIntegrity(fixture.db);
    });
  });

  test('single active authorization that is already running fails closed', async () => {
    await withFixture(async fixture => {
      const authorization = transitionOperationToRunning(fixture, createOperation(fixture, 'run.start'));
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      assert.equal(authorization.status, 'running');
      assert.throws(
        () => fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_NOT_QUEUED',
      );
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    });
  });

  test('single waiting_approval or paused authorization fails closed without a second claim', async () => {
    for (const status of ['waiting_approval', 'paused'] as const) {
      await withFixture(async fixture => {
        const authorization = createOperation(fixture, 'run.start');
        const nonQueued = { ...authorization, status, startedAt: NOW };
        const engine = createEngine(fixture, {
          operationService: {
            listByRun: () => [nonQueued],
            transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
          },
        });
        const beforeRun = runState(fixture);
        const beforeOperations = operationState(fixture);
        assert.throws(
          () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
          error => error instanceof RunEngineError
            && error.code === 'RUN_ENGINE_AUTHORIZATION_NOT_QUEUED',
        );
        assertNoClaimWrites(fixture, beforeRun, beforeOperations);
      });
    }
  });

  test('Run and Operation workspace/binding isolation fails closed', async () => {
    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const otherWorkspace = createEntityId('workspace');
      const malformed = { ...authorization, workspaceId: otherWorkspace };
      const engine = createEngine(fixture, {
        operationService: {
          listByRun: () => [malformed],
          transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
        },
      });
      const beforeRun = runState(fixture);
      const beforeOperations = operationState(fixture);
      assert.throws(
        () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
      );
      assertNoClaimWrites(fixture, beforeRun, beforeOperations);
    });

    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const malformed = { ...authorization, aggregateId: createEntityId('run') };
      const engine = createEngine(fixture, {
        operationService: {
          listByRun: () => [malformed],
          transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
        },
      });
      assert.throws(
        () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
      );
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assert.equal(runState(fixture).status, 'queued');
      assertIntegrity(fixture.db);
    });

    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const malformed = { ...authorization, runId: createEntityId('run') };
      const engine = createEngine(fixture, {
        operationService: {
          listByRun: () => [malformed],
          transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
        },
      });
      assert.throws(
        () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
      );
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assert.equal(runState(fixture).status, 'queued');
      assertIntegrity(fixture.db);
    });

    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const malformed = { ...authorization, correlationId: 'op_wrong_correlation' };
      const engine = createEngine(fixture, {
        operationService: {
          listByRun: () => [malformed],
          transitionWithinTransaction: fixture.operationService.transitionWithinTransaction.bind(fixture.operationService),
        },
      });
      assert.throws(
        () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
        error => error instanceof RunEngineError
          && error.code === 'RUN_ENGINE_AUTHORIZATION_BINDING_INVALID',
      );
      assert.deepEqual(eventsForRun(fixture), []);
      assert.deepEqual(outboxesForRun(fixture), []);
      assert.equal(runState(fixture).status, 'queued');
      assertIntegrity(fixture.db);
    });
  });

  test('missing Run preserves RUN_NOT_FOUND and wrong workspace cannot observe another workspace Run', async () => {
    await withFixture(async fixture => {
      assert.throws(
        () => fixture.engine.tick({ workspaceId: createEntityId('workspace'), runId: fixture.runId }),
        error => error instanceof Error && 'code' in error && error.code === 'RUN_NOT_FOUND',
      );
      assert.throws(
        () => fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: createEntityId('run') }),
        error => error instanceof Error && 'code' in error && error.code === 'RUN_NOT_FOUND',
      );
    });
  });

  test('successful repeated tick cannot create a second Event or Outbox', async () => {
    await withFixture(async fixture => {
      const authorization = createOperation(fixture, 'run.start');
      const first = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.equal(first.outcome, 'claimed');
      const second = fixture.engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId });
      assert.deepEqual(second, { outcome: 'noop', reason: 'run-not-queued', runId: fixture.runId });
      assert.equal(operationState(fixture).find(item => item.id === authorization.id)?.status, 'running');
      assert.equal(eventsForRun(fixture).length, 1);
      assert.equal(outboxesForRun(fixture).length, 1);
      assertIntegrity(fixture.db);
    });
  });

  test('Operation transition, Run transition, Event insert, Outbox insert, and outer COMMIT failures roll back the complete claim', async () => {
    const cases: Array<{
      readonly name: string;
      readonly options?: FixtureOptions;
      readonly overrides?: (fixture: Fixture) => Partial<RunEngineDependencies>;
    }> = [
      {
        name: 'operation transition',
        overrides: fixture => ({
          operationService: {
            listByRun: fixture.operationService.listByRun.bind(fixture.operationService),
            transitionWithinTransaction: () => {
              throw new Error('injected operation transition failure');
            },
          },
        }),
      },
      {
        name: 'Run transition',
        overrides: () => ({
          lifecycleTransactionService: {
            transitionRunWithinTransaction: () => {
              throw new Error('injected Run transition failure');
            },
          },
        }),
      },
      {
        name: 'Runtime Event insert',
        options: { eventFailure: true },
      },
      {
        name: 'Outbox insert',
        options: { outboxFailure: true },
      },
      {
        name: 'outer COMMIT',
        overrides: fixture => ({
          runInTransaction: <T>(fn: () => T): T => {
            fixture.db.exec('BEGIN IMMEDIATE');
            try {
              const result = fn();
              void result;
              throw new Error('injected outer COMMIT failure');
            } catch (error) {
              fixture.db.exec('ROLLBACK');
              throw error;
            }
          },
        }),
      },
    ];

    for (const failureCase of cases) {
      await withFixture(async fixture => {
        const authorization = createOperation(fixture, 'run.start');
        const beforeRun = runState(fixture);
        const beforeOperations = operationState(fixture);
        const engine = createEngine(fixture, failureCase.overrides?.(fixture));
        assert.throws(
          () => engine.tick({ workspaceId: fixture.workspaceId, runId: fixture.runId }),
          error => error instanceof Error
            && error.message.toLowerCase().includes(`injected ${failureCase.name.toLowerCase()}`),
        );
        assert.equal(operationState(fixture).find(item => item.id === authorization.id)?.status, 'queued');
        assertNoClaimWrites(fixture, beforeRun, beforeOperations);
      }, failureCase.options);
    }
  });

  test('two independent file-backed connections produce exactly one competing claim winner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentos-p3b1-'));
    const databasePath = join(root, 'claim.sqlite');
    const fixture = createFixture(databasePath);
    try {
      const authorization = createOperation(fixture, 'run.start');
      const data: ClaimWorkerData = {
        mode: 'claim',
        dbPath: databasePath,
        workspaceId: fixture.workspaceId,
        runId: fixture.runId,
      };
      const results = await Promise.all([spawnClaimWorker(data), spawnClaimWorker(data)]);
      assert.equal(results.filter(result => result.ok && result.outcome === 'claimed').length, 1);
      assert.equal(results.filter(result => result.ok && result.outcome === 'noop' && result.reason === 'run-not-queued').length, 1);
      assert.equal(results.filter(result => result.ok === false).length, 0);
      const operation = fixture.operationService.findById(fixture.workspaceId, authorization.id);
      assert.equal(operation.status, 'running');
      assert.equal(operation.version, 2);
      assert.equal(runState(fixture).status, 'starting');
      assert.equal(runState(fixture).version, 2);
      assert.equal(eventsForRun(fixture).length, 1);
      assert.equal(eventsForRun(fixture)[0]?.type, 'run.dequeued');
      assert.equal(eventsForRun(fixture)[0]?.correlation_id, authorization.id);
      assert.equal(outboxesForRun(fixture).length, 1);
      assert.equal(outboxesForRun(fixture)[0]?.aggregate_id, fixture.runId);
      assertIntegrity(fixture.db);
    } finally {
      fixture.db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
