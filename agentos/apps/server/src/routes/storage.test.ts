import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { createStorageRoutes } from './storage.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { RuntimeArtifactService } from '../services/RuntimeArtifactService.js';

test('retention apply requires the same short-lived preview selection and is one-shot', async () => {
  const app = express();
  app.use(express.json());
  const workspaceManager = { get: (id: string) => id === 'workspace-a' ? { id, rootPath: process.cwd() } : undefined };
  app.use('/api/workspaces/:workspaceId', createStorageRoutes(workspaceManager as never, process.cwd()));
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const base = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`;
    const previewResponse = await fetch(`${base}/retention/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection: ['run-1'] }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { token: string };
    const mismatch = await fetch(`${base}/retention/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: preview.token, selection: ['run-2'] }),
    });
    assert.equal(mismatch.status, 409);
    const applied = await fetch(`${base}/retention/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: preview.token, selection: ['run-1'] }),
    });
    assert.equal(applied.status, 200);
    assert.equal((await applied.json()).dryRun, true);
    const replay = await fetch(`${base}/retention/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: preview.token, selection: ['run-1'] }),
    });
    assert.equal(replay.status, 409);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('retention preview reports terminal run bytes and apply removes selected run artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-retention-route-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
    agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
    lastOpenedAt: '2026-07-17T00:00:00.000Z', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  }] }), 'utf8');
  const store = new SqliteStore(root);
  const artifactService = new RuntimeArtifactService(store, root);
  const now = '2026-07-17T00:00:00.000Z';
  store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Retention', agentId: 'codex', createdAt: now, updatedAt: now });
  store.createMessage({ id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user', content: 'retention', createdAt: now });
  store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: 'retention', status: 'completed', createdAt: now, updatedAt: now });
  store.createExecution({ id: 'execution-a', runId: 'run-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-a', agentId: 'codex', status: 'completed', mode: 'mock', createdAt: now, updatedAt: now });
  const artifact = await artifactService.create({
    workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex',
    type: 'report', title: 'report.md', source: { kind: 'text', content: 'retained bytes' },
  });
  const workspaceManager = { get: (id: string) => id === 'workspace-a' ? { id, rootPath: root } : undefined };
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId', createStorageRoutes(workspaceManager as never, root, store, artifactService));
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const base = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`;
    const previewResponse = await fetch(`${base}/retention/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection: ['run-a'] }),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as { token: string; bytes: number };
    assert.equal(preview.bytes, artifact.sizeBytes);
    const applied = await fetch(`${base}/retention/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: preview.token, selection: ['run-a'] }),
    });
    assert.equal(applied.status, 200);
    assert.deepEqual(await applied.json(), { workspaceId: 'workspace-a', selection: ['run-a'], deletedRuns: 1, deletedArtifacts: 1, bytes: artifact.sizeBytes, dryRun: false });
    assert.equal(store.getRun('workspace-a', 'run-a'), undefined);
    assert.equal(store.listRuntimeArtifacts('workspace-a', 'run-a').length, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
