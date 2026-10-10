'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentPresence, AgentProfile, Conversation, ThinkingEffort, Workspace } from '@agentos/shared';
import type { WorkspaceApiRequest } from './useConversationStream';
import { indexPresence } from './agentPresence';
import type { DirectConversationClient } from './directConversationClient';
import { toUiGroupConversation } from './uiGroupConversation';
import { getActiveConversationId } from './conversationSelection';

export interface WorkspaceDataOptions {
  workspaceId: string | null;
  runtimeClient: DirectConversationClient | null;
  request: WorkspaceApiRequest;
  returnConversationId: string | null;
  returnConversationSource: 'workspace' | 'runtime';
  returnConversationSourceParameter: string | null;
  /** Shared feedback setter for fatal workspace load failures. */
  onLoadError(message: string): void;
  notifyError(error: unknown, fallback?: string): void;
  /** Shared page-level error text written by the URL selection resolver. */
  setConversationSelectionError(message: string): void;
}

/**
 * Owns the workspace shell data and the conversation/agent selection state:
 * workspace profile, agents, presence, direct conversations, runtime groups,
 * their loaders/refreshers, and URL-driven selection restoration.
 */
export function useWorkspaceData(options: WorkspaceDataOptions) {
  const {
    workspaceId, runtimeClient, request,
    returnConversationId, returnConversationSource, returnConversationSourceParameter,
    onLoadError, notifyError, setConversationSelectionError,
  } = options;
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [presence, setPresence] = useState<Record<string, AgentPresence>>({});
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Conversation[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedDirectConversationId, setSelectedDirectConversationId] = useState<string | null>(null);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [urlSelectionState, setUrlSelectionStateInternal] = useState<{
    readonly key: string; readonly status: 'found'; readonly source: 'workspace' | 'runtime';
  } | { readonly key: string; readonly status: 'missing' } | null>(null);
  const conversationListGenerationRef = useRef(0);
  const selectedAgentIdRef = useRef(selectedAgentId);
  selectedAgentIdRef.current = selectedAgentId;

  const selectedAgent = agents.find(agent => agent.id === selectedAgentId);
  const activeConversationId = getActiveConversationId({ selectedGroupId, selectedDirectConversationId });
  const selectedConversation = selectedGroupId
    ? groups.find(conversation => conversation.id === selectedGroupId)
    : conversations.find(conversation => conversation.id === selectedDirectConversationId);
  const activeConversationSource = selectedConversation?.type === 'group' ? 'runtime' : 'workspace';
  const explicitSelectionKey = returnConversationId ? `${workspaceId ?? ''}:${returnConversationSourceParameter ?? 'legacy'}:${returnConversationId}` : null;
  const urlSelectionStatus = !explicitSelectionKey ? 'none'
    : urlSelectionState?.key !== explicitSelectionKey ? 'pending' : urlSelectionState.status;
  const explicitSelectionVerified = urlSelectionStatus === 'none' || (urlSelectionStatus === 'found'
    && urlSelectionState?.status === 'found' && selectedConversation?.id === returnConversationId
    && activeConversationSource === urlSelectionState.source);

  const loadGroups = useCallback(async () => {
    if (!runtimeClient) return;
    const result = await runtimeClient.listConversations();
    setGroups(result.conversations.filter(conversation => conversation.kind === 'group' && conversation.status !== 'archived'
      && (conversation.workspaceId === undefined || conversation.workspaceId === workspaceId)).map(toUiGroupConversation));
    setGroupsLoaded(true);
  }, [runtimeClient, workspaceId]);

  const loadPresence = useCallback(async () => {
    if (!workspaceId) return;
    const result = await request<{ presence: AgentPresence[] }>(`/api/workspaces/${workspaceId}/agents/presence`);
    setPresence(Object.fromEntries(indexPresence(result.presence)));
  }, [request, workspaceId]);

  const loadConversations = useCallback(async (agentId: string) => {
    if (!workspaceId) return;
    const generation = ++conversationListGenerationRef.current;
    const result = await request<{ conversations: Conversation[] }>(`/api/workspaces/${workspaceId}/conversations?agentId=${encodeURIComponent(agentId)}`);
    if (generation !== conversationListGenerationRef.current || selectedAgentIdRef.current !== agentId) return;
    const ownedConversations = result.conversations.filter(conversation => conversation.workspaceId === workspaceId && conversation.agentId === agentId && conversation.type === 'direct');
    setConversations(ownedConversations);
    const explicitTarget = returnConversationId
      ? ownedConversations.find(conversation => conversation.id === returnConversationId)
      : undefined;
    setSelectedDirectConversationId(current => explicitTarget?.id ?? (returnConversationId ? null
      : ownedConversations.some(conversation => conversation.id === current) ? current : ownedConversations[0]?.id ?? null));
  }, [request, returnConversationId, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    Promise.all([
      request<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`),
      request<{ agents: AgentProfile[] }>(`/api/workspaces/${workspaceId}/agents`),
    ]).then(([workspaceResult, agentResult]) => {
      if (cancelled) return;
      setWorkspace(workspaceResult.workspace);
      setAgents(agentResult.agents);
      setSelectedAgentId(current => current && agentResult.agents.some(agent => agent.id === current) ? current : agentResult.agents[0]?.id ?? null);
      void loadGroups().catch(loadError => notifyError(loadError, '加载群聊失败'));
      void loadPresence().catch(loadError => notifyError(loadError, '加载 Agent 状态失败'));
    }).catch(loadError => { if (!cancelled) onLoadError(loadError instanceof Error ? loadError.message : String(loadError)); });
    return () => { cancelled = true; };
  }, [loadGroups, loadPresence, notifyError, onLoadError, request, workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let timer: number | undefined;
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadPresence().catch(() => undefined);
    };
    const syncTimer = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = document.visibilityState === 'visible' ? window.setInterval(refresh, 15_000) : undefined;
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', syncTimer);
    syncTimer();
    return () => {
      document.removeEventListener('visibilitychange', syncTimer);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [loadPresence, workspaceId]);

  useEffect(() => {
    if (selectedAgentId && explicitSelectionVerified && !selectedGroupId) void loadConversations(selectedAgentId).catch(loadError => { if (selectedAgentIdRef.current === selectedAgentId) notifyError(loadError, '加载会话失败'); });
    return () => { conversationListGenerationRef.current += 1; };
  }, [explicitSelectionVerified, loadConversations, notifyError, selectedAgentId, selectedGroupId]);


  useEffect(() => {
    if (!explicitSelectionKey) {
      setConversationSelectionError('');
      return;
    }
    let cancelled = false;
    setConversationSelectionError('');
    if (returnConversationSourceParameter !== null && returnConversationSourceParameter !== 'workspace' && returnConversationSourceParameter !== 'runtime') {
      setSelectedGroupId(null);
      setSelectedDirectConversationId(null);
      setUrlSelectionStateInternal({ key: explicitSelectionKey, status: 'missing' });
      setConversationSelectionError('指定的会话来源无法识别；没有切换到其他会话。');
      return undefined;
    }
    if (returnConversationSource === 'runtime') {
      if (!groupsLoaded) return undefined;
      const target = groups.find(conversation => conversation.id === returnConversationId && conversation.type === 'group');
      if (target) {
        setSelectedGroupId(target.id);
        setSelectedDirectConversationId(null);
        setSelectedAgentId(null);
        setUrlSelectionStateInternal({ key: explicitSelectionKey, status: 'found', source: 'runtime' });
        setConversationSelectionError('');
      } else {
        setSelectedGroupId(null);
        setSelectedDirectConversationId(null);
        setUrlSelectionStateInternal({ key: explicitSelectionKey, status: 'missing' });
        setConversationSelectionError('指定的运行时群聊不存在或已归档；没有切换到其他会话。');
      }
      return undefined;
    }
    // Unified links historically omitted source or used "workspace" for a
    // canonical group. Resolve that exact ID through the verified adapters;
    // never substitute the first available conversation or trust the URL as
    // the draft's storage identity. Explicit runtime remains strict above.
    if (!groupsLoaded) return undefined;
    const canonicalTarget = groups.find(conversation => conversation.id === returnConversationId && conversation.type === 'group');
    const restoreCanonicalTarget = () => {
      if (!canonicalTarget) return false;
      setSelectedGroupId(canonicalTarget.id);
      setSelectedDirectConversationId(null);
      setSelectedAgentId(null);
      setUrlSelectionStateInternal({ key: explicitSelectionKey, status: 'found', source: 'runtime' });
      setConversationSelectionError('');
      return true;
    };
    if (agents.length === 0) {
      if (!restoreCanonicalTarget()) {
        setSelectedGroupId(null);
        setSelectedDirectConversationId(null);
        setUrlSelectionStateInternal({ key: explicitSelectionKey, status: 'missing' });
        setConversationSelectionError('指定的会话不存在或不属于当前工作区；没有回退到其他会话。');
      }
      return undefined;
    }
    void Promise.all(agents.map(async agent => {
      const result = await request<{ conversations: Conversation[] }>(`/api/workspaces/${workspaceId}/conversations?agentId=${encodeURIComponent(agent.id)}`);
      return { agent, conversations: result.conversations.filter(conversation => conversation.workspaceId === workspaceId && conversation.agentId === agent.id && conversation.type === 'direct') };
    })).then(results => {
      if (cancelled) return;
      const owner = results.find(result => result.conversations.some(conversation => conversation.id === returnConversationId && conversation.type === 'direct'));
      if (owner && canonicalTarget && returnConversationSourceParameter === null) {
        setSelectedGroupId(null);
        setSelectedDirectConversationId(null);
        setUrlSelectionStateInternal({ key: explicitSelectionKey, status: 'missing' });
        setConversationSelectionError('指定的会话 ID 存在于多个来源；请使用会话列表中的明确链接，没有自动选择。');
        return;
      }
      if (!owner) {
        if (restoreCanonicalTarget()) return;
        setSelectedGroupId(null);
        setSelectedDirectConversationId(null);
        setUrlSelectionStateInternal({ key: explicitSelectionKey, status: 'missing' });
        setConversationSelectionError('指定的会话不存在或不属于当前工作区；没有回退到其他会话。');
        return;
      }
      setConversations(owner.conversations);
      setSelectedGroupId(null);
      setSelectedAgentId(owner.agent.id);
      setSelectedDirectConversationId(returnConversationId);
      setUrlSelectionStateInternal({ key: explicitSelectionKey, status: 'found', source: 'workspace' });
      setConversationSelectionError('');
    }).catch(selectionError => {
      if (cancelled) return;
      setUrlSelectionStateInternal({ key: explicitSelectionKey, status: 'missing' });
      setConversationSelectionError(selectionError instanceof Error ? `无法验证指定会话：${selectionError.message}` : '无法验证指定会话');
    });
    return () => { cancelled = true; };
  }, [agents, explicitSelectionKey, groups, groupsLoaded, request, returnConversationId, returnConversationSource, returnConversationSourceParameter, setConversationSelectionError, workspaceId]);

  const applyAgent = useCallback((agent: AgentProfile) => {
    setAgents(current => current.map(item => item.id === agent.id ? agent : item));
  }, []);

  const persistConversationSettings = useCallback(async (conversationId: string, model: string | undefined, thinkingEffort: ThinkingEffort): Promise<Conversation> => {
    if (!workspaceId) throw new Error('Workspace is unavailable');
    const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations/${conversationId}/settings`, {
      method: 'PATCH',
      body: { model: model ?? null, thinkingEffort },
    });
    const update = (current: Conversation[]) => current.map(conversation => conversation.id === result.conversation.id ? result.conversation : conversation);
    setConversations(update);
    return result.conversation;
  }, [request, workspaceId]);

  const prependConversation = useCallback((conversation: Conversation) => {
    setConversations(current => [conversation, ...current.filter(item => item.id !== conversation.id)]);
  }, []);

  const applyGroupConversation = useCallback((conversation: Conversation) => {
    setGroups(current => current.map(group => group.id === conversation.id ? conversation : group));
  }, []);

  return {
    workspace,
    agents,
    presence,
    conversations,
    setConversations,
    groups,
    setGroups,
    groupsLoaded,
    selectedAgentId,
    setSelectedAgentId,
    selectedGroupId,
    setSelectedGroupId,
    selectedDirectConversationId,
    setSelectedDirectConversationId,
    selectedAgent,
    selectedConversation,
    activeConversationId,
    activeConversationSource,
    urlSelectionState,
    explicitSelectionVerified,
    loadConversations,
    loadGroups,
    loadPresence,
    applyAgent,
    persistConversationSettings,
    prependConversation,
    applyGroupConversation,
  };
}
