import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/** @internal exported for atomic rollback verification only. */
export const M25_008_DDL_STATEMENTS = Object.freeze([
  `CREATE UNIQUE INDEX idx_runs_id_workspace
    ON runs(id, workspace_id)`,

  `CREATE TABLE run_snapshots (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    workflow_definition_id TEXT NOT NULL,
    snapshot_schema_version INTEGER NOT NULL
      CHECK (snapshot_schema_version >= 1),
    snapshot_json TEXT NOT NULL
      CHECK (json_valid(snapshot_json)),
    content_hash TEXT NOT NULL
      CHECK (length(content_hash) = 64),
    redaction_applied INTEGER NOT NULL DEFAULT 0
      CHECK (redaction_applied IN (0,1)),
    captured_at TEXT NOT NULL,
    UNIQUE(run_id),
    UNIQUE(id, run_id),
    FOREIGN KEY (run_id, workspace_id)
      REFERENCES runs(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_definition_id)
      REFERENCES workflow_definitions(id) ON DELETE RESTRICT
  )`,

  `CREATE TRIGGER run_snapshots_reject_update
    BEFORE UPDATE ON run_snapshots
    BEGIN
      SELECT RAISE(ABORT, 'RUN_SNAPSHOT_IMMUTABLE');
    END`,
]);

// Checksum covers the supporting unique index, the table DDL, and the trigger DDL.
// The UPDATE-only trigger preserves Run -> Snapshot cascade delete (no DELETE trigger).
const CANONICAL_SOURCE = M25_008_DDL_STATEMENTS.join('\n');

export const migration008Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration008: Migration = {
  id: '008',
  name: 'run-snapshots',
  checksum: migration008Checksum,
  apply(ctx: MigrationContext): void {
    for (const stmt of M25_008_DDL_STATEMENTS) {
      ctx.db.exec(stmt);
    }
  },
};
