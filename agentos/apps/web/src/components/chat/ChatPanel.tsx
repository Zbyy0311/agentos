import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AgentEvent, AgentModelOption, AgentProfile, ConversationAttachment, ConversationMessage, ExecutionEvent, ExecutionStatus, ModelDiscoverySource, RunIntent, RuntimeArtifact, ThinkingEffort } from '@agentos/shared';
import { canSendMessage, isImageClipboardItem, type ImageDraft } from '@/lib/imageAttachments';
import type { StreamingTextStore } from '@/lib/streamingTextStore';
import { getChatVisibleArtifacts } from '@/lib/artifacts';
import { getChatTarget } from '@/lib/conversationSelection';
import { getSendButtonState } from '@/lib/uiFeedback';
import { isNearBottom } from '@/lib/chatScroll';
import { handleComposerKeyDown } from '@/lib/composerKeyboard';
import { ComposerControls } from './ComposerControls';
import { ImageAttachments } from './ImageAttachments';
import { ImagePreviewModal, type ImagePreviewItem } from './ImagePreviewModal';
import { ArtifactShelf } from '@/components/runs/ArtifactShelf';
import { RuntimeResultProjection } from './RuntimeResultProjection';
import type { RuntimeResultProjection as RuntimeResultProjectionData } from '@/lib/runtimeProjection';
import { MarkdownMessage } from './MarkdownMessage';
import { VirtualMessageList } from './VirtualMessageList';
import { MentionPicker } from './MentionPicker';
import { useLiquidGlass } from '@/components/glass/useLiquidGlass';
import { CollaborationTaskProgressCard } from './CollaborationTaskProgressCard';
import type { CollaborationProgressState } from '@/lib/useCollaborationProgress';
import { groupInteractionRecoveryReason, type GroupBudgetStatus, type GroupInteraction, type GroupInteractionDetail, type GroupInteractionRecoveryResult } from '@/lib/groupConversationClient';
import { GroupInteractionRecoveryPanel, type GroupRecoveryDispatchState, type GroupRecoveryIdentity } from './GroupInteractionRecoveryPanel';

type VisibleExecutionEvent = ExecutionEvent & { agentId?: string; agentName?: string; runtimeEvent?: AgentEvent };

export interface ChatLayoutControls {
  workspaceMode: 'full' | 'compact';
  historyAvailable: boolean;
  historyVisible: boolean;
  inspectorVisible: boolean;
  focusMode: boolean;
  view?: 'chat' | 'execution';
  onViewChange?(view: 'chat' | 'execution'): void;
  onToggleWorkspace(): void;
  onToggleHistory(): void;
  onToggleInspector(): void;
  onToggleFocus(): void;
}

interface ChatPanelProps {
  agentName?: string;
  roleTitle?: string;
  conversationTitle?: string;
  groupName?: string;
  isGroup?: boolean;
  agents: AgentProfile[];
  messages: ConversationMessage[];
  draft: string;
  attachments: ImageDraft[];
  attachmentError: string;
  /**
   * Subscription handle for the typewriter-streamed assistant text. The text
   * lives in this store (owned by the workspace page's stream pipeline), not
   * in page React state, so streaming ticks re-render only this panel.
   */
  streaming?: StreamingTextStore | null;
  /** Evidence gate: when false the subscribed streaming text is not shown. */
  streamingVisible?: boolean;
  activeEvents: VisibleExecutionEvent[];
  activeRuntimeEvents?: AgentEvent[];
  artifacts?: RuntimeArtifact[];
  runtimeResult?: RuntimeResultProjectionData;
  apiBase?: string;
  activeStatus?: ExecutionStatus;
  waitingQuestion?: string;
  connectionNotice?: string;
  validationError?: string;
  error: string;
  sending: boolean;
  queuedMessageCount: number;
  modelOptions: AgentModelOption[];
  composerModel?: string;
  composerThinkingEffort: ThinkingEffort;
  composerThinkingEfforts: ThinkingEffort[];
  modelSource?: ModelDiscoverySource;
  onDraftChange(value: string): void;
  onFiles(files: File[]): void;
  onRemoveAttachment(id: string): void;
  onComposerModelChange(value: string | undefined): void;
  onComposerThinkingEffortChange(value: ThinkingEffort): void;
  runIntent?: RunIntent;
  onRunIntentChange?(value: RunIntent): void;
  onSend(): void;
  onCancel(): void;
  onResumeQueue?(): void;
  onOpenRuntimeDetails?(runId: string): void;
  onOpenRuntime?(runId?: string): void;
  onCreateCollaborationTask?(): void;
  onOpenCollaborationTask?(): void;
  collaborationProgressState?: CollaborationProgressState;
  groupInteraction?: GroupInteraction | null;
  groupExecutionOwner?: GroupInteractionDetail['executionOwner'];
  groupBudget?: GroupBudgetStatus | null;
  groupSpeakingAgentName?: string;
  groupDiscussionError?: string;
  groupRecoveryWorkspaceId?: string;
  groupRecoveryGeneration?: number;
  onGroupInteractionRecovered?: (result: GroupInteractionRecoveryResult, dispatch: GroupRecoveryDispatchState, identity: GroupRecoveryIdentity) => void | Promise<void>;
  mentionedAgentIds?: string[];
  onMentionedAgentIdsChange?(agentIds: string[]): void;
  draftReady?: boolean;
  draftPersistenceWarning?: string;
  scrollIdentityKey?: string;
  savedScrollPosition?: number;
  onScrollPositionChange?(scrollPosition: number): void;
  layoutControls?: ChatLayoutControls;
}

const statusLabels: Partial<Record<ExecutionStatus, string>> = {
  queued: '正在排队',
  preparing_context: '正在准备会话上下文',
  running_cli: '正在调用 Agent CLI',
  streaming_response: '正在生成回复',
  waiting_user: '等待你的补充信息',
};

function MessageContent({ content }: { content: string }) {
  return <MarkdownMessage content={content} />;
}

function MessageAttachments({ attachments }: { attachments?: ConversationAttachment[] }) {
  if (!attachments?.length) return null;
  return <MessageAttachmentGallery attachments={attachments} />;
}

function MessageAttachmentGallery({ attachments }: { attachments: ConversationAttachment[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const previewItems: ImagePreviewItem[] = attachments.map(attachment => ({ id: attachment.id, name: attachment.name, url: attachment.url }));
  return <>
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map(attachment => <button key={attachment.id} type="button" aria-label={`放大 ${attachment.name}`} title={attachment.name} onClick={() => setSelectedId(attachment.id)} className="group h-28 w-28 overflow-hidden rounded-xl border ui-border cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]">
        <img src={attachment.url} alt={attachment.name} className="h-full w-full object-cover transition duration-200 group-hover:scale-105" />
      </button>)}
    </div>
    <ImagePreviewModal items={previewItems} selectedId={selectedId} onClose={() => setSelectedId(null)} onSelect={setSelectedId} />
  </>;
}

function MessageSurface({ content, attachments, senderName, senderRoleTitle, senderType, streaming = false }: {
  content: string;
  attachments?: ConversationAttachment[];
  senderName?: string;
  senderRoleTitle?: string;
  senderType?: ConversationMessage['senderType'];
  streaming?: boolean;
}) {
  const userMessage = senderType === 'user';
  const systemMessage = senderType === 'system';
  const surfaceClass = userMessage
    ? 'signal-message-user ui-message-user order-2'
    : systemMessage
      ? 'signal-message-system ui-message-system'
      : 'signal-message-agent ui-message-agent';

  return <div className={`signal-message ${surfaceClass} rounded-2xl border px-4 py-3 text-sm leading-6`}>
    {senderName && <div className="message-sender mb-2 border-b ui-border pb-2 text-xs font-medium ui-accent">{senderName}{senderRoleTitle && <span className="ml-1 font-normal ui-muted">· {senderRoleTitle}</span>}</div>}
    <MessageContent content={content} />
    {attachments && <MessageAttachments attachments={attachments} />}
    {streaming && <span aria-hidden="true" className="ml-1 inline-block h-4 w-1 animate-pulse bg-[var(--app-accent)] align-[-2px]" />}
  </div>;
}

const MessageRow = memo(function MessageRow({ message, senderName, senderRoleTitle }: {
  message: ConversationMessage;
  senderName?: string;
  senderRoleTitle?: string;
}) {
  const userMessage = message.senderType === 'user';
  return <div className={`signal-message-row flex min-w-0 gap-3 ${userMessage ? 'justify-end' : 'justify-start'}`}><MessageSurface content={message.content} attachments={message.attachments} senderName={senderName} senderRoleTitle={senderRoleTitle} senderType={message.senderType} /></div>;
});

const executionLabels: Partial<Record<ExecutionStatus, string>> = {
  queued: '已进入队列',
  preparing_context: '准备上下文',
  running_cli: '调用 Agent CLI',
  streaming_response: '生成回复',
  waiting_user: '等待用户补充',
  completed: '执行完成',
  failed: '执行失败',
  cancelled: '执行已取消',
};

function formatExecutionTime(createdAt: string) {
  return new Date(createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const COMPOSER_MIN_HEIGHT = 48;
const COMPOSER_MAX_HEIGHT = 320;
const COMPOSER_HEIGHT_STEP = 16;

function clampComposerHeight(height: number): number {
  return Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, height));
}

function hasChangingChatGeometry(element: HTMLElement): boolean {
  return element.getAnimations().some(animation => (
    (animation.playState === 'running' || animation.pending)
    && animation.effect instanceof KeyframeEffect
    && animation.effect.getKeyframes().some(frame => (
      ['height', 'minHeight', 'maxHeight', 'width', 'padding', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom', 'top', 'bottom', 'transform', 'translate', 'scale']
        .some(property => property in frame)
    ))
  ));
}

function RuntimeTimeline({ events }: { events: AgentEvent[] }) {
  const visibleEvents = mergeToolEvents(events);
  if (!visibleEvents.length) return null;
  return <div className="mt-3 space-y-1.5 border-l ui-border pl-3" aria-label="Tool timeline">
    {visibleEvents.map(event => {
      const payload = event.payload as Record<string, unknown>;
      const label = typeof payload.toolName === 'string' ? payload.toolName : event.type.replace('execution.', '');
      const summary = typeof payload.summary === 'string' ? payload.summary : typeof payload.text === 'string' ? payload.text : '';
      return <div key={event.eventId} className="rounded-lg border ui-border px-2.5 py-2 text-xs">
        <div className="flex items-center gap-2 ui-text-soft"><span aria-hidden="true">{event.type === 'execution.tool.started' ? '⚙' : event.type === 'execution.tool.completed' ? '✓' : '·'}</span><span className="font-medium">{label}</span><span className="ml-auto ui-dim">{event.type.replace('execution.', '')}</span></div>
        {summary && <div className="mt-1 line-clamp-2 ui-muted">{summary}</div>}
      </div>;
    })}
  </div>;
}

function mergeToolEvents(events: AgentEvent[]): AgentEvent[] {
  const merged: AgentEvent[] = [];
  const byCallId = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'execution.tool.started' && event.type !== 'execution.tool.completed') {
      merged.push(event);
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    const callId = typeof payload.callId === 'string' ? payload.callId : undefined;
    if (!callId) { merged.push(event); continue; }
    const index = byCallId.get(callId);
    if (index !== undefined) {
      merged[index] = { ...event, payload: { ...merged[index].payload, ...event.payload } };
    } else {
      byCallId.set(callId, merged.length);
      merged.push(event);
    }
  }
  return merged;
}

function ThinkingProcess({ events, runtimeEvents = [], sending, interrupted = false }: { events: VisibleExecutionEvent[]; runtimeEvents?: AgentEvent[]; sending: boolean; interrupted?: boolean }) {
  const [expanded, setExpanded] = useState(sending);
  useEffect(() => setExpanded(sending), [sending]);
  const projectedRuntimeEvents = runtimeEvents.length > 0 ? runtimeEvents : events.flatMap(event => event.runtimeEvent ? [event.runtimeEvent] : []);
  if (!events.length && !projectedRuntimeEvents.length && !sending) return null;
  const latest = events.at(-1);
  const label = latest ? executionLabels[latest.status] ?? latest.activity : '正在准备执行过程';
  const latestLabel = interrupted ? '历史执行记录（讨论已中断）' : latest?.agentName ? `${latest.agentName} · ${label}` : label;
  return (
    <div className="thinking-process">
    <button type="button" className="thinking-process-header w-full text-left" aria-expanded={expanded} aria-controls="thinking-process-body" onClick={() => setExpanded(current => !current)}>
      <span className="flex min-w-0 items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${latest?.status === 'failed' ? 'bg-[var(--app-danger)]' : latest?.status === 'completed' ? 'bg-[var(--app-success)]' : 'bg-[var(--app-accent)]'}`} />
        <span className="truncate text-xs font-medium ui-text">思考进度</span>
        <span className="truncate text-xs ui-muted">{latestLabel}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[11px] ui-dim">
        <span>{events.length ? `${events.length} 个步骤` : interrupted ? '历史事件' : '进行中'}</span>
        <span>· {expanded ? '收起' : '展开'}</span>
        <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
      </span>
    </button>
    {expanded && <div id="thinking-process-body" className="thinking-process-body space-y-2">
      {events.map(event => (
        <div key={event.id} className="flex gap-2.5">
          <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${event.status === 'failed' ? 'bg-[var(--app-danger)]' : event.status === 'completed' ? 'bg-[var(--app-success)]' : 'bg-[var(--app-accent)]'}`} />
          <div className="min-w-0">
            <div className="text-xs leading-5 ui-text-soft">{event.agentName ? <span className="font-medium ui-accent">{event.agentName} · </span> : null}{event.activity}</div>
            <div className="text-[10px] ui-dim">{executionLabels[event.status] ?? event.status} · {formatExecutionTime(event.createdAt)}</div>
            {event.content && event.status !== 'streaming_response' ? <div className="mt-0.5 line-clamp-2 text-[11px] leading-5 ui-muted">{event.content}</div> : null}
          </div>
        </div>
      ))}
      {!events.length && <div className="text-xs ui-muted">{interrupted ? '保留的历史执行事件' : '正在等待 Agent 返回第一个执行阶段...'}</div>}
      <RuntimeTimeline events={projectedRuntimeEvents} />
    </div>}
    </div>
  );
}

export function ChatPanel({ agentName, roleTitle, conversationTitle, groupName, isGroup = false, agents, messages, draft, attachments, attachmentError, streaming, streamingVisible = true, activeEvents, activeRuntimeEvents = [], artifacts = [], runtimeResult, apiBase = '', activeStatus, waitingQuestion, connectionNotice, validationError, error, sending, queuedMessageCount, modelOptions, composerModel, composerThinkingEffort, composerThinkingEfforts, modelSource, onDraftChange, onFiles, onRemoveAttachment, onComposerModelChange, onComposerThinkingEffortChange, onSend, onCancel, onResumeQueue, onOpenRuntimeDetails, onOpenRuntime, onCreateCollaborationTask, onOpenCollaborationTask, collaborationProgressState, groupInteraction, groupExecutionOwner, groupBudget, groupSpeakingAgentName, groupDiscussionError, groupRecoveryWorkspaceId, groupRecoveryGeneration, onGroupInteractionRecovered, mentionedAgentIds = [], onMentionedAgentIdsChange, draftReady = true, draftPersistenceWarning, scrollIdentityKey, savedScrollPosition = 0, onScrollPositionChange, runIntent = 'execute', onRunIntentChange = value => window.dispatchEvent(new CustomEvent('agentos:run-intent', { detail: value })), layoutControls }: ChatPanelProps) {
  // The streamed assistant text is owned by the page-level StreamingTextStore
  // and mirrored into local state so streaming ticks re-render only ChatPanel.
  const [streamedContent, setStreamedContent] = useState(() => streaming?.getSnapshot() ?? '');
  useEffect(() => {
    if (!streaming) {
      setStreamedContent('');
      return undefined;
    }
    return streaming.subscribe(setStreamedContent);
  }, [streaming]);
  const streamingContent = streamingVisible ? streamedContent : '';
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const composerResizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const composerResizingRef = useRef(false);
  const composerResizeFrameRef = useRef<number | null>(null);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);
  const headerGlassRef = useLiquidGlass<HTMLElement>('chat-header');
  const composerGlassRef = useLiquidGlass<HTMLDivElement>('composer');
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null);
  const [chromeEl, setChromeEl] = useState<HTMLDivElement | null>(null);
  const [chromeTop, setChromeTop] = useState(76);
  const [chromeBottom, setChromeBottom] = useState(0);
  const bindHeaderRef = useCallback((node: HTMLElement | null) => { headerGlassRef(node); setHeaderEl(node); }, [headerGlassRef]);
  const bindChromeRef = useCallback((node: HTMLDivElement | null) => setChromeEl(node), []);

  useEffect(() => {
    if (!headerEl) return undefined;
    const measure = () => { const host = headerEl.closest('[data-signal-chat]'); const hostTop = host?.getBoundingClientRect().top ?? 0; setChromeTop(headerEl.getBoundingClientRect().bottom - hostTop); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(headerEl);
    return () => observer.disconnect();
  }, [headerEl]);

  useEffect(() => {
    if (!chromeEl) return undefined;
    const measure = () => { const host = chromeEl.closest('[data-signal-chat]'); const hostBottom = host?.getBoundingClientRect().bottom ?? 0; setChromeBottom(hostBottom - chromeEl.getBoundingClientRect().top); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(chromeEl);
    return () => observer.disconnect();
  }, [chromeEl]);
  const wasNearBottomRef = useRef(true);
  const restoredScrollIdentityRef = useRef<string>();
  const [restoredScrollIdentity, setRestoredScrollIdentity] = useState<string>();
  const readerNavigationRef = useRef({ identity: scrollIdentityKey, navigated: false });
  const scrollSaveTimerRef = useRef<number | null>(null);
  const pendingScrollSaveRef = useRef<{ identity: string | undefined; position: number; save(position: number): void } | null>(null);
  useEffect(() => {
    return () => {
      if (composerResizeFrameRef.current !== null) window.cancelAnimationFrame(composerResizeFrameRef.current);
    };
  }, []);

  useEffect(() => {
    restoredScrollIdentityRef.current = undefined;
    setRestoredScrollIdentity(undefined);
    readerNavigationRef.current = { identity: scrollIdentityKey, navigated: false };
    wasNearBottomRef.current = !scrollIdentityKey;
  }, [scrollIdentityKey]);

  useEffect(() => {
    if (composerResizingRef.current) return;
    if (scrollIdentityKey && restoredScrollIdentityRef.current !== scrollIdentityKey) return;
    if (!wasNearBottomRef.current) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, streamingContent, activeEvents, activeRuntimeEvents, scrollIdentityKey]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scrollIdentityKey || !draftReady || !scroll || !headerEl || !chromeEl || restoredScrollIdentityRef.current === scrollIdentityKey) return;
    // A saved position cannot be restored into the temporary empty message
    // surface. Wait for this identity's content, and never persist its clamped
    // zero or reapply an old position on subsequent streaming updates.
    if (savedScrollPosition > 0 && messages.length === 0) return;
    // The first render has only estimated chrome padding. Setting scrollTop
    // there clamps a saved bottom position and would overwrite this identity's
    // draft. Wait for the actual header/Composer safe area and a stable layout.
    let frame = 0;
    let previousLayout = '';
    let stableFrames = 0;
    const restore = () => {
      const host = scroll.closest('[data-signal-chat]');
      if (!host || scrollRef.current !== scroll || !scroll.isConnected) return;
      const hostRect = host.getBoundingClientRect();
      const padding = window.getComputedStyle(scroll);
      const top = headerEl.getBoundingClientRect().bottom - hostRect.top + 28;
      const bottom = hostRect.bottom - chromeEl.getBoundingClientRect().top + 28;
      // Consecutive frames can temporarily have the same geometry at an
      // animation's start. Wait for size/position animations, not decorative
      // opacity or color effects, before advertising restoration as ready.
      const measured = !hasChangingChatGeometry(headerEl) && !hasChangingChatGeometry(chromeEl)
        && Math.abs(parseFloat(padding.paddingTop) - top) < 1
        && Math.abs(parseFloat(padding.paddingBottom) - bottom) < 1;
      const layout = `${top}:${bottom}:${scroll.scrollHeight}:${scroll.clientHeight}`;
      stableFrames = measured && layout === previousLayout ? stableFrames + 1 : 0;
      previousLayout = layout;
      if (stableFrames < 2) { frame = window.requestAnimationFrame(restore); return; }
      // A wheel/touch/key gesture during measurement takes precedence over the
      // old saved position. Do not drag a reader back after they navigate.
      const readerNavigated = readerNavigationRef.current.identity === scrollIdentityKey && readerNavigationRef.current.navigated;
      if (!readerNavigated) scroll.scrollTop = Math.max(0, savedScrollPosition);
      wasNearBottomRef.current = isNearBottom(scroll);
      restoredScrollIdentityRef.current = scrollIdentityKey;
      setRestoredScrollIdentity(scrollIdentityKey);
      if (readerNavigated) onScrollPositionChange?.(scroll.scrollTop);
    };
    frame = window.requestAnimationFrame(restore);
    return () => window.cancelAnimationFrame(frame);
  }, [draftReady, messages.length, savedScrollPosition, scrollIdentityKey, headerEl, chromeEl, chromeTop, chromeBottom, onScrollPositionChange]);

  useEffect(() => () => {
    if (scrollSaveTimerRef.current !== null) window.clearTimeout(scrollSaveTimerRef.current);
    const pending = pendingScrollSaveRef.current;
    if (pending && pending.identity === scrollIdentityKey) {
      pendingScrollSaveRef.current = null;
      pending.save(pending.position);
    }
  }, [scrollIdentityKey]);

  const startComposerResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    composerResizingRef.current = true;
    composerResizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: composerHeight };
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveComposerResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = composerResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const clientY = event.clientY;
    if (composerResizeFrameRef.current !== null) window.cancelAnimationFrame(composerResizeFrameRef.current);
    composerResizeFrameRef.current = window.requestAnimationFrame(() => {
      composerResizeFrameRef.current = null;
      setComposerHeight(clampComposerHeight(resize.startHeight + resize.startY - clientY));
    });
  };

  const finishComposerResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (composerResizeRef.current?.pointerId !== event.pointerId) return;
    const resize = composerResizeRef.current;
    if (composerResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(composerResizeFrameRef.current);
      composerResizeFrameRef.current = null;
    }
    setComposerHeight(clampComposerHeight(resize.startHeight + resize.startY - event.clientY));
    composerResizeRef.current = null;
    composerResizingRef.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleComposerResizeKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const adjustment = event.key === 'ArrowUp'
      ? COMPOSER_HEIGHT_STEP
      : event.key === 'ArrowDown'
        ? -COMPOSER_HEIGHT_STEP
        : event.key === 'Home'
          ? COMPOSER_MIN_HEIGHT - composerHeight
          : event.key === 'End'
            ? COMPOSER_MAX_HEIGHT - composerHeight
            : undefined;
    if (adjustment === undefined) return;
    event.preventDefault();
    setComposerHeight(current => clampComposerHeight(current + adjustment));
  };

  const target = getChatTarget({ groupTitle: isGroup ? groupName : undefined, agentName });
  const chatArtifacts = getChatVisibleArtifacts(artifacts);
  const title = conversationTitle ?? (agentName ? `${agentName} · ${roleTitle ?? 'Agent'}` : '选择一个 Agent 开始对话');
  const recoveryReason = isGroup ? groupInteractionRecoveryReason(groupInteraction) : undefined;
  const groupReadOnly = recoveryReason !== undefined;
  const groupRecoveryAvailable = groupInteraction?.status === 'active'
    && groupInteraction.integrityStatus === 'unusable'
    && groupExecutionOwner?.status === 'interrupted'
    && Number.isSafeInteger(groupExecutionOwner.ownerEpoch) && groupExecutionOwner.ownerEpoch > 0
    && Boolean(groupRecoveryWorkspaceId && scrollIdentityKey && onGroupInteractionRecovered);
  const groupRecoveryBlockedReason = isGroup && groupInteraction?.status === 'active' && groupInteraction.integrityStatus === 'unusable'
    ? !groupExecutionOwner
      ? '恢复入口未开放：执行 owner 状态未知，无法确认旧 Provider 已停止。为避免重复调用，保留历史供查看。'
      : groupExecutionOwner.status !== 'interrupted'
        ? `恢复入口未开放：执行 owner 状态为“${groupExecutionOwner.status}”，尚未确认中断。`
        : groupExecutionOwner.ownerEpoch <= 0
          ? '恢复入口未开放：中断 owner 缺少有效 epoch，无法安全执行版本比较。'
          : undefined
    : undefined;
  const effectiveSending = sending && !groupReadOnly;
  const status = !groupReadOnly && activeStatus ? statusLabels[activeStatus] : undefined;
  const baseSendButtonState = getSendButtonState({ canSend: canSendMessage(draft, attachments), sending: effectiveSending });
  const sendButtonState = { ...baseSendButtonState, disabled: baseSendButtonState.disabled || !draftReady || groupReadOnly };
  const groupStatusLabel = groupReadOnly ? '讨论已中断 · 等待处理' : groupInteraction?.status === 'active'
    ? groupSpeakingAgentName ? `正在发言：${groupSpeakingAgentName}` : '正在准备下一位 Agent'
    : groupInteraction?.status === 'completed' ? '讨论已完成'
      : groupInteraction?.status === 'exhausted' ? '讨论已达到预算上限'
        : groupInteraction?.status === 'stopped' ? '讨论已停止'
          : undefined;
  const markReaderNavigation = () => {
    if (readerNavigationRef.current.identity === scrollIdentityKey) readerNavigationRef.current.navigated = true;
  };
  const handleScroll = (element: HTMLDivElement) => {
    if (scrollIdentityKey && restoredScrollIdentityRef.current !== scrollIdentityKey) return;
    wasNearBottomRef.current = isNearBottom(element);
    if (!onScrollPositionChange) return;
    if (scrollSaveTimerRef.current !== null) window.clearTimeout(scrollSaveTimerRef.current);
    const pending = { identity: scrollIdentityKey, position: element.scrollTop, save: onScrollPositionChange };
    pendingScrollSaveRef.current = pending;
    scrollSaveTimerRef.current = window.setTimeout(() => {
      if (pendingScrollSaveRef.current !== pending) return;
      pendingScrollSaveRef.current = null;
      scrollSaveTimerRef.current = null;
      pending.save(pending.position);
    }, 140);
  };
  const agentsById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const renderMessage = useCallback((message: ConversationMessage) => {
    const sender = message.senderAgentId ? agentsById.get(message.senderAgentId) : undefined;
    return <MessageRow key={message.id} message={message} senderName={isGroup ? sender?.name : undefined} senderRoleTitle={isGroup ? sender?.roleTitle : undefined} />;
  }, [agentsById, isGroup]);

  return <main data-signal-chat className="signal-chat flex min-w-0 flex-1 flex-col bg-[var(--app-bg)]">
    <div className="ambient-backdrop" aria-hidden="true" />
    <header ref={bindHeaderRef} className="signal-chat-header absolute inset-x-3 top-3 z-10 flex min-h-[4.25rem] items-center justify-between gap-3 rounded-2xl border ui-border px-5 py-3">
      <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${effectiveSending ? 'signal-timeline-dot-current bg-[var(--app-accent)]' : 'bg-[var(--app-dim)]'}`} /><h1 className="truncate text-[15px] font-semibold ui-text">{title}</h1></div>{target.kind !== 'none' && <p className="mt-1 truncate text-xs ui-muted">{isGroup ? '协作群聊记录保存在当前工作区' : '私聊会话仅属于当前工作区'}</p>}</div>
      <div className="flex shrink-0 items-center gap-2">{isGroup && (onOpenCollaborationTask || onCreateCollaborationTask) && <button type="button" className="ui-button-secondary rounded-lg px-2.5 py-1.5 text-xs" onClick={() => (onOpenCollaborationTask ?? onCreateCollaborationTask)?.()}>协作任务</button>}{layoutControls?.view && layoutControls.onViewChange && <div className="flex items-center gap-1 rounded-xl border ui-border p-1" role="tablist" aria-label="工作区视图"><button type="button" role="tab" aria-selected={layoutControls.view === 'chat'} data-agentos="workspace-chat-tab" onClick={() => layoutControls.onViewChange?.('chat')} className={`rounded-lg px-2.5 py-1.5 text-xs ${layoutControls.view === 'chat' ? 'ui-selected' : 'ui-button-ghost'}`}>对话</button><button type="button" role="tab" aria-selected={layoutControls.view === 'execution'} data-agentos="workspace-execution-tab" onClick={() => layoutControls.onViewChange?.('execution')} className={`rounded-lg px-2.5 py-1.5 text-xs ${layoutControls.view === 'execution' ? 'ui-selected' : 'ui-button-ghost'}`}>执行详情</button></div>}{layoutControls && <div className="chat-layout-controls" role="group" aria-label="工作区布局">
        <button type="button" data-layout-toggle="workspace" aria-label={layoutControls.workspaceMode === 'compact' ? '展开 Agent 导航' : '收起 Agent 导航'} title={layoutControls.workspaceMode === 'compact' ? '展开 Agent 导航' : '收起 Agent 导航'} aria-pressed={layoutControls.workspaceMode === 'compact'} onClick={layoutControls.onToggleWorkspace} className="chat-layout-toggle ui-button-ghost"
        ><span aria-hidden="true">{layoutControls.workspaceMode === 'compact' ? '›' : '‹'}</span><span className="chat-layout-toggle-label">导航</span></button>
        {layoutControls.historyAvailable && <button type="button" data-layout-toggle="history" aria-label={layoutControls.historyVisible ? '收起会话列表' : '打开会话列表'} title={layoutControls.historyVisible ? '收起会话列表' : '打开会话列表'} aria-pressed={!layoutControls.historyVisible} onClick={layoutControls.onToggleHistory} className="chat-layout-toggle ui-button-ghost"><span aria-hidden="true">▤</span><span className="chat-layout-toggle-label">会话</span></button>}
        <button type="button" data-layout-toggle="inspector" aria-label={layoutControls.inspectorVisible ? '收起执行状态面板' : '打开执行状态面板'} title={layoutControls.inspectorVisible ? '收起执行状态面板' : '打开执行状态面板'} aria-pressed={!layoutControls.inspectorVisible} onClick={layoutControls.onToggleInspector} className="chat-layout-toggle ui-button-ghost"><span aria-hidden="true">◧</span><span className="chat-layout-toggle-label">状态</span></button>
        <button type="button" data-layout-toggle="focus" aria-label={layoutControls.focusMode ? '退出专注模式' : '进入专注模式'} title={layoutControls.focusMode ? '退出专注模式' : '进入专注模式'} aria-pressed={layoutControls.focusMode} onClick={layoutControls.onToggleFocus} className={`chat-layout-toggle ui-button-ghost ${layoutControls.focusMode ? 'ui-selected' : ''}`}><span aria-hidden="true">✦</span><span className="chat-layout-toggle-label">专注</span></button>
      </div>}{sending && <button type="button" onClick={onCancel} disabled={groupReadOnly} title={recoveryReason} className="rounded-lg border border-[color:var(--app-danger)]/50 px-3 py-1.5 text-xs font-medium text-[var(--app-danger)] transition hover:bg-[color:var(--app-danger)]/10 disabled:cursor-not-allowed disabled:opacity-50">{isGroup ? '停止讨论' : '中断执行'}</button>}</div>
    </header>

    {target.kind === 'none' ? <div className="signal-empty m-6 grid flex-1 place-items-center px-6 text-center" style={{ marginTop: chromeTop + 24 }}><div className="relative z-10"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[var(--app-accent-soft)] text-2xl ui-accent">✦</div><p className="mt-4 text-sm ui-muted">从左侧选择一个 Agent 或群聊。</p></div></div> : <>
      <div ref={scrollRef} data-scroll-restoration={!scrollIdentityKey || (draftReady && restoredScrollIdentity === scrollIdentityKey) ? 'ready' : 'pending'} onWheel={markReaderNavigation} onTouchMove={markReaderNavigation} onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markReaderNavigation(); }} onScroll={event => handleScroll(event.currentTarget)} className="signal-chat-scroll flex-1 min-w-0 overflow-y-auto px-4 sm:px-6" style={{ paddingTop: chromeTop + 28, paddingBottom: chromeBottom + 28 }}><div className="message-content-column mx-auto max-w-[70rem] min-w-0 space-y-3">
        {isGroup && (groupInteraction || groupDiscussionError) && <div className="rounded-2xl border ui-border bg-[var(--app-surface-raised)] px-4 py-3 text-sm ui-text-soft"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-2"><span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${!groupReadOnly && groupInteraction?.status === 'active' ? 'bg-[var(--app-accent)]' : 'bg-[var(--app-dim)]'}`} /><span className="font-medium ui-text">轮流讨论</span>{groupStatusLabel && <span className="ui-muted">· {groupStatusLabel}</span>}</div><span className="text-xs ui-muted">{groupBudget ? `${groupBudget.repliesUsed}/${groupBudget.repliesUsed + groupBudget.repliesRemaining} 次回复 · ${groupBudget.distinctAgents} 位 Agent` : '预算准备中'}</span></div>{groupReadOnly && <div role="status" className="mt-2 text-xs ui-text-soft">等待处理：{recoveryReason}。该讨论无法安全续接；保留历史供查看，发送、继续和停止已禁用。</div>}{groupRecoveryBlockedReason && <div role="status" className="mt-2 text-xs ui-text-soft">{groupRecoveryBlockedReason}</div>}{groupInteraction?.stopReason && <div className="mt-1 text-xs ui-muted">结束原因：{groupInteraction.stopReason}</div>}{groupDiscussionError && <div role="alert" className="mt-2 text-xs text-[var(--app-danger)]">{groupDiscussionError}</div>}</div>}
        {groupRecoveryAvailable && groupInteraction && groupExecutionOwner && groupRecoveryWorkspaceId && scrollIdentityKey && onGroupInteractionRecovered && <GroupInteractionRecoveryPanel
          workspaceId={groupRecoveryWorkspaceId}
          apiBase={apiBase}
          identityKey={scrollIdentityKey}
          conversationId={groupInteraction.conversationId}
          generation={groupRecoveryGeneration ?? 0}
          interactionId={groupInteraction.id}
          interactionVersion={groupInteraction.version}
          ownerEpoch={groupExecutionOwner.ownerEpoch}
          dispatchManagedByCaller
          onRecovered={onGroupInteractionRecovered}
        />}
        {messages.length === 0 && !streamingContent && !collaborationProgressState?.progress && !collaborationProgressState?.error && !groupInteraction && <div className="signal-empty px-5 py-10 text-center text-sm leading-7 ui-muted">{target.kind === 'group' ? `这是群聊“${target.label}”的新会话。直接输入需求即可开始轮流讨论。` : `这是与 ${target.label} 的新会话。直接输入需求即可开始执行。`}</div>}
        {isGroup && collaborationProgressState?.error && <section role="alert" className="mx-auto w-full max-w-[70rem] rounded-2xl border border-[var(--app-danger)]/40 bg-[var(--app-surface-raised)] px-4 py-3 text-sm leading-6 text-[var(--app-danger)]">协作任务无法加载：{collaborationProgressState.error}</section>}
        {isGroup && collaborationProgressState?.progress && <CollaborationTaskProgressCard state={collaborationProgressState} agents={agents} onOpenTask={() => (onOpenCollaborationTask ?? onCreateCollaborationTask)?.()} onCreateTask={() => onCreateCollaborationTask?.()} onOpenRuntime={runId => onOpenRuntime?.(runId)} />}
        {messages.length > 100 && <VirtualMessageList messages={messages} scrollElementRef={scrollRef} renderMessage={renderMessage} />}
        {messages.length <= 100 && messages.map(renderMessage)}
        {runtimeResult && <RuntimeResultProjection projection={runtimeResult} apiBase={apiBase} onOpenDetails={onOpenRuntimeDetails ? () => onOpenRuntimeDetails(runtimeResult.run.id) : undefined} />}
        <ThinkingProcess events={activeEvents} runtimeEvents={activeRuntimeEvents} sending={effectiveSending} interrupted={groupReadOnly} />
        {streamingContent && <div className="signal-message-row flex min-w-0 gap-3"><MessageSurface content={streamingContent} senderName={isGroup ? groupSpeakingAgentName : undefined} senderType="agent" streaming={!groupReadOnly} /></div>}
        {status && <div className="signal-status-card rounded-xl border px-4 py-3 text-sm">{status}</div>}
        {connectionNotice && <div className="rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-warning)]/10 px-4 py-3 text-sm ui-text-soft">{connectionNotice}</div>}
        {!groupReadOnly && activeStatus === 'waiting_user' && waitingQuestion && <div className="rounded-xl border border-[var(--app-accent)]/40 bg-[var(--app-accent-soft)] px-4 py-3 text-sm ui-text-soft"><div className="mb-1 text-xs font-medium ui-accent">Agent 需要补充信息</div>{waitingQuestion}</div>}
        {error && <div className="ui-error rounded-xl border px-4 py-3 text-sm">{error}</div>}
        {!runtimeResult && !sending && chatArtifacts.length > 0 && apiBase && <div className="rounded-2xl border ui-border bg-[var(--app-surface-raised)] p-4"><ArtifactShelf artifacts={chatArtifacts} apiBase={apiBase} /></div>}
         <div ref={endRef} />
       </div></div>

      <div ref={bindChromeRef} className="signal-chat-chrome">
      <div className="signal-composer-shell border-t ui-border px-4 py-4 sm:px-6"><div ref={composerGlassRef} className="signal-composer mx-auto max-w-[70rem] min-w-0 rounded-2xl border ui-border bg-[var(--app-surface-raised)] p-3 transition focus-within:border-[var(--app-accent)]" onPaste={event => { const imageFiles = Array.from(event.clipboardData.items).filter(isImageClipboardItem).map(item => item.getAsFile()).filter((file): file is File => Boolean(file)); if (imageFiles.length > 0) { event.preventDefault(); onFiles(imageFiles); } }}>
        <button type="button" role="slider" data-testid="composer-resize-handle" className="composer-resize-handle" aria-label="调整输入框高度" aria-controls="message-input" aria-orientation="vertical" aria-valuemin={COMPOSER_MIN_HEIGHT} aria-valuemax={COMPOSER_MAX_HEIGHT} aria-valuenow={composerHeight} aria-valuetext={`${composerHeight}px`} onPointerDown={startComposerResize} onPointerMove={moveComposerResize} onPointerUp={finishComposerResize} onPointerCancel={finishComposerResize} onKeyDown={handleComposerResizeKeyDown}><span aria-hidden="true" /></button>
        <textarea id="message-input" aria-label="消息输入框" disabled={!draftReady} value={draft} onChange={event => onDraftChange(event.target.value)} onKeyDown={event => handleComposerKeyDown({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode, preventDefault: () => event.preventDefault() }, { canSend: draftReady && !groupReadOnly, onSend, focus: () => event.currentTarget.focus() })} placeholder={groupReadOnly ? '讨论已中断，等待处理；可保留未发送草稿…' : effectiveSending ? `正在运行——输入补充指示，回车加入队列${queuedMessageCount ? `（已排队 ${queuedMessageCount} 条）` : ''}` : !draftReady ? '正在恢复此会话草稿…' : activeStatus === 'waiting_user' ? '补充信息…' : target.kind === 'group' ? '向群聊发起轮流讨论…' : `向 ${target.label} 发送消息…`} className="w-full resize-none bg-transparent px-1 text-sm leading-6 ui-text outline-none focus-visible:outline-none placeholder:ui-dim disabled:cursor-wait" style={{ height: `${composerHeight}px` }} />
        {validationError && <div role="alert" className="ui-error mt-2 rounded-lg border px-2.5 py-1.5 text-xs">{validationError}</div>}
        {attachmentError && <div role="alert" className="ui-error mt-2 rounded-lg border px-2.5 py-1.5 text-xs">{attachmentError}</div>}
        {onResumeQueue && !effectiveSending && (queuedMessageCount > 0 || groupDiscussionError) && <button type="button" disabled={!draftReady || groupReadOnly} title={recoveryReason} onClick={onResumeQueue} className="ui-button-ghost mt-2 rounded-lg px-2.5 py-1.5 text-xs">核对后恢复原发送</button>}
        {draftPersistenceWarning && <div role="status" className="mt-2 rounded-lg border border-[var(--app-warning)]/40 bg-[var(--app-warning)]/10 px-2.5 py-1.5 text-xs ui-text-soft">{draftPersistenceWarning}</div>}
        <div className={`composer-action-row mt-2 flex items-center justify-between gap-3 ${isGroup ? 'composer-group-actions' : ''}`}>
          <div className={isGroup ? 'composer-group-targets' : 'min-w-0'}>
            <ImageAttachments drafts={attachments} disabled={!draftReady} onFiles={onFiles} onRemove={onRemoveAttachment} />
            {isGroup && onMentionedAgentIdsChange && <MentionPicker agents={agents} selectedAgentIds={mentionedAgentIds} disabled={sending || !draftReady} onChange={onMentionedAgentIdsChange} />}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2"><ComposerControls isGroup={isGroup} modelOptions={modelOptions} model={composerModel} thinkingEffort={composerThinkingEffort} thinkingEfforts={composerThinkingEfforts} modelSource={modelSource} disabled={sending || !draftReady} runIntent={runIntent} onRunIntentChange={onRunIntentChange} onModelChange={onComposerModelChange} onThinkingEffortChange={onComposerThinkingEffortChange} />{sending && <button type="button" onClick={onCancel} disabled={groupReadOnly} title={recoveryReason ?? (isGroup ? '停止当前群聊讨论' : '中断当前运行')} aria-label={isGroup ? '停止讨论' : '中断执行'} className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[color:var(--app-danger)]/60 bg-[color:var(--app-danger)]/15 text-[var(--app-danger)] transition hover:bg-[color:var(--app-danger)]/25 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-[var(--app-danger)]" /></button>}<button type="button" onClick={onSend} disabled={sendButtonState.disabled} title={recoveryReason} aria-busy={sendButtonState.ariaBusy} aria-label={sendButtonState.label} className="ui-button-primary grid h-9 w-9 shrink-0 place-items-center rounded-xl text-lg disabled:cursor-not-allowed disabled:opacity-50">{sendButtonState.showSpinner ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <span aria-hidden="true">↑</span>}</button></div></div>
      </div></div></div>
    </>}
  </main>;
}
