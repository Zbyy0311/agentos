import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/** @internal exported for atomic rollback verification only. */
export const M26_010_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY
    CHECK (
      length(id) = 31
      AND substr(id, 1, 5) = 'idem_'
    ),

  workspace_id TEXT NOT NULL,

  operation TEXT NOT NULL
    CHECK (
      operation IN (
        'task.create',
        'run.create',
        'run.cancel',
        'task.accept',
        'task.cancel',
        'task.reopen'
      )
    ),

  key_hash TEXT NOT NULL
    CHECK (
      length(key_hash) = 64
      AND key_hash NOT GLOB '*[^0-9a-f]*'
    ),

  request_hash TEXT NOT NULL
    CHECK (
      length(request_hash) = 64
      AND request_hash NOT GLOB '*[^0-9a-f]*'
    ),

  result_schema_version INTEGER NOT NULL
    CHECK (result_schema_version = 1),

  result_json TEXT NOT NULL
    CHECK (json_valid(result_json)),

  result_hash TEXT NOT NULL
    CHECK (
      length(result_hash) = 64
      AND result_hash NOT GLOB '*[^0-9a-f]*'
    ),

  http_status INTEGER NOT NULL
    CHECK (http_status BETWEEN 200 AND 299),

  created_at TEXT NOT NULL,

  UNIQUE(workspace_id, operation, key_hash),

  FOREIGN KEY (workspace_id)
    REFERENCES workspaces(id)
    ON DELETE CASCADE
)`,

  `CREATE TRIGGER idempotency_records_reject_update
  BEFORE UPDATE ON idempotency_records
  BEGIN
    SELECT RAISE(
      ABORT,
      'IDEMPOTENCY_RECORD_IMMUTABLE'
    );
  END`,
]);

// Checksum covers the table DDL and the trigger DDL.
// The UPDATE-only trigger preserves Workspace -> Record cascade delete (no DELETE trigger).
const CANONICAL_SOURCE = M26_010_DDL_STATEMENTS.join('\n');

export const migration010Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration010: Migration = {
  id: '010',
  name: 'idempotency-records',
  checksum: migration010Checksum,
  apply(ctx: MigrationContext): void {
    for (const stmt of M26_010_DDL_STATEMENTS) {
      ctx.db.exec(stmt);
    }
  },
};
