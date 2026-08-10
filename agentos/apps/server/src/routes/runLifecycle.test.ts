import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { createRunLifecycleRoutes } from './runLifecycle.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { TaskRunService, type TaskRunServiceDeps } from '../services/TaskRunService.js';
import { IdempotencyService } from '../services/IdempotencyService.js';
import { OperationService } from '../services/OperationService.js';
import { RunActiveExistsError } from '../store/RunRepository.js';
import type { Run } from '@agentos/shared';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): unknown[];
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
    close(): void;
  };
};

// ---------------------------------------------------------------------------
// Worker protocol (M3 P3C-1 §16): two workers share one real SQLite file and
// race the canonical Start acceptance through the production TaskRunService.
// The 'go' barrier maximizes BEGIN IMMEDIATE contention; busy_timeout = 5000
// serializes the loser instead of surfacing SQLITE_BUSY.
// ---------------------------------------------------------------------------

interface StartRaceWorkerData {
  mode: 'run-start-race' | 'run-retry-race' | 'store-open-under-lock';
  root: string;
  workspaceId: string;
  runId: string;
  key?: string;
  expectedVersion?: number;
}

type StartRaceWorkerMessage =
  | { outcome: 'live'; httpStatus: number; replayed: boolean; body: unknown }
  | { outcome: 'error'; code: string | null; message: string };

function executeStartRaceWorkerCall(data: StartRaceWorkerData): StartRaceWorkerMessage {
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(data.root);
    const service = new TaskRunService(store, {
      idempotencyService: new IdempotencyService(store.idempotencyRepository()),
    });
    const result = data.mode === 'run-retry-race'
      ? service.retryRunOperationForV2(data.workspaceId, data.runId, data.key ?? '', data.expectedVersion ?? 0)
      : service.startRunOperationForV2(data.workspaceId, data.runId, data.key);
    return { outcome: 'live', httpStatus: result.httpStatus, replayed: result.replayed, body: result.body };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return {
      outcome: 'error',
      code: typeof code === 'string' ? code : null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    store?.close();
  }
}

const currentWorkerData = workerData as StartRaceWorkerData | undefined;

if (!isMainThread && parentPort && (currentWorkerData?.mode === 'run-start-race' || currentWorkerData?.mode === 'run-retry-race')) {
  // MEDIUM-3: 'ready' means START CALL READY — the store, its migrations,
  // and the service are fully constructed before the barrier; 'go' fires
  // only startRunOperationForV2, so the two workers truly race A1.
  const port = parentPort;
  const data = currentWorkerData;
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(data.root);
    const service = new TaskRunService(store, {
      idempotencyService: new IdempotencyService(store.idempotencyRepository()),
    });
    port.postMessage('ready');
    port.once('message', message => {
      if (message !== 'go') {
        store?.close();
        port.close();
        return;
      }
      let result: StartRaceWorkerMessage;
      try {
        const call = data.mode === 'run-retry-race'
          ? service.retryRunOperationForV2(data.workspaceId, data.runId, data.key ?? '', data.expectedVersion ?? 0)
          : service.startRunOperationForV2(data.workspaceId, data.runId, data.key);
        result = { outcome: 'live', httpStatus: call.httpStatus, replayed: call.replayed, body: call.body };
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        result = {
          outcome: 'error',
          code: typeof code === 'string' ? code : null,
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        store?.close();
      }
      port.postMessage(result);
      port.close();
    });
  } catch (error) {
    store?.close();
    const code = (error as { code?: unknown } | null)?.code;
    port.postMessage({
      outcome: 'error',
      code: typeof code === 'string' ? code : null,
      message: error instanceof Error ? error.message : String(error),
    });
    port.close();
  }
} else if (!isMainThread && parentPort && currentWorkerData?.mode === 'store-open-under-lock') {
  // R28 keeps constructor-under-lock semantics on this separate mode: the
  // barrier is signalled first and the SqliteStore constructor runs under
  // the foreign lock after 'go'.
  const port = parentPort;
  port.postMessage('ready');
  port.once('message', message => {
    if (message !== 'go') {
      port.close();
      return;
    }
    const result = executeStartRaceWorkerCall(currentWorkerData);
    port.postMessage(result);
    port.close();
  });
} else {

interface SpawnedRaceWorker {
  ready: Promise<void>;
  go: () => void;
  result: Promise<StartRaceWorkerMessage>;
}

function spawnStartRaceWorker(data: StartRaceWorkerData): SpawnedRaceWorker {
  const worker = new Worker(new URL('./runLifecycle.test.ts', import.meta.url), {
    workerData: data,
    execArgv: ['--import', 'tsx'],
  });
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveResult!: (message: StartRaceWorkerMessage) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const result = new Promise<StartRaceWorkerMessage>((resolvePromise, rejectPromise) => {
    resolveResult = resolvePromise;
    rejectResult = rejectPromise;
  });
  let readySettled = false;
  worker.on('message', message => {
    if (message === 'ready') {
      readySettled = true;
      resolveReady();
      return;
    }
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error(
        `start race worker failed before signalling ready: ${(message as { message?: string }).message ?? 'unknown'}`,
      ));
    }
    resolveResult(message as StartRaceWorkerMessage);
  });
  worker.once('error', rejectResult);
  worker.once('exit', code => {
    if (code !== 0) rejectResult(new Error(`start race worker exited with ${code}`));
  });
  return { ready, go: () => worker.postMessage('go'), result };
}

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-run-lifecycle-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  return root;
}

function isFetchBadPortError(error: unknown): boolean {
  return (error as { cause?: { message?: unknown } } | null)?.cause?.message === 'bad port';
}

async function closeTestServer(server: ReturnType<express.Express['listen']>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
}

async function listenOnFetchSafePort(app: express.Express): Promise<{ server: ReturnType<typeof app.listen>; port: number }> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
      const probe = await fetch(`http://127.0.0.1:${address.port}/__test_fetch_port_probe`, { method: 'HEAD' });
      if (probe.status !== 204) throw new Error(`test fetch probe returned ${probe.status}`);
      return { server, port: address.port };
    } catch (error) {
      await closeTestServer(server);
      if (!isFetchBadPortError(error)) throw error;
    }
  }
  throw new Error('TEST_FETCH_SAFE_PORT_UNAVAILABLE');
}

function buildSeededRun(store: SqliteStore, workspaceId: string): { taskId: string; runId: string } {
  const service = new TaskRunService(store);
  const task = service.createTask(workspaceId, { title: 'start-route-target', createdBy: 'test' });
  const run = service.createRun(workspaceId, { taskId: task.id, createdBy: 'test' });
  return { taskId: task.id, runId: run.id };
}

interface RouteFixture {
  root: string;
  store: SqliteStore;
  server: ReturnType<express.Express['listen']>;
  baseApi: string;
  workspaceId: string;
  taskId: string;
  runId: string;
}

async function createRouteFixture(mountStore?: TaskRunServiceDeps): Promise<RouteFixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('Start Workspace', join(root, 'workspace-a'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const seeded = buildSeededRun(store, workspace.id);
  const app = express();
  // Mirror production: the lifecycle router (owning a scoped non-strict
  // parser) mounts ahead of the global strict JSON parser.
  app.use('/api', createRunLifecycleRoutes(mountStore ?? store));
  app.use(express.json());
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  const { server, port } = await listenOnFetchSafePort(app);
  return {
    root,
    store,
    server,
    baseApi: `http://127.0.0.1:${port}/api`,
    workspaceId: workspace.id,
    taskId: seeded.taskId,
    runId: seeded.runId,
  };
}

async function closeRouteFixture(fx: RouteFixture): Promise<void> {
  await closeTestServer(fx.server);
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

interface StartResponse {
  status: number;
  text: string;
  json: Record<string, unknown> | null;
  replayedHeader: string | null;
}

async function postStart(
  fx: RouteFixture,
  runId: string,
  options: { body?: unknown; raw?: string; contentType?: string | null; key?: string; query?: string } = {},
): Promise<StartResponse> {
  const headers: Record<string, string> = {};
  const contentType = options.contentType === undefined
    ? (options.body !== undefined || options.raw !== undefined ? 'application/json' : null)
    : options.contentType;
  if (contentType) headers['Content-Type'] = contentType;
  if (options.key) headers['Idempotency-Key'] = options.key;
  const response = await fetch(`${fx.baseApi}/runs/${runId}/start${options.query ?? ''}`, {
    method: 'POST',
    headers,
    body: options.raw !== undefined ? options.raw : (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, text, json, replayedHeader: response.headers.get('idempotency-replayed') };
}

async function postRetry(
  fx: RouteFixture,
  runId: string,
  options: { body?: unknown; raw?: string; contentType?: string | null; key?: string; query?: string } = {},
): Promise<StartResponse> {
  const headers: Record<string, string> = {};
  const contentType = options.contentType === undefined
    ? (options.body !== undefined || options.raw !== undefined ? 'application/json' : null)
    : options.contentType;
  if (contentType) headers['Content-Type'] = contentType;
  if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
  const response = await fetch(`${fx.baseApi}/runs/${runId}/retry${options.query ?? ''}`, {
    method: 'POST',
    headers,
    body: options.raw !== undefined ? options.raw : (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  });
  const text = await response.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: response.status, text, json, replayedHeader: response.headers.get('idempotency-replayed') };
}

function failRouteParent(fx: RouteFixture): Run {
  let parent = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
  fx.store.runRepository().transitionStatus(fx.workspaceId, parent.id, parent.version, 'running');
  parent = fx.store.runRepository().findById(fx.workspaceId, parent.id)!;
  return fx.store.runRepository().transitionStatus(
    fx.workspaceId,
    parent.id,
    parent.version,
    'failed',
    { failureCode: 'TEST_FAILURE', failureMessage: 'test failure' },
  );
}

function tableRowCount(store: SqliteStore, table: string): number {
  return (store.getDatabase().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function expectOperationBody(body: unknown, workspaceId: string, runId: string): Record<string, unknown> {
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body));
  const record = body as Record<string, unknown>;
  assert.deepEqual(Object.keys(record), ['operation']);
  const operation = record.operation as Record<string, unknown>;
  assert.deepEqual(Object.keys(operation).sort(), [
    'aggregateId',
    'aggregateType',
    'correlationId',
    'createdAt',
    'id',
    'runId',
    'status',
    'type',
    'version',
    'workspaceId',
  ]);
  assert.match(String(operation.id), /^op_[0-9A-HJKM-NP-TV-Z]{26}$/);
  assert.equal(operation.type, 'run.start');
  assert.equal(operation.status, 'queued');
  assert.equal(operation.workspaceId, workspaceId);
  assert.equal(operation.aggregateType, 'run');
  assert.equal(operation.aggregateId, runId);
  assert.equal(operation.runId, runId);
  assert.equal(operation.correlationId, operation.id);
  assert.equal(operation.version, 1);
  return operation;
}

function expectErrorBody(response: StartResponse, status: number, code: string): void {
  assert.equal(response.status, status);
  assert.ok(response.json !== null);
  assert.deepEqual(
    Object.keys(response.json).sort(),
    ['code', 'detail', 'instance', 'requestId', 'retryable', 'status', 'title', 'type'],
  );
  assert.equal(response.json.code, code);
  assert.equal(response.json.status, status);
  assert.equal(typeof response.json.detail, 'string');
  assert.equal(typeof response.json.requestId, 'string');
  assert.doesNotMatch(response.text, /SQLITE|sql|database is locked|\.agentos/i);
}

test('P3C1-R01 canonical URL accepts a live no-key start with the exact 202 operation body', async () => {
  const fx = await createRouteFixture();
  try {
    // Run creation persists run.created Runtime Event + Outbox rows (P2C-2C);
    // A1 acceptance must not add anything beyond the queued Operation.
    const eventsBefore = tableRowCount(fx.store, 'runtime_events');
    const outboxBefore = tableRowCount(fx.store, 'outbox_messages');
    const deadLettersBefore = tableRowCount(fx.store, 'dead_letters');
    const response = await postStart(fx, fx.runId, { body: {} });
    assert.equal(response.status, 202);
    expectOperationBody(response.json, fx.workspaceId, fx.runId);
    assert.equal(response.replayedHeader, null);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
    assert.equal(tableRowCount(fx.store, 'runtime_events'), eventsBefore);
    assert.equal(tableRowCount(fx.store, 'outbox_messages'), outboxBefore);
    assert.equal(tableRowCount(fx.store, 'dead_letters'), deadLettersBefore);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R02 no workspace-scoped start URL exists', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await fetch(`${fx.baseApi}/workspaces/${fx.workspaceId}/runs/${fx.runId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 404);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R03 the locator runs before body validation', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, 'run_01J00000000000000000000000', { raw: '[]' });
    expectErrorBody(response, 404, 'RUN_NOT_FOUND');
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R04 an undefined body is rejected', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, fx.runId, { contentType: null });
    expectErrorBody(response, 400, 'VALIDATION_FAILED');
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R05 a null body is rejected', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, fx.runId, { raw: 'null' });
    expectErrorBody(response, 400, 'VALIDATION_FAILED');
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R06 an array body is rejected', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, fx.runId, { raw: '[]' });
    expectErrorBody(response, 400, 'VALIDATION_FAILED');
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R07 a string body is rejected', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, fx.runId, { raw: '"start"' });
    expectErrorBody(response, 400, 'VALIDATION_FAILED');
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R08 a number body is rejected', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, fx.runId, { raw: '1' });
    expectErrorBody(response, 400, 'VALIDATION_FAILED');
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R09 a boolean body is rejected', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, fx.runId, { raw: 'true' });
    expectErrorBody(response, 400, 'VALIDATION_FAILED');
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R10 unknown body fields are rejected', async () => {
  const fx = await createRouteFixture();
  try {
    const forbidden = ['workspaceId', 'createdBy', 'requestedBy', 'reason', 'operationId', 'correlationId', 'runId', 'anythingElse'];
    for (const field of forbidden) {
      const response = await postStart(fx, fx.runId, { body: { [field]: field === 'expectedVersion' ? 1 : 'x' } });
      expectErrorBody(response, 400, 'VALIDATION_FAILED');
    }
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R11 expectedVersion must be a positive safe integer when present', async () => {
  const fx = await createRouteFixture();
  try {
    const invalid = [null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1];
    for (const value of invalid) {
      const response = await postStart(fx, fx.runId, { raw: JSON.stringify({ expectedVersion: value }) });
      expectErrorBody(response, 400, 'VALIDATION_FAILED');
    }
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
    const accepted = await postStart(fx, fx.runId, { body: { expectedVersion: 1 } });
    assert.equal(accepted.status, 202);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R12 query parameters are not accepted', async () => {
  const fx = await createRouteFixture();
  try {
    const byWorkspace = await postStart(fx, fx.runId, { body: {}, query: `?workspaceId=${fx.workspaceId}` });
    expectErrorBody(byWorkspace, 400, 'VALIDATION_FAILED');
    const byVersion = await postStart(fx, fx.runId, { body: {}, query: '?expectedVersion=1' });
    expectErrorBody(byVersion, 400, 'VALIDATION_FAILED');
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R13 keyed live then replay returns the identical snapshot with the replay header', async () => {
  const fx = await createRouteFixture();
  try {
    const live = await postStart(fx, fx.runId, { body: {}, key: 'p3c1-route-key-0001' });
    assert.equal(live.status, 202);
    assert.equal(live.replayedHeader, null);
    expectOperationBody(live.json, fx.workspaceId, fx.runId);
    const replay = await postStart(fx, fx.runId, { body: {}, key: 'p3c1-route-key-0001' });
    assert.equal(replay.status, 202);
    assert.equal(replay.replayedHeader, 'true');
    assert.deepEqual(replay.json, live.json);
    assert.equal(tableRowCount(fx.store, 'operations'), 1);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 1);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R14 the same key with a different fingerprint is rejected without new side effects', async () => {
  const fx = await createRouteFixture();
  try {
    const live = await postStart(fx, fx.runId, { body: { expectedVersion: 1 }, key: 'p3c1-route-key-0002' });
    assert.equal(live.status, 202);
    const reused = await postStart(fx, fx.runId, { body: {}, key: 'p3c1-route-key-0002' });
    expectErrorBody(reused, 409, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(tableRowCount(fx.store, 'operations'), 1);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 1);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R15 an unknown run returns 404 RUN_NOT_FOUND', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, 'run_01J00000000000000000000000', { body: {} });
    expectErrorBody(response, 404, 'RUN_NOT_FOUND');
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R16 an expectedVersion mismatch returns 409 VERSION_CONFLICT', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, fx.runId, { body: { expectedVersion: 2 } });
    expectErrorBody(response, 409, 'VERSION_CONFLICT');
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R17 a non-queued run returns 409 INVALID_RUN_TRANSITION', async () => {
  const fx = await createRouteFixture();
  try {
    const run = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    fx.store.runRepository().transitionStatus(fx.workspaceId, fx.runId, run.version, 'running');
    const response = await postStart(fx, fx.runId, { body: {} });
    expectErrorBody(response, 409, 'INVALID_RUN_TRANSITION');
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R18 a second start while one is queued returns 409 RUN_START_ALREADY_ACTIVE', async () => {
  const fx = await createRouteFixture();
  try {
    const live = await postStart(fx, fx.runId, { body: {}, key: 'p3c1-route-key-0003' });
    assert.equal(live.status, 202);
    const differentKey = await postStart(fx, fx.runId, { body: {}, key: 'p3c1-route-key-0004' });
    expectErrorBody(differentKey, 409, 'RUN_START_ALREADY_ACTIVE');
    const noKey = await postStart(fx, fx.runId, { body: {} });
    expectErrorBody(noKey, 409, 'RUN_START_ALREADY_ACTIVE');
    assert.equal(tableRowCount(fx.store, 'operations'), 1);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 1);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R19 multiple non-terminal starts return 500 RUN_START_AUTHORIZATION_AMBIGUOUS', async () => {
  const fx = await createRouteFixture();
  try {
    const operations = new OperationService(fx.store.getDatabase() as never);
    operations.createWithinTransaction({ workspaceId: fx.workspaceId, runId: fx.runId, type: 'run.start' });
    operations.createWithinTransaction({ workspaceId: fx.workspaceId, runId: fx.runId, type: 'run.start' });
    const response = await postStart(fx, fx.runId, { body: {} });
    expectErrorBody(response, 500, 'RUN_START_AUTHORIZATION_AMBIGUOUS');
    assert.equal(tableRowCount(fx.store, 'operations'), 2);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R20 an inconsistent start history returns 500 RUN_START_STATE_INCONSISTENT', async () => {
  const fx = await createRouteFixture();
  try {
    const operations = new OperationService(fx.store.getDatabase() as never);
    const seeded = operations.createWithinTransaction({ workspaceId: fx.workspaceId, runId: fx.runId, type: 'run.start' });
    operations.transitionWithinTransaction({ workspaceId: fx.workspaceId, operationId: seeded.id, expectedVersion: 1, to: 'running' });
    const response = await postStart(fx, fx.runId, { body: {} });
    expectErrorBody(response, 500, 'RUN_START_STATE_INCONSISTENT');
    assert.equal(tableRowCount(fx.store, 'operations'), 1);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R21 a real SQLite busy timeout maps to a sanitized 503 RUN_START_BUSY', async () => {
  const fx = await createRouteFixture();
  const locker = new DatabaseSync(join(fx.root, '.agentos', 'agentos.sqlite'));
  try {
    locker.exec('BEGIN IMMEDIATE');
    const startedAt = Date.now();
    const response = await postStart(fx, fx.runId, { body: {} });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(response.status, 503);
    assert.ok(response.json !== null);
    assert.equal(response.json.code, 'RUN_START_BUSY');
    assert.equal(response.json.detail, 'Run start is temporarily unavailable');
    assert.equal(response.json.retryable, true);
    assert.doesNotMatch(response.text, /SQLITE|SQL|database is locked|BEGIN IMMEDIATE/);
    // Production busy_timeout is 5000ms: the loser waited for the real timeout.
    assert.ok(elapsedMs >= 4000, `expected the request to wait for the busy timeout, got ${elapsedMs}ms`);
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
  } finally {
    locker.exec('ROLLBACK');
    locker.close();
    await closeRouteFixture(fx);
  }
});

test('P3C1-R22 a missing OperationService capability is sanitized to 500 INTERNAL_ERROR before mutation', async () => {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  try {
    const manager = new WorkspaceManager(store);
    const workspace = manager.create('Capability Workspace', join(root, 'workspace-b'), {
      git: false, memory: false, readme: false, docs: false,
    });
    const seeded = buildSeededRun(store, workspace.id);
    const depsWithoutCapability = {
      taskRepository: () => store.taskRepository(),
      runRepository: () => store.runRepository(),
      workflowDefinitionRepository: () => store.workflowDefinitionRepository(),
      runSnapshotRepository: () => store.runSnapshotRepository(),
      runStageRepository: () => store.runStageRepository(),
      providerConfigurationRepository: () => store.providerConfigurationRepository(),
      findAgentSnapshotSource: (workspaceId: string, agentId: string) => store.findAgentSnapshotSource(workspaceId, agentId),
      runInTransaction: <T,>(fn: () => T): T => store.runInTransaction(fn),
      lifecycleTransactionService: () => store.lifecycleTransactionService(),
      idempotencyRepository: () => store.idempotencyRepository(),
    };
    const fx = await createRouteFixtureOnStore(root, store, depsWithoutCapability, workspace.id, seeded);
    try {
      for (const key of [undefined, 'p3c1-route-key-0005'] as const) {
        const response = await postStart(fx, seeded.runId, { body: {}, ...(key ? { key } : {}) });
        expectErrorBody(response, 500, 'INTERNAL_ERROR');
      }
      assert.equal(tableRowCount(store, 'operations'), 0);
      assert.equal(tableRowCount(store, 'idempotency_records'), 0);
    } finally {
      await closeTestServer(fx.server);
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function createRouteFixtureOnStore(
  root: string,
  store: SqliteStore,
  mountStore: TaskRunServiceDeps,
  workspaceId: string,
  seeded: { taskId: string; runId: string },
): Promise<RouteFixture> {
  const app = express();
  app.use('/api', createRunLifecycleRoutes(mountStore));
  app.use(express.json());
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  const { server, port } = await listenOnFetchSafePort(app);
  return {
    root,
    store,
    server,
    baseApi: `http://127.0.0.1:${port}/api`,
    workspaceId,
    taskId: seeded.taskId,
    runId: seeded.runId,
  };
}

test('P3C1-R23 the route module touches no Engine, Provider, Process, or CLI surface', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'runLifecycle.ts'), 'utf8');
  assert.doesNotMatch(source, /run-engine|RunEngine|WorkflowExecutor|StageExecutor|child_process|spawn\(|exec\(|ProviderConfiguration\b.*validate|CliModelDiscovery/);
});

test('P3C1-R24 index.ts mounts the lifecycle router exactly once on /api', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const indexSource = readFileSync(join(here, '..', 'index.ts'), 'utf8');
  const mounts = indexSource.match(/app\.use\('\/api', createRunLifecycleRoutes\(store\)\);/g) ?? [];
  assert.equal(mounts.length, 1);
});

// -------------------------------------------------------------------------
// §16 concurrency evidence — real shared SQLite file, two workers, 'go'
// barrier. Losers resolve or hit the history guard; never a 503.
// -------------------------------------------------------------------------

interface RaceFixture {
  root: string;
  store: SqliteStore;
  workspaceId: string;
  taskId: string;
  runId: string;
}

function createRaceFixture(): RaceFixture {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('Race Workspace', join(root, 'workspace-race'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const seeded = buildSeededRun(store, workspace.id);
  return { root, store, workspaceId: workspace.id, taskId: seeded.taskId, runId: seeded.runId };
}

function closeRaceFixture(fx: RaceFixture): void {
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

async function runStartRace(
  fx: RaceFixture,
  a: { key?: string },
  b: { key?: string },
): Promise<[StartRaceWorkerMessage, StartRaceWorkerMessage]> {
  const workerA = spawnStartRaceWorker({ mode: 'run-start-race', root: fx.root, workspaceId: fx.workspaceId, runId: fx.runId, ...(a.key ? { key: a.key } : {}) });
  const workerB = spawnStartRaceWorker({ mode: 'run-start-race', root: fx.root, workspaceId: fx.workspaceId, runId: fx.runId, ...(b.key ? { key: b.key } : {}) });
  await Promise.all([workerA.ready, workerB.ready]);
  workerA.go();
  workerB.go();
  return Promise.all([workerA.result, workerB.result]);
}

test('P3C1-R25 same-key race: exactly one live 202 and one replay 202 with one operation and one record', async () => {
  const fx = createRaceFixture();
  try {
    const [a, b] = await runStartRace(fx, { key: 'p3c1-race-key-same1' }, { key: 'p3c1-race-key-same1' });
    const messages = [a, b];
    const lives = messages.filter(message => message.outcome === 'live' && !message.replayed);
    const replays = messages.filter(message => message.outcome === 'live' && message.replayed);
    assert.equal(lives.length, 1);
    assert.equal(replays.length, 1);
    assert.equal((lives[0] as { httpStatus: number }).httpStatus, 202);
    assert.equal((replays[0] as { httpStatus: number }).httpStatus, 202);
    assert.deepEqual(
      (replays[0] as { body: unknown }).body,
      (lives[0] as { body: unknown }).body,
    );
    const operations = fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.start'").get() as { count: number };
    assert.equal(operations.count, 1);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 1);
  } finally {
    closeRaceFixture(fx);
  }
});

test('P3C1-R26 different-key race: exactly one live 202 and one stable 409 RUN_START_ALREADY_ACTIVE', async () => {
  const fx = createRaceFixture();
  try {
    const [a, b] = await runStartRace(fx, { key: 'p3c1-race-key-diff1' }, { key: 'p3c1-race-key-diff2' });
    const messages = [a, b];
    const lives = messages.filter(message => message.outcome === 'live');
    const conflicts = messages.filter(message => message.outcome === 'error' && message.code === 'RUN_START_ALREADY_ACTIVE');
    assert.equal(lives.length, 1);
    assert.equal(conflicts.length, 1);
    assert.equal((lives[0] as { httpStatus: number; replayed: boolean }).httpStatus, 202);
    assert.equal((lives[0] as { replayed: boolean }).replayed, false);
    const operations = fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.start'").get() as { count: number };
    assert.equal(operations.count, 1);
  } finally {
    closeRaceFixture(fx);
  }
});

test('P3C1-R27 no-key race: exactly one live 202, one stable 409 RUN_START_ALREADY_ACTIVE, and no idempotency record', async () => {
  const fx = createRaceFixture();
  try {
    const [a, b] = await runStartRace(fx, {}, {});
    const messages = [a, b];
    const lives = messages.filter(message => message.outcome === 'live');
    const conflicts = messages.filter(message => message.outcome === 'error' && message.code === 'RUN_START_ALREADY_ACTIVE');
    assert.equal(lives.length, 1);
    assert.equal(conflicts.length, 1);
    assert.equal((lives[0] as { httpStatus: number }).httpStatus, 202);
    const operations = fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.start'").get() as { count: number };
    assert.equal(operations.count, 1);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    closeRaceFixture(fx);
  }
});

function failRaceRun(fx: RaceFixture, runId: string): number {
  let run = fx.store.runRepository().findById(fx.workspaceId, runId)!;
  if (run.status === 'queued') {
    fx.store.runRepository().transitionStatus(fx.workspaceId, run.id, run.version, 'running');
    run = fx.store.runRepository().findById(fx.workspaceId, run.id)!;
  }
  const failed = fx.store.runRepository().transitionStatus(
    fx.workspaceId,
    run.id,
    run.version,
    'failed',
    { failureCode: 'RACE_FAILURE', failureMessage: 'race failure' },
  );
  return failed.version;
}

interface RetryRaceFixture extends RaceFixture {
  parentVersion: number;
  secondRunId?: string;
  secondParentVersion?: number;
}

function createRetryRaceFixture(twoParents = false): RetryRaceFixture {
  const fx = createRaceFixture();
  const parentVersion = failRaceRun(fx, fx.runId);
  if (!twoParents) return { ...fx, parentVersion };
  const service = new TaskRunService(fx.store);
  const second = service.createRun(fx.workspaceId, {
    taskId: fx.taskId,
    reason: 'manual',
    createdBy: 'race-test',
  });
  const secondParentVersion = failRaceRun(fx, second.id);
  return { ...fx, parentVersion, secondRunId: second.id, secondParentVersion };
}

async function runRetryRace(
  fx: RetryRaceFixture,
  a: { runId: string; expectedVersion: number; key: string },
  b: { runId: string; expectedVersion: number; key: string },
): Promise<[StartRaceWorkerMessage, StartRaceWorkerMessage]> {
  const workerA = spawnStartRaceWorker({
    mode: 'run-retry-race', root: fx.root, workspaceId: fx.workspaceId,
    runId: a.runId, expectedVersion: a.expectedVersion, key: a.key,
  });
  const workerB = spawnStartRaceWorker({
    mode: 'run-retry-race', root: fx.root, workspaceId: fx.workspaceId,
    runId: b.runId, expectedVersion: b.expectedVersion, key: b.key,
  });
  await Promise.all([workerA.ready, workerB.ready]);
  workerA.go();
  workerB.go();
  return Promise.all([workerA.result, workerB.result]);
}

test('P3C1-RY-C01 same Parent + same key has one live 201 and one replay 201', async () => {
  const fx = createRetryRaceFixture();
  try {
    const [a, b] = await runRetryRace(
      fx,
      { runId: fx.runId, expectedVersion: fx.parentVersion, key: 'retry-race-same-key-01' },
      { runId: fx.runId, expectedVersion: fx.parentVersion, key: 'retry-race-same-key-01' },
    );
    const messages = [a, b];
    const live = messages.filter(message => message.outcome === 'live' && !message.replayed);
    const replay = messages.filter(message => message.outcome === 'live' && message.replayed);
    assert.equal(live.length, 1);
    assert.equal(replay.length, 1);
    assert.equal((live[0] as { httpStatus: number }).httpStatus, 201);
    assert.equal((replay[0] as { httpStatus: number }).httpStatus, 201);
    assert.equal(messages.some(message => message.outcome === 'error'), false);
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.retry'").get() as { count: number }).count, 1);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?').get(fx.runId) as { count: number }).count, 1);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }).count, 1);
  } finally {
    closeRaceFixture(fx);
  }
});

test('P3C1-RY-C02 same Parent + different keys has one 201 and one RUN_RETRY_ALREADY_CREATED 409', async () => {
  const fx = createRetryRaceFixture();
  try {
    const [a, b] = await runRetryRace(
      fx,
      { runId: fx.runId, expectedVersion: fx.parentVersion, key: 'retry-race-different-a-01' },
      { runId: fx.runId, expectedVersion: fx.parentVersion, key: 'retry-race-different-b-01' },
    );
    const messages = [a, b];
    const live = messages.filter(message => message.outcome === 'live');
    const conflicts = messages.filter(message => message.outcome === 'error' && message.code === 'RUN_RETRY_ALREADY_CREATED');
    assert.equal(live.length, 1);
    assert.equal(conflicts.length, 1);
    assert.equal((live[0] as { httpStatus: number }).httpStatus, 201);
    assert.equal(messages.some(message => message.outcome === 'live' && (message as { httpStatus: number }).httpStatus === 503), false);
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.retry'").get() as { count: number }).count, 1);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?').get(fx.runId) as { count: number }).count, 1);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }).count, 1);
  } finally {
    closeRaceFixture(fx);
  }
});

test('P3C1-RY-C03 same Task + two failed Parents has one 201 and one RUN_ACTIVE_EXISTS 409', async () => {
  const fx = createRetryRaceFixture(true);
  try {
    assert.ok(fx.secondRunId);
    assert.ok(fx.secondParentVersion);
    const [a, b] = await runRetryRace(
      fx,
      { runId: fx.runId, expectedVersion: fx.parentVersion, key: 'retry-race-task-a-01' },
      { runId: fx.secondRunId!, expectedVersion: fx.secondParentVersion!, key: 'retry-race-task-b-01' },
    );
    const messages = [a, b];
    const live = messages.filter(message => message.outcome === 'live');
    const conflicts = messages.filter(message => message.outcome === 'error' && message.code === 'RUN_ACTIVE_EXISTS');
    assert.equal(live.length, 1);
    assert.equal(conflicts.length, 1);
    assert.equal((live[0] as { httpStatus: number }).httpStatus, 201);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND status IN (\'queued\',\'starting\',\'running\',\'waiting_approval\',\'paused\')').get(fx.taskId) as { count: number }).count, 1);
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.retry'").get() as { count: number }).count, 1);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }).count, 1);
  } finally {
    closeRaceFixture(fx);
  }
});

test('P3C1-R28 a store connection waits out a short foreign write lock instead of failing busy', async () => {
  const fx = createRaceFixture();
  const locker = new DatabaseSync(join(fx.root, '.agentos', 'agentos.sqlite'));
  try {
    const worker = spawnStartRaceWorker({ mode: 'store-open-under-lock', root: fx.root, workspaceId: fx.workspaceId, runId: fx.runId });
    await worker.ready;
    locker.exec('BEGIN IMMEDIATE');
    const startedAt = Date.now();
    worker.go();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
    locker.exec('ROLLBACK');
    const message = await worker.result;
    const elapsedMs = Date.now() - startedAt;
    assert.equal(message.outcome, 'live');
    if (message.outcome === 'live') {
      assert.equal(message.httpStatus, 202);
      assert.equal(message.replayed, false);
    }
    // busy_timeout let the worker wait out the 300ms lock instead of failing fast.
    assert.ok(elapsedMs >= 250, `expected the worker to wait for the lock, got ${elapsedMs}ms`);
  } finally {
    locker.close();
    closeRaceFixture(fx);
  }
});

// -------------------------------------------------------------------------
// Remote review remediation 1 — HIGH-1 locator-first ordering, route-local
// safe parser mapping, and the MEDIUM-1 zero-byte payload contract.
// -------------------------------------------------------------------------

test('P3C1-R29 unknown run + malformed JSON keeps 404 precedence over parser errors', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, 'run_01J00000000000000000000000', { raw: '{"expectedVersion":' });
    expectErrorBody(response, 404, 'RUN_NOT_FOUND');
    assert.doesNotMatch(response.text, /SyntaxError|Unexpected token|JSON\.parse|stack|E:\\|C:\\/i);
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R30 known run + malformed JSON maps to a sanitized 400 VALIDATION_FAILED', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, fx.runId, { raw: '{"expectedVersion":' });
    assert.equal(response.status, 400);
    assert.ok(response.json !== null);
    assert.equal(response.json.code, 'VALIDATION_FAILED');
    assert.equal(response.json.detail, 'Request body must be a valid JSON object');
    assert.doesNotMatch(response.text, /SyntaxError|Unexpected token|JSON\.parse|stack|database is locked|E:\\|C:\\/i);
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R31 a zero-byte JSON payload is rejected and writes nothing', async () => {
  const fx = await createRouteFixture();
  try {
    const runBefore = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    const taskBefore = fx.store.taskRepository().findById(fx.workspaceId, fx.taskId)!;
    const response = await postStart(fx, fx.runId, { raw: '' });
    expectErrorBody(response, 400, 'VALIDATION_FAILED');
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
    const runAfter = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    const taskAfter = fx.store.taskRepository().findById(fx.workspaceId, fx.taskId)!;
    assert.deepEqual(
      { status: runAfter.status, version: runAfter.version },
      { status: runBefore.status, version: runBefore.version },
    );
    assert.deepEqual(
      { status: taskAfter.status, version: taskAfter.version },
      { status: taskBefore.status, version: taskBefore.version },
    );
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R32 an empty chunked JSON payload is rejected and writes nothing', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new ReadableStream({ start(controller) { controller.close(); } }),
      duplex: 'half',
    } as unknown as RequestInit);
    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    assert.equal(response.status, 400);
    assert.ok(json !== null);
    assert.equal(json.code, 'VALIDATION_FAILED');
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R33 application/json with a charset parameter accepts an explicit {} as 202', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, fx.runId, { raw: '{}', contentType: 'application/json; charset=utf-8' });
    assert.equal(response.status, 202);
    expectOperationBody(response.json, fx.workspaceId, fx.runId);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R34 a non-JSON content type is rejected and writes nothing', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postStart(fx, fx.runId, { body: {}, contentType: 'text/plain' });
    expectErrorBody(response, 400, 'VALIDATION_FAILED');
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R35 an oversized JSON payload maps to a sanitized 400 VALIDATION_FAILED', async () => {
  const fx = await createRouteFixture();
  try {
    const oversized = '{"pad":"' + 'x'.repeat(160 * 1024) + '"}';
    const response = await postStart(fx, fx.runId, { raw: oversized });
    assert.equal(response.status, 400);
    assert.ok(response.json !== null);
    assert.equal(response.json.code, 'VALIDATION_FAILED');
    assert.doesNotMatch(response.text, /too large|entity|stack|E:\\|C:\\/i);
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-R36 start-race workers finish store construction before signalling ready', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, 'runLifecycle.test.ts'), 'utf8');
  // MEDIUM-3: in the run-start-race worker branch, 'ready' must mean
  // START CALL READY — the store and service are fully constructed first.
  const raceBranch = source.indexOf("currentWorkerData?.mode === 'run-start-race'");
  assert.ok(raceBranch >= 0, 'run-start-race worker branch must exist');
  const raceSection = source.slice(raceBranch, raceBranch + 3000);
  const constructIndex = raceSection.indexOf('new SqliteStore(');
  const readyIndex = raceSection.indexOf("postMessage('ready')");
  assert.ok(constructIndex >= 0, 'run-start-race worker branch must construct the store itself');
  assert.ok(readyIndex >= 0, 'run-start-race worker branch must post ready');
  assert.ok(
    constructIndex < readyIndex,
    'run-start-race workers must construct SqliteStore before posting ready',
  );
  // R28 keeps constructor-under-lock semantics on a separate worker mode
  // (referenced twice outside this assertion: the mode guard and the spawn).
  assert.ok(
    source.split('store-open-under-lock').length >= 3,
    'store-open-under-lock worker mode must exist for the constructor lock test',
  );
});

test('P3C1-RY01 canonical Retry route accepts a failed Parent and returns HTTP 201', async () => {
  const fx = await createRouteFixture();
  try {
    let parent = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    fx.store.runRepository().transitionStatus(fx.workspaceId, parent.id, parent.version, 'running');
    parent = fx.store.runRepository().findById(fx.workspaceId, parent.id)!;
    parent = fx.store.runRepository().transitionStatus(
      fx.workspaceId,
      parent.id,
      parent.version,
      'failed',
      { failureCode: 'TEST_FAILURE', failureMessage: 'test failure' },
    );
    const response = await fetch(`${fx.baseApi}/runs/${parent.id}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'retry-route-key' },
      body: JSON.stringify({ expectedVersion: parent.version }),
    });
    assert.equal(response.status, 201);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-RY02 Retry locator precedes malformed body, query, and invalid key validation', async () => {
  const fx = await createRouteFixture();
  try {
    const cases = [
      { raw: '{', query: '?unexpected=1', key: 'bad' },
      { raw: 'null', query: '', key: 'bad,key' },
      { raw: '', query: '?workspaceId=secret', key: '' },
    ];
    for (const item of cases) {
      const response = await postRetry(fx, 'run_01J00000000000000000000000', item);
      expectErrorBody(response, 404, 'RUN_NOT_FOUND');
    }
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-RY03 Retry rejects query parameters before body and key processing', async () => {
  const fx = await createRouteFixture();
  try {
    const response = await postRetry(fx, fx.runId, {
      body: { expectedVersion: 1 },
      key: 'retry-query-key-01',
      query: '?workspaceId=forbidden',
    });
    expectErrorBody(response, 400, 'VALIDATION_FAILED');
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-RY04 Retry enforces the exact JSON body contract', async () => {
  const fx = await createRouteFixture();
  try {
    const cases: Array<{ label: string; options: Parameters<typeof postRetry>[2] }> = [
      { label: 'missing content type', options: { body: { expectedVersion: 1 }, contentType: null, key: 'retry-body-key-01' } },
      { label: 'wrong content type', options: { body: { expectedVersion: 1 }, contentType: 'text/plain', key: 'retry-body-key-02' } },
      { label: 'zero byte', options: { raw: '', key: 'retry-body-key-03' } },
      { label: 'malformed json', options: { raw: '{"expectedVersion":', key: 'retry-body-key-04' } },
      { label: 'null', options: { raw: 'null', key: 'retry-body-key-05' } },
      { label: 'array', options: { raw: '[]', key: 'retry-body-key-06' } },
      { label: 'string', options: { raw: '"retry"', key: 'retry-body-key-07' } },
      { label: 'number', options: { raw: '1', key: 'retry-body-key-08' } },
      { label: 'boolean', options: { raw: 'true', key: 'retry-body-key-09' } },
      { label: 'missing expectedVersion', options: { body: {}, key: 'retry-body-key-10' } },
    ];
    for (const item of cases) {
      const response = await postRetry(fx, fx.runId, item.options);
      expectErrorBody(response, 400, 'VALIDATION_FAILED');
    }
    for (const value of [null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      const response = await postRetry(fx, fx.runId, {
        raw: JSON.stringify({ expectedVersion: value }),
        key: `retry-version-key-${String(cases.length + Number(value === null))}`,
      });
      expectErrorBody(response, 400, 'VALIDATION_FAILED');
    }
    for (const field of [
      'mode', 'stageId', 'providerOverrides', 'reuseTaskMemory', 'reuseWorktree', 'reason',
      'createdBy', 'requestedBy', 'workspaceId', 'parentRunId', 'operationId', 'correlationId',
    ]) {
      const response = await postRetry(fx, fx.runId, {
        body: { expectedVersion: 1, [field]: 'forbidden' },
        key: `retry-field-${field.slice(0, 12)}-01`,
      });
      expectErrorBody(response, 400, 'VALIDATION_FAILED');
    }
    assert.equal(tableRowCount(fx.store, 'operations'), 0);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-RY05 Retry rejects every missing or malformed Idempotency-Key shape', async () => {
  const fx = await createRouteFixture();
  try {
    for (const [index, key] of [undefined, '', '   ', 'a,b', 'short', 'bad key', '!invalid!'].entries()) {
      const response = await postRetry(fx, fx.runId, {
        body: { expectedVersion: 1 },
        ...(key === undefined ? {} : { key }),
      });
      expectErrorBody(response, 400, 'VALIDATION_FAILED');
      if (key) assert.equal(response.text.includes(key), false, `raw key leaked for case ${index}`);
    }

    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/retry`, {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/json'],
        ['Idempotency-Key', 'retry-duplicate-key-01'],
        ['idempotency-key', 'retry-duplicate-key-02'],
      ],
      body: JSON.stringify({ expectedVersion: 1 }),
    });
    const text = await response.text();
    assert.equal(response.status, 400);
    assert.doesNotMatch(text, /retry-duplicate-key|SQLITE|database is locked|\.agentos/i);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-RY06 live and replay return the immutable HTTP 201 acceptance snapshot', async () => {
  const fx = await createRouteFixture();
  try {
    const parent = failRouteParent(fx);
    const live = await postRetry(fx, parent.id, { body: { expectedVersion: parent.version }, key: 'retry-live-key-0001' });
    assert.equal(live.status, 201);
    assert.equal(live.replayedHeader, null);
    assert.ok(live.json !== null);
    assert.deepEqual(Object.keys(live.json).sort(), ['operation', 'run']);
    const liveRun = live.json.run as Record<string, unknown>;
    const liveOperation = live.json.operation as Record<string, unknown>;
    assert.deepEqual(Object.keys(liveRun).sort(), [
      'createdAt', 'createdBy', 'id', 'nextEventSequence', 'origin', 'parentRunId',
      'reason', 'rootRunId', 'status', 'taskId', 'updatedAt', 'version', 'workspaceId',
    ]);
    assert.equal(liveRun.workspaceId, fx.workspaceId);
    assert.equal(liveRun.taskId, fx.taskId);
    assert.equal(liveRun.parentRunId, parent.id);
    assert.equal(liveRun.rootRunId, parent.rootRunId);
    assert.equal(liveRun.status, 'queued');
    assert.equal(liveRun.reason, 'retry');
    assert.equal(liveRun.origin, 'v2_api');
    assert.equal(liveRun.nextEventSequence, 1);
    assert.equal(liveRun.version, 1);
    assert.deepEqual(Object.keys(liveOperation).sort(), [
      'aggregateId', 'aggregateType', 'completedAt', 'correlationId', 'createdAt', 'id',
      'result', 'runId', 'startedAt', 'status', 'type', 'version', 'workspaceId',
    ]);
    assert.equal(liveOperation.type, 'run.retry');
    assert.equal(liveOperation.status, 'completed');
    assert.equal(liveOperation.version, 3);
    assert.equal(liveOperation.aggregateId, parent.id);
    assert.equal(liveOperation.runId, parent.id);
    assert.equal(liveOperation.correlationId, liveOperation.id);
    assert.deepEqual(liveOperation.result, { resourceId: liveRun.id, resourceType: 'run' });

    const childId = String(liveRun.id);
    const db = fx.store.getDatabase();
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?').get(parent.id) as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.retry' AND run_id = ?").get(parent.id) as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM idempotency_records').get() as { count: number }).count, 1);
    const events = db.prepare('SELECT type, correlation_id, causation_id, parent_event_id FROM runtime_events WHERE run_id = ? ORDER BY sequence').all(childId) as Array<Record<string, unknown>>;
    assert.deepEqual(events.map(event => event.type), ['run.created']);
    assert.equal(events[0]!.correlation_id, childId);
    assert.equal(events[0]!.causation_id, null);
    assert.equal(events[0]!.parent_event_id, null);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM outbox_messages WHERE aggregate_id = ?').get(childId) as { count: number }).count, 1);

    db.prepare('UPDATE runs SET next_event_sequence = 99, updated_at = updated_at WHERE id = ?').run(childId);
    const replay = await postRetry(fx, parent.id, { body: { expectedVersion: parent.version }, key: 'retry-live-key-0001' });
    assert.equal(replay.status, 201);
    assert.equal(replay.replayedHeader, 'true');
    assert.deepEqual(replay.json, live.json);
    assert.equal((db.prepare('SELECT next_event_sequence FROM runs WHERE id = ?').get(childId) as { next_event_sequence: number }).next_event_sequence, 99);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?').get(parent.id) as { count: number }).count, 1);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-RY07 Retry preserves locator, version, and failed-Parent guards', async () => {
  const fx = await createRouteFixture();
  try {
    const queued = await postRetry(fx, fx.runId, { body: { expectedVersion: 1 }, key: 'retry-queued-key-01' });
    expectErrorBody(queued, 409, 'RUN_NOT_RETRYABLE');

    const parent = failRouteParent(fx);
    const stale = await postRetry(fx, parent.id, { body: { expectedVersion: parent.version - 1 }, key: 'retry-stale-key-01' });
    expectErrorBody(stale, 409, 'VERSION_CONFLICT');
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?').get(parent.id) as { count: number }).count, 0);
  } finally {
    await closeRouteFixture(fx);
  }
});

test('P3C1-RY08 Retry maps duplicate and active-slot races to stable 409 responses', async () => {
  const first = await createRouteFixture();
  try {
    const parent = failRouteParent(first);
    const live = await postRetry(first, parent.id, { body: { expectedVersion: parent.version }, key: 'retry-duplicate-live-01' });
    assert.equal(live.status, 201);
    const duplicate = await postRetry(first, parent.id, { body: { expectedVersion: parent.version }, key: 'retry-duplicate-other-01' });
    assert.equal(duplicate.status, 409);
    assert.ok(duplicate.json !== null);
    assert.equal(duplicate.json.code, 'RUN_RETRY_ALREADY_CREATED');
    assert.equal(duplicate.json.detail, 'Retry child already exists');
    assert.equal(tableRowCount(first.store, 'idempotency_records'), 1);
    assert.equal((first.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?').get(parent.id) as { count: number }).count, 1);
  } finally {
    await closeRouteFixture(first);
  }

  const second = await createRouteFixture();
  try {
    const parent = failRouteParent(second);
    second.store.runRepository().insert({
      workspaceId: second.workspaceId,
      taskId: second.taskId,
      origin: 'v2_api',
      objective: 'active unrelated run',
      createdBy: 'test',
    });
    const active = await postRetry(second, parent.id, { body: { expectedVersion: parent.version }, key: 'retry-active-key-01' });
    assert.equal(active.status, 409);
    assert.ok(active.json !== null);
    assert.equal(active.json.code, 'RUN_ACTIVE_EXISTS');
    assert.equal(active.json.detail, 'Task already has an active run');
    assert.equal(active.json.retryable, false);
    assert.equal(tableRowCount(second.store, 'idempotency_records'), 0);
    assert.equal((second.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.retry'").get() as { count: number }).count, 0);
  } finally {
    await closeRouteFixture(second);
  }
});

test('P3C1-RY09 Retry ambiguity and inconsistency responses remain exact two-field errors', async () => {
  const ambiguous = await createRouteFixture();
  try {
    const parent = failRouteParent(ambiguous);
    const operations = new OperationService(ambiguous.store.getDatabase() as never);
    operations.createWithinTransaction({ workspaceId: ambiguous.workspaceId, runId: parent.id, type: 'run.retry' });
    operations.createWithinTransaction({ workspaceId: ambiguous.workspaceId, runId: parent.id, type: 'run.retry' });
    const response = await postRetry(ambiguous, parent.id, {
      body: { expectedVersion: parent.version },
      key: 'retry-ambiguous-response-01',
    });
    assert.equal(response.status, 500);
    assert.ok(response.json !== null);
    assert.equal(response.json.code, 'RUN_RETRY_STATE_AMBIGUOUS');
    assert.equal(response.json.detail, 'Retry state is ambiguous');
  } finally {
    await closeRouteFixture(ambiguous);
  }

  const inconsistent = await createRouteFixture();
  try {
    const parent = failRouteParent(inconsistent);
    new OperationService(inconsistent.store.getDatabase() as never).createWithinTransaction({
      workspaceId: inconsistent.workspaceId,
      runId: parent.id,
      type: 'run.retry',
    });
    const response = await postRetry(inconsistent, parent.id, {
      body: { expectedVersion: parent.version },
      key: 'retry-inconsistent-response-01',
    });
    assert.equal(response.status, 500);
    assert.ok(response.json !== null);
    assert.equal(response.json.code, 'RUN_RETRY_STATE_INCONSISTENT');
    assert.equal(response.json.detail, 'Retry state is inconsistent');
  } finally {
    await closeRouteFixture(inconsistent);
  }
});

test('P3C1-RY10 a Run active-slot unique conflict returns the exact retryable false response', async () => {
  const fx = await createRouteFixture();
  const repository = fx.store.runRepository();
  const originalInsert = repository.insert;
  try {
    const parent = failRouteParent(fx);
    repository.insert = ((input) => {
      if (input.reason === 'retry') throw new RunActiveExistsError(parent.taskId);
      return originalInsert.call(repository, input);
    }) as typeof repository.insert;
    const response = await postRetry(fx, parent.id, {
      body: { expectedVersion: parent.version },
      key: 'retry-unique-active-response-01',
    });
    assert.equal(response.status, 409);
    assert.ok(response.json !== null);
    assert.equal(response.json.code, 'RUN_ACTIVE_EXISTS');
    assert.equal(response.json.detail, 'Task already has an active run');
    assert.equal(response.json.retryable, false);
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.retry'").get() as { count: number }).count, 0);
    assert.equal((fx.store.getDatabase().prepare('SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?').get(parent.id) as { count: number }).count, 0);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    repository.insert = originalInsert;
    await closeRouteFixture(fx);
  }
});

test('P3C1-RY11 an unknown Retry failure remains a sanitized 500 INTERNAL_ERROR', async () => {
  const fx = await createRouteFixture();
  const originalOperationService = fx.store.operationService;
  try {
    const parent = failRouteParent(fx);
    fx.store.operationService = (() => {
      throw new Error('secret SQLite detail C:\\private\\.agentos\\agentos.sqlite');
    }) as typeof fx.store.operationService;
    const response = await postRetry(fx, parent.id, {
      body: { expectedVersion: parent.version },
      key: 'retry-unknown-response-01',
    });
    assert.equal(response.status, 500);
    assert.ok(response.json !== null);
    assert.equal(response.json.code, 'INTERNAL_ERROR');
    assert.equal(response.json.detail, 'Internal server error');
    assert.doesNotMatch(response.text, /secret|SQLite|private|\.agentos/i);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
  } finally {
    fx.store.operationService = originalOperationService;
    await closeRouteFixture(fx);
  }
});

test('P3C1-RY12 genuine SQLite lock timeout maps only to Retry busy', async () => {
  const fx = await createRouteFixture();
  const locker = new DatabaseSync(join(fx.root, '.agentos', 'agentos.sqlite'));
  try {
    const parent = failRouteParent(fx);
    locker.exec('BEGIN IMMEDIATE');
    const response = await postRetry(fx, parent.id, { body: { expectedVersion: parent.version }, key: 'retry-busy-key-01' });
    assert.equal(response.status, 503);
    assert.ok(response.json !== null);
    assert.equal(response.json.code, 'RUN_RETRY_BUSY');
    assert.equal(response.json.detail, 'Run retry is temporarily unavailable');
    assert.equal(response.json.retryable, true);
    assert.doesNotMatch(response.text, /SQLITE|SQL|database is locked|BEGIN IMMEDIATE|\.agentos/i);
    assert.equal(tableRowCount(fx.store, 'idempotency_records'), 0);
    assert.equal((fx.store.getDatabase().prepare("SELECT COUNT(*) AS count FROM operations WHERE type = 'run.retry'").get() as { count: number }).count, 0);
  } finally {
    locker.exec('ROLLBACK');
    locker.close();
    await closeRouteFixture(fx);
  }
});

}
