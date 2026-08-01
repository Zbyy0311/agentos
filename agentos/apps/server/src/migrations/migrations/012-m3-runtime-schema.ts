import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * M3 P2A schema foundation. This migration only creates/rebuilds schema and
 * constraints; runtime repositories, publishers, allocators, and state
 * transitions are intentionally outside this package.
 */
export const M3_P2A_012_DDL_STATEMENTS = Object.freeze([
  `ALTER TABLE runs ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0
    CHECK (recovery_required IN (0, 1))`,

  `ALTER TABLE run_stages RENAME TO run_stages_legacy_012`,

  `CREATE TABLE run_stages (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    run_snapshot_id TEXT NOT NULL,
    workflow_stage_key TEXT NOT NULL,
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','ready','starting','running','waiting_approval','paused','completed','failed','cancelled','skipped')),
    failure_code TEXT,
    failure_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE(run_id, sequence),
    UNIQUE(run_id, workflow_stage_key, attempt),
    UNIQUE(id, run_id),
    FOREIGN KEY (run_id, workspace_id)
      REFERENCES runs(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (run_snapshot_id, run_id)
      REFERENCES run_snapshots(id, run_id) ON DELETE CASCADE
  )`,

  `INSERT INTO run_stages (
    id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
    sequence, attempt, status, created_at, updated_at, version
  )
  SELECT
    id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
    sequence, attempt, status, created_at, updated_at, version
  FROM run_stages_legacy_012`,

  `DROP TABLE run_stages_legacy_012`,

  `DROP TRIGGER idempotency_records_reject_update`,

  `ALTER TABLE idempotency_records RENAME TO idempotency_records_legacy_012`,

  `CREATE TABLE idempotency_records (
    id TEXT PRIMARY KEY
      CHECK (length(id) = 31 AND substr(id, 1, 5) = 'idem_'),
    workspace_id TEXT NOT NULL,
    operation TEXT NOT NULL
      CHECK (operation IN ('task.create','run.create','run.cancel','task.accept','task.cancel','task.reopen','run.start','run.retry')),
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
  FROM idempotency_records_legacy_012`,

  `DROP TABLE idempotency_records_legacy_012`,

  `CREATE TRIGGER idempotency_records_reject_update
  BEFORE UPDATE ON idempotency_records
  BEGIN
    SELECT RAISE(ABORT, 'IDEMPOTENCY_RECORD_IMMUTABLE');
  END`,

  `CREATE TABLE runtime_events (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
    type TEXT NOT NULL CHECK (type <> ''),
    workspace_id TEXT NOT NULL,
    task_id TEXT,
    run_id TEXT NOT NULL,
    stage_id TEXT,
    agent_id TEXT,
    provider_config_id TEXT,
    provider_session_id TEXT,
    process_id TEXT,
    worktree_id TEXT,
    artifact_id TEXT,
    approval_request_id TEXT,
    conversation_id TEXT,
    message_id TEXT,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    timestamp TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source <> ''),
    correlation_id TEXT NOT NULL CHECK (correlation_id <> ''),
    causation_id TEXT,
    parent_event_id TEXT,
    severity TEXT NOT NULL CHECK (severity <> ''),
    visibility TEXT NOT NULL CHECK (visibility <> ''),
    durability TEXT NOT NULL CHECK (durability <> ''),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
    created_at TEXT NOT NULL,
    UNIQUE(run_id, sequence),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (stage_id, run_id) REFERENCES run_stages(id, run_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, agent_id) REFERENCES agent_profiles(workspace_id, id) ON DELETE SET NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
    FOREIGN KEY (artifact_id) REFERENCES runtime_artifacts(id) ON DELETE SET NULL
  )`,

  `CREATE INDEX runtime_events_run_sequence
    ON runtime_events(run_id, sequence)`,

  `CREATE INDEX runtime_events_run_correlation_sequence
    ON runtime_events(run_id, correlation_id, sequence)`,

  `CREATE INDEX runtime_events_correlation
    ON runtime_events(correlation_id)`,

  `CREATE TRIGGER runtime_events_reject_update
  BEFORE UPDATE ON runtime_events
  BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_EVENT_APPEND_ONLY');
  END`,

  `CREATE TRIGGER runtime_events_reject_delete
  BEFORE DELETE ON runtime_events
  BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_EVENT_APPEND_ONLY');
  END`,

  `CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL
      CHECK (type IN ('run.create','run.start','run.cancel','run.retry')),
    status TEXT NOT NULL
      CHECK (status IN ('queued','running','waiting_approval','paused','completed','failed','cancelled')),
    workspace_id TEXT NOT NULL,
    aggregate_type TEXT NOT NULL CHECK (aggregate_type = 'run'),
    aggregate_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL UNIQUE,
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (aggregate_id = run_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX operations_run_correlation
    ON operations(run_id, correlation_id)`,

  `CREATE TRIGGER operations_identity_immutable
  BEFORE UPDATE ON operations
  WHEN NEW.id IS NOT OLD.id
    OR NEW.type IS NOT OLD.type
    OR NEW.workspace_id IS NOT OLD.workspace_id
    OR NEW.aggregate_type IS NOT OLD.aggregate_type
    OR NEW.aggregate_id IS NOT OLD.aggregate_id
    OR NEW.run_id IS NOT OLD.run_id
    OR NEW.correlation_id IS NOT OLD.correlation_id
  BEGIN
    SELECT RAISE(ABORT, 'OPERATION_IDENTITY_IMMUTABLE');
  END`,

  `CREATE TABLE outbox_messages (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL,
    aggregate_type TEXT NOT NULL CHECK (aggregate_type = 'run'),
    aggregate_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    status TEXT NOT NULL CHECK (status IN ('pending','publishing','published','retry','dead_letter')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at TEXT NOT NULL,
    published_at TEXT,
    last_error TEXT,
    lease_owner TEXT,
    lease_expires_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    CHECK (status <> 'published' OR published_at IS NOT NULL),
    CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
    FOREIGN KEY (event_id) REFERENCES runtime_events(id) ON DELETE RESTRICT,
    FOREIGN KEY (aggregate_id) REFERENCES runs(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX outbox_messages_aggregate_status
    ON outbox_messages(aggregate_type, aggregate_id, status, available_at)`,

  `CREATE TRIGGER outbox_messages_identity_immutable
  BEFORE UPDATE ON outbox_messages
  WHEN NEW.id IS NOT OLD.id
    OR NEW.event_id IS NOT OLD.event_id
    OR NEW.topic IS NOT OLD.topic
    OR NEW.aggregate_type IS NOT OLD.aggregate_type
    OR NEW.aggregate_id IS NOT OLD.aggregate_id
    OR NEW.payload_json IS NOT OLD.payload_json
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN
    SELECT RAISE(ABORT, 'OUTBOX_IDENTITY_IMMUTABLE');
  END`,

  `CREATE TABLE dead_letters (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target TEXT NOT NULL,
    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    error_code TEXT NOT NULL,
    error_message TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    first_failed_at TEXT NOT NULL,
    last_failed_at TEXT NOT NULL,
    retryable INTEGER NOT NULL CHECK (retryable IN (0,1)),
    resolved_at TEXT,
    resolved_by TEXT,
    created_at TEXT NOT NULL,
    CHECK ((resolved_at IS NULL AND resolved_by IS NULL) OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
  )`,

  `CREATE INDEX dead_letters_source
    ON dead_letters(source_type, source_id, target)`,
]);

const CANONICAL_SOURCE = M3_P2A_012_DDL_STATEMENTS.join('\n');

export const migration012Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration012: Migration = {
  id: '012',
  name: 'm3-runtime-schema',
  checksum: migration012Checksum,
  apply(ctx: MigrationContext): void {
    for (const statement of M3_P2A_012_DDL_STATEMENTS) {
      ctx.db.exec(statement);
    }
  },
};
