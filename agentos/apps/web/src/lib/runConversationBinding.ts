export type RunConversationBinding = 'matched' | 'unattached' | 'mismatch';

export function classifyRunConversationBinding(
  run: { readonly conversationId?: string | null },
  selectedConversationId: string,
): RunConversationBinding {
  if (run.conversationId === null || run.conversationId === undefined || run.conversationId === '') return 'unattached';
  return run.conversationId === selectedConversationId ? 'matched' : 'mismatch';
}
