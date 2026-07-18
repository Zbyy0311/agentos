import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStreamRegistry } from './RunStreamRegistry.js';

test('replays events after a cursor and forwards later events', () => {
  const registry = new RunStreamRegistry();
  const controller = new AbortController();
  registry.open('run-a', controller);
  registry.emit('run-a', 'execution', { status: 'queued' });
  registry.emit('run-a', 'execution', { status: 'running_cli' });

  const received: Array<{ cursor: number; event: string }> = [];
  registry.subscribe('run-a', 1, item => received.push({ cursor: item.cursor, event: item.event }));
  registry.emit('run-a', 'done', { execution: { runId: 'run-a', status: 'completed' } });

  assert.deepEqual(received, [
    { cursor: 2, event: 'execution' },
    { cursor: 3, event: 'done' },
  ]);
});

test('finishes a stream for late subscribers and cancels only active runs', () => {
  const registry = new RunStreamRegistry();
  const controller = new AbortController();
  registry.open('run-a', controller);
  registry.finish('run-a', 'done', { execution: { runId: 'run-a', status: 'completed' } });

  const received: string[] = [];
  registry.subscribe('run-a', 0, item => received.push(item.event));
  assert.deepEqual(received, ['done']);
  assert.equal(registry.cancel('run-a'), false);

  registry.open('run-b', controller);
  assert.equal(registry.cancel('run-b'), true);
  assert.equal(controller.signal.aborted, true);
});

test('returns no subscription for an unknown run', () => {
  const registry = new RunStreamRegistry();
  assert.equal(registry.subscribe('missing', 0, () => {}), undefined);
  assert.equal(registry.cancel('missing'), false);
});

test('keeps persisted AgentEvent sequence in SSE data while cursor remains transport-local', () => {
  const registry = new RunStreamRegistry();
  registry.open('run-sequence', new AbortController());
  const item = registry.emit('run-sequence', 'runtime', {
    eventId: 'event-9', sequence: 42, type: 'execution.tool.started',
  });
  assert.equal(item?.cursor, 1);
  assert.equal(item?.data.sequence, 42);
  assert.equal(item?.data.cursor, 1);
});
