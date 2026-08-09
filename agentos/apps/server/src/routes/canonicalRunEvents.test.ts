import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createApiNotFoundHandler, createProblemErrorHandler, createRequestIdMiddleware } from '../problemDetails.js';
import { TaskRunService } from '../services/TaskRunService.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { canonicalizeJson, hashCanonicalJson } from '../snapshots/canonicalJson.js';
import { createCanonicalRunRoutes } from './canonicalRuns.js';
import { createCanonicalRunEventRoutes } from './canonicalRunEvents.js';

interface Fixture {
  root: string;
  store: SqliteStore;
  server: ReturnType<express.Express['listen']>;
  baseApi: string;
  workspaceId: string;
  taskId: string;
  runId: string;
}

function isFetchBadPortError(error: unknown): boolean {
  return (error as { cause?: { message?: unknown } } | null)?.cause?.message === 'bad port';
}

async function closeServer(server: ReturnType<express.Express['listen']>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function listen(app: express.Express): Promise<{ server: ReturnType<express.Express['listen']>; origin: string }> {
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

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'agentos-p5a-route-red-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = manager.create('P5A Route Workspace', join(root, 'workspace-a'), {
    git: false,
    memory: false,
    readme: false,
    docs: false,
  });
  const service = new TaskRunService(store);
  const task = service.createTask(workspace.id, { title: 'P5A route task', createdBy: 'test' });
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

async function getJson(fx: Fixture, path: string): Promise<{
  status: number;
  contentType: string;
  body: Record<string, unknown>;
}> {
  const response = await fetch(`${fx.baseApi}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.json() as Record<string, unknown>,
  };
}

test('P5A-R01 GET canonical Run Events is implemented from durable runtime_events', async () => {
  const fx = await createFixture();
  try {
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/events`);
    assert.equal(response.status, 200);
  } finally {
    await closeFixture(fx);
  }
});

test('P5A-R02 GET canonical Run Replay is implemented from durable evidence', async () => {
  const fx = await createFixture();
  try {
    const response = await fetch(`${fx.baseApi}/runs/${fx.runId}/replay`);
    assert.equal(response.status, 200);
  } finally {
    await closeFixture(fx);
  }
});

test('P5A-R06/R09/R12 Events returns the raw bounded page in strict sequence order', async () => {
  const fx = await createFixture();
  try {
    const result = await getJson(fx, `/runs/${fx.runId}/events?afterSequence=0&limit=1`);
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.body.events));
    assert.equal((result.body.events as unknown[]).length, 1);
    assert.equal(result.body.nextAfterSequence, 1);
    assert.equal(result.body.hasMore, false);
    assert.equal('data' in result.body, false, 'RuntimeEventPage must not use a normal list envelope');
  } finally {
    await closeFixture(fx);
  }
});

test('P5A-R13 Events preserves unknown wire records without Registry consumption wrappers', async () => {
  const fx = await createFixture();
  try {
    fx.store.getDatabase().prepare(`
      INSERT INTO runtime_events (
        id, schema_version, type, workspace_id, task_id, run_id, sequence,
        timestamp, source, correlation_id, severity, visibility, durability,
        payload_json, metadata_json, created_at
      ) VALUES ('evt_00000000000000000000000002', 1, 'future.route.event', ?, ?, ?, 2,
        '2026-08-10T00:00:00.000Z', 'system', 'corr_future_route', 'notice',
        'public', 'durable', '{"future":true}', NULL, '2026-08-10T00:00:00.000Z')
    `).run(fx.workspaceId, fx.taskId, fx.runId);
    const result = await getJson(fx, `/runs/${fx.runId}/events?types=future.route.event`);
    assert.equal(result.status, 200);
    const events = result.body.events as Record<string, unknown>[];
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'unknown_runtime_event');
    assert.equal(events[0]?.warning, 'UNKNOWN_EVENT_TYPE');
    assert.equal(events[0]?.sequence, 2);
    assert.equal('event' in events[0]!, false);
  } finally {
    await closeFixture(fx);
  }
});

test('P5A-R14 locator-first unknown Run keeps 404 precedence over malformed query', async () => {
  const fx = await createFixture();
  try {
    const result = await getJson(fx, '/runs/run_missing/events?limit=invalid');
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'RUN_NOT_FOUND');
  } finally {
    await closeFixture(fx);
  }
});

test('P5A-R15/R16 query validation and Restricted visibility use stable ApiProblem codes', async () => {
  const fx = await createFixture();
  try {
    const malformed = await getJson(fx, `/runs/${fx.runId}/events?limit=0`);
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.code, 'VALIDATION_FAILED');
    assert.ok(malformed.contentType.startsWith('application/problem+json'));

    const invalidEnum = await getJson(fx, `/runs/${fx.runId}/events?severity=loud`);
    assert.equal(invalidEnum.status, 422);
    assert.equal(invalidEnum.body.code, 'INPUT_ENUM_INVALID');

    const restricted = await getJson(fx, `/runs/${fx.runId}/events?visibility=restricted`);
    assert.equal(restricted.status, 403);
    assert.equal(restricted.body.code, 'EVENT_VISIBILITY_FORBIDDEN');
    assert.equal(restricted.body.title, 'Forbidden');
  } finally {
    await closeFixture(fx);
  }
});

test('P5A-R17 Replay returns only the safe Shared projection', async () => {
  const fx = await createFixture();
  try {
    const result = await getJson(fx, `/runs/${fx.runId}/replay?includeArtifacts=true`);
    assert.equal(result.status, 200);
    assert.equal((result.body.runSnapshot as { schemaVersion?: unknown } | null)?.schemaVersion, 2);
    assert.ok(Array.isArray(result.body.stageSnapshots));
    assert.ok(Array.isArray(result.body.events));
    assert.deepEqual(result.body.artifactIndex, []);
    assert.ok((result.body.compatibilityWarnings as { code?: unknown }[])
      .some(warning => warning.code === 'ARTIFACT_INDEX_UNAVAILABLE'));
    const serialized = JSON.stringify(result.body);
    assert.equal(serialized.includes('originalPath'), false);
    assert.equal(serialized.includes('storageKey'), false);
  } finally {
    await closeFixture(fx);
  }
});

test('P5A-R22 unsafe persisted Snapshot fails closed without leaking secret/path/SQLite details', async () => {
  const fx = await createFixture();
  try {
    const db = fx.store.getDatabase();
    const now = '2026-08-10T00:00:00.000Z';
    const unsafeWorkspaceId = 'Bearer p5a-secret-token';
    const unsafeTaskId = 'task_p5a_unsafe';
    db.prepare(`
      INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
      VALUES (?, 'Unsafe fixture', '/tmp/p5a-unsafe', '/tmp/p5a-unsafe', ?, ?, ?)
    `).run(unsafeWorkspaceId, now, now, now);
    db.prepare(`
      INSERT INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at)
      VALUES (?, ?, 'Unsafe replay fixture', 'open', 'normal', 'test', ?, ?)
    `).run(unsafeTaskId, unsafeWorkspaceId, now, now);
    const unsafeRun = fx.store.runRepository().insert({
      workspaceId: unsafeWorkspaceId,
      taskId: unsafeTaskId,
      createdBy: 'test',
      origin: 'v2_api',
      reason: 'initial',
    });
    const safeSnapshot = fx.store.runSnapshotRepository().findByRunId(fx.workspaceId, fx.runId)!;
    const payload = structuredClone(safeSnapshot.payload);
    payload.run.workspaceId = unsafeWorkspaceId;
    payload.run.taskId = unsafeTaskId;
    payload.run.rootRunId = unsafeRun.id;
    payload.run.parentRunId = null;
    const snapshotJson = canonicalizeJson(payload);
    db.prepare(`
      INSERT INTO run_snapshots (
        id, workspace_id, run_id, workflow_definition_id, snapshot_schema_version,
        snapshot_json, content_hash, redaction_applied, captured_at
      ) VALUES ('snapshot_p5a_unsafe', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      unsafeWorkspaceId,
      unsafeRun.id,
      safeSnapshot.workflowDefinitionId,
      payload.schemaVersion,
      snapshotJson,
      hashCanonicalJson(payload),
      payload.security.redactionApplied ? 1 : 0,
      payload.capturedAt,
    );

    const result = await getJson(fx, `/runs/${unsafeRun.id}/replay`);
    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'INTERNAL_ERROR');
    const serialized = JSON.stringify(result.body);
    for (const forbidden of ['p5a-secret-token', 'C:\\private', 'SQLite', 'stack']) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked`);
    }
  } finally {
    await closeFixture(fx);
  }
});

test('P5A-R26 Stream remains a P5C future route with truthful 404', async () => {
  const fx = await createFixture();
  try {
    const result = await getJson(fx, `/runs/${fx.runId}/stream`);
    assert.equal(result.status, 404);
    assert.equal(result.body.code, 'NOT_FOUND');
  } finally {
    await closeFixture(fx);
  }
});
