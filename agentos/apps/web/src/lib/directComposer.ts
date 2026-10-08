/**
 * Direct Conversation UX — Composer modes (Lite 12 §12).
 *
 * The Composer exposes chat, create Task, and start Run as DISTINCT actions.
 * A normal Send creates no Task and no modifying Run. Pure, framework-agnostic.
 */

export const COMPOSER_MODES = ['chat', 'task', 'run'] as const;
export type ComposerMode = (typeof COMPOSER_MODES)[number];

export interface ComposerDraft {
  readonly mode: ComposerMode;
  readonly content: string;
}

export type ComposerAction =
  | { readonly kind: 'send' }       // chat reply
  | { readonly kind: 'create-task' }
  | { readonly kind: 'start-run' };

export type ComposerIntent =
  | { readonly valid: true; readonly action: ComposerAction }
  | { readonly valid: false; readonly reason: 'empty-content' | 'invalid-mode' };

/**
 * Resolve the Composer's explicit action. Mode drives the action; content is required
 * for every mode. Chat send produces no Task and no Run by construction.
 */
export function resolveComposerAction(draft: ComposerDraft): ComposerIntent {
  if (!COMPOSER_MODES.includes(draft.mode)) return { valid: false, reason: 'invalid-mode' };
  if (draft.content.trim().length === 0) return { valid: false, reason: 'empty-content' };
  switch (draft.mode) {
    case 'chat': return { valid: true, action: { kind: 'send' } };
    case 'task': return { valid: true, action: { kind: 'create-task' } };
    case 'run': return { valid: true, action: { kind: 'start-run' } };
  }
}

/** Whether the action creates work beyond a chat reply (used for honest UI affordances). */
export function actionCreatesWork(action: ComposerAction): boolean {
  return action.kind !== 'send';
}

