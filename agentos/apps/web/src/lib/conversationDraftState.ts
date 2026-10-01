import type { RunIntent, ThinkingEffort } from '@agentos/shared';
import type { ImageDraft } from './imageAttachments';

export type ConversationStorageSource = 'workspace' | 'runtime';

export interface ConversationDraftIdentity {
  readonly workspaceId: string;
  /** Chosen from the validated adapter result, never copied from an unchecked URL. */
  readonly storageSource: ConversationStorageSource;
  readonly conversationId?: string;
  readonly pendingAgentId?: string;
}

export interface QueuedConversationMessage {
  readonly id: string;
  readonly identityKey: string;
  readonly content: string;
  readonly mentionedAgentIds: readonly string[];
  readonly runIntent: RunIntent;
  readonly model?: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly attachments: readonly ImageDraft[];
}

export interface ConversationDraft {
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly textRevision: number;
  readonly mentionsRevision: number;
  readonly text: string;
  readonly mentionedAgentIds: readonly string[];
  readonly runIntent: RunIntent;
  readonly model?: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly attachments: readonly ImageDraft[];
  readonly queue: readonly QueuedConversationMessage[];
  readonly scrollPosition: number;
}

export interface SubmittedConversationDraft {
  readonly identityKey: string;
  readonly revision: number;
  readonly textRevision: number;
  readonly mentionsRevision: number;
  readonly text: string;
  readonly mentionedAgentIds: readonly string[];
  readonly attachmentIds: readonly string[];
  readonly queueItemId?: string;
}

export interface PersistedAttachmentMetadata {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
}

export function createConversationDraftIdentityKey(identity: ConversationDraftIdentity): string {
  if (!identity.workspaceId.trim()) throw new Error('workspaceId is required for a draft identity');
  const target = identity.conversationId
    ? ['conversation', identity.conversationId]
    : identity.pendingAgentId
      ? ['pending-agent', identity.pendingAgentId]
      : undefined;
  if (!target || target[1].trim().length === 0) throw new Error('conversationId or pendingAgentId is required for a draft identity');
  return JSON.stringify([1, identity.workspaceId, identity.storageSource, ...target]);
}

export function conversationDraftStorageKey(identity: ConversationDraftIdentity): string {
  return `agentos:conversation-draft:v1:${encodeURIComponent(createConversationDraftIdentityKey(identity))}`;
}

export function createEmptyConversationDraft(): ConversationDraft {
  return {
    schemaVersion: 1,
    revision: 0,
    textRevision: 0,
    mentionsRevision: 0,
    text: '',
    mentionedAgentIds: [],
    runIntent: 'execute',
    thinkingEffort: 'auto',
    attachments: [],
    queue: [],
    scrollPosition: 0,
  };
}

export function isCurrentConversationGeneration(
  activeIdentityKey: string | null,
  activeGeneration: number,
  callbackIdentityKey: string,
  callbackGeneration: number,
): boolean {
  return activeIdentityKey === callbackIdentityKey && activeGeneration === callbackGeneration;
}

export function captureDraftSubmission(
  identityKey: string,
  draft: ConversationDraft,
  queueItemId?: string,
): SubmittedConversationDraft {
  return {
    identityKey,
    revision: draft.revision,
    textRevision: draft.textRevision,
    mentionsRevision: draft.mentionsRevision,
    text: draft.text,
    mentionedAgentIds: [...draft.mentionedAgentIds],
    attachmentIds: draft.attachments.map(attachment => attachment.id),
    ...(queueItemId === undefined ? {} : { queueItemId }),
  };
}

export function settleDraftSubmission(
  currentIdentityKey: string | null,
  current: ConversationDraft,
  submitted: SubmittedConversationDraft,
  outcome: 'committed' | 'ambiguous',
): ConversationDraft {
  if (outcome !== 'committed' || currentIdentityKey !== submitted.identityKey) return current;
  const clearText = current.textRevision === submitted.textRevision;
  const clearMentions = current.mentionsRevision === submitted.mentionsRevision;
  const submittedAttachments = new Set(submitted.attachmentIds);
  const queuedSubmission = submitted.queueItemId !== undefined;
  return {
    ...current,
    revision: current.revision + 1,
    ...(!queuedSubmission && clearText ? { text: '', textRevision: current.textRevision + 1 } : {}),
    ...(!queuedSubmission && clearMentions ? { mentionedAgentIds: [], mentionsRevision: current.mentionsRevision + 1 } : {}),
    attachments: queuedSubmission ? current.attachments : current.attachments.filter(attachment => !submittedAttachments.has(attachment.id)),
    ...(submitted.queueItemId === undefined ? {} : { queue: current.queue.filter(item => item.id !== submitted.queueItemId) }),
  };
}

export function enqueueDraftSubmission(
  identityKey: string,
  current: ConversationDraft,
  id: string,
): ConversationDraft {
  if (current.queue.some(item => item.id === id)) return current;
  const item: QueuedConversationMessage = {
    id,
    identityKey,
    content: current.text.trim(),
    mentionedAgentIds: [...current.mentionedAgentIds],
    runIntent: current.runIntent,
    ...(current.model === undefined ? {} : { model: current.model }),
    thinkingEffort: current.thinkingEffort,
    attachments: [...current.attachments],
  };
  return {
    ...current,
    revision: current.revision + 1,
    text: '',
    textRevision: current.textRevision + 1,
    mentionedAgentIds: [],
    mentionsRevision: current.mentionsRevision + 1,
    attachments: [],
    queue: [...current.queue, item],
  };
}

export function serializeConversationDraft(draft: ConversationDraft, includeAttachmentMetadata = true): string {
  const attachments: PersistedAttachmentMetadata[] = includeAttachmentMetadata
    ? draft.attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }))
    : [];
  return JSON.stringify({
    schemaVersion: 1,
    revision: draft.revision,
    textRevision: draft.textRevision,
    mentionsRevision: draft.mentionsRevision,
    text: draft.text,
    mentionedAgentIds: [...draft.mentionedAgentIds],
    runIntent: draft.runIntent,
    ...(draft.model === undefined ? {} : { model: draft.model }),
    thinkingEffort: draft.thinkingEffort,
    attachments,
    queue: draft.queue.map(item => ({
      id: item.id,
      identityKey: item.identityKey,
      content: item.content,
      mentionedAgentIds: [...item.mentionedAgentIds],
      runIntent: item.runIntent,
      ...(item.model === undefined ? {} : { model: item.model }),
      thinkingEffort: item.thinkingEffort,
      attachments: includeAttachmentMetadata
        ? item.attachments.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }))
        : [],
    })),
    scrollPosition: draft.scrollPosition,
  });
}

export function deserializeConversationDraft(serialized: string): {
  readonly draft: ConversationDraft;
  readonly attachments: readonly PersistedAttachmentMetadata[];
} | undefined {
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    if (value.schemaVersion !== 1 || typeof value.text !== 'string') return undefined;
    const intent = value.runIntent;
    const queue = Array.isArray(value.queue) ? value.queue.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const entry = item as Record<string, unknown>;
      const mentionedAgentIds = Array.isArray(entry.mentionedAgentIds)
        ? entry.mentionedAgentIds.filter((id): id is string => typeof id === 'string') : [];
      const attachments = Array.isArray(entry.attachments) ? entry.attachments.flatMap(attachment => {
        if (!attachment || typeof attachment !== 'object') return [];
        const metadata = attachment as Record<string, unknown>;
        return typeof metadata.id === 'string' && typeof metadata.name === 'string'
          && typeof metadata.mimeType === 'string' && typeof metadata.size === 'number'
          ? [{ id: metadata.id, name: metadata.name, mimeType: metadata.mimeType, size: metadata.size, previewUrl: '' }]
          : [];
      }) : [];
      const runIntent: RunIntent = entry.runIntent === 'ask' || entry.runIntent === 'review' ? entry.runIntent : 'execute';
      return typeof entry.id === 'string' && typeof entry.identityKey === 'string' && typeof entry.content === 'string'
        ? [{
          id: entry.id,
          identityKey: entry.identityKey,
          content: entry.content,
          mentionedAgentIds,
          runIntent,
          ...(typeof entry.model === 'string' ? { model: entry.model } : {}),
          thinkingEffort: typeof entry.thinkingEffort === 'string' ? entry.thinkingEffort as ThinkingEffort : 'auto',
          attachments,
        }]
        : [];
    }) : [];
    const attachments = Array.isArray(value.attachments) ? value.attachments.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const entry = item as Record<string, unknown>;
      return typeof entry.id === 'string' && typeof entry.name === 'string' && typeof entry.mimeType === 'string' && typeof entry.size === 'number'
        ? [{ id: entry.id, name: entry.name, mimeType: entry.mimeType, size: entry.size }]
        : [];
    }) : [];
    const draft: ConversationDraft = {
      ...createEmptyConversationDraft(),
      revision: nonNegativeInteger(value.revision),
      textRevision: nonNegativeInteger(value.textRevision),
      mentionsRevision: nonNegativeInteger(value.mentionsRevision),
      text: value.text,
      mentionedAgentIds: Array.isArray(value.mentionedAgentIds) ? value.mentionedAgentIds.filter((id): id is string => typeof id === 'string') : [],
      runIntent: intent === 'ask' || intent === 'review' ? intent : 'execute',
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
      thinkingEffort: typeof value.thinkingEffort === 'string' ? value.thinkingEffort as ThinkingEffort : 'auto',
      queue,
      scrollPosition: typeof value.scrollPosition === 'number' && Number.isFinite(value.scrollPosition) ? Math.max(0, value.scrollPosition) : 0,
    };
    return { draft, attachments };
  } catch {
    return undefined;
  }
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
