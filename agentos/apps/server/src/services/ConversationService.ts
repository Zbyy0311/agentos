import { randomUUID } from 'node:crypto';
import { ConversationAgentRunner, resolveImageInput, type ConversationExecutionEvent } from '@agentos/agent-core';
import type { AgentExecution, AgentProfile, ConversationMessage } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { cleanupConversationAttachments, getAttachmentAbsolutePath, saveConversationAttachments, type ConversationAttachmentInput, type StoredConversationAttachment } from './ConversationAttachmentService.js';

export interface SendDirectMessageInput {
  workspaceId: string;
  workspaceRoot: string;
  conversationId: string;
  agentId: string;
  content: string;
  attachments?: ConversationAttachmentInput[];
  runtimeOverrides?: Pick<AgentProfile, 'model' | 'thinkingEffort'>;
  signal?: AbortSignal;
  onExecutionEvent?: (event: ConversationExecutionEvent) => void;
}

export interface SendDirectMessageResult {
  userMessage: ConversationMessage;
  responseMessage: ConversationMessage;
  execution: AgentExecution;
}

export interface SendGroupMessageInput {
  workspaceId: string;
  workspaceRoot: string;
  conversationId: string;
  content: string;
  attachments?: ConversationAttachmentInput[];
  signal?: AbortSignal;
  onExecutionEvent?: (event: ConversationExecutionEvent) => void;
  onAgentMessage?: (message: ConversationMessage) => void;
}

export interface SendGroupMessageResult {
  userMessage: ConversationMessage;
  agentMessages: ConversationMessage[];
  executions: AgentExecution[];
}

export class ConversationService {
  constructor(private readonly store: SqliteStore) {}

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

    const execution: AgentExecution = {
      id: randomUUID(),
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
    this.recordExecutionEvent(execution, { status: 'queued', activity: '消息已进入执行队列' }, input.onExecutionEvent);

    const history = this.store.listMessages(input.workspaceId, input.conversationId).filter(message => message.id !== userMessage.id);
    const runner = new ConversationAgentRunner({
      agent,
      runtimeOverrides: input.runtimeOverrides,
      workspaceRoot: input.workspaceRoot,
      executionId: execution.id,
      message: content,
      history,
      attachments: storedAttachments.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, absolutePath: getAttachmentAbsolutePath(input.workspaceRoot, attachment.relativePath) })),
      signal: input.signal,
      onEvent: event => this.recordExecutionEvent(execution, event, input.onExecutionEvent),
    });
    const runResult = await runner.run();
    const completedAt = new Date().toISOString();
    const responseMessage: ConversationMessage = {
      id: randomUUID(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      senderType: runResult.status === 'completed' ? 'agent' : 'system',
      ...(runResult.status === 'completed' ? { senderAgentId: agent.id } : {}),
      content: runResult.status === 'completed' ? runResult.content : `执行失败：${runResult.error ?? '未知错误'}`,
      createdAt: completedAt,
    };
    this.store.createMessage(responseMessage);

    const latest = this.store.listExecutions(input.workspaceId, input.conversationId)
      .find(item => item.id === execution.id);
    if (!latest) throw new Error('Execution was not persisted');
    return { userMessage, responseMessage, execution: latest };
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

    const planned = await this.runAgentTurn({
      workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, conversationId: input.conversationId,
      sourceMessage: userMessage, agent: leader,
      attachments: storedAttachments,
      prompt: `你是本群群主。用户任务：${content}\n请先公开拆分计划，并按成员职责给出后续委派。`,
      signal: input.signal, onExecutionEvent: input.onExecutionEvent,
      onAgentMessage: input.onAgentMessage,
    });
    const turns = [planned];
    const memberTurns = await Promise.allSettled(
      members.filter(member => !member.isLeader).map(async member => {
        const agent = profiles.get(member.agentId);
        if (!agent) return null;
        return this.runAgentTurn({
          workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, conversationId: input.conversationId,
          sourceMessage: userMessage, agent,
          attachments: storedAttachments,
          prompt: `群主计划：${planned.responseMessage.content}\n你在本群的职责是：${member.roleTitle}\n请执行被委派的部分并公开报告结果。`,
          signal: input.signal, onExecutionEvent: input.onExecutionEvent,
          onAgentMessage: input.onAgentMessage,
        });
      }),
    );
    for (const result of memberTurns) {
      if (result.status === 'fulfilled' && result.value) turns.push(result.value);
    }
    const workerSummary = turns.slice(1)
      .map(turn => `${turn.responseMessage.senderAgentId ?? turn.execution.agentId}: ${turn.responseMessage.content}`)
      .join('\n\n');
    turns.push(await this.runAgentTurn({
      workspaceId: input.workspaceId, workspaceRoot: input.workspaceRoot, conversationId: input.conversationId,
      sourceMessage: userMessage, agent: leader,
      attachments: storedAttachments,
      prompt: `请作为群主总结本次任务。原始任务：${content}\n成员报告：\n${workerSummary || '无可用成员报告'}\n给出最终结论、阻塞项和下一步。`,
      signal: input.signal, onExecutionEvent: input.onExecutionEvent,
      onAgentMessage: input.onAgentMessage,
    }));

    return { userMessage, agentMessages: turns.map(turn => turn.responseMessage), executions: turns.map(turn => turn.execution) };
  }

  private async runAgentTurn(input: {
    workspaceId: string;
    workspaceRoot: string;
    conversationId: string;
    sourceMessage: ConversationMessage;
    agent: AgentProfile;
    prompt: string;
    attachments?: StoredConversationAttachment[];
    signal?: AbortSignal;
    onExecutionEvent?: (event: ConversationExecutionEvent) => void;
    onAgentMessage?: (message: ConversationMessage) => void;
  }): Promise<{ responseMessage: ConversationMessage; execution: AgentExecution }> {
    const now = new Date().toISOString();
    const execution: AgentExecution = {
      id: randomUUID(), conversationId: input.conversationId, workspaceId: input.workspaceId,
      sourceMessageId: input.sourceMessage.id, agentId: input.agent.id, status: 'queued',
      mode: process.env.AGENTOS_FORCE_MOCK === 'true' ? 'mock' : 'real', createdAt: now, updatedAt: now,
    };
    this.store.createExecution(execution);
    this.recordExecutionEvent(execution, { status: 'queued', activity: `${input.agent.name} 已进入执行队列` }, input.onExecutionEvent);
    const history = this.store.listMessages(input.workspaceId, input.conversationId).filter(message => message.id !== input.sourceMessage.id);
    const runResult = await new ConversationAgentRunner({
      agent: input.agent, workspaceRoot: input.workspaceRoot, executionId: execution.id,
      message: input.prompt, history,
      attachments: input.attachments?.map(attachment => ({ name: attachment.name, mimeType: attachment.mimeType, absolutePath: getAttachmentAbsolutePath(input.workspaceRoot, attachment.relativePath) })),
      signal: input.signal,
      onEvent: event => this.recordExecutionEvent(execution, event, input.onExecutionEvent),
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
    const latest = this.store.listExecutions(input.workspaceId, input.conversationId).find(item => item.id === execution.id);
    if (!latest) throw new Error('Execution was not persisted');
    return { responseMessage, execution: latest };
  }

  private recordExecutionEvent(
    execution: AgentExecution,
    event: ConversationExecutionEvent,
    onExecutionEvent?: (event: ConversationExecutionEvent) => void,
  ): void {
    const now = new Date().toISOString();
    this.store.appendExecutionEvent({
      id: randomUUID(),
      executionId: execution.id,
      status: event.status,
      activity: event.activity,
      ...(event.content ? { content: event.content } : {}),
      createdAt: now,
    });
    if (event.status !== 'queued') {
      this.store.updateExecution(execution.workspaceId, execution.id, {
        status: event.status,
        ...(event.status === 'preparing_context' || event.status === 'running_cli' || event.status === 'streaming_response'
          ? { startedAt: now }
          : {}),
        ...(event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled'
          ? { completedAt: now }
          : {}),
        ...(event.status === 'failed' ? { error: event.content ?? event.activity } : {}),
        updatedAt: now,
      });
    }
    onExecutionEvent?.(event);
  }
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
