import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration027, migration027Checksum, MF2_ARTIFACT_027_DDL_STATEMENTS } from '../migrations/027-mf2-review-test-artifact.js';
import type { MinimalDatabaseSync } from '../types.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

test('LITE-07-104/108: fresh and through026 upgrade apply identical additive 027 without rewriting old objects', () => {
  const upgrade = new DatabaseSync(':memory:');
  const fresh = new DatabaseSync(':memory:');
  try {
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(m => m.id < '027')) migration.apply({ db: upgrade });
    const before = upgrade.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all() as { type: string; name: string; sql: string }[];
    migration027.apply({ db: upgrade });
    for (const original of before) {
      assert.deepEqual(upgrade.prepare('SELECT type,name,sql FROM sqlite_master WHERE name = ?').get(original.name), original);
    }
    // Compare at the 027 boundary; later additive migrations are outside this
    // historical upgrade proof.
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(m => m.id <= '027')) migration.apply({ db: fresh });
    assert.deepEqual(upgrade.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), fresh.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all());
    assert.equal(migration027Checksum, createHash('sha256').update(MF2_ARTIFACT_027_DDL_STATEMENTS.join('\n')).digest('hex').slice(0, 16));
    const fks = upgrade.prepare("PRAGMA foreign_key_list('artifact_completions')").all() as { table: string }[];
    for (const name of ['workspaces', 'runtime_artifacts', 'runs', 'memory_candidate_entries']) assert.ok(fks.some(fk => fk.table === name));
    assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { upgrade.close(); fresh.close(); }
});

test('LITE-07-104: 027 refuses missing prerequisite and defines unique, typed, immutable completion', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration027.apply({ db }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'artifact_completions'").get(), undefined);
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db });
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'artifact_completions'").get() as { sql: string }).sql;
    assert.match(ddl, /artifact_id TEXT NOT NULL UNIQUE/);
    assert.match(ddl, /UNIQUE \(workspace_id, source_key\)/);
    assert.match(ddl, /artifact_type = 'review' AND conclusion IN \('approved','changes_requested'\)/);
    assert.match(ddl, /artifact_type = 'test' AND conclusion IN \('pass','fail'\)/);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'artifact_completions_validate_source'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'artifact_completions_reject_update'").get());
  } finally { db.close(); }
});
