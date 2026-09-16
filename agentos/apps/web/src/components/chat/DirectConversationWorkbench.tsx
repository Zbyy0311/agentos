'use client';

import type { ReactNode } from 'react';
import { WorkbenchShell } from '../layout/WorkbenchShell';
import { ConversationRuntimeView } from '../chat/ConversationRuntimeView';
import { GroupConversationCanvas } from '../chat/GroupConversationCanvas';
import type { UiTheme } from '../../lib/uiFoundation';
import { UI_SPACING_BASE_PX, UI_RADIUS_TOKENS } from '../../lib/uiFoundation';
import type { ConversationStreamState } from '../../lib/directConversationStream';
import type { ComposerMode } from '../../lib/directComposer';
import type { ForwardConversation, ForwardMessage } from '../../lib/directConversationClient';
import { dispatchWorkbenchAction } from '../../lib/workbenchInteractions';

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
  readonly inspector?: ReactNode;
  readonly toolbar?: ReactNode;
  readonly theme: UiTheme;
  readonly viewportWidth: number;
  readonly workspaceId: string;
  readonly apiBase: string;
  readonly reducedMotion?: boolean;
  readonly workspaceName: string;
  readonly agents: readonly AgentSummary[];
  readonly activeAgentId: string | null;
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
  readonly onSelectAgent: (id: string) => void;
  readonly onSelectConversation: (id: string) => void;
  readonly onCreateConversation: () => void;
  readonly onCreateGroupConversation?: () => void;
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
      <div role="list" aria-label="Agents">
        {props.agents.map(agent => (
          <div key={agent.id} role="listitem">
            <button
              type="button"
              data-agent={agent.id}
              aria-current={agent.id === props.activeAgentId}
              onClick={() => dispatchWorkbenchAction(
                { kind: 'select-agent', id: agent.id },
                {
                  onSelectAgent: props.onSelectAgent,
                  onSelectConversation: props.onSelectConversation,
                  onCreateConversation: props.onCreateConversation,
                },
              )}
              style={listItemStyle(agent.id === props.activeAgentId)}
            >
              <span>{agent.name}</span>
              {agent.status === undefined ? null : (
                <span style={{ float: 'right', fontSize: 10, color: 'var(--text-tertiary)' }}>{agent.status}</span>
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  const conversationsColumn = (
    <div style={{ padding: UI_SPACING_BASE_PX }}>
      <ColumnHeader
        title="Conversations"
        action={(
          <span style={{ display: 'inline-flex', gap: UI_SPACING_BASE_PX }}>
            <button
              type="button"
              data-agentos="new-conversation"
              aria-label="New Conversation"
              disabled={props.agents.length === 0}
              onClick={() => dispatchWorkbenchAction(
                { kind: 'create-conversation' },
                {
                  onSelectAgent: props.onSelectAgent,
                  onSelectConversation: props.onSelectConversation,
                  onCreateConversation: props.onCreateConversation,
                },
              )}
              style={{
                border: '1px solid var(--border-default)', borderRadius: UI_RADIUS_TOKENS.input,
                backgroundColor: 'var(--surface-raised)', color: 'var(--text-primary)', cursor: 'pointer',
                padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 2}px`, fontSize: 12,
              }}
            >
              +
            </button>
            {props.onCreateGroupConversation === undefined ? null : (
              <button
                type="button"
                data-agentos="new-group-conversation"
                aria-label="New Group Conversation"
                disabled={props.agents.length < 2}
                onClick={props.onCreateGroupConversation}
                style={{
                  border: '1px solid var(--border-default)', borderRadius: UI_RADIUS_TOKENS.input,
                  backgroundColor: 'var(--surface-raised)', color: 'var(--text-primary)', cursor: 'pointer',
                  padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 2}px`, fontSize: 12,
                }}
              >
                Group
              </button>
            )}
          </span>
        )}
      />
      <div role="list" aria-label="Conversations">
      {props.conversations.map(conversation => (
        <div key={conversation.id} role="listitem">
          <button
            type="button"
            data-conversation={conversation.id}
            aria-current={conversation.id === props.activeConversationId}
            onClick={() => dispatchWorkbenchAction(
              { kind: 'select-conversation', id: conversation.id },
              {
                onSelectAgent: props.onSelectAgent,
                onSelectConversation: props.onSelectConversation,
                onCreateConversation: props.onCreateConversation,
              },
            )}
            style={listItemStyle(conversation.id === props.activeConversationId)}
          >
            <span>{conversation.title}</span>
            <span style={{ float: 'right', fontSize: 10, color: 'var(--text-tertiary)' }}>{conversation.kind}</span>
          </button>
        </div>
      ))}
      </div>
    </div>
  );

  // A group Conversation gets the bounded group canvas (it owns its own composer
  // and its bounded walk); a direct Conversation keeps the reply stream canvas.
  const canvasColumn = props.activeConversationKind === 'group'
    ? (
      <GroupConversationCanvas
        theme={props.theme}
        workspaceId={props.workspaceId}
        apiBase={props.apiBase}
        conversationId={props.activeConversationId ?? ''}
        conversationTitle={props.activeConversationTitle}
        agents={props.agents}
      />
    )
    : (
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
      {...(props.toolbar === undefined ? {} : { toolbar: props.toolbar })}
      {...(props.reducedMotion === undefined ? {} : { reducedMotion: props.reducedMotion })}
      agents={agentsColumn}
      conversations={conversationsColumn}
      canvas={canvasColumn}
      inspector={props.inspector ?? inspectorColumn}
    />
  );
}
