import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { directConversationClient, type ForwardMessage } from '../../lib/directConversationClient';
import { useGroupConversation } from '../../lib/useGroupConversation';
import type { GroupInteractionBudgetInput } from '../../lib/groupConversationClient';
import { BoundedGroupView } from './BoundedGroupView';
import { MentionPicker, type MentionAgent } from './MentionPicker';
import { handleComposerKeyDown, submitComposer } from '../../lib/composerKeyboard';
import {
  UI_FONT_STACK,
  UI_SPACING_BASE_PX,
  UI_RADIUS_TOKENS,
  uiCssVariables,
  type UiTheme,
} from '../../lib/uiFoundation';

/**
 * Controlled Group Conversation canvas (Lite 12 §13) for a group Conversation on
 * the forward runtime page. The runtime selects the speakers; the user provides
 * the triggering Message and the budget, and watches the bounded walk live. The
 * walk is chat-class: it never creates a Task or Run.
 */

export interface GroupConversationCanvasProps {
  readonly theme: UiTheme;
  readonly workspaceId: string;
  readonly apiBase: string;
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly agents?: readonly MentionAgent[];
}

const DEFAULT_BUDGET: GroupInteractionBudgetInput = {
  maxAgentsPerTurn: 3,
  maxRepliesPerAgent: 2,
  maxTotalReplies: 6,
  maxAgentHops: 4,
};

function BudgetField(props: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: 'var(--text-tertiary)' }}>
      {props.label}
      <input
        type="number"
        min={1}
        value={props.value}
        onChange={event => props.onChange(Math.max(1, Number(event.target.value) || 1))}
        style={{
          backgroundColor: 'var(--surface-raised)', color: 'var(--text-primary)',
          border: '1px solid var(--border-default)', borderRadius: UI_RADIUS_TOKENS.input,
          padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 2}px`, fontSize: 12, width: 72,
        }}
      />
    </label>
  );
}
export function GroupConversationCanvas(props: GroupConversationCanvasProps) {
  const group = useGroupConversation(props.workspaceId, props.apiBase, props.conversationId);
  const direct = useMemo(
    () => directConversationClient({ workspaceId: props.workspaceId, apiBase: props.apiBase }),
    [props.workspaceId, props.apiBase],
  );
  const [content, setContent] = useState('');
  const [budget, setBudget] = useState<GroupInteractionBudgetInput>(DEFAULT_BUDGET);
  const [sendError, setSendError] = useState<string | undefined>(undefined);
  const [messages, setMessages] = useState<readonly ForwardMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [mentionedAgentIds, setMentionedAgentIds] = useState<string[]>([]);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const refreshMessages = useCallback(async () => {
    if (!props.conversationId) return;
    setLoadingMessages(true);
    try {
      const result = await direct.listMessages(props.conversationId);
      setMessages(result.messages);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingMessages(false);
    }
  }, [direct, props.conversationId]);

  useEffect(() => {
    setContent('');
    setMessages([]);
    setMentionedAgentIds([]);
    setSendError(undefined);
    void refreshMessages();
  }, [props.conversationId, refreshMessages]);

  const updateBudget = (key: keyof GroupInteractionBudgetInput) => (value: number) =>
    setBudget(current => ({ ...current, [key]: value }));

  const canSend = content.trim().length > 0 && !group.busy;

  const send = async () => {
    if (!canSend) return;
    setSendError(undefined);
    const selectedMentions = [...mentionedAgentIds];
    try {
      // Persist the user Message first, then open the bounded interaction and run
      // the walk against exactly that Message.
      const { message } = await direct.sendMessage(props.conversationId, content.trim());
      setMessages(current => [...current, message]);
      setContent('');
      setMentionedAgentIds([]);
      const created = await group.start(budget);
      if (created === null) return;
      await group.run(created.id, message.id, selectedMentions);
      await refreshMessages();
    } catch (sendErr) {
      setSendError(sendErr instanceof Error ? sendErr.message : String(sendErr));
    }
  };

  const interaction = group.interaction;
  const walking = group.walk.phase === 'walking';

  return (
    <div
      data-agentos="group-conversation-canvas"
      style={{
        ...uiCssVariables(props.theme),
        fontFamily: UI_FONT_STACK.ui,
        backgroundColor: 'var(--surface-base)',
        color: 'var(--text-primary)',
        display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
      }}
    >
      <header style={{ padding: UI_SPACING_BASE_PX * 2, borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ fontWeight: 600 }}>{props.conversationTitle}</span>
        <span style={{ marginLeft: UI_SPACING_BASE_PX * 2, fontSize: 11, color: 'var(--text-tertiary)' }}>
          bounded group
        </span>
      </header>
      <div style={{ flex: 1, overflow: 'auto', padding: UI_SPACING_BASE_PX * 2 }}>
        <section data-agentos="group-message-history" aria-label="群聊消息" style={{ marginBottom: UI_SPACING_BASE_PX * 2 }}>
          {loadingMessages ? <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Loading messages…</div> : null}
          {messages.map(message => {
            const sender = message.senderAgentId === null
              ? 'You'
              : props.agents?.find(agent => agent.id === message.senderAgentId)?.name ?? message.senderAgentId;
            return (
              <article key={message.id} data-message-id={message.id} style={{ marginBottom: UI_SPACING_BASE_PX * 2 }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>{sender}</div>
                <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{message.content}</div>
              </article>
            );
          })}
        </section>
        {interaction === null ? (
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Set a reply budget, then send a Message to open a bounded group interaction.
          </div>
        ) : (
          <>
            <BoundedGroupView
              theme={props.theme}
              interaction={{
                id: interaction.id,
                status: interaction.status,
                stopReason: interaction.stopReason,
                loopGuardSignal: interaction.loopGuardSignal,
              }}
              budget={{
                repliesUsed: group.budget?.repliesUsed ?? 0,
                repliesRemaining: group.budget?.repliesRemaining ?? 0,
                hopsUsed: group.budget?.hopsUsed ?? 0,
                hopsRemaining: group.budget?.hopsRemaining ?? 0,
                distinctAgents: group.budget?.distinctAgents ?? 0,
                agentsRemaining: group.budget?.agentsRemaining ?? 0,
              }}
              replies={[...group.replies]}
              stopping={group.busy}
              {...(group.error === undefined ? {} : { error: group.error })}
              onStop={() => { void group.stop(); }}
            />

            {group.walk.speakers.length === 0 && group.walk.skipped.length === 0 ? null : (
              <section data-agentos="group-walk" style={{ marginTop: UI_SPACING_BASE_PX * 2, fontSize: 12 }}>
                {group.walk.speakers.map(speaker => (
                  <div key={speaker.turnId} data-agentos="group-turn" data-status={speaker.status}
                    style={{ padding: `${UI_SPACING_BASE_PX}px 0`, borderBottom: '1px solid var(--border-subtle)' }}>
                    <span style={{ fontFamily: UI_FONT_STACK.code, color: 'var(--text-tertiary)' }}>{speaker.agentId}</span>
                    {' '}{speaker.status}
                    {speaker.content === '' ? null : (
                      <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', marginTop: 2 }}>
                        {speaker.content}
                      </div>
                    )}
                  </div>
                ))}
                {group.walk.skipped.map(skip => (
                  <div key={`${skip.agentId}:${skip.reason}`} data-agentos="group-skip"
                    style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                    {skip.agentId ?? 'unknown'} skipped: {skip.reason}
                  </div>
                ))}
                {group.walk.endedBy === null ? null : (
                  <div data-agentos="group-walk-end" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: UI_SPACING_BASE_PX }}>
                    ended: {group.walk.endedBy}
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>

      <footer style={{ borderTop: '1px solid var(--border-subtle)', padding: UI_SPACING_BASE_PX * 2 }}>
        {props.agents && props.agents.length > 0 ? (
          <MentionPicker agents={props.agents} selectedAgentIds={mentionedAgentIds} disabled={group.busy} onChange={setMentionedAgentIds} />
        ) : null}
        <div style={{ display: 'flex', gap: UI_SPACING_BASE_PX * 2, marginBottom: UI_SPACING_BASE_PX * 2, flexWrap: 'wrap' }}>
          <BudgetField label="agents" value={budget.maxAgentsPerTurn} onChange={updateBudget('maxAgentsPerTurn')} />
          <BudgetField label="replies/agent" value={budget.maxRepliesPerAgent} onChange={updateBudget('maxRepliesPerAgent')} />
          <BudgetField label="total replies" value={budget.maxTotalReplies} onChange={updateBudget('maxTotalReplies')} />
          <BudgetField label="hops" value={budget.maxAgentHops} onChange={updateBudget('maxAgentHops')} />
        </div>
        <div style={{ display: 'flex', gap: UI_SPACING_BASE_PX * 2, alignItems: 'flex-end' }}>
          <textarea
            ref={composerRef}
            aria-label="Message the group"
            aria-describedby="group-composer-hint"
            aria-keyshortcuts="Enter"
            value={content}
            onChange={event => setContent(event.target.value)}
            onKeyDown={event => handleComposerKeyDown(event, {
              canSend,
              onSend: () => { void send(); },
              focus: () => composerRef.current?.focus(),
            })}
            placeholder="Message the group…"
            data-agentos="group-composer"
            rows={1}
            style={{
              flex: 1, backgroundColor: 'var(--surface-raised)', color: 'var(--text-primary)',
              border: '1px solid var(--border-default)', borderRadius: UI_RADIUS_TOKENS.input,
              padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 2}px`, fontSize: 13, resize: 'vertical',
            }}
          />
          <button
            type="button"
            data-agentos="group-send"
            disabled={!canSend}
            onClick={() => submitComposer({
              canSend,
              onSend: () => { void send(); },
              focus: () => composerRef.current?.focus(),
            })}
            style={{
              border: '1px solid var(--border-strong)', borderRadius: UI_RADIUS_TOKENS.input,
              backgroundColor: 'var(--accent-default)', color: 'var(--text-primary)',
              padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 3}px`, cursor: 'pointer', fontSize: 13,
            }}
          >
            {walking ? 'Running…' : 'Send'}
          </button>
        </div>
        <div id="group-composer-hint" style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: UI_SPACING_BASE_PX }}>
          Enter sends · Shift+Enter adds a line
        </div>
        {(sendError === undefined && group.error === undefined) ? null : (
          <div role="alert" style={{ color: 'var(--status-danger)', fontSize: 12, marginTop: UI_SPACING_BASE_PX }}>
            {sendError ?? group.error}
          </div>
        )}
      </footer>
    </div>
  );
}
