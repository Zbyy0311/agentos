import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * CR-1 Conversation Runtime persistence (additive).
 *
 * Implements exactly the frozen design in
 * `docs/implementation/milestones/CR1-schema-authorization.md`. It creates:
 *   - cr_conversations          (forward Conversation)
 *   - cr_conversation_members   (forward Member)
 *   - cr_messages               (forward Message, unique sequence + client idempotency)
 *   - cr_message_revisions      (append-only edit history)
 * plus supporting indexes and an identity-immutability trigger.
 *
 * Behavior:
 * - additive only; no historical migration, table, column, index, or trigger is
 *   modified and no table rebuild occurs (destructive = false);
 * - NO BACKFILL: baseline conversation rows are never reinterpreted and the
 *   legacy `agent_runs` conversation path is untouched;
 * - idempotent and self-guarding;
 * - PREREQUISITE FAIL-CLOSED: migration 020 requires the 019 schema.
 *
 * No secret value is stored.
 */

const REQUIRED_TABLES = Object.freeze(['workspaces', 'memory_conflicts']);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  const missing = REQUIRED_TABLES.filter(
    table =>
      db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table) === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      'MIGRATION_PREREQUISITE_MISSING: migration 020 (cr1-conversation-runtime-persistence) requires the 019 schema; missing tables: '
        + missing.join(', '),
    );
  }
}

/** Canonical DDL: the checksum source must cover every object 020 creates. */
export const CR1_020_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS cr_conversations (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('direct','group','system')),
    title TEXT NOT NULL CHECK (length(title) > 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
    reply_mode TEXT CHECK (reply_mode IN
      ('sequential','parallel-read-only','orchestrated','manual','mention-only')),
    last_message_id TEXT,
    last_message_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT,
    CHECK (kind <> 'direct' OR reply_mode IS NULL),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS cr_conversations_workspace_status
    ON cr_conversations (workspace_id, status, updated_at DESC, id)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS cr_conversations_id_workspace
    ON cr_conversations (id, workspace_id)`,

  `CREATE TABLE IF NOT EXISTS cr_conversation_members (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    conversation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user','agent')),
    subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
    display_name_snapshot TEXT NOT NULL CHECK (length(display_name_snapshot) > 0),
    role TEXT NOT NULL CHECK (role IN
      ('owner','participant','observer','orchestrator','reviewer')),
    reply_mode TEXT NOT NULL CHECK (reply_mode IN
      ('always','mentioned','orchestrated','manual','never')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','muted','removed')),
    joined_at TEXT NOT NULL,
    removed_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (conversation_id, subject_type, subject_id),
    FOREIGN KEY (conversation_id, workspace_id)
      REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS cr_conversation_members_conversation
    ON cr_conversation_members (conversation_id, status, role)`,

  `CREATE TABLE IF NOT EXISTS cr_messages (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    conversation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    sender_type TEXT NOT NULL CHECK (sender_type IN ('user','agent','system')),
    sender_agent_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN
      ('text','task-reference','run-reference','status','approval','artifact','error','system-notice')),
    status TEXT NOT NULL CHECK (status IN
      ('draft','streaming','final','failed','edited','deleted')),
    content TEXT NOT NULL DEFAULT '',
    client_message_id TEXT,
    task_id TEXT,
    run_id TEXT,
    source_event_id TEXT,
    reply_to_message_id TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (sender_type <> 'agent' OR sender_agent_id IS NOT NULL),
    UNIQUE (conversation_id, sequence),
    UNIQUE (conversation_id, client_message_id),
    FOREIGN KEY (conversation_id, workspace_id)
      REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (reply_to_message_id) REFERENCES cr_messages(id) ON DELETE SET NULL
  )`,

  `CREATE INDEX IF NOT EXISTS cr_messages_conversation_sequence
    ON cr_messages (conversation_id, sequence ASC)`,

  `CREATE INDEX IF NOT EXISTS cr_messages_source_event
    ON cr_messages (source_event_id)
    WHERE source_event_id IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS cr_message_revisions (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    message_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    content TEXT NOT NULL,
    edited_at TEXT NOT NULL,
    UNIQUE (message_id, revision),
    FOREIGN KEY (message_id) REFERENCES cr_messages(id) ON DELETE CASCADE
  )`,

  `CREATE INDEX IF NOT EXISTS cr_message_revisions_message
    ON cr_message_revisions (message_id, revision ASC)`,

  `CREATE TRIGGER IF NOT EXISTS cr_messages_identity_immutable
  BEFORE UPDATE ON cr_messages
  WHEN NEW.id IS NOT OLD.id
    OR NEW.conversation_id IS NOT OLD.conversation_id
    OR NEW.sequence IS NOT OLD.sequence
    OR NEW.created_at IS NOT OLD.created_at
  BEGIN
    SELECT RAISE(ABORT, 'CR_MESSAGE_IDENTITY_IMMUTABLE');
  END`,
]);

const CANONICAL_SOURCE = CR1_020_DDL_STATEMENTS.join('\n');

export const migration020Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration020: Migration = {
  id: '020',
  name: 'cr1-conversation-runtime-persistence',
  checksum: migration020Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    for (const statement of CR1_020_DDL_STATEMENTS) {
      ctx.db.prepare(statement).run();
    }
  },
};
