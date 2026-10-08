import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * MF-5 Workspace Event stream (authorization: PR #127,
 * `docs/implementation/milestones/MF5-workspace-event-schema-authorization.md`).
 *
 * Additive only: one column on the owning aggregate row plus one Run-less
 * canonical Event table. `runtime_events` is NOT mirrored byte-for-byte: this
 * table is deliberately stricter (length CHECKs on id/workspace_id and a
 * NOT NULL causation_id) and carries no Run-bound reference column at all, so
 * a Run-bound fact is structurally unable to enter this stream.
 *
 * Exactly ONE trigger: the frozen design measured that a BEFORE DELETE abort
 * trigger is mutually exclusive with the required Workspace hard-delete, so
 * delete protection is a construction property, not a trigger property.
 */
export const MF5_WORKSPACE_025_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS workspace_events (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  type TEXT NOT NULL CHECK (type <> ''),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source <> ''),
  correlation_id TEXT NOT NULL CHECK (correlation_id <> ''),
  causation_id TEXT NOT NULL CHECK (causation_id <> ''),
  parent_event_id TEXT,
  severity TEXT NOT NULL CHECK (severity <> ''),
  visibility TEXT NOT NULL CHECK (visibility <> ''),
  durability TEXT NOT NULL CHECK (durability <> ''),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, sequence),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS workspace_events_workspace_sequence
  ON workspace_events (workspace_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS workspace_events_correlation
  ON workspace_events (workspace_id, correlation_id, sequence)`,
  `CREATE TRIGGER IF NOT EXISTS workspace_events_reject_update
  BEFORE UPDATE ON workspace_events
  BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_EVENT_APPEND_ONLY');
  END`,
]);

/** Canonical column DDL: part of the checksum source (must stay covered). */
export const MF5_WORKSPACE_025_COLUMN_DDL =
  'ALTER TABLE workspaces ADD COLUMN next_event_sequence INTEGER NOT NULL DEFAULT 1';

const CANONICAL_SOURCE = [MF5_WORKSPACE_025_COLUMN_DDL, ...MF5_WORKSPACE_025_DDL_STATEMENTS].join('\n');

export const migration025Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration025: Migration = {
  id: '025',
  name: 'mf5-workspace-event-stream',
  checksum: migration025Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    if (!workspacesExists(ctx.db)) {
      // Fail closed: an 025 success record must never be written against an
      // incomplete parent schema.
      throw new Error(
        'MIGRATION_PREREQUISITE_MISSING: 025 requires workspaces',
      );
    }
    const column = ctx.db
      .prepare("SELECT name FROM pragma_table_info('workspaces') WHERE name = 'next_event_sequence'")
      .get();
    if (column === undefined || column === null) {
      ctx.db.exec(MF5_WORKSPACE_025_COLUMN_DDL);
    }
    for (const statement of MF5_WORKSPACE_025_DDL_STATEMENTS) {
      ctx.db.exec(statement);
    }
  },
};

function workspacesExists(db: MigrationContext['db']): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
    .get();
  return row !== undefined && row !== null;
}
