'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import type { AgentExecution, AgentProfile, Conversation, ConversationMessage, ExecutionEvent, ExecutionStatus, ThinkingEffort, Workspace } from '@agentos/shared';
import { AgentList } from '@/components/chat/AgentList';
import { AgentEditor } from '@/components/chat/AgentEditor';
import { GroupCreator } from '@/components/chat/GroupCreator';
import { GroupRenameModal } from '@/components/chat/GroupRenameModal';
import { ConversationContextMenu } from '@/components/chat/ConversationContextMenu';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { ConversationHistory } from '@/components/chat/ConversationHistory';
import { ExecutionInspector } from '@/components/chat/ExecutionInspector';
import { useApi } from '@/lib/useApi';
import { getActiveConversationId, shouldResetGroupView } from '@/lib/conversationSelection';
import { getNextConversationId } from '@/lib/conversationActions';
import { getInitialComposerSettings, getModelOptions, getRuntimeOverrides, getThinkingEfforts, normalizeThinkingEffort } from '@/lib/composerSettings';
import { parseSseChunk, parseSseEventData } from '@/lib/sse';
import { canSendMessage, fileToImageDraft, validateImageDrafts, type ImageDraft } from '@/lib/imageAttachments';
import { resolveAttachmentUrl } from '@/lib/attachmentUrls';

type StreamEvent = Pick<ExecutionEvent, 'status' | 'activity' | 'content'>;
type ContextMenuState = { conversation: Conversation; clientX: number; clientY: number };

export default function WorkspacePage() {
  const params = useParams();
  const router = useRouter();
  const workspaceId = typeof params.id === 'string' ? params.id : null;
  const { API_BASE, request } = useApi();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Conversation[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedDirectConversationId, setSelectedDirectConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [executions, setExecutions] = useState<AgentExecution[]>([]);
  const [activeEvents, setActiveEvents] = useState<ExecutionEvent[]>([]);
  const [activeStatus, setActiveStatus] = useState<ExecutionStatus>();
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<ImageDraft[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [composerModel, setComposerModel] = useState<string | undefined>();
  const [composerThinkingEffort, setComposerThinkingEffort] = useState<ThinkingEffort>('auto');
  const [streamingContent, setStreamingContent] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [editingAgent, setEditingAgent] = useState(false);
  const [savingAgent, setSavingAgent] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [savingGroup, setSavingGroup] = useState(false);
  const [renamingConversation, setRenamingConversation] = useState<Conversation | null>(null);
  const [savingConversationTitle, setSavingConversationTitle] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [actionNotice, setActionNotice] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const selectedAgent = agents.find(agent => agent.id === selectedAgentId);
  const activeConversationId = getActiveConversationId({ selectedGroupId, selectedDirectConversationId });
  const selectedConversation = selectedGroupId
    ? groups.find(conversation => conversation.id === selectedGroupId)
    : conversations.find(conversation => conversation.id === selectedDirectConversationId);
  const isGroupConversation = selectedConversation?.type === 'group';
  const activeComposerConversation = !isGroupConversation && selectedConversation?.agentId === selectedAgentId ? selectedConversation : undefined;
  const historyConversations = selectedGroupId ? groups : conversations;
  const historyTitle = selectedGroupId ? '群聊' : selectedAgent?.name ?? '会话';
  const composerModelOptions = getModelOptions(selectedAgent);
  const composerThinkingEfforts = getThinkingEfforts(selectedAgent, composerModel ?? selectedAgent?.model);

  useEffect(() => {
    const settings = getInitialComposerSettings(selectedAgent, activeComposerConversation ? {
      model: activeComposerConversation.model,
      thinkingEffort: activeComposerConversation.thinkingEffort,
    } : undefined);
    setComposerModel(settings.model);
    setComposerThinkingEffort(settings.thinkingEffort);
  }, [activeComposerConversation?.id, activeComposerConversation?.model, activeComposerConversation?.thinkingEffort, selectedAgent]);

  const persistConversationSettings = useCallback(async (conversationId: string, model: string | undefined, thinkingEffort: ThinkingEffort): Promise<Conversation> => {
    if (!workspaceId) throw new Error('Workspace is unavailable');
    const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations/${conversationId}/settings`, {
      method: 'PATCH',
      body: { model: model ?? null, thinkingEffort },
    });
    const update = (current: Conversation[]) => current.map(conversation => conversation.id === result.conversation.id ? result.conversation : conversation);
    setConversations(update);
    setGroups(update);
    return result.conversation;
  }, [request, workspaceId]);

  const handleComposerModelChange = useCallback((model: string | undefined) => {
    const efforts = getThinkingEfforts(selectedAgent, model);
    const selectedOption = getModelOptions(selectedAgent).find(option => option.id === model);
    const nextThinkingEffort = normalizeThinkingEffort(composerThinkingEffort, efforts, selectedOption?.defaultThinkingEffort);
    setComposerModel(model);
    setComposerThinkingEffort(nextThinkingEffort);
    if (activeConversationId && !isGroupConversation) {
      void persistConversationSettings(activeConversationId, model, nextThinkingEffort).catch(saveError => setError(saveError instanceof Error ? saveError.message : String(saveError)));
    }
  }, [activeConversationId, composerThinkingEffort, isGroupConversation, persistConversationSettings, selectedAgent]);

  const handleComposerThinkingEffortChange = useCallback((thinkingEffort: ThinkingEffort) => {
    setComposerThinkingEffort(thinkingEffort);
    if (activeConversationId && !isGroupConversation) {
      void persistConversationSettings(activeConversationId, composerModel, thinkingEffort).catch(saveError => setError(saveError instanceof Error ? saveError.message : String(saveError)));
    }
  }, [activeConversationId, composerModel, isGroupConversation, persistConversationSettings]);

  const handleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setAttachmentError('');
    const addedDrafts: ImageDraft[] = [];
    try {
      for (const file of files) addedDrafts.push(await fileToImageDraft(file));
      const nextDrafts = [...attachments, ...addedDrafts];
      const validation = validateImageDrafts(nextDrafts);
      if (!validation.ok) {
        for (const draft of addedDrafts) URL.revokeObjectURL(draft.previewUrl);
        setAttachmentError(validation.error);
        return;
      }
      setAttachments(nextDrafts);
    } catch (error) {
      for (const draft of addedDrafts) URL.revokeObjectURL(draft.previewUrl);
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  }, [attachments]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(current => {
      const removed = current.find(attachment => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter(attachment => attachment.id !== id);
    });
    setAttachmentError('');
  }, []);

  const loadConversationDetails = useCallback(async (conversationId: string) => {
    if (!workspaceId) return;
    const [messageResult, executionResult] = await Promise.all([
      request<{ messages: ConversationMessage[] }>(`/api/workspaces/${workspaceId}/conversations/${conversationId}/messages`),
      request<{ executions: Array<AgentExecution & { events: ExecutionEvent[] }> }>(`/api/workspaces/${workspaceId}/conversations/${conversationId}/executions`),
    ]);
    setMessages(messageResult.messages.map(message => ({
      ...message,
      attachments: message.attachments?.map(attachment => ({
        ...attachment,
        url: resolveAttachmentUrl(API_BASE, attachment.url),
      })),
    })));
    setExecutions(executionResult.executions);
    setActiveEvents(executionResult.executions[0]?.events ?? []);
    setActiveStatus(executionResult.executions[0]?.status);
  }, [API_BASE, request, workspaceId]);

  const loadConversations = useCallback(async (agentId: string) => {
    if (!workspaceId) return;
    const result = await request<{ conversations: Conversation[] }>(`/api/workspaces/${workspaceId}/conversations?agentId=${encodeURIComponent(agentId)}`);
    setConversations(result.conversations);
    setSelectedDirectConversationId(result.conversations[0]?.id ?? null);
    setMessages([]); setExecutions([]); setActiveEvents([]); setActiveStatus(undefined);
  }, [request, workspaceId]);

  const loadGroups = useCallback(async () => {
    if (!workspaceId) return;
    const result = await request<{ conversations: Conversation[] }>(`/api/workspaces/${workspaceId}/conversations`);
    setGroups(result.conversations.filter(conversation => conversation.type === 'group'));
  }, [request, workspaceId]);

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
      void loadGroups();
    }).catch(loadError => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError)); });
    return () => { cancelled = true; };
  }, [loadGroups, request, workspaceId]);

  useEffect(() => {
    if (selectedAgentId) void loadConversations(selectedAgentId).catch(loadError => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, [loadConversations, selectedAgentId]);

  useEffect(() => {
    if (activeConversationId) void loadConversationDetails(activeConversationId).catch(loadError => setError(loadError instanceof Error ? loadError.message : String(loadError)));
  }, [activeConversationId, loadConversationDetails]);

  useEffect(() => {
    if (!actionNotice) return;
    const timeout = window.setTimeout(() => setActionNotice(''), 1800);
    return () => window.clearTimeout(timeout);
  }, [actionNotice]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', closeOnKeyDown);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', closeOnKeyDown); };
  }, [contextMenu]);

  const createConversation = useCallback(async (): Promise<Conversation | null> => {
    if (!workspaceId || !selectedAgent) return null;
    const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations`, { method: 'POST', body: { agentId: selectedAgent.id } });
    const conversation = await persistConversationSettings(result.conversation.id, composerModel, composerThinkingEffort);
    setConversations(current => [conversation, ...current.filter(item => item.id !== conversation.id)]);
    setSelectedDirectConversationId(conversation.id);
    setMessages([]); setExecutions([]); setActiveEvents([]); setActiveStatus(undefined);
    return conversation;
  }, [composerModel, composerThinkingEffort, persistConversationSettings, request, selectedAgent, workspaceId]);

  const openContextMenu = useCallback((conversationId: string, event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const conversation = groups.find(item => item.id === conversationId) ?? conversations.find(item => item.id === conversationId);
    if (conversation) setContextMenu({ conversation, clientX: event.clientX, clientY: event.clientY });
  }, [conversations, groups]);

  const copyConversationId = useCallback(async (conversationId: string) => {
    try { await navigator.clipboard.writeText(conversationId); setActionNotice('会话 ID 已复制'); }
    catch (copyError) { setError(copyError instanceof Error ? copyError.message : String(copyError)); }
  }, []);

  const handleSend = useCallback(async () => {
    if (!workspaceId || (!selectedAgent && !selectedGroupId) || !canSendMessage(draft, attachments) || sending) return;
    setError('');
    const content = draft.trim();
    const attachmentPayload = attachments.map(({ name, mimeType, dataUrl }) => ({ name, mimeType, dataUrl }));
    const optimisticAttachments = attachments.map(attachment => ({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, url: attachment.previewUrl }));
    let optimisticId: string | undefined;
    let conversation: Conversation | null | undefined = selectedConversation;
    try {
      if (!conversation) conversation = await createConversation();
      if (!conversation) return;
      optimisticId = `local-${Date.now()}`;
      const optimistic: ConversationMessage = { id: optimisticId, conversationId: conversation.id, workspaceId, senderType: 'user', content, attachments: optimisticAttachments, createdAt: new Date().toISOString() };
      setMessages(current => [...current, optimistic]);
      setSending(true); setStreamingContent(''); setActiveEvents([]); setActiveStatus('queued');
      const controller = new AbortController();
      abortRef.current = controller;
      const runtimeOverrides = getRuntimeOverrides(selectedAgent, { model: composerModel, thinkingEffort: composerThinkingEffort });
      const response = await fetch(`${API_BASE}/api/workspaces/${workspaceId}/conversations/${conversation.id}/messages/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(conversation.type === 'group' ? { content, attachments: attachmentPayload } : { content, attachments: attachmentPayload, ...(runtimeOverrides.model ? { model: runtimeOverrides.model } : {}), ...(runtimeOverrides.thinkingEffort ? { thinkingEffort: runtimeOverrides.thinkingEffort } : {}) }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new Error(`发送失败：${response.status}`);
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const parsed = parseSseChunk(buffer, decoder.decode(value, { stream: true }));
          buffer = parsed.remainder;
          for (const event of parsed.events) {
            const data = parseSseEventData<StreamEvent & { message?: ConversationMessage; execution?: AgentExecution; error?: string }>(event.data);
            if (!data) continue;
            if (event.event === 'execution') {
              const time = new Date().toISOString();
              setActiveStatus(data.status);
              setActiveEvents(current => [...current, { id: `${time}-${current.length}`, executionId: 'active', status: data.status, activity: data.activity, ...(data.content ? { content: data.content } : {}), createdAt: time }]);
              if (data.status === 'streaming_response' && data.content) setStreamingContent(current => current + data.content);
            } else if (event.event === 'message' && data.message) {
              setStreamingContent(''); setMessages(current => [...current, data.message!]);
            } else if (event.event === 'done' && data.execution) {
              setActiveStatus(data.execution.status);
            } else if (event.event === 'error') {
              throw new Error(data.error ?? '执行失败');
            }
          }
        }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      await Promise.all([
        conversation.type === 'group' ? loadGroups() : selectedAgent ? loadConversations(selectedAgent.id) : Promise.resolve(),
        loadConversationDetails(conversation.id),
      ]);
      if (conversation.type === 'group') setSelectedGroupId(conversation.id);
      else setSelectedDirectConversationId(conversation.id);
      setDraft('');
      setAttachments(current => { for (const attachment of current) URL.revokeObjectURL(attachment.previewUrl); return []; });
      setAttachmentError('');
    } catch (sendError) {
      if (optimisticId) setMessages(current => current.filter(message => message.id !== optimisticId));
      if (sendError instanceof DOMException && sendError.name === 'AbortError') setError('执行已取消');
      else setError(sendError instanceof Error ? sendError.message : String(sendError));
    } finally {
      setSending(false); abortRef.current = null;
    }
  }, [API_BASE, attachments, composerModel, composerThinkingEffort, createConversation, draft, loadConversationDetails, loadConversations, loadGroups, selectedAgent, selectedConversation, selectedGroupId, sending, workspaceId]);

  const saveAgent = useCallback(async (update: Pick<AgentProfile, 'roleTitle' | 'systemPrompt' | 'permissions' | 'enabled'> & Partial<Pick<AgentProfile, 'name' | 'model'>> & { thinkingEffort: ThinkingEffort }) => {
    if (!workspaceId || !selectedAgent) return;
    setSavingAgent(true);
    try {
      const result = await request<{ agent: AgentProfile }>(`/api/workspaces/${workspaceId}/agents/${selectedAgent.id}`, { method: 'PATCH', body: update });
      setAgents(current => current.map(agent => agent.id === result.agent.id ? result.agent : agent));
      setEditingAgent(false);
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : String(saveError)); }
    finally { setSavingAgent(false); }
  }, [request, selectedAgent, workspaceId]);

  const refreshAgentModels = useCallback(async () => {
    if (!workspaceId || !selectedAgent) return;
    setSavingAgent(true);
    try {
      const result = await request<{ agent: AgentProfile }>(`/api/workspaces/${workspaceId}/agents/${selectedAgent.id}/models/refresh`, { method: 'POST' });
      setAgents(current => current.map(agent => agent.id === result.agent.id ? result.agent : agent));
    } catch (refreshError) { setError(refreshError instanceof Error ? refreshError.message : String(refreshError)); }
    finally { setSavingAgent(false); }
  }, [request, selectedAgent, workspaceId]);

  const createGroup = useCallback(async (input: { title: string; memberAgentIds: string[]; leaderAgentId: string }) => {
    if (!workspaceId) return;
    setSavingGroup(true);
    try {
      const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations`, { method: 'POST', body: { type: 'group', ...input } });
      setGroups(current => [result.conversation, ...current]);
      setSelectedGroupId(result.conversation.id); setSelectedAgentId(null);
      setMessages([]); setExecutions([]); setActiveEvents([]); setActiveStatus(undefined); setCreatingGroup(false);
    } catch (groupError) { setError(groupError instanceof Error ? groupError.message : String(groupError)); }
    finally { setSavingGroup(false); }
  }, [request, workspaceId]);

  const saveConversationTitle = useCallback(async (title: string) => {
    if (!workspaceId || !renamingConversation) return;
    setSavingConversationTitle(true);
    try {
      const result = await request<{ conversation: Conversation }>(`/api/workspaces/${workspaceId}/conversations/${renamingConversation.id}`, { method: 'PATCH', body: { title } });
      if (result.conversation.type === 'group') setGroups(current => current.map(group => group.id === result.conversation.id ? result.conversation : group));
      else setConversations(current => current.map(conversation => conversation.id === result.conversation.id ? result.conversation : conversation));
      setRenamingConversation(null);
    } catch (renameError) { setError(renameError instanceof Error ? renameError.message : String(renameError)); }
    finally { setSavingConversationTitle(false); }
  }, [request, renamingConversation, workspaceId]);

  const deleteConversation = useCallback(async (conversation: Conversation) => {
    if (!workspaceId || !window.confirm(`确定删除会话“${conversation.title}”吗？此操作不可撤销。`)) return;
    try {
      await request<{ conversationId: string }>(`/api/workspaces/${workspaceId}/conversations/${conversation.id}`, { method: 'DELETE' });
      const nextId = conversation.type === 'group' ? getNextConversationId(groups, conversation.id) : getNextConversationId(conversations, conversation.id);
      if (conversation.type === 'group') {
        setGroups(current => current.filter(group => group.id !== conversation.id));
        if (selectedGroupId === conversation.id) { setSelectedGroupId(nextId); setSelectedAgentId(null); setMessages([]); setExecutions([]); setActiveEvents([]); setActiveStatus(undefined); }
      } else {
        setConversations(current => current.filter(item => item.id !== conversation.id));
        if (selectedDirectConversationId === conversation.id) { setSelectedDirectConversationId(nextId); setMessages([]); setExecutions([]); setActiveEvents([]); setActiveStatus(undefined); }
      }
      setContextMenu(null); setActionNotice('会话已删除');
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : String(deleteError)); }
  }, [conversations, groups, request, selectedDirectConversationId, selectedGroupId, workspaceId]);

  const selectGroup = useCallback((groupId: string) => {
    const group = groups.find(item => item.id === groupId);
    if (!group) return;
    if (!shouldResetGroupView({ selectedGroupId, nextGroupId: groupId })) { setSelectedAgentId(null); return; }
    setSelectedGroupId(groupId); setSelectedAgentId(null); setMessages([]); setExecutions([]); setActiveEvents([]); setActiveStatus(undefined);
  }, [groups, selectedGroupId]);

  if (!workspaceId) return <div className="grid h-screen place-items-center bg-[#0b1118] text-slate-400">工作区不存在</div>;
  if (!workspace && !error) return <div className="grid h-screen place-items-center bg-[#0b1118] text-slate-400">正在加载工作区…</div>;

  return <div className="flex h-screen min-w-[960px] overflow-hidden bg-[#0b1118] text-slate-200">
    <AgentList agents={agents} groups={groups} selectedGroupId={selectedGroupId} selectedAgentId={selectedAgentId} activeStatus={activeStatus} onSelect={agentId => { setSelectedAgentId(agentId); setSelectedGroupId(null); setSelectedDirectConversationId(null); setError(''); }} onSelectGroup={selectGroup} onCreateGroup={() => setCreatingGroup(true)} onContextMenu={openContextMenu} onBackToWorkspace={() => router.push('/')} />
    <ConversationHistory title={historyTitle} conversations={historyConversations} selectedConversationId={activeConversationId} createLabel={selectedGroupId ? '新建群聊' : '新建会话'} onCreate={() => { if (selectedGroupId) setCreatingGroup(true); else void createConversation().catch(createError => setError(createError instanceof Error ? createError.message : String(createError))); }} onSelect={selectedGroupId ? selectGroup : setSelectedDirectConversationId} onContextMenu={openContextMenu} />
    <ChatPanel agentName={selectedAgent?.name} roleTitle={selectedAgent?.roleTitle} conversationTitle={isGroupConversation && selectedConversation ? `👥 ${selectedConversation.title}` : undefined} groupName={isGroupConversation ? selectedConversation?.title : undefined} isGroup={isGroupConversation} agents={agents} messages={messages} draft={draft} attachments={attachments} attachmentError={attachmentError} streamingContent={streamingContent} activeStatus={activeStatus} error={error} sending={sending} modelOptions={composerModelOptions} composerModel={composerModel} composerThinkingEffort={composerThinkingEffort} composerThinkingEfforts={composerThinkingEfforts} modelSource={selectedAgent?.capability?.modelSource} onDraftChange={setDraft} onFiles={files => { void handleFiles(files); }} onRemoveAttachment={removeAttachment} onComposerModelChange={handleComposerModelChange} onComposerThinkingEffortChange={handleComposerThinkingEffortChange} onSend={() => { void handleSend(); }} onCancel={() => abortRef.current?.abort()} onRename={isGroupConversation ? () => { if (selectedConversation) setRenamingConversation(selectedConversation); } : undefined} />
    <ExecutionInspector agent={isGroupConversation ? undefined : selectedAgent} groupTitle={isGroupConversation ? selectedConversation?.title : undefined} events={activeEvents} executions={executions} activeStatus={activeStatus} onEdit={() => setEditingAgent(true)} />
    {editingAgent && selectedAgent && <AgentEditor key={`${selectedAgent.id}-${selectedAgent.capability?.modelSource}-${selectedAgent.capability?.models.join('|')}`} agent={selectedAgent} saving={savingAgent} refreshingModels={savingAgent} onClose={() => setEditingAgent(false)} onRefreshModels={() => { void refreshAgentModels(); }} onSave={update => { void saveAgent(update); }} />}
    {creatingGroup && <GroupCreator agents={agents} saving={savingGroup} onClose={() => setCreatingGroup(false)} onCreate={input => { void createGroup(input); }} />}
    {renamingConversation && <GroupRenameModal title={renamingConversation.title} entityLabel={renamingConversation.type === 'group' ? '群聊' : '会话'} saving={savingConversationTitle} onClose={() => setRenamingConversation(null)} onSave={title => { void saveConversationTitle(title); }} />}
    {contextMenu && <ConversationContextMenu conversation={contextMenu.conversation} clientX={contextMenu.clientX} clientY={contextMenu.clientY} onRename={() => setRenamingConversation(contextMenu.conversation)} onCopyId={() => { void copyConversationId(contextMenu.conversation.id); }} onDelete={() => { void deleteConversation(contextMenu.conversation); }} onClose={() => setContextMenu(null)} />}
    {actionNotice && <div className="fixed bottom-6 left-1/2 z-[70] -translate-x-1/2 rounded-lg border border-emerald-500/30 bg-emerald-950/90 px-4 py-2 text-sm text-emerald-200 shadow-xl">{actionNotice}</div>}
  </div>;
}
