import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * Conversation message search (FTS5) + per-user Conversation Read State.
 *
 * Realizes Lite 09-Conversation-Runtime §68/§70/§71 and 10-Data-Model
 * §69 (conversation_read_states) / §90 (messages_fts):
 *
 *   - messages_fts: external-content-free FTS5 index over cr_messages content
 *     with the sender display name frozen from cr_conversation_members. It is
 *     kept in sync by three triggers (insert / content-update / delete), so a
 *     Message edit (cr_message_revisions + content UPDATE) re-indexes the new
 *     content automatically and Message deletion removes the index row.
 *   - conversation_read_states: one row per (conversation_id, user_id) holding
 *     the monotone last-read position. Unread/mention/approval counts are
 *     server-computed from sequence and the message text at read time; the
 *     count columns are a frozen snapshot of the last computation.
 *
 * Additive only (destructive = false), idempotent, fail-closed on the
 * cr_messages prerequisite. A one-time backfill indexes existing messages.
 */

const FTS_SYNC_SELECT_SENDER = `COALESCE(
    (SELECT display_name_snapshot FROM cr_conversation_members
      WHERE conversation_id = NEW.conversation_id
        AND subject_type = NEW.sender_type
        AND (NEW.sender_agent_id IS NULL OR subject_id = NEW.sender_agent_id)
      LIMIT 1),
    NEW.sender_type)`;

export const CONVERSATION_SEARCH_READSTATE_063_DDL = Object.freeze([
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    message_id UNINDEXED,
    conversation_id UNINDEXED,
    sender_display_name,
    content_text,
    task_text,
    run_text,
    tokenize = 'unicode61'
  )`,

  `CREATE TRIGGER IF NOT EXISTS cr_messages_fts_insert AFTER INSERT ON cr_messages
  BEGIN
    INSERT INTO messages_fts (message_id, conversation_id, sender_display_name, content_text, task_text, run_text)
    VALUES (NEW.id, NEW.conversation_id, ${FTS_SYNC_SELECT_SENDER}, NEW.content, NULL, NULL);
  END`,

  `CREATE TRIGGER IF NOT EXISTS cr_messages_fts_update AFTER UPDATE ON cr_messages
  WHEN OLD.content IS NOT NEW.content
    OR OLD.sender_type IS NOT NEW.sender_type
    OR OLD.sender_agent_id IS NOT NEW.sender_agent_id
  BEGIN
    DELETE FROM messages_fts WHERE message_id = OLD.id;
    INSERT INTO messages_fts (message_id, conversation_id, sender_display_name, content_text, task_text, run_text)
    VALUES (NEW.id, NEW.conversation_id, ${FTS_SYNC_SELECT_SENDER}, NEW.content, NULL, NULL);
  END`,

  `CREATE TRIGGER IF NOT EXISTS cr_messages_fts_delete AFTER DELETE ON cr_messages
  BEGIN
    DELETE FROM messages_fts WHERE message_id = OLD.id;
  END`,

  `CREATE TABLE IF NOT EXISTS conversation_read_states (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_read_message_sequence INTEGER NOT NULL CHECK (last_read_message_sequence >= 0),
    last_read_message_id TEXT,
    last_read_at TEXT NOT NULL,
    unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
    mention_count INTEGER NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
    approval_count INTEGER NOT NULL DEFAULT 0 CHECK (approval_count >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES cr_conversations(id) ON DELETE CASCADE
  )`,
]);

const CANONICAL_SOURCE = CONVERSATION_SEARCH_READSTATE_063_DDL.join('\n');

export const migration063Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  if (db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'cr_messages'").get() === undefined) {
    throw new Error('MIGRATION_PREREQUISITE_MISSING: migration 063 (conversation-search-readstate) requires cr_messages');
  }
}

export const migration063: Migration = {
  id: '063',
  name: 'conversation-search-readstate',
  checksum: migration063Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    for (const statement of CONVERSATION_SEARCH_READSTATE_063_DDL) {
      ctx.db.prepare(statement).run();
    }
    // One-time backfill: index every existing Message exactly once. The
    // insert trigger only covers rows created after this migration.
    ctx.db.prepare(`INSERT INTO messages_fts (message_id, conversation_id, sender_display_name, content_text)
      SELECT m.id, m.conversation_id,
        COALESCE(
          (SELECT mem.display_name_snapshot FROM cr_conversation_members mem
            WHERE mem.conversation_id = m.conversation_id
              AND mem.subject_type = m.sender_type
              AND (m.sender_agent_id IS NULL OR mem.subject_id = m.sender_agent_id)
            LIMIT 1),
          m.sender_type),
        m.content
      FROM cr_messages m
      WHERE NOT EXISTS (SELECT 1 FROM messages_fts f WHERE f.message_id = m.id)`).run();
  },
};
