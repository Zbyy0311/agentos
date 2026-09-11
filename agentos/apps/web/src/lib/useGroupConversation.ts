import { useCallback, useEffect, useRef, useState } from 'react';

import {
  groupConversationClient,
  type GroupBudgetStatus,
  type GroupInteraction,
  type GroupInteractionBudgetInput,
  type GroupReply,
} from './groupConversationClient';
import { applyGroupWalkEvent, emptyGroupWalk, type GroupWalkStreamState } from './groupWalkStream';
import { consumeSseResponse } from './streamReconnect';

/**
 * Controlled Group Conversation — the canvas state for one group Conversation.
 *
 * Owns the active interaction and the live walk. Sending a user Message creates
 * one bounded interaction and runs the walk against it: the runtime selects the
 * speakers, never the caller. The walk is chat-class; no Task or Run is made.
 */

export interface GroupCanvasState {
  readonly interaction: GroupInteraction | null;
  readonly budget: GroupBudgetStatus | null;
  readonly replies: readonly GroupReply[];
  readonly walk: GroupWalkStreamState;
  readonly busy: boolean;
  readonly error: string | undefined;
}

export interface GroupCanvasActions {
  readonly start: (budget: GroupInteractionBudgetInput) => Promise<GroupInteraction | null>;
  readonly run: (interactionId: string, sourceMessageId: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useGroupConversation(
  workspaceId: string,
  apiBase: string,
  conversationId: string | null,
): GroupCanvasState & GroupCanvasActions {
  const clientRef = useRef(groupConversationClient({ workspaceId, apiBase }));
  clientRef.current = groupConversationClient({ workspaceId, apiBase });
  const [interaction, setInteraction] = useState<GroupInteraction | null>(null);
  const [budget, setBudget] = useState<GroupBudgetStatus | null>(null);
  const [replies, setReplies] = useState<readonly GroupReply[]>([]);
  const [walk, setWalk] = useState<GroupWalkStreamState>(emptyGroupWalk);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // The walk's SSE keeps its own AbortController so a stop can cut the stream
  // without tearing down the page.
  const walkAbortRef = useRef<AbortController | null>(null);

  // Switching conversations resets the whole canvas.
  useEffect(() => {
    setInteraction(null);
    setBudget(null);
    setReplies([]);
    setWalk(emptyGroupWalk);
    setError(undefined);
    setBusy(false);
  }, [conversationId]);

  const applyDetail = useCallback((detail: {
    interaction: GroupInteraction;
    budget: GroupBudgetStatus;
    replies: readonly GroupReply[];
  }) => {
    setInteraction(detail.interaction);
    setBudget(detail.budget);
    setReplies(detail.replies);
  }, []);

  const refresh = useCallback(async () => {
    if (!conversationId) return;
    setInteraction(current => current);
    const currentId = interaction?.id;
    if (!currentId) return;
    applyDetail(await clientRef.current.getInteraction(currentId));
  }, [conversationId, interaction?.id, applyDetail]);

  const start = useCallback(async (input: GroupInteractionBudgetInput) => {
    if (!conversationId) return null;
    setBusy(true);
    setError(undefined);
    try {
      const created = await clientRef.current.createInteraction(conversationId, input);
      setWalk(emptyGroupWalk);
      applyDetail(await clientRef.current.getInteraction(created.interaction.id));
      return created.interaction;
    } catch (createError) {
      setError(describeError(createError));
      return null;
    } finally {
      setBusy(false);
    }
  }, [conversationId, applyDetail]);

  const run = useCallback(async (interactionId: string, sourceMessageId: string) => {
    if (!conversationId) return;
    setBusy(true);
    setError(undefined);
    setWalk(emptyGroupWalk());
    const abort = new AbortController();
    walkAbortRef.current = abort;
    try {
      const response = await clientRef.current.respond(interactionId, conversationId, {
        sourceMessageId,
      });
      await consumeSseResponse(response, (event, data) => {
        setWalk(current => applyGroupWalkEvent(current, event.event, data));
      });
      // Re-read the interaction so the budget, hop chain, and terminal state the
      // view shows are the committed ones, not the stream's view.
      applyDetail(await clientRef.current.getInteraction(interactionId));
    } catch (runError) {
      if (!(runError instanceof DOMException && runError.name === 'AbortError')) {
        setError(describeError(runError));
      }
      try {
        applyDetail(await clientRef.current.getInteraction(interactionId));
      } catch {
        // Best-effort re-read after a failed walk; the stream already ended.
      }
    } finally {
      walkAbortRef.current = null;
      setBusy(false);
    }
  }, [conversationId, applyDetail]);

  const stop = useCallback(async () => {
    const currentInteraction = interaction;
    if (!currentInteraction) return;
    setBusy(true);
    setError(undefined);
    try {
      // Cut the live stream first so no further delta lands, then persist the stop.
      walkAbortRef.current?.abort();
      await clientRef.current.stopInteraction(currentInteraction.id, currentInteraction.version);
      applyDetail(await clientRef.current.getInteraction(currentInteraction.id));
    } catch (stopError) {
      setError(describeError(stopError));
    } finally {
      setBusy(false);
    }
  }, [interaction, applyDetail]);

  return { interaction, budget, replies, walk, busy, error, start, run, stop, refresh };
}
