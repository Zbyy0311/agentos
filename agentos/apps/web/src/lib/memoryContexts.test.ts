import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryContextsPath, parseMemoryContextsResponse } from './memoryContexts.js';

const CONTEXT = {
  id: 'context-1', kind: 'run', ownerId: 'run-1', runId: 'run-1', stageId: null,
  conversationId: 'conversation-1', createdAt: '2026-10-01T09:00:00.000Z', queryHash: 'hash-1',
  retrievalStrategyVersion: 'memory-v3', contextText: 'Frozen context', payloadAvailable: true,
  totalTokens: 12, truncated: false, retrievalDegraded: false,
  selected: [{ memoryId: 'entry-1', memoryVersion: 4, rank: 1, reasons: ['scope-match', 'fts-match'], tokenCost: 12, store: 'canonical' }],
  exclusions: [{ memoryId: 'entry-2', reason: 'token-budget' }],
};

test('memory context path encodes workspace and optional kind and owner filters', () => {
  assert.equal(memoryContextsPath('workspace 1'), '/api/workspaces/workspace%201/memory/contexts');
  assert.equal(
    memoryContextsPath('workspace 1', { kind: 'legacy-execution', ownerId: 'execution/1' }),
    '/api/workspaces/workspace%201/memory/contexts?kind=legacy-execution&ownerId=execution%2F1',
  );
  assert.equal(memoryContextsPath('w', { ownerId: '  ' }), '/api/workspaces/w/memory/contexts');
});

test('memory context parser preserves frozen payload, selected versions, reasons, stores and exclusions', () => {
  const [context] = parseMemoryContextsResponse({ contexts: [CONTEXT] });
  assert.equal(context.id, 'context-1');
  assert.equal(context.contextText, 'Frozen context');
  assert.equal(context.payloadAvailable, true);
  assert.deepEqual(context.selected, [{
    memoryId: 'entry-1', memoryVersion: 4, rank: 1, reasons: ['scope-match', 'fts-match'], tokenCost: 12, store: 'canonical',
  }]);
  assert.deepEqual(context.exclusions, [{ memoryId: 'entry-2', reason: 'token-budget' }]);
});

test('metadata-only historical contexts retain missing explanations and unknown degraded state', () => {
  const [context] = parseMemoryContextsResponse({ contexts: [{
    id: 'turn-snapshot', kind: 'turn', ownerId: null, conversationId: 'conversation-1', turnId: null,
    createdAt: '2026-10-01T09:00:00.000Z', queryHash: null, retrievalStrategyVersion: 'cr-v1',
    contextText: null, payloadAvailable: false, totalTokens: 3, truncated: false,
  }] });
  assert.equal(context.queryHash, null);
  assert.equal(context.payloadAvailable, false);
  assert.equal(context.contextText, null);
  assert.equal(context.retrievalDegraded, undefined);
  assert.equal(context.selected, null);
  assert.equal(context.exclusions, null);
});

test('legacy exclusion reason arrays map to a readable reason and nullable memory versions stay nullable', () => {
  const [context] = parseMemoryContextsResponse({ contexts: [{
    ...CONTEXT, kind: 'legacy-execution', executionId: 'exec-1',
    selected: [{ memoryId: 'legacy-1', memoryVersion: null, rank: 1, reasons: ['legacy-match'], tokenCost: 5, store: 'legacy' }],
    exclusions: [{ memoryId: 'legacy-2', reasons: ['budget', 'diversity-limit'] }],
  }] });
  assert.equal(context.selected?.[0].memoryVersion, null);
  assert.equal(context.exclusions?.[0].reason, 'budget, diversity-limit');
});

test('memory context parser rejects malformed response envelopes and unsupported kinds', () => {
  assert.throws(() => parseMemoryContextsResponse({ contexts: {} }), /contexts must be an array/);
  assert.throws(() => parseMemoryContextsResponse({ contexts: [{ ...CONTEXT, kind: 'unknown' }] }), /kind is unsupported/);
  assert.throws(() => parseMemoryContextsResponse({ contexts: [{ ...CONTEXT, selected: [{ rank: 1 }] }] }), /memoryId is missing/);
});
