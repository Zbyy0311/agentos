import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

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

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import {
  migration010,
  migration010Checksum,
  M26_010_DDL_STATEMENTS,
} from '../migrations/010-idempotency-records.js';
import type { Migration } from '../types.js';

const NOW = '2026-01-01T00:00:00.000Z';
const HASH64 = 'a'.repeat(64);
const VALID_ID = `idem_${'0'.repeat(26)}`;
const VALID_ID_B = `idem_${'0'.repeat(25)}1`;

const REGISTRY_FIRST_NINE = DEFAULT_REGISTRY_MIGRATIONS.slice(0, 9);

function runMigrations(db: Db, migrations: Migration[]): void {
  new MigrationRunner(db, new MigrationRegistry(migrations)).run();
}

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, [...DEFAULT_REGISTRY_MIGRATIONS]);
  return db;
}

function tableNames(db: Db): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function tableInfo(db: Db, table: string): Array<{ name: string }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
}

function insertWorkspace(db: Db, id: string): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `ws-${id}`, `/r/${id}`, `/r/${id}`, NOW, NOW, NOW);
}

function insertTask(db: Db, id: string, workspaceId: string): void {
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, legacy_task_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, NULL, 'task', 'open', 'normal', 'tester', ?, ?)
  `).run(id, workspaceId, NOW, NOW);
}

function insertRecord(
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
  db.prepare(`
    INSERT INTO idempotency_records (
      id, workspace_id, operation, key_hash, request_hash,
      result_schema_version, result_json, result_hash, http_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.id ?? VALID_ID,
    overrides.workspaceId ?? 'ws-1',
    overrides.operation ?? 'task.create',
    overrides.keyHash ?? HASH64,
    overrides.requestHash ?? HASH64,
    overrides.resultSchemaVersion ?? 1,
    overrides.resultJson ?? '{"schemaVersion":1}',
    overrides.resultHash ?? HASH64,
    overrides.httpStatus ?? 201,
    overrides.createdAt ?? NOW,
  );
}

describe('M2.6 — Migration 010 idempotency_records schema', () => {
  it('S01 fresh DB creates idempotency_records', () => {
    const db = migratedDb();
    try {
      assert.ok(tableNames(db).includes('idempotency_records'));
    } finally {
      db.close();
    }
  });

  it('S02 a 009 DB upgrades to 010', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      runMigrations(db, [...REGISTRY_FIRST_NINE]);
      assert.ok(!tableNames(db).includes('idempotency_records'));
      runMigrations(db, [...DEFAULT_REGISTRY_MIGRATIONS]);
      assert.ok(tableNames(db).includes('idempotency_records'));
      const record = db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id = '010'").all();
      assert.equal(record.length, 1);
    } finally {
      db.close();
    }
  });

  it('S03 existing prior data is retained after the 010 upgrade', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      runMigrations(db, [...REGISTRY_FIRST_NINE]);
      insertWorkspace(db, 'ws-1');
      insertTask(db, 'task-1', 'ws-1');
      runMigrations(db, [...DEFAULT_REGISTRY_MIGRATIONS]);
      const task = db.prepare("SELECT id FROM tasks WHERE id = 'task-1'").all();
      assert.equal(task.length, 1);
      const workspace = db.prepare("SELECT id FROM workspaces WHERE id = 'ws-1'").all();
      assert.equal(workspace.length, 1);
    } finally {
      db.close();
    }
  });

  it('S04 exact columns', () => {
    const db = migratedDb();
    try {
      const columns = tableInfo(db, 'idempotency_records').map((c) => c.name);
      assert.deepEqual(columns, [
        'id',
        'workspace_id',
        'operation',
        'key_hash',
        'request_hash',
        'result_schema_version',
        'result_json',
        'result_hash',
        'http_status',
        'created_at',
      ]);
    } finally {
      db.close();
    }
  });

  it('S05 no expires_at column', () => {
    const db = migratedDb();
    try {
      const columns = tableInfo(db, 'idempotency_records').map((c) => c.name);
      assert.ok(!columns.includes('expires_at'));
    } finally {
      db.close();
    }
  });

  it('S06 no raw key column', () => {
    const db = migratedDb();
    try {
      const columns = tableInfo(db, 'idempotency_records').map((c) => c.name);
      for (const column of columns) {
        assert.ok(!/raw|secret/i.test(column), `unexpected sensitive column: ${column}`);
      }
      assert.ok(!columns.includes('key'));
      assert.ok(!columns.includes('idempotency_key'));
      assert.ok(!columns.includes('request_body'));
    } finally {
      db.close();
    }
  });

  it('S07 all six frozen operations are accepted', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      const operations = [
        'task.create',
        'run.create',
        'run.cancel',
        'task.accept',
        'task.cancel',
        'task.reopen',
      ];
      for (const [index, operation] of operations.entries()) {
        insertRecord(db, {
          id: `idem_${'0'.repeat(24)}${String(index).padStart(2, '0')}`,
          operation,
          keyHash: `${index}${'a'.repeat(63)}`,
        });
      }
      const count = db.prepare('SELECT COUNT(*) AS c FROM idempotency_records').get() as { c: number };
      assert.equal(count.c, 6);
    } finally {
      db.close();
    }
  });

  it('S08 invalid operation is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      assert.throws(() => insertRecord(db, { operation: 'task.delete' }));
      assert.throws(() => insertRecord(db, { operation: 'TASK.CREATE' }));
    } finally {
      db.close();
    }
  });

  it('S09 hash with wrong length is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      assert.throws(() => insertRecord(db, { keyHash: 'a'.repeat(63) }));
      assert.throws(() => insertRecord(db, { requestHash: 'a'.repeat(65) }));
      assert.throws(() => insertRecord(db, { resultHash: 'a'.repeat(32) }));
    } finally {
      db.close();
    }
  });

  it('S10 uppercase or non-hex hash is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      assert.throws(() => insertRecord(db, { keyHash: 'A'.repeat(64) }));
      assert.throws(() => insertRecord(db, { requestHash: 'g'.repeat(64) }));
      assert.throws(() => insertRecord(db, { resultHash: `z${'a'.repeat(63)}` }));
    } finally {
      db.close();
    }
  });

  it('S11 result_schema_version must be exactly 1', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      assert.throws(() => insertRecord(db, { resultSchemaVersion: 0 }));
      assert.throws(() => insertRecord(db, { resultSchemaVersion: 2 }));
    } finally {
      db.close();
    }
  });

  it('S12 invalid JSON result is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      assert.throws(() => insertRecord(db, { resultJson: 'not-json' }));
      assert.throws(() => insertRecord(db, { resultJson: '{"unterminated":' }));
    } finally {
      db.close();
    }
  });

  it('S13 http_status below 200 is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      assert.throws(() => insertRecord(db, { httpStatus: 199 }));
      assert.throws(() => insertRecord(db, { httpStatus: 0 }));
    } finally {
      db.close();
    }
  });

  it('S14 http_status above 299 is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      assert.throws(() => insertRecord(db, { httpStatus: 300 }));
      assert.throws(() => insertRecord(db, { httpStatus: 500 }));
    } finally {
      db.close();
    }
  });

  it('S15 workspace foreign key is enforced', () => {
    const db = migratedDb();
    try {
      assert.throws(() => insertRecord(db, { workspaceId: 'missing-workspace' }));
    } finally {
      db.close();
    }
  });

  it('S16 workspace cascade delete removes records', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRecord(db);
      db.prepare("DELETE FROM workspaces WHERE id = 'ws-1'").run();
      const count = db.prepare('SELECT COUNT(*) AS c FROM idempotency_records').get() as { c: number };
      assert.equal(count.c, 0);
    } finally {
      db.close();
    }
  });

  it('S17 duplicate workspace+operation+key_hash scope is rejected', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRecord(db);
      assert.throws(() => insertRecord(db, { id: VALID_ID_B }));
    } finally {
      db.close();
    }
  });

  it('S18 same key hash in a different workspace is allowed', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertWorkspace(db, 'ws-2');
      insertRecord(db, { workspaceId: 'ws-1' });
      insertRecord(db, { id: VALID_ID_B, workspaceId: 'ws-2' });
      const count = db.prepare('SELECT COUNT(*) AS c FROM idempotency_records').get() as { c: number };
      assert.equal(count.c, 2);
    } finally {
      db.close();
    }
  });

  it('S19 same key hash for a different operation is allowed', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRecord(db, { operation: 'task.create' });
      insertRecord(db, { id: VALID_ID_B, operation: 'run.create' });
      const count = db.prepare('SELECT COUNT(*) AS c FROM idempotency_records').get() as { c: number };
      assert.equal(count.c, 2);
    } finally {
      db.close();
    }
  });

  it('S20 UPDATE trigger rejects record mutation', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRecord(db);
      assert.throws(() =>
        db.prepare('UPDATE idempotency_records SET http_status = 200 WHERE id = ?').run(VALID_ID),
      );
    } finally {
      db.close();
    }
  });

  it('S21 trigger abort message is IDEMPOTENCY_RECORD_IMMUTABLE', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRecord(db);
      assert.throws(
        () => db.prepare('UPDATE idempotency_records SET http_status = 200 WHERE id = ?').run(VALID_ID),
        /IDEMPOTENCY_RECORD_IMMUTABLE/,
      );
    } finally {
      db.close();
    }
  });

  it('S22 direct DELETE is allowed at the database level', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRecord(db);
      db.prepare('DELETE FROM idempotency_records WHERE id = ?').run(VALID_ID);
      const count = db.prepare('SELECT COUNT(*) AS c FROM idempotency_records').get() as { c: number };
      assert.equal(count.c, 0);
    } finally {
      db.close();
    }
  });

  it('S23 no DELETE trigger exists on idempotency_records', () => {
    const db = migratedDb();
    try {
      const triggers = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='idempotency_records'",
      ).all() as Array<{ name: string }>;
      assert.deepEqual(triggers.map((t) => t.name), ['idempotency_records_reject_update']);
    } finally {
      db.close();
    }
  });

  it('S24 exact migration checksum is recorded and exported', () => {
    const db = migratedDb();
    try {
      const record = db.prepare("SELECT checksum FROM _schema_migrations WHERE migration_id = '010'").get() as { checksum: string };
      assert.equal(record.checksum, migration010Checksum);
      assert.equal(migration010.checksum, migration010Checksum);
      assert.equal(migration010.id, '010');
      assert.equal(migration010.name, 'idempotency-records');
      assert.ok(/^[0-9a-f]{16}$/.test(migration010Checksum));
    } finally {
      db.close();
    }
  });

  it('S25 failed migration rolls back table, trigger and migration record', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const failing010: Migration = {
        id: '010',
        name: 'idempotency-records',
        checksum: 'f'.repeat(16),
        apply(ctx) {
          for (const stmt of M26_010_DDL_STATEMENTS) {
            ctx.db.exec(stmt);
          }
          throw new Error('forced failure');
        },
      };
      assert.throws(() => runMigrations(db, [...REGISTRY_FIRST_NINE, failing010]));
      assert.ok(!tableNames(db).includes('idempotency_records'));
      const triggers = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='trigger' AND name='idempotency_records_reject_update'",
      ).all();
      assert.equal(triggers.length, 0);
      const record = db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id = '010'").all();
      assert.equal(record.length, 0);
    } finally {
      db.close();
    }
  });

  it('S26 registry order is exactly 001-010', () => {
    const ids = DEFAULT_REGISTRY_MIGRATIONS.map((m) => m.id);
    assert.deepEqual(ids, ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010']);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('S27 PRAGMA foreign_key_check passes after full migration', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws-1');
      insertRecord(db);
      const fk = db.prepare('PRAGMA foreign_key_check').all();
      assert.deepEqual(fk, []);
    } finally {
      db.close();
    }
  });

  it('S28 PRAGMA integrity_check passes after full migration', () => {
    const db = migratedDb();
    try {
      const integrity = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
      assert.deepEqual(integrity.map((r) => r.integrity_check), ['ok']);
    } finally {
      db.close();
    }
  });
});
