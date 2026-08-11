import { randomUUID } from 'node:crypto';
import { ConversationAgentRunner, resolveImageInput, resolveRuntimePolicy, assertRuntimePolicySupported, type ConversationExecutionEvent as RunnerExecutionEvent, type NormalizedCliEvent } from '@agentos/agent-core';
import type { AgentEvent, AgentEventDraft, AgentExecution, AgentProfile, AgentRun, CliInvocationObservation, ConversationMessage, ExecutionStatus, MemoryUsage, PreferenceContext, RunCliInvocation, RunFileChange, RuntimeArtifact, RunIntent, RuntimePolicy } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { EventBus } from '../events/EventBus.js';
import { createAgentEvent } from '../events/createAgentEvent.js';
import { cleanupConversationAttachments, getAttachmentAbsolutePath, saveConversationAttachments, type ConversationAttachmentInput, type StoredConversationAttachment } from './ConversationAttachmentService.js';
import { MemoryRetriever } from './MemoryRetriever.js';
import { MAX_MEMORY_CHARACTERS, MAX_MEMORY_ITEMS, RunContextBuilder } from './RunContextBuilder.js';
import { RuntimeEventProjector } from './RuntimeEventProjector.js';
import { RuntimeArtifactCollector, type ArtifactCollectionContext } from './RuntimeArtifactCollector.js';
import { RuntimeArtifactService } from './RuntimeArtifactService.js';
import { PreferenceService, type ObserveRunInput } from './PreferenceService.js';
import { canTransitionRunStep, RunStepService } from './RunStepService.js';
import { RunDecisionService } from './RunDecisionService.js';
import { buildGroupTurns, resolveDispatchDecision } from './GroupDispatchService.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorktreeArtifactService } from './WorktreeArtifactService.js';
import { RuntimeEventBuffer } from './RuntimeEventBuffer.js';

type StreamExecutionEvent = RunnerExecutionEvent & { agentId: string; agentName: string };
const CRITICAL_EVENT_PERSISTENCE_FAILURE = '关键事件持久化失败';
const MEMORY_USAGE_PERSISTENCE_FAILURE = '记忆使用记录持久化失败';
const GROUP_WAITING_USER_FAILURE = '群聊暂不支持等待用户恢复';

export interface SendDirectMessageInput {
  workspaceId: string;
  workspaceRoot: string;
  conversationId: string;
  agentId: string;
  content: string;
  attachments?: ConversationAttachmentInput[];
  runtimeOverrides?: Pick<AgentProfile, 'model' | 'thinkingEffort'>;
  memoryEnabled?: boolean;
  signal?: AbortSignal;
  onRunCreated?: (run: AgentRun) => void;
  onExecutionEvent?: (event: StreamExecutionEvent) => void;
  onRuntimeEvent?: (event: AgentEvent) => void;
  intent?: RunIntent;
}

export interface SendDirectMessageResult {
  userMessage: ConversationMessage;
  responseMessage: ConversationMessage;
  execution: AgentExecution;
  waitingQuestion?: string;
}

export interface ResumeDirectMessageInput {
  workspaceId: string;
  workspaceRoot: string;
  conversationId: string;
  runId: string;
  content: string;
  memoryEnabled?: boolean;
  signal?: AbortSignal;
  onRunCreated?: (run: AgentRun) => void;
  onExecutionEvent?: (event: StreamExecutionEvent) => void;
  onRuntimeEvent?: (event: AgentEvent) => void;
}

export interface SendGroupMessageInput {
  workspaceId: string;
  workspaceRoot: string;
  conversationId: string;
  content: string;
  attachments?: ConversationAttachmentInput[];
  signal?: AbortSignal;
  onRunCreated?: (run: AgentRun) => void;
  onExecutionEvent?: (event: StreamExecutionEvent) => void;
  onRuntimeEvent?: (event: AgentEvent) => void;
  onAgentMessage?: (message: ConversationMessage) => void;
  memoryEnabled?: boolean;
  mentionedAgentIds?: string[];
  intent?: RunIntent;
}

export interface SendGroupMessageResult {
  userMessage: ConversationMessage;
  agentMessages: ConversationMessage[];
  executions: AgentExecution[];
}

export interface ResumeGroupMessageInput {
  workspaceId: string;
  workspaceRoot: string;
  conversationId: string;
  runId: string;
  content: string;
  memoryEnabled?: boolean;
  signal?: AbortSignal;
  onRunCreated?: (run: AgentRun) => void;
  onExecutionEvent?: (event: StreamExecutionEvent) => void;
  onRuntimeEvent?: (event: AgentEvent) => void;
  onAgentMessage?: (message: ConversationMessage) => void;
}

export interface PreferenceLearningService {
  resolveForRun(input: { profileId: string; workspaceId: string; objective: string; conversationType?: 'direct' | 'group'; runId: string }): PreferenceContext;
  recordApplications(applications: PreferenceContext['applications']): void;
  recordRunEvidence(input: ObserveRunInput): Promise<unknown>;
}

export class ConversationService {
  private readonly pendingEvents = new Set<Promise<unknown>>();
  private readonly pendingArtifacts = new Set<Promise<void>>();
  private readonly pendingStepMutations = new Set<Promise<unknown>>();
  private stepMutationTail: Promise<void> = Promise.resolve();
  private readonly contextBuilder: RunContextBuilder;
  private readonly preferenceService: PreferenceLearningService;
  private readonly runtimeEventProjector = new RuntimeEventProjector();
  private readonly artifactCollector?: RuntimeArtifactCollector;
  private readonly runStepService: RunStepService;
  private readonly runDecisionService: RunDecisionService;
  private readonly worktreeManager?: WorktreeManager;
  private readonly worktreeArtifactService?: WorktreeArtifactService;
  private readonly runtimeBuffers = new Map<string, RuntimeEventBuffer>();
  private readonly runtimeQuotaNotices = new Set<string>();
  private readonly runtimeFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly store: SqliteStore,
    private readonly eventBus?: EventBus,
    artifactService?: RuntimeArtifactService,
    preferenceService?: PreferenceLearningService,
    worktreeManager?: WorktreeManager,
  ) {
    this.contextBuilder = new RunContextBuilder(new MemoryRetriever(store));
    this.preferenceService = preferenceService ?? new PreferenceService(store);
    this.runStepService = new RunStepService(store, eventBus);
    this.runDecisionService = new RunDecisionService(store);
    this.worktreeManager = worktreeManager;
    this.worktreeArtifactService = artifactService && worktreeManager
      ? new WorktreeArtifactService(artifactService, worktreeManager)
      : undefined;
    this.artifactCollector = artifactService
      ? new RuntimeArtifactCollector(artifactService, artifact => this.publishArtifactCreated(artifact))
      : undefined;
  }

  private artifactContext(execution: AgentExecution, workspaceRoot: string, runId = execution.runId): ArtifactCollectionContext {
    return {
      workspaceId: execution.workspaceId,
      workspaceRoot,
      runId,
      sourceExecutionId: execution.id,
      agentId: execution.agentId,
    };
  }

  private trackArtifact(promise: Promise<void>): void {
    this.pendingArtifacts.add(promise);
    void promise.then(() => this.pendingArtifacts.delete(promise), () => this.pendingArtifacts.delete(promise));
  }

  private async flushArtifacts(): Promise<void> {
    if (this.pendingArtifacts.size === 0) return;
    await Promise.all([...this.pendingArtifacts]);
  }

  async sendDirectMessage(input: SendDirectMessageInput): Promise<SendDirectMessageResult> {
    const content = input.content.trim();
    if (!content && !(input.attachments?.length)) throw new Error('Message content or image attachment is required');

    const conversation = this.store.listConversations(input.workspaceId)
      .find(item => item.id === input.conversationId);
    if (!conversation || conversation.type !== 'direct' || conversation.agentId !== input.agentId) {
      throw new Error('Direct conversation not found for agent');
    }

    const agent = this.store.listAgentProfiles(input.workspaceId)
      .find(item => item.id === input.agentId);
    if (!agent || !agent.enabled) throw new Error('Agent is unavailable');
    assertImageInputSupported(agent, input.attachments);
    const intent = input.intent ?? 'execute';
    const runtimePolicy = resolveRuntimePolicy(intent, agent);
    if (intent !== 'execute') assertRuntimePolicySupported(runtimePolicy, process.env.AGENTOS_FORCE_MOCK === 'true');

    const now = new Date().toISOString();
    const userMessage: ConversationMessage = {
      id: randomUUID(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      senderType: 'user',
      content,
      createdAt: now,
    };
    const storedAttachments = input.attachments?.length
      ? await saveConversationAttachments({
        workspaceRoot: input.workspaceRoot,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        messageId: userMessage.id,
        attachments: input.attachments,
      })
      : [];
    try {
      this.store.createMessage(userMessage, storedAttachments);
    } catch (error) {
      await cleanupConversationAttachments(input.workspaceRoot, storedAttachments);
      throw error;
    }

    const run = this.store.createRun({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sourceMessageId: userMessage.id,
      objective: content || '分析用户附件',
      status: 'queued',
      intent,
      runtimePolicy,
      createdAt: now,
      updatedAt: now,
    });
    userMessage.runId = run.id;
    this.store.updateMessageRunId(input.workspaceId, userMessage.id, run.id);
    await this.runStepService.initializeDirectRun({ workspaceId: input.workspaceId, runId: run.id, agentId: agent.id });
    input.onRunCreated?.(run);
    this.publishEvent(createAgentEvent({
      type: 'run.created', workspaceId: input.workspaceId, conversationId: input.conversationId, runId: run.id,
      payload: { objective: run.objective, status: run.status },
    }));
    this.publishEvent(createAgentEvent({
      type: 'conversation.message.created', workspaceId: input.workspaceId, conversationId: input.conversationId,
      runId: run.id, payload: { senderType: userMessage.senderType },
    }));
    const runContext = await this.contextBuilder.build({
      runId: run.id, workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, query: content,
      limit: MAX_MEMORY_ITEMS, maxCharacters: MAX_MEMORY_CHARACTERS, memoryEnabled: input.memoryEnabled !== false,
    });
    const preferenceContext = this.resolvePreferenceContext({
      runId: run.id, workspaceId: input.workspaceId, objective: run.objective, conversationType: 'direct',
    });
    this.preferenceService.recordApplications(preferenceContext.applications);

    const execution: AgentExecution = {
      id: randomUUID(),
      runId: run.id,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      sourceMessageId: userMessage.id,
      agentId: agent.id,
      status: 'queued',
      mode: process.env.AGENTOS_FORCE_MOCK === 'true' ? 'mock' : 'real',
      createdAt: now,
      updatedAt: now,
    };
    this.store.createExecution(execution);
    this.artifactCollector?.start(this.artifactContext(execution, input.workspaceRoot));
    this.recordExecutionEvent(execution, { status: 'queued', activity: '消息已进入执行队列' }, input.onExecutionEvent, agent, { runId: run.id, finalizeRun: true });

    const history = this.store.listMessages(input.workspaceId, input.conversationId).filter(message => message.id !== userMessage.id);
    const runner = new ConversationAgentRunner({
      agent,
      runtimeOverrides: input.runtimeOverrides,
      runtimePolicy,
      workspaceRoot: input.workspaceRoot,
      executionId: execution.id,
      message: this.combineContexts(runContext.context, preferenceContext.text, content),
      history,
      attachments: storedAttachments.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, absolutePath: getAttachmentAbsolutePath(input.workspaceRoot, attachment.relativePath) })),
      signal: input.signal,
      ...this.createEvidenceCallbacks(run.id, execution, agent, input.workspaceRoot, input.onRuntimeEvent),
      onRuntimeEvent: event => this.recordRuntimeEvent(run.id, execution, agent, event, input.onRuntimeEvent, input.workspaceRoot),
      onEvent: event => this.recordExecutionEvent(execution, event, input.onExecutionEvent, agent, { runId: run.id, finalizeRun: true }),
    });
    const runResult = await runner.run();
    const completedAt = new Date().toISOString();
    let finalStatus = runResult.status;
    let finalFailureReason: string | undefined;
    if (runResult.status === 'completed') {
      try {
        this.persistMemoryUsage(input.workspaceId, input.conversationId, runContext.usages);
        this.store.updateRun(input.workspaceId, run.id, { status: 'completed', resultSummary: runResult.content, completedAt });
      } catch {
        finalStatus = 'failed';
        finalFailureReason = MEMORY_USAGE_PERSISTENCE_FAILURE;
        this.store.updateRun(input.workspaceId, run.id, { status: finalStatus, failureReason: finalFailureReason, completedAt });
        this.publishEvent(createAgentEvent({
          type: 'run.failed', workspaceId: input.workspaceId, conversationId: input.conversationId, runId: run.id,
          executionId: execution.id, agentId: agent.id, payload: { status: finalStatus, reason: finalFailureReason },
        }));
      }
    } else if (runResult.status === 'waiting_user') {
      this.store.updateRun(input.workspaceId, run.id, {
        status: 'waiting_user', waitingQuestion: runResult.waitingQuestion, waitingExecutionId: execution.id,
        waitingAgentId: agent.id, completedAt: undefined,
      });
    } else {
      this.store.updateRun(input.workspaceId, run.id, { status: finalStatus, failureReason: runResult.error ?? '执行未完成', completedAt });
    }
    this.learnFromRun({
      profileId: 'default', workspaceId: input.workspaceId, conversationId: input.conversationId, runId: run.id,
      objective: run.objective, status: finalStatus, resultSummary: runResult.content,
      appliedProjectionIds: preferenceContext.applications.map(application => application.projectionId),
    });
    const responseMessage: ConversationMessage = {
      id: randomUUID(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      runId: run.id,
      senderType: finalStatus === 'completed' ? 'agent' : 'system',
      ...(finalStatus === 'completed' ? { senderAgentId: agent.id } : {}),
      content: finalStatus === 'completed'
        ? runResult.content
        : finalStatus === 'waiting_user'
          ? `等待补充信息：${runResult.waitingQuestion}`
          : `${finalStatus === 'cancelled' ? '执行已取消' : '执行失败'}：${finalFailureReason ?? runResult.error ?? '未知错误'}`,
      createdAt: completedAt,
    };
    this.store.createMessage(responseMessage);
    this.publishEvent(createAgentEvent({
      type: 'conversation.message.created', workspaceId: input.workspaceId, conversationId: input.conversationId,
      runId: run.id, agentId: agent.id, payload: { senderType: responseMessage.senderType },
    }));
    await this.flushArtifacts();
    if (finalStatus !== 'waiting_user') {
      await this.artifactCollector?.finalize(this.artifactContext(execution, input.workspaceRoot));
    }
    await this.flushArtifacts();
    await this.finishDirectRunSteps(input.workspaceId, run.id, finalStatus, finalFailureReason ?? runResult.error);
    await this.flushStepMutations();
    await this.flushEventsForRun(input.workspaceId, run.id);

    const latest = this.store.listExecutions(input.workspaceId, input.conversationId)
      .find(item => item.id === execution.id);
    if (!latest) throw new Error('Execution was not persisted');
    if (finalFailureReason) throw new Error(finalFailureReason);
    return { userMessage, responseMessage, execution: latest, ...(runResult.waitingQuestion ? { waitingQuestion: runResult.waitingQuestion } : {}) };
  }

  async resumeDirectMessage(input: ResumeDirectMessageInput): Promise<SendDirectMessageResult> {
    const content = input.content.trim();
    if (!content) throw new Error('补充信息不能为空');
    const conversation = this.store.listConversations(input.workspaceId).find(item => item.id === input.conversationId);
    if (!conversation || conversation.type !== 'direct') throw new Error('Direct conversation not found');
    const run = this.store.getRun(input.workspaceId, input.runId);
    if (!run || run.conversationId !== conversation.id) throw new Error('Run not found');
    if (run.status !== 'waiting_user') throw new Error('Run is not waiting for user input');
    input.onRunCreated?.(run);
    const agentId = run.waitingAgentId ?? conversation.agentId;
    if (!agentId) throw new Error('Waiting agent is unavailable');
    const agent = this.store.listAgentProfiles(input.workspaceId).find(item => item.id === agentId && item.enabled);
    if (!agent) throw new Error('Agent is unavailable');

    const previousQuestion = run.waitingQuestion ?? '上次执行请求补充信息';
    const now = new Date().toISOString();
    const userMessage: ConversationMessage = {
      id: randomUUID(), conversationId: conversation.id, workspaceId: input.workspaceId,
      senderType: 'user', content, createdAt: now,
    };
    this.store.createMessage(userMessage);
    this.store.updateRun(input.workspaceId, run.id, {
      status: 'running', waitingQuestion: undefined, waitingExecutionId: undefined, waitingAgentId: undefined, completedAt: undefined,
    });
    this.publishEvent(createAgentEvent({
      type: 'conversation.message.created', workspaceId: input.workspaceId, conversationId: conversation.id,
      runId: run.id, payload: { senderType: userMessage.senderType },
    }));

    const runContext = await this.contextBuilder.build({
      runId: run.id, workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, query: content,
      limit: MAX_MEMORY_ITEMS, maxCharacters: MAX_MEMORY_CHARACTERS, memoryEnabled: input.memoryEnabled !== false,
    });
    const preferenceContext = this.resolvePreferenceContext({
      runId: run.id, workspaceId: input.workspaceId, objective: run.objective, conversationType: 'direct',
    });
    this.preferenceService.recordApplications(preferenceContext.applications);
    const execution: AgentExecution = {
      id: randomUUID(), runId: run.id, conversationId: conversation.id, workspaceId: input.workspaceId,
      sourceMessageId: userMessage.id, agentId: agent.id, status: 'queued',
      mode: process.env.AGENTOS_FORCE_MOCK === 'true' ? 'mock' : 'real', createdAt: now, updatedAt: now,
    };
    this.store.createExecution(execution);
    this.artifactCollector?.start(this.artifactContext(execution, input.workspaceRoot));
    this.recordExecutionEvent(execution, { status: 'queued', activity: '补充信息已进入执行队列' }, input.onExecutionEvent, agent, { runId: run.id, finalizeRun: true });
    const history = this.store.listMessages(input.workspaceId, conversation.id).filter(message => message.id !== userMessage.id);
    const prompt = `原始任务：${run.objective}\n上次等待问题：${previousQuestion}\n用户补充信息：${content}`;
    const runner = new ConversationAgentRunner({
      agent, workspaceRoot: input.workspaceRoot, executionId: execution.id,
      message: this.combineContexts(runContext.context, preferenceContext.text, prompt), history,
      signal: input.signal,
      ...this.createEvidenceCallbacks(run.id, execution, agent, input.workspaceRoot, input.onRuntimeEvent),
      onRuntimeEvent: event => this.recordRuntimeEvent(run.id, execution, agent, event, input.onRuntimeEvent, input.workspaceRoot),
      onEvent: event => this.recordExecutionEvent(execution, event, input.onExecutionEvent, agent, { runId: run.id, finalizeRun: true }),
    });
    const runResult = await runner.run();
    const completedAt = new Date().toISOString();
    let finalStatus = runResult.status;
    let finalFailureReason: string | undefined;
    if (runResult.status === 'completed') {
      try {
        this.persistMemoryUsage(input.workspaceId, conversation.id, runContext.usages);
        this.store.updateRun(input.workspaceId, run.id, { status: 'completed', resultSummary: runResult.content, completedAt });
      } catch {
        finalStatus = 'failed';
        finalFailureReason = MEMORY_USAGE_PERSISTENCE_FAILURE;
        this.store.updateRun(input.workspaceId, run.id, { status: finalStatus, failureReason: finalFailureReason, completedAt });
        this.publishEvent(createAgentEvent({
          type: 'run.failed', workspaceId: input.workspaceId, conversationId: conversation.id, runId: run.id,
          executionId: execution.id, agentId: agent.id, payload: { status: finalStatus, reason: finalFailureReason },
        }));
      }
    } else if (runResult.status === 'waiting_user') {
      this.store.updateRun(input.workspaceId, run.id, {
        status: 'waiting_user', waitingQuestion: runResult.waitingQuestion, waitingExecutionId: execution.id,
        waitingAgentId: agent.id, completedAt: undefined,
      });
    } else {
      this.store.updateRun(input.workspaceId, run.id, { status: finalStatus, failureReason: runResult.error ?? '执行未完成', completedAt });
    }
    this.learnFromRun({
      profileId: 'default', workspaceId: input.workspaceId, conversationId: conversation.id, runId: run.id,
      objective: run.objective, status: finalStatus, resultSummary: runResult.content,
      appliedProjectionIds: preferenceContext.applications.map(application => application.projectionId),
    });
    const responseMessage: ConversationMessage = {
      id: randomUUID(), conversationId: conversation.id, workspaceId: input.workspaceId, runId: run.id,
      senderType: finalStatus === 'completed' ? 'agent' : 'system',
      ...(finalStatus === 'completed' ? { senderAgentId: agent.id } : {}),
      content: finalStatus === 'completed'
        ? runResult.content
        : finalStatus === 'waiting_user'
          ? `等待补充信息：${runResult.waitingQuestion}`
          : `${finalStatus === 'cancelled' ? '执行已取消' : '执行失败'}：${finalFailureReason ?? runResult.error ?? '未知错误'}`,
      createdAt: completedAt,
    };
    this.store.createMessage(responseMessage);
    this.publishEvent(createAgentEvent({
      type: 'conversation.message.created', workspaceId: input.workspaceId, conversationId: conversation.id,
      runId: run.id, agentId: agent.id, payload: { senderType: responseMessage.senderType },
    }));
    await this.flushArtifacts();
    if (finalStatus !== 'waiting_user') {
      await this.artifactCollector?.finalize(this.artifactContext(execution, input.workspaceRoot));
    }
    await this.flushArtifacts();
    await this.finishDirectRunSteps(input.workspaceId, run.id, finalStatus, finalFailureReason ?? runResult.error);
    await this.flushStepMutations();
    await this.flushEventsForRun(input.workspaceId, run.id);
    const latest = this.store.listExecutions(input.workspaceId, conversation.id).find(item => item.id === execution.id);
    if (!latest) throw new Error('Execution was not persisted');
    if (finalFailureReason) throw new Error(finalFailureReason);
    return { userMessage, responseMessage, execution: latest, ...(runResult.waitingQuestion ? { waitingQuestion: runResult.waitingQuestion } : {}) };
  }

  async sendGroupMessage(input: SendGroupMessageInput): Promise<SendGroupMessageResult> {
    const content = input.content.trim();
    if (!content && !(input.attachments?.length)) throw new Error('Message content or image attachment is required');
    const conversation = this.store.listConversations(input.workspaceId).find(item => item.id === input.conversationId);
    if (!conversation || conversation.type !== 'group') throw new Error('Group conversation not found');
    const members = this.store.listConversationMembers(input.workspaceId, input.conversationId);
    const leaderMember = members.find(member => member.isLeader);
    if (!leaderMember) throw new Error('Group leader not found');
    const profiles = new Map(this.store.listAgentProfiles(input.workspaceId).filter(profile => profile.enabled).map(profile => [profile.id, profile]));
    const leader = profiles.get(leaderMember.agentId);
    if (!leader) throw new Error('Group leader is unavailable');
    const intent = input.intent ?? 'execute';
    const runtimePolicy = resolveRuntimePolicy(intent, leader);
    if (intent !== 'execute') assertRuntimePolicySupported(runtimePolicy, process.env.AGENTOS_FORCE_MOCK === 'true');
    const isolatedMode = process.env.AGENTOS_WORKTREE_MODE === 'isolated';
    if (isolatedMode) {
      if (!this.worktreeManager || !this.worktreeArtifactService) throw new Error('parallel_isolated requires worktree and artifact services');
      await this.worktreeManager.preflight(input.workspaceRoot);
      assertRuntimePolicySupported(resolveRuntimePolicy('review', leader), process.env.AGENTOS_FORCE_MOCK === 'true');
    }
    const dispatchDecision = resolveDispatchDecision(conversation, members, input.mentionedAgentIds ?? []);
    if (dispatchDecision.action === 'need_user') throw new Error(dispatchDecision.question);
    const selectedMemberIds = new Set(dispatchDecision.action === 'members'
      ? dispatchDecision.agentIds
      : dispatchDecision.action === 'full_pipeline'
        ? members.filter(member => !member.isLeader).map(member => member.agentId)
        : []);
    for (const member of members) {
      const agent = profiles.get(member.agentId);
      if (agent) assertImageInputSupported(agent, input.attachments);
    }

    const now = new Date().toISOString();
    const userMessage: ConversationMessage = {
      id: randomUUID(), conversationId: input.conversationId, workspaceId: input.workspaceId,
      senderType: 'user', content, createdAt: now,
    };
    const storedAttachments = input.attachments?.length
      ? await saveConversationAttachments({
        workspaceRoot: input.workspaceRoot,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        messageId: userMessage.id,
        attachments: input.attachments,
      })
      : [];
    try {
      this.store.createMessage(userMessage, storedAttachments);
    } catch (error) {
      await cleanupConversationAttachments(input.workspaceRoot, storedAttachments);
      throw error;
    }

    const run = this.store.createRun({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      sourceMessageId: userMessage.id,
      objective: content || '分析用户附件',
      status: 'queued',
      intent,
      runtimePolicy,
      createdAt: now,
      updatedAt: now,
    });
    userMessage.runId = run.id;
    this.store.updateMessageRunId(input.workspaceId, userMessage.id, run.id);
    input.onRunCreated?.(run);
    this.publishEvent(createAgentEvent({
      type: 'run.created', workspaceId: input.workspaceId, conversationId: input.conversationId, runId: run.id,
      payload: { objective: run.objective, status: run.status },
    }));
    this.publishEvent(createAgentEvent({
      type: 'conversation.message.created', workspaceId: input.workspaceId, conversationId: input.conversationId,
      runId: run.id, payload: { senderType: userMessage.senderType },
    }));
    const runContext = await this.contextBuilder.build({
      runId: run.id, workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, query: content,
      limit: MAX_MEMORY_ITEMS, maxCharacters: MAX_MEMORY_CHARACTERS, memoryEnabled: input.memoryEnabled !== false,
    });
    const preferenceContext = this.resolvePreferenceContext({
      runId: run.id, workspaceId: input.workspaceId, objective: run.objective, conversationType: 'group',
    });
    this.preferenceService.recordApplications(preferenceContext.applications);
    await this.runStepService.initializeGroupRun({ workspaceId: input.workspaceId, runId: run.id, members });
    const leaderPolicy = isolatedMode ? resolveRuntimePolicy('review', leader) : runtimePolicy;
    const planned = await this.runAgentTurn({
      workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, conversationId: input.conversationId, runId: run.id,
      sourceMessage: userMessage, agent: leader, runtimePolicy: leaderPolicy,
      memoryContext: this.combineContexts(runContext.context, preferenceContext.text),
      attachments: storedAttachments,
      prompt: `你是本群群主。用户任务：${content}\n请先公开拆分计划，并按成员职责给出后续委派。`,
      signal: input.signal, onExecutionEvent: input.onExecutionEvent, onRuntimeEvent: input.onRuntimeEvent,
      onAgentMessage: input.onAgentMessage,
      finalizeRun: conversation.dispatchMode !== undefined,
    });
    if (planned.status === 'waiting_user') {
      if (conversation.dispatchMode === undefined) await this.failGroupWaitingRun(input.workspaceId, input.conversationId, run.id, planned.execution, leader);
      await this.flushStepMutations();
      await this.flushEventsForRun(input.workspaceId, run.id);
      return { userMessage, agentMessages: [planned.responseMessage], executions: [planned.execution] };
    }
    const turns = [planned];
    const selectedMembers = members.filter(member => !member.isLeader && selectedMemberIds.has(member.agentId)).sort((left, right) => left.sequence - right.sequence);
    const runMember = async (member: typeof selectedMembers[number]) => {
        const agent = profiles.get(member.agentId);
        if (!agent) return null;
        let executionWorkspaceRoot = input.workspaceRoot;
        let worktreeLeaseId: string | undefined;
        const executionId = randomUUID();
        if (isolatedMode && agent.permissions.includes('write')) {
          const lease = await this.worktreeManager!.createLease({
            workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, runId: run.id,
            executionId, agentId: agent.id,
          });
          worktreeLeaseId = lease.id;
          executionWorkspaceRoot = this.worktreeManager!.getRecord(lease.id)!.absolutePath;
        }
        return this.runAgentTurn({
          workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, conversationId: input.conversationId, runId: run.id,
          sourceMessage: userMessage, agent, executionId, runtimePolicy: resolveRuntimePolicy(intent, agent),
          executionWorkspaceRoot, worktreeLeaseId,
          memoryContext: this.combineContexts(runContext.context, preferenceContext.text),
          attachments: storedAttachments,
          prompt: `群主计划：${planned.responseMessage.content}\n你在本群的职责是：${member.roleTitle}\n请执行被委派的部分并公开报告结果。`,
          signal: input.signal, onExecutionEvent: input.onExecutionEvent, onRuntimeEvent: input.onRuntimeEvent,
          onAgentMessage: input.onAgentMessage,
          finalizeRun: false,
        });
    };
    const memberTurns = conversation.dispatchMode === undefined
      ? await Promise.allSettled(selectedMembers.map(runMember))
      : await (async () => {
        const results: Array<PromiseSettledResult<Awaited<ReturnType<typeof runMember>>>> = [];
        for (const member of selectedMembers) {
          results.push(await Promise.resolve().then(() => runMember(member), reason => { throw reason; }).then(value => ({ status: 'fulfilled', value } as const), reason => ({ status: 'rejected', reason } as const)));
        }
        return results;
      })();
    if (isolatedMode) {
      const rejected = memberTurns.find(result => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    }
    for (const result of memberTurns) {
      if (result.status === 'fulfilled' && result.value) turns.push(result.value);
    }
    const waitingTurn = turns.find(turn => turn.status === 'waiting_user');
    if (waitingTurn) {
      await this.failGroupWaitingRun(input.workspaceId, input.conversationId, run.id, waitingTurn.execution, profiles.get(waitingTurn.execution.agentId) ?? leader);
    }
    const workerSummary = turns.slice(1)
      .map(turn => `${turn.responseMessage.senderAgentId ?? turn.execution.agentId}: ${turn.responseMessage.content}`)
      .join('\n\n');
    const summary = await this.runAgentTurn({
      workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, conversationId: input.conversationId, runId: run.id,
      sourceMessage: userMessage, agent: leader, runtimePolicy: leaderPolicy,
      memoryContext: this.combineContexts(runContext.context, preferenceContext.text),
      attachments: storedAttachments,
      prompt: `请作为群主总结本次任务。原始任务：${content}\n成员报告：\n${workerSummary || '无可用成员报告'}\n给出最终结论、阻塞项和下一步。`,
      signal: input.signal, onExecutionEvent: input.onExecutionEvent, onRuntimeEvent: input.onRuntimeEvent,
      onAgentMessage: input.onAgentMessage,
      finalizeRun: true,
    });
    turns.push(summary);

    await this.finishGroupRunSteps(input.workspaceId, run.id, summary.status, summary.responseMessage.content);

    if (summary.status === 'completed') {
      try {
        this.persistMemoryUsage(input.workspaceId, input.conversationId, runContext.usages);
      } catch {
        const failureReason = MEMORY_USAGE_PERSISTENCE_FAILURE;
        this.store.updateRun(input.workspaceId, run.id, { status: 'failed', failureReason, completedAt: new Date().toISOString() });
        this.publishEvent(createAgentEvent({
          type: 'run.failed', workspaceId: input.workspaceId, conversationId: input.conversationId, runId: run.id,
          executionId: summary.execution.id, agentId: leader.id, payload: { status: 'failed', reason: failureReason },
        }));
        throw new Error(failureReason);
      }
    }

    await this.flushArtifacts();
    await this.artifactCollector?.finalize(this.artifactContext(summary.execution, input.workspaceRoot));
    await this.flushArtifacts();
    await this.flushEventsForRun(input.workspaceId, run.id);
    this.learnFromRun({
      profileId: 'default', workspaceId: input.workspaceId, conversationId: input.conversationId, runId: run.id,
      objective: run.objective, status: this.store.getRun(input.workspaceId, run.id)?.status ?? 'failed',
      resultSummary: summary.responseMessage.content,
      appliedProjectionIds: preferenceContext.applications.map(application => application.projectionId),
    });
    return { userMessage, agentMessages: turns.map(turn => turn.responseMessage), executions: turns.map(turn => turn.execution) };
  }

  async resumeGroupMessage(input: ResumeGroupMessageInput): Promise<SendGroupMessageResult> {
    const content = input.content.trim();
    if (!content) throw new Error('补充信息不能为空');
    const conversation = this.store.listConversations(input.workspaceId).find(item => item.id === input.conversationId);
    if (!conversation || conversation.type !== 'group') throw new Error('Group conversation not found');
    const run = this.store.getRun(input.workspaceId, input.runId);
    if (!run || run.conversationId !== conversation.id) throw new Error('Run not found');
    if (run.status !== 'waiting_user') throw new Error('Run is not waiting for user input');
    const members = this.store.listConversationMembers(input.workspaceId, conversation.id);
    const agentId = run.waitingAgentId ?? members.find(member => member.roleKind === 'leader')?.agentId;
    const agent = this.store.listAgentProfiles(input.workspaceId).find(item => item.id === agentId && item.enabled);
    if (!agent) throw new Error('Waiting agent is unavailable');
    const now = new Date().toISOString();
    const userMessage: ConversationMessage = { id: randomUUID(), conversationId: conversation.id, workspaceId: input.workspaceId, senderType: 'user', content, runId: run.id, createdAt: now };
    this.store.createMessage(userMessage);
    this.store.updateRun(input.workspaceId, run.id, { status: 'running', waitingQuestion: undefined, waitingExecutionId: undefined, waitingAgentId: undefined, completedAt: undefined });
    input.onRunCreated?.(run);
    this.publishEvent(createAgentEvent({ type: 'conversation.message.created', workspaceId: input.workspaceId, conversationId: conversation.id, runId: run.id, payload: { senderType: 'user' } }));
    const runContext = await this.contextBuilder.build({ runId: run.id, workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, query: content, limit: MAX_MEMORY_ITEMS, maxCharacters: MAX_MEMORY_CHARACTERS, memoryEnabled: input.memoryEnabled !== false });
    const preferenceContext = this.resolvePreferenceContext({ runId: run.id, workspaceId: input.workspaceId, objective: run.objective, conversationType: 'group' });
    this.preferenceService.recordApplications(preferenceContext.applications);
    const planned = await this.runAgentTurn({ workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, conversationId: conversation.id, runId: run.id, sourceMessage: userMessage, agent, runtimePolicy: run.runtimePolicy ?? resolveRuntimePolicy('execute', agent), memoryContext: this.combineContexts(runContext.context, preferenceContext.text), prompt: `原始任务：${run.objective}\n用户补充信息：${content}`, signal: input.signal, onExecutionEvent: input.onExecutionEvent, onRuntimeEvent: input.onRuntimeEvent, onAgentMessage: input.onAgentMessage, finalizeRun: true });
    await this.finishGroupRunSteps(input.workspaceId, run.id, planned.status, planned.responseMessage.content);
    await this.flushStepMutations();
    await this.flushEventsForRun(input.workspaceId, run.id);
    return { userMessage, agentMessages: [planned.responseMessage], executions: [planned.execution] };
  }

  private async runAgentTurn(input: {
    workspaceId: string;
    workspaceRoot: string;
    conversationId: string;
    runId: string;
    sourceMessage: ConversationMessage;
    agent: AgentProfile;
    executionId?: string;
    executionWorkspaceRoot?: string;
    worktreeLeaseId?: string;
    runtimePolicy?: RuntimePolicy;
    prompt: string;
    memoryContext?: string;
    attachments?: StoredConversationAttachment[];
    signal?: AbortSignal;
    onExecutionEvent?: (event: StreamExecutionEvent) => void;
    onRuntimeEvent?: (event: AgentEvent) => void;
    onAgentMessage?: (message: ConversationMessage) => void;
    finalizeRun: boolean;
  }): Promise<{ responseMessage: ConversationMessage; execution: AgentExecution; status: 'waiting_user' | 'completed' | 'failed' | 'cancelled'; waitingQuestion?: string }> {
    const executionWorkspaceRoot = input.executionWorkspaceRoot ?? input.workspaceRoot;
    const now = new Date().toISOString();
    const execution: AgentExecution = {
      id: input.executionId ?? randomUUID(), runId: input.runId, conversationId: input.conversationId, workspaceId: input.workspaceId,
      sourceMessageId: input.sourceMessage.id, agentId: input.agent.id, status: 'queued',
      mode: process.env.AGENTOS_FORCE_MOCK === 'true' ? 'mock' : 'real', createdAt: now, updatedAt: now,
    };
    this.store.createExecution(execution);
    this.artifactCollector?.start(this.artifactContext(execution, executionWorkspaceRoot));
    this.recordExecutionEvent(execution, { status: 'queued', activity: `${input.agent.name} 已进入执行队列` }, input.onExecutionEvent, input.agent, { runId: input.runId, finalizeRun: input.finalizeRun });
    const history = this.store.listMessages(input.workspaceId, input.conversationId).filter(message => message.id !== input.sourceMessage.id);
    const runResult = await new ConversationAgentRunner({
      agent: input.agent, workspaceRoot: executionWorkspaceRoot, executionId: execution.id,
      runtimePolicy: input.runtimePolicy,
      message: input.memoryContext ? `${input.memoryContext}\n\n${input.prompt}` : input.prompt, history,
      attachments: input.attachments?.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, absolutePath: getAttachmentAbsolutePath(input.workspaceRoot, attachment.relativePath) })),
      signal: input.signal,
      ...this.createEvidenceCallbacks(input.runId, execution, input.agent, executionWorkspaceRoot, input.onRuntimeEvent),
      onRuntimeEvent: event => this.recordRuntimeEvent(input.runId, execution, input.agent, event, input.onRuntimeEvent, executionWorkspaceRoot),
      onEvent: event => this.recordExecutionEvent(execution, event, input.onExecutionEvent, input.agent, { runId: input.runId, finalizeRun: input.finalizeRun }),
    }).run();
    if (input.worktreeLeaseId && this.worktreeArtifactService) {
      try {
        await this.worktreeArtifactService.createBundle(input.worktreeLeaseId, {
          workspaceId: input.workspaceId, runId: input.runId, executionId: execution.id, agentId: input.agent.id,
        });
      } catch (error) {
        this.worktreeManager?.markCleanupPending(input.worktreeLeaseId);
        this.publishEvent(createAgentEvent({
          type: 'execution.diagnostic', workspaceId: input.workspaceId, conversationId: input.conversationId,
          runId: input.runId, executionId: execution.id, agentId: input.agent.id,
          payload: { level: 'error', code: 'worktree.recovery_bundle_failed', message: error instanceof Error ? error.message : String(error) },
        }));
      }
    }
    const responseMessage: ConversationMessage = {
      id: randomUUID(), conversationId: input.conversationId, workspaceId: input.workspaceId, runId: input.runId,
      senderType: runResult.status === 'completed' ? 'agent' : 'system',
      ...(runResult.status === 'completed' ? { senderAgentId: input.agent.id } : {}),
      content: runResult.status === 'completed'
        ? runResult.content
        : `${runResult.status === 'cancelled' ? '执行已取消' : '执行失败'}：${runResult.error ?? '未知错误'}`,
      createdAt: new Date().toISOString(),
    };
    this.store.createMessage(responseMessage);
    input.onAgentMessage?.(responseMessage);
    this.publishEvent(createAgentEvent({
      type: 'conversation.message.created', workspaceId: input.workspaceId, conversationId: input.conversationId,
      runId: input.runId, agentId: input.agent.id, payload: { senderType: responseMessage.senderType },
    }));
    if (input.finalizeRun) {
      const completedAt = new Date().toISOString();
      this.store.updateRun(input.workspaceId, input.runId, runResult.status === 'completed'
        ? { status: 'completed', resultSummary: runResult.content, completedAt }
        : { status: runResult.status, failureReason: runResult.error ?? '执行未完成', completedAt });
    }
    const pendingDecision = runResult.status === 'failed'
      ? this.runDecisionService.recordPartialWriteFailure({
        workspaceId: input.workspaceId,
        run: this.store.getRun(input.workspaceId, input.runId) ?? ({ id: input.runId } as AgentRun),
        execution,
        fileChanges: this.store.listRunFileChanges(input.workspaceId, input.runId),
        writeCapable: input.agent.permissions.includes('write'),
      })
      : undefined;
    const latest = this.store.listExecutions(input.workspaceId, input.conversationId).find(item => item.id === execution.id);
    if (!latest) throw new Error('Execution was not persisted');
    return { responseMessage, execution: latest, status: pendingDecision ? 'waiting_user' : runResult.status, ...(pendingDecision ? { waitingQuestion: this.store.getRun(input.workspaceId, input.runId)?.waitingQuestion } : runResult.waitingQuestion ? { waitingQuestion: runResult.waitingQuestion } : {}) };
  }

  private async failGroupWaitingRun(workspaceId: string, conversationId: string, runId: string, execution: AgentExecution, agent: AgentProfile): Promise<never> {
    const failureReason = GROUP_WAITING_USER_FAILURE;
    const currentRun = this.store.getRun(workspaceId, runId);
    if (currentRun?.status !== 'failed' || currentRun.failureReason !== failureReason) {
      this.store.updateRun(workspaceId, runId, { status: 'failed', failureReason, completedAt: new Date().toISOString() });
      this.publishEvent(createAgentEvent({
        type: 'run.failed', workspaceId, conversationId, runId, executionId: execution.id, agentId: agent.id,
        payload: { status: 'failed', reason: failureReason },
      }));
    }
    await this.flushEventsForRun(workspaceId, runId);
    throw new Error(failureReason);
  }

  private recordExecutionEvent(
    execution: AgentExecution,
    event: RunnerExecutionEvent,
    onExecutionEvent?: (event: StreamExecutionEvent) => void,
    agent?: Pick<AgentProfile, 'id' | 'name'>,
    options?: { runId: string; finalizeRun: boolean },
  ): void {
    const runId = options?.runId ?? execution.runId;
    const finalizeRun = options?.finalizeRun ?? false;
    this.trackStepMutation(() => this.syncRunStepForExecution(execution.workspaceId, runId, execution.id, event.status, event.content));
    const now = new Date().toISOString();
    this.store.appendExecutionEvent({
      id: randomUUID(),
      executionId: execution.id,
      status: event.status,
      activity: event.activity,
      ...(event.content ? { content: event.content } : {}),
      createdAt: now,
    });
    this.publishEvent(createAgentEvent({
      type: 'execution.status.changed', workspaceId: execution.workspaceId, conversationId: execution.conversationId,
      runId, executionId: execution.id, agentId: execution.agentId,
      payload: { status: event.status, activity: event.activity },
    }));
    if (event.status !== 'queued') {
      this.store.updateExecution(execution.workspaceId, execution.id, {
        status: event.status,
        ...(event.status === 'preparing_context' || event.status === 'running_cli' || event.status === 'streaming_response'
          ? { startedAt: now }
          : {}),
        ...(event.status === 'waiting_user' || event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled'
          ? { completedAt: now }
          : {}),
        ...(event.status === 'failed' ? { error: event.content ?? event.activity } : {}),
        updatedAt: now,
      });
    }
    if (event.status === 'preparing_context' || event.status === 'running_cli' || event.status === 'streaming_response') {
      this.store.updateRun(execution.workspaceId, runId, { status: 'running', startedAt: now });
      if (event.status === 'preparing_context') {
        this.publishEvent(createAgentEvent({
          type: 'run.started', workspaceId: execution.workspaceId, conversationId: execution.conversationId,
          runId, executionId: execution.id, agentId: execution.agentId, payload: { status: 'running' },
        }));
      }
    } else if (event.status === 'waiting_user') {
      if (finalizeRun) {
        this.store.updateRun(execution.workspaceId, runId, {
          status: 'waiting_user', waitingQuestion: event.content, waitingExecutionId: execution.id,
          waitingAgentId: execution.agentId, completedAt: undefined,
        });
        this.publishEvent(createAgentEvent({
          type: 'run.waiting_user', workspaceId: execution.workspaceId, conversationId: execution.conversationId, runId,
          executionId: execution.id, agentId: execution.agentId,
          payload: { question: event.content ?? '' },
        }));
      } else {
        this.store.updateRun(execution.workspaceId, runId, {
          status: 'failed', failureReason: GROUP_WAITING_USER_FAILURE, completedAt: now,
        });
        this.publishEvent(createAgentEvent({
          type: 'run.failed', workspaceId: execution.workspaceId, conversationId: execution.conversationId, runId,
          executionId: execution.id, agentId: execution.agentId,
          payload: { status: 'failed', reason: GROUP_WAITING_USER_FAILURE },
        }));
      }
    } else if (finalizeRun && (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled')) {
      this.store.updateRun(execution.workspaceId, runId, {
        status: event.status,
        ...(event.status === 'failed' || event.status === 'cancelled' ? { failureReason: event.content ?? event.activity } : {}),
        completedAt: now,
      });
      this.publishEvent(createAgentEvent({
        type: event.status === 'completed' ? 'run.completed' : event.status === 'failed' ? 'run.failed' : 'run.cancelled',
        workspaceId: execution.workspaceId, conversationId: execution.conversationId, runId,
        executionId: execution.id, agentId: execution.agentId, payload: { status: event.status },
      }));
    }
    onExecutionEvent?.(agent ? { ...event, agentId: agent.id, agentName: agent.name } : { ...event, agentId: execution.agentId, agentName: execution.agentId });
  }

  private recordRuntimeEvent(
    runId: string,
    execution: AgentExecution,
    agent: Pick<AgentProfile, 'id'>,
    event: NormalizedCliEvent,
    onRuntimeEvent?: (event: AgentEvent) => void,
    workspaceRoot?: string,
  ): void {
    const projected = this.runtimeEventProjector.project({
      workspaceId: execution.workspaceId,
      conversationId: execution.conversationId,
      runId,
      executionId: execution.id,
      agentId: agent.id,
    }, event);
    const liveEvent = { ...projected, sequence: 0 } as AgentEvent;
    onRuntimeEvent?.(liveEvent);
    const buffer = this.runtimeBuffers.get(runId) ?? new RuntimeEventBuffer();
    this.runtimeBuffers.set(runId, buffer);
    const accepted = buffer.push(liveEvent);
    if (!accepted && event.type !== 'diagnostic') {
      const noticeKey = `${runId}:${event.type}`;
      if (!this.runtimeQuotaNotices.has(noticeKey)) {
        this.runtimeQuotaNotices.add(noticeKey);
        this.publishEvent(createAgentEvent({
          type: 'execution.diagnostic', workspaceId: execution.workspaceId, conversationId: execution.conversationId,
          runId, executionId: execution.id, agentId: execution.agentId,
          payload: { level: 'warning', code: 'runtime.quota_exceeded', message: `已达到 ${event.type} 持久化明细上限，后续明细已汇总。` },
        }));
      }
    }
    if (event.type === 'assistant.message') this.scheduleRuntimeFlush(runId);
    else this.trackCriticalEventWork(this.flushRuntimeBuffer(runId));
    if (this.artifactCollector && workspaceRoot) {
      this.trackArtifact(this.artifactCollector.recordRuntimeEvent(this.artifactContext(execution, workspaceRoot, runId), event));
    }
  }

  private scheduleRuntimeFlush(runId: string): void {
    if (this.runtimeFlushTimers.has(runId)) return;
    const timer = setTimeout(() => {
      this.runtimeFlushTimers.delete(runId);
      this.trackCriticalEventWork(this.flushRuntimeBuffer(runId));
    }, 260);
    timer.unref?.();
    this.runtimeFlushTimers.set(runId, timer);
  }

  private async flushRuntimeBuffer(runId: string): Promise<void> {
    const timer = this.runtimeFlushTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.runtimeFlushTimers.delete(runId);
    }
    const buffer = this.runtimeBuffers.get(runId);
    if (!buffer) return;
    const events = buffer.drain();
    if (events.length === 0) return;
    await Promise.all(events.map(event => this.publishEvent(event)));
  }

  private publishEvent(event: AgentEventDraft): Promise<AgentEvent | undefined> {
    let pending: Promise<AgentEvent | undefined>;
    if (!this.eventBus) {
      pending = Promise.resolve({ ...event, sequence: 0 });
    } else {
      try {
        pending = Promise.resolve(this.eventBus.publish(event));
      } catch (error) {
        pending = Promise.reject(error);
      }
    }
    return this.trackCriticalEventWork(pending);
  }

  private trackCriticalEventWork<T>(pending: Promise<T>): Promise<T> {
    this.pendingEvents.add(pending);
    void pending.catch(() => undefined);
    return pending;
  }

  private publishArtifactCreated(artifact: RuntimeArtifact): void {
    const run = this.store.getRun(artifact.workspaceId, artifact.runId);
    if (!run) return;
    this.publishEvent(createAgentEvent({
      type: 'execution.artifact.created',
      workspaceId: artifact.workspaceId,
      conversationId: run.conversationId,
      runId: artifact.runId,
      executionId: artifact.sourceExecutionId,
      agentId: artifact.agentId,
      payload: {
        artifactId: artifact.id,
        artifactType: artifact.type,
        title: artifact.title,
        contentAvailable: artifact.contentAvailable,
        sizeBytes: artifact.sizeBytes,
      },
    }));
  }

  private async flushEvents(): Promise<void> {
    let rejected = false;
    while (this.pendingEvents.size > 0) {
      const pendingEvents = [...this.pendingEvents];
      const results = await Promise.allSettled(pendingEvents);
      for (const pending of pendingEvents) this.pendingEvents.delete(pending);
      if (results.some(result => result.status === 'rejected')) rejected = true;
    }
    if (rejected) throw new Error(CRITICAL_EVENT_PERSISTENCE_FAILURE);
  }

  private trackStepMutation(operation: () => Promise<unknown>): void {
    const promise = this.stepMutationTail.then(operation);
    this.stepMutationTail = promise.then(() => undefined, () => undefined);
    this.pendingStepMutations.add(promise);
    void promise.catch(() => undefined);
  }

  private async flushStepMutations(): Promise<void> {
    if (this.pendingStepMutations.size === 0) return;
    const pending = [...this.pendingStepMutations];
    const results = await Promise.allSettled(pending);
    for (const item of pending) this.pendingStepMutations.delete(item);
    if (results.some(result => result.status === 'rejected')) throw new Error('RunStep persistence failed');
  }

  private async syncRunStepForExecution(workspaceId: string, runId: string, executionId: string, status: ExecutionStatus, content?: string): Promise<void> {
    const steps = this.store.listRunSteps(workspaceId, runId);
    if (steps.length === 0) return;
    const execution = this.store.listExecutions(workspaceId, this.store.getRun(workspaceId, runId)?.conversationId ?? '').find(item => item.id === executionId);
    const groupAgentStep = execution ? this.store.getRunStep(workspaceId, runId, `group.agent.${execution.agentId}`) : undefined;
    if (groupAgentStep) {
      const nextStatus = status === 'waiting_user'
        ? 'waiting'
        : status === 'completed'
          ? 'completed'
          : status === 'failed'
            ? 'failed'
            : status === 'cancelled'
              ? 'cancelled'
              : 'running';
      if (groupAgentStep.status !== nextStatus && canTransitionRunStep(groupAgentStep.status, nextStatus)) {
        await this.runStepService.update({ workspaceId, runId, stableStepKey: groupAgentStep.stableStepKey, status: nextStatus, executionId, ...(content ? { summary: content } : {}) });
      }
      return;
    }
    if (status === 'preparing_context') {
      const contextStep = this.store.getRunStep(workspaceId, runId, 'direct.context');
      if (contextStep?.status === 'pending') await this.runStepService.update({ workspaceId, runId, stableStepKey: 'direct.context', status: 'running', executionId });
    } else if (status === 'running_cli') {
      const contextStep = this.store.getRunStep(workspaceId, runId, 'direct.context');
      if (contextStep?.status === 'running') await this.runStepService.update({ workspaceId, runId, stableStepKey: 'direct.context', status: 'completed', executionId });
      const agentStep = this.store.getRunStep(workspaceId, runId, 'direct.agent');
      if (agentStep?.status === 'pending' || agentStep?.status === 'waiting') await this.runStepService.update({ workspaceId, runId, stableStepKey: 'direct.agent', status: 'running', executionId });
    } else if (status === 'streaming_response') {
      const agentStep = this.store.getRunStep(workspaceId, runId, 'direct.agent');
      if (agentStep?.status === 'pending') await this.runStepService.update({ workspaceId, runId, stableStepKey: 'direct.agent', status: 'running', executionId });
    } else if (status === 'waiting_user') {
      await this.runStepService.update({ workspaceId, runId, stableStepKey: 'direct.agent', status: 'waiting', executionId, summary: content });
    } else if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      const agentStep = this.store.getRunStep(workspaceId, runId, 'direct.agent');
      if (agentStep && agentStep.status !== statusToRunStep(status)) {
        await this.runStepService.update({ workspaceId, runId, stableStepKey: 'direct.agent', status: statusToRunStep(status), executionId, summary: content });
      }
    }
  }

  private async finishDirectRunSteps(workspaceId: string, runId: string, status: AgentRun['status'], summary?: string): Promise<void> {
    const artifactStep = this.store.getRunStep(workspaceId, runId, 'direct.artifacts');
    const summaryStep = this.store.getRunStep(workspaceId, runId, 'direct.summary');
    if (status === 'waiting_user') return;
    if (artifactStep?.status === 'pending') await this.runStepService.update({ workspaceId, runId, stableStepKey: 'direct.artifacts', status: 'running' });
    const artifactTerminal = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    const refreshedArtifact = this.store.getRunStep(workspaceId, runId, 'direct.artifacts');
    if (refreshedArtifact && refreshedArtifact.status === 'running') await this.runStepService.update({ workspaceId, runId, stableStepKey: 'direct.artifacts', status: artifactTerminal, summary });
    if (summaryStep?.status === 'pending') await this.runStepService.update({ workspaceId, runId, stableStepKey: 'direct.summary', status: 'running' });
    const refreshedSummary = this.store.getRunStep(workspaceId, runId, 'direct.summary');
    if (refreshedSummary && refreshedSummary.status === 'running') await this.runStepService.update({ workspaceId, runId, stableStepKey: 'direct.summary', status: artifactTerminal, summary });
  }

  private async finishGroupRunSteps(workspaceId: string, runId: string, status: 'completed' | 'failed' | 'cancelled' | 'waiting_user', summary?: string): Promise<void> {
    if (status === 'waiting_user') return;
    const summaryStep = this.store.getRunStep(workspaceId, runId, 'group.summary');
    if (!summaryStep) return;
    if (summaryStep.status === 'pending') await this.runStepService.update({ workspaceId, runId, stableStepKey: summaryStep.stableStepKey, status: 'running' });
    const terminal = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    const current = this.store.getRunStep(workspaceId, runId, summaryStep.stableStepKey);
    if (current?.status === 'running') await this.runStepService.update({ workspaceId, runId, stableStepKey: current.stableStepKey, status: terminal, summary });
  }

  private async flushEventsForRun(workspaceId: string, runId: string): Promise<void> {
    let persistenceFailed = false;
    try {
      await this.trackCriticalEventWork(this.flushRuntimeBuffer(runId));
    } catch {
      persistenceFailed = true;
    }
    try {
      await this.flushEvents();
    } catch {
      persistenceFailed = true;
    }
    this.runtimeBuffers.delete(runId);
    this.runtimeQuotaNotices.forEach(key => {
      if (key.startsWith(`${runId}:`)) this.runtimeQuotaNotices.delete(key);
    });
    if (!persistenceFailed) return;
    this.store.updateRun(workspaceId, runId, {
      status: 'failed',
      failureReason: CRITICAL_EVENT_PERSISTENCE_FAILURE,
      completedAt: new Date().toISOString(),
    });
    throw new Error(CRITICAL_EVENT_PERSISTENCE_FAILURE);
  }

  private persistMemoryUsage(workspaceId: string, conversationId: string, usages: MemoryUsage[]): void {
    for (const usage of usages) {
      this.store.createMemoryUsage(usage);
      this.publishEvent(createAgentEvent({
        type: 'memory.used', workspaceId, conversationId, runId: usage.runId,
        payload: {
          memoryId: usage.memoryId,
          rank: usage.rank,
          injectedCharacters: usage.injectedCharacters,
        },
      }));
    }
  }

  private resolvePreferenceContext(input: { runId: string; workspaceId: string; objective: string; conversationType: 'direct' | 'group' }): PreferenceContext {
    try {
      return this.preferenceService.resolveForRun({ profileId: 'default', ...input });
    } catch {
      return { contextKind: 'general', text: '', applications: [] };
    }
  }

  private combineContexts(...contexts: Array<string | undefined>): string {
    return contexts.filter((context): context is string => Boolean(context?.trim())).join('\n\n');
  }

  private learnFromRun(input: ObserveRunInput): void {
    void this.preferenceService.recordRunEvidence(input).catch(() => undefined);
  }

  private createEvidenceCallbacks(runId: string, execution: AgentExecution, agent: AgentProfile, workspaceRoot: string, onRuntimeEvent?: (event: AgentEvent) => void): {
    onInvocationStarted: (observation: CliInvocationObservation) => void;
    onInvocationCompleted: (observation: CompletedCliInvocationObservation) => void;
    onFileChanges: (changes: Array<Omit<RunFileChange, 'runId'>>) => void;
  } {
    const emitEvidence = (event: AgentEventDraft): void => {
      void this.publishEvent(event).then(persisted => {
        if (persisted) onRuntimeEvent?.(persisted);
      }, () => undefined);
    };

    return {
      onInvocationStarted: observation => {
        emitEvidence(createAgentEvent({
          type: 'execution.cli.started', workspaceId: execution.workspaceId, conversationId: execution.conversationId,
          runId, executionId: execution.id, agentId: agent.id,
          payload: {
            cliKind: observation.cliKind, commandLabel: observation.commandLabel,
            ...(observation.configuredProvider ? { configuredProvider: observation.configuredProvider } : {}),
            ...(observation.detectedProvider ? { detectedProvider: observation.detectedProvider } : {}),
            ...(observation.providerMismatch ? { providerMismatch: true } : {}),
            ...(observation.model ? { model: observation.model } : {}),
            ...(observation.thinkingEffort ? { thinkingEffort: observation.thinkingEffort } : {}),
            startedAt: observation.startedAt,
          },
        }));
      },
      onInvocationCompleted: observation => {
        const invocation: RunCliInvocation = {
          id: observation.invocationId, runId, executionId: execution.id, agentId: agent.id,
          cliKind: observation.cliKind, commandLabel: observation.commandLabel,
          ...(observation.configuredProvider ? { configuredProvider: observation.configuredProvider } : {}),
          ...(observation.detectedProvider ? { detectedProvider: observation.detectedProvider } : {}),
          ...(observation.providerMismatch ? { providerMismatch: true } : {}),
          ...(observation.model ? { model: observation.model } : {}),
          ...(observation.thinkingEffort ? { thinkingEffort: observation.thinkingEffort } : {}),
          exitCode: observation.exitCode, durationMs: observation.durationMs,
          startedAt: observation.startedAt, completedAt: observation.completedAt,
        };
        this.store.saveRunCliInvocation(invocation);
        emitEvidence(createAgentEvent({
          type: 'execution.cli.completed', workspaceId: execution.workspaceId, conversationId: execution.conversationId,
          runId, executionId: execution.id, agentId: agent.id,
          payload: {
            cliKind: invocation.cliKind, commandLabel: invocation.commandLabel, exitCode: invocation.exitCode,
            durationMs: invocation.durationMs, startedAt: invocation.startedAt, completedAt: invocation.completedAt,
            ...(invocation.configuredProvider ? { configuredProvider: invocation.configuredProvider } : {}),
            ...(invocation.detectedProvider ? { detectedProvider: invocation.detectedProvider } : {}),
            ...(invocation.providerMismatch ? { providerMismatch: true } : {}),
            ...(invocation.model ? { model: invocation.model } : {}),
            ...(invocation.thinkingEffort ? { thinkingEffort: invocation.thinkingEffort } : {}),
          },
        }));
      },
      onFileChanges: changes => {
        if (this.artifactCollector) {
          this.trackArtifact(this.artifactCollector.collectFileChanges(
            this.artifactContext(execution, workspaceRoot, runId),
            changes,
          ));
        }
        const persistedChanges = changes.map(change => ({ runId, path: change.path, changeType: change.changeType }));
        for (const change of persistedChanges) this.store.createRunFileChange(change);
        if (persistedChanges.length > 0) {
          emitEvidence(createAgentEvent({
            type: 'execution.files.changed', workspaceId: execution.workspaceId, conversationId: execution.conversationId,
            runId, executionId: execution.id, agentId: agent.id,
            payload: { changes: persistedChanges.map(change => ({ path: change.path, changeType: change.changeType })) },
          }));
        }
      },
    };
  }
}

type CompletedCliInvocationObservation = Required<Pick<CliInvocationObservation, 'invocationId' | 'cliKind' | 'commandLabel' | 'startedAt' | 'completedAt' | 'exitCode' | 'durationMs'>> & Pick<CliInvocationObservation, 'configuredProvider' | 'detectedProvider' | 'providerMismatch' | 'model' | 'thinkingEffort'>;

function statusToRunStep(status: Extract<ExecutionStatus, 'completed' | 'failed' | 'cancelled'>): 'completed' | 'failed' | 'cancelled' {
  return status;
}

function assertImageInputSupported(agent: AgentProfile, attachments: ConversationAttachmentInput[] | undefined): void {
  if (!attachments?.length) return;
  const plan = resolveImageInput({ role: agent.role, cliCommand: agent.cliCommand }, attachments.map(attachment => ({
    name: attachment.name,
    mimeType: attachment.mimeType,
    absolutePath: 'attachment-placeholder',
  })));
  if (plan.transport === 'unsupported') throw new Error(plan.error ?? `${agent.name} 当前 CLI 不支持图片输入`);
}
