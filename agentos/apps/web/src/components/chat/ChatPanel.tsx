import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { AgentEvent, AgentModelOption, AgentProfile, ConversationAttachment, ConversationMessage, ExecutionEvent, ExecutionStatus, ModelDiscoverySource, RunIntent, RuntimeArtifact, ThinkingEffort } from '@agentos/shared';
import { canSendMessage, isImageClipboardItem, type ImageDraft } from '@/lib/imageAttachments';
import { getChatVisibleArtifacts } from '@/lib/artifacts';
import { getChatTarget } from '@/lib/conversationSelection';
import { chunkResponseBlocks, getResponseLineCount, RESPONSE_CHUNK_THRESHOLD, type ResponseBlock } from '@/lib/responseRendering';
import { getSendButtonState } from '@/lib/uiFeedback';
import { isNearBottom } from '@/lib/chatScroll';
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

type VisibleExecutionEvent = ExecutionEvent & { agentId?: string; agentName?: string; runtimeEvent?: AgentEvent };

export interface ChatLayoutControls {
  workspaceMode: 'full' | 'compact';
  historyAvailable: boolean;
  historyVisible: boolean;
  inspectorVisible: boolean;
  focusMode: boolean;
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
  streamingContent: string;
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
  onOpenRuntimeDetails?(runId: string): void;
  mentionedAgentIds?: string[];
  onMentionedAgentIdsChange?(agentIds: string[]): void;
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
  /* Legacy line renderer retained below until old response snapshots are removed. */
  const blocks: ResponseBlock[] = [];
  let codeLines: string[] | null = null;

  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (codeLines !== null) { blocks.push({ type: 'code', lines: codeLines! }); codeLines = null; }
      else codeLines = [];
      continue;
    }
    if (codeLines !== null) codeLines!.push(line);
    else {
      const last = blocks.at(-1);
      if (last?.type === 'text') last!.lines.push(line);
      else blocks.push({ type: 'text', lines: [line] });
    }
  }
  if (codeLines !== null) blocks.push({ type: 'code', lines: codeLines! });
  const shouldChunk = getResponseLineCount(blocks) > RESPONSE_CHUNK_THRESHOLD;
  const responseChunks = shouldChunk ? chunkResponseBlocks(blocks) : [blocks];

  return <div className="space-y-2">
    {responseChunks.map((chunk, chunkIndex) => <div key={chunkIndex} className={shouldChunk ? 'response-render-chunk' : undefined}>
      {chunk.map((block, blockIndex) => block.type === 'code'
      ? <pre key={blockIndex} className="overflow-x-auto rounded-xl border ui-border bg-[var(--app-bg)] px-3 py-2 font-mono text-xs leading-5 ui-text-soft"><code>{block.lines.join('\n')}</code></pre>
      : block.lines.map((line, lineIndex) => {
        const key = `${blockIndex}-${lineIndex}`;
        const displayLine = line.replace(/^-\s+(?=#{1,3}\s)/, '');
        if (!displayLine.trim()) return <div key={key} className="h-2" />;
        if (displayLine.startsWith('### ')) return <h4 key={key} className="pt-2 text-sm font-semibold ui-text">{displayLine.slice(4)}</h4>;
        if (displayLine.startsWith('## ')) return <h3 key={key} className="pt-2 text-base font-semibold ui-text">{displayLine.slice(3)}</h3>;
        if (displayLine.startsWith('# ')) return <h2 key={key} className="pt-2 text-lg font-semibold ui-text">{displayLine.slice(2)}</h2>;
        const numbered = displayLine.match(/^(\d+)\.\s+(.*)$/);
        if (numbered) return <p key={key} className="flex gap-2"><span className="shrink-0 ui-accent">{numbered[1]}.</span><span>{numbered[2]}</span></p>;
        if (displayLine.startsWith('- ')) return <p key={key} className="flex gap-2"><span className="ui-accent">•</span><span>{displayLine.slice(2)}</span></p>;
        return <p key={key}>{displayLine}</p>;
      }),
      )}
    </div>)}
  </div>;
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
  const byCallId = new Map<string, AgentEvent>();
  for (const event of events) {
    if (event.type !== 'execution.tool.started' && event.type !== 'execution.tool.completed') {
      merged.push(event);
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    const callId = typeof payload.callId === 'string' ? payload.callId : undefined;
    if (!callId) { merged.push(event); continue; }
    const prior = byCallId.get(callId);
    if (prior) {
      const index = merged.indexOf(prior);
      const next = { ...event, payload: { ...prior.payload, ...event.payload } };
      if (index >= 0) merged[index] = next;
      byCallId.set(callId, next);
    } else {
      merged.push(event);
      byCallId.set(callId, event);
    }
  }
  return merged;
}

function ThinkingProcess({ events, runtimeEvents = [], sending }: { events: VisibleExecutionEvent[]; runtimeEvents?: AgentEvent[]; sending: boolean }) {
  const [expanded, setExpanded] = useState(sending);
  useEffect(() => setExpanded(sending), [sending]);
  const projectedRuntimeEvents = runtimeEvents.length > 0 ? runtimeEvents : events.flatMap(event => event.runtimeEvent ? [event.runtimeEvent] : []);
  if (!events.length && !projectedRuntimeEvents.length && !sending) return null;
  const latest = events.at(-1);
  const label = latest ? executionLabels[latest.status] ?? latest.activity : '正在准备执行过程';
  const latestLabel = latest?.agentName ? `${latest.agentName} · ${label}` : label;
  return (
    <div className="thinking-process">
    <button type="button" className="thinking-process-header w-full text-left" aria-expanded={expanded} aria-controls="thinking-process-body" onClick={() => setExpanded(current => !current)}>
      <span className="flex min-w-0 items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${latest?.status === 'failed' ? 'bg-[var(--app-danger)]' : latest?.status === 'completed' ? 'bg-[var(--app-success)]' : 'bg-[var(--app-accent)]'}`} />
        <span className="truncate text-xs font-medium ui-text">思考进度</span>
        <span className="truncate text-xs ui-muted">{latestLabel}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-[11px] ui-dim">
        <span>{events.length ? `${events.length} 个步骤` : '进行中'}</span>
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
      {!events.length && <div className="text-xs ui-muted">正在等待 Agent 返回第一个执行阶段...</div>}
      <RuntimeTimeline events={projectedRuntimeEvents} />
    </div>}
    </div>
  );
}

export function ChatPanel({ agentName, roleTitle, conversationTitle, groupName, isGroup = false, agents, messages, draft, attachments, attachmentError, streamingContent, activeEvents, activeRuntimeEvents = [], artifacts = [], runtimeResult, apiBase = '', activeStatus, waitingQuestion, connectionNotice, validationError, error, sending, queuedMessageCount, modelOptions, composerModel, composerThinkingEffort, composerThinkingEfforts, modelSource, onDraftChange, onFiles, onRemoveAttachment, onComposerModelChange, onComposerThinkingEffortChange, onSend, onCancel, onOpenRuntimeDetails, mentionedAgentIds = [], onMentionedAgentIdsChange, runIntent = 'execute', onRunIntentChange = value => window.dispatchEvent(new CustomEvent('agentos:run-intent', { detail: value })), layoutControls }: ChatPanelProps) {
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
  useEffect(() => {
    return () => {
      if (composerResizeFrameRef.current !== null) window.cancelAnimationFrame(composerResizeFrameRef.current);
    };
  }, []);

  useEffect(() => {
    if (composerResizingRef.current) return;
    if (!wasNearBottomRef.current) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, streamingContent, activeEvents, activeRuntimeEvents]);

  const startComposerResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    composerResizingRef.current = true;
    composerResizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: composerHeight };
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (scrollRef.current) scrollRef.current.style.scrollBehavior = 'auto';
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
    if (scrollRef.current) scrollRef.current.style.scrollBehavior = '';
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
  const status = activeStatus ? statusLabels[activeStatus] : undefined;
  const sendButtonState = getSendButtonState({ canSend: canSendMessage(draft, attachments), sending });
  const renderMessage = (message: ConversationMessage) => {
    const sender = message.senderAgentId ? agents.find(agent => agent.id === message.senderAgentId) : undefined;
    const userMessage = message.senderType === 'user';
    return <div key={message.id} className={`signal-message-row flex min-w-0 gap-3 ${userMessage ? 'justify-end' : 'justify-start'}`}><MessageSurface content={message.content} attachments={message.attachments} senderName={isGroup ? sender?.name : undefined} senderRoleTitle={isGroup ? sender?.roleTitle : undefined} senderType={message.senderType} /></div>;
  };

  return <main data-signal-chat className="signal-chat flex min-w-0 flex-1 flex-col bg-[var(--app-bg)]">
    <div className="ambient-backdrop" aria-hidden="true" />
    <header ref={bindHeaderRef} className="signal-chat-header absolute inset-x-3 top-3 z-10 flex min-h-[4.25rem] items-center justify-between gap-3 rounded-2xl border ui-border px-5 py-3">
      <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${sending ? 'signal-timeline-dot-current bg-[var(--app-accent)]' : 'bg-[var(--app-dim)]'}`} /><h1 className="truncate text-[15px] font-semibold ui-text">{title}</h1></div>{target.kind !== 'none' && <p className="mt-1 truncate text-xs ui-muted">{isGroup ? '协作群聊记录保存在当前工作区' : '私聊会话仅属于当前工作区'}</p>}</div>
      <div className="flex shrink-0 items-center gap-2">{layoutControls && <div className="chat-layout-controls" role="group" aria-label="工作区布局">
        <button type="button" data-layout-toggle="workspace" aria-label={layoutControls.workspaceMode === 'compact' ? '展开 Agent 导航' : '收起 Agent 导航'} title={layoutControls.workspaceMode === 'compact' ? '展开 Agent 导航' : '收起 Agent 导航'} aria-pressed={layoutControls.workspaceMode === 'compact'} onClick={layoutControls.onToggleWorkspace} className="chat-layout-toggle ui-button-ghost"
        ><span aria-hidden="true">{layoutControls.workspaceMode === 'compact' ? '›' : '‹'}</span><span className="chat-layout-toggle-label">导航</span></button>
        {layoutControls.historyAvailable && <button type="button" data-layout-toggle="history" aria-label={layoutControls.historyVisible ? '收起会话列表' : '打开会话列表'} title={layoutControls.historyVisible ? '收起会话列表' : '打开会话列表'} aria-pressed={!layoutControls.historyVisible} onClick={layoutControls.onToggleHistory} className="chat-layout-toggle ui-button-ghost"><span aria-hidden="true">▤</span><span className="chat-layout-toggle-label">会话</span></button>}
        <button type="button" data-layout-toggle="inspector" aria-label={layoutControls.inspectorVisible ? '收起执行状态面板' : '打开执行状态面板'} title={layoutControls.inspectorVisible ? '收起执行状态面板' : '打开执行状态面板'} aria-pressed={!layoutControls.inspectorVisible} onClick={layoutControls.onToggleInspector} className="chat-layout-toggle ui-button-ghost"><span aria-hidden="true">◧</span><span className="chat-layout-toggle-label">状态</span></button>
        <button type="button" data-layout-toggle="focus" aria-label={layoutControls.focusMode ? '退出专注模式' : '进入专注模式'} title={layoutControls.focusMode ? '退出专注模式' : '进入专注模式'} aria-pressed={layoutControls.focusMode} onClick={layoutControls.onToggleFocus} className={`chat-layout-toggle ui-button-ghost ${layoutControls.focusMode ? 'ui-selected' : ''}`}><span aria-hidden="true">✦</span><span className="chat-layout-toggle-label">专注</span></button>
      </div>}{sending && <button type="button" onClick={onCancel} className="rounded-lg border border-[color:var(--app-danger)]/50 px-3 py-1.5 text-xs font-medium text-[var(--app-danger)] transition hover:bg-[color:var(--app-danger)]/10">中断执行</button>}</div>
    </header>

    {target.kind === 'none' ? <div className="signal-empty m-6 grid flex-1 place-items-center px-6 text-center" style={{ marginTop: chromeTop + 24 }}><div className="relative z-10"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[var(--app-accent-soft)] text-2xl ui-accent">✦</div><p className="mt-4 text-sm ui-muted">从左侧选择一个 Agent 或群聊。</p></div></div> : <>
      <div ref={scrollRef} onScroll={event => { wasNearBottomRef.current = isNearBottom(event.currentTarget); }} className="signal-chat-scroll flex-1 min-w-0 overflow-y-auto px-4 sm:px-6" style={{ paddingTop: chromeTop + 28, paddingBottom: chromeBottom + 28 }}><div className="message-content-column mx-auto max-w-[70rem] min-w-0 space-y-3">
        {messages.length === 0 && !streamingContent && <div className="signal-empty px-5 py-10 text-center text-sm leading-7 ui-muted">{target.kind === 'group' ? `这是群聊“${target.label}”的新会话。直接输入需求即可开始协作。` : `这是与 ${target.label} 的新会话。直接输入需求即可开始执行。`}</div>}
        {messages.length > 100 && <VirtualMessageList messages={messages} scrollElementRef={scrollRef} renderMessage={renderMessage} />}
        {messages.length <= 100 && messages.map(renderMessage)}
        {runtimeResult && <RuntimeResultProjection projection={runtimeResult} apiBase={apiBase} onOpenDetails={onOpenRuntimeDetails ? () => onOpenRuntimeDetails(runtimeResult.run.id) : undefined} />}
        <ThinkingProcess events={activeEvents} runtimeEvents={activeRuntimeEvents} sending={sending} />
        {streamingContent && <div className="signal-message-row flex min-w-0 gap-3"><MessageSurface content={streamingContent} streaming /></div>}
        {status && <div className="signal-status-card rounded-xl border px-4 py-3 text-sm">{status}</div>}
        {connectionNotice && <div className="rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-warning)]/10 px-4 py-3 text-sm ui-text-soft">{connectionNotice}</div>}
        {activeStatus === 'waiting_user' && waitingQuestion && <div className="rounded-xl border border-[var(--app-accent)]/40 bg-[var(--app-accent-soft)] px-4 py-3 text-sm ui-text-soft"><div className="mb-1 text-xs font-medium ui-accent">Agent 需要补充信息</div>{waitingQuestion}</div>}
        {error && <div className="ui-error rounded-xl border px-4 py-3 text-sm">{error}</div>}
        {!runtimeResult && !sending && chatArtifacts.length > 0 && apiBase && <div className="rounded-2xl border ui-border bg-[var(--app-surface-raised)] p-4"><ArtifactShelf artifacts={chatArtifacts} apiBase={apiBase} /></div>}
         <div ref={endRef} />
       </div></div>

      <div ref={bindChromeRef} className="signal-chat-chrome">
      <div className="signal-composer-shell border-t ui-border px-4 py-4 sm:px-6"><div ref={composerGlassRef} className="signal-composer mx-auto max-w-[70rem] min-w-0 rounded-2xl border ui-border bg-[var(--app-surface-raised)] p-3 transition focus-within:border-[var(--app-accent)]" onPaste={event => { const imageFiles = Array.from(event.clipboardData.items).filter(isImageClipboardItem).map(item => item.getAsFile()).filter((file): file is File => Boolean(file)); if (imageFiles.length > 0) { event.preventDefault(); onFiles(imageFiles); } }}>
        <button type="button" role="slider" data-testid="composer-resize-handle" className="composer-resize-handle" aria-label="调整输入框高度" aria-controls="message-input" aria-orientation="vertical" aria-valuemin={COMPOSER_MIN_HEIGHT} aria-valuemax={COMPOSER_MAX_HEIGHT} aria-valuenow={composerHeight} aria-valuetext={`${composerHeight}px`} onPointerDown={startComposerResize} onPointerMove={moveComposerResize} onPointerUp={finishComposerResize} onPointerCancel={finishComposerResize} onKeyDown={handleComposerResizeKeyDown}><span aria-hidden="true" /></button>
        <textarea id="message-input" aria-label="消息输入框" value={draft} onChange={event => onDraftChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={sending ? `正在运行——输入补充指示，回车加入队列${queuedMessageCount ? `（已排队 ${queuedMessageCount} 条）` : ''}` : activeStatus === 'waiting_user' ? '补充信息…' : target.kind === 'group' ? '' : `向 ${target.label} 发送消息…`} className="w-full resize-none bg-transparent px-1 text-sm leading-6 ui-text outline-none focus-visible:outline-none placeholder:ui-dim" style={{ height: `${composerHeight}px` }} />
        {validationError && <div role="alert" className="ui-error mt-2 rounded-lg border px-2.5 py-1.5 text-xs">{validationError}</div>}
        {attachmentError && <div role="alert" className="ui-error mt-2 rounded-lg border px-2.5 py-1.5 text-xs">{attachmentError}</div>}
        <div className={`composer-action-row mt-2 flex items-center justify-between gap-3 ${isGroup ? 'composer-group-actions' : ''}`}>
          <div className={isGroup ? 'composer-group-targets' : 'min-w-0'}>
            <ImageAttachments drafts={attachments} disabled={sending} onFiles={onFiles} onRemove={onRemoveAttachment} />
            {isGroup && onMentionedAgentIdsChange && <MentionPicker agents={agents} selectedAgentIds={mentionedAgentIds} disabled={sending} onChange={onMentionedAgentIdsChange} />}
          </div>
          <div className="ml-auto flex min-w-0 items-center gap-2"><ComposerControls isGroup={isGroup} modelOptions={modelOptions} model={composerModel} thinkingEffort={composerThinkingEffort} thinkingEfforts={composerThinkingEfforts} modelSource={modelSource} disabled={sending} runIntent={runIntent} onRunIntentChange={onRunIntentChange} onModelChange={onComposerModelChange} onThinkingEffortChange={onComposerThinkingEffortChange} />{sending && <button type="button" onClick={onCancel} title="中断当前运行" aria-label="中断执行" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[color:var(--app-danger)]/60 bg-[color:var(--app-danger)]/15 text-[var(--app-danger)] transition hover:bg-[color:var(--app-danger)]/25 active:scale-95"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-[var(--app-danger)]" /></button>}<button type="button" onClick={onSend} disabled={sendButtonState.disabled} aria-busy={sendButtonState.ariaBusy} aria-label={sendButtonState.label} className="ui-button-primary grid h-9 w-9 shrink-0 place-items-center rounded-xl text-lg disabled:cursor-not-allowed disabled:opacity-50">{sendButtonState.showSpinner ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <span aria-hidden="true">↑</span>}</button></div></div>
      </div></div></div>
    </>}
  </main>;
}
