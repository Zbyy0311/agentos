import { createEntityId } from './Identity.js';
import { isTransactionActive, type TransactionDatabase } from './Transaction.js';
import { eventRedactionServiceForDatabase } from '../services/EventRedactionService.js';

export const CONVERSATION_PRODUCT_EVENT_TYPES = [
  'conversation.summary_created', 'conversation.summary_superseded',
  'conversation.notification_created', 'conversation.notification_updated',
  'conversation.read_state_updated',
] as const;
export type ConversationProductEventType = typeof CONVERSATION_PRODUCT_EVENT_TYPES[number];

export interface ConversationProductEvent {
  readonly id: string;
  readonly sequence: number;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly userId: string | null;
  readonly type: ConversationProductEventType;
  readonly payload: Record<string, unknown>;
  readonly timestamp: string;
}

/** Conversation-scoped facts have no fabricated Run ID. SSE reads this committed log. */
export class ConversationEventRepository {
  constructor(private readonly db: TransactionDatabase) {}

  appendWithinTransaction(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly userId?: string;
    readonly type: ConversationProductEventType;
    readonly dedupeKey: string;
    readonly payload: Record<string, unknown>;
    readonly timestamp: string;
  }): void {
    // Old-schema compatibility is deliberate; 067 installs the durable transport.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_events'").get()) return;
    if (!isTransactionActive(this.db)) throw new Error('CONVERSATION_EVENT_TRANSACTION_REQUIRED');
    const payload = eventRedactionServiceForDatabase(this.db).redactPayload(input.workspaceId, input.payload).value;
    this.db.prepare(`
      INSERT INTO conversation_events (id, workspace_id, conversation_id, user_id, type, dedupe_key, payload_json, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, dedupe_key) DO NOTHING
    `).run(createEntityId('event'), input.workspaceId, input.conversationId, input.userId ?? null,
      input.type, input.dedupeKey, JSON.stringify(payload), input.timestamp);
  }

  listAfter(workspaceId: string, conversationId: string, userId: string, afterSequence = 0, limit = 100): ConversationProductEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('CONVERSATION_EVENT_INPUT_INVALID');
    const rows = this.db.prepare(`
      SELECT id, sequence, workspace_id AS workspaceId, conversation_id AS conversationId,
        user_id AS userId, type, payload_json AS payloadJson, timestamp
      FROM conversation_events WHERE workspace_id = ? AND conversation_id = ? AND sequence > ?
        AND (user_id IS NULL OR user_id = ?)
      ORDER BY sequence LIMIT ?
    `).all(workspaceId, conversationId, afterSequence, userId, limit) as Array<Omit<ConversationProductEvent, 'payload'> & { payloadJson: string }>;
    return rows.map(({ payloadJson, ...row }) => ({ ...row, payload: JSON.parse(payloadJson) as Record<string, unknown> }));
  }
}
