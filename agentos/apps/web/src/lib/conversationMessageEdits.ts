import type { ConversationRuntimeError } from './directConversationClient';

/**
 * Message edit / delete / revisions — typed client for the forward Conversation
 * runtime (Lite 09 §13 / §111).
 *
 * Every call goes to the workspace-scoped forward surface
 * (`/api/workspaces/:id/runtime/messages/...`). Edit keeps history through the
 * append-only revision ledger; delete is a soft delete (status 'deleted').
 * The client owns no state; list/search projections revalidate through the
 * existing conversation message list and search clients.
 */

export interface ConversationMessageRevision {
  readonly id: string;
  readonly messageId: string;
  readonly revision: number;
  readonly content: string;
  readonly editedAt: string;
}

export interface ConversationMessageRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly sequence: number;
  readonly senderType: 'user' | 'agent' | 'system';
  readonly senderAgentId: string | null;
  readonly kind: string;
  readonly status: string;
  readonly content: string;
  readonly clientMessageId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly sourceEventId: string | null;
  readonly replyToMessageId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ConversationMessageEditClientOptions {
  readonly apiBase: string;
  readonly workspaceId: string;
}

export function conversationMessageEditClient(options: ConversationMessageEditClientOptions) {
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
    /**
     * Edit Message content under optimistic concurrency. A stale expectedVersion
     * rejects with a 409 `MESSAGE_VERSION_CONFLICT`; history is kept server-side
     * as a revision.
     */
    editMessage: (
      messageId: string,
      input: { content: string; expectedVersion: number },
    ): Promise<{ message: ConversationMessageRecord }> =>
      request(`/messages/${encodeURIComponent(messageId)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }),

    /** Soft delete: the Message and its revisions are preserved server-side. */
    deleteMessage: (
      messageId: string,
      input: { expectedVersion: number },
    ): Promise<{ message: ConversationMessageRecord }> =>
      request(`/messages/${encodeURIComponent(messageId)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      }),

    /** Append-only edit history, oldest revision first. */
    listMessageRevisions: (messageId: string): Promise<{ revisions: readonly ConversationMessageRevision[] }> =>
      request(`/messages/${encodeURIComponent(messageId)}/revisions`),
  };
}

export type ConversationMessageEditClient = ReturnType<typeof conversationMessageEditClient>;
