import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { baselineMigration } from '../../migrations/migrations/001-baseline-schema.js';
import { migration002 } from '../../migrations/migrations/002-add-aggregate-versions.js';
import { migration003 } from '../../migrations/migrations/003-workspace-provider-config.js';
import { migration004 } from '../../migrations/migrations/004-workspace-tombstones.js';
import { migration011 } from '../../migrations/migrations/011-legacy-data-migration-foundation.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;
const NOW = '2026-07-30T00:00:00.000Z';

function createDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003, migration004]) migration.apply({ db });
  migration011.apply({ db });
  return db;
}

test('[M27-P2-T002] SQLite-only Workspace is preserved and never receives a synthetic source Attempt', async () => {
  const db = createDb();
  try {
    db.prepare(`
      INSERT INTO workspaces (id, name, root_path, canonical_root_path, git_enabled, memory_enabled, last_opened_at, created_at, updated_at)
      VALUES ('sqlite-only', 'SQLite Only', 'C:\\sqlite-only', 'c:\\sqlite-only', 1, 1, ?, ?, ?)
    `).run(NOW, NOW, NOW);
    const { WorkspaceCompatibilityRepository } = await import('../WorkspaceCompatibilityRepository.js') as {
      WorkspaceCompatibilityRepository: new (db: Db) => { findWorkspaceById(id: string): unknown; findTombstone(id: string): unknown; findWorkspaceByCanonicalPath(path: string): unknown };
    };
    const repo = new WorkspaceCompatibilityRepository(db);
    assert.ok(repo.findWorkspaceById('sqlite-only'));
    assert.equal(repo.findTombstone('sqlite-only'), null);
    assert.ok(repo.findWorkspaceByCanonicalPath('c:\\sqlite-only'));
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM legacy_data_migrations').get() as { count: number }).count, 0);
  } finally {
    db.close();
  }
});
