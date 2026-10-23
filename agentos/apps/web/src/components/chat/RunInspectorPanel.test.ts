import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildRunInspectorUrl,
  nextRuntimeTimelineBackfillRequest,
  queueRuntimeTimelineSequence,
  replaceInspectorProjection,
} from './RunInspectorPanel.js';
import type { InspectorProjectionDto } from './RuntimeInspectorView.js';

test('LITE-13-101 Run Inspector uses the forward runtime route', () => {
  assert.equal(
    buildRunInspectorUrl('http://127.0.0.1:38471', 'browser fixture', 'run/one'),
    'http://127.0.0.1:38471/api/workspaces/browser%20fixture/runtime/runs/run%2Fone/inspector',
  );
});

test('LITE-13-005 Inspector refresh replaces the bounded projection instead of appending client state', () => {
  const previous = {
    events: Array.from({ length: 100 }, (_, index) => ({ eventId: `old-${index}` })),
  } as unknown as InspectorProjectionDto;
  const next = {
    events: [{ eventId: 'new-1' }, { eventId: 'new-2' }],
  } as unknown as InspectorProjectionDto;

  const refreshed = replaceInspectorProjection(previous, next);

  assert.strictEqual(refreshed, next);
  assert.deepEqual(refreshed.events, next.events);
  assert.equal(refreshed.events.some(event => event.eventId === 'old-0'), false);
});

test('Run Inspector deduplicates SSE sequences and backfills every missing sequence from the durable cursor', () => {
  let queuedThrough = 10;
  queuedThrough = queueRuntimeTimelineSequence(10, queuedThrough, 12) ?? queuedThrough;
  assert.equal(queueRuntimeTimelineSequence(10, queuedThrough, 12), null);
  assert.equal(queueRuntimeTimelineSequence(10, queuedThrough, 11), null);

  const firstPage = nextRuntimeTimelineBackfillRequest(10, queuedThrough);
  assert.deepEqual(firstPage, { afterSequence: 10, limit: 2 });
  const secondPage = nextRuntimeTimelineBackfillRequest(11, queuedThrough);
  assert.deepEqual(secondPage, { afterSequence: 11, limit: 1 });
  assert.equal(nextRuntimeTimelineBackfillRequest(12, queuedThrough), null);
});
