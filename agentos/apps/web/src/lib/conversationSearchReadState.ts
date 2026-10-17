import type { ConversationRuntimeError } from './directConversationClient';

/**
 * Conversation message search + Read State — typed client for the forward
 * Conversation runtime (Lite 09 §68/§71, §115/§116).
 *
 * Every call goes to the workspace-scoped forward surface
 * (`/api/workspaces/:id/runtime/...`), never a legacy path. The client owns no
 * state; unread badges should revalidate through `listConversationReadStates`.
 */

export interface ConversationSearchQuery {
  readonly query: string;
  readonly sender?: 'user' | 'agent' | 'system';
  readonly agentId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly type?: string;
  readonly limit?: number;
}

export interface ConversationSearchHit {
  readonly messageId: string;
  readonly conversationId: string;
  readonly sequence: number;
  readonly senderType: string;
  readonly senderDisplayName: string;
  readonly snippet: string;
  readonly matchedTerms: readonly string[];
  readonly createdAt: string;
}

export interface ConversationReadState {
  readonly conversationId: string;
  readonly userId: string;
  readonly lastReadMessageSequence: number;
  readonly lastReadMessageId: string | null;
  readonly lastReadAt: string;
  readonly unreadCount: number;
  readonly mentionCount: number;
  readonly approvalCount: number;
}

export interface ConversationSearchClientOptions {
  readonly apiBase: string;
  readonly workspaceId: string;
}

function searchParamsOf(query: ConversationSearchQuery, conversationId?: string): URLSearchParams {
  const params = new URLSearchParams({ query: query.query });
  if (query.sender !== undefined) params.set('sender', query.sender);
  if (query.agentId !== undefined) params.set('agentId', query.agentId);
  if (query.from !== undefined) params.set('from', query.from);
  if (query.to !== undefined) params.set('to', query.to);
  if (query.type !== undefined) params.set('type', query.type);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (conversationId !== undefined) params.set('conversationId', conversationId);
  return params;
}

export function conversationSearchReadStateClient(options: ConversationSearchClientOptions) {
  const base = `${options.apiBase}/api/workspaces/${encodeURIComponent(options.workspaceId)}/runtime`;
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, init);
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; detail?: string; title?: string; code?: string };
      const error = new Error(body.detail ?? body.error ?? body.title ?? `HTTP ${response.status}`) as ConversationRuntimeError;
      (error as { status: number }).status = response.status;
      if (body.code) (error as { code?: string }).code = body.code;
      throw error;
    }
    return response.json() as Promise<T>;
  };

  return {
    /** Global workspace search across every Conversation. */
    searchConversations: (query: ConversationSearchQuery): Promise<{ results: readonly ConversationSearchHit[] }> =>
      request(`/conversations/search?${searchParamsOf(query).toString()}`),

    /** Conversation-scoped search. */
    searchConversation: (conversationId: string, query: ConversationSearchQuery): Promise<{ results: readonly ConversationSearchHit[] }> =>
      request(`/conversations/${encodeURIComponent(conversationId)}/search?${searchParamsOf(query).toString()}`),

    /**
     * Advance the read position. Pass `latest: true` to converge on the newest
     * Message; the server never moves the position backwards.
     */
    markConversationRead: (
      conversationId: string,
      input: { userId?: string; lastReadMessageSequence?: number; latest?: boolean },
    ): Promise<{ readState: ConversationReadState }> =>
      request(`/conversations/${encodeURIComponent(conversationId)}/read`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }),

    /** One Conversation's read state (server-computed unread/mention counts). */
    getConversationReadState: (conversationId: string, userId?: string): Promise<{ readState: ConversationReadState }> =>
      request(`/conversations/${encodeURIComponent(conversationId)}/read-state${userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`}`),

    /** Batch read states for the Conversation list page. */
    listConversationReadStates: (userId?: string): Promise<{ readStates: readonly ConversationReadState[] }> =>
      request(`/conversations/read-state${userId === undefined ? '' : `?userId=${encodeURIComponent(userId)}`}`),
  };
}

export type ConversationSearchReadStateClient = ReturnType<typeof conversationSearchReadStateClient>;
