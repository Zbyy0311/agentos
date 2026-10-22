import { createHash } from 'node:crypto';
import { createEntityId } from '../store/Identity.js';
import { inTransaction, isTransactionActive, type TransactionDatabase } from '../store/Transaction.js';
import { conversationIdsForRun } from '../store/ConversationRunResolver.js';
import { ConversationEventRepository } from '../store/ConversationEventRepository.js';
import { extractMentionTargets } from './ConversationSearchReadStateService.js';
import { eventRedactionServiceForDatabase } from './EventRedactionService.js';

export const CONVERSATION_NOTIFICATION_TYPES = Object.freeze([
  'mention', 'agent-reply', 'run-completed', 'approval',
] as const);
export const CONVERSATION_NOTIFICATION_STATUSES = Object.freeze(['unread', 'read', 'dismissed'] as const);
export const DEFAULT_CONVERSATION_NOTIFICATION_USER_ID = 'default';

export type ConversationNotificationType = (typeof CONVERSATION_NOTIFICATION_TYPES)[number];
export type ConversationNotificationStatus = (typeof CONVERSATION_NOTIFICATION_STATUSES)[number];

/** Central projection table: existing durable Runtime Events that create notifications. */
export const CONVERSATION_NOTIFICATION_EVENT_REGISTRY = Object.freeze({
  'run.completed': 'run-completed',
  'approval.required': 'approval',
} as const satisfies Record<string, ConversationNotificationType>);

export interface ConversationNotificationRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly type: ConversationNotificationType;
  readonly status: ConversationNotificationStatus;
  readonly dedupeKey: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly sourceMessageId?: string;
  readonly sourceRunId?: string;
  readonly sourceApprovalId?: string;
}

interface NotifyInput {
  readonly workspaceId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly type: ConversationNotificationType;
  readonly source: NotificationSource;
  readonly payload?: Record<string, unknown>;
}

export type NotificationSource =
  | { readonly kind: 'message'; readonly messageId: string }
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'approval'; readonly requestId: string };

export interface ConversationNotificationRuntimeEvent {
  readonly type: string;
  readonly workspaceId: string;
  readonly conversationId?: string | null;
  readonly runId?: string | null;
  readonly approvalRequestId?: string | null;
  readonly payload?: Record<string, unknown>;
}

export class ConversationNotificationError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'CONVERSATION_NOT_FOUND' | 'NOT_FOUND') {
    super('CONVERSATION_NOTIFICATION_' + code);
    this.name = 'ConversationNotificationError';
  }
}

interface NotificationRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly user_id: string;
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

  static dedupeKey(
    workspaceId: string,
    userId: string,
    conversationId: string,
    type: ConversationNotificationType,
    source: NotificationSource,
  ): string {
    const sourceId = source.kind === 'message' ? source.messageId
      : source.kind === 'run' ? source.runId : source.requestId;
    const scope = JSON.stringify([workspaceId, userId, conversationId, type, source.kind, sourceId]);
    return `cnd_${createHash('sha256').update(scope).digest('hex')}`;
  }

  /** Insert-or-converge: one notification per user, conversation, type, and source. */
  notify(input: NotifyInput): { readonly notification: ConversationNotificationRecord; readonly deduped: boolean } | null {
    if (!this.hasTable()) return null;
    return this.atomic(() => this.notifyWithinTransaction(input));
  }

  private notifyWithinTransaction(input: NotifyInput): { readonly notification: ConversationNotificationRecord; readonly deduped: boolean } {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.userId) || !nonBlank(input.conversationId)
      || !CONVERSATION_NOTIFICATION_TYPES.includes(input.type)
      || !validSource(input.source)
      || ((input.type === 'mention' || input.type === 'agent-reply') && input.source.kind !== 'message')
      || (input.type === 'run-completed' && input.source.kind !== 'run')
      || (input.type === 'approval' && input.source.kind !== 'approval')) {
      throw new ConversationNotificationError('INPUT_INVALID');
    }
    const conversation = this.db.prepare(
      'SELECT id FROM cr_conversations WHERE workspace_id = ? AND id = ?',
    ).get(input.workspaceId, input.conversationId);
    if (conversation === undefined) throw new ConversationNotificationError('CONVERSATION_NOT_FOUND');
    const user = this.db.prepare('SELECT id FROM user_profiles WHERE id = ?').get(input.userId);
    if (user === undefined) throw new ConversationNotificationError('INPUT_INVALID');

    const dedupeKey = ConversationNotificationService.dedupeKey(
      input.workspaceId, input.userId, input.conversationId, input.type, input.source,
    );
    const existing = this.findByDedupeKey(input.workspaceId, input.userId, dedupeKey);
    if (existing !== null) return { notification: existing, deduped: true };
    let payloadJson: string;
    try {
      const sourcePayload = input.source.kind === 'message' ? { messageId: input.source.messageId }
        : input.source.kind === 'run' ? { runId: input.source.runId } : { approvalRequestId: input.source.requestId };
      const redacted = eventRedactionServiceForDatabase(this.db)
        .redactPayload(input.workspaceId, { ...input.payload, ...sourcePayload }).value;
      if (typeof redacted !== 'object' || redacted === null || Array.isArray(redacted)) {
        throw new Error('payload must be an object');
      }
      payloadJson = JSON.stringify(redacted);
      if (Buffer.byteLength(payloadJson, 'utf8') > 16384) throw new Error('payload too large');
    } catch {
      throw new ConversationNotificationError('INPUT_INVALID');
    }

    const id = createEntityId('conversationNotification');
    const createdAt = this.now();
    const result = this.db.prepare(`
      INSERT INTO conversation_notifications (
        id, conversation_id, user_id, type, status, dedupe_key, payload_json, created_at
      ) VALUES (?, ?, ?, ?, 'unread', ?, ?, ?)
      ON CONFLICT(dedupe_key) DO NOTHING
    `).run(id, input.conversationId, input.userId, input.type, dedupeKey, payloadJson, createdAt) as { changes?: number | bigint };
    const row = this.findByDedupeKey(input.workspaceId, input.userId, dedupeKey);
    if (row === null) throw new ConversationNotificationError('NOT_FOUND');
    if (Number(result.changes ?? 0) === 1) new ConversationEventRepository(this.db).appendWithinTransaction({
      workspaceId: input.workspaceId, conversationId: input.conversationId, userId: input.userId,
      type: 'conversation.notification_created', dedupeKey: `notification-created:${id}`, timestamp: createdAt,
      payload: { notification: row },
    });
    return { notification: row, deduped: Number(result.changes ?? 0) !== 1 };
  }

  /** Route a registered event into a durable notification; unknown types are ignored. */
  notifyFromRuntimeEvent(event: ConversationNotificationRuntimeEvent, userId = DEFAULT_CONVERSATION_NOTIFICATION_USER_ID): void {
    if (!this.hasTable()) return;
    const type = CONVERSATION_NOTIFICATION_EVENT_REGISTRY[event.type as keyof typeof CONVERSATION_NOTIFICATION_EVENT_REGISTRY];
    if (type === undefined || !nonBlank(event.workspaceId)) return;
    const source: NotificationSource = type === 'approval'
      ? { kind: 'approval', requestId: event.approvalRequestId ?? String(event.payload?.approvalRequestId ?? '') }
      : { kind: 'run', runId: event.runId ?? '' };
    if (!validSource(source)) return;
    const conversationIds = new Set(this.findConversationIdsForEvent(event.workspaceId, source));
    if (nonBlank(event.conversationId)) conversationIds.add(event.conversationId);
    for (const conversationId of conversationIds) {
      // Legacy/foreign Conversation hints are not forward-runtime bindings.
      // Ignore an unresolvable hint without suppressing real persistence errors.
      if (!this.db.prepare('SELECT 1 FROM cr_conversations WHERE workspace_id = ? AND id = ?')
        .get(event.workspaceId, conversationId)) continue;
      this.notify({
        workspaceId: event.workspaceId,
        userId,
        conversationId,
        type,
        source,
        payload: type === 'approval'
          ? { approvalRequestId: source.kind === 'approval' ? source.requestId : '' }
          : { runId: source.kind === 'run' ? source.runId : '' },
      });
    }
  }

  notifyForMessage(input: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderType: string;
    readonly status: string;
    readonly content: string;
    readonly userId?: string;
  }): void {
    if (input.status !== 'final') return;
    const userId = input.userId ?? DEFAULT_CONVERSATION_NOTIFICATION_USER_ID;
    if (extractMentionTargets(input.content).length > 0) {
      this.notify({
        workspaceId: input.workspaceId,
        userId,
        conversationId: input.conversationId,
        type: 'mention',
        source: { kind: 'message', messageId: input.messageId },
        payload: { messageId: input.messageId },
      });
    }
    if (input.senderType === 'agent' && input.content.trim().length > 0) {
      this.notify({
        workspaceId: input.workspaceId,
        userId,
        conversationId: input.conversationId,
        type: 'agent-reply',
        source: { kind: 'message', messageId: input.messageId },
        payload: { messageId: input.messageId },
      });
    }
  }

  list(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly conversationId?: string;
    readonly status?: ConversationNotificationStatus;
  }): ConversationNotificationRecord[] {
    if (!this.hasTable()) return [];
    if (!nonBlank(input.workspaceId) || !nonBlank(input.userId)
      || (input.conversationId !== undefined && !nonBlank(input.conversationId))
      || (input.status !== undefined && !CONVERSATION_NOTIFICATION_STATUSES.includes(input.status))) {
      throw new ConversationNotificationError('INPUT_INVALID');
    }
    const conditions = ['conversation.workspace_id = ?', 'notification.user_id = ?'];
    const params: unknown[] = [input.workspaceId, input.userId];
    if (input.conversationId !== undefined) { conditions.push('notification.conversation_id = ?'); params.push(input.conversationId); }
    if (input.status !== undefined) { conditions.push('notification.status = ?'); params.push(input.status); }
    const rows = this.db.prepare(`
      SELECT notification.* FROM conversation_notifications notification
      JOIN cr_conversations conversation ON conversation.id = notification.conversation_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY notification.created_at DESC, notification.id DESC
    `).all(...params) as unknown as NotificationRow[];
    return rows.map(toRecord);
  }

  markRead(workspaceId: string, userId: string, id: string): ConversationNotificationRecord | null {
    return this.setStatus(workspaceId, userId, id, 'read');
  }

  dismiss(workspaceId: string, userId: string, id: string): ConversationNotificationRecord | null {
    return this.setStatus(workspaceId, userId, id, 'dismissed');
  }

  private setStatus(
    workspaceId: string,
    userId: string,
    id: string,
    status: 'read' | 'dismissed',
  ): ConversationNotificationRecord | null {
    if (!this.hasTable()) return null;
    if (!nonBlank(workspaceId) || !nonBlank(userId) || !nonBlank(id)) {
      throw new ConversationNotificationError('INPUT_INVALID');
    }
    return this.atomic(() => {
      const changedAt = this.now();
      const changed = this.db.prepare(`
        UPDATE conversation_notifications
        SET status = ?, read_at = CASE WHEN ? = 'read' THEN ? ELSE read_at END
        WHERE id = ? AND user_id = ? AND status <> 'dismissed' AND status <> ?
          AND conversation_id IN (SELECT id FROM cr_conversations WHERE workspace_id = ?)
      `).run(status, status, changedAt, id, userId, status, workspaceId) as { changes?: number | bigint };
      const row = this.db.prepare(`
        SELECT notification.* FROM conversation_notifications notification
        JOIN cr_conversations conversation ON conversation.id = notification.conversation_id
        WHERE notification.id = ? AND notification.user_id = ? AND conversation.workspace_id = ?
      `).get(id, userId, workspaceId) as NotificationRow | undefined;
      if (row === undefined) return null;
      const notification = toRecord(row);
      if (Number(changed.changes ?? 0) === 1) new ConversationEventRepository(this.db).appendWithinTransaction({
        workspaceId, conversationId: row.conversation_id, userId,
        type: 'conversation.notification_updated', dedupeKey: `notification-${status}:${id}`, timestamp: changedAt,
        payload: { notification },
      });
      return notification;
    });
  }

  private findByDedupeKey(workspaceId: string, userId: string, dedupeKey: string): ConversationNotificationRecord | null {
    const row = this.db.prepare(`
      SELECT notification.* FROM conversation_notifications notification
      JOIN cr_conversations conversation ON conversation.id = notification.conversation_id
      WHERE notification.dedupe_key = ? AND notification.user_id = ? AND conversation.workspace_id = ?
    `).get(dedupeKey, userId, workspaceId) as NotificationRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  private findConversationIdsForEvent(workspaceId: string, source: NotificationSource): string[] {
    if (source.kind === 'run') return conversationIdsForRun(this.db, workspaceId, source.runId);
    if (source.kind === 'approval') {
      const columns = this.db.prepare('PRAGMA table_info(runtime_approval_requests)').all() as Array<{ name: string }>;
      if (columns.length > 0) {
        const binding = columns.some(column => column.name === 'conversation_id') ? 'conversation_id' : 'NULL';
        const row = this.db.prepare(`
          SELECT ${binding} AS conversationId, run_id AS runId FROM runtime_approval_requests
          WHERE workspace_id = ? AND id = ?
        `).get(workspaceId, source.requestId) as { conversationId: string | null; runId: string } | undefined;
        if (row !== undefined) return [...new Set([
          ...(row.conversationId ? [row.conversationId] : []), ...conversationIdsForRun(this.db, workspaceId, row.runId),
        ])];
      }
    }
    return [];
  }

  private atomic<T>(run: () => T): T {
    return isTransactionActive(this.db) ? run() : inTransaction(this.db, run);
  }
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validSource(source: NotificationSource): boolean {
  if (!source || typeof source !== 'object') return false;
  if (source.kind === 'message') return nonBlank(source.messageId);
  if (source.kind === 'run') return nonBlank(source.runId);
  if (source.kind === 'approval') return nonBlank(source.requestId);
  return false;
}

function toRecord(row: NotificationRow): ConversationNotificationRecord {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    type: row.type,
    status: row.status,
    dedupeKey: row.dedupe_key,
    payload,
    ...(typeof payload.messageId === 'string' ? { sourceMessageId: payload.messageId } : {}),
    ...(typeof payload.runId === 'string' ? { sourceRunId: payload.runId } : {}),
    ...(typeof payload.approvalRequestId === 'string' ? { sourceApprovalId: payload.approvalRequestId } : {}),
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}
