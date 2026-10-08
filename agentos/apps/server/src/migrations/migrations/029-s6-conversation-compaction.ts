import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * S6 conversation compaction persistence (authorization:
 * S6-compaction-authorization.md). Additive only: one immutable versioned
 * policy table and one durable task/summary table. 001-028 stay unchanged.
 */
export const S6_COMPACTION_029_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE conversation_compaction_policies (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    policy_version TEXT NOT NULL UNIQUE CHECK (length(policy_version) > 0),
    trigger_ratio REAL NOT NULL CHECK (trigger_ratio > 0 AND trigger_ratio < 1),
    target_ratio REAL NOT NULL CHECK (target_ratio > 0 AND target_ratio < 1),
    min_recent_messages INTEGER NOT NULL CHECK (min_recent_messages >= 1),
    summary_max_tokens INTEGER NOT NULL CHECK (summary_max_tokens >= 1),
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms >= 1),
    max_automatic_retries INTEGER NOT NULL CHECK (max_automatic_retries >= 0),
    fallback_application_budget_tokens INTEGER NOT NULL CHECK (fallback_application_budget_tokens >= 1),
    parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
    checksum TEXT NOT NULL CHECK (length(checksum) = 64),
    created_at TEXT NOT NULL
  )`,
  `CREATE TRIGGER conversation_compaction_policies_immutable
    BEFORE UPDATE ON conversation_compaction_policies
    BEGIN SELECT RAISE(ABORT, 'COMPACTION_POLICY_IMMUTABLE'); END`,
  `CREATE TABLE conversation_compactions (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','running','published','failed','retry-pending')),
    policy_id TEXT NOT NULL,
    source_start_message_id TEXT,
    source_end_message_id TEXT,
    source_message_count INTEGER NOT NULL CHECK (source_message_count >= 0),
    source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
    prior_summary_id TEXT,
    summary TEXT,
    summary_hash TEXT CHECK (summary_hash IS NULL OR length(summary_hash) = 64),
    summary_token_estimate INTEGER,
    budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
    provider_config_id TEXT,
    provider_type TEXT,
    adapter_id TEXT,
    adapter_version TEXT,
    model TEXT,
    estimator_version TEXT NOT NULL CHECK (length(estimator_version) > 0),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_owner TEXT,
    lease_expires_at TEXT,
    candidate_id TEXT,
    failure_code TEXT,
    failure_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (status <> 'published' OR (summary IS NOT NULL AND summary_hash IS NOT NULL AND published_at IS NOT NULL AND candidate_id IS NOT NULL)),
    CHECK ((status = 'running') = (lease_owner IS NOT NULL)),
    CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id, workspace_id) REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (policy_id) REFERENCES conversation_compaction_policies(id) ON DELETE RESTRICT,
    FOREIGN KEY (prior_summary_id) REFERENCES conversation_compactions(id) ON DELETE RESTRICT,
    FOREIGN KEY (candidate_id) REFERENCES memory_candidate_entries(id) ON DELETE RESTRICT
  )`,
  `CREATE INDEX conversation_compactions_conversation
    ON conversation_compactions (workspace_id, conversation_id, created_at, id)`,
  `CREATE UNIQUE INDEX conversation_compactions_one_running
    ON conversation_compactions (conversation_id)
    WHERE status = 'running'`,
  `CREATE UNIQUE INDEX conversation_compactions_one_published_source
    ON conversation_compactions (conversation_id, source_hash)
    WHERE status = 'published'`,
  `CREATE TRIGGER conversation_compactions_identity_immutable
    BEFORE UPDATE ON conversation_compactions
    WHEN NEW.id IS NOT OLD.id
      OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.conversation_id IS NOT OLD.conversation_id
      OR NEW.policy_id IS NOT OLD.policy_id
      OR NEW.source_start_message_id IS NOT OLD.source_start_message_id
      OR NEW.source_end_message_id IS NOT OLD.source_end_message_id
      OR NEW.source_message_count IS NOT OLD.source_message_count
      OR NEW.source_hash IS NOT OLD.source_hash
      OR NEW.prior_summary_id IS NOT OLD.prior_summary_id
      OR NEW.budget_json IS NOT OLD.budget_json
      OR NEW.provider_config_id IS NOT OLD.provider_config_id
      OR NEW.provider_type IS NOT OLD.provider_type
      OR NEW.adapter_id IS NOT OLD.adapter_id
      OR NEW.adapter_version IS NOT OLD.adapter_version
      OR NEW.model IS NOT OLD.model
      OR NEW.estimator_version IS NOT OLD.estimator_version
      OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT, 'COMPACTION_IDENTITY_IMMUTABLE'); END`,
  `CREATE TRIGGER conversation_compactions_published_immutable
    BEFORE UPDATE ON conversation_compactions
    WHEN OLD.status = 'published'
      AND (NEW.summary IS NOT OLD.summary
        OR NEW.summary_hash IS NOT OLD.summary_hash
        OR NEW.summary_token_estimate IS NOT OLD.summary_token_estimate
        OR NEW.candidate_id IS NOT OLD.candidate_id
        OR NEW.published_at IS NOT OLD.published_at)
    BEGIN SELECT RAISE(ABORT, 'COMPACTION_PUBLISHED_IMMUTABLE'); END`,
]);

export const migration029Checksum = createHash('sha256')
  .update(S6_COMPACTION_029_DDL_STATEMENTS.join('\n')).digest('hex').slice(0, 16);

export const migration029: Migration = {
  id: '029',
  name: 's6-conversation-compaction',
  checksum: migration029Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const table of ['workspaces', 'cr_conversations', 'memory_candidate_entries']) {
      if (ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) {
        throw new Error('MIGRATION_PREREQUISITE_MISSING: 029 requires ' + table);
      }
    }
    for (const sql of S6_COMPACTION_029_DDL_STATEMENTS) ctx.db.exec(sql);
  },
};

