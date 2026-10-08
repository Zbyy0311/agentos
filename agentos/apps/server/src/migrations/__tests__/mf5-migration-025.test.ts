import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import {
  migration025,
  MF5_WORKSPACE_025_COLUMN_DDL,
  MF5_WORKSPACE_025_DDL_STATEMENTS,
} from '../migrations/025-mf5-workspace-event-stream.js';
import type { MinimalDatabaseSync } from '../types.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => MinimalDatabaseSync & {
    close(): void;
    exec(sql: string): void;
  };
};

const NEW_OBJECT_PREFIX = 'workspace_events';

function migrateThrough024(db: MinimalDatabaseSync): void {
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(m => m.id < '025')) {
    migration.apply({ db });
  }
}

function insertWorkspace(db: MinimalDatabaseSync, id = 'ws'): void {
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, 'workspace', 'C:/tmp/mf025', 'C:/tmp/mf025', 'now', 'now', 'now')`).run(id);
}

function insertEvent(db: MinimalDatabaseSync, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'evt_1',
    schema_version: 1,
    type: 'memory.entry_created',
    workspace_id: 'ws',
    sequence: 1,
    timestamp: '2026-09-11T00:00:00.000Z',
    source: 'memory-engine',
    correlation_id: 'memory-candidate:c1:v1',
    causation_id: 'c1',
    severity: 'info',
    visibility: 'internal',
    durability: 'durable',
    payload_json: '{}',
    created_at: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO workspace_events (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map(key => row[key as keyof typeof row]));
}

test('025 upgrades 024 additively and leaves every earlier object byte-identical', () => {
  const db = new DatabaseSync(':memory:');
  try {
    migrateThrough024(db);
    insertWorkspace(db);
    const beforeWorkspaces = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get() as { sql: string };
    const beforeColumns = db.prepare("SELECT name FROM pragma_table_info('workspaces') ORDER BY cid").all() as Array<{ name: string }>;
    const beforeOther = db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '${NEW_OBJECT_PREFIX}%' AND name <> 'workspaces'
      ORDER BY name`).all();

    migration025.apply({ db });
    migration025.apply({ db });

    assert.equal(migration025.destructive, false);
    assert.equal(migration025.id, '025');
    assert.equal(migration025.name, 'mf5-workspace-event-stream');
    assert.equal(
      migration025.checksum,
      createHash('sha256')
        .update([MF5_WORKSPACE_025_COLUMN_DDL, ...MF5_WORKSPACE_025_DDL_STATEMENTS].join('\n'))
        .digest('hex')
        .slice(0, 16),
    );

    // The only pre-existing table touched is `workspaces`, by exactly one column.
    const afterOther = db.prepare(`SELECT name, sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '${NEW_OBJECT_PREFIX}%' AND name <> 'workspaces'
      ORDER BY name`).all();
    assert.deepEqual(afterOther, beforeOther);
    assert.equal(beforeColumns.length + 1, (db.prepare("SELECT name FROM pragma_table_info('workspaces')").all() as unknown[]).length);
    const column = db.prepare("SELECT type, \"notnull\", dflt_value, pk FROM pragma_table_info('workspaces') WHERE name = 'next_event_sequence'").get() as {
      type: string; notnull: number; dflt_value: string | null; pk: number;
    };
    assert.equal(column.type, 'INTEGER');
    assert.equal(column.notnull, 1);
    assert.equal(column.dflt_value, '1');
    assert.equal(column.pk, 0);
    void beforeWorkspaces;
    // Existing rows keep version semantics and receive the default counter.
    const workspace = db.prepare("SELECT version, next_event_sequence FROM workspaces WHERE id = 'ws'").get() as {
      version: number; next_event_sequence: number;
    };
    assert.equal(workspace.next_event_sequence, 1);
    assert.equal(workspace.version, 1);
    assert.deepEqual(db.prepare('SELECT * FROM workspace_events').all(), []);

    // Exactly one trigger: no BEFORE DELETE guard (design section 6.3).
    const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${NEW_OBJECT_PREFIX}%' ORDER BY name`).all() as Array<{ name: string }>;
    assert.deepEqual(triggers.map(t => t.name), ['workspace_events_reject_update']);
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '${NEW_OBJECT_PREFIX}%' ORDER BY name`).all() as Array<{ name: string }>;
    assert.deepEqual(indexes.map(i => i.name), ['workspace_events_correlation', 'workspace_events_workspace_sequence']);
  } finally { db.close(); }
});

test('025 missing prerequisite records no migration state and creates no table', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration025.apply({ db }), /MIGRATION_PREREQUISITE_MISSING: 025 requires workspaces/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'workspace_events'").get(), undefined);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'workspace_events_reject_update'").get(), undefined);
  } finally { db.close(); }
});

test('025 stream is append-only for updates and honours the sanctioned delete order', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrateThrough024(db);
    migration025.apply({ db });
    insertWorkspace(db);
    insertEvent(db);

    assert.throws(
      () => db.prepare("UPDATE workspace_events SET severity = 'warn' WHERE id = 'evt_1'").run(),
      /WORKSPACE_EVENT_APPEND_ONLY/,
    );

    // RESTRICT FK + no delete trigger: the Workspace cannot be removed while
    // its Events exist, and the sanctioned order (events first) succeeds.
    assert.throws(() => db.prepare("DELETE FROM workspaces WHERE id = 'ws'").run());
    db.prepare("DELETE FROM workspace_events WHERE workspace_id = 'ws'").run();
    db.prepare("DELETE FROM workspaces WHERE id = 'ws'").run();
    assert.deepEqual(db.prepare('SELECT * FROM workspace_events').all(), []);
    assert.equal(db.prepare("SELECT id FROM workspaces WHERE id = 'ws'").get(), undefined);

    // A Run-bound reference cannot be represented: no such column exists.
    const columns = db.prepare("SELECT name FROM pragma_table_info('workspace_events')").all() as Array<{ name: string }>;
    const names = columns.map(c => c.name);
    for (const forbidden of ['run_id', 'task_id', 'stage_id', 'process_id', 'provider_session_id', 'approval_request_id']) {
      assert.equal(names.includes(forbidden), false, forbidden + ' must not be representable');
    }
  } finally { db.close(); }
});

