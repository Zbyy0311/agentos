import test from 'node:test';
import assert from 'node:assert/strict';
import cors from 'cors';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiProblem } from '@agentos/shared';
import {
  createLocalCorsOptions,
  createLocalWriteGuard,
  resolveLocalApiSecurityConfig,
} from '../localApiSecurity.js';
import {
  createApiNotFoundHandler,
  createProblemErrorHandler,
  createRequestIdMiddleware,
} from '../problemDetails.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from '../services/TaskRunService.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { createOperationRoutes } from './operations.js';
import { createRunLifecycleRoutes } from './runLifecycle.js';
import { createCanonicalRunRoutes } from './canonicalRuns.js';
import { createCanonicalRunEventRoutes } from './canonicalRunEvents.js';
import { createV2RunRoutes } from './v2Runs.js';
import { createV2TaskRoutes } from './v2Tasks.js';

/**
 * P4 Run-level Pause/Resume route tests (canonical + current-v2 families).
 *
 * Pause and resume are record-level logical markers in this slice: no
 * provider process is suspended or restarted (that is a follow-up PR; all
 * adapters still report sessionResume: false). The routes only drive the
 * Lifecycle running <-> paused single transitions, emitting run.paused /
 * run.resumed Events and Outbox rows in the same transaction.
 *
 * Surface under test:
 * - POST /api/runs/:runId/pause    (canonical)
 * - POST /api/runs/:runId/resume   (canonical)
 * - POST /api/workspaces/:workspaceId/v2/runs/:runId/pause   (current-v2)
 * - POST /api/workspaces/:workspaceId/v2/runs/:runId/resume  (current-v2)
 */

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-pause-resume-'));
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

async function listenOnFetchSafePort(app: express.Express): Promise<{ server: ReturnType<express.Express['listen']>; origin: string }> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
      const origin = `http://127.0.0.1:${address.port}`;
      const probe = await fetch(`${origin}/__test_fetch_port_probe`, { method: 'HEAD' });
      if (probe.status !== 204) throw new Error(`test fetch probe returned ${probe.status}`);
      return { server, origin };
    } catch (error) {
      await closeTestServer(server);
      if (!isFetchBadPortError(error)) throw error;
    }
  }
  throw new Error('TEST_FETCH_SAFE_PORT_UNAVAILABLE');
}

const NOW = '2026-08-01T00:00:00.000Z';

interface Fixture {
  root: string;
  store: SqliteStore;
  server: ReturnType<express.Express['listen']>;
  baseApi: string;
  workspaceId: string;
  taskId: string;
  runId: string;
}

async function createFixture(): Promise<Fixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = await manager.create('Pause Resume Workspace', join(root, 'workspace-a'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const seeder = new TaskRunService(store);
  const task = seeder.createTask(workspace.id, { title: 'pause-resume-target', createdBy: 'test' });
  const run = seeder.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const security = resolveLocalApiSecurityConfig({});
  const app = express();
  // Mirrors the index.ts middleware order.
  app.use(createRequestIdMiddleware());
  app.use(cors(createLocalCorsOptions(security)));
  app.use(createLocalWriteGuard(security));
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.use('/api', createRunLifecycleRoutes(store));
  app.use('/api', createOperationRoutes(store));
  app.use('/api', createCanonicalRunEventRoutes(store));
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(store, manager));
  app.use('/api', createCanonicalRunRoutes(store, manager));
  app.use('/api', createApiNotFoundHandler());
  app.use(createProblemErrorHandler());
  const { server, origin } = await listenOnFetchSafePort(app);
  return {
    root,
    store,
    server,
    baseApi: `${origin}/api`,
    workspaceId: workspace.id,
    taskId: task.id,
    runId: run.id,
  };
}

async function closeFixture(fx: Fixture): Promise<void> {
  await closeTestServer(fx.server);
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

function setRunStatus(fx: Fixture, runId: string, status: 'queued' | 'running' | 'paused' | 'cancelled'): void {
  fx.store.getDatabase().prepare(`
    UPDATE runs
    SET status = ?, started_at = ?, completed_at = NULL, cancellation_requested_at = NULL
    WHERE workspace_id = ? AND id = ?
  `).run(status, status === 'queued' ? null : NOW, fx.workspaceId, runId);
}

interface ApiResult {
  status: number;
  contentType: string;
  json: Record<string, unknown> | null;
  replayed: string | null;
}

async function api(
  fx: Fixture,
  method: string,
  path: string,
  options: { body?: unknown; key?: string; ifMatch?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
  if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;
  const response = await fetch(`${fx.baseApi}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    json,
    replayed: response.headers.get('idempotency-replayed'),
  };
}

function assertProblem(body: unknown, status: number, code: string): ApiProblem {
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body), 'problem body must be an object');
  const problem = body as ApiProblem;
  assert.equal(problem.status, status);
  assert.equal(problem.code, code);
  return problem;
}

function assertProblemContentType(result: ApiResult): void {
  assert.ok(
    result.contentType.startsWith('application/problem+json'),
    `expected application/problem+json, got ${result.contentType}`,
  );
}

interface RecordedEvent {
  type: string;
  payload: Record<string, unknown>;
  stageId?: string;
}

function runEvents(fx: Fixture, runId: string): RecordedEvent[] {
  return fx.store.runtimeEventRepository()
    .listByRunAfterSequence(runId, 0)
    .flatMap(record => record.kind === 'known' ? [{
      type: record.event.type,
      payload: record.event.payload as Record<string, unknown>,
      stageId: record.event.stageId,
    }] : []);
}

function createRunningRun(fx: Fixture): string {
  const service = new TaskRunService(fx.store);
  const task = service.createTask(fx.workspaceId, { title: 'pause-resume-running', createdBy: 'test' });
  const run = service.createRun(fx.workspaceId, { taskId: task.id, createdBy: 'test' });
  setRunStatus(fx, run.id, 'running');
  return run.id;
}

test('P4 pause a running Run returns 200 paused and emits run.paused', async () => {
  const fx = await createFixture();
  try {
    const runId = createRunningRun(fx);
    const res = await api(fx, 'POST', `/runs/${runId}/pause`, { body: {} });
    assert.equal(res.status, 200);
    const run = res.json?.run as Record<string, unknown> | undefined;
    assert.equal(run?.status, 'paused');
    assert.equal(run?.version, 2);

    const paused = runEvents(fx, runId).filter(event => event.type === 'run.paused');
    assert.equal(paused.length, 1);
    assert.equal(paused[0].payload.reason, 'user');
    assert.equal(paused[0].payload.resumable, true);
    assert.equal(paused[0].stageId, undefined, 'run.paused must not bind a Stage');

    const persisted = fx.store.runRepository().findById(fx.workspaceId, runId);
    assert.equal(persisted?.status, 'paused');
    assert.equal(persisted?.startedAt, NOW, 'paused preserves startedAt');
  } finally {
    await closeFixture(fx);
  }
});

test('P4 pause carries reason and requestedBy into the run.paused payload', async () => {
  const fx = await createFixture();
  try {
    const runId = createRunningRun(fx);
    const res = await api(fx, 'POST', `/runs/${runId}/pause`, { body: { reason: 'policy', requestedBy: 'operator-1' } });
    assert.equal(res.status, 200);
    const paused = runEvents(fx, runId).filter(event => event.type === 'run.paused');
    assert.equal(paused.length, 1);
    assert.equal(paused[0].payload.reason, 'policy');
    assert.equal(paused[0].payload.requestedBy, 'operator-1');
    assert.equal(paused[0].payload.resumable, true);
  } finally {
    await closeFixture(fx);
  }
});

test('P4 pause is idempotent on an already paused Run (200, no new event)', async () => {
  const fx = await createFixture();
  try {
    const runId = createRunningRun(fx);
    const first = await api(fx, 'POST', `/runs/${runId}/pause`, { body: {} });
    if (first.status !== 200) throw new Error("FIRSTBODY:" + JSON.stringify(first.json));
    const second = await api(fx, 'POST', `/runs/${runId}/pause`, { body: {} });
    assert.equal(second.status, 200);
    const run = second.json?.run as Record<string, unknown> | undefined;
    assert.equal(run?.status, 'paused');
    assert.equal(run?.version, 2, 'idempotent pause must not bump the version');
    assert.equal(runEvents(fx, runId).filter(event => event.type === 'run.paused').length, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('P4 pause on a non-running Run is 409 RUN_NOT_PAUSABLE', async () => {
  const fx = await createFixture();
  try {
    // The seeded run is queued.
    const res = await api(fx, 'POST', `/runs/${fx.runId}/pause`, { body: {} });
    assert.equal(res.status, 409);
    assertProblemContentType(res);
    assertProblem(res.json, 409, 'RUN_NOT_PAUSABLE');
    const persisted = fx.store.runRepository().findById(fx.workspaceId, fx.runId);
    assert.equal(persisted?.status, 'queued');
  } finally {
    await closeFixture(fx);
  }
});

test('P4 pause on a terminal Run is 409 RUN_NOT_PAUSABLE', async () => {
  const fx = await createFixture();
  try {
    setRunStatus(fx, fx.runId, 'cancelled');
    const res = await api(fx, 'POST', `/runs/${fx.runId}/pause`, { body: {} });
    assert.equal(res.status, 409);
    assertProblem(res.json, 409, 'RUN_NOT_PAUSABLE');
  } finally {
    await closeFixture(fx);
  }
});

test('P4 pause on an unknown Run is 404 RUN_NOT_FOUND', async () => {
  const fx = await createFixture();
  try {
    const res = await api(fx, 'POST', '/runs/run_missing/pause', { body: {} });
    assert.equal(res.status, 404);
    assertProblemContentType(res);
    assertProblem(res.json, 404, 'RUN_NOT_FOUND');
  } finally {
    await closeFixture(fx);
  }
});

test('P4 pause with an invalid reason is 400 VALIDATION_FAILED', async () => {
  const fx = await createFixture();
  try {
    const runId = createRunningRun(fx);
    const res = await api(fx, 'POST', `/runs/${runId}/pause`, { body: { reason: 'bogus' } });
    assert.equal(res.status, 400);
    assertProblemContentType(res);
    assertProblem(res.json, 400, 'VALIDATION_FAILED');
  } finally {
    await closeFixture(fx);
  }
});

test('P4 resume a paused Run returns 200 running and emits run.resumed', async () => {
  const fx = await createFixture();
  try {
    const runId = createRunningRun(fx);
    const paused = await api(fx, 'POST', `/runs/${runId}/pause`, { body: {} });
    assert.equal(paused.status, 200);

    const resumed = await api(fx, 'POST', `/runs/${runId}/resume`, { body: {} });
    assert.equal(resumed.status, 200);
    const run = resumed.json?.run as Record<string, unknown> | undefined;
    assert.equal(run?.status, 'running');

    const events = runEvents(fx, runId).filter(event => event.type === 'run.resumed');
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.resumeMode, 'process-restart');
    assert.equal(events[0].stageId, undefined, 'run.resumed must not bind a Stage');
  } finally {
    await closeFixture(fx);
  }
});

test('P4 resume carries resumeMode and requestedBy into the run.resumed payload', async () => {
  const fx = await createFixture();
  try {
    const runId = createRunningRun(fx);
    await api(fx, 'POST', `/runs/${runId}/pause`, { body: {} });
    const res = await api(fx, 'POST', `/runs/${runId}/resume`, { body: { resumeMode: 'scheduler', requestedBy: 'operator-2' } });
    assert.equal(res.status, 200);
    const events = runEvents(fx, runId).filter(event => event.type === 'run.resumed');
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.resumeMode, 'scheduler');
    assert.equal(events[0].payload.requestedBy, 'operator-2');
  } finally {
    await closeFixture(fx);
  }
});

test('P4 resume is idempotent on a running Run (200, no new event)', async () => {
  const fx = await createFixture();
  try {
    const runId = createRunningRun(fx);
    await api(fx, 'POST', `/runs/${runId}/pause`, { body: {} });
    const first = await api(fx, 'POST', `/runs/${runId}/resume`, { body: {} });
    if (first.status !== 200) throw new Error("FIRSTBODY:" + JSON.stringify(first.json));
    const before = (fx.store.runRepository().findById(fx.workspaceId, runId))!.version;
    const second = await api(fx, 'POST', `/runs/${runId}/resume`, { body: {} });
    assert.equal(second.status, 200);
    const run = second.json?.run as Record<string, unknown> | undefined;
    assert.equal(run?.status, 'running');
    assert.equal(run?.version, before, 'idempotent resume must not bump the version');
    assert.equal(runEvents(fx, runId).filter(event => event.type === 'run.resumed').length, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('P4 resume on a queued Run is 409 RUN_NOT_RESUMABLE', async () => {
  const fx = await createFixture();
  try {
    // The seeded run is queued.
    const res = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: {} });
    assert.equal(res.status, 409);
    assertProblemContentType(res);
    assertProblem(res.json, 409, 'RUN_NOT_RESUMABLE');
  } finally {
    await closeFixture(fx);
  }
});

test('P4 pause and resume participate in durable idempotency replay', async () => {
  const fx = await createFixture();
  try {
    const runId = createRunningRun(fx);
    const first = await api(fx, 'POST', `/runs/${runId}/pause`, { body: {}, key: 'pause-key-1' });
    assert.equal(first.status, 200);
    const replay = await api(fx, 'POST', `/runs/${runId}/pause`, { body: {}, key: 'pause-key-1' });
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, 'true');
    assert.equal(runEvents(fx, runId).filter(event => event.type === 'run.paused').length, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('P4 pause stale If-Match is 412 STORAGE_VERSION_CONFLICT with zero mutation', async () => {
  const fx = await createFixture();
  try {
    const runId = createRunningRun(fx);
    const res = await api(fx, 'POST', `/runs/${runId}/pause`, { body: {}, ifMatch: '"v999"' });
    assert.equal(res.status, 412);
    assertProblemContentType(res);
    assertProblem(res.json, 412, 'STORAGE_VERSION_CONFLICT');
    assert.equal(fx.store.runRepository().findById(fx.workspaceId, runId)?.status, 'running');
  } finally {
    await closeFixture(fx);
  }
});

test('P4 current-v2 family exposes the same pause/resume contract', async () => {
  const fx = await createFixture();
  try {
    const runId = createRunningRun(fx);
    const pause = await api(fx, 'POST', `/workspaces/${fx.workspaceId}/v2/runs/${runId}/pause`, { body: {} });
    assert.equal(pause.status, 200);
    assert.equal((pause.json?.run as Record<string, unknown> | undefined)?.status, 'paused');
    const resume = await api(fx, 'POST', `/workspaces/${fx.workspaceId}/v2/runs/${runId}/resume`, { body: {} });
    assert.equal(resume.status, 200);
    assert.equal((resume.json?.run as Record<string, unknown> | undefined)?.status, 'running');
    assert.equal(runEvents(fx, runId).filter(event => event.type === 'run.paused').length, 1);
    assert.equal(runEvents(fx, runId).filter(event => event.type === 'run.resumed').length, 1);
  } finally {
    await closeFixture(fx);
  }
});
