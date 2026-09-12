import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration030, migration030Checksum, S7_IMPORT_030_DDL_STATEMENTS } from '../migrations/030-s7-explicit-markdown-import.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

test('S7/030: fresh and through029 upgrade apply identical additive 030', () => {
  const upgrade = new DatabaseSync(':memory:');
  const fresh = new DatabaseSync(':memory:');
  try {
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id < '030')) migration.apply({ db: upgrade });
    const before = upgrade.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    migration030.apply({ db: upgrade });
    for (const original of before as Array<Record<string, unknown>>) {
      assert.deepEqual(upgrade.prepare('SELECT type,name,sql FROM sqlite_master WHERE name = ?').get(original.name), original);
    }
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db: fresh });
    assert.deepEqual(upgrade.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),
      fresh.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all());
    assert.equal(migration030Checksum, createHash('sha256')
      .update(S7_IMPORT_030_DDL_STATEMENTS.join('\n')).digest('hex').slice(0, 16));
    assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { upgrade.close(); fresh.close(); }
});

test('S7/030: refuses incomplete prerequisites and defines the idempotency tuple plus immutability', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration030.apply({ db }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_import_records'").get(), undefined);
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db });
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'memory_import_records'").get() as { sql: string }).sql;
    assert.match(ddl, /UNIQUE \(workspace_id, source_hash, fragment_index, parser_version\)/);
    assert.match(ddl, /candidate_id TEXT NOT NULL UNIQUE/);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_import_records_immutable'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_import_records_workspace_source'").get());
  } finally { db.close(); }
});

