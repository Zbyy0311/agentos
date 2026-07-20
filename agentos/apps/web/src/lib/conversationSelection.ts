export function getActiveConversationId({
  selectedGroupId,
  selectedDirectConversationId,
}: {
  selectedGroupId: string | null;
  selectedDirectConversationId: string | null;
}): string | null {
  return selectedGroupId ?? selectedDirectConversationId;
}

export function getChatTarget({ groupTitle, agentName }: { groupTitle?: string; agentName?: string }): { kind: 'group' | 'agent' | 'none'; label: string } {
  if (groupTitle) return { kind: 'group', label: groupTitle };
  if (agentName) return { kind: 'agent', label: agentName };
  return { kind: 'none', label: '' };
}

export function shouldResetGroupView({ selectedGroupId, nextGroupId }: { selectedGroupId: string | null; nextGroupId: string }): boolean {
  return selectedGroupId !== nextGroupId;
}
