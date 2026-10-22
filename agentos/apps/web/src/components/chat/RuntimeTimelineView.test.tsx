import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  groupRuntimeTimelineItems,
  isKeyRuntimeTimelineItem,
  mergeRuntimeTimelineItems,
  shouldRuntimeTimelineFollowTail,
  RuntimeTimelineView,
} from './RuntimeTimelineView.js';
import type { RuntimeTimelineItemDto, RuntimeTimelineProjectionDto } from '../../lib/runtimeInspectorClient.js';

function item(overrides: Partial<RuntimeTimelineItemDto> = {}): RuntimeTimelineItemDto {
  return {
    id: 'evt_1', runId: 'run_1', domain: 'run', kind: 'run', type: 'run.started', title: 'run started',
    firstSequence: 1, lastSequence: 1, sourceRefs: [], aggregated: false, eventCount: 1,
    ...overrides,
  };
}

const TIMELINE: RuntimeTimelineProjectionDto = {
  runId: 'run_1', mode: 'summary', group: 'none',
  items: [
    item({ stageId: 'stage_1', domain: 'stream', kind: 'stream', type: 'stream.text_delta', title: 'stream text delta', firstSequence: 1, lastSequence: 2, aggregated: true, eventCount: 2, summary: '2 × stream.text_delta' }),
    item({ id: 'evt_3', domain: 'run', type: 'run.failed', title: 'run failed', firstSequence: 3, lastSequence: 3, severity: 'error' }),
  ],
  groups: [], highWatermark: 3, nextAfterSequence: 3, hasMore: false, truncated: false, retentionWarning: false,
};

test('Timeline grouping keeps sequence order and creates Stage, Correlation, and Domain buckets', () => {
  const items = [
    item({ stageId: 'stage_1', correlationId: 'corr_a', domain: 'run' }),
    item({ id: 'evt_2', stageId: 'stage_2', correlationId: 'corr_b', domain: 'approval' }),
    item({ id: 'evt_3', stageId: 'stage_1', correlationId: 'corr_a', domain: 'run' }),
  ];
  assert.deepEqual(groupRuntimeTimelineItems(items, 'stage').map(group => group.key), ['stage_1', 'stage_2']);
  assert.deepEqual(groupRuntimeTimelineItems(items, 'correlation').map(group => group.key), ['corr_a', 'corr_b']);
  assert.deepEqual(groupRuntimeTimelineItems(items, 'domain').map(group => group.key), ['run', 'approval']);
});

test('Summary merges adjacent high-frequency items across pages and preserves terminal facts', () => {
  const first = item({
    id: 'evt_1', domain: 'stream', kind: 'stream', type: 'stream.text_delta', title: 'stream text delta',
    firstSequence: 1, lastSequence: 2, aggregated: true, eventCount: 2,
  });
  const next = item({
    id: 'evt_3', domain: 'stream', kind: 'stream', type: 'stream.text_delta', title: 'stream text delta',
    firstSequence: 3, lastSequence: 3,
  });
  const failed = item({ id: 'evt_4', type: 'run.failed', title: 'run failed', firstSequence: 4, lastSequence: 4, severity: 'error' });
  const merged = mergeRuntimeTimelineItems([first], [next, failed], 'summary');
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.eventCount, 3);
  assert.equal(merged[0]!.lastSequence, 3);
  assert.equal(merged[1]!.type, 'run.failed');
  assert.equal(merged[1]!.aggregated, false);
});

test('Timeline highlights approvals, failures, and run terminal events', () => {
  assert.equal(isKeyRuntimeTimelineItem(item({ kind: 'approval', type: 'approval.required' })), true);
  assert.equal(isKeyRuntimeTimelineItem(item({ type: 'run.failed' })), true);
  assert.equal(isKeyRuntimeTimelineItem(item({ severity: 'error' })), true);
  assert.equal(isKeyRuntimeTimelineItem(item({ type: 'stream.text_delta', severity: 'info' })), false);
});

test('Client aggregation keeps the first row key stable and never folds error deltas or heartbeat events', () => {
  const delta = (sequence: number, severity = 'info') => item({
    id: `evt_${sequence}`, domain: 'stream', kind: 'stream', type: 'stream.text_delta',
    firstSequence: sequence, lastSequence: sequence, severity,
  });
  const folded = mergeRuntimeTimelineItems([delta(1)], [delta(2), delta(3, 'error'), delta(4, 'error')], 'summary');
  assert.equal(folded[0]!.id, 'evt_1');
  assert.deepEqual(folded.map(item => item.eventCount), [2, 1, 1]);
  const heartbeats = [item({ type: 'run.heartbeat' }), item({ id: 'evt_2', type: 'run.heartbeat', firstSequence: 2, lastSequence: 2 })];
  assert.equal(mergeRuntimeTimelineItems([], heartbeats, 'summary').length, 2);
});

test('Live Tail only follows new sequences when the user was already at the bottom', () => {
  assert.equal(shouldRuntimeTimelineFollowTail(null, 10, false), true);
  assert.equal(shouldRuntimeTimelineFollowTail(10, 11, true), true);
  assert.equal(shouldRuntimeTimelineFollowTail(10, 11, false), false);
  assert.equal(shouldRuntimeTimelineFollowTail(11, 10, false), false);
});

test('Timeline controls render all modes and mark key items for emphasis', () => {
  (globalThis as typeof globalThis & { React: typeof React }).React = React;
  const markup = renderToStaticMarkup(<RuntimeTimelineView
    timeline={TIMELINE}
    mode="summary"
    group="none"
    filters={{ type: '', domain: '', severity: '', stageId: '' }}
    stages={[]}
    connectionState="live"
    loading={false}
    loadingMore={false}
    onModeChange={() => undefined}
    onGroupChange={() => undefined}
    onFilterChange={() => undefined}
    onLoadMore={() => undefined}
  />);
  assert.match(markup, /aria-label="Timeline mode"/u);
  assert.match(markup, /<option value="summary"[^>]*>Summary<\/option>/u);
  assert.match(markup, /<option value="detailed"[^>]*>Detailed<\/option>/u);
  assert.match(markup, /<option value="raw"[^>]*>Raw \(advanced\)<\/option>/u);
  assert.match(markup, /data-key-event="true"/u);
  assert.match(markup, /data-live-tail="following"/u);
});
