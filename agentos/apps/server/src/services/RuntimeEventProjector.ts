import type { AgentEvent, AgentEventDraft, ExecutionStatus } from '@agentos/shared';
import type { NormalizedCliEvent } from '@agentos/agent-core';
import { createAgentEvent } from '../events/createAgentEvent.js';
import { redactRuntimeText } from '@agentos/agent-core';

export interface RuntimeEventContext {
  workspaceId: string;
  conversationId: string;
  runId: string;
  executionId: string;
  agentId: string;
}

export class RuntimeEventProjector {
  project(context: RuntimeEventContext, event: NormalizedCliEvent): AgentEventDraft {
    switch (event.type) {
      case 'status':
        return this.create(context, 'execution.status.changed', {
          status: statusForPhase(event.phase),
          activity: publicStatusLabel(event.phase),
        });
      case 'assistant.message':
        return this.create(context, 'execution.output.appended', {
          text: redactRuntimeText(event.text),
          ...(event.messageId ? { messageId: event.messageId } : {}),
        });
      case 'tool.started':
        return this.create(context, 'execution.tool.started', {
          callId: event.callId,
          toolName: redactRuntimeText(event.toolName, 128),
          summary: redactRuntimeText(event.summary),
          ...(event.inputPreview ? { inputPreview: redactRuntimeText(event.inputPreview) } : {}),
        });
      case 'tool.completed':
        return this.create(context, 'execution.tool.completed', {
          callId: event.callId,
          toolName: redactRuntimeText(event.toolName, 128),
          success: event.success,
          summary: redactRuntimeText(event.summary),
          ...(event.outputPreview ? { outputPreview: redactRuntimeText(event.outputPreview) } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        });
      case 'usage':
        return this.create(context, 'execution.usage.recorded', {
          ...(event.source ? { source: event.source } : {}),
          ...(event.provider ? { provider: event.provider } : {}),
          ...(event.model ? { model: event.model } : {}),
          ...(event.estimated !== undefined ? { estimated: event.estimated } : {}),
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
        });
      case 'diagnostic':
        return this.create(context, 'execution.diagnostic', {
          level: event.level,
          code: event.code,
          message: redactRuntimeText(event.message),
        });
      case 'approval.requested':
        return this.create(context, 'execution.approval.requested', {
          requestId: event.requestId,
          toolName: redactRuntimeText(event.toolName, 128),
          riskLevel: event.riskLevel,
          summary: redactRuntimeText(event.summary),
          ...(event.affectedPaths ? { affectedPaths: event.affectedPaths.slice(0, 32) } : {}),
        });
      case 'approval.resolved':
        return this.create(context, 'execution.approval.resolved', { requestId: event.requestId, decision: event.decision });
    }
  }

  private create<TPayload extends Record<string, unknown>>(
    context: RuntimeEventContext,
    type: AgentEvent['type'],
    payload: TPayload,
  ): AgentEventDraft<TPayload> {
    return createAgentEvent({ ...context, type, payload });
  }
}

function statusForPhase(phase: Extract<NormalizedCliEvent, { type: 'status' }>['phase']): ExecutionStatus {
  return phase === 'starting' ? 'running_cli' : 'streaming_response';
}

function publicStatusLabel(phase: Extract<NormalizedCliEvent, { type: 'status' }>['phase']): string {
  switch (phase) {
    case 'starting': return '正在启动 Codex';
    case 'thinking': return '正在分析任务';
    case 'working': return '正在执行工具';
    case 'finalizing': return '正在整理结果';
  }
}
