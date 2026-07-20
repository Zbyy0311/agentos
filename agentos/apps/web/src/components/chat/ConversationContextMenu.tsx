import type { Conversation } from '@agentos/shared';
import { getContextMenuPosition } from '@/lib/conversationActions';

interface ConversationContextMenuProps {
  conversation: Conversation;
  clientX: number;
  clientY: number;
  onRename(): void;
  onEditGroup?(): void;
  onCopyId(): void;
  onDelete(): void;
  onClose(): void;
}

export function ConversationContextMenu({ conversation, clientX, clientY, onRename, onEditGroup, onCopyId, onDelete, onClose }: ConversationContextMenuProps) {
  const { left, top } = getContextMenuPosition({
    clientX,
    clientY,
    menuWidth: 192,
    menuHeight: onEditGroup ? 184 : 144,
    viewportWidth: typeof window === 'undefined' ? 1280 : window.innerWidth,
    viewportHeight: typeof window === 'undefined' ? 720 : window.innerHeight,
  });

  const run = (action: () => void) => {
    action();
    onClose();
  };

  return <div
    role="menu"
    aria-label={`${conversation.title} 会话操作`}
    onMouseDown={event => event.stopPropagation()}
    className="ui-panel-raised fixed z-[60] w-48 overflow-hidden rounded-xl border p-1.5 shadow-[var(--app-shadow)]"
    style={{ left, top }}
  >
    <button type="button" role="menuitem" onClick={() => run(onRename)} className="ui-button-ghost w-full rounded-lg px-3 py-2 text-left text-sm">
      重命名
    </button>
    {conversation.type === 'group' && onEditGroup && <button type="button" role="menuitem" onClick={() => run(onEditGroup)} className="ui-button-ghost w-full rounded-lg px-3 py-2 text-left text-sm">
      编辑协作策略
    </button>}
    <button type="button" role="menuitem" onClick={() => run(onCopyId)} className="ui-button-ghost w-full rounded-lg px-3 py-2 text-left text-sm">
      复制会话 ID
    </button>
    <button type="button" role="menuitem" onClick={() => run(onDelete)} className="ui-button-ghost w-full rounded-lg px-3 py-2 text-left text-sm text-[var(--app-danger)]">
      删除会话
    </button>
  </div>;
}
