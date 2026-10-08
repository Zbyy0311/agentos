export interface GroupConversationScope {
  readonly workspaceId: string;
  readonly apiBase: string;
  readonly conversationId: string | null;
  readonly generation: number;
}

export function nextGroupConversationScope(
  previous: GroupConversationScope,
  workspaceId: string,
  apiBase: string,
  conversationId: string | null,
): GroupConversationScope {
  return previous.workspaceId === workspaceId && previous.apiBase === apiBase && previous.conversationId === conversationId
    ? previous
    : { workspaceId, apiBase, conversationId, generation: previous.generation + 1 };
}

export function isGroupRecoveryDispatchCurrent(
  identity: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly generation: number;
    readonly interactionId: string;
  },
  scope: GroupConversationScope,
  visibleInteractionId: string | null,
): boolean {
  return identity.workspaceId === scope.workspaceId
    && identity.conversationId === scope.conversationId
    && identity.generation === scope.generation
    && identity.interactionId === visibleInteractionId;
}
