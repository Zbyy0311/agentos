import type { Conversation } from '@agentos/shared';

export function getNextConversationId(conversations: Conversation[], deletedId: string): string | null {
  const deletedIndex = conversations.findIndex(conversation => conversation.id === deletedId);
  if (deletedIndex < 0) return null;
  return conversations[deletedIndex + 1]?.id ?? conversations[deletedIndex - 1]?.id ?? null;
}

export function getContextMenuPosition({
  clientX,
  clientY,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportHeight,
  margin = 8,
}: {
  clientX: number;
  clientY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): { left: number; top: number } {
  return {
    left: Math.max(margin, Math.min(clientX, viewportWidth - menuWidth - margin)),
    top: Math.max(margin, Math.min(clientY, viewportHeight - menuHeight - margin)),
  };
}
