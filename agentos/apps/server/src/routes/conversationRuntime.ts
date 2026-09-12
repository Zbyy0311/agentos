import { Router, type Request, type Response } from 'express';

import { createEntityId } from '../store/Identity.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createSseWriter, startSseHeartbeat } from './sse.js';
import {
  ConversationTurnDriver,
  createDurableTurnContextSnapshotPort,
  type ChatWorkspaceAuthorityPort,
} from '../services/ConversationTurnDriver.js';
import { WorkspaceAdmissionRepository } from '../store/WorkspaceAdmissionRepository.js';
import {
  ConversationCompactionService,
  createConversationCompactionPort,
} from '../services/ConversationCompactionService.js';
import { ConversationCompactionTrigger } from '../services/ConversationCompactionTrigger.js';
import { ProviderCompactionSummarizer } from '../services/ProviderCompactionSummarizer.js';
import { SUMMARIZATION_CLI_PROFILES } from '../services/summarizationCliProfiles.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompactionPolicyRepository, CompactionRepository } from '../store/CompactionRepository.js';
import { GroupTurnDriver, GroupTurnDriverError } from '../services/GroupTurnDriver.js';
import {
  CONVERSATION_REPLY_MODES,
  type ConversationReplyMode,
} from '@agentos/shared';
import type { ConversationStatus } from '@agentos/shared';

/**
 * Forward Conversation Runtime HTTP surface (Lite 11-API-Specification section 10).
 *
 * Workspace-scoped under `/api/workspaces/:workspaceId/runtime` — the forward paths
 * from the Lite contract are realized under the app's existing workspace mount without
 * colliding with the legacy `/conversations` surface, which remains COMPATIBILITY.
 *
 * This router is a thin API boundary over the merged CR seams:
 *   ConversationRepository (CR-1) + AgentTurnRepository (CR-2) + ConversationStreamService
 *   (CR-3) + ConversationBridgeService (CR-4a) + BoundedGroupService (CR-5) +
 *   AgentHistoryService (CR-6).
 *
 * It never spawns a process, never touches Provider credentials, and sends a user
 * Message by persisting before any routing. The chat reply stream (a Provider-backed
 * Agent Turn over the CR-3 seam) is the Direct Conversation UX slice, not this one.
 */

interface ErrorMapping { readonly status: number; readonly code: string }

function mapError(error: unknown): ErrorMapping {
  const code = error instanceof Error ? (error as { code?: string }).code ?? error.message : String(error);
  if (/NOT_FOUND/.test(code)) return { status: 404, code };
  if (/INPUT_INVALID|INVALID/.test(code)) return { status: 400, code };
  if (/NOT_TRANSITIONABLE|CONFLICT|TERMINATED|BUDGET_EXCEEDED|LOOP_GUARD|ARCHIVED|NOT_ACTIVE/.test(code)) {
    return { status: 409, code };
  }
  return { status: 500, code };
}

function fail(res: Response, error: unknown): void {
  const mapped = mapError(error);
  res.status(mapped.status).json({ error: mapped.code });
}

function isConversationReplyMode(value: unknown): value is ConversationReplyMode {
  return (CONVERSATION_REPLY_MODES as readonly unknown[]).includes(value);
}

export function createConversationRuntimeRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });

  const requireWorkspace = (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return null;
    }
    return workspace;
  };

  const conversations = () => store.conversationRepository();

  /**
   * LITE-09-102 / D2=A: chat has no implicit modifying authority. The forward
   * chat path is classified as modifying (no adapter proves enforced
   * read-only), so it refuses while another subject holds the Workspace's
   * single-writer authority instead of running concurrently with it.
   */
  const chatWorkspaceAuthority: ChatWorkspaceAuthorityPort = {
    findModifyingHolder: (workspaceId: string) => {
      const row = new WorkspaceAdmissionRepository(store.getDatabase())
        .listByWorkspace(workspaceId)
        .find(admission => admission.effectiveMutationClass === 'MODIFYING' && admission.state === 'GRANTED');
      if (row === undefined) return undefined;
      return {
        subjectKind: row.subjectKind,
        subjectId: row.canonicalRunId ?? row.legacyRunId ?? row.id,
      };
    },
  };

  // S6: published compaction summaries apply to new Turn contexts. The hard
  // application budget is the frozen lite-v1 fallback when no provider bound
  // is known, which is what the compaction policy records today.
  const compactionPort = createConversationCompactionPort(store);
  const compactionBudget = { hardBudgetTokens: 16384 };

  // S6 / LITE-09-106 + LITE-09-107: the automatic trigger. One engine per
  // router and one summary execution channel: only an allowlisted CLI profile
  // may produce a summary, and it runs in an isolated scratch directory that
  // is outside every Workspace. Without an allowlisted profile the attempt
  // fails closed and the durable task records the failure code.
  const compactionEngine = new ConversationCompactionService({
    store,
    summarizer: new ProviderCompactionSummarizer({
      scratchRoot: join(tmpdir(), 'agentos-compaction-scratch'),
      profiles: SUMMARIZATION_CLI_PROFILES,
    }),
  });
  const compactionTrigger = new ConversationCompactionTrigger({
    store,
    engine: compactionEngine,
    getAgent: (workspaceId, agentId) => store.listAgentProfiles(workspaceId).find(profile => profile.id === agentId),
    onAttempt: attempt => console.log(
      `COMPACTION_ATTEMPT outcome=${attempt.outcome} policy=${attempt.policyVersion}`
      + (attempt.taskId === undefined ? '' : ` task=${attempt.taskId}`),
    ),
    onError: (code, error) => console.error(`COMPACTION_TRIGGER_ERROR code=${code}`, error),
  });

  // ---- Conversations ------------------------------------------------------

  router.post('/conversations', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = req.body as Record<string, unknown>;
    const kind = body.kind;
    if (kind !== 'direct' && kind !== 'group') {
      res.status(400).json({ error: 'kind must be direct or group' });
      return;
    }
    const title = typeof body.title === 'string' && body.title.trim().length > 0 ? body.title.trim() : null;
    const now = new Date().toISOString();
    const userId = typeof body.userId === 'string' && body.userId.trim().length > 0
      ? body.userId.trim()
      : store.getDefaultUserProfile().id;
    try {
      if (kind === 'direct') {
        const agentId = typeof body.agentId === 'string' ? body.agentId : null;
        if (agentId === null) { res.status(400).json({ error: 'agentId is required for a direct Conversation' }); return; }
        const agent = store.listAgentProfiles(workspace.id).find(p => p.id === agentId && p.enabled);
        if (!agent) { res.status(400).json({ error: 'Agent is unavailable' }); return; }
        const conversation = conversations().createConversation({
          id: createEntityId('conversation'), workspaceId: workspace.id, kind: 'direct',
          title: title ?? `与 ${agent.name} 的对话`, createdAt: now,
        });
        conversations().addMember({
          id: createEntityId('conversation'), conversationId: conversation.id, workspaceId: workspace.id,
          subjectType: 'user', subjectId: userId, displayNameSnapshot: 'You', role: 'owner',
          replyMode: 'always', joinedAt: now,
        });
        conversations().addMember({
          id: createEntityId('conversation'), conversationId: conversation.id, workspaceId: workspace.id,
          subjectType: 'agent', subjectId: agent.id, displayNameSnapshot: agent.name, role: 'participant',
          replyMode: 'always', joinedAt: now,
        });
        res.status(201).json({ conversation, members: conversations().listMembers(workspace.id, conversation.id) });
        return;
      }
      // group
      const replyMode = body.replyMode;
      if (replyMode === undefined || !isConversationReplyMode(replyMode)) {
        res.status(400).json({ error: 'replyMode is required for a group Conversation' });
        return;
      }
      const memberAgentIds = Array.isArray(body.memberAgentIds)
        ? (body.memberAgentIds as unknown[]).filter((id): id is string => typeof id === 'string')
        : [];
      if (memberAgentIds.length < 2) {
        res.status(400).json({ error: 'a group Conversation needs at least two Agents' });
        return;
      }
      const profiles = new Map(store.listAgentProfiles(workspace.id).filter(p => p.enabled).map(p => [p.id, p]));
      if (memberAgentIds.some(id => !profiles.has(id))) {
        res.status(400).json({ error: 'a group member Agent is unavailable' });
        return;
      }
      const conversation = conversations().createConversation({
        id: createEntityId('conversation'), workspaceId: workspace.id, kind: 'group',
        title: title ?? 'Group', replyMode, createdAt: now,
      });
      conversations().addMember({
        id: createEntityId('conversation'), conversationId: conversation.id, workspaceId: workspace.id,
        subjectType: 'user', subjectId: userId, displayNameSnapshot: 'You', role: 'owner',
        replyMode: 'always', joinedAt: now,
      });
      for (const agentId of memberAgentIds) {
        conversations().addMember({
          id: createEntityId('conversation'), conversationId: conversation.id, workspaceId: workspace.id,
          subjectType: 'agent', subjectId: agentId, displayNameSnapshot: profiles.get(agentId)!.name,
          role: 'participant', replyMode: 'always', joinedAt: now,
        });
      }
      res.status(201).json({ conversation, members: conversations().listMembers(workspace.id, conversation.id) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/conversations', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const status = req.query.status;
    if (status !== undefined && (status !== 'active' && status !== 'archived')) {
      res.status(400).json({ error: 'status must be active or archived' });
      return;
    }
    res.json({ conversations: conversations().listConversations(workspace.id, status as ConversationStatus | undefined) });
  });

  router.get('/conversations/:conversationId', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const conversation = conversations().findConversationById(workspace.id, req.params.conversationId);
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }
    res.json({ conversation });
  });

  router.post('/conversations/:conversationId/archive', (req: Request, res: Response) => {
    transitionConversation(req, res, 'archive');
  });
  router.post('/conversations/:conversationId/restore', (req: Request, res: Response) => {
    transitionConversation(req, res, 'restore');
  });
  function transitionConversation(req: Request, res: Response, action: 'archive' | 'restore'): void {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = req.body as Record<string, unknown>;
    const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : null;
    if (expectedVersion === null) { res.status(400).json({ error: 'expectedVersion is required' }); return; }
    try {
      const conversation = conversations().transitionConversation({
        workspaceId: workspace.id, conversationId: req.params.conversationId,
        expectedVersion, action, changedAt: new Date().toISOString(),
      });
      res.json({ conversation });
    } catch (error) {
      fail(res, error);
    }
  }

  router.get('/conversations/:conversationId/members', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    res.json({ members: conversations().listMembers(workspace.id, req.params.conversationId) });
  });

  router.get('/conversations/:conversationId/turns', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    res.json({ turns: store.agentTurnRepository().listTurnsByConversation(workspace.id, req.params.conversationId) });
  });

  /**
   * S6 Inspector read surface (LITE-09-104/107): the effective compaction
   * policy, every task of the Conversation with its frozen budget inputs, the
   * applied summary and the attempts/failure state. Read-only, no Provider
   * work, no mutation.
   */
  router.get('/conversations/:conversationId/compactions', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const compactions = new CompactionRepository(store.getDatabase());
    const tasks = compactions.listForConversation(workspace.id, req.params.conversationId);
    const policyIds = [...new Set(tasks.map(task => task.policyId))];
    // LITE-13-101 also has to answer WHO adopted a summary: a published summary
    // only matters through the Turn and frozen context snapshot that used it.
    // Both are read back from durable rows; nothing is inferred.
    const adoptions = (store.getDatabase().prepare(
      'SELECT id, turn_id, created_at, budget_json FROM cr_turn_context_snapshots WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
    ).all(req.params.conversationId) as Array<{ id: string; turn_id: string | null; created_at: string; budget_json: string }>)
      .flatMap(row => {
        let summaryId: unknown;
        try {
          summaryId = (JSON.parse(row.budget_json) as { compactionSummaryId?: unknown }).compactionSummaryId;
        } catch {
          return [];
        }
        return typeof summaryId === 'string'
          ? [{ snapshotId: row.id, turnId: row.turn_id, summaryId, createdAt: row.created_at }]
          : [];
      });
    res.json({
      adoptions,
      tasks: tasks.map(task => ({
        id: task.id, status: task.status, policyId: task.policyId,
        sourceStartMessageId: task.sourceStartMessageId, sourceEndMessageId: task.sourceEndMessageId,
        sourceMessageCount: task.sourceMessageCount, sourceHash: task.sourceHash,
        priorSummaryId: task.priorSummaryId,
        summary: task.summary, summaryHash: task.summaryHash, summaryTokenEstimate: task.summaryTokenEstimate,
        candidateId: task.candidateId,
        providerConfigId: task.providerConfigId, providerType: task.providerType,
        adapterId: task.adapterId, adapterVersion: task.adapterVersion, model: task.model,
        estimatorVersion: task.estimatorVersion, attempts: task.attempts,
        leaseOwner: task.leaseOwner, leaseExpiresAt: task.leaseExpiresAt,
        failureCode: task.failureCode, failureMessage: task.failureMessage,
        createdAt: task.createdAt, updatedAt: task.updatedAt, publishedAt: task.publishedAt,
        budget: JSON.parse(task.budgetJson) as Record<string, unknown>,
      })),
      policies: policyIds.map(id => {
        const policy = new CompactionPolicyRepository(store.getDatabase()).findById(id);
        return policy === undefined ? { id } : {
          id: policy.id, policyVersion: policy.policyVersion, triggerRatio: policy.triggerRatio,
          targetRatio: policy.targetRatio, minRecentMessages: policy.minRecentMessages,
          summaryMaxTokens: policy.summaryMaxTokens, timeoutMs: policy.timeoutMs,
          maxAutomaticRetries: policy.maxAutomaticRetries,
          fallbackApplicationBudgetTokens: policy.fallbackApplicationBudgetTokens,
          parameters: JSON.parse(policy.parametersJson) as Record<string, unknown>,
        };
      }),
    });
  });

  // ---- Messages -----------------------------------------------------------

  router.get('/conversations/:conversationId/messages', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const afterSequence = typeof req.query.afterSequence === 'string' ? Number(req.query.afterSequence) : 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      res.status(400).json({ error: 'afterSequence must be a non-negative integer' });
      return;
    }
    res.json({ messages: conversations().listMessages(workspace.id, req.params.conversationId, afterSequence) });
  });

  /**
   * Send a user Message: persisted before any routing. No Task, Run, or Agent Turn
   * is created here; the Provider-backed reply stream is the Direct Conversation UX
   * slice. clientMessageId makes a retried send converge on one Message.
   */
  router.post('/conversations/:conversationId/messages', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = req.body as Record<string, unknown>;
    const content = body.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    const kind = body.kind === undefined ? 'text' : body.kind;
    if (kind !== 'text') { res.status(400).json({ error: 'only text Messages are supported here' }); return; }
    try {
      const message = conversations().appendMessage({
        id: createEntityId('message'), conversationId: req.params.conversationId, workspaceId: workspace.id,
        senderType: 'user', kind: 'text', status: 'final', content,
        ...(typeof body.clientMessageId === 'string' && body.clientMessageId.trim().length > 0
          ? { clientMessageId: body.clientMessageId.trim() } : {}),
        createdAt: new Date().toISOString(),
      });
      res.status(201).json({ message });
    } catch (error) {
      fail(res, error);
    }
  });

  // Durable streaming reconnect (CR-3): replay checkpoints after the client cursor.
  router.get('/conversations/:conversationId/messages/:messageId/checkpoints', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const afterCursor = typeof req.query.afterCursor === 'string' ? Number(req.query.afterCursor) : 0;
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      res.status(400).json({ error: 'afterCursor must be a non-negative integer' });
      return;
    }
    try {
      const replay = store.conversationStreamService().replayStream({
        workspaceId: workspace.id, messageId: req.params.messageId, afterCursor,
      });
      if (replay.message.conversationId !== req.params.conversationId) {
        res.status(404).json({ error: 'Message not found in this Conversation' });
        return;
      }
      res.json(replay);
    } catch (error) {
      fail(res, error);
    }
  });

  // ---- Task / Run bridge (CR-4a) -------------------------------------------

  router.post('/messages/:messageId/create-task', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = req.body as Record<string, unknown>;
    try {
      const result = store.conversationBridgeService().createTaskFromMessage({
        workspaceId: workspace.id, messageId: req.params.messageId,
        createdBy: typeof body.createdBy === 'string' ? body.createdBy : store.getDefaultUserProfile().id,
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        createdAt: new Date().toISOString(),
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/messages/:messageId/start-run', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = req.body as Record<string, unknown>;
    try {
      const result = store.conversationBridgeService().startRunFromMessage({
        workspaceId: workspace.id, messageId: req.params.messageId,
        createdBy: typeof body.createdBy === 'string' ? body.createdBy : store.getDefaultUserProfile().id,
        ...(typeof body.objective === 'string' ? { objective: body.objective } : {}),
        ...(body.requestedIntent === 'READ_ONLY' || body.requestedIntent === 'MODIFYING'
          ? { requestedIntent: body.requestedIntent } : {}),
        createdAt: new Date().toISOString(),
      });
      res.status(result.runCreated ? 201 : 200).json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  // ---- Agent History (CR-6) ----------------------------------------------

  // ---- Bounded Group Conversation (CR-5) ---------------------------------

  router.post('/conversations/:conversationId/interactions', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = req.body as Record<string, unknown>;
    const budget = body.budget;
    if (typeof budget !== 'object' || budget === null) { res.status(400).json({ error: 'budget is required' }); return; }
    try {
      const interaction = store.boundedGroupService().createInteraction({
        workspaceId: workspace.id, conversationId: req.params.conversationId,
        budget: budget as never, createdAt: new Date().toISOString(),
      });
      res.status(201).json({ interaction });
    } catch (error) { fail(res, error); }
  });

  router.get('/interactions/:interactionId', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const interaction = store.boundedGroupService().findInteraction(workspace.id, req.params.interactionId);
    if (!interaction) { res.status(404).json({ error: 'Interaction not found' }); return; }
    res.json({
      interaction,
      replies: store.groupInteractionRepository().listReplies(interaction.id),
      budget: store.boundedGroupService().budgetStatus(interaction),
    });
  });

  router.post('/interactions/:interactionId/replies', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = req.body as Record<string, unknown>;
    try {
      const result = store.boundedGroupService().recordReply({
        workspaceId: workspace.id,
        interactionId: req.params.interactionId,
        agentId: typeof body.agentId === 'string' ? body.agentId : '',
        messageId: typeof body.messageId === 'string' ? body.messageId : '',
        content: typeof body.content === 'string' ? body.content : '',
        ...(typeof body.hopFromAgentId === 'string' ? { hopFromAgentId: body.hopFromAgentId } : {}),
        ...(Array.isArray(body.mentionTargets) ? { mentionTargets: (body.mentionTargets as unknown[]).filter((t): t is string => typeof t === 'string') } : {}),
        createdAt: new Date().toISOString(),
      });
      res.status(201).json(result);
    } catch (error) { fail(res, error); }
  });

  router.post('/interactions/:interactionId/stop', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = req.body as Record<string, unknown>;
    const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : null;
    if (expectedVersion === null) { res.status(400).json({ error: 'expectedVersion is required' }); return; }
    try {
      const interaction = store.boundedGroupService().stopInteraction({
        workspaceId: workspace.id, interactionId: req.params.interactionId,
        expectedVersion, endedAt: new Date().toISOString(),
      });
      res.json({ interaction });
    } catch (error) { fail(res, error); }
  });

  /**
   * Bounded group walk (CG-S5..CG-S9): resolve the speaker plan, then run each
   * speaker sequentially through the CR-3 reply stream and record every reply
   * through CR-5 `recordReply`. The runtime selects the speakers; the caller
   * supplies the triggering user Message and, for `manual` / `orchestrated`
   * modes, the explicit list / template order. The stream emits one
   * `group.plan` event (speakers + skipped with stable reasons), one
   * `group.turn.start` / `checkpoint` / `group.turn.final|failed` chain per
   * speaker, and one `group.done`.
   */
  router.post('/conversations/:conversationId/interactions/:interactionId/respond', async (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const conversation = conversations().findConversationById(workspace.id, req.params.conversationId);
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }
    if (conversation.kind !== 'group') { res.status(400).json({ error: 'GROUP_WALK_INPUT_INVALID' }); return; }
    if (conversation.status !== 'active') { res.status(409).json({ error: 'Conversation is archived' }); return; }
    const interaction = store.boundedGroupService().findInteraction(workspace.id, req.params.interactionId);
    if (!interaction || interaction.conversationId !== conversation.id) { res.status(404).json({ error: 'Interaction not found' }); return; }
    if (interaction.status !== 'active') {
      res.status(409).json({ error: 'GROUP_INTERACTION_TERMINATED' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sourceMessageId = typeof body.sourceMessageId === 'string' ? body.sourceMessageId : '';
    const source = sourceMessageId.length === 0
      ? undefined
      : conversations().findMessageById(workspace.id, sourceMessageId);
    if (!source || source.conversationId !== conversation.id || source.senderType !== 'user') {
      res.status(400).json({ error: 'GROUP_WALK_INPUT_INVALID' });
      return;
    }
    const stringList = (value: unknown): string[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return undefined;
      return value as string[];
    };
    const mentionedAgentIds = stringList(body.mentionedAgentIds);
    const namedAgentIds = stringList(body.namedAgentIds);
    const orchestratedOrder = stringList(body.orchestratedOrder);
    if ((body.mentionedAgentIds !== undefined && mentionedAgentIds === undefined)
      || (body.namedAgentIds !== undefined && namedAgentIds === undefined)
      || (body.orchestratedOrder !== undefined && orchestratedOrder === undefined)) {
      res.status(400).json({ error: 'GROUP_WALK_INPUT_INVALID' });
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
    const interactionId = interaction.id;
    const driver = new GroupTurnDriver(
      store.boundedGroupService(),
      store.groupInteractionRepository(),
      conversations(),
      store.conversationStreamService(),
      (workspaceId, agentId) => store.listAgentProfiles(workspaceId).find(p => p.id === agentId && p.enabled),
      {
        snapshots: createDurableTurnContextSnapshotPort(store),
        workspaceAuthority: chatWorkspaceAuthority,
        compaction: compactionPort,
        compactionBudget,
        compactionTrigger,
      },
    );
    try {
      const result = await driver.run(
        {
          workspaceId: workspace.id,
          workspaceRoot: workspace.rootPath,
          conversationId: conversation.id,
          interactionId,
          sourceMessageId: source.id,
          ...(mentionedAgentIds === undefined ? {} : { mentionedAgentIds }),
          ...(namedAgentIds === undefined ? {} : { namedAgentIds }),
          ...(orchestratedOrder === undefined ? {} : { orchestratedOrder }),
          createdAt: new Date().toISOString(),
        },
        {
          onPlan: plan => send('group.plan', {
            interactionId,
            speakers: plan.speakers.map(speaker => speaker.agentId),
            skipped: plan.skipped,
            ...(plan.terminalReason === undefined ? {} : { terminalReason: plan.terminalReason }),
          }),
          onSpeakerTurnStart: speaker => send('group.turn.start', { interactionId, agentId: speaker.agentId, turnId: speaker.turnId, messageId: speaker.messageId }),
          onSpeakerDelta: (agentId, turnId, messageId, delta, cursor) => send('checkpoint', { agentId, turnId, messageId, cursor, delta }),
          onSpeakerTurnEnd: outcome => send(
            outcome.status === 'final' ? 'group.turn.final' : 'group.turn.failed',
            { interactionId, agentId: outcome.agentId, turnId: outcome.turnId, messageId: outcome.messageId, replyId: outcome.replyId },
          ),
        },
      );
      send('group.done', {
        interactionId,
        endedBy: result.endedBy,
        speakers: result.speakers,
        ...(result.interaction === undefined ? {} : { interaction: result.interaction }),
      });
    } catch (error) {
      const code = error instanceof GroupTurnDriverError ? error.code : (error instanceof Error ? error.message : 'GROUP_WALK_FAILED');
      send('group.error', { interactionId, error: code });
      send('group.done', { interactionId, endedBy: 'provider-failed' });
    } finally {
      stopHeartbeat();
      res.end();
    }
  });

  /**
   * Send a user Message and stream the primary Agent member's reply as durable
   * checkpoints (CR-3). The reply's deltas are SSE 'checkpoint' events carrying the
   * durable cursor; a reconnect replays from the checkpoints endpoint. A chat reply
   * creates no Task or Run; browser disconnect closes only the subscription.
   */
  router.post('/conversations/:conversationId/messages/stream', async (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const conversation = conversations().findConversationById(workspace.id, req.params.conversationId);
    if (!conversation) { res.status(404).json({ error: 'Conversation not found' }); return; }
    if (conversation.status !== 'active') { res.status(409).json({ error: 'Conversation is archived' }); return; }
    const body = req.body as Record<string, unknown>;
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (content.length === 0) { res.status(400).json({ error: 'content is required' }); return; }
    const agent = conversations().listMembers(workspace.id, conversation.id)
      .find(member => member.subjectType === 'agent' && member.status === 'active');
    if (!agent) { res.status(400).json({ error: 'no active Agent member' }); return; }

    // Persist the user Message before any routing or Provider call.
    let userMessage;
    try {
      userMessage = conversations().appendMessage({
        id: createEntityId('message'), conversationId: conversation.id, workspaceId: workspace.id,
        senderType: 'user', kind: 'text', status: 'final', content, createdAt: new Date().toISOString(),
      });
    } catch (error) {
      fail(res, error);
      return;
    }

    const turnId = createEntityId('turn');
    const responseMessageId = createEntityId('message');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = createSseWriter(res);
    const stopHeartbeat = startSseHeartbeat(res);
    send('turn.start', { turnId, messageId: responseMessageId, sourceMessageId: userMessage.id });
    const driver = new ConversationTurnDriver(
      conversations(),
      store.conversationStreamService(),
      (workspaceId, agentId) => store.listAgentProfiles(workspaceId).find(p => p.id === agentId && p.enabled),
      undefined,
      {
        snapshots: createDurableTurnContextSnapshotPort(store),
        workspaceAuthority: chatWorkspaceAuthority,
        compaction: compactionPort,
        compactionBudget,
        compactionTrigger,
      },
    );
    try {
      const result = await driver.replyWithTurn({
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        conversationId: conversation.id,
        agentId: agent.subjectId,
        sourceMessageId: userMessage.id,
        content,
        turnId,
        responseMessageId,
        onDelta: (delta, cursor) => send('checkpoint', { messageId: responseMessageId, cursor, delta }),
        createdAt: new Date().toISOString(),
      });
      if (result.turn.status === 'final') {
        send('turn.final', { turn: result.turn, message: result.message });
      } else {
        send('turn.failed', { turn: result.turn, message: result.message });
      }
      send('done', { messageId: responseMessageId, turnId });
    } catch (error) {
      send('turn.failed', { error: error instanceof Error ? error.message : String(error) });
      send('done', { messageId: responseMessageId, turnId });
    } finally {
      stopHeartbeat();
      res.end();
    }
  });


  router.get('/agents/:agentId/history', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const q = req.query;
    try {
      const entries = store.agentHistoryService().history(workspace.id, req.params.agentId, {
        ...(typeof q.kind === 'string' ? { kind: q.kind as never } : {}),
        ...(typeof q.status === 'string' ? { status: q.status } : {}),
        ...(typeof q.conversationId === 'string' ? { conversationId: q.conversationId } : {}),
        ...(typeof q.taskId === 'string' ? { taskId: q.taskId } : {}),
        ...(typeof q.runId === 'string' ? { runId: q.runId } : {}),
        ...(typeof q.providerConfigId === 'string' ? { providerConfigId: q.providerConfigId } : {}),
        ...(typeof q.from === 'string' ? { from: q.from } : {}),
        ...(typeof q.to === 'string' ? { to: q.to } : {}),
        ...(typeof q.q === 'string' ? { q: q.q } : {}),
        ...(typeof q.limit === 'string' ? { limit: Number(q.limit) } : {}),
      });
      res.json({ history: entries });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
