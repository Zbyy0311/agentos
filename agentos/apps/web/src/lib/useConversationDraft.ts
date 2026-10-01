'use client';

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { RunIntent, ThinkingEffort } from '@agentos/shared';
import { browserConversationDraftRepository, type ConversationDraftRepository } from './conversationDraftRepository';
import { ConversationDraftController } from './conversationDraftController';
import {
  createConversationDraftIdentityKey,
  createEmptyConversationDraft,
  type SubmittedConversationDraft,
  type ConversationDraft,
  type ConversationDraftIdentity,
  type QueuedConversationMessage,
} from './conversationDraftState';
import type { ImageDraft } from './imageAttachments';

export function useConversationDraft(
  identity: ConversationDraftIdentity | null,
  repository: ConversationDraftRepository = browserConversationDraftRepository,
) {
  const identityKey = identity ? createConversationDraftIdentityKey(identity) : null;
  const controller = useMemo(() => new ConversationDraftController(repository), [repository]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    () => controller.getSnapshot(identityKey),
    () => null,
  );

  useEffect(() => {
    if (identity) void controller.load(identity);
  }, [controller, identity, identityKey]);

  const activeSnapshot = snapshot?.identityKey === identityKey ? snapshot : null;
  const activeDraft = activeSnapshot?.draft ?? createEmptyConversationDraft();
  const ready = identityKey !== null && activeSnapshot?.ready === true;
  const warning = activeSnapshot?.warning ?? '';

  const updateDraft = useCallback((update: (current: ConversationDraft) => ConversationDraft) => (
    identityKey ? controller.updateDraft(identityKey, update) : false
  ), [controller, identityKey]);

  const setText = useCallback((value: string | ((current: string) => string)) => updateDraft(current => {
    const text = typeof value === 'function' ? value(current.text) : value;
    return text === current.text ? current : { ...current, text, textRevision: current.textRevision + 1 };
  }), [updateDraft]);
  const setMentions = useCallback((value: string[] | ((current: readonly string[]) => string[])) => updateDraft(current => {
    const mentionedAgentIds = typeof value === 'function' ? value(current.mentionedAgentIds) : value;
    return { ...current, mentionedAgentIds: [...mentionedAgentIds], mentionsRevision: current.mentionsRevision + 1 };
  }), [updateDraft]);
  const setRunIntent = useCallback((runIntent: RunIntent) => updateDraft(current => ({ ...current, runIntent })), [updateDraft]);
  const setModel = useCallback((model: string | undefined) => updateDraft(current => ({ ...current, ...(model === undefined ? { model: undefined } : { model }) })), [updateDraft]);
  const setThinkingEffort = useCallback((thinkingEffort: ThinkingEffort) => updateDraft(current => ({ ...current, thinkingEffort })), [updateDraft]);
  const setAttachments = useCallback((value: ImageDraft[] | ((current: readonly ImageDraft[]) => ImageDraft[])) => updateDraft(current => ({
    ...current,
    attachments: typeof value === 'function' ? value(current.attachments) : value,
  })), [updateDraft]);
  const setQueue = useCallback((value: QueuedConversationMessage[] | ((current: readonly QueuedConversationMessage[]) => QueuedConversationMessage[])) => updateDraft(current => ({
    ...current,
    queue: typeof value === 'function' ? value(current.queue) : value,
  })), [updateDraft]);
  const setScrollPosition = useCallback((scrollPosition: number) => updateDraft(current => ({ ...current, scrollPosition: Math.max(0, scrollPosition) })), [updateDraft]);

  const migrateTo = useCallback(async (
    nextIdentity: ConversationDraftIdentity,
    sourceIdentity: ConversationDraftIdentity | null = identity,
  ) => sourceIdentity ? controller.migrateTo(sourceIdentity, nextIdentity) : undefined, [controller, identity]);

  const settleSubmission = useCallback((
    targetIdentity: ConversationDraftIdentity,
    submitted: SubmittedConversationDraft,
    outcome: 'committed' | 'ambiguous',
  ) => controller.settleSubmission(targetIdentity, submitted, outcome), [controller]);

  return {
    draft: activeDraft,
    ready,
    warning,
    updateDraft,
    setText,
    setMentions,
    setRunIntent,
    setModel,
    setThinkingEffort,
    setAttachments,
    setQueue,
    setScrollPosition,
    migrateTo,
    settleSubmission,
  };
}
