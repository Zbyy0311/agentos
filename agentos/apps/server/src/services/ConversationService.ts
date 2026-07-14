import { randomUUID } from 'node:crypto';
import { ConversationAgentRunner, resolveImageInput, type ConversationExecutionEvent as RunnerExecutionEvent } from '@agentos/agent-core';
import type { AgentEvent, AgentExecution, AgentProfile, CliInvocationObservation, ConversationMessage, MemoryUsage, RunCliInvocation, RunFileChange } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { EventBus } from '../events/EventBus.js';
import { createAgentEvent } from '../events/createAgentEvent.js';
import { cleanupConversationAttachments, getAttachmentAbsolutePath, saveConversationAttachments, type ConversationAttachmentInput, type StoredConversationAttachment } from './ConversationAttachmentService.js';
import { MemoryRetriever } from './MemoryRetriever.js';
import { MAX_MEMORY_CHARACTERS, MAX_MEMORY_ITEMS, RunContextBuilder } from './RunContextBuilder.js';

type StreamExecutionEvent = RunnerExecutionEvent & { agentId: string; agentName: string };
const CRITICAL_EVENT_PERSISTENCE_FAILURE = '关键事件持久化失败';

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
  onExecutionEvent?: (event: StreamExecutionEvent) => void;
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
  onExecutionEvent?: (event: StreamExecutionEvent) => void;
}

export interface SendGroupMessageInput {
  workspaceId: string;
  workspaceRoot: string;
  conversationId: string;
  content: string;
  attachments?: ConversationAttachmentInput[];
  signal?: AbortSignal;
  onExecutionEvent?: (event: StreamExecutionEvent) => void;
  onAgentMessage?: (message: ConversationMessage) => void;
  memoryEnabled?: boolean;
}

export interface SendGroupMessageResult {
  userMessage: ConversationMessage;
  agentMessages: ConversationMessage[];
  executions: AgentExecution[];
}

export class ConversationService {
  private readonly pendingEvents = new Set<Promise<void>>();
  private readonly contextBuilder: RunContextBuilder;

  constructor(private readonly store: SqliteStore, private readonly eventBus?: EventBus) {
    this.contextBuilder = new RunContextBuilder(new MemoryRetriever(store));
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
      createdAt: now,
      updatedAt: now,
    });
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
    this.recordExecutionEvent(execution, { status: 'queued', activity: '消息已进入执行队列' }, input.onExecutionEvent, agent, { runId: run.id, finalizeRun: true });

    const history = this.store.listMessages(input.workspaceId, input.conversationId).filter(message => message.id !== userMessage.id);
    const runner = new ConversationAgentRunner({
      agent,
      runtimeOverrides: input.runtimeOverrides,
      workspaceRoot: input.workspaceRoot,
      executionId: execution.id,
      message: runContext.context ? `${runContext.context}\n\n${content}` : content,
      history,
      attachments: storedAttachments.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, absolutePath: getAttachmentAbsolutePath(input.workspaceRoot, attachment.relativePath) })),
      signal: input.signal,
      ...this.createEvidenceCallbacks(run.id, execution, agent),
      onEvent: event => this.recordExecutionEvent(execution, event, input.onExecutionEvent, agent, { runId: run.id, finalizeRun: true }),
    });
    const runResult = await runner.run();
    const completedAt = new Date().toISOString();
    if (runResult.status === 'completed') {
      this.persistMemoryUsage(input.workspaceId, input.conversationId, runContext.usages);
      this.store.updateRun(input.workspaceId, run.id, { status: 'completed', resultSummary: runResult.content, completedAt });
    } else if (runResult.status === 'waiting_user') {
      this.store.updateRun(input.workspaceId, run.id, {
        status: 'waiting_user', waitingQuestion: runResult.waitingQuestion, waitingExecutionId: execution.id,
        waitingAgentId: agent.id, completedAt: undefined,
      });
    } else {
      this.store.updateRun(input.workspaceId, run.id, { status: runResult.status, failureReason: runResult.error ?? '执行未完成', completedAt });
    }
    const responseMessage: ConversationMessage = {
      id: randomUUID(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      senderType: runResult.status === 'completed' ? 'agent' : 'system',
      ...(runResult.status === 'completed' ? { senderAgentId: agent.id } : {}),
      content: runResult.status === 'completed'
        ? runResult.content
        : runResult.status === 'waiting_user'
          ? `等待补充信息：${runResult.waitingQuestion}`
          : `执行失败：${runResult.error ?? '未知错误'}`,
      createdAt: completedAt,
    };
    this.store.createMessage(responseMessage);
    this.publishEvent(createAgentEvent({
      type: 'conversation.message.created', workspaceId: input.workspaceId, conversationId: input.conversationId,
      runId: run.id, agentId: agent.id, payload: { senderType: responseMessage.senderType },
    }));
    await this.flushEventsForRun(input.workspaceId, run.id);

    const latest = this.store.listExecutions(input.workspaceId, input.conversationId)
      .find(item => item.id === execution.id);
    if (!latest) throw new Error('Execution was not persisted');
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
    const execution: AgentExecution = {
      id: randomUUID(), runId: run.id, conversationId: conversation.id, workspaceId: input.workspaceId,
      sourceMessageId: userMessage.id, agentId: agent.id, status: 'queued',
      mode: process.env.AGENTOS_FORCE_MOCK === 'true' ? 'mock' : 'real', createdAt: now, updatedAt: now,
    };
    this.store.createExecution(execution);
    this.recordExecutionEvent(execution, { status: 'queued', activity: '补充信息已进入执行队列' }, input.onExecutionEvent, agent, { runId: run.id, finalizeRun: true });
    const history = this.store.listMessages(input.workspaceId, conversation.id).filter(message => message.id !== userMessage.id);
    const prompt = `原始任务：${run.objective}\n上次等待问题：${previousQuestion}\n用户补充信息：${content}`;
    const runner = new ConversationAgentRunner({
      agent, workspaceRoot: input.workspaceRoot, executionId: execution.id,
      message: runContext.context ? `${runContext.context}\n\n${prompt}` : prompt, history,
      signal: input.signal,
      ...this.createEvidenceCallbacks(run.id, execution, agent),
      onEvent: event => this.recordExecutionEvent(execution, event, input.onExecutionEvent, agent, { runId: run.id, finalizeRun: true }),
    });
    const runResult = await runner.run();
    const completedAt = new Date().toISOString();
    if (runResult.status === 'completed') {
      this.persistMemoryUsage(input.workspaceId, conversation.id, runContext.usages);
      this.store.updateRun(input.workspaceId, run.id, { status: 'completed', resultSummary: runResult.content, completedAt });
    } else if (runResult.status === 'waiting_user') {
      this.store.updateRun(input.workspaceId, run.id, {
        status: 'waiting_user', waitingQuestion: runResult.waitingQuestion, waitingExecutionId: execution.id,
        waitingAgentId: agent.id, completedAt: undefined,
      });
    } else {
      this.store.updateRun(input.workspaceId, run.id, { status: runResult.status, failureReason: runResult.error ?? '执行未完成', completedAt });
    }
    const responseMessage: ConversationMessage = {
      id: randomUUID(), conversationId: conversation.id, workspaceId: input.workspaceId,
      senderType: runResult.status === 'completed' ? 'agent' : 'system',
      ...(runResult.status === 'completed' ? { senderAgentId: agent.id } : {}),
      content: runResult.status === 'completed'
        ? runResult.content
        : runResult.status === 'waiting_user'
          ? `等待补充信息：${runResult.waitingQuestion}`
          : `执行失败：${runResult.error ?? '未知错误'}`,
      createdAt: completedAt,
    };
    this.store.createMessage(responseMessage);
    this.publishEvent(createAgentEvent({
      type: 'conversation.message.created', workspaceId: input.workspaceId, conversationId: conversation.id,
      runId: run.id, agentId: agent.id, payload: { senderType: responseMessage.senderType },
    }));
    await this.flushEventsForRun(input.workspaceId, run.id);
    const latest = this.store.listExecutions(input.workspaceId, conversation.id).find(item => item.id === execution.id);
    if (!latest) throw new Error('Execution was not persisted');
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
      createdAt: now,
      updatedAt: now,
    });
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
    this.persistMemoryUsage(input.workspaceId, input.conversationId, runContext.usages);

    const planned = await this.runAgentTurn({
      workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, conversationId: input.conversationId, runId: run.id,
      sourceMessage: userMessage, agent: leader,
      memoryContext: runContext.context,
      attachments: storedAttachments,
      prompt: `你是本群群主。用户任务：${content}\n请先公开拆分计划，并按成员职责给出后续委派。`,
      signal: input.signal, onExecutionEvent: input.onExecutionEvent,
      onAgentMessage: input.onAgentMessage,
      finalizeRun: false,
    });
    if (planned.status === 'waiting_user') {
      await this.failGroupWaitingRun(input.workspaceId, input.conversationId, run.id, planned.execution, leader);
    }
    const turns = [planned];
    const memberTurns = await Promise.allSettled(
      members.filter(member => !member.isLeader).map(async member => {
        const agent = profiles.get(member.agentId);
        if (!agent) return null;
        return this.runAgentTurn({
          workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, conversationId: input.conversationId, runId: run.id,
          sourceMessage: userMessage, agent,
          memoryContext: runContext.context,
          attachments: storedAttachments,
          prompt: `群主计划：${planned.responseMessage.content}\n你在本群的职责是：${member.roleTitle}\n请执行被委派的部分并公开报告结果。`,
          signal: input.signal, onExecutionEvent: input.onExecutionEvent,
          onAgentMessage: input.onAgentMessage,
          finalizeRun: false,
        });
      }),
    );
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
    turns.push(await this.runAgentTurn({
      workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, conversationId: input.conversationId, runId: run.id,
      sourceMessage: userMessage, agent: leader,
      memoryContext: runContext.context,
      attachments: storedAttachments,
      prompt: `请作为群主总结本次任务。原始任务：${content}\n成员报告：\n${workerSummary || '无可用成员报告'}\n给出最终结论、阻塞项和下一步。`,
      signal: input.signal, onExecutionEvent: input.onExecutionEvent,
      onAgentMessage: input.onAgentMessage,
      finalizeRun: true,
    }));

    await this.flushEventsForRun(input.workspaceId, run.id);
    return { userMessage, agentMessages: turns.map(turn => turn.responseMessage), executions: turns.map(turn => turn.execution) };
  }

  private async runAgentTurn(input: {
    workspaceId: string;
    workspaceRoot: string;
    conversationId: string;
    runId: string;
    sourceMessage: ConversationMessage;
    agent: AgentProfile;
    prompt: string;
    memoryContext?: string;
    attachments?: StoredConversationAttachment[];
    signal?: AbortSignal;
    onExecutionEvent?: (event: StreamExecutionEvent) => void;
    onAgentMessage?: (message: ConversationMessage) => void;
    finalizeRun: boolean;
  }): Promise<{ responseMessage: ConversationMessage; execution: AgentExecution; status: 'waiting_user' | 'completed' | 'failed' | 'cancelled'; waitingQuestion?: string }> {
    const now = new Date().toISOString();
    const execution: AgentExecution = {
      id: randomUUID(), runId: input.runId, conversationId: input.conversationId, workspaceId: input.workspaceId,
      sourceMessageId: input.sourceMessage.id, agentId: input.agent.id, status: 'queued',
      mode: process.env.AGENTOS_FORCE_MOCK === 'true' ? 'mock' : 'real', createdAt: now, updatedAt: now,
    };
    this.store.createExecution(execution);
    this.recordExecutionEvent(execution, { status: 'queued', activity: `${input.agent.name} 已进入执行队列` }, input.onExecutionEvent, input.agent, { runId: input.runId, finalizeRun: input.finalizeRun });
    const history = this.store.listMessages(input.workspaceId, input.conversationId).filter(message => message.id !== input.sourceMessage.id);
    const runResult = await new ConversationAgentRunner({
      agent: input.agent, workspaceRoot: input.workspaceRoot, executionId: execution.id,
      message: input.memoryContext ? `${input.memoryContext}\n\n${input.prompt}` : input.prompt, history,
      attachments: input.attachments?.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, absolutePath: getAttachmentAbsolutePath(input.workspaceRoot, attachment.relativePath) })),
      signal: input.signal,
      ...this.createEvidenceCallbacks(input.runId, execution, input.agent),
      onEvent: event => this.recordExecutionEvent(execution, event, input.onExecutionEvent, input.agent, { runId: input.runId, finalizeRun: input.finalizeRun }),
    }).run();
    const responseMessage: ConversationMessage = {
      id: randomUUID(), conversationId: input.conversationId, workspaceId: input.workspaceId,
      senderType: runResult.status === 'completed' ? 'agent' : 'system',
      ...(runResult.status === 'completed' ? { senderAgentId: input.agent.id } : {}),
      content: runResult.status === 'completed' ? runResult.content : `执行失败：${runResult.error ?? '未知错误'}`,
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
    const latest = this.store.listExecutions(input.workspaceId, input.conversationId).find(item => item.id === execution.id);
    if (!latest) throw new Error('Execution was not persisted');
    return { responseMessage, execution: latest, status: runResult.status, ...(runResult.waitingQuestion ? { waitingQuestion: runResult.waitingQuestion } : {}) };
  }

  private async failGroupWaitingRun(workspaceId: string, conversationId: string, runId: string, execution: AgentExecution, agent: AgentProfile): Promise<never> {
    const failureReason = '群聊暂不支持等待用户恢复';
    this.store.updateRun(workspaceId, runId, { status: 'failed', failureReason, completedAt: new Date().toISOString() });
    this.publishEvent(createAgentEvent({
      type: 'run.failed', workspaceId, conversationId, runId, executionId: execution.id, agentId: agent.id,
      payload: { status: 'failed', reason: failureReason },
    }));
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
      this.store.updateRun(execution.workspaceId, runId, {
        status: 'waiting_user', waitingQuestion: event.content, waitingExecutionId: execution.id,
        waitingAgentId: execution.agentId, completedAt: undefined,
      });
      this.publishEvent(createAgentEvent({
        type: 'run.waiting_user', workspaceId: execution.workspaceId, conversationId: execution.conversationId, runId,
        executionId: execution.id, agentId: execution.agentId,
        payload: { question: event.content ?? '' },
      }));
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

  private publishEvent(event: AgentEvent): void {
    if (!this.eventBus) return;
    const pending = this.eventBus.publish(event);
    this.pendingEvents.add(pending);
    void pending.then(undefined, () => undefined);
  }

  private async flushEvents(): Promise<void> {
    if (this.pendingEvents.size === 0) return;
    const pendingEvents = [...this.pendingEvents];
    const results = await Promise.allSettled(pendingEvents);
    for (const pending of pendingEvents) this.pendingEvents.delete(pending);
    if (results.some(result => result.status === 'rejected')) {
      throw new Error(CRITICAL_EVENT_PERSISTENCE_FAILURE);
    }
  }

  private async flushEventsForRun(workspaceId: string, runId: string): Promise<void> {
    try {
      await this.flushEvents();
    } catch (error) {
      this.store.updateRun(workspaceId, runId, {
        status: 'failed',
        failureReason: CRITICAL_EVENT_PERSISTENCE_FAILURE,
        completedAt: new Date().toISOString(),
      });
      throw error;
    }
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

  private createEvidenceCallbacks(runId: string, execution: AgentExecution, agent: AgentProfile): {
    onInvocationStarted: (observation: CliInvocationObservation) => void;
    onInvocationCompleted: (observation: CompletedCliInvocationObservation) => void;
    onFileChanges: (changes: Array<Omit<RunFileChange, 'runId'>>) => void;
  } {
    return {
      onInvocationStarted: observation => {
        this.publishEvent(createAgentEvent({
          type: 'execution.cli.started', workspaceId: execution.workspaceId, conversationId: execution.conversationId,
          runId, executionId: execution.id, agentId: agent.id,
          payload: {
            cliKind: observation.cliKind, commandLabel: observation.commandLabel,
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
          ...(observation.model ? { model: observation.model } : {}),
          ...(observation.thinkingEffort ? { thinkingEffort: observation.thinkingEffort } : {}),
          exitCode: observation.exitCode, durationMs: observation.durationMs,
          startedAt: observation.startedAt, completedAt: observation.completedAt,
        };
        this.store.saveRunCliInvocation(invocation);
        this.publishEvent(createAgentEvent({
          type: 'execution.cli.completed', workspaceId: execution.workspaceId, conversationId: execution.conversationId,
          runId, executionId: execution.id, agentId: agent.id,
          payload: {
            cliKind: invocation.cliKind, commandLabel: invocation.commandLabel, exitCode: invocation.exitCode,
            durationMs: invocation.durationMs, startedAt: invocation.startedAt, completedAt: invocation.completedAt,
            ...(invocation.model ? { model: invocation.model } : {}),
            ...(invocation.thinkingEffort ? { thinkingEffort: invocation.thinkingEffort } : {}),
          },
        }));
      },
      onFileChanges: changes => {
        const persistedChanges = changes.map(change => ({ runId, path: change.path, changeType: change.changeType }));
        for (const change of persistedChanges) this.store.createRunFileChange(change);
        if (persistedChanges.length > 0) {
          this.publishEvent(createAgentEvent({
            type: 'execution.files.changed', workspaceId: execution.workspaceId, conversationId: execution.conversationId,
            runId, executionId: execution.id, agentId: agent.id,
            payload: { changes: persistedChanges.map(change => ({ path: change.path, changeType: change.changeType })) },
          }));
        }
      },
    };
  }
}

type CompletedCliInvocationObservation = Required<Pick<CliInvocationObservation, 'invocationId' | 'cliKind' | 'commandLabel' | 'startedAt' | 'completedAt' | 'exitCode' | 'durationMs'>> & Pick<CliInvocationObservation, 'model' | 'thinkingEffort'>;

function assertImageInputSupported(agent: AgentProfile, attachments: ConversationAttachmentInput[] | undefined): void {
  if (!attachments?.length) return;
  const plan = resolveImageInput({ role: agent.role, cliCommand: agent.cliCommand }, attachments.map(attachment => ({
    name: attachment.name,
    mimeType: attachment.mimeType,
    absolutePath: 'attachment-placeholder',
  })));
  if (plan.transport === 'unsupported') throw new Error(plan.error ?? `${agent.name} 当前 CLI 不支持图片输入`);
}
