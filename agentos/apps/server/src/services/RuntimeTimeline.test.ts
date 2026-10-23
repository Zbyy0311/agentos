import assert from 'node:assert/strict';
import test from 'node:test';
import { projectTimelineItems, type TimelineEventInput } from './RuntimeTimeline.js';

function event(sequence: number, type: string, fields: Partial<TimelineEventInput> = {}): TimelineEventInput {
  return {
    eventId: `event_${sequence}`, runId: 'run_a', sequence, type,
    timestamp: `2026-10-22T00:00:0${sequence}.000Z`, severity: 'info', correlationId: 'corr_a',
    ...fields,
  };
}

test('Summary omits detailed domains but retains every terminal, approval, denial, merge and recovery fact', () => {
  const types = [
    'provider.started', 'process.started', 'worktree.created', 'memory.selected', 'policy.allowed', 'usage.sample',
    'run.completed', 'stage.failed', 'approval.required', 'policy.denied', 'process.failed',
    'worktree.merge.completed', 'artifact.finalized', 'recovery.completed', 'stream.text_delta',
  ];
  const events = types.map((type, index) => event(index + 1, type, type === 'process.failed' ? { severity: 'error' } : {}));
  const summary = projectTimelineItems({ mode: 'summary', events });
  assert.deepEqual(summary.map(item => item.type), types.slice(6));
  assert.ok(summary.every(item => !item.aggregated));
  assert.equal(projectTimelineItems({ mode: 'detailed', events }).length, types.length);
  assert.equal(projectTimelineItems({ mode: 'raw', events }).length, types.length);
});

test('Summary never folds error text deltas or across stage, correlation, severity and visibility boundaries', () => {
  const events = [
    event(1, 'stream.text_delta'), event(2, 'stream.text_delta'),
    event(3, 'stream.text_delta', { severity: 'error' }), event(4, 'stream.text_delta', { severity: 'error' }),
    event(5, 'stream.text_delta', { stageId: 'stage_a' }),
    event(6, 'stream.text_delta', { correlationId: 'corr_b' }),
    event(7, 'stream.text_delta', { visibility: 'internal' }),
    event(9, 'stream.text_delta'),
  ];
  const items = projectTimelineItems({ mode: 'summary', events });
  assert.deepEqual(items.map(item => item.eventCount), [2, 1, 1, 1, 1, 1, 1]);
  assert.equal(items[0]!.id, 'event_1');
  assert.equal(items[0]!.expandable, true);
});

test('Filters cannot fold across a hidden event, and Raw payload previews stay bounded and redacted', () => {
  const events = [event(1, 'stream.text_delta'), event(2, 'approval.required'), event(3, 'stream.text_delta')];
  const items = projectTimelineItems({ mode: 'summary', events, filter: { types: new Set(['stream.text_delta']) } });
  assert.deepEqual(items.map(item => item.eventCount), [1, 1]);
  const raw = projectTimelineItems({ mode: 'raw', events: [event(1, 'run.started', {
    payload: { api_key: 'private-value', nested: { password: 'hidden' }, text: 'a'.repeat(400) },
  })] })[0]!;
  assert.equal(raw.expandable, true);
  assert.ok(raw.payloadSummary!.preview.length <= 241);
  assert.doesNotMatch(raw.payloadSummary!.preview, /private-value|hidden/u);
});
