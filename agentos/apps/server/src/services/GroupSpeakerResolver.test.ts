/**
 * Controlled Group speaker resolution — gates CG-S1..CG-S4.
 *
 * Authorization: `docs/implementation/milestones/CG-orchestration-entry-audit.md`
 * sections 5.1, 5.3 and 6.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveGroupSpeakers,
  type GroupSpeakerMember,
  type ResolveGroupSpeakersInput,
} from './GroupSpeakerResolver.js';

const AGENT_A = 'agent_a';
const AGENT_B = 'agent_b';
const AGENT_C = 'agent_c';

function member(
  agentId: string | null,
  overrides: Partial<GroupSpeakerMember> = {},
): GroupSpeakerMember {
  return {
    memberId: 'member_' + (agentId ?? 'human'),
    agentId,
    role: 'participant',
    replyMode: 'always',
    status: 'active',
    joinedAt: '2026-09-11T00:00:00.000Z',
    ...overrides,
  };
}

function input(overrides: Partial<ResolveGroupSpeakersInput> = {}): ResolveGroupSpeakersInput {
  return {
    conversationKind: 'group',
    conversationStatus: 'active',
    replyMode: 'sequential',
    members: [member(AGENT_A), member(AGENT_B)],
    replyAgentIds: [],
    budget: { maxAgentsPerTurn: 4, maxRepliesPerAgent: 2, maxTotalReplies: 8 },
    ...overrides,
  };
}

test('CG-S1: eligibility excludes muted, removed, never, and human members with stable reasons', () => {
  const plan = resolveGroupSpeakers(input({
    members: [
      member(AGENT_A),
      member(AGENT_B, { replyMode: 'never' }),
      member(AGENT_C, { status: 'muted' }),
      member('agent_d', { status: 'removed' }),
      member(null),
    ],
  }));
  assert.deepEqual(plan.speakers.map(speaker => speaker.agentId), [AGENT_A]);
  const reasons = plan.skipped.map(skip => [skip.agentId, skip.reason]);
  assert.deepEqual(reasons, [
    [AGENT_B, 'member-reply-mode-never'],
    [AGENT_C, 'member-not-active'],
    ['agent_d', 'member-not-active'],
    [null, 'member-not-active'],
  ]);
  // A `mentioned` member only replies when it is actually mentioned.
  const mentionedOnly = resolveGroupSpeakers(input({
    members: [member(AGENT_A, { replyMode: 'mentioned' }), member(AGENT_B)],
  }));
  assert.deepEqual(mentionedOnly.speakers.map(speaker => speaker.agentId), [AGENT_B]);
  assert.deepEqual(
    mentionedOnly.skipped.filter(skip => skip.agentId === AGENT_A).map(skip => skip.reason),
    ['not-mentioned'],
  );
});

test('CG-S1: a non-group or archived Conversation never yields speakers', () => {
  for (const overrides of [
    { conversationKind: 'direct' as const },
    { conversationStatus: 'archived' as const },
  ]) {
    const plan = resolveGroupSpeakers(input(overrides));
    assert.deepEqual(plan.speakers, []);
    assert.equal(plan.skipped.length, 2);
    assert.ok(plan.skipped.every(skip => skip.reason === 'member-not-active'));
  }
});

test('CG-S2: sequential order is membership order; mentions always win and are reported', () => {
  const sequential = resolveGroupSpeakers(input({
    members: [
      member(AGENT_B, { joinedAt: '2026-09-11T02:00:00.000Z' }),
      member(AGENT_A, { joinedAt: '2026-09-11T01:00:00.000Z' }),
    ],
  }));
  assert.deepEqual(sequential.speakers.map(speaker => speaker.agentId), [AGENT_A, AGENT_B]);
  assert.deepEqual(sequential.speakers.map(speaker => speaker.source), ['mode', 'mode']);

  // Same join time breaks the tie by member id ascending, so the order is
  // reproducible rather than dependent on insertion order.
  const tied = resolveGroupSpeakers(input({
    members: [
      member(AGENT_B, { joinedAt: '2026-09-11T01:00:00.000Z' }),
      member(AGENT_A, { joinedAt: '2026-09-11T01:00:00.000Z' }),
    ],
  }));
  assert.deepEqual(tied.speakers.map(speaker => speaker.agentId), [AGENT_A, AGENT_B]);

  // A mention outranks the Conversation mode and follows mention order.
  const mentioned = resolveGroupSpeakers(input({
    replyMode: 'mention-only',
    mentionedAgentIds: [AGENT_B, AGENT_A],
  }));
  assert.deepEqual(mentioned.speakers.map(speaker => speaker.agentId), [AGENT_B, AGENT_A]);
  assert.ok(mentioned.speakers.every(speaker => speaker.source === 'mention'));

  // A mention of an unknown or removed Agent is explicit, never silent.
  const unresolved = resolveGroupSpeakers(input({ mentionedAgentIds: ['agent_ghost'] }));
  assert.deepEqual(unresolved.speakers.map(speaker => speaker.agentId), [AGENT_A, AGENT_B]);
  assert.ok(unresolved.skipped.some(skip => skip.reason === 'mention-unresolved' && skip.agentId === 'agent_ghost'));
});

test('CG-S2: manual mode follows the caller order and reports the rest', () => {
  const plan = resolveGroupSpeakers(input({
    replyMode: 'manual',
    members: [member(AGENT_A), member(AGENT_B), member(AGENT_C)],
    namedAgentIds: [AGENT_C, AGENT_A],
  }));
  assert.deepEqual(plan.speakers.map(speaker => speaker.agentId), [AGENT_C, AGENT_A]);
  assert.ok(plan.speakers.every(speaker => speaker.source === 'manual'));
  assert.ok(plan.skipped.some(skip => skip.agentId === AGENT_B && skip.reason === 'not-selected-manually'));
});

test('CG-S3: orchestrated mode resolves the template order deterministically', () => {
  const base = input({
    replyMode: 'orchestrated',
    members: [member(AGENT_A), member(AGENT_B), member(AGENT_C)],
    orchestratedOrder: [AGENT_B, AGENT_C],
  });
  const first = resolveGroupSpeakers(base);
  const second = resolveGroupSpeakers(base);
  assert.deepEqual(first, second);
  assert.deepEqual(first.speakers.map(speaker => speaker.agentId), [AGENT_B, AGENT_C]);
  assert.ok(first.speakers.every(speaker => speaker.source === 'template'));
  assert.ok(first.skipped.some(skip => skip.agentId === AGENT_A && skip.reason === 'not-orchestrated'));

  // A member whose OWN mode is `orchestrated` is eligible only when the template
  // names it, so member mode and template order cannot disagree silently.
  const memberScoped = resolveGroupSpeakers(input({
    replyMode: 'orchestrated',
    members: [member(AGENT_A, { replyMode: 'orchestrated' }), member(AGENT_B)],
    orchestratedOrder: [AGENT_B],
  }));
  assert.deepEqual(memberScoped.speakers.map(speaker => speaker.agentId), [AGENT_B]);
  assert.ok(memberScoped.skipped.some(skip => skip.agentId === AGENT_A));

  // Without a template order an orchestrated interaction selects nobody rather
  // than inventing an order.
  const unordered = resolveGroupSpeakers(input({ replyMode: 'orchestrated' }));
  assert.deepEqual(unordered.speakers, []);
  assert.equal(unordered.terminalReason, undefined);
  assert.ok(unordered.skipped.every(skip => skip.reason === 'not-orchestrated'));
});

test('CG-S4: the plan ends with the same stable budget reason recordReply would return', () => {
  const total = resolveGroupSpeakers(input({
    budget: { maxAgentsPerTurn: 4, maxRepliesPerAgent: 2, maxTotalReplies: 2 },
    replyAgentIds: [AGENT_A, AGENT_B],
  }));
  assert.deepEqual(total.speakers, []);
  assert.equal(total.terminalReason, 'budget-total-replies');
  assert.ok(total.skipped.every(skip => skip.reason === 'budget-total-replies'));

  const perAgent = resolveGroupSpeakers(input({
    budget: { maxAgentsPerTurn: 4, maxRepliesPerAgent: 1, maxTotalReplies: 8 },
    replyAgentIds: [AGENT_A],
  }));
  assert.deepEqual(perAgent.speakers.map(speaker => speaker.agentId), [AGENT_B]);
  assert.equal(perAgent.terminalReason, undefined);
  assert.ok(perAgent.skipped.some(skip => skip.agentId === AGENT_A && skip.reason === 'budget-replies-per-agent'));

  const agents = resolveGroupSpeakers(input({
    members: [member(AGENT_A), member(AGENT_B), member(AGENT_C)],
    budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 3, maxTotalReplies: 8 },
  }));
  assert.deepEqual(agents.speakers.map(speaker => speaker.agentId), [AGENT_A, AGENT_B]);
  assert.ok(agents.skipped.some(skip => skip.agentId === AGENT_C && skip.reason === 'budget-agents'));

  // An Agent that already replied does not consume a NEW Agent slot: with a
  // per-Turn cap of 2 and one prior speaker, exactly one further Agent may join.
  const returning = resolveGroupSpeakers(input({
    members: [member(AGENT_A), member(AGENT_B), member(AGENT_C)],
    budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 3, maxTotalReplies: 8 },
    replyAgentIds: [AGENT_A],
  }));
  assert.deepEqual(returning.speakers.map(speaker => speaker.agentId), [AGENT_A, AGENT_B]);
  assert.ok(returning.skipped.some(skip => skip.agentId === AGENT_C && skip.reason === 'budget-agents'));
});

test('CG-S1/CG-S9: parallel-read-only declares intent but never claims an unproven read-only class', () => {
  const plan = resolveGroupSpeakers(input({ replyMode: 'parallel-read-only' }));
  assert.equal(plan.speakers.length, 2);
  assert.ok(plan.speakers.every(speaker => speaker.declaredReadOnly === true));
  assert.ok(plan.speakers.every(speaker => speaker.effectiveMutationClass === 'modifying'));
  const sequential = resolveGroupSpeakers(input({ replyMode: 'sequential' }));
  assert.ok(sequential.speakers.every(speaker => speaker.declaredReadOnly === false));
});
