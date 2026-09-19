/**
 * Direct Conversation UX — typed API client for the forward Conversation runtime.
 *
 * Every call goes to the workspace-scoped forward surface
 * (`/api/workspaces/:id/runtime/...`), never to a legacy path. The client owns no
 * state; the view layer owns cache, drafts, focus, and scroll (Lite 12 §18).
 *
 * No secret value is ever sent or stored.
 */

import type { AgentCapability, RunIntent, ThinkingEffort } from '@agentos/shared';

export interface ConversationRuntimeError extends Error {
  readonly status: number;
}

export interface ForwardConversation {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly status: string;
  readonly version: number;
  readonly settingsVersion?: number;
}

export interface ForwardAgent {
  readonly id: string;
  readonly name: string;
  readonly enabled?: boolean;
  readonly status?: string;
  readonly model?: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly capability?: AgentCapability;
  readonly roleTitle?: string;
}

export interface ForwardConversationMember {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly subjectType: 'user' | 'agent';
  readonly subjectId: string;
  readonly displayNameSnapshot: string;
  readonly role: string;
  readonly roleTitle: string;
  readonly replyMode: string;
  readonly status: string;
  readonly model?: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly additionalInstructions?: string;
  readonly joinedAt: string;
  readonly removedAt: string | null;
  readonly version: number;
}

export interface GroupMemberSettingsUpdate {
  readonly memberId: string;
  readonly roleTitle?: string | null;
  readonly model?: string | null;
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly additionalInstructions?: string | null;
}

export interface ForwardMessage {
  readonly id: string;
  /** Present on the canonical API response; older client fixtures may omit it. */
  readonly conversationId?: string;
  readonly sequence: number;
  readonly senderType: string;
  readonly senderAgentId: string | null;
  readonly status: string;
  readonly content: string;
  readonly taskId: string | null;
  readonly runId: string | null;
}

export interface ForwardTurn {
  readonly id: string;
  readonly status: string;
  readonly conversationId: string;
}

export interface CheckpointReplay {
  readonly message: ForwardMessage;
  readonly checkpoints: ReadonlyArray<{ readonly ordinal: number; readonly cursor: number; readonly delta: string }>;
  readonly nextCursor: number;
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

export interface DirectConversationClientOptions {
  readonly workspaceId: string;
  readonly apiBase: string;
}

export function directConversationClient(options: DirectConversationClientOptions) {
  const base = `${options.apiBase}/api/workspaces/${encodeURIComponent(options.workspaceId)}/runtime`;
  const jsonPost = (path: string, body: unknown) => apiFetch<never>(base, path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return {
    listAgents: () => apiFetch<{ agents: ForwardAgent[] }>(
      options.apiBase,
      `/api/workspaces/${encodeURIComponent(options.workspaceId)}/agents`,
    ),
    listConversations: () => apiFetch<{ conversations: ForwardConversation[] }>(base, '/conversations'),
    listMembers: (conversationId: string) =>
      apiFetch<{ members: ForwardConversationMember[] }>(base, `/conversations/${encodeURIComponent(conversationId)}/members`),
    updateGroupMemberSettings: (
      conversationId: string,
      expectedSettingsVersion: number,
      members: readonly GroupMemberSettingsUpdate[],
    ) => apiFetch<{ conversation: ForwardConversation; members: ForwardConversationMember[] }>(base, `/conversations/${encodeURIComponent(conversationId)}/members`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedSettingsVersion, members }),
    }),
    createConversation: (body: Record<string, unknown>) =>
      jsonPost('/conversations', body) as Promise<{ conversation: ForwardConversation }>,
    listMessages: (conversationId: string, afterSequence = 0) =>
      apiFetch<{ messages: ForwardMessage[] }>(base, `/conversations/${encodeURIComponent(conversationId)}/messages?afterSequence=${afterSequence}`),
    sendMessage: (conversationId: string, content: string, clientMessageId?: string) =>
      jsonPost(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
        content, ...(clientMessageId === undefined ? {} : { clientMessageId }),
      }) as Promise<{ message: ForwardMessage }>,
    /**
     * The reply stream (SSE). Returns the raw Response; the controller consumes it.
     * Not OK responses throw before the stream is read.
     */
    streamReply: async (conversationId: string, content: string, intent?: RunIntent): Promise<Response> => {
      const response = await fetch(`${base}/conversations/${encodeURIComponent(conversationId)}/messages/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, ...(intent === undefined ? {} : { intent }) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
        const error = new Error(body.error ?? `HTTP ${response.status}`) as ConversationRuntimeError;
        (error as { status: number }).status = response.status;
        throw error;
      }
      return response;
    },
    replayCheckpoints: (conversationId: string, messageId: string, afterCursor: number) =>
      apiFetch<CheckpointReplay>(base, `/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/checkpoints?afterCursor=${afterCursor}`),
    createTaskFromMessage: (messageId: string, body: Record<string, unknown> = {}) =>
      jsonPost(`/messages/${encodeURIComponent(messageId)}/create-task`, body),
    startRunFromMessage: (messageId: string, body: Record<string, unknown> = {}) =>
      jsonPost(`/messages/${encodeURIComponent(messageId)}/start-run`, body),
    listTurns: (conversationId: string) =>
      apiFetch<{ turns: ForwardTurn[] }>(base, `/conversations/${encodeURIComponent(conversationId)}/turns`),
  };
}

export type DirectConversationClient = ReturnType<typeof directConversationClient>;
