import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  HISTORY_KINDS,
  HISTORY_LIMIT_MAX,
  HistorySearchError,
  groupHistoryByKind,
  historyQueryString,
  historyReferenceTarget,
  isLabelSearchable,
  validateHistorySearch,
  type HistoryEntry,
} from './historySearch.js';

const ENTRY: HistoryEntry = {
  kind: 'task', id: 'task_1', at: '2026-09-10T00:00:00.000Z', status: 'open', label: 'Ship release',
  conversationId: 'conv_1', taskId: 'task_1', runId: null, messageId: null, turnId: null,
  providerSessionId: null, referenceId: 'task_1',
};

test('HS-01 the query string encodes every filter and defaults the limit', () => {
  const query = historyQueryString({
    agentId: 'agent_a', kind: 'run', status: 'completed', conversationId: 'conv_1',
    taskId: 'task_1', runId: 'run_1', providerConfigId: 'provider_1',
    from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z', q: ' release ',
  });
  assert.ok(query.includes('kind=run'));
  assert.ok(query.includes('status=completed'));
  assert.ok(query.includes('conversationId=conv_1'));
  assert.ok(query.includes('taskId=task_1'));
  assert.ok(query.includes('runId=run_1'));
  assert.ok(query.includes('providerConfigId=provider_1'));
  assert.ok(query.includes('q=release'));
  assert.ok(query.includes('limit=50'));
});

test('HS-02 validation fails closed on a missing Agent, bad kind, bad limit, and reversed range', () => {
  assert.deepEqual(validateHistorySearch({ agentId: '  ' }), { valid: false, code: 'AGENT_REQUIRED' });
  assert.deepEqual(validateHistorySearch({ agentId: 'a', kind: 'bogus' as never }), { valid: false, code: 'KIND_INVALID' });
  assert.deepEqual(validateHistorySearch({ agentId: 'a', limit: 0 }), { valid: false, code: 'LIMIT_INVALID' });
  assert.deepEqual(validateHistorySearch({ agentId: 'a', limit: HISTORY_LIMIT_MAX + 1 }), { valid: false, code: 'LIMIT_INVALID' });
  assert.deepEqual(
    validateHistorySearch({ agentId: 'a', from: '2026-09-30T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' }),
    { valid: false, code: 'TIME_RANGE_INVALID' },
  );
  assert.throws(() => historyQueryString({ agentId: '' }), HistorySearchError);
  // every declared kind is accepted
  for (const kind of HISTORY_KINDS) {
    assert.equal(validateHistorySearch({ agentId: 'a', kind }).valid, true, kind);
  }
});

test('HS-03 results group by kind preserving newest-first order within a kind', () => {
  const entries: HistoryEntry[] = [
    { ...ENTRY, kind: 'conversation', id: 'conv_1', at: '2026-09-03T00:00:00Z' },
    { ...ENTRY, kind: 'task', id: 'task_2', at: '2026-09-02T00:00:00Z' },
    { ...ENTRY, kind: 'task', id: 'task_1', at: '2026-09-01T00:00:00Z' },
  ];
  const groups = groupHistoryByKind(entries);
  assert.deepEqual(groups.map(g => g.kind), ['conversation', 'task']);
  assert.deepEqual(groups[1]!.entries.map(e => e.id), ['task_2', 'task_1']);
});

test('HS-04 every entry links to its canonical source record', () => {
  assert.deepEqual(historyReferenceTarget({ ...ENTRY, kind: 'run', runId: 'run_1' }), { kind: 'run', id: 'run_1' });
  assert.deepEqual(historyReferenceTarget({ ...ENTRY, kind: 'message', conversationId: 'conv_9' }), { kind: 'conversation', id: 'conv_9' });
  assert.deepEqual(historyReferenceTarget({ ...ENTRY, kind: 'turn', conversationId: 'conv_9' }), { kind: 'conversation', id: 'conv_9' });
  assert.deepEqual(historyReferenceTarget({ ...ENTRY, kind: 'task', taskId: 'task_9' }), { kind: 'task', id: 'task_9' });
  assert.deepEqual(historyReferenceTarget({ ...ENTRY, kind: 'context-snapshot', runId: 'run_9' }), { kind: 'run', id: 'run_9' });
  assert.deepEqual(historyReferenceTarget({ ...ENTRY, kind: 'artifact', runId: 'run_9' }), { kind: 'run', id: 'run_9' });
  assert.deepEqual(historyReferenceTarget({ ...ENTRY, kind: 'memory' }), { kind: 'none', id: null });
});

test('HS-05 only labelled entries are searchable (no content search, secrets excluded)', () => {
  assert.equal(isLabelSearchable(ENTRY), true);
  assert.equal(isLabelSearchable({ ...ENTRY, label: '   ' }), false);
  assert.equal(isLabelSearchable({ ...ENTRY, label: null }), false);
});

// ---- view ------------------------------------------------------------------

async function renderView(overrides: Record<string, unknown> = {}): Promise<string> {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const { HistorySearchView } = await import('../components/chat/HistorySearchView.js');
  return renderToStaticMarkup(
    <HistorySearchView
      theme="dark"
      filters={{ agentId: 'agent_a' }}
      entries={[ENTRY, { ...ENTRY, kind: 'run', id: 'run_1', runId: 'run_1', status: 'completed', label: null }]}
      loading={false}
      onFiltersChange={() => {}}
      onOpenReference={() => {}}
      {...overrides}
    />,
  );
}

test('HS-V01 the view renders the filter set, grouped results, and canonical links', async () => {
  const markup = await renderView();
  assert.ok(markup.includes('data-agentos="history-search-view"'));
  for (const filter of ['agent', 'q', 'kind', 'status', 'conversationId', 'taskId', 'runId', 'providerConfigId', 'from', 'to']) {
    assert.ok(markup.includes(`data-filter="${filter}"`), filter);
  }
  assert.ok(markup.includes('data-history-group="task"'));
  assert.ok(markup.includes('data-history-group="run"'));
  assert.ok(markup.includes('Ship release'));
  assert.ok(markup.includes('data-history-reference="task"'));
  assert.ok(markup.includes('data-history-reference="run"'));
});

test('HS-V02 an empty result names the absence and a loading state is explicit', async () => {
  const empty = await renderView({ entries: [] });
  assert.ok(empty.includes('No history for this Agent'));
  const loading = await renderView({ entries: [], loading: true });
  assert.ok(loading.includes('Loading…'));
  assert.ok(!loading.includes('No history for this Agent'));
});

test('HS-V03 an error is an alert and the view consumes tokens', async () => {
  const markup = await renderView({ error: 'HISTORY_SEARCH_TIME_RANGE_INVALID' });
  assert.ok(markup.includes('role="alert"'));
  assert.ok(markup.includes('HISTORY_SEARCH_TIME_RANGE_INVALID'));
  assert.ok(markup.includes('--surface-base:'));
});

