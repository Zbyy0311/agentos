import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * Durable ownership, observation events, and association guards for bounded
 * group executions. Existing rows are retained; rows whose original ownership
 * cannot be proven are marked interrupted and require explicit reconciliation.
 */
const DDL = [
  `ALTER TABLE cr_group_interactions ADD COLUMN integrity_status TEXT NOT NULL DEFAULT 'valid'
    CHECK (integrity_status IN ('valid','unusable'))`,
  `ALTER TABLE cr_group_interactions ADD COLUMN integrity_reason TEXT`,
  `ALTER TABLE cr_group_interaction_replies ADD COLUMN integrity_status TEXT NOT NULL DEFAULT 'valid'
    CHECK (integrity_status IN ('valid','unusable'))`,
  `ALTER TABLE cr_group_interaction_replies ADD COLUMN integrity_reason TEXT`,
  `ALTER TABLE cr_group_interaction_replies ADD COLUMN owner_id TEXT`,
  `ALTER TABLE cr_group_interaction_replies ADD COLUMN owner_epoch INTEGER`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cr_group_interactions_execution_scope
    ON cr_group_interactions (id, workspace_id, conversation_id)`,
  `CREATE TABLE IF NOT EXISTS cr_group_interaction_executions (
    interaction_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    source_message_id TEXT,
    owner_id TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 0),
    participants_json TEXT NOT NULL CHECK (json_valid(participants_json)),
    budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
    status TEXT NOT NULL CHECK (status IN ('claimed','running','stop_requested','completed','failed','interrupted','abandoned')),
    current_agent_id TEXT,
    current_turn_id TEXT,
    current_message_id TEXT,
    event_cursor INTEGER NOT NULL DEFAULT 0 CHECK (event_cursor >= 0),
    terminal_reason TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (interaction_id, workspace_id, conversation_id),
    FOREIGN KEY (interaction_id, workspace_id, conversation_id)
      REFERENCES cr_group_interactions(id, workspace_id, conversation_id) ON DELETE CASCADE
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS cr_group_execution_one_owner_per_conversation
    ON cr_group_interaction_executions (workspace_id, conversation_id)
    WHERE status IN ('claimed','running','stop_requested','interrupted')`,
  `CREATE INDEX IF NOT EXISTS cr_group_execution_interaction_status
    ON cr_group_interaction_executions (workspace_id, conversation_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS cr_group_interaction_events (
    interaction_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    cursor INTEGER NOT NULL CHECK (cursor >= 1),
    owner_epoch INTEGER NOT NULL CHECK (owner_epoch >= 0),
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    payload_json TEXT NOT NULL CHECK (
      json_valid(payload_json)
      AND json_type(payload_json, '$.version') = 'integer'
      AND json_type(payload_json, '$.ownerEpoch') = 'integer'
    ),
    created_at TEXT NOT NULL,
    PRIMARY KEY (interaction_id, cursor),
    FOREIGN KEY (interaction_id, workspace_id, conversation_id)
      REFERENCES cr_group_interaction_executions(interaction_id, workspace_id, conversation_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS cr_group_interaction_events_conversation
    ON cr_group_interaction_events (workspace_id, conversation_id, interaction_id, cursor)`,
  `CREATE TRIGGER IF NOT EXISTS cr_group_interaction_source_insert_guard
    BEFORE INSERT ON cr_group_interactions
    WHEN NEW.source_message_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM cr_conversations c JOIN cr_messages m
        ON m.id = NEW.source_message_id
       AND m.workspace_id = NEW.workspace_id
       AND m.conversation_id = NEW.conversation_id
       AND m.sender_type = 'user' AND m.status = 'final'
      WHERE c.id = NEW.conversation_id AND c.workspace_id = NEW.workspace_id
        AND c.kind = 'group' AND c.status = 'active'
    )
    BEGIN SELECT RAISE(ABORT, 'GROUP_SOURCE_ASSOCIATION_INVALID'); END`,
  `CREATE TRIGGER IF NOT EXISTS cr_group_interaction_reply_insert_guard
    BEFORE INSERT ON cr_group_interaction_replies
    WHEN NEW.turn_id IS NULL OR NEW.owner_id IS NULL OR NEW.owner_epoch IS NULL OR NOT EXISTS (
      SELECT 1
      FROM cr_group_interactions i
      JOIN cr_messages m ON m.id = NEW.message_id
      JOIN cr_agent_turns t ON t.id = NEW.turn_id
      JOIN cr_group_interaction_executions e ON e.interaction_id = i.id
      WHERE i.id = NEW.interaction_id AND i.integrity_status = 'valid'
        AND i.source_message_id IS NOT NULL
        AND m.workspace_id = i.workspace_id AND m.conversation_id = i.conversation_id
        AND m.sender_type = 'agent' AND m.sender_agent_id = NEW.agent_id AND m.status = 'final'
        AND m.reply_to_message_id = i.source_message_id
        AND t.workspace_id = i.workspace_id AND t.conversation_id = i.conversation_id
        AND t.agent_id = NEW.agent_id AND t.status = 'final' AND t.source_message_id = m.id
        AND e.owner_id = NEW.owner_id AND e.owner_epoch = NEW.owner_epoch
        AND e.current_agent_id = NEW.agent_id AND e.current_turn_id = t.id
        AND e.current_message_id = m.id AND e.status IN ('running','stop_requested')
    )
    BEGIN SELECT RAISE(ABORT, 'GROUP_REPLY_ASSOCIATION_INVALID'); END`,
  `CREATE TRIGGER IF NOT EXISTS cr_group_interaction_reply_update_guard
    BEFORE UPDATE ON cr_group_interaction_replies
    BEGIN SELECT RAISE(ABORT, 'GROUP_REPLY_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS cr_group_interaction_identity_update_guard
    BEFORE UPDATE ON cr_group_interactions
    WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id
      OR NEW.conversation_id IS NOT OLD.conversation_id
      OR NEW.source_message_id IS NOT OLD.source_message_id
    BEGIN SELECT RAISE(ABORT, 'GROUP_INTERACTION_IDENTITY_IMMUTABLE'); END`,
];

export const migration041Checksum = createHash('sha256').update(DDL.join('\n')).digest('hex').slice(0, 16);

function columns(ctx: MigrationContext, table: string): Set<string> {
  return new Set((ctx.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
    .flatMap(row => typeof row.name === 'string' ? [row.name] : []));
}

function addColumnIfMissing(ctx: MigrationContext, table: string, name: string, ddl: string): void {
  if (!columns(ctx, table).has(name)) ctx.db.exec(ddl);
}

interface LegacyReplyRow {
  id: string;
  interaction_id: string;
  agent_id: string;
  message_id: string;
  turn_id: string | null;
  content_hash: string;
  source_message_id: string | null;
  interaction_workspace_id: string;
  interaction_conversation_id: string;
  integrity_status: string;
  message_workspace_id: string | null;
  message_conversation_id: string | null;
  message_sender_type: string | null;
  message_sender_agent_id: string | null;
  message_status: string | null;
  message_content: string | null;
  message_reply_to_id: string | null;
  turn_workspace_id: string | null;
  turn_conversation_id: string | null;
  turn_agent_id: string | null;
  turn_status: string | null;
  turn_message_id: string | null;
}

function markHistoricalAssociations(ctx: MigrationContext): void {
  ctx.db.exec(`
    UPDATE cr_group_interactions
    SET integrity_status = 'unusable', integrity_reason = CASE
      WHEN source_message_id IS NULL THEN 'source-message-missing'
      ELSE 'source-message-association-invalid'
    END
    WHERE source_message_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM cr_conversations c JOIN cr_messages m
        ON m.id = cr_group_interactions.source_message_id
       AND m.workspace_id = cr_group_interactions.workspace_id
       AND m.conversation_id = cr_group_interactions.conversation_id
       AND m.sender_type = 'user' AND m.status = 'final'
      WHERE c.id = cr_group_interactions.conversation_id
        AND c.workspace_id = cr_group_interactions.workspace_id AND c.kind = 'group'
    )`);
  ctx.db.exec(`
    UPDATE cr_group_interactions
    SET integrity_status = 'unusable', integrity_reason = COALESCE(integrity_reason, 'legacy-execution-unknown')
    WHERE status = 'active'
  `);

  const replies = ctx.db.prepare(`
    SELECT r.id, r.interaction_id, r.agent_id, r.message_id, r.turn_id, r.content_hash,
      i.source_message_id, i.workspace_id AS interaction_workspace_id,
      i.conversation_id AS interaction_conversation_id, r.integrity_status,
      m.workspace_id AS message_workspace_id, m.conversation_id AS message_conversation_id,
      m.sender_type AS message_sender_type, m.sender_agent_id AS message_sender_agent_id,
      m.status AS message_status, m.content AS message_content, m.reply_to_message_id AS message_reply_to_id,
      t.workspace_id AS turn_workspace_id, t.conversation_id AS turn_conversation_id,
      t.agent_id AS turn_agent_id, t.status AS turn_status, t.source_message_id AS turn_message_id
    FROM cr_group_interaction_replies r
    JOIN cr_group_interactions i ON i.id = r.interaction_id
    LEFT JOIN cr_messages m ON m.id = r.message_id
    LEFT JOIN cr_agent_turns t ON t.id = r.turn_id
    WHERE r.integrity_status = 'valid'
  `).all() as LegacyReplyRow[];
  const markInvalid = ctx.db.prepare(
    `UPDATE cr_group_interaction_replies SET integrity_status = 'unusable', integrity_reason = ? WHERE id = ?`,
  );
  for (const row of replies) {
    const associated = row.turn_id !== null
      && row.source_message_id !== null
      && row.message_workspace_id === row.interaction_workspace_id
      && row.message_conversation_id === row.interaction_conversation_id
      && row.message_sender_type === 'agent'
      && row.message_sender_agent_id === row.agent_id
      && row.message_status === 'final'
      && row.message_reply_to_id === row.source_message_id
      && row.turn_workspace_id === row.interaction_workspace_id
      && row.turn_conversation_id === row.interaction_conversation_id
      && row.turn_agent_id === row.agent_id
      && row.turn_status === 'final'
      && row.turn_message_id === row.message_id
      && row.message_content !== null
      && createHash('sha256').update(row.message_content).digest('hex') === row.content_hash;
    if (!associated) markInvalid.run('reply-association-invalid', row.id);
  }
  ctx.db.exec(`
    UPDATE cr_group_interactions
    SET integrity_status = 'unusable', integrity_reason = COALESCE(integrity_reason, 'reply-association-invalid')
    WHERE EXISTS (
      SELECT 1 FROM cr_group_interaction_replies r
      WHERE r.interaction_id = cr_group_interactions.id AND r.integrity_status = 'unusable'
    )
  `);
}

function seedUnknownLegacyOwners(ctx: MigrationContext): void {
  ctx.db.prepare(`
    INSERT OR IGNORE INTO cr_group_interaction_executions (
      interaction_id, workspace_id, conversation_id, source_message_id, owner_id, owner_epoch,
      participants_json, budget_json, status, terminal_reason, updated_at
    )
    SELECT i.id, i.workspace_id, i.conversation_id, i.source_message_id,
      'legacy-unknown-' || i.id, 0, '[]', json_object(
        'maxAgentsPerTurn', i.max_agents_per_turn,
        'maxRepliesPerAgent', i.max_replies_per_agent,
        'maxTotalReplies', i.max_total_replies,
        'maxAgentHops', i.max_agent_hops,
        'timeoutMs', i.timeout_ms,
        'contextTokenBudget', i.context_token_budget
      ), CASE WHEN i.id = (
        SELECT legacy.id FROM cr_group_interactions legacy
        WHERE legacy.workspace_id = i.workspace_id AND legacy.conversation_id = i.conversation_id
          AND legacy.status = 'active'
        ORDER BY legacy.created_at ASC, legacy.id ASC LIMIT 1
      ) THEN 'interrupted' ELSE 'abandoned' END,
      'legacy-owner-unknown', i.updated_at
    FROM cr_group_interactions i
    WHERE i.status = 'active'
  `).run();
  ctx.db.prepare(`
    INSERT OR IGNORE INTO cr_group_interaction_events (
      interaction_id, workspace_id, conversation_id, cursor, owner_epoch, event_type, payload_json, created_at
    )
    SELECT e.interaction_id, e.workspace_id, e.conversation_id, 1, e.owner_epoch, 'group.interrupted',
      json_object('interactionId', e.interaction_id, 'reason', 'legacy-owner-unknown',
        'version', i.version, 'ownerEpoch', e.owner_epoch), e.updated_at
    FROM cr_group_interaction_executions e
    JOIN cr_group_interactions i ON i.id = e.interaction_id AND i.workspace_id = e.workspace_id
    WHERE e.terminal_reason = 'legacy-owner-unknown' AND e.event_cursor = 0
  `).run();
  ctx.db.prepare(`
    UPDATE cr_group_interaction_executions SET event_cursor = 1
    WHERE terminal_reason = 'legacy-owner-unknown' AND event_cursor = 0
  `).run();
}

export const migration041: Migration = {
  id: '041',
  name: 'group-execution-ownership',
  checksum: migration041Checksum,
  apply(ctx: MigrationContext): void {
    addColumnIfMissing(ctx, 'cr_group_interactions', 'integrity_status', DDL[0]!);
    addColumnIfMissing(ctx, 'cr_group_interactions', 'integrity_reason', DDL[1]!);
    addColumnIfMissing(ctx, 'cr_group_interaction_replies', 'integrity_status', DDL[2]!);
    addColumnIfMissing(ctx, 'cr_group_interaction_replies', 'integrity_reason', DDL[3]!);
    addColumnIfMissing(ctx, 'cr_group_interaction_replies', 'owner_id', DDL[4]!);
    addColumnIfMissing(ctx, 'cr_group_interaction_replies', 'owner_epoch', DDL[5]!);
    for (const statement of DDL.slice(6, 14)) ctx.db.exec(statement);
    markHistoricalAssociations(ctx);
    seedUnknownLegacyOwners(ctx);
    for (const statement of DDL.slice(14)) ctx.db.exec(statement);
  },
};
