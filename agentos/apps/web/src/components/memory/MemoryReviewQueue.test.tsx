import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildReviewBody } from './MemoryReviewQueue.js';
import type { ForwardMemoryCandidateDto } from './MemoryReviewQueue.js';

const CANDIDATE: ForwardMemoryCandidateDto = {
  id: 'mc_1',
  scope: 'workspace',
  category: 'preference',
  authority: 'agent-derived',
  confidence: 0.6,
  importance: 0.5,
  title: 'Inferred preference',
  summary: 's',
  content: 'c',
  tags: [],
  outcome: 'review-required',
  decision: 'review-required',
  version: 3,
  createdAt: '2026-09-11T00:00:00.000Z',
  sources: [{ kind: 'run', id: 'run_1' }],
};

test('MRQ-01 review body is version-guarded and outcome-explicit', () => {
  assert.deepEqual(buildReviewBody(CANDIDATE, 'accept'), { expectedVersion: 3, outcome: 'accept' });
  assert.deepEqual(buildReviewBody(CANDIDATE, 'reject'), { expectedVersion: 3, outcome: 'reject' });
});

test('MRQ-02 merge carries a trimmed target and rejects are target-free', () => {
  assert.deepEqual(
    buildReviewBody(CANDIDATE, 'merge-with-existing', '  mem_target  '),
    { expectedVersion: 3, outcome: 'merge-with-existing', mergedIntoEntryId: 'mem_target' },
  );
  // a blank target never reaches the wire (the server would 400 it)
  assert.deepEqual(buildReviewBody(CANDIDATE, 'merge-with-existing', '   '), { expectedVersion: 3, outcome: 'merge-with-existing' });
  assert.deepEqual(buildReviewBody(CANDIDATE, 'accept', 'mem_target'), { expectedVersion: 3, outcome: 'accept' });
});

test('MRQ-03 initial render is the empty review queue, not an error', async () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { MemoryReviewQueue } = await import('./MemoryReviewQueue.js');
  const markup = renderToStaticMarkup(<MemoryReviewQueue workspaceId="workspace-a" onClose={() => {}} />);
  assert.ok(markup.includes('data-agentos="memory-review-queue"'));
  assert.ok(markup.includes('暂无待审查候选'));
  // edit-and-accept is deliberately absent: the contract records outcomes
  // without applying edits
  assert.ok(!markup.includes('编辑后接受'));
});
