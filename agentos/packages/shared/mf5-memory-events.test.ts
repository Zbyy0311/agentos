import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MF5_MEMORY_EVENT_DEFINITIONS,
  isMemoryCandidateEventPayload,
  isMemoryCandidateReviewEventPayload,
  isMemoryConflictEventPayload,
  isMemoryContextEventPayload,
  isMemoryEntryEventPayload,
  isMemoryRetrievalEventPayload,
  MEMORY_EVENT_TYPES,
  RUNTIME_EVENT_DOMAINS,
  createM3RuntimeEventRegistry,
} from './src/index.ts';

const ENTRY_PAYLOAD = {
  memoryEntryId: 'mem_1',
  version: 1,
  scope: 'task',
  category: 'decision',
  authority: 'system-verified',
};
const CANDIDATE_PAYLOAD = {
  candidateId: 'mcand_1',
  scope: 'task',
  category: 'decision',
  authority: 'system-verified',
  decision: 'auto-accept',
};
const CONFLICT_PAYLOAD = {
  conflictId: 'conf_1',
  conflictType: 'contradiction',
  entryAId: 'mem_1',
  entryBId: 'mem_2',
};
const RETRIEVAL_PAYLOAD = {
  queryHash: 'a'.repeat(64),
  strategyVersion: 'mf3-ranking-v1',
  candidateCount: 3,
  selectedCount: 2,
  totalTokens: 42,
  degraded: false,
};
const CONTEXT_PAYLOAD = {
  memoryContextId: 'mctx_1',
  runId: 'run_1',
  selectedCount: 2,
  totalTokens: 42,
  truncated: false,
};

// MF5-01 — memory is a canonical Runtime Event domain.
test('MF5-01 memory is a canonical Runtime Event domain', () => {
  assert.ok((RUNTIME_EVENT_DOMAINS as readonly string[]).includes('memory'));
});

// MF5-02 — the family covers every Lite memory event.
test('MF5-02 definitions cover the Lite memory event family', () => {
  const types = MF5_MEMORY_EVENT_DEFINITIONS.map(d => d.type);
  assert.deepEqual(types, [...MEMORY_EVENT_TYPES]);
  assert.equal(types.length, 14);
});

// MF5-03 — every definition is a memory-domain, memory-engine, durable event.
test('MF5-03 definitions use memory domain and engine source', () => {
  for (const definition of MF5_MEMORY_EVENT_DEFINITIONS) {
    assert.equal(definition.domain, 'memory', definition.type);
    assert.equal(definition.source, 'memory-engine', definition.type);
    assert.equal(definition.defaultDurability, 'durable', definition.type);
    assert.equal(definition.schemaVersion, 1, definition.type);
    assert.equal(definition.forbidsStageId, true, definition.type);
  }
});

// MF5-04 — the registry registers all memory events.
test('MF5-04 registry registers all memory events', () => {
  const registry = createM3RuntimeEventRegistry();
  for (const definition of MF5_MEMORY_EVENT_DEFINITIONS) {
    const registered = registry.get(definition.type);
    assert.ok(registered !== undefined, definition.type);
    assert.equal(registered?.domain, 'memory');
  }
});

// MF5-05 — payload guards accept well-formed payloads.
test('MF5-05 guards accept well-formed payloads', () => {
  assert.ok(isMemoryEntryEventPayload(ENTRY_PAYLOAD));
  assert.ok(isMemoryCandidateEventPayload(CANDIDATE_PAYLOAD));
  assert.ok(isMemoryConflictEventPayload(CONFLICT_PAYLOAD));
  assert.ok(isMemoryRetrievalEventPayload(RETRIEVAL_PAYLOAD));
  assert.ok(isMemoryContextEventPayload(CONTEXT_PAYLOAD));
});

// MF5-06 — payload guards reject extra fields and bad values.
test('MF5-06 guards reject extra fields and bad values', () => {
  assert.ok(!isMemoryEntryEventPayload({ ...ENTRY_PAYLOAD, content: 'secret' }));
  assert.ok(!isMemoryEntryEventPayload({ ...ENTRY_PAYLOAD, version: 0 }));
  assert.ok(!isMemoryEntryEventPayload({ ...ENTRY_PAYLOAD, memoryEntryId: '' }));
  assert.ok(!isMemoryCandidateEventPayload({ ...CANDIDATE_PAYLOAD, decision: 'maybe' }));
  assert.ok(!isMemoryRetrievalEventPayload({ ...RETRIEVAL_PAYLOAD, degraded: 'no' }));
  assert.ok(!isMemoryRetrievalEventPayload({ ...RETRIEVAL_PAYLOAD, totalTokens: -1 }));
  assert.ok(!isMemoryContextEventPayload({ ...CONTEXT_PAYLOAD, runId: '' }));
  assert.ok(!isMemoryConflictEventPayload({ ...CONFLICT_PAYLOAD, conflictType: '' }));
});

// MF5-07 — payloads never carry full Memory content.
test('MF5-07 payloads carry references only', () => {
  const forbidden = ['content', 'secret', 'token', 'password', 'credential'];
  for (const definition of MF5_MEMORY_EVENT_DEFINITIONS) {
    for (const field of forbidden) {
      assert.ok(!definition.payloadSchema.required.includes(field), `${definition.type}.${field}`);
      assert.ok(!definition.payloadSchema.optional.includes(field), `${definition.type}.${field}`);
    }
  }
});

// MF5-08 — registry validates a representative draft for each family member.
test('MF5-08 registry accepts representative payloads', () => {
  const registry = createM3RuntimeEventRegistry();
  const payloads: Record<string, unknown> = {
    'memory.entry_created': ENTRY_PAYLOAD,
    'memory.entry_updated': ENTRY_PAYLOAD,
    'memory.entry_conflicted': ENTRY_PAYLOAD,
    'memory.entry_deduplicated': ENTRY_PAYLOAD,
    'memory.entry_superseded': ENTRY_PAYLOAD,
    'memory.entry_expired': ENTRY_PAYLOAD,
    'memory.entry_archived': ENTRY_PAYLOAD,
    'memory.candidate_created': CANDIDATE_PAYLOAD,
    'memory.candidate_reviewed': { candidateId: 'candidate', candidateVersion: 2, outcome: 'reject', memoryEntryId: null },
    'memory.retrieval_completed': RETRIEVAL_PAYLOAD,
    'memory.retrieval_failed': RETRIEVAL_PAYLOAD,
    'memory.revalidation_completed': RETRIEVAL_PAYLOAD,
    'memory.context_created': CONTEXT_PAYLOAD,
    'memory.injected': CONTEXT_PAYLOAD,
  };
  for (const definition of MF5_MEMORY_EVENT_DEFINITIONS) {
    const payload = payloads[definition.type];
    assert.ok(payload !== undefined, definition.type);
    assert.ok(definition.validatePayload(payload), definition.type);
  }
});

test('candidate review payload distinguishes Candidate and Entry outcomes', () => {
  const rejected = { candidateId: 'candidate', candidateVersion: 2, outcome: 'reject', memoryEntryId: null };
  assert.ok(isMemoryCandidateReviewEventPayload(rejected));
  assert.ok(!isMemoryCandidateReviewEventPayload({ ...rejected, memoryEntryId: 'invented' }));
  assert.ok(!isMemoryCandidateReviewEventPayload({ ...rejected, outcome: 'accept' }));
  assert.ok(isMemoryCandidateReviewEventPayload({ ...rejected, outcome: 'accept', memoryEntryId: 'entry' }));
  assert.ok(!isMemoryCandidateReviewEventPayload({ ...rejected, content: 'not allowed' }));
});
