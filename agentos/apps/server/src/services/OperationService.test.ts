import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, describe } from 'node:test';

import type { ApiOperation, ApiOperationResult, ApiProblem, M3OperationStatus } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { inTransaction } from '../store/Transaction.js';
import { createEntityId, isValidEntityId } from '../store/Identity.js';
import { OperationRepository } from '../store/OperationRepository.js';
import { VersionConflictError } from '../store/Version.js';
import {
  InvalidOperationTransitionError,
  OperationNotFoundError,
  OperationService,
  OperationValidationError,
} from './OperationService.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): { changes: number };
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

const WORKSPACE_ID = 'workspace-service';
const TASK_ID = 'task-service';
const RUN_ID = 'run-service';
const NOW = '2026-08-04T00:00:00.000Z';
const LATER = '2026-08-04T00:00:01.000Z';
const LATEST = '2026-08-04T00:00:02.000Z';

const SAMPLE_RESULT: ApiOperationResult = {
  resourceType: 'run',
  resourceId: RUN_ID,
  data: { accepted: true },
};

function sampleProblem(): ApiProblem {
  return {
    type: 'https://agentos.dev/problems/operation-failed',
    title: 'Operation failed',
    status: 500,
    code: 'OPERATION_FAILED',
    detail: 'The operation failed during the test.',
    instance: '/api/operations/test',
    requestId: 'request-service',
    retryable: false,
    context: { workspaceId: WORKSPACE_ID, runId: RUN_ID },
  };
}

const databases: Db[] = [];

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  seedRun(db);
  databases.push(db);
  return db;
}

function seedRun(db: Db): void {
  db.prepare(`
    INSERT INTO workspaces (
      id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(WORKSPACE_ID, WORKSPACE_ID, `/${WORKSPACE_ID}`, `/${WORKSPACE_ID}`, NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (
      id, workspace_id, legacy_task_id, title, status, priority, created_by, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, 'open', 'normal', 'test', ?, ?)
  `).run(TASK_ID, WORKSPACE_ID, 'Operation service task', NOW, NOW);
  db.prepare(`
    INSERT INTO runs (
      id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', 'initial', 'v2_api', 'test', ?, ?)
  `).run(RUN_ID, WORKSPACE_ID, TASK_ID, RUN_ID, NOW, NOW);
}

function serviceFixture(now: () => string = () => NOW): { db: Db; service: OperationService } {
  const db = migratedDb();
  return { db, service: new OperationService(db, { now }) };
}

function cancelServiceFixture(
  onCancel: (input: unknown) => unknown = () => undefined,
  now: () => string = () => NOW,
): {
  db: Db;
  service: OperationService;
  calls: unknown[];
} {
  const db = migratedDb();
  const calls: unknown[] = [];
  const lifecycle = {
    cancelRunForOperationWithinTransaction(input: unknown): unknown {
      calls.push(input);
      return onCancel(input);
    },
  };
  const service = new OperationService(db, {
    now,
    lifecycleTransactionService: lifecycle,
  } as never);
  return { db, service, calls };
}

function cancelInput(operation: ApiOperation, expectedVersion = operation.version): {
  workspaceId: string;
  operationId: string;
  expectedVersion: number;
} {
  return {
    workspaceId: operation.workspaceId,
    operationId: operation.id,
    expectedVersion,
  };
}

function assertCode(code: string) {
  return (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === code;
}

function createStart(service: OperationService): ApiOperation {
  return service.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('OperationService — identity and creation', () => {
  test('creates canonical operation and non-create identities', () => {
    const { service } = serviceFixture();

    const create = service.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.create' });
    const start = service.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });

    assert.ok(isValidEntityId(create.id, 'operation'));
    assert.ok(create.id.startsWith('op_'));
    assert.equal(create.correlationId, RUN_ID);
    assert.equal(start.correlationId, start.id);
    assert.equal(start.aggregateType, 'run');
    assert.equal(start.aggregateId, RUN_ID);
    assert.equal(start.runId, RUN_ID);
    assert.equal(start.status, 'queued');
    assert.equal(start.version, 1);
    assert.equal(start.createdAt, NOW);
    assert.equal('progress' in start, false);
    assert.equal('result' in start, false);
    assert.equal('error' in start, false);
  });

  test('findWorkspaceIdByOpaqueId delegates the opaque locator without changing workspace-scoped reads', () => {
    const { service } = serviceFixture();
    const start = service.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });

    assert.equal(service.findWorkspaceIdByOpaqueId(start.id), WORKSPACE_ID);
    assert.equal(service.findWorkspaceIdByOpaqueId(createEntityId('operation')), undefined);
    assert.deepEqual(service.findById(WORKSPACE_ID, start.id), start);
    assert.throws(
      () => service.findById('workspace-other', start.id),
      (error: unknown) => error instanceof OperationNotFoundError && error.code === 'OPERATION_NOT_FOUND',
    );
  });

  test('callers cannot override canonical identity fields', () => {
    const { db, service } = serviceFixture();
    const operation = service.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.cancel' });
    const row = db.prepare(`
      SELECT id, correlation_id, aggregate_type, aggregate_id, run_id, status, version
      FROM operations WHERE id = ?
    `).get(operation.id) as Record<string, unknown>;

    assert.equal(row.id, operation.id);
    assert.equal(row.correlation_id, operation.id);
    assert.equal(row.aggregate_type, 'run');
    assert.equal(row.aggregate_id, RUN_ID);
    assert.equal(row.run_id, RUN_ID);
    assert.equal(row.status, 'queued');
    assert.equal(row.version, 1);
  });

  test('rejects invalid type and invalid canonical timestamp before inserting', () => {
    const invalidType = serviceFixture();
    const invalidInput = JSON.parse(JSON.stringify({
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      type: 'invalid.operation',
    }));
    assert.throws(
      () => invalidType.service.create(invalidInput),
      assertCode('OPERATION_VALIDATION_FAILED'),
    );
    assert.equal(
      (invalidType.db.prepare('SELECT COUNT(*) AS count FROM operations').get() as { count: number }).count,
      0,
    );

    const invalidTimestamp = serviceFixture(() => '2026-08-04T00:00:00Z');
    assert.throws(
      () => invalidTimestamp.service.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' }),
      assertCode('OPERATION_VALIDATION_FAILED'),
    );
  });
});

describe('OperationService — transition graph', () => {
  test('queued -> running -> completed preserves startedAt and writes result', () => {
    let now = NOW;
    const { service } = serviceFixture(() => now);
    const operation = createStart(service);

    now = LATER;
    const running = service.transition({
      workspaceId: WORKSPACE_ID,
      operationId: operation.id,
      expectedVersion: 1,
      to: 'running',
    });
    assert.equal(running.status, 'running');
    assert.equal(running.startedAt, LATER);
    assert.equal(running.completedAt, undefined);
    assert.equal(running.version, 2);

    now = LATEST;
    const completed = service.transition({
      workspaceId: WORKSPACE_ID,
      operationId: operation.id,
      expectedVersion: 2,
      to: 'completed',
      result: SAMPLE_RESULT,
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.startedAt, LATER);
    assert.equal(completed.completedAt, LATEST);
    assert.deepEqual(completed.result, SAMPLE_RESULT);
    assert.equal(completed.error, undefined);
    assert.equal(completed.version, 3);
  });

  test('queued -> failed is the explicit C1a failure-record path', () => {
    let now = NOW;
    const { service } = serviceFixture(() => now);
    const operation = createStart(service);
    now = LATER;

    const failed = service.transition({
      workspaceId: WORKSPACE_ID,
      operationId: operation.id,
      expectedVersion: 1,
      to: 'failed',
      error: sampleProblem(),
    });

    assert.equal(failed.status, 'failed');
    assert.equal(failed.startedAt, undefined);
    assert.equal(failed.completedAt, LATER);
    assert.deepEqual(failed.error, sampleProblem());
    assert.equal(failed.result, undefined);
  });

  test('queued -> cancelled records terminal time without startedAt/result/error', () => {
    let now = NOW;
    const { service } = serviceFixture(() => now);
    const operation = service.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.cancel' });
    now = LATER;

    const cancelled = service.transition({
      workspaceId: WORKSPACE_ID,
      operationId: operation.id,
      expectedVersion: 1,
      to: 'cancelled',
    });

    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.startedAt, undefined);
    assert.equal(cancelled.completedAt, LATER);
    assert.equal(cancelled.result, undefined);
    assert.equal(cancelled.error, undefined);
  });

  test('rejects self, unsupported, terminal, and retained waiting/paused transitions', () => {
    const { db, service } = serviceFixture();
    const operation = createStart(service);

    assert.throws(
      () => service.transition({ workspaceId: WORKSPACE_ID, operationId: operation.id, expectedVersion: 1, to: 'queued' }),
      assertCode('INVALID_OPERATION_TRANSITION'),
    );
    assert.throws(
      () => service.transition({ workspaceId: WORKSPACE_ID, operationId: operation.id, expectedVersion: 1, to: 'completed' }),
      assertCode('INVALID_OPERATION_TRANSITION'),
    );

    db.prepare('UPDATE operations SET status = ?, started_at = ?, version = version + 1 WHERE id = ?')
      .run('waiting_approval', LATER, operation.id);
    assert.throws(
      () => service.transition({ workspaceId: WORKSPACE_ID, operationId: operation.id, expectedVersion: 2, to: 'running' }),
      (error: unknown) => error instanceof InvalidOperationTransitionError
        && error.code === 'INVALID_OPERATION_TRANSITION',
    );

    db.prepare('UPDATE operations SET status = ?, started_at = ?, version = version + 1 WHERE id = ?')
      .run('paused', LATER, operation.id);
    assert.throws(
      () => service.transition({ workspaceId: WORKSPACE_ID, operationId: operation.id, expectedVersion: 3, to: 'cancelled' }),
      assertCode('INVALID_OPERATION_TRANSITION'),
    );

    db.prepare('UPDATE operations SET status = ?, started_at = ?, completed_at = ?, version = version + 1 WHERE id = ?')
      .run('completed', LATER, LATER, operation.id);
    assert.throws(
      () => service.transition({ workspaceId: WORKSPACE_ID, operationId: operation.id, expectedVersion: 4, to: 'failed', error: sampleProblem() }),
      assertCode('INVALID_OPERATION_TRANSITION'),
    );
  });

  test('stale version raises VERSION_CONFLICT and does not overwrite the winner', () => {
    const { service } = serviceFixture();
    const operation = createStart(service);
    const winner = service.transition({
      workspaceId: WORKSPACE_ID,
      operationId: operation.id,
      expectedVersion: 1,
      to: 'running',
    });

    assert.throws(
      () => service.transition({
        workspaceId: WORKSPACE_ID,
        operationId: operation.id,
        expectedVersion: 1,
        to: 'cancelled',
      }),
      (error: unknown) => error instanceof VersionConflictError && error.code === 'VERSION_CONFLICT',
    );
    assert.equal(service.findById(WORKSPACE_ID, operation.id)?.status, winner.status);
    assert.equal(service.findById(WORKSPACE_ID, operation.id)?.version, winner.version);
  });

  test('missing operation is stable OPERATION_NOT_FOUND', () => {
    const { service } = serviceFixture();
    assert.throws(
      () => service.findById(WORKSPACE_ID, createEntityId('operation')),
      (error: unknown) => error instanceof OperationNotFoundError && error.code === 'OPERATION_NOT_FOUND',
    );
    assert.throws(
      () => service.transition({
        workspaceId: WORKSPACE_ID,
        operationId: createEntityId('operation'),
        expectedVersion: 1,
        to: 'running',
      }),
      assertCode('OPERATION_NOT_FOUND'),
    );
  });
});

describe('OperationService — result/error and transaction invariants', () => {
  test('rejects result/error on incompatible status and malformed ApiProblem', () => {
    const completedError = serviceFixture();
    const operation = createStart(completedError.service);
    completedError.service.transition({
      workspaceId: WORKSPACE_ID,
      operationId: operation.id,
      expectedVersion: 1,
      to: 'running',
    });
    assert.throws(
      () => completedError.service.transition({
        workspaceId: WORKSPACE_ID,
        operationId: operation.id,
        expectedVersion: 2,
        to: 'completed',
        error: sampleProblem(),
      }),
      assertCode('OPERATION_VALIDATION_FAILED'),
    );

    const failedNoError = serviceFixture();
    const failedOperation = createStart(failedNoError.service);
    assert.throws(
      () => failedNoError.service.transition({
        workspaceId: WORKSPACE_ID,
        operationId: failedOperation.id,
        expectedVersion: 1,
        to: 'failed',
      }),
      assertCode('OPERATION_VALIDATION_FAILED'),
    );

    const failedMalformed = serviceFixture();
    const malformedOperation = createStart(failedMalformed.service);
    const malformed = JSON.parse(JSON.stringify({ ...sampleProblem(), retryable: 'no' }));
    assert.throws(
      () => failedMalformed.service.transition({
        workspaceId: WORKSPACE_ID,
        operationId: malformedOperation.id,
        expectedVersion: 1,
        to: 'failed',
        error: malformed,
      }),
      assertCode('OPERATION_VALIDATION_FAILED'),
    );

    const cancelledResult = serviceFixture();
    const cancelledOperation = createStart(cancelledResult.service);
    assert.throws(
      () => cancelledResult.service.transition({
        workspaceId: WORKSPACE_ID,
        operationId: cancelledOperation.id,
        expectedVersion: 1,
        to: 'cancelled',
        result: SAMPLE_RESULT,
      }),
      assertCode('OPERATION_VALIDATION_FAILED'),
    );
  });

  test('within-transaction entry points compose with one caller-owned transaction', () => {
    const { db, service } = serviceFixture();
    let operation: ApiOperation | undefined;

    inTransaction(db, () => {
      const created = service.createWithinTransaction({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });
      operation = service.transitionWithinTransaction({
        workspaceId: WORKSPACE_ID,
        operationId: created.id,
        expectedVersion: 1,
        to: 'running',
      });
    });

    assert.equal(operation?.status, 'running');
    assert.equal(service.findById(WORKSPACE_ID, operation!.id)?.status, 'running');
  });

  test('outer rollback does not auto-create a failed Operation', () => {
    const { db, service } = serviceFixture();
    const operationId = createEntityId('operation');

    assert.throws(() => inTransaction(db, () => {
      service.createWithinTransaction({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });
      throw new Error('transaction-attempt rollback');
    }));
    assert.equal(service.listByRun(WORKSPACE_ID, RUN_ID).length, 0);

    const committed = service.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });
    assert.throws(() => inTransaction(db, () => {
      service.transitionWithinTransaction({
        workspaceId: WORKSPACE_ID,
        operationId: committed.id,
        expectedVersion: 1,
        to: 'running',
      });
      throw new Error('transition rollback');
    }));
    assert.equal(service.findById(WORKSPACE_ID, committed.id)?.status, 'queued');
    assert.equal(service.findById(WORKSPACE_ID, committed.id)?.error, undefined);
    assert.throws(
      () => service.findById(WORKSPACE_ID, operationId),
      assertCode('OPERATION_NOT_FOUND'),
    );
  });

  test('progress is never accepted, persisted, or returned', () => {
    const { db, service } = serviceFixture();
    const operation = service.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });
    const row = db.prepare('SELECT result_json, error_json FROM operations WHERE id = ?').get(operation.id) as {
      result_json: string | null;
      error_json: string | null;
    };

    assert.equal('progress' in operation, false);
    assert.equal(row.result_json, null);
    assert.equal(row.error_json, null);
  });
});

describe('OperationService — dedicated atomic cancel', () => {
  test('dedicated cancel does not widen ALLOWED_TRANSITIONS', () => {
    const { db, service } = cancelServiceFixture();
    const queued = createStart(service);
    const cancelled = service.cancel(cancelInput(queued));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.version, 2);

    const waiting = createStart(service);
    db.prepare('UPDATE operations SET status = ?, started_at = ?, version = 1 WHERE id = ?')
      .run('waiting_approval', NOW, waiting.id);
    assert.throws(
      () => service.transition({
        workspaceId: WORKSPACE_ID,
        operationId: waiting.id,
        expectedVersion: 1,
        to: 'cancelled',
      }),
      assertCode('INVALID_OPERATION_TRANSITION'),
    );
  });

  test('already-cancelled ignores a stale expectedVersion without lifecycle or mutation', () => {
    const { db, service, calls } = cancelServiceFixture();
    const operation = createStart(service);
    db.prepare(`
      UPDATE operations SET status = 'cancelled', version = 7, completed_at = ?,
        result_json = NULL, error_json = NULL WHERE id = ?
    `).run(LATER, operation.id);
    const before = db.prepare('SELECT * FROM operations WHERE id = ?').get(operation.id);

    const current = service.cancel(cancelInput(operation, 1));

    assert.deepEqual(current, service.findById(WORKSPACE_ID, operation.id));
    assert.deepEqual(db.prepare('SELECT * FROM operations WHERE id = ?').get(operation.id), before);
    assert.deepEqual(calls, []);
  });

  test('stale non-cancelled Operation raises VERSION_CONFLICT before lifecycle', () => {
    const { db, service, calls } = cancelServiceFixture();
    const operation = createStart(service);
    db.prepare('UPDATE operations SET status = ?, started_at = ?, version = 2 WHERE id = ?')
      .run('running', NOW, operation.id);

    assert.throws(
      () => service.cancel(cancelInput(operation, 1)),
      (error: unknown) => error instanceof VersionConflictError
        && error.entityType === 'operations'
        && error.code === 'VERSION_CONFLICT',
    );
    assert.equal(service.findById(WORKSPACE_ID, operation.id)?.version, 2);
    assert.deepEqual(calls, []);
  });

  test('completed and failed Operations are not cancellable', () => {
    const completed = cancelServiceFixture();
    const completedQueued = createStart(completed.service);
    const completedRunning = completed.service.transition({
      workspaceId: WORKSPACE_ID,
      operationId: completedQueued.id,
      expectedVersion: 1,
      to: 'running',
    });
    const completedOperation = completed.service.transition({
      workspaceId: WORKSPACE_ID,
      operationId: completedRunning.id,
      expectedVersion: 2,
      to: 'completed',
      result: SAMPLE_RESULT,
    });
    assert.throws(
      () => completed.service.cancel(cancelInput(completedOperation)),
      assertCode('OPERATION_NOT_CANCELLABLE'),
    );
    assert.deepEqual(completed.calls, []);

    const failed = cancelServiceFixture();
    const failedOperation = failed.service.transition({
      workspaceId: WORKSPACE_ID,
      operationId: createStart(failed.service).id,
      expectedVersion: 1,
      to: 'failed',
      error: sampleProblem(),
    });
    assert.throws(
      () => failed.service.cancel(cancelInput(failedOperation)),
      assertCode('OPERATION_NOT_CANCELLABLE'),
    );
    assert.deepEqual(failed.calls, []);
  });

  test('all four guarded statuses use the dedicated cancel seam exactly once', () => {
    for (const status of ['queued', 'running', 'waiting_approval', 'paused'] as const) {
      const { db, service, calls } = cancelServiceFixture();
      const operation = createStart(service);
      if (status !== 'queued') {
        db.prepare('UPDATE operations SET status = ?, started_at = ?, version = 1 WHERE id = ?')
          .run(status, NOW, operation.id);
      }

      const cancelled = service.cancel(cancelInput(operation));

      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.version, 2);
      assert.equal(calls.length, 1);
      assert.equal('result' in cancelled, false);
      assert.equal('error' in cancelled, false);
    }
  });

  test('OperationService passes only persisted binding to the lifecycle seam', () => {
    const { service, calls } = cancelServiceFixture();
    const operation = createStart(service);

    service.cancel(cancelInput(operation));

    assert.deepEqual(calls, [{
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      correlationId: operation.correlationId,
    }]);
  });

  test('missing canonical lifecycle dependency fails closed', () => {
    const { service } = serviceFixture();
    const operation = createStart(service);

    assert.throws(
      () => service.cancel(cancelInput(operation)),
      assertCode('OPERATION_LIFECYCLE_DEPENDENCY_MISSING'),
    );
    assert.equal(service.findById(WORKSPACE_ID, operation.id)?.status, 'queued');
  });

  test('lifecycle failure rolls back the guarded Operation update', () => {
    const { db, service } = cancelServiceFixture(() => { throw new Error('lifecycle failure'); });
    const operation = createStart(service);
    const before = db.prepare('SELECT * FROM operations WHERE id = ?').get(operation.id);

    assert.throws(() => service.cancel(cancelInput(operation)), /lifecycle failure/);

    assert.deepEqual(db.prepare('SELECT * FROM operations WHERE id = ?').get(operation.id), before);
  });

  test('cancel increments the Operation version exactly once and keeps result/error null', () => {
    const { db, service } = cancelServiceFixture();
    const operation = createStart(service);

    const cancelled = service.cancel(cancelInput(operation));
    const row = db.prepare('SELECT status, version, result_json, error_json FROM operations WHERE id = ?')
      .get(operation.id) as { status: string; version: number; result_json: string | null; error_json: string | null };

    assert.equal(cancelled.version, operation.version + 1);
    assert.deepEqual({ ...row }, { status: 'cancelled', version: 2, result_json: null, error_json: null });
  });

  test('a COMMIT failure injected through the test database proxy rolls back cancel', () => {
    const db = migratedDb();
    let failCommit = false;
    const proxy = {
      exec(sql: string): void {
        if (failCommit && sql === 'COMMIT') throw new Error('COMMIT_FAILURE');
        db.exec(sql);
      },
      prepare: db.prepare.bind(db),
    };
    const calls: unknown[] = [];
    const service = new OperationService(proxy as never, {
      now: () => NOW,
      lifecycleTransactionService: {
        cancelRunForOperationWithinTransaction(input: unknown): void { calls.push(input); },
      },
    } as never);
    const operation = service.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });
    const before = db.prepare('SELECT * FROM operations WHERE id = ?').get(operation.id);
    failCommit = true;

    assert.throws(() => service.cancel(cancelInput(operation)), /COMMIT_FAILURE/);

    assert.deepEqual(db.prepare('SELECT * FROM operations WHERE id = ?').get(operation.id), before);
    assert.equal(calls.length, 1);
  });
});

describe('OperationService — file-backed optimistic concurrency', () => {
  test('two services using the same expected version have one winner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentos-p3a-service-'));
    const path = join(directory, 'operations.sqlite');
    const setup = new DatabaseSync(path);
    setup.exec('PRAGMA foreign_keys = ON');
    new MigrationRunner(setup, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
    seedRun(setup);
    const seeded = new OperationService(setup, { now: () => NOW });
    const operation = seeded.create({ workspaceId: WORKSPACE_ID, runId: RUN_ID, type: 'run.start' });
    setup.close();

    const firstDb = new DatabaseSync(path);
    const secondDb = new DatabaseSync(path);
    firstDb.exec('PRAGMA foreign_keys = ON');
    secondDb.exec('PRAGMA foreign_keys = ON');
    const first = new OperationService(firstDb, { now: () => LATER });
    const second = new OperationService(secondDb, { now: () => LATER });
    assert.equal(first.findById(WORKSPACE_ID, operation.id)?.version, 1);
    assert.equal(second.findById(WORKSPACE_ID, operation.id)?.version, 1);

    first.transition({ workspaceId: WORKSPACE_ID, operationId: operation.id, expectedVersion: 1, to: 'running' });
    assert.throws(
      () => second.transition({ workspaceId: WORKSPACE_ID, operationId: operation.id, expectedVersion: 1, to: 'cancelled' }),
      (error: unknown) => error instanceof VersionConflictError,
    );
    assert.equal(first.findById(WORKSPACE_ID, operation.id)?.status, 'running');
    assert.equal(first.findById(WORKSPACE_ID, operation.id)?.version, 2);

    firstDb.close();
    secondDb.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
