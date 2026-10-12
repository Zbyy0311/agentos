import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * P4 Run-level Pause/Resume: widen the idempotency_records operation CHECK so
 * the canonical 'run.pause' / 'run.resume' V2 mutations can persist durable
 * success records. SQLite cannot ALTER a CHECK constraint, so the table is
 * rebuilt with the same shape and immutability trigger as migration 012; only
 * the operation enumeration changes. Pause/Resume create no Operation rows,
 * so the operations CHECK is untouched.
 */
export const RUN_PAUSE_RESUME_057_DDL_STATEMENTS = Object.freeze([
  `DROP TRIGGER idempotency_records_reject_update`,

  `ALTER TABLE idempotency_records RENAME TO idempotency_records_legacy_057`,

  `CREATE TABLE idempotency_records (
    id TEXT PRIMARY KEY
      CHECK (length(id) = 31 AND substr(id, 1, 5) = 'idem_'),
    workspace_id TEXT NOT NULL,
    operation TEXT NOT NULL
      CHECK (operation IN ('task.create','run.create','run.cancel','task.accept','task.cancel','task.reopen','run.start','run.retry','run.pause','run.resume')),
    key_hash TEXT NOT NULL
      CHECK (length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
    request_hash TEXT NOT NULL
      CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    result_schema_version INTEGER NOT NULL CHECK (result_schema_version = 1),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    result_hash TEXT NOT NULL
      CHECK (length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*'),
    http_status INTEGER NOT NULL CHECK (http_status BETWEEN 200 AND 299),
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, operation, key_hash),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`,

  `INSERT INTO idempotency_records (
    id, workspace_id, operation, key_hash, request_hash, result_schema_version,
    result_json, result_hash, http_status, created_at
  )
  SELECT
    id, workspace_id, operation, key_hash, request_hash, result_schema_version,
    result_json, result_hash, http_status, created_at
  FROM idempotency_records_legacy_057`,

  `DROP TABLE idempotency_records_legacy_057`,

  `CREATE TRIGGER idempotency_records_reject_update
  BEFORE UPDATE ON idempotency_records
  BEGIN
    SELECT RAISE(ABORT, 'IDEMPOTENCY_RECORD_IMMUTABLE');
  END`,
]);

export const migration057Checksum = createHash('sha256')
  .update(RUN_PAUSE_RESUME_057_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration057: Migration = {
  id: '057',
  name: 'run-pause-resume',
  checksum: migration057Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of RUN_PAUSE_RESUME_057_DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
