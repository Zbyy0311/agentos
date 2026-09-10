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
  const root = mkdtempSync(join(tmpdir(), 'agentos-group-route-'));
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
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function seedConversation(baseUrl: string): Promise<{ conversationId: string; messageId: string }> {
  const created = await postJson(`${baseUrl}/conversations`, { kind: 'group', replyMode: 'sequential', memberAgentIds: ['codex', 'kimi'] });
  assert.equal(created.status, 201);
  const conversation = (created.json as { conversation: { id: string } }).conversation;
  const sent = await postJson(`${baseUrl}/conversations/${conversation.id}/messages`, { content: 'hello' });
  const message = (sent.json as { message: { id: string } }).message;
  return { conversationId: conversation.id, messageId: message.id };
}

test('bounded group interaction: create, reply, budget status, stop', async () => {
  await withServer(async (baseUrl, store) => {
    const { conversationId, messageId } = await seedConversation(baseUrl);
    const created = await postJson(`${baseUrl}/conversations/${conversationId}/interactions`, {
      budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 2, maxTotalReplies: 3, maxAgentHops: 2 },
    });
    assert.equal(created.status, 201);
    const interaction = (created.json as { interaction: { id: string; status: string } }).interaction;
    assert.equal(interaction.status, 'active');

    const reply = await postJson(`${baseUrl}/interactions/${interaction.id}/replies`, { agentId: 'codex', messageId, content: 'reply one' });
    assert.equal(reply.status, 201);

    const read = await fetch(`${baseUrl}/interactions/${interaction.id}`).then(r => r.json()) as {
      budget: { repliesUsed: number; repliesRemaining: number; distinctAgents: number };
      replies: unknown[];
    };
    assert.equal(read.budget.repliesUsed, 1);
    assert.equal(read.budget.repliesRemaining, 2);
    assert.equal(read.replies.length, 1);

    const current = store.boundedGroupService().findInteraction('workspace-a', interaction.id);
    const stopped = await postJson(`${baseUrl}/interactions/${interaction.id}/stop`, { expectedVersion: current!.version });
    assert.equal(stopped.status, 200);
    assert.equal((stopped.json as { interaction: { status: string } }).interaction.status, 'stopped');

    const afterStop = await postJson(`${baseUrl}/interactions/${interaction.id}/replies`, { agentId: 'kimi', messageId, content: 'late' });
    assert.equal(afterStop.status, 409);
    assert.equal((afterStop.json as { error: string }).error, 'GROUP_INTERACTION_TERMINATED');
  });
});

test('budget exhaustion and loop guard return the stable reason via HTTP', async () => {
  await withServer(async (baseUrl) => {
    const { conversationId, messageId } = await seedConversation(baseUrl);
    const created = await postJson(`${baseUrl}/conversations/${conversationId}/interactions`, {
      budget: { maxAgentsPerTurn: 1, maxRepliesPerAgent: 1, maxTotalReplies: 1, maxAgentHops: 2 },
    });
    const interaction = (created.json as { interaction: { id: string } }).interaction;
    await postJson(`${baseUrl}/interactions/${interaction.id}/replies`, { agentId: 'codex', messageId, content: 'only one' });
    const exceeded = await postJson(`${baseUrl}/interactions/${interaction.id}/replies`, { agentId: 'kimi', messageId, content: 'over the cap' });
    assert.equal(exceeded.status, 409);
    assert.equal((exceeded.json as { error: string }).error, 'GROUP_INTERACTION_TERMINATED');
  });
});

test('create interaction fails closed for an invalid budget or missing conversation', async () => {
  await withServer(async (baseUrl) => {
    const { conversationId } = await seedConversation(baseUrl);
    const bad = await postJson(`${baseUrl}/conversations/${conversationId}/interactions`, {
      budget: { maxAgentsPerTurn: 0, maxRepliesPerAgent: 2, maxTotalReplies: 3, maxAgentHops: 2 },
    });
    assert.equal(bad.status, 400);
    const noConv = await postJson(`${baseUrl}/conversations/conv_missing/interactions`, {
      budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 2, maxTotalReplies: 3, maxAgentHops: 2 },
    });
    assert.equal(noConv.status, 404);
  });
});
