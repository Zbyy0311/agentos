import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_TURN_TERMINAL_STATUSES,
  CONVERSATION_BOUNDARY_RULES,
  CONVERSATION_KINDS,
  CONVERSATION_REPLY_MODES,
  MESSAGE_NON_FINAL_STATUSES,
  MENTION_ALL,
  MEMBER_REPLY_MODES,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  canTransitionConversation,
  clientMessageKeyId,
  isAgentTurnTerminal,
  isMessageFinal,
  projectionKeyId,
  validateGroupInteractionBudget,
  validateMentionTarget,
  type GroupInteractionBudgetV1,
} from './src/index.ts';

// CR0-01 — forward conversation kinds add `system` without removing baseline kinds.
test('CR0-01 conversation kinds are frozen', () => {
  assert.deepEqual([...CONVERSATION_KINDS], ['direct', 'group', 'system']);
  assert.deepEqual([...CONVERSATION_REPLY_MODES], [
    'sequential', 'parallel-read-only', 'orchestrated', 'manual', 'mention-only',
  ]);
});

// CR0-02 — member roles and reply modes are frozen.
test('CR0-02 member vocabularies are frozen', () => {
  assert.deepEqual([...MEMBER_ROLES], ['owner', 'participant', 'observer', 'orchestrator', 'reviewer']);
  assert.deepEqual([...MEMBER_REPLY_MODES], ['always', 'mentioned', 'orchestrated', 'manual', 'never']);
  assert.deepEqual([...MEMBER_STATUSES], ['active', 'muted', 'removed']);
});

// CR0-03 — message finality rules.
test('CR0-03 message finality', () => {
  assert.deepEqual([...MESSAGE_NON_FINAL_STATUSES], ['draft', 'streaming']);
  assert.ok(isMessageFinal('final'));
  assert.ok(isMessageFinal('edited'));
  assert.ok(!isMessageFinal('streaming'));
  assert.ok(!isMessageFinal('failed'));
});

// CR0-04 — agent turn terminality.
test('CR0-04 agent turn terminality', () => {
  assert.deepEqual([...AGENT_TURN_TERMINAL_STATUSES], ['final', 'failed', 'cancelled']);
  assert.ok(isAgentTurnTerminal('cancelled'));
  assert.ok(!isAgentTurnTerminal('streaming'));
});

// CR0-05 — boundary rules freeze Message != Task/Run and archive semantics.
test('CR0-05 boundary rules are frozen', () => {
  assert.equal(CONVERSATION_BOUNDARY_RULES.normalMessageCreatesTask, false);
  assert.equal(CONVERSATION_BOUNDARY_RULES.normalMessageStartsRun, false);
  assert.equal(CONVERSATION_BOUNDARY_RULES.projectionBecomesRuntimeEvent, false);
  assert.equal(CONVERSATION_BOUNDARY_RULES.archiveCascadesDeletes, false);
  assert.equal(CONVERSATION_BOUNDARY_RULES.browserDisconnectCancelsRun, false);
});

// CR0-06 — archive/restore transitions are one-way.
test('CR0-06 archive and restore transitions', () => {
  assert.ok(canTransitionConversation('active', 'archive'));
  assert.ok(!canTransitionConversation('archived', 'archive'));
  assert.ok(canTransitionConversation('archived', 'restore'));
  assert.ok(!canTransitionConversation('active', 'restore'));
});

// CR0-07 — client message key is conversation-scoped.
test('CR0-07 client message key is conversation-scoped', () => {
  const a = clientMessageKeyId({ conversationId: 'conv_1', clientMessageId: 'c1' });
  const b = clientMessageKeyId({ conversationId: 'conv_2', clientMessageId: 'c1' });
  assert.notEqual(a, b);
  assert.equal(a, clientMessageKeyId({ conversationId: 'conv_1', clientMessageId: 'c1' }));
});

// CR0-08 — projection key is projector+event scoped.
test('CR0-08 projection key is idempotent-scoped', () => {
  const a = projectionKeyId({ projectorId: 'p1', sourceEventId: 'evt_1' });
  assert.equal(a, projectionKeyId({ projectorId: 'p1', sourceEventId: 'evt_1' }));
  assert.notEqual(a, projectionKeyId({ projectorId: 'p2', sourceEventId: 'evt_1' }));
});

// CR0-09 — a valid group budget passes; malformed budgets fail closed.
test('CR0-09 group budget validation', () => {
  const budget: GroupInteractionBudgetV1 = {
    maxAgentsPerTurn: 3,
    maxRepliesPerAgent: 2,
    maxTotalReplies: 6,
    maxAgentHops: 4,
  };
  assert.equal(validateGroupInteractionBudget(budget).valid, true);
  assert.deepEqual(validateGroupInteractionBudget(null), { valid: false, reason: 'NOT_OBJECT' });
  assert.deepEqual(validateGroupInteractionBudget({ ...budget, maxTotalReplies: 0 }), {
    valid: false, reason: 'LIMIT_INVALID',
  });
  assert.deepEqual(validateGroupInteractionBudget({ ...budget, maxAgentHops: -1 }), {
    valid: false, reason: 'HOPS_INVALID',
  });
  assert.deepEqual(validateGroupInteractionBudget({ ...budget, timeoutMs: 0 }), {
    valid: false, reason: 'TIMEOUT_INVALID',
  });
  assert.deepEqual(validateGroupInteractionBudget({ ...budget, contextTokenBudget: 0 }), {
    valid: false, reason: 'CONTEXT_BUDGET_INVALID',
  });
  assert.deepEqual(validateGroupInteractionBudget({ ...budget, maxAgentsPerTurn: 10, maxTotalReplies: 6 }), {
    valid: false, reason: 'AGENT_LIMIT_EXCEEDS_TOTAL',
  });
});

// CR0-10 — mention targets bind durable IDs; @all carries no agent.
test('CR0-10 mention targets', () => {
  assert.equal(MENTION_ALL, '@all');
  assert.ok(validateMentionTarget({ kind: 'agent', agentId: 'agent_1' }));
  assert.ok(validateMentionTarget({ kind: 'all' }));
  assert.ok(!validateMentionTarget({ kind: 'agent' }));
  assert.ok(!validateMentionTarget({ kind: 'agent', agentId: '   ' }));
  assert.ok(!validateMentionTarget({ kind: 'all', agentId: 'agent_1' }));
  assert.ok(!validateMentionTarget(null));
});
