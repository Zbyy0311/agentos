import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * CR-4b Conversation message projection persistence (additive).
 *
 * Implements the idempotent Event projection design from
 * `docs/implementation/milestones/CR4-schema-authorization.md` section 5 and
 * `docs/Runtime-Specification lite/09-Conversation-Runtime.md` section 10.
 * It creates:
 *   - cr_message_projections  (idempotent projector-to-Event projection key)
 * plus supporting indexes.
 *
 * Behavior:
 * - additive only; no historical migration, table, column, index, or trigger is
 *   modified and no table rebuild occurs (destructive = false);
 * - NO BACKFILL: existing Messages are never reinterpreted or re-projected;
 * - idempotent and self-guarding;
 * - PREREQUISITE FAIL-CLOSED: migration 022 requires the 020 and 021 schema.
 *
 * No secret value is stored.
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
      'MIGRATION_PREREQUISITE_MISSING: migration 022 (cr4-message-projection-persistence) requires the 020 and 021 schema; missing tables: '
        + missing.join(', '),
    );
  }
}

/** Canonical DDL: the checksum source must cover every object 022 creates. */
export const CR4_022_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS cr_message_projections (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    conversation_id TEXT NOT NULL,
    projector_id TEXT NOT NULL CHECK (length(projector_id) > 0),
    source_event_id TEXT NOT NULL CHECK (length(source_event_id) > 0),
    message_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (projector_id, source_event_id),
    FOREIGN KEY (conversation_id, workspace_id)
      REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES cr_messages(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS cr_message_projections_conversation
    ON cr_message_projections (conversation_id, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS cr_message_projections_message
    ON cr_message_projections (message_id)`,
]);

const CANONICAL_SOURCE = CR4_022_DDL_STATEMENTS.join('\n');

export const migration022Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration022: Migration = {
  id: '022',
  name: 'cr4-message-projection-persistence',
  checksum: migration022Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    for (const statement of CR4_022_DDL_STATEMENTS) {
      ctx.db.prepare(statement).run();
    }
  },
};

