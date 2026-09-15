import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

test('LITE-07-012/LITE-10-016 legacy Memory rejects unsafe writes and hides unsafe historical text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-memory-safety-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    { id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
  ] }), 'utf8');
  const store = new SqliteStore(root);
  const app = express(); app.use(express.json()); app.use('/api/workspaces/:workspaceId', createMemoryRoutes(store, new WorkspaceManager(store)));
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('bind failed');
    const base = `http://127.0.0.1:${address.port}/api/workspaces`;
    const rejected = await fetch(`${base}/workspace-a/memories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'experience', title: 'unsafe', summary: 'unsafe summary', content: 'Authorization: Bearer legacy-secret' }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { error: 'Memory content is unsafe to persist' });
    assert.equal((store.getDatabase().prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n, 0);
    assert.equal((store.getDatabase().prepare('SELECT COUNT(*) AS n FROM memory_fts').get() as { n: number }).n, 0);
    assert.equal(existsSync(join(root, 'agent-memory')), false, 'unsafe content must be rejected before file creation');

    const safeResponse = await fetch(`${base}/workspace-a/memories`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'experience', title: 'safe', summary: 'safe summary', content: 'ordinary content' }),
    });
    const safe = await safeResponse.json() as { memory: { id: string; contentPath: string } };
    assert.equal(safeResponse.status, 201);
    writeFileSync(join(root, safe.memory.contentPath), 'Authorization: Bearer historical-secret', 'utf8');
    store.getDatabase().prepare('UPDATE memory_fts SET content = ? WHERE memory_id = ?')
      .run('Authorization: Bearer historical-secret', safe.memory.id);

    const listed = await fetch(`${base}/workspace-a/memories`).then(response => response.json()) as { memories: unknown[] };
    assert.deepEqual(listed.memories, []);
    assert.equal((await fetch(`${base}/workspace-a/memories/${safe.memory.id}`)).status, 404);
  } finally { server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
