import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import type { MinimalDatabaseSync } from '../types.js';
import { migration052 } from '../migrations/052-memory-entry-source-bindings.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

test('052 persists one immutable promotion link for each source Entry version', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        status TEXT NOT NULL, version INTEGER NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );
      CREATE TABLE workspace_events (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );
      INSERT INTO workspaces VALUES ('ws-a');
      INSERT INTO memory_entries VALUES ('source-a', 'ws-a', 'run', 'active', 2);
      INSERT INTO memory_entries VALUES ('promoted-a', 'ws-a', 'workspace', 'active', 1);
      INSERT INTO memory_entries VALUES ('promoted-b', 'ws-a', 'workspace', 'active', 1);
      INSERT INTO workspace_events VALUES ('event-a', 'ws-a', 'memory.entry_created', '{"memoryEntryId":"promoted-a"}');`);

    migration052.apply({ db: db as unknown as MinimalDatabaseSync });
    migration052.apply({ db: db as unknown as MinimalDatabaseSync });
    db.prepare(`INSERT INTO memory_entry_source_bindings (
      workspace_id, source_entry_id, source_entry_version, promoted_entry_id,
      promoted_entry_version, promotion_event_id, created_at
    ) VALUES ('ws-a', 'source-a', 2, 'promoted-a', 1, 'event-a', '2026-10-02T00:00:00.000Z')`).run();

    assert.deepEqual({ ...db.prepare('SELECT * FROM memory_entry_source_bindings').get() as object }, {
      workspace_id: 'ws-a', source_entry_id: 'source-a', source_entry_version: 2,
      promoted_entry_id: 'promoted-a', promoted_entry_version: 1,
      promotion_event_id: 'event-a', created_at: '2026-10-02T00:00:00.000Z',
    });
    assert.throws(() => db.prepare(`INSERT INTO memory_entry_source_bindings (
      workspace_id, source_entry_id, source_entry_version, promoted_entry_id,
      promoted_entry_version, created_at
    ) VALUES ('ws-a', 'source-a', 2, 'promoted-b', 1, '2026-10-02T00:00:01.000Z')`).run());
    assert.throws(() => db.prepare("UPDATE memory_entry_source_bindings SET source_entry_version = 1").run(),
      /MEMORY_ENTRY_SOURCE_BINDING_IMMUTABLE/);
    assert.throws(() => db.prepare('DELETE FROM memory_entry_source_bindings').run(),
      /MEMORY_ENTRY_SOURCE_BINDING_IMMUTABLE/);
  } finally { db.close(); }
});

test('052 fails closed when its source or audit prerequisites are absent', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.throws(() => migration052.apply({ db: db as unknown as MinimalDatabaseSync }),
      /MIGRATION_PREREQUISITE_MISSING: 052 requires workspaces/);
  } finally { db.close(); }
});
