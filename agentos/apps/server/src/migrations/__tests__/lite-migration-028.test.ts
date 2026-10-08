import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration028, migration028Checksum, LITE_APPROVAL_028_DDL_STATEMENTS } from '../migrations/028-lite-runtime-approval-requests.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

test('LITE-08-005/006/007: fresh and through027 upgrade apply identical additive 028', () => {
  const upgrade = new DatabaseSync(':memory:');
  const fresh = new DatabaseSync(':memory:');
  try {
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id < '028')) migration.apply({ db: upgrade });
    const before = upgrade.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name").all();
    migration028.apply({ db: upgrade });
    for (const original of before as Array<Record<string, unknown>>) {
      assert.deepEqual(upgrade.prepare('SELECT type,name,sql FROM sqlite_master WHERE name = ?').get(original.name), original);
    }
    // Compare at the 028 boundary; later additive migrations are outside this
    // historical upgrade proof.
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id <= '028')) migration.apply({ db: fresh });
    assert.deepEqual(upgrade.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(),
      fresh.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all());
    assert.equal(migration028Checksum, createHash('sha256')
      .update(LITE_APPROVAL_028_DDL_STATEMENTS.join('\n')).digest('hex').slice(0, 16));
    assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { upgrade.close(); fresh.close(); }
});

test('LITE-08-005: 028 refuses incomplete prerequisites and defines pending/immutable/one-shot constraints', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration028.apply({ db }), /MIGRATION_PREREQUISITE_MISSING/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_approval_requests'").get(), undefined);
    for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db });
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'runtime_approval_requests'").get() as { sql: string }).sql;
    assert.match(ddl, /UNIQUE \(workspace_id, source_key, request_round\)/);
    assert.match(ddl, /status IN \('pending','approved','rejected','cancelled','expired'\)/);
    assert.match(ddl, /expires_at > requested_at/);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_approval_requests_one_pending'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_approval_requests_identity_immutable'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_approval_requests_validate_decision'").get());
  } finally { db.close(); }
});
