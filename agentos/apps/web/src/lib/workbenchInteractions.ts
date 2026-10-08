export type WorkbenchAction =
  | { readonly kind: 'select-agent'; readonly id: string }
  | { readonly kind: 'select-conversation'; readonly id: string }
  | { readonly kind: 'create-conversation' };

export interface WorkbenchActionHandlers {
  readonly onSelectAgent: (id: string) => void;
  readonly onSelectConversation: (id: string) => void;
  readonly onCreateConversation: () => void;
}

/** Keep the four-column controls as a pure intent-to-callback seam. */
export function dispatchWorkbenchAction(
  action: WorkbenchAction,
  handlers: WorkbenchActionHandlers,
): void {
  if (action.kind === 'select-agent') {
    handlers.onSelectAgent(action.id);
    return;
  }
  if (action.kind === 'select-conversation') {
    handlers.onSelectConversation(action.id);
    return;
  }
  handlers.onCreateConversation();
}
