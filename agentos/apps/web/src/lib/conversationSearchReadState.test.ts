import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationSearchReadStateClient } from './conversationSearchReadState.ts';

function withFakeFetch(handler: (url: string, init?: RequestInit) => Response, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return handler(requestUrl, init);
  };
  return run().finally(() => { globalThis.fetch = originalFetch; assert.ok(requestUrl.length > 0); });
}

test('searchConversations builds the multi-filter query and hits the global route', async () => {
  await withFakeFetch(
    () => Response.json({ results: [{ messageId: 'm1', conversationId: 'c1', sequence: 4, senderType: 'agent', senderDisplayName: 'Codex', snippet: '…<mark>alpha</mark>…', matchedTerms: ['alpha'], createdAt: '2026-01-01T00:00:00.000Z' }] }),
    async () => {
      const client = conversationSearchReadStateClient({ workspaceId: 'ws/1', apiBase: 'http://127.0.0.1:3000' });
      const result = await client.searchConversations({
        query: 'alpha beta', sender: 'agent', agentId: 'codex',
        from: '2026-01-01T00:00:00.000Z', to: '2026-02-01T00:00:00.000Z', type: 'text', limit: 10,
      });
      assert.equal(result.results.length, 1);
      assert.equal(result.results[0]!.messageId, 'm1');
      assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/ws%2F1/runtime/conversations/search?query=alpha+beta&sender=agent&agentId=codex&from=2026-01-01T00%3A00%3A00.000Z&to=2026-02-01T00%3A00%3A00.000Z&type=text&limit=10');
      assert.equal(requestInit?.method, undefined);
    },
  );
});

test('searchConversation scopes to the conversation route', async () => {
  await withFakeFetch(
    () => Response.json({ results: [] }),
    async () => {
      const client = conversationSearchReadStateClient({ workspaceId: 'ws', apiBase: 'http://127.0.0.1:3000' });
      await client.searchConversation('conv/1', { query: 'alpha' });
      assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/ws/runtime/conversations/conv%2F1/search?query=alpha');
    },
  );
});

test('markConversationRead posts the monotone read position', async () => {
  await withFakeFetch(
    () => Response.json({ readState: { conversationId: 'c1', userId: 'u1', lastReadMessageSequence: 7, lastReadMessageId: 'm7', lastReadAt: '2026-01-01T00:00:00.000Z', unreadCount: 0, mentionCount: 0, approvalCount: 0 } }),
    async () => {
      const client = conversationSearchReadStateClient({ workspaceId: 'ws', apiBase: 'http://127.0.0.1:3000' });
      const { readState } = await client.markConversationRead('c1', { userId: 'u1', latest: true });
      assert.equal(readState.lastReadMessageSequence, 7);
      assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/ws/runtime/conversations/c1/read');
      assert.equal(requestInit?.method, 'POST');
      assert.deepEqual(JSON.parse(String(requestInit?.body)), { userId: 'u1', latest: true });
    },
  );
});

test('read-state endpoints carry the optional user and propagate error codes', async () => {
  await withFakeFetch(
    (url) => url.includes('read-state')
      ? Response.json({ readStates: [] })
      : new Response(JSON.stringify({ code: 'CONVERSATION_NOT_FOUND', detail: 'Conversation not found' }), { status: 404 }),
    async () => {
      const client = conversationSearchReadStateClient({ workspaceId: 'ws', apiBase: 'http://127.0.0.1:3000' });
      const batch = await client.listConversationReadStates('u/1');
      assert.deepEqual(batch.readStates, []);
      assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/ws/runtime/conversations/read-state?userId=u%2F1');
      await assert.rejects(
        () => client.markConversationRead('missing', { latest: true }),
        (error: unknown) => {
          const err = error as Error & { status: number; code?: string };
          assert.equal(err.status, 404);
          assert.equal(err.code, 'CONVERSATION_NOT_FOUND');
          return true;
        },
      );
    },
  );
});

let requestUrl = '';
let requestInit: RequestInit | undefined;
