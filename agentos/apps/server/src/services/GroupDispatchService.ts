import { randomBytes } from 'node:crypto';
import type { CollaborationRole, Conversation, ConversationMember } from '@agentos/shared';

export interface GroupMessageInput {
  content: string;
  mentionedAgentIds: string[];
}

export type DispatchDecision =
  | { action: 'self'; publicReason: string }
  | { action: 'members'; agentIds: string[]; publicReason: string }
  | { action: 'full_pipeline'; publicReason: string }
  | { action: 'need_user'; question: string };

export interface DispatchEnvelope {
  nonce: string;
  decision: DispatchDecision;
}

export interface GroupTurn {
  stableStepKey: string;
  agentId: string;
  roleKind: CollaborationRole;
  prompt: string;
}

const ENVELOPE_PREFIX = 'AGENTOS_DISPATCH::';

export function createDispatchNonce(): string {
  return randomBytes(16).toString('hex');
}

export function resolveDispatchDecision(
  conversation: Pick<Conversation, 'dispatchMode'>,
  members: readonly ConversationMember[],
  mentionedAgentIds: readonly string[],
): DispatchDecision {
  const memberIds = new Set(members.map(member => member.agentId));
  const mentions = [...new Set(mentionedAgentIds)].filter(agentId => memberIds.has(agentId));
  if (mentions.length > 0) return { action: 'members', agentIds: mentions, publicReason: '按用户 @mention 调度指定成员。' };
  if (conversation.dispatchMode === 'full_pipeline') return { action: 'full_pipeline', publicReason: '按群聊策略执行完整流水线。' };
  if (conversation.dispatchMode === 'mentioned_only') return { action: 'self', publicReason: '未指定 @Agent，由 Leader 直接回应。' };
  if (conversation.dispatchMode === undefined) return { action: 'full_pipeline', publicReason: '兼容未设置策略的历史群聊。' };
  return { action: 'self', publicReason: '由 Leader 路由并直接回应。' };
}

export function parseDispatchEnvelope(
  finalAssistantMessage: string,
  expectedNonce: string,
  members: readonly ConversationMember[],
): DispatchDecision {
  const memberIds = new Set(members.map(member => member.agentId));
  const envelopes: DispatchEnvelope[] = [];
  for (const line of finalAssistantMessage.split(/\r?\n/).map(item => item.trim())) {
    if (!line.startsWith(ENVELOPE_PREFIX)) continue;
    const parts = line.split('::');
    if (parts.length !== 3 || parts[1] !== expectedNonce) continue;
    try {
      const parsed = JSON.parse(Buffer.from(parts[2]!, 'base64url').toString('utf8')) as unknown;
      if (!isDispatchEnvelope(parsed, expectedNonce, memberIds)) continue;
      envelopes.push(parsed);
    } catch {
      // Invalid router output is intentionally fail-closed below.
    }
  }
  if (envelopes.length !== 1) return { action: 'need_user', question: 'Leader 路由结果无效，请确认下一步由哪个 Agent 执行。' };
  return envelopes[0].decision;
}

export function buildGroupTurns(
  decision: DispatchDecision,
  members: readonly ConversationMember[],
  prompt: string,
): GroupTurn[] {
  if (decision.action === 'need_user') return [];
  const sorted = [...members].sort((left, right) => left.sequence - right.sequence);
  const selected = decision.action === 'members'
    ? sorted.filter(member => decision.agentIds.includes(member.agentId))
    : decision.action === 'self'
      ? sorted.filter(member => member.roleKind === 'leader')
      : sorted;
  return selected.map(member => ({
    stableStepKey: `group-turn:${member.agentId}`,
    agentId: member.agentId,
    roleKind: member.roleKind,
    prompt,
  }));
}

function isDispatchEnvelope(value: unknown, expectedNonce: string, memberIds: Set<string>): value is DispatchEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.nonce !== expectedNonce || !envelope.decision || typeof envelope.decision !== 'object') return false;
  const decision = envelope.decision as Record<string, unknown>;
  if (decision.action === 'self' || decision.action === 'full_pipeline') return typeof decision.publicReason === 'string' && decision.publicReason.length <= 4000;
  if (decision.action === 'need_user') return typeof decision.question === 'string' && decision.question.trim().length > 0 && decision.question.length <= 4000;
  if (decision.action !== 'members' || !Array.isArray(decision.agentIds) || typeof decision.publicReason !== 'string') return false;
  const ids = decision.agentIds;
  return ids.length > 0 && ids.every(agentId => typeof agentId === 'string' && memberIds.has(agentId)) && new Set(ids).size === ids.length;
}
