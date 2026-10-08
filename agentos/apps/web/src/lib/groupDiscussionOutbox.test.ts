import assert from 'node:assert/strict';
import test from 'node:test';
import { GroupDiscussionOutbox } from './groupDiscussionOutbox.ts';

test('lost response keeps the same durable idempotency key and frozen payload for replay', () => {
  const storage = new Map<string, string>();
  const outbox = new GroupDiscussionOutbox({
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => { storage.delete(key); },
  });
  const entry = {
    identityKey: 'group-identity',
    idempotencyKey: 'client-message-1',
    clientMessageId: 'client-message-1',
    phase: 'prepared' as const,
    payload: { content: 'original request', intent: 'review' as const, mentionedAgentIds: ['agent-a'], attachmentIds: ['image-a'], budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 1, maxTotalReplies: 2, maxAgentHops: 2 } },
    submission: {
      identityKey: 'group-identity', revision: 8, textRevision: 4, mentionsRevision: 2,
      text: 'original request', mentionedAgentIds: ['agent-a'], attachmentIds: ['image-a'], queueItemId: 'queue-a',
    },
  };
  outbox.save(entry);
  outbox.updatePhase('group-identity', entry.idempotencyKey, 'responding');
  outbox.updateCursor('group-identity', entry.idempotencyKey, 11, 2);
  const recovered = outbox.load('group-identity');
  assert.deepEqual(recovered, { ...entry, phase: 'observing', cursor: 11, ownerEpoch: 2 });
  assert.equal(outbox.clear('group-identity', 'different-key'), false);
  assert.equal(outbox.clear('group-identity', entry.idempotencyKey), true);
});

test('a restored queue item reads only its own frozen outbox submission', () => {
  const storage = new Map<string, string>();
  const outbox = new GroupDiscussionOutbox({
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => { storage.delete(key); },
  });
  const entry = {
    identityKey: 'group-identity',
    idempotencyKey: 'queue-a-key',
    clientMessageId: 'queue-a-key',
    phase: 'prepared' as const,
    payload: {
      content: 'frozen queue text', intent: 'review' as const, mentionedAgentIds: ['agent-a'],
      attachmentIds: ['image-a'], budget: { maxAgentsPerTurn: 1, maxRepliesPerAgent: 1, maxTotalReplies: 1, maxAgentHops: 1 },
    },
    submission: {
      identityKey: 'group-identity', revision: 4, textRevision: 2, mentionsRevision: 1,
      text: 'frozen queue text', mentionedAgentIds: ['agent-a'], attachmentIds: ['image-a'], queueItemId: 'queue-a',
    },
  };
  outbox.save(entry);

  assert.deepEqual(outbox.loadForSubmission('group-identity', 'queue-a'), entry);
  assert.throws(() => outbox.loadForSubmission('group-identity', 'queue-b'), /队列|恢复/);
  // A new manual send is not recovery and cannot borrow a queued submission.
  assert.throws(() => outbox.loadForSubmission('group-identity'), /队列|恢复/);
  const recovered = outbox.loadForRecovery('group-identity');
  assert.equal(recovered?.submission?.queueItemId, 'queue-a');
  assert.deepEqual(recovered, entry);
  assert.throws(() => outbox.save({ ...entry, payload: { ...entry.payload, content: 'new composer text' } }), /持久化/);
});

test('outbox write failures reject before a group send can lose its recovery key', () => {
  const outbox = new GroupDiscussionOutbox({
    getItem: () => null,
    setItem: () => { throw new Error('storage denied'); },
    removeItem: () => undefined,
  });
  assert.throws(() => outbox.save({
    identityKey: 'group-identity', idempotencyKey: 'key', clientMessageId: 'key', phase: 'prepared',
    payload: { content: 'body', intent: 'execute', mentionedAgentIds: [], attachmentIds: [], budget: { maxAgentsPerTurn: 1, maxRepliesPerAgent: 1, maxTotalReplies: 1, maxAgentHops: 1 } },
  }), /持久化/i);
});
