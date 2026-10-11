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

const NOW = '2026-10-11T00:00:00.000Z';

function runMigrations(db: MinimalDatabaseSync, lastId: string): void {
  new MigrationRunner(
    db,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id <= lastId)),
  ).run();
}

type Row = Record<string, unknown>;

function tableColumns(db: MinimalDatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map(row => row.name as string);
}

test('migration 055 creates the policy core tables with the skeleton schema', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, '055');

    for (const table of ['policy_profiles', 'policy_rules', 'policy_decisions']) {
      assert.ok(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        `${table} must exist`,
      );
    }

    assert.deepEqual(tableColumns(db, 'policy_profiles'),
      ['id', 'workspace_id', 'name', 'is_default', 'rules_version', 'created_at', 'updated_at']);
    assert.deepEqual(tableColumns(db, 'policy_rules'),
      ['id', 'profile_id', 'action', 'selector_json', 'decision', 'priority', 'specificity', 'enabled', 'created_at']);
    assert.deepEqual(tableColumns(db, 'policy_decisions'),
      ['id', 'workspace_id', 'run_id', 'stage_id', 'action', 'fingerprint', 'decision',
        'matched_rule_ids_json', 'profile_id', 'evaluated_at']);

    const uniqueConstraints = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'policy_profiles'",
    ).get() as { sql: string };
    assert.match(uniqueConstraints.sql, /UNIQUE\(workspace_id, name\)/);

    // Decision CHECK constraints reject unknown values.
    db.prepare(
      "INSERT INTO policy_decisions (id, workspace_id, action, decision, matched_rule_ids_json, evaluated_at)"
        + " VALUES ('pdec_055a', 'ws_055', 'provider.launch', 'allow', '[]', ?)",
    ).run(NOW);
    assert.throws(
      () => db.prepare(
        "INSERT INTO policy_decisions (id, workspace_id, action, decision, matched_rule_ids_json, evaluated_at)"
          + " VALUES ('pdec_055b', 'ws_055', 'provider.launch', 'maybe', '[]', ?)",
      ).run(NOW),
    );
    assert.throws(
      () => db.prepare(
        "INSERT INTO policy_rules (id, profile_id, action, selector_json, decision, priority, created_at)"
          + " VALUES ('prule_055x', 'pprof_missing', 'provider.delete', '{}', 'allow', 0, ?)",
      ).run(NOW),
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '055'").get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('migration 055 is idempotent and fresh/upgrade paths agree', () => {
  const upgrade = new DatabaseSync(':memory:');
  try {
    upgrade.exec('PRAGMA foreign_keys = ON');
    runMigrations(upgrade, '054');
    runMigrations(upgrade, '055');
    const firstPass = {
      tables: (upgrade.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'policy_%' ORDER BY name",
      ).all() as Row[]).map(row => row.name),
      count: (upgrade.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '055'").get() as { count: number }).count,
    };
    runMigrations(upgrade, '055');
    assert.deepEqual({
      tables: (upgrade.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'policy_%' ORDER BY name",
      ).all() as Row[]).map(row => row.name),
      count: (upgrade.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '055'").get() as { count: number }).count,
    }, firstPass);
    assert.equal(firstPass.count, 1);
    assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    upgrade.close();
  }

  const fresh = new DatabaseSync(':memory:');
  try {
    fresh.exec('PRAGMA foreign_keys = ON');
    runMigrations(fresh, '055');
    const latest = fresh.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id DESC LIMIT 1').get() as { migration_id: string };
    assert.equal(latest.migration_id, '055');
    assert.deepEqual(fresh.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    fresh.close();
  }
});
