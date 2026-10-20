import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * Conversation productization cut 2: versioned Conversation Summary +
 * Conversation Notification (09-Conversation-Runtime §64/§65/§73/§74).
 *
 *   - conversation_summaries: append-only version chain. A new Summary always
 *     INSERTs a new row whose supersedes_summary_id points at the previous
 *     head; old rows are never UPDATEd (there is deliberately no update path).
 *     from_sequence/to_sequence bound the covered cr_messages range and the
 *     next version continues at to_sequence + 1.
 *   - conversation_notifications: durable notification log with a UNIQUE
 *     dedupe_key so repeated projections of the same source event converge on
 *     one row (§74: Approval notifies immediately, Run Terminal notifies once,
 *     ordinary stage events never notify at all). Status machine:
 *     unread -> read | dismissed.
 *   - runtime_approval_requests gains a nullable conversation_id so the §71
 *     read-state approvalCount can count pending approvals per Conversation
 *     instead of staying hard-zero. Rows created before this migration keep
 *     NULL and keep counting as zero (degraded mode).
 *
 * Additive only (destructive = false). The ALTER TABLE is guarded by
 * PRAGMA table_info so a re-apply converges instead of failing.
 */

export const CONVERSATION_SUMMARIES_NOTIFICATIONS_067_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS conversation_summaries (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    conversation_id TEXT NOT NULL,
    from_sequence INTEGER NOT NULL CHECK (from_sequence >= 1),
    to_sequence INTEGER NOT NULL CHECK (to_sequence >= from_sequence),
    summary TEXT NOT NULL CHECK (length(summary) > 0),
    decisions_json TEXT NOT NULL CHECK (json_valid(decisions_json)),
    constraints_json TEXT NOT NULL CHECK (json_valid(constraints_json)),
    supersedes_summary_id TEXT,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES cr_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (supersedes_summary_id) REFERENCES conversation_summaries(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS conversation_summaries_conversation
    ON conversation_summaries (conversation_id, to_sequence DESC, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS conversation_notifications (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    conversation_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('mention','agent_reply','run_completed','approval')),
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read','dismissed')),
    dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 512),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    created_at TEXT NOT NULL,
    read_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES cr_conversations(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS conversation_notifications_conversation_status
    ON conversation_notifications (conversation_id, status, created_at DESC)`,
]);

export const migration067Checksum = createHash('sha256')
  .update(CONVERSATION_SUMMARIES_NOTIFICATIONS_067_DDL.join('\n'))
  .digest('hex')
  .slice(0, 16);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  for (const table of ['cr_conversations', 'runtime_approval_requests']) {
    if (db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) {
      throw new Error('MIGRATION_PREREQUISITE_MISSING: migration 067 (conversation-summaries-notifications) requires ' + table);
    }
  }
}

export const migration067: Migration = {
  id: '067',
  name: 'conversation-summaries-notifications',
  checksum: migration067Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    assertPrerequisites(ctx.db);
    for (const statement of CONVERSATION_SUMMARIES_NOTIFICATIONS_067_DDL) {
      ctx.db.exec(statement);
    }
    const columns = ctx.db.prepare('PRAGMA table_info(runtime_approval_requests)').all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'conversation_id')) {
      ctx.db.exec('ALTER TABLE runtime_approval_requests ADD COLUMN conversation_id TEXT');
    }
  },
};
