'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { AgentEvent, AgentExecution, AgentPresence, AgentProfile, AgentRun, AgentRunDetails, Conversation, ConversationMember, ConversationMessage, ExecutionEvent, ExecutionStatus, GroupDispatchMode, RunIntent, RunStep, RuntimeArtifact, ThinkingEffort, Workspace } from '@agentos/shared';
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
import { canSendMessage, fileToImageDraft, validateImageDrafts, type ImageDraft } from '@/lib/imageAttachments';
import { getComposerSendIntent, preserveDraftAfterSendFailure } from '@/lib/composerInteraction';
import { getInspectorProposedWidth, getResizablePanelWidth } from '@/lib/resizablePanels';
import { DEFAULT_WORKSPACE_LAYOUT, WORKSPACE_LAYOUT_THRESHOLDS, WORKSPACE_LAYOUT_WIDTHS, normalizeWorkspaceLayout, panelCollapseThreshold, panelIsDocked, panelWidthRange, resolveEffectiveWorkspaceLayout, workspaceLayoutStorageKey, type EffectiveWorkspaceLayout, type WorkspaceLayoutPanel, type WorkspaceLayoutPreferences } from '@/lib/workspaceLayout';
import { resolveAttachmentUrl } from '@/lib/attachmentUrls';
import { RunDetails } from '@/components/runs/RunDetails';
import { MemoryPanel } from '@/components/memory/MemoryPanel';
import { MemoryCandidateQueue } from '@/components/memory/MemoryCandidateQueue';
import { MemoryReviewQueue } from '@/components/memory/MemoryReviewQueue';
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

type VisibleExecutionEvent = ExecutionEvent & { agentId?: string; agentName?: string };
type StreamEvent = Pick<VisibleExecutionEvent, 'status' | 'activity' | 'content' | 'agentId' | 'agentName'>;
type ConversationStreamData = StreamEvent & { cursor?: number; runId?: string; run?: AgentRun; message?: ConversationMessage; execution?: AgentExecution; executions?: AgentExecution[]; runtime?: AgentEvent; runStep?: RunStep; eventId?: string; sequence?: number; error?: string };
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
  const workspaceId = typeof params.id === 'string' ? params.id : null;
  const { API_BASE, request } = useApi();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [presence, setPresence] = useState<Record<string, AgentPresence>>({});
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Conversation[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedDirectConversationId, setSelectedDirectConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [executions, setExecutions] = useState<AgentExecution[]>([]);
  const [activeEvents, setActiveEvents] = useState<VisibleExecutionEvent[]>([]);
  const [activeRuntimeEvents, setActiveRuntimeEvents] = useState<AgentEvent[]>([]);
  const [activeRunSteps, setActiveRunSteps] = useState<RunStep[]>([]);
  const [activeArtifacts, setActiveArtifacts] = useState<RuntimeArtifact[]>([]);
  const [activeRuntimeResult, setActiveRuntimeResult] = useState<RuntimeResultProjection | null>(null);
  const [conversationRuns, setConversationRuns] = useState<AgentRun[]>([]);
  const [activeStatus, setActiveStatus] = useState<ExecutionStatus>();
  const [activeStartedAt, setActiveStartedAt] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [activeWaitingQuestion, setActiveWaitingQuestion] = useState<string>();
  const [draft, setDraft] = useState('');
  const [mentionedAgentIds, setMentionedAgentIds] = useState<string[]>([]);
  // Keep the historical execution default for provider compatibility. The
  // generic prompt still answers ordinary questions directly; ask/review are
  // explicit modes and require a provider-backed read-only enforcement proof.
  const [runIntent, setRunIntent] = useState<RunIntent>('execute');
  useEffect(() => {
    const handleRunIntent = (event: Event) => {
      const value = (event as CustomEvent<RunIntent>).detail;
      if (value === 'ask' || value === 'execute' || value === 'review') setRunIntent(value);
    };
    window.addEventListener('agentos:run-intent', handleRunIntent);
    return () => window.removeEventListener('agentos:run-intent', handleRunIntent);
  }, []);
  const [attachments, setAttachments] = useState<ImageDraft[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [composerModel, setComposerModel] = useState<string | undefined>();
  const [composerThinkingEffort, setComposerThinkingEffort] = useState<ThinkingEffort>('auto');
  const [streamingContent, setStreamingContent] = useState('');
  const [sending, setSending] = useState(false);
  const [queuedMessageCount, setQueuedMessageCount] = useState(0);
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
  const [showPreferences, setShowPreferences] = useState(false);
  const [layoutPreferences, setLayoutPreferences] = useState<WorkspaceLayoutPreferences>(DEFAULT_WORKSPACE_LAYOUT);
  const [layoutViewportWidth, setLayoutViewportWidth] = useState(1440);
  const [layoutReady, setLayoutReady] = useState(false);
  const [overlayPanel, setOverlayPanel] = useState<OverlayPanel>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const layoutStorageWorkspaceRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamRunIdRef = useRef<string>();
  const streamCursorRef = useRef(0);
  const userCancelledRef = useRef(false);
  const pendingQueueRef = useRef<string[]>([]);
  const drainingQueueRef = useRef(false);
  const activeResizeRef = useRef<ActivePanelResize | null>(null);
  const runDetailsCacheRef = useRef(new Map<string, Promise<AgentRunDetails>>());
  const toastIdRef = useRef(0);
  const typewriterRef = useRef(new TypewriterQueue());

  const selectedAgent = agents.find(agent => agent.id === selectedAgentId);
  const activeConversationId = getActiveConversationId({ selectedGroupId, selectedDirectConversationId });
  const selectedConversation = selectedGroupId
    ? groups.find(conversation => conversation.id === selectedGroupId)
    : conversations.find(conversation => conversation.id === selectedDirectConversationId);
  const isGroupConversation = selectedConversation?.type === 'group';
  const activeComposerConversation = !isGroupConversation && selectedConversation?.agentId === selectedAgentId ? selectedConversation : undefined;
  const historyConversations = selectedGroupId ? groups : conversations;
  const historyTitle = selectedGroupId ? '群聊' : selectedAgent?.name ?? '会话';
  const composerModelOptions = getModelOptions(selectedAgent);
  const composerThinkingEfforts = getThinkingEfforts(selectedAgent, composerModel ?? selectedAgent?.model);
  const effectiveLayout = useMemo<EffectiveWorkspaceLayout>(() => resolveEffectiveWorkspaceLayout({
    viewportWidth: layoutViewportWidth,
    preferences: layoutPreferences,
    historyAvailable: !selectedGroupId,
  }), [layoutPreferences, layoutViewportWidth, selectedGroupId]);

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
      .catch(error => {
        runDetailsCacheRef.current.delete(cacheKey);
        throw error;
      });
    runDetailsCacheRef.current.set(cacheKey, pending);
    return pending;
  }, [request, workspaceId]);

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
    const settings = getInitialComposerSettings(selectedAgent, activeComposerConversation ? {
      model: activeComposerConversation.model,
      thinkingEffort: activeComposerConversation.thinkingEffort,
    } : undefined);
    setComposerModel(settings.model);
    setComposerThinkingEffort(settings.thinkingEffort);
  }, [activeComposerConversation?.id, activeComposerConversation?.model, activeComposerConversation?.thinkingEffort, selectedAgent]);

  const persistConversationSettings = useCallback(async (conversationId: string, model: string | undefined, thinkingEffort: ThinkingEffort): Promise<Conversation> => {
    if (!workspaceId) throw new Error('Workspace is unavailable');
    const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations/${conversationId}/settings`, {
      method: 'PATCH',
      body: { model: model ?? null, thinkingEffort },
    });
    const update = (current: Conversation[]) => current.map(conversation => conversation.id === result.conversation.id ? result.conversation : conversation);
    setConversations(update);
    setGroups(update);
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
  }, [activeConversationId, composerThinkingEffort, isGroupConversation, notifyError, persistConversationSettings, selectedAgent]);

  const handleComposerThinkingEffortChange = useCallback((thinkingEffort: ThinkingEffort) => {
    setComposerThinkingEffort(thinkingEffort);
    if (activeConversationId && !isGroupConversation) {
      void persistConversationSettings(activeConversationId, composerModel, thinkingEffort).catch(saveError => notifyError(saveError, '保存会话设置失败'));
    }
  }, [activeConversationId, composerModel, isGroupConversation, notifyError, persistConversationSettings]);

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setAttachmentError('');
    setValidationError('');
    const addedDrafts: ImageDraft[] = [];
    try {
      for (const file of files) addedDrafts.push(await fileToImageDraft(file));
      const nextDrafts = [...attachments, ...addedDrafts];
      const validation = validateImageDrafts(nextDrafts);
      if (!validation.ok) {
        for (const draft of addedDrafts) URL.revokeObjectURL(draft.previewUrl);
        setAttachmentError(validation.error);
        return;
      }
      setAttachments(nextDrafts);
    } catch (error) {
      for (const draft of addedDrafts) URL.revokeObjectURL(draft.previewUrl);
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  }, [attachments]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(current => {
      const removed = current.find(attachment => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter(attachment => attachment.id !== id);
    });
    setAttachmentError('');
  }, []);

  const loadConversationDetails = useCallback(async (conversationId: string) => {
    if (!workspaceId) return;
    const [messageResult, executionResult, runResult] = await Promise.all([
      request<{ messages: ConversationMessage[] }>(`/api/workspaces/${workspaceId}/conversations/${conversationId}/messages`),
      request<{ executions: Array<AgentExecution & { events: ExecutionEvent[] }> }>(`/api/workspaces/${workspaceId}/conversations/${conversationId}/executions`),
      request<{ runs: AgentRun[] }>(`/api/workspaces/${workspaceId}/runs?conversationId=${encodeURIComponent(conversationId)}`),
    ]);
    const activeRun = selectActiveRunExecutions(executionResult.executions, runResult.runs);
    const latestRun = runResult.runs[0];
    const latestRunDetails = latestRun ? await loadRunDetails(latestRun.id) : undefined;
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
    setConversationRuns(runResult.runs);
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
    const result = await request<{ conversations: Conversation[] }>(`/api/workspaces/${workspaceId}/conversations?agentId=${encodeURIComponent(agentId)}`);
    setConversations(result.conversations);
    setSelectedDirectConversationId(result.conversations[0]?.id ?? null);
    setMessages([]); setConversationRuns([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined);
  }, [request, workspaceId]);

  const loadGroups = useCallback(async () => {
    if (!workspaceId) return;
    const result = await request<{ conversations: Conversation[] }>(`/api/workspaces/${workspaceId}/conversations`);
    setGroups(result.conversations.filter(conversation => conversation.type === 'group'));
  }, [request, workspaceId]);

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
      void loadGroups();
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
    if (selectedAgentId) void loadConversations(selectedAgentId).catch(loadError => notifyError(loadError, '加载会话失败'));
  }, [loadConversations, notifyError, selectedAgentId]);

  useEffect(() => {
    if (activeConversationId) void loadConversationDetails(activeConversationId).catch(loadError => notifyError(loadError, '加载会话详情失败'));
  }, [activeConversationId, loadConversationDetails, notifyError]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', closeOnKeyDown);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', closeOnKeyDown); };
  }, [contextMenu]);

  const createConversation = useCallback(async (): Promise<Conversation | null> => {
    if (!workspaceId || !selectedAgent) return null;
    const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations`, { method: 'POST', body: { agentId: selectedAgent.id } });
    const conversation = await persistConversationSettings(result.conversation.id, composerModel, composerThinkingEffort);
    setConversations(current => [conversation, ...current.filter(item => item.id !== conversation.id)]);
    setSelectedDirectConversationId(conversation.id);
    setSelectedGroupId(null);
    setMessages([]); setConversationRuns([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined);
    return conversation;
  }, [composerModel, composerThinkingEffort, persistConversationSettings, request, selectedAgent, workspaceId]);

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
    if (!workspaceId) return;
    const requestedConversationId = activeConversationId;
    try {
      const details = await loadRunDetails(runId);
      if (!requestedConversationId || activeConversationId !== requestedConversationId || !projectRuntimeResult(details, { workspaceId, conversationId: requestedConversationId, runId })) return;
      setRunDetails(details);
    } catch (detailsError) {
      notifyError(detailsError, '加载运行详情失败');
    }
  }, [activeConversationId, loadRunDetails, notifyError, workspaceId]);

  const generateMemoryCandidates = useCallback(async (runId: string) => {
    if (!workspaceId) return;
    setGeneratingCandidates(true);
    try {
      const result = await request<{ candidates: unknown[]; outcome: 'created' | 'existing' | 'none'; reason?: 'no_valuable_public_evidence' }>(`/api/workspaces/${workspaceId}/runs/${runId}/memory-candidates/generate`, { method: 'POST' });
      setShowCandidateQueue(result.candidates.length > 0);
      pushToast('success', result.outcome === 'none'
        ? '本次没有可复用的公开证据，未生成记忆候选'
        : result.outcome === 'existing' ? '已复用待审核记忆候选' : '记忆候选已生成，请审核');
    } catch (generateError) { notifyError(generateError, '生成记忆候选失败'); }
    finally { setGeneratingCandidates(false); }
  }, [notifyError, pushToast, request, workspaceId]);

  const handleSend = useCallback(async (contentOverride?: string) => {
    const contentSource = contentOverride ?? draft;
    const queuedSend = contentOverride !== undefined;
    const currentAttachments = queuedSend ? [] : attachments;
    const intent = getComposerSendIntent({ sending, content: contentSource, hasAttachments: currentAttachments.length > 0 });
    if (intent === 'idle') {
      setValidationError(getComposerValidationError(contentSource, currentAttachments.length));
      return;
    }
    if (intent === 'queue' && !contentSource.trim()) {
      setValidationError(getComposerValidationError(contentSource, currentAttachments.length));
      return;
    }
    setValidationError('');
    if (intent === 'queue') {
      pendingQueueRef.current.push(contentSource.trim());
      setQueuedMessageCount(pendingQueueRef.current.length);
      setDraft('');
      pushToast('success', '已加入执行队列（' + pendingQueueRef.current.length + '）');
      return;
    }
    if (!workspaceId || (!selectedAgent && !selectedGroupId) || !canSendMessage(contentSource, currentAttachments)) return;
    setError('');
    setConnectionNotice('');
    const content = contentSource.trim();
    const attachmentPayload = currentAttachments.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl }));
    const optimisticAttachments = currentAttachments.map(attachment => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, url: attachment.previewUrl }));
    let optimisticId: string | undefined;
    let conversation: Conversation | null | undefined = selectedConversation;
    try {
      if (!conversation) conversation = await createConversation();
      if (!conversation) return;
      const conversationId = conversation.id;
      optimisticId = 'local-' + Date.now();
      const optimistic: ConversationMessage = { id: optimisticId, conversationId: conversation.id, workspaceId, senderType: 'user', content, attachments: optimisticAttachments, createdAt: new Date().toISOString() };
      setMessages(current => [...current, optimistic]);
      setSending(true);
      typewriterRef.current.flush();
      setStreamingContent('');
      setActiveEvents([]);
      setActiveRuntimeEvents([]);
      setActiveRunSteps([]);
      setActiveArtifacts([]);
      setActiveRuntimeResult(null);
      setActiveStatus('queued');
      setActiveStartedAt(undefined);
      setActiveWaitingQuestion(undefined);
      if (!queuedSend) setDraft('');
      if (conversation.type === 'group') setMentionedAgentIds([]);

      const controller = new AbortController();
      abortRef.current = controller;
      userCancelledRef.current = false;
      streamCursorRef.current = 0;
      const runtimeOverrides = getRuntimeOverrides(selectedAgent, { model: composerModel, thinkingEffort: composerThinkingEffort });
      const isWaitingResume = conversation.type === 'direct' && activeStatus === 'waiting_user' && Boolean(activeRunId);
      streamRunIdRef.current = isWaitingResume ? activeRunId : undefined;
      const streamPath = isWaitingResume
        ? '/api/workspaces/' + workspaceId + '/conversations/' + conversation.id + '/runs/' + activeRunId + '/resume/stream'
        : '/api/workspaces/' + workspaceId + '/conversations/' + conversation.id + '/messages/stream';
      const body = isWaitingResume
        ? { content, intent: runIntent }
        : conversation.type === 'group'
          ? { content, intent: runIntent, attachments: attachmentPayload, ...(mentionedAgentIds.length ? { mentionedAgentIds } : {}) }
          : { content, intent: runIntent, attachments: attachmentPayload, ...(runtimeOverrides.model ? { model: runtimeOverrides.model } : {}), ...(runtimeOverrides.thinkingEffort ? { thinkingEffort: runtimeOverrides.thinkingEffort } : {}) };

      const handleStreamEvent = async (event: { event: string }, data: ConversationStreamData) => {
        if (event.event === 'run' && typeof data.runId === 'string') {
          streamRunIdRef.current = data.runId;
          setActiveRunId(data.runId);
        } else if (event.event === 'execution') {
          const time = new Date().toISOString();
          setActiveStatus(data.status);
          void loadPresence();
          if (data.status === 'waiting_user' && data.content) setActiveWaitingQuestion(data.content);
          if (data.status !== 'queued') setActiveStartedAt(current => current ?? time);
          setActiveEvents(current => collapseStreamingExecutionEvents([...current, { id: time + '-' + current.length, executionId: 'active', status: data.status, activity: data.activity, ...(data.content ? { content: data.content } : {}), ...(data.agentId ? { agentId: data.agentId } : {}), ...(data.agentName ? { agentName: data.agentName } : {}), createdAt: time }]));
          if (data.status === 'streaming_response' && data.content) typewriterRef.current.enqueue(data.content);
        } else if (event.event === 'runtime' && data.runtime) {
          if (streamRunIdRef.current && data.runtime.runId !== streamRunIdRef.current) return;
          if (!streamRunIdRef.current) streamRunIdRef.current = data.runtime.runId;
          setActiveRuntimeEvents(current => mergeRuntimeEvent(current, data.runtime!, streamRunIdRef.current!));
          const payload = data.runtime.payload as Record<string, unknown>;
          const runtimeLabel = typeof payload.toolName === 'string' ? payload.toolName : data.runtime.type;
          const runtimeSummary = typeof payload.summary === 'string' ? payload.summary : typeof payload.text === 'string' ? payload.text : undefined;
          setActiveEvents(current => current.some(item => item.id === data.runtime!.eventId) ? current : collapseStreamingExecutionEvents([...current, {
            id: data.runtime!.eventId,
            executionId: data.runtime!.executionId ?? 'active',
            status: 'streaming_response',
            activity: runtimeLabel,
            ...(runtimeSummary ? { content: runtimeSummary } : {}),
            runtimeEvent: data.runtime,
            createdAt: data.runtime!.timestamp,
          }]));
        } else if (event.event === 'run.step' && data.runStep) {
          if (streamRunIdRef.current && data.runStep.runId !== streamRunIdRef.current) return;
          setActiveRunSteps(current => upsertRunStep(current, data.runStep!));
        } else if (event.event === 'message' && data.message) {
          typewriterRef.current.flush();
          setStreamingContent('');
          setMessages(current => current.some(message => message.id === data.message?.id) ? current : [...current, data.message!]);
        } else if (event.event === 'done') {
          typewriterRef.current.flush();
          setStreamingContent('');
          const doneExecution = getDoneExecution(data);
          if (doneExecution) {
            if (data.execution) {
              setExecutions(current => current.some(item => item.id === data.execution!.id)
                ? current.map(item => item.id === data.execution!.id ? { ...item, ...data.execution } : item)
                : [...current, data.execution!]);
            } else if (data.executions?.length) {
              setExecutions(data.executions);
            }
            setActiveStatus(doneExecution.status);
            setActiveRunId(doneExecution.runId);
          }
        } else if (event.event === 'error') {
          throw new TerminalStreamError(data.error ?? '执行失败');
        }
      };

      const connectStream = async (path: string, method: 'GET' | 'POST', payload?: unknown) => {
        const response = await fetch(API_BASE + path, {
          method,
          headers: method === 'POST' ? { 'Content-Type': 'application/json', Accept: 'text/event-stream' } : { Accept: 'text/event-stream' },
          ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}),
          signal: controller.signal,
        });
        if (!response.ok) throw new StreamHttpError(response.status);
        const result = await consumeSseResponse(response, (event, data) => handleStreamEvent(event, data as ConversationStreamData));
        streamCursorRef.current = Math.max(streamCursorRef.current, result.lastCursor);
      };

      try {
        await connectStream(streamPath, 'POST', body);
      } catch (streamError) {
        if (!streamRunIdRef.current || !shouldReconnect(streamError, { userCancelled: userCancelledRef.current })) throw streamError;
        try {
          await retryWithExponentialBackoff(
            async attempt => {
              const runId = streamRunIdRef.current;
              if (!runId) throw new TerminalStreamError('无法恢复当前执行连接');
              setConnectionNotice('正在重连（第 ' + (attempt + 1) + '/' + MAX_RECONNECT_ATTEMPTS + ' 次）…');
              await waitForReconnect(getReconnectDelay(attempt), controller.signal);
              await connectStream('/api/workspaces/' + workspaceId + '/conversations/' + conversationId + '/runs/' + runId + '/stream?cursor=' + streamCursorRef.current, 'GET');
            },
            {
              maxRetries: MAX_RECONNECT_ATTEMPTS - 1,
              sleep: async () => {},
              shouldRetry: error => shouldReconnect(error, { userCancelled: userCancelledRef.current }),
            },
          );
          setConnectionNotice('');
          pushToast('success', '连接已恢复');
        } catch (reconnectError) {
          setConnectionNotice('连接断开，自动重连失败；任务可能仍在后台执行');
          throw reconnectError;
        }
      }

      await Promise.all([
        conversation.type === 'group' ? loadGroups() : selectedAgent ? loadConversations(selectedAgent.id) : Promise.resolve(),
        loadConversationDetails(conversation.id),
      ]);
      if (conversation.type === 'group') setSelectedGroupId(conversation.id);
      else setSelectedDirectConversationId(conversation.id);
      setAttachments(current => { for (const attachment of current) URL.revokeObjectURL(attachment.previewUrl); return []; });
      setAttachmentError('');
    } catch (sendError) {
      const hasServerRun = Boolean(streamRunIdRef.current);
      if (optimisticId && !hasServerRun) setMessages(current => current.filter(message => message.id !== optimisticId));
      if (!hasServerRun) setDraft(current => preserveDraftAfterSendFailure(current, content));
      if (sendError instanceof DOMException && sendError.name === 'AbortError') {
        if (!userCancelledRef.current) pushToast('error', '执行已取消');
      } else if (sendError instanceof UnexpectedStreamEndError) {
        setConnectionNotice('连接已断开，自动重连失败');
      } else {
        notifyError(sendError, '执行失败');
      }
    } finally {
      setSending(false);
      abortRef.current = null;
      streamRunIdRef.current = undefined;
    }
  }, [API_BASE, activeRunId, activeStatus, attachments, composerModel, composerThinkingEffort, createConversation, draft, loadConversationDetails, loadConversations, loadGroups, loadPresence, mentionedAgentIds, notifyError, pushToast, selectedAgent, selectedConversation, selectedGroupId, sending, workspaceId]);

  useEffect(() => {
    if (sending || drainingQueueRef.current || pendingQueueRef.current.length === 0) return;
    const nextMessage = pendingQueueRef.current.shift();
    if (!nextMessage) return;
    setQueuedMessageCount(pendingQueueRef.current.length);
    drainingQueueRef.current = true;
    void handleSend(nextMessage).finally(() => { drainingQueueRef.current = false; });
  }, [handleSend, queuedMessageCount, sending]);

  const handleCancel = useCallback(() => {
    userCancelledRef.current = true;
    const runId = streamRunIdRef.current;
    if (workspaceId && selectedConversation && runId) {
      void request('/api/workspaces/' + workspaceId + '/conversations/' + selectedConversation.id + '/runs/' + runId + '/cancel', { method: 'POST' }).catch(() => {});
    }
    abortRef.current?.abort();
    pendingQueueRef.current = [];
    setQueuedMessageCount(0);
  }, [request, selectedConversation, workspaceId]);

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
    if (!workspaceId) return;
    setSavingGroup(true);
    try {
      const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations`, { method: 'POST', body: { type: 'group', ...input } });
      setGroups(current => [result.conversation, ...current]);
      setSelectedGroupId(result.conversation.id); setSelectedAgentId(null);
      setMessages([]); setConversationRuns([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined); setCreatingGroup(false);
    } catch (groupError) { notifyError(groupError, '创建群聊失败'); }
    finally { setSavingGroup(false); }
  }, [notifyError, request, workspaceId]);

  const saveConversationTitle = useCallback(async (title: string) => {
    if (!workspaceId || !renamingConversation) return;
    setSavingConversationTitle(true);
    try {
      const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations/${renamingConversation.id}`, { method: 'PATCH', body: { title } });
      if (result.conversation.type === 'group') setGroups(current => current.map(group => group.id === result.conversation.id ? result.conversation : group));
      else setConversations(current => current.map(conversation => conversation.id === result.conversation.id ? result.conversation : conversation));
      setRenamingConversation(null);
    } catch (renameError) { notifyError(renameError, '重命名会话失败'); }
    finally { setSavingConversationTitle(false); }
  }, [notifyError, request, renamingConversation, workspaceId]);

  const openGroupEditor = useCallback(async (conversation: Conversation) => {
    if (!workspaceId || conversation.type !== 'group') return;
    try {
      const result = await request<{ conversation: Conversation; members: ConversationMember[] }>(`/api/workspaces/${workspaceId}/conversations/${conversation.id}/members`);
      setEditingGroup(result.conversation);
      setEditingGroupMembers(result.members);
    } catch (loadError) { notifyError(loadError, '加载群聊策略失败'); }
  }, [notifyError, request, workspaceId]);

  const saveGroupSettings = useCallback(async (input: { title: string; members: Array<{ agentId: string; roleKind: NonNullable<ConversationMember['roleKind']>; roleTitle: string; sequence: number; model?: string | null; thinkingEffort?: ThinkingEffort | null; additionalInstructions?: string | null }>; dispatchMode: GroupDispatchMode }) => {
    if (!workspaceId || !editingGroup) return;
    setSavingGroupSettings(true);
    try {
      const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations/${editingGroup.id}`, { method: 'PATCH', body: { ...input, expectedSettingsVersion: editingGroup.settingsVersion ?? 1 } });
      setGroups(current => current.map(group => group.id === result.conversation.id ? result.conversation : group));
      setEditingGroup(null);
      pushToast('success', '群聊设置已保存');
    } catch (saveError) { notifyError(saveError, '保存群聊策略失败'); }
    finally { setSavingGroupSettings(false); }
  }, [editingGroup, notifyError, pushToast, request, workspaceId]);

  const deleteConversation = useCallback(async (conversation: Conversation) => {
    if (!workspaceId) return;
    setDeletingConversationId(conversation.id);
    try {
      await request<{ conversationId: string }>(`/api/workspaces/${workspaceId}/conversations/${conversation.id}`, { method: 'DELETE' });
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
  }, [conversations, groups, notifyError, pushToast, request, selectedDirectConversationId, selectedGroupId, workspaceId]);

  const selectGroup = useCallback((groupId: string) => {
    const group = groups.find(item => item.id === groupId);
    if (!group) return;
    if (!shouldResetGroupView({ selectedGroupId, nextGroupId: groupId })) { setSelectedAgentId(null); return; }
    setSelectedGroupId(groupId); setSelectedAgentId(null); setMessages([]); setConversationRuns([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveRunSteps([]); setActiveArtifacts([]); setActiveRuntimeResult(null); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined);
    setOverlayPanel(null);
  }, [groups, selectedGroupId]);

  const closeOverlayPanel = useCallback(() => {
    const panel = overlayPanel;
    setOverlayPanel(null);
    if (panel) window.requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-layout-toggle="${panel}"]`)?.focus());
  }, [overlayPanel]);

  const toggleLayoutPanel = useCallback((panel: WorkspaceLayoutPanel) => {
    if (panel === 'history' && selectedGroupId) return;
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
    const nextLayout = resolveEffectiveWorkspaceLayout({ viewportWidth: layoutViewportWidth, preferences: next, historyAvailable: !selectedGroupId });
    setOverlayPanel(panelIsDocked(nextLayout, panel) ? null : panel);
  }, [effectiveLayout, layoutPreferences, layoutViewportWidth, overlayPanel, selectedGroupId]);

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
    setError('');
    setOverlayPanel(null);
  }, []);

  const renderAgentPanel = (compact: boolean, panelWidth?: number) => <AgentList panelWidth={panelWidth} compact={compact} agents={agents} presence={presence} groups={groups} selectedGroupId={selectedGroupId} selectedAgentId={selectedAgentId} activeStatus={activeStatus} onSelect={selectAgent} onSelectGroup={selectGroup} onCreateGroup={() => setCreatingGroup(true)} onContextMenu={openContextMenu} onBackToWorkspace={() => router.push('/')} onOpenRuntime={() => router.push(`/workspace/${encodeURIComponent(workspaceId ?? '')}/runtime`)} onOpenMemories={() => setShowMemories(true)} onOpenPreferences={() => setShowPreferences(true)} onOpenMemoryReview={() => setShowMemoryReview(true)} />;
  const renderHistoryPanel = (panelWidth?: number) => <ConversationHistory panelWidth={panelWidth} title={historyTitle} conversations={historyConversations} selectedConversationId={activeConversationId} createLabel="新建会话" onCreate={() => { void createConversation().catch(createError => notifyError(createError, '创建会话失败')); }} onSelect={setSelectedDirectConversationId} onContextMenu={openContextMenu} />;
  const renderInspectorPanel = (panelWidth?: number) => <ExecutionInspector panelWidth={panelWidth} agent={isGroupConversation ? undefined : selectedAgent} groupTitle={isGroupConversation ? selectedConversation?.title : undefined} events={activeEvents} runtimeEvents={activeRuntimeEvents} steps={activeRunSteps} executions={executions} runHistory={conversationRuns} activeStatus={activeStatus} activeStartedAt={activeStartedAt} apiBase={API_BASE} workspaceId={workspaceId ?? undefined} activeRunId={activeRunId} onEdit={() => setEditingAgent(true)} onOpenRunDetails={runId => { void openRunDetails(runId); }} onRuntimeApprovalResolved={() => { if (activeConversationId) void loadConversationDetails(activeConversationId).catch(() => undefined); }} />;

  if (!workspaceId) return <div className="app-shell grid h-screen place-items-center text-sm ui-muted">工作区不存在</div>;
  if (!workspace && !error) return <div className="app-shell grid h-screen place-items-center text-sm ui-muted">正在加载工作区…</div>;

  return <div ref={layoutRef} data-signal-workspace data-workspace-layout className="signal-workspace app-shell flex h-screen min-w-0 overflow-hidden">
    {renderAgentPanel(effectiveLayout.workspaceMode === 'compact', effectiveLayout.workspaceMode === 'compact' ? WORKSPACE_LAYOUT_WIDTHS.compactRail : layoutPreferences.workspaceWidth)}
    <PanelResizeHandle panel="workspace" width={effectiveLayout.workspaceWidth} onPointerDown={handleResizePointerDown} onKeyDown={handleResizeKeyDown} />
    {effectiveLayout.historyVisible && !selectedGroupId && <>
      {renderHistoryPanel(layoutPreferences.historyWidth)}
      <PanelResizeHandle panel="history" width={layoutPreferences.historyWidth} onPointerDown={handleResizePointerDown} onKeyDown={handleResizeKeyDown} />
    </>}
    <ChatPanel agentName={selectedAgent?.name} roleTitle={selectedAgent?.roleTitle} conversationTitle={isGroupConversation && selectedConversation ? `群聊 · ${selectedConversation.title}` : undefined} groupName={isGroupConversation ? selectedConversation?.title : undefined} isGroup={isGroupConversation} agents={agents} messages={messages} draft={draft} attachments={attachments} attachmentError={attachmentError} validationError={validationError} streamingContent={streamingContent} activeEvents={activeEvents} activeRuntimeEvents={activeRuntimeEvents} artifacts={activeArtifacts} runtimeResult={activeRuntimeResult ?? undefined} apiBase={API_BASE} activeStatus={activeStatus} waitingQuestion={activeWaitingQuestion} connectionNotice={connectionNotice} error={error} sending={sending} queuedMessageCount={queuedMessageCount} modelOptions={composerModelOptions} composerModel={composerModel} composerThinkingEffort={composerThinkingEffort} composerThinkingEfforts={composerThinkingEfforts} modelSource={selectedAgent?.capability?.modelSource} mentionedAgentIds={mentionedAgentIds} onMentionedAgentIdsChange={setMentionedAgentIds} runIntent={runIntent} onRunIntentChange={setRunIntent} onDraftChange={value => { setDraft(value); if (!getComposerValidationError(value, attachments.length)) setValidationError(''); }} onFiles={files => { void handleFiles(files); }} onRemoveAttachment={removeAttachment} onComposerModelChange={handleComposerModelChange} onComposerThinkingEffortChange={handleComposerThinkingEffortChange} onSend={() => { void handleSend(); }} onCancel={handleCancel} onOpenRuntimeDetails={runId => { void openRunDetails(runId); }} layoutControls={{ workspaceMode: effectiveLayout.workspaceMode, historyAvailable: !selectedGroupId, historyVisible: effectiveLayout.historyVisible, inspectorVisible: effectiveLayout.inspectorVisible, focusMode: layoutPreferences.focusMode, onToggleWorkspace: () => toggleLayoutPanel('workspace'), onToggleHistory: () => toggleLayoutPanel('history'), onToggleInspector: () => toggleLayoutPanel('inspector'), onToggleFocus: toggleFocusMode }} />
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
    {runDetails && <RunDetails details={runDetails} apiBase={API_BASE} onClose={() => setRunDetails(null)} onGenerateCandidates={runId => { void generateMemoryCandidates(runId); }} generatingCandidates={generatingCandidates} />}
    {showMemories && <MemoryPanel workspaceId={workspaceId} onClose={() => setShowMemories(false)} onOpenRun={runId => { setShowMemories(false); void openRunDetails(runId); }} />}
    {showPreferences && <PreferencePanel workspaceId={workspaceId} onClose={() => setShowPreferences(false)} onOpenRun={runId => { setShowPreferences(false); void openRunDetails(runId); }} />}
    {showCandidateQueue && <MemoryCandidateQueue workspaceId={workspaceId} onClose={() => setShowCandidateQueue(false)} onOpenRun={runId => { setShowCandidateQueue(false); void openRunDetails(runId); }} />}
    {showMemoryReview && <MemoryReviewQueue workspaceId={workspaceId} onClose={() => setShowMemoryReview(false)} />}
    <ToastStack toasts={toasts} onDismiss={dismissToast} />
  </div>;
}
