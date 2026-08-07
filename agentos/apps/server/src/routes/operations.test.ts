import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ApiOperation, ApiProblem, RuntimeEventEnvelope } from '@agentos/shared';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SnapshotService, type ResolvedRunConfiguration } from '../services/SnapshotService.js';
import { TaskRunService } from '../services/TaskRunService.js';
import { WorkflowDefinitionResolver } from '../services/WorkflowDefinitionResolver.js';
import { createEntityId } from '../store/Identity.js';
import type { OperationType } from '../store/OperationRepository.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { createOperationRoutes, type OperationRouteStore } from './operations.js';

const NOW = '2026-08-07T00:00:00.000Z';

interface RouteFixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly server: ReturnType<express.Express['listen']>;
  readonly baseApi: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
}

interface HttpResult {
  readonly status: number;
  readonly text: string;
  readonly json: unknown;
}

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-operation-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  return root;
}

async function closeTestServer(server: RouteFixture['server']): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function listen(app: express.Express): Promise<{ server: RouteFixture['server']; port: number }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
  return { server, port: address.port };
}

async function createRouteFixture(mountStore?: OperationRouteStore): Promise<RouteFixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('Operation Routes', join(root, 'workspace-a'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const service = new TaskRunService(store);
  const task = service.createTask(workspace.id, { title: 'operation route target', createdBy: 'test' });
  const run = service.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });

  const app = express();
  app.use('/api', createOperationRoutes(mountStore ?? store));
  app.use(express.json());
  const { server, port } = await listen(app);
  return {
    root,
    store,
    server,
    baseApi: `http://127.0.0.1:${port}/api`,
    workspaceId: workspace.id,
    taskId: task.id,
    runId: run.id,
  };
}

async function closeRouteFixture(fx: RouteFixture): Promise<void> {
  await closeTestServer(fx.server);
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

async function withFixture(fn: (fx: RouteFixture) => Promise<void> | void): Promise<void> {
  const fx = await createRouteFixture();
  try {
    await fn(fx);
  } finally {
    await closeRouteFixture(fx);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function getOperation(fx: RouteFixture, operationId: string, suffix = '', headers: Record<string, string> = {}): Promise<HttpResult> {
  const response = await fetch(`${fx.baseApi}/operations/${operationId}${suffix}`, { headers });
  const text = await response.text();
  return { status: response.status, text, json: parseJson(text) };
}

async function getEvents(fx: RouteFixture, operationId: string, suffix = '', headers: Record<string, string> = {}): Promise<HttpResult> {
  const response = await fetch(`${fx.baseApi}/operations/${operationId}/events${suffix}`, { headers });
  const text = await response.text();
  return { status: response.status, text, json: parseJson(text) };
}

async function rawRequest(
  fx: RouteFixture,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  const url = new URL(`${fx.baseApi}${path}`);
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, text, json: parseJson(text) });
      });
    });
    req.once('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function createOperation(fx: RouteFixture, type: OperationType = 'run.start'): ApiOperation {
  return fx.store.operationService().create({ workspaceId: fx.workspaceId, runId: fx.runId, type });
}

function sampleProblem(fx: RouteFixture, operationId: string): ApiProblem {
  return {
    type: 'https://agentos.dev/problems/operation-failed',
    title: 'Operation failed',
    status: 500,
    code: 'OPERATION_FAILED',
    detail: 'The operation failed during the route test.',
    instance: `/api/operations/${operationId}`,
    requestId: 'request-operation-routes',
    retryable: false,
    context: { workspaceId: fx.workspaceId, runId: fx.runId, operationId },
  };
}

function completeOperation(fx: RouteFixture): ApiOperation {
  const operation = createOperation(fx);
  const running = fx.store.operationService().transition({
    workspaceId: fx.workspaceId,
    operationId: operation.id,
    expectedVersion: operation.version,
    to: 'running',
  });
  return fx.store.operationService().transition({
    workspaceId: fx.workspaceId,
    operationId: operation.id,
    expectedVersion: running.version,
    to: 'completed',
    result: {
      resourceType: 'run',
      resourceId: fx.runId,
      data: { accepted: true },
    },
  });
}

function failOperation(fx: RouteFixture): ApiOperation {
  const operation = createOperation(fx);
  return fx.store.operationService().transition({
    workspaceId: fx.workspaceId,
    operationId: operation.id,
    expectedVersion: operation.version,
    to: 'failed',
    error: sampleProblem(fx, operation.id),
  });
}

function nextSequence(fx: RouteFixture, runId: string): number {
  const row = fx.store.getDatabase().prepare(
    'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM runtime_events WHERE run_id = ?',
  ).get(runId) as { next: number };
  return row.next;
}

function appendRuntimeEvent(
  fx: RouteFixture,
  input: {
    runId: string;
    correlationId: string;
    type: 'run.dequeued' | 'run.started' | 'run.queued';
    sequence?: number;
  },
): RuntimeEventEnvelope {
  const sequence = input.sequence ?? nextSequence(fx, input.runId);
  const payload = input.type === 'run.dequeued'
    ? { dequeuedAt: NOW }
    : input.type === 'run.started'
      ? { startedAt: NOW }
      : { priority: 'normal', queueName: 'default' };
  return fx.store.runInTransaction(() => fx.store.runtimeEventRepository().appendWithinTransaction({
    id: createEntityId('event'),
    schemaVersion: 1,
    type: input.type,
    workspaceId: fx.workspaceId,
    runId: input.runId,
    sequence,
    timestamp: NOW,
    correlationId: input.correlationId,
    payload,
  }));
}

function eventBody(result: HttpResult): Array<Record<string, unknown>> {
  assert.ok(result.json !== null && typeof result.json === 'object' && !Array.isArray(result.json));
  const body = result.json as { events?: unknown; hasMore?: unknown };
  assert.ok(Array.isArray(body.events));
  assert.equal(body.hasMore, false);
  return body.events as Array<Record<string, unknown>>;
}

function legacyGraphSnapshotService(store: SqliteStore): SnapshotService {
  const workflow = store.workflowDefinitionRepository().findLatestAvailableByKey('legacy-pipeline');
  if (!workflow || workflow.payload.schemaVersion !== 2) {
    throw new Error('legacy V2 workflow fixture is unavailable');
  }
  const workflowPayload = workflow.payload;
  const resolver = new WorkflowDefinitionResolver(store.workflowDefinitionRepository());
  const snapshotService = new SnapshotService({
    workflowDefinitionResolver: resolver,
    runSnapshotRepository: () => store.runSnapshotRepository(),
    runStageRepository: () => store.runStageRepository(),
    providerConfigurationRepository: () => store.providerConfigurationRepository(),
    findAgentSnapshotSource: (workspaceId, agentId) => store.findAgentSnapshotSource(workspaceId, agentId),
  });
  const stages = workflowPayload.stages.map(stage => ({
    workflowStageKey: stage.key,
    name: stage.key,
    sequence: stage.sequence,
    dependsOn: [...stage.dependsOn],
    agent: null,
    provider: null,
    runnerAgent: null,
  }));
  snapshotService.resolveUnbound = (_workspaceId: string): ResolvedRunConfiguration => ({
    workflow,
    stages,
    worktreeMode: workflowPayload.worktreeMode,
    redactionApplied: false,
  });
  return snapshotService;
}

function createChildRun(fx: RouteFixture): string {
  const service = new TaskRunService(fx.store, { snapshotService: legacyGraphSnapshotService(fx.store) });
  const task = service.createTask(fx.workspaceId, { title: `child-${createEntityId('task')}`, createdBy: 'test' });
  return service.createRun(fx.workspaceId, { taskId: task.id, createdBy: 'test' }).id;
}

test('R01 known GET Operation returns HTTP 200 with the current ApiOperation', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);

    const response = await getOperation(fx, operation.id);

    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { data: operation });
  });
});

test('R02 unknown Operation returns 404 OPERATION_NOT_FOUND', async () => {
  await withFixture(async fx => {
    const response = await getOperation(fx, createEntityId('operation'));

    assert.equal(response.status, 404);
    assert.deepEqual(response.json, { error: 'Operation not found', code: 'OPERATION_NOT_FOUND' });
  });
});

test('R03 unknown Operation plus query returns 404 before query validation', async () => {
  await withFixture(async fx => {
    const response = await getOperation(fx, createEntityId('operation'), '?workspaceId=other&bogus=');

    assert.equal(response.status, 404);
    assert.deepEqual(response.json, { error: 'Operation not found', code: 'OPERATION_NOT_FOUND' });
  });
});

test('R04 known Operation plus any query returns 400 VALIDATION_FAILED', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);

    const response = await getOperation(fx, operation.id, '?workspaceId=other');

    assert.equal(response.status, 400);
    assert.deepEqual(response.json, { error: 'Query parameters are not accepted', code: 'VALIDATION_FAILED' });
  });
});

test('R05 GET does not use a JSON parser and ignores malformed JSON bodies', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);

    const response = await rawRequest(fx, `/operations/${operation.id}`, {
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken":',
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { data: operation });
  });
});

test('R06 GET Operation preserves the current persisted projection exactly', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);

    const response = await getOperation(fx, operation.id);

    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { data: operation });
    const data = (response.json as { data: ApiOperation }).data;
    assert.deepEqual(Object.keys(data).sort(), [
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
  });
});

test('R07 GET Operation never invents progress', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);

    const response = await getOperation(fx, operation.id);

    assert.equal(response.status, 200);
    assert.equal('progress' in (response.json as { data: object }).data, false);
  });
});

test('R08 completed Operation preserves its persisted result', async () => {
  await withFixture(async fx => {
    const operation = completeOperation(fx);

    const response = await getOperation(fx, operation.id);

    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { data: operation });
    assert.deepEqual((response.json as { data: ApiOperation }).data.result, operation.result);
  });
});

test('R09 failed Operation preserves its persisted error', async () => {
  await withFixture(async fx => {
    const operation = failOperation(fx);

    const response = await getOperation(fx, operation.id);

    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { data: operation });
    assert.deepEqual((response.json as { data: ApiOperation }).data.error, operation.error);
  });
});

test('R10 persisted Operation corruption is sanitized as INTERNAL_ERROR', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);
    fx.store.getDatabase().prepare('UPDATE operations SET result_json = ? WHERE id = ?')
      .run('[]', operation.id);

    const response = await getOperation(fx, operation.id);

    assert.equal(response.status, 500);
    assert.deepEqual(response.json, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
    assert.equal(response.text.includes('broken-json'), false);
    assert.equal(/SQLITE|SELECT|UPDATE|stack|agentos-p3d/i.test(response.text), false);
  });
});

test('R11 GET events returns canonical events in ascending sequence order', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);
    const firstSequence = nextSequence(fx, fx.runId);
    const first = appendRuntimeEvent(fx, {
      runId: fx.runId,
      correlationId: operation.id,
      type: 'run.dequeued',
      sequence: firstSequence,
    });
    const second = appendRuntimeEvent(fx, {
      runId: fx.runId,
      correlationId: operation.id,
      type: 'run.started',
      sequence: firstSequence + 1,
    });

    const response = await getEvents(fx, operation.id);

    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { events: [first, second], hasMore: false });
    const events = eventBody(response);
    assert.deepEqual(events.map(event => event.sequence), [firstSequence, firstSequence + 1]);
  });
});

test('R11b GET events preserves an unknown persisted Runtime Event', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);
    const sequence = nextSequence(fx, operation.runId);
    const eventId = createEntityId('event');
    fx.store.getDatabase().prepare(`
      INSERT INTO runtime_events (
        id, schema_version, type, workspace_id, task_id, run_id, stage_id,
        agent_id, provider_config_id, provider_session_id, process_id, worktree_id,
        artifact_id, approval_request_id, conversation_id, message_id, sequence,
        timestamp, source, correlation_id, causation_id, parent_event_id, severity,
        visibility, durability, payload_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      999,
      'future.operation.event',
      fx.workspaceId,
      fx.taskId,
      operation.runId,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      sequence,
      NOW,
      'future-producer',
      operation.correlationId,
      null,
      null,
      'info',
      'public',
      'durable',
      JSON.stringify({ future: true }),
      JSON.stringify({ trace: 'future' }),
      NOW,
    );

    const persisted = fx.store.runtimeEventRepository().listByRunAndCorrelation(
      operation.runId,
      operation.correlationId,
    );
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.kind, 'unknown');

    const response = await getEvents(fx, operation.id);

    assert.equal(response.status, 200);
    const expectedEvent = JSON.parse(JSON.stringify(persisted[0]!.event));
    assert.deepEqual(response.json, { events: [expectedEvent], hasMore: false });
    const event = (response.json as { events: Array<Record<string, unknown>> }).events[0];
    assert.equal(event?.kind, 'unknown_runtime_event');
    assert.equal(event?.type, 'future.operation.event');
    assert.equal(event?.warning, 'UNKNOWN_FUTURE_EVENT_SCHEMA');
  });
});

test('R12 GET events queries only the Operation runId and correlationId', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);
    const repository = fx.store.runtimeEventRepository();
    const original = repository.listByRunAndCorrelation;
    const calls: Array<[string, string]> = [];
    Object.defineProperty(repository, 'listByRunAndCorrelation', {
      configurable: true,
      value: (runId: string, correlationId: string) => {
        calls.push([runId, correlationId]);
        return original.call(repository, runId, correlationId);
      },
    });
    try {
      const response = await getEvents(fx, operation.id);
      assert.equal(response.status, 200);
    } finally {
      Reflect.deleteProperty(repository, 'listByRunAndCorrelation');
    }

    assert.deepEqual(calls, [[operation.runId, operation.correlationId]]);
  });
});

test('R13 unrelated Events from the same Run but another correlation are excluded', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);
    appendRuntimeEvent(fx, { runId: fx.runId, correlationId: operation.id, type: 'run.dequeued' });
    appendRuntimeEvent(fx, { runId: fx.runId, correlationId: 'correlation-unrelated', type: 'run.started' });

    const response = await getEvents(fx, operation.id);

    assert.equal(response.status, 200);
    const events = eventBody(response);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.correlationId, operation.correlationId);
    assert.equal(events.some(event => event.correlationId === 'correlation-unrelated'), false);
  });
});

test('R14 retry Operation excludes Child run.created and stage.created Events', async () => {
  await withFixture(async fx => {
    const retry = createOperation(fx, 'run.retry');
    const childRunId = createChildRun(fx);
    const childRows = fx.store.getDatabase().prepare(`
      SELECT type FROM runtime_events WHERE run_id = ? ORDER BY sequence ASC
    `).all(childRunId) as Array<{ type: string }>;
    assert.ok(childRows.some(row => row.type === 'run.created'));
    assert.ok(childRows.some(row => row.type === 'stage.created'));

    const response = await getEvents(fx, retry.id);

    assert.equal(response.status, 200);
    assert.deepEqual(response.json, { events: [], hasMore: false });
  });
});

test('R15 retry Operation excludes independent Start Events for the Child Run', async () => {
  await withFixture(async fx => {
    const retry = createOperation(fx, 'run.retry');
    const childRunId = createChildRun(fx);
    const childStart = fx.store.operationService().create({
      workspaceId: fx.workspaceId,
      runId: childRunId,
      type: 'run.start',
    });
    appendRuntimeEvent(fx, { runId: childRunId, correlationId: childStart.id, type: 'run.dequeued' });
    appendRuntimeEvent(fx, { runId: childRunId, correlationId: childStart.id, type: 'run.started' });

    const retryEvents = await getEvents(fx, retry.id);
    const startEvents = await getEvents(fx, childStart.id);

    assert.equal(retryEvents.status, 200);
    assert.deepEqual(retryEvents.json, { events: [], hasMore: false });
    assert.equal(startEvents.status, 200);
    assert.equal(eventBody(startEvents).length, 2);
  });
});

test('R16 Runtime Event read failure is sanitized as INTERNAL_ERROR', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);
    const repository = fx.store.runtimeEventRepository();
    Object.defineProperty(repository, 'listByRunAndCorrelation', {
      configurable: true,
      value: () => {
        throw new Error('SQLITE_READ_FAILED at C:\\secret\\agentos.sqlite\nstack-frame');
      },
    });
    try {
      const response = await getEvents(fx, operation.id);

      assert.equal(response.status, 500);
      assert.deepEqual(response.json, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
      assert.equal(response.text.includes('SQLITE_READ_FAILED'), false);
      assert.equal(response.text.includes('agentos.sqlite'), false);
      assert.equal(response.text.includes('stack-frame'), false);
    } finally {
      Reflect.deleteProperty(repository, 'listByRunAndCorrelation');
    }
  });
});

test('R17 workspace, run, and correlation cannot be overridden by headers, body, or query', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);

    const headers = await getOperation(fx, operation.id, '', {
      'x-workspace-id': 'workspace-override',
      'x-run-id': 'run-override',
      'x-correlation-id': 'correlation-override',
    });
    assert.equal(headers.status, 200);
    assert.deepEqual(headers.json, { data: operation });

    const body = await rawRequest(fx, `/operations/${operation.id}/events`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'workspace-override', runId: 'run-override', correlationId: 'correlation-override' }),
    });
    assert.equal(body.status, 200);
    assert.deepEqual(body.json, { events: [], hasMore: false });

    const query = await getEvents(fx, operation.id, '?runId=run-override&correlationId=correlation-override');
    assert.equal(query.status, 400);
    assert.deepEqual(query.json, { error: 'Query parameters are not accepted', code: 'VALIDATION_FAILED' });
  });
});

test('R18 Router exposes no Cancel route or stub', async () => {
  await withFixture(async fx => {
    const operation = createOperation(fx);
    const response = await fetch(`${fx.baseApi}/operations/${operation.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: operation.version }),
    });
    assert.equal(response.status, 404);

    const source = readFileSync(new URL('./operations.ts', import.meta.url), 'utf8');
    assert.equal(source.includes("router.post("), false);
    assert.equal(source.includes('/cancel'), false);
  });
});

test('R19 index mounts the Operation router once before the global JSON parser', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const lifecycleMount = "app.use('/api', createRunLifecycleRoutes(store));";
  const operationImport = "import { createOperationRoutes } from './routes/operations.js';";
  const operationMount = "app.use('/api', createOperationRoutes(store));";
  const globalJson = 'app.use(express.json({ limit: \'50mb\' }));';

  assert.equal(source.includes(operationImport), true);
  assert.equal((source.match(new RegExp(operationMount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length, 1);
  assert.ok(source.indexOf(lifecycleMount) >= 0);
  assert.ok(source.indexOf(operationMount) > source.indexOf(lifecycleMount));
  assert.ok(source.indexOf(globalJson) > source.indexOf(operationMount));
});
