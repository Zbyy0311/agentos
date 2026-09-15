export type ComposerKeyAction = 'send' | 'newline' | 'ignore';

export interface ComposerKeyInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly canSend: boolean;
}

export interface ComposerSubmitInput {
  readonly canSend: boolean;
  readonly onSend: () => void;
  readonly focus: () => void;
}

export function resolveComposerKeyAction(input: ComposerKeyInput): ComposerKeyAction {
  if (input.key !== 'Enter' || input.isComposing === true) return 'ignore';
  if (input.shiftKey) return 'newline';
  return input.canSend ? 'send' : 'ignore';
}

/** Submit without moving focus away from the message composer. */
export function submitComposer(input: ComposerSubmitInput): void {
  if (!input.canSend) return;
  input.onSend();
  input.focus();
}

/** Apply the shared Enter/Shift+Enter contract to a textarea-like event. */
export function handleComposerKeyDown(
  event: Pick<ComposerKeyInput, 'key' | 'shiftKey' | 'isComposing'> & { preventDefault(): void },
  input: ComposerSubmitInput,
): void {
  if (resolveComposerKeyAction({ ...event, canSend: input.canSend }) !== 'send') return;
  event.preventDefault();
  submitComposer(input);
}
