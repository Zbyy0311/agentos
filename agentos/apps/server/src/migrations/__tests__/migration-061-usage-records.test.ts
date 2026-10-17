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

const NOW = '2026-10-17T00:00:00.000Z';

function runMigrations(db: MinimalDatabaseSync, lastId: string): void {
  new MigrationRunner(
    db,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id <= lastId)),
  ).run();
}

function insertWorkspace(db: MinimalDatabaseSync): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws_061', 'Workspace 061', '/workspace-061', '/workspace-061', ?, ?, ?)
  `).run(NOW, NOW, NOW);
}

function usageRecordColumns(db: MinimalDatabaseSync): Array<{ name: string }> {
  return db.prepare('PRAGMA table_info(usage_records)').all() as Array<{ name: string }>;
}

test('migration 061 creates usage_records with metric-only columns, unique source_event_id and indexes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, '061');
    insertWorkspace(db);

    const columns = usageRecordColumns(db).map(column => column.name);
    for (const expected of [
      'id', 'workspace_id', 'run_id', 'stage_id', 'process_id', 'provider_config_id',
      'source', 'provider', 'model', 'input_tokens', 'cached_input_tokens',
      'output_tokens', 'total_tokens', 'duration_ms', 'estimated',
      'recorded_at', 'source_event_id', 'created_at',
    ]) {
      assert.ok(columns.includes(expected), `missing column ${expected}`);
    }
    // Prompt content has no column to live in.
    assert.ok(!columns.some(name => /prompt|stdout|content|payload/i.test(name)));

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_records'").all() as Array<{ name: string }>;
    const indexNames = indexes.map(index => index.name);
    assert.ok(indexNames.includes('idx_usage_records_workspace_recorded'));
    assert.ok(indexNames.includes('idx_usage_records_workspace_run'));
    assert.ok(indexNames.includes('idx_usage_records_workspace_provider'));
    assert.ok(indexNames.some(name => name.startsWith('sqlite_autoindex')));

    db.prepare(`
      INSERT INTO usage_records (
        id, workspace_id, run_id, provider, model, input_tokens, output_tokens,
        total_tokens, duration_ms, estimated, recorded_at, source_event_id, created_at
      ) VALUES ('urec_061A', 'ws_061', 'run_1', 'kimi', 'k2', 10, 5, 15, 1200, 0, ?, 'evt_src_1', ?)
    `).run(NOW, NOW);

    // UNIQUE(source_event_id): replay is rejected.
    assert.throws(
      () => db.prepare(`
        INSERT INTO usage_records (id, workspace_id, recorded_at, source_event_id, created_at)
        VALUES ('urec_061B', 'ws_061', ?, 'evt_src_1', ?)
      `).run(NOW, NOW),
      /UNIQUE/,
    );

    // Metric CHECK constraints reject negatives.
    assert.throws(
      () => db.prepare(`
        INSERT INTO usage_records (id, workspace_id, input_tokens, recorded_at, source_event_id, created_at)
        VALUES ('urec_061C', 'ws_061', -1, ?, 'evt_src_2', ?)
      `).run(NOW, NOW),
      /CHECK/,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO usage_records (id, workspace_id, estimated, recorded_at, source_event_id, created_at)
        VALUES ('urec_061D', 'ws_061', 2, ?, 'evt_src_3', ?)
      `).run(NOW, NOW),
      /CHECK/,
    );

    // Workspace cascade: deleting the Workspace removes its Usage Records.
    db.prepare("DELETE FROM workspaces WHERE id = 'ws_061'").run();
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM usage_records').get() as { count: number }).count, 0);

    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '061'").get() as { count: number }).count, 1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('migration 061 applies once across upgrade and fresh installs', () => {
  const upgraded = new DatabaseSync(':memory:');
  try {
    upgraded.exec('PRAGMA foreign_keys = ON');
    runMigrations(upgraded, '059');
    runMigrations(upgraded, '061');
    const first = usageRecordColumns(upgraded);
    runMigrations(upgraded, '061');
    assert.deepEqual(usageRecordColumns(upgraded), first);
    assert.equal((upgraded.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '061'").get() as { count: number }).count, 1);
    assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    upgraded.close();
  }

  const fresh = new DatabaseSync(':memory:');
  try {
    fresh.exec('PRAGMA foreign_keys = ON');
    runMigrations(fresh, '061');
    assert.ok(usageRecordColumns(fresh).length > 0);
    assert.equal(
      (fresh.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id DESC LIMIT 1').get() as { migration_id: string }).migration_id,
      '061',
    );
    assert.deepEqual(fresh.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    fresh.close();
  }
});
