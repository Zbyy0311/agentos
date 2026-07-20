import { randomUUID } from 'node:crypto';
import type { AgentEventDraft, AgentEventType } from '@agentos/shared';

export function createAgentEvent<TPayload extends Record<string, unknown>>(input: {
  eventId?: string;
  type: AgentEventType;
  workspaceId: string;
  conversationId: string;
  runId: string;
  executionId?: string;
  agentId?: string;
  timestamp?: string;
  payload: TPayload;
}): AgentEventDraft<TPayload> {
  return {
    eventId: input.eventId ?? randomUUID(),
    schemaVersion: 2,
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
