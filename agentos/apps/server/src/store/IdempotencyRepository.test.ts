import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
import { canonicalizeJson, hashCanonicalJson } from '../snapshots/canonicalJson.js';
import { createEntityId } from './Identity.js';
import { SqliteStore } from './SqliteStore.js';
import {
  buildTaskResultEnvelopeV1,
  IdempotencyRecordInvalidError,
  type IdempotencyOperation,
  type InsertCompletedIdempotencyRecord,
  type TaskResultEnvelopeV1,
} from '../idempotency/types.js';
import { hashIdempotencyRequest, hashNormalizedIdempotencyKey } from '../idempotency/fingerprint.js';
import { IdempotencyRepository } from './IdempotencyRepository.js';

const NOW = '2026-01-01T00:00:00.000Z';
const HASH64 = 'c'.repeat(64);
const RAW_KEY = 'raw-key-should-never-persist';

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry([...DEFAULT_REGISTRY_MIGRATIONS])).run();
  return db;
}

function rawDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      canonical_root_path TEXT NOT NULL,
      last_opened_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE idempotency_records (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      result_schema_version INTEGER NOT NULL,
      result_json TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      http_status INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
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

function makeEnvelope(): TaskResultEnvelopeV1 {
  return buildTaskResultEnvelopeV1('task.create', makeTask());
}

function makeInput(overrides: Partial<InsertCompletedIdempotencyRecord> = {}): InsertCompletedIdempotencyRecord {
  return {
    id: createEntityId('idempotency'),
    workspaceId: 'ws-1',
    operation: 'task.create',
    keyHash: hashNormalizedIdempotencyKey(RAW_KEY),
    requestHash: hashIdempotencyRequest({
      operation: 'task.create',
      workspaceId: 'ws-1',
      pathParams: {},
      domainInput: { title: 'task title' },
      expectedVersion: null,
    }),
    envelope: makeEnvelope(),
    httpStatus: 201,
    createdAt: NOW,
    ...overrides,
  };
}

function insertRawRow(
  db: Db,
  overrides: {
    id?: string;
    workspaceId?: string;
    operation?: string;
    keyHash?: string;
    requestHash?: string;
    resultSchemaVersion?: number;
    resultJson?: string;
    resultHash?: string;
    httpStatus?: number;
    createdAt?: string;
  } = {},
): void {
  const envelope = makeEnvelope();
  db.prepare(`
    INSERT INTO idempotency_records (
      id, workspace_id, operation, key_hash, request_hash,
      result_schema_version, result_json, result_hash, http_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id ?? createEntityId('idempotency'),
    overrides.workspaceId ?? 'ws-1',
    overrides.operation ?? 'task.create',
    overrides.keyHash ?? HASH64,
    overrides.requestHash ?? HASH64,
    overrides.resultSchemaVersion ?? 1,
    overrides.resultJson ?? canonicalizeJson(envelope),
    overrides.resultHash ?? hashCanonicalJson(envelope),
    overrides.httpStatus ?? 201,
    overrides.createdAt ?? NOW,
  );
}

describe('M2.6 — IdempotencyRepository insert and read', () => {
  it('R01 insert/read round trip returns the stored record', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      const record = repo.insertCompleted(input);
      assert.equal(record.id, input.id);
      assert.equal(record.workspaceId, 'ws-1');
      assert.equal(record.operation, 'task.create');
      assert.equal(record.keyHash, input.keyHash);
      assert.equal(record.requestHash, input.requestHash);
      assert.equal(record.resultSchemaVersion, 1);
      assert.deepEqual(record.envelope, input.envelope);
      assert.equal(record.httpStatus, 201);
      assert.equal(record.createdAt, NOW);
      const found = repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash);
      assert.deepEqual(found, record);
    } finally {
      db.close();
    }
  });

  it('R02 stored result_json is the canonical envelope JSON', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      const row = db.prepare('SELECT result_json FROM idempotency_records WHERE id = ?').get(input.id) as { result_json: string };
      assert.equal(row.result_json, canonicalizeJson(input.envelope));
    } finally {
      db.close();
    }
  });

  it('R03 result_hash is computed internally from the canonical envelope', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      const record = repo.insertCompleted(input);
      assert.equal(record.resultHash, hashCanonicalJson(input.envelope));
      const row = db.prepare('SELECT result_hash FROM idempotency_records WHERE id = ?').get(input.id) as { result_hash: string };
      assert.equal(row.result_hash, record.resultHash);
    } finally {
      db.close();
    }
  });

  it('R04 raw key never appears in the stored row', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      const row = db.prepare('SELECT * FROM idempotency_records WHERE id = ?').get(input.id) as Record<string, unknown>;
      for (const value of Object.values(row)) {
        assert.ok(!String(value).includes(RAW_KEY), `raw key leaked into row value: ${String(value)}`);
      }
    } finally {
      db.close();
    }
  });

  it('R05 normalized key never appears in the stored row', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const normalizedKey = 'normalized-key-123';
      const input = makeInput({ keyHash: hashNormalizedIdempotencyKey(normalizedKey) });
      repo.insertCompleted(input);
      const row = db.prepare('SELECT * FROM idempotency_records WHERE id = ?').get(input.id) as Record<string, unknown>;
      for (const value of Object.values(row)) {
        assert.ok(!String(value).includes(normalizedKey));
      }
    } finally {
      db.close();
    }
  });

  it('R06 lookup is scoped to the exact workspace', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertWorkspace(db, 'ws-2');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      assert.ok(repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash));
      const other = repo.insertCompleted(makeInput({ workspaceId: 'ws-2' }));
      assert.ok(other.id !== input.id);
    } finally {
      db.close();
    }
  });

  it('R07 cross-workspace lookup returns undefined', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertWorkspace(db, 'ws-2');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      assert.equal(repo.findVerifiedByScope('ws-2', 'task.create', input.keyHash), undefined);
    } finally {
      db.close();
    }
  });

  it('R08 different operation returns undefined', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      assert.equal(repo.findVerifiedByScope('ws-1', 'run.create', input.keyHash), undefined);
    } finally {
      db.close();
    }
  });

  it('R09 insert with invalid id is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeInput({ id: 'task_00000000000000000000000001' })), IdempotencyRecordInvalidError);
      assert.throws(() => repo.insertCompleted(makeInput({ id: 'idem_short' })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R10 insert with an extra envelope field is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const envelope = { ...makeEnvelope(), extra: 1 } as TaskResultEnvelopeV1;
      assert.throws(() => repo.insertCompleted(makeInput({ envelope })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R11 insert with a missing envelope field is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const broken = JSON.parse(JSON.stringify(makeEnvelope()));
      delete broken.body.task.title;
      assert.throws(() => repo.insertCompleted(makeInput({ envelope: broken })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R12 insert with envelope operation mismatch is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const envelope = buildTaskResultEnvelopeV1('task.accept', makeTask());
      assert.throws(
        () => repo.insertCompleted(makeInput({ envelope, httpStatus: 200, operation: 'task.create' as IdempotencyOperation })),
        IdempotencyRecordInvalidError,
      );
    } finally {
      db.close();
    }
  });

  it('R13 insert with invalid keyHash is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeInput({ keyHash: 'not-a-hash' })), IdempotencyRecordInvalidError);
      assert.throws(() => repo.insertCompleted(makeInput({ keyHash: 'A'.repeat(64) })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R14 insert with invalid requestHash is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeInput({ requestHash: 'z'.repeat(64) })), IdempotencyRecordInvalidError);
      assert.throws(() => repo.insertCompleted(makeInput({ requestHash: 'a'.repeat(63) })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R15 stored malformed result_hash fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { resultHash: 'not-a-hash' });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R16 stored invalid result_schema_version fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { resultSchemaVersion: 2 });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R17 stored non-2xx http_status fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { httpStatus: 500 });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R18 operation/http status pair mismatch is rejected on insert and read', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeInput({ httpStatus: 200 })), IdempotencyRecordInvalidError);
      const runCancel = buildTaskResultEnvelopeV1('task.cancel', makeTask());
      assert.throws(
        () => repo.insertCompleted(makeInput({ operation: 'task.cancel', envelope: runCancel, httpStatus: 201 })),
        IdempotencyRecordInvalidError,
      );
    } finally {
      db.close();
    }
    const raw = rawDb();
    try {
      insertWorkspace(raw, 'ws-1');
      insertRawRow(raw, { httpStatus: 200 });
      const repo = new IdempotencyRepository(raw);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      raw.close();
    }
  });

  it('R19 stored invalid JSON fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { resultJson: 'not-json' });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R20 stored non-canonical JSON fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { resultJson: `{ "schemaVersion": 1, "operation": "task.create", "body": { "task": {} } }` });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R21 result hash tampering fails closed on read', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, { resultHash: 'e'.repeat(64) });
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
  });

  it('R22 invalid createdAt is rejected on insert and read', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      assert.throws(() => repo.insertCompleted(makeInput({ createdAt: 'not-a-date' })), IdempotencyRecordInvalidError);
      assert.throws(() => repo.insertCompleted(makeInput({ createdAt: '2026-13-99T99:99:99Z' })), IdempotencyRecordInvalidError);
    } finally {
      db.close();
    }
    const raw = rawDb();
    try {
      insertWorkspace(raw, 'ws-1');
      insertRawRow(raw, { createdAt: 'not-a-date' });
      const repo = new IdempotencyRepository(raw);
      assert.throws(() => repo.findVerifiedByScope('ws-1', 'task.create', HASH64), IdempotencyRecordInvalidError);
    } finally {
      raw.close();
    }
  });

  it('R23 returned record is deep detached', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      const record = repo.insertCompleted(input);
      (record.envelope as TaskResultEnvelopeV1).body.task.title = 'mutated';
      const found = repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash);
      assert.equal((found!.envelope as TaskResultEnvelopeV1).body.task.title, 'task title');
    } finally {
      db.close();
    }
  });

  it('R24 duplicate scope is rejected by SQLite', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      assert.throws(() => repo.insertCompleted(makeInput({ keyHash: input.keyHash })));
    } finally {
      db.close();
    }
  });

  it('R25 UPDATE is rejected by the immutability trigger', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      assert.throws(
        () => db.prepare('UPDATE idempotency_records SET http_status = 200 WHERE id = ?').run(input.id),
        /IDEMPOTENCY_RECORD_IMMUTABLE/,
      );
    } finally {
      db.close();
    }
  });

  it('R26 direct DELETE is permitted at the database level', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      db.prepare('DELETE FROM idempotency_records WHERE id = ?').run(input.id);
      assert.equal(repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash), undefined);
    } finally {
      db.close();
    }
  });

  it('R27 workspace cascade delete removes records', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const input = makeInput();
      repo.insertCompleted(input);
      db.prepare("DELETE FROM workspaces WHERE id = 'ws-1'").run();
      assert.equal(repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash), undefined);
    } finally {
      db.close();
    }
  });

  it('R28 well-formed request hash mismatch is not judged by the repository', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const repo = new IdempotencyRepository(db);
      const requestHashA = hashIdempotencyRequest({
        operation: 'task.create',
        workspaceId: 'ws-1',
        pathParams: {},
        domainInput: { title: 'A' },
        expectedVersion: null,
      });
      const input = makeInput({ requestHash: requestHashA });
      repo.insertCompleted(input);
      const found = repo.findVerifiedByScope('ws-1', 'task.create', input.keyHash);
      assert.equal(found!.requestHash, requestHashA);
    } finally {
      db.close();
    }
  });

  it('R29 error message never contains sensitive row values', () => {
    const db = rawDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRawRow(db, {
        resultJson: '{"schemaVersion":1,"secret":"SENSITIVE-ROW-VALUE"}',
        resultHash: 'd'.repeat(64),
      });
      const repo = new IdempotencyRepository(db);
      try {
        repo.findVerifiedByScope('ws-1', 'task.create', HASH64);
        assert.fail('expected rejection');
      } catch (error) {
        assert.ok(error instanceof IdempotencyRecordInvalidError);
        const message = (error as Error).message;
        assert.equal(message, 'Idempotency record is invalid');
        assert.ok(!message.includes('SENSITIVE-ROW-VALUE'));
        assert.ok(!message.includes(HASH64));
        assert.ok(!message.includes('ws-1'));
      }
    } finally {
      db.close();
    }
  });

  it('R30 public surface exposes only findVerifiedByScope and insertCompleted', () => {
    const db = migratedDb();
    try {
      const repo = new IdempotencyRepository(db);
      const publicNames = Object.getOwnPropertyNames(IdempotencyRepository.prototype)
        .filter((name) => name !== 'constructor' && !name.startsWith('_'));
      assert.deepEqual(publicNames.sort(), ['findVerifiedByScope', 'insertCompleted']);
      const instance = repo as unknown as Record<string, unknown>;
      assert.equal(instance.update, undefined);
      assert.equal(instance.delete, undefined);
      assert.equal(instance.findAll, undefined);
      assert.equal(instance.list, undefined);
      assert.equal(instance.verifyIntegrity, undefined);
      assert.equal(instance.getDatabase, undefined);
    } finally {
      db.close();
    }
  });
});

describe('M2.6 — SqliteStore idempotency wiring', () => {
  it('R31 accessor uses the same DB handle as runInTransaction (rollback removes the insert)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm26-idem-store-'));
    let store: SqliteStore | undefined;
    const expectedRollback = new Error('expected-rollback');
    try {
      store = new SqliteStore(root);
      store.getDatabase().prepare(`
        INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
        VALUES ('ws-1', 'ws-1', '/r/ws-1', '/r/ws-1', ?, ?, ?)
      `).run(NOW, NOW, NOW);
      const input = makeInput();
      assert.throws(() => {
        store!.runInTransaction(() => {
          store!.idempotencyRepository().insertCompleted(input);
          throw expectedRollback;
        });
      }, /expected-rollback/);
      assert.equal(
        store.idempotencyRepository().findVerifiedByScope('ws-1', 'task.create', input.keyHash),
        undefined,
      );
      store.runInTransaction(() => {
        store!.idempotencyRepository().insertCompleted(input);
      });
      assert.ok(store.idempotencyRepository().findVerifiedByScope('ws-1', 'task.create', input.keyHash));
    } finally {
      store?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
