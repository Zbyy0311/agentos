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

function insertLease(db: MinimalDatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'wt_056a', workspace_id: 'ws_056', run_id: 'run_056', execution_id: 'exec_056',
    agent_id: 'agent_056', branch_name: 'agentos/run-056', path_label: 'worktree/ws_056/run_056/exec_056',
    absolute_path: '/wt/ws_056/run_056/exec_056', workspace_root: '/ws/ws_056',
    base_commit: 'abc123', status: 'active', recovery_bundle_json: null,
    created_at: NOW, updated_at: NOW, ...overrides,
  };
  db.prepare(`
    INSERT INTO worktrees (
      id, workspace_id, run_id, execution_id, agent_id, branch_name, path_label,
      absolute_path, workspace_root, base_commit, status, recovery_bundle_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.workspace_id, row.run_id, row.execution_id, row.agent_id, row.branch_name,
    row.path_label, row.absolute_path, row.workspace_root, row.base_commit, row.status,
    row.recovery_bundle_json, row.created_at, row.updated_at,
  );
}

test('migration 056 creates the worktrees table with lease schema', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, '056');

    const table = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worktrees'",
    ).get() as { sql: string } | undefined;
    assert.ok(table, 'worktrees table must exist');
    for (const column of ['id', 'workspace_id', 'run_id', 'execution_id', 'agent_id', 'branch_name',
      'path_label', 'absolute_path', 'workspace_root', 'base_commit', 'status',
      'recovery_bundle_json', 'created_at', 'updated_at']) {
      assert.match(table.sql, new RegExp(`\\b${column}\\b`), `column ${column} must exist`);
    }
    assert.match(table.sql, /UNIQUE\(workspace_id, branch_name\)/);
    assert.match(table.sql, /UNIQUE\(workspace_id, absolute_path\)/);
    assert.match(table.sql, /CHECK\(status IN \('creating','active','completed','cleanup_pending','cleaned','failed'\)\)/);

    for (const index of ['idx_worktrees_run', 'idx_worktrees_status']) {
      assert.ok(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index),
        `${index} must exist`,
      );
    }

    insertLease(db);
    assert.throws(() => insertLease(db, { id: 'wt_056b' }), /UNIQUE/, 'duplicate (workspace_id, branch_name) rejected');
    assert.throws(() => insertLease(db, { id: 'wt_056c', branch_name: 'agentos/other' }), /UNIQUE/, 'duplicate (workspace_id, absolute_path) rejected');
    assert.throws(() => insertLease(db, { id: 'wt_056d', branch_name: 'agentos/other', absolute_path: '/other', status: 'unknown' }), /CHECK/);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '056'").get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('migration 056 is idempotent and fresh/upgrade paths agree', () => {
  const upgrade = new DatabaseSync(':memory:');
  try {
    upgrade.exec('PRAGMA foreign_keys = ON');
    runMigrations(upgrade, '055');
    runMigrations(upgrade, '056');
    const firstPass = {
      columns: (upgrade.prepare('PRAGMA table_info(worktrees)').all() as Array<{ name: string }>).map(row => row.name),
      count: (upgrade.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '056'").get() as { count: number }).count,
    };
    runMigrations(upgrade, '056');
    assert.deepEqual({
      columns: (upgrade.prepare('PRAGMA table_info(worktrees)').all() as Array<{ name: string }>).map(row => row.name),
      count: (upgrade.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '056'").get() as { count: number }).count,
    }, firstPass);
    assert.equal(firstPass.count, 1);
    assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    upgrade.close();
  }

  const fresh = new DatabaseSync(':memory:');
  try {
    fresh.exec('PRAGMA foreign_keys = ON');
    runMigrations(fresh, '056');
    const latest = fresh.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id DESC LIMIT 1').get() as { migration_id: string };
    assert.equal(latest.migration_id, '056');
    insertLease(fresh);
    assert.equal((fresh.prepare('SELECT COUNT(*) AS count FROM worktrees').get() as { count: number }).count, 1);
    assert.deepEqual(fresh.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    fresh.close();
  }
});
