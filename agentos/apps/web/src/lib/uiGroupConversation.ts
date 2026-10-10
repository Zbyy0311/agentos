import type { Conversation, ConversationAttachment, ConversationMember, ConversationMessage } from '@agentos/shared';
import { resolveAttachmentUrl } from './attachmentUrls';
import type { ForwardConversation, ForwardConversationMember } from './directConversationClient';

export function toUiGroupConversation(conversation: ForwardConversation): Conversation {
  const now = new Date().toISOString();
  return {
    id: conversation.id,
    workspaceId: conversation.workspaceId ?? '',
    type: 'group',
    title: conversation.title,
    dispatchMode: 'leader_route',
    settingsVersion: conversation.settingsVersion,
    createdAt: conversation.createdAt ?? conversation.updatedAt ?? now,
    updatedAt: conversation.updatedAt ?? conversation.createdAt ?? now,
  };
}

export function toUiGroupMember(member: ForwardConversationMember, index: number): ConversationMember {
  return {
    conversationId: member.conversationId,
    agentId: member.subjectId,
    roleTitle: member.roleTitle,
    roleKind: member.role === 'reviewer' ? 'reviewer' : index === 0 ? 'leader' : 'worker',
    sequence: (index + 1) * 10,
    ...(member.model === undefined ? {} : { model: member.model }),
    ...(member.thinkingEffort === undefined ? {} : { thinkingEffort: member.thinkingEffort }),
    ...(member.additionalInstructions === undefined ? {} : { additionalInstructions: member.additionalInstructions }),
    createdAt: member.joinedAt,
  };
}

export function toUiGroupMessage(message: { id: string; conversationId?: string; senderType: string; senderAgentId: string | null; content: string; runId: string | null; attachments?: readonly ConversationAttachment[]; createdAt?: string }, conversationId: string, workspaceId: string, apiBase = ''): ConversationMessage {
  return {
    id: message.id,
    conversationId: message.conversationId ?? conversationId,
    workspaceId,
    senderType: message.senderType === 'user' ? 'user' : message.senderType === 'system' ? 'system' : 'agent',
    ...(message.senderAgentId === null ? {} : { senderAgentId: message.senderAgentId }),
    ...(message.runId === null ? {} : { runId: message.runId }),
    content: message.content,
    ...(message.attachments === undefined ? {} : { attachments: message.attachments.map(attachment => ({ ...attachment, url: resolveAttachmentUrl(apiBase, attachment.url) })) }),
    createdAt: message.createdAt ?? new Date().toISOString(),
  };
}
