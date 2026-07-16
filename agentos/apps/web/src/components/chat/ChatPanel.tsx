import { useEffect, useRef, useState } from 'react';
import type { AgentModelOption, AgentProfile, ConversationAttachment, ConversationMessage, ExecutionEvent, ExecutionStatus, ModelDiscoverySource, ThinkingEffort } from '@agentos/shared';
import { canSendMessage, isImageClipboardItem, type ImageDraft } from '@/lib/imageAttachments';
import { getChatTarget } from '@/lib/conversationSelection';
import { chunkResponseBlocks, getResponseLineCount, RESPONSE_CHUNK_THRESHOLD, type ResponseBlock } from '@/lib/responseRendering';
import { getSendButtonState } from '@/lib/uiFeedback';
import { ComposerControls } from './ComposerControls';
import { ImageAttachments } from './ImageAttachments';
import { ImagePreviewModal, type ImagePreviewItem } from './ImagePreviewModal';

type VisibleExecutionEvent = ExecutionEvent & { agentId?: string; agentName?: string };

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
  onSend(): void;
  onCancel(): void;
  onRename?(): void;
}

const statusLabels: Partial<Record<ExecutionStatus, string>> = {
  queued: '正在排队',
  preparing_context: '正在准备会话上下文',
  running_cli: '正在调用 Agent CLI',
  streaming_response: '正在生成回复',
  waiting_user: '等待你的补充信息',
};

function MessageContent({ content }: { content: string }) {
  const blocks: ResponseBlock[] = [];
  let codeLines: string[] | null = null;

  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (codeLines) { blocks.push({ type: 'code', lines: codeLines }); codeLines = null; }
      else codeLines = [];
      continue;
    }
    if (codeLines) codeLines.push(line);
    else {
      const last = blocks.at(-1);
      if (last?.type === 'text') last.lines.push(line);
      else blocks.push({ type: 'text', lines: [line] });
    }
  }
  if (codeLines) blocks.push({ type: 'code', lines: codeLines });
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

function ThinkingProcess({ events, sending }: { events: VisibleExecutionEvent[]; sending: boolean }) {
  const [expanded, setExpanded] = useState(sending);
  useEffect(() => setExpanded(sending), [sending]);
  if (!events.length && !sending) return null;
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
    </div>}
    </div>
  );
}

export function ChatPanel({ agentName, roleTitle, conversationTitle, groupName, isGroup = false, agents, messages, draft, attachments, attachmentError, streamingContent, activeEvents, activeStatus, waitingQuestion, connectionNotice, validationError, error, sending, queuedMessageCount, modelOptions, composerModel, composerThinkingEffort, composerThinkingEfforts, modelSource, onDraftChange, onFiles, onRemoveAttachment, onComposerModelChange, onComposerThinkingEffortChange, onSend, onCancel, onRename }: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamingContent, activeEvents]);

  const target = getChatTarget({ groupTitle: isGroup ? groupName : undefined, agentName });
  const title = conversationTitle ?? (agentName ? `${agentName} · ${roleTitle ?? 'Agent'}` : '选择一个 Agent 开始对话');
  const status = activeStatus ? statusLabels[activeStatus] : undefined;
  const sendButtonState = getSendButtonState({ canSend: canSendMessage(draft, attachments), sending });

  return <main data-signal-chat className="signal-chat flex min-w-0 flex-1 flex-col bg-[var(--app-bg)]">
    <header className="signal-chat-header flex min-h-[4.75rem] items-center justify-between border-b ui-border px-5 py-3 sm:px-7">
      <div className="min-w-0"><div className="mb-1 flex items-center gap-2 signal-section-label"><span className={`h-1.5 w-1.5 rounded-full ${sending ? 'signal-timeline-dot-current bg-[var(--app-accent)]' : 'bg-[var(--app-dim)]'}`} />ACTIVE SESSION</div><h1 className="truncate text-[15px] font-semibold ui-text">{title}</h1>{target.kind !== 'none' && <p className="mt-1 text-xs ui-muted">{isGroup ? '协作群聊记录保存在当前工作区' : '私聊会话仅属于当前工作区'}</p>}</div>
      <div className="flex items-center gap-3">{isGroup && onRename && <button type="button" onClick={onRename} className="ui-button-ghost rounded-lg px-2 py-1 text-xs">编辑群聊</button>}{sending && <button type="button" onClick={onCancel} className="rounded-lg border border-[color:var(--app-danger)]/50 px-3 py-1.5 text-xs font-medium text-[var(--app-danger)] transition hover:bg-[color:var(--app-danger)]/10">中断执行</button>}</div>
    </header>

    {target.kind === 'none' ? <div className="signal-empty m-6 grid flex-1 place-items-center px-6 text-center"><div className="relative z-10"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[var(--app-accent-soft)] text-2xl ui-accent">✦</div><p className="mt-4 text-sm ui-muted">从左侧选择一个 Agent 或群聊。</p></div></div> : <>
      <div className="signal-chat-scroll flex-1 overflow-y-auto px-4 py-7 sm:px-6"><div className="mx-auto max-w-4xl space-y-5">
        {messages.length === 0 && !streamingContent && <div className="signal-empty px-5 py-10 text-center text-sm leading-7 ui-muted">{target.kind === 'group' ? `这是群聊“${target.label}”的新会话。直接输入需求即可开始协作。` : `这是与 ${target.label} 的新会话。直接输入需求即可开始执行。`}</div>}
        {messages.map(message => {
          const sender = message.senderAgentId ? agents.find(agent => agent.id === message.senderAgentId) : undefined;
          const userMessage = message.senderType === 'user';
          return <div key={message.id} className={`flex gap-3 ${userMessage ? 'justify-end' : 'justify-start'}`}><div className={`signal-message ${userMessage ? 'ui-message-user order-2' : message.senderType === 'system' ? 'ui-message-system' : 'ui-message-agent'} max-w-[86%] rounded-2xl border px-4 py-3 text-sm leading-6 sm:max-w-[78%]`}>{isGroup && sender && <div className="mb-2 border-b ui-border pb-2 text-xs font-medium ui-accent">{sender.name}<span className="ml-1 font-normal ui-muted">· {sender.roleTitle}</span></div>}<MessageContent content={message.content} /><MessageAttachments attachments={message.attachments} /></div></div>;
        })}
        <ThinkingProcess events={activeEvents} sending={sending} />
        {streamingContent && <div className="flex gap-3"><div className="signal-message ui-message-agent max-w-[86%] rounded-2xl border px-4 py-3 text-sm leading-6 sm:max-w-[78%]"><MessageContent content={streamingContent} /><span className="ml-1 inline-block h-4 w-1 animate-pulse bg-[var(--app-accent)] align-[-2px]" /></div></div>}
        {status && <div className="signal-status-card rounded-xl border px-4 py-3 text-sm">{status}</div>}
        {connectionNotice && <div className="rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-warning)]/10 px-4 py-3 text-sm ui-text-soft">{connectionNotice}</div>}
        {activeStatus === 'waiting_user' && waitingQuestion && <div className="rounded-xl border border-[var(--app-accent)]/40 bg-[var(--app-accent-soft)] px-4 py-3 text-sm ui-text-soft"><div className="mb-1 text-xs font-medium ui-accent">Agent 需要补充信息</div>{waitingQuestion}</div>}
        {error && <div className="ui-error rounded-xl border px-4 py-3 text-sm">{error}</div>}
        <div ref={endRef} />
      </div></div>

      <div className="signal-composer-shell border-t ui-border px-4 py-4 sm:px-6"><div className="signal-composer mx-auto max-w-4xl rounded-2xl border ui-border bg-[var(--app-surface-raised)] p-3 transition focus-within:border-[var(--app-accent)]" onPaste={event => { const imageFiles = Array.from(event.clipboardData.items).filter(isImageClipboardItem).map(item => item.getAsFile()).filter((file): file is File => Boolean(file)); if (imageFiles.length > 0) { event.preventDefault(); onFiles(imageFiles); } }}>
        <textarea aria-label="消息输入框" value={draft} onChange={event => onDraftChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder={sending ? `正在运行——输入补充指示，回车加入队列${queuedMessageCount ? `（已排队 ${queuedMessageCount} 条）` : ''}` : activeStatus === 'waiting_user' ? '补充信息…' : target.kind === 'group' ? `向群聊“${target.label}”发送消息…` : `向 ${target.label} 发送消息…`} className="h-20 w-full resize-none bg-transparent px-1 text-sm leading-6 ui-text outline-none focus-visible:outline-none placeholder:ui-dim" />
        {validationError && <div role="alert" className="ui-error mt-2 rounded-lg border px-2.5 py-1.5 text-xs">{validationError}</div>}
        {attachmentError && <div role="alert" className="ui-error mt-2 rounded-lg border px-2.5 py-1.5 text-xs">{attachmentError}</div>}
        <div className="mt-2 flex items-center justify-between gap-3"><ImageAttachments drafts={attachments} disabled={sending} onFiles={onFiles} onRemove={onRemoveAttachment} /><span className="hidden text-xs ui-dim sm:inline">{sending ? 'Enter 加入队列 · Shift + Enter 换行' : 'Enter 发送 · Shift + Enter 换行'}</span><div className="ml-auto flex min-w-0 items-center gap-2"><ComposerControls isGroup={isGroup} modelOptions={modelOptions} model={composerModel} thinkingEffort={composerThinkingEffort} thinkingEfforts={composerThinkingEfforts} modelSource={modelSource} disabled={sending} onModelChange={onComposerModelChange} onThinkingEffortChange={onComposerThinkingEffortChange} />{sending && <button type="button" onClick={onCancel} title="中断当前运行" aria-label="中断执行" className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[color:var(--app-danger)]/60 bg-[color:var(--app-danger)]/15 text-[var(--app-danger)] transition hover:bg-[color:var(--app-danger)]/25 active:scale-95"><span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-[var(--app-danger)]" /></button>}<button type="button" onClick={onSend} disabled={sendButtonState.disabled} aria-busy={sendButtonState.ariaBusy} aria-label={sendButtonState.label} className="ui-button-primary grid h-9 w-9 shrink-0 place-items-center rounded-xl text-lg disabled:cursor-not-allowed disabled:opacity-50">{sendButtonState.showSpinner ? <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" /> : <span aria-hidden="true">↑</span>}</button></div></div>
      </div></div>
    </>}
  </main>;
}
