import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2TaskRoutes } from './v2Tasks.js';
import { createV2RunRoutes } from './v2Runs.js';
import { createTaskRoutes } from './tasks.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { TaskRunService } from '../services/TaskRunService.js';
import type { Workspace } from '@agentos/shared';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-v2-task-routes-'));
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
  workspaceBId: string;
  workspaceA: Workspace;
}

async function createFixture(): Promise<Fixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspaceA = manager.create('Workspace A', join(root, 'a'), { git: false, memory: false, readme: false, docs: false });
  const workspaceB = manager.create('Workspace B', join(root, 'b'), { git: false, memory: false, readme: false, docs: false });
  const app = express();
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, manager));
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
    workspaceBId: workspaceB.id,
    workspaceA,
  };
}

async function closeFixture(fx: Fixture): Promise<void> {
  fx.server.close();
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

async function postJson(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function createTask(baseA: string, title = 'task-one'): Promise<{ id: string; [k: string]: unknown }> {
  const response = await postJson(`${baseA}/v2/tasks`, { title });
  assert.equal(response.status, 201);
  return (await response.json() as { task: { id: string } }).task as { id: string };
}

async function bridgeCompleteTask(fx: Fixture, legacyTaskId: string): Promise<{ taskId: string; runId: string }> {
  const created = fx.service.createLegacyRunForBridge({
    workspaceId: fx.workspaceAId,
    legacyTaskId,
    title: 'bridge task',
    createdBy: 'legacy_pipeline',
    objective: 'bridge task',
    workspace: fx.workspaceA,
  });
  assert.ok(created.snapshot);
  assert.equal(created.stages.length, 4);
  assert.equal(fx.store.runStageRepository().listByRun(fx.workspaceAId, created.run.id).length, 4);
  fx.service.startRunForBridge(fx.workspaceAId, created.run.id);
  fx.service.completeRunForBridge(fx.workspaceAId, created.run.id);
  return { taskId: created.task.id, runId: created.run.id };
}

test('T68 POST v2 Task returns task_ id, open/normal defaults and version 1', async () => {
  const fx = await createFixture();
  try {
    const response = await postJson(`${fx.baseA}/v2/tasks`, { title: 'first task' });
    assert.equal(response.status, 201);
    const { task } = await response.json() as { task: { id: string; status: string; priority: string; version: number } };
    assert.ok(task.id.startsWith('task_'));
    assert.equal(task.status, 'open');
    assert.equal(task.priority, 'normal');
    assert.equal(task.version, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('T69 GET v2 Task returns the full Task', async () => {
  const fx = await createFixture();
  try {
    const created = await createTask(fx.baseA, 'readable');
    const response = await fetch(`${fx.baseA}/v2/tasks/${created.id}`);
    assert.equal(response.status, 200);
    const { task } = await response.json() as { task: Record<string, unknown> };
    assert.equal(task.id, created.id);
    assert.equal(task.title, 'readable');
    assert.equal(task.workspaceId, fx.workspaceAId);
    assert.equal(task.status, 'open');
    assert.ok(task.createdAt);
    assert.ok(task.updatedAt);
  } finally {
    await closeFixture(fx);
  }
});

test('T70 LIST v2 Tasks returns non-archived Tasks of the workspace only', async () => {
  const fx = await createFixture();
  try {
    await createTask(fx.baseA, 'a1');
    await createTask(fx.baseA, 'a2');
    await createTask(fx.baseB, 'b1');
    const response = await fetch(`${fx.baseA}/v2/tasks`);
    assert.equal(response.status, 200);
    const { tasks } = await response.json() as { tasks: Array<{ title: string }> };
    assert.equal(tasks.length, 2);
    assert.deepEqual(tasks.map(t => t.title).sort(), ['a1', 'a2']);
  } finally {
    await closeFixture(fx);
  }
});

test('T71 missing title returns TASK_TITLE_REQUIRED', async () => {
  const fx = await createFixture();
  try {
    const response = await postJson(`${fx.baseA}/v2/tasks`, { description: 'no title' });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, 'TASK_TITLE_REQUIRED');
  } finally {
    await closeFixture(fx);
  }
});

test('T72 invalid priority returns VALIDATION_FAILED', async () => {
  const fx = await createFixture();
  try {
    const response = await postJson(`${fx.baseA}/v2/tasks`, { title: 'bad priority', priority: 'urgent' });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, 'VALIDATION_FAILED');
  } finally {
    await closeFixture(fx);
  }
});

test('T73 missing workspace returns WORKSPACE_NOT_FOUND', async () => {
  const fx = await createFixture();
  try {
    const base = fx.baseA.replace(fx.workspaceAId, 'ws_missing');
    const response = await postJson(`${base}/v2/tasks`, { title: 'nowhere' });
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { code: string }).code, 'WORKSPACE_NOT_FOUND');
  } finally {
    await closeFixture(fx);
  }
});

test('T74 cross-workspace Task access returns TASK_NOT_FOUND', async () => {
  const fx = await createFixture();
  try {
    const created = await createTask(fx.baseA);
    const response = await fetch(`${fx.baseB}/v2/tasks/${created.id}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { code: string }).code, 'TASK_NOT_FOUND');
  } finally {
    await closeFixture(fx);
  }
});

test('T75 POST v2 Run initial returns queued with parent null and root self', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA);
    const response = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, {});
    assert.equal(response.status, 201);
    const { run } = await response.json() as { run: Record<string, unknown> };
    assert.equal(run.status, 'queued');
    assert.equal(run.parentRunId, undefined);
    assert.equal(run.rootRunId, run.id);
    assert.equal(run.reason, 'initial');
    assert.equal(run.origin, 'v2_api');
    assert.equal((run.id as string).startsWith('run_'), true);
  } finally {
    await closeFixture(fx);
  }
});

test('T78 LIST v2 Runs returns a stable createdAt/id order', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA);
    const first = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, {});
    const run1 = (await first.json() as { run: { id: string } }).run;
    await fetch(`${fx.baseA}/v2/runs/${run1.id}/cancel`, { method: 'POST' });
    const second = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, { reason: 'retry', parentRunId: run1.id });
    const run2 = (await second.json() as { run: { id: string } }).run;
    const response = await fetch(`${fx.baseA}/v2/tasks/${task.id}/runs`);
    assert.equal(response.status, 200);
    const { runs } = await response.json() as { runs: Array<{ id: string; createdAt: string }> };
    assert.deepEqual(runs.map(r => r.id), [run1.id, run2.id]);
    const again = await (await fetch(`${fx.baseA}/v2/tasks/${task.id}/runs`)).json() as { runs: Array<{ id: string }> };
    assert.deepEqual(again.runs.map(r => r.id), [run1.id, run2.id]);
  } finally {
    await closeFixture(fx);
  }
});

test('T79 invalid reason returns VALIDATION_FAILED', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA);
    const response = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, { reason: 'rerun' });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, 'VALIDATION_FAILED');
  } finally {
    await closeFixture(fx);
  }
});

test('T80 parentRunId mismatching the reason or another Task is rejected', async () => {
  const fx = await createFixture();
  try {
    const taskA = await createTask(fx.baseA, 'a');
    const taskB = await createTask(fx.baseA, 'b');
    const runAResponse = await postJson(`${fx.baseA}/v2/tasks/${taskA.id}/runs`, {});
    const runA = (await runAResponse.json() as { run: { id: string } }).run;
    await fetch(`${fx.baseA}/v2/runs/${runA.id}/cancel`, { method: 'POST' });

    const crossTask = await postJson(`${fx.baseA}/v2/tasks/${taskB.id}/runs`, { reason: 'retry', parentRunId: runA.id });
    assert.equal(crossTask.status, 404);
    assert.equal((await crossTask.json() as { code: string }).code, 'PARENT_RUN_NOT_FOUND');

    const badCombo = await postJson(`${fx.baseA}/v2/tasks/${taskB.id}/runs`, { reason: 'initial', parentRunId: runA.id });
    assert.equal(badCombo.status, 400);
    assert.equal((await badCombo.json() as { code: string }).code, 'VALIDATION_FAILED');

    const missingParent = await postJson(`${fx.baseA}/v2/tasks/${taskB.id}/runs`, { reason: 'retry' });
    assert.equal(missingParent.status, 400);
    assert.equal((await missingParent.json() as { code: string }).code, 'VALIDATION_FAILED');
  } finally {
    await closeFixture(fx);
  }
});

test('T81 retry via API creates a new Run with the correct parent/root chain', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA);
    const firstResponse = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, {});
    const run1 = (await firstResponse.json() as { run: { id: string; rootRunId: string } }).run;
    await fetch(`${fx.baseA}/v2/runs/${run1.id}/cancel`, { method: 'POST' });
    const retryResponse = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, { reason: 'retry', parentRunId: run1.id });
    assert.equal(retryResponse.status, 201);
    const { run } = await retryResponse.json() as { run: Record<string, unknown> };
    assert.equal(run.reason, 'retry');
    assert.equal(run.parentRunId, run1.id);
    assert.equal(run.rootRunId, run1.rootRunId);
    assert.notEqual(run.id, run1.id);
  } finally {
    await closeFixture(fx);
  }
});

test('T82 creating a second Run while one is active returns RUN_ACTIVE_EXISTS', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA);
    await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, {});
    const response = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, {});
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'RUN_ACTIVE_EXISTS');
  } finally {
    await closeFixture(fx);
  }
});

test('T86 accepting a completed Run returns a done Task with acceptance fields', async () => {
  const fx = await createFixture();
  try {
    const { taskId, runId } = await bridgeCompleteTask(fx, 'L1');
    const response = await postJson(`${fx.baseA}/v2/tasks/${taskId}/accept`, { runId });
    assert.equal(response.status, 200);
    const { task } = await response.json() as { task: Record<string, unknown> };
    assert.equal(task.status, 'done');
    assert.equal(task.acceptedRunId, runId);
    assert.equal(task.pendingResultRunId, undefined);
    assert.ok(task.completedAt);
  } finally {
    await closeFixture(fx);
  }
});

test('T87 accepting a non-completed Run returns RUN_NOT_COMPLETED', async () => {
  const fx = await createFixture();
  try {
    const { taskId } = await bridgeCompleteTask(fx, 'L1');
    const retry = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceAId, legacyTaskId: 'L1', title: 'bridge task', createdBy: 'legacy_pipeline', objective: 'bridge task',
      workspace: fx.workspaceA,
    });
    const response = await postJson(`${fx.baseA}/v2/tasks/${taskId}/accept`, { runId: retry.run.id });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'RUN_NOT_COMPLETED');
  } finally {
    await closeFixture(fx);
  }
});

test('T88 cancelling a Task without an active Run writes cancelled', async () => {
  const fx = await createFixture();
  try {
    const { taskId } = await bridgeCompleteTask(fx, 'L1');
    const response = await postJson(`${fx.baseA}/v2/tasks/${taskId}/cancel`);
    assert.equal(response.status, 200);
    const { task } = await response.json() as { task: Record<string, unknown> };
    assert.equal(task.status, 'cancelled');
    assert.equal(task.pendingResultRunId, undefined);
  } finally {
    await closeFixture(fx);
  }
});

test('T89 creating a Run on a cancelled Task returns TASK_CANCELLED', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA);
    await postJson(`${fx.baseA}/v2/tasks/${task.id}/cancel`);
    const response = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, {});
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'TASK_CANCELLED');
  } finally {
    await closeFixture(fx);
  }
});

test('T90 reopening a Task restores open and allows creating a Run again', async () => {
  const fx = await createFixture();
  try {
    const { taskId, runId } = await bridgeCompleteTask(fx, 'L1');
    await postJson(`${fx.baseA}/v2/tasks/${taskId}/accept`, { runId });
    const reopened = await postJson(`${fx.baseA}/v2/tasks/${taskId}/reopen`);
    assert.equal(reopened.status, 200);
    assert.equal((await reopened.json() as { task: { status: string } }).task.status, 'open');
    const runResponse = await postJson(`${fx.baseA}/v2/tasks/${taskId}/runs`, {});
    assert.equal(runResponse.status, 201);
  } finally {
    await closeFixture(fx);
  }
});

const FORBIDDEN_ERROR_PATTERNS = [/SQLITE/i, /constraint failed/i, /agentos\.sqlite/i, /\\workspace\\|\/workspace\//i, /\bat\s+[\w.]+\s+\(/];

test('T91 internal errors are sanitized and never leak SQLite, path or stack details', async () => {
  const fx = await createFixture();
  try {
    fx.store.close();
    const response = await fetch(`${fx.baseA}/v2/tasks`);
    assert.equal(response.status, 500);
    const body = await response.json() as { error: string; code: string };
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.error, 'Internal server error');
    const raw = JSON.stringify(body);
    for (const pattern of FORBIDDEN_ERROR_PATTERNS) {
      assert.ok(!pattern.test(raw), `response must not match ${pattern}`);
    }
    fx.store = undefined as unknown as SqliteStore;
  } finally {
    fx.server.close();
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('T92 v2 Task/Run endpoints exist only under /api/workspaces/:workspaceId/v2/**', async () => {
  const fx = await createFixture();
  try {
    const v2Task = await createTask(fx.baseA, 'v2-only');
    const legacyList = await (await fetch(`${fx.baseA}/tasks`)).json() as { tasks: unknown[] };
    assert.deepEqual(legacyList.tasks, []);
    const legacyStatus = await fetch(`${fx.baseA}/tasks/${v2Task.id}/status`);
    assert.equal(legacyStatus.status, 404);
    const legacyCreate = await postJson(`${fx.baseA}/tasks`, { title: 'legacy-item' });
    assert.equal(legacyCreate.status, 201);
    const legacyTask = (await legacyCreate.json() as { task: { id: string; status: string } }).task;
    assert.equal(legacyTask.id.length, 8);
    assert.equal(legacyTask.status, 'pending');
    const v2Run404 = await fetch(`${fx.baseA}/runs/${v2Task.id}`);
    assert.notEqual(v2Run404.status, 200);
  } finally {
    await closeFixture(fx);
  }
});
