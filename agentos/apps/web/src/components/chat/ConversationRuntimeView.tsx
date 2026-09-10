'use client';

import type { ReactNode } from 'react';
import { UI_FONT_STACK, UI_SPACING_BASE_PX, UI_RADIUS_TOKENS, uiCssVariables } from '../../lib/uiFoundation';
import type { UiTheme } from '../../lib/uiFoundation';
import type { ConversationStreamState } from '../../lib/directConversationStream';
import type { ComposerMode } from '../../lib/directComposer';
import { COMPOSER_MODES } from '../../lib/directComposer';
import type { ForwardMessage } from '../../lib/directConversationClient';

/**
 * Direct Conversation UX — the forward Conversation runtime view (Lite 12 §12).
 *
 * Presentational composition over the merged seams: the Message timeline, the single
 * streaming reply block, and the Composer with distinct Chat/Task/Run modes. A normal
 * Send creates no Task and no modifying Run; Task/Run are explicit composer actions.
 *
 * All data comes in through props and all user intent goes out through callbacks; the
 * component holds no fetch and no timers, so it is SSR-renderable and testable.
 */

export interface ConversationRuntimeViewProps {
  readonly theme: UiTheme;
  readonly conversationTitle: string;
  readonly conversationKind: string;
  readonly messages: readonly ForwardMessage[];
  readonly stream: ConversationStreamState;
  readonly composerMode: ComposerMode;
  readonly composerContent: string;
  readonly sending: boolean;
  readonly error?: string;
  readonly emptyConversationAction?: ReactNode;
  readonly onModeChange: (mode: ComposerMode) => void;
  readonly onContentChange: (content: string) => void;
  readonly onSend: () => void;
}

const MODE_LABELS: Readonly<Record<ComposerMode, string>> = Object.freeze({
  chat: 'Chat',
  task: 'Task',
  run: 'Run',
});

const MODE_HINTS: Readonly<Record<ComposerMode, string>> = Object.freeze({
  chat: 'Send a message; no Task or Run is created.',
  task: 'Create a Task from this message; nothing runs yet.',
  run: 'Start a Run from this message; admission applies.',
});

export function ConversationRuntimeView(props: ConversationRuntimeViewProps) {
  const {
    theme, conversationTitle, conversationKind, messages, stream,
    composerMode, composerContent, sending, error, emptyConversationAction,
    onModeChange, onContentChange, onSend,
  } = props;

  const streaming = stream.phase === 'connected' || stream.phase === 'resyncing' || stream.phase === 'reconnecting';
  const canSend = composerContent.trim().length > 0 && !sending;

  return (
    <div
      data-agentos="conversation-runtime-view"
      style={{
        ...uiCssVariables(theme),
        fontFamily: UI_FONT_STACK.ui,
        backgroundColor: 'var(--surface-base)',
        color: 'var(--text-primary)',
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
      }}
    >
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: `${UI_SPACING_BASE_PX * 2}px ${UI_SPACING_BASE_PX * 3}px`,
        borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)',
      }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{conversationTitle}</span>
        <span data-conversation-kind={conversationKind} style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{conversationKind}</span>
      </header>

      <div role="log" aria-label="Messages" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: UI_SPACING_BASE_PX * 3 }}>
        {messages.length === 0 && !streaming ? (
          <div style={{ color: 'var(--text-tertiary)', textAlign: 'center', paddingTop: UI_SPACING_BASE_PX * 10 }}>
            <p style={{ margin: 0 }}>No messages in {conversationTitle}.</p>
            {emptyConversationAction ?? null}
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {messages.map(message => (
              <li key={message.id} data-message-id={message.id} data-sender={message.senderType} style={{ marginBottom: UI_SPACING_BASE_PX * 3 }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>
                  {message.senderType === 'agent' ? (message.senderAgentId ?? 'agent') : message.senderType}
                  {' · '}{message.status}
                </div>
                <div style={{
                  backgroundColor: message.senderType === 'user' ? 'var(--surface-raised)' : 'var(--surface-subtle)',
                  border: '1px solid var(--border-subtle)', borderRadius: UI_RADIUS_TOKENS.card,
                  padding: `${UI_SPACING_BASE_PX * 2}px ${UI_SPACING_BASE_PX * 3}px`,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {message.content}
                </div>
              </li>
            ))}
            {streaming ? (
              <li data-agentos="streaming-block" aria-live="polite" style={{ marginBottom: UI_SPACING_BASE_PX * 3 }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>
                  agent · streaming · cursor {stream.lastCursor}
                </div>
                <div style={{
                  backgroundColor: 'var(--surface-subtle)', border: '1px solid var(--border-default)',
                  borderRadius: UI_RADIUS_TOKENS.card, padding: `${UI_SPACING_BASE_PX * 2}px ${UI_SPACING_BASE_PX * 3}px`,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}>
                  {stream.text}
                </div>
              </li>
            ) : null}
          </ul>
        )}
      </div>

      {error === undefined ? null : (
        <div role="alert" style={{ color: 'var(--status-danger)', padding: `0 ${UI_SPACING_BASE_PX * 3}px`, fontSize: 12 }}>{error}</div>
      )}

      <div style={{ borderTop: '1px solid var(--border-subtle)', padding: UI_SPACING_BASE_PX * 2 }}>
        <div role="radiogroup" aria-label="Composer mode" style={{ display: 'flex', gap: UI_SPACING_BASE_PX, marginBottom: UI_SPACING_BASE_PX }}>
          {COMPOSER_MODES.map(mode => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={composerMode === mode}
              data-mode={mode}
              onClick={() => onModeChange(mode)}
              style={{
                border: '1px solid var(--border-default)', borderRadius: UI_RADIUS_TOKENS.input,
                backgroundColor: composerMode === mode ? 'var(--accent-default)' : 'var(--surface-raised)',
                color: composerMode === mode ? '#fff' : 'var(--text-secondary)',
                padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 2}px`, cursor: 'pointer', fontSize: 12,
              }}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: UI_SPACING_BASE_PX }}>{MODE_HINTS[composerMode]}</div>
        <div style={{ display: 'flex', gap: UI_SPACING_BASE_PX, alignItems: 'flex-end' }}>
          <textarea
            aria-label="Message"
            value={composerContent}
            onChange={event => onContentChange(event.target.value)}
            placeholder={composerMode === 'chat' ? 'Message…' : composerMode === 'task' ? 'Describe the Task…' : 'Describe the Run…'}
            rows={2}
            style={{
              flex: 1, resize: 'vertical', borderRadius: UI_RADIUS_TOKENS.input,
              border: '1px solid var(--border-default)', backgroundColor: 'var(--surface-raised)',
              color: 'var(--text-primary)', padding: UI_SPACING_BASE_PX * 2, fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            data-agentos="composer-send"
            disabled={!canSend}
            onClick={onSend}
            style={{
              border: 'none', borderRadius: UI_RADIUS_TOKENS.input,
              backgroundColor: canSend ? 'var(--accent-default)' : 'var(--surface-raised)',
              color: canSend ? '#fff' : 'var(--text-disabled)',
              padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 3}px`, cursor: canSend ? 'pointer' : 'default',
            }}
          >
            {composerMode === 'chat' ? 'Send' : composerMode === 'task' ? 'Create Task' : 'Start Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
