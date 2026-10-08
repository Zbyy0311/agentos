import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * CR-5 bounded Group Conversation persistence (additive).
 *
 * Implements exactly the frozen design in
 * `docs/implementation/milestones/CR5-schema-authorization.md`. It creates:
 *   - cr_group_interactions          (frozen budget + live counters + stop/loop state)
 *   - cr_group_interaction_replies   (per-reply accounting, hop lineage, guard evidence)
 *   - cr_turn_context_snapshots      (Turn-scoped per-Agent Memory Context selection)
 * plus supporting indexes.
 *
 * Behavior:
 * - additive only; no historical migration, table, column, index, or trigger is
 *   modified and no table rebuild occurs (destructive = false);
 * - NO BACKFILL: existing rows are never reinterpreted;
 * - idempotent and self-guarding;
 * - PREREQUISITE FAIL-CLOSED: migration 023 requires the 020 and 021 schema.
 *
 * No secret value is stored (reply content is a hash only).
 */

const REQUIRED_TABLES = Object.freeze(['cr_conversations', 'cr_messages', 'cr_agent_turns']);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const missing = REQUIRED_TABLES.filter(
    table =>
      db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 023 (cr5-bounded-group-persistence) requires the 020 and 021 schema; missing tables: '
        + missing.join(', '),
    );
  }
}

/** Canonical DDL: the checksum source must cover every object 023 creates. */
export const CR5_023_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS cr_group_interactions (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    conversation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    max_agents_per_turn INTEGER NOT NULL CHECK (max_agents_per_turn >= 1),
    max_replies_per_agent INTEGER NOT NULL CHECK (max_replies_per_agent >= 1),
    max_total_replies INTEGER NOT NULL CHECK (max_total_replies >= 1),
    max_agent_hops INTEGER NOT NULL CHECK (max_agent_hops >= 0),
    timeout_ms INTEGER,
    context_token_budget INTEGER,
    reply_count INTEGER NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
    hop_count INTEGER NOT NULL DEFAULT 0 CHECK (hop_count >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN
      ('active','stopped','exhausted','completed')),
    stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN
      ('budget-agents','budget-replies-per-agent','budget-total-replies','budget-hops',
       'budget-timeout','user-stop','loop-guard','completed')),
    loop_guard_signal TEXT CHECK (loop_guard_signal IS NULL OR loop_guard_signal IN
      ('same-agent-cycle','repeated-content','repeated-mention-no-new-information','hops-exceeded')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY (conversation_id, workspace_id)
      REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS cr_group_interactions_conversation
    ON cr_group_interactions (conversation_id, status, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS cr_group_interaction_replies (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    interaction_id TEXT NOT NULL,
    agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
    message_id TEXT NOT NULL,
    turn_id TEXT,
    content_hash TEXT NOT NULL CHECK (length(content_hash) > 0),
    mention_targets_json TEXT CHECK (mention_targets_json IS NULL OR json_valid(mention_targets_json)),
    hop_from_agent_id TEXT,
    hop_order INTEGER NOT NULL DEFAULT 0 CHECK (hop_order >= 0),
    context_snapshot_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (interaction_id) REFERENCES cr_group_interactions(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES cr_messages(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS cr_group_interaction_replies_interaction_agent
    ON cr_group_interaction_replies (interaction_id, agent_id, created_at ASC)`,

  `CREATE INDEX IF NOT EXISTS cr_group_interaction_replies_interaction_hash
    ON cr_group_interaction_replies (interaction_id, content_hash)`,

  `CREATE TABLE IF NOT EXISTS cr_turn_context_snapshots (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    conversation_id TEXT NOT NULL,
    interaction_id TEXT,
    agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
    turn_id TEXT,
    budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
    selected_entry_ids_json TEXT NOT NULL CHECK (json_valid(selected_entry_ids_json)),
    total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
    truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
    query_hash TEXT,
    retrieval_strategy_version TEXT NOT NULL CHECK (length(retrieval_strategy_version) > 0),
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id, workspace_id)
      REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (interaction_id) REFERENCES cr_group_interactions(id) ON DELETE SET NULL,
    FOREIGN KEY (turn_id) REFERENCES cr_agent_turns(id) ON DELETE SET NULL
  )`,

  `CREATE INDEX IF NOT EXISTS cr_turn_context_snapshots_turn
    ON cr_turn_context_snapshots (conversation_id, agent_id, created_at DESC)`,
]);

const CANONICAL_SOURCE = CR5_023_DDL_STATEMENTS.join('\n');

export const migration023Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration023: Migration = {
  id: '023',
  name: 'cr5-bounded-group-persistence',
  checksum: migration023Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    for (const statement of CR5_023_DDL_STATEMENTS) {
      ctx.db.prepare(statement).run();
    }
  },
};

