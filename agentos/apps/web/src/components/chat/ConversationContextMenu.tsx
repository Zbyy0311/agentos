import type { Conversation } from '@agentos/shared';
import { getContextMenuPosition } from '@/lib/conversationActions';

interface ConversationContextMenuProps {
  conversation: Conversation;
  clientX: number;
  clientY: number;
  onRename(): void;
  onCopyId(): void;
  onDelete(): void;
  onClose(): void;
}

export function ConversationContextMenu({ conversation, clientX, clientY, onRename, onCopyId, onDelete, onClose }: ConversationContextMenuProps) {
  const { left, top } = getContextMenuPosition({
    clientX,
    clientY,
    menuWidth: 192,
    menuHeight: 144,
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
    className="fixed z-[60] w-48 overflow-hidden rounded-xl border border-slate-700 bg-[#121a25] p-1.5 shadow-2xl shadow-black/40"
    style={{ left, top }}
  >
    <button type="button" role="menuitem" onClick={() => run(onRename)} className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800">
      重命名
    </button>
    <button type="button" role="menuitem" onClick={() => run(onCopyId)} className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800">
      复制会话 ID
    </button>
    <button type="button" role="menuitem" onClick={() => run(onDelete)} className="w-full rounded-lg px-3 py-2 text-left text-sm text-rose-300 transition hover:bg-rose-950/50">
      删除会话
    </button>
  </div>;
}
