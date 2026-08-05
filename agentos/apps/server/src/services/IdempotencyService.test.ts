import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { ApiOperation, Run, Task } from '@agentos/shared';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { IdempotencyRepository } from '../store/IdempotencyRepository.js';
import {
  IDEMPOTENCY_HTTP_STATUS,
  IDEMPOTENCY_OPERATIONS,
  buildOperationResultEnvelopeV1,
  buildRetryResultEnvelopeV1,
  buildRunResultEnvelopeV1,
  buildTaskResultEnvelopeV1,
  parseIdempotencyResultEnvelopeV1,
  type FingerprintInput,
} from '../idempotency/types.js';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import {
  IdempotencyKeyReusedError,
  IdempotencyService,
  type PreparedIdempotency,
} from './IdempotencyService.js';
import { IdempotencyKeyValidationError } from '../idempotency/fingerprint.js';
import { IdempotencyRecordInvalidError } from '../idempotency/types.js';
import { OperationService } from './OperationService.js';

const NOW = '2026-01-01T00:00:00.000Z';
const KEY = 'p2-service-key-1';

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  return db;
}

function insertWorkspace(db: Db, id: string): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `ws-${id}`, `/r/${id}`, `/r/${id}`, NOW, NOW, NOW);
}

function insertQueuedRunFixture(db: Db): void {
  db.prepare(`
    INSERT INTO tasks (
      id, workspace_id, title, status, priority, created_by, created_at, updated_at, version
    ) VALUES (?, ?, ?, 'open', 'normal', ?, ?, ?, 1)
  `).run('task-start-replay', 'ws-1', 'start replay task', 'tester', NOW, NOW);
  db.prepare(`
    INSERT INTO runs (
      id, workspace_id, task_id, root_run_id, status, reason, origin,
      next_event_sequence, created_by, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, 'queued', 'initial', 'v2_api', 1, ?, ?, ?, 1)
  `).run('run-start-replay', 'ws-1', 'task-start-replay', 'run-start-replay', 'tester', NOW, NOW);
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task_00000000000000000000000001',
    workspaceId: 'ws-1',
    title: 'task title',
    status: 'open',
    priority: 'normal',
    createdBy: 'tester',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_00000000000000000000000001',
    workspaceId: 'ws-1',
    taskId: 'task_00000000000000000000000001',
    rootRunId: 'run_00000000000000000000000001',
    status: 'queued',
    reason: 'initial',
    origin: 'v2_api',
    nextEventSequence: 1,
    createdBy: 'tester',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function makeStartOperation(overrides: Partial<ApiOperation> = {}): ApiOperation {
  return {
    id: 'operation_00000000000000000000000001',
    type: 'run.start',
    status: 'queued',
    workspaceId: 'ws-1',
    aggregateType: 'run',
    aggregateId: 'run_00000000000000000000000001',
    runId: 'run_00000000000000000000000001',
    correlationId: 'operation_00000000000000000000000001',
    createdAt: NOW,
    version: 1,
    ...overrides,
  };
}

function makeRetryChildRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_00000000000000000000000002',
    workspaceId: 'ws-1',
    taskId: 'task_00000000000000000000000001',
    parentRunId: 'run_00000000000000000000000001',
    rootRunId: 'run_00000000000000000000000001',
    status: 'queued',
    reason: 'retry',
    origin: 'v2_api',
    nextEventSequence: 1,
    createdBy: 'tester',
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function makeRetryOperation(overrides: Partial<ApiOperation> = {}): ApiOperation {
  return {
    id: 'operation_00000000000000000000000002',
    type: 'run.retry',
    status: 'completed',
    workspaceId: 'ws-1',
    aggregateType: 'run',
    aggregateId: 'run_00000000000000000000000001',
    runId: 'run_00000000000000000000000001',
    correlationId: 'operation_00000000000000000000000002',
    result: {
      resourceType: 'run',
      resourceId: 'run_00000000000000000000000002',
    },
    createdAt: NOW,
    startedAt: '2026-01-01T00:00:00.001Z',
    completedAt: '2026-01-01T00:00:00.002Z',
    version: 3,
    ...overrides,
  };
}

function makeFingerprint(overrides: Partial<FingerprintInput> = {}): FingerprintInput {
  return {
    operation: 'task.create',
    workspaceId: 'ws-1',
    pathParams: {},
    domainInput: { title: 'task title' },
    expectedVersion: null,
    ...overrides,
  };
}

function makeRetryFingerprint(): FingerprintInput & { operation: 'run.retry' } {
  return {
    operation: 'run.retry',
    workspaceId: 'ws-1',
    pathParams: { runId: 'run_00000000000000000000000001' },
    domainInput: { reason: 'retry' },
    expectedVersion: 1,
  };
}

function makeService(db: Db): IdempotencyService {
  return new IdempotencyService(new IdempotencyRepository(db));
}

function makePrepared(service: IdempotencyService): PreparedIdempotency {
  const prepared = service.prepare({
    operation: 'task.create',
    workspaceId: 'ws-1',
    normalizedKey: KEY,
    fingerprintInput: makeFingerprint(),
  });
  assert.ok(prepared);
  return prepared;
}

describe('M2.6 P2 — IdempotencyService prepare', () => {
  it('SVC-01 prepare without a key returns undefined', () => {
    const db = migratedDb();
    try {
      const service = makeService(db);
      const prepared = service.prepare({
        operation: 'task.create',
        workspaceId: 'ws-1',
        normalizedKey: undefined,
        fingerprintInput: makeFingerprint(),
      });
      assert.equal(prepared, undefined);
    } finally {
      db.close();
    }
  });

  it('SVC-02 prepare returns only hash-scoped prepared data', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = makePrepared(service);
      assert.equal(prepared.operation, 'task.create');
      assert.equal(prepared.workspaceId, 'ws-1');
      assert.ok(/^[0-9a-f]{64}$/.test(prepared.keyHash));
      assert.ok(/^[0-9a-f]{64}$/.test(prepared.requestHash));
    } finally {
      db.close();
    }
  });

  it('SVC-03 prepared object never exposes the raw or normalized key', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = makePrepared(service);
      for (const value of Object.values(prepared)) {
        assert.ok(!String(value).includes(KEY));
      }
      const serialized = JSON.stringify(prepared);
      assert.ok(!serialized.includes(KEY));
    } finally {
      db.close();
    }
  });

  it('SVC-04 prepare with an invalid key rejects without leaking the key', () => {
    const db = migratedDb();
    try {
      const service = makeService(db);
      assert.throws(
        () => service.prepare({
          operation: 'task.create',
          workspaceId: 'ws-1',
          normalizedKey: 'bad key!',
          fingerprintInput: makeFingerprint(),
        }),
        IdempotencyKeyValidationError,
      );
    } finally {
      db.close();
    }
  });
});

describe('M2.6 P2 — IdempotencyService resolve and storeSuccess', () => {
  it('SVC-05 resolve on an empty scope returns miss', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = makePrepared(service);
      assert.deepEqual(service.resolve(prepared), { kind: 'miss' });
    } finally {
      db.close();
    }
  });

  it('SVC-06 storeSuccess persists and resolve replays the same request', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = makePrepared(service);
      assert.deepEqual(service.resolve(prepared), { kind: 'miss' });
      const envelope = buildTaskResultEnvelopeV1('task.create', makeTask());
      const record = service.storeSuccess({ prepared, httpStatus: 201, envelope });
      assert.ok(record.id.startsWith('idem_'));
      const resolution = service.resolve(prepared);
      assert.equal(resolution.kind, 'replay');
      if (resolution.kind === 'replay') {
        assert.equal(resolution.httpStatus, 201);
        assert.deepEqual(resolution.envelope, envelope);
      }
    } finally {
      db.close();
    }
  });

  it('SVC-07 same key with a different well-formed request throws key-reused conflict', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const first = makePrepared(service);
      service.storeSuccess({
        prepared: first,
        httpStatus: 201,
        envelope: buildTaskResultEnvelopeV1('task.create', makeTask()),
      });
      const second = service.prepare({
        operation: 'task.create',
        workspaceId: 'ws-1',
        normalizedKey: KEY,
        fingerprintInput: makeFingerprint({ domainInput: { title: 'different title' } }),
      });
      assert.ok(second);
      try {
        service.resolve(second);
        assert.fail('expected IdempotencyKeyReusedError');
      } catch (error) {
        assert.ok(error instanceof IdempotencyKeyReusedError);
        assert.equal((error as IdempotencyKeyReusedError).code, 'IDEMPOTENCY_KEY_REUSED');
        assert.equal(
          (error as Error).message,
          'Idempotency key was already used with a different request',
        );
        assert.ok(!(error as Error).message.includes(KEY));
      }
    } finally {
      db.close();
    }
  });

  it('SVC-08 storeSuccess rejects non-2xx and non-pair statuses', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const envelope = buildTaskResultEnvelopeV1('task.create', makeTask());
      for (const httpStatus of [199, 204, 300, 500]) {
        const prepared = makePrepared(service);
        assert.throws(
          () => service.storeSuccess({ prepared, httpStatus: httpStatus as 201, envelope }),
          IdempotencyRecordInvalidError,
        );
      }
      // task.create requires 201, not 200
      const prepared = makePrepared(service);
      assert.throws(
        () => service.storeSuccess({ prepared, httpStatus: 200, envelope }),
        IdempotencyRecordInvalidError,
      );
    } finally {
      db.close();
    }
  });

  it('SVC-09 storeSuccess rejects an envelope whose operation differs from the prepared operation', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = makePrepared(service);
      const wrongEnvelope = buildTaskResultEnvelopeV1('task.cancel', makeTask());
      assert.throws(
        () => service.storeSuccess({ prepared, httpStatus: 201, envelope: wrongEnvelope }),
        IdempotencyRecordInvalidError,
      );
    } finally {
      db.close();
    }
  });

  it('SVC-10 failed operations leave no record (success-only persistence)', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = makePrepared(service);
      assert.throws(
        () => service.storeSuccess({
          prepared,
          httpStatus: 200,
          envelope: buildTaskResultEnvelopeV1('task.create', makeTask()),
        }),
        IdempotencyRecordInvalidError,
      );
      assert.deepEqual(service.resolve(prepared), { kind: 'miss' });
    } finally {
      db.close();
    }
  });

  it('SVC-11 corrupted stored result fails closed on resolve', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = makePrepared(service);
      const envelope = buildTaskResultEnvelopeV1('task.create', makeTask());
      // Simulate a corrupted stored record through a constraint-free raw handle:
      // canonical result_json with a well-formed but wrong result_hash must fail closed.
      db.prepare('CREATE TABLE idempotency_records_raw AS SELECT * FROM idempotency_records').run();
      db.prepare('DROP TABLE idempotency_records').run();
      db.prepare('ALTER TABLE idempotency_records_raw RENAME TO idempotency_records').run();
      db.prepare(`
        INSERT INTO idempotency_records (
          id, workspace_id, operation, key_hash, request_hash,
          result_schema_version, result_json, result_hash, http_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'idem_' + '0'.repeat(26),
        'ws-1',
        'task.create',
        prepared.keyHash,
        prepared.requestHash,
        1,
        canonicalizeJson(envelope),
        'e'.repeat(64),
        201,
        NOW,
      );
      assert.throws(() => service.resolve(prepared), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('SVC-12 replay envelope is deep detached from subsequent reads', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = makePrepared(service);
      service.storeSuccess({
        prepared,
        httpStatus: 201,
        envelope: buildTaskResultEnvelopeV1('task.create', makeTask()),
      });
      const first = service.resolve(prepared);
      if (first.kind === 'replay' && 'task' in first.envelope.body) {
        first.envelope.body.task.title = 'mutated';
      }
      const second = service.resolve(prepared);
      if (second.kind === 'replay' && 'task' in second.envelope.body) {
        assert.equal(second.envelope.body.task.title, 'task title');
      } else {
        assert.fail('expected replay');
      }
    } finally {
      db.close();
    }
  });

  it('SVC-13 service exposes no transaction surface', () => {
    const db = migratedDb();
    try {
      const service = makeService(db);
      const names = Object.getOwnPropertyNames(IdempotencyService.prototype)
        .filter((name) => name !== 'constructor');
      assert.deepEqual(names.sort(), ['prepare', 'resolve', 'storeSuccess']);
      const instance = service as unknown as Record<string, unknown>;
      assert.equal(instance.runInTransaction, undefined);
      assert.equal(instance.begin, undefined);
      assert.equal(instance.commit, undefined);
      assert.equal(instance.rollback, undefined);
    } finally {
      db.close();
    }
  });

  it('SVC-14 scopes are workspace isolated through the service', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertWorkspace(db, 'ws-2');
      const service = makeService(db);
      const prepared = makePrepared(service);
      service.storeSuccess({
        prepared,
        httpStatus: 201,
        envelope: buildTaskResultEnvelopeV1('task.create', makeTask()),
      });
      const foreign = service.prepare({
        operation: 'task.create',
        workspaceId: 'ws-2',
        normalizedKey: KEY,
        fingerprintInput: makeFingerprint({ workspaceId: 'ws-2' }),
      });
      assert.ok(foreign);
      assert.deepEqual(service.resolve(foreign), { kind: 'miss' });
    } finally {
      db.close();
    }
  });

  it('SVC-15 prepare rejects operation mismatch between scope and fingerprint', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      try {
        service.prepare({
          operation: 'task.create',
          workspaceId: 'ws-1',
          normalizedKey: KEY,
          fingerprintInput: makeFingerprint({ operation: 'run.create' }),
        });
        assert.fail('expected rejection');
      } catch (error) {
        assert.ok(error instanceof IdempotencyRecordInvalidError);
        const message = (error as Error).message;
        assert.equal(message, 'Idempotency record is invalid');
        assert.ok(!message.includes('task.create'));
        assert.ok(!message.includes('run.create'));
        assert.ok(!message.includes('ws-1'));
        assert.ok(!message.includes(KEY));
      }
    } finally {
      db.close();
    }
  });

  it('SVC-16 prepare rejects workspace mismatch between scope and fingerprint', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      try {
        service.prepare({
          operation: 'task.create',
          workspaceId: 'ws-1',
          normalizedKey: KEY,
          fingerprintInput: makeFingerprint({ workspaceId: 'ws-2' }),
        });
        assert.fail('expected rejection');
      } catch (error) {
        assert.ok(error instanceof IdempotencyRecordInvalidError);
        const message = (error as Error).message;
        assert.equal(message, 'Idempotency record is invalid');
        assert.ok(!message.includes('ws-1'));
        assert.ok(!message.includes('ws-2'));
        assert.ok(!message.includes(KEY));
      }
    } finally {
      db.close();
    }
  });

  it('SVC-17 storeSuccess rejects a task envelope bound to a different workspace', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = makePrepared(service);
      const envelope = buildTaskResultEnvelopeV1('task.create', makeTask({ workspaceId: 'ws-2' }));
      assert.throws(
        () => service.storeSuccess({ prepared, httpStatus: 201, envelope }),
        IdempotencyRecordInvalidError,
      );
      const count = db.prepare('SELECT COUNT(*) AS c FROM idempotency_records').get() as { c: number };
      assert.equal(count.c, 0);
    } finally {
      db.close();
    }
  });

  it('SVC-18 storeSuccess rejects a run envelope bound to a different workspace', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = service.prepare({
        operation: 'run.create',
        workspaceId: 'ws-1',
        normalizedKey: KEY,
        fingerprintInput: makeFingerprint({ operation: 'run.create' }),
      });
      assert.ok(prepared);
      const envelope = buildRunResultEnvelopeV1('run.create', makeRun({ workspaceId: 'ws-2' }));
      assert.throws(
        () => service.storeSuccess({ prepared, httpStatus: 201, envelope }),
        IdempotencyRecordInvalidError,
      );
      const count = db.prepare('SELECT COUNT(*) AS c FROM idempotency_records').get() as { c: number };
      assert.equal(count.c, 0);
    } finally {
      db.close();
    }
  });

  it('SVC-19 same-workspace task and run envelopes persist and replay', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const taskPrepared = makePrepared(service);
      const taskEnvelope = buildTaskResultEnvelopeV1('task.create', makeTask());
      service.storeSuccess({ prepared: taskPrepared, httpStatus: 201, envelope: taskEnvelope });
      const taskResolution = service.resolve(taskPrepared);
      assert.equal(taskResolution.kind, 'replay');
      if (taskResolution.kind === 'replay') {
        assert.equal(taskResolution.httpStatus, 201);
        assert.deepEqual(taskResolution.envelope, taskEnvelope);
      }
      const runPrepared = service.prepare({
        operation: 'run.create',
        workspaceId: 'ws-1',
        normalizedKey: `${KEY}-run`,
        fingerprintInput: makeFingerprint({
          operation: 'run.create',
          domainInput: { objective: 'objective' },
        }),
      });
      assert.ok(runPrepared);
      const runEnvelope = buildRunResultEnvelopeV1('run.create', makeRun());
      service.storeSuccess({ prepared: runPrepared, httpStatus: 201, envelope: runEnvelope });
      const runResolution = service.resolve(runPrepared);
      assert.equal(runResolution.kind, 'replay');
      if (runResolution.kind === 'replay') {
        assert.equal(runResolution.httpStatus, 201);
        assert.deepEqual(runResolution.envelope, runEnvelope);
      }
    } finally {
      db.close();
    }
  });

  it('SVC-20 registers run.start and run.retry after the six Legacy operations', () => {
    assert.deepEqual(IDEMPOTENCY_OPERATIONS, [
      'task.create',
      'run.create',
      'run.cancel',
      'task.accept',
      'task.cancel',
      'task.reopen',
      'run.start',
      'run.retry',
    ]);
    assert.deepEqual(IDEMPOTENCY_HTTP_STATUS, {
      'task.create': 201,
      'run.create': 201,
      'run.cancel': 200,
      'task.accept': 200,
      'task.cancel': 200,
      'task.reopen': 200,
      'run.start': 202,
      'run.retry': 201,
    });
  });

  it('SVC-21 builds and parses an exact queued run.start Operation envelope', () => {
    const source = makeStartOperation();
    const envelope = buildOperationResultEnvelopeV1('run.start', source);
    assert.deepEqual(Object.keys(envelope).sort(), ['body', 'operation', 'schemaVersion']);
    assert.deepEqual(Object.keys(envelope.body).sort(), ['operation']);
    assert.deepEqual(Object.keys(envelope.body.operation).sort(), [
      'aggregateId', 'aggregateType', 'correlationId', 'createdAt', 'id',
      'runId', 'status', 'type', 'version', 'workspaceId',
    ]);
    assert.deepEqual(envelope, {
      schemaVersion: 1,
      operation: 'run.start',
      body: {
        operation: {
          id: source.id,
          type: 'run.start',
          status: 'queued',
          workspaceId: source.workspaceId,
          aggregateType: 'run',
          aggregateId: source.aggregateId,
          runId: source.runId,
          correlationId: source.correlationId,
          createdAt: NOW,
          version: 1,
        },
      },
    });
    assert.equal('progress' in envelope.body.operation, false);
    assert.equal('result' in envelope.body.operation, false);
    assert.equal('error' in envelope.body.operation, false);
    assert.equal('startedAt' in envelope.body.operation, false);
    assert.equal('completedAt' in envelope.body.operation, false);
    assert.equal('updatedAt' in envelope.body.operation, false);
    assert.equal('data' in envelope.body.operation, false);

    const parsed = parseIdempotencyResultEnvelopeV1(JSON.parse(JSON.stringify(envelope)));
    assert.deepEqual(parsed, envelope);
    (envelope.body.operation as { id: string }).id = 'mutated-operation';
    assert.equal(source.id, 'operation_00000000000000000000000001');
  });

  it('SVC-22 Operation envelope parser rejects variants, binding errors, and forbidden fields', () => {
    const envelope = buildOperationResultEnvelopeV1('run.start', makeStartOperation());
    const invalidValues: unknown[] = [
      { ...envelope, operation: 'run.retry' },
      { ...envelope, body: { task: envelope.body.operation } },
      { ...envelope, body: { run: envelope.body.operation } },
      { ...envelope, body: { operation: { ...envelope.body.operation, status: 'running' } } },
      { ...envelope, body: { operation: { ...envelope.body.operation, aggregateId: 'run-other' } } },
      { ...envelope, body: { operation: { ...envelope.body.operation, correlationId: 'operation-other' } } },
      { ...envelope, body: { operation: { ...envelope.body.operation, progress: {} } } },
      { ...envelope, body: { operation: { ...envelope.body.operation, version: 2 } } },
      { ...envelope, schemaVersion: 2 },
      { ...envelope, body: { operation: { ...envelope.body.operation, type: 'run.create' } } },
      { ...envelope, operation: 'task.create', body: { operation: envelope.body.operation } },
      { ...envelope, body: { unknown: envelope.body.operation } },
      { ...envelope, body: { operation: { ...envelope.body.operation, version: undefined } } },
    ];
    for (const value of invalidValues) assert.throws(() => parseIdempotencyResultEnvelopeV1(value), IdempotencyRecordInvalidError);
    for (const status of ['running', 'completed', 'failed', 'cancelled'] as const) {
      assert.throws(
        () => buildOperationResultEnvelopeV1('run.start', makeStartOperation({ status })),
        IdempotencyRecordInvalidError,
      );
    }
    assert.throws(
      () => buildOperationResultEnvelopeV1('run.start', makeStartOperation({ type: 'run.create' })),
      IdempotencyRecordInvalidError,
    );
    assert.throws(
      () => buildOperationResultEnvelopeV1('run.start', makeStartOperation({ aggregateId: 'run-other' })),
      IdempotencyRecordInvalidError,
    );
    assert.throws(
      () => buildOperationResultEnvelopeV1('run.start', { ...makeStartOperation(), progress: { percent: 0 } }),
      IdempotencyRecordInvalidError,
    );
  });

  it('SVC-23 stores and replays the acceptance-time queued run.start snapshot after source mutation', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = service.prepare({
        operation: 'run.start',
        workspaceId: 'ws-1',
        normalizedKey: `${KEY}-start`,
        fingerprintInput: makeFingerprint({ operation: 'run.start' }),
      });
      assert.ok(prepared);
      const source = { ...makeStartOperation() };
      const envelope = buildOperationResultEnvelopeV1('run.start', source);
      service.storeSuccess({ prepared, httpStatus: 202, envelope });
      source.status = 'running';
      source.version = 2;
      const resolution = service.resolve(prepared);
      assert.equal(resolution.kind, 'replay');
      if (resolution.kind === 'replay') {
        assert.equal(resolution.httpStatus, 202);
        assert.deepEqual(resolution.envelope, {
          schemaVersion: 1,
          operation: 'run.start',
          body: { operation: {
            id: source.id,
            type: 'run.start',
            status: 'queued',
            workspaceId: 'ws-1',
            aggregateType: 'run',
            aggregateId: source.aggregateId,
            runId: source.runId,
            correlationId: source.correlationId,
            createdAt: NOW,
            version: 1,
          } },
        });
      }
    } finally {
      db.close();
    }
  });

  it('SVC-24 restricts HTTP 202 to run.start and HTTP 201 to run.retry', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const startPrepared = service.prepare({
        operation: 'run.start',
        workspaceId: 'ws-1',
        normalizedKey: `${KEY}-status`,
        fingerprintInput: makeFingerprint({ operation: 'run.start' }),
      });
      assert.ok(startPrepared);
      const startEnvelope = buildOperationResultEnvelopeV1('run.start', makeStartOperation());
      assert.throws(() => service.storeSuccess({ prepared: startPrepared, httpStatus: 200, envelope: startEnvelope }), IdempotencyRecordInvalidError);
      assert.throws(() => service.storeSuccess({ prepared: startPrepared, httpStatus: 201, envelope: startEnvelope }), IdempotencyRecordInvalidError);
      const retryPrepared = service.prepare({
        operation: 'run.retry',
        workspaceId: 'ws-1',
        normalizedKey: `${KEY}-retry`,
        fingerprintInput: makeRetryFingerprint(),
      });
      assert.ok(retryPrepared);
      const retryEnvelope = buildRetryResultEnvelopeV1(
        'run.retry',
        makeRetryChildRun(),
        makeRetryOperation(),
      );
      assert.throws(
        () => service.storeSuccess({ prepared: retryPrepared, httpStatus: 200, envelope: retryEnvelope }),
        IdempotencyRecordInvalidError,
      );
      assert.throws(
        () => service.storeSuccess({ prepared: retryPrepared, httpStatus: 202, envelope: retryEnvelope }),
        IdempotencyRecordInvalidError,
      );
      const record = service.storeSuccess({ prepared: retryPrepared, httpStatus: 201, envelope: retryEnvelope });
      assert.equal(record.httpStatus, 201);
      const replay = service.resolve(retryPrepared);
      assert.equal(replay.kind, 'replay');
      if (replay.kind === 'replay') assert.equal(replay.httpStatus, 201);
    } finally {
      db.close();
    }
  });

  it('SVC-27 builds and parses a dedicated exact Retry result envelope', () => {
    const childRun = makeRetryChildRun();
    const retryOperation = makeRetryOperation();
    const envelope = buildRetryResultEnvelopeV1('run.retry', childRun, retryOperation);
    assert.deepEqual(Object.keys(envelope).sort(), ['body', 'operation', 'schemaVersion']);
    assert.deepEqual(Object.keys(envelope.body).sort(), ['operation', 'run']);
    assert.deepEqual(Object.keys(envelope.body.run).sort(), [
      'createdAt', 'createdBy', 'id', 'nextEventSequence', 'origin', 'parentRunId',
      'reason', 'rootRunId', 'status', 'taskId', 'updatedAt', 'version', 'workspaceId',
    ]);
    assert.deepEqual(Object.keys(envelope.body.operation).sort(), [
      'aggregateId', 'aggregateType', 'completedAt', 'correlationId', 'createdAt', 'id',
      'result', 'runId', 'startedAt', 'status', 'type', 'version', 'workspaceId',
    ]);
    assert.deepEqual(envelope, {
      schemaVersion: 1,
      operation: 'run.retry',
      body: {
        run: {
          id: childRun.id,
          workspaceId: childRun.workspaceId,
          taskId: childRun.taskId,
          parentRunId: childRun.parentRunId,
          rootRunId: childRun.rootRunId,
          status: 'queued',
          reason: 'retry',
          origin: childRun.origin,
          nextEventSequence: 1,
          createdBy: childRun.createdBy,
          createdAt: NOW,
          updatedAt: NOW,
          version: 1,
        },
        operation: {
          id: retryOperation.id,
          type: 'run.retry',
          status: 'completed',
          workspaceId: 'ws-1',
          aggregateType: 'run',
          aggregateId: 'run_00000000000000000000000001',
          runId: 'run_00000000000000000000000001',
          correlationId: retryOperation.id,
          result: { resourceType: 'run', resourceId: childRun.id },
          createdAt: NOW,
          startedAt: '2026-01-01T00:00:00.001Z',
          completedAt: '2026-01-01T00:00:00.002Z',
          version: 3,
        },
      },
    });
    const parsed = parseIdempotencyResultEnvelopeV1(JSON.parse(JSON.stringify(envelope)));
    assert.deepEqual(parsed, envelope);
    assert.equal(envelope.body.run.status, 'queued');
    assert.equal(envelope.body.run.reason, 'retry');
    assert.equal(envelope.body.operation.status, 'completed');
    assert.equal(envelope.body.operation.version, 3);
    for (const field of ['startedAt', 'completedAt', 'failureCode', 'failureMessage', 'cancellationRequestedAt']) {
      assert.equal(field in envelope.body.run, false);
    }
    for (const field of ['data', 'error', 'progress', 'updatedAt']) {
      assert.equal(field in envelope.body.operation, false);
    }

    const sourceChild = { ...childRun };
    const sourceOperation = {
      ...retryOperation,
      result: { resourceType: 'run', resourceId: childRun.id },
    };
    const detached = buildRetryResultEnvelopeV1('run.retry', sourceChild, sourceOperation);
    sourceChild.status = 'running';
    sourceOperation.status = 'running';
    sourceOperation.version = 4;
    sourceOperation.result.resourceId = 'run_other';
    assert.equal(detached.body.run.status, 'queued');
    assert.equal(detached.body.operation.status, 'completed');
    assert.equal(detached.body.operation.version, 3);
    assert.equal(detached.body.operation.result.resourceId, childRun.id);
  });

  it('SVC-28 rejects Retry builder and parser variants fail closed', () => {
    const childRun = makeRetryChildRun();
    const retryOperation = makeRetryOperation();
    const envelope = buildRetryResultEnvelopeV1('run.retry', childRun, retryOperation);
    const invalidValues: unknown[] = [
      { ...envelope, schemaVersion: 2 },
      { ...envelope, operation: 'run.start' },
      { ...envelope, body: { run: envelope.body.run } },
      { ...envelope, body: { operation: envelope.body.operation } },
      { ...envelope, body: { ...envelope.body, extra: true } },
      { ...envelope, body: { ...envelope.body, run: { ...envelope.body.run, status: 'running' } } },
      { ...envelope, body: { ...envelope.body, run: { ...envelope.body.run, reason: 'initial' } } },
      { ...envelope, body: { ...envelope.body, run: { ...envelope.body.run, parentRunId: undefined } } },
      { ...envelope, body: { ...envelope.body, run: { ...envelope.body.run, id: envelope.body.run.parentRunId } } },
      { ...envelope, body: { ...envelope.body, operation: { ...envelope.body.operation, status: 'running' } } },
      { ...envelope, body: { ...envelope.body, operation: { ...envelope.body.operation, version: 2 } } },
      { ...envelope, body: { ...envelope.body, operation: { ...envelope.body.operation, runId: 'run_other' } } },
      { ...envelope, body: { ...envelope.body, operation: { ...envelope.body.operation, result: { resourceType: 'run', resourceId: 'run_other' } } } },
      { ...envelope, body: { ...envelope.body, operation: { ...envelope.body.operation, data: {} } } },
      { ...envelope, body: { ...envelope.body, operation: { ...envelope.body.operation, startedAt: '2026-01-02T00:00:00.000Z' } } },
    ];
    for (const value of invalidValues) assert.throws(
      () => parseIdempotencyResultEnvelopeV1(value),
      IdempotencyRecordInvalidError,
    );
    assert.throws(
      () => buildRetryResultEnvelopeV1('run.retry', makeRetryChildRun({ status: 'running' }), retryOperation),
      IdempotencyRecordInvalidError,
    );
    assert.throws(
      () => buildRetryResultEnvelopeV1('run.retry', makeRetryChildRun(), makeRetryOperation({ version: 2 })),
      IdempotencyRecordInvalidError,
    );
    assert.throws(
      () => buildRetryResultEnvelopeV1(
        'run.retry',
        makeRetryChildRun(),
        makeRetryOperation({ result: { resourceType: 'run', resourceId: 'run_other' } }),
      ),
      IdempotencyRecordInvalidError,
    );
  });

  it('SVC-29 replays immutable Retry snapshots and validates all workspace bindings', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = service.prepare({
        operation: 'run.retry',
        workspaceId: 'ws-1',
        normalizedKey: `${KEY}-retry-snapshot`,
        fingerprintInput: makeRetryFingerprint(),
      });
      assert.ok(prepared);
      const childRun = makeRetryChildRun();
      const retryOperation = {
        ...makeRetryOperation(),
        result: { resourceType: 'run', resourceId: 'run_00000000000000000000000002' },
      };
      const envelope = buildRetryResultEnvelopeV1('run.retry', childRun, retryOperation);
      service.storeSuccess({ prepared, httpStatus: 201, envelope });
      childRun.status = 'running';
      childRun.version = 2;
      retryOperation.status = 'running';
      retryOperation.version = 4;
      const replay = service.resolve(prepared);
      assert.equal(replay.kind, 'replay');
      if (replay.kind === 'replay') {
        assert.equal(replay.httpStatus, 201);
        assert.equal(replay.envelope.body.run.status, 'queued');
        assert.equal(replay.envelope.body.run.version, 1);
        assert.equal(replay.envelope.body.operation.status, 'completed');
        assert.equal(replay.envelope.body.operation.version, 3);
        assert.equal(replay.envelope.body.operation.result.resourceId, 'run_00000000000000000000000002');
      }
      const mismatched = JSON.parse(JSON.stringify(envelope));
      mismatched.body.operation.workspaceId = 'ws-2';
      assert.throws(
        () => service.storeSuccess({ prepared, httpStatus: 201, envelope: mismatched }),
        IdempotencyRecordInvalidError,
      );
      const malformed = JSON.parse(JSON.stringify(envelope));
      delete malformed.body.run;
      assert.throws(
        () => service.storeSuccess({ prepared, httpStatus: 201, envelope: malformed }),
        IdempotencyRecordInvalidError,
      );
    } finally {
      db.close();
    }
  });

  it('SVC-30 keeps Retry persistence inside the caller-owned transaction', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = service.prepare({
        operation: 'run.retry',
        workspaceId: 'ws-1',
        normalizedKey: `${KEY}-retry-transaction`,
        fingerprintInput: makeRetryFingerprint(),
      });
      assert.ok(prepared);
      const envelope = buildRetryResultEnvelopeV1('run.retry', makeRetryChildRun(), makeRetryOperation());
      assert.throws(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
          service.storeSuccess({ prepared, httpStatus: 201, envelope });
          throw new Error('expected-retry-rollback');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }, /expected-retry-rollback/);
      assert.equal(service.resolve(prepared).kind, 'miss');
      db.exec('BEGIN IMMEDIATE');
      service.storeSuccess({ prepared, httpStatus: 201, envelope });
      db.exec('COMMIT');
      const replay = service.resolve(prepared);
      assert.equal(replay.kind, 'replay');
      if (replay.kind === 'replay') {
        assert.equal(replay.httpStatus, 201);
        assert.deepEqual(replay.envelope, envelope);
      }
      assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  });

  it('SVC-25 replays the acceptance snapshot after a real OperationService transition', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertQueuedRunFixture(db);
      const operationService = new OperationService(db, { now: () => NOW });
      const operation = operationService.create({ workspaceId: 'ws-1', runId: 'run-start-replay', type: 'run.start' });
      const service = makeService(db);
      const prepared = service.prepare({
        operation: 'run.start',
        workspaceId: 'ws-1',
        normalizedKey: `${KEY}-real-operation`,
        fingerprintInput: {
          operation: 'run.start',
          workspaceId: 'ws-1',
          pathParams: { runId: 'run-start-replay' },
          domainInput: {},
          expectedVersion: 1,
        },
      });
      assert.ok(prepared);
      const envelope = buildOperationResultEnvelopeV1('run.start', operation);
      service.storeSuccess({ prepared, httpStatus: 202, envelope });
      const running = operationService.transition({
        workspaceId: 'ws-1',
        operationId: operation.id,
        expectedVersion: operation.version,
        to: 'running',
      });
      const completed = operationService.transition({
        workspaceId: 'ws-1',
        operationId: operation.id,
        expectedVersion: running.version,
        to: 'completed',
        result: { resourceType: 'run', resourceId: 'run-start-replay' },
      });
      assert.equal(completed.status, 'completed');
      assert.equal(completed.version, 3);
      const resolution = service.resolve(prepared);
      assert.equal(resolution.kind, 'replay');
      if (resolution.kind === 'replay') {
        assert.equal(resolution.httpStatus, 202);
        const replayed = resolution.envelope.body.operation;
        assert.equal(replayed.type, 'run.start');
        assert.equal(replayed.status, 'queued');
        assert.equal(replayed.version, 1);
        assert.equal('startedAt' in replayed, false);
        assert.equal('completedAt' in replayed, false);
        assert.equal('result' in replayed, false);
        assert.equal('error' in replayed, false);
        assert.deepEqual(replayed, envelope.body.operation);
      }
    } finally {
      db.close();
    }
  });

  it('SVC-26 keeps run.start persistence inside a caller-owned transaction', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const service = makeService(db);
      const prepared = service.prepare({
        operation: 'run.start',
        workspaceId: 'ws-1',
        normalizedKey: `${KEY}-transaction`,
        fingerprintInput: makeFingerprint({ operation: 'run.start' }),
      });
      assert.ok(prepared);
      const envelope = buildOperationResultEnvelopeV1('run.start', makeStartOperation());

      assert.throws(() => {
        db.exec('BEGIN IMMEDIATE');
        try {
          service.storeSuccess({ prepared, httpStatus: 202, envelope });
          throw new Error('expected-service-rollback');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }, /expected-service-rollback/);
      assert.equal(service.resolve(prepared).kind, 'miss');

      db.exec('BEGIN IMMEDIATE');
      service.storeSuccess({ prepared, httpStatus: 202, envelope });
      db.exec('COMMIT');
      const replay = service.resolve(prepared);
      assert.equal(replay.kind, 'replay');
      if (replay.kind === 'replay') {
        assert.equal(replay.httpStatus, 202);
        assert.deepEqual(replay.envelope, envelope);
      }
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      assert.equal(integrity.integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
  });
});
