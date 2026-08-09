import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run, RuntimeEventEnvelope } from '@agentos/shared';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createApiNotFoundHandler, createProblemErrorHandler, createRequestIdMiddleware } from '../problemDetails.js';
import type { RunStreamSubscriptionInput } from '../services/RunStreamService.js';
import type { RunStreamService } from '../services/RunStreamService.js';
import { TaskRunService } from '../services/TaskRunService.js';
import type { RunRepository } from '../store/RunRepository.js';
import type { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { createCanonicalRunRoutes } from './canonicalRuns.js';
import { createCanonicalRunEventRoutes, type CanonicalRunEventStore } from './canonicalRunEvents.js';

interface Fixture {
  readonly root: string;
  readonly store: SqliteStore;
  readonly server: Server;
  readonly baseApi: string;
  readonly workspaceId: string;
  readonly taskId: string;
  readonly runId: string;
}

function isFetchBadPortError(error: unknown): boolean {
  return (error as { cause?: { message?: unknown } } | null)?.cause?.message === 'bad port';
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function listen(app: express.Express): Promise<{ server: Server; origin: string }> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      const origin = `http://127.0.0.1:${address.port}`;
      const probe = await fetch(`${origin}/__probe`, { method: 'HEAD' });
      if (probe.status !== 204) throw new Error(`probe returned ${probe.status}`);
      return { server, origin };
    } catch (error) {
      await closeServer(server);
      if (!isFetchBadPortError(error)) throw error;
    }
  }
  throw new Error('TEST_FETCH_SAFE_PORT_UNAVAILABLE');
}

function buildApp(store: CanonicalRunEventStore): express.Express {
  const app = express();
  app.use(createRequestIdMiddleware());
  app.head('/__probe', (_req, res) => res.status(204).end());
  app.use('/api', createCanonicalRunEventRoutes(store));
  app.use('/api', createApiNotFoundHandler());
  app.use(createProblemErrorHandler());
  return app;
}

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p5c-stream-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P5C Stream Workspace', join(root, 'workspace-a'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const service = new TaskRunService(store);
  const task = service.createTask(workspace.id, { title: 'P5C stream task', createdBy: 'test' });
  const run = service.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const app = express();
  app.use(createRequestIdMiddleware());
  app.head('/__probe', (_req, res) => res.status(204).end());
  app.use('/api', createCanonicalRunRoutes(store, manager));
  app.use('/api', createCanonicalRunEventRoutes(store));
  app.use('/api', createApiNotFoundHandler());
  app.use(createProblemErrorHandler());
  const { server, origin } = await listen(app);
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
  await closeServer(fx.server);
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

async function readFrames(
  response: Response,
  count: number,
  timeoutMs = 10000,
): Promise<{ frames: string[]; done: boolean }> {
  assert.ok(response.body, 'SSE response must expose a readable body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: string[] = [];
  let done = false;
  const deadline = Date.now() + timeoutMs;
  try {
    while (frames.length < count && !done) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${count} SSE frame(s); received ${frames.length}`);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('SSE read timeout')), remaining);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      if (result.done) {
        done = true;
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1 && frames.length < count) {
        frames.push(buffer.slice(0, index + 2));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { frames, done };
}

async function readUntilClosed(response: Response): Promise<string[]> {
  const collected: string[] = [];
  for (let round = 0; round < 512; round += 1) {
    const { frames, done } = await readFrames(response, 1);
    collected.push(...frames);
    if (done) return collected;
  }
  throw new Error('SSE transport did not close');
}

function transitionToStarting(fx: Fixture): void {
  const run = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
  fx.store.lifecycleTransactionService().transitionRun({
    workspaceId: fx.workspaceId,
    runId: fx.runId,
    expectedVersion: run.version,
    expectedFrom: 'queued',
    to: 'starting',
    correlationId: fx.runId,
  });
}

function appendManualEvent(fx: Fixture): { id: string; sequence: number } {
  const seed = fx.store.runtimeEventRepository()
    .findDurableByWorkspaceRunAndSequence(fx.workspaceId, fx.runId, 1)!.event as RuntimeEventEnvelope;
  return fx.store.runInTransaction(() => {
    const sequence = fx.store.runSequenceAllocator().allocateWithinTransaction(fx.workspaceId, fx.runId);
    const id = `evt_${String(sequence).padStart(26, '0')}`;
    fx.store.runtimeEventRepository().appendWithinTransaction({
      ...seed,
      id,
      sequence,
      correlationId: `corr_p5c_manual_${sequence}`,
    });
    return { id, sequence };
  });
}

function eventIdAt(fx: Fixture, sequence: number): string {
  const row = fx.store.getDatabase().prepare(
    'SELECT id FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND sequence = ?',
  ).get(fx.workspaceId, fx.runId, sequence) as { id: string } | undefined;
  assert.ok(row, `expected persisted event at sequence ${sequence}`);
  return row.id;
}

function countEventsOfType(fx: Fixture, type: string): number {
  const row = fx.store.getDatabase().prepare(
    'SELECT COUNT(*) AS count FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND type = ?',
  ).get(fx.workspaceId, fx.runId, type) as { count: number };
  return row.count;
}

function durableCounts(fx: Fixture): { events: number; outbox: number; nextEventSequence: number } {
  const events = (fx.store.getDatabase().prepare(
    'SELECT COUNT(*) AS count FROM runtime_events WHERE workspace_id = ? AND run_id = ?',
  ).get(fx.workspaceId, fx.runId) as { count: number }).count;
  const outbox = (fx.store.getDatabase().prepare(
    'SELECT COUNT(*) AS count FROM outbox_messages',
  ).get() as { count: number }).count;
  const run = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
  return { events, outbox, nextEventSequence: run.nextEventSequence };
}

function runLifecycleCounts(fx: Fixture): { status: string; version: number; nextEventSequence: number; cancelledEvents: number; operations: number } {
  const run = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
  const operations = (fx.store.getDatabase().prepare(
    'SELECT COUNT(*) AS count FROM operations WHERE run_id = ?',
  ).get(fx.runId) as { count: number }).count;
  return {
    status: run.status,
    version: run.version,
    nextEventSequence: run.nextEventSequence,
    cancelledEvents: countEventsOfType(fx, 'run.cancelled'),
    operations,
  };
}

function frameEventId(frame: string): string {
  const firstLine = frame.split('\n', 1)[0]!;
  assert.ok(firstLine.startsWith('id: '), `frame must start with an SSE id line: ${frame}`);
  return firstLine.slice(4);
}

function frameEventData(frame: string): Record<string, unknown> {
  const dataLine = frame.split('\n').find(line => line.startsWith('data: '));
  assert.ok(dataLine, `frame must carry a data line: ${frame}`);
  return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
}

// --- Cursor contract -------------------------------------------------------

test('P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0)', async () => {
  const fx = await createFixture();
  const controller = new AbortController();
  try {
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.match(response.headers.get('content-type') ?? '', /charset=utf-8/);
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(response.headers.get('connection'), 'keep-alive');
    assert.ok((response.headers.get('x-request-id') ?? '').length > 0);

    const { frames } = await readFrames(response, 1);
    const frame = frames[0]!;
    const expectedId = eventIdAt(fx, 1);
    const lines = frame.split('\n');
    assert.equal(lines[0], `id: ${expectedId}`);
    assert.equal(lines[1], 'event: runtime-event');
    assert.ok(lines[2]!.startsWith('data: '));
    assert.equal(lines[3], '');
    assert.ok(!frame.includes('retry:'));
    const data = frameEventData(frame);
    assert.equal(data.id, expectedId);
    assert.equal(data.sequence, 1);
    assert.equal(data.type, 'run.created');
  } finally {
    controller.abort();
    await closeFixture(fx);
  }
});

test('P5C afterSequence-only cursor replays strictly greater durable sequences', async () => {
  const fx = await createFixture();
  const controller = new AbortController();
  try {
    const second = appendManualEvent(fx);
    const third = appendManualEvent(fx);
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream?afterSequence=1`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const { frames } = await readFrames(response, 2);
    assert.deepEqual(frames.map(frameEventId), [second.id, third.id]);
  } finally {
    controller.abort();
    await closeFixture(fx);
  }
});

test('P5C Last-Event-ID-only cursor resolves the persisted Event sequence', async () => {
  const fx = await createFixture();
  const controller = new AbortController();
  try {
    const second = appendManualEvent(fx);
    const third = appendManualEvent(fx);
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream`, {
      headers: { 'Last-Event-ID': second.id },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const { frames } = await readFrames(response, 1);
    assert.deepEqual(frames.map(frameEventId), [third.id]);
  } finally {
    controller.abort();
    await closeFixture(fx);
  }
});

test('P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native reconnect)', async () => {
  const fx = await createFixture();
  const controller = new AbortController();
  try {
    const second = appendManualEvent(fx);
    const third = appendManualEvent(fx);

    const firstController = new AbortController();
    const first = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream?afterSequence=1`, { signal: firstController.signal });
    assert.equal(first.status, 200);
    const firstFrames = await readFrames(first, 2);
    assert.deepEqual(firstFrames.frames.map(frameEventId), [second.id, third.id]);
    firstController.abort();

    const fourth = appendManualEvent(fx);

    const reconnect = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream?afterSequence=1`, {
      headers: { 'Last-Event-ID': third.id },
      signal: controller.signal,
    });
    assert.equal(reconnect.status, 200);
    const { frames } = await readFrames(reconnect, 1);
    assert.deepEqual(frames.map(frameEventId), [fourth.id]);
    assert.ok(!frames.map(frameEventId).includes(second.id));
    assert.ok(!frames.map(frameEventId).includes(third.id));
  } finally {
    controller.abort();
    await closeFixture(fx);
  }
});

test('P5C-R05 monotonic cursor: query higher than Last-Event-ID lets the query win', async () => {
  const fx = await createFixture();
  const controller = new AbortController();
  try {
    const second = appendManualEvent(fx);
    appendManualEvent(fx);
    const fourth = appendManualEvent(fx);
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream?afterSequence=3`, {
      headers: { 'Last-Event-ID': second.id },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const { frames } = await readFrames(response, 1);
    assert.deepEqual(frames.map(frameEventId), [fourth.id]);
  } finally {
    controller.abort();
    await closeFixture(fx);
  }
});

test('P5C malformed afterSequence variants fail with 400 VALIDATION_FAILED before any SSE header', async () => {
  const fx = await createFixture();
  try {
    const malformed = [
      'afterSequence=-1',
      'afterSequence=1.5',
      'afterSequence=1e3',
      'afterSequence=',
      'afterSequence=NaN',
      'afterSequence=9007199254740993',
      'afterSequence=1&afterSequence=2',
      'foo=1',
    ];
    for (const query of malformed) {
      const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream?${query}`);
      assert.equal(response.status, 400, `query ${query} must be rejected`);
      assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/);
      const body = await response.json() as { code?: string; status?: number };
      assert.equal(body.code, 'VALIDATION_FAILED', `query ${query}`);
      assert.equal(body.status, 400);
    }
  } finally {
    await closeFixture(fx);
  }
});

test('P5C unknown, foreign-Run and foreign-Workspace Last-Event-ID share one 400 representation', async () => {
  const fx = await createFixture();
  try {
    const unknown = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream`, {
      headers: { 'Last-Event-ID': 'evt_00000000000000000000000099' },
    });
    assert.equal(unknown.status, 400);
    const unknownBody = await unknown.json() as { code?: string; detail?: string };
    assert.equal(unknownBody.code, 'VALIDATION_FAILED');

    const service = new TaskRunService(fx.store);
    const otherTask = service.createTask(fx.workspaceId, { title: 'P5C other task', createdBy: 'test' });
    const otherRun = service.createRun(fx.workspaceId, { taskId: otherTask.id, createdBy: 'test' });
    const foreignRunId = eventIdAt({ ...fx, runId: otherRun.id }, 1);
    const foreignRun = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream`, {
      headers: { 'Last-Event-ID': foreignRunId },
    });
    assert.equal(foreignRun.status, 400);
    const foreignRunBody = await foreignRun.json() as { code?: string; detail?: string };
    assert.equal(foreignRunBody.code, 'VALIDATION_FAILED');
    assert.equal(foreignRunBody.detail, unknownBody.detail);

    const manager = new WorkspaceManager(fx.store);
    const workspaceB = manager.create('P5C Stream Workspace B', join(fx.root, 'workspace-b'), {
      git: false,
      memory: false,
      readme: false,
      docs: false,
    });
    const taskB = service.createTask(workspaceB.id, { title: 'P5C foreign task', createdBy: 'test' });
    const runB = service.createRun(workspaceB.id, { taskId: taskB.id, createdBy: 'test' });
    const foreignWorkspaceId = (fx.store.getDatabase().prepare(
      'SELECT id FROM runtime_events WHERE workspace_id = ? AND run_id = ? AND sequence = 1',
    ).get(workspaceB.id, runB.id) as { id: string }).id;
    const foreignWorkspace = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream`, {
      headers: { 'Last-Event-ID': foreignWorkspaceId },
    });
    assert.equal(foreignWorkspace.status, 400);
    const foreignWorkspaceBody = await foreignWorkspace.json() as { code?: string; detail?: string };
    assert.equal(foreignWorkspaceBody.code, 'VALIDATION_FAILED');
    assert.equal(foreignWorkspaceBody.detail, unknownBody.detail);
  } finally {
    await closeFixture(fx);
  }
});

test('P5C unknown Run takes precedence over a malformed cursor with 404 RUN_NOT_FOUND', async () => {
  const fx = await createFixture();
  try {
    const response = await fetch(`${fx.baseApi}/runs/run_does_not_exist/stream?afterSequence=abc`, {
      headers: { 'Last-Event-ID': 'evt_00000000000000000000000099' },
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /application\/problem\+json/);
    const body = await response.json() as { code?: string };
    assert.equal(body.code, 'RUN_NOT_FOUND');
  } finally {
    await closeFixture(fx);
  }
});

// --- Live delivery / frames ------------------------------------------------

test('P5C live durable commits after subscribe are delivered exactly once with the persisted id', async () => {
  const fx = await createFixture();
  const controller = new AbortController();
  try {
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream?afterSequence=1`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const pending = readFrames(response, 1);
    const live = appendManualEvent(fx);
    const { frames } = await pending;
    assert.deepEqual(frames.map(frameEventId), [live.id]);
    assert.equal(frameEventData(frames[0]!).sequence, 2);
  } finally {
    controller.abort();
    await closeFixture(fx);
  }
});

test('P5C unknown persisted runtime events stream losslessly with kind/raw/warning', async () => {
  const fx = await createFixture();
  const controller = new AbortController();
  try {
    fx.store.getDatabase().prepare(`
      INSERT INTO runtime_events (
        id, schema_version, type, workspace_id, task_id, run_id, stage_id,
        sequence, timestamp, source, correlation_id, severity, visibility,
        durability, payload_json, metadata_json, created_at
      ) VALUES (?, 1, 'future.p5c.event', ?, ?, ?, NULL, 2, '2026-08-10T00:00:00.000Z', 'system', 'corr_p5c_unknown', 'info', 'public', 'durable', '{"future":true}', NULL, '2026-08-10T00:00:00.000Z')
    `).run('evt_00000000000000000000000002', fx.workspaceId, fx.taskId, fx.runId);
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream?afterSequence=1`, { signal: controller.signal });
    assert.equal(response.status, 200);
    const { frames } = await readFrames(response, 1);
    assert.equal(frameEventId(frames[0]!), 'evt_00000000000000000000000002');
    const data = frameEventData(frames[0]!);
    assert.equal(data.kind, 'unknown_runtime_event');
    assert.equal(data.warning, 'UNKNOWN_EVENT_TYPE');
    assert.equal(data.type, 'future.p5c.event');
    const raw = data.raw as Record<string, unknown>;
    assert.equal(raw.type, 'future.p5c.event');
    assert.equal(raw.sequence, 2);
  } finally {
    controller.abort();
    await closeFixture(fx);
  }
});

// --- Disconnect / cleanup --------------------------------------------------

test('P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues', async () => {
  const fx = await createFixture();
  const controller = new AbortController();
  try {
    const before = runLifecycleCounts(fx);
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    await readFrames(response, 1);
    controller.abort();
    assert.deepEqual(runLifecycleCounts(fx), before);
    transitionToStarting(fx);
    const run = fx.store.runRepository().findById(fx.workspaceId, fx.runId)!;
    assert.equal(run.status, 'starting');
  } finally {
    controller.abort();
    await closeFixture(fx);
  }
});

const STUB_WORKSPACE_ID = 'workspace_p5c_stub';
const STUB_RUN_ID = 'run_p5c_stub';

function createStubStore(subscribe: (input: RunStreamSubscriptionInput) => () => void): CanonicalRunEventStore {
  const run = {
    id: STUB_RUN_ID,
    workspaceId: STUB_WORKSPACE_ID,
    taskId: 'task_p5c_stub',
    rootRunId: STUB_RUN_ID,
    status: 'running',
    reason: 'initial',
    origin: 'canonical',
    nextEventSequence: 2,
    createdBy: 'test',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    version: 3,
  } as unknown as Run;
  return {
    runRepository: () => ({
      findWorkspaceIdByOpaqueId: (runId: string) => (runId === STUB_RUN_ID ? STUB_WORKSPACE_ID : undefined),
      findById: (workspaceId: string, runId: string) => (
        workspaceId === STUB_WORKSPACE_ID && runId === STUB_RUN_ID ? run : undefined
      ),
    }) as unknown as RunRepository,
    runtimeEventRepository: () => ({
      findById: () => undefined,
    }) as unknown as RuntimeEventRepository,
    runSnapshotRepository: () => ({}) as unknown as RunSnapshotRepository,
    runStageRepository: () => ({}) as unknown as RunStageRepository,
    runStreamService: () => ({ subscribe }) as unknown as RunStreamService,
  } as CanonicalRunEventStore;
}

test('P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once', async () => {
  let unsubscribeCalls = 0;
  let subscribed: RunStreamSubscriptionInput | undefined;
  let resolveUnsubscribed!: () => void;
  const unsubscribed = new Promise<void>(resolve => { resolveUnsubscribed = resolve; });
  const app = buildApp(createStubStore(input => {
    subscribed = input;
    return () => {
      unsubscribeCalls += 1;
      resolveUnsubscribed();
    };
  }));
  const { server, origin } = await listen(app);
  const controller = new AbortController();
  try {
    const response = await fetch(`${origin}/api/runs/${STUB_RUN_ID}/stream?afterSequence=5`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.ok(subscribed, 'subscription must be installed before the response completes headers');
    assert.equal(subscribed!.workspaceId, STUB_WORKSPACE_ID);
    assert.equal(subscribed!.runId, STUB_RUN_ID);
    assert.equal(subscribed!.afterSequence, 5);
    controller.abort();
    await unsubscribed;
    assert.equal(unsubscribeCalls, 1);
  } finally {
    controller.abort();
    await closeServer(server);
  }
});

test('P5C overflow closes the SSE transport without synthetic frames or durable writes', async () => {
  let overflowCursor: number | undefined;
  const app = buildApp(createStubStore(input => {
    input.onOverflow(7);
    return () => {
      overflowCursor = overflowCursor ?? -1;
    };
  }));
  const { server, origin } = await listen(app);
  try {
    const response = await fetch(`${origin}/api/runs/${STUB_RUN_ID}/stream`);
    assert.equal(response.status, 200);
    const frames = await readUntilClosed(response);
    assert.deepEqual(frames, []);
    assert.equal(overflowCursor, undefined);
  } finally {
    await closeServer(server);
  }
});

// --- Backpressure / write failure ------------------------------------------

async function createBackpressureFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p5c-backpressure-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P5C Backpressure Workspace', join(root, 'workspace-a'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const service = new TaskRunService(store);
  const task = service.createTask(workspace.id, { title: 'P5C backpressure task', createdBy: 'test' });
  const run = service.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const app = express();
  app.use(createRequestIdMiddleware());
  app.head('/__probe', (_req, res) => res.status(204).end());
  app.use('/api', (req, res, next) => {
    if (req.path.endsWith('/stream')) {
      const originalWrite = res.write.bind(res);
      let writes = 0;
      res.write = ((chunk: unknown, ...args: unknown[]) => {
        writes += 1;
        if (writes > 1) return false;
        return (originalWrite as (value: unknown, ...rest: unknown[]) => boolean)(chunk, ...args);
      }) as typeof res.write;
    }
    next();
  });
  app.use('/api', createCanonicalRunEventRoutes(store));
  app.use('/api', createApiNotFoundHandler());
  app.use(createProblemErrorHandler());
  const { server, origin } = await listen(app);
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

test('P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed', async () => {
  const fx = await createBackpressureFixture();
  try {
    const second = appendManualEvent(fx);
    appendManualEvent(fx);
    const before = durableCounts(fx);
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream?afterSequence=0`);
    assert.equal(response.status, 200);
    const frames = await readUntilClosed(response);
    assert.deepEqual(frames.map(frameEventId), [eventIdAt(fx, 1)]);
    assert.ok(!frames.map(frameEventId).includes(second.id));
    assert.deepEqual(durableCounts(fx), before);
    transitionToStarting(fx);
    assert.equal(fx.store.runRepository().findById(fx.workspaceId, fx.runId)!.status, 'starting');
  } finally {
    await closeFixture(fx);
  }
});

// --- Keepalive persistence boundary ----------------------------------------

test('P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)', async () => {
  const fx = await createFixture();
  const controller = new AbortController();
  try {
    const before = durableCounts(fx);
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream`, { signal: controller.signal });
    assert.equal(response.status, 200);
    await readFrames(response, 1);
    controller.abort();
    assert.deepEqual(durableCounts(fx), before);
  } finally {
    controller.abort();
    await closeFixture(fx);
  }
});

// --- Route collision --------------------------------------------------------

test('P5C stream route does not shadow canonical Run, Events or Replay routes', async () => {
  const fx = await createFixture();
  const controller = new AbortController();
  try {
    const detail = await fetch(`${fx.baseApi}/runs/${fx.runId}`);
    assert.equal(detail.status, 200);
    assert.match(detail.headers.get('content-type') ?? '', /application\/json/);
    const detailBody = await detail.json() as { run?: { id?: string } };
    assert.equal(detailBody.run?.id, fx.runId);

    const events = await fetch(`${fx.baseApi}/runs/${fx.runId}/events`);
    assert.equal(events.status, 200);
    assert.match(events.headers.get('content-type') ?? '', /application\/json/);
    await events.json();

    const replay = await fetch(`${fx.baseApi}/runs/${fx.runId}/replay`);
    assert.equal(replay.status, 200);
    assert.match(replay.headers.get('content-type') ?? '', /application\/json/);
    await replay.json();

    const stream = await fetch(`${fx.baseApi}/runs/${fx.runId}/stream`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/);
    await readFrames(stream, 1);
  } finally {
    controller.abort();
    await closeFixture(fx);
  }
});
