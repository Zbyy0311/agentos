import { createHash } from 'node:crypto';
import type { Migration, MigrationContext, MinimalDatabaseSync } from '../types.js';

/**
 * Conversation productization cut 2: versioned Conversation Summary +
 * Conversation Notification (09-Conversation-Runtime §64/§65/§73/§74).
 *
 *   - conversation_summaries: append-only version chain. A new Summary always
 *     INSERTs a new row whose supersedes_summary_id points at the previous
 *     head; old rows cannot be UPDATEd or DELETEd (there is deliberately no
 *     rewrite path).
 *     from_sequence/to_sequence bound the covered cr_messages range and the
 *     next version continues at to_sequence + 1.
 *   - conversation_notifications: durable notification log with a UNIQUE
 *     dedupe_key so repeated projections of the same source event converge on
 *     one row (§74: Approval notifies immediately, Run Terminal notifies once,
 *     ordinary stage events never notify at all). Status machine:
 *     unread -> read -> dismissed (or unread -> dismissed).
 *   - runtime_approval_requests gains a nullable conversation_id so the §71
 *     read-state approvalCount can count pending approvals per Conversation
 *     instead of staying hard-zero. Existing NULL bindings are resolved from
 *     durable Run/Task/Message/Turn associations at read time.
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
    open_questions_json TEXT NOT NULL CHECK (json_valid(open_questions_json)),
    task_references_json TEXT NOT NULL CHECK (json_valid(task_references_json)),
    run_references_json TEXT NOT NULL CHECK (json_valid(run_references_json)),
    source_message_ids_json TEXT NOT NULL CHECK (json_valid(source_message_ids_json)),
    generated_at TEXT NOT NULL,
    supersedes_summary_id TEXT,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, version),
    UNIQUE (supersedes_summary_id),
    FOREIGN KEY (conversation_id) REFERENCES cr_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (supersedes_summary_id) REFERENCES conversation_summaries(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS conversation_summaries_conversation
    ON conversation_summaries (conversation_id, version DESC, created_at DESC)`,
  `CREATE TRIGGER IF NOT EXISTS conversation_summaries_validate_chain
    BEFORE INSERT ON conversation_summaries
    WHEN (NEW.version = 1 AND (NEW.supersedes_summary_id IS NOT NULL OR NEW.from_sequence <> 1))
      OR (NEW.version > 1 AND NOT EXISTS (
        SELECT 1 FROM conversation_summaries previous
        WHERE previous.id = NEW.supersedes_summary_id
          AND previous.conversation_id = NEW.conversation_id
          AND previous.version = NEW.version - 1
          AND previous.to_sequence + 1 = NEW.from_sequence
      ))
    BEGIN SELECT RAISE(ABORT, 'CONVERSATION_SUMMARY_CHAIN_INVALID'); END`,
  `CREATE TRIGGER IF NOT EXISTS conversation_summaries_immutable
    BEFORE UPDATE ON conversation_summaries
    BEGIN SELECT RAISE(ABORT, 'CONVERSATION_SUMMARY_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS conversation_summaries_no_delete
    BEFORE DELETE ON conversation_summaries
    BEGIN SELECT RAISE(ABORT, 'CONVERSATION_SUMMARY_IMMUTABLE'); END`,
  `CREATE TABLE IF NOT EXISTS conversation_notifications (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('mention','agent-reply','run-completed','approval')),
    status TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread','read','dismissed')),
    dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 512),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 16384),
    created_at TEXT NOT NULL,
    read_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES cr_conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES user_profiles(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS conversation_notifications_user_scope
    ON conversation_notifications (user_id, conversation_id, status, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS conversation_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    user_id TEXT,
    type TEXT NOT NULL CHECK (type IN (
      'conversation.summary_created','conversation.summary_superseded',
      'conversation.notification_created','conversation.notification_updated','conversation.read_state_updated'
    )),
    dedupe_key TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    timestamp TEXT NOT NULL,
    UNIQUE (conversation_id, dedupe_key),
    FOREIGN KEY (conversation_id, workspace_id) REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS conversation_events_scope ON conversation_events (workspace_id, conversation_id, sequence)`,
  `CREATE TRIGGER IF NOT EXISTS conversation_events_immutable BEFORE UPDATE ON conversation_events
    BEGIN SELECT RAISE(ABORT, 'CONVERSATION_EVENT_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS conversation_events_no_delete BEFORE DELETE ON conversation_events
    BEGIN SELECT RAISE(ABORT, 'CONVERSATION_EVENT_IMMUTABLE'); END`,
]);

const APPROVAL_CONVERSATION_INDEX_067 = `CREATE INDEX IF NOT EXISTS runtime_approval_requests_conversation_pending
  ON runtime_approval_requests (workspace_id, conversation_id, status, expires_at)`;

export const migration067Checksum = createHash('sha256')
  .update([
    ...CONVERSATION_SUMMARIES_NOTIFICATIONS_067_DDL,
    'ALTER TABLE runtime_approval_requests ADD COLUMN conversation_id TEXT',
    APPROVAL_CONVERSATION_INDEX_067,
  ].join('\n'))
  .digest('hex')
  .slice(0, 16);

function assertPrerequisites(db: MinimalDatabaseSync): void {
  for (const table of ['cr_conversations', 'runtime_approval_requests', 'user_profiles']) {
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
    ctx.db.exec(APPROVAL_CONVERSATION_INDEX_067);
  },
};
