import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2TaskRoutes, respondV2 } from './v2Tasks.js';
import { createV2RunRoutes } from './v2Runs.js';
import { createTaskRoutes } from './tasks.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { TaskRunService, type TaskRunServiceDeps } from '../services/TaskRunService.js';
import { IdempotencyService } from '../services/IdempotencyService.js';
import { createOptionalIdempotencyService } from './v2Idempotency.js';
import type { Workspace } from '@agentos/shared';
import { AgentNotAvailableError, ProviderConfigNotAvailableError, RunSnapshotFailedError } from '../services/SnapshotService.js';
import { WorkflowNotAvailableError } from '../services/WorkflowDefinitionResolver.js';
import { hashNormalizedIdempotencyKey } from '../idempotency/fingerprint.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-v2-task-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  return root;
}

function isFetchBadPortError(error: unknown): boolean {
  return (error as { cause?: { message?: unknown } } | null)?.cause?.message === 'bad port';
}

async function closeTestServer(server: ReturnType<express.Express['listen']>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function listenOnFetchSafePort(app: express.Express): Promise<{ server: ReturnType<typeof app.listen>; base: string }> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
      const base = `http://127.0.0.1:${address.port}/api/workspaces`;
      const probe = await fetch(`http://127.0.0.1:${address.port}/__test_fetch_port_probe`, { method: 'HEAD' });
      if (probe.status !== 204) throw new Error(`test fetch probe returned ${probe.status}`);
      return { server, base };
    } catch (error) {
      await closeTestServer(server);
      if (!isFetchBadPortError(error)) throw error;
    }
  }
  throw new Error('TEST_FETCH_SAFE_PORT_UNAVAILABLE');
}

interface Fixture {
  root: string;
  store: SqliteStore;
  manager: WorkspaceManager;
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
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(store, manager));
  const { server, base } = await listenOnFetchSafePort(app);
  return {
    root,
    store,
    manager,
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
  await closeTestServer(fx.server);
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

function responseProbe(): { response: Response; state: { status: number; body: unknown } } {
  const state = { status: 0, body: undefined as unknown };
  const response = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  } as unknown as Response;
  return { response, state };
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
    await closeTestServer(fx.server);
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

test('P4 v2 error boundary maps four snapshot-related codes to stable safe responses', () => {
  const cases = [
    [new AgentNotAvailableError(), 409, 'Agent is not available'],
    [new ProviderConfigNotAvailableError(), 409, 'Provider configuration is not available'],
    [new WorkflowNotAvailableError('secret-workflow-literal'), 409, 'Workflow is not available'],
    [new RunSnapshotFailedError('secret-snapshot-literal'), 500, 'Run snapshot creation failed'],
  ] as const;
  for (const [error, expectedStatus, expectedMessage] of cases) {
    const probe = responseProbe();
    respondV2(probe.response as never, () => { throw error; });
    assert.equal(probe.state.status, expectedStatus);
    assert.deepEqual(probe.state.body, { error: expectedMessage, code: error.code });
    assert.doesNotMatch(JSON.stringify(probe.state.body), /secret-(workflow|snapshot)-literal/);
  }
});

test('P4 disabled unbound Workflow returns WORKFLOW_NOT_AVAILABLE without raw definition details', async () => {
  const fx = await createFixture();
  try {
    fx.store.getDatabase().prepare("UPDATE workflow_definitions SET enabled = 0 WHERE definition_key = 'unbound-task-run'").run();
    const task = await createTask(fx.baseA, 'disabled workflow');
    const response = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, {});
    assert.equal(response.status, 409);
    const body = await response.json() as { error: string; code: string };
    assert.deepEqual(body, { error: 'Workflow is not available', code: 'WORKFLOW_NOT_AVAILABLE' });
    assert.doesNotMatch(JSON.stringify(body), /unbound-task-run|SQLITE|workspace/);
  } finally {
    await closeFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// M2.6 P3 — Route idempotency integration (R01–R25; R08 lives in v2Runs.test.ts)
// ---------------------------------------------------------------------------

function idempotencyRecordCount(store: SqliteStore): number {
  return (store.getDatabase().prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }).count;
}

function idempotencyRecordsDump(store: SqliteStore): string {
  const rows = store.getDatabase().prepare('SELECT * FROM idempotency_records').all();
  return JSON.stringify(rows);
}

async function postJsonWithKey(url: string, body: unknown, key?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

interface RawHttpResult {
  status: number;
  body: string;
}

async function postRawHttp(urlString: string, payload: unknown, headers: Record<string, string | string[]>): Promise<RawHttpResult> {
  const url = new URL(urlString);
  const bodyText = JSON.stringify(payload ?? {});
  return new Promise<RawHttpResult>((resolve, reject) => {
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText),
          ...headers,
        },
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    request.on('error', reject);
    request.write(bodyText);
    request.end();
  });
}

test('R01 POST task without a key keeps the existing 201 contract', async () => {
  const fx = await createFixture();
  try {
    const response = await postJson(`${fx.baseA}/v2/tasks`, { title: 'r01' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('idempotency-replayed'), null);
    const { task } = await response.json() as { task: { id: string } };
    assert.ok(task.id.startsWith('task_'));
    assert.equal(idempotencyRecordCount(fx.store), 0);
  } finally {
    await closeFixture(fx);
  }
});

test('R02 POST task with the same key and body returns the same task id', async () => {
  const fx = await createFixture();
  try {
    const first = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r02' }, 'r02-key-0001');
    assert.equal(first.status, 201);
    const firstTask = (await first.json() as { task: { id: string } }).task;
    const second = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r02' }, 'r02-key-0001');
    const secondTask = (await second.json() as { task: { id: string } }).task;
    assert.equal(secondTask.id, firstTask.id);
  } finally {
    await closeFixture(fx);
  }
});

test('R03 a task replay sets the Idempotency-Replayed header to true', async () => {
  const fx = await createFixture();
  try {
    await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r03' }, 'r03-key-0001');
    const replay = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r03' }, 'r03-key-0001');
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  } finally {
    await closeFixture(fx);
  }
});

test('R04 the first task response has no replay header', async () => {
  const fx = await createFixture();
  try {
    const first = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r04' }, 'r04-key-0001');
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('idempotency-replayed'), null);
  } finally {
    await closeFixture(fx);
  }
});

test('R05 the same key with a different task body returns 409 IDEMPOTENCY_KEY_REUSED', async () => {
  const fx = await createFixture();
  try {
    await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r05-a' }, 'r05-key-0001');
    const conflict = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r05-b' }, 'r05-key-0001');
    assert.equal(conflict.status, 409);
    assert.equal(conflict.headers.get('idempotency-replayed'), null);
    const body = await conflict.json() as { error: string; code: string };
    assert.deepEqual(body, {
      error: 'Idempotency key was already used with a different request',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  } finally {
    await closeFixture(fx);
  }
});

test('R06 POST run with the same key replays the same run id', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA, 'r06');
    const first = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/runs`, {}, 'r06-key-0001');
    assert.equal(first.status, 201);
    const firstRun = (await first.json() as { run: { id: string } }).run;
    const second = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/runs`, {}, 'r06-key-0001');
    assert.equal(second.status, 201);
    assert.equal(second.headers.get('idempotency-replayed'), 'true');
    const secondRun = (await second.json() as { run: { id: string } }).run;
    assert.equal(secondRun.id, firstRun.id);
  } finally {
    await closeFixture(fx);
  }
});

test('R07 run create replay is evaluated before RUN_ACTIVE_EXISTS', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA, 'r07');
    const first = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/runs`, {}, 'r07-key-0001');
    assert.equal(first.status, 201);
    const firstRun = (await first.json() as { run: { id: string } }).run;
    // The first run is still active; without idempotency this would be a 409 RUN_ACTIVE_EXISTS.
    const replay = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/runs`, {}, 'r07-key-0001');
    assert.equal(replay.status, 201);
    const replayRun = (await replay.json() as { run: { id: string } }).run;
    assert.equal(replayRun.id, firstRun.id);
    // A different key with the same task still hits the active-run guard.
    const conflict = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/runs`, {}, 'r07-key-0002');
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { code: string }).code, 'RUN_ACTIVE_EXISTS');
  } finally {
    await closeFixture(fx);
  }
});

test('R09 task accept replay is evaluated before the acceptance guard', async () => {
  const fx = await createFixture();
  try {
    const { taskId, runId } = await bridgeCompleteTask(fx, 'r09-legacy');
    const first = await postJsonWithKey(`${fx.baseA}/v2/tasks/${taskId}/accept`, { runId }, 'r09-key-0001');
    assert.equal(first.status, 200);
    // The acceptance window is consumed; without idempotency this would be a 409.
    const replay = await postJsonWithKey(`${fx.baseA}/v2/tasks/${taskId}/accept`, { runId }, 'r09-key-0001');
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    const firstBody = await first.json() as { task: { id: string; status: string } };
    const replayBody = await replay.json() as { task: { id: string; status: string } };
    assert.deepEqual(replayBody, firstBody);
  } finally {
    await closeFixture(fx);
  }
});

test('R10 task cancel replay is evaluated before the transition guard', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA, 'r10');
    const first = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/cancel`, {}, 'r10-key-0001');
    assert.equal(first.status, 200);
    const replay = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/cancel`, {}, 'r10-key-0001');
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    // A different key still hits the transition guard.
    const conflict = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/cancel`, {}, 'r10-key-0002');
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { code: string }).code, 'INVALID_TASK_TRANSITION');
  } finally {
    await closeFixture(fx);
  }
});

test('R11 task reopen replay is evaluated before the transition guard', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA, 'r11');
    await postJson(`${fx.baseA}/v2/tasks/${task.id}/cancel`, {});
    const first = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/reopen`, {}, 'r11-key-0001');
    assert.equal(first.status, 200);
    const replay = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/reopen`, {}, 'r11-key-0001');
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    const conflict = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/reopen`, {}, 'r11-key-0002');
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { code: string }).code, 'INVALID_TASK_TRANSITION');
  } finally {
    await closeFixture(fx);
  }
});

test('R12 the same key in different workspaces does not conflict', async () => {
  const fx = await createFixture();
  try {
    const first = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r12' }, 'r12-key-0001');
    const second = await postJsonWithKey(`${fx.baseB}/v2/tasks`, { title: 'r12' }, 'r12-key-0001');
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.headers.get('idempotency-replayed'), null);
    const firstTask = (await first.json() as { task: { id: string } }).task;
    const secondTask = (await second.json() as { task: { id: string } }).task;
    assert.notEqual(firstTask.id, secondTask.id);
    assert.equal(idempotencyRecordCount(fx.store), 2);
  } finally {
    await closeFixture(fx);
  }
});

test('R13 a failed request does not poison the key', async () => {
  const fx = await createFixture();
  try {
    const task = await createTask(fx.baseA, 'r13');
    const blocker = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, {});
    assert.equal(blocker.status, 201);
    const blockerRun = (await blocker.json() as { run: { id: string } }).run;
    const failed = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/runs`, {}, 'r13-key-0001');
    assert.equal(failed.status, 409);
    assert.equal((await failed.json() as { code: string }).code, 'RUN_ACTIVE_EXISTS');
    assert.equal(idempotencyRecordCount(fx.store), 0);
    const cancel = await postJson(`${fx.baseA}/v2/runs/${blockerRun.id}/cancel`, {});
    assert.equal(cancel.status, 200);
    const retry = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/runs`, {}, 'r13-key-0001');
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get('idempotency-replayed'), null);
    assert.equal(idempotencyRecordCount(fx.store), 1);
  } finally {
    await closeFixture(fx);
  }
});

test('R14 records survive router recreation and still replay', async () => {
  const fx = await createFixture();
  let secondServer: ReturnType<express.Express['listen']> | undefined;
  try {
    const first = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r14' }, 'r14-key-0001');
    assert.equal(first.status, 201);
    const firstTask = (await first.json() as { task: { id: string } }).task;
    const secondApp = express();
    secondApp.use(express.json());
    secondApp.head('/__test_fetch_port_probe', (_req, res) => {
      res.setHeader('Connection', 'close');
      res.status(204).end();
    });
    secondApp.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(fx.store, fx.manager));
    const second = await listenOnFetchSafePort(secondApp);
    secondServer = second.server;
    const replay = await postJsonWithKey(`${second.base}/${fx.workspaceAId}/v2/tasks`, { title: 'r14' }, 'r14-key-0001');
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    const replayTask = (await replay.json() as { task: { id: string } }).task;
    assert.equal(replayTask.id, firstTask.id);
  } finally {
    if (secondServer) await closeTestServer(secondServer);
    await closeFixture(fx);
  }
});

test('R15 live and replay response bodies are deep equal', async () => {
  const fx = await createFixture();
  try {
    const live = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r15', priority: 'high' }, 'r15-key-0001');
    const liveBody = await live.json();
    const replay = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r15', priority: 'high' }, 'r15-key-0001');
    const replayBody = await replay.json();
    assert.deepEqual(replayBody, liveBody);
  } finally {
    await closeFixture(fx);
  }
});

test('R16 a replay preserves the first-result http status', async () => {
  const fx = await createFixture();
  try {
    const created = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r16' }, 'r16-key-0001');
    assert.equal(created.status, 201);
    const replayCreate = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r16' }, 'r16-key-0001');
    assert.equal(replayCreate.status, 201);
    const task = (await created.json() as { task: { id: string } }).task;
    const cancelled = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/cancel`, {}, 'r16-key-0002');
    assert.equal(cancelled.status, 200);
    const replayCancel = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/cancel`, {}, 'r16-key-0002');
    assert.equal(replayCancel.status, 200);
  } finally {
    await closeFixture(fx);
  }
});

test('R17 repeated replays keep exactly one idempotency record', async () => {
  const fx = await createFixture();
  try {
    await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r17' }, 'r17-key-0001');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r17' }, 'r17-key-0001');
      assert.equal(replay.status, 201);
    }
    assert.equal(idempotencyRecordCount(fx.store), 1);
  } finally {
    await closeFixture(fx);
  }
});

test('R18 the raw idempotency key is never persisted', async () => {
  const fx = await createFixture();
  try {
    const rawKey = 'r18-raw-secret-key-0001';
    const response = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r18' }, rawKey);
    assert.equal(response.status, 201);
    const dump = idempotencyRecordsDump(fx.store);
    assert.ok(dump.length > 2);
    assert.ok(!dump.includes(rawKey));
    assert.ok(dump.includes(hashNormalizedIdempotencyKey(rawKey)));
  } finally {
    await closeFixture(fx);
  }
});

test('R19 error bodies never leak the key, its hash or the workspace id', async () => {
  const fx = await createFixture();
  try {
    const rawKey = 'r19-raw-secret-key-0001';
    await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r19-a' }, rawKey);
    const conflict = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'r19-b' }, rawKey);
    assert.equal(conflict.status, 409);
    const text = JSON.stringify(await conflict.json());
    assert.ok(!text.includes(rawKey));
    assert.ok(!text.includes(hashNormalizedIdempotencyKey(rawKey)));
    assert.ok(!text.includes(fx.workspaceAId));

    const invalid = await postRawHttp(`${fx.baseA}/v2/tasks`, { title: 'r19-c' }, { 'Idempotency-Key': 'bad' });
    assert.equal(invalid.status, 400);
    assert.ok(!invalid.body.includes('bad'));
    assert.ok(!invalid.body.includes(fx.workspaceAId));
  } finally {
    await closeFixture(fx);
  }
});

test('R20 the legacy task endpoint is unchanged and writes no idempotency records', async () => {
  const fx = await createFixture();
  try {
    const response = await postJson(`${fx.baseA}/tasks`, { title: 'r20 legacy' });
    assert.equal(response.status, 201);
    const legacy = (await response.json() as { task: { id: string; status: string } }).task;
    assert.equal(legacy.status, 'pending');
    assert.equal(idempotencyRecordCount(fx.store), 0);
  } finally {
    await closeFixture(fx);
  }
});

test('R21 duplicate raw Idempotency-Key headers are rejected with 400 VALIDATION_FAILED', async () => {
  const fx = await createFixture();
  try {
    const result = await postRawHttp(`${fx.baseA}/v2/tasks`, { title: 'r21' }, {
      'Idempotency-Key': ['r21-key-0001', 'r21-key-0001'],
    });
    assert.equal(result.status, 400);
    const body = JSON.parse(result.body) as { code: string; error: string };
    assert.equal(body.code, 'VALIDATION_FAILED');
    assert.equal(body.error, 'Idempotency key is invalid');
    assert.equal(idempotencyRecordCount(fx.store), 0);
  } finally {
    await closeFixture(fx);
  }
});

test('R22 case-insensitive duplicate headers are rejected', async () => {
  const fx = await createFixture();
  try {
    // Node's http client normalizes duplicate header names case-insensitively,
    // so the two differently-cased header lines must be written on a raw socket.
    const url = new URL(`${fx.baseA}/v2/tasks`);
    const payload = JSON.stringify({ title: 'r22' });
    const rawResponse = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: url.hostname, port: Number(url.port) }, () => {
        socket.write(
          `POST ${url.pathname} HTTP/1.1\r\n`
          + `Host: ${url.host}\r\n`
          + 'Content-Type: application/json\r\n'
          + `Content-Length: ${Buffer.byteLength(payload)}\r\n`
          + 'Idempotency-Key: r22-key-0001\r\n'
          + 'IDEMPOTENCY-KEY: r22-key-0001\r\n'
          + 'Connection: close\r\n'
          + '\r\n'
          + payload,
        );
      });
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
    });
    const statusLine = rawResponse.split('\r\n', 1)[0] ?? '';
    assert.ok(statusLine.includes('400'), `expected 400, got: ${statusLine}`);
    const bodyText = rawResponse.slice(rawResponse.indexOf('\r\n\r\n') + 4);
    assert.equal((JSON.parse(bodyText) as { code: string }).code, 'VALIDATION_FAILED');
    assert.equal(idempotencyRecordCount(fx.store), 0);
  } finally {
    await closeFixture(fx);
  }
});

test('R23 a comma-joined header value is rejected', async () => {
  const fx = await createFixture();
  try {
    const result = await postRawHttp(`${fx.baseA}/v2/tasks`, { title: 'r23' }, {
      'Idempotency-Key': 'r23-key-0001, r23-key-0002',
    });
    assert.equal(result.status, 400);
    assert.equal((JSON.parse(result.body) as { code: string }).code, 'VALIDATION_FAILED');
  } finally {
    await closeFixture(fx);
  }
});

test('R24 an empty header value is rejected', async () => {
  const fx = await createFixture();
  try {
    const result = await postRawHttp(`${fx.baseA}/v2/tasks`, { title: 'r24' }, {
      'Idempotency-Key': '   ',
    });
    assert.equal(result.status, 400);
    assert.equal((JSON.parse(result.body) as { code: string }).code, 'VALIDATION_FAILED');
  } finally {
    await closeFixture(fx);
  }
});

test('R25 an invalid-character header value is rejected', async () => {
  const fx = await createFixture();
  try {
    const result = await postRawHttp(`${fx.baseA}/v2/tasks`, { title: 'r25' }, {
      'Idempotency-Key': 'not a valid key!',
    });
    assert.equal(result.status, 400);
    const body = JSON.parse(result.body) as { code: string; error: string };
    assert.equal(body.code, 'VALIDATION_FAILED');
    assert.equal(body.error, 'Idempotency key is invalid');
    assert.equal(idempotencyRecordCount(fx.store), 0);
  } finally {
    await closeFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// M2.6 P3 HIGH-1 remediation — optional capability behavior (C03–C05)
// ---------------------------------------------------------------------------

function withoutIdempotencyCapability(store: SqliteStore): TaskRunServiceDeps {
  return {
    taskRepository: () => store.taskRepository(),
    runRepository: () => store.runRepository(),
    workflowDefinitionRepository: () => store.workflowDefinitionRepository(),
    runSnapshotRepository: () => store.runSnapshotRepository(),
    runStageRepository: () => store.runStageRepository(),
    providerConfigurationRepository: () => store.providerConfigurationRepository(),
    findAgentSnapshotSource: (workspaceId, agentId) => store.findAgentSnapshotSource(workspaceId, agentId),
    runInTransaction: <T>(fn: () => T): T => store.runInTransaction(fn),
  };
}

interface NoCapabilityFixture {
  root: string;
  store: SqliteStore;
  server: ReturnType<express.Express['listen']>;
  baseA: string;
  workspaceAId: string;
}

async function createNoCapabilityFixture(): Promise<NoCapabilityFixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspaceA = manager.create('No Capability Workspace', join(root, 'a'), { git: false, memory: false, readme: false, docs: false });
  const deps = withoutIdempotencyCapability(store);
  const app = express();
  app.use(express.json());
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(deps, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(deps, manager));
  const { server, base } = await listenOnFetchSafePort(app);
  return { root, store, server, baseA: `${base}/${workspaceA.id}`, workspaceAId: workspaceA.id };
}

async function closeNoCapabilityFixture(fx: NoCapabilityFixture): Promise<void> {
  await closeTestServer(fx.server);
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

test('C03 a capability-less store keeps the original no-key behavior', async () => {
  const fx = await createNoCapabilityFixture();
  try {
    const created = await postJson(`${fx.baseA}/v2/tasks`, { title: 'c03' });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('idempotency-replayed'), null);
    const task = (await created.json() as { task: { id: string } }).task;
    assert.ok(task.id.startsWith('task_'));
    const run = await postJson(`${fx.baseA}/v2/tasks/${task.id}/runs`, {});
    assert.equal(run.status, 201);
    const cancelled = await postJson(`${fx.baseA}/v2/runs/${(await run.json() as { run: { id: string } }).run.id}/cancel`, {});
    assert.equal(cancelled.status, 200);
    const cancelTask = await postJson(`${fx.baseA}/v2/tasks/${task.id}/cancel`, {});
    assert.equal(cancelTask.status, 200);
    const reopen = await postJson(`${fx.baseA}/v2/tasks/${task.id}/reopen`, {});
    assert.equal(reopen.status, 200);
    assert.equal(idempotencyRecordCount(fx.store), 0);
  } finally {
    await closeNoCapabilityFixture(fx);
  }
});

test('C04 a keyed request without capability fails closed before any mutation', async () => {
  const fx = await createNoCapabilityFixture();
  try {
    const rawKey = 'c04-raw-secret-key-0001';
    const response = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'c04' }, rawKey);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('idempotency-replayed'), null);
    const body = await response.json() as { error: string; code: string };
    assert.deepEqual(body, {
      error: 'Idempotency record is invalid',
      code: 'IDEMPOTENCY_RECORD_INVALID',
    });
    const text = JSON.stringify(body);
    assert.ok(!text.includes(rawKey));
    assert.ok(!text.includes(hashNormalizedIdempotencyKey(rawKey)));
    assert.ok(!text.includes(fx.workspaceAId));
    assert.ok(!/TypeError|idempotencyRepository/i.test(text));
    assert.equal(fx.store.taskRepository().listByWorkspace(fx.workspaceAId).length, 0);
    assert.equal(idempotencyRecordCount(fx.store), 0);

    const plain = await postJson(`${fx.baseA}/v2/tasks`, { title: 'c04-plain' });
    assert.equal(plain.status, 201);
    const task = (await plain.json() as { task: { id: string } }).task;
    const keyedRun = await postJsonWithKey(`${fx.baseA}/v2/tasks/${task.id}/runs`, {}, rawKey);
    assert.equal(keyedRun.status, 500);
    assert.equal((await keyedRun.json() as { code: string }).code, 'IDEMPOTENCY_RECORD_INVALID');
    assert.equal(fx.store.runRepository().listByTask(fx.workspaceAId, task.id).length, 0);
    assert.equal(idempotencyRecordCount(fx.store), 0);
  } finally {
    await closeNoCapabilityFixture(fx);
  }
});

test('C05 a real SqliteStore still creates the IdempotencyService and replays', async () => {
  const fx = await createFixture();
  try {
    const capability = createOptionalIdempotencyService(fx.store);
    assert.ok(capability instanceof IdempotencyService);
    const first = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'c05' }, 'c05-key-0001');
    assert.equal(first.status, 201);
    const firstTask = (await first.json() as { task: { id: string } }).task;
    const replay = await postJsonWithKey(`${fx.baseA}/v2/tasks`, { title: 'c05' }, 'c05-key-0001');
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    const replayTask = (await replay.json() as { task: { id: string } }).task;
    assert.equal(replayTask.id, firstTask.id);
    assert.equal(idempotencyRecordCount(fx.store), 1);
  } finally {
    await closeFixture(fx);
  }
});
