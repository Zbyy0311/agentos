import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { Task } from '@agentos/shared';

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
import { buildTaskResultEnvelopeV1, type FingerprintInput } from '../idempotency/types.js';
import { canonicalizeJson } from '../snapshots/canonicalJson.js';
import {
  IdempotencyKeyReusedError,
  IdempotencyService,
  type PreparedIdempotency,
} from './IdempotencyService.js';
import { IdempotencyKeyValidationError } from '../idempotency/fingerprint.js';
import { IdempotencyRecordInvalidError } from '../idempotency/types.js';

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
});
