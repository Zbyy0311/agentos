'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { AgentProfile, AgentRunDetails, Conversation, ConversationMember, GroupDispatchMode, RunIntent, ThinkingEffort } from '@agentos/shared';
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
import { shouldResetGroupView } from '@/lib/conversationSelection';
import { getNextConversationId } from '@/lib/conversationActions';
import { getInitialComposerSettings, getModelOptions, getThinkingEfforts, normalizeThinkingEffort } from '@/lib/composerSettings';
import { fileToImageDraft, validateImageDrafts, type ImageDraft } from '@/lib/imageAttachments';
import { getInspectorProposedWidth, getResizablePanelWidth } from '@/lib/resizablePanels';
import { DEFAULT_WORKSPACE_LAYOUT, WORKSPACE_LAYOUT_THRESHOLDS, WORKSPACE_LAYOUT_WIDTHS, normalizeWorkspaceLayout, panelCollapseThreshold, panelIsDocked, panelWidthRange, resolveEffectiveWorkspaceLayout, workspaceLayoutStorageKey, type EffectiveWorkspaceLayout, type WorkspaceLayoutPanel, type WorkspaceLayoutPreferences } from '@/lib/workspaceLayout';
import { RunDetails } from '@/components/runs/RunDetails';
import { MemoryPanel } from '@/components/memory/MemoryPanel';
import { MemoryCandidateQueue } from '@/components/memory/MemoryCandidateQueue';
import { MemoryReviewQueue } from '@/components/memory/MemoryReviewQueue';
import { CollaborationTaskPanel } from '@/components/chat/CollaborationTaskPanel';
import { PreferencePanel } from '@/components/preference/PreferencePanel';
import { ToastStack } from '@/components/feedback/ToastStack';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { classifyUiError, getComposerValidationError, TOAST_DURATION_MS, type ToastItem, type ToastTone } from '@/lib/uiFeedback';
import { useCollaborationProgress } from '@/lib/useCollaborationProgress';
import { directConversationClient } from '@/lib/directConversationClient';
import { groupConversationClient } from '@/lib/groupConversationClient';
import { useConversationDraft } from '@/lib/useConversationDraft';
import { createConversationDraftIdentityKey, type ConversationDraftIdentity } from '@/lib/conversationDraftState';
import { projectRuntimeResult } from '@/lib/runtimeProjection';
import { isCurrentConversationGeneration } from '@/lib/conversationDraftState';
import type { UnifiedWorkspaceView } from '@/components/chat/UnifiedRuntimeConversationSurface';
import { RunInspectorPanel } from '@/components/chat/RunInspectorPanel';
import { CollaborationTaskDetailsView } from '@/components/chat/CollaborationTaskDetailsView';
import { useWorkspaceData } from '@/lib/useWorkspaceData';
import { useConversationStream } from '@/lib/useConversationStream';
import { toUiGroupConversation, toUiGroupMember } from '@/lib/uiGroupConversation';

type ContextMenuState = { conversation: Conversation; clientX: number; clientY: number };
type ResizePanel = WorkspaceLayoutPanel;
type OverlayPanel = WorkspaceLayoutPanel | null;
type ActivePanelResize = { panel: ResizePanel; startX: number; startWidth: number; startPreferences: WorkspaceLayoutPreferences; lastProposed?: number; cleanup: () => void };

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
  const [, setWorkspaceView] = useState<UnifiedWorkspaceView>(requestedView);
  const [executionRunHint, setExecutionRunHint] = useState<string | undefined>(searchParams.get('runId') ?? undefined);
  const activeExecutionRunHint = searchParams.get('runId') ?? executionRunHint;
  const [attachmentError, setAttachmentError] = useState('');
  const [conversationSelectionError, setConversationSelectionError] = useState('');
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
  const activeResizeRef = useRef<ActivePanelResize | null>(null);
  const returnSelectionRef = useRef<string | null>(null);
  const toastIdRef = useRef(0);

  const pushToast = useCallback((tone: ToastTone, message: string) => {
    const id = `toast-${Date.now()}-${toastIdRef.current++}`;
    setToasts(current => [...current, { id, tone, message, durationMs: TOAST_DURATION_MS }].slice(-4));
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts(current => current.filter(toast => toast.id !== id));
  }, []);

  const notifyError = useCallback((unknownError: unknown, fallback = '操作失败') => {
    const message = unknownError instanceof Error ? unknownError.message : String(unknownError);
    if (classifyUiError(unknownError) === 'connection') {
      setConnectionNotice(message || '连接异常，请稍后重试');
      return;
    }
    pushToast('error', message || fallback);
  }, [pushToast]);

  const onLoadError = useCallback((message: string) => {
    setError(message);
  }, []);

  const runtimeClient = useMemo(
    () => workspaceId ? directConversationClient({ workspaceId, apiBase: API_BASE }) : null,
    [API_BASE, workspaceId],
  );
  const groupClient = useMemo(
    () => workspaceId ? groupConversationClient({ workspaceId, apiBase: API_BASE }) : null,
    [API_BASE, workspaceId],
  );

  const workspaceData = useWorkspaceData({
    workspaceId,
    runtimeClient,
    request,
    returnConversationId,
    returnConversationSource,
    returnConversationSourceParameter,
    onLoadError,
    notifyError,
    setConversationSelectionError,
  });

  const {
    workspace, agents, presence, conversations, setConversations, groups, setGroups,
    selectedAgentId, setSelectedAgentId, selectedGroupId, setSelectedGroupId,
    selectedDirectConversationId, setSelectedDirectConversationId,
    selectedAgent, selectedConversation, activeConversationId, activeConversationSource,
    explicitSelectionVerified,
    loadPresence, applyAgent, persistConversationSettings, prependConversation,
  } = workspaceData;

  const isLegacyRuntimeLink = returnConversationSource === 'runtime';
  const isGroupConversation = selectedConversation?.type === 'group';
  const explicitSelectionKey = returnConversationId ? `${workspaceId ?? ''}:${returnConversationSourceParameter ?? 'legacy'}:${returnConversationId}` : null;
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
  const setDraft = draftState.setText;
  const setMentionedAgentIds = draftState.setMentions;
  const setRunIntent = draftState.setRunIntent;
  const setAttachments = draftState.setAttachments;
  const setComposerModel = draftState.setModel;
  const setComposerThinkingEffort = draftState.setThinkingEffort;
  const setQueue = draftState.setQueue;

  const onResetFeedback = useCallback(() => {
    setError(''); setConnectionNotice(''); setValidationError(''); setAttachmentError(''); setRunDetails(null);
  }, []);

  const applyCreatedConversation = useCallback((conversation: Conversation, fallbackAgentId: string | null) => {
    setConversations(current => [conversation, ...current.filter(item => item.id !== conversation.id)]);
    setSelectedGroupId(null);
    setSelectedAgentId(conversation.agentId ?? fallbackAgentId);
    setSelectedDirectConversationId(conversation.id);
  }, [setConversations, setSelectedAgentId, setSelectedDirectConversationId, setSelectedGroupId]);

  const selectCreatedConversation = useCallback((conversationId: string) => {
    setSelectedGroupId(null);
    setSelectedDirectConversationId(conversationId);
  }, [setSelectedDirectConversationId, setSelectedGroupId]);

  const stream = useConversationStream({
    workspaceId,
    apiBase: API_BASE,
    request,
    router,
    draftState,
    draftIdentity,
    activeDraftIdentityKey,
    explicitSelectionVerified,
    activeConversationId,
    isGroupConversation,
    agents,
    selectedAgent,
    selectedConversation,
    selectedGroupId,
    activeWorkspaceView,
    runtimeClient,
    groupClient,
    loadPresence,
    notifyError,
    pushToast,
    setError,
    setConnectionNotice,
    setValidationError,
    setAttachmentError,
    onResetFeedback,
    activeExecutionRunHint,
    applyCreatedConversation,
    persistConversationSettings,
    prependConversation,
    selectCreatedConversation,
    composerModel,
    composerThinkingEffort,
  });

  const {
    activeScopeGenerationRef, activeDraftIdentityKeyRef, activeConversationIdRef, conversationLoadGenerationRef,
    streamingStore,
    messages, conversationRuns, executions, activeEvents, activeRuntimeEvents, activeRunSteps, activeArtifacts, activeRuntimeResult,
    activeStatus, activeStartedAt, activeRunId, activeWaitingQuestion,
    groupInteraction, groupExecutionOwner, groupBudget, groupDiscussionError, groupSpeakingAgentId,
    sendingIdentityKeys, runLinkState, evidenceVisible, directRunBinding,
    resetEvidence, createConversation, loadRunDetails, loadConversationDetails, handleSend, handleResumeQueue, handleCancel, handleGroupInteractionRecovered,
  } = stream;

  const sending = Boolean(activeDraftIdentityKey && sendingIdentityKeys.has(activeDraftIdentityKey));
  const directRunBlocked = directRunBinding === 'loading' || directRunBinding === 'mismatch';
  const visibleMessages = evidenceVisible ? messages : [];
  const visibleActiveEvents = evidenceVisible && !directRunBlocked ? activeEvents : [];
  const visibleRuntimeEvents = evidenceVisible && !directRunBlocked ? activeRuntimeEvents : [];
  const visibleRunSteps = evidenceVisible && !directRunBlocked ? activeRunSteps : [];
  const visibleExecutions = evidenceVisible && !directRunBlocked ? executions : [];
  const visibleConversationRuns = evidenceVisible && !directRunBlocked ? conversationRuns : [];
  const visibleActiveRunId = evidenceVisible && !directRunBlocked ? activeRunId : undefined;
  const visibleActiveStatus = evidenceVisible && !directRunBlocked ? activeStatus : undefined;

  const resetConversationEvidence = useCallback(() => {
    resetEvidence();
    onResetFeedback();
  }, [resetEvidence, onResetFeedback]);

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
    } catch (unknownError) {
      for (const draft of addedDrafts) URL.revokeObjectURL(draft.previewUrl);
      if (isCurrent()) setAttachmentError(unknownError instanceof Error ? unknownError.message : String(unknownError));
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

  const saveAgent = useCallback(async (update: Pick<AgentProfile, 'roleTitle' | 'systemPrompt' | 'permissions' | 'enabled'> & Partial<Pick<AgentProfile, 'name' | 'model' | 'provider'>> & { thinkingEffort: ThinkingEffort }) => {
    if (!workspaceId || !selectedAgent) return;
    setSavingAgent(true);
    try {
      const result = await request<{ agent: AgentProfile }>(`/api/workspaces/${workspaceId}/agents/${selectedAgent.id}`, { method: 'PATCH', body: update });
      applyAgent(result.agent);
      setEditingAgent(false);
    } catch (saveError) { notifyError(saveError, '保存智能体失败'); }
    finally { setSavingAgent(false); }
  }, [applyAgent, notifyError, request, selectedAgent, workspaceId]);

  const refreshAgentModels = useCallback(async () => {
    if (!workspaceId || !selectedAgent) return;
    setSavingAgent(true);
    try {
      const result = await request<{ agent: AgentProfile }>(`/api/workspaces/${workspaceId}/agents/${selectedAgent.id}/models/refresh`, { method: 'POST' });
      applyAgent(result.agent);
    } catch (refreshError) { notifyError(refreshError, '刷新模型失败'); }
    finally { setSavingAgent(false); }
  }, [applyAgent, notifyError, request, selectedAgent, workspaceId]);

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
      resetConversationEvidence(); setCreatingGroup(false);
      if (workspaceId) router.replace(`/workspace/${encodeURIComponent(workspaceId)}?conversationSource=runtime&conversationId=${encodeURIComponent(conversation.id)}&view=chat`);
    } catch (groupError) { notifyError(groupError, '创建群聊失败'); }
    finally { setSavingGroup(false); }
  }, [notifyError, resetConversationEvidence, router, runtimeClient, setGroups, setSelectedAgentId, setSelectedDirectConversationId, setSelectedGroupId, workspaceId]);

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
  }, [notifyError, renamingConversation, request, runtimeClient, setConversations, setGroups, workspaceId]);

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
  }, [editingGroup, notifyError, pushToast, runtimeClient, setGroups, workspaceId]);

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
        if (selectedGroupId === conversation.id) { setSelectedGroupId(nextId); setSelectedAgentId(null); resetConversationEvidence(); }
      } else {
        setConversations(current => current.filter(item => item.id !== conversation.id));
        if (selectedDirectConversationId === conversation.id) { setSelectedDirectConversationId(nextId); setSelectedAgentId(null); resetConversationEvidence(); }
      }
      setContextMenu(null); setDeletingConversation(null); pushToast('success', '会话已删除');
    } catch (deleteError) { notifyError(deleteError, '删除会话失败'); }
    finally { setDeletingConversationId(null); }
  }, [conversations, groups, notifyError, pushToast, request, resetConversationEvidence, runtimeClient, selectedDirectConversationId, selectedGroupId, setConversations, setGroups, setSelectedAgentId, setSelectedDirectConversationId, setSelectedGroupId, workspaceId]);

  const selectGroup = useCallback((groupId: string, syncUrl = true) => {
    const group = groups.find(item => item.id === groupId);
    if (!group) return;
    if (!shouldResetGroupView({ selectedGroupId, nextGroupId: groupId })) {
      setSelectedAgentId(null);
      if (syncUrl && workspaceId) router.push(`/workspace/${encodeURIComponent(workspaceId)}?conversationSource=runtime&conversationId=${encodeURIComponent(groupId)}&view=chat`);
      return;
    }
    conversationLoadGenerationRef.current += 1;
    setSelectedGroupId(groupId); setSelectedDirectConversationId(null); setSelectedAgentId(null); setWorkspaceView('chat'); setExecutionRunHint(undefined); resetConversationEvidence();
    setOverlayPanel(null);
    if (syncUrl && workspaceId) {
      const query = new URLSearchParams({ conversationId: groupId, view: 'chat' });
      query.set('conversationSource', 'runtime');
      router.push(`/workspace/${encodeURIComponent(workspaceId)}?${query.toString()}`);
    }
  }, [conversationLoadGenerationRef, groups, resetConversationEvidence, router, selectedGroupId, setSelectedAgentId, setSelectedDirectConversationId, setSelectedGroupId, workspaceId]);

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
    resetConversationEvidence();
    setWorkspaceView('chat');
    setExecutionRunHint(undefined);
    if (workspaceId) router.push(`/workspace/${encodeURIComponent(workspaceId)}?conversationSource=workspace&conversationId=${encodeURIComponent(conversationId)}&view=chat`);
  }, [conversationLoadGenerationRef, resetConversationEvidence, router, setSelectedDirectConversationId, setSelectedGroupId, workspaceId]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', closeOnKeyDown);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', closeOnKeyDown); };
  }, [contextMenu]);

  const openContextMenu = useCallback((conversationId: string, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const conversation = groups.find(item => item.id === conversationId) ?? conversations.find(item => item.id === conversationId);
    if (conversation) setContextMenu({ conversation, clientX: event.clientX, clientY: event.clientY });
  }, [conversations, groups]);

  const copyConversationId = useCallback(async (conversationId: string) => {
    try { await navigator.clipboard.writeText(conversationId); pushToast('success', '会话 ID 已复制'); }
    catch (copyError) { notifyError(copyError, '复制会话 ID 失败'); }
  }, [notifyError, pushToast]);

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
  }, [router, setSelectedAgentId, setSelectedDirectConversationId, setSelectedGroupId, workspaceId]);

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
    messages={visibleMessages} streaming={streamingStore} streamingVisible={evidenceVisible}
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
    onSend={() => { void handleSend(); }} onCancel={() => { handleCancel({ directRunBlocked, evidenceVisible }); }}
    onOpenRuntimeDetails={runId => { void openRunDetails(runId); }} onOpenRuntime={openRuntime}
    onCreateCollaborationTask={() => { setCollaborationPanelCreateMode(true); setShowCollaborationTask(true); }}
    onOpenCollaborationTask={openCollaborationDetails} collaborationProgressState={collaborationProgressState}
    groupInteraction={evidenceVisible && isGroupConversation ? groupInteraction : undefined}
    groupExecutionOwner={evidenceVisible && isGroupConversation ? groupExecutionOwner : undefined}
    groupBudget={evidenceVisible && isGroupConversation ? groupBudget : undefined}
    groupSpeakingAgentName={evidenceVisible && isGroupConversation ? agents.find(agent => agent.id === groupSpeakingAgentId)?.name : undefined}
    groupDiscussionError={evidenceVisible && isGroupConversation ? groupDiscussionError : undefined}
    groupRecoveryWorkspaceId={evidenceVisible && isGroupConversation ? workspaceId ?? undefined : undefined}
    groupRecoveryGeneration={evidenceVisible && isGroupConversation ? activeScopeGenerationRef.current.generation : undefined}
    onGroupInteractionRecovered={handleGroupInteractionRecovered}
    layoutControls={{ workspaceMode: effectiveLayout.workspaceMode, historyAvailable: !selectedGroupId && !isLegacyRuntimeLink,
      historyVisible: effectiveLayout.historyVisible, inspectorVisible: effectiveLayout.inspectorVisible, focusMode: layoutPreferences.focusMode,
      view: activeWorkspaceView, onViewChange: changeWorkspaceView, onToggleWorkspace: () => toggleLayoutPanel('workspace'),
      onToggleHistory: () => toggleLayoutPanel('history'), onToggleInspector: () => toggleLayoutPanel('inspector'), onToggleFocus: toggleFocusMode }} />;
  const renderMainContent = () => activeWorkspaceView === 'execution' ? renderLegacyExecutionPanel() : renderLegacyChatPanel();

  if (!workspaceId) return <div className="app-shell grid h-screen place-items-center text-sm ui-muted">工作区不存在</div>;
  if (!workspace && !error) return <div className="app-shell grid h-screen place-items-center text-sm ui-muted"><span className="flex items-center gap-3"><span aria-hidden="true" className="ui-loading-spinner" />正在加载工作区…</span></div>;

  return <div ref={layoutRef} data-signal-workspace data-workspace-layout data-visible-conversation-identity={activeDraftIdentityKey ?? ''} className="signal-workspace app-shell flex h-screen min-w-0 overflow-hidden">
    {renderAgentPanel(effectiveLayout.workspaceMode === 'compact', effectiveLayout.workspaceMode === 'compact' ? WORKSPACE_LAYOUT_WIDTHS.compactRail : layoutPreferences.workspaceWidth)}
    <PanelResizeHandle panel="workspace" width={effectiveLayout.workspaceWidth} onPointerDown={handleResizePointerDown} onKeyDown={handleResizeKeyDown} />
    {effectiveLayout.historyVisible && !selectedGroupId && <>
      {renderHistoryPanel(layoutPreferences.historyWidth)}
      <PanelResizeHandle panel="history" width={layoutPreferences.historyWidth} onPointerDown={handleResizePointerDown} onKeyDown={handleResizeKeyDown} />
    </>}
    {renderMainContent()}
    {effectiveLayout.inspectorVisible && <>
      <PanelResizeHandle panel="inspector" width={effectiveLayout.inspectorWidth} onPointerDown={handleResizePointerDown} onKeyDown={handleResizeKeyDown} />
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
