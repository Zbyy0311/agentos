import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from './EventBus.js';
import type { AgentEvent, AgentEventDraft, PersistEventResult } from '@agentos/shared';

function draft(id: string): AgentEventDraft {
  return {
    eventId: id, schemaVersion: 2, type: 'run.created', workspaceId: 'workspace-a',
    conversationId: 'conversation-a', runId: 'run-a', timestamp: id, payload: { id },
  };
}

function persistWithSequence(): (event: AgentEventDraft) => PersistEventResult {
  let sequence = 0;
  return event => ({ event: { ...event, sequence: ++sequence }, inserted: true });
}

test('persists before broadcasting and returns the assigned sequence', async () => {
  const received: string[] = [];
  const bus = new EventBus(persistWithSequence());
  bus.subscribe(async item => {
    received.push(`first:${item.eventId}:${item.sequence}`);
    await new Promise(resolve => setTimeout(resolve, 15));
    received.push('first:done');
  });
  bus.subscribe(item => { received.push(`second:${item.eventId}`); });

  const persisted = await bus.publish(draft('one'));
  assert.equal(persisted.sequence, 1);
  assert.deepEqual(received, ['first:one:1', 'second:one', 'first:done']);
});

test('duplicate persistence results are not broadcast again', async () => {
  const received: string[] = [];
  const event: AgentEvent = { ...draft('one'), sequence: 1 };
  const bus = new EventBus(input => ({ event, inserted: input.eventId !== 'duplicate' }));
  bus.subscribe(item => { received.push(item.eventId); });
  await bus.publish(draft('one'));
  await bus.publish({ ...draft('duplicate'), eventId: 'duplicate' });
  assert.deepEqual(received, ['one']);
});

test('subscriber failures are isolated and reported after other subscribers run', async () => {
  const received: string[] = [];
  const failures: unknown[] = [];
  const bus = new EventBus(persistWithSequence(), (error) => failures.push(error));
  bus.subscribe(() => { throw new Error('subscriber failed'); });
  bus.subscribe(item => { received.push(item.eventId); });

  await bus.publish(draft('broken'));
  assert.deepEqual(received, ['broken']);
  assert.equal(failures.length, 1);
  assert.equal((failures[0] as Error).message, 'subscriber failed');
});
