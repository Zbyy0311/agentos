import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * Migration 001: baseline schema matching the current SqliteStore.migrateSchema() output.
 *
 * This migration captures all 25+ user tables, indexes, triggers, and FTS5 tables
 * as defined in SqliteStore.migrateSchema() at commit 5c34cb7e.
 *
 * The checksum is a frozen hash of the canonical DDL text. Any DDL change
 * must be a new migration, not a modification to this file.
 */
const DDL_STATEMENTS = [
  // agent_profiles
  `CREATE TABLE IF NOT EXISTS agent_profiles (
    workspace_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    agent_role TEXT NOT NULL,
    provider TEXT,
    role_title TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    cli_command TEXT NOT NULL,
    cli_args_json TEXT NOT NULL,
    model TEXT,
    thinking_effort TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id)
  )`,

  // conversations
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    conversation_type TEXT NOT NULL CHECK (conversation_type IN ('direct', 'group')),
    title TEXT NOT NULL,
    agent_id TEXT,
    model TEXT,
    thinking_effort TEXT,
    dispatch_mode TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS conversations_workspace_updated ON conversations (workspace_id, updated_at DESC)`,

  // conversation_members
  `CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    role_title TEXT NOT NULL,
    is_leader INTEGER NOT NULL DEFAULT 0,
    role_kind TEXT NOT NULL DEFAULT 'worker',
    sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, agent_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_members_conversation_sequence ON conversation_members (conversation_id, sequence)`,

  // messages
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'system')),
    sender_agent_id TEXT,
    run_id TEXT,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS messages_conversation_created ON messages (conversation_id, created_at DESC)`,

  // message_attachments
  `CREATE TABLE IF NOT EXISTS message_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS message_attachments_conversation ON message_attachments (conversation_id, id)`,
  `CREATE INDEX IF NOT EXISTS message_attachments_workspace ON message_attachments (workspace_id, id)`,

  // executions
  `CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    conversation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('real', 'mock')),
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS executions_conversation_updated ON executions (conversation_id, updated_at DESC)`,

  // agent_runs
  `CREATE TABLE IF NOT EXISTS agent_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL,
    result_summary TEXT,
    failure_reason TEXT,
    started_at TEXT,
    completed_at TEXT,
    waiting_question TEXT,
    waiting_execution_id TEXT,
    waiting_agent_id TEXT,
    intent TEXT NOT NULL DEFAULT 'execute',
    runtime_policy_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE RESTRICT
  )`,
  `CREATE INDEX IF NOT EXISTS agent_runs_conversation_updated ON agent_runs (conversation_id, updated_at DESC)`,

  // run_steps
  `CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY,
    stable_step_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    parent_step_id TEXT,
    execution_id TEXT,
    agent_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    created_event_sequence INTEGER NOT NULL,
    updated_event_sequence INTEGER NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS run_steps_stable_key ON run_steps (run_id, stable_step_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS run_steps_sibling_sequence ON run_steps (run_id, IFNULL(parent_step_id, ''), sequence)`,

  // execution_events
  `CREATE TABLE IF NOT EXISTS execution_events (
    id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    status TEXT NOT NULL,
    activity TEXT NOT NULL,
    content TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS execution_events_execution_created ON execution_events (execution_id, created_at ASC)`,

  // agent_events
  `CREATE TABLE IF NOT EXISTS agent_events (
    event_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    execution_id TEXT,
    agent_id TEXT,
    sequence INTEGER,
    timestamp TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS agent_events_workspace_run_timestamp ON agent_events (workspace_id, run_id, timestamp ASC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS agent_events_run_sequence ON agent_events (run_id, sequence)`,

  // run_event_sequences
  `CREATE TABLE IF NOT EXISTS run_event_sequences (
    run_id TEXT PRIMARY KEY,
    next_sequence INTEGER NOT NULL
  )`,

  // run_cli_invocations
  `CREATE TABLE IF NOT EXISTS run_cli_invocations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    cli_kind TEXT NOT NULL,
    command_label TEXT NOT NULL,
    configured_provider TEXT,
    detected_provider TEXT,
    provider_mismatch INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    thinking_effort TEXT,
    exit_code INTEGER,
    duration_ms INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS run_cli_invocations_run_started ON run_cli_invocations (run_id, started_at ASC)`,

  // run_file_changes
  `CREATE TABLE IF NOT EXISTS run_file_changes (
    run_id TEXT NOT NULL,
    path TEXT NOT NULL,
    change_type TEXT NOT NULL,
    PRIMARY KEY (run_id, path, change_type),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  )`,

  // run_decisions
  `CREATE TABLE IF NOT EXISTS run_decisions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_changes_json TEXT NOT NULL,
    allowed_decisions_json TEXT NOT NULL,
    resolved_decision TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    UNIQUE (run_id, execution_id, kind),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (execution_id) REFERENCES executions(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS run_decisions_workspace_run ON run_decisions (workspace_id, run_id, created_at DESC)`,

  // runtime_artifacts
  `CREATE TABLE IF NOT EXISTS runtime_artifacts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_execution_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    artifact_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    original_path TEXT,
    storage_key TEXT,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT,
    content_available INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (source_execution_id) REFERENCES executions(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS runtime_artifacts_run_created ON runtime_artifacts (workspace_id, run_id, created_at, id)`,

  // memories
  `CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    content_path TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    related_files_json TEXT NOT NULL,
    importance INTEGER NOT NULL,
    confidence INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_accessed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS memories_workspace_updated ON memories (workspace_id, status, updated_at DESC)`,

  // memory_sources
  `CREATE TABLE IF NOT EXISTS memory_sources (
    memory_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    PRIMARY KEY (memory_id, run_id),
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  )`,

  // memory_fts
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    memory_id UNINDEXED, title, summary, content, tags
  )`,

  // run_memory_usage
  `CREATE TABLE IF NOT EXISTS run_memory_usage (
    run_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    injected_characters INTEGER NOT NULL,
    used_at TEXT NOT NULL,
    PRIMARY KEY (run_id, memory_id),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
  )`,

  // memory_candidates
  `CREATE TABLE IF NOT EXISTS memory_candidates (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    memory_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT NOT NULL,
    confidence INTEGER NOT NULL,
    operation TEXT NOT NULL,
    conflicting_memory_ids_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reviewed_at TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS memory_candidates_workspace_status_created ON memory_candidates (workspace_id, status, created_at DESC)`,

  // user_profiles
  `CREATE TABLE IF NOT EXISTS user_profiles (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    learning_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  // preference_evidence
  `CREATE TABLE IF NOT EXISTS preference_evidence (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    workspace_id TEXT,
    conversation_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    dimension TEXT NOT NULL,
    context_kind TEXT NOT NULL,
    candidate_value TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    polarity TEXT NOT NULL,
    weight INTEGER NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (profile_id, source_event_id, dimension, context_kind, candidate_value, signal_type, polarity),
    FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS preference_evidence_profile_scope_time ON preference_evidence (profile_id, workspace_id, observed_at ASC)`,

  // preference_projections
  `CREATE TABLE IF NOT EXISTS preference_projections (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    workspace_id TEXT,
    dimension TEXT NOT NULL,
    context_kind TEXT NOT NULL,
    preferred_value TEXT NOT NULL,
    confidence INTEGER NOT NULL,
    score INTEGER NOT NULL,
    evidence_count INTEGER NOT NULL,
    independent_run_count INTEGER NOT NULL,
    status TEXT NOT NULL,
    last_supported_at TEXT NOT NULL,
    last_conflicted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (profile_id, scope, workspace_id, dimension, context_kind),
    FOREIGN KEY (profile_id) REFERENCES user_profiles(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS preference_projections_profile_scope_status ON preference_projections (profile_id, scope, workspace_id, status, updated_at DESC)`,

  // preference_projection_evidence
  `CREATE TABLE IF NOT EXISTS preference_projection_evidence (
    projection_id TEXT NOT NULL,
    evidence_id TEXT NOT NULL,
    contribution INTEGER NOT NULL,
    PRIMARY KEY (projection_id, evidence_id),
    FOREIGN KEY (projection_id) REFERENCES preference_projections(id) ON DELETE CASCADE,
    FOREIGN KEY (evidence_id) REFERENCES preference_evidence(id) ON DELETE CASCADE
  )`,

  // preference_applications
  `CREATE TABLE IF NOT EXISTS preference_applications (
    run_id TEXT NOT NULL,
    projection_id TEXT NOT NULL,
    resolved_value TEXT NOT NULL,
    rank INTEGER NOT NULL,
    injected_characters INTEGER NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (run_id, projection_id),
    FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS preference_applications_run_rank ON preference_applications (run_id, rank ASC)`,

  // Ensure default user profile
  `INSERT OR IGNORE INTO user_profiles (id, display_name, learning_enabled, created_at, updated_at)
   VALUES ('default', '本地用户', 1, '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z')`,
];

export const BASELINE_DDL = DDL_STATEMENTS;

export function computeBaselineChecksum(): string {
  const hash = createHash('sha256');
  for (const stmt of DDL_STATEMENTS) {
    hash.update(stmt.replace(/\s+/g, ' ').trim());
  }
  return hash.digest('hex').slice(0, 16);
}

export const BASELINE_CHECKSUM = computeBaselineChecksum();

export const baselineMigration: Migration = {
  id: '001',
  name: 'baseline-schema',
  checksum: BASELINE_CHECKSUM,
  apply(ctx: MigrationContext): void {
    for (const stmt of DDL_STATEMENTS) {
      ctx.db.exec(stmt);
    }
  },
};
