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
  readonly sourceMessageId: string | null;
  readonly maxAgentsPerTurn: number;
  readonly maxRepliesPerAgent: number;
  readonly maxTotalReplies: number;
  readonly maxAgentHops: number;
  readonly status: 'active' | 'stopped' | 'exhausted' | 'completed';
  readonly stopReason: string | null;
  readonly loopGuardSignal: string | null;
  readonly replyCount: number;
  readonly hopCount: number;
  readonly version: number;
  readonly ownerEpoch?: number;
  readonly integrityStatus?: 'valid' | 'unusable';
  readonly integrityReason?: string | null;
}

export function groupInteractionRecoveryReason(interaction: GroupInteraction | null | undefined): string | undefined {
  return interaction?.integrityStatus === 'unusable'
    ? interaction.integrityReason ?? 'interaction-integrity-unusable'
    : undefined;
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
  readonly executionOwner?: {
    readonly status: 'claimed' | 'running' | 'stop_requested' | 'completed' | 'failed' | 'interrupted' | 'abandoned';
    readonly ownerEpoch: number;
  } | null;
}

export interface GroupConversationRequestError extends ConversationRuntimeError {
  readonly code?: string;
}

export function mergeGroupInteractionVersionEvent(
  current: GroupInteraction | null,
  event: unknown,
): GroupInteraction | null {
  if (!current || !event || typeof event !== 'object') return current;
  const payload = event as Record<string, unknown>;
  const nested = payload.interaction && typeof payload.interaction === 'object'
    ? payload.interaction as Record<string, unknown>
    : undefined;
  const interactionId = typeof nested?.id === 'string' ? nested.id
    : typeof payload.interactionId === 'string' ? payload.interactionId : undefined;
  const version = typeof nested?.version === 'number' ? nested.version
    : typeof payload.interactionVersion === 'number' ? payload.interactionVersion
      : typeof payload.version === 'number' ? payload.version : undefined;
  const ownerEpoch = typeof nested?.ownerEpoch === 'number' ? nested.ownerEpoch
    : typeof payload.ownerEpoch === 'number' ? payload.ownerEpoch : undefined;
  if (interactionId !== current.id || version === undefined || !Number.isSafeInteger(version) || version < current.version
    || (ownerEpoch !== undefined && (!Number.isSafeInteger(ownerEpoch) || ownerEpoch < (current.ownerEpoch ?? 0)))
    || (version === current.version && (ownerEpoch === undefined || ownerEpoch <= (current.ownerEpoch ?? 0)))) return current;
  const integrityStatus = nested?.integrityStatus ?? payload.integrityStatus;
  const integrityReason = nested?.integrityReason === undefined ? payload.integrityReason : nested.integrityReason;
  return {
    ...current,
    version,
    ...(ownerEpoch === undefined ? {} : { ownerEpoch }),
    ...(nested?.status === undefined && (payload.status === 'active' || payload.status === 'stopped' || payload.status === 'exhausted' || payload.status === 'completed')
      ? { status: payload.status } : {}),
    ...(nested?.status === 'active' || nested?.status === 'stopped' || nested?.status === 'exhausted' || nested?.status === 'completed'
      ? { status: nested.status } : {}),
    ...(typeof nested?.replyCount === 'number' ? { replyCount: nested.replyCount } : {}),
    ...(typeof nested?.hopCount === 'number' ? { hopCount: nested.hopCount } : {}),
    ...(typeof nested?.stopReason === 'string' || nested?.stopReason === null ? { stopReason: nested.stopReason } : {}),
    // A status-only event cannot make an interrupted owner writable again.
    // Recovery requires a fresh authoritative snapshot, not a later raw active event.
    ...(current.integrityStatus !== 'unusable' && (integrityStatus === 'valid' || integrityStatus === 'unusable')
      ? { integrityStatus } : {}),
    ...(current.integrityStatus !== 'unusable' && (typeof integrityReason === 'string' || integrityReason === null)
      ? { integrityReason } : {}),
  };
}

async function apiFetch<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; code?: string; errorCode?: string };
    const error = new Error(body.error ?? `HTTP ${response.status}`) as GroupConversationRequestError;
    (error as { status: number }).status = response.status;
    if (body.code ?? body.errorCode) (error as { code?: string }).code = body.code ?? body.errorCode;
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
    getInteraction: (interactionId: string) =>
      apiFetch<GroupInteractionDetail>(base, `/interactions/${encodeURIComponent(interactionId)}`),
    listInteractions: (conversationId: string) =>
      apiFetch<{ interactions: readonly GroupInteraction[] }>(base, `/conversations/${encodeURIComponent(conversationId)}/interactions`),
    createDiscussion: (conversationId: string, body: Record<string, unknown>, idempotencyKey: string): Promise<{ message: { id: string; conversationId?: string; senderType: string; senderAgentId: string | null; content: string; runId: string | null; createdAt?: string }; interaction: GroupInteraction }> =>
      apiFetch(base, `/conversations/${encodeURIComponent(conversationId)}/discussions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(body),
      }),
    createInteraction: (conversationId: string, budget: GroupInteractionBudgetInput): Promise<{ interaction: GroupInteraction }> =>
      jsonPost(`/conversations/${encodeURIComponent(conversationId)}/interactions`, { budget }),
    observeEvents: async (conversationId: string, interactionId: string, after: number, signal?: AbortSignal): Promise<Response> => {
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a non-negative integer cursor');
      const query = new URLSearchParams({ after: String(after) });
      const response = await fetch(
        `${base}/conversations/${encodeURIComponent(conversationId)}/interactions/${encodeURIComponent(interactionId)}/events?${query.toString()}`,
        { method: 'GET', headers: { Accept: 'text/event-stream' }, ...(signal === undefined ? {} : { signal }) },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; code?: string };
        const error = new Error(body.error ?? `HTTP ${response.status}`) as GroupConversationRequestError;
        (error as { status: number }).status = response.status;
        if (body.code) (error as { code?: string }).code = body.code;
        throw error;
      }
      return response;
    },
    stopInteraction: (interactionId: string, expectedVersion: number, idempotencyKey: string): Promise<{ interaction: GroupInteraction; execution?: { ownerEpoch: number; status: string; eventCursor: number; terminalReason: string | null } | null }> =>
      apiFetch(base, `/interactions/${encodeURIComponent(interactionId)}/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ expectedVersion }),
      }),
    /**
     * The bounded walk (SSE). Returns the raw Response; the caller consumes the
     * `group.plan` / `group.turn.*` / `group.done` events. Not-OK throws before
     * the stream is read.
     */
    respond: async (interactionId: string, conversationId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> => {
      const response = await fetch(
        `${base}/conversations/${encodeURIComponent(conversationId)}/interactions/${encodeURIComponent(interactionId)}/respond`,
        {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        },
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
