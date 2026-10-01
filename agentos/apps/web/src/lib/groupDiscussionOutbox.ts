import type { RunIntent } from '@agentos/shared';
import type { GroupInteractionBudgetInput } from './groupConversationClient';
import type { DraftTextStorage } from './conversationDraftRepository';
import type { SubmittedConversationDraft } from './conversationDraftState';

export interface GroupDiscussionOutboxPayload {
  readonly content: string;
  readonly intent: RunIntent;
  readonly mentionedAgentIds: readonly string[];
  readonly attachmentIds: readonly string[];
  readonly budget: GroupInteractionBudgetInput;
}

export type GroupDiscussionSubmission = SubmittedConversationDraft;

export interface PendingGroupDiscussion {
  readonly identityKey: string;
  readonly idempotencyKey: string;
  readonly clientMessageId: string;
  readonly phase: 'prepared' | 'created' | 'responding' | 'observing';
  readonly payload: GroupDiscussionOutboxPayload;
  readonly submission?: GroupDiscussionSubmission;
  readonly interactionId?: string;
  readonly cursor?: number;
  readonly ownerEpoch?: number;
}

export class GroupDiscussionOutbox {
  constructor(private readonly storage: DraftTextStorage) {}

  load(identityKey: string): PendingGroupDiscussion | undefined {
    try {
      const serialized = this.storage.getItem(storageKey(identityKey));
      if (!serialized) return undefined;
      return decodeEntry(serialized, identityKey);
    } catch {
      return undefined;
    }
  }

  loadForSubmission(identityKey: string, queueItemId?: string): PendingGroupDiscussion | undefined {
    const entry = this.loadForRecovery(identityKey);
    if (!entry) return undefined;
    if (entry.submission?.queueItemId !== queueItemId) {
      throw new Error('存在属于其他队列项的群聊恢复记录；未借用其幂等键或内容。');
    }
    return entry;
  }

  /** Discover the original owner; callers must dispatch that owner, not a new draft. */
  loadForRecovery(identityKey: string): PendingGroupDiscussion | undefined {
    let serialized: string | null;
    try {
      serialized = this.storage.getItem(storageKey(identityKey));
    } catch {
      throw new Error('无法读取群聊发送恢复记录；为避免生成新幂等键，本次发送已停止。');
    }
    if (serialized === null) return undefined;
    const entry = decodeEntry(serialized, identityKey);
    if (!entry || !entry.submission) {
      throw new Error('群聊发送恢复记录损坏或缺少提交快照；已保留记录，未创建新讨论。');
    }
    if (entry.submission.identityKey !== identityKey) {
      throw new Error('存在属于其他队列项的群聊恢复记录；未借用其幂等键或内容。');
    }
    return entry;
  }

  save(entry: PendingGroupDiscussion): void {
    try {
      const existingText = this.storage.getItem(storageKey(entry.identityKey));
      if (existingText !== null) {
        const existing = decodeEntry(existingText, entry.identityKey);
        if (!existing || existing.idempotencyKey !== entry.idempotencyKey
          || existing.clientMessageId !== entry.clientMessageId
          || JSON.stringify(existing.payload) !== JSON.stringify(entry.payload)
          || JSON.stringify(existing.submission) !== JSON.stringify(entry.submission)) throw new Error('pending entry mismatch');
      }
      if (entry.submission && entry.submission.identityKey !== entry.identityKey) throw new Error('submission identity mismatch');
      this.storage.setItem(storageKey(entry.identityKey), JSON.stringify(entry));
      const check = this.load(entry.identityKey);
      if (check?.idempotencyKey !== entry.idempotencyKey) throw new Error('verification failed');
    } catch {
      throw new Error('无法持久化群聊发送的恢复键和原始内容；为避免重复消息，本次发送未提交。');
    }
  }

  updatePhase(identityKey: string, idempotencyKey: string, phase: PendingGroupDiscussion['phase'], interactionId?: string): boolean {
    const existing = this.load(identityKey);
    if (!existing || existing.idempotencyKey !== idempotencyKey) return false;
    this.save({ ...existing, phase, ...(interactionId === undefined ? {} : { interactionId }) });
    return true;
  }

  updateCursor(identityKey: string, idempotencyKey: string, cursor: number, ownerEpoch?: number): boolean {
    const existing = this.load(identityKey);
    if (!existing || existing.idempotencyKey !== idempotencyKey || !Number.isSafeInteger(cursor) || cursor < 0) return false;
    if (ownerEpoch !== undefined && (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < 0)) return false;
    if (cursor <= (existing.cursor ?? 0) || (ownerEpoch !== undefined && ownerEpoch < (existing.ownerEpoch ?? 0))) return false;
    this.save({ ...existing, phase: 'observing', cursor, ...(ownerEpoch === undefined ? {} : { ownerEpoch }) });
    return true;
  }

  clear(identityKey: string, idempotencyKey: string): boolean {
    const existing = this.load(identityKey);
    if (!existing || existing.idempotencyKey !== idempotencyKey) return false;
    try {
      this.storage.removeItem(storageKey(identityKey));
      return true;
    } catch {
      return false;
    }
  }
}

function isPhase(value: unknown): value is PendingGroupDiscussion['phase'] {
  return value === 'prepared' || value === 'created' || value === 'responding' || value === 'observing';
}

function decodeEntry(serialized: string, identityKey: string): PendingGroupDiscussion | undefined {
  try {
    const value = JSON.parse(serialized) as Partial<PendingGroupDiscussion>;
    const submission = value.submission;
    if (value.identityKey !== identityKey || typeof value.idempotencyKey !== 'string'
      || typeof value.clientMessageId !== 'string' || !isPhase(value.phase)
      || !value.payload || typeof value.payload.content !== 'string'
      || !Array.isArray(value.payload.mentionedAgentIds) || !Array.isArray(value.payload.attachmentIds)
      || !isBudget(value.payload.budget)
      || (submission !== undefined && !isSubmission(submission))
      || (value.cursor !== undefined && (!Number.isSafeInteger(value.cursor) || value.cursor < 0))
      || (value.ownerEpoch !== undefined && (!Number.isSafeInteger(value.ownerEpoch) || value.ownerEpoch < 0))) return undefined;
    return value as PendingGroupDiscussion;
  } catch {
    return undefined;
  }
}

function isBudget(value: unknown): value is GroupInteractionBudgetInput {
  if (!value || typeof value !== 'object') return false;
  const budget = value as Record<string, unknown>;
  return ['maxAgentsPerTurn', 'maxRepliesPerAgent', 'maxTotalReplies', 'maxAgentHops']
    .every(key => typeof budget[key] === 'number' && Number.isSafeInteger(budget[key]) && Number(budget[key]) > 0)
    && (budget.timeoutMs === undefined || typeof budget.timeoutMs === 'number')
    && (budget.contextTokenBudget === undefined || typeof budget.contextTokenBudget === 'number');
}

function isSubmission(value: GroupDiscussionSubmission): boolean {
  return typeof value.identityKey === 'string' && Number.isSafeInteger(value.revision)
    && Number.isSafeInteger(value.textRevision) && Number.isSafeInteger(value.mentionsRevision)
    && typeof value.text === 'string' && Array.isArray(value.mentionedAgentIds)
    && value.mentionedAgentIds.every(id => typeof id === 'string')
    && Array.isArray(value.attachmentIds) && value.attachmentIds.every(id => typeof id === 'string')
    && (value.queueItemId === undefined || typeof value.queueItemId === 'string');
}

function storageKey(identityKey: string): string {
  return `agentos:group-discussion-outbox:v1:${encodeURIComponent(identityKey)}`;
}

const browserOutboxStorage: DraftTextStorage = {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
  removeItem: key => window.localStorage.removeItem(key),
};

export const browserGroupDiscussionOutbox = new GroupDiscussionOutbox(browserOutboxStorage);
