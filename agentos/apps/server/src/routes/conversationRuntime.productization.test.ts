import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { createEntityId } from '../store/Identity.js';
import type { AppendMessageInput } from '../store/ConversationRepository.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createConversationRuntimeRoutes } from './conversationRuntime.js';
import { inTransaction } from '../store/Transaction.js';
import { RuntimeApprovalRepository } from '../store/RuntimeApprovalRepository.js';
import { seedApprovalRun } from '../store/RuntimeApproval.test-fixture.js';
import type { ConversationProductEvent } from '../store/ConversationEventRepository.js';
import { ConversationStreamService } from '../services/ConversationStreamService.js';
import { AgentTurnRepository } from '../store/AgentTurnRepository.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr-productization-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [
      {
        id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: false, memoryEnabled: false,
        agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
        lastOpenedAt: '2026-10-20T00:00:00.000Z', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
      },
      {
        id: 'workspace-b', name: 'Workspace B', rootPath: join(root, 'ws-b-root'), gitEnabled: false, memoryEnabled: false,
        agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
        lastOpenedAt: '2026-10-20T00:00:00.000Z', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
      },
    ],
  }), 'utf-8');
  return root;
}

async function withServer(run: (baseUrl: (workspaceId: string) => string, store: SqliteStore) => Promise<void>): Promise<void> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId/runtime', createConversationRuntimeRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await run(workspaceId => `http://127.0.0.1:${address.port}/api/workspaces/${workspaceId}/runtime`, store);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function postJson(url: string, body: unknown = {}): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test('Summary list/latest/manual routes expose immutable active versions and safe conflicts', async () => {
  await withServer(async (baseUrl, store) => {
    const base = baseUrl('workspace-a');
    const created = await postJson(`${base}/conversations`, { kind: 'direct', agentId: 'codex' });
    assert.equal(created.status, 201);
    const conversationId = (created.json as { conversation: { id: string } }).conversation.id;
    const send = async (content: string) => {
      const response = await postJson(`${base}/conversations/${conversationId}/messages`, { content });
      assert.equal(response.status, 201);
    };
    await send('我们采用保守切换步骤。');
    const first = await postJson(`${base}/conversations/${conversationId}/summaries`);
    assert.equal(first.status, 201);
    assert.equal((first.json as { summary: { version: number } }).summary.version, 1);
    assert.equal((first.json as { activeSummaryId: string }).activeSummaryId,
      (first.json as { summary: { id: string } }).summary.id);

    const latest = await fetch(`${base}/conversations/${conversationId}/summaries/latest`).then(response => response.json()) as {
      summary: { version: number; id: string };
      activeSummaryId: string;
    };
    assert.equal(latest.summary.version, 1);
    assert.equal(latest.activeSummaryId, latest.summary.id);
    await send('必须保留原始会话消息。');
    const second = await postJson(`${base}/conversations/${conversationId}/summaries`);
    assert.equal((second.json as { summary: { version: number; supersedesSummaryId: string } }).summary.version, 2);
    const history = await fetch(`${base}/conversations/${conversationId}/summaries`).then(response => response.json()) as {
      summaries: Array<{ version: number }>;
    };
    assert.deepEqual(history.summaries.map(summary => summary.version), [2, 1]);

    const foreign = await fetch(`${baseUrl('workspace-b')}/conversations/${conversationId}/summaries/latest`);
    assert.equal(foreign.status, 404);
    const missing = await fetch(`${base}/conversations/missing/summaries`);
    assert.equal(missing.status, 404);

    const streamingMessage: AppendMessageInput = {
      id: createEntityId('message'), workspaceId: 'workspace-a', conversationId,
      senderType: 'user', kind: 'text', status: 'streaming', content: 'partial', createdAt: '2026-10-20T10:00:00.000Z',
    };
    store.conversationRepository().appendMessage(streamingMessage);
    const activeStream = await postJson(`${base}/conversations/${conversationId}/summaries`);
    assert.equal(activeStream.status, 409);
    assert.equal(JSON.stringify(activeStream.json).includes('Internal server error'), false);
  });
});

test('Notification routes list, read, and dismiss with workspace/user isolation', async () => {
  await withServer(async (baseUrl) => {
    const base = baseUrl('workspace-a');
    const created = await postJson(`${base}/conversations`, { kind: 'direct', agentId: 'codex' });
    const conversationId = (created.json as { conversation: { id: string } }).conversation.id;
    for (const content of ['@codex first notification', '@codex second notification']) {
      assert.equal((await postJson(`${base}/conversations/${conversationId}/messages`, { content })).status, 201);
    }

    const listed = await fetch(`${base}/conversations/notifications?userId=default`).then(response => response.json()) as {
      notifications: Array<{ id: string; status: string; type: string; conversationId: string }>;
    };
    assert.equal(listed.notifications.length, 2);
    assert.ok(listed.notifications.every(notification => notification.type === 'mention' && notification.status === 'unread'));
    assert.ok(listed.notifications.every(notification => notification.conversationId === conversationId));

    const read = await postJson(`${base}/conversations/notifications/${listed.notifications[0]!.id}/read`, { userId: 'default' });
    assert.equal((read.json as { notification: { status: string } }).notification.status, 'read');
    const dismissed = await postJson(`${base}/conversations/notifications/${listed.notifications[1]!.id}/dismiss`, { userId: 'default' });
    assert.equal((dismissed.json as { notification: { status: string } }).notification.status, 'dismissed');
    assert.equal((await fetch(`${base}/conversations/notifications?status=invalid`)).status, 400);
    const otherUser = await fetch(`${base}/conversations/notifications?userId=other-user`).then(response => response.json()) as { notifications: unknown[] };
    assert.equal(otherUser.notifications.length, 0);
    const otherWorkspace = await fetch(`${baseUrl('workspace-b')}/conversations/notifications`).then(response => response.json()) as { notifications: unknown[] };
    assert.equal(otherWorkspace.notifications.length, 0);
    assert.equal((await postJson(`${base}/conversations/notifications/missing/read`)).status, 404);
  });
});

async function readSse(response: Response, count: number) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ id: number; event: string; data: ConversationProductEvent }> = [];
  let buffered = '';
  try {
    while (events.length < count) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false, 'stream ended before the expected committed events');
      buffered += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffered.indexOf('\n\n')) >= 0) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!data) continue;
        events.push({ id: Number(/^id: (\d+)$/m.exec(frame)?.[1]),
          event: /^event: (.+)$/m.exec(frame)![1]!, data: JSON.parse(data) as ConversationProductEvent });
        if (events.length === count) break;
      }
    }
    return events;
  } finally { await reader.cancel(); }
}

test('product SSE delivers live facts, replays Last-Event-ID, and scopes notification/read-state events by user', async () => {
  await withServer(async baseUrl => {
    const base = baseUrl('workspace-a');
    const created = await postJson(`${base}/conversations`, { kind: 'direct', agentId: 'codex' });
    const conversationId = (created.json as { conversation: { id: string } }).conversation.id;
    const streamUrl = `${base}/conversations/${conversationId}/stream`;
    assert.equal((await fetch(`${streamUrl}?afterCursor=-1`)).status, 400);
    assert.equal((await fetch(streamUrl, { headers: { 'Last-Event-ID': 'invalid' } })).status, 400);
    assert.equal((await fetch(`${base}/conversations/missing/stream`)).status, 404);
    assert.equal((await fetch(`${baseUrl('workspace-b')}/conversations/${conversationId}/stream`)).status, 404);
    const live = await fetch(streamUrl, { signal: AbortSignal.timeout(10000) });
    await postJson(`${base}/conversations/${conversationId}/messages`, { content: '@codex first' });
    await postJson(`${base}/conversations/${conversationId}/summaries`);
    const first = await readSse(live, 2);
    assert.deepEqual(first.map(event => event.event), ['notification', 'conversation-updated']);
    assert.deepEqual(first.map(event => event.data.type), ['conversation.notification_created', 'conversation.summary_created']);
    assert.equal(first[0]!.data.userId, 'default');
    const cursor = first.at(-1)!.id;
    await postJson(`${base}/conversations/${conversationId}/messages`, { content: '@codex second' });
    await postJson(`${base}/conversations/${conversationId}/summaries`);
    const replay = await readSse(await fetch(streamUrl, {
      headers: { 'Last-Event-ID': String(cursor) }, signal: AbortSignal.timeout(10000),
    }), 3);
    assert.ok(replay.every(event => event.id > cursor && event.id === event.data.sequence));
    assert.deepEqual(replay.map(event => event.data.type), [
      'conversation.notification_created', 'conversation.summary_created', 'conversation.summary_superseded',
    ]);
    const otherUser = await readSse(await fetch(`${streamUrl}?userId=other-user`, { signal: AbortSignal.timeout(10000) }), 3);
    assert.ok(otherUser.every(event => event.data.userId === null && event.data.type.startsWith('conversation.summary_')));
    const notification = first[0]!.data.payload.notification as { id: string };
    const changedCursor = replay.at(-1)!.id;
    assert.equal((await postJson(`${base}/conversations/notifications/${notification.id}/read`)).status, 200);
    const dismissed = await postJson(`${base}/conversations/notifications/${notification.id}/dismiss`);
    assert.equal((dismissed.json as { notification: { status: string } }).notification.status, 'dismissed');
    await postJson(`${base}/conversations/notifications/${notification.id}/dismiss`);
    await postJson(`${base}/conversations/${conversationId}/read`, { latest: true });
    const changes = await readSse(await fetch(`${streamUrl}?afterRuntimeEventSequence=${changedCursor}`, { signal: AbortSignal.timeout(10000) }), 3);
    assert.deepEqual(changes.map(event => event.event), ['notification', 'notification', 'read-state-updated']);
    assert.equal((changes[1]!.data.payload.notification as { status: string }).status, 'dismissed');
    assert.ok(changes.every(event => event.data.userId === 'default'));
  });
});

test('approval creation notifies immediately and single/batch/read routes report actual pending counts including NULL bindings', async () => {
  await withServer(async (baseUrl, store) => {
    const base = baseUrl('workspace-a');
    const created = await postJson(`${base}/conversations`, { kind: 'direct', agentId: 'codex' });
    const conversationId = (created.json as { conversation: { id: string } }).conversation.id;
    const db = store.getDatabase();
    const input = seedApprovalRun(db, 'workspace-a', new Date().toISOString(), conversationId);
    const approvals = new RuntimeApprovalRepository(db);
    const approval = inTransaction(db, () => approvals.createWithinTransaction(input));
    assert.equal(approval.conversationId, conversationId, 'Task source resolves before any Run Message is created');
    assert.equal(approval.approvalRequiredEventId, null);
    const notifications = await fetch(`${base}/conversations/notifications`).then(response => response.json()) as {
      notifications: Array<{ id: string; type: string; sourceApprovalId: string }>;
    };
    assert.deepEqual(notifications.notifications.map(row => [row.type, row.sourceApprovalId]), [['approval', approval.id]]);
    await postJson(`${base}/conversations/notifications/${notifications.notifications[0]!.id}/dismiss`);
    const count = async () => ((await fetch(`${base}/conversations/${conversationId}/read-state`).then(response => response.json())) as {
      readState: { approvalCount: number };
    }).readState.approvalCount;
    assert.equal(await count(), 1, 'dismissing a notification never resolves its Approval');
    db.prepare('UPDATE runtime_approval_requests SET conversation_id = NULL WHERE id = ?').run(approval.id);
    assert.equal(await count(), 1, 'legacy NULL bindings are dynamically resolvable');
    const secondInput = seedApprovalRun(db, 'workspace-a', new Date().toISOString(), conversationId);
    const second = inTransaction(db, () => approvals.createWithinTransaction(secondInput));
    assert.equal(await count(), 2);
    const read = await postJson(`${base}/conversations/${conversationId}/read`, { latest: true });
    assert.equal((read.json as { readState: { approvalCount: number } }).readState.approvalCount, 2);
    const batch = await fetch(`${base}/conversations/read-state`).then(response => response.json()) as {
      readStates: Array<{ conversationId: string; approvalCount: number }>;
    };
    assert.equal(batch.readStates.find(row => row.conversationId === conversationId)?.approvalCount, 2);
    inTransaction(db, () => approvals.markExpiredWithinTransaction({ workspaceId: 'workspace-a', id: second.id,
      expectedVersion: second.version, now: new Date(Date.parse(secondInput.expiresAt) + 1).toISOString() }));
    assert.equal(await count(), 1);
    const unlinked = seedApprovalRun(db, 'workspace-a', new Date().toISOString());
    inTransaction(db, () => approvals.createWithinTransaction(unlinked));
    assert.equal(await count(), 1, 'an unresolvable Run contributes zero');
    assert.equal((await fetch(`${baseUrl('workspace-b')}/conversations/${conversationId}/read-state`)).status, 404);
  });
});

test('all four production notification sources are listed, streamed, read and dismissed through HTTP', async () => {
  await withServer(async (baseUrl, store) => {
    const base = baseUrl('workspace-a');
    const created = await postJson(`${base}/conversations`, { kind: 'direct', agentId: 'codex' });
    const conversationId = (created.json as { conversation: { id: string } }).conversation.id;
    const db = store.getDatabase();
    const now = new Date().toISOString();
    await postJson(`${base}/conversations/${conversationId}/messages`, { content: '@codex review this' });
    const stream = new ConversationStreamService(db, store.conversationRepository(), new AgentTurnRepository(db));
    const handle = stream.beginAgentTurnStream({ workspaceId: 'workspace-a', conversationId, turnId: createEntityId('turn'),
      messageId: createEntityId('message'), agentId: 'codex', createdAt: now });
    stream.finalizeStream({ workspaceId: 'workspace-a', turnId: handle.turn.id, messageId: handle.message.id,
      expectedTurnVersion: handle.turn.version, expectedMessageVersion: handle.message.version,
      outcome: 'final', content: 'Agent final reply', updatedAt: now });
    const approvalInput = seedApprovalRun(db, 'workspace-a', now, conversationId);
    inTransaction(db, () => new RuntimeApprovalRepository(db).createWithinTransaction(approvalInput));
    for (const sequence of [1, 2]) inTransaction(db, () => store.runtimeEventRepository().appendWithinTransaction({
      id: createEntityId('event'), schemaVersion: 1, workspaceId: 'workspace-a', runId: approvalInput.runId,
      taskId: approvalInput.taskId, type: 'run.completed', source: 'run-engine', sequence, timestamp: now,
      correlationId: approvalInput.runId, payload: { durationMs: 1, completedStageIds: [], artifactIds: [] },
    }));
    const listed = await fetch(`${base}/conversations/notifications?conversationId=${conversationId}`).then(response => response.json()) as {
      notifications: Array<{ id: string; type: string }>;
    };
    assert.deepEqual(listed.notifications.map(row => row.type).sort(), ['agent-reply', 'approval', 'mention', 'run-completed']);
    const events = await readSse(await fetch(`${base}/conversations/${conversationId}/stream`, { signal: AbortSignal.timeout(10000) }), 5);
    const notifications = events.filter(event => event.event === 'notification');
    assert.equal(notifications.length, 4);
    assert.deepEqual(notifications.map(event => (event.data.payload.notification as { type: string }).type).sort(),
      ['agent-reply', 'approval', 'mention', 'run-completed']);
    for (const { id } of listed.notifications) {
      const read = await postJson(`${base}/conversations/notifications/${id}/read`);
      assert.equal((read.json as { notification: { status: string } }).notification.status, 'read');
      const dismiss = await postJson(`${base}/conversations/notifications/${id}/dismiss`);
      assert.equal((dismiss.json as { notification: { status: string } }).notification.status, 'dismissed');
    }
    const dismissed = await fetch(`${base}/conversations/notifications?status=dismissed`).then(response => response.json()) as { notifications: unknown[] };
    assert.equal(dismissed.notifications.length, 4);
  });
});
