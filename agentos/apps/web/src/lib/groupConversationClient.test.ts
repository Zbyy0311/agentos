import assert from 'node:assert/strict';
import test from 'node:test';
import { groupConversationClient, mergeGroupInteractionVersionEvent, type GroupInteraction } from './groupConversationClient.ts';

test('respond calls the bounded forward route with mentions and the cancellation signal', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(null, { status: 200 });
  };
  try {
    const response = await groupConversationClient({ workspaceId: 'ws/1', apiBase: 'http://127.0.0.1:3000' })
      .respond('interaction/1', 'conversation/1', {
        sourceMessageId: 'message/1', mentionedAgentIds: ['agent_a', 'agent_b'],
      }, controller.signal);
    assert.equal(response.status, 200);
    assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/ws%2F1/runtime/conversations/conversation%2F1/interactions/interaction%2F1/respond');
    assert.equal(requestInit?.method, 'POST');
    assert.equal(requestInit?.signal, controller.signal);
    assert.deepEqual(JSON.parse(String(requestInit?.body)), {
      sourceMessageId: 'message/1', mentionedAgentIds: ['agent_a', 'agent_b'],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('execution observer is read-only and resumes from the persisted event cursor', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response('event: group.done\nid: 11\ndata: {"interactionId":"interaction-1","cursor":11}\n\n', { status: 200 });
  };
  try {
    const response = await groupConversationClient({ workspaceId: 'ws', apiBase: 'http://localhost:3000' })
      .observeEvents('conversation-1', 'interaction-1', 10, controller.signal);
    assert.equal(requestUrl, 'http://localhost:3000/api/workspaces/ws/runtime/conversations/conversation-1/interactions/interaction-1/events?after=10');
    assert.equal(requestInit?.method, 'GET');
    assert.equal(requestInit?.signal, controller.signal);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createDiscussion sends the durable idempotency key alongside its frozen payload', async () => {
  const originalFetch = globalThis.fetch;
  const seen: RequestInit[] = [];
  globalThis.fetch = async (_input, init) => {
    seen.push(init ?? {});
    return Response.json({ message: { id: 'message-1' }, interaction: { id: 'interaction-1' } });
  };
  try {
    const client = groupConversationClient({ workspaceId: 'ws', apiBase: '' });
    const payload = { content: 'frozen body', clientMessageId: 'durable-send-1', budget: { maxTotalReplies: 2 } };
    await client.createDiscussion('conversation', payload, 'durable-send-1');
    await client.createDiscussion('conversation', payload, 'durable-send-1');
    assert.equal(seen.length, 2);
    for (const init of seen) {
      assert.equal(new Headers(init.headers).get('Idempotency-Key'), 'durable-send-1');
      assert.equal(init.body, JSON.stringify(payload));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stopInteraction sends expectedVersion and a stable idempotency key', async () => {
  const originalFetch = globalThis.fetch;
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    requestInit = init;
    return Response.json({ interaction: { id: 'interaction-1' } });
  };
  try {
    await groupConversationClient({ workspaceId: 'ws', apiBase: '' })
      .stopInteraction('interaction-1', 7, 'stop-key-7');
    assert.equal(new Headers(requestInit?.headers).get('Idempotency-Key'), 'stop-key-7');
    assert.deepEqual(JSON.parse(String(requestInit?.body)), { expectedVersion: 7 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('interaction event versions advance monotonically and never merge a foreign interaction', () => {
  const current: GroupInteraction = {
    id: 'interaction-a', conversationId: 'group-a', sourceMessageId: 'message-a', status: 'active',
    stopReason: null, loopGuardSignal: null, replyCount: 1, hopCount: 1, version: 4,
    maxAgentsPerTurn: 2, maxRepliesPerAgent: 1, maxTotalReplies: 2, maxAgentHops: 2,
  };
  assert.equal(mergeGroupInteractionVersionEvent(current, { interactionId: 'interaction-a', interactionVersion: 3 }), current);
  assert.equal(mergeGroupInteractionVersionEvent(current, { interactionId: 'interaction-b', interactionVersion: 5 }), current);
  assert.equal(mergeGroupInteractionVersionEvent(current, { interactionId: 'interaction-a', interactionVersion: 5 })?.version, 5);
  assert.deepEqual(mergeGroupInteractionVersionEvent({ ...current, ownerEpoch: 3 }, { interactionId: 'interaction-a', ownerEpoch: 2, version: 9 }), { ...current, ownerEpoch: 3 });
  assert.equal(mergeGroupInteractionVersionEvent({ ...current, ownerEpoch: 2 }, { interactionId: 'interaction-a', ownerEpoch: 3, version: 4 })?.ownerEpoch, 3);
});

test('GROUP_VERSION_CONFLICT is preserved as a stable client error code', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'version changed', code: 'GROUP_VERSION_CONFLICT' }, { status: 409 });
  try {
    await assert.rejects(
      groupConversationClient({ workspaceId: 'ws', apiBase: '' }).stopInteraction('interaction-a', 4, 'stop-4'),
      error => (error as { code?: string }).code === 'GROUP_VERSION_CONFLICT',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('newer interruption events retain the integrity fence through later raw active updates', () => {
  const current: GroupInteraction = { id: 'interaction-a', conversationId: 'group-a', sourceMessageId: 'source-a', status: 'active',
    stopReason: null, loopGuardSignal: null, replyCount: 1, hopCount: 0, version: 3,
    maxAgentsPerTurn: 3, maxRepliesPerAgent: 1, maxTotalReplies: 3, maxAgentHops: 3 };
  const interrupted = mergeGroupInteractionVersionEvent(current, {
    interaction: { id: 'interaction-a', version: 4, integrityStatus: 'unusable', integrityReason: 'execution-owner-unknown-after-restart' },
  });
  assert.ok(interrupted);
  assert.equal(Reflect.get(interrupted, 'integrityStatus'), 'unusable');
  assert.equal(Reflect.get(interrupted, 'integrityReason'), 'execution-owner-unknown-after-restart');
  const later = mergeGroupInteractionVersionEvent(interrupted, { interactionId: 'interaction-a', interactionVersion: 5, status: 'active' });
  assert.ok(later); assert.equal(Reflect.get(later, 'integrityStatus'), 'unusable');
  assert.equal(mergeGroupInteractionVersionEvent(interrupted, { interactionId: 'interaction-b', interactionVersion: 6, integrityStatus: 'valid' }), interrupted);
});
