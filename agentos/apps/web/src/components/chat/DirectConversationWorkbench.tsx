'use client';

import type { ReactNode } from 'react';
import { WorkbenchShell } from '../layout/WorkbenchShell.js';
import { ConversationRuntimeView } from '../chat/ConversationRuntimeView.js';
import type { UiTheme } from '../../lib/uiFoundation.js';
import { UI_SPACING_BASE_PX, UI_RADIUS_TOKENS } from '../../lib/uiFoundation.js';
import type { ConversationStreamState } from '../../lib/directConversationStream.js';
import type { ComposerMode } from '../../lib/directComposer.js';
import type { ForwardConversation, ForwardMessage } from '../../lib/directConversationClient.js';

/**
 * Direct Conversation UX — the composed four-column workbench (Lite 12 §5).
 *
 * Wires the shell to the forward runtime: Agents and Conversations columns feed the
 * Canvas (ConversationRuntimeView), and the Inspector shows the active reply stream
 * state. Presentational: data in through props, intent out through callbacks.
 */

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
}

export interface DirectConversationWorkbenchProps {
  readonly theme: UiTheme;
  readonly viewportWidth: number;
  readonly reducedMotion?: boolean;
  readonly workspaceName: string;
  readonly agents: readonly AgentSummary[];
  readonly conversations: readonly ForwardConversation[];
  readonly activeConversationId: string | null;
  readonly activeConversationTitle: string;
  readonly activeConversationKind: string;
  readonly messages: readonly ForwardMessage[];
  readonly stream: ConversationStreamState;
  readonly composerMode: ComposerMode;
  readonly composerContent: string;
  readonly sending: boolean;
  readonly error?: string;
  readonly onSelectConversation: (id: string) => void;
  readonly onCreateConversation: () => void;
  readonly onModeChange: (mode: ComposerMode) => void;
  readonly onContentChange: (content: string) => void;
  readonly onSend: () => void;
}

function ColumnHeader(props: { readonly title: string; readonly action?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span>{props.title}</span>
      {props.action ?? null}
    </div>
  );
}

export function DirectConversationWorkbench(props: DirectConversationWorkbenchProps) {
  const listItemStyle = (active: boolean) => ({
    display: 'block', width: '100%', textAlign: 'left' as const, border: 'none',
    backgroundColor: active ? 'var(--surface-selected)' : 'transparent',
    color: 'var(--text-primary)', padding: `${UI_SPACING_BASE_PX * 2}px`,
    borderRadius: UI_RADIUS_TOKENS.row, cursor: 'pointer',
  });

  const agentsColumn = (
    <div style={{ padding: UI_SPACING_BASE_PX }}>
      {props.agents.map(agent => (
        <div key={agent.id} style={{ ...listItemStyle(false), cursor: 'default' }}>
          <span>{agent.name}</span>
          {agent.status === undefined ? null : (
            <span style={{ float: 'right', fontSize: 10, color: 'var(--text-tertiary)' }}>{agent.status}</span>
          )}
        </div>
      ))}
    </div>
  );

  const conversationsColumn = (
    <div style={{ padding: UI_SPACING_BASE_PX }}>
      {props.conversations.map(conversation => (
        <button
          key={conversation.id}
          type="button"
          data-conversation={conversation.id}
          aria-current={conversation.id === props.activeConversationId}
          onClick={() => props.onSelectConversation(conversation.id)}
          style={listItemStyle(conversation.id === props.activeConversationId)}
        >
          <span>{conversation.title}</span>
          <span style={{ float: 'right', fontSize: 10, color: 'var(--text-tertiary)' }}>{conversation.kind}</span>
        </button>
      ))}
    </div>
  );

  const canvasColumn = (
    <ConversationRuntimeView
      theme={props.theme}
      conversationTitle={props.activeConversationTitle}
      conversationKind={props.activeConversationKind}
      messages={props.messages}
      stream={props.stream}
      composerMode={props.composerMode}
      composerContent={props.composerContent}
      sending={props.sending}
      {...(props.error === undefined ? {} : { error: props.error })}
      onModeChange={props.onModeChange}
      onContentChange={props.onContentChange}
      onSend={props.onSend}
    />
  );

  const inspectorColumn = (
    <div style={{ padding: UI_SPACING_BASE_PX * 2, color: 'var(--text-secondary)', fontSize: 12 }}>
      <ColumnHeader title="Runtime" />
      <dl style={{ margin: 0, display: 'grid', rowGap: UI_SPACING_BASE_PX }}>
        <div><dt style={{ color: 'var(--text-tertiary)' }}>stream</dt><dd style={{ margin: 0 }}>{props.stream.phase}</dd></div>
        <div><dt style={{ color: 'var(--text-tertiary)' }}>cursor</dt><dd style={{ margin: 0 }}>{props.stream.lastCursor}</dd></div>
        <div><dt style={{ color: 'var(--text-tertiary)' }}>checkpoints</dt><dd style={{ margin: 0 }}>{props.stream.checkpointCount}</dd></div>
      </dl>
    </div>
  );

  return (
    <WorkbenchShell
      theme={props.theme}
      viewportWidth={props.viewportWidth}
      {...(props.reducedMotion === undefined ? {} : { reducedMotion: props.reducedMotion })}
      agents={agentsColumn}
      conversations={conversationsColumn}
      canvas={canvasColumn}
      inspector={inspectorColumn}
    />
  );
}
