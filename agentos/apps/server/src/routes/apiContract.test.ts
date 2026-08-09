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
import { createV2RunRoutes } from './v2Runs.js';
import { createV2TaskRoutes } from './v2Tasks.js';

/**
 * M3 P4A API contract tests. Composes the exact middleware order used by
 * index.ts: request-id -> canonical lifecycle/operation routers (scoped
 * parsers) -> global strict JSON parser -> v2 routers -> API 404 fallback
 * -> ApiProblem error handler.
 */

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-api-contract-'));
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
  service: TaskRunService;
  server: ReturnType<express.Express['listen']>;
  origin: string;
  workspaceId: string;
}

async function createFixture(): Promise<Fixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('Contract', join(root, 'a'), { git: false, memory: false, readme: false, docs: false });
  const security = resolveLocalApiSecurityConfig({});
  const app = express();
  // Mirrors the index.ts order: request-id -> CORS -> local write guard ->
  // API routers -> ApiProblem fallback/error handling.
  app.use(createRequestIdMiddleware());
  app.use(cors(createLocalCorsOptions(security)));
  app.use(createLocalWriteGuard(security));
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.get('/api/__test_boom', (_req, _res, next) => next(new Error('boom-secret-internal-detail')));
  app.use('/api', createRunLifecycleRoutes(store));
  app.use('/api', createOperationRoutes(store));
  app.use(express.json());
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(store, manager));
  app.use('/api', createApiNotFoundHandler());
  app.use(createProblemErrorHandler());
  const { server, origin } = await listenOnFetchSafePort(app);
  return { root, store, service: new TaskRunService(store), server, origin, workspaceId: workspace.id };
}

async function closeFixture(fx: Fixture): Promise<void> {
  await closeTestServer(fx.server);
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

async function createTask(fx: Fixture, title = 'contract task'): Promise<string> {
  const response = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 201);
  return (await response.json() as { task: { id: string } }).task.id;
}

async function createRun(fx: Fixture, taskId: string): Promise<string> {
  const response = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/tasks/${taskId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 201);
  return (await response.json() as { run: { id: string } }).run.id;
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

function assertProblemContentType(response: Response): void {
  const contentType = response.headers.get('content-type') ?? '';
  assert.ok(
    contentType.startsWith('application/problem+json'),
    `expected application/problem+json, got ${contentType}`,
  );
}

test('P4A unknown API route returns 404 ApiProblem with requestId header', async () => {
  const fx = await createFixture();
  try {
    const response = await fetch(`${fx.origin}/api/definitely-not-a-route?ignored=1`);
    assert.equal(response.status, 404);
    assertProblemContentType(response);
    const problem = assertProblem(await response.json(), 404, 'NOT_FOUND');
    assert.equal(problem.instance, '/api/definitely-not-a-route');
    assert.equal(problem.retryable, false);
    const requestId = response.headers.get('x-request-id');
    assert.ok(requestId && requestId.length > 0);
    assert.equal(problem.requestId, requestId);
  } finally {
    await closeFixture(fx);
  }
});

test('P4A X-Request-ID is generated, echoed when valid, replaced when invalid', async () => {
  const fx = await createFixture();
  try {
    const generated = await fetch(`${fx.origin}/api/definitely-not-a-route`);
    const generatedId = generated.headers.get('x-request-id') ?? '';
    assert.match(generatedId, /^req_[0-9a-f-]{36}$/);

    const echoed = await fetch(`${fx.origin}/api/definitely-not-a-route`, {
      headers: { 'X-Request-ID': 'client-req-1' },
    });
    assert.equal(echoed.headers.get('x-request-id'), 'client-req-1');
    assert.equal((await echoed.json() as ApiProblem).requestId, 'client-req-1');

    const invalid = await fetch(`${fx.origin}/api/definitely-not-a-route`, {
      headers: { 'X-Request-ID': 'bad id with spaces' },
    });
    const replacedId = invalid.headers.get('x-request-id') ?? '';
    assert.match(replacedId, /^req_[0-9a-f-]{36}$/);
  } finally {
    await closeFixture(fx);
  }
});

test('P4A malformed JSON on a global-parser route is 400 VALIDATION_FAILED ApiProblem', async () => {
  const fx = await createFixture();
  try {
    const response = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(response.status, 400);
    assertProblemContentType(response);
    assertProblem(await response.json(), 400, 'VALIDATION_FAILED');
  } finally {
    await closeFixture(fx);
  }
});

test('P4A unhandled error is 500 INTERNAL_ERROR ApiProblem without internal detail leak', async () => {
  const fx = await createFixture();
  try {
    const response = await fetch(`${fx.origin}/api/__test_boom`);
    assert.equal(response.status, 500);
    assertProblemContentType(response);
    const text = await response.text();
    assert.ok(!text.includes('boom-secret-internal-detail'), 'internal message must not leak');
    assertProblem(JSON.parse(text), 500, 'INTERNAL_ERROR');
  } finally {
    await closeFixture(fx);
  }
});

test('P4A canonical Start validation failure is an ApiProblem', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTask(fx);
    const runId = await createRun(fx, taskId);
    const response = await fetch(`${fx.origin}/api/runs/${runId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unexpected: true }),
    });
    assert.equal(response.status, 400);
    assertProblemContentType(response);
    assertProblem(await response.json(), 400, 'VALIDATION_FAILED');
  } finally {
    await closeFixture(fx);
  }
});

test('P4A v2 run GET emits ETag "vN" matching the run version', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTask(fx);
    const runId = await createRun(fx, taskId);
    const response = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${runId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), '"v1"');
    const body = await response.json() as { run: { version: number } };
    assert.equal(body.run.version, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('P4A v2 task GET emits ETag "vN" matching the task version', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTask(fx);
    const response = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/tasks/${taskId}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), '"v1"');
    const body = await response.json() as { task: { version: number } };
    assert.equal(body.task.version, 1);
  } finally {
    await closeFixture(fx);
  }
});

test('P4A operation GET emits ETag "vN" matching the operation version', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTask(fx);
    const runId = await createRun(fx, taskId);
    const start = await fetch(`${fx.origin}/api/runs/${runId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(start.status, 202);
    const operation = (await start.json() as { operation: { id: string; version: number } }).operation;
    const response = await fetch(`${fx.origin}/api/operations/${operation.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('etag'), `"v${operation.version}"`);
  } finally {
    await closeFixture(fx);
  }
});

test('P4A If-Match on v2 run cancel: match succeeds, stale is 412 with spec fields', async () => {
  const fx = await createFixture();
  try {
    const staleRunId = await createRun(fx, await createTask(fx));
    const stale = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${staleRunId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v99"' },
      body: JSON.stringify({}),
    });
    assert.equal(stale.status, 412);
    assertProblemContentType(stale);
    const staleProblem = assertProblem(await stale.json(), 412, 'STORAGE_VERSION_CONFLICT');
    assert.equal(staleProblem.type, 'urn:agentos:error:version-conflict');
    assert.equal(staleProblem.retryable, true);
    assert.equal(staleProblem.suggestedAction, 'Reload the resource and retry with the latest ETag.');
    const staleRun = fx.store.runRepository().findById(fx.workspaceId, staleRunId);
    assert.equal(staleRun?.status, 'queued');

    const okRunId = await createRun(fx, await createTask(fx));
    const ok = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${okRunId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({}),
    });
    assert.equal(ok.status, 200);
    const okRun = fx.store.runRepository().findById(fx.workspaceId, okRunId);
    assert.equal(okRun?.status, 'cancelled');
  } finally {
    await closeFixture(fx);
  }
});

test('P4A body-only stale expectedVersion on v2 run cancel stays 409 VERSION_CONFLICT', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTask(fx);
    const runId = await createRun(fx, taskId);
    const response = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${runId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 99 }),
    });
    assert.equal(response.status, 409);
    assertProblemContentType(response);
    assertProblem(await response.json(), 409, 'VERSION_CONFLICT');
  } finally {
    await closeFixture(fx);
  }
});

test('P4A malformed If-Match and inconsistent header/body preconditions are 400', async () => {
  const fx = await createFixture();
  try {
    const unquoted = await createRun(fx, await createTask(fx));
    const malformed = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${unquoted}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': 'v1' },
      body: JSON.stringify({}),
    });
    assert.equal(malformed.status, 400);
    assertProblem(await malformed.json(), 400, 'VALIDATION_FAILED');

    const zero = await createRun(fx, await createTask(fx));
    const zeroVersion = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${zero}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v0"' },
      body: JSON.stringify({}),
    });
    assert.equal(zeroVersion.status, 400);
    assertProblem(await zeroVersion.json(), 400, 'VALIDATION_FAILED');

    const pair = await createRun(fx, await createTask(fx));
    const inconsistent = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${pair}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ expectedVersion: 2 }),
    });
    assert.equal(inconsistent.status, 400);
    assertProblem(await inconsistent.json(), 400, 'VALIDATION_FAILED');

    const consistentPair = await createRun(fx, await createTask(fx));
    const consistent = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${consistentPair}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(consistent.status, 200);
  } finally {
    await closeFixture(fx);
  }
});

test('P4A If-Match precondition does not break idempotent replay', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTask(fx);
    const runId = await createRun(fx, taskId);
    const url = `${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${runId}/cancel`;
    const init = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"v1"',
        'Idempotency-Key': 'contract-replay-key-1',
      },
      body: JSON.stringify({}),
    };
    const first = await fetch(url, init);
    assert.equal(first.status, 200);
    const replay = await fetch(url, init);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(await replay.json(), await first.json());
  } finally {
    await closeFixture(fx);
  }
});

test('P4A If-Match on v2 task cancel follows the same header contract', async () => {
  const fx = await createFixture();
  try {
    const staleTaskId = await createTask(fx, 'stale task');
    const stale = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/tasks/${staleTaskId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v7"' },
      body: JSON.stringify({}),
    });
    assert.equal(stale.status, 412);
    assertProblem(await stale.json(), 412, 'STORAGE_VERSION_CONFLICT');

    const okTaskId = await createTask(fx, 'ok task');
    const ok = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/tasks/${okTaskId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({}),
    });
    assert.equal(ok.status, 200);
  } finally {
    await closeFixture(fx);
  }
});

test('P4A operation cancel keeps the frozen body-only P3D contract (If-Match is not a version transport)', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTask(fx);
    const runId = await createRun(fx, taskId);
    const start = await fetch(`${fx.origin}/api/runs/${runId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(start.status, 202);
    const operation = (await start.json() as { operation: { id: string; version: number } }).operation;
    const cancel = await fetch(`${fx.origin}/api/operations/${operation.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v999"' },
      body: JSON.stringify({ expectedVersion: operation.version }),
    });
    assert.equal(cancel.status, 200);
    const staleBody = await fetch(`${fx.origin}/api/operations/${operation.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"v1"' },
      body: JSON.stringify({ expectedVersion: 999 }),
    });
    // Body path keeps the frozen 409 VERSION_CONFLICT mapping even when an
    // If-Match header is present; the header is not evaluated on this route.
    assert.notEqual(staleBody.status, 412);
  } finally {
    await closeFixture(fx);
  }
});

test('P4A MEDIUM-1 local write guard rejection is an ApiProblem carrying the chain requestId', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTask(fx);
    const runId = await createRun(fx, taskId);
    const response = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'application/json',
        'If-Match': '"v1"',
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 403);
    assertProblemContentType(response);
    const problem = assertProblem(await response.json(), 403, 'origin_not_allowed');
    assert.equal(problem.retryable, false);
    const requestId = response.headers.get('x-request-id');
    assert.ok(requestId && requestId.length > 0, 'X-Request-ID header must exist on the security rejection');
    assert.equal(problem.requestId, requestId);
    assert.ok(!problem.detail.includes('evil.example'), 'rejected Origin must not be exposed');
    // The guard terminated the request before any route ran.
    assert.equal(fx.store.runRepository().findById(fx.workspaceId, runId)?.status, 'queued');
  } finally {
    await closeFixture(fx);
  }
});

test('P4A HIGH-1 approved-origin browser request with If-Match still reaches the 412 contract', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTask(fx);
    const runId = await createRun(fx, taskId);
    const response = await fetch(`${fx.origin}/api/workspaces/${fx.workspaceId}/v2/runs/${runId}/cancel`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3001',
        'Content-Type': 'application/json',
        'If-Match': '"v99"',
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3001');
    assert.equal(response.status, 412);
    assertProblem(await response.json(), 412, 'STORAGE_VERSION_CONFLICT');
  } finally {
    await closeFixture(fx);
  }
});
