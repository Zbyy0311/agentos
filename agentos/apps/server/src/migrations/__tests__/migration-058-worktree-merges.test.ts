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

function insertMerge(db: MinimalDatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'wtmg_058a', worktree_id: 'wt_058', strategy: 'squash',
    source_branch: 'agentos/run-x', target_branch: 'main',
    base_commit: 'abc123', head_commit: 'def456', expected_head_commit: 'abc123',
    previous_target_commit: 'abc123', resulting_target_commit: null, merge_commit: null,
    result: 'merged', conflict_summary_json: null, requested_by: 'tester',
    created_at: NOW, completed_at: NOW, ...overrides,
  };
  db.prepare(`
    INSERT INTO worktree_merges (
      id, worktree_id, strategy, source_branch, target_branch, base_commit,
      head_commit, expected_head_commit, previous_target_commit, resulting_target_commit,
      merge_commit, result, conflict_summary_json, requested_by, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.worktree_id, row.strategy, row.source_branch, row.target_branch, row.base_commit,
    row.head_commit, row.expected_head_commit, row.previous_target_commit, row.resulting_target_commit,
    row.merge_commit, row.result, row.conflict_summary_json, row.requested_by, row.created_at, row.completed_at,
  );
}

test('migration 058 creates the worktree_merges table with merge audit schema', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, '058');

    const table = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worktree_merges'",
    ).get() as { sql: string } | undefined;
    assert.ok(table, 'worktree_merges table must exist');
    for (const column of ['id', 'worktree_id', 'strategy', 'source_branch', 'target_branch', 'base_commit',
      'head_commit', 'expected_head_commit', 'previous_target_commit', 'resulting_target_commit',
      'merge_commit', 'result', 'conflict_summary_json', 'requested_by', 'created_at', 'completed_at']) {
      assert.match(table.sql, new RegExp(`\\b${column}\\b`), `column ${column} must exist`);
    }
    assert.match(table.sql, /CHECK\(strategy IN \('squash','merge-commit','ff'\)\)/);
    assert.match(table.sql, /CHECK\(result IN \('merged','conflicted','aborted','failed'\)\)/);

    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_worktree_merges_worktree'").get(),
      'idx_worktree_merges_worktree must exist',
    );

    insertMerge(db);
    assert.throws(() => insertMerge(db, { id: 'wtmg_058b', strategy: 'rebase' }), /CHECK/);
    assert.throws(() => insertMerge(db, { id: 'wtmg_058c', result: 'unknown' }), /CHECK/);
    assert.throws(() => insertMerge(db, { id: 'wtmg_058d', conflict_summary_json: '{not json' }), /CHECK/);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '058'").get() as { count: number }).count, 1);
  } finally {
    db.close();
  }
});

test('migration 058 is idempotent and fresh/upgrade paths agree', () => {
  const upgrade = new DatabaseSync(':memory:');
  try {
    upgrade.exec('PRAGMA foreign_keys = ON');
    runMigrations(upgrade, '056');
    runMigrations(upgrade, '058');
    const firstPass = {
      columns: (upgrade.prepare('PRAGMA table_info(worktree_merges)').all() as Array<{ name: string }>).map(row => row.name),
      count: (upgrade.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '058'").get() as { count: number }).count,
    };
    runMigrations(upgrade, '058');
    assert.deepEqual({
      columns: (upgrade.prepare('PRAGMA table_info(worktree_merges)').all() as Array<{ name: string }>).map(row => row.name),
      count: (upgrade.prepare("SELECT COUNT(*) AS count FROM _schema_migrations WHERE migration_id = '058'").get() as { count: number }).count,
    }, firstPass);
    assert.equal(firstPass.count, 1);
    assert.deepEqual(upgrade.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    upgrade.close();
  }

  const fresh = new DatabaseSync(':memory:');
  try {
    fresh.exec('PRAGMA foreign_keys = ON');
    runMigrations(fresh, '058');
    const latest = fresh.prepare('SELECT migration_id FROM _schema_migrations ORDER BY migration_id DESC LIMIT 1').get() as { migration_id: string };
    assert.equal(latest.migration_id, '058');
    insertMerge(fresh);
    assert.equal((fresh.prepare('SELECT COUNT(*) AS count FROM worktree_merges').get() as { count: number }).count, 1);
    assert.deepEqual(fresh.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    fresh.close();
  }
});
