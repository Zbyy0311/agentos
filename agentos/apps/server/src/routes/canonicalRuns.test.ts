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
import { createTaskRoutes } from './tasks.js';
import { createV2RunRoutes } from './v2Runs.js';
import { createV2TaskRoutes } from './v2Tasks.js';

/**
 * M3 P4B canonical route compatibility tests. The fixture composes the
 * exact middleware order used by index.ts: request-id -> CORS -> local
 * write guard -> canonical lifecycle/operation routers (scoped parsers)
 * -> global strict JSON parser -> Legacy tasks -> current-v2 routers ->
 * P4B canonical compatibility router -> API 404 fallback -> ApiProblem
 * error handler.
 *
 * Canonical surface under test:
 * - POST /api/tasks/:taskId/runs   (Create Run, delegates to createRunForV2)
 * - GET  /api/runs/:runId          (Get Run, emits the P4A version ETag)
 * - POST /api/runs/:runId/cancel   (Cancel Run, If-Match 412 / body 409)
 *
 * P5 routes (/events, /replay, /stream) must remain unimplemented 404s.
 */

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-canonical-runs-'));
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
  const workspace = manager.create('Canonical Workspace', join(root, 'workspace-a'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const seeder = new TaskRunService(store);
  const task = seeder.createTask(workspace.id, { title: 'canonical-target', createdBy: 'test' });
  const run = seeder.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const security = resolveLocalApiSecurityConfig({});
  const app = express();
  // Mirrors the index.ts order: request-id -> CORS -> local write guard ->
  // lifecycle/operation routers (scoped parsers) -> global strict JSON
  // parser -> Legacy/current-v2 routers -> P4B canonical router -> API 404
  // fallback -> ApiProblem error handler.
  app.use(createRequestIdMiddleware());
  app.use(cors(createLocalCorsOptions(security)));
  app.use(createLocalWriteGuard(security));
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.use('/api', createRunLifecycleRoutes(store));
  app.use('/api', createOperationRoutes(store));
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId/tasks', createTaskRoutes(store, manager, { taskRunService: seeder }));
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(store, manager));
  // P4B canonical compatibility mount point (mirrors index.ts).
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

interface ApiResult {
  status: number;
  contentType: string;
  json: Record<string, unknown> | null;
  etag: string | null;
  replayed: string | null;
  requestId: string | null;
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
    etag: response.headers.get('etag'),
    replayed: response.headers.get('idempotency-replayed'),
    requestId: response.headers.get('x-request-id'),
  };
}

function assertProblem(body: unknown, status: number, code: string): ApiProblem {
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body), 'problem body must be an object');
  const problem = body as ApiProblem;
  assert.equal(problem.status, status);
  assert.equal(problem.code, code);
  assert.equal(typeof problem.type, 'string');
  assert.ok(problem.type.startsWith('urn:agentos:error:'), `unexpected problem type: ${problem.type}`);
  assert.equal(typeof problem.title, 'string');
  assert.equal(typeof problem.detail, 'string');
  assert.equal(typeof problem.instance, 'string');
  assert.equal(typeof problem.requestId, 'string');
  assert.ok(problem.requestId.length > 0);
  assert.equal(typeof problem.retryable, 'boolean');
  return problem;
}

function assertProblemContentType(result: ApiResult): void {
  assert.ok(
    result.contentType.startsWith('application/problem+json'),
    `expected application/problem+json, got ${result.contentType}`,
  );
}

function runCount(fx: Fixture): number {
  return (fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number }).count;
}

function createAdditionalTask(fx: Fixture, title: string): string {
  const service = new TaskRunService(fx.store);
  return service.createTask(fx.workspaceId, { title, createdBy: 'test' }).id;
}

function failSeededRun(fx: Fixture): void {
  let parent = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
  fx.store.runRepository().transitionStatus(fx.workspaceId, parent.id, parent.version, 'running');
  parent = fx.store.runRepository().findById(fx.workspaceId, parent.id)!;
  fx.store.runRepository().transitionStatus(fx.workspaceId, parent.id, parent.version, 'failed', {
    failureCode: 'TEST_FAILURE',
    failureMessage: 'test failure',
  });
}

test('P4B-R02 canonical Create Run returns 201 with the versioned run envelope', async () => {
  const fx = await createFixture();
  try {
    const taskId = createAdditionalTask(fx, 'canonical-create');
    const res = await api(fx, 'POST', `/tasks/${taskId}/runs`, { body: {} });
    assert.equal(res.status, 201);
    const run = res.json?.run as Record<string, unknown> | undefined;
    assert.ok(run, 'response must carry the run envelope');
    assert.equal(run.taskId, taskId);
    assert.equal(run.status, 'queued');
    assert.equal(run.version, 1);
    assert.equal(typeof run.id, 'string');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R02 canonical Create Run with an unknown task is 404 TASK_NOT_FOUND ApiProblem', async () => {
  const fx = await createFixture();
  try {
    const res = await api(fx, 'POST', '/tasks/task_missing/runs', { body: {} });
    assert.equal(res.status, 404);
    assertProblemContentType(res);
    const problem = assertProblem(res.json, 404, 'TASK_NOT_FOUND');
    assert.equal(problem.requestId, res.requestId);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R11 canonical Create Run same-key replay returns the original envelope exactly once', async () => {
  const fx = await createFixture();
  try {
    const taskId = createAdditionalTask(fx, 'canonical-replay');
    const before = runCount(fx);
    const first = await api(fx, 'POST', `/tasks/${taskId}/runs`, {
      body: { objective: 'canonical replay probe' },
      key: 'canonical-create-replay-1',
    });
    assert.equal(first.status, 201);
    const second = await api(fx, 'POST', `/tasks/${taskId}/runs`, {
      body: { objective: 'canonical replay probe' },
      key: 'canonical-create-replay-1',
    });
    assert.equal(second.status, 201);
    assert.equal(second.replayed, 'true');
    const firstRun = first.json?.run as { id?: unknown } | undefined;
    const secondRun = second.json?.run as { id?: unknown } | undefined;
    assert.ok(firstRun?.id);
    assert.equal(secondRun?.id, firstRun.id);
    assert.equal(runCount(fx), before + 1, 'replay must not create a second run');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R12 canonical Create Run same-key different body is 409 IDEMPOTENCY_KEY_REUSED', async () => {
  const fx = await createFixture();
  try {
    const taskId = createAdditionalTask(fx, 'canonical-mismatch');
    const first = await api(fx, 'POST', `/tasks/${taskId}/runs`, {
      body: { objective: 'alpha' },
      key: 'canonical-create-mismatch-1',
    });
    assert.equal(first.status, 201);
    const second = await api(fx, 'POST', `/tasks/${taskId}/runs`, {
      body: { objective: 'beta' },
      key: 'canonical-create-mismatch-1',
    });
    assert.equal(second.status, 409);
    assertProblemContentType(second);
    assertProblem(second.json, 409, 'IDEMPOTENCY_KEY_REUSED');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R03 canonical Get Run returns the version ETag and the run envelope', async () => {
  const fx = await createFixture();
  try {
    const res = await api(fx, 'GET', `/runs/${fx.runId}`);
    assert.equal(res.status, 200);
    assert.equal(res.etag, '"v1"');
    const run = res.json?.run as Record<string, unknown> | undefined;
    assert.ok(run, 'response must carry the run envelope');
    assert.equal(run.id, fx.runId);
    assert.equal(run.version, 1);
    assert.equal(typeof res.json?.snapshotAvailable, 'boolean');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R03 canonical Get Run with an unknown run is 404 RUN_NOT_FOUND ApiProblem', async () => {
  const fx = await createFixture();
  try {
    const res = await api(fx, 'GET', '/runs/run_missing');
    assert.equal(res.status, 404);
    assertProblemContentType(res);
    const problem = assertProblem(res.json, 404, 'RUN_NOT_FOUND');
    assert.equal(problem.requestId, res.requestId);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R03 canonical Get Run supports include=stages', async () => {
  const fx = await createFixture();
  try {
    const res = await api(fx, 'GET', `/runs/${fx.runId}?include=stages`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json?.stages), 'include=stages must return a stages array');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R32 canonical and current-v2 families observe the same run aggregate', async () => {
  const fx = await createFixture();
  try {
    const canonical = await api(fx, 'GET', `/runs/${fx.runId}`);
    assert.equal(canonical.status, 200);
    const v2 = await api(fx, 'GET', `/workspaces/${fx.workspaceId}/v2/runs/${fx.runId}`);
    assert.equal(v2.status, 200);
    const canonicalRun = canonical.json?.run as { id?: unknown; version?: unknown } | undefined;
    const v2Run = v2.json?.run as { id?: unknown; version?: unknown } | undefined;
    assert.equal(canonicalRun?.id, v2Run?.id);
    assert.equal(canonicalRun?.version, v2Run?.version);
    assert.equal(canonical.etag, v2.etag);
    const taskId = createAdditionalTask(fx, 'canonical-cross-family');
    const created = await api(fx, 'POST', `/tasks/${taskId}/runs`, { body: {} });
    assert.equal(created.status, 201);
    const createdRun = created.json?.run as { id?: unknown } | undefined;
    const v2Read = await api(fx, 'GET', `/workspaces/${fx.workspaceId}/v2/runs/${String(createdRun?.id)}`);
    assert.equal(v2Read.status, 200);
    assert.equal((v2Read.json?.run as { id?: unknown } | undefined)?.id, createdRun?.id);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R04 canonical Cancel Run cancels a queued run', async () => {
  const fx = await createFixture();
  try {
    const res = await api(fx, 'POST', `/runs/${fx.runId}/cancel`, { body: {} });
    assert.equal(res.status, 200);
    const run = res.json?.run as Record<string, unknown> | undefined;
    assert.equal(run?.status, 'cancelled');
    assert.equal(run?.version, 2);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R04 canonical Cancel Run stale If-Match is 412 STORAGE_VERSION_CONFLICT with zero mutation', async () => {
  const fx = await createFixture();
  try {
    const res = await api(fx, 'POST', `/runs/${fx.runId}/cancel`, { body: {}, ifMatch: '"v999"' });
    assert.equal(res.status, 412);
    assertProblemContentType(res);
    const problem = assertProblem(res.json, 412, 'STORAGE_VERSION_CONFLICT');
    assert.equal(problem.retryable, true);
    assert.equal(typeof problem.suggestedAction, 'string');
    assert.equal(problem.requestId, res.requestId);
    const after = await api(fx, 'GET', `/runs/${fx.runId}`);
    const run = after.json?.run as Record<string, unknown> | undefined;
    assert.equal(run?.status, 'queued');
    assert.equal(run?.version, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R04 canonical Cancel Run stale body expectedVersion stays 409 VERSION_CONFLICT', async () => {
  const fx = await createFixture();
  try {
    const res = await api(fx, 'POST', `/runs/${fx.runId}/cancel`, { body: { expectedVersion: 999 } });
    assert.equal(res.status, 409);
    assertProblemContentType(res);
    assertProblem(res.json, 409, 'VERSION_CONFLICT');
    const after = await api(fx, 'GET', `/runs/${fx.runId}`);
    const run = after.json?.run as Record<string, unknown> | undefined;
    assert.equal(run?.status, 'queued');
    assert.equal(run?.version, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R04 canonical Cancel Run with a matching If-Match succeeds', async () => {
  const fx = await createFixture();
  try {
    const before = await api(fx, 'GET', `/runs/${fx.runId}`);
    assert.equal(before.status, 200);
    assert.ok(before.etag, 'GET must emit the version ETag');
    const res = await api(fx, 'POST', `/runs/${fx.runId}/cancel`, { body: {}, ifMatch: before.etag });
    assert.equal(res.status, 200);
    const run = res.json?.run as Record<string, unknown> | undefined;
    assert.equal(run?.status, 'cancelled');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R11 canonical Cancel Run same-key replay returns the original snapshot', async () => {
  const fx = await createFixture();
  try {
    const first = await api(fx, 'POST', `/runs/${fx.runId}/cancel`, { body: {}, key: 'canonical-cancel-replay-1' });
    assert.equal(first.status, 200);
    const second = await api(fx, 'POST', `/runs/${fx.runId}/cancel`, { body: {}, key: 'canonical-cancel-replay-1' });
    assert.equal(second.status, 200);
    assert.equal(second.replayed, 'true');
    const firstRun = first.json?.run as { id?: unknown; version?: unknown } | undefined;
    const secondRun = second.json?.run as { id?: unknown; version?: unknown } | undefined;
    assert.equal(secondRun?.id, firstRun?.id);
    assert.equal(secondRun?.version, firstRun?.version);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R31 canonical routes do not shadow the frozen Start route', async () => {
  const fx = await createFixture();
  try {
    const res = await api(fx, 'POST', `/runs/${fx.runId}/start`, { body: {} });
    assert.equal(res.status, 202);
    const operation = res.json?.operation as Record<string, unknown> | undefined;
    assert.equal(operation?.type, 'run.start');
    assert.equal(operation?.status, 'queued');
    assert.equal(operation?.version, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R31 canonical routes do not shadow the frozen Retry route', async () => {
  const fx = await createFixture();
  try {
    failSeededRun(fx);
    const res = await api(fx, 'POST', `/runs/${fx.runId}/retry`, {
      body: { expectedVersion: 3 },
      key: 'canonical-retry-shadow-1',
    });
    assert.equal(res.status, 201);
    const child = res.json?.run as Record<string, unknown> | undefined;
    const operation = res.json?.operation as Record<string, unknown> | undefined;
    assert.equal(child?.parentRunId, fx.runId);
    assert.equal(operation?.type, 'run.retry');
    assert.equal(operation?.status, 'completed');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R15 unimplemented P5 run routes stay truthful 404 NOT_FOUND', async () => {
  const fx = await createFixture();
  try {
    for (const suffix of ['events', 'replay', 'stream']) {
      const res = await api(fx, 'GET', `/runs/${fx.runId}/${suffix}`);
      assert.equal(res.status, 404, `${suffix} must not be implemented in P4B`);
      assertProblemContentType(res);
      assertProblem(res.json, 404, 'NOT_FOUND');
    }
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R09 Operation read route remains intact alongside the canonical router', async () => {
  const fx = await createFixture();
  try {
    const start = await api(fx, 'POST', `/runs/${fx.runId}/start`, { body: {} });
    assert.equal(start.status, 202);
    const operation = start.json?.operation as { id?: unknown } | undefined;
    assert.ok(operation?.id);
    const res = await api(fx, 'GET', `/operations/${String(operation.id)}`);
    assert.equal(res.status, 200);
    const read = res.json?.data as { id?: unknown } | undefined;
    assert.equal(read?.id, operation.id);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R05 legacy task routes remain intact alongside the canonical router', async () => {
  const fx = await createFixture();
  try {
    const res = await api(fx, 'GET', `/workspaces/${fx.workspaceId}/tasks`);
    assert.equal(res.status, 200);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B-R06 current-v2 routes remain intact alongside the canonical router', async () => {
  const fx = await createFixture();
  try {
    const taskId = createAdditionalTask(fx, 'v2-preserved');
    const res = await api(fx, 'POST', `/workspaces/${fx.workspaceId}/v2/tasks/${taskId}/runs`, { body: {} });
    assert.equal(res.status, 201);
    const run = res.json?.run as Record<string, unknown> | undefined;
    assert.equal(run?.taskId, taskId);
  } finally {
    await closeFixture(fx);
  }
});
