import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MemoryContextRecord } from '@/lib/memoryContexts';

const BASE_CONTEXT: MemoryContextRecord = {
  id: 'context-1', kind: 'run', ownerId: 'run-1', runId: 'run-1', createdAt: '2026-10-01T09:00:00.000Z',
  queryHash: 'query-hash', retrievalStrategyVersion: 'memory-v3', contextText: 'Frozen prompt from that run',
  payloadAvailable: true, totalTokens: 20, truncated: false, retrievalDegraded: false,
  selected: [{ memoryId: 'entry-1', memoryVersion: 7, rank: 1, reasons: ['scope-match', 'fts-match'], tokenCost: 20, store: 'canonical' }],
  exclusions: [{ memoryId: 'entry-2', reason: 'token-budget' }],
};

async function render(context: MemoryContextRecord, workspaceId?: string): Promise<string> {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { MemoryContextDetails } = await import('./MemoryContextHistory.js');
  return renderToStaticMarkup(<MemoryContextDetails context={context} workspaceId={workspaceId} />);
}

test('history details label a missing historical payload and unpersisted explanations without inventing text', async () => {
  const markup = await render({
    ...BASE_CONTEXT,
    contextText: null,
    payloadAvailable: false,
    selected: null,
    exclusions: null,
    retrievalDegraded: undefined,
  });
  assert.ok(markup.includes('此历史记录未保存可回放的冻结上下文正文。'));
  assert.ok(markup.includes('此历史记录没有保存选取明细。'));
  assert.ok(markup.includes('此历史记录没有保存排除项明细。'));
  assert.ok(!markup.includes('Frozen prompt from that run'));
  assert.ok(!markup.includes('data-field="retrieval-degraded"'));
});

test('history details show the actual frozen payload, selected version/reasons, exclusions and degraded warning', async () => {
  const markup = await render({ ...BASE_CONTEXT, retrievalDegraded: true });
  assert.ok(markup.includes('Frozen prompt from that run'));
  assert.ok(markup.includes('data-field="retrieval-degraded"'));
  assert.ok(markup.includes('v7'));
  assert.ok(markup.includes('scope-match、fts-match'));
  assert.ok(markup.includes('entry-2 — token-budget'));
});

test('history details expose version feedback against each frozen selected memory', async () => {
  const markup = await render(BASE_CONTEXT, 'workspace-1');
  assert.ok(markup.includes('data-agentos="memory-version-feedback"'));
  assert.ok(markup.includes('对冻结版本 v7'));
  assert.ok(markup.includes('有帮助'));
  assert.ok(markup.includes('有错误'));
  assert.ok(markup.includes('已过时'));
});

test('history details keep unknown legacy selection versions visibly unknown', async () => {
  const markup = await render({
    ...BASE_CONTEXT,
    kind: 'legacy-execution',
    selected: [{ memoryId: 'legacy-entry', memoryVersion: null, rank: 1, reasons: ['legacy-match'], tokenCost: 5, store: 'legacy' }],
  });
  assert.ok(markup.includes('版本未记录'));
  assert.ok(markup.includes('legacy-match'));
  assert.ok(markup.includes('legacy'));
});
