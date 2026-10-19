import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationMessageEditClient } from './conversationMessageEdits.ts';

let requestUrl = '';
let requestInit: RequestInit | undefined;

function withFakeFetch(handler: (url: string, init?: RequestInit) => Response, run: () => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return handler(requestUrl, init);
  };
  return run().finally(() => { globalThis.fetch = originalFetch; assert.ok(requestUrl.length > 0); });
}

function messageRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_1', conversationId: 'conv_1', workspaceId: 'ws', sequence: 3,
    senderType: 'user', senderAgentId: null, kind: 'text', status: 'edited',
    content: 'second', clientMessageId: null, taskId: null, runId: null,
    sourceEventId: null, replyToMessageId: null, version: 2,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

test('editMessage patches the message with optimistic concurrency', async () => {
  await withFakeFetch(
    () => Response.json({ message: messageRecord() }),
    async () => {
      const client = conversationMessageEditClient({ workspaceId: 'ws/1', apiBase: 'http://127.0.0.1:3000' });
      const { message } = await client.editMessage('msg/1', { content: 'second', expectedVersion: 1 });
      assert.equal(message.status, 'edited');
      assert.equal(message.version, 2);
      assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/ws%2F1/runtime/messages/msg%2F1');
      assert.equal(requestInit?.method, 'PATCH');
      assert.deepEqual(JSON.parse(String(requestInit?.body)), { content: 'second', expectedVersion: 1 });
    },
  );
});

test('deleteMessage sends the optimistic version on the DELETE route', async () => {
  await withFakeFetch(
    () => Response.json({ message: messageRecord({ status: 'deleted', version: 3 }) }),
    async () => {
      const client = conversationMessageEditClient({ workspaceId: 'ws', apiBase: 'http://127.0.0.1:3000' });
      const { message } = await client.deleteMessage('msg_2', { expectedVersion: 2 });
      assert.equal(message.status, 'deleted');
      assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/ws/runtime/messages/msg_2');
      assert.equal(requestInit?.method, 'DELETE');
      assert.deepEqual(JSON.parse(String(requestInit?.body)), { expectedVersion: 2 });
    },
  );
});

test('listMessageRevisions hits the revisions route', async () => {
  await withFakeFetch(
    () => Response.json({ revisions: [{ id: 'rev_1', messageId: 'msg_1', revision: 1, content: 'second', editedAt: '2026-01-01T00:01:00.000Z' }] }),
    async () => {
      const client = conversationMessageEditClient({ workspaceId: 'ws', apiBase: 'http://127.0.0.1:3000' });
      const { revisions } = await client.listMessageRevisions('msg/9');
      assert.equal(revisions.length, 1);
      assert.equal(revisions[0]!.revision, 1);
      assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/ws/runtime/messages/msg%2F9/revisions');
      assert.equal(requestInit?.method, undefined);
    },
  );
});

test('conflict responses surface the problem code and status', async () => {
  await withFakeFetch(
    () => new Response(JSON.stringify({ code: 'MESSAGE_VERSION_CONFLICT', detail: 'MESSAGE_VERSION_CONFLICT' }), { status: 409 }),
    async () => {
      const client = conversationMessageEditClient({ workspaceId: 'ws', apiBase: 'http://127.0.0.1:3000' });
      await assert.rejects(
        () => client.editMessage('msg_1', { content: 'third', expectedVersion: 1 }),
        (error: unknown) => {
          const err = error as Error & { status: number; code?: string };
          assert.equal(err.status, 409);
          assert.equal(err.code, 'MESSAGE_VERSION_CONFLICT');
          return true;
        },
      );
    },
  );
});
