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

function insertLegacyProvider(db: MinimalDatabaseSync): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('ws_062', 'Workspace 062', '/workspace-062', '/workspace-062', ?, ?, ?)
  `).run(NOW, NOW, NOW);
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
    VALUES ('task_062', 'ws_062', 'Task 062', 'open', 'normal', 'test', ?, ?)
  `).run(NOW, NOW);
  db.prepare(`
    INSERT INTO provider_configurations (
      id, workspace_id, name, provider_type, adapter_id, runtime_mode,
      capabilities_json, timeout_policy_json, created_at, updated_at
    ) VALUES ('provider_062', 'ws_062', 'Legacy provider', 'custom-cli', 'builtin.custom-cli', 'cli', '{}', '{}', ?, ?)
  `).run(NOW, NOW);
}

function fallbackPolicyJson(): string {
  return JSON.stringify({
    enabled: true,
    fallbackProviderConfigIds: ['provider_062_fallback'],
    triggerErrorCodes: ['PROVIDER_RATE_LIMITED'],
    maxFallbacks: 2,
    requireUserApproval: true,
  });
}

test('migration 062 adds nullable fallback policy JSON, preserves provider rows, and creates the append-only chain table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, '059');
    insertLegacyProvider(db);

    runMigrations(db, '062');

    const column = (db.prepare('PRAGMA table_info(provider_configurations)').all() as Array<{
      name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
    }>).find(entry => entry.name === 'fallback_policy_json');
    assert.ok(column);
    assert.equal(column.type, 'TEXT');
    assert.equal(column.notnull, 0);
    assert.equal(column.dflt_value, null);
    assert.equal(column.pk, 0);

    // Legacy rows survive with a NULL policy.
    assert.equal(
      (db.prepare('SELECT fallback_policy_json FROM provider_configurations WHERE id = ?').get('provider_062') as { fallback_policy_json: string | null }).fallback_policy_json,
      null,
    );

    db.prepare('UPDATE provider_configurations SET fallback_policy_json = ? WHERE id = ?')
      .run(fallbackPolicyJson(), 'provider_062');
    const stored = JSON.parse(
      (db.prepare('SELECT fallback_policy_json FROM provider_configurations WHERE id = ?').get('provider_062') as { fallback_policy_json: string }).fallback_policy_json,
    ) as Record<string, unknown>;
    assert.equal(stored['enabled'], true);
    assert.equal(stored['maxFallbacks'], 2);
    assert.equal(stored['requireUserApproval'], true);

    const chainColumns = (db.prepare('PRAGMA table_info(run_provider_fallback_chain)').all() as Array<{ name: string }>).map(column => column.name);
    for (const expected of ['run_snapshot_id', 'stage_id', 'from_provider_config_id', 'to_provider_config_id', 'trigger_error_code', 'approval_request_id', 'sequence']) {
      assert.ok(chainColumns.includes(expected), 'run_provider_fallback_chain missing column ' + expected);
    }
    db.prepare(`
      INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, next_event_sequence, created_by, created_at, updated_at)
      VALUES ('run_062', 'ws_062', 'task_062', 'run_062', 'running', 'initial', 'v2_api', 1, 'test', ?, ?)
    `).run(NOW, NOW);
    db.prepare(`
      INSERT INTO run_provider_fallback_chain (
        id, workspace_id, run_id, run_snapshot_id, stage_id, stage_attempt,
        from_provider_config_id, to_provider_config_id, trigger_error_code,
        attempt, switched_at, approval_request_id, sequence, created_at
      ) VALUES ('pf_062', 'ws_062', 'run_062', 'snapshot_062', 'stage_062', 1,
        'provider_062', 'provider_062_fallback', 'PROVIDER_RATE_LIMITED', 1, ?, NULL, 1, ?)
    `).run(NOW, NOW);
    assert.throws(
      () => db.exec("UPDATE run_provider_fallback_chain SET sequence = 2 WHERE id = 'pf_062'"),
      /RUN_PROVIDER_FALLBACK_CHAIN_APPEND_ONLY/,
    );
    assert.equal(
      (db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id = '062'").get() as { migration_id: string } | undefined)?.migration_id,
      '062',
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('migration 062 applies once across upgrade and fresh installs', () => {
  const upgraded = new DatabaseSync(':memory:');
  try {
    upgraded.exec('PRAGMA foreign_keys = ON');
    runMigrations(upgraded, '059');
    insertLegacyProvider(upgraded);
    runMigrations(upgraded, '062');
    const first = upgraded.prepare('PRAGMA table_info(provider_configurations)').all();
    runMigrations(upgraded, '062');
    assert.deepEqual(upgraded.prepare('PRAGMA table_info(provider_configurations)').all(), first);
    assert.equal(
      (upgraded.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '062'").get() as { count: number }).count,
      1,
    );
    assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    upgraded.close();
  }

  const fresh = new DatabaseSync(':memory:');
  try {
    fresh.exec('PRAGMA foreign_keys = ON');
    runMigrations(fresh, '062');
    assert.ok((fresh.prepare('PRAGMA table_info(provider_configurations)').all() as Array<{ name: string }>).some(column => column.name === 'fallback_policy_json'));
    assert.ok((fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_provider_fallback_chain'").get()) !== undefined);
    assert.equal(
      (fresh.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id DESC LIMIT 1').get() as { migration_id: string }).migration_id,
      '062',
    );
  } finally {
    fresh.close();
  }
});
