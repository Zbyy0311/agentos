import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentEventType } from '@agentos/shared';

export function createAgentEvent<TPayload extends Record<string, unknown>>(input: {
  type: AgentEventType;
  workspaceId: string;
  conversationId: string;
  runId: string;
  executionId?: string;
  agentId?: string;
  timestamp?: string;
  payload: TPayload;
}): AgentEvent<TPayload> {
  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    type: input.type,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    runId: input.runId,
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: input.payload,
  };
}
