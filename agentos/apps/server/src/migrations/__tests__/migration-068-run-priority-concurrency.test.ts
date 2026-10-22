import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRunner } from '../MigrationRunner.js';
import { MigrationRegistry } from '../registry.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration068, RUN_PRIORITY_CONCURRENCY_068_DDL_STATEMENTS } from '../migrations/068-run-priority-concurrency.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};
type Db = InstanceType<typeof DatabaseSync>;

const PRE_068 = DEFAULT_REGISTRY_MIGRATIONS.filter(migration => migration.id < '068');

function tempDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentos-migration-068-'));
  const db = new DatabaseSync(join(dir, 'test.db'));
  return { db, dir };
}

function cleanup(ctx: { db: Db; dir: string }): void {
  try { ctx.db.close(); } catch { /* ignore */ }
  try { rmSync(ctx.dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function hasColumn(db: Db, column: string): boolean {
  return db.prepare("SELECT 1 AS present FROM pragma_table_info('runs') WHERE name = ?").get(column) !== undefined;
}

function hasScheduleIndex(db: Db): boolean {
  return db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'idx_runs_schedule_order'").get() !== undefined;
}

describe('migration 068 run-priority-concurrency', () => {
  it('has a stable id, name, checksum and is registered last', () => {
    assert.equal(migration068.id, '068');
    assert.equal(migration068.name, 'run-priority-concurrency');
    assert.match(migration068.checksum, /^[0-9a-f]{16}$/);
    assert.equal(migration068.destructive, false);
    assert.equal(DEFAULT_REGISTRY_MIGRATIONS.at(-1)?.id, '068');
  });

  it('fresh install applies the registry including 068', () => {
    const ctx = tempDb();
    try {
      new MigrationRunner(ctx.db as never, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
      assert.equal(hasColumn(ctx.db, 'priority'), true);
      assert.equal(hasScheduleIndex(ctx.db), true);
      assert.equal((ctx.db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id = '068'").get() as { migration_id: string }).migration_id, '068');
      assert.equal((ctx.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    } finally { cleanup(ctx); }
  });

  it('upgrade from the pre-068 registry adds the column with default 0 and backfills existing rows', () => {
    const ctx = tempDb();
    try {
      new MigrationRunner(ctx.db as never, new MigrationRegistry(PRE_068)).run();
      assert.equal(hasColumn(ctx.db, 'priority'), false);
      // Seed a pre-upgrade Run row the way an older server would have written it.
      ctx.db.prepare("INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)"
        + " VALUES ('ws_1', 'ws', '/a', '/a', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')").run();
      ctx.db.prepare("INSERT INTO tasks (id, workspace_id, title, created_by, created_at, updated_at)"
        + " VALUES ('task_1', 'ws_1', 't', 'x', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')").run();
      ctx.db.prepare("INSERT INTO runs (id, workspace_id, task_id, root_run_id, created_by, created_at, updated_at)"
        + " VALUES ('run_1', 'ws_1', 'task_1', 'run_1', 'x', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')").run();

      new MigrationRunner(ctx.db as never, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
      assert.equal(hasColumn(ctx.db, 'priority'), true);
      assert.equal(hasScheduleIndex(ctx.db), true);
      const row = ctx.db.prepare("SELECT priority FROM runs WHERE id = 'run_1'").get() as { priority: number };
      assert.equal(row.priority, 0);
    } finally { cleanup(ctx); }
  });

  it('DDL is frozen: upgrade applies exactly the exported statements', () => {
    assert.deepEqual([...RUN_PRIORITY_CONCURRENCY_068_DDL_STATEMENTS], [
      'ALTER TABLE runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0',
      'CREATE INDEX idx_runs_schedule_order\n    ON runs(status, priority DESC, created_at ASC, id ASC)',
    ]);
  });
});
