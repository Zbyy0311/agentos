import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createRuntimeInspectorRoutes } from './runtimeInspector.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-inspector-route-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
      agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
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
    app.use('/api/workspaces/:workspaceId/runtime', createRuntimeInspectorRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/workspaces/workspace-a/runtime`, store);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('GET /runs/:runId/inspector returns the redacted projection for a canonical Run', async () => {
  await withServer(async (baseUrl, store) => {
    const task = store.taskRepository().insert({ workspaceId: 'workspace-a', title: 'T', createdBy: 'user' });
    const run = store.runRepository().insert({ workspaceId: 'workspace-a', taskId: task.id, origin: 'v2_api', createdBy: 'user' });
    const response = await fetch(`${baseUrl}/runs/${run.id}/inspector`);
    assert.equal(response.status, 200);
    const body = await response.json() as { projection: { overview: { runId: string; status: string }; stages: unknown[]; events: unknown[]; highWatermark: number } };
    assert.equal(body.projection.overview.runId, run.id);
    assert.equal(body.projection.overview.status, 'queued');
    assert.ok(Array.isArray(body.projection.stages));
    assert.ok(Array.isArray(body.projection.events));
  });
});

test('GET /runs/:runId/inspector fails closed for an unknown Run and workspace', async () => {
  await withServer(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/runs/run_missing/inspector`);
    assert.equal(missing.status, 404);
  });
});
