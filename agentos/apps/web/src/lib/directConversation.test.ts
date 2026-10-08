import assert from 'node:assert/strict';
import test from 'node:test';

import { ConversationStreamMachine, ConversationStreamGapError } from './directConversationStream.js';
import { directConversationClient } from './directConversationClient.js';
import { resolveComposerAction, actionCreatesWork } from './directComposer.js';

// ---- stream state machine ---------------------------------------------------

test('DCUX-S01 a stream connects, assembles one block, and finalizes', () => {
  const m = new ConversationStreamMachine();
  m.connect();
  assert.equal(m.snapshot.phase, 'connecting');
  m.apply({ type: 'turn.start', turnId: 'turn_1', messageId: 'msg_1' });
  assert.equal(m.snapshot.phase, 'connected');
  m.apply({ type: 'checkpoint', messageId: 'msg_1', cursor: 1, delta: 'Hel' });
  m.apply({ type: 'checkpoint', messageId: 'msg_1', cursor: 2, delta: 'lo' });
  assert.equal(m.snapshot.text, 'Hello');
  assert.equal(m.snapshot.lastCursor, 2);
  assert.equal(m.snapshot.checkpointCount, 2);
  m.apply({ type: 'turn.final', messageStatus: 'final' });
  assert.equal(m.snapshot.phase, 'done');
  assert.equal(m.snapshot.terminal, true);
});

test('DCUX-S02 a checkpoint out of order fails as a gap', () => {
  const m = new ConversationStreamMachine();
  m.connect();
  m.apply({ type: 'turn.start', turnId: 'turn_1', messageId: 'msg_1' });
  m.apply({ type: 'checkpoint', messageId: 'msg_1', cursor: 1, delta: 'a' });
  assert.throws(
    () => m.apply({ type: 'checkpoint', messageId: 'msg_1', cursor: 3, delta: 'b' }),
    ConversationStreamGapError,
  );
});

test('DCUX-S03 reconnect resumes from the durable cursor and resyncs', () => {
  const m = new ConversationStreamMachine();
  m.connect();
  m.apply({ type: 'turn.start', turnId: 'turn_1', messageId: 'msg_1' });
  m.apply({ type: 'checkpoint', messageId: 'msg_1', cursor: 1, delta: 'a' });
  m.apply({ type: 'checkpoint', messageId: 'msg_1', cursor: 2, delta: 'b' });
  m.disconnected();
  assert.equal(m.snapshot.phase, 'disconnected');
  m.reconnecting();
  assert.equal(m.snapshot.phase, 'reconnecting');
  assert.equal(m.resumeCursor(), 2);
  m.markResyncing();
  m.apply({ type: 'checkpoint', messageId: 'msg_1', cursor: 3, delta: 'c' });
  assert.equal(m.snapshot.phase, 'resyncing');
  assert.equal(m.snapshot.text, 'abc');
  m.apply({ type: 'turn.final', messageStatus: 'final' });
  assert.equal(m.snapshot.terminal, true);
});

test('DCUX-S04 a terminal stream accepts nothing further', () => {
  const m = new ConversationStreamMachine();
  m.connect();
  m.apply({ type: 'turn.start', turnId: 'turn_1', messageId: 'msg_1' });
  m.apply({ type: 'turn.failed', messageStatus: 'failed', failureCode: 'PROVIDER_FAILED' });
  assert.equal(m.snapshot.phase, 'failed');
  assert.equal(m.snapshot.failureCode, 'PROVIDER_FAILED');
  m.apply({ type: 'checkpoint', messageId: 'msg_1', cursor: 1, delta: 'late' });
  assert.equal(m.snapshot.text, '');
  m.disconnected();
  assert.equal(m.snapshot.phase, 'failed');
});

test('DCUX-S05 checkpoints for another message are ignored', () => {
  const m = new ConversationStreamMachine();
  m.connect();
  m.apply({ type: 'turn.start', turnId: 'turn_1', messageId: 'msg_1' });
  m.apply({ type: 'checkpoint', messageId: 'msg_other', cursor: 1, delta: 'x' });
  assert.equal(m.snapshot.text, '');
});

// ---- API client ---------------------------------------------------------------

test('DCUX-C01 the client targets the forward runtime surface with correct paths', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const fakeFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return {
      ok: true,
      status: 200,
      json: async () => ({ conversations: [], messages: [], checkpoints: [], turns: [] }),
      text: async () => '',
    } as unknown as Response;
  };
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch as never;
  try {
    const client = directConversationClient({ workspaceId: 'workspace-a', apiBase: 'http://127.0.0.1:3000' });
    await client.listAgents();
    await client.listConversations();
    await client.sendMessage('conv_1', 'hello', 'cm-1');
    await client.listMessages('conv_1', 4);
    await client.replayCheckpoints('conv_1', 'msg_1', 2);
    await client.createTaskFromMessage('msg_1');
    await client.startRunFromMessage('msg_1', { objective: 'x' });
    await client.listTurns('conv_1');
  } finally {
    globalThis.fetch = original;
  }
  const urls = calls.map(c => c.url);
  assert.ok(urls.some(u => u.includes('/api/workspaces/workspace-a/runtime')));
  assert.ok(calls.some(c => c.url === 'http://127.0.0.1:3000/api/workspaces/workspace-a/agents'));
  assert.ok(calls.some(c => c.method === 'POST' && c.url.endsWith('/conversations/conv_1/messages')));
  assert.ok(calls.some(c => c.url.includes('/messages/msg_1/checkpoints?afterCursor=2')));
  assert.ok(calls.some(c => c.method === 'POST' && c.url.endsWith('/messages/msg_1/create-task')));
  assert.ok(calls.some(c => c.method === 'POST' && c.url.endsWith('/messages/msg_1/start-run')));
  assert.ok(calls.some(c => c.url.endsWith('/conversations/conv_1/turns')));
});

test('DCUX-C02 a non-OK response throws with the status', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 409, json: async () => ({ error: 'CONVERSATION_NOT_TRANSITIONABLE' }), text: async () => '' })) as never;
  try {
    const client = directConversationClient({ workspaceId: 'workspace-a', apiBase: 'http://x' });
    await assert.rejects(
      () => client.sendMessage('conv_1', 'hi'),
      (error: unknown) => error instanceof Error && (error as { status?: number }).status === 409 && error.message === 'CONVERSATION_NOT_TRANSITIONABLE',
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('DCUX-C05 the client sends an explicit ask intent for a general conversation', async () => {
  const original = globalThis.fetch;
  let requestBody: unknown;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(null, { status: 200 });
  };
  try {
    const client = directConversationClient({ workspaceId: 'workspace-a', apiBase: 'http://127.0.0.1:3000' });
    await client.streamReply('conv_1', '比较两个方案的优缺点', 'ask');
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(requestBody, { content: '比较两个方案的优缺点', intent: 'ask' });
});

test('DCUX-C03 canonical runtime group creation keeps the group contract explicit', async () => {
  const original = globalThis.fetch;
  let requestUrl = '';
  let requestBody: unknown;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ conversation: { id: 'group_1', kind: 'group', title: 'Team', status: 'active', version: 1 } }),
    } as unknown as Response;
  };
  try {
    const client = directConversationClient({ workspaceId: 'workspace-a', apiBase: 'http://127.0.0.1:3000' });
    await client.createConversation({
      kind: 'group', replyMode: 'sequential', title: 'Team', memberAgentIds: ['agent_a', 'agent_b'],
    });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(requestUrl, 'http://127.0.0.1:3000/api/workspaces/workspace-a/runtime/conversations');
  assert.deepEqual(requestBody, {
    kind: 'group', replyMode: 'sequential', title: 'Team', memberAgentIds: ['agent_a', 'agent_b'],
  });
});

test('DCUX-C04 canonical runtime group member settings use the versioned group endpoint', async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ members: [], conversation: { id: 'group_1', kind: 'group', title: 'Team', status: 'active', version: 1, settingsVersion: 2 } }),
    } as unknown as Response;
  };
  try {
    const client = directConversationClient({ workspaceId: 'workspace-a', apiBase: 'http://127.0.0.1:3000' });
    await client.listMembers('group_1');
    await client.updateGroupMemberSettings('group_1', 1, [{
      memberId: 'member_a',
      roleTitle: '规划负责人',
      model: 'gpt-5.6-luna',
      thinkingEffort: 'high',
      additionalInstructions: '只输出可复现结论',
    }]);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls[0]?.url, 'http://127.0.0.1:3000/api/workspaces/workspace-a/runtime/conversations/group_1/members');
  assert.equal(calls[0]?.method, 'GET');
  assert.equal(calls[1]?.url, 'http://127.0.0.1:3000/api/workspaces/workspace-a/runtime/conversations/group_1/members');
  assert.equal(calls[1]?.method, 'PATCH');
  assert.deepEqual(calls[1]?.body, {
    expectedSettingsVersion: 1,
    members: [{
      memberId: 'member_a',
      roleTitle: '规划负责人',
      model: 'gpt-5.6-luna',
      thinkingEffort: 'high',
      additionalInstructions: '只输出可复现结论',
    }],
  });
});

// ---- composer -----------------------------------------------------------------

test('DCUX-P01 chat send produces no Task and no Run', () => {
  const intent = resolveComposerAction({ mode: 'chat', content: 'hi' });
  assert.equal(intent.valid, true);
  if (intent.valid) {
    assert.equal(intent.action.kind, 'send');
    assert.equal(actionCreatesWork(intent.action), false);
  }
});

test('DCUX-P02 task and run modes map to distinct explicit actions', () => {
  const task = resolveComposerAction({ mode: 'task', content: 'do the thing' });
  const run = resolveComposerAction({ mode: 'run', content: 'do the thing' });
  if (task.valid) assert.equal(task.action.kind, 'create-task');
  if (run.valid) assert.equal(run.action.kind, 'start-run');
  if (task.valid && run.valid) {
    assert.notEqual(task.action.kind, run.action.kind);
    assert.equal(actionCreatesWork(task.action), true);
    assert.equal(actionCreatesWork(run.action), true);
  }
});

test('DCUX-P03 empty content and unknown modes fail closed', () => {
  assert.deepEqual(resolveComposerAction({ mode: 'chat', content: '   ' }), { valid: false, reason: 'empty-content' });
  assert.deepEqual(resolveComposerAction({ mode: 'bogus' as never, content: 'x' }), { valid: false, reason: 'invalid-mode' });
});
