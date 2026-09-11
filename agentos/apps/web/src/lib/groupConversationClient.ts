import type { ConversationRuntimeError, DirectConversationClientOptions } from './directConversationClient';

/**
 * Controlled Group Conversation — typed client for the bounded group routes.
 *
 * Every call goes to the workspace-scoped forward surface
 * (`/api/workspaces/:id/runtime/...`), never a legacy path. The client owns no
 * state. No secret value is ever sent or stored.
 */

export interface GroupInteractionBudgetInput {
  readonly maxAgentsPerTurn: number;
  readonly maxRepliesPerAgent: number;
  readonly maxTotalReplies: number;
  readonly maxAgentHops: number;
  readonly timeoutMs?: number;
  readonly contextTokenBudget?: number;
}

export interface GroupInteraction {
  readonly id: string;
  readonly conversationId: string;
  readonly status: 'active' | 'stopped' | 'exhausted' | 'completed';
  readonly stopReason: string | null;
  readonly loopGuardSignal: string | null;
  readonly replyCount: number;
  readonly hopCount: number;
  readonly version: number;
}

export interface GroupBudgetStatus {
  readonly repliesUsed: number;
  readonly repliesRemaining: number;
  readonly hopsUsed: number;
  readonly hopsRemaining: number;
  readonly distinctAgents: number;
  readonly agentsRemaining: number;
}

export interface GroupReply {
  readonly id: string;
  readonly agentId: string;
  readonly messageId: string;
  readonly hopFromAgentId: string | null;
  readonly hopOrder: number;
}

export interface GroupInteractionDetail {
  readonly interaction: GroupInteraction;
  readonly replies: readonly GroupReply[];
  readonly budget: GroupBudgetStatus;
}

async function apiFetch<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    const error = new Error(body.error ?? `HTTP ${response.status}`) as ConversationRuntimeError;
    (error as { status: number }).status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

export function groupConversationClient(options: DirectConversationClientOptions) {
  const base = `${options.apiBase}/api/workspaces/${encodeURIComponent(options.workspaceId)}/runtime`;
  const jsonPost = (path: string, body: unknown) => apiFetch<never>(base, path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    createInteraction: (conversationId: string, budget: GroupInteractionBudgetInput): Promise<{ interaction: GroupInteraction }> =>
      jsonPost(`/conversations/${encodeURIComponent(conversationId)}/interactions`, { budget }),
    getInteraction: (interactionId: string) =>
      apiFetch<GroupInteractionDetail>(base, `/interactions/${encodeURIComponent(interactionId)}`),
    stopInteraction: (interactionId: string, expectedVersion: number): Promise<{ interaction: GroupInteraction }> =>
      jsonPost(`/interactions/${encodeURIComponent(interactionId)}/stop`, { expectedVersion }),
    /**
     * The bounded walk (SSE). Returns the raw Response; the caller consumes the
     * `group.plan` / `group.turn.*` / `group.done` events. Not-OK throws before
     * the stream is read.
     */
    respond: async (interactionId: string, conversationId: string, body: Record<string, unknown>): Promise<Response> => {
      const response = await fetch(
        `${base}/conversations/${encodeURIComponent(conversationId)}/interactions/${encodeURIComponent(interactionId)}/respond`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
        const error = new Error(errorBody.error ?? `HTTP ${response.status}`) as ConversationRuntimeError;
        (error as { status: number }).status = response.status;
        throw error;
      }
      return response;
    },
  };
}

export type GroupConversationClient = ReturnType<typeof groupConversationClient>;
