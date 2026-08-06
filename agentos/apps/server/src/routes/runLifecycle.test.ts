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
  mode: 'run-start-race';
  root: string;
  workspaceId: string;
  runId: string;
  key?: string;
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
    const result = service.startRunOperationForV2(data.workspaceId, data.runId, data.key);
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

if (!isMainThread && parentPort && currentWorkerData?.mode === 'run-start-race') {
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
  let resolveResult!: (message: StartRaceWorkerMessage) => void;
  let rejectResult!: (error: Error) => void;
  const ready = new Promise<void>(resolvePromise => { resolveReady = resolvePromise; });
  const result = new Promise<StartRaceWorkerMessage>((resolvePromise, rejectPromise) => {
    resolveResult = resolvePromise;
    rejectResult = rejectPromise;
  });
  worker.on('message', message => {
    if (message === 'ready') {
      resolveReady();
      return;
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
  assert.deepEqual(Object.keys(response.json).sort(), ['code', 'error']);
  assert.equal(response.json.code, code);
  assert.equal(typeof response.json.error, 'string');
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
    assert.deepEqual(response.json, {
      error: 'Run start is temporarily unavailable',
      code: 'RUN_START_BUSY',
      retryable: true,
    });
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
  return { root, store, workspaceId: workspace.id, runId: seeded.runId };
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

test('P3C1-R28 a store connection waits out a short foreign write lock instead of failing busy', async () => {
  const fx = createRaceFixture();
  const locker = new DatabaseSync(join(fx.root, '.agentos', 'agentos.sqlite'));
  try {
    const worker = spawnStartRaceWorker({ mode: 'run-start-race', root: fx.root, workspaceId: fx.workspaceId, runId: fx.runId });
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

}
