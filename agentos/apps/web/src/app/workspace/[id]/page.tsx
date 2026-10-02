'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { AgentEvent, AgentExecution, AgentPresence, AgentProfile, AgentRun, AgentRunDetails, Conversation, ConversationAttachment, ConversationMember, ConversationMessage, ExecutionEvent, ExecutionStatus, GroupDispatchMode, RunIntent, RunStep, RuntimeArtifact, ThinkingEffort, Workspace } from '@agentos/shared';
import { AgentList } from '@/components/chat/AgentList';
import { AgentEditor } from '@/components/chat/AgentEditor';
import { GroupCreator, type GroupCreateMember } from '@/components/chat/GroupCreator';
import { GroupEditor } from '@/components/chat/GroupEditor';
import { GroupRenameModal } from '@/components/chat/GroupRenameModal';
import { ConversationContextMenu } from '@/components/chat/ConversationContextMenu';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { ConversationHistory } from '@/components/chat/ConversationHistory';
import { ExecutionInspector } from '@/components/chat/ExecutionInspector';
import { WorkspacePanelOverlay } from '@/components/layout/WorkspacePanelOverlay';
import { useApi } from '@/lib/useApi';
import { getActiveConversationId, shouldResetGroupView } from '@/lib/conversationSelection';
import { getNextConversationId } from '@/lib/conversationActions';
import { getInitialComposerSettings, getModelOptions, getRuntimeOverrides, getThinkingEfforts, normalizeThinkingEffort } from '@/lib/composerSettings';
import { getDoneExecution } from '@/lib/streamDoneExecution';
import { MAX_RECONNECT_ATTEMPTS, TerminalStreamError, StreamHttpError, UnexpectedStreamEndError, consumeSseResponse, getReconnectDelay, retryWithExponentialBackoff, shouldReconnect } from '@/lib/streamReconnect';
import { canSendMessage, fileToImageDraft, imageDraftDataUrl, validateImageDrafts, type ImageDraft } from '@/lib/imageAttachments';
import { getComposerSendIntent } from '@/lib/composerInteraction';
import { getInspectorProposedWidth, getResizablePanelWidth } from '@/lib/resizablePanels';
import { DEFAULT_WORKSPACE_LAYOUT, WORKSPACE_LAYOUT_THRESHOLDS, WORKSPACE_LAYOUT_WIDTHS, normalizeWorkspaceLayout, panelCollapseThreshold, panelIsDocked, panelWidthRange, resolveEffectiveWorkspaceLayout, workspaceLayoutStorageKey, type EffectiveWorkspaceLayout, type WorkspaceLayoutPanel, type WorkspaceLayoutPreferences } from '@/lib/workspaceLayout';
import { resolveAttachmentUrl } from '@/lib/attachmentUrls';
import { RunDetails } from '@/components/runs/RunDetails';
import { MemoryPanel } from '@/components/memory/MemoryPanel';
import { MemoryCandidateQueue } from '@/components/memory/MemoryCandidateQueue';
import { MemoryReviewQueue } from '@/components/memory/MemoryReviewQueue';
import { CollaborationTaskPanel } from '@/components/chat/CollaborationTaskPanel';
import { PreferencePanel } from '@/components/preference/PreferencePanel';
import { ToastStack } from '@/components/feedback/ToastStack';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { classifyUiError, getComposerValidationError, TOAST_DURATION_MS, type ToastItem, type ToastTone } from '@/lib/uiFeedback';
import { TypewriterQueue } from '@/lib/typewriterQueue';
import { selectActiveRunExecutions } from '@/lib/runtimeSelection';
import { collapseStreamingExecutionEvents } from '@/lib/executionTimeline';
import { upsertRunStep } from '@/lib/runSteps';
import { indexPresence } from '@/lib/agentPresence';
import { mergeRuntimeEvent, projectRuntimeResult, type RuntimeResultProjection } from '@/lib/runtimeProjection';
import { useCollaborationProgress } from '@/lib/useCollaborationProgress';
import { directConversationClient, type ForwardConversation, type ForwardConversationMember } from '@/lib/directConversationClient';
import { groupConversationClient, mergeGroupInteractionVersionEvent, type GroupInteraction, type GroupInteractionBudgetInput } from '@/lib/groupConversationClient';
import { useConversationDraft } from '@/lib/useConversationDraft';
import { captureDraftSubmission, createConversationDraftIdentityKey, enqueueDraftSubmission, isCurrentConversationGeneration, type ConversationDraftIdentity, type QueuedConversationMessage, type SubmittedConversationDraft } from '@/lib/conversationDraftState';
import { completeDirectConversationSubmission } from '@/lib/conversationDraftLifecycle';
import { browserGroupDiscussionOutbox, type PendingGroupDiscussion } from '@/lib/groupDiscussionOutbox';
import { classifyRunConversationBinding } from '@/lib/runConversationBinding';
import type { UnifiedWorkspaceView } from '@/components/chat/UnifiedRuntimeConversationSurface';
import { RunInspectorPanel } from '@/components/chat/RunInspectorPanel';
import { CollaborationTaskDetailsView } from '@/components/chat/CollaborationTaskDetailsView';

type VisibleExecutionEvent = ExecutionEvent & { agentId?: string; agentName?: string };
type StreamEvent = Pick<VisibleExecutionEvent, 'status' | 'activity' | 'content' | 'agentId' | 'agentName'>;
type ConversationStreamData = StreamEvent & { cursor?: number; runId?: string; run?: AgentRun; message?: ConversationMessage; execution?: AgentExecution; executions?: AgentExecution[]; runtime?: AgentEvent; runStep?: RunStep; eventId?: string; sequence?: number; error?: string };
type ContextMenuState = { conversation: Conversation; clientX: number; clientY: number };
type ResizePanel = WorkspaceLayoutPanel;
type OverlayPanel = WorkspaceLayoutPanel | null;
type ActivePanelResize = { panel: ResizePanel; startX: number; startWidth: number; startPreferences: WorkspaceLayoutPreferences; lastProposed?: number; cleanup: () => void };

function toUiGroupConversation(conversation: ForwardConversation): Conversation {
  const now = new Date().toISOString();
  return {
    id: conversation.id,
    workspaceId: conversation.workspaceId ?? '',
    type: 'group',
    title: conversation.title,
    dispatchMode: 'leader_route',
    settingsVersion: conversation.settingsVersion,
    createdAt: conversation.createdAt ?? conversation.updatedAt ?? now,
    updatedAt: conversation.updatedAt ?? conversation.createdAt ?? now,
  };
}

function toUiGroupMember(member: ForwardConversationMember, index: number): ConversationMember {
  return {
    conversationId: member.conversationId,
    agentId: member.subjectId,
    roleTitle: member.roleTitle,
    roleKind: member.role === 'reviewer' ? 'reviewer' : index === 0 ? 'leader' : 'worker',
    sequence: (index + 1) * 10,
    ...(member.model === undefined ? {} : { model: member.model }),
    ...(member.thinkingEffort === undefined ? {} : { thinkingEffort: member.thinkingEffort }),
    ...(member.additionalInstructions === undefined ? {} : { additionalInstructions: member.additionalInstructions }),
    createdAt: member.joinedAt,
  };
}

function toUiGroupMessage(message: { id: string; conversationId?: string; senderType: string; senderAgentId: string | null; content: string; runId: string | null; attachments?: readonly ConversationAttachment[]; createdAt?: string }, conversationId: string, workspaceId: string, apiBase = ''): ConversationMessage {
  return {
    id: message.id,
    conversationId: message.conversationId ?? conversationId,
    workspaceId,
    senderType: message.senderType === 'user' ? 'user' : message.senderType === 'system' ? 'system' : 'agent',
    ...(message.senderAgentId === null ? {} : { senderAgentId: message.senderAgentId }),
    ...(message.runId === null ? {} : { runId: message.runId }),
    content: message.content,
    ...(message.attachments === undefined ? {} : { attachments: message.attachments.map(attachment => ({ ...attachment, url: resolveAttachmentUrl(apiBase, attachment.url) })) }),
    createdAt: message.createdAt ?? new Date().toISOString(),
  };
}

const PANEL_RESIZE_HANDLE_WIDTH = WORKSPACE_LAYOUT_WIDTHS.handle;

function chatMinimumForViewport(viewportWidth: number): number {
  return viewportWidth >= WORKSPACE_LAYOUT_THRESHOLDS.compactViewport
    ? WORKSPACE_LAYOUT_THRESHOLDS.desktopChatMinimum
    : 0;
}

function PanelResizeHandle({ panel, width, onPointerDown, onKeyDown }: { panel: ResizePanel; width?: number; onPointerDown(panel: ResizePanel, event: ReactPointerEvent<HTMLDivElement>): void; onKeyDown(panel: ResizePanel, event: ReactKeyboardEvent<HTMLDivElement>): void }) {
  const range = panelWidthRange(panel);
  const label = panel === 'workspace' ? '调整工作区导航栏宽度' : panel === 'history' ? '调整会话历史栏宽度' : '调整执行状态面板宽度';
  const defaultWidth = panelWidthRange(panel).min;
  const actualWidth = Math.round(width ?? defaultWidth);
  const announcedWidth = Math.max(range.min, actualWidth);
  return <div data-panel-resize={panel} role="separator" tabIndex={0} aria-orientation="vertical" aria-label={label} aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={announcedWidth} aria-valuetext={actualWidth < range.min ? '图标栏（64px）' : `${actualWidth}px`} className={`panel-resize-handle panel-resize-handle-${panel}`} onPointerDown={event => onPointerDown(panel, event)} onKeyDown={event => onKeyDown(panel, event)} />;
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

export default function WorkspacePage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const workspaceId = typeof params.id === 'string' ? params.id : null;
  const returnConversationId = searchParams.get('conversationId');
  const returnCollaborationId = searchParams.get('collaborationId');
  const returnConversationSourceParameter = searchParams.get('conversationSource');
  const returnConversationSource = returnConversationSourceParameter === 'runtime' ? 'runtime' : 'workspace';
  const requestedView: UnifiedWorkspaceView = searchParams.get('view') === 'execution' ? 'execution' : 'chat';
  // Navigation state is canonical for the visible tab. The local state keeps
  // transitions responsive, while URL-driven rendering makes refresh,
  // history navigation, and /runtime compatibility links deterministic.
  const activeWorkspaceView = requestedView;
  const { API_BASE, request } = useApi();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [presence, setPresence] = useState<Record<string, AgentPresence>>({});
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Conversation[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedDirectConversationId, setSelectedDirectConversationId] = useState<string | null>(null);
  const [, setWorkspaceView] = useState<UnifiedWorkspaceView>(requestedView);
  const [executionRunHint, setExecutionRunHint] = useState<string | undefined>(searchParams.get('runId') ?? undefined);
  const activeExecutionRunHint = searchParams.get('runId') ?? executionRunHint;
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
  const [groupBudget, setGroupBudget] = useState<{ repliesUsed: number; repliesRemaining: number; hopsUsed: number; hopsRemaining: number; distinctAgents: number; agentsRemaining: number } | null>(null);
  const [groupDiscussionError, setGroupDiscussionError] = useState('');
  const [groupSpeakingAgentId, setGroupSpeakingAgentId] = useState<string | undefined>();
  const [conversationRuns, setConversationRuns] = useState<AgentRun[]>([]);
  const [activeStatus, setActiveStatus] = useState<ExecutionStatus>();
  const [activeStartedAt, setActiveStartedAt] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [activeWaitingQuestion, setActiveWaitingQuestion] = useState<string>();
  const [attachmentError, setAttachmentError] = useState('');
  const [conversationSelectionError, setConversationSelectionError] = useState('');
  const [runLinkState, setRunLinkState] = useState<{ readonly key: string; readonly binding: 'matched' | 'unattached' | 'mismatch' | 'loading'; readonly error?: string } | null>(null);
  const [urlSelectionState, setUrlSelectionState] = useState<{
    readonly key: string; readonly status: 'found'; readonly source: 'workspace' | 'runtime';
  } | { readonly key: string; readonly status: 'missing' } | null>(null);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [sendingIdentityKeys, setSendingIdentityKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState('');
  const [connectionNotice, setConnectionNotice] = useState('');
  const [validationError, setValidationError] = useState('');
  const [editingAgent, setEditingAgent] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [savingGroup, setSavingGroup] = useState(false);
  const [editingGroup, setEditingGroup] = useState<Conversation | null>(null);
  const [editingGroupMembers, setEditingGroupMembers] = useState<ConversationMember[]>([]);
  const [savingGroupSettings, setSavingGroupSettings] = useState(false);
  const [renamingConversation, setRenamingConversation] = useState<Conversation | null>(null);
  const [savingConversationTitle, setSavingConversationTitle] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [deletingConversation, setDeletingConversation] = useState<Conversation | null>(null);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [runDetails, setRunDetails] = useState<AgentRunDetails | null>(null);
  const [generatingCandidates, setGeneratingCandidates] = useState(false);
  const [showCandidateQueue, setShowCandidateQueue] = useState(false);
  const [showMemories, setShowMemories] = useState(false);
  const [showMemoryReview, setShowMemoryReview] = useState(false);
  const [showCollaborationTask, setShowCollaborationTask] = useState(false);
  const [collaborationPanelCreateMode, setCollaborationPanelCreateMode] = useState(false);
  const [focusCreatedCollaborationId, setFocusCreatedCollaborationId] = useState<string | null>(null);
  const [showPreferences, setShowPreferences] = useState(false);
  const [layoutPreferences, setLayoutPreferences] = useState<WorkspaceLayoutPreferences>(DEFAULT_WORKSPACE_LAYOUT);
  const [layoutViewportWidth, setLayoutViewportWidth] = useState(1440);
  const [layoutReady, setLayoutReady] = useState(false);
  const [overlayPanel, setOverlayPanel] = useState<OverlayPanel>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const layoutStorageWorkspaceRef = useRef<string | null>(null);
  const streamCursorRef = useRef(0);
  const drainingQueueRef = useRef(false);
  const activeResizeRef = useRef<ActivePanelResize | null>(null);
  const runDetailsCacheRef = useRef(new Map<string, Promise<AgentRunDetails>>());
  const conversationLoadGenerationRef = useRef(0);
  const conversationListGenerationRef = useRef(0);
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;
  const activeConversationIdRef = useRef<string | null>(null);
  const activeDraftIdentityKeyRef = useRef<string | null>(null);
  const blockedQueueItemByIdentityRef = useRef(new Map<string, string>());
  const activeScopeGenerationRef = useRef({ identityKey: null as string | null, generation: 0 });
  const activeSendRef = useRef(new Map<string, { identityKey: string; generation: number; directController?: AbortController; observerController?: AbortController; runId?: string; cancelled: boolean }>());
  const returnSelectionRef = useRef<string | null>(null);
  const toastIdRef = useRef(0);
  const typewriterRef = useRef(new TypewriterQueue());
  const typewriterOwnerRef = useRef<{ identityKey: string; generation: number } | null>(null);

  const selectedAgent = agents.find(agent => agent.id === selectedAgentId);
  const isLegacyRuntimeLink = returnConversationSource === 'runtime';
  // Runtime is now an execution view inside this page. A legacy runtime source
  // is kept only to render an explicit missing-record state after local cleanup.
  const activeConversationId = getActiveConversationId({ selectedGroupId, selectedDirectConversationId });
  activeConversationIdRef.current = activeConversationId;
  const selectedConversation = selectedGroupId
    ? groups.find(conversation => conversation.id === selectedGroupId)
    : conversations.find(conversation => conversation.id === selectedDirectConversationId);
  const isGroupConversation = selectedConversation?.type === 'group';
  const activeConversationSource = selectedConversation?.type === 'group' ? 'runtime' : 'workspace';
  const explicitSelectionKey = returnConversationId ? `${workspaceId ?? ''}:${returnConversationSourceParameter ?? 'legacy'}:${returnConversationId}` : null;
  const urlSelectionStatus = !explicitSelectionKey ? 'none'
    : urlSelectionState?.key !== explicitSelectionKey ? 'pending' : urlSelectionState.status;
  const explicitSelectionVerified = urlSelectionStatus === 'none' || (urlSelectionStatus === 'found'
    && urlSelectionState?.status === 'found' && selectedConversation?.id === returnConversationId
    && activeConversationSource === urlSelectionState.source);
  const draftIdentity = useMemo<ConversationDraftIdentity | null>(() => workspaceId
    && explicitSelectionVerified
    ? selectedConversation
      ? { workspaceId, storageSource: selectedConversation.type === 'group' ? 'runtime' : 'workspace', conversationId: selectedConversation.id }
      : !selectedGroupId && selectedAgentId
        ? { workspaceId, storageSource: 'workspace', pendingAgentId: selectedAgentId }
        : null
    : null, [explicitSelectionVerified, selectedAgentId, selectedConversation, selectedGroupId, workspaceId]);
  const draftState = useConversationDraft(draftIdentity);
  const activeDraftIdentityKey = draftIdentity ? createConversationDraftIdentityKey(draftIdentity) : null;
  const draft = draftState.draft.text;
  const mentionedAgentIds = [...draftState.draft.mentionedAgentIds];
  const runIntent = draftState.draft.runIntent;
  const attachments = [...draftState.draft.attachments];
  const composerModel = draftState.draft.model;
  const composerThinkingEffort = draftState.draft.thinkingEffort;
  const queuedMessageCount = draftState.draft.queue.length;
  const sending = Boolean(activeDraftIdentityKey && sendingIdentityKeys.has(activeDraftIdentityKey));
  const setDraft = draftState.setText;
  const setMentionedAgentIds = draftState.setMentions;
  const setRunIntent = draftState.setRunIntent;
  const setAttachments = draftState.setAttachments;
  const setComposerModel = draftState.setModel;
  const setComposerThinkingEffort = draftState.setThinkingEffort;
  const setQueue = draftState.setQueue;
  if (activeScopeGenerationRef.current.identityKey !== activeDraftIdentityKey) {
    activeScopeGenerationRef.current = {
      identityKey: activeDraftIdentityKey,
      generation: activeScopeGenerationRef.current.generation + 1,
    };
  }
  activeDraftIdentityKeyRef.current = activeDraftIdentityKey;
  const evidenceVisible = explicitSelectionVerified && activeDraftIdentityKey !== null
    && conversationEvidenceIdentityKey === activeDraftIdentityKey
    && conversationEvidenceGeneration === activeScopeGenerationRef.current.generation;
  const visibleMessages = evidenceVisible ? messages : [];
  const visibleStreamingContent = evidenceVisible ? streamingContent : '';
  const directRunLinkKey = !isGroupConversation && activeConversationId && activeDraftIdentityKey && activeExecutionRunHint
    ? JSON.stringify([activeDraftIdentityKey, activeScopeGenerationRef.current.generation, activeExecutionRunHint]) : null;
  const directRunBinding = directRunLinkKey ? runLinkState?.key === directRunLinkKey ? runLinkState.binding : 'loading' : null;
  const directRunBlocked = directRunBinding === 'loading' || directRunBinding === 'mismatch';
  const visibleActiveEvents = evidenceVisible && !directRunBlocked ? activeEvents : [];
  const visibleRuntimeEvents = evidenceVisible && !directRunBlocked ? activeRuntimeEvents : [];
  const visibleRunSteps = evidenceVisible && !directRunBlocked ? activeRunSteps : [];
  const visibleExecutions = evidenceVisible && !directRunBlocked ? executions : [];
  const visibleConversationRuns = evidenceVisible && !directRunBlocked ? conversationRuns : [];
  const visibleActiveRunId = evidenceVisible && !directRunBlocked ? activeRunId : undefined;
  const visibleActiveStatus = evidenceVisible && !directRunBlocked ? activeStatus : undefined;

  useEffect(() => {
    // Withdraw the previous owner's evidence before its replacement request
    // resolves. The render-time identity/generation gate covers this effect gap.
    conversationLoadGenerationRef.current += 1;
    typewriterRef.current.flush();
    typewriterOwnerRef.current = null;
    setConversationEvidenceIdentityKey(activeDraftIdentityKey);
    setConversationEvidenceGeneration(activeScopeGenerationRef.current.generation);
    setMessages([]); setStreamingContent(''); setConversationRuns([]); setExecutions([]);
    setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null);
    setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined);
    setGroupInteraction(null); setGroupBudget(null); setGroupSpeakingAgentId(undefined);
    setGroupDiscussionError(''); setAttachmentError(''); setValidationError(''); setError(''); setConnectionNotice(''); setRunDetails(null);
    for (const [key, operation] of activeSendRef.current) {
      if (key !== activeDraftIdentityKey) operation.observerController?.abort();
    }
  }, [activeDraftIdentityKey]);
  useEffect(() => {
    const handleRunIntent = (event: Event) => {
      const value = (event as CustomEvent<RunIntent>).detail;
      if (value === 'ask' || value === 'execute' || value === 'review') setRunIntent(value);
    };
    window.addEventListener('agentos:run-intent', handleRunIntent);
    return () => window.removeEventListener('agentos:run-intent', handleRunIntent);
  }, [setRunIntent]);
  const syncCollaborationSelection = useCallback((taskId: string, reason: 'user' | 'auto') => {
    if (!workspaceId || !activeConversationId) return;
    const query = new URLSearchParams(searchParams.toString());
    query.set('conversationSource', activeConversationSource);
    query.set('conversationId', activeConversationId);
    query.set('collaborationId', taskId);
    if (reason === 'user') {
      query.delete('runId');
      query.delete('runSource');
    }
    const href = `/workspace/${encodeURIComponent(workspaceId)}?${query.toString()}`;
    if (reason === 'auto') router.replace(href);
    else router.push(href);
  }, [activeConversationId, activeConversationSource, router, searchParams, workspaceId]);
  const collaborationProgressState = useCollaborationProgress({
    apiBase: API_BASE,
    workspaceId,
    conversationId: isGroupConversation ? activeConversationId : null,
    preferredTaskId: isGroupConversation ? returnCollaborationId : null,
    enabled: isGroupConversation && explicitSelectionVerified,
    onTaskSelectionChange: syncCollaborationSelection,
  });
  const requestedCollaborationRunId = searchParams.get('runId');
  const collaborationRunLinkError = isGroupConversation && collaborationProgressState.progress && requestedCollaborationRunId
    && (!collaborationProgressState.progress.runs.some(run => run.runId === requestedCollaborationRunId)
      || searchParams.get('runSource') === 'workspace')
    ? '指定的 Run 不属于当前协作任务，未加载其他执行记录。请从当前任务的执行轮次中重新选择。'
    : null;
  const activeComposerConversation = !isGroupConversation && selectedConversation?.agentId === selectedAgentId ? selectedConversation : undefined;
  const historyConversations = selectedGroupId ? groups : conversations;
  const historyTitle = selectedGroupId ? '群聊' : selectedAgent?.name ?? '会话';
  const composerModelOptions = getModelOptions(selectedAgent);
  const composerThinkingEfforts = getThinkingEfforts(selectedAgent, composerModel ?? selectedAgent?.model);
  const effectiveLayout = useMemo<EffectiveWorkspaceLayout>(() => resolveEffectiveWorkspaceLayout({
    viewportWidth: layoutViewportWidth,
    preferences: layoutPreferences,
    historyAvailable: !selectedGroupId && !isLegacyRuntimeLink,
  }), [isLegacyRuntimeLink, layoutPreferences, layoutViewportWidth, selectedGroupId]);

  useEffect(() => {
    if (!layoutRef.current) return undefined;
    const updateWidth = () => setLayoutViewportWidth(Math.round(layoutRef.current?.getBoundingClientRect().width ?? window.innerWidth));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(layoutRef.current);
    window.addEventListener('resize', updateWidth);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, [workspace]);

  useEffect(() => {
    if (!workspaceId) return;
    layoutStorageWorkspaceRef.current = null;
    setLayoutReady(false);
    try {
      const stored = window.localStorage.getItem(workspaceLayoutStorageKey(workspaceId));
      setLayoutPreferences(stored ? normalizeWorkspaceLayout(JSON.parse(stored) as unknown) : DEFAULT_WORKSPACE_LAYOUT);
    } catch {
      setLayoutPreferences(DEFAULT_WORKSPACE_LAYOUT);
    } finally {
      layoutStorageWorkspaceRef.current = workspaceId;
      setLayoutReady(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !layoutReady || layoutStorageWorkspaceRef.current !== workspaceId) return;
    if (activeResizeRef.current) return;
    try {
      window.localStorage.setItem(workspaceLayoutStorageKey(workspaceId), JSON.stringify(layoutPreferences));
    } catch {
      // Browser storage can be unavailable in privacy mode; layout remains in memory.
    }
  }, [layoutPreferences, layoutReady, workspaceId]);

  useEffect(() => {
    if (!overlayPanel) return;
    if (panelIsDocked(effectiveLayout, overlayPanel)) setOverlayPanel(null);
  }, [effectiveLayout, overlayPanel]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const owner = typewriterOwnerRef.current;
      if (!owner || !isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, owner.identityKey, owner.generation)) {
        typewriterRef.current.flush();
        return;
      }
      const character = typewriterRef.current.drainOne();
      if (character) setStreamingContent(current => current + character);
    }, 12);
    return () => window.clearInterval(timer);
  }, []);

  const pushToast = useCallback((tone: ToastTone, message: string) => {
    const id = `toast-${Date.now()}-${toastIdRef.current++}`;
    setToasts(current => [...current, { id, tone, message, durationMs: TOAST_DURATION_MS }].slice(-4));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(current => current.filter(toast => toast.id !== id));
  }, []);

  const notifyError = useCallback((error: unknown, fallback = '操作失败') => {
    const message = error instanceof Error ? error.message : String(error);
    if (classifyUiError(error) === 'connection') {
      setConnectionNotice(message || '连接异常，请稍后重试');
      return;
    }
    pushToast('error', message || fallback);
  }, [pushToast]);

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

  const getPanelWidth = useCallback((panel: ResizePanel) => {
    if (panel === 'workspace') return effectiveLayout.workspaceMode === 'compact' ? WORKSPACE_LAYOUT_WIDTHS.compactRail : layoutPreferences.workspaceWidth;
    return panel === 'history' ? layoutPreferences.historyWidth : layoutPreferences.inspectorWidth;
  }, [effectiveLayout.workspaceMode, layoutPreferences.historyWidth, layoutPreferences.inspectorWidth, layoutPreferences.workspaceWidth]);

  const updateLayoutPreferences = useCallback((update: (current: WorkspaceLayoutPreferences) => WorkspaceLayoutPreferences) => {
    setLayoutPreferences(current => {
      const next = update(current);
      return current.focusMode ? { ...next, focusMode: false, focusRestore: undefined } : next;
    });
  }, []);

  const otherDockedPanelWidth = useCallback((panel: ResizePanel) => {
    const widths = {
      workspace: effectiveLayout.workspaceMode === 'compact' ? WORKSPACE_LAYOUT_WIDTHS.compactRail : effectiveLayout.workspaceWidth,
      history: effectiveLayout.historyVisible ? effectiveLayout.historyWidth : 0,
      inspector: effectiveLayout.inspectorVisible ? effectiveLayout.inspectorWidth : 0,
    } satisfies Record<ResizePanel, number>;
    return Object.entries(widths).reduce((total, [key, width]) => key === panel ? total : total + width, 0);
  }, [effectiveLayout.historyWidth, effectiveLayout.historyVisible, effectiveLayout.inspectorWidth, effectiveLayout.inspectorVisible, effectiveLayout.workspaceMode, effectiveLayout.workspaceWidth]);

  const stopResize = useCallback(() => {
    activeResizeRef.current?.cleanup();
    activeResizeRef.current = null;
    document.body.classList.remove('resizing-panels');
  }, []);

  const handleResizePointerDown = useCallback((panel: ResizePanel, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    stopResize();

    const handle = event.currentTarget;
    const activeResize: ActivePanelResize = { panel, startX: event.clientX, startWidth: getPanelWidth(panel), startPreferences: layoutPreferences, cleanup: () => {} };
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const layout = layoutRef.current;
      if (!layout) return;
      const layoutWidth = layout.getBoundingClientRect().width;
      const proposed = panel === 'inspector'
        ? getInspectorProposedWidth(activeResize.startWidth, activeResize.startX, moveEvent.clientX)
        : activeResize.startWidth + moveEvent.clientX - activeResize.startX;
      activeResize.lastProposed = proposed;
      const range = panelWidthRange(panel);
      const nextWidth = getResizablePanelWidth({
        proposed: Math.max(range.min, proposed),
        panelMin: range.min,
        panelMax: range.max,
        availableWidth: layoutWidth,
        otherPanelWidth: otherDockedPanelWidth(panel),
        handleWidth: effectiveLayout.handleCount * PANEL_RESIZE_HANDLE_WIDTH,
        chatMinWidth: chatMinimumForViewport(layoutWidth),
      });
      updateLayoutPreferences(current => {
        const next = { ...current, focusMode: false, focusRestore: undefined };
        if (panel === 'workspace') return { ...next, workspaceWidth: nextWidth, workspaceMode: proposed >= panelCollapseThreshold(panel) ? 'full' : current.workspaceMode };
        if (panel === 'history') return { ...next, historyWidth: nextWidth };
        return { ...next, inspectorWidth: nextWidth };
      });
    };
    const finish = (cancelled = false) => {
      if (cancelled) {
        setLayoutPreferences(activeResize.startPreferences);
      }
      if (!cancelled && activeResize.lastProposed !== undefined && activeResize.lastProposed < panelCollapseThreshold(panel)) {
        updateLayoutPreferences(current => {
          if (panel === 'workspace') return { ...current, workspaceMode: 'compact', workspaceWidth: activeResize.startWidth, focusMode: false, focusRestore: undefined };
          if (panel === 'history') return { ...current, historyOpen: false, historyWidth: activeResize.startWidth, focusMode: false, focusRestore: undefined };
          return { ...current, inspectorOpen: false, inspectorWidth: activeResize.startWidth, focusMode: false, focusRestore: undefined };
        });
      }
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (activeResizeRef.current === activeResize) activeResizeRef.current = null;
      document.body.classList.remove('resizing-panels');
    };

    const handleUp = () => finish(false);
    const handleCancel = () => finish(true);
    activeResize.cleanup = handleCancel;
    activeResizeRef.current = activeResize;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Some browser automation environments do not expose native pointer capture.
    }
    document.body.classList.add('resizing-panels');
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
  }, [effectiveLayout.handleCount, getPanelWidth, layoutPreferences, otherDockedPanelWidth, stopResize, updateLayoutPreferences]);

  const handleResizeKeyDown = useCallback((panel: ResizePanel, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const range = panelWidthRange(panel);
    if (event.key === 'Home') {
      event.preventDefault();
      updateLayoutPreferences(current => panel === 'workspace'
        ? { ...current, workspaceMode: 'compact' }
        : panel === 'history'
          ? { ...current, historyOpen: false }
          : { ...current, inspectorOpen: false });
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      updateLayoutPreferences(current => panel === 'workspace'
        ? { ...current, workspaceMode: 'full', workspaceWidth: range.max }
        : panel === 'history'
          ? { ...current, historyOpen: true, historyWidth: range.max }
          : { ...current, inspectorOpen: true, inspectorWidth: range.max });
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = panel === 'inspector'
      ? event.key === 'ArrowLeft' ? 16 : -16
      : event.key === 'ArrowRight' ? 16 : -16;
    updateLayoutPreferences(current => {
      if (panel === 'workspace') return { ...current, workspaceMode: 'full', workspaceWidth: Math.min(range.max, Math.max(range.min, current.workspaceWidth + direction)) };
      if (panel === 'history') return { ...current, historyOpen: true, historyWidth: Math.min(range.max, Math.max(range.min, current.historyWidth + direction)) };
      return { ...current, inspectorOpen: true, inspectorWidth: Math.min(range.max, Math.max(range.min, current.inspectorWidth + direction)) };
    });
  }, [updateLayoutPreferences]);

  useEffect(() => () => stopResize(), [stopResize]);

  useEffect(() => {
    if (!draftState.ready || draftState.draft.revision !== 0) return;
    const settings = getInitialComposerSettings(selectedAgent, activeComposerConversation ? {
      model: activeComposerConversation.model,
      thinkingEffort: activeComposerConversation.thinkingEffort,
    } : undefined);
    setComposerModel(settings.model);
    setComposerThinkingEffort(settings.thinkingEffort);
    if (draftState.draft.model === undefined) setComposerModel(settings.model);
    if (draftState.draft.thinkingEffort === 'auto') setComposerThinkingEffort(settings.thinkingEffort);
  }, [activeComposerConversation?.id, activeComposerConversation?.model, activeComposerConversation?.thinkingEffort, draftState.draft.model, draftState.draft.revision, draftState.draft.thinkingEffort, draftState.ready, selectedAgent]);

  const persistConversationSettings = useCallback(async (conversationId: string, model: string | undefined, thinkingEffort: ThinkingEffort): Promise<Conversation> => {
    if (!workspaceId) throw new Error('Workspace is unavailable');
    const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations/${conversationId}/settings`, {
      method: 'PATCH',
      body: { model: model ?? null, thinkingEffort },
    });
    const update = (current: Conversation[]) => current.map(conversation => conversation.id === result.conversation.id ? result.conversation : conversation);
    setConversations(update);
    return result.conversation;
  }, [request, workspaceId]);

  const handleComposerModelChange = useCallback((model: string | undefined) => {
    const efforts = getThinkingEfforts(selectedAgent, model);
    const selectedOption = getModelOptions(selectedAgent).find(option => option.id === model);
    const nextThinkingEffort = normalizeThinkingEffort(composerThinkingEffort, efforts, selectedOption?.defaultThinkingEffort);
    setComposerModel(model);
    setComposerThinkingEffort(nextThinkingEffort);
    if (activeConversationId && !isGroupConversation) {
      void persistConversationSettings(activeConversationId, model, nextThinkingEffort).catch(saveError => notifyError(saveError, '保存会话设置失败'));
    }
  }, [activeConversationId, composerThinkingEffort, isGroupConversation, notifyError, persistConversationSettings, selectedAgent, setComposerModel, setComposerThinkingEffort]);

  const handleComposerThinkingEffortChange = useCallback((thinkingEffort: ThinkingEffort) => {
    setComposerThinkingEffort(thinkingEffort);
    if (activeConversationId && !isGroupConversation) {
      void persistConversationSettings(activeConversationId, composerModel, thinkingEffort).catch(saveError => notifyError(saveError, '保存会话设置失败'));
    }
  }, [activeConversationId, composerModel, isGroupConversation, notifyError, persistConversationSettings, setComposerThinkingEffort]);

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0 || !draftState.ready || !activeDraftIdentityKey) return;
    const identityKey = activeDraftIdentityKey;
    const generation = activeScopeGenerationRef.current.generation;
    const isCurrent = () => isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, identityKey, generation);
    setAttachmentError('');
    setValidationError('');
    const addedDrafts: ImageDraft[] = [];
    try {
      for (const file of files) addedDrafts.push(await fileToImageDraft(file));
      let validationError: string | undefined;
      const stored = draftState.updateDraft(current => {
        const nextDrafts = [...current.attachments, ...addedDrafts];
        const validation = validateImageDrafts(nextDrafts);
        if (!validation.ok) { validationError = validation.error; return current; }
        return { ...current, attachments: nextDrafts };
      });
      if (!stored) {
        for (const draft of addedDrafts) URL.revokeObjectURL(draft.previewUrl);
        if (isCurrent()) setAttachmentError(validationError ?? '原会话草稿尚未恢复；图片未加入其他会话。');
        return;
      }
    } catch (error) {
      for (const draft of addedDrafts) URL.revokeObjectURL(draft.previewUrl);
      if (isCurrent()) setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  }, [activeDraftIdentityKey, draftState]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(current => {
      const removed = current.find(attachment => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter(attachment => attachment.id !== id);
    });
    setAttachmentError('');
  }, [setAttachments]);

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
        url: resolveAttachmentUrl(API_BASE, attachment.url),
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
  }, [API_BASE, agents, loadRunDetails, request, workspaceId]);

  const loadConversations = useCallback(async (agentId: string) => {
    if (!workspaceId) return;
    const generation = ++conversationListGenerationRef.current;
    const result = await request<{ conversations: Conversation[] }>(`/api/workspaces/${workspaceId}/conversations?agentId=${encodeURIComponent(agentId)}`);
    if (generation !== conversationListGenerationRef.current || selectedAgentIdRef.current !== agentId) return;
    const ownedConversations = result.conversations.filter(conversation => conversation.workspaceId === workspaceId && conversation.agentId === agentId && conversation.type === 'direct');
    setConversations(ownedConversations);
    const explicitTarget = returnConversationId
      ? ownedConversations.find(conversation => conversation.id === returnConversationId)
      : undefined;
    setSelectedDirectConversationId(current => explicitTarget?.id ?? (returnConversationId ? null
      : ownedConversations.some(conversation => conversation.id === current) ? current : ownedConversations[0]?.id ?? null));
  }, [request, returnConversationId, workspaceId]);

  const runtimeClient = useMemo(
    () => workspaceId ? directConversationClient({ workspaceId, apiBase: API_BASE }) : null,
    [API_BASE, workspaceId],
  );
  const groupClient = useMemo(
    () => workspaceId ? groupConversationClient({ workspaceId, apiBase: API_BASE }) : null,
    [API_BASE, workspaceId],
  );

  const loadGroups = useCallback(async () => {
    if (!runtimeClient) return;
    const result = await runtimeClient.listConversations();
    setGroups(result.conversations.filter(conversation => conversation.kind === 'group' && conversation.status !== 'archived'
      && (conversation.workspaceId === undefined || conversation.workspaceId === workspaceId)).map(toUiGroupConversation));
    setGroupsLoaded(true);
  }, [runtimeClient, workspaceId]);

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
    setMessages(messageResult.messages.map(message => toUiGroupMessage(message, conversationId, workspaceId, API_BASE)));
    setGroupInteraction(detail?.interaction ?? selected ?? null);
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
  }, [API_BASE, groupClient, runtimeClient, workspaceId]);

  const loadPresence = useCallback(async () => {
    if (!workspaceId) return;
    const result = await request<{ presence: AgentPresence[] }>(`/api/workspaces/${workspaceId}/agents/presence`);
    setPresence(Object.fromEntries(indexPresence(result.presence)));
  }, [request, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    Promise.all([
      request<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`),
      request<{ agents: AgentProfile[] }>(`/api/workspaces/${workspaceId}/agents`),
    ]).then(([workspaceResult, agentResult]) => {
      if (cancelled) return;
      setWorkspace(workspaceResult.workspace);
      setAgents(agentResult.agents);
      setSelectedAgentId(current => current && agentResult.agents.some(agent => agent.id === current) ? current : agentResult.agents[0]?.id ?? null);
      void loadGroups().catch(loadError => notifyError(loadError, '加载群聊失败'));
      void loadPresence().catch(loadError => notifyError(loadError, '加载 Agent 状态失败'));
    }).catch(loadError => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError)); });
    return () => { cancelled = true; };
  }, [loadGroups, loadPresence, notifyError, request, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let timer: number | undefined;
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadPresence().catch(() => undefined);
    };
    const syncTimer = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = document.visibilityState === 'visible' ? window.setInterval(refresh, 15_000) : undefined;
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', syncTimer);
    syncTimer();
    return () => {
      document.removeEventListener('visibilitychange', syncTimer);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [loadPresence, workspaceId]);

  useEffect(() => {
    if (selectedAgentId && explicitSelectionVerified && !selectedGroupId) void loadConversations(selectedAgentId).catch(loadError => { if (selectedAgentIdRef.current === selectedAgentId) notifyError(loadError, '加载会话失败'); });
    return () => { conversationListGenerationRef.current += 1; };
  }, [explicitSelectionVerified, loadConversations, notifyError, selectedAgentId, selectedGroupId]);

  useEffect(() => {
    if (!explicitSelectionKey) {
      setConversationSelectionError('');
      return;
    }
    let cancelled = false;
    setConversationSelectionError('');
    if (returnConversationSourceParameter !== null && returnConversationSourceParameter !== 'workspace' && returnConversationSourceParameter !== 'runtime') {
      setSelectedGroupId(null);
      setSelectedDirectConversationId(null);
      setUrlSelectionState({ key: explicitSelectionKey, status: 'missing' });
      setConversationSelectionError('指定的会话来源无法识别；没有切换到其他会话。');
      return undefined;
    }
    if (returnConversationSource === 'runtime') {
      if (!groupsLoaded) return undefined;
      const target = groups.find(conversation => conversation.id === returnConversationId && conversation.type === 'group');
      if (target) {
        setSelectedGroupId(target.id);
        setSelectedDirectConversationId(null);
        setSelectedAgentId(null);
        setUrlSelectionState({ key: explicitSelectionKey, status: 'found', source: 'runtime' });
        setConversationSelectionError('');
      } else {
        setSelectedGroupId(null);
        setSelectedDirectConversationId(null);
        setUrlSelectionState({ key: explicitSelectionKey, status: 'missing' });
        setConversationSelectionError('指定的运行时群聊不存在或已归档；没有切换到其他会话。');
      }
      return undefined;
    }
    // Unified links historically omitted source or used "workspace" for a
    // canonical group. Resolve that exact ID through the verified adapters;
    // never substitute the first available conversation or trust the URL as
    // the draft's storage identity. Explicit runtime remains strict above.
    if (!groupsLoaded) return undefined;
    const canonicalTarget = groups.find(conversation => conversation.id === returnConversationId && conversation.type === 'group');
    const restoreCanonicalTarget = () => {
      if (!canonicalTarget) return false;
      setSelectedGroupId(canonicalTarget.id);
      setSelectedDirectConversationId(null);
      setSelectedAgentId(null);
      setUrlSelectionState({ key: explicitSelectionKey, status: 'found', source: 'runtime' });
      setConversationSelectionError('');
      return true;
    };
    if (agents.length === 0) {
      if (!restoreCanonicalTarget()) {
        setSelectedGroupId(null);
        setSelectedDirectConversationId(null);
        setUrlSelectionState({ key: explicitSelectionKey, status: 'missing' });
        setConversationSelectionError('指定的会话不存在或不属于当前工作区；没有回退到其他会话。');
      }
      return undefined;
    }
    void Promise.all(agents.map(async agent => {
      const result = await request<{ conversations: Conversation[] }>(`/api/workspaces/${workspaceId}/conversations?agentId=${encodeURIComponent(agent.id)}`);
      return { agent, conversations: result.conversations.filter(conversation => conversation.workspaceId === workspaceId && conversation.agentId === agent.id && conversation.type === 'direct') };
    })).then(results => {
      if (cancelled) return;
      const owner = results.find(result => result.conversations.some(conversation => conversation.id === returnConversationId && conversation.type === 'direct'));
      if (owner && canonicalTarget && returnConversationSourceParameter === null) {
        setSelectedGroupId(null);
        setSelectedDirectConversationId(null);
        setUrlSelectionState({ key: explicitSelectionKey, status: 'missing' });
        setConversationSelectionError('指定的会话 ID 存在于多个来源；请使用会话列表中的明确链接，没有自动选择。');
        return;
      }
      if (!owner) {
        if (restoreCanonicalTarget()) return;
        setSelectedGroupId(null);
        setSelectedDirectConversationId(null);
        setUrlSelectionState({ key: explicitSelectionKey, status: 'missing' });
        setConversationSelectionError('指定的会话不存在或不属于当前工作区；没有回退到其他会话。');
        return;
      }
      setConversations(owner.conversations);
      setSelectedGroupId(null);
      setSelectedAgentId(owner.agent.id);
      setSelectedDirectConversationId(returnConversationId);
      setUrlSelectionState({ key: explicitSelectionKey, status: 'found', source: 'workspace' });
      setConversationSelectionError('');
    }).catch(selectionError => {
      if (cancelled) return;
      setUrlSelectionState({ key: explicitSelectionKey, status: 'missing' });
      setConversationSelectionError(selectionError instanceof Error ? `无法验证指定会话：${selectionError.message}` : '无法验证指定会话');
    });
    return () => { cancelled = true; };
  }, [agents, explicitSelectionKey, groups, groupsLoaded, request, returnConversationId, returnConversationSource, returnConversationSourceParameter, workspaceId]);

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

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', closeOnKeyDown);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', closeOnKeyDown); };
  }, [contextMenu]);

  const createConversation = useCallback(async (options?: {
    readonly agent?: AgentProfile;
    readonly model?: string;
    readonly thinkingEffort?: ThinkingEffort;
    readonly sourceIdentity?: ConversationDraftIdentity;
    readonly sourceIdentityKey?: string;
    readonly sourceGeneration?: number;
    readonly select?: boolean;
  }): Promise<Conversation | null> => {
    const agent = options?.agent ?? selectedAgent;
    if (!workspaceId || !agent) return null;
    const sourceIdentity = options?.sourceIdentity ?? draftIdentity;
    const sourceIdentityKey = options?.sourceIdentityKey ?? activeDraftIdentityKey;
    const sourceGeneration = options?.sourceGeneration ?? activeScopeGenerationRef.current.generation;
    const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations`, { method: 'POST', body: { agentId: agent.id } });
    const conversation = await persistConversationSettings(result.conversation.id, options?.model ?? composerModel, options?.thinkingEffort ?? composerThinkingEffort);
    const stillCurrent = sourceIdentityKey !== null && isCurrentConversationGeneration(
      activeDraftIdentityKeyRef.current,
      activeScopeGenerationRef.current.generation,
      sourceIdentityKey,
      sourceGeneration,
    );
    if (options?.select !== false) {
      if (sourceIdentity && !sourceIdentity.conversationId) {
        await draftState.migrateTo({ workspaceId, storageSource: 'workspace', conversationId: conversation.id }, sourceIdentity);
      }
      if (!stillCurrent || !sourceIdentityKey || !isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, sourceIdentityKey, sourceGeneration)) return conversation;
      setConversations(current => [conversation, ...current.filter(item => item.id !== conversation.id)]);
      setSelectedDirectConversationId(conversation.id);
      setSelectedGroupId(null);
      router.replace(`/workspace/${encodeURIComponent(workspaceId)}?conversationSource=workspace&conversationId=${encodeURIComponent(conversation.id)}&view=chat`);
      setMessages([]); setConversationRuns([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined);
    }
    return conversation;
  }, [activeDraftIdentityKey, composerModel, composerThinkingEffort, draftIdentity, draftState.migrateTo, persistConversationSettings, request, router, selectedAgent, workspaceId]);

  const openContextMenu = useCallback((conversationId: string, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const conversation = groups.find(item => item.id === conversationId) ?? conversations.find(item => item.id === conversationId);
    if (conversation) setContextMenu({ conversation, clientX: event.clientX, clientY: event.clientY });
  }, [conversations, groups]);

  const copyConversationId = useCallback(async (conversationId: string) => {
    try { await navigator.clipboard.writeText(conversationId); pushToast('success', '会话 ID 已复制'); }
    catch (copyError) { notifyError(copyError, '复制会话 ID 失败'); }
  }, [notifyError, pushToast]);

  const openRunDetails = useCallback(async (runId: string) => {
    if (!workspaceId || !activeDraftIdentityKey || directRunBlocked) return;
    const requestedConversationId = activeConversationIdRef.current;
    const identityKey = activeDraftIdentityKey;
    const generation = activeScopeGenerationRef.current.generation;
    setOverlayPanel(null);
    try {
      const details = await loadRunDetails(runId);
      if (!requestedConversationId || !isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, identityKey, generation) || !projectRuntimeResult(details, { workspaceId, conversationId: requestedConversationId, runId })) return;
      setRunDetails(details);
    } catch (detailsError) {
      if (isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, identityKey, generation)) notifyError(detailsError, '加载运行详情失败');
    }
  }, [activeDraftIdentityKey, directRunBlocked, loadRunDetails, notifyError, workspaceId]);

  const generateMemoryCandidates = useCallback(async (runId: string) => {
    if (!workspaceId) return;
    setGeneratingCandidates(true);
    try {
      const result = await request<{ candidates: unknown[]; outcome: 'created' | 'existing' | 'none'; reason?: 'no_valuable_public_evidence' }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/memory-candidates/accumulate`, { method: 'POST' });
      setShowMemoryReview(result.candidates.length > 0);
      pushToast('success', result.outcome === 'none'
        ? '本次没有可复用的公开证据，未生成记忆候选'
        : result.outcome === 'existing' ? '已复用待审核记忆候选' : '规范记忆候选已生成，请审核');
    } catch (generateError) { notifyError(generateError, '生成记忆候选失败'); }
    finally { setGeneratingCandidates(false); }
  }, [notifyError, pushToast, request, workspaceId]);

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
        setStreamingContent('');
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
            const persistedMessage = toUiGroupMessage(created.message, conversation.id, workspaceId, API_BASE);
            setMessages(current => {
              const withoutOptimistic = current.filter(message => message.id !== optimisticId);
              return withoutOptimistic.some(message => message.id === persistedMessage.id) ? withoutOptimistic : [...withoutOptimistic, persistedMessage];
            });
            setGroupInteraction(created.interaction);
          }
        }
        if (!interactionId) throw new Error('恢复记录缺少 interactionId；未尝试新建讨论。');
        if (groupOutboxEntry.phase === 'created') {
          const snapshot = await groupClient.getInteraction(interactionId);
          sourceMessageId ??= snapshot.interaction.sourceMessageId ?? undefined;
          if (isCurrentScope()) { setGroupInteraction(snapshot.interaction); setGroupBudget(snapshot.budget); }
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
          if (isCurrentScope()) { setGroupInteraction(snapshot.interaction); setGroupBudget(snapshot.budget); }
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
                setStreamingContent('');
              } else if (event.event === 'group.checkpoint') {
                if (typeof payload.agentId === 'string') setGroupSpeakingAgentId(payload.agentId);
                if (typeof payload.delta === 'string') typewriterRef.current.enqueue(payload.delta);
              } else if (event.event === 'group.reply.final' || event.event === 'group.turn.final' || event.event === 'group.turn.failed' || event.event === 'group.turn.cancelled') {
                typewriterRef.current.flush(); setStreamingContent(''); setGroupSpeakingAgentId(undefined);
                const [latest, messageResult] = await Promise.all([groupClient.getInteraction(interactionId), runtimeClient.listMessages(groupConversation.id)]);
                if (isCurrentScope()) {
                  setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, latest.interaction));
                  setGroupBudget(latest.budget);
                  setMessages(messageResult.messages.map(message => toUiGroupMessage(message, groupConversation.id, workspaceId, API_BASE)));
                }
              } else if (event.event === 'group.done' || event.event === 'group.stopped' || event.event === 'group.interrupted') {
                typewriterRef.current.flush(); setStreamingContent(''); setGroupSpeakingAgentId(undefined);
              }
            }, { terminalEvents: ['group.done', 'group.stopped', 'group.interrupted'] });
            cursor = Math.max(cursor, consumed.lastCursor);
            retryIndex = 0;
          } catch (observationError) {
            if (observerSignal.aborted) throw observationError;
            const latest = await groupClient.getInteraction(interactionId);
            if (isCurrentScope()) { setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, latest.interaction)); setGroupBudget(latest.budget); }
            if (latest.interaction.status !== 'active') break;
            if (!shouldReconnect(observationError) || retryIndex >= MAX_RECONNECT_ATTEMPTS) throw observationError;
            if (isCurrentScope()) setConnectionNotice('群聊观察连接中断；只读续传不会再次启动讨论…');
            await waitForReconnect(getReconnectDelay(retryIndex), observerSignal);
            retryIndex += 1;
            continue;
          }
          const latest = await groupClient.getInteraction(interactionId);
          if (isCurrentScope()) { setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, latest.interaction)); setGroupBudget(latest.budget); }
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
          typewriterRef.current.flush(); setStreamingContent('');
          const message = data.message;
          setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]);
        } else if (event.event === 'done') {
          typewriterRef.current.flush(); setStreamingContent('');
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
        const response = await fetch(API_BASE + path, {
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
            setConversations(current => [sentConversation, ...current.filter(item => item.id !== sentConversation.id)]);
            setSelectedGroupId(null); setSelectedAgentId(sentConversation.agentId ?? selectedAgent?.id ?? null);
            setSelectedDirectConversationId(sentConversation.id);
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
  }, [API_BASE, activeDraftIdentityKey, activeRunId, activeStatus, activeWorkspaceView, agents.length, createConversation, draftIdentity, draftState, groupClient, loadCanonicalGroupDetails, loadConversationDetails, loadPresence, pushToast, router, runtimeClient, selectedAgent, selectedConversation, selectedGroupId, sending, workspaceId]);

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

  const handleCancel = useCallback(() => {
    if (!activeDraftIdentityKey || !selectedConversation || directRunBlocked || !evidenceVisible) return;
    const generation = activeScopeGenerationRef.current.generation;
    const isCurrent = () => isCurrentConversationGeneration(activeDraftIdentityKeyRef.current, activeScopeGenerationRef.current.generation, activeDraftIdentityKey, generation);
    const operation = activeSendRef.current.get(activeDraftIdentityKey);
    if (selectedConversation.type === 'group' && groupInteraction && groupClient) {
      const interactionId = groupInteraction.id;
      void groupClient.getInteraction(interactionId).then(async latest => {
        if (!isCurrent()) return;
        setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, latest.interaction));
        setGroupBudget(latest.budget);
        const result = await groupClient.stopInteraction(interactionId, latest.interaction.version, `workspace-ui-group-stop-${interactionId}-${latest.interaction.version}`);
        if (!isCurrent()) return;
        setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, result.interaction));
        const final = await groupClient.getInteraction(interactionId);
        if (!isCurrent()) return;
        setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, final.interaction));
        setGroupBudget(final.budget);
        await loadCanonicalGroupDetails(selectedConversation.id);
      }).catch(async stopError => {
        if ((stopError as { code?: string })?.code === 'GROUP_VERSION_CONFLICT') {
          try {
            const latest = await groupClient.getInteraction(interactionId);
            if (isCurrent()) { setGroupInteraction(current => mergeGroupInteractionVersionEvent(current, latest.interaction)); setGroupBudget(latest.budget); }
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
  }, [activeDraftIdentityKey, directRunBlocked, evidenceVisible, groupClient, groupInteraction, loadCanonicalGroupDetails, notifyError, request, selectedConversation, workspaceId]);

  const saveAgent = useCallback(async (update: Pick<AgentProfile, 'roleTitle' | 'systemPrompt' | 'permissions' | 'enabled'> & Partial<Pick<AgentProfile, 'name' | 'model' | 'provider'>> & { thinkingEffort: ThinkingEffort }) => {
    if (!workspaceId || !selectedAgent) return;
    setSavingAgent(true);
    try {
      const result = await request<{ agent: AgentProfile }>(`/api/workspaces/${workspaceId}/agents/${selectedAgent.id}`, { method: 'PATCH', body: update });
      setAgents(current => current.map(agent => agent.id === result.agent.id ? result.agent : agent));
      setEditingAgent(false);
    } catch (saveError) { notifyError(saveError, '保存智能体失败'); }
    finally { setSavingAgent(false); }
  }, [notifyError, request, selectedAgent, workspaceId]);

  const refreshAgentModels = useCallback(async () => {
    if (!workspaceId || !selectedAgent) return;
    setSavingAgent(true);
    try {
      const result = await request<{ agent: AgentProfile }>(`/api/workspaces/${workspaceId}/agents/${selectedAgent.id}/models/refresh`, { method: 'POST' });
      setAgents(current => current.map(agent => agent.id === result.agent.id ? result.agent : agent));
    } catch (refreshError) { notifyError(refreshError, '刷新模型失败'); }
    finally { setSavingAgent(false); }
  }, [notifyError, request, selectedAgent, workspaceId]);

  const createGroup = useCallback(async (input: { title: string; members: GroupCreateMember[]; dispatchMode: GroupDispatchMode }) => {
    if (!workspaceId || !runtimeClient) return;
    setSavingGroup(true);
    try {
      // Group conversations have one canonical source now. The legacy dispatch
      // selector is intentionally ignored here; every new discussion uses the
      // bounded sequential driver and its budget is chosen per send.
      const result = await runtimeClient.createConversation({
        kind: 'group',
        title: input.title,
        replyMode: 'sequential',
        memberAgentIds: input.members.map(member => member.agentId),
        members: input.members.map(member => ({
          agentId: member.agentId,
          roleTitle: '协作成员',
        })),
      });
      const conversation = toUiGroupConversation(result.conversation);
      setGroups(current => [conversation, ...current.filter(item => item.id !== conversation.id)]);
      setSelectedGroupId(conversation.id); setSelectedAgentId(null); setWorkspaceView('chat'); setExecutionRunHint(undefined);
      setSelectedDirectConversationId(null);
      setMessages([]); setConversationRuns([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined); setCreatingGroup(false);
      setGroupInteraction(null); setGroupBudget(null); setGroupDiscussionError('');
      if (workspaceId) router.replace(`/workspace/${encodeURIComponent(workspaceId)}?conversationSource=runtime&conversationId=${encodeURIComponent(conversation.id)}&view=chat`);
    } catch (groupError) { notifyError(groupError, '创建群聊失败'); }
    finally { setSavingGroup(false); }
  }, [notifyError, router, runtimeClient, workspaceId]);

  const saveConversationTitle = useCallback(async (title: string) => {
    if (!workspaceId || !renamingConversation) return;
    setSavingConversationTitle(true);
    try {
      if (renamingConversation.type === 'group') {
        if (!runtimeClient) return;
        const result = await runtimeClient.updateConversation(renamingConversation.id, { title });
        const updated = toUiGroupConversation(result.conversation);
        setGroups(current => current.map(group => group.id === updated.id ? updated : group));
      } else {
        const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations/${renamingConversation.id}`, { method: 'PATCH', body: { title } });
        setConversations(current => current.map(conversation => conversation.id === result.conversation.id ? result.conversation : conversation));
      }
      setRenamingConversation(null);
    } catch (renameError) { notifyError(renameError, '重命名会话失败'); }
    finally { setSavingConversationTitle(false); }
  }, [notifyError, request, renamingConversation, runtimeClient, workspaceId]);

  const openGroupEditor = useCallback(async (conversation: Conversation) => {
    if (!workspaceId || conversation.type !== 'group' || !runtimeClient) return;
    setOverlayPanel(null);
    try {
      const [conversationResult, membersResult] = await Promise.all([
        runtimeClient.listConversations(),
        runtimeClient.listMembers(conversation.id),
      ]);
      const source = conversationResult.conversations.find(item => item.id === conversation.id);
      if (!source) throw new Error('群聊不存在或已归档');
      setEditingGroup(toUiGroupConversation(source));
      setEditingGroupMembers(membersResult.members.filter(member => member.subjectType === 'agent').map(toUiGroupMember));
    } catch (loadError) { notifyError(loadError, '加载群聊策略失败'); }
  }, [notifyError, runtimeClient, workspaceId]);

  const saveGroupSettings = useCallback(async (input: { title: string; members: Array<{ agentId: string; roleKind: NonNullable<ConversationMember['roleKind']>; roleTitle: string; sequence: number; model?: string | null; thinkingEffort?: ThinkingEffort | null; additionalInstructions?: string | null }>; dispatchMode: GroupDispatchMode }) => {
    if (!workspaceId || !editingGroup || !runtimeClient) return;
    setSavingGroupSettings(true);
    try {
      await runtimeClient.updateConversation(editingGroup.id, { title: input.title });
      await runtimeClient.updateGroupMemberSettings(editingGroup.id, editingGroup.settingsVersion ?? 1, input.members.map(member => ({
        agentId: member.agentId,
        roleTitle: member.roleTitle,
        model: member.model ?? null,
        thinkingEffort: member.thinkingEffort ?? null,
        additionalInstructions: member.additionalInstructions ?? null,
      })));
      const refreshed = await runtimeClient.listConversations();
      const updated = refreshed.conversations.find(item => item.id === editingGroup.id);
      if (updated) setGroups(current => current.map(group => group.id === updated.id ? toUiGroupConversation(updated) : group));
      setEditingGroup(null);
      pushToast('success', '群聊设置已保存');
    } catch (saveError) { notifyError(saveError, '保存群聊策略失败'); }
    finally { setSavingGroupSettings(false); }
  }, [editingGroup, notifyError, pushToast, runtimeClient, workspaceId]);

  const deleteConversation = useCallback(async (conversation: Conversation) => {
    if (!workspaceId) return;
    setDeletingConversationId(conversation.id);
    try {
      if (conversation.type === 'group') {
        if (!runtimeClient) throw new Error('群聊服务暂不可用');
        const listed = await runtimeClient.listConversations();
        const source = listed.conversations.find(item => item.id === conversation.id);
        if (!source) throw new Error('群聊不存在或已归档');
        await runtimeClient.archiveConversation(conversation.id, source.version);
      } else {
        await request<{ conversationId: string }>(`/api/workspaces/${workspaceId}/conversations/${conversation.id}`, { method: 'DELETE' });
      }
      const nextId = conversation.type === 'group' ? getNextConversationId(groups, conversation.id) : getNextConversationId(conversations, conversation.id);
      if (conversation.type === 'group') {
        setGroups(current => current.filter(group => group.id !== conversation.id));
        if (selectedGroupId === conversation.id) { setSelectedGroupId(nextId); setSelectedAgentId(null); setMessages([]); setConversationRuns([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined); }
      } else {
        setConversations(current => current.filter(item => item.id !== conversation.id));
        if (selectedDirectConversationId === conversation.id) { setSelectedDirectConversationId(nextId); setSelectedAgentId(null); setMessages([]); setConversationRuns([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined); }
      }
      setContextMenu(null); setDeletingConversation(null); pushToast('success', '会话已删除');
    } catch (deleteError) { notifyError(deleteError, '删除会话失败'); }
    finally { setDeletingConversationId(null); }
  }, [conversations, groups, notifyError, pushToast, request, runtimeClient, selectedDirectConversationId, selectedGroupId, workspaceId]);

  const selectGroup = useCallback((groupId: string, syncUrl = true) => {
    const group = groups.find(item => item.id === groupId);
    if (!group) return;
    if (!shouldResetGroupView({ selectedGroupId, nextGroupId: groupId })) {
      setSelectedAgentId(null);
      if (syncUrl && workspaceId) router.push(`/workspace/${encodeURIComponent(workspaceId)}?conversationSource=runtime&conversationId=${encodeURIComponent(groupId)}&view=chat`);
      return;
    }
    conversationLoadGenerationRef.current += 1;
    setSelectedGroupId(groupId); setSelectedDirectConversationId(null); setSelectedAgentId(null); setWorkspaceView('chat'); setExecutionRunHint(undefined); setMessages([]); setConversationRuns([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined); setGroupInteraction(null); setGroupBudget(null); setGroupDiscussionError('');
    setOverlayPanel(null);
    if (syncUrl && workspaceId) {
      const query = new URLSearchParams({ conversationId: groupId, view: 'chat' });
      query.set('conversationSource', 'runtime');
      router.push(`/workspace/${encodeURIComponent(workspaceId)}?${query.toString()}`);
    }
  }, [groups, router, selectedGroupId, workspaceId]);

  useEffect(() => {
    if (!workspaceId || returnConversationSource !== 'runtime' || !returnConversationId || groups.length === 0) return;
    const group = groups.find(item => item.id === returnConversationId);
    if (!group || group.type !== 'group') return;
    const key = `${workspaceId}:runtime:${returnConversationId}:${returnCollaborationId ?? ''}`;
    if (returnSelectionRef.current === key) return;
    returnSelectionRef.current = key;
    // URL restoration must not overwrite an explicitly requested tab/run.
    // User-initiated clicks still use the default syncUrl=true path above.
    selectGroup(group.id, false);
  }, [groups, returnCollaborationId, returnConversationId, returnConversationSource, selectGroup, workspaceId]);

  useEffect(() => {
    setWorkspaceView(requestedView);
    setExecutionRunHint(searchParams.get('runId') ?? undefined);
  }, [requestedView, searchParams]);

  const selectDirectConversation = useCallback((conversationId: string) => {
    conversationLoadGenerationRef.current += 1;
    setSelectedGroupId(null);
    setSelectedDirectConversationId(conversationId);
    setMessages([]); setStreamingContent(''); setConversationRuns([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null);
    setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined);
    setWorkspaceView('chat');
    setExecutionRunHint(undefined);
    if (workspaceId) router.push(`/workspace/${encodeURIComponent(workspaceId)}?conversationSource=workspace&conversationId=${encodeURIComponent(conversationId)}&view=chat`);
  }, [router, workspaceId]);

  const closeOverlayPanel = useCallback(() => {
    const panel = overlayPanel;
    setOverlayPanel(null);
    if (panel) window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-layout-toggle="${panel}"]`)?.focus());
  }, [overlayPanel]);

  const toggleLayoutPanel = useCallback((panel: WorkspaceLayoutPanel) => {
    if (panel === 'history' && (selectedGroupId || isLegacyRuntimeLink)) return;
    if (panel === 'workspace' && overlayPanel === 'workspace') {
      setOverlayPanel(null);
      return;
    }

    const currentlyVisible = overlayPanel === panel || panelIsDocked(effectiveLayout, panel);
    const candidate: WorkspaceLayoutPreferences = panel === 'workspace'
      ? { ...layoutPreferences, workspaceMode: currentlyVisible ? 'compact' : 'full' }
      : panel === 'history'
        ? { ...layoutPreferences, historyOpen: !currentlyVisible }
        : { ...layoutPreferences, inspectorOpen: !currentlyVisible };
    const next = layoutPreferences.focusMode ? { ...candidate, focusMode: false, focusRestore: undefined } : candidate;
    setLayoutPreferences(next);

    if (currentlyVisible) {
      setOverlayPanel(null);
      return;
    }
    const nextLayout = resolveEffectiveWorkspaceLayout({ viewportWidth: layoutViewportWidth, preferences: next, historyAvailable: !selectedGroupId && !isLegacyRuntimeLink });
    setOverlayPanel(panelIsDocked(nextLayout, panel) ? null : panel);
  }, [effectiveLayout, isLegacyRuntimeLink, layoutPreferences, layoutViewportWidth, overlayPanel, selectedGroupId]);

  const toggleFocusMode = useCallback(() => {
    setLayoutPreferences(current => {
      if (current.focusMode && current.focusRestore) {
        return { ...current.focusRestore, focusMode: false, focusRestore: undefined };
      }
      const focusRestore: Omit<WorkspaceLayoutPreferences, 'focusMode' | 'focusRestore'> = {
        version: 2,
        workspaceMode: current.workspaceMode,
        workspaceWidth: current.workspaceWidth,
        historyOpen: current.historyOpen,
        historyWidth: current.historyWidth,
        inspectorOpen: current.inspectorOpen,
        inspectorWidth: current.inspectorWidth,
      };
      return { ...current, workspaceMode: 'compact', historyOpen: false, inspectorOpen: false, focusMode: true, focusRestore };
    });
    setOverlayPanel(null);
  }, []);

  useEffect(() => {
    const handleLayoutShortcut = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.altKey || (!event.ctrlKey && !event.metaKey)) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'b' && !event.shiftKey) {
        event.preventDefault();
        toggleLayoutPanel('history');
      } else if (key === 'l' && event.shiftKey) {
        event.preventDefault();
        toggleLayoutPanel('inspector');
      }
    };
    window.addEventListener('keydown', handleLayoutShortcut);
    return () => window.removeEventListener('keydown', handleLayoutShortcut);
  }, [toggleLayoutPanel]);

  const selectAgent = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setSelectedGroupId(null);
    setSelectedDirectConversationId(null);
    setWorkspaceView('chat');
    setExecutionRunHint(undefined);
    setError('');
    setOverlayPanel(null);
    if (workspaceId) router.push(`/workspace/${encodeURIComponent(workspaceId)}?conversationSource=workspace&view=chat`);
  }, [router, workspaceId]);

  const openEditorLayer = useCallback((open: () => void) => {
    setOverlayPanel(null);
    open();
  }, []);

  const openRuntime = useCallback((runId?: string) => {
    const progress = collaborationProgressState.progress;
    const targetRunId = runId ?? progress?.currentRunId ?? visibleActiveRunId;
    const runSource = progress?.runs.some(run => run.runId === targetRunId) ? 'canonical' : 'workspace';
    setExecutionRunHint(targetRunId);
    setWorkspaceView('execution');
    if (workspaceId) {
      const query = new URLSearchParams(searchParams.toString());
      if (activeConversationId) { query.set('conversationSource', activeConversationSource); query.set('conversationId', activeConversationId); }
      query.set('view', 'execution');
      if (progress?.task.id) query.set('collaborationId', progress.task.id);
      if (targetRunId) query.set('runId', targetRunId);
      if (targetRunId) query.set('runSource', runSource);
      router.push(`/workspace/${encodeURIComponent(workspaceId)}?${query.toString()}`);
    }
  }, [activeConversationId, activeConversationSource, collaborationProgressState.progress, router, searchParams, visibleActiveRunId, workspaceId]);

  const openCollaborationDetails = useCallback(() => {
    const taskId = collaborationProgressState.selectedTaskId ?? returnCollaborationId;
    if (!workspaceId || !activeConversationId || !taskId) {
      setCollaborationPanelCreateMode(true);
      setShowCollaborationTask(true);
      return;
    }
    const query = new URLSearchParams(searchParams.toString());
    query.set('conversationSource', activeConversationSource);
    query.set('conversationId', activeConversationId);
    query.set('collaborationId', taskId);
    query.set('view', 'execution');
    query.delete('runId');
    query.delete('runSource');
    setWorkspaceView('execution');
    router.push(`/workspace/${encodeURIComponent(workspaceId)}?${query.toString()}`);
  }, [activeConversationId, activeConversationSource, collaborationProgressState.selectedTaskId, returnCollaborationId, router, searchParams, workspaceId]);

  const finishCreatedCollaborationFocus = useCallback(() => setFocusCreatedCollaborationId(null), []);
  const handleCollaborationCreated = useCallback((taskId: string) => {
    if (!workspaceId || !activeConversationId) return;
    setShowCollaborationTask(false);
    setCollaborationPanelCreateMode(false);
    setFocusCreatedCollaborationId(taskId);
    setWorkspaceView('execution');
    const query = new URLSearchParams(searchParams.toString());
    query.set('conversationSource', activeConversationSource);
    query.set('conversationId', activeConversationId);
    query.set('collaborationId', taskId);
    query.set('view', 'execution');
    query.delete('runId');
    query.delete('runSource');
    router.push(`/workspace/${encodeURIComponent(workspaceId)}?${query.toString()}`);
  }, [activeConversationId, activeConversationSource, router, searchParams, workspaceId]);

  const changeWorkspaceView = useCallback((view: UnifiedWorkspaceView) => {
    setWorkspaceView(view);
    if (!workspaceId) return;
    const query = new URLSearchParams(searchParams.toString());
    query.set('view', view);
    if (view === 'chat') {
      query.delete('runId');
      query.delete('runSource');
    }
    if (activeConversationId) {
      query.set('conversationSource', activeConversationSource);
      query.set('conversationId', activeConversationId);
    }
    router.push(`/workspace/${encodeURIComponent(workspaceId)}?${query.toString()}`);
  }, [activeConversationId, activeConversationSource, router, searchParams, workspaceId]);

  const renderAgentPanel = (compact: boolean, panelWidth?: number) => <AgentList panelWidth={panelWidth} compact={compact} agents={agents} presence={presence} groups={groups} selectedGroupId={selectedGroupId} selectedAgentId={selectedAgentId} activeStatus={visibleActiveStatus} onSelect={selectAgent} onSelectGroup={selectGroup} onCreateGroup={() => openEditorLayer(() => setCreatingGroup(true))} onContextMenu={openContextMenu} onBackToWorkspace={() => router.push('/')} onOpenMemories={() => openEditorLayer(() => setShowMemories(true))} onOpenPreferences={() => openEditorLayer(() => setShowPreferences(true))} onOpenMemoryReview={() => openEditorLayer(() => setShowMemoryReview(true))} />;
  const renderHistoryPanel = (panelWidth?: number) => <ConversationHistory panelWidth={panelWidth} title={historyTitle} conversations={historyConversations} selectedConversationId={activeConversationId} createLabel="新建会话" onCreate={() => { void createConversation().catch(createError => notifyError(createError, '创建会话失败')); }} onSelect={selectDirectConversation} onContextMenu={openContextMenu} />;
  const renderInspectorPanel = (panelWidth?: number) => isGroupConversation ? <aside data-signal-inspector data-layout-panel="inspector" className="inspector-sidebar signal-inspector ui-panel w-64 shrink-0 overflow-y-auto border-l px-4 py-5" style={panelWidth === undefined ? undefined : { width: `${panelWidth}px` }}>
    <div className="mb-6 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold ui-text">协作状态</h2><button type="button" className="ui-button-ghost rounded-lg px-2 py-1 text-xs" onClick={collaborationProgressState.refresh} disabled={collaborationProgressState.loading}>刷新</button></div>
    {selectedConversation && <div className="signal-inspector-summary mb-5 flex items-center gap-3 p-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--app-accent)] text-sm font-semibold text-white">群</span><div className="min-w-0"><div className="truncate text-sm font-medium ui-text">{selectedConversation.title}</div><div className="mt-0.5 truncate text-xs ui-muted">群聊协作</div></div></div>}
    {collaborationProgressState.progress ? <>
      <section className="mb-5 rounded-xl border ui-border bg-[var(--app-surface-raised)] p-3"><div className="text-xs font-medium ui-text">{collaborationProgressState.progress.task.title}</div><div className="mt-2 text-xs ui-muted">状态：{collaborationProgressState.progress.currentStage?.status === 'waiting_approval' ? '待审批' : collaborationProgressState.progress.task.status === 'running' && collaborationProgressState.progress.waitingReason ? '等待用户' : collaborationProgressState.progress.task.status}</div><div className="mt-1 text-xs ui-muted">阶段：{collaborationProgressState.progress.currentStage?.label ?? '未开始'}</div><div className="mt-1 text-xs ui-muted">负责 Agent：{collaborationProgressState.progress.currentAgent?.name ?? '尚未开始'}</div>{collaborationProgressState.progress.waitingReason && <p className="mt-2 text-xs leading-5 text-[var(--app-warning)]">{collaborationProgressState.progress.waitingReason}</p>}</section>
      <div className="text-xs ui-dim">{collaborationProgressState.connection === 'connected' ? '与主区进度同步' : collaborationProgressState.connection === 'offline' ? '连接中断，显示最近状态' : collaborationProgressState.loading ? '正在同步…' : '等待进度更新'}</div>
    </> : collaborationProgressState.error ? <p role="alert" className="text-xs leading-5 text-[var(--app-danger)]">协作进度加载失败：{collaborationProgressState.error}</p> : <p className="text-xs leading-5 ui-dim">{collaborationProgressState.loading ? '正在加载协作进度…' : '当前群聊还没有协作任务。'}</p>}
  </aside> : directRunBlocked ? <aside data-layout-panel="inspector" className="inspector-sidebar signal-inspector ui-panel w-64 shrink-0 border-l px-4 py-5" style={panelWidth === undefined ? undefined : { width: `${panelWidth}px` }}><p role={directRunBinding === 'mismatch' ? 'alert' : 'status'} className="text-xs leading-5 ui-muted">{directRunBinding === 'loading' ? '正在验证 Run 所属会话…' : runLinkState?.error}</p></aside> : <ExecutionInspector key={activeDraftIdentityKey ?? 'unselected'} panelWidth={panelWidth} agent={selectedAgent} events={visibleActiveEvents} runtimeEvents={visibleRuntimeEvents} steps={visibleRunSteps} executions={visibleExecutions} runHistory={visibleConversationRuns} activeStatus={visibleActiveStatus} activeStartedAt={evidenceVisible ? activeStartedAt : undefined} apiBase={API_BASE} workspaceId={workspaceId ?? undefined} activeRunId={visibleActiveRunId} onEdit={() => { setOverlayPanel(null); setEditingAgent(true); }} onOpenRunDetails={runId => { void openRunDetails(runId); }} onRuntimeApprovalResolved={() => { if (activeConversationId) void loadConversationDetails(activeConversationId).catch(() => undefined); }} />;
  const validatedRunHint = directRunBinding === 'matched' || directRunBinding === 'unattached' ? activeExecutionRunHint : undefined;
  const legacyRunIds = [...new Set([validatedRunHint, ...visibleConversationRuns.map(run => run.id)].filter((runId): runId is string => Boolean(runId)))];
  const renderLegacyExecutionPanel = () => <main data-agentos="workspace-execution-view" className="signal-chat flex min-w-0 flex-1 flex-col bg-[var(--app-bg)]">
    <header className="signal-chat-header absolute inset-x-3 top-3 z-10 flex min-h-[4.25rem] items-center justify-between gap-3 rounded-2xl border ui-border px-5 py-3"><div className="min-w-0"><div className="text-[15px] font-semibold ui-text">执行详情</div><div className="mt-1 text-xs ui-muted">当前会话的任务状态、交付证据和技术详情</div></div><div className="flex items-center gap-1 rounded-xl border ui-border p-1" role="tablist" aria-label="工作区视图"><button type="button" role="tab" aria-selected={false} data-agentos="workspace-chat-tab" onClick={() => changeWorkspaceView('chat')} className="ui-button-ghost rounded-lg px-2.5 py-1.5 text-xs">对话</button><button type="button" role="tab" aria-selected={true} data-agentos="workspace-execution-tab" className="ui-selected rounded-lg px-2.5 py-1.5 text-xs">执行详情</button></div></header>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-28 sm:px-6"><div className="mx-auto max-w-[70rem] space-y-4">
      {!explicitSelectionVerified ? <section role="alert" className="rounded-2xl border ui-border p-6 text-sm ui-muted">{conversationSelectionError || '正在验证目标会话…'}</section>
        : collaborationRunLinkError ? <section role="alert" className="rounded-2xl border border-[var(--app-danger)]/40 p-6 text-sm ui-error">{collaborationRunLinkError}</section>
          : isGroupConversation && collaborationProgressState.progress ? <CollaborationTaskDetailsView key={`${activeDraftIdentityKey}:${collaborationProgressState.progress.task.id}`} workspaceId={workspaceId ?? ''} apiBase={API_BASE} state={collaborationProgressState} agents={agents} activeRunId={activeExecutionRunHint} focusTaskId={focusCreatedCollaborationId} onTaskTitleFocused={finishCreatedCollaborationFocus} onBack={() => changeWorkspaceView('chat')} onOpenRun={runId => { void openRuntime(runId); }} />
            : isGroupConversation && collaborationProgressState.error ? <section role="alert" className="rounded-2xl border ui-border p-6 text-sm ui-error">协作任务无法加载：{collaborationProgressState.error}</section>
              : isGroupConversation ? <section className="rounded-2xl border ui-border p-6 text-sm ui-muted">{collaborationProgressState.loading ? '正在加载协作任务…' : '当前群聊还没有协作任务。返回对话后点击“协作任务”创建。'}</section>
                : directRunBlocked ? <section role={directRunBinding === 'mismatch' ? 'alert' : 'status'} className="rounded-2xl border ui-border p-6 text-sm ui-muted">{directRunBinding === 'loading' ? '正在验证 Run 所属会话…' : runLinkState?.error}</section>
                  : <div className="rounded-2xl border ui-border bg-[var(--app-surface)]">
                    {directRunBinding === 'unattached' && <p role="status" className="px-4 py-3 text-sm ui-muted">此 Run 未关联会话，以下为独立运行的只读证据。</p>}
                    <RunInspectorPanel key={`${activeDraftIdentityKey}:${validatedRunHint ?? ''}`} workspaceId={workspaceId ?? ''} apiBase={API_BASE} runIds={legacyRunIds} initialRunId={validatedRunHint} theme="light" readOnly={directRunBinding === 'unattached'} />
                  </div>}
      {explicitSelectionVerified && isGroupConversation && collaborationProgressState.progress && !collaborationRunLinkError && <details className="rounded-2xl border ui-border bg-[var(--app-surface)]"><summary className="cursor-pointer px-4 py-3 text-sm font-medium ui-text">技术详情（事件、进程与运行时记录）</summary><RunInspectorPanel key={`${activeDraftIdentityKey}:${collaborationProgressState.progress.task.id}`} workspaceId={workspaceId ?? ''} apiBase={API_BASE} runIds={collaborationProgressState.progress.runs.map(run => run.runId)} initialRunId={activeExecutionRunHint ?? collaborationProgressState.progress.currentRunId} theme="light" readOnly refreshSignal={collaborationProgressState.refreshRevision} /></details>}
    </div></div>
  </main>;
  const renderLegacyChatPanel = () => <ChatPanel key={activeDraftIdentityKey ?? explicitSelectionKey ?? 'unselected'}
    agentName={selectedAgent?.name} roleTitle={selectedAgent?.roleTitle}
    conversationTitle={isGroupConversation && selectedConversation ? `群聊 · ${selectedConversation.title}` : undefined}
    groupName={isGroupConversation ? selectedConversation?.title : undefined} isGroup={isGroupConversation} agents={agents}
    messages={visibleMessages} streamingContent={visibleStreamingContent}
    activeEvents={visibleActiveEvents} activeRuntimeEvents={visibleRuntimeEvents}
    artifacts={evidenceVisible && !directRunBlocked ? activeArtifacts : []}
    runtimeResult={evidenceVisible && !directRunBlocked ? activeRuntimeResult ?? undefined : undefined}
    apiBase={API_BASE} activeStatus={visibleActiveStatus} waitingQuestion={evidenceVisible && !directRunBlocked ? activeWaitingQuestion : undefined}
    connectionNotice={evidenceVisible ? connectionNotice : ''} error={conversationSelectionError || (directRunBinding === 'mismatch' ? runLinkState?.error ?? '' : evidenceVisible ? error : '')}
    draft={draft} attachments={attachments} attachmentError={evidenceVisible ? attachmentError : ''} validationError={evidenceVisible ? validationError : ''}
    draftReady={draftState.ready} draftPersistenceWarning={draftState.warning}
    scrollIdentityKey={activeDraftIdentityKey ?? undefined} savedScrollPosition={draftState.draft.scrollPosition}
    onScrollPositionChange={draftState.setScrollPosition}
    sending={sending} queuedMessageCount={queuedMessageCount} onResumeQueue={handleResumeQueue}
    modelOptions={composerModelOptions} composerModel={composerModel} composerThinkingEffort={composerThinkingEffort}
    composerThinkingEfforts={composerThinkingEfforts} modelSource={selectedAgent?.capability?.modelSource}
    mentionedAgentIds={mentionedAgentIds} onMentionedAgentIdsChange={setMentionedAgentIds}
    runIntent={runIntent} onRunIntentChange={setRunIntent}
    onDraftChange={value => { setDraft(value); if (!getComposerValidationError(value, attachments.length)) setValidationError(''); }}
    onFiles={files => { void handleFiles(files); }} onRemoveAttachment={removeAttachment}
    onComposerModelChange={handleComposerModelChange} onComposerThinkingEffortChange={handleComposerThinkingEffortChange}
    onSend={() => { void handleSend(); }} onCancel={handleCancel}
    onOpenRuntimeDetails={runId => { void openRunDetails(runId); }} onOpenRuntime={openRuntime}
    onCreateCollaborationTask={() => { setCollaborationPanelCreateMode(true); setShowCollaborationTask(true); }}
    onOpenCollaborationTask={openCollaborationDetails} collaborationProgressState={collaborationProgressState}
    groupInteraction={evidenceVisible && isGroupConversation ? groupInteraction : undefined}
    groupBudget={evidenceVisible && isGroupConversation ? groupBudget : undefined}
    groupSpeakingAgentName={evidenceVisible && isGroupConversation ? agents.find(agent => agent.id === groupSpeakingAgentId)?.name : undefined}
    groupDiscussionError={evidenceVisible && isGroupConversation ? groupDiscussionError : undefined}
    layoutControls={{ workspaceMode: effectiveLayout.workspaceMode, historyAvailable: !selectedGroupId && !isLegacyRuntimeLink,
      historyVisible: effectiveLayout.historyVisible, inspectorVisible: effectiveLayout.inspectorVisible, focusMode: layoutPreferences.focusMode,
      view: activeWorkspaceView, onViewChange: changeWorkspaceView, onToggleWorkspace: () => toggleLayoutPanel('workspace'),
      onToggleHistory: () => toggleLayoutPanel('history'), onToggleInspector: () => toggleLayoutPanel('inspector'), onToggleFocus: toggleFocusMode }} />;
  const renderMainContent = () => activeWorkspaceView === 'execution' ? renderLegacyExecutionPanel() : renderLegacyChatPanel();

  if (!workspaceId) return <div className="app-shell grid h-screen place-items-center text-sm ui-muted">工作区不存在</div>;
  if (!workspace && !error) return <div className="app-shell grid h-screen place-items-center text-sm ui-muted">正在加载工作区…</div>;

  return <div ref={layoutRef} data-signal-workspace data-workspace-layout data-visible-conversation-identity={activeDraftIdentityKey ?? ''} className="signal-workspace app-shell flex h-screen min-w-0 overflow-hidden">
    {renderAgentPanel(effectiveLayout.workspaceMode === 'compact', effectiveLayout.workspaceMode === 'compact' ? WORKSPACE_LAYOUT_WIDTHS.compactRail : layoutPreferences.workspaceWidth)}
    <PanelResizeHandle panel="workspace" width={effectiveLayout.workspaceWidth} onPointerDown={handleResizePointerDown} onKeyDown={handleResizeKeyDown} />
    {effectiveLayout.historyVisible && !selectedGroupId && <>
      {renderHistoryPanel(layoutPreferences.historyWidth)}
      <PanelResizeHandle panel="history" width={layoutPreferences.historyWidth} onPointerDown={handleResizePointerDown} onKeyDown={handleResizeKeyDown} />
    </>}
    {renderMainContent()}
    {effectiveLayout.inspectorVisible && <>
      <PanelResizeHandle panel="inspector" width={layoutPreferences.inspectorWidth} onPointerDown={handleResizePointerDown} onKeyDown={handleResizeKeyDown} />
      {renderInspectorPanel(layoutPreferences.inspectorWidth)}
    </>}
    {overlayPanel && <WorkspacePanelOverlay panel={overlayPanel} onClose={closeOverlayPanel}>
      {overlayPanel === 'workspace' && renderAgentPanel(false)}
      {overlayPanel === 'history' && renderHistoryPanel()}
      {overlayPanel === 'inspector' && renderInspectorPanel()}
    </WorkspacePanelOverlay>}
    {editingAgent && selectedAgent && <AgentEditor key={`${selectedAgent.id}-${selectedAgent.capability?.modelSource}-${selectedAgent.capability?.models.join('|')}`} agent={selectedAgent} saving={savingAgent} refreshingModels={savingAgent} onClose={() => setEditingAgent(false)} onRefreshModels={() => { void refreshAgentModels(); }} onSave={update => { void saveAgent(update); }} />}
     {creatingGroup && <GroupCreator agents={agents} saving={savingGroup} onClose={() => setCreatingGroup(false)} onCreate={input => { void createGroup(input); }} />}
     {editingGroup && <GroupEditor agents={agents} members={editingGroupMembers} title={editingGroup.title} dispatchMode={editingGroup.dispatchMode ?? 'leader_route'} saving={savingGroupSettings} onClose={() => setEditingGroup(null)} onSave={input => { void saveGroupSettings(input); }} />}
    {renamingConversation && <GroupRenameModal title={renamingConversation.title} entityLabel={renamingConversation.type === 'group' ? '群聊' : '会话'} saving={savingConversationTitle} onClose={() => setRenamingConversation(null)} onSave={title => { void saveConversationTitle(title); }} />}
    {contextMenu && <ConversationContextMenu conversation={contextMenu.conversation} clientX={contextMenu.clientX} clientY={contextMenu.clientY} onRename={contextMenu.conversation.type === 'group' ? undefined : () => setRenamingConversation(contextMenu.conversation)} onEditGroup={contextMenu.conversation.type === 'group' ? () => { void openGroupEditor(contextMenu.conversation); } : undefined} onCopyId={() => { void copyConversationId(contextMenu.conversation.id); }} onDelete={() => setDeletingConversation(contextMenu.conversation)} onClose={() => setContextMenu(null)} />}
    {deletingConversation && <ConfirmDialog
      eyebrow="DELETE CONVERSATION"
      title={`删除${deletingConversation.type === 'group' ? '群聊' : '会话'}？`}
      description="此操作不可撤销，历史消息、执行记录及相关上下文都会被移除。"
      targetLabel={deletingConversation.title}
      targetDescription="请确认你要删除的是这条会话。"
      confirmLabel="确认删除"
      busy={deletingConversationId === deletingConversation.id}
      busyLabel="删除中…"
      onClose={() => { if (deletingConversationId === null) setDeletingConversation(null); }}
      onConfirm={() => { void deleteConversation(deletingConversation); }}
    />}
    {runDetails && evidenceVisible && !directRunBlocked && <RunDetails details={runDetails} apiBase={API_BASE} onClose={() => setRunDetails(null)} onGenerateCandidates={runId => { void generateMemoryCandidates(runId); }} generatingCandidates={generatingCandidates} />}
    {showMemories && <MemoryPanel workspaceId={workspaceId} onClose={() => setShowMemories(false)} onOpenRun={runId => { setShowMemories(false); void openRunDetails(runId); }} />}
    {showPreferences && <PreferencePanel workspaceId={workspaceId} onClose={() => setShowPreferences(false)} onOpenRun={runId => { setShowPreferences(false); void openRunDetails(runId); }} />}
    {showCandidateQueue && <MemoryCandidateQueue workspaceId={workspaceId} onClose={() => setShowCandidateQueue(false)} onOpenRun={runId => { setShowCandidateQueue(false); void openRunDetails(runId); }} />}
    {showMemoryReview && <MemoryReviewQueue workspaceId={workspaceId} onClose={() => setShowMemoryReview(false)} />}
    {showCollaborationTask && isGroupConversation && selectedConversation && <CollaborationTaskPanel key={`${selectedConversation.id}:${collaborationPanelCreateMode ? 'create' : 'details'}`} workspaceId={workspaceId} groupName={selectedConversation.title} conversationId={selectedConversation.id} agents={agents} startInCreateMode={collaborationPanelCreateMode} onClose={() => setShowCollaborationTask(false)} onCreated={handleCollaborationCreated} />}
    <ToastStack toasts={toasts} onDismiss={dismissToast} />
  </div>;
}
