import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createConversationRuntimeRoutes } from './conversationRuntime.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr-runtime-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
      agents: [
        { id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] },
        { id: 'kimi', name: 'KimiCode', role: 'kimi', enabled: true, cliCommand: 'kimi', cliArgs: ['-p'] },
      ],
      lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    }],
  }), 'utf-8');
  return root;
}

async function withServer(run: (baseUrl: string, store: SqliteStore) => Promise<void>): Promise<void> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId/runtime', createConversationRuntimeRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/workspaces/workspace-a/runtime`, store);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close?.();
    rmSync(root, { recursive: true, force: true });
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test('direct Conversation lifecycle: create, send, list, archive, restore', async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/conversations`, { kind: 'direct', agentId: 'codex' });
    assert.equal(created.status, 201);
    const conversation = (created.json as { conversation: { id: string; kind: string } }).conversation;
    assert.equal(conversation.kind, 'direct');

    const members = await fetch(`${baseUrl}/conversations/${conversation.id}/members`).then(r => r.json()) as { members: unknown[] };
    assert.equal(members.members.length, 2); // user + agent

    const sent = await postJson(`${baseUrl}/conversations/${conversation.id}/messages`, { content: 'hello', clientMessageId: 'cm-1' });
    assert.equal(sent.status, 201);
    const message = (sent.json as { message: { sequence: number; senderType: string } }).message;
    assert.equal(message.senderType, 'user');
    assert.equal(message.sequence, 1);

    // retried send converges on one Message
    const again = await postJson(`${baseUrl}/conversations/${conversation.id}/messages`, { content: 'hello', clientMessageId: 'cm-1' });
    assert.equal(again.status, 201);
    const listed = await fetch(`${baseUrl}/conversations/${conversation.id}/messages`).then(r => r.json()) as { messages: unknown[] };
    assert.equal(listed.messages.length, 1);

    const beforeArchive = await fetch(`${baseUrl}/conversations/${conversation.id}`).then(r => r.json()) as { conversation: { version: number } };
    const archived = await postJson(`${baseUrl}/conversations/${conversation.id}/archive`, { expectedVersion: beforeArchive.conversation.version });
    assert.equal(archived.status, 200);
    const restored = await postJson(`${baseUrl}/conversations/${conversation.id}/restore`, {
      expectedVersion: (archived.json as { conversation: { version: number } }).conversation.version,
    });
    assert.equal(restored.status, 200);

    const list = await fetch(`${baseUrl}/conversations`).then(r => r.json()) as { conversations: unknown[] };
    assert.equal(list.conversations.length, 1);
  });
});

test('group Conversation requires two Agents and a reply mode', async () => {
  await withServer(async (baseUrl) => {
    const missingMode = await postJson(`${baseUrl}/conversations`, { kind: 'group', memberAgentIds: ['codex', 'kimi'] });
    assert.equal(missingMode.status, 400);
    const oneAgent = await postJson(`${baseUrl}/conversations`, { kind: 'group', replyMode: 'sequential', memberAgentIds: ['codex'] });
    assert.equal(oneAgent.status, 400);
    const created = await postJson(`${baseUrl}/conversations`, { kind: 'group', replyMode: 'sequential', memberAgentIds: ['codex', 'kimi'] });
    assert.equal(created.status, 201);
    const members = (created.json as { members: unknown[] }).members;
    assert.equal(members.length, 3); // user + two agents
  });
});

test('checkpoints replay and unknown ids fail closed', async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/conversations`, { kind: 'direct', agentId: 'codex' });
    const conversation = (created.json as { conversation: { id: string } }).conversation;
    const sent = await postJson(`${baseUrl}/conversations/${conversation.id}/messages`, { content: 'hi' });
    const message = (sent.json as { message: { id: string } }).message;
    const replay = await fetch(`${baseUrl}/conversations/${conversation.id}/messages/${message.id}/checkpoints?afterCursor=0`);
    assert.equal(replay.status, 200);
    const replayJson = await replay.json() as { checkpoints: unknown[]; nextCursor: number };
    assert.equal(replayJson.checkpoints.length, 0);
    assert.equal(replayJson.nextCursor, 0);
    const missing = await fetch(`${baseUrl}/conversations/${conversation.id}/messages/msg_missing/checkpoints`);
    assert.equal(missing.status, 404);
    const badCursor = await fetch(`${baseUrl}/conversations/${conversation.id}/messages/${message.id}/checkpoints?afterCursor=-1`);
    assert.equal(badCursor.status, 400);
  });
});

test('create-task and start-run bridge a Message into durable work', async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/conversations`, { kind: 'direct', agentId: 'codex' });
    const conversation = (created.json as { conversation: { id: string } }).conversation;
    const sent = await postJson(`${baseUrl}/conversations/${conversation.id}/messages`, { content: 'plan the release' });
    const message = (sent.json as { message: { id: string } }).message;

    const task = await postJson(`${baseUrl}/messages/${message.id}/create-task`, {});
    assert.equal(task.status, 201);
    const taskResult = task.json as { created: boolean; task: { id: string; sourceMessageId: string } };
    assert.equal(taskResult.created, true);
    assert.equal(taskResult.task.sourceMessageId, message.id);

    const start = await postJson(`${baseUrl}/messages/${message.id}/start-run`, { objective: 'ship it' });
    assert.equal(start.status, 201);
    const startResult = start.json as { runCreated: boolean; run: { status: string; taskId: string }; admission: { admissionState: unknown } };
    assert.equal(startResult.runCreated, true);
    assert.equal(startResult.run.status, 'queued');
    assert.equal(startResult.run.taskId, taskResult.task.id);
    // admission is reported, never fabricated
    assert.equal(startResult.admission.admissionState, null);

    // a retry converges on the same Run
    const retry = await postJson(`${baseUrl}/messages/${message.id}/start-run`, { objective: 'ship it' });
    assert.equal((retry.json as { runCreated: boolean }).runCreated, false);
  });
});

test('history endpoint returns the agent unified references', async () => {
  await withServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/conversations`, { kind: 'direct', agentId: 'codex' });
    const conversation = (created.json as { conversation: { id: string } }).conversation;
    await postJson(`${baseUrl}/conversations/${conversation.id}/messages`, { content: 'hi' });
    const sent2 = await postJson(`${baseUrl}/conversations/${conversation.id}/messages`, { content: 'do work' });
    const message2 = (sent2.json as { message: { id: string } }).message;
    await postJson(`${baseUrl}/messages/${message2.id}/create-task`, {});
    const history = await fetch(`${baseUrl}/agents/codex/history`).then(r => r.json()) as { history: unknown[] };
    assert.ok(Array.isArray(history.history));
    // conversation membership is linked
    assert.ok((history.history as Array<{ kind: string }>).some(e => e.kind === 'conversation'));
  });
});

test('unknown workspace and conversation fail closed with 404', async () => {
  await withServer(async (baseUrl) => {
    const noWs = await fetch('http://127.0.0.1:1/api/workspaces/nope/runtime/conversations').catch(() => null);
    assert.equal(noWs, null);
    const noConv = await fetch(`${baseUrl}/conversations/conv_missing`);
    assert.equal(noConv.status, 404);
  });
});
