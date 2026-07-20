import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createMemoryCandidateRoutes } from './memoryCandidates.js';
import { createMemoryRoutes } from './memories.js';

test('generates, accepts, rejects, and isolates memory candidates through the API', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-candidate-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    { id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
    { id: 'workspace-b', name: 'B', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
  ] }), 'utf8');
  const store = new SqliteStore(root);
  store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'A', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
  store.createMessage({ id: 'message-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', senderType: 'user', content: '记录决策', createdAt: '2026-07-12T01:00:01.000Z' });
  store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: '记录决策', status: 'completed', resultSummary: '<!-- agentos-memory-candidate: {"type":"decision","title":"API 决策","summary":"保持兼容","content":"保持旧 API 兼容。","confidence":90} -->', createdAt: '2026-07-12T01:00:01.000Z', updatedAt: '2026-07-12T01:00:02.000Z', completedAt: '2026-07-12T01:00:02.000Z' });
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId', createMemoryCandidateRoutes(store, new WorkspaceManager(store)));
  app.use('/api/workspaces/:workspaceId', createMemoryRoutes(store, new WorkspaceManager(store)));
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('bind failed');
    const base = `http://127.0.0.1:${address.port}/api/workspaces`;
    const generatedResponse = await fetch(`${base}/workspace-a/runs/run-a/memory-candidates/generate`, { method: 'POST' });
    assert.equal(generatedResponse.status, 201);
      const generated = await generatedResponse.json() as { candidates: Array<{ id: string }>; outcome: string };
      assert.equal(generated.candidates.length, 1);
      assert.equal(generated.outcome, 'created');
    assert.equal((await fetch(`${base}/workspace-b/memory-candidates`)).status, 200);
    const acceptedResponse = await fetch(`${base}/workspace-a/memory-candidates/${generated.candidates[0]!.id}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'API 决策（确认）' }) });
    assert.equal(acceptedResponse.status, 200);
    assert.equal((await fetch(`${base}/workspace-a/memory-candidates/${generated.candidates[0]!.id}/reject`, { method: 'POST' })).status, 409);
    const memories = await fetch(`${base}/workspace-a/memories`).then(response => response.json()) as { memories: Array<{ title: string }> };
    assert.deepEqual(memories.memories.map(memory => memory.title), ['API 决策（确认）']);
  } finally {
    server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('returns an explicit none outcome when a completed run has no valuable public evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-candidate-none-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    { id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
  ] }), 'utf8');
  const store = new SqliteStore(root);
  store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'A', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
  store.createMessage({ id: 'message-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', senderType: 'user', content: '完成任务', createdAt: '2026-07-12T01:00:01.000Z' });
  store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: '完成任务', status: 'completed', resultSummary: '已完成', createdAt: '2026-07-12T01:00:01.000Z', updatedAt: '2026-07-12T01:00:02.000Z', completedAt: '2026-07-12T01:00:02.000Z' });
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId', createMemoryCandidateRoutes(store, new WorkspaceManager(store)));
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('bind failed');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workspaces/workspace-a/runs/run-a/memory-candidates/generate`, { method: 'POST' });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { candidates: [], outcome: 'none', reason: 'no_valuable_public_evidence' });
  } finally {
    server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
