import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { MemoryExplanationSnapshotDto } from './MemoryExplanationView.js';

const SNAPSHOT: MemoryExplanationSnapshotDto = {
  memoryContextId: 'mctx_abc',
  queryHash: 'qh-1',
  retrievalStrategyVersion: 'mf3-ranking-v1',
  totalTokens: 42,
  maxTokens: 6000,
  truncated: true,
  createdAt: '2026-09-11T00:00:00.000Z',
  selected: [
    {
      memoryId: 'mem_a', memoryVersion: 2, rank: 1, score: 51.25, scope: 'workspace',
      category: 'decision', authority: 'system-verified', confidence: 0.9, importance: 0.8,
      tokenCost: 30, reasons: ['scope-match', 'fts'], sourceRefs: [{ kind: 'run', id: 'run_9' }],
    },
    {
      memoryId: 'mem_b', memoryVersion: 1, rank: 2, score: 33.5, scope: 'task',
      category: 'knowledge', authority: 'user-explicit', confidence: 0.8, importance: 0.5,
      tokenCost: 12, reasons: ['pinned'], sourceRefs: [],
    },
  ],
  exclusions: [{ memoryId: 'mem_c', reason: 'below-confidence' }],
};

async function render(overrides: Partial<MemoryExplanationSnapshotDto> = {}): Promise<string> {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { MemoryExplanationView } = await import('./MemoryExplanationView.js');
  return renderToStaticMarkup(<MemoryExplanationView snapshot={{ ...SNAPSHOT, ...overrides }} />);
}

test('MEV-01 snapshot identity, strategy, query hash, budget, and truncation are visible', async () => {
  const markup = await render();
  assert.ok(markup.includes('mctx_abc'));
  assert.ok(markup.includes('mf3-ranking-v1'));
  assert.ok(markup.includes('qh-1'));
  assert.ok(markup.includes('42 / 6000'));
  assert.ok(markup.includes('truncated'));
  assert.ok(markup.includes('2026-09-11T00:00:00.000Z'));
});

test('MEV-02 each selected Entry shows rank, score, scope, authority, confidence, reasons, and source', async () => {
  const markup = await render();
  assert.ok(markup.includes('data-agentos="memory-explanation-selected"'));
  assert.ok(markup.indexOf('mem_a') < markup.indexOf('mem_b')); // rank order
  assert.ok(markup.includes('#1 mem_a'));
  assert.ok(markup.includes('v2'));
  assert.ok(markup.includes('51.25'));
  assert.ok(markup.includes('workspace'));
  assert.ok(markup.includes('system-verified'));
  assert.ok(markup.includes('conf 0.9'));
  assert.ok(markup.includes('scope-match, fts'));
  assert.ok(markup.includes('run:run_9'));
  assert.ok(markup.includes('pinned'));
});

test('MEV-03 exclusions are named with reasons, and an all-selected snapshot omits the block', async () => {
  const withExclusions = await render();
  assert.ok(withExclusions.includes('mem_c'));
  assert.ok(withExclusions.includes('below-confidence'));
  const without = await render({ exclusions: [] });
  assert.ok(!without.includes('data-agentos="memory-explanation-exclusions"'));
});
