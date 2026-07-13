import { useEffect, useRef } from 'react';
import type { AgentModelOption, AgentProfile, ConversationAttachment, ConversationMessage, ExecutionStatus, ModelDiscoverySource, ThinkingEffort } from '@agentos/shared';
import { isImageClipboardItem, type ImageDraft } from '@/lib/imageAttachments';
import { getChatTarget } from '@/lib/conversationSelection';
import { ComposerControls } from './ComposerControls';
import { ImageAttachments } from './ImageAttachments';

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
  activeStatus?: ExecutionStatus;
  error: string;
  sending: boolean;
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
};

function MessageContent({ content }: { content: string }) {
  const blocks: Array<{ type: 'text' | 'code'; lines: string[] }> = [];
  let codeLines: string[] | null = null;

  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (codeLines) {
        blocks.push({ type: 'code', lines: codeLines });
        codeLines = null;
      } else {
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
    } else {
      const last = blocks.at(-1);
      if (last?.type === 'text') last.lines.push(line);
      else blocks.push({ type: 'text', lines: [line] });
    }
  }
  if (codeLines) blocks.push({ type: 'code', lines: codeLines });

  return <div className="space-y-2">
    {blocks.map((block, blockIndex) => block.type === 'code'
      ? <pre key={blockIndex} className="overflow-x-auto rounded-xl border border-slate-800 bg-[#0b1118] px-3 py-2 font-mono text-xs leading-5 text-slate-200"><code>{block.lines.join('\n')}</code></pre>
      : block.lines.map((line, lineIndex) => {
        const key = `${blockIndex}-${lineIndex}`;
        const displayLine = line.replace(/^-\s+(?=#{1,3}\s)/, '');
        if (!displayLine.trim()) return <div key={key} className="h-2" />;
        if (displayLine.startsWith('### ')) return <h4 key={key} className="pt-2 text-sm font-semibold text-slate-50">{displayLine.slice(4)}</h4>;
        if (displayLine.startsWith('## ')) return <h3 key={key} className="pt-2 text-base font-semibold text-slate-50">{displayLine.slice(3)}</h3>;
        if (displayLine.startsWith('# ')) return <h2 key={key} className="pt-2 text-lg font-semibold text-slate-50">{displayLine.slice(2)}</h2>;
        const numbered = displayLine.match(/^(\d+)\.\s+(.*)$/);
        if (numbered) return <p key={key} className="flex gap-2"><span className="shrink-0 text-blue-300">{numbered[1]}.</span><span>{numbered[2]}</span></p>;
        if (displayLine.startsWith('- ')) return <p key={key} className="flex gap-2"><span className="text-blue-300">•</span><span>{displayLine.slice(2)}</span></p>;
        return <p key={key}>{displayLine}</p>;
      }),
    )}
  </div>;
}

function MessageAttachments({ attachments }: { attachments?: ConversationAttachment[] }) {
  if (!attachments?.length) return null;
  return <div className="mt-3 flex flex-wrap gap-2">
    {attachments.map(attachment => <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" title={attachment.name}>
      <img src={attachment.url} alt={attachment.name} className="h-28 w-28 rounded-xl border border-white/15 object-cover transition hover:border-blue-300" />
    </a>)}
  </div>;
}

export function ChatPanel({ agentName, roleTitle, conversationTitle, groupName, isGroup = false, agents, messages, draft, attachments, attachmentError, streamingContent, activeStatus, error, sending, modelOptions, composerModel, composerThinkingEffort, composerThinkingEfforts, modelSource, onDraftChange, onFiles, onRemoveAttachment, onComposerModelChange, onComposerThinkingEffortChange, onSend, onCancel, onRename }: ChatPanelProps) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamingContent]);

  const target = getChatTarget({ groupTitle: isGroup ? groupName : undefined, agentName });
  const title = conversationTitle ?? (agentName ? `${agentName} · ${roleTitle ?? 'Agent'}` : '选择一个 Agent 开始对话');
  const status = activeStatus ? statusLabels[activeStatus] : undefined;

  return <main className="flex min-w-0 flex-1 flex-col bg-[#0b1118]">
    <header className="flex min-h-[4.5rem] items-center justify-between border-b border-slate-800/80 px-6 py-3">
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-semibold text-slate-100">{title}</h1>
        {target.kind !== 'none' && <p className="mt-1 text-xs text-slate-500">{isGroup ? '协作群聊记录保存在当前工作区' : '私聊会话仅属于当前工作区'}</p>}
      </div>
      <div className="flex items-center gap-3">
        {isGroup && onRename && <button type="button" onClick={onRename} className="text-xs text-slate-500 transition hover:text-slate-200">编辑群聊</button>}
        {sending && <button type="button" onClick={onCancel} className="rounded-lg border border-red-400/30 px-3 py-1.5 text-xs font-medium text-red-300 transition hover:bg-red-500/10">取消执行</button>}
      </div>
    </header>

    {target.kind === 'none' ? <div className="grid flex-1 place-items-center px-6 text-center text-sm text-slate-500">从左侧选择一个 Agent 或群聊。</div> : <>
      <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.length === 0 && !streamingContent && <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/20 px-5 py-10 text-center text-sm leading-7 text-slate-500">{target.kind === 'group' ? `这是群聊“${target.label}”的新会话。直接输入需求即可开始协作。` : `这是与 ${target.label} 的新会话。直接输入需求即可开始执行。`}</div>}
          {messages.map(message => {
            const sender = message.senderAgentId ? agents.find(agent => agent.id === message.senderAgentId) : undefined;
            const userMessage = message.senderType === 'user';
            return <div key={message.id} className={`flex gap-3 ${userMessage ? 'justify-end' : 'justify-start'}`}>
              <div className={`${userMessage ? 'order-2 bg-blue-600 text-white' : message.senderType === 'system' ? 'border border-amber-500/30 bg-amber-500/10 text-amber-100' : 'border border-slate-800 bg-[#151e2a] text-slate-200'} max-w-[86%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm sm:max-w-[78%]`}>
                {isGroup && sender && <div className="mb-2 border-b border-slate-700/70 pb-2 text-xs font-medium text-blue-300">{sender.name}<span className="ml-1 font-normal text-slate-500">· {sender.roleTitle}</span></div>}
                <MessageContent content={message.content} />
                <MessageAttachments attachments={message.attachments} />
              </div>
            </div>;
          })}
          {streamingContent && <div className="flex gap-3"><div className="max-w-[86%] rounded-2xl border border-slate-800 bg-[#151e2a] px-4 py-3 text-sm leading-6 text-slate-200 shadow-sm sm:max-w-[78%]"><MessageContent content={streamingContent} /><span className="ml-1 inline-block h-4 w-1 animate-pulse bg-blue-400 align-[-2px]" /></div></div>}
          {status && <div className="rounded-xl border border-blue-400/20 bg-blue-500/10 px-4 py-3 text-sm text-blue-200">{status}</div>}
          {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">{error}</div>}
          <div ref={endRef} />
        </div>
      </div>

      <div className="border-t border-slate-800/80 bg-[#0b1118]/95 px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-3xl rounded-2xl border border-slate-700/80 bg-[#151d28] p-3 shadow-[0_12px_40px_rgba(0,0,0,0.18)] transition focus-within:border-slate-600" onPaste={event => {
          const imageFiles = Array.from(event.clipboardData.items)
            .filter(isImageClipboardItem)
            .map(item => item.getAsFile())
            .filter((file): file is File => Boolean(file));
          if (imageFiles.length > 0) {
            event.preventDefault();
            onFiles(imageFiles);
          }
        }}>
          <textarea aria-label="消息输入框" value={draft} onChange={event => onDraftChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); } }} disabled={sending} placeholder={target.kind === 'group' ? `向群聊“${target.label}”发送消息…` : `向 ${target.label} 发送消息…`} className="h-20 w-full resize-none bg-transparent px-1 text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600 disabled:cursor-not-allowed" />
          {attachmentError && <div role="alert" className="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-200">{attachmentError}</div>}
          <div className="mt-2 flex items-center justify-between gap-3">
            <ImageAttachments drafts={attachments} disabled={sending} onFiles={onFiles} onRemove={onRemoveAttachment} />
            <span className="hidden text-xs text-slate-600 sm:inline">Enter 发送 · Shift + Enter 换行</span>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <ComposerControls isGroup={isGroup} modelOptions={modelOptions} model={composerModel} thinkingEffort={composerThinkingEffort} thinkingEfforts={composerThinkingEfforts} modelSource={modelSource} disabled={sending} onModelChange={onComposerModelChange} onThinkingEffortChange={onComposerThinkingEffortChange} />
              <button type="button" onClick={onSend} disabled={sending || (!draft.trim() && attachments.length === 0)} aria-label="发送消息" className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-blue-600 text-lg text-white shadow-lg shadow-blue-950/40 transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500">↑</button>
            </div>
          </div>
        </div>
      </div>
    </>}
  </main>;
}
