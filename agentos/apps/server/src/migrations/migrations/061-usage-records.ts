import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * 061 — Usage Records (§23 / §50).
 *
 * usage_records is the append-only per-Provider/Run/Stage/Process resource
 * consumption ledger. Rows carry metric fields only (tokens, duration,
 * estimated flag); prompt content is never representable here. Idempotency:
 * source_event_id is UNIQUE so replaying the same source event never
 * duplicates a record.
 */
export const USAGE_RECORDS_061_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE usage_records (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT,
    stage_id TEXT,
    process_id TEXT,
    provider_config_id TEXT,
    source TEXT,
    provider TEXT,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    cached_input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
    output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
    recorded_at TEXT NOT NULL,
    source_event_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX idx_usage_records_workspace_recorded
    ON usage_records(workspace_id, recorded_at ASC, id ASC)`,

  `CREATE INDEX idx_usage_records_workspace_run
    ON usage_records(workspace_id, run_id)`,

  `CREATE INDEX idx_usage_records_workspace_provider
    ON usage_records(workspace_id, provider, recorded_at ASC)`,
]);

export const migration061Checksum = createHash('sha256')
  .update(USAGE_RECORDS_061_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration061: Migration = {
  id: '061',
  name: 'usage-records',
  checksum: migration061Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of USAGE_RECORDS_061_DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
