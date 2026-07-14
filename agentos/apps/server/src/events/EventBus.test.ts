import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './EventBus.js';
import type { AgentEvent } from '@agentos/shared';

function event(id: string): AgentEvent {
  return {
    eventId: id, schemaVersion: 1, type: 'run.created', workspaceId: 'workspace-a',
    conversationId: 'conversation-a', runId: 'run-a', timestamp: id, payload: { id },
  };
}

test('publishes to subscribers in order and waits for async subscribers', async () => {
  const bus = new EventBus();
  const received: string[] = [];
  bus.subscribe(async item => {
    received.push(`first:${item.eventId}`);
    await new Promise(resolve => setTimeout(resolve, 15));
    received.push('first:done');
  });
  bus.subscribe(item => { received.push(`second:${item.eventId}`); });

  await bus.publish(event('one'));
  assert.deepEqual(received, ['first:one', 'first:done', 'second:one']);
});

test('unsubscribe stops delivery and preserves subscriber errors', async () => {
  const bus = new EventBus();
  const received: string[] = [];
  const unsubscribe = bus.subscribe(item => { received.push(item.eventId); });
  unsubscribe();
  await bus.publish(event('ignored'));
  assert.deepEqual(received, []);

  const failure = new Error('subscriber failed');
  bus.subscribe(() => { throw failure; });
  await assert.rejects(bus.publish(event('broken')), error => error === failure);
});

test('preserves errors from asynchronous subscribers', async () => {
  const bus = new EventBus();
  const failure = new Error('async subscriber failed');
  bus.subscribe(async () => {
    await Promise.resolve();
    throw failure;
  });

  await assert.rejects(bus.publish(event('async-broken')), error => error === failure);
});
