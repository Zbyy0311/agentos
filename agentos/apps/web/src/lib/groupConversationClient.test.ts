import assert from 'node:assert/strict';
import test from 'node:test';
import { groupConversationClient } from './groupConversationClient.ts';

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
