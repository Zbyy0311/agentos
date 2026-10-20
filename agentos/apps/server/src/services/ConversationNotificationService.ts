import { randomUUID } from 'node:crypto';
import type { TransactionDatabase } from '../store/Transaction.js';

/**
 * Conversation Notification (09-Conversation-Runtime §73/§74).
 *
 * Durable notification log with a UNIQUE dedupe_key per
 * (conversation, type, source): repeated projections of the same source event
 * converge on the one already-persisted row instead of flooding the log —
 * §74 deduplication. §74 routing policy is enforced at the call sites:
 *   - approval:    notify immediately when the approval request is created;
 *   - run terminal: notify once per Run (dedupe_key on the run id);
 *   - mention / agent_reply: notify once per source Message;
 *   - ordinary stage events never call notify — they only update the Card.
 *
 * Status machine: unread -> read | dismissed. Everything degrades to a no-op
 * when the table is absent (pre-067 databases), mirroring the read-state
 * degraded mode.
 */

export type ConversationNotificationType = 'mention' | 'agent_reply' | 'run_completed' | 'approval';
export type ConversationNotificationStatus = 'unread' | 'read' | 'dismissed';

export interface ConversationNotificationRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly type: ConversationNotificationType;
  readonly status: ConversationNotificationStatus;
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export type NotificationSource =
  | { readonly kind: 'message'; readonly messageId: string }
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'approval'; readonly requestId: string };

interface NotificationRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly type: ConversationNotificationType;
  readonly status: ConversationNotificationStatus;
  readonly dedupe_key: string;
  readonly payload_json: string;
  readonly created_at: string;
  readonly read_at: string | null;
}

export class ConversationNotificationService {
  private tableAvailable: boolean | undefined;

  constructor(
    private readonly db: TransactionDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private hasTable(): boolean {
    if (this.tableAvailable === undefined) {
      this.tableAvailable = this.db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_notifications'",
      ).get() !== undefined;
    }
    return this.tableAvailable;
  }

  /** §74 dedupe key: same conversation + type + source identity is one notification. */
  static dedupeKey(conversationId: string, type: ConversationNotificationType, source: NotificationSource): string {
    const sourceId = source.kind === 'message' ? source.messageId : source.kind === 'run' ? source.runId : source.requestId;
    return `${conversationId}:${type}:${sourceId}`;
  }

  /**
   * Insert-or-converge. A second call with the same dedupe key returns the
   * existing row with deduped: true; no duplicate row is ever written.
   */
  notify(input: {
    readonly conversationId: string;
    readonly type: ConversationNotificationType;
    readonly source: NotificationSource;
    readonly payload?: Record<string, unknown>;
  }): { readonly notification: ConversationNotificationRecord; readonly deduped: boolean } | null {
    if (!this.hasTable()) return null;
    const dedupeKey = ConversationNotificationService.dedupeKey(input.conversationId, input.type, input.source);
    const existing = this.findByDedupeKey(dedupeKey);
    if (existing !== null) return { notification: existing, deduped: true };
    const id = randomUUID();
    const createdAt = this.now();
    this.db.prepare(`
      INSERT INTO conversation_notifications (id, conversation_id, type, status, dedupe_key, payload_json, created_at)
      VALUES (?, ?, ?, 'unread', ?, ?, ?)
    `).run(id, input.conversationId, input.type, dedupeKey, JSON.stringify(input.payload ?? {}), createdAt);
    return {
      notification: {
        id, conversationId: input.conversationId, type: input.type, status: 'unread',
        dedupeKey, payload: input.payload ?? {}, createdAt, readAt: null,
      },
      deduped: false,
    };
  }

  list(filters: { readonly conversationId?: string; readonly status?: ConversationNotificationStatus } = {}): ConversationNotificationRecord[] {
    if (!this.hasTable()) return [];
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filters.conversationId !== undefined) { conditions.push('conversation_id = ?'); params.push(filters.conversationId); }
    if (filters.status !== undefined) { conditions.push('status = ?'); params.push(filters.status); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM conversation_notifications ${where} ORDER BY created_at DESC, id DESC`,
    ).all(...params) as unknown as NotificationRow[];
    return rows.map(toRecord);
  }

  markRead(id: string): ConversationNotificationRecord | null {
    return this.setStatus(id, 'read');
  }

  dismiss(id: string): ConversationNotificationRecord | null {
    return this.setStatus(id, 'dismissed');
  }

  private setStatus(id: string, status: 'read' | 'dismissed'): ConversationNotificationRecord | null {
    if (!this.hasTable()) return null;
    const readAt = status === 'read' ? this.now() : null;
    this.db.prepare('UPDATE conversation_notifications SET status = ?, read_at = ? WHERE id = ?')
      .run(status, readAt, id);
    const row = this.db.prepare('SELECT * FROM conversation_notifications WHERE id = ?').get(id) as NotificationRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  private findByDedupeKey(dedupeKey: string): ConversationNotificationRecord | null {
    const row = this.db.prepare('SELECT * FROM conversation_notifications WHERE dedupe_key = ?').get(dedupeKey) as NotificationRow | undefined;
    return row === undefined ? null : toRecord(row);
  }
}

function toRecord(row: NotificationRow): ConversationNotificationRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    type: row.type,
    status: row.status,
    dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}
