import assert from 'node:assert/strict';
import test from 'node:test';

import { DirectConversationController } from './directConversationController.js';
import type { DirectConversationClient, ForwardMessage } from './directConversationClient.js';

function sseResponse(events: string): Response {
  return new Response(events);
}

function fakeClient(overrides: Partial<Record<string, (args: never) => Promise<never>>> = {}): DirectConversationClient {
  const sent: Array<{ conversationId: string; content: string }> = [];
  return {
    calls: { sent },
    listMessages: async () => ({ messages: [] }),
    listConversations: async () => ({ conversations: [] }),
    createConversation: async () => ({ conversation: { id: 'conv_1' } }),
    listTurns: async () => ({ turns: [] }),
    sendMessage: async (conversationId: string, content: string) => {
      sent.push({ conversationId, content });
      return { message: { id: 'msg_u', sequence: 1, senderType: 'user', senderAgentId: null, status: 'final', content, taskId: null, runId: null } };
    },
    streamReply: async () => sseResponse(
      'event: turn.start\ndata: {"turnId":"turn_1","messageId":"msg_r"}\n\n'
      + 'event: checkpoint\ndata: {"messageId":"msg_r","cursor":1,"delta":"Hel"}\n\n'
      + 'event: checkpoint\ndata: {"messageId":"msg_r","cursor":2,"delta":"lo"}\n\n'
      + 'event: turn.final\ndata: {}\n\n'
      + 'event: done\ndata: {}\n\n',
    ),
    replayCheckpoints: async () => ({ message: { id: 'msg_r', status: 'final' }, checkpoints: [], nextCursor: 0 }),
    createTaskFromMessage: async () => ({}),
    startRunFromMessage: async () => ({}),
    ...overrides,
  } as unknown as DirectConversationClient & { calls: { sent: Array<{ conversationId: string; content: string }> } };
}

test('DCUX-C10 a chat send persists the Message and streams the reply as one block', async () => {
  const client = fakeClient();
  const controller = new DirectConversationController({ client });
  const outcome = await controller.send('conv_1', { mode: 'chat', content: 'hello' });
  assert.equal(outcome.kind, 'chat');
  assert.equal(outcome.terminal, true);
  assert.equal(outcome.stream.text, 'Hello');
  assert.equal(outcome.stream.phase, 'done');
  assert.equal(outcome.stream.lastCursor, 2);
});

test('DCUX-C11 task and run sends hit the bridge and never open a stream', async () => {
  const calls: string[] = [];
  const client = fakeClient({
    createTaskFromMessage: (async () => { calls.push('create-task'); }) as never,
    startRunFromMessage: (async () => { calls.push('start-run'); }) as never,
    streamReply: (async () => { calls.push('stream'); return sseResponse(''); }) as never,
  });
  const controller = new DirectConversationController({ client });
  const taskOutcome = await controller.send('conv_1', { mode: 'task', content: 'plan it' });
  assert.equal(taskOutcome.kind, 'task');
  const runOutcome = await controller.send('conv_1', { mode: 'run', content: 'do it' });
  assert.equal(runOutcome.kind, 'run');
  assert.deepEqual(calls, ['create-task', 'start-run']);
  assert.ok(!calls.includes('stream'));
});

test('DCUX-C12 empty content fails closed and sends nothing', async () => {
  const client = fakeClient();
  const controller = new DirectConversationController({ client });
  await assert.rejects(() => controller.send('conv_1', { mode: 'chat', content: '  ' }), /COMPOSER_EMPTY_CONTENT/);
});

test('DCUX-C13 a stream that ends without a terminal event resyncs from the cursor', async () => {
  // Server stream ends early (no turn.final / done)
  const client = fakeClient({
    streamReply: (async () => sseResponse(
      'event: turn.start\ndata: {"turnId":"turn_1","messageId":"msg_r"}\n\n'
      + 'event: checkpoint\ndata: {"messageId":"msg_r","cursor":1,"delta":"Hel"}\n\n',
    )) as never,
    replayCheckpoints: (async () => ({
      message: { id: 'msg_r', status: 'final' },
      checkpoints: [{ ordinal: 2, cursor: 2, delta: 'lo' }],
      nextCursor: 2,
    })) as never,
  });
  const controller = new DirectConversationController({ client });
  const outcome = await controller.send('conv_1', { mode: 'chat', content: 'hello' });
  assert.equal(outcome.stream.phase, 'done');
  assert.equal(outcome.stream.text, 'Hello');
  assert.equal(outcome.stream.lastCursor, 2);
});

test('DCUX-C14 a stream that is still streaming after resync does not guess completion', async () => {
  const client = fakeClient({
    streamReply: (async () => sseResponse(
      'event: turn.start\ndata: {"turnId":"turn_1","messageId":"msg_r"}\n\n'
      + 'event: checkpoint\ndata: {"messageId":"msg_r","cursor":1,"delta":"Hel"}\n\n',
    )) as never,
    replayCheckpoints: (async () => ({
      message: { id: 'msg_r', status: 'streaming' },   // the Server has not finalized
      checkpoints: [],
      nextCursor: 1,
    })) as never,
  });
  const controller = new DirectConversationController({ client });
  const outcome = await controller.send('conv_1', { mode: 'chat', content: 'hello' });
  // never terminal by guess; the stream stays disconnected
  assert.equal(outcome.stream.terminal, false);
  assert.equal(outcome.stream.phase, 'disconnected');
  assert.equal(outcome.stream.text, 'Hel');
});

test('DCUX-C15 a checkpoint gap fails the stream instead of guessing', async () => {
  const client = fakeClient({
    streamReply: (async () => sseResponse(
      'event: turn.start\ndata: {"turnId":"turn_1","messageId":"msg_r"}\n\n'
      + 'event: checkpoint\ndata: {"messageId":"msg_r","cursor":2,"delta":"lo"}\n\n'
      + 'event: done\ndata: {}\n\n',
    )) as never,
  });
  const controller = new DirectConversationController({ client });
  await assert.rejects(() => controller.send('conv_1', { mode: 'chat', content: 'hello' }), /STREAM_GAP/);
});

