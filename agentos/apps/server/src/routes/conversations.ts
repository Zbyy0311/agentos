import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { getAgentCapability } from '@agentos/agent-core';
import type { AgentCapability, AgentModelOption, AgentProfile, Conversation, ThinkingEffort } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { ConversationService } from '../services/ConversationService.js';
import { RunStreamRegistry, type RunStreamEvent } from '../services/RunStreamRegistry.js';
import { cleanupConversationAttachments, getAttachmentAbsolutePath, validateConversationAttachmentInputs, type ConversationAttachmentInput } from '../services/ConversationAttachmentService.js';
import { CliModelDiscovery, type ModelDiscoveryService } from '../services/CliModelDiscovery.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { EventBus } from '../events/EventBus.js';
import { createSseWriter, startSseHeartbeat } from './sse.js';

export function createConversationRoutes(
  store: SqliteStore,
  workspaceManager: WorkspaceManager,
  modelDiscovery: ModelDiscoveryService = new CliModelDiscovery(),
  eventBus?: EventBus,
): Router {
  const router = Router({ mergeParams: true });
  const service = new ConversationService(store, eventBus);
  const runStreams = new RunStreamRegistry();

  router.get('/agents', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const agents = await Promise.all(store.listAgentProfiles(workspace.id).map(agent => withCapability(agent, modelDiscovery)));
      res.json({ agents, workspaceId: workspace.id });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/agents/:agentId', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const current = store.listAgentProfiles(workspace.id).find(agent => agent.id === req.params.agentId);
    if (!current) return res.status(404).json({ error: 'Agent not found' });
    const body = req.body as Record<string, unknown>;
    const permissions = Array.isArray(body.permissions) && body.permissions.every(value => value === 'read' || value === 'write' || value === 'review')
      ? body.permissions as Array<'read' | 'write' | 'review'>
      : current.permissions;
    const thinkingEffort = body.thinkingEffort === undefined
      ? current.thinkingEffort ?? 'auto'
      : body.thinkingEffort;
    if (!isThinkingEffort(thinkingEffort)) {
      return res.status(400).json({ error: 'thinkingEffort must be auto, low, medium, or high' });
    }
    const nextModel = typeof body.model === 'string' ? body.model.trim() : current.model;
    const capability = getAgentCapability(current.role, current.cliCommand, nextModel);
    if (!capability.thinkingEfforts.includes(thinkingEffort)) {
      return res.status(400).json({ error: `${current.name} does not support thinking effort "${thinkingEffort}"` });
    }
    try {
      const agent = store.updateAgentProfile(workspace.id, current.id, {
        name: typeof body.name === 'string' ? body.name : current.name,
        roleTitle: typeof body.roleTitle === 'string' ? body.roleTitle : current.roleTitle,
        systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : current.systemPrompt,
        permissions,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
        model: typeof body.model === 'string' ? body.model : current.model,
        thinkingEffort,
      });
      res.json({ agent: await withCapability(agent, modelDiscovery) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/agents/:agentId/models/refresh', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const current = store.listAgentProfiles(workspace.id).find(agent => agent.id === req.params.agentId);
    if (!current) return res.status(404).json({ error: 'Agent not found' });
    try {
      res.json({ agent: await withCapability(current, modelDiscovery, true) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/conversations', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    const conversations = store.listConversations(workspace.id)
      .filter(conversation => !agentId || conversation.agentId === agentId);
    res.json({ conversations });
  });

  router.post('/conversations', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const { agentId, title, type, memberAgentIds, leaderAgentId } = req.body as {
      agentId?: unknown; title?: unknown; type?: unknown; memberAgentIds?: unknown; leaderAgentId?: unknown;
    };
    if (type === 'group') {
      if (!Array.isArray(memberAgentIds) || memberAgentIds.length < 2 || memberAgentIds.some(id => typeof id !== 'string') || typeof leaderAgentId !== 'string') {
        return res.status(400).json({ error: 'Group requires at least two memberAgentIds and a leaderAgentId' });
      }
      const uniqueIds = [...new Set(memberAgentIds)];
      if (uniqueIds.length !== memberAgentIds.length || !uniqueIds.includes(leaderAgentId)) {
        return res.status(400).json({ error: 'Group members must be unique and include the leader' });
      }
      const profiles = new Map(store.listAgentProfiles(workspace.id).filter(profile => profile.enabled).map(profile => [profile.id, profile]));
      if (uniqueIds.some(id => !profiles.has(id))) return res.status(400).json({ error: 'Group member is unavailable' });
      const now = new Date().toISOString();
      const conversation: Conversation = {
        id: randomUUID(), workspaceId: workspace.id, type: 'group',
        title: typeof title === 'string' && title.trim() ? title.trim() : '新建协作群聊', createdAt: now, updatedAt: now,
      };
      const members = uniqueIds.map(id => ({
        conversationId: conversation.id, agentId: id, roleTitle: id === leaderAgentId ? '群主' : profiles.get(id)!.roleTitle,
        isLeader: id === leaderAgentId, createdAt: now,
      }));
      store.createGroupConversation(conversation, members);
      return res.status(201).json({ conversation, members });
    }
    if (!agentId || typeof agentId !== 'string') return res.status(400).json({ error: 'agentId is required' });

    const agent = store.listAgentProfiles(workspace.id).find(profile => profile.id === agentId && profile.enabled);
    if (!agent) return res.status(400).json({ error: 'Agent is unavailable' });

    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: randomUUID(),
      workspaceId: workspace.id,
      type: 'direct',
      title: typeof title === 'string' && title.trim() ? title.trim() : `与 ${agent.name} 的新对话`,
      agentId: agent.id,
      createdAt: now,
      updatedAt: now,
    };
    store.createConversation(conversation);
    res.status(201).json({ conversation });
  });

  router.patch('/conversations/:conversationId/settings', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const conversation = store.listConversations(workspace.id).find(item => item.id === req.params.conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (conversation.type !== 'direct' || !conversation.agentId) {
      return res.status(400).json({ error: 'Only direct conversations support model settings' });
    }
    const agent = store.listAgentProfiles(workspace.id).find(profile => profile.id === conversation.agentId && profile.enabled);
    if (!agent) return res.status(400).json({ error: 'Conversation agent is unavailable' });
    try {
      const body = req.body as Record<string, unknown>;
      const model = body.model === undefined
        ? conversation.model
        : body.model === null
          ? undefined
          : typeof body.model === 'string'
            ? body.model.trim() || undefined
            : (() => { throw new Error('model must be a string or null'); })();
      const thinkingEffort = body.thinkingEffort === undefined ? conversation.thinkingEffort : body.thinkingEffort;
      if (thinkingEffort !== undefined && !isThinkingEffort(thinkingEffort)) {
        throw new Error('thinkingEffort must be auto, low, medium, or high');
      }
      const capableAgent = await withCapability(agent, modelDiscovery);
      validateRuntimeOverrides(capableAgent, {
        ...(model ? { model } : {}),
        ...(thinkingEffort ? { thinkingEffort } : {}),
      });
      const updated = store.updateConversationSettings(workspace.id, conversation.id, {
        model: model ?? null,
        thinkingEffort: thinkingEffort ?? null,
      });
      res.json({ conversation: updated });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/conversations/:conversationId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const title = (req.body as { title?: unknown }).title;
    if (typeof title !== 'string') return res.status(400).json({ error: 'title is required' });
    try {
      const conversation = store.updateConversationTitle(workspace.id, req.params.conversationId, title);
      res.json({ conversation });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/conversations/:conversationId', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const attachments = store.listConversationAttachments(workspace.id, req.params.conversationId);
      store.deleteConversation(workspace.id, req.params.conversationId);
      await cleanupConversationAttachments(workspace.rootPath, attachments);
      res.json({ conversationId: req.params.conversationId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'Conversation not found' || message === 'Conversation not found in workspace' ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  router.get('/conversations/:conversationId/messages', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const limit = parseLimit(req.query.limit);
    res.json({ messages: store.listMessages(workspace.id, req.params.conversationId, limit) });
  });

  router.get('/conversations/:conversationId/executions', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const executions = store.listExecutions(workspace.id, req.params.conversationId)
      .map(execution => ({ ...execution, events: store.listExecutionEvents(workspace.id, execution.id) }));
    res.json({ executions });
  });

  router.get('/attachments/:attachmentId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const attachment = store.getAttachment(workspace.id, req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    try {
      res.sendFile(getAttachmentAbsolutePath(workspace.rootPath, attachment.relativePath), { headers: { 'Cache-Control': 'private, max-age=3600' } }, error => {
        if (error && !res.headersSent) res.status(404).json({ error: 'Attachment file not found' });
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/conversations/:conversationId/messages/stream', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const body = req.body as Record<string, unknown>;
    const content = typeof body.content === 'string' ? body.content : '';
    let attachments: ConversationAttachmentInput[];
    try {
      attachments = parseAttachmentInputs(body.attachments);
      validateConversationAttachmentInputs(attachments);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
    if (!content.trim() && attachments.length === 0) return res.status(400).json({ error: 'content or image attachment is required' });

    const conversation = store.listConversations(workspace.id)
      .find(item => item.id === req.params.conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (conversation.type === 'direct' && !conversation.agentId) return res.status(404).json({ error: 'Direct conversation not found' });

    let runtimeOverrides: Pick<AgentProfile, 'model' | 'thinkingEffort'> | undefined;
    if (conversation.type === 'direct') {
      try {
        const agent = store.listAgentProfiles(workspace.id).find(item => item.id === conversation.agentId && item.enabled);
        if (!agent) return res.status(400).json({ error: 'Agent is unavailable' });
        const capableAgent = await withCapability(agent, modelDiscovery);
        runtimeOverrides = parseRuntimeOverrides(req.body as Record<string, unknown>);
        validateRuntimeOverrides(capableAgent, runtimeOverrides);
      } catch (error) {
        return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = createSseWriter(res);
    const stopHeartbeat = startSseHeartbeat(res);
    const abortController = new AbortController();
    let activeRunId: string | undefined;
    let unsubscribe = () => {};
    const forward = (item: RunStreamEvent) => send(item.event, item.data);
    const attachRun = (run: { id: string }) => {
      activeRunId = run.id;
      runStreams.open(run.id, abortController);
      unsubscribe = runStreams.subscribe(run.id, 0, forward) ?? (() => {});
      runStreams.emit(run.id, 'run', { runId: run.id, run });
    };

    res.on('close', () => {
      unsubscribe();
      stopHeartbeat();
    });

    try {
      if (conversation.type === 'direct') {
        const result = await service.sendDirectMessage({
          workspaceId: workspace.id,
          workspaceRoot: workspace.rootPath,
          conversationId: conversation.id,
          agentId: conversation.agentId!,
          content,
          attachments,
          runtimeOverrides,
          memoryEnabled: workspace.memoryEnabled,
          signal: abortController.signal,
          onRunCreated: attachRun,
          onExecutionEvent: event => { if (activeRunId) runStreams.emit(activeRunId, 'execution', event); },
        });
        if (activeRunId) {
          runStreams.emit(activeRunId, 'message', { message: result.responseMessage });
          runStreams.finish(activeRunId, 'done', { execution: result.execution });
        }
      } else {
        const result = await service.sendGroupMessage({
          workspaceId: workspace.id,
          workspaceRoot: workspace.rootPath,
          conversationId: conversation.id,
          content,
          attachments,
          memoryEnabled: workspace.memoryEnabled,
          signal: abortController.signal,
          onRunCreated: attachRun,
          onExecutionEvent: event => { if (activeRunId) runStreams.emit(activeRunId, 'execution', event); },
          onAgentMessage: message => { if (activeRunId) runStreams.emit(activeRunId, 'message', { message }); },
        });
        if (activeRunId) runStreams.finish(activeRunId, 'done', { executions: result.executions });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (activeRunId) runStreams.finish(activeRunId, 'error', { error: message });
      else send('error', { error: message });
    } finally {
      unsubscribe();
      stopHeartbeat();
      res.end();
    }
  });

  router.get('/conversations/:conversationId/runs/:runId/stream', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const conversation = store.listConversations(workspace.id).find(item => item.id === req.params.conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run || run.conversationId !== conversation.id) return res.status(404).json({ error: 'Run not found' });
    if (!runStreams.has(run.id)) return res.status(503).json({ error: 'Run stream is no longer available' });

    const cursor = parseStreamCursor(req.query.cursor);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = createSseWriter(res);
    const stopHeartbeat = startSseHeartbeat(res);
    const onEvent = (item: RunStreamEvent) => {
      send(item.event, item.data);
      if (item.event === 'done' || item.event === 'error') {
        stopHeartbeat();
        res.end();
      }
    };
    const unsubscribe = runStreams.subscribe(run.id, cursor, onEvent) ?? (() => {});
    res.on('close', () => {
      unsubscribe();
      stopHeartbeat();
    });
    if (runStreams.isFinished(run.id)) res.end();
  });

  router.post('/conversations/:conversationId/runs/:runId/cancel', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const conversation = store.listConversations(workspace.id).find(item => item.id === req.params.conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run || run.conversationId !== conversation.id) return res.status(404).json({ error: 'Run not found' });
    if (!runStreams.cancel(run.id)) return res.status(409).json({ error: 'Run is no longer active' });
    res.json({ runId: run.id, cancelled: true });
  });

  router.post('/conversations/:conversationId/runs/:runId/resume/stream', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const conversation = store.listConversations(workspace.id).find(item => item.id === req.params.conversationId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (conversation.type === 'group') return res.status(409).json({ error: '群聊暂不支持等待用户恢复' });
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) return res.status(400).json({ error: '补充信息不能为空' });
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run || run.conversationId !== conversation.id) return res.status(404).json({ error: 'Run not found' });
    if (run.status !== 'waiting_user') return res.status(409).json({ error: 'Run is not waiting for user input' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = createSseWriter(res);
    const stopHeartbeat = startSseHeartbeat(res);
    const abortController = new AbortController();
    runStreams.open(run.id, abortController);
    const unsubscribe = runStreams.subscribe(run.id, 0, item => send(item.event, item.data)) ?? (() => {});
    runStreams.emit(run.id, 'run', { runId: run.id, run });
    res.on('close', () => {
      unsubscribe();
      stopHeartbeat();
    });
    try {
      const result = await service.resumeDirectMessage({
        workspaceId: workspace.id, workspaceRoot: workspace.rootPath, conversationId: conversation.id,
        runId: run.id, content, memoryEnabled: workspace.memoryEnabled, signal: abortController.signal,
        onExecutionEvent: event => runStreams.emit(run.id, 'execution', event),
      });
      runStreams.emit(run.id, 'message', { message: result.responseMessage });
      runStreams.finish(run.id, 'done', { execution: result.execution });
    } catch (error) {
      runStreams.finish(run.id, 'error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      unsubscribe();
      stopHeartbeat();
      res.end();
    }
  });

  return router;
}

function parseAttachmentInputs(value: unknown): ConversationAttachmentInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('attachments must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`attachment ${index + 1} is invalid`);
    const attachment = item as Record<string, unknown>;
    if (typeof attachment.name !== 'string' || typeof attachment.mimeType !== 'string' || typeof attachment.dataUrl !== 'string') {
      throw new Error(`attachment ${index + 1} is invalid`);
    }
    return { name: attachment.name, mimeType: attachment.mimeType, dataUrl: attachment.dataUrl };
  });
}

function parseStreamCursor(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : 0;
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high';
}

function parseRuntimeOverrides(body: Record<string, unknown>): Pick<AgentProfile, 'model' | 'thinkingEffort'> | undefined {
  const model = body.model === undefined ? undefined : typeof body.model === 'string' ? body.model.trim() : null;
  if (model === null) throw new Error('model must be a string');
  const thinkingEffort = body.thinkingEffort === undefined ? undefined : body.thinkingEffort;
  if (thinkingEffort !== undefined && !isThinkingEffort(thinkingEffort)) {
    throw new Error('thinkingEffort must be auto, low, medium, or high');
  }
  if (!model && thinkingEffort === undefined) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(thinkingEffort ? { thinkingEffort } : {}),
  };
}

function validateRuntimeOverrides(
  agent: AgentProfile & { capability: AgentCapability },
  overrides: Pick<AgentProfile, 'model' | 'thinkingEffort'> | undefined,
): void {
  if (!overrides) return;
  const modelOptions = agent.capability.modelOptions ?? agent.capability.models.map(model => ({
    id: model,
    label: model,
    thinkingEfforts: [...agent.capability.thinkingEfforts],
    defaultThinkingEffort: agent.capability.defaultThinkingEffort,
  }));
  const selectedModel = overrides.model ?? agent.model;
  const selectedModelOption = selectedModel ? modelOptions.find(model => model.id === selectedModel) : undefined;
  if (overrides.model && !selectedModelOption) {
    throw new Error(`Model "${overrides.model}" is not available for ${agent.name}`);
  }
  if (overrides.thinkingEffort) {
    const supportedEfforts = selectedModelOption?.thinkingEfforts ?? agent.capability.thinkingEfforts;
    if (!supportedEfforts.includes(overrides.thinkingEffort)) {
      throw new Error(`${agent.name} model does not support thinking effort "${overrides.thinkingEffort}"`);
    }
  }
}

async function withCapability(
  agent: AgentProfile,
  modelDiscovery: ModelDiscoveryService,
  forceRefresh = false,
): Promise<AgentProfile & { capability: ReturnType<typeof getAgentCapability> }> {
  const baseCapability = getAgentCapability(agent.role, agent.cliCommand, agent.model);
  const fallbackModels: AgentModelOption[] = baseCapability.models.map(model => ({
    id: model,
    label: model,
    thinkingEfforts: [...baseCapability.thinkingEfforts],
    defaultThinkingEffort: baseCapability.defaultThinkingEffort,
  }));
  const discovery = await modelDiscovery.discover({
    cliCommand: agent.cliCommand,
    role: agent.role,
    fallbackModels,
    fallbackThinkingEfforts: baseCapability.thinkingEfforts,
    forceRefresh,
  });
  const modelOptions = discovery.models.length > 0 ? discovery.models : fallbackModels;
  const selectedModel = agent.model?.trim();
  const selectedOption = selectedModel ? modelOptions.find(model => model.id === selectedModel) : undefined;
  return {
    ...agent,
    thinkingEffort: agent.thinkingEffort ?? 'auto',
    capability: {
      ...baseCapability,
      models: modelOptions.map(model => model.id),
      modelOptions,
      modelSource: discovery.source,
      modelSourceStale: discovery.stale,
      ...(discovery.warning ? { modelSourceWarning: discovery.warning } : {}),
      thinkingEfforts: selectedOption?.thinkingEfforts ?? baseCapability.thinkingEfforts,
    },
  };
}

function parseLimit(value: unknown): number {
  if (typeof value !== 'string') return 50;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
}
