import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2RunRoutes } from './v2Runs.js';
import { createV2TaskRoutes } from './v2Tasks.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { TaskRunService } from '../services/TaskRunService.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-v2-run-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  return root;
}

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof app.listen>; base: string }> {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
  return { server, base: `http://127.0.0.1:${address.port}/api/workspaces` };
}

interface Fixture {
  root: string;
  store: SqliteStore;
  service: TaskRunService;
  server: ReturnType<express.Express['listen']>;
  baseA: string;
  baseB: string;
  workspaceAId: string;
}

async function createFixture(): Promise<Fixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspaceA = manager.create('Workspace A', join(root, 'a'), { git: false, memory: false, readme: false, docs: false });
  const workspaceB = manager.create('Workspace B', join(root, 'b'), { git: false, memory: false, readme: false, docs: false });
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(store, manager));
  const { server, base } = await listen(app);
  return {
    root,
    store,
    service: new TaskRunService(store),
    server,
    baseA: `${base}/${workspaceA.id}`,
    baseB: `${base}/${workspaceB.id}`,
    workspaceAId: workspaceA.id,
  };
}

async function closeFixture(fx: Fixture): Promise<void> {
  fx.server.close();
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

async function createTaskViaApi(baseA: string, title = 'task'): Promise<string> {
  const response = await fetch(`${baseA}/v2/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 201);
  return (await response.json() as { task: { id: string } }).task.id;
}

async function createRunViaApi(baseA: string, taskId: string): Promise<string> {
  const response = await fetch(`${baseA}/v2/tasks/${taskId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 201);
  return (await response.json() as { run: { id: string } }).run.id;
}

test('T76 GET v2 Run returns failureCode/failureMessage and the full Run', async () => {
  const fx = await createFixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceAId,
      legacyTaskId: 'L1',
      title: 'bridge task',
      createdBy: 'legacy_pipeline',
      objective: 'bridge objective',
    });
    fx.service.startRunForBridge(fx.workspaceAId, created.run.id);
    fx.service.failRunForBridge(fx.workspaceAId, created.run.id, 'worker exploded');

    const response = await fetch(`${fx.baseA}/v2/runs/${created.run.id}`);
    assert.equal(response.status, 200);
    const { run } = await response.json() as { run: Record<string, unknown> };
    assert.equal(run.id, created.run.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.failureCode, 'LEGACY_PIPELINE_FAILED');
    assert.equal(run.failureMessage, 'worker exploded');
    assert.equal(run.taskId, created.task.id);
    assert.equal(run.workspaceId, fx.workspaceAId);
    assert.equal(run.origin, 'legacy_pipeline');
    assert.equal(run.objective, 'bridge objective');
    assert.ok(run.createdAt);
    assert.ok(run.completedAt);
    assert.equal(run.version, 3);
  } finally {
    await closeFixture(fx);
  }
});

test('T77 cross-workspace Run access returns RUN_NOT_FOUND', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA);
    const runId = await createRunViaApi(fx.baseA, taskId);
    const response = await fetch(`${fx.baseB}/v2/runs/${runId}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { code: string }).code, 'RUN_NOT_FOUND');
  } finally {
    await closeFixture(fx);
  }
});

test('T83 cancelling a queued v2 Run succeeds and releases the active slot', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA);
    const runId = await createRunViaApi(fx.baseA, taskId);
    const cancel = await fetch(`${fx.baseA}/v2/runs/${runId}/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 200);
    const { run } = await cancel.json() as { run: Record<string, unknown> };
    assert.equal(run.status, 'cancelled');
    assert.ok(run.cancellationRequestedAt);

    const nextRunId = await createRunViaApi(fx.baseA, taskId);
    assert.ok(nextRunId);
  } finally {
    await closeFixture(fx);
  }
});

test('T84 cancelling a running Run returns 409 RUN_NOT_CANCELLABLE', async () => {
  const fx = await createFixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceAId, legacyTaskId: 'L1', title: 'bridge', createdBy: 'legacy_pipeline', objective: 'bridge',
    });
    fx.service.startRunForBridge(fx.workspaceAId, created.run.id);
    const response = await fetch(`${fx.baseA}/v2/runs/${created.run.id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'RUN_NOT_CANCELLABLE');
  } finally {
    await closeFixture(fx);
  }
});

test('T85 cancelling a terminal Run returns 409 RUN_NOT_CANCELLABLE', async () => {
  const fx = await createFixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceAId, legacyTaskId: 'L1', title: 'bridge', createdBy: 'legacy_pipeline', objective: 'bridge',
    });
    fx.service.startRunForBridge(fx.workspaceAId, created.run.id);
    fx.service.completeRunForBridge(fx.workspaceAId, created.run.id);
    const response = await fetch(`${fx.baseA}/v2/runs/${created.run.id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'RUN_NOT_CANCELLABLE');
  } finally {
    await closeFixture(fx);
  }
});
