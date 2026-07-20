import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationMember } from '@agentos/shared';
import { buildGroupTurns, createDispatchNonce, parseDispatchEnvelope, resolveDispatchDecision } from './GroupDispatchService.js';

const members: ConversationMember[] = [
  { conversationId: 'group', agentId: 'leader', roleKind: 'leader', roleTitle: 'Leader', sequence: 10, createdAt: '2026-07-18T00:00:00.000Z' },
  { conversationId: 'group', agentId: 'worker', roleKind: 'worker', roleTitle: 'Worker', sequence: 20, createdAt: '2026-07-18T00:00:00.000Z' },
  { conversationId: 'group', agentId: 'reviewer', roleKind: 'reviewer', roleTitle: 'Reviewer', sequence: 30, createdAt: '2026-07-18T00:00:00.000Z' },
];

test('mentions take precedence and unknown mentions are ignored by the pure decision function', () => {
  assert.deepEqual(resolveDispatchDecision({ dispatchMode: 'full_pipeline' }, members, ['reviewer']), { action: 'members', agentIds: ['reviewer'], publicReason: '按用户 @mention 调度指定成员。' });
  assert.equal(resolveDispatchDecision({ dispatchMode: 'mentioned_only' }, members, ['missing']).action, 'self');
});

test('dispatch mode selects self or full pipeline when there are no mentions', () => {
  assert.equal(resolveDispatchDecision({ dispatchMode: 'full_pipeline' }, members, []).action, 'full_pipeline');
  assert.equal(resolveDispatchDecision({ dispatchMode: 'leader_route' }, members, []).action, 'self');
});

test('parses only the expected nonce and fails closed for malformed, duplicate, or non-member envelopes', () => {
  const nonce = createDispatchNonce();
  const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString('base64url');
  const valid = `AGENTOS_DISPATCH::${nonce}::${encode({ nonce, decision: { action: 'members', agentIds: ['worker'], publicReason: 'implement' } })}`;
  assert.deepEqual(parseDispatchEnvelope(`normal text\n${valid}`, nonce, members), { action: 'members', agentIds: ['worker'], publicReason: 'implement' });
  assert.equal(parseDispatchEnvelope(valid, createDispatchNonce(), members).action, 'need_user');
  const invalidMember = `AGENTOS_DISPATCH::${nonce}::${encode({ nonce, decision: { action: 'members', agentIds: ['outside'], publicReason: 'bad' } })}`;
  assert.equal(parseDispatchEnvelope(invalidMember, nonce, members).action, 'need_user');
  assert.equal(parseDispatchEnvelope(`${valid}\n${valid}`, nonce, members).action, 'need_user');
});

test('builds deterministic turns by persisted member sequence', () => {
  const turns = buildGroupTurns({ action: 'members', agentIds: ['reviewer', 'worker'], publicReason: 'selected' }, members, 'do work');
  assert.deepEqual(turns.map(turn => turn.agentId), ['worker', 'reviewer']);
  assert.equal(buildGroupTurns({ action: 'need_user', question: 'which?' }, members, 'do work').length, 0);
});
