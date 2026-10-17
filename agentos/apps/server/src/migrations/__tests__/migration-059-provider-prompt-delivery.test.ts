import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { MigrationRegistry } from '../registry.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & { close(): void };
};

const NOW = '2026-10-12T00:00:00.000Z';

function runMigrations(db: MinimalDatabaseSync, lastId: string): void {
  new MigrationRunner(
    db,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id <= lastId)),
  ).run();
}

function insertLegacyProvider(db: MinimalDatabaseSync): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws_059', 'Workspace 059', '/workspace-059', '/workspace-059', ?, ?, ?)
  `).run(NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO provider_configurations (
      id, workspace_id, name, provider_type, adapter_id, runtime_mode,
      capabilities_json, timeout_policy_json, created_at, updated_at
    ) VALUES ('provider_059', 'ws_059', 'Legacy provider', 'custom-cli', 'builtin.custom-cli', 'cli', '{}', '{}', ?, ?)
  `).run(NOW, NOW);
}

test('migration 059 adds nullable, constrained prompt delivery and preserves existing provider rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, '058');
    insertLegacyProvider(db);

    runMigrations(db, '059');
    const column = (db.prepare('PRAGMA table_info(provider_configurations)').all() as Array<{
      cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }>).find(entry => entry.name === 'prompt_delivery');
    assert.ok(column);
    assert.equal(column.cid, 22);
    assert.equal(column.type, 'TEXT');
    assert.equal(column.notnull, 0);
    assert.equal(column.dflt_value, null);
    assert.equal(column.pk, 0);
    assert.equal((db.prepare('SELECT prompt_delivery FROM provider_configurations WHERE id = ?').get('provider_059') as { prompt_delivery: string | null }).prompt_delivery, null);

    for (const mode of ['argument', 'stdin', 'file']) {
      db.prepare('UPDATE provider_configurations SET prompt_delivery = ? WHERE id = ?').run(mode, 'provider_059');
      assert.equal((db.prepare('SELECT prompt_delivery FROM provider_configurations WHERE id = ?').get('provider_059') as { prompt_delivery: string }).prompt_delivery, mode);
    }
    assert.throws(
      () => db.prepare('UPDATE provider_configurations SET prompt_delivery = ? WHERE id = ?').run('socket', 'provider_059'),
      /CHECK/,
    );
    assert.equal((db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id = '059'").get() as { migration_id: string } | undefined)?.migration_id, '059');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('migration 059 applies once across upgrade and fresh installs', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, '058');
    insertLegacyProvider(db);
    runMigrations(db, '059');
    const first = db.prepare('PRAGMA table_info(provider_configurations)').all();
    runMigrations(db, '059');
    assert.deepEqual(db.prepare('PRAGMA table_info(provider_configurations)').all(), first);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '059'").get() as { count: number }).count, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }

  const fresh = new DatabaseSync(':memory:');
  try {
    fresh.exec('PRAGMA foreign_keys = ON');
    runMigrations(fresh, '059');
    assert.ok((fresh.prepare('PRAGMA table_info(provider_configurations)').all() as Array<{ name: string }>).some(column => column.name === 'prompt_delivery'));
    assert.equal((fresh.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id = '059'").get() as { migration_id: string }).migration_id, '059');
  } finally {
    fresh.close();
  }
});
