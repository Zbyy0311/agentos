import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration029, migration029Checksum, S6_COMPACTION_029_DDL_STATEMENTS } from '../migrations/029-s6-conversation-compaction.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

test('S6/029: fresh and through028 upgrade apply identical additive 029', () => {
  const upgrade = new DatabaseSync(':memory:');
  const fresh = new DatabaseSync(':memory:');
  try {
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id < '029')) migration.apply({ db: upgrade });
    const before = upgrade.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    migration029.apply({ db: upgrade });
    for (const original of before as Array<Record<string, unknown>>) {
      assert.deepEqual(upgrade.prepare('SELECT type,name,sql FROM sqlite_master WHERE name = ?').get(original.name), original);
    }
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db: fresh });
    assert.deepEqual(upgrade.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),
      fresh.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all());
    assert.equal(migration029Checksum, createHash('sha256')
      .update(S6_COMPACTION_029_DDL_STATEMENTS.join('\n')).digest('hex').slice(0, 16));
    assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { upgrade.close(); fresh.close(); }
});

test('S6/029: refuses incomplete prerequisites and defines immutable policy plus durable task constraints', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration029.apply({ db }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_compactions'").get(), undefined);
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db });
    const taskDdl = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'conversation_compactions'").get() as { sql: string }).sql;
    assert.match(taskDdl, /status IN \('pending','running','published','failed','retry-pending'\)/);
    assert.match(taskDdl, /status <> 'published' OR/);
    assert.match(taskDdl, /\(status = 'running'\) = \(lease_owner IS NOT NULL\)/);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_compaction_policies_immutable'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_compactions_identity_immutable'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_compactions_published_immutable'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'conversation_compactions_one_running'").get());
  } finally { db.close(); }
});

