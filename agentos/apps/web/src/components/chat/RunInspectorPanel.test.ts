import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRunInspectorUrl, replaceInspectorProjection } from './RunInspectorPanel.js';
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
