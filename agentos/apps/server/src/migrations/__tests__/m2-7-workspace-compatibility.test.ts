import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { baselineMigration } from '../migrations/001-baseline-schema.js';
import { migration002 } from '../migrations/002-add-aggregate-versions.js';
import { migration003 } from '../migrations/003-workspace-provider-config.js';
import { migration004 } from '../migrations/004-workspace-tombstones.js';
import { migration011 } from '../migrations/011-legacy-data-migration-foundation.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;
const NOW = '2026-07-30T00:00:00.000Z';

function workspace(id: string, rootPath: string, name = `Workspace ${id}`): Record<string, unknown> {
  return { id, name, rootPath, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW };
}

function createFixture(): { root: string; databasePath: string; db: Db; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'agentos-m27-p2-compat-'));
  mkdirSync(join(root, '.agentos'), { recursive: true });
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const databasePath = join(root, '.agentos', 'agentos.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of [baselineMigration, migration002, migration003, migration004]) migration.apply({ db });
  migration011.apply({ db });
  return { root, databasePath, db, cleanup() { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); } };
}

async function run(fx: { root: string; databasePath: string }, source: unknown[], workspaceId?: string): Promise<any> {
  const { WorkspaceCompatibilityMigrationService } = await import('../../services/WorkspaceCompatibilityMigrationService.js') as { WorkspaceCompatibilityMigrationService: new (options?: Record<string, unknown>) => any };
  return new WorkspaceCompatibilityMigrationService({
    leaseFactory: async () => ({ release: async () => {} }),
    databaseFactory: () => new DatabaseSync(fx.databasePath),
    migrationIdFactory: (() => { let n = 0; return () => `compat-${++n}`; })(),
    clock: () => NOW,
    backupProvider: { createAndVerify: async () => ({ sqliteBackupFileName: 'b.sqlite', jsonBackupFileName: 'b.json', sqliteBackupHash: '0'.repeat(64), jsonBackupHash: '1'.repeat(64) }) },
  }).run({
    projectRoot: fx.root,
    sourceRoot: fx.root,
    databasePath: fx.databasePath,
    backupDirectory: join(fx.root, 'backups'),
    kind: 'workspace',
    mode: 'apply',
    ...(workspaceId ? { workspaceId } : {}),
  }, source);
}

test('[M27-P2-T011] Batch Workspace scopes isolate completion, quarantine, and resume without a global completed marker', async () => {
  const fx = createFixture();
  try {
    const source = [workspace('batch-a', join(fx.root, 'batch-a')), workspace('batch-b', join(fx.root, 'batch-b'), 'Batch B')];
    writeFileSync(join(fx.root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: source }), 'utf8');
    fx.db.prepare(`
      INSERT INTO workspaces (id, name, root_path, canonical_root_path, git_enabled, memory_enabled, last_opened_at, created_at, updated_at)
      VALUES ('batch-b', 'Existing B', ?, ?, 1, 1, ?, ?, ?)
    `).run(join(fx.root, 'batch-b'), join(fx.root, 'batch-b').toLowerCase(), NOW, NOW, NOW);
    const first = await run(fx, source);
    assert.equal(first.completedCount, 1);
    assert.equal(first.quarantinedCount, 1);
    assert.equal((fx.db.prepare("SELECT canonical_workspace_id FROM legacy_data_migrations WHERE scope_key = 'batch-a'").get() as { canonical_workspace_id: string | null }).canonical_workspace_id, null);
    assert.equal((fx.db.prepare("SELECT COUNT(*) AS count FROM legacy_data_migrations WHERE scope_kind = 'global' AND status = 'completed'").get() as { count: number }).count, 0);
    const second = await run(fx, source, 'batch-a');
    assert.equal(second.noopCount, 1);
    assert.equal((fx.db.prepare("SELECT COUNT(*) AS count FROM legacy_data_migrations WHERE scope_key = 'batch-a' AND status = 'completed'").get() as { count: number }).count, 1);
    assert.equal((fx.db.prepare("SELECT COUNT(*) AS count FROM legacy_data_migrations WHERE scope_key = 'batch-b'").get() as { count: number }).count, 1);
  } finally {
    fx.cleanup();
  }
});
