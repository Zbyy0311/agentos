import type {
  ConversationKind,
  ConversationReplyMode,
  GroupStopReason,
  MemberReplyMode,
  MemberRole,
} from '@agentos/shared';

/**
 * Controlled Group Conversation — speaker resolution.
 *
 * Authorization: `docs/implementation/milestones/CG-orchestration-entry-audit.md`
 * sections 5.1, 5.3 and gates CG-S1..CG-S4.
 *
 * This module is PURE: it reads the durable inputs handed to it and returns a
 * plan. It never mutates state, never opens a transaction, and never calls a
 * Provider, so a caller can show the plan before anything runs and a test can
 * assert every rule directly.
 *
 * `BoundedGroupService.recordReply` stays the ONLY writer of interaction state:
 * budgets, stop, and the loop guard remain its terminators. The resolver's
 * budget pre-check exists so a walk ends with the SAME stable reason instead of
 * spending a Provider call to discover it.
 */

/** Why one member did not become a speaker. Every exclusion is explicit. */
export const SPEAKER_SKIP_REASONS = [
  'member-not-active',
  'member-reply-mode-never',
  'not-mentioned',
  'not-orchestrated',
  'not-selected-manually',
  'mention-unresolved',
  'budget-total-replies',
  'budget-replies-per-agent',
  'budget-agents',
] as const;
export type SpeakerSkipReason = (typeof SPEAKER_SKIP_REASONS)[number];

/** How a speaker entered the plan: the trigger that selected it. */
export const SPEAKER_SOURCES = ['mention', 'mode', 'manual', 'template'] as const;
export type SpeakerSource = (typeof SPEAKER_SOURCES)[number];

/** The only mutation class this slice may claim: nothing proves read-only yet. */
export type EffectiveMutationClass = 'modifying' | 'read-only';

export interface GroupSpeakerMember {
  readonly memberId: string;
  /** The durable Agent id (`subjectType === 'agent'`), or null for a human member. */
  readonly agentId: string | null;
  readonly role: MemberRole;
  readonly replyMode: MemberReplyMode;
  readonly status: 'active' | 'muted' | 'removed';
  readonly joinedAt: string;
}

export interface GroupSpeakerBudget {
  readonly maxAgentsPerTurn: number;
  readonly maxRepliesPerAgent: number;
  readonly maxTotalReplies: number;
}

export interface ResolveGroupSpeakersInput {
  readonly conversationKind: ConversationKind;
  readonly conversationStatus: 'active' | 'archived';
  readonly replyMode: ConversationReplyMode | null;
  readonly members: readonly GroupSpeakerMember[];
  /** Agent ids mentioned in the triggering Message. */
  readonly mentionedAgentIds?: readonly string[];
  /** Agent ids the caller named explicitly (`manual` mode). */
  readonly namedAgentIds?: readonly string[];
  /** Template-declared speaker order (decision D1 option B), agent ids. */
  readonly orchestratedOrder?: readonly string[];
  /** Durable reply history of the interaction, oldest first. */
  readonly replyAgentIds: readonly string[];
  readonly budget: GroupSpeakerBudget;
}

export interface GroupSpeakerSelection {
  readonly memberId: string;
  readonly agentId: string;
  readonly role: MemberRole;
  readonly source: SpeakerSource;
  /** What the Conversation mode asked for. */
  readonly declaredReadOnly: boolean;
  /** Frozen: this slice never claims an unproven read-only class. */
  readonly effectiveMutationClass: EffectiveMutationClass;
}

export interface GroupSpeakerSkip {
  readonly memberId: string;
  readonly agentId: string | null;
  readonly reason: SpeakerSkipReason;
}

export interface GroupSpeakerPlan {
  readonly speakers: readonly GroupSpeakerSelection[];
  readonly skipped: readonly GroupSpeakerSkip[];
  /** Set when the plan is empty because a budget is already exhausted. */
  readonly terminalReason?: GroupStopReason;
}

function isActiveAgentMember(member: GroupSpeakerMember): member is GroupSpeakerMember & { agentId: string } {
  // A human member carries no Agent id and can never be a speaker.
  return member.status === 'active' && typeof member.agentId === 'string' && member.agentId.length > 0;
}

/** Deterministic membership order: join time, then member id. */
function byMembership(left: GroupSpeakerMember, right: GroupSpeakerMember): number {
  if (left.joinedAt !== right.joinedAt) return left.joinedAt < right.joinedAt ? -1 : 1;
  return left.memberId < right.memberId ? -1 : left.memberId > right.memberId ? 1 : 0;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Whether a member's OWN reply mode lets it reply for this trigger. Member mode
 * decides eligibility (CR-0); the Conversation mode decides order.
 */
function eligibleByOwnMode(
  member: GroupSpeakerMember,
  mentioned: readonly string[],
  named: readonly string[],
  orchestrated: readonly string[],
): boolean {
  const agentId = member.agentId as string;
  switch (member.replyMode) {
    case 'always': return true;
    case 'mentioned': return mentioned.includes(agentId);
    case 'orchestrated': return orchestrated.includes(agentId);
    case 'manual': return named.includes(agentId);
    case 'never': return false;
    default: return false;
  }
}

function skipReasonForOwnMode(member: GroupSpeakerMember): SpeakerSkipReason {
  return member.replyMode === 'never' ? 'member-reply-mode-never' : 'not-selected-manually';
}

/**
 * Resolve the ordered speaker plan for one bounded walk.
 *
 * Rules, in order (audit section 5.1): eligibility, mention precedence, mode
 * order, then a budget pre-check that reproduces `recordReply`'s stable reasons.
 */
export function resolveGroupSpeakers(input: ResolveGroupSpeakersInput): GroupSpeakerPlan {
  const skipped: GroupSpeakerSkip[] = [];
  const members = [...input.members].sort(byMembership);
  const mentioned = dedupe(input.mentionedAgentIds ?? []);
  const named = dedupe(input.namedAgentIds ?? []);
  const orchestrated = dedupe(input.orchestratedOrder ?? []);
  const replyAgentIds = input.replyAgentIds;
  const readOnlyIntent = input.replyMode === 'parallel-read-only';

  // A direct or archived Conversation has no bounded group walk at all.
  if (input.conversationKind !== 'group' || input.conversationStatus !== 'active') {
    return {
      speakers: [],
      skipped: members.map(member => ({
        memberId: member.memberId, agentId: member.agentId, reason: 'member-not-active' as const,
      })),
    };
  }

  const activeAgents: Array<GroupSpeakerMember & { agentId: string }> = [];
  for (const member of members) {
    if (!isActiveAgentMember(member)) {
      skipped.push({ memberId: member.memberId, agentId: member.agentId, reason: 'member-not-active' });
      continue;
    }
    if (!eligibleByOwnMode(member, mentioned, named, orchestrated)) {
      skipped.push({
        memberId: member.memberId,
        agentId: member.agentId,
        reason: member.replyMode === 'mentioned' ? 'not-mentioned' : skipReasonForOwnMode(member),
      });
      continue;
    }
    activeAgents.push(member);
  }

  // A mention naming nobody in this Conversation is reported, never ignored.
  const activeAgentIds = new Set(activeAgents.map(member => member.agentId as string));
  for (const agentId of mentioned) {
    if (!activeAgentIds.has(agentId)) {
      skipped.push({ memberId: '', agentId, reason: 'mention-unresolved' });
    }
  }

  const eligible = activeAgents;

  // Order: mentions win, then the Conversation mode decides.
  let ordered: GroupSpeakerMember[];
  let source: SpeakerSource;
  const mentionHits = eligible.filter(member => mentioned.includes(member.agentId as string));
  if (mentionHits.length > 0) {
    ordered = mentionHits.sort((left, right) =>
      mentioned.indexOf(left.agentId as string) - mentioned.indexOf(right.agentId as string));
    source = 'mention';
  } else if (input.replyMode === 'manual') {
    ordered = eligible
      .filter(member => named.includes(member.agentId as string))
      .sort((left, right) => named.indexOf(left.agentId as string) - named.indexOf(right.agentId as string));
    source = 'manual';
  } else if (input.replyMode === 'orchestrated') {
    ordered = eligible
      .filter(member => orchestrated.includes(member.agentId as string))
      .sort((left, right) => orchestrated.indexOf(left.agentId as string) - orchestrated.indexOf(right.agentId as string));
    source = 'template';
  } else {
    ordered = eligible;
    source = 'mode';
  }

  // Every eligible member the order rules left out is reported with its reason.
  const chosen = new Set(ordered.map(member => member.memberId));
  for (const member of eligible) {
    if (chosen.has(member.memberId)) continue;
    skipped.push({
      memberId: member.memberId, agentId: member.agentId,
      reason: input.replyMode === 'orchestrated' ? 'not-orchestrated' : 'not-selected-manually',
    });
  }
  // Budget pre-check in `recordReply`'s order: total, per agent, then agents.
  const budgetLimited: GroupSpeakerSelection[] = [];
  // Mirrors `recordReply`'s counters: distinct Agents come from the durable
  // reply history plus the Agents this plan already admitted, and an Agent that
  // already replied never consumes a new slot.
  const projectedAgents = new Set(replyAgentIds);
  let projectedTotal = replyAgentIds.length;
  let terminalReason: GroupStopReason | undefined;
  for (const member of ordered) {
    const agentId = member.agentId as string;
    if (projectedTotal + 1 > input.budget.maxTotalReplies) {
      terminalReason ??= 'budget-total-replies';
      skipped.push({ memberId: member.memberId, agentId, reason: 'budget-total-replies' });
      continue;
    }
    const alreadyReplied = replyAgentIds.filter(id => id === agentId).length;
    if (alreadyReplied + 1 > input.budget.maxRepliesPerAgent) {
      terminalReason ??= 'budget-replies-per-agent';
      skipped.push({ memberId: member.memberId, agentId, reason: 'budget-replies-per-agent' });
      continue;
    }
    if (!projectedAgents.has(agentId) && projectedAgents.size + 1 > input.budget.maxAgentsPerTurn) {
      terminalReason ??= 'budget-agents';
      skipped.push({ memberId: member.memberId, agentId, reason: 'budget-agents' });
      continue;
    }
    projectedTotal += 1;
    projectedAgents.add(agentId);
    budgetLimited.push({
      memberId: member.memberId, agentId, role: member.role, source,
      declaredReadOnly: readOnlyIntent,
      // No Adapter/platform proves `enforcedWorkspaceReadOnly` on this path, so
      // every speaker is modifying and the walk stays serialized (section 5.3).
      effectiveMutationClass: 'modifying',
    });
  }

  return {
    speakers: budgetLimited,
    skipped,
    ...(budgetLimited.length === 0 && terminalReason !== undefined ? { terminalReason } : {}),
  };
}
