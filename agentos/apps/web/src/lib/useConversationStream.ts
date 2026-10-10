'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, AgentExecution, AgentProfile, AgentRun, AgentRunDetails, Conversation, ConversationMessage, ExecutionEvent, ExecutionStatus, RunStep, RuntimeArtifact, ThinkingEffort } from '@agentos/shared';
import type { ApiOptions } from './useApi';
import type { useConversationDraft } from './useConversationDraft';
import type { ConversationDraftIdentity, QueuedConversationMessage } from './conversationDraftState';
import { captureDraftSubmission, createConversationDraftIdentityKey, enqueueDraftSubmission, isCurrentConversationGeneration } from './conversationDraftState';
import { completeDirectConversationSubmission } from './conversationDraftLifecycle';
import { getDoneExecution } from './streamDoneExecution';
import { MAX_RECONNECT_ATTEMPTS, StreamHttpError, TerminalStreamError, UnexpectedStreamEndError, consumeSseResponse, getReconnectDelay, retryWithExponentialBackoff, shouldReconnect } from './streamReconnect';
import { TypewriterQueue } from './typewriterQueue';
import { selectActiveRunExecutions } from './runtimeSelection';
import { collapseStreamingExecutionEvents } from './executionTimeline';
import { upsertRunStep } from './runSteps';
import { mergeRuntimeEvent, projectRuntimeResult, type RuntimeResultProjection } from './runtimeProjection';
import { resolveAttachmentUrl } from './attachmentUrls';
import { canSendMessage, imageDraftDataUrl } from './imageAttachments';
import { getComposerSendIntent } from './composerInteraction';
import { getComposerValidationError, type ToastTone } from './uiFeedback';
import { getRuntimeOverrides } from './composerSettings';
import { classifyRunConversationBinding } from './runConversationBinding';
import type { DirectConversationClient } from './directConversationClient';
import { browserGroupDiscussionOutbox, type PendingGroupDiscussion } from './groupDiscussionOutbox';
import { mergeGroupInteractionVersionEvent, type GroupConversationClient, type GroupInteraction, type GroupInteractionBudgetInput, type GroupInteractionDetail, type GroupInteractionRecoveryResult } from './groupConversationClient';
import { toUiGroupMessage } from './uiGroupConversation';
import { StreamingTextStore } from './streamingTextStore';
import type { GroupRecoveryDispatchState, GroupRecoveryIdentity } from '@/components/chat/GroupInteractionRecoveryPanel';

export type VisibleExecutionEvent = ExecutionEvent & { agentId?: string; agentName?: string };
type StreamEvent = Pick<VisibleExecutionEvent, 'status' | 'activity' | 'content' | 'agentId' | 'agentName'>;
export type ConversationStreamData = StreamEvent & { cursor?: number; runId?: string; run?: AgentRun; message?: ConversationMessage; execution?: AgentExecution; executions?: AgentExecution[]; runtime?: AgentEvent; runStep?: RunStep; eventId?: string; sequence?: number; error?: string };

export type ConversationStreamView = 'chat' | 'execution';

export type WorkspaceApiRequest = <T = unknown>(path: string, options?: ApiOptions) => Promise<T>;

export interface WorkspaceRouterLike {
  push(href: string): void;
  replace(href: string): void;
}

export interface ConversationStreamOptions {
  workspaceId: string | null;
  apiBase: string;
  request: WorkspaceApiRequest;
  router: WorkspaceRouterLike;
  draftState: ReturnType<typeof useConversationDraft>;
  draftIdentity: ConversationDraftIdentity | null;
  activeDraftIdentityKey: string | null;
  explicitSelectionVerified: boolean;
  activeConversationId: string | null;
  isGroupConversation: boolean;
  agents: AgentProfile[];
  selectedAgent: AgentProfile | undefined;
  selectedConversation: Conversation | undefined;
  selectedGroupId: string | null;
  activeWorkspaceView: ConversationStreamView;
  runtimeClient: DirectConversationClient | null;
  groupClient: GroupConversationClient | null;
  loadPresence(): Promise<void>;
  notifyError(error: unknown, fallback?: string): void;
  pushToast(tone: ToastTone, message: string): void;
  setError(message: string): void;
  setConnectionNotice(message: string): void;
  setValidationError(message: string): void;
  setAttachmentError(message: string): void;
  /** Page-level half of resetConversationEvidence: clears shared feedback state. */
  onResetFeedback(): void;
  /** Explicit Run hint from the URL/local hint state, for run-link verification. */
  activeExecutionRunHint: string | undefined;
  /** Applies the selection/list updates after a direct send creates its conversation. */
  applyCreatedConversation(conversation: Conversation, fallbackAgentId: string | null): void;
  persistConversationSettings(conversationId: string, model: string | undefined, thinkingEffort: ThinkingEffort): Promise<Conversation>;
  prependConversation(conversation: Conversation): void;
  selectCreatedConversation(conversationId: string): void;
  composerModel: string | undefined;
  composerThinkingEffort: ThinkingEffort;
}

function waitForReconnect(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The reconnect was aborted', 'AbortError'));
      return;
    }
    let abort: () => void;
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    abort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(new DOMException('The reconnect was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Owns everything about the active conversation's evidence: message/execution
 * state, group interaction state, the SSE send pipeline, the typewriter
 * streaming queue, run-link verification and the draft submission queue.
 *
 * Streamed assistant text is pushed into a StreamingTextStore instead of page
 * state, so the 12 ms typewriter ticks re-render only the subscribing
 * ChatPanel; the page layer re-renders when a message completes instead.
 */
export function useConversationStream(options: ConversationStreamOptions) {
  const {
    workspaceId, apiBase, request, router, draftState, draftIdentity, activeDraftIdentityKey,
    explicitSelectionVerified, activeConversationId, isGroupConversation, agents, selectedAgent,
    selectedConversation, selectedGroupId, activeWorkspaceView, runtimeClient, groupClient,
    loadPresence, notifyError, pushToast,
    setError, setConnectionNotice, setValidationError, setAttachmentError,
    onResetFeedback, activeExecutionRunHint, applyCreatedConversation,
    persistConversationSettings, prependConversation, selectCreatedConversation,
    composerModel, composerThinkingEffort,
  } = options;

  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [conversationEvidenceIdentityKey, setConversationEvidenceIdentityKey] = useState<string | null>(null);
  const [conversationEvidenceGeneration, setConversationEvidenceGeneration] = useState(0);
  const [executions, setExecutions] = useState<AgentExecution[]>([]);
  const [activeEvents, setActiveEvents] = useState<VisibleExecutionEvent[]>([]);
  const [activeRuntimeEvents, setActiveRuntimeEvents] = useState<AgentEvent[]>([]);
  const [activeRunSteps, setActiveRunSteps] = useState<RunStep[]>([]);
  const [activeArtifacts, setActiveArtifacts] = useState<RuntimeArtifact[]>([]);
  const [activeRuntimeResult, setActiveRuntimeResult] = useState<RuntimeResultProjection | null>(null);
  const [groupInteraction, setGroupInteraction] = useState<GroupInteraction | null>(null);
  const [groupExecutionOwner, setGroupExecutionOwner] = useState<GroupInteractionDetail['executionOwner']>(null);
  const [groupBudget, setGroupBudget] = useState<{ repliesUsed: number; repliesRemaining: number; hopsUsed: number; hopsRemaining: number; distinctAgents: number; agentsRemaining: number } | null>(null);
  const [groupDiscussionError, setGroupDiscussionError] = useState('');
  const [groupSpeakingAgentId, setGroupSpeakingAgentId] = useState<string | undefined>();
  const [conversationRuns, setConversationRuns] = useState<AgentRun[]>([]);
  const [activeStatus, setActiveStatus] = useState<ExecutionStatus>();
  const [activeStartedAt, setActiveStartedAt] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [activeWaitingQuestion, setActiveWaitingQuestion] = useState<string>();
  const [sendingIdentityKeys, setSendingIdentityKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [runLinkState, setRunLinkState] = useState<{ readonly key: string; readonly binding: 'matched' | 'unattached' | 'mismatch' | 'loading'; readonly error?: string } | null>(null);

  const streamingStoreRef = useRef<StreamingTextStore | null>(null);
  if (streamingStoreRef.current === null) streamingStoreRef.current = new StreamingTextStore();
  const streamingStore = streamingStoreRef.current;
  const drainingQueueRef = useRef(false);
  const runDetailsCacheRef = useRef(new Map<string, Promise<AgentRunDetails>>());
  const conversationLoadGenerationRef = useRef(0);
  const activeConversationIdRef = useRef<string | null>(null);
  const activeGroupInteractionIdRef = useRef<string | null>(null);
  const blockedQueueItemByIdentityRef = useRef(new Map<string, string>());
  const activeScopeGenerationRef = useRef({ identityKey: null as string | null, generation: 0 });
  const activeSendRef = useRef(new Map<string, { identityKey: string; generation: number; directController?: AbortController; observerController?: AbortController; runId?: string; cancelled: boolean }>());
  const typewriterRef = useRef(new TypewriterQueue());
  const typewriterOwnerRef = useRef<{ identityKey: string; generation: number } | null>(null);
  const groupRecoveryObserverRef = useRef(new Map<string, AbortController>());
  const activeDraftIdentityKeyRef = useRef(activeDraftIdentityKey);
  activeDraftIdentityKeyRef.current = activeDraftIdentityKey;
  activeConversationIdRef.current = activeConversationId;
  activeGroupInteractionIdRef.current = groupInteraction?.id ?? null;
  if (activeScopeGenerationRef.current.identityKey !== activeDraftIdentityKey) {
    activeScopeGenerationRef.current = {
      identityKey: activeDraftIdentityKey,
      generation: activeScopeGenerationRef.current.generation + 1,
    };
  }

  const sending = Boolean(activeDraftIdentityKey && sendingIdentityKeys.has(activeDraftIdentityKey));
  const evidenceVisible = explicitSelectionVerified && activeDraftIdentityKey !== null
    && conversationEvidenceIdentityKey === activeDraftIdentityKey
    && conversationEvidenceGeneration === activeScopeGenerationRef.current.generation;
  const directRunLinkKey = !isGroupConversation && activeConversationId && activeDraftIdentityKey && activeExecutionRunHint
    ? JSON.stringify([activeDraftIdentityKey, activeScopeGenerationRef.current.generation, activeExecutionRunHint]) : null;
  const directRunBinding = directRunLinkKey ? runLinkState?.key === directRunLinkKey ? runLinkState.binding : 'loading' : null;

  const resetEvidence = useCallback(() => {
    setMessages([]); streamingStore.clear(); setConversationRuns([]); setExecutions([]);
    setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null);
    setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined);
    setGroupInteraction(null); setGroupBudget(null); setGroupSpeakingAgentId(undefined); setGroupExecutionOwner(null);
    setGroupDiscussionError('');
  }, [streamingStore]);

  useEffect(() => {
    // Withdraw the previous owner's evidence before its replacement request
    // resolves. The render-time identity/generation gate covers this effect gap.
    conversationLoadGenerationRef.current += 1;
    typewriterRef.current.flush();
    typewriterOwnerRef.current = null;
    setConversationEvidenceIdentityKey(activeDraftIdentityKey);
    setConversationEvidenceGeneration(activeScopeGenerationRef.current.generation);
    resetEvidence();
    onResetFeedback();
    for (const [key, operation] of activeSendRef.current) {
      if (key !== activeDraftIdentityKey) operation.observerController?.abort();
    }
    for (const [key, controller] of groupRecoveryObserverRef.current) {
      if (key !== activeDraftIdentityKey) { controller.abort(); groupRecoveryObserverRef.current.delete(key); }
    }
  }, [activeDraftIdentityKey, onResetFeedback, resetEvidence]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const owner = typewriterOwnerRef.current;
      if (!owner || !isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, owner.identityKey, owner.generation)) {
        typewriterRef.current.flush();
        return;
      }
      const character = typewriterRef.current.drainOne();
      if (character) streamingStore.append(character);
    }, 12);
    return () => window.clearInterval(timer);
  }, [streamingStore]);

  const loadRunDetails = useCallback((runId: string): Promise<AgentRunDetails> => {
    if (!workspaceId) return Promise.reject(new Error('Workspace is unavailable'));
    const cacheKey = `${workspaceId}:${runId}`;
    const cached = runDetailsCacheRef.current.get(cacheKey);
    if (cached) return cached;
    const pending = request<AgentRunDetails>(`/api/workspaces/${workspaceId}/runs/${runId}`)
      .finally(() => {
        // Deduplicate only overlapping requests. A completed run must be
        // fetched again so streaming, approval, and artifact updates cannot
        // be frozen behind a permanently cached Promise.
        if (runDetailsCacheRef.current.get(cacheKey) === pending) runDetailsCacheRef.current.delete(cacheKey);
      });
    runDetailsCacheRef.current.set(cacheKey, pending);
    return pending;
  }, [request, workspaceId]);

  useEffect(() => {
    if (!directRunLinkKey || !activeExecutionRunHint || !activeConversationId || !workspaceId || !explicitSelectionVerified) return;
    let cancelled = false;
    setRunLinkState({ key: directRunLinkKey, binding: 'loading' });
    void loadRunDetails(activeExecutionRunHint).then(details => {
      if (cancelled) return;
      const binding = details.run.workspaceId === workspaceId
        ? classifyRunConversationBinding(details.run, activeConversationId) : 'mismatch';
      setRunLinkState({ key: directRunLinkKey, binding, ...(binding === 'mismatch' ? { error: '指定的 Run 不属于当前会话；未展示其证据或写操作。' } : {}) });
    }).catch(linkError => {
      if (!cancelled) setRunLinkState({ key: directRunLinkKey, binding: 'mismatch', error: `无法验证指定 Run：${linkError instanceof Error ? linkError.message : String(linkError)}` });
    });
    return () => { cancelled = true; };
  }, [activeConversationId, activeExecutionRunHint, directRunLinkKey, explicitSelectionVerified, loadRunDetails, workspaceId]);

  const loadConversationDetails = useCallback(async (conversationId: string) => {
    if (!workspaceId) return;
    const generation = conversationLoadGenerationRef.current + 1;
    conversationLoadGenerationRef.current = generation;
    const identityKey = createConversationDraftIdentityKey({ workspaceId, storageSource: 'workspace', conversationId });
    const scopeGeneration = activeScopeGenerationRef.current.generation;
    const isCurrentConversation = () => conversationLoadGenerationRef.current === generation
      && isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, identityKey, scopeGeneration);
    const [messageResult, executionResult, runResult] = await Promise.all([
      request<{ messages: ConversationMessage[] }>(`/api/workspaces/${workspaceId}/conversations/${conversationId}/messages`),
      request<{ executions: Array<AgentExecution & { events: ExecutionEvent[] }> }>(`/api/workspaces/${workspaceId}/conversations/${conversationId}/executions`),
      request<{ runs: AgentRun[] }>(`/api/workspaces/${workspaceId}/runs?conversationId=${encodeURIComponent(conversationId)}`),
    ]);
    if (!isCurrentConversation()) return;
    const validRuns = runResult.runs.filter(run => run.workspaceId === workspaceId && run.conversationId === conversationId);
    const activeRun = selectActiveRunExecutions(executionResult.executions, validRuns);
    const latestRun = validRuns[0];
    const latestRunDetails = latestRun ? await loadRunDetails(latestRun.id) : undefined;
    if (!isCurrentConversation()) return;
    const runtimeResult = latestRunDetails
      ? projectRuntimeResult(latestRunDetails, { workspaceId, conversationId, runId: activeRun.runId ?? latestRun?.id })
      : undefined;
    setMessages(messageResult.messages.map(message => ({
      ...message,
      attachments: message.attachments?.map(attachment => ({
        ...attachment,
        url: resolveAttachmentUrl(apiBase, attachment.url),
      })),
    })));
    setConversationRuns(validRuns);
    setExecutions(activeRun.executions);
    const agentNames = new Map(agents.map(agent => [agent.id, agent.name]));
    const visibleEvents = activeRun.executions
      .flatMap(execution => execution.events.map(event => ({
        ...event,
        agentId: execution.agentId,
        agentName: agentNames.get(execution.agentId),
      })))
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    setActiveEvents(collapseStreamingExecutionEvents(visibleEvents));
    const activeExecutionIds = new Set(activeRun.executions.map(execution => execution.id));
    setActiveRuntimeEvents((runtimeResult?.events ?? []).filter(event => !event.executionId || activeExecutionIds.has(event.executionId)));
    setActiveRunSteps(runtimeResult?.steps ?? []);
    setActiveStatus(activeRun.executions[0]?.status);
    setActiveStartedAt(activeRun.executions[0]?.startedAt);
    setActiveRunId(activeRun.runId);
    setActiveWaitingQuestion(runResult.runs[0]?.waitingQuestion);
    setActiveArtifacts(runtimeResult?.artifacts ?? []);
    setActiveRuntimeResult(runtimeResult ?? null);
  }, [apiBase, agents, loadRunDetails, request, workspaceId]);

  const loadCanonicalGroupDetails = useCallback(async (conversationId: string) => {
    if (!workspaceId || !runtimeClient || !groupClient) return;
    const generation = conversationLoadGenerationRef.current + 1;
    conversationLoadGenerationRef.current = generation;
    const identityKey = createConversationDraftIdentityKey({ workspaceId, storageSource: 'runtime', conversationId });
    const scopeGeneration = activeScopeGenerationRef.current.generation;
    const isCurrent = () => conversationLoadGenerationRef.current === generation
      && isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, identityKey, scopeGeneration);
    const [messageResult, interactionResult] = await Promise.all([
      runtimeClient.listMessages(conversationId),
      groupClient.listInteractions(conversationId),
    ]);
    if (!isCurrent()) return;
    const ordered = [...interactionResult.interactions].sort((left, right) => left.id.localeCompare(right.id));
    const selected = [...ordered].reverse().find(item => item.status === 'active') ?? ordered.at(-1);
    const detail = selected ? await groupClient.getInteraction(selected.id) : undefined;
    if (!isCurrent()) return;
    setMessages(messageResult.messages.map(message => toUiGroupMessage(message, conversationId, workspaceId, apiBase)));
    setGroupInteraction(detail?.interaction ?? selected ?? null);
    setGroupExecutionOwner(detail?.executionOwner ?? null);
    setGroupBudget(detail?.budget ?? null);
    setGroupDiscussionError('');
    setConversationRuns([]);
    setExecutions([]);
    setActiveEvents([]);
    setActiveRuntimeEvents([]);
    setActiveRunSteps([]);
    setActiveArtifacts([]);
    setActiveRuntimeResult(null);
    setActiveStatus(undefined);
    setActiveStartedAt(undefined);
    setActiveRunId(undefined);
    setActiveWaitingQuestion(undefined);
  }, [apiBase, groupClient, runtimeClient, workspaceId]);

  useEffect(() => {
    if (activeConversationId && !isGroupConversation && explicitSelectionVerified) {
      const key = activeDraftIdentityKey;
      const generation = activeScopeGenerationRef.current.generation;
      void loadConversationDetails(activeConversationId).catch(loadError => { if (key && isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, key, generation)) notifyError(loadError, '加载会话详情失败'); });
    }
  }, [activeConversationId, activeDraftIdentityKey, explicitSelectionVerified, isGroupConversation, loadConversationDetails, notifyError]);

  useEffect(() => {
    if (activeConversationId && isGroupConversation && explicitSelectionVerified) {
      const key = activeDraftIdentityKey;
      const generation = activeScopeGenerationRef.current.generation;
      void loadCanonicalGroupDetails(activeConversationId).catch(loadError => { if (key && isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, key, generation)) notifyError(loadError, '加载群聊详情失败'); });
    }
  }, [activeConversationId, activeDraftIdentityKey, explicitSelectionVerified, isGroupConversation, loadCanonicalGroupDetails, notifyError]);

  const createConversation = useCallback(async (createOptions?: {
    readonly agent?: AgentProfile;
    readonly model?: string;
    readonly thinkingEffort?: ThinkingEffort;
    readonly sourceIdentity?: ConversationDraftIdentity;
    readonly sourceIdentityKey?: string;
    readonly sourceGeneration?: number;
    readonly select?: boolean;
  }): Promise<Conversation | null> => {
    const agent = createOptions?.agent ?? selectedAgent;
    if (!workspaceId || !agent) return null;
    const sourceIdentity = createOptions?.sourceIdentity ?? draftIdentity;
    const sourceIdentityKey = createOptions?.sourceIdentityKey ?? activeDraftIdentityKey;
    const sourceGeneration = createOptions?.sourceGeneration ?? activeScopeGenerationRef.current.generation;
    const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations`, { method: 'POST', body: { agentId: agent.id } });
    const conversation = await persistConversationSettings(result.conversation.id, createOptions?.model ?? composerModel, createOptions?.thinkingEffort ?? composerThinkingEffort);
    const stillCurrent = sourceIdentityKey !== null && isCurrentConversationGeneration(
      activeDraftIdentityKeyRef.current,
      activeScopeGenerationRef.current.generation,
      sourceIdentityKey,
      sourceGeneration,
    );
    if (createOptions?.select !== false) {
      if (sourceIdentity && !sourceIdentity.conversationId) {
        await draftState.migrateTo({ workspaceId, storageSource: 'workspace', conversationId: conversation.id }, sourceIdentity);
      }
      if (!stillCurrent || !sourceIdentityKey || !isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, sourceIdentityKey, sourceGeneration)) return conversation;
      prependConversation(conversation);
      selectCreatedConversation(conversation.id);
      router.replace(`/workspace/${encodeURIComponent(workspaceId)}?conversationSource=workspace&conversationId=${encodeURIComponent(conversation.id)}&view=chat`);
      resetEvidence();
      onResetFeedback();
    }
    return conversation;
  }, [activeDraftIdentityKey, composerModel, composerThinkingEffort, draftIdentity, draftState.migrateTo, onResetFeedback, persistConversationSettings, prependConversation, request, resetEvidence, router, selectCreatedConversation, selectedAgent, workspaceId]);

  const handleGroupInteractionRecovered = useCallback(async (
    result: GroupInteractionRecoveryResult,
    dispatch: GroupRecoveryDispatchState,
    identity: GroupRecoveryIdentity,
  ) => {
    const { conversationId: recoveredConversationId, identityKey: recoveryIdentityKey, generation: recoveryGeneration, workspaceId: recoveryWorkspaceId } = identity;
    const isRecoveryIdentityCurrent = () => workspaceId === recoveryWorkspaceId
      && activeConversationIdRef.current === recoveredConversationId
      && activeGroupInteractionIdRef.current === identity.interactionId
      && isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, recoveryIdentityKey, recoveryGeneration);
    if (!recoveryWorkspaceId || !recoveredConversationId || !recoveryIdentityKey || !groupClient || !runtimeClient
      || result.interaction.conversationId !== recoveredConversationId
      || result.interaction.id === identity.interactionId
      || (result.message.conversationId !== undefined && result.message.conversationId !== recoveredConversationId)) {
      throw new Error('恢复响应不属于发起请求的群聊；已停止后续启动。');
    }
    const sourceMessageId = result.message.id;
    if (!sourceMessageId || result.interaction.sourceMessageId !== sourceMessageId) {
      throw new Error('恢复响应的新轮次与源消息不匹配；已停止后续启动。');
    }

    // The click authorized only this response's new interaction and source
    // message. Do not replace the visible old interaction before the response
    // is confirmed: the recovery panel must remain mounted to show an uncertain
    // respond result and keep its durable retry fence visible.
    // The recovery CAS can settle after navigation, but the linked interaction
    // may only start while its original source identity is still visible.
    if (!isRecoveryIdentityCurrent()) return;
    if (!dispatch.markResponding()) return;
    const startResponse = await groupClient.respond(result.interaction.id, recoveredConversationId, {
      sourceMessageId,
      ...(result.message.clientMessageId ? { clientMessageId: result.message.clientMessageId } : {}),
      ...(result.participantAgentIds?.length ? { mentionedAgentIds: [...result.participantAgentIds] } : {}),
    });
    await startResponse.body?.cancel().catch(() => undefined);
    dispatch.markDispatched();

    if (!isRecoveryIdentityCurrent()) return;
    const existing = groupRecoveryObserverRef.current.get(recoveryIdentityKey);
    existing?.abort();
    const observer = new AbortController();
    groupRecoveryObserverRef.current.set(recoveryIdentityKey, observer);
    void (async () => {
      let cursor = 0;
      try {
        while (!observer.signal.aborted && isRecoveryIdentityCurrent()) {
          const response = await groupClient.observeEvents(recoveredConversationId, result.interaction.id, cursor, observer.signal);
          const consumed = await consumeSseResponse(response, async (event, payload) => {
            const eventCursor = typeof payload.cursor === 'number' ? payload.cursor : Number(event.id);
            if (!Number.isSafeInteger(eventCursor) || eventCursor <= cursor || !isRecoveryIdentityCurrent()) return;
            cursor = eventCursor;
            setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, payload));
            if (event.event === 'group.turn.start') {
              setGroupSpeakingAgentId(typeof payload.agentId === 'string' ? payload.agentId : undefined);
              streamingStore.clear();
            } else if (event.event === 'group.checkpoint' && typeof payload.delta === 'string') {
              if (typeof payload.agentId === 'string') setGroupSpeakingAgentId(payload.agentId);
              typewriterRef.current.enqueue(payload.delta);
            } else if (event.event === 'group.reply.final' || event.event === 'group.turn.final'
              || event.event === 'group.turn.failed' || event.event === 'group.turn.cancelled') {
              typewriterRef.current.flush(); streamingStore.clear(); setGroupSpeakingAgentId(undefined);
              const [latest, messagesResult] = await Promise.all([
                groupClient.getInteraction(result.interaction.id),
                runtimeClient.listMessages(recoveredConversationId),
              ]);
              if (isRecoveryIdentityCurrent()) {
                setGroupInteraction(latest.interaction); setGroupExecutionOwner(latest.executionOwner ?? null); setGroupBudget(latest.budget);
                setMessages(messagesResult.messages.map(message => toUiGroupMessage(message, recoveredConversationId, recoveryWorkspaceId, apiBase)));
              }
            } else if (event.event === 'group.done' || event.event === 'group.stopped' || event.event === 'group.interrupted') {
              typewriterRef.current.flush(); streamingStore.clear(); setGroupSpeakingAgentId(undefined);
            }
          }, { terminalEvents: ['group.done', 'group.stopped', 'group.interrupted'] });
          cursor = Math.max(cursor, consumed.lastCursor);
          const latest = await groupClient.getInteraction(result.interaction.id);
          if (!isRecoveryIdentityCurrent()) return;
          setGroupInteraction(latest.interaction); setGroupExecutionOwner(latest.executionOwner ?? null); setGroupBudget(latest.budget);
          if (latest.interaction.status !== 'active') break;
        }
      } catch (observationError) {
        if (!observer.signal.aborted && isRecoveryIdentityCurrent()) {
          setGroupDiscussionError(`新轮次已启动；状态观察暂不可用，可重新打开群聊查询，不会再次调用 Provider。（${observationError instanceof Error ? observationError.message : String(observationError)}）`);
        }
      } finally {
        if (groupRecoveryObserverRef.current.get(recoveryIdentityKey) === observer) groupRecoveryObserverRef.current.delete(recoveryIdentityKey);
      }
    })();

    try {
      const [detail, messageResult] = await Promise.all([
        groupClient.getInteraction(result.interaction.id),
        runtimeClient.listMessages(recoveredConversationId),
      ]);
      if (detail.interaction.id !== result.interaction.id || detail.interaction.conversationId !== recoveredConversationId) {
        throw new Error('新轮次详情与当前群聊身份不匹配。');
      }
      if (isRecoveryIdentityCurrent()) {
        setMessages(messageResult.messages.map(message => toUiGroupMessage(message, recoveredConversationId, recoveryWorkspaceId, apiBase)));
        setGroupInteraction(detail.interaction);
        setGroupExecutionOwner(detail.executionOwner ?? null);
        setGroupBudget(detail.budget);
        setGroupDiscussionError('');
      }
    } catch (refreshError) {
      if (isRecoveryIdentityCurrent()) {
        setGroupDiscussionError(`新轮次启动已确认，但状态刷新暂不可用；恢复意图已锁定，不会重复调用 Provider。（${refreshError instanceof Error ? refreshError.message : String(refreshError)}）`);
      }
    }
  }, [apiBase, groupClient, runtimeClient, streamingStore, workspaceId]);

  const handleSend = useCallback(async (queuedItem?: QueuedConversationMessage, recovery?: PendingGroupDiscussion) => {
    const identity = draftIdentity;
    const identityKey = activeDraftIdentityKey;
    const generation = activeScopeGenerationRef.current.generation;
    if (!workspaceId || !identity || !identityKey || !draftState.ready || (!selectedAgent && !selectedGroupId)) return;
    const isCurrentScope = () => isCurrentConversationGeneration(
      activeDraftIdentityKeyRef.current,
      activeScopeGenerationRef.current.generation,
      identityKey,
      generation,
    );
    if (queuedItem && queuedItem.identityKey !== identityKey) return;
    if (activeSendRef.current.has(identityKey)) {
      if (!queuedItem && !recovery && canSendMessage(draftState.draft.text, [...draftState.draft.attachments])) {
        const queueId = globalThis.crypto?.randomUUID?.() ?? `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        draftState.updateDraft(current => enqueueDraftSubmission(identityKey, current, queueId));
        if (isCurrentScope()) pushToast('success', '已加入此会话的执行队列');
      }
      return;
    }
    const group = selectedConversation?.type === 'group';
    let storedOutbox: PendingGroupDiscussion | undefined;
    try {
      storedOutbox = group ? browserGroupDiscussionOutbox.loadForSubmission(identityKey, queuedItem?.id) : undefined;
    } catch (outboxError) {
      blockedQueueItemByIdentityRef.current.set(identityKey, queuedItem?.id ?? 'outbox');
      if (isCurrentScope()) setGroupDiscussionError(outboxError instanceof Error ? outboxError.message : String(outboxError));
      return;
    }
    if (recovery && (!storedOutbox || storedOutbox.idempotencyKey !== recovery.idempotencyKey)) return;
    if (storedOutbox && !recovery && !queuedItem) {
      if (isCurrentScope()) setGroupDiscussionError('原发送结果尚未核实；请恢复原发送，不会把当前新输入借用旧恢复键提交。');
      return;
    }
    const availableAttachments = [...draftState.draft.attachments, ...draftState.draft.queue.flatMap(item => item.attachments)];
    const currentAttachments = storedOutbox
      ? storedOutbox.payload.attachmentIds.flatMap(id => { const attachment = availableAttachments.find(item => item.id === id); return attachment ? [attachment] : []; })
      : queuedItem ? [...queuedItem.attachments] : [...draftState.draft.attachments];
    const contentSource = storedOutbox?.payload.content ?? queuedItem?.content ?? draftState.draft.text;
    const sendIntent = storedOutbox ? 'send' : getComposerSendIntent({ sending, content: contentSource, hasAttachments: currentAttachments.length > 0 });
    if (sendIntent === 'idle') {
      if (isCurrentScope()) setValidationError(getComposerValidationError(contentSource, currentAttachments.length));
      return;
    }
    if (sendIntent === 'queue') {
      if (!contentSource.trim() || queuedItem) return;
      const queueId = globalThis.crypto?.randomUUID?.() ?? `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      draftState.updateDraft(current => enqueueDraftSubmission(identityKey, current, queueId));
      if (isCurrentScope()) pushToast('success', `已加入此会话的执行队列（${draftState.draft.queue.length + 1}）`);
      return;
    }
    if (!storedOutbox && !canSendMessage(contentSource, currentAttachments)) return;
    if (activeSendRef.current.has(identityKey)) return;
    if (isCurrentScope()) { setValidationError(''); setError(''); setConnectionNotice(''); }

    const frozenDraft = queuedItem ? {
      ...draftState.draft,
      text: queuedItem.content,
      mentionedAgentIds: [...queuedItem.mentionedAgentIds],
      runIntent: queuedItem.runIntent,
      model: queuedItem.model,
      thinkingEffort: queuedItem.thinkingEffort,
      attachments: [...queuedItem.attachments],
    } : draftState.draft;
    const submitted = storedOutbox?.submission
      ? storedOutbox.submission
      : captureDraftSubmission(identityKey, frozenDraft, queuedItem?.id);
    const content = storedOutbox?.payload.content ?? frozenDraft.text.trim();
    const mentionedIds = [...(storedOutbox?.payload.mentionedAgentIds ?? frozenDraft.mentionedAgentIds)];
    const intent = storedOutbox?.payload.intent ?? frozenDraft.runIntent;
    const attachmentsForPayload = currentAttachments;
    const needsAttachmentBytes = !storedOutbox || storedOutbox.phase === 'prepared';
    if (needsAttachmentBytes && (attachmentsForPayload.some(item => !item.blob && !item.dataUrl)
      || attachmentsForPayload.length !== (storedOutbox?.payload.attachmentIds.length ?? attachmentsForPayload.length))) {
      blockedQueueItemByIdentityRef.current.set(identityKey, queuedItem?.id ?? 'outbox');
      if (isCurrentScope()) {
        const message = '待发送图片未能从本地存储恢复；请重新选择图片。原恢复键仍保留，未提交少图消息。';
        if (group) setGroupDiscussionError(message); else setAttachmentError(message);
      }
      return;
    }
    const optimisticAttachments = attachmentsForPayload.map(attachment => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, url: attachment.previewUrl }));
    const activeOperation = { identityKey, generation, cancelled: false } as { identityKey: string; generation: number; directController?: AbortController; observerController?: AbortController; runId?: string; cancelled: boolean };
    activeSendRef.current.set(identityKey, activeOperation);
    setSendingIdentityKeys(current => new Set(current).add(identityKey));
    let optimisticId: string | undefined;
    let serverMessagePersisted = false;
    let createdDirectConversation = false;
    let conversation: Conversation | null | undefined = selectedConversation;
    let groupOutboxEntry: PendingGroupDiscussion | undefined = storedOutbox;
    try {
      const attachmentPayload = needsAttachmentBytes ? await Promise.all(attachmentsForPayload.map(async attachment => ({
        name: attachment.name, mimeType: attachment.mimeType, dataUrl: await imageDraftDataUrl(attachment),
      }))) : [];
      if (!conversation) {
        conversation = await createConversation({
          agent: selectedAgent,
          model: frozenDraft.model,
          thinkingEffort: frozenDraft.thinkingEffort,
          sourceIdentity: identity,
          sourceIdentityKey: identityKey,
          sourceGeneration: generation,
          select: false,
        });
        createdDirectConversation = conversation !== null;
      }
      if (!conversation) throw new Error('无法创建会话');
      if (isCurrentScope()) {
        typewriterOwnerRef.current = { identityKey, generation };
        optimisticId = `local-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
        const optimistic: ConversationMessage = { id: optimisticId, conversationId: conversation.id, workspaceId, senderType: 'user', content, attachments: optimisticAttachments, createdAt: new Date().toISOString() };
        setMessages(current => [...current, optimistic]);
        typewriterRef.current.flush();
        streamingStore.clear();
        setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null);
        setActiveStatus('queued'); setActiveStartedAt(undefined); setActiveWaitingQuestion(undefined);
      }

      if (conversation.type === 'group') {
        if (!groupClient || !runtimeClient) throw new Error('群聊服务暂不可用');
        const groupConversation = conversation;
        if (!groupOutboxEntry) {
          const memberResult = await runtimeClient.listMembers(conversation.id);
          const activeMemberCount = memberResult.members.filter(member => member.subjectType === 'agent' && member.status === 'active').length;
          const participantCount = Math.max(1, mentionedIds.length || activeMemberCount || agents.length);
          const budget: GroupInteractionBudgetInput = { maxAgentsPerTurn: participantCount, maxRepliesPerAgent: 1, maxTotalReplies: participantCount, maxAgentHops: participantCount };
          const key = globalThis.crypto?.randomUUID?.() ?? `group-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          groupOutboxEntry = {
            identityKey,
            idempotencyKey: key,
            clientMessageId: key,
            phase: 'prepared',
            payload: { content, intent, mentionedAgentIds: mentionedIds, attachmentIds: attachmentsForPayload.map(item => item.id), budget },
            submission: submitted,
          };
          browserGroupDiscussionOutbox.save(groupOutboxEntry);
        }
        if (!groupOutboxEntry) throw new Error('群聊恢复记录不存在；未发起新讨论。');

        let interactionId = groupOutboxEntry.interactionId;
        let sourceMessageId: string | undefined;
        if (groupOutboxEntry.phase === 'prepared') {
          const savedAttachmentPayload = await Promise.all(groupOutboxEntry.payload.attachmentIds.map(async id => {
            const attachment = attachmentsForPayload.find(item => item.id === id);
            if (!attachment) throw new Error(`待恢复图片 ${id} 不可用，未重发群聊消息`);
            return { name: attachment.name, mimeType: attachment.mimeType, dataUrl: await imageDraftDataUrl(attachment) };
          }));
          const created = await groupClient.createDiscussion(conversation.id, {
            content: groupOutboxEntry.payload.content,
            clientMessageId: groupOutboxEntry.clientMessageId,
            budget: groupOutboxEntry.payload.budget,
            ...(savedAttachmentPayload.length ? { attachments: savedAttachmentPayload } : {}),
            ...(groupOutboxEntry.payload.mentionedAgentIds.length ? { mentionedAgentIds: groupOutboxEntry.payload.mentionedAgentIds } : {}),
          }, groupOutboxEntry.idempotencyKey);
          serverMessagePersisted = true;
          interactionId = created.interaction.id;
          sourceMessageId = created.message.id;
          browserGroupDiscussionOutbox.updatePhase(identityKey, groupOutboxEntry.idempotencyKey, 'created', interactionId);
          groupOutboxEntry = { ...groupOutboxEntry, phase: 'created', interactionId };
          if (isCurrentScope()) {
            const persistedMessage = toUiGroupMessage(created.message, conversation.id, workspaceId, apiBase);
            setMessages(current => {
              const withoutOptimistic = current.filter(message => message.id !== optimisticId);
              return withoutOptimistic.some(message => message.id === persistedMessage.id) ? withoutOptimistic : [...withoutOptimistic, persistedMessage];
            });
            setGroupInteraction(created.interaction);
            setGroupExecutionOwner(null);
          }
        }
        if (!interactionId) throw new Error('恢复记录缺少 interactionId；未尝试新建讨论。');
        if (groupOutboxEntry.phase === 'created') {
          const snapshot = await groupClient.getInteraction(interactionId);
          sourceMessageId ??= snapshot.interaction.sourceMessageId ?? undefined;
          if (isCurrentScope()) { setGroupInteraction(snapshot.interaction); setGroupExecutionOwner(snapshot.executionOwner ?? null); setGroupBudget(snapshot.budget); }
          if (!sourceMessageId) throw new Error('群聊源消息暂不可用；保留恢复记录并等待核对。');
          browserGroupDiscussionOutbox.updatePhase(identityKey, groupOutboxEntry.idempotencyKey, 'responding', interactionId);
          groupOutboxEntry = { ...groupOutboxEntry, phase: 'responding', interactionId };
          try {
            const startResponse = await groupClient.respond(interactionId, conversation.id, {
              sourceMessageId,
              intent: groupOutboxEntry.payload.intent,
              ...(groupOutboxEntry.payload.mentionedAgentIds.length ? { mentionedAgentIds: groupOutboxEntry.payload.mentionedAgentIds } : {}),
            });
            await startResponse.body?.cancel().catch(() => undefined);
          } catch (startError) {
            if (isCurrentScope()) setGroupDiscussionError(`启动响应未确认（${startError instanceof Error ? startError.message : String(startError)}）；未重发启动请求，正在只读查询 owner 事件。`);
          }
        } else {
          const snapshot = await groupClient.getInteraction(interactionId);
          sourceMessageId = snapshot.interaction.sourceMessageId ?? undefined;
          if (isCurrentScope()) { setGroupInteraction(snapshot.interaction); setGroupExecutionOwner(snapshot.executionOwner ?? null); setGroupBudget(snapshot.budget); }
        }
        if (!activeOperation.observerController) activeOperation.observerController = new AbortController();
        const observerSignal = activeOperation.observerController.signal;
        let cursor = groupOutboxEntry.cursor ?? 0;
        let ownerEpoch = groupOutboxEntry.ownerEpoch ?? 0;
        let retryIndex = 0;
        const outboxKey = groupOutboxEntry.idempotencyKey;
        browserGroupDiscussionOutbox.updatePhase(identityKey, outboxKey, 'observing', interactionId);
        while (!observerSignal.aborted) {
          try {
            const response = await groupClient.observeEvents(conversation.id, interactionId, cursor, observerSignal);
            const consumed = await consumeSseResponse(response, async (event, payload) => {
              const eventCursor = typeof payload.cursor === 'number' ? payload.cursor : Number(event.id);
              const eventEpoch = typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : ownerEpoch;
              if (!Number.isSafeInteger(eventCursor) || eventCursor <= cursor) return;
              cursor = eventCursor;
              if (eventEpoch < ownerEpoch) {
                browserGroupDiscussionOutbox.updateCursor(identityKey, outboxKey, cursor, ownerEpoch);
                return;
              }
              ownerEpoch = Math.max(ownerEpoch, eventEpoch);
              browserGroupDiscussionOutbox.updateCursor(identityKey, outboxKey, cursor, ownerEpoch);
              if (!isCurrentScope()) return;
              setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, payload));
              if (event.event === 'group.turn.start') {
                setGroupSpeakingAgentId(typeof payload.agentId === 'string' ? payload.agentId : undefined);
                streamingStore.clear();
              } else if (event.event === 'group.checkpoint') {
                if (typeof payload.agentId === 'string') setGroupSpeakingAgentId(payload.agentId);
                if (typeof payload.delta === 'string') typewriterRef.current.enqueue(payload.delta);
              } else if (event.event === 'group.reply.final' || event.event === 'group.turn.final' || event.event === 'group.turn.failed' || event.event === 'group.turn.cancelled') {
                typewriterRef.current.flush(); streamingStore.clear(); setGroupSpeakingAgentId(undefined);
                const [latest, messageResult] = await Promise.all([groupClient.getInteraction(interactionId), runtimeClient.listMessages(groupConversation.id)]);
                if (isCurrentScope()) {
                  setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, latest.interaction));
                  setGroupExecutionOwner(latest.executionOwner ?? null);
                  setGroupBudget(latest.budget);
                  setMessages(messageResult.messages.map(message => toUiGroupMessage(message, groupConversation.id, workspaceId, apiBase)));
                }
              } else if (event.event === 'group.done' || event.event === 'group.stopped' || event.event === 'group.interrupted') {
                typewriterRef.current.flush(); streamingStore.clear(); setGroupSpeakingAgentId(undefined);
              }
            }, { terminalEvents: ['group.done', 'group.stopped', 'group.interrupted'] });
            cursor = Math.max(cursor, consumed.lastCursor);
            retryIndex = 0;
          } catch (observationError) {
            if (observerSignal.aborted) throw observationError;
            const latest = await groupClient.getInteraction(interactionId);
            if (isCurrentScope()) { setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, latest.interaction)); setGroupExecutionOwner(latest.executionOwner ?? null); setGroupBudget(latest.budget); }
            if (latest.interaction.status !== 'active') break;
            if (!shouldReconnect(observationError) || retryIndex >= MAX_RECONNECT_ATTEMPTS) throw observationError;
            if (isCurrentScope()) setConnectionNotice('群聊观察连接中断；只读续传不会再次启动讨论…');
            await waitForReconnect(getReconnectDelay(retryIndex), observerSignal);
            retryIndex += 1;
            continue;
          }
          const latest = await groupClient.getInteraction(interactionId);
          if (isCurrentScope()) { setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, latest.interaction)); setGroupExecutionOwner(latest.executionOwner ?? null); setGroupBudget(latest.budget); }
          if (latest.interaction.status !== 'active') break;
          if (!shouldReconnect(new UnexpectedStreamEndError()) || retryIndex >= MAX_RECONNECT_ATTEMPTS) throw new UnexpectedStreamEndError();
          await waitForReconnect(getReconnectDelay(retryIndex), observerSignal);
          retryIndex += 1;
        }
        if (observerSignal.aborted) throw new DOMException('Observation detached', 'AbortError');
        const finalDetail = await groupClient.getInteraction(interactionId);
        if (finalDetail.interaction.status === 'active') throw new Error('执行 owner 仍处于活动状态；恢复记录保留，尚未确认完成。');
        if (isCurrentScope()) {
          setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, finalDetail.interaction));
          setGroupExecutionOwner(finalDetail.executionOwner ?? null);
          setGroupBudget(finalDetail.budget);
          await loadCanonicalGroupDetails(conversation.id);
          setGroupDiscussionError(''); setConnectionNotice(''); setAttachmentError('');
        }
        const settled = await draftState.settleSubmission(identity, submitted, 'committed');
        if (settled.warning && isCurrentScope()) setGroupDiscussionError(settled.warning);
        if (!browserGroupDiscussionOutbox.clear(identityKey, outboxKey) && isCurrentScope()) setGroupDiscussionError('讨论已完成，但本地恢复记录未能清除；刷新后只查询原讨论，不新建消息。');
        return;
      }

      if (conversation.type !== 'direct') throw new Error('不支持的会话类型');
      const sentConversation = conversation;
      const runtimeOverrides = getRuntimeOverrides(selectedAgent, { model: frozenDraft.model, thinkingEffort: frozenDraft.thinkingEffort });
      const isWaitingResume = activeStatus === 'waiting_user' && Boolean(activeRunId);
      activeOperation.runId = isWaitingResume ? activeRunId : undefined;
      const streamPath = isWaitingResume
        ? `/api/workspaces/${workspaceId}/conversations/${conversation.id}/runs/${activeRunId}/resume/stream`
        : `/api/workspaces/${workspaceId}/conversations/${conversation.id}/messages/stream`;
      const body = isWaitingResume
        ? { content, intent }
        : { content, intent, attachments: attachmentPayload, ...(runtimeOverrides.model ? { model: runtimeOverrides.model } : {}), ...(runtimeOverrides.thinkingEffort ? { thinkingEffort: runtimeOverrides.thinkingEffort } : {}) };
      const directController = new AbortController();
      activeOperation.directController = directController;
      let streamRunId = activeOperation.runId;
      let streamCursor = 0;
      const handleStreamEvent = async (event: { event: string }, data: ConversationStreamData) => {
        if (event.event === 'run' && typeof data.runId === 'string') {
          streamRunId = data.runId; activeOperation.runId = data.runId;
        }
        if (event.event === 'message') serverMessagePersisted = true;
        if (event.event === 'error') throw new TerminalStreamError(data.error ?? '执行失败');
        if (!isCurrentScope()) return;
        if (event.event === 'run' && typeof data.runId === 'string') {
          setActiveRunId(data.runId);
        } else if (event.event === 'execution') {
          const time = new Date().toISOString();
          setActiveStatus(data.status); void loadPresence();
          if (data.status === 'waiting_user' && data.content) setActiveWaitingQuestion(data.content);
          if (data.status !== 'queued') setActiveStartedAt(current => current ?? time);
          setActiveEvents(current => collapseStreamingExecutionEvents([...current, { id: time + '-' + current.length, executionId: 'active', status: data.status, activity: data.activity, ...(data.content ? { content: data.content } : {}), ...(data.agentId ? { agentId: data.agentId } : {}), ...(data.agentName ? { agentName: data.agentName } : {}), createdAt: time }]));
          if (data.status === 'streaming_response' && data.content) typewriterRef.current.enqueue(data.content);
        } else if (event.event === 'runtime' && data.runtime) {
          const runtimeEvent = data.runtime;
          if (streamRunId && runtimeEvent.runId !== streamRunId) return;
          streamRunId ??= runtimeEvent.runId;
          const runId = streamRunId;
          setActiveRuntimeEvents(current => mergeRuntimeEvent(current, runtimeEvent, runId));
          const payload = runtimeEvent.payload;
          const runtimeLabel = typeof payload.toolName === 'string' ? payload.toolName : runtimeEvent.type;
          const runtimeSummary = typeof payload.summary === 'string' ? payload.summary : typeof payload.text === 'string' ? payload.text : undefined;
          setActiveEvents(current => current.some(item => item.id === runtimeEvent.eventId) ? current : collapseStreamingExecutionEvents([...current, { id: runtimeEvent.eventId, executionId: runtimeEvent.executionId ?? 'active', status: 'streaming_response', activity: runtimeLabel, ...(runtimeSummary ? { content: runtimeSummary } : {}), runtimeEvent, createdAt: runtimeEvent.timestamp }]));
        } else if (event.event === 'run.step' && data.runStep) {
          if (streamRunId && data.runStep.runId !== streamRunId) return;
          const step = data.runStep;
          setActiveRunSteps(current => upsertRunStep(current, step));
        } else if (event.event === 'message' && data.message) {
          typewriterRef.current.flush(); streamingStore.clear();
          const message = data.message;
          setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]);
        } else if (event.event === 'done') {
          typewriterRef.current.flush(); streamingStore.clear();
          const doneExecution = getDoneExecution(data);
          if (doneExecution) {
            if (data.execution) {
              const execution = data.execution;
              setExecutions(current => current.some(item => item.id === execution.id) ? current.map(item => item.id === execution.id ? { ...item, ...execution } : item) : [...current, execution]);
            }
            else if (data.executions?.length) setExecutions(data.executions);
            setActiveStatus(doneExecution.status); setActiveRunId(doneExecution.runId);
          }
        } else if (event.event === 'error') throw new TerminalStreamError(data.error ?? '执行失败');
      };
      const connectStream = async (path: string, method: 'GET' | 'POST', payload?: unknown) => {
        const response = await fetch(apiBase + path, {
          method,
          headers: method === 'POST' ? { 'Content-Type': 'application/json', Accept: 'text/event-stream' } : { Accept: 'text/event-stream' },
          ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
          signal: directController.signal,
        });
        if (!response.ok) throw new StreamHttpError(response.status);
        const result = await consumeSseResponse(response, (event, data) => handleStreamEvent(event, data as ConversationStreamData));
        streamCursor = Math.max(streamCursor, result.lastCursor);
      };
      try {
        await connectStream(streamPath, 'POST', body);
      } catch (streamError) {
        if (!streamRunId || !shouldReconnect(streamError, { userCancelled: activeOperation.cancelled })) throw streamError;
        await retryWithExponentialBackoff(async attempt => {
          if (!streamRunId) throw new TerminalStreamError('无法恢复当前执行连接');
          if (isCurrentScope()) setConnectionNotice(`正在重连（第 ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} 次）…`);
          await waitForReconnect(getReconnectDelay(attempt), directController.signal);
          await connectStream(`/api/workspaces/${workspaceId}/conversations/${sentConversation.id}/runs/${streamRunId}/stream?cursor=${streamCursor}`, 'GET');
        }, {
          maxRetries: MAX_RECONNECT_ATTEMPTS - 1,
          sleep: async () => {},
          shouldRetry: error => shouldReconnect(error, { userCancelled: activeOperation.cancelled }),
        });
        if (isCurrentScope()) { setConnectionNotice(''); pushToast('success', '连接已恢复'); }
      }
      const settled = await completeDirectConversationSubmission({
        sourceIdentity: identity, submitted,
        ...(createdDirectConversation ? { createdConversationIdentity: { workspaceId, storageSource: 'workspace', conversationId: sentConversation.id } } : {}),
        migrateTo: draftState.migrateTo, settleSubmission: draftState.settleSubmission,
        isCurrentScope,
        onCurrentScopeSettled: () => {
          if (createdDirectConversation) {
            applyCreatedConversation(sentConversation, selectedAgent?.id ?? null);
            router.replace(`/workspace/${encodeURIComponent(workspaceId)}?conversationSource=workspace&conversationId=${encodeURIComponent(sentConversation.id)}&view=${activeWorkspaceView}`);
          }
          setAttachmentError('');
        },
      });
      if (settled.currentScope && settled.warning) setError(settled.warning);
      if (isCurrentScope() && !createdDirectConversation) await loadConversationDetails(sentConversation.id);
    } catch (sendError) {
      if (queuedItem || groupOutboxEntry) blockedQueueItemByIdentityRef.current.set(identityKey, queuedItem?.id ?? 'outbox');
      if (isCurrentScope()) {
        if (conversation?.type === 'group') {
          const message = sendError instanceof Error ? sendError.message : String(sendError);
          setGroupDiscussionError(message);
          setGroupSpeakingAgentId(undefined);
          if (groupOutboxEntry?.interactionId) void loadCanonicalGroupDetails(conversation.id).catch(() => undefined);
        } else if (sendError instanceof UnexpectedStreamEndError) {
          setConnectionNotice('连接已断开，执行可能仍在后台继续；再次提交前请核实状态。');
        } else {
          setError(sendError instanceof Error ? sendError.message : String(sendError));
        }
        if (queuedItem) blockedQueueItemByIdentityRef.current.set(identityKey, queuedItem.id);
      }
      if (optimisticId && !serverMessagePersisted && isCurrentScope()) setMessages(current => current.filter(message => message.id !== optimisticId));
      if (sendError instanceof DOMException && sendError.name === 'AbortError' && isCurrentScope() && !activeOperation.cancelled) pushToast('warning', '当前观察连接已断开；后台任务状态未被据此判定为取消。');
    } finally {
      activeSendRef.current.delete(identityKey);
      setSendingIdentityKeys(current => { const next = new Set(current); next.delete(identityKey); return next; });
      if (activeOperation.observerController && !activeOperation.observerController.signal.aborted) activeOperation.observerController.abort();
    }
  }, [apiBase, activeDraftIdentityKey, activeRunId, activeStatus, activeWorkspaceView, agents.length, applyCreatedConversation, createConversation, draftIdentity, draftState, groupClient, loadCanonicalGroupDetails, loadConversationDetails, loadPresence, pushToast, router, runtimeClient, selectedAgent, selectedConversation, selectedGroupId, sending, setAttachmentError, setConnectionNotice, setError, setValidationError, streamingStore, workspaceId]);

  useEffect(() => {
    if (!activeDraftIdentityKey || !draftState.ready || sending || drainingQueueRef.current) return;
    let pending: PendingGroupDiscussion | undefined;
    try {
      if (isGroupConversation) pending = browserGroupDiscussionOutbox.loadForRecovery(activeDraftIdentityKey);
    } catch (recoveryError) {
      blockedQueueItemByIdentityRef.current.set(activeDraftIdentityKey, 'outbox');
      setGroupDiscussionError(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
      return;
    }
    const recoveredEntry = pending;
    const queuedSubmissionId = recoveredEntry?.submission?.queueItemId;
    const next = recoveredEntry && queuedSubmissionId
      ? draftState.draft.queue.find(item => item.id === queuedSubmissionId && item.identityKey === activeDraftIdentityKey)
        ?? { id: queuedSubmissionId, identityKey: activeDraftIdentityKey, content: recoveredEntry.payload.content,
          mentionedAgentIds: recoveredEntry.payload.mentionedAgentIds, runIntent: recoveredEntry.payload.intent,
          thinkingEffort: 'auto' as const, attachments: draftState.draft.attachments.filter(item => recoveredEntry.payload.attachmentIds.includes(item.id)) }
      : pending ? undefined : draftState.draft.queue.find(item => item.identityKey === activeDraftIdentityKey);
    if (!next && !pending) return;
    if (blockedQueueItemByIdentityRef.current.get(activeDraftIdentityKey) === (next?.id ?? 'outbox')) return;
    drainingQueueRef.current = true;
    void handleSend(next, pending).finally(() => { drainingQueueRef.current = false; });
  }, [activeDraftIdentityKey, draftState.draft, draftState.ready, handleSend, isGroupConversation, sending]);

  const handleResumeQueue = useCallback(() => {
    if (!activeDraftIdentityKey) return;
    blockedQueueItemByIdentityRef.current.delete(activeDraftIdentityKey);
    setSendingIdentityKeys(current => new Set(current));
  }, [activeDraftIdentityKey]);

  const handleCancel = useCallback(({ directRunBlocked, evidenceVisible }: { directRunBlocked: boolean; evidenceVisible: boolean }) => {
    if (!activeDraftIdentityKey || !selectedConversation || directRunBlocked || !evidenceVisible) return;
    const generation = activeScopeGenerationRef.current.generation;
    const isCurrent = () => isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, activeDraftIdentityKey, generation);
    const operation = activeSendRef.current.get(activeDraftIdentityKey);
    if (selectedConversation.type === 'group' && groupInteraction && groupClient) {
      const interactionId = groupInteraction.id;
      void groupClient.getInteraction(interactionId).then(async latest => {
        if (!isCurrent()) return;
        setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, latest.interaction));
        setGroupExecutionOwner(latest.executionOwner ?? null);
        setGroupBudget(latest.budget);
        const result = await groupClient.stopInteraction(interactionId, latest.interaction.version, `workspace-ui-group-stop-${interactionId}-${latest.interaction.version}`);
        if (!isCurrent()) return;
        setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, result.interaction));
        const final = await groupClient.getInteraction(interactionId);
        if (!isCurrent()) return;
        setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, final.interaction));
        setGroupExecutionOwner(final.executionOwner ?? null);
        setGroupBudget(final.budget);
        await loadCanonicalGroupDetails(selectedConversation.id);
      }).catch(async stopError => {
        if ((stopError as { code?: string })?.code === 'GROUP_VERSION_CONFLICT') {
          try {
            const latest = await groupClient.getInteraction(interactionId);
            if (isCurrent()) { setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, latest.interaction)); setGroupExecutionOwner(latest.executionOwner ?? null); setGroupBudget(latest.budget); }
          } catch { /* report the original optimistic-version conflict */ }
          if (isCurrent()) setGroupDiscussionError('群聊版本已变化，已刷新最新状态；没有自动重试停止，请确认后再次操作。');
          return;
        }
        if (isCurrent()) notifyError(stopError, '停止群聊讨论失败');
      });
      return;
    }
    if (!operation) return;
    operation.cancelled = true;
    const runId = operation.runId;
    if (workspaceId && runId) void request(`/api/workspaces/${workspaceId}/conversations/${selectedConversation.id}/runs/${runId}/cancel`, { method: 'POST' }).catch(() => undefined);
    operation.directController?.abort();
  }, [activeDraftIdentityKey, groupClient, groupInteraction, loadCanonicalGroupDetails, notifyError, request, selectedConversation, workspaceId]);

  return {
    // Identity/generation machinery shared with the page layer.
    activeScopeGenerationRef,
    activeDraftIdentityKeyRef,
    activeConversationIdRef,
    conversationLoadGenerationRef,
    // Typewriter-streamed text sink (ChatPanel subscribes; page does not re-render per tick).
    streamingStore,
    // Conversation evidence state.
    messages,
    conversationRuns,
    executions,
    activeEvents,
    activeRuntimeEvents,
    activeRunSteps,
    activeArtifacts,
    activeRuntimeResult,
    activeStatus,
    activeStartedAt,
    activeRunId,
    activeWaitingQuestion,
    groupInteraction,
    groupExecutionOwner,
    groupBudget,
    groupDiscussionError,
    groupSpeakingAgentId,
    sendingIdentityKeys,
    runLinkState,
    evidenceVisible,
    directRunLinkKey,
    directRunBinding,
    // Actions.
    resetEvidence,
    createConversation,
    loadRunDetails,
    loadConversationDetails,
    loadCanonicalGroupDetails,
    handleSend,
    handleResumeQueue,
    handleCancel,
    handleGroupInteractionRecovered,
  };
}
