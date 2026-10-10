import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { assertRuntimePolicySupported, resolveRuntimePolicy } from '@agentos/agent-core';
import type { AgentProfile, AgentProvider, CollaborationRole, Conversation, ConversationMember, GroupDispatchMode, PartialWriteDecision, RunIntent, ThinkingEffort } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { ConversationService } from '../services/ConversationService.js';
import { RunStreamRegistry, type RunStreamEvent } from '../services/RunStreamRegistry.js';
import { cleanupConversationAttachments, getAttachmentAbsolutePath, parseConversationAttachmentInputs, validateConversationAttachmentInputs, type ConversationAttachmentInput } from '../services/ConversationAttachmentService.js';
import { CliModelDiscovery, type ModelDiscoveryService } from '../services/CliModelDiscovery.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { EventBus } from '../events/EventBus.js';
import { createSseWriter, startSseHeartbeat } from './sse.js';
import { RuntimeArtifactService } from '../services/RuntimeArtifactService.js';
import type { PreferenceLearningService } from '../services/ConversationService.js';
import { RunDecisionService } from '../services/RunDecisionService.js';
import type { WorktreeManager } from '../services/WorktreeManager.js';
import { parseGroupMemberSettings, validateRuntimeOverrides, withAgentCapability } from '../services/AgentCapabilityService.js';
import { sendProblem } from '../problemDetails.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export function createConversationRoutes(
  store: SqliteStore,
  workspaceManager: WorkspaceManager,
  modelDiscovery: ModelDiscoveryService = new CliModelDiscovery(),
  eventBus?: EventBus,
  artifactService?: RuntimeArtifactService,
  preferenceService?: PreferenceLearningService,
  worktreeManager?: WorktreeManager,
): Router {
  const router = Router({ mergeParams: true });
  const runStreams = new RunStreamRegistry();
  const service = new ConversationService(store, eventBus, artifactService, preferenceService, worktreeManager);
  const runDecisionService = new RunDecisionService(store);

  // Step events are persisted through EventBus first, then projected into the
  // transport-local stream. The event sequence remains part of the payload so
  // the client can reject stale updates while SSE cursor semantics stay local.
  eventBus?.subscribe(event => {
    if (event.type !== 'run.step.created' && event.type !== 'run.step.updated') return;
    const payload = event.payload as Record<string, unknown>;
    if (!payload.step || typeof payload.step !== 'object') return;
    runStreams.emit(event.runId, 'run.step', {
      type: event.type,
      runStep: payload.step,
      eventId: event.eventId,
      sequence: event.sequence,
    });
  });

  router.get('/agents', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    try {
      const agents = await Promise.all(store.listAgentProfiles(workspace.id).map(agent => withAgentCapability(agent, modelDiscovery)));
      res.json({ agents, workspaceId: workspace.id });
    } catch (error) {
      console.error('[conversations] list agents failed', error);
      sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
    }
  }));

  router.patch('/agents/:agentId', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const current = store.listAgentProfiles(workspace.id).find(agent => agent.id === req.params.agentId);
    if (!current) {
      sendProblem(req, res, { status: 404, code: 'AGENT_NOT_FOUND', detail: 'Agent not found' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const permissions = Array.isArray(body.permissions) && body.permissions.every(value => value === 'read' || value === 'write' || value === 'review')
      ? body.permissions as Array<'read' | 'write' | 'review'>
      : current.permissions;
    const thinkingEffort = body.thinkingEffort === undefined
      ? current.thinkingEffort ?? 'auto'
      : body.thinkingEffort;
    if (!isThinkingEffort(thinkingEffort)) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'thinkingEffort must be auto, low, medium, high, or max' }); return;
    }
    const nextModel = typeof body.model === 'string' ? body.model.trim() || undefined : current.model;
    const provider = body.provider === undefined
      ? current.provider
      : isAgentProvider(body.provider) ? body.provider : undefined;
    if (body.provider !== undefined && !provider) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'provider must be codex, kimi, opencode, mimo, or custom' }); return;
    }
    try {
      // Validate the selected model against the same live capability metadata
      // used by the composer. A CLI-level capability is not enough here:
      // provider registries can expose different effort variants per model.
      const capableAgent = await withAgentCapability({ ...current, model: nextModel }, modelDiscovery);
      validateRuntimeOverrides(capableAgent, {
        ...(nextModel === undefined ? {} : { model: nextModel }),
        thinkingEffort,
      });
      const agent = store.updateAgentProfile(workspace.id, current.id, {
        name: typeof body.name === 'string' ? body.name : current.name,
        roleTitle: typeof body.roleTitle === 'string' ? body.roleTitle : current.roleTitle,
        systemPrompt: typeof body.systemPrompt === 'string' ? body.systemPrompt : current.systemPrompt,
        permissions,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : current.enabled,
        provider,
        model: nextModel,
        thinkingEffort,
      });
      res.json({ agent: await withAgentCapability(agent, modelDiscovery) });
    } catch (error) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  }));

  router.post('/agents/:agentId/models/refresh', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const current = store.listAgentProfiles(workspace.id).find(agent => agent.id === req.params.agentId);
    if (!current) {
      sendProblem(req, res, { status: 404, code: 'AGENT_NOT_FOUND', detail: 'Agent not found' });
      return;
    }
    try {
      res.json({ agent: await withAgentCapability(current, modelDiscovery, true) });
    } catch (error) {
      console.error('[conversations] refresh agent models failed', error);
      sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
    }
  }));

  router.get('/conversations', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    const conversations = store.listConversations(workspace.id)
      .filter(conversation => !agentId || conversation.agentId === agentId);
    res.json({ conversations });
  });

  router.post('/conversations', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const { agentId, title, type, memberAgentIds, leaderAgentId: rawLeaderAgentId, members: rawMembers, dispatchMode: rawDispatchMode } = req.body as {
      agentId?: unknown; title?: unknown; type?: unknown; memberAgentIds?: unknown; leaderAgentId?: unknown;
      members?: unknown; dispatchMode?: unknown;
    };
    if (type === 'group') {
      const explicitMembers = parseGroupMembers(rawMembers);
      if (rawMembers !== undefined && explicitMembers === undefined) {
        sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'members must contain at least two valid group members' }); return;
      }
      const legacyIds = Array.isArray(memberAgentIds) && memberAgentIds.every(id => typeof id === 'string') ? memberAgentIds as string[] : undefined;
      const ids = explicitMembers?.map(member => member.agentId) ?? legacyIds;
      const leader = explicitMembers?.find(member => member.roleKind === 'leader')?.agentId
        ?? (typeof rawLeaderAgentId === 'string' ? rawLeaderAgentId : undefined);
      if (!ids || ids.length < 2 || !leader) {
        sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Group requires at least two members and exactly one leader' }); return;
      }
      const uniqueIds = [...new Set(ids)];
      if (uniqueIds.length !== ids.length || !uniqueIds.includes(leader)) {
        sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Group members must be unique and include the leader' }); return;
      }
      const dispatchMode = rawDispatchMode === undefined ? (explicitMembers ? 'leader_route' : 'full_pipeline') : parseDispatchMode(rawDispatchMode);
      if (!dispatchMode) {
        sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'dispatchMode must be leader_route, full_pipeline, or mentioned_only' });
        return;
      }
      const leaderAgentId = leader;
      const profiles = new Map(store.listAgentProfiles(workspace.id).filter(profile => profile.enabled).map(profile => [profile.id, profile]));
      if (uniqueIds.some(id => !profiles.has(id))) {
        sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Group member is unavailable' });
        return;
      }
      const now = new Date().toISOString();
      const conversation: Conversation = {
        id: randomUUID(), workspaceId: workspace.id, type: 'group',
        dispatchMode,
        settingsVersion: 1,
        title: typeof title === 'string' && title.trim() ? title.trim() : '新建协作群聊', createdAt: now, updatedAt: now,
      };
      const members = uniqueIds.map(id => ({
        conversationId: conversation.id, agentId: id, roleTitle: id === leaderAgentId ? '群主' : profiles.get(id)!.roleTitle,
        isLeader: id === leaderAgentId, createdAt: now,
      }));
      const configuredMembers: ConversationMember[] = members.map((member, index) => {
        const explicit = explicitMembers?.find(item => item.agentId === member.agentId);
        const roleKind: CollaborationRole = explicit?.roleKind ?? (member.isLeader ? 'leader' : 'worker');
        return {
          ...member,
          roleKind,
          isLeader: roleKind === 'leader',
          roleTitle: explicit?.roleTitle ?? member.roleTitle,
          sequence: explicit?.sequence ?? (index + 1) * 10,
          ...(explicit?.model === undefined ? {} : { model: explicit.model }),
          ...(explicit?.thinkingEffort === undefined ? {} : { thinkingEffort: explicit.thinkingEffort }),
          ...(explicit?.additionalInstructions === undefined ? {} : { additionalInstructions: explicit.additionalInstructions }),
        };
      });
      try {
        await validateGroupMemberRuntimeSettings(profiles, configuredMembers, modelDiscovery);
        store.createGroupConversation(conversation, configuredMembers);
      } catch (error) {
        sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: error instanceof Error ? error.message : String(error) }); return;
      }
      return res.status(201).json({ conversation, members: store.listConversationMembers(workspace.id, conversation.id) });
    }
    if (!agentId || typeof agentId !== 'string') {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'agentId is required' });
      return;
    }

    const agent = store.listAgentProfiles(workspace.id).find(profile => profile.id === agentId && profile.enabled);
    if (!agent) {
      sendProblem(req, res, { status: 400, code: 'AGENT_UNAVAILABLE', detail: 'Agent is unavailable' });
      return;
    }

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
  }));

  router.patch('/conversations/:conversationId/settings', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const conversation = store.listConversations(workspace.id).find(item => item.id === req.params.conversationId);
    if (!conversation) {
      sendProblem(req, res, { status: 404, code: 'CONVERSATION_NOT_FOUND', detail: 'Conversation not found' });
      return;
    }
    if (conversation.type !== 'direct' || !conversation.agentId) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Only direct conversations support model settings' }); return;
    }
    const agent = store.listAgentProfiles(workspace.id).find(profile => profile.id === conversation.agentId && profile.enabled);
    if (!agent) {
      sendProblem(req, res, { status: 400, code: 'AGENT_UNAVAILABLE', detail: 'Conversation agent is unavailable' });
      return;
    }
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
        throw new Error('thinkingEffort must be auto, low, medium, high, or max');
      }
      const capableAgent = await withAgentCapability(agent, modelDiscovery);
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
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  }));

  router.get('/conversations/:conversationId/members', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const conversation = store.listConversations(workspace.id).find(item => item.id === req.params.conversationId);
    if (!conversation) {
      sendProblem(req, res, { status: 404, code: 'CONVERSATION_NOT_FOUND', detail: 'Conversation not found' });
      return;
    }
    if (conversation.type !== 'group') {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Only group conversations have members' });
      return;
    }
    res.json({ conversation, members: store.listConversationMembers(workspace.id, conversation.id) });
  });

  router.get('/conversations/:conversationId/runs/:runId/decision', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run || run.conversationId !== req.params.conversationId) {
      sendProblem(req, res, { status: 404, code: 'RUN_NOT_FOUND', detail: 'Run not found' });
      return;
    }
    res.json({ decision: runDecisionService.get(workspace.id, run.id) ?? null });
  });

  router.post('/conversations/:conversationId/runs/:runId/decisions/:decisionId/resolve', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run || run.conversationId !== req.params.conversationId) {
      sendProblem(req, res, { status: 404, code: 'RUN_NOT_FOUND', detail: 'Run not found' });
      return;
    }
    const decision = (req.body as { decision?: unknown }).decision;
    if (decision !== 'keep_and_continue' && decision !== 'retry_current' && decision !== 'abort') {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'decision is invalid' });
      return;
    }
    try {
      const resolved = runDecisionService.resolve(workspace.id, req.params.decisionId, decision as PartialWriteDecision);
      if (resolved.runId !== run.id) {
        sendProblem(req, res, { status: 404, code: 'DECISION_NOT_FOUND', detail: 'Decision not found for run' });
        return;
      }
      if (decision === 'abort') store.updateRun(workspace.id, run.id, { status: 'cancelled', completedAt: new Date().toISOString(), failureReason: 'User aborted after partial write failure' });
      else if (run.status === 'waiting_user') store.updateRun(workspace.id, run.id, { status: 'running', waitingQuestion: undefined, waitingExecutionId: undefined, waitingAgentId: undefined, completedAt: undefined });
      res.json({ decision: resolved, run: store.getRun(workspace.id, run.id) });
    } catch (error) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  router.patch('/conversations/:conversationId', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    try {
      const current = store.listConversations(workspace.id).find(item => item.id === req.params.conversationId);
      if (!current) {
        sendProblem(req, res, { status: 404, code: 'CONVERSATION_NOT_FOUND', detail: 'Conversation not found' });
        return;
      }
      let conversation = current;
      if (body.title !== undefined) {
        if (typeof body.title !== 'string') {
          sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'title must be a string' });
          return;
        }
        conversation = store.updateConversationTitle(workspace.id, req.params.conversationId, body.title);
      }
      if (current.type === 'group' && (body.members !== undefined || body.dispatchMode !== undefined)) {
        const parsedMembers = parseGroupMembers(body.members);
        if (!parsedMembers) {
          sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'members must define at least two explicit roles' });
          return;
        }
        const now = new Date().toISOString();
        const members: ConversationMember[] = parsedMembers.map((member, index) => ({
          conversationId: current.id,
          agentId: member.agentId,
          roleKind: member.roleKind,
          roleTitle: member.roleTitle ?? '协作成员',
          isLeader: member.roleKind === 'leader',
          sequence: member.sequence ?? (index + 1) * 10,
          createdAt: now,
          ...(member.model === undefined ? {} : { model: member.model }),
          ...(member.thinkingEffort === undefined ? {} : { thinkingEffort: member.thinkingEffort }),
          ...(member.additionalInstructions === undefined ? {} : { additionalInstructions: member.additionalInstructions }),
        }));
        const dispatchMode = body.dispatchMode === undefined ? (current.dispatchMode ?? 'leader_route') : parseDispatchMode(body.dispatchMode);
        if (!dispatchMode) {
          sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'dispatchMode must be leader_route, full_pipeline, or mentioned_only' });
          return;
        }
        await validateGroupMemberRuntimeSettings(new Map(store.listAgentProfiles(workspace.id).filter(profile => profile.enabled).map(profile => [profile.id, profile])), members, modelDiscovery);
        const expectedSettingsVersion = body.expectedSettingsVersion === undefined ? undefined : body.expectedSettingsVersion;
        if (expectedSettingsVersion !== undefined && (typeof expectedSettingsVersion !== 'number' || !Number.isSafeInteger(expectedSettingsVersion))) {
          sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'expectedSettingsVersion must be an integer' }); return;
        }
        const updated = store.updateGroupConversation(workspace.id, current.id, { members, dispatchMode, expectedSettingsVersion });
        conversation = updated.conversation;
        return res.json({ conversation, members: updated.members });
      }
      res.json({ conversation });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const conflict = message.includes('settings version conflict');
      sendProblem(req, res, { status: conflict ? 409 : 400, code: conflict ? 'SETTINGS_VERSION_CONFLICT' : 'VALIDATION_FAILED', detail: message });
    }
  }));

  router.delete('/conversations/:conversationId', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    try {
      const attachments = store.listConversationAttachments(workspace.id, req.params.conversationId);
      await artifactService?.cleanupConversation(workspace.id, req.params.conversationId);
      store.deleteConversation(workspace.id, req.params.conversationId);
      await cleanupConversationAttachments(workspace.rootPath, attachments);
      res.json({ conversationId: req.params.conversationId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = message === 'Conversation not found' || message === 'Conversation not found in workspace';
      sendProblem(req, res, { status: missing ? 404 : 400, code: missing ? 'CONVERSATION_NOT_FOUND' : 'CONVERSATION_DELETE_FAILED', detail: message });
    }
  }));

  router.get('/conversations/:conversationId/messages', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const limit = parseLimit(req.query.limit);
    res.json({ messages: store.listMessages(workspace.id, req.params.conversationId, limit) });
  });

  router.get('/conversations/:conversationId/executions', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const executions = store.listExecutions(workspace.id, req.params.conversationId)
      .map(execution => ({ ...execution, events: store.listExecutionEvents(workspace.id, execution.id) }));
    res.json({ executions });
  });

  router.get('/attachments/:attachmentId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const attachment = store.getAttachment(workspace.id, req.params.attachmentId);
    if (!attachment) {
      sendProblem(req, res, { status: 404, code: 'ATTACHMENT_NOT_FOUND', detail: 'Attachment not found' });
      return;
    }
    try {
      res.sendFile(getAttachmentAbsolutePath(workspace.rootPath, attachment.relativePath), { headers: { 'Cache-Control': 'private, max-age=3600' } }, error => {
        if (error && !res.headersSent) sendProblem(req, res, { status: 404, code: 'ATTACHMENT_FILE_NOT_FOUND', detail: 'Attachment file not found' });
      });
    } catch (error) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/conversations/:conversationId/messages/stream', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const content = typeof body.content === 'string' ? body.content : '';
    const intent = parseRunIntent(body.intent);
    if (!intent) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'intent must be ask, execute, or review' });
      return;
    }
    const mentionedAgentIds = parseMentionedAgentIds(body.mentionedAgentIds);
    if (!mentionedAgentIds) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'mentionedAgentIds must be an array of agent ids' });
      return;
    }
    let attachments: ConversationAttachmentInput[];
    try {
      attachments = parseConversationAttachmentInputs(body.attachments);
      validateConversationAttachmentInputs(attachments);
    } catch (error) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: error instanceof Error ? error.message : String(error) }); return;
    }
    if (!content.trim() && attachments.length === 0) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'content or image attachment is required' });
      return;
    }

    const conversation = store.listConversations(workspace.id)
      .find(item => item.id === req.params.conversationId);
    if (!conversation) {
      sendProblem(req, res, { status: 404, code: 'CONVERSATION_NOT_FOUND', detail: 'Conversation not found' });
      return;
    }
    if (conversation.type === 'direct' && !conversation.agentId) {
      sendProblem(req, res, { status: 404, code: 'CONVERSATION_NOT_FOUND', detail: 'Direct conversation not found' });
      return;
    }
    if (conversation.type === 'group') {
      sendProblem(req, res, { status: 409, code: 'GROUP_DISCUSSION_REQUIRED', detail: 'GROUP_DISCUSSION_REQUIRED' }); return;
    }

    let runtimeOverrides: Pick<AgentProfile, 'model' | 'thinkingEffort'> | undefined;
    if (conversation.type === 'direct') {
      try {
        const agent = store.listAgentProfiles(workspace.id).find(item => item.id === conversation.agentId && item.enabled);
        if (!agent) {
          sendProblem(req, res, { status: 400, code: 'AGENT_UNAVAILABLE', detail: 'Agent is unavailable' });
          return;
        }
        const capableAgent = await withAgentCapability(agent, modelDiscovery);
        try {
          if (intent !== 'execute') assertRuntimePolicySupported(resolveRuntimePolicy(intent, capableAgent), process.env.AGENTOS_FORCE_MOCK === 'true');
        } catch (error) {
          sendProblem(req, res, { status: 409, code: 'RUNTIME_POLICY_UNSUPPORTED', detail: error instanceof Error ? error.message : String(error) }); return;
        }
        runtimeOverrides = parseRuntimeOverrides(req.body as Record<string, unknown>);
        validateRuntimeOverrides(capableAgent, runtimeOverrides);
      } catch (error) {
        sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: error instanceof Error ? error.message : String(error) }); return;
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
      // The initial stream is a transport subscription; disconnecting it must
      // not cancel the owned execution. Explicit cancellation uses the public
      // operation path and its proof-backed Process stop authority.
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
          intent,
          memoryEnabled: workspace.memoryEnabled,
          signal: abortController.signal,
          onRunCreated: attachRun,
          onExecutionEvent: event => { if (activeRunId) runStreams.emit(activeRunId, 'execution', event); },
          onRuntimeEvent: event => { if (activeRunId) runStreams.emit(activeRunId, 'runtime', event); },
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
          onRuntimeEvent: event => { if (activeRunId) runStreams.emit(activeRunId, 'runtime', event); },
          onAgentMessage: message => { if (activeRunId) runStreams.emit(activeRunId, 'message', { message }); },
          mentionedAgentIds,
          intent,
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
  }));

  router.get('/conversations/:conversationId/runs/:runId/stream', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const conversation = store.listConversations(workspace.id).find(item => item.id === req.params.conversationId);
    if (!conversation) {
      sendProblem(req, res, { status: 404, code: 'CONVERSATION_NOT_FOUND', detail: 'Conversation not found' });
      return;
    }
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run || run.conversationId !== conversation.id) {
      sendProblem(req, res, { status: 404, code: 'RUN_NOT_FOUND', detail: 'Run not found' });
      return;
    }
    if (!runStreams.has(run.id)) {
      sendProblem(req, res, { status: 503, code: 'RUN_STREAM_UNAVAILABLE', detail: 'Run stream is no longer available' });
      return;
    }

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
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const conversation = store.listConversations(workspace.id).find(item => item.id === req.params.conversationId);
    if (!conversation) {
      sendProblem(req, res, { status: 404, code: 'CONVERSATION_NOT_FOUND', detail: 'Conversation not found' });
      return;
    }
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run || run.conversationId !== conversation.id) {
      sendProblem(req, res, { status: 404, code: 'RUN_NOT_FOUND', detail: 'Run not found' });
      return;
    }
    if (!runStreams.cancel(run.id)) {
      sendProblem(req, res, { status: 409, code: 'RUN_NOT_ACTIVE', detail: 'Run is no longer active' });
      return;
    }
    res.json({ runId: run.id, cancelled: true });
  });

  router.post('/conversations/:conversationId/runs/:runId/resume/stream', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const conversation = store.listConversations(workspace.id).find(item => item.id === req.params.conversationId);
    if (!conversation) {
      sendProblem(req, res, { status: 404, code: 'CONVERSATION_NOT_FOUND', detail: 'Conversation not found' });
      return;
    }
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: '补充信息不能为空' });
      return;
    }
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run || run.conversationId !== conversation.id) {
      sendProblem(req, res, { status: 404, code: 'RUN_NOT_FOUND', detail: 'Run not found' });
      return;
    }
    if (run.status !== 'waiting_user') {
      sendProblem(req, res, { status: 409, code: 'RUN_NOT_WAITING', detail: 'Run is not waiting for user input' });
      return;
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
    runStreams.open(run.id, abortController);
    const unsubscribe = runStreams.subscribe(run.id, 0, item => send(item.event, item.data)) ?? (() => {});
    runStreams.emit(run.id, 'run', { runId: run.id, run });
    res.on('close', () => {
      unsubscribe();
      stopHeartbeat();
    });
    try {
      if (conversation.type === 'group') {
        const result = await service.resumeGroupMessage({
          workspaceId: workspace.id, workspaceRoot: workspace.rootPath, conversationId: conversation.id,
          runId: run.id, content, memoryEnabled: workspace.memoryEnabled, signal: abortController.signal,
          onExecutionEvent: event => runStreams.emit(run.id, 'execution', event),
          onRuntimeEvent: event => runStreams.emit(run.id, 'runtime', event),
          onAgentMessage: message => runStreams.emit(run.id, 'message', { message }),
        });
        runStreams.finish(run.id, 'done', { executions: result.executions });
      } else {
        const result = await service.resumeDirectMessage({
          workspaceId: workspace.id, workspaceRoot: workspace.rootPath, conversationId: conversation.id,
          runId: run.id, content, memoryEnabled: workspace.memoryEnabled, signal: abortController.signal,
          onExecutionEvent: event => runStreams.emit(run.id, 'execution', event),
          onRuntimeEvent: event => runStreams.emit(run.id, 'runtime', event),
        });
        runStreams.emit(run.id, 'message', { message: result.responseMessage });
        runStreams.finish(run.id, 'done', { execution: result.execution });
      }
    } catch (error) {
      runStreams.finish(run.id, 'error', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      unsubscribe();
      stopHeartbeat();
      res.end();
    }
  }));

  return router;
}

function isAgentProvider(value: unknown): value is AgentProvider {
  return value === 'codex' || value === 'kimi' || value === 'opencode' || value === 'mimo' || value === 'custom';
}

function parseDispatchMode(value: unknown): GroupDispatchMode | undefined {
  return value === 'leader_route' || value === 'full_pipeline' || value === 'mentioned_only' ? value : undefined;
}

function parseMentionedAgentIds(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) return undefined;
  return [...new Set(value.map(item => (item as string).trim()))];
}

function parseRunIntent(value: unknown): RunIntent | undefined {
  if (value === undefined) return 'execute';
  return value === 'ask' || value === 'execute' || value === 'review' ? value : undefined;
}

function parseGroupMembers(value: unknown): Array<{
  agentId: string;
  roleKind: CollaborationRole;
  roleTitle?: string;
  sequence?: number;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  additionalInstructions?: string;
}> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const members: Array<{
    agentId: string; roleKind: CollaborationRole; roleTitle?: string; sequence?: number;
    model?: string; thinkingEffort?: ThinkingEffort; additionalInstructions?: string;
  }> = [];
  try {
    for (const item of value) {
      if (!item || typeof item !== 'object') return undefined;
      const entry = item as Record<string, unknown>;
      if (typeof entry.agentId !== 'string' || !entry.agentId.trim()) return undefined;
      if (entry.roleKind !== 'leader' && entry.roleKind !== 'worker' && entry.roleKind !== 'reviewer' && entry.roleKind !== 'specialist') return undefined;
      if (entry.sequence !== undefined && (!Number.isInteger(entry.sequence) || Number(entry.sequence) <= 0)) return undefined;
      const settings = parseGroupMemberSettings(entry);
      members.push({
        agentId: entry.agentId,
        roleKind: entry.roleKind,
        ...(settings.roleTitle === undefined ? {} : { roleTitle: settings.roleTitle }),
        ...(entry.sequence !== undefined ? { sequence: Number(entry.sequence) } : {}),
        ...(settings.model === undefined ? {} : { model: settings.model }),
        ...(settings.thinkingEffort === undefined ? {} : { thinkingEffort: settings.thinkingEffort }),
        ...(settings.additionalInstructions === undefined ? {} : { additionalInstructions: settings.additionalInstructions }),
      });
    }
  } catch {
    return undefined;
  }
  return members;
}

async function validateGroupMemberRuntimeSettings(
  profiles: Map<string, AgentProfile>,
  members: readonly ConversationMember[],
  modelDiscovery: ModelDiscoveryService,
): Promise<void> {
  await Promise.all(members.map(async member => {
    const profile = profiles.get(member.agentId);
    if (!profile) throw new Error('Group member is unavailable');
    const capable = await withAgentCapability(profile, modelDiscovery);
    validateRuntimeOverrides(capable, {
      ...(member.model === undefined ? {} : { model: member.model }),
      ...(member.thinkingEffort === undefined ? {} : { thinkingEffort: member.thinkingEffort }),
    });
  }));
}

function parseStreamCursor(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : 0;
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function isThinkingEffort(value: unknown): value is ThinkingEffort {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high' || value === 'max';
}

function parseRuntimeOverrides(body: Record<string, unknown>): Pick<AgentProfile, 'model' | 'thinkingEffort'> | undefined {
  const model = body.model === undefined ? undefined : typeof body.model === 'string' ? body.model.trim() : null;
  if (model === null) throw new Error('model must be a string');
  const thinkingEffort = body.thinkingEffort === undefined ? undefined : body.thinkingEffort;
  if (thinkingEffort !== undefined && !isThinkingEffort(thinkingEffort)) {
    throw new Error('thinkingEffort must be auto, low, medium, high, or max');
  }
  if (!model && thinkingEffort === undefined) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(thinkingEffort ? { thinkingEffort } : {}),
  };
}

function parseLimit(value: unknown): number {
  if (typeof value !== 'string') return 50;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 50;
}
