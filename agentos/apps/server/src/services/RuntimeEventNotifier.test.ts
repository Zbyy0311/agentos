import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeEventNotifier } from './RuntimeEventNotifier.js';

test('P5B-R04 RuntimeEventNotifier supports isolated Run subscribers', () => {
  const notifier = new RuntimeEventNotifier();
  const first: number[] = [];
  const second: number[] = [];
  const other: number[] = [];
  const unsubscribeFirst = notifier.subscribe('run_p5b', hint => first.push(hint.sequence));
  notifier.subscribe('run_p5b', hint => second.push(hint.sequence));
  notifier.subscribe('run_other', hint => other.push(hint.sequence));
  const hint = { runId: 'run_p5b', sequence: 1, eventId: 'evt_p5b' };
  notifier.publish(hint);
  notifier.publish(hint);
  unsubscribeFirst();
  unsubscribeFirst();
  notifier.publish({ runId: 'run_p5b', sequence: 2, eventId: 'evt_p5b_2' });
  assert.deepEqual(first, [1, 1]);
  assert.deepEqual(second, [1, 1, 2]);
  assert.deepEqual(other, []);
});

test('P5B-G10 one subscriber exception does not affect later subscribers', () => {
  const notifier = new RuntimeEventNotifier();
  const received: string[] = [];
  notifier.subscribe('run_p5b', () => { throw new Error('subscriber failure'); });
  notifier.subscribe('run_p5b', hint => received.push(hint.eventId));
  assert.doesNotThrow(() => notifier.publish({ runId: 'run_p5b', sequence: 3, eventId: 'evt_3' }));
  assert.deepEqual(received, ['evt_3']);
});

test('P5B notifier has no retained history and a new instance loses subscriptions', () => {
  const first = new RuntimeEventNotifier();
  first.publish({ runId: 'run_p5b', sequence: 1, eventId: 'evt_1' });
  const received: number[] = [];
  first.subscribe('run_p5b', hint => received.push(hint.sequence));
  assert.deepEqual(received, []);

  const restarted = new RuntimeEventNotifier();
  restarted.publish({ runId: 'run_p5b', sequence: 2, eventId: 'evt_2' });
  assert.deepEqual(received, []);
});

test('P5B commit hints contain identity only', () => {
  const notifier = new RuntimeEventNotifier();
  let observed: Record<string, unknown> | undefined;
  notifier.subscribe('run_p5b', hint => { observed = hint as unknown as Record<string, unknown>; });
  notifier.publish({ runId: 'run_p5b', sequence: 4, eventId: 'evt_4' });
  assert.deepEqual(Object.keys(observed!).sort(), ['eventId', 'runId', 'sequence']);
});
