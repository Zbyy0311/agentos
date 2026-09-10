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
      .then(result => { if (!cancelled) setConversations(result.conversations); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${apiBase}/api/workspaces/${encodeURIComponent(workspaceId)}/agents`)
      .then(response => response.ok ? response.json() as Promise<{ agents: Array<{ id: string; name: string; enabled?: boolean }> }> : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(result => { if (!cancelled) setAgents(result.agents.filter(a => a.enabled !== false).map(a => ({ id: a.id, name: a.name }))); })
      .catch(() => { if (!cancelled) setAgents([]); });
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

  const createConversation = useCallback(async (body: Record<string, unknown>) => {
    const result = await client.createConversation(body);
    setConversations(previous => [result.conversation, ...previous]);
    setActiveConversationId(result.conversation.id);
    return result.conversation;
  }, [client]);

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
    conversations, agents, activeConversationId, messages, stream, mode, content, sending, error,
    selectConversation, createConversation, setMode, setContent, send,
  };
}

export type DirectConversationState = ReturnType<typeof useDirectConversation>;

