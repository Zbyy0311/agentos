import type { Conversation } from '@agentos/shared';
import type { MouseEvent } from 'react';

interface ConversationHistoryProps {
  title: string;
  conversations: Conversation[];
  selectedConversationId: string | null;
  createLabel: string;
  onCreate(): void;
  onSelect(id: string): void;
  onContextMenu(conversationId: string, event: MouseEvent<HTMLButtonElement>): void;
}

export function ConversationHistory({ title, conversations, selectedConversationId, createLabel, onCreate, onSelect, onContextMenu }: ConversationHistoryProps) {
  return <aside className="flex w-60 shrink-0 flex-col border-r border-slate-800/80 bg-[#101923] px-3 py-4">
    <div className="mb-4 flex items-center justify-between px-2"><span className="truncate text-sm font-medium text-slate-200">{title}</span><span className="text-xs text-slate-600">历史记录</span></div>
    <button type="button" onClick={onCreate} className="mb-5 flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-500"><span className="text-lg leading-none">+</span>{createLabel}</button>
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
      {conversations.map(conversation => {
        const selected = conversation.id === selectedConversationId;
        return <button type="button" key={conversation.id} onClick={() => onSelect(conversation.id)} onContextMenu={event => onContextMenu(conversation.id, event)} className={`w-full rounded-xl px-3 py-3 text-left transition ${selected ? 'bg-slate-800/90 ring-1 ring-blue-500/40' : 'hover:bg-slate-800/60'}`}>
          <span className="block truncate text-sm font-medium text-slate-200">{conversation.title}</span>
          <span className="mt-1 block text-xs text-slate-500">{new Date(conversation.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </button>;
      })}
      {conversations.length === 0 && <div className="px-3 py-8 text-center text-sm leading-6 text-slate-600">暂无历史会话。<br />新建会话即可开始协作。</div>}
    </div>
  </aside>;
}
