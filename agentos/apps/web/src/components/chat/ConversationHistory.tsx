import type { Conversation } from '@agentos/shared';
import type { MouseEvent } from 'react';

interface ConversationHistoryProps {
  title: string;
  panelWidth?: number;
  conversations: Conversation[];
  selectedConversationId: string | null;
  createLabel: string;
  onCreate(): void;
  onSelect(id: string): void;
  onContextMenu(conversationId: string, event: MouseEvent<HTMLButtonElement>): void;
}

export function ConversationHistory({ title, panelWidth, conversations, selectedConversationId, createLabel, onCreate, onSelect, onContextMenu }: ConversationHistoryProps) {
  return <aside data-signal-history className="history-sidebar signal-history ui-panel flex w-64 shrink-0 flex-col border-r px-3 py-4" style={panelWidth === undefined ? undefined : { width: `${panelWidth}px` }}>
    <div className="mb-4 px-2">
      <div className="signal-section-label">CONVERSATIONS</div>
      <div className="mt-2 truncate text-sm font-semibold ui-text">{title}</div>
    </div>
    <button type="button" onClick={onCreate} className="ui-button-primary mb-5 flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium"><span className="text-lg leading-none">+</span>{createLabel}</button>
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
      {conversations.map(conversation => {
        const selected = conversation.id === selectedConversationId;
        return <button type="button" key={conversation.id} onClick={() => onSelect(conversation.id)} onContextMenu={event => onContextMenu(conversation.id, event)} className={`signal-history-button w-full rounded-xl px-3 py-3 text-left transition ${selected ? 'ui-selected' : 'ui-button-ghost'}`}>
          <span className="block truncate text-sm font-medium">{conversation.title}</span>
          <span className="mt-1 block text-xs ui-dim">{new Date(conversation.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        </button>;
      })}
      {conversations.length === 0 && <div className="rounded-xl border border-dashed ui-border px-3 py-8 text-center text-sm leading-6 ui-dim">暂无历史会话。<br />新建会话即可开始协作。</div>}
    </div>
  </aside>;
}
