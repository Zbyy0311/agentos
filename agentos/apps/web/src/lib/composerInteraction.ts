export type ComposerSendIntent = 'idle' | 'send' | 'queue';

export function getComposerSendIntent(input: { sending: boolean; content: string; hasAttachments: boolean }): ComposerSendIntent {
  if (!input.content.trim() && !input.hasAttachments) return 'idle';
  return input.sending ? 'queue' : 'send';
}

export function preserveDraftAfterSendFailure(currentDraft: string, submittedContent: string): string {
  return currentDraft.trim() ? currentDraft : submittedContent;
}
