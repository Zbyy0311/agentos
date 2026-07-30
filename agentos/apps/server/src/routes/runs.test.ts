import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createRunRoutes } from './runs.js';

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-run-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    { id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
    { id: 'workspace-b', name: 'B', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
  ] }), 'utf8');
  return root;
}

test('returns run list and aggregated details with workspace isolation and capped limit', async () => {
  const root = createRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const app = express();
  app.use('/api/workspaces/:workspaceId', createRunRoutes(store, manager));
  const server = app.listen(0);
  try {
    store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Runs', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
    store.createMessage({ id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user', content: '详情', createdAt: '2026-07-12T01:00:01.000Z' });
    store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: '详情', status: 'completed', resultSummary: '完成', createdAt: '2026-07-12T01:00:01.000Z', updatedAt: '2026-07-12T01:00:02.000Z' });
    store.createExecution({ id: 'execution-a', runId: 'run-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-a', agentId: 'codex', status: 'completed', mode: 'mock', createdAt: '2026-07-12T01:00:01.000Z', updatedAt: '2026-07-12T01:00:02.000Z' });
    store.appendAgentEvent({ eventId: 'event-a', schemaVersion: 2, type: 'run.completed', workspaceId: 'workspace-a', conversationId: 'conversation-a', runId: 'run-a', timestamp: '2026-07-12T01:00:02.000Z', payload: { status: 'completed' } });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}/api/workspaces`;
    const list = await fetch(`${base}/workspace-a/runs?conversationId=conversation-a&limit=999`).then(response => response.json()) as { runs: Array<{ id: string }> };
    assert.deepEqual(list.runs.map(run => run.id), ['run-a']);
    const details = await fetch(`${base}/workspace-a/runs/run-a`).then(response => response.json()) as { run: { resultSummary: string }; sourceMessage: { content: string }; events: Array<{ runId: string }> };
    assert.equal(details.run.resultSummary, '完成');
    assert.equal(details.sourceMessage.content, '详情');
    assert.equal(details.events[0]?.runId, 'run-a');
    assert.equal((await fetch(`${base}/workspace-b/runs/run-a`)).status, 404);
    assert.equal((await fetch(`${base}/workspace-a/runs/unknown`)).status, 404);
  } finally {
    server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('[M27-P4-T008] Task-domain Runs remain isolated from Conversation agent_runs and executions', async () => {
  const root = createRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const app = express();
  app.use('/api/workspaces/:workspaceId', createRunRoutes(store, manager));
  const server = app.listen(0);
  try {
    store.createConversation({ id: 'conversation-p4', workspaceId: 'workspace-a', type: 'direct', title: 'P4', agentId: 'codex', createdAt: '2026-07-31T00:00:00.000Z', updatedAt: '2026-07-31T00:00:00.000Z' });
    store.createMessage({ id: 'message-p4', conversationId: 'conversation-p4', workspaceId: 'workspace-a', senderType: 'user', content: 'synthetic', createdAt: '2026-07-31T00:00:01.000Z' });
    const task = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'task-domain', createdBy: 'p4' });
    const taskRun = store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id, reason: 'initial', createdBy: 'p4', origin: 'legacy_pipeline' });
    store.createRun({ id: 'conversation-run-p4', workspaceId: 'workspace-a', conversationId: 'conversation-p4', sourceMessageId: 'message-p4', objective: 'conversation', status: 'completed', createdAt: '2026-07-31T00:00:01.000Z', updatedAt: '2026-07-31T00:00:02.000Z' });

    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`;
    const list = await fetch(`${base}/runs?conversationId=conversation-p4`).then(response => response.json()) as { runs: Array<{ id: string }> };

    assert.deepEqual(list.runs.map(run => run.id), ['conversation-run-p4']);
    assert.deepEqual(store.listExecutions('workspace-a', 'conversation-p4'), []);
    assert.equal(store.runRepository().findById('workspace-a', taskRun.id)?.taskId, task.id);
  } finally {
    server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
