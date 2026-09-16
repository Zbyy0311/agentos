'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  directConversationClient,
  type DirectConversationClient,
  type ForwardConversation,
  type ForwardMessage,
} from './directConversationClient';
import { DirectConversationController } from './directConversationController';
import type { ConversationStreamState } from './directConversationStream';
import type { ComposerMode } from './directComposer';
import type { AgentSummary } from '../components/chat/DirectConversationWorkbench';

export interface RuntimeGroupCreateInput {
  readonly title: string;
  readonly memberAgentIds: readonly string[];
}

/**
 * Direct Conversation UX — the React binding for the forward runtime.
 *
 * Owns view state only (selection, drafts, panel state): conversations, messages,
 * the reply stream, and composer mode. All durable state lives on the Server; the
 * controller drives send/stream/reconnect and this hook reflects it into React.
 */

const IDLE_STREAM: ConversationStreamState = {
  phase: 'idle', turnId: null, messageId: null, lastCursor: 0, text: '',
  checkpointCount: 0, finalMessageStatus: null, failureCode: null, terminal: false,
};

export function useDirectConversation(workspaceId: string, apiBase: string) {
  const client: DirectConversationClient = useMemo(
    () => directConversationClient({ workspaceId, apiBase }),
    [workspaceId, apiBase],
  );
  const [conversations, setConversations] = useState<ForwardConversation[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ForwardMessage[]>([]);
  const [stream, setStream] = useState<ConversationStreamState>(IDLE_STREAM);
  const [mode, setMode] = useState<ComposerMode>('chat');
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const controller = useMemo(() => new DirectConversationController({
    client,
    onState: setStream,
    onMessages: items => setMessages([...items]),
  }), [client]);

  useEffect(() => {
    let cancelled = false;
    client.listConversations()
      .then(result => {
        if (cancelled) return;
        setConversations(result.conversations);
        setActiveConversationId(current => current !== null && result.conversations.some(item => item.id === current)
          ? current
          : result.conversations[0]?.id ?? null);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    client.listAgents()
      .then(result => {
        if (cancelled) return;
        const nextAgents = result.agents.filter(a => a.enabled !== false).map(a => ({
          id: a.id, name: a.name, ...(a.status === undefined ? {} : { status: a.status }),
        }));
        setAgents(nextAgents);
        setActiveAgentId(current => current !== null && nextAgents.some(agent => agent.id === current)
          ? current
          : nextAgents[0]?.id ?? null);
      })
      .catch(e => {
        if (!cancelled) {
          setAgents([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => { cancelled = true; };
  }, [apiBase, workspaceId]);

  useEffect(() => {
    if (activeConversationId === null) return;
    let cancelled = false;
    setError(undefined);
    controller.loadMessages(activeConversationId).catch(e => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { cancelled = true; };
  }, [activeConversationId, controller]);

  const selectConversation = useCallback((id: string) => {
    setActiveConversationId(id);
  }, []);

  const selectAgent = useCallback((id: string) => {
    setActiveAgentId(id);
  }, []);

  const createConversation = useCallback(async (body: Record<string, unknown> = {}) => {
    const payload = { kind: 'direct', agentId: activeAgentId, ...body };
    if (payload.kind === 'direct' && typeof payload.agentId !== 'string') {
      setError('Select an enabled Agent before creating a Conversation.');
      return null;
    }
    setError(undefined);
    try {
      const result = await client.createConversation(payload);
      setConversations(previous => [result.conversation, ...previous]);
      setActiveConversationId(result.conversation.id);
      return result.conversation;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [activeAgentId, client]);

  const createGroupConversation = useCallback(async (input: RuntimeGroupCreateInput) => {
    const title = input.title.trim();
    const memberAgentIds = [...new Set(input.memberAgentIds)];
    const enabledAgentIds = new Set(agents.map(agent => agent.id));
    if (title.length === 0) {
      setError('Enter a title before creating a group Conversation.');
      return null;
    }
    if (memberAgentIds.length < 2 || memberAgentIds.some(id => !enabledAgentIds.has(id))) {
      setError('Select at least two enabled Agents before creating a group Conversation.');
      return null;
    }
    setError(undefined);
    try {
      const result = await client.createConversation({
        kind: 'group',
        replyMode: 'sequential',
        title,
        memberAgentIds,
      });
      setConversations(previous => [
        result.conversation,
        ...previous.filter(item => item.id !== result.conversation.id),
      ]);
      setActiveConversationId(result.conversation.id);
      return result.conversation;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [agents, client]);

  const send = useCallback(async () => {
    if (activeConversationId === null || content.trim().length === 0) return;
    setSending(true);
    setError(undefined);
    try {
      await controller.send(activeConversationId, { mode, content });
      setContent('');
      await controller.loadMessages(activeConversationId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }, [controller, activeConversationId, mode, content]);

  return {
    conversations, agents, activeAgentId, activeConversationId, messages, stream, mode, content, sending, error,
    selectAgent, selectConversation, createConversation, createGroupConversation, setMode, setContent, send,
  };
}

export type DirectConversationState = ReturnType<typeof useDirectConversation>;
