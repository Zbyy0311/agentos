import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * M4 P2A process runtime schema (frozen design: M4-p2-schema-design.md).
 * Creates exactly the three M4 tables (provider_sessions, runtime_processes,
 * process_output_references) plus the three supporting unique indexes on
 * pre-existing parent tables. No backfill, no old-table reuse, no changes to
 * 001-013 objects or rows.
 *
 * destructive is frozen to true so the existing MigrationRunner
 * mandatory-backup gate engages on non-empty databases; schema/data behavior
 * stays additive. Fresh databases use the runner's existing fresh destructive
 * skip.
 */
export const M4_P2_014_DDL_STATEMENTS = Object.freeze([
  `CREATE UNIQUE INDEX provider_configurations_id_workspace
    ON provider_configurations(id, workspace_id)`,

  `CREATE UNIQUE INDEX runs_id_workspace_task
    ON runs(id, workspace_id, task_id)`,

  `CREATE UNIQUE INDEX run_stages_id_workspace_run_attempt
    ON run_stages(id, workspace_id, run_id, attempt)`,

  `CREATE TABLE provider_sessions (
    id TEXT NOT NULL PRIMARY KEY
      CHECK (length(id) = 32 AND substr(id, 1, 6) = 'psess_'),
    workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    stage_attempt INTEGER NOT NULL CHECK (stage_attempt >= 1),
    authority_role TEXT NOT NULL CHECK (authority_role = 'primary-provider'),
    agent_id TEXT NOT NULL,
    provider_config_id TEXT NOT NULL,
    provider_config_version INTEGER NOT NULL CHECK (provider_config_version >= 1),
    provider_type TEXT NOT NULL CHECK (length(provider_type) > 0 AND provider_type <> 'kimi'),
    adapter_id TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    config_schema_version INTEGER NOT NULL CHECK (config_schema_version >= 1),
    runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('cli','api','ssh','container')),
    native_session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('starting','active','waiting','paused','completed','failed','cancelled')),
    claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 1),
    claim_owner_id TEXT,
    claim_lease_expires_at TEXT,
    adapter_start_requested_at TEXT,
    capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
    error_code TEXT,
    error_detail_redacted TEXT,
    started_at TEXT,
    last_activity_at TEXT,
    completed_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    CHECK ((claim_owner_id IS NULL AND claim_lease_expires_at IS NULL) OR (claim_owner_id IS NOT NULL AND claim_lease_expires_at IS NOT NULL)),
    CHECK (status <> 'active' OR started_at IS NOT NULL),
    CHECK (status NOT IN ('completed','failed','cancelled') OR completed_at IS NOT NULL),
    UNIQUE (id, workspace_id, run_id),
    UNIQUE (id, workspace_id, run_id, stage_id, stage_attempt),
    UNIQUE (workspace_id, run_id, stage_id, stage_attempt, authority_role),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, workspace_id, task_id)
      REFERENCES runs(id, workspace_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (stage_id, workspace_id, run_id, stage_attempt)
      REFERENCES run_stages(id, workspace_id, run_id, attempt) ON DELETE RESTRICT,
    FOREIGN KEY (provider_config_id, workspace_id)
      REFERENCES provider_configurations(id, workspace_id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, agent_id)
      REFERENCES agent_profiles(workspace_id, id) ON DELETE RESTRICT
  )`,

  `CREATE INDEX provider_sessions_run_created
    ON provider_sessions(workspace_id, run_id, created_at, id)`,

  `CREATE INDEX provider_sessions_status_updated
    ON provider_sessions(workspace_id, status, updated_at, id)`,

  `CREATE INDEX provider_sessions_config_version
    ON provider_sessions(provider_config_id, provider_config_version, created_at, id)`,

  `CREATE INDEX provider_sessions_native_session
    ON provider_sessions(workspace_id, provider_type, native_session_id)
    WHERE native_session_id IS NOT NULL`,

  `CREATE TRIGGER provider_sessions_identity_immutable
  BEFORE UPDATE ON provider_sessions
  WHEN NEW.id IS NOT OLD.id
    OR NEW.workspace_id IS NOT OLD.workspace_id
    OR NEW.task_id IS NOT OLD.task_id
    OR NEW.run_id IS NOT OLD.run_id
    OR NEW.stage_id IS NOT OLD.stage_id
    OR NEW.stage_attempt IS NOT OLD.stage_attempt
    OR NEW.authority_role IS NOT OLD.authority_role
    OR NEW.agent_id IS NOT OLD.agent_id
    OR NEW.provider_config_id IS NOT OLD.provider_config_id
    OR NEW.provider_config_version IS NOT OLD.provider_config_version
    OR NEW.provider_type IS NOT OLD.provider_type
    OR NEW.adapter_id IS NOT OLD.adapter_id
    OR NEW.adapter_version IS NOT OLD.adapter_version
    OR NEW.config_schema_version IS NOT OLD.config_schema_version
    OR NEW.runtime_mode IS NOT OLD.runtime_mode
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN
    SELECT RAISE(ABORT, 'PROVIDER_SESSION_IDENTITY_IMMUTABLE');
  END`,

  `CREATE TRIGGER provider_sessions_terminal_immutable
  BEFORE UPDATE ON provider_sessions
  WHEN OLD.status IN ('completed','failed','cancelled')
    AND (NEW.id IS NOT OLD.id
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.task_id IS NOT OLD.task_id
      OR NEW.run_id IS NOT OLD.run_id
      OR NEW.stage_id IS NOT OLD.stage_id
      OR NEW.stage_attempt IS NOT OLD.stage_attempt
      OR NEW.authority_role IS NOT OLD.authority_role
      OR NEW.agent_id IS NOT OLD.agent_id
      OR NEW.provider_config_id IS NOT OLD.provider_config_id
      OR NEW.provider_config_version IS NOT OLD.provider_config_version
      OR NEW.provider_type IS NOT OLD.provider_type
      OR NEW.adapter_id IS NOT OLD.adapter_id
      OR NEW.adapter_version IS NOT OLD.adapter_version
      OR NEW.config_schema_version IS NOT OLD.config_schema_version
      OR NEW.runtime_mode IS NOT OLD.runtime_mode
      OR NEW.native_session_id IS NOT OLD.native_session_id
      OR NEW.status IS NOT OLD.status
      OR NEW.claim_epoch IS NOT OLD.claim_epoch
      OR NEW.claim_owner_id IS NOT OLD.claim_owner_id
      OR NEW.claim_lease_expires_at IS NOT OLD.claim_lease_expires_at
      OR NEW.adapter_start_requested_at IS NOT OLD.adapter_start_requested_at
      OR NEW.capabilities_json IS NOT OLD.capabilities_json
      OR NEW.error_code IS NOT OLD.error_code
      OR NEW.error_detail_redacted IS NOT OLD.error_detail_redacted
      OR NEW.started_at IS NOT OLD.started_at
      OR NEW.last_activity_at IS NOT OLD.last_activity_at
      OR NEW.completed_at IS NOT OLD.completed_at
      OR NEW.created_at IS NOT OLD.created_at)
  BEGIN
    SELECT RAISE(ABORT, 'PROVIDER_SESSION_TERMINAL_IMMUTABLE');
  END`,

  `CREATE TRIGGER provider_sessions_reject_delete
  BEFORE DELETE ON provider_sessions
  BEGIN
    SELECT RAISE(ABORT, 'PROVIDER_SESSION_REJECT_DELETE');
  END`,

  `CREATE TABLE runtime_processes (
    id TEXT NOT NULL PRIMARY KEY
      CHECK (length(id) = 31 AND substr(id, 1, 5) = 'proc_'),
    workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    stage_id TEXT,
    stage_attempt INTEGER CHECK (stage_attempt IS NULL OR stage_attempt >= 1),
    provider_session_id TEXT,
    parent_process_id TEXT,
    authority_role TEXT CHECK (authority_role IS NULL OR authority_role = 'primary-provider'),
    claim_epoch INTEGER NOT NULL CHECK (claim_epoch >= 1),
    claim_owner_id TEXT,
    claim_lease_expires_at TEXT,
    process_type TEXT NOT NULL CHECK (process_type IN ('provider','tool','command','git','test','system','extension')),
    platform TEXT NOT NULL CHECK (length(platform) > 0),
    status TEXT NOT NULL CHECK (status IN ('created','starting','running','waiting','stopping','exited','failed','orphaned','unknown')),
    executable_resolved TEXT NOT NULL,
    executable_fingerprint TEXT,
    args_redacted_json TEXT NOT NULL CHECK (json_valid(args_redacted_json)),
    cwd_resolved TEXT NOT NULL,
    shell INTEGER NOT NULL CHECK (shell IN (0,1)),
    detached INTEGER NOT NULL CHECK (detached IN (0,1)),
    stdin_mode TEXT NOT NULL CHECK (stdin_mode IN ('closed','pipe')),
    stdout_mode TEXT NOT NULL CHECK (stdout_mode IN ('capture','null')),
    stderr_mode TEXT NOT NULL CHECK (stderr_mode IN ('capture','null')),
    timeout_policy_json TEXT NOT NULL CHECK (json_valid(timeout_policy_json)),
    security_profile_ref TEXT NOT NULL,
    native_pid INTEGER CHECK (native_pid IS NULL OR native_pid > 0),
    native_parent_pid INTEGER CHECK (native_parent_pid IS NULL OR native_parent_pid > 0),
    native_started_at TEXT,
    process_group_id TEXT,
    tree_ownership_mode TEXT,
    platform_handle_id TEXT,
    recovery_token_hash TEXT,
    recovery_classification TEXT CHECK (recovery_classification IS NULL OR recovery_classification IN ('same','missing','mismatch','unknown')),
    recovery_evidence_json TEXT CHECK (recovery_evidence_json IS NULL OR json_valid(recovery_evidence_json)),
    recovery_checked_at TEXT,
    recovery_classifier_version TEXT,
    started_at TEXT,
    ready_at TEXT,
    last_activity_at TEXT,
    stopping_at TEXT,
    exited_at TEXT,
    exit_code INTEGER,
    exit_signal TEXT,
    termination_reason TEXT,
    cleanup_result TEXT CHECK (cleanup_result IS NULL OR cleanup_result IN ('TERMINATED','ALREADY_EXITED','SURVIVORS','IDENTITY_MISMATCH','UNKNOWN_PLATFORM_UNAVAILABLE')),
    survivor_pids_redacted_json TEXT CHECK (survivor_pids_redacted_json IS NULL OR json_valid(survivor_pids_redacted_json)),
    error_code TEXT,
    error_detail_redacted TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    CHECK ((claim_owner_id IS NULL AND claim_lease_expires_at IS NULL) OR (claim_owner_id IS NOT NULL AND claim_lease_expires_at IS NOT NULL)),
    CHECK (authority_role IS NULL OR (provider_session_id IS NOT NULL AND stage_id IS NOT NULL AND stage_attempt IS NOT NULL AND parent_process_id IS NULL)),
    CHECK (provider_session_id IS NULL OR (stage_id IS NOT NULL AND stage_attempt IS NOT NULL)),
    CHECK (status <> 'created' OR (native_pid IS NULL AND native_started_at IS NULL)),
    CHECK (status <> 'running' OR (native_pid IS NOT NULL AND native_started_at IS NOT NULL AND started_at IS NOT NULL)),
    CHECK (status NOT IN ('exited','failed') OR exited_at IS NOT NULL),
    CHECK (parent_process_id IS NULL OR parent_process_id <> id),
    UNIQUE (id, workspace_id, run_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
    FOREIGN KEY (run_id, workspace_id, task_id)
      REFERENCES runs(id, workspace_id, task_id) ON DELETE RESTRICT,
    FOREIGN KEY (stage_id, workspace_id, run_id, stage_attempt)
      REFERENCES run_stages(id, workspace_id, run_id, attempt) ON DELETE RESTRICT,
    FOREIGN KEY (provider_session_id, workspace_id, run_id, stage_id, stage_attempt)
      REFERENCES provider_sessions(id, workspace_id, run_id, stage_id, stage_attempt) ON DELETE RESTRICT,
    FOREIGN KEY (parent_process_id, workspace_id, run_id)
      REFERENCES runtime_processes(id, workspace_id, run_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
  )`,

  `CREATE UNIQUE INDEX runtime_processes_root_claim_unique
    ON runtime_processes(workspace_id, run_id, stage_id, stage_attempt, authority_role)
    WHERE parent_process_id IS NULL AND authority_role IS NOT NULL`,

  `CREATE INDEX runtime_processes_run_created
    ON runtime_processes(workspace_id, run_id, created_at, id)`,

  `CREATE INDEX runtime_processes_stage_attempt
    ON runtime_processes(workspace_id, stage_id, stage_attempt, created_at, id)`,

  `CREATE INDEX runtime_processes_status_updated
    ON runtime_processes(workspace_id, status, updated_at, id)`,

  `CREATE INDEX runtime_processes_session
    ON runtime_processes(provider_session_id, created_at, id)`,

  `CREATE INDEX runtime_processes_parent
    ON runtime_processes(parent_process_id, created_at, id)`,

  `CREATE INDEX runtime_processes_native_identity
    ON runtime_processes(platform, native_pid, native_started_at)`,

  `CREATE TRIGGER runtime_processes_identity_immutable
  BEFORE UPDATE ON runtime_processes
  WHEN NEW.id IS NOT OLD.id
    OR NEW.workspace_id IS NOT OLD.workspace_id
    OR NEW.task_id IS NOT OLD.task_id
    OR NEW.run_id IS NOT OLD.run_id
    OR NEW.stage_id IS NOT OLD.stage_id
    OR NEW.stage_attempt IS NOT OLD.stage_attempt
    OR NEW.provider_session_id IS NOT OLD.provider_session_id
    OR NEW.parent_process_id IS NOT OLD.parent_process_id
    OR NEW.authority_role IS NOT OLD.authority_role
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_PROCESS_IDENTITY_IMMUTABLE');
  END`,

  `CREATE TRIGGER runtime_processes_terminal_immutable
  BEFORE UPDATE ON runtime_processes
  WHEN OLD.status IN ('exited','failed')
    AND (NEW.id IS NOT OLD.id
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.task_id IS NOT OLD.task_id
      OR NEW.run_id IS NOT OLD.run_id
      OR NEW.stage_id IS NOT OLD.stage_id
      OR NEW.stage_attempt IS NOT OLD.stage_attempt
      OR NEW.provider_session_id IS NOT OLD.provider_session_id
      OR NEW.parent_process_id IS NOT OLD.parent_process_id
      OR NEW.authority_role IS NOT OLD.authority_role
      OR NEW.claim_epoch IS NOT OLD.claim_epoch
      OR NEW.claim_owner_id IS NOT OLD.claim_owner_id
      OR NEW.claim_lease_expires_at IS NOT OLD.claim_lease_expires_at
      OR NEW.process_type IS NOT OLD.process_type
      OR NEW.platform IS NOT OLD.platform
      OR NEW.status IS NOT OLD.status
      OR NEW.executable_resolved IS NOT OLD.executable_resolved
      OR NEW.executable_fingerprint IS NOT OLD.executable_fingerprint
      OR NEW.args_redacted_json IS NOT OLD.args_redacted_json
      OR NEW.cwd_resolved IS NOT OLD.cwd_resolved
      OR NEW.shell IS NOT OLD.shell
      OR NEW.detached IS NOT OLD.detached
      OR NEW.stdin_mode IS NOT OLD.stdin_mode
      OR NEW.stdout_mode IS NOT OLD.stdout_mode
      OR NEW.stderr_mode IS NOT OLD.stderr_mode
      OR NEW.timeout_policy_json IS NOT OLD.timeout_policy_json
      OR NEW.security_profile_ref IS NOT OLD.security_profile_ref
      OR NEW.native_pid IS NOT OLD.native_pid
      OR NEW.native_parent_pid IS NOT OLD.native_parent_pid
      OR NEW.native_started_at IS NOT OLD.native_started_at
      OR NEW.process_group_id IS NOT OLD.process_group_id
      OR NEW.tree_ownership_mode IS NOT OLD.tree_ownership_mode
      OR NEW.platform_handle_id IS NOT OLD.platform_handle_id
      OR NEW.recovery_token_hash IS NOT OLD.recovery_token_hash
      OR NEW.recovery_classification IS NOT OLD.recovery_classification
      OR NEW.recovery_evidence_json IS NOT OLD.recovery_evidence_json
      OR NEW.recovery_checked_at IS NOT OLD.recovery_checked_at
      OR NEW.recovery_classifier_version IS NOT OLD.recovery_classifier_version
      OR NEW.started_at IS NOT OLD.started_at
      OR NEW.ready_at IS NOT OLD.ready_at
      OR NEW.last_activity_at IS NOT OLD.last_activity_at
      OR NEW.stopping_at IS NOT OLD.stopping_at
      OR NEW.exited_at IS NOT OLD.exited_at
      OR NEW.exit_code IS NOT OLD.exit_code
      OR NEW.exit_signal IS NOT OLD.exit_signal
      OR NEW.termination_reason IS NOT OLD.termination_reason
      OR NEW.cleanup_result IS NOT OLD.cleanup_result
      OR NEW.survivor_pids_redacted_json IS NOT OLD.survivor_pids_redacted_json
      OR NEW.error_code IS NOT OLD.error_code
      OR NEW.error_detail_redacted IS NOT OLD.error_detail_redacted
      OR NEW.created_at IS NOT OLD.created_at)
  BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_PROCESS_TERMINAL_IMMUTABLE');
  END`,

  `CREATE TRIGGER runtime_processes_reject_delete
  BEFORE DELETE ON runtime_processes
  BEGIN
    SELECT RAISE(ABORT, 'RUNTIME_PROCESS_REJECT_DELETE');
  END`,

  `CREATE TABLE process_output_references (
    process_id TEXT NOT NULL,
    stream TEXT NOT NULL CHECK (stream IN ('stdout','stderr')),
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL UNIQUE
      CHECK (length(artifact_id) = 35 AND substr(artifact_id, 1, 9) = 'artifact_'),
    storage_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    encoding TEXT NOT NULL,
    access_classification TEXT NOT NULL CHECK (access_classification = 'restricted'),
    redaction_mode TEXT NOT NULL CHECK (redaction_mode IN ('scan','strict')),
    source_bytes_seen INTEGER NOT NULL CHECK (source_bytes_seen >= 0),
    retained_bytes INTEGER NOT NULL CHECK (retained_bytes >= 0),
    next_source_offset INTEGER NOT NULL CHECK (next_source_offset >= 0),
    segment_count INTEGER NOT NULL CHECK (segment_count >= 0),
    truncated INTEGER NOT NULL CHECK (truncated IN (0,1)),
    truncation_reason TEXT CHECK (truncated = 1 OR truncation_reason IS NULL),
    finalized INTEGER NOT NULL CHECK (finalized IN (0,1)),
    sha256 TEXT CHECK (sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finalized_at TEXT,
    archived_at TEXT,
    PRIMARY KEY (process_id, stream),
    CHECK (retained_bytes <= source_bytes_seen),
    CHECK (next_source_offset <= source_bytes_seen),
    CHECK (finalized = 0 OR (finalized_at IS NOT NULL AND sha256 IS NOT NULL)),
    FOREIGN KEY (process_id, workspace_id, run_id)
      REFERENCES runtime_processes(id, workspace_id, run_id) ON DELETE RESTRICT
  )`,

  `CREATE INDEX process_output_references_run_process
    ON process_output_references(workspace_id, run_id, process_id, stream)`,

  `CREATE INDEX process_output_references_finalized
    ON process_output_references(workspace_id, finalized, updated_at, process_id)`,

  `CREATE TRIGGER process_output_references_identity_immutable
  BEFORE UPDATE ON process_output_references
  WHEN NEW.process_id IS NOT OLD.process_id
    OR NEW.stream IS NOT OLD.stream
    OR NEW.workspace_id IS NOT OLD.workspace_id
    OR NEW.run_id IS NOT OLD.run_id
    OR NEW.artifact_id IS NOT OLD.artifact_id
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN
    SELECT RAISE(ABORT, 'PROCESS_OUTPUT_IDENTITY_IMMUTABLE');
  END`,

  `CREATE TRIGGER process_output_references_monotonic
  BEFORE UPDATE ON process_output_references
  WHEN NEW.source_bytes_seen < OLD.source_bytes_seen
    OR NEW.retained_bytes < OLD.retained_bytes
    OR NEW.next_source_offset < OLD.next_source_offset
    OR NEW.segment_count < OLD.segment_count
  BEGIN
    SELECT RAISE(ABORT, 'PROCESS_OUTPUT_MONOTONIC');
  END`,

  `CREATE TRIGGER process_output_references_finalized_immutable
  BEFORE UPDATE ON process_output_references
  WHEN OLD.finalized = 1
    AND (NEW.process_id IS NOT OLD.process_id
      OR NEW.stream IS NOT OLD.stream
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.run_id IS NOT OLD.run_id
      OR NEW.artifact_id IS NOT OLD.artifact_id
      OR NEW.storage_key IS NOT OLD.storage_key
      OR NEW.content_type IS NOT OLD.content_type
      OR NEW.encoding IS NOT OLD.encoding
      OR NEW.access_classification IS NOT OLD.access_classification
      OR NEW.redaction_mode IS NOT OLD.redaction_mode
      OR NEW.source_bytes_seen IS NOT OLD.source_bytes_seen
      OR NEW.retained_bytes IS NOT OLD.retained_bytes
      OR NEW.next_source_offset IS NOT OLD.next_source_offset
      OR NEW.segment_count IS NOT OLD.segment_count
      OR NEW.truncated IS NOT OLD.truncated
      OR NEW.truncation_reason IS NOT OLD.truncation_reason
      OR NEW.finalized IS NOT OLD.finalized
      OR NEW.sha256 IS NOT OLD.sha256
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.finalized_at IS NOT OLD.finalized_at)
  BEGIN
    SELECT RAISE(ABORT, 'PROCESS_OUTPUT_FINALIZED_IMMUTABLE');
  END`,

  `CREATE TRIGGER process_output_references_reject_delete
  BEFORE DELETE ON process_output_references
  BEGIN
    SELECT RAISE(ABORT, 'PROCESS_OUTPUT_REJECT_DELETE');
  END`,
]);

/**
 * Supporting unique keys on pre-existing parent tables must hold before any
 * 014 DDL runs. A violation fails the migration closed inside the runner's
 * BEGIN IMMEDIATE transaction, so no partial DDL can survive.
 */
const M4_P2_014_PARENT_KEY_PRECHECKS = Object.freeze([
  { table: 'provider_configurations', columns: 'id, workspace_id' },
  { table: 'runs', columns: 'id, workspace_id, task_id' },
  { table: 'run_stages', columns: 'id, workspace_id, run_id, attempt' },
]);

function assertNoDuplicateParentKeys(db: MinimalDatabaseSync): void {
  for (const precheck of M4_P2_014_PARENT_KEY_PRECHECKS) {
    const duplicates = db.prepare(
      'SELECT ' + precheck.columns + ', COUNT(*) AS duplicate_count FROM ' + precheck.table
      + ' GROUP BY ' + precheck.columns + ' HAVING COUNT(*) > 1 LIMIT 1',
    ).all();
    if (duplicates.length > 0) {
      throw new Error(
        'MIGRATION_014_PARENT_KEY_DUPLICATE: ' + precheck.table
        + ' contains duplicate (' + precheck.columns + ') values; refusing to apply any 014 DDL',
      );
    }
  }
}

const CANONICAL_SOURCE = M4_P2_014_DDL_STATEMENTS.join('\n');

export const migration014Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration014: Migration = {
  id: '014',
  name: 'm4-process-runtime-schema',
  checksum: migration014Checksum,
  destructive: true,
  apply(ctx: MigrationContext): void {
    assertNoDuplicateParentKeys(ctx.db);
    for (const statement of M4_P2_014_DDL_STATEMENTS) {
      ctx.db.exec(statement);
    }
  },
};
