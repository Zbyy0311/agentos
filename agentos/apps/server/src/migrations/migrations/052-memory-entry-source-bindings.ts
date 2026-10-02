import { createHash } from 'node:crypto';
import type { Migration, MinimalDatabaseSync } from '../types.js';

/** Immutable lineage for an explicit workspace-knowledge promotion. */
export const MEMORY_ENTRY_SOURCE_BINDINGS_052_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS memory_entry_source_bindings (
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    source_entry_id TEXT NOT NULL CHECK (length(source_entry_id) > 0),
    source_entry_version INTEGER NOT NULL CHECK (source_entry_version >= 1),
    promoted_entry_id TEXT NOT NULL CHECK (length(promoted_entry_id) > 0),
    promoted_entry_version INTEGER NOT NULL CHECK (promoted_entry_version >= 1),
    promotion_event_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, source_entry_id, source_entry_version),
    UNIQUE (source_entry_id, source_entry_version),
    UNIQUE (workspace_id, promoted_entry_id),
    CHECK (source_entry_id <> promoted_entry_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
    FOREIGN KEY (source_entry_id) REFERENCES memory_entries(id) ON DELETE RESTRICT,
    FOREIGN KEY (promoted_entry_id) REFERENCES memory_entries(id) ON DELETE RESTRICT,
    FOREIGN KEY (promotion_event_id) REFERENCES workspace_events(id) ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS memory_entry_source_bindings_promoted
    ON memory_entry_source_bindings (workspace_id, promoted_entry_id)`,
  `CREATE TRIGGER IF NOT EXISTS memory_entry_source_bindings_validate_insert
    BEFORE INSERT ON memory_entry_source_bindings
    WHEN NOT EXISTS (
      SELECT 1 FROM memory_entries source
      JOIN memory_entries promoted ON promoted.id = NEW.promoted_entry_id
      WHERE source.id = NEW.source_entry_id AND source.workspace_id = NEW.workspace_id
        AND source.scope IN ('task','conversation','run')
        AND NEW.source_entry_version <= source.version
        AND promoted.workspace_id = NEW.workspace_id AND promoted.scope = 'workspace'
        AND NEW.promoted_entry_version <= promoted.version
    ) OR (NEW.promotion_event_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM workspace_events event
      WHERE event.id = NEW.promotion_event_id AND event.workspace_id = NEW.workspace_id
        AND event.type = 'memory.entry_created'
        AND json_extract(event.payload_json, '$.memoryEntryId') = NEW.promoted_entry_id
    ))
    BEGIN SELECT RAISE(ABORT, 'MEMORY_ENTRY_SOURCE_BINDING_INVALID'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_entry_source_bindings_reject_update
    BEFORE UPDATE ON memory_entry_source_bindings
    BEGIN SELECT RAISE(ABORT, 'MEMORY_ENTRY_SOURCE_BINDING_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS memory_entry_source_bindings_reject_delete
    BEFORE DELETE ON memory_entry_source_bindings
    BEGIN SELECT RAISE(ABORT, 'MEMORY_ENTRY_SOURCE_BINDING_IMMUTABLE'); END`,
] as const);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  for (const table of ['workspaces', 'memory_entries', 'workspace_events']) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) {
      throw new Error(`MIGRATION_PREREQUISITE_MISSING: 052 requires ${table}`);
    }
  }
}

export const migration052: Migration = {
  id: '052',
  name: 'memory-entry-source-bindings',
  destructive: false,
  checksum: createHash('sha256').update(MEMORY_ENTRY_SOURCE_BINDINGS_052_DDL.join('\n')).digest('hex').slice(0, 16),
  apply({ db }) {
    assertPrerequisites(db);
    for (const ddl of MEMORY_ENTRY_SOURCE_BINDINGS_052_DDL) db.prepare(ddl).run();
  },
};
