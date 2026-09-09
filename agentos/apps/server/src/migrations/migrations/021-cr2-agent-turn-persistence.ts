import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * CR-2 Agent Turn persistence (additive).
 *
 * Implements the Agent Turn and streaming checkpoint design from
 * `docs/Runtime-Specification lite/09-Conversation-Runtime.md` §4.4 and §8.
 * It creates:
 *   - cr_agent_turns          (bounded response attempt record)
 *   - cr_message_checkpoints  (ordered durable streaming deltas)
 * plus supporting indexes.
 *
 * Behavior:
 * - additive only; no historical migration, table, column, index, or trigger is
 *   modified and no table rebuild occurs (destructive = false);
 * - NO BACKFILL: baseline conversation rows are never reinterpreted;
 * - idempotent and self-guarding;
 * - PREREQUISITE FAIL-CLOSED: migration 021 requires the 020 schema.
 *
 * No secret value is stored.
 */

const REQUIRED_TABLES = Object.freeze(['cr_conversations', 'cr_messages']);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const missing = REQUIRED_TABLES.filter(
    table =>
      db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 021 (cr2-agent-turn-persistence) requires the 020 schema; missing tables: '
        + missing.join(', '),
    );
  }
}

/** Canonical DDL: the checksum source must cover every object 021 creates. */
export const CR2_021_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS cr_agent_turns (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    conversation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
    source_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'created' CHECK (status IN
      ('created','streaming','final','failed','cancelled')),
    failure_code TEXT,
    failure_message TEXT,
    context_snapshot_id TEXT,
    provider_session_id TEXT,
    task_id TEXT,
    run_id TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (conversation_id, workspace_id)
      REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (source_message_id) REFERENCES cr_messages(id) ON DELETE SET NULL
  )`,

  `CREATE INDEX IF NOT EXISTS cr_agent_turns_conversation
    ON cr_agent_turns (conversation_id, status, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS cr_agent_turns_workspace_agent
    ON cr_agent_turns (workspace_id, agent_id, status, created_at DESC)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS cr_agent_turns_id_workspace
    ON cr_agent_turns (id, workspace_id)`,

  `CREATE TABLE IF NOT EXISTS cr_message_checkpoints (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    message_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    cursor INTEGER NOT NULL CHECK (cursor >= 0),
    delta TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (message_id, ordinal),
    UNIQUE (turn_id, ordinal),
    FOREIGN KEY (message_id) REFERENCES cr_messages(id) ON DELETE CASCADE,
    FOREIGN KEY (turn_id) REFERENCES cr_agent_turns(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS cr_message_checkpoints_message
    ON cr_message_checkpoints (message_id, ordinal ASC)`,

  `CREATE INDEX IF NOT EXISTS cr_message_checkpoints_turn
    ON cr_message_checkpoints (turn_id, ordinal ASC)`,
]);

const CANONICAL_SOURCE = CR2_021_DDL_STATEMENTS.join('\n');

export const migration021Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration021: Migration = {
  id: '021',
  name: 'cr2-agent-turn-persistence',
  checksum: migration021Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    for (const statement of CR2_021_DDL_STATEMENTS) {
      ctx.db.prepare(statement).run();
    }
  },
};
