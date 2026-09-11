import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEMORY_AUTHORITIES,
  MEMORY_AUTHORITY_RANK,
  MEMORY_CATEGORIES,
  MEMORY_CONTEXT_SNAPSHOT_IMMUTABILITY,
  MEMORY_DEDUPLICATION_ORDER,
  MEMORY_EVENT_PAYLOAD_RULE,
  MEMORY_EVENT_TYPES,
  MEMORY_NON_RETRIEVABLE_STATUSES,
  MEMORY_SCOPES,
  MEMORY_SCOPE_PROXIMITY,
  MemoryScopeOwnerError_,
  assertMemoryScopeOwner,
  compareMemoryAuthority,
  compareMemoryScopeProximity,
  decideMemoryPromotion,
  isWeakMemoryAuthority,
  requiresMemorySource,
  validateMemoryBudgetPolicy,
  validateMemoryScopeOwner,
  type MemoryBudgetPolicyV1,
  type MemoryPromotionGateInput,
  type MemoryScopeOwner,
} from './src/index.ts';

// MF0-01 — frozen scope vocabulary and proximity ordering.
test('MF0-01 scope vocabulary and proximity are frozen', () => {
  assert.deepEqual([...MEMORY_SCOPES], ['global', 'workspace', 'agent', 'conversation', 'task', 'run']);
  const ordered = [...MEMORY_SCOPES].sort(compareMemoryScopeProximity);
  assert.deepEqual(ordered, ['run', 'task', 'conversation', 'agent', 'workspace', 'global']);
  assert.equal(MEMORY_SCOPE_PROXIMITY.run, 0);
  assert.equal(MEMORY_SCOPE_PROXIMITY.global, 5);
});

// MF0-02 — category and authority vocabularies match the Lite contract.
test('MF0-02 category and authority vocabularies match Lite', () => {
  assert.equal(MEMORY_CATEGORIES.length, 14);
  assert.ok(MEMORY_CATEGORIES.includes('security'));
  assert.deepEqual([...MEMORY_AUTHORITIES], [
    'user-explicit',
    'system-verified',
    'imported-verified',
    'agent-derived',
    'user-inferred',
    'unknown',
  ]);
  const ordered = [...MEMORY_AUTHORITIES].sort(compareMemoryAuthority);
  assert.deepEqual(ordered, [...MEMORY_AUTHORITIES]);
  assert.equal(MEMORY_AUTHORITY_RANK['user-explicit'], 0);
  assert.equal(MEMORY_AUTHORITY_RANK.unknown, 5);
});

// MF0-03 — weak authorities are exactly the non-promotable defaults.
test('MF0-03 weak authority set is fail-closed', () => {
  assert.ok(isWeakMemoryAuthority('agent-derived'));
  assert.ok(isWeakMemoryAuthority('user-inferred'));
  assert.ok(isWeakMemoryAuthority('unknown'));
  assert.ok(!isWeakMemoryAuthority('user-explicit'));
  assert.ok(!isWeakMemoryAuthority('system-verified'));
  assert.ok(!isWeakMemoryAuthority('imported-verified'));
});

// MF0-04 — non-retrievable statuses exclude deleted/archived/expired/rejected/superseded.
test('MF0-04 non-retrievable statuses are frozen', () => {
  assert.deepEqual([...MEMORY_NON_RETRIEVABLE_STATUSES], [
    'expired',
    'archived',
    'rejected',
    'superseded',
    'deleted',
  ]);
});

// MF0-05 — global scope accepts no owner.
test('MF0-05 global scope accepts no owner', () => {
  const owner: MemoryScopeOwner = { scope: 'global' };
  assert.equal(validateMemoryScopeOwner(owner).valid, true);
  assert.deepEqual(validateMemoryScopeOwner({ scope: 'global', workspaceId: 'ws' }), {
    valid: false,
    reason: 'OWNER_NOT_ALLOWED',
  });
});

// MF0-06 — workspace/agent/conversation/task scopes require exactly their owners.
test('MF0-06 narrower scopes require exact owners', () => {
  assert.equal(validateMemoryScopeOwner({ scope: 'workspace', workspaceId: 'ws' }).valid, true);
  assert.deepEqual(validateMemoryScopeOwner({ scope: 'workspace' }), {
    valid: false,
    reason: 'OWNER_MISSING',
  });
  assert.equal(validateMemoryScopeOwner({ scope: 'agent', workspaceId: 'ws', agentId: 'a' }).valid, true);
  assert.deepEqual(validateMemoryScopeOwner({ scope: 'agent', workspaceId: 'ws' }), {
    valid: false,
    reason: 'OWNER_MISSING',
  });
  assert.equal(
    validateMemoryScopeOwner({ scope: 'conversation', workspaceId: 'ws', conversationId: 'c' }).valid,
    true,
  );
  assert.equal(validateMemoryScopeOwner({ scope: 'task', workspaceId: 'ws', taskId: 't' }).valid, true);
});

// MF0-07 — a Run entry must identify Workspace, Task, and Run.
test('MF0-07 run scope requires workspace, task, and run', () => {
  assert.equal(
    validateMemoryScopeOwner({ scope: 'run', workspaceId: 'ws', taskId: 't', runId: 'r' }).valid,
    true,
  );
  assert.deepEqual(validateMemoryScopeOwner({ scope: 'run', workspaceId: 'ws', runId: 'r' }), {
    valid: false,
    reason: 'OWNER_MISSING',
  });
  assert.deepEqual(
    validateMemoryScopeOwner({ scope: 'run', workspaceId: 'ws', taskId: 't', runId: 'r', agentId: 'a' }),
    { valid: false, reason: 'OWNER_NOT_ALLOWED' },
  );
});

// MF0-08 — unknown/malformed scope fails closed.
test('MF0-08 unknown scope and non-object fail closed', () => {
  assert.deepEqual(validateMemoryScopeOwner({ scope: 'galaxy', workspaceId: 'ws' }), {
    valid: false,
    reason: 'SCOPE_UNKNOWN',
  });
  assert.deepEqual(validateMemoryScopeOwner(null), { valid: false, reason: 'SCOPE_UNKNOWN' });
  assert.deepEqual(validateMemoryScopeOwner('global'), { valid: false, reason: 'SCOPE_UNKNOWN' });
});

// MF0-09 — whitespace-only owner IDs do not count as present.
test('MF0-09 blank owner IDs are missing', () => {
  assert.deepEqual(validateMemoryScopeOwner({ scope: 'workspace', workspaceId: '   ' }), {
    valid: false,
    reason: 'OWNER_MISSING',
  });
});

// MF0-10 — assert form throws the stable data-free error.
test('MF0-10 assert form throws stable data-free error', () => {
  assert.throws(
    () => assertMemoryScopeOwner({ scope: 'run', workspaceId: 'ws' }),
    (error: unknown) => {
      assert.ok(error instanceof MemoryScopeOwnerError_);
      assert.equal(error.code, 'OWNER_MISSING');
      assert.equal(error.message, 'MEMORY_SCOPE_OWNER_OWNER_MISSING');
      return true;
    },
  );
});

// MF0-11 — automatic entries require a stable source; user-explicit does not.
test('MF0-11 source requirement is authority-dependent', () => {
  assert.equal(requiresMemorySource('user-explicit'), false);
  for (const authority of MEMORY_AUTHORITIES.filter(value => value !== 'user-explicit')) {
    assert.equal(requiresMemorySource(authority), true, authority);
  }
});

// MF0-12 — secret content always rejects.
test('MF0-12 promotion gate rejects secret content', () => {
  const base = makeGateInput();
  assert.equal(decideMemoryPromotion({ ...base, containsSecret: true }), 'reject');
});

// MF0-13 — missing stable source rejects automatic entries.
test('MF0-13 promotion gate rejects automatic entry without source', () => {
  assert.equal(decideMemoryPromotion(makeGateInput({ authority: 'agent-derived', sourceCount: 0 })), 'reject');
  assert.equal(decideMemoryPromotion(makeGateInput({ authority: 'user-explicit', sourceCount: 0 })), 'auto-accept');
});

// MF0-14 — global scope, security category, weak authority, inferred preference,
// scope promotion, and unresolved conflict all require review.
test('MF0-14 review-required triggers are fail-closed', () => {
  const base = makeGateInput();
  assert.equal(decideMemoryPromotion({ ...base, scope: 'global' }), 'review-required');
  assert.equal(decideMemoryPromotion({ ...base, category: 'security' }), 'review-required');
  assert.equal(decideMemoryPromotion({ ...base, authority: 'user-inferred' }), 'review-required');
  assert.equal(decideMemoryPromotion({ ...base, inferredPreference: true }), 'review-required');
  assert.equal(decideMemoryPromotion({ ...base, scopePromotion: true }), 'review-required');
  assert.equal(decideMemoryPromotion({ ...base, hasUnresolvedConflict: true }), 'review-required');
});

// MF0-15 — duplicate handling, confidence, and bounded size gate acceptance.
test('MF0-15 promotion gate enforces duplicate, confidence, and size', () => {
  const base = makeGateInput();
  assert.equal(decideMemoryPromotion({ ...base, duplicateResolved: false }), 'review-required');
  assert.equal(decideMemoryPromotion({ ...base, confidence: 0.2 }), 'review-required');
  assert.equal(decideMemoryPromotion({ ...base, confidence: Number.NaN }), 'review-required');
  assert.equal(decideMemoryPromotion({ ...base, tokenEstimate: 5000 }), 'review-required');
});

// MF0-16 — a fully-qualified candidate auto-accepts.
test('MF0-16 qualified candidate auto-accepts', () => {
  assert.equal(decideMemoryPromotion(makeGateInput()), 'auto-accept');
});

// MF0-17 — budget policy validation is fail-closed on every field.
test('MF0-17 budget policy validation fails closed', () => {
  assert.equal(validateMemoryBudgetPolicy(makeBudgetPolicy()).valid, true);
  assert.deepEqual(validateMemoryBudgetPolicy(null), { valid: false, reason: 'NOT_OBJECT' });
  assert.deepEqual(validateMemoryBudgetPolicy({ ...makeBudgetPolicy(), maxTokens: 0 }), {
    valid: false,
    reason: 'MAX_TOKENS_INVALID',
  });
  assert.deepEqual(validateMemoryBudgetPolicy({ ...makeBudgetPolicy(), maxEntries: -1 }), {
    valid: false,
    reason: 'MAX_ENTRIES_INVALID',
  });
  assert.deepEqual(
    validateMemoryBudgetPolicy({ ...makeBudgetPolicy(), perScopeLimits: { run: -1 } }),
    { valid: false, reason: 'LIMIT_INVALID' },
  );
  assert.deepEqual(validateMemoryBudgetPolicy({ ...makeBudgetPolicy(), minConfidence: 2 }), {
    valid: false,
    reason: 'THRESHOLD_INVALID',
  });
  assert.deepEqual(validateMemoryBudgetPolicy({ ...makeBudgetPolicy(), maxTruncation: -1 }), {
    valid: false,
    reason: 'MAX_TRUNCATION_INVALID',
  });
  assert.deepEqual(validateMemoryBudgetPolicy({ ...makeBudgetPolicy(), requireDiversity: 'yes' }), {
    valid: false,
    reason: 'DIVERSITY_INVALID',
  });
});

// MF0-18 — deduplication order is frozen and embedding similarity is last.
test('MF0-18 deduplication order is frozen', () => {
  assert.equal(MEMORY_DEDUPLICATION_ORDER[0], 'exact-content-hash');
  assert.equal(MEMORY_DEDUPLICATION_ORDER[1], 'normalized-text-hash');
  assert.equal(MEMORY_DEDUPLICATION_ORDER.at(-1), 'optional-embedding-similarity');
});

// MF0-19 — snapshot immutability and event payload rules are frozen.
test('MF0-19 snapshot immutability and event payload rules are frozen', () => {
  assert.equal(MEMORY_CONTEXT_SNAPSHOT_IMMUTABILITY.mutable, false);
  assert.equal(MEMORY_CONTEXT_SNAPSHOT_IMMUTABILITY.rewrittenByLaterEntryEdits, false);
  assert.equal(MEMORY_CONTEXT_SNAPSHOT_IMMUTABILITY.persistenceFailureBlocksInjection, true);
  assert.equal(MEMORY_EVENT_PAYLOAD_RULE.carriesFullMemoryContent, false);
  assert.equal(MEMORY_EVENT_PAYLOAD_RULE.carriesSecretValues, false);
});

// MF0-20 — the event family covers the Lite §15 list.
test('MF0-20 event family covers Lite memory events', () => {
  assert.equal(MEMORY_EVENT_TYPES.length, 14);
  assert.ok(MEMORY_EVENT_TYPES.includes('memory.context_created'));
  assert.ok(MEMORY_EVENT_TYPES.includes('memory.entry_conflicted'));
  assert.ok(MEMORY_EVENT_TYPES.includes('memory.retrieval_failed'));
  assert.ok(MEMORY_EVENT_TYPES.includes('memory.injected'));
});

function makeGateInput(overrides: Partial<MemoryPromotionGateInput> = {}): MemoryPromotionGateInput {
  return {
    scope: 'task',
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.9,
    sourceCount: 1,
    hasUnresolvedConflict: false,
    scopePromotion: false,
    inferredPreference: false,
    containsSecret: false,
    tokenEstimate: 100,
    maxTokenEstimate: 1000,
    duplicateResolved: true,
    minConfidence: 0.7,
    ...overrides,
  };
}

function makeBudgetPolicy(overrides: Partial<MemoryBudgetPolicyV1> = {}): MemoryBudgetPolicyV1 {
  return {
    maxTokens: 6000,
    maxEntries: 10,
    perScopeLimits: { run: 5 },
    perCategoryLimits: { decision: 3 },
    minConfidence: 0.5,
    minImportance: 0.3,
    maxTruncation: 2,
    requireDiversity: true,
    ...overrides,
  };
}
