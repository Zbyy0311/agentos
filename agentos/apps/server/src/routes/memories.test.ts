import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createMemoryRoutes } from './memories.js';

test('supports memory CRUD, archive, search, and workspace isolation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-memory-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    { id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
    { id: 'workspace-b', name: 'B', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
  ] }), 'utf8');
  const store = new SqliteStore(root);
  const app = express(); app.use(express.json()); app.use('/api/workspaces/:workspaceId', createMemoryRoutes(store, new WorkspaceManager(store)));
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('bind failed');
    const base = `http://127.0.0.1:${address.port}/api/workspaces`;
    const created = await fetch(`${base}/workspace-a/memories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'experience', title: '部署经验', summary: '经验摘要', content: '先构建再部署', tags: ['deploy'] }) }).then(response => response.json()) as { memory: { id: string } };
    assert.ok(created.memory.id);
    assert.equal((await fetch(`${base}/workspace-a/memories?query=部署`)).status, 200);
    assert.equal((await fetch(`${base}/workspace-b/memories/${created.memory.id}`)).status, 404);
    assert.equal((await fetch(`${base}/workspace-a/memories/${created.memory.id}/archive`, { method: 'POST' })).status, 200);
    const active = await fetch(`${base}/workspace-a/memories`).then(response => response.json()) as { memories: unknown[] };
    assert.deepEqual(active.memories, []);
  } finally { server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
