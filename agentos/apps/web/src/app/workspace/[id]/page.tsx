'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { AgentEvent, AgentExecution, AgentProfile, AgentRun, AgentRunDetails, Conversation, ConversationMessage, ExecutionEvent, ExecutionStatus, RuntimeArtifact, ThinkingEffort, Workspace } from '@agentos/shared';
import { AgentList } from '@/components/chat/AgentList';
import { AgentEditor } from '@/components/chat/AgentEditor';
import { GroupCreator } from '@/components/chat/GroupCreator';
import { GroupRenameModal } from '@/components/chat/GroupRenameModal';
import { ConversationContextMenu } from '@/components/chat/ConversationContextMenu';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { ConversationHistory } from '@/components/chat/ConversationHistory';
import { ExecutionInspector } from '@/components/chat/ExecutionInspector';
import { useApi } from '@/lib/useApi';
import { getActiveConversationId, shouldResetGroupView } from '@/lib/conversationSelection';
import { getNextConversationId } from '@/lib/conversationActions';
import { getInitialComposerSettings, getModelOptions, getRuntimeOverrides, getThinkingEfforts, normalizeThinkingEffort } from '@/lib/composerSettings';
import { getDoneExecution } from '@/lib/streamDoneExecution';
import { MAX_RECONNECT_ATTEMPTS, TerminalStreamError, StreamHttpError, UnexpectedStreamEndError, consumeSseResponse, getReconnectDelay, retryWithExponentialBackoff, shouldReconnect } from '@/lib/streamReconnect';
import { canSendMessage, fileToImageDraft, validateImageDrafts, type ImageDraft } from '@/lib/imageAttachments';
import { getComposerSendIntent, preserveDraftAfterSendFailure } from '@/lib/composerInteraction';
import { getResizablePanelWidth } from '@/lib/resizablePanels';
import { resolveAttachmentUrl } from '@/lib/attachmentUrls';
import { RunDetails } from '@/components/runs/RunDetails';
import { MemoryPanel } from '@/components/memory/MemoryPanel';
import { MemoryCandidateQueue } from '@/components/memory/MemoryCandidateQueue';
import { ToastStack } from '@/components/feedback/ToastStack';
import { classifyUiError, getComposerValidationError, TOAST_DURATION_MS, type ToastItem, type ToastTone } from '@/lib/uiFeedback';
import { TypewriterQueue } from '@/lib/typewriterQueue';
import { selectActiveRunExecutions } from '@/lib/runtimeSelection';
import { collapseStreamingExecutionEvents } from '@/lib/executionTimeline';

type VisibleExecutionEvent = ExecutionEvent & { agentId?: string; agentName?: string };
type StreamEvent = Pick<VisibleExecutionEvent, 'status' | 'activity' | 'content' | 'agentId' | 'agentName'>;
type ConversationStreamData = StreamEvent & { cursor?: number; runId?: string; run?: AgentRun; message?: ConversationMessage; execution?: AgentExecution; executions?: AgentExecution[]; runtime?: AgentEvent; error?: string };
type ContextMenuState = { conversation: Conversation; clientX: number; clientY: number };
type ResizePanel = 'workspace' | 'history';
type ActivePanelResize = { panel: ResizePanel; startX: number; startWidth: number; cleanup: () => void };

const PANEL_RESIZE_HANDLE_WIDTH = 8;
const CHAT_MIN_WIDTH = 360;
const PANEL_WIDTH_RANGES: Record<ResizePanel, { min: number; max: number }> = {
  workspace: { min: 180, max: 360 },
  history: { min: 180, max: 420 },
};

function PanelResizeHandle({ panel, width, onPointerDown }: { panel: ResizePanel; width?: number; onPointerDown(panel: ResizePanel, event: ReactPointerEvent<HTMLDivElement>): void }) {
  const range = PANEL_WIDTH_RANGES[panel];
  const label = panel === 'workspace' ? '调整工作区导航栏宽度' : '调整会话历史栏宽度';
  return <div data-panel-resize={panel} role="separator" aria-orientation="vertical" aria-label={label} aria-valuemin={range.min} aria-valuemax={range.max} aria-valuenow={Math.round(width ?? (panel === 'workspace' ? 240 : 256))} className={`panel-resize-handle panel-resize-handle-${panel}`} onPointerDown={event => onPointerDown(panel, event)} />;
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
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Conversation[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedDirectConversationId, setSelectedDirectConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [executions, setExecutions] = useState<AgentExecution[]>([]);
  const [activeEvents, setActiveEvents] = useState<VisibleExecutionEvent[]>([]);
  const [activeRuntimeEvents, setActiveRuntimeEvents] = useState<AgentEvent[]>([]);
  const [activeArtifacts, setActiveArtifacts] = useState<RuntimeArtifact[]>([]);
  const [activeStatus, setActiveStatus] = useState<ExecutionStatus>();
  const [activeStartedAt, setActiveStartedAt] = useState<string>();
  const [activeRunId, setActiveRunId] = useState<string>();
  const [activeWaitingQuestion, setActiveWaitingQuestion] = useState<string>();
  const [draft, setDraft] = useState('');
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
  const [renamingConversation, setRenamingConversation] = useState<Conversation | null>(null);
  const [savingConversationTitle, setSavingConversationTitle] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [runDetails, setRunDetails] = useState<AgentRunDetails | null>(null);
  const [generatingCandidates, setGeneratingCandidates] = useState(false);
  const [showCandidateQueue, setShowCandidateQueue] = useState(false);
  const [showMemories, setShowMemories] = useState(false);
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState<number>();
  const [historyPanelWidth, setHistoryPanelWidth] = useState<number>();
  const layoutRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamRunIdRef = useRef<string>();
  const streamCursorRef = useRef(0);
  const userCancelledRef = useRef(false);
  const pendingQueueRef = useRef<string[]>([]);
  const drainingQueueRef = useRef(false);
  const activeResizeRef = useRef<ActivePanelResize | null>(null);
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

  const getPanelWidth = useCallback((panel: ResizePanel) => {
    const selector = panel === 'workspace' ? '.workspace-sidebar' : '.history-sidebar';
    const width = layoutRef.current?.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width;
    return width && width > 0 ? width : panel === 'workspace' ? 240 : 256;
  }, []);

  const stopResize = useCallback(() => {
    activeResizeRef.current?.cleanup();
    activeResizeRef.current = null;
    document.body.classList.remove('resizing-panels');
  }, []);

  const handleResizePointerDown = useCallback((panel: ResizePanel, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    stopResize();

    const handle = event.currentTarget;
    const activeResize: ActivePanelResize = { panel, startX: event.clientX, startWidth: getPanelWidth(panel), cleanup: () => {} };
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      const layout = layoutRef.current;
      if (!layout) return;
      const layoutWidth = layout.getBoundingClientRect().width;
      const inspectorWidth = layout.querySelector<HTMLElement>('.inspector-sidebar')?.getBoundingClientRect().width ?? 0;
      const nextWidth = getResizablePanelWidth({
        proposed: activeResize.startWidth + moveEvent.clientX - activeResize.startX,
        panelMin: PANEL_WIDTH_RANGES[panel].min,
        panelMax: PANEL_WIDTH_RANGES[panel].max,
        availableWidth: layoutWidth - inspectorWidth,
        otherPanelWidth: getPanelWidth(panel === 'workspace' ? 'history' : 'workspace'),
        handleWidth: PANEL_RESIZE_HANDLE_WIDTH * 2,
        chatMinWidth: CHAT_MIN_WIDTH,
      });
      if (panel === 'workspace') setWorkspacePanelWidth(nextWidth);
      else setHistoryPanelWidth(nextWidth);
    };
    const finish = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      if (activeResizeRef.current === activeResize) activeResizeRef.current = null;
      document.body.classList.remove('resizing-panels');
    };

    activeResize.cleanup = finish;
    activeResizeRef.current = activeResize;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Some browser automation environments do not expose native pointer capture.
    }
    document.body.classList.add('resizing-panels');
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }, [getPanelWidth, stopResize]);

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
    const latestRun = runResult.runs[0];
    const latestRunDetails = latestRun
      ? await request<AgentRunDetails>(`/api/workspaces/${workspaceId}/runs/${latestRun.id}`)
      : undefined;
    const activeRun = selectActiveRunExecutions(executionResult.executions, runResult.runs);
    setMessages(messageResult.messages.map(message => ({
      ...message,
      attachments: message.attachments?.map(attachment => ({
        ...attachment,
        url: resolveAttachmentUrl(API_BASE, attachment.url),
      })),
    })));
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
    setActiveStatus(activeRun.executions[0]?.status);
    setActiveStartedAt(activeRun.executions[0]?.startedAt);
    setActiveRunId(activeRun.runId);
    setActiveWaitingQuestion(runResult.runs[0]?.waitingQuestion);
    setActiveArtifacts(latestRunDetails?.artifacts ?? []);
  }, [API_BASE, agents, request, workspaceId]);

  const loadConversations = useCallback(async (agentId: string) => {
    if (!workspaceId) return;
    const result = await request<{ conversations: Conversation[] }>(`/api/workspaces/${workspaceId}/conversations?agentId=${encodeURIComponent(agentId)}`);
    setConversations(result.conversations);
    setSelectedDirectConversationId(result.conversations[0]?.id ?? null);
    setMessages([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveArtifacts([]); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined);
  }, [request, workspaceId]);

  const loadGroups = useCallback(async () => {
    if (!workspaceId) return;
    const result = await request<{ conversations: Conversation[] }>(`/api/workspaces/${workspaceId}/conversations`);
    setGroups(result.conversations.filter(conversation => conversation.type === 'group'));
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
    }).catch(loadError => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError)); });
    return () => { cancelled = true; };
  }, [loadGroups, request, workspaceId]);

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
    setMessages([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveArtifacts([]); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined);
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
    try {
      const details = await request<AgentRunDetails>(`/api/workspaces/${workspaceId}/runs/${runId}`);
      setRunDetails(details);
    } catch (detailsError) {
      notifyError(detailsError, '加载运行详情失败');
    }
  }, [notifyError, request, workspaceId]);

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
      setActiveArtifacts([]);
      setActiveStatus('queued');
      setActiveStartedAt(undefined);
      setActiveWaitingQuestion(undefined);
      if (!queuedSend) setDraft('');

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
        ? { content }
        : conversation.type === 'group'
          ? { content, attachments: attachmentPayload }
          : { content, attachments: attachmentPayload, ...(runtimeOverrides.model ? { model: runtimeOverrides.model } : {}), ...(runtimeOverrides.thinkingEffort ? { thinkingEffort: runtimeOverrides.thinkingEffort } : {}) };

      const handleStreamEvent = async (event: { event: string }, data: ConversationStreamData) => {
        if (event.event === 'run' && typeof data.runId === 'string') {
          streamRunIdRef.current = data.runId;
          setActiveRunId(data.runId);
        } else if (event.event === 'execution') {
          const time = new Date().toISOString();
          setActiveStatus(data.status);
          if (data.status === 'waiting_user' && data.content) setActiveWaitingQuestion(data.content);
          if (data.status !== 'queued') setActiveStartedAt(current => current ?? time);
          setActiveEvents(current => collapseStreamingExecutionEvents([...current, { id: time + '-' + current.length, executionId: 'active', status: data.status, activity: data.activity, ...(data.content ? { content: data.content } : {}), ...(data.agentId ? { agentId: data.agentId } : {}), ...(data.agentName ? { agentName: data.agentName } : {}), createdAt: time }]));
          if (data.status === 'streaming_response' && data.content) typewriterRef.current.enqueue(data.content);
        } else if (event.event === 'runtime' && data.runtime) {
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
        } else if (event.event === 'message' && data.message) {
          typewriterRef.current.flush();
          setStreamingContent('');
          setMessages(current => current.some(message => message.id === data.message?.id) ? current : [...current, data.message!]);
        } else if (event.event === 'done') {
          typewriterRef.current.flush();
          setStreamingContent('');
          const doneExecution = getDoneExecution(data);
          if (doneExecution) {
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
  }, [API_BASE, activeRunId, activeStatus, attachments, composerModel, composerThinkingEffort, createConversation, draft, loadConversationDetails, loadConversations, loadGroups, notifyError, pushToast, selectedAgent, selectedConversation, selectedGroupId, sending, workspaceId]);

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

  const saveAgent = useCallback(async (update: Pick<AgentProfile, 'roleTitle' | 'systemPrompt' | 'permissions' | 'enabled'> & Partial<Pick<AgentProfile, 'name' | 'model'>> & { thinkingEffort: ThinkingEffort }) => {
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

  const createGroup = useCallback(async (input: { title: string; memberAgentIds: string[]; leaderAgentId: string }) => {
    if (!workspaceId) return;
    setSavingGroup(true);
    try {
      const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations`, { method: 'POST', body: { type: 'group', ...input } });
      setGroups(current => [result.conversation, ...current]);
      setSelectedGroupId(result.conversation.id); setSelectedAgentId(null);
      setMessages([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveArtifacts([]); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined); setCreatingGroup(false);
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

  const deleteConversation = useCallback(async (conversation: Conversation) => {
    if (!workspaceId || !window.confirm(`确定删除会话“${conversation.title}”吗？此操作不可撤销。`)) return;
    try {
      await request<{ conversationId: string }>(`/api/workspaces/${workspaceId}/conversations/${conversation.id}`, { method: 'DELETE' });
      const nextId = conversation.type === 'group' ? getNextConversationId(groups, conversation.id) : getNextConversationId(conversations, conversation.id);
      if (conversation.type === 'group') {
        setGroups(current => current.filter(group => group.id !== conversation.id));
        if (selectedGroupId === conversation.id) { setSelectedGroupId(nextId); setSelectedAgentId(null); setMessages([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveArtifacts([]); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined); }
      } else {
        setConversations(current => current.filter(item => item.id !== conversation.id));
        if (selectedDirectConversationId === conversation.id) { setSelectedDirectConversationId(nextId); setSelectedAgentId(null); setMessages([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveArtifacts([]); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined); }
      }
      setContextMenu(null); pushToast('success', '会话已删除');
    } catch (deleteError) { notifyError(deleteError, '删除会话失败'); }
  }, [conversations, groups, notifyError, pushToast, request, selectedDirectConversationId, selectedGroupId, workspaceId]);

  const selectGroup = useCallback((groupId: string) => {
    const group = groups.find(item => item.id === groupId);
    if (!group) return;
    if (!shouldResetGroupView({ selectedGroupId, nextGroupId: groupId })) { setSelectedAgentId(null); return; }
    setSelectedGroupId(groupId); setSelectedAgentId(null); setMessages([]); setExecutions([]); setActiveEvents([]); setActiveRuntimeEvents([]); setActiveArtifacts([]); setActiveStatus(undefined); setActiveStartedAt(undefined); setActiveRunId(undefined); setActiveWaitingQuestion(undefined);
  }, [groups, selectedGroupId]);

  if (!workspaceId) return <div className="app-shell grid h-screen place-items-center text-sm ui-muted">工作区不存在</div>;
  if (!workspace && !error) return <div className="app-shell grid h-screen place-items-center text-sm ui-muted">正在加载工作区…</div>;

  return <div ref={layoutRef} data-signal-workspace data-workspace-layout className="signal-workspace app-shell flex h-screen min-w-0 overflow-hidden">
    <AgentList panelWidth={workspacePanelWidth} agents={agents} groups={groups} selectedGroupId={selectedGroupId} selectedAgentId={selectedAgentId} activeStatus={activeStatus} onSelect={agentId => { setSelectedAgentId(agentId); setSelectedGroupId(null); setSelectedDirectConversationId(null); setError(''); }} onSelectGroup={selectGroup} onCreateGroup={() => setCreatingGroup(true)} onContextMenu={openContextMenu} onBackToWorkspace={() => router.push('/')} onOpenMemories={() => setShowMemories(true)} />
    <PanelResizeHandle panel="workspace" width={workspacePanelWidth} onPointerDown={handleResizePointerDown} />
    <ConversationHistory panelWidth={historyPanelWidth} title={historyTitle} conversations={historyConversations} selectedConversationId={activeConversationId} createLabel={selectedGroupId ? '新建群聊' : '新建会话'} onCreate={() => { if (selectedGroupId) setCreatingGroup(true); else void createConversation().catch(createError => notifyError(createError, '创建会话失败')); }} onSelect={selectedGroupId ? selectGroup : setSelectedDirectConversationId} onContextMenu={openContextMenu} />
    <PanelResizeHandle panel="history" width={historyPanelWidth} onPointerDown={handleResizePointerDown} />
    <ChatPanel agentName={selectedAgent?.name} roleTitle={selectedAgent?.roleTitle} conversationTitle={isGroupConversation && selectedConversation ? `群聊 · ${selectedConversation.title}` : undefined} groupName={isGroupConversation ? selectedConversation?.title : undefined} isGroup={isGroupConversation} agents={agents} messages={messages} draft={draft} attachments={attachments} attachmentError={attachmentError} validationError={validationError} streamingContent={streamingContent} activeEvents={activeEvents} activeRuntimeEvents={activeRuntimeEvents} artifacts={activeArtifacts} apiBase={API_BASE} activeStatus={activeStatus} waitingQuestion={activeWaitingQuestion} connectionNotice={connectionNotice} error={error} sending={sending} queuedMessageCount={queuedMessageCount} modelOptions={composerModelOptions} composerModel={composerModel} composerThinkingEffort={composerThinkingEffort} composerThinkingEfforts={composerThinkingEfforts} modelSource={selectedAgent?.capability?.modelSource} onDraftChange={value => { setDraft(value); if (!getComposerValidationError(value, attachments.length)) setValidationError(''); }} onFiles={files => { void handleFiles(files); }} onRemoveAttachment={removeAttachment} onComposerModelChange={handleComposerModelChange} onComposerThinkingEffortChange={handleComposerThinkingEffortChange} onSend={() => { void handleSend(); }} onCancel={handleCancel} onRename={isGroupConversation ? () => { if (selectedConversation) setRenamingConversation(selectedConversation); } : undefined} />
    <ExecutionInspector agent={isGroupConversation ? undefined : selectedAgent} groupTitle={isGroupConversation ? selectedConversation?.title : undefined} events={activeEvents} executions={executions} activeStatus={activeStatus} activeStartedAt={activeStartedAt} onEdit={() => setEditingAgent(true)} onOpenRunDetails={runId => { void openRunDetails(runId); }} />
    {editingAgent && selectedAgent && <AgentEditor key={`${selectedAgent.id}-${selectedAgent.capability?.modelSource}-${selectedAgent.capability?.models.join('|')}`} agent={selectedAgent} saving={savingAgent} refreshingModels={savingAgent} onClose={() => setEditingAgent(false)} onRefreshModels={() => { void refreshAgentModels(); }} onSave={update => { void saveAgent(update); }} />}
    {creatingGroup && <GroupCreator agents={agents} saving={savingGroup} onClose={() => setCreatingGroup(false)} onCreate={input => { void createGroup(input); }} />}
    {renamingConversation && <GroupRenameModal title={renamingConversation.title} entityLabel={renamingConversation.type === 'group' ? '群聊' : '会话'} saving={savingConversationTitle} onClose={() => setRenamingConversation(null)} onSave={title => { void saveConversationTitle(title); }} />}
    {contextMenu && <ConversationContextMenu conversation={contextMenu.conversation} clientX={contextMenu.clientX} clientY={contextMenu.clientY} onRename={() => setRenamingConversation(contextMenu.conversation)} onCopyId={() => { void copyConversationId(contextMenu.conversation.id); }} onDelete={() => { void deleteConversation(contextMenu.conversation); }} onClose={() => setContextMenu(null)} />}
    {runDetails && <RunDetails details={runDetails} apiBase={API_BASE} onClose={() => setRunDetails(null)} onGenerateCandidates={runId => { void generateMemoryCandidates(runId); }} generatingCandidates={generatingCandidates} />}
    {showMemories && <MemoryPanel workspaceId={workspaceId} onClose={() => setShowMemories(false)} onOpenRun={runId => { setShowMemories(false); void openRunDetails(runId); }} />}
    {showCandidateQueue && <MemoryCandidateQueue workspaceId={workspaceId} onClose={() => setShowCandidateQueue(false)} onOpenRun={runId => { setShowCandidateQueue(false); void openRunDetails(runId); }} />}
    <ToastStack toasts={toasts} onDismiss={dismissToast} />
  </div>;
}
