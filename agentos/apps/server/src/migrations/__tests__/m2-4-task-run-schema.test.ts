import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

type Db = InstanceType<typeof DatabaseSync>;

import { MigrationRegistry } from '../registry.js';
import { MigrationRunner } from '../MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration005, migration005Checksum } from '../migrations/005-tasks-table.js';
import { migration006, migration006Checksum } from '../migrations/006-runs-table.js';
import type { Migration } from '../types.js';

const NOW = '2026-01-01T00:00:00.000Z';

function migratedDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  return db;
}

function insertWorkspace(db: Db, id: string): void {
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, `ws-${id}`, `/r/${id}`, `/r/${id}`, NOW, NOW, NOW);
}

function insertTask(
  db: Db,
  id: string,
  workspaceId: string,
  opts: { legacyTaskId?: string | null; status?: string; priority?: string } = {},
): void {
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, legacy_task_id, title, status, priority, created_by, created_at, updated_at)
    VALUES (?, ?, ?, 'task', ?, ?, 'tester', ?, ?)
  `).run(
    id,
    workspaceId,
    opts.legacyTaskId ?? null,
    opts.status ?? 'open',
    opts.priority ?? 'normal',
    NOW,
    NOW,
  );
}

function insertRun(
  db: Db,
  id: string,
  workspaceId: string,
  taskId: string,
  opts: {
    parentRunId?: string | null;
    rootRunId?: string;
    status?: string;
    reason?: string;
    origin?: string;
  } = {},
): void {
  db.prepare(`
    INSERT INTO runs (id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'tester', ?, ?)
  `).run(
    id,
    workspaceId,
    taskId,
    opts.parentRunId ?? null,
    opts.rootRunId ?? id,
    opts.status ?? 'queued',
    opts.reason ?? 'initial',
    opts.origin ?? 'v2_api',
    NOW,
    NOW,
  );
}

function tableInfo(db: Db, table: string): Array<{ name: string; notnull: number; dflt_value: unknown; pk: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: unknown; pk: number }>;
}

describe('M2.4 migration 005/006 schema', () => {
  it('T01 records 005/006 id, name and checksum in _schema_migrations', () => {
    const db = migratedDb();
    try {
      const rows = db.prepare(
        "SELECT migration_id, name, checksum FROM _schema_migrations WHERE migration_id IN ('005','006') ORDER BY migration_id",
      ).all() as Array<{ migration_id: string; name: string; checksum: string }>;
      assert.equal(rows.length, 2);
      assert.equal(rows[0].migration_id, '005');
      assert.equal(rows[0].name, 'tasks-table');
      assert.equal(rows[0].checksum, migration005Checksum);
      assert.equal(rows[1].migration_id, '006');
      assert.equal(rows[1].name, 'runs-table');
      assert.equal(rows[1].checksum, migration006Checksum);
    } finally {
      db.close();
    }
  });

  it('T02 second MigrationRunner run skips 005/006 without re-applying DDL', () => {
    const db = migratedDb();
    try {
      new MigrationRunner(db, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
      const rows = db.prepare(
        "SELECT COUNT(*) AS cnt FROM _schema_migrations WHERE migration_id IN ('005','006')",
      ).get() as { cnt: number };
      assert.equal(rows.cnt, 2);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','runs') ORDER BY name").all() as Array<{ name: string }>;
      assert.deepEqual(tables.map(t => t.name), ['runs', 'tasks']);
    } finally {
      db.close();
    }
  });

  it('T03 failed migration rolls back DDL and leaves no _schema_migrations record', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    try {
      const failing: Migration = {
        id: '005',
        name: 'tasks-table',
        checksum: 'failing005',
        apply(ctx) {
          ctx.db.exec('CREATE TABLE should_rollback_tasks (id INT)');
          throw new Error('simulated migration failure');
        },
      };
      assert.throws(() => new MigrationRunner(db, new MigrationRegistry([failing])).run());
      const stray = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_rollback_tasks'").all();
      assert.equal(stray.length, 0);
      const tasksTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").all();
      assert.equal(tasksTable.length, 0);
      const record = db.prepare("SELECT migration_id FROM _schema_migrations WHERE migration_id = '005'").all();
      assert.equal(record.length, 0);
    } finally {
      db.close();
    }
  });

  it('T04 tasks table columns, defaults, CHECK constraints and workspace FK are enforced', () => {
    const db = migratedDb();
    try {
      const cols = tableInfo(db, 'tasks');
      assert.deepEqual(cols.map(c => c.name), [
        'id', 'workspace_id', 'legacy_task_id', 'title', 'description', 'status', 'priority',
        'source_conversation_id', 'source_message_id', 'accepted_run_id', 'pending_result_run_id',
        'created_by', 'created_at', 'updated_at', 'completed_at', 'archived_at', 'version',
      ]);
      const byName = new Map(cols.map(c => [c.name, c]));
      assert.equal(byName.get('workspace_id')!.notnull, 1);
      assert.equal(byName.get('title')!.notnull, 1);
      assert.equal(byName.get('created_by')!.notnull, 1);
      assert.equal(byName.get('created_at')!.notnull, 1);
      assert.equal(byName.get('updated_at')!.notnull, 1);
      assert.equal(byName.get('status')!.dflt_value, "'open'");
      assert.equal(byName.get('priority')!.dflt_value, "'normal'");
      assert.equal(byName.get('version')!.dflt_value, '1');
      for (const nullable of ['legacy_task_id', 'description', 'source_conversation_id', 'source_message_id', 'accepted_run_id', 'pending_result_run_id', 'completed_at', 'archived_at']) {
        assert.equal(byName.get(nullable)!.notnull, 0, `${nullable} must be nullable`);
      }

      insertWorkspace(db, 'ws1');
      assert.throws(() => insertTask(db, 'task_a', 'ws_missing'), /FOREIGN KEY/i);
      assert.throws(() => insertTask(db, 'task_a', 'ws1', { status: 'draft' }));
      assert.throws(() => insertTask(db, 'task_a', 'ws1', { priority: 'urgent' }));
      insertTask(db, 'task_a', 'ws1');
      const row = db.prepare('SELECT status, priority, version FROM tasks WHERE id = ?').get('task_a') as { status: string; priority: string; version: number };
      assert.equal(row.status, 'open');
      assert.equal(row.priority, 'normal');
      assert.equal(row.version, 1);
    } finally {
      db.close();
    }
  });

  it('T05 runs table columns, defaults and CHECK constraints are enforced', () => {
    const db = migratedDb();
    try {
      const cols = tableInfo(db, 'runs');
      assert.deepEqual(cols.map(c => c.name), [
        'id', 'workspace_id', 'task_id', 'parent_run_id', 'root_run_id', 'status', 'reason', 'origin',
        'objective', 'failure_code', 'failure_message', 'cancellation_requested_at', 'next_event_sequence',
        'started_at', 'completed_at', 'created_by', 'created_at', 'updated_at', 'version', 'recovery_required',
      ]);
      const byName = new Map(cols.map(c => [c.name, c]));
      assert.equal(byName.get('workspace_id')!.notnull, 1);
      assert.equal(byName.get('task_id')!.notnull, 1);
      assert.equal(byName.get('root_run_id')!.notnull, 1);
      assert.equal(byName.get('parent_run_id')!.notnull, 0);
      assert.equal(byName.get('status')!.dflt_value, "'queued'");
      assert.equal(byName.get('reason')!.dflt_value, "'initial'");
      assert.equal(byName.get('origin')!.dflt_value, "'v2_api'");
      assert.equal(byName.get('next_event_sequence')!.dflt_value, '1');
      assert.equal(byName.get('version')!.dflt_value, '1');
      assert.equal(byName.get('recovery_required')!.dflt_value, '0');

      insertWorkspace(db, 'ws1');
      insertTask(db, 'task_a', 'ws1');
      assert.throws(() => insertRun(db, 'run_a', 'ws1', 'task_a', { status: 'created' }));
      assert.throws(() => insertRun(db, 'run_a', 'ws1', 'task_a', { status: 'done' }));
      assert.throws(() => insertRun(db, 'run_a', 'ws1', 'task_a', { reason: 'rerun' }));
      assert.throws(() => insertRun(db, 'run_a', 'ws1', 'task_a', { origin: 'web' }));
      insertRun(db, 'run_a', 'ws1', 'task_a');
      const row = db.prepare('SELECT status, reason, origin, next_event_sequence, version FROM runs WHERE id = ?').get('run_a') as { status: string; reason: string; origin: string; next_event_sequence: number; version: number };
      assert.equal(row.status, 'queued');
      assert.equal(row.reason, 'initial');
      assert.equal(row.origin, 'v2_api');
      assert.equal(row.next_event_sequence, 1);
      assert.equal(row.version, 1);
    } finally {
      db.close();
    }
  });

  it('T06 partial unique index rejects a second active Run per Task and allows it after terminal', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws1');
      insertTask(db, 'task_a', 'ws1');
      insertRun(db, 'run_1', 'ws1', 'task_a', { status: 'queued' });
      assert.throws(() => insertRun(db, 'run_2', 'ws1', 'task_a', { status: 'running' }));
      db.prepare("UPDATE runs SET status = 'completed' WHERE id = 'run_1'").run();
      insertRun(db, 'run_2', 'ws1', 'task_a', { status: 'queued' });
      const cnt = db.prepare("SELECT COUNT(*) AS cnt FROM runs WHERE task_id = 'task_a'").get() as { cnt: number };
      assert.equal(cnt.cnt, 2);
    } finally {
      db.close();
    }
  });

  it('T07 partial unique index rejects duplicate legacy_task_id per workspace and ignores NULL', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws1');
      insertWorkspace(db, 'ws2');
      insertTask(db, 'task_a', 'ws1', { legacyTaskId: 'legacy-1' });
      assert.throws(() => insertTask(db, 'task_b', 'ws1', { legacyTaskId: 'legacy-1' }));
      insertTask(db, 'task_c', 'ws1');
      insertTask(db, 'task_d', 'ws1');
      insertTask(db, 'task_e', 'ws2', { legacyTaskId: 'legacy-1' });
      const cnt = db.prepare('SELECT COUNT(*) AS cnt FROM tasks').get() as { cnt: number };
      assert.equal(cnt.cnt, 4);
    } finally {
      db.close();
    }
  });

  it('T08 deleting a workspace cascades its tasks and runs', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws1');
      insertTask(db, 'task_a', 'ws1');
      insertRun(db, 'run_1', 'ws1', 'task_a');
      db.prepare("DELETE FROM workspaces WHERE id = 'ws1'").run();
      assert.equal((db.prepare('SELECT COUNT(*) AS cnt FROM tasks').get() as { cnt: number }).cnt, 0);
      assert.equal((db.prepare('SELECT COUNT(*) AS cnt FROM runs').get() as { cnt: number }).cnt, 0);
    } finally {
      db.close();
    }
  });

  it('T09 deleting a task cascades its runs', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws1');
      insertTask(db, 'task_a', 'ws1');
      insertRun(db, 'run_1', 'ws1', 'task_a', { status: 'completed' });
      insertRun(db, 'run_2', 'ws1', 'task_a');
      db.prepare("DELETE FROM tasks WHERE id = 'task_a'").run();
      assert.equal((db.prepare('SELECT COUNT(*) AS cnt FROM runs').get() as { cnt: number }).cnt, 0);
    } finally {
      db.close();
    }
  });

  it('T10 composite FK rejects a Run whose workspace does not match the Task workspace', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws1');
      insertWorkspace(db, 'ws2');
      insertTask(db, 'task_a', 'ws1');
      assert.throws(() => insertRun(db, 'run_1', 'ws2', 'task_a'), /FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('T11 composite self FK rejects parent_run_id pointing at another Task', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws1');
      insertTask(db, 'task_a', 'ws1');
      insertTask(db, 'task_b', 'ws1');
      insertRun(db, 'run_1', 'ws1', 'task_a');
      assert.throws(
        () => insertRun(db, 'run_2', 'ws1', 'task_b', { parentRunId: 'run_1', rootRunId: 'run_2', reason: 'retry' }),
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });

  it('T12 composite self FK rejects root_run_id pointing at another Task', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws1');
      insertTask(db, 'task_a', 'ws1');
      insertTask(db, 'task_b', 'ws1');
      insertRun(db, 'run_1', 'ws1', 'task_a');
      assert.throws(
        () => insertRun(db, 'run_2', 'ws1', 'task_b', { rootRunId: 'run_1' }),
        /FOREIGN KEY/i,
      );
    } finally {
      db.close();
    }
  });

  it('T13 real node:sqlite accepts an initial Run with parent NULL and root_run_id = self', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws1');
      insertTask(db, 'task_a', 'ws1');
      insertRun(db, 'run_self', 'ws1', 'task_a', { parentRunId: null, rootRunId: 'run_self' });
      const row = db.prepare('SELECT parent_run_id, root_run_id FROM runs WHERE id = ?').get('run_self') as { parent_run_id: string | null; root_run_id: string };
      assert.equal(row.parent_run_id, null);
      assert.equal(row.root_run_id, 'run_self');
    } finally {
      db.close();
    }
  });

  it('T14 PRAGMA integrity_check returns ok after 005/006', () => {
    const db = migratedDb();
    try {
      const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].integrity_check, 'ok');
    } finally {
      db.close();
    }
  });

  it('T15 PRAGMA foreign_key_check reports no violations after 005/006', () => {
    const db = migratedDb();
    try {
      insertWorkspace(db, 'ws1');
      insertTask(db, 'task_a', 'ws1');
      insertRun(db, 'run_1', 'ws1', 'task_a');
      const rows = db.prepare('PRAGMA foreign_key_check').all();
      assert.equal(rows.length, 0);
    } finally {
      db.close();
    }
  });

  it('migrations 005/006 remain registered after 004 as later migrations are appended', () => {
    const ids = DEFAULT_REGISTRY_MIGRATIONS.map(m => m.id);
    assert.deepEqual(ids.slice(4), ['005', '006', '007', '008', '009', '010', '011', '012', '013', '014']);
    assert.equal(DEFAULT_REGISTRY_MIGRATIONS[4], migration005);
    assert.equal(DEFAULT_REGISTRY_MIGRATIONS[5], migration006);
  });
});
