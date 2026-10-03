import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  groupConversationClient,
  mergeGroupInteractionVersionEvent,
  type GroupBudgetStatus,
  type GroupInteraction,
  type GroupInteractionBudgetInput,
  type GroupReply,
  type GroupInteractionDetail,
} from './groupConversationClient';
import { applyGroupWalkEvent, emptyGroupWalk, type GroupWalkStreamState } from './groupWalkStream';
import { consumeSseResponse } from './streamReconnect';
import { nextGroupConversationScope, type GroupConversationScope } from './groupConversationScope';

export interface GroupCanvasState {
  readonly scopeReady: boolean;
  readonly scope: GroupConversationScope;
  readonly isCurrentScope: (scope: GroupConversationScope) => boolean;
  readonly interaction: GroupInteraction | null;
  readonly executionOwner: GroupInteractionDetail['executionOwner'];
  readonly budget: GroupBudgetStatus | null;
  readonly replies: readonly GroupReply[];
  readonly walk: GroupWalkStreamState;
  readonly busy: boolean;
  readonly error: string | undefined;
}

export interface GroupCanvasActions {
  readonly start: (budget: GroupInteractionBudgetInput) => Promise<GroupInteraction | null>;
  readonly run: (interactionId: string, sourceMessageId: string, mentionedAgentIds?: readonly string[], clientMessageId?: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly loadInteraction: (interactionId: string) => Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useGroupConversation(
  workspaceId: string,
  apiBase: string,
  conversationId: string | null,
): GroupCanvasState & GroupCanvasActions {
  const scopeRef = useRef<GroupConversationScope>({ workspaceId, apiBase, conversationId, generation: 0 });
  scopeRef.current = nextGroupConversationScope(scopeRef.current, workspaceId, apiBase, conversationId);
  const scope = scopeRef.current;
  const client = useMemo(() => groupConversationClient({ workspaceId, apiBase }), [workspaceId, apiBase]);
  const [interaction, setInteraction] = useState<GroupInteraction | null>(null);
  const [executionOwner, setExecutionOwner] = useState<GroupInteractionDetail['executionOwner']>(null);
  const [budget, setBudget] = useState<GroupBudgetStatus | null>(null);
  const [replies, setReplies] = useState<readonly GroupReply[]>([]);
  const [walk, setWalk] = useState<GroupWalkStreamState>(emptyGroupWalk);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [stateGeneration, setStateGeneration] = useState(scope.generation);
  const walkAbortRef = useRef<AbortController | null>(null);

  const isCurrentScope = useCallback((expected: GroupConversationScope) => {
    const current = scopeRef.current;
    return current.workspaceId === expected.workspaceId
      && current.apiBase === expected.apiBase
      && current.conversationId === expected.conversationId
      && current.generation === expected.generation;
  }, []);

  const applyDetail = useCallback((detail: {
    interaction: GroupInteraction;
    budget: GroupBudgetStatus;
    replies: readonly GroupReply[];
    executionOwner?: GroupInteractionDetail['executionOwner'];
  }, expected: GroupConversationScope) => {
    if (!isCurrentScope(expected)) return;
    setInteraction(detail.interaction);
    setExecutionOwner(detail.executionOwner ?? null);
    setBudget(detail.budget);
    setReplies(detail.replies);
  }, [isCurrentScope]);

  // Identity changes synchronously advance scopeRef during render; this effect
  // then clears the old canvas and aborts only its observer.
  useEffect(() => {
    walkAbortRef.current?.abort();
    setInteraction(null);
    setExecutionOwner(null);
    setBudget(null);
    setReplies([]);
    setWalk(emptyGroupWalk);
    setError(undefined);
    setBusy(false);
    setStateGeneration(scope.generation);
    return () => walkAbortRef.current?.abort();
  }, [scope.workspaceId, scope.apiBase, scope.conversationId, scope.generation]);

  const loadInteraction = useCallback(async (interactionId: string) => {
    const expected = scope;
    if (!isCurrentScope(expected)) return;
    setError(undefined);
    setWalk(emptyGroupWalk());
    try {
      const detail = await client.getInteraction(interactionId);
      if (detail.interaction.id !== interactionId || detail.interaction.conversationId !== expected.conversationId) return;
      applyDetail(detail, expected);
    } catch (loadError) {
      if (isCurrentScope(expected)) setError(describeError(loadError));
    }
  }, [applyDetail, client, isCurrentScope, scope]);

  useEffect(() => {
    const expected = scope;
    let current = true;
    if (!expected.conversationId) return () => { current = false; };
    void client.listInteractions(expected.conversationId).then(async ({ interactions }) => {
      const latestActive = [...interactions].reverse().find(item => item.status === 'active');
      if (!latestActive) return;
      const detail = await client.getInteraction(latestActive.id);
      if (current && isCurrentScope(expected) && detail.interaction.conversationId === expected.conversationId) {
        applyDetail(detail, expected);
      }
    }).catch(loadError => {
      if (current && isCurrentScope(expected)) setError(describeError(loadError));
    });
    return () => { current = false; };
  }, [applyDetail, client, isCurrentScope, scope]);

  const refresh = useCallback(async () => {
    const expected = scope;
    if (!expected.conversationId || !isCurrentScope(expected)) return;
    const currentId = interaction?.id;
    if (!currentId) return;
    const detail = await client.getInteraction(currentId);
    if (detail.interaction.id === currentId && detail.interaction.conversationId === expected.conversationId) applyDetail(detail, expected);
  }, [applyDetail, client, interaction?.id, isCurrentScope, scope]);

  const start = useCallback(async (input: GroupInteractionBudgetInput) => {
    const expected = scope;
    if (!expected.conversationId || !isCurrentScope(expected)) return null;
    setBusy(true);
    setError(undefined);
    try {
      const created = await client.createInteraction(expected.conversationId, input);
      if (!isCurrentScope(expected) || created.interaction.conversationId !== expected.conversationId) return null;
      setWalk(emptyGroupWalk);
      const detail = await client.getInteraction(created.interaction.id);
      if (!isCurrentScope(expected) || detail.interaction.conversationId !== expected.conversationId) return null;
      applyDetail(detail, expected);
      return created.interaction;
    } catch (createError) {
      if (isCurrentScope(expected)) setError(describeError(createError));
      return null;
    } finally {
      if (isCurrentScope(expected)) setBusy(false);
    }
  }, [applyDetail, client, isCurrentScope, scope]);

  const run = useCallback(async (interactionId: string, sourceMessageId: string, mentionedAgentIds?: readonly string[], clientMessageId?: string) => {
    const expected = scope;
    if (!expected.conversationId || !isCurrentScope(expected)) return;
    setBusy(true);
    setError(undefined);
    setWalk(emptyGroupWalk());
    const abort = new AbortController();
    walkAbortRef.current?.abort();
    walkAbortRef.current = abort;
    try {
      // The guard is immediately before dispatch; a stale callback cannot use
      // a newly rendered workspace client with an old conversation id.
      if (!isCurrentScope(expected)) return;
      const startResponse = await client.respond(interactionId, expected.conversationId, {
        sourceMessageId,
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(mentionedAgentIds === undefined || mentionedAgentIds.length === 0 ? {} : { mentionedAgentIds: [...mentionedAgentIds] }),
      });
      await startResponse.body?.cancel().catch(() => undefined);
      let cursor = 0;
      let attempts = 0;
      while (!abort.signal.aborted && isCurrentScope(expected)) {
        try {
          const response = await client.observeEvents(expected.conversationId, interactionId, cursor, abort.signal);
          await consumeSseResponse(response, (event, data) => {
            if (!isCurrentScope(expected)) return;
            cursor = Math.max(cursor, typeof data.cursor === 'number' ? data.cursor : Number(event.id) || 0);
            setInteraction(current => mergeGroupInteractionVersionEvent(current, data));
            setWalk(current => applyGroupWalkEvent(current, event.event, data));
          }, { terminalEvents: ['group.done', 'group.stopped', 'group.interrupted'] });
          attempts = 0;
        } catch (observationError) {
          if (abort.signal.aborted || !isCurrentScope(expected)) break;
          const latest = await client.getInteraction(interactionId);
          if (!isCurrentScope(expected) || latest.interaction.conversationId !== expected.conversationId) break;
          applyDetail(latest, expected);
          if (latest.interaction.status !== 'active') break;
          attempts += 1;
          if (attempts > 5) throw observationError;
          await new Promise(resolve => window.setTimeout(resolve, Math.min(1000 * (2 ** (attempts - 1)), 8000)));
        }
        if (abort.signal.aborted || !isCurrentScope(expected)) break;
        const latest = await client.getInteraction(interactionId);
        if (!isCurrentScope(expected) || latest.interaction.conversationId !== expected.conversationId) break;
        applyDetail(latest, expected);
        if (latest.interaction.status !== 'active') break;
      }
      if (!abort.signal.aborted && isCurrentScope(expected)) {
        const latest = await client.getInteraction(interactionId);
        if (latest.interaction.conversationId === expected.conversationId) applyDetail(latest, expected);
      }
    } catch (runError) {
      if (isCurrentScope(expected) && !(runError instanceof DOMException && runError.name === 'AbortError')) setError(describeError(runError));
      if (isCurrentScope(expected)) {
        try {
          const detail = await client.getInteraction(interactionId);
          if (detail.interaction.conversationId === expected.conversationId) applyDetail(detail, expected);
        } catch { /* Keep the last current-scope snapshot. */ }
      }
    } finally {
      if (walkAbortRef.current === abort) walkAbortRef.current = null;
      if (isCurrentScope(expected)) setBusy(false);
    }
  }, [applyDetail, client, isCurrentScope, scope]);

  const stop = useCallback(async () => {
    const expected = scope;
    const currentInteraction = interaction;
    if (!expected.conversationId || !currentInteraction || !isCurrentScope(expected)) return;
    setBusy(true);
    setError(undefined);
    try {
      const latest = await client.getInteraction(currentInteraction.id);
      if (!isCurrentScope(expected) || latest.interaction.conversationId !== expected.conversationId) return;
      setInteraction(latest.interaction);
      const result = await client.stopInteraction(
        latest.interaction.id,
        latest.interaction.version,
        `group-ui-stop-${latest.interaction.id}-${latest.interaction.version}`,
      );
      if (!isCurrentScope(expected)) return;
      setInteraction(result.interaction);
      const detail = await client.getInteraction(currentInteraction.id);
      if (detail.interaction.conversationId === expected.conversationId) applyDetail(detail, expected);
    } catch (stopError) {
      if (!isCurrentScope(expected)) return;
      if ((stopError as { code?: string })?.code === 'GROUP_VERSION_CONFLICT') {
        try {
          const detail = await client.getInteraction(currentInteraction.id);
          if (isCurrentScope(expected) && detail.interaction.conversationId === expected.conversationId) applyDetail(detail, expected);
        } catch { /* keep last confirmed snapshot */ }
        if (isCurrentScope(expected)) setError('群聊版本已变化，已刷新状态；未自动重试停止操作，请确认后再点击。');
        return;
      }
      setError(describeError(stopError));
    } finally {
      if (isCurrentScope(expected)) setBusy(false);
    }
  }, [applyDetail, client, interaction, isCurrentScope, scope]);

  return { interaction, executionOwner, budget, replies, walk, busy, error, scopeReady: stateGeneration === scope.generation, scope, isCurrentScope, start, run, stop, refresh, loadInteraction };
}
