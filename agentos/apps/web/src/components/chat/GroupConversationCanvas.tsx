import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { directConversationClient, type ForwardMessage } from '../../lib/directConversationClient';
import { useGroupConversation } from '../../lib/useGroupConversation';
import type { GroupInteractionBudgetInput } from '../../lib/groupConversationClient';
import { isGroupRecoveryDispatchCurrent } from '../../lib/groupConversationScope';
import { BoundedGroupView } from './BoundedGroupView';
import { GroupInteractionRecoveryPanel } from './GroupInteractionRecoveryPanel';
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
    const expected = group.scope;
    if (!expected.conversationId || !group.isCurrentScope(expected)) return;
    setLoadingMessages(true);
    try {
      const result = await direct.listMessages(expected.conversationId);
      if (group.isCurrentScope(expected)) setMessages(result.messages);
    } catch (error) {
      if (group.isCurrentScope(expected)) setSendError(error instanceof Error ? error.message : String(error));
    } finally {
      if (group.isCurrentScope(expected)) setLoadingMessages(false);
    }
  }, [direct, group.scope, group.isCurrentScope]);

  useEffect(() => {
    setLoadingMessages(false);
    setContent('');
    setMessages([]);
    setMentionedAgentIds([]);
    setSendError(undefined);
    void refreshMessages();
  }, [props.workspaceId, props.apiBase, props.conversationId, refreshMessages]);

  const updateBudget = (key: keyof GroupInteractionBudgetInput) => (value: number) =>
    setBudget(current => ({ ...current, [key]: value }));

  const interaction = group.scopeReady ? group.interaction : null;
  const ownerUnknownForUnusableInteraction = interaction?.integrityStatus === 'unusable'
    && (group.executionOwner?.status !== 'interrupted' || !Number.isSafeInteger(group.executionOwner.ownerEpoch) || group.executionOwner.ownerEpoch < 1);
  const canSend = group.scopeReady && content.trim().length > 0 && !group.busy && interaction?.status !== 'active';

  const send = async () => {
    const expected = group.scope;
    if (!canSend || !group.isCurrentScope(expected) || !expected.conversationId) return;
    setSendError(undefined);
    const selectedMentions = [...mentionedAgentIds];
    try {
      // Persist the user Message first, then open the bounded interaction and run
      // the walk against exactly that Message.
      const { message } = await direct.sendMessage(expected.conversationId, content.trim());
      if (!group.isCurrentScope(expected)) return;
      setMessages(current => [...current, message]);
      setContent('');
      setMentionedAgentIds([]);
      const created = await group.start(budget);
      if (created === null || !group.isCurrentScope(expected)) return;
      await group.run(created.id, message.id, selectedMentions);
      if (group.isCurrentScope(expected)) await refreshMessages();
    } catch (sendErr) {
      if (group.isCurrentScope(expected)) setSendError(sendErr instanceof Error ? sendErr.message : String(sendErr));
    }
  };

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
          {group.scopeReady && loadingMessages ? <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Loading messages…</div> : null}
          {(group.scopeReady ? messages : []).map(message => {
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
                status: interaction.integrityStatus === 'unusable' ? 'interrupted' : interaction.status,
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
              stopping={group.busy || ownerUnknownForUnusableInteraction}
              {...(group.error === undefined ? {} : { error: group.error })}
              onStop={() => { void group.stop(); }}
            />

            {group.scopeReady && interaction.status === 'active' && interaction.integrityStatus === 'unusable'
              && group.executionOwner?.status === 'interrupted' && group.executionOwner.ownerEpoch > 0 ? (
                <GroupInteractionRecoveryPanel
                  workspaceId={props.workspaceId}
                  apiBase={props.apiBase}
                  identityKey={JSON.stringify([props.workspaceId, props.conversationId])}
                  conversationId={props.conversationId}
                  generation={group.scope.generation}
                  interactionId={interaction.id}
                  interactionVersion={interaction.version}
                  ownerEpoch={group.executionOwner.ownerEpoch}
                  dispatchManagedByCaller
                  canDispatch={identity => isGroupRecoveryDispatchCurrent(identity, group.scope, interaction.id)
                    && group.isCurrentScope(group.scope)}
                  onRecovered={async (result, dispatch, identity) => {
                    const expected = group.scope;
                    const sourceMessageId = result.message.id;
                    if (!isGroupRecoveryDispatchCurrent(identity, expected, interaction.id)
                      || result.interaction.id === interaction.id
                      || result.interaction.conversationId !== expected.conversationId
                      || result.interaction.sourceMessageId !== sourceMessageId
                      || !group.isCurrentScope(expected)) return;
                    if (!dispatch.markResponding()) return;
                    await group.run(result.interaction.id, sourceMessageId, result.participantAgentIds, result.message.clientMessageId);
                    if (group.isCurrentScope(expected)) await refreshMessages();
                  }}
                />
              ) : null}

            {ownerUnknownForUnusableInteraction && <div role="status" style={{ marginTop: UI_SPACING_BASE_PX, fontSize: 12, color: 'var(--text-tertiary)' }}>
              执行 owner 状态未知或未确认中断；已保留历史，恢复和停止操作均已禁用。
            </div>}

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
            placeholder={interaction?.status === 'active' ? 'Finish or recover the active round above before sending another message…' : 'Message the group…'}
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
