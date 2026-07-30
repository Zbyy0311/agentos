import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2RunRoutes } from './v2Runs.js';
import { createV2TaskRoutes } from './v2Tasks.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { TaskRunService } from '../services/TaskRunService.js';
import type { Workspace } from '@agentos/shared';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-v2-run-routes-'));
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
  service: TaskRunService;
  server: ReturnType<express.Express['listen']>;
  baseA: string;
  baseB: string;
  workspaceAId: string;
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
  app.use('/api/workspaces/:workspaceId/v2', createV2TaskRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(store, manager));
  const { server, base } = await listenOnFetchSafePort(app);
  return {
    root,
    store,
    service: new TaskRunService(store),
    server,
    baseA: `${base}/${workspaceA.id}`,
    baseB: `${base}/${workspaceB.id}`,
    workspaceAId: workspaceA.id,
    workspaceA,
  };
}

async function closeFixture(fx: Fixture): Promise<void> {
  await closeTestServer(fx.server);
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

async function createTaskViaApi(baseA: string, title = 'task'): Promise<string> {
  const response = await fetch(`${baseA}/v2/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 201);
  return (await response.json() as { task: { id: string } }).task.id;
}

async function createRunViaApi(baseA: string, taskId: string): Promise<string> {
  const response = await fetch(`${baseA}/v2/tasks/${taskId}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 201);
  return (await response.json() as { run: { id: string } }).run.id;
}

test('P4 malformed repository read surfaces fail closed instead of synthesizing compatibility', async () => {
  const fx = await createFixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceAId,
      legacyTaskId: 'malformed-read-surface',
      title: 'malformed read surface',
      createdBy: 'legacy_pipeline',
      objective: 'malformed read surface',
      workspace: fx.workspaceA,
    });
    const validSnapshotRepository = fx.store.runSnapshotRepository();
    const validStageRepository = fx.store.runStageRepository();
    const malformedStore = fx.store as unknown as {
      runSnapshotRepository: () => unknown;
      runStageRepository: () => unknown;
    };

    malformedStore.runSnapshotRepository = () => ({});
    const missingSnapshotRead = await fetch(`${fx.baseA}/v2/runs/${created.run.id}`);
    assert.equal(missingSnapshotRead.status, 500);
    assert.deepEqual(await missingSnapshotRead.json(), {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });

    malformedStore.runSnapshotRepository = () => validSnapshotRepository;
    malformedStore.runStageRepository = () => ({});
    const missingStageRead = await fetch(`${fx.baseA}/v2/runs/${created.run.id}?include=stages`);
    assert.equal(missingStageRead.status, 500);
    assert.deepEqual(await missingStageRead.json(), {
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    });

    malformedStore.runStageRepository = () => validStageRepository;
  } finally {
    await closeFixture(fx);
  }
});

test('T76 GET v2 Run returns failureCode/failureMessage and the full Run', async () => {
  const fx = await createFixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceAId,
      legacyTaskId: 'L1',
      title: 'bridge task',
      createdBy: 'legacy_pipeline',
      objective: 'bridge objective',
      workspace: fx.workspaceA,
    });
    fx.service.startRunForBridge(fx.workspaceAId, created.run.id);
    fx.service.failRunForBridge(fx.workspaceAId, created.run.id, 'worker exploded');

    const response = await fetch(`${fx.baseA}/v2/runs/${created.run.id}`);
    assert.equal(response.status, 200);
    const { run } = await response.json() as { run: Record<string, unknown> };
    assert.equal(run.id, created.run.id);
    assert.equal(run.status, 'failed');
    assert.equal(run.failureCode, 'LEGACY_PIPELINE_FAILED');
    assert.equal(run.failureMessage, 'worker exploded');
    assert.equal(run.taskId, created.task.id);
    assert.equal(run.workspaceId, fx.workspaceAId);
    assert.equal(run.origin, 'legacy_pipeline');
    assert.equal(run.objective, 'bridge objective');
    assert.ok(run.createdAt);
    assert.ok(run.completedAt);
    assert.equal(run.version, 3);
    const body = (await fetch(`${fx.baseA}/v2/runs/${created.run.id}`)).json() as Promise<Record<string, unknown>>;
    const defaultBody = await body;
    assert.equal(defaultBody.snapshotAvailable, true);
    assert.equal(defaultBody.snapshotSchemaVersion, 1);
    assert.equal('snapshot' in defaultBody, false);
    assert.equal('stages' in defaultBody, false);
    assert.equal('contentHash' in defaultBody, false);
  } finally {
    await closeFixture(fx);
  }
});

test('[M27-P4-T007] v2 Run create and read preserve initial lineage and origin', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA, 'p4 v2 run task');
    const runId = await createRunViaApi(fx.baseA, taskId);
    const response = await fetch(`${fx.baseA}/v2/runs/${runId}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { run: Record<string, unknown> };
    assert.deepEqual({
      id: body.run.id,
      taskId: body.run.taskId,
      status: body.run.status,
      reason: body.run.reason,
      origin: body.run.origin,
      parentRunId: body.run.parentRunId,
      rootRunId: body.run.rootRunId,
    }, {
      id: runId,
      taskId,
      status: 'queued',
      reason: 'initial',
      origin: 'v2_api',
      parentRunId: undefined,
      rootRunId: runId,
    });
  } finally {
    await closeFixture(fx);
  }
});

test('P4 GET v2 Run includes snapshot payload and content hash without row metadata', async () => {
  const fx = await createFixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceAId,
      legacyTaskId: 'p4-snapshot',
      title: 'p4 snapshot',
      createdBy: 'legacy_pipeline',
      objective: 'p4 snapshot',
      workspace: fx.workspaceA,
    });
    const response = await fetch(`${fx.baseA}/v2/runs/${created.run.id}?include=snapshot`);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.snapshotAvailable, true);
    assert.equal(body.snapshotSchemaVersion, 1);
    assert.equal((body.snapshot as { workflow: { definitionKey: string } }).workflow.definitionKey, 'legacy-pipeline');
    assert.match(body.contentHash as string, /^[0-9a-f]{64}$/);
    assert.equal('snapshotId' in body, false);
    assert.equal('workflowDefinitionId' in body, false);
    assert.equal('id' in (body.snapshot as Record<string, unknown>), false);
  } finally {
    await closeFixture(fx);
  }
});

test('P4 GET v2 Run includes ordered stages and both include orders', async () => {
  const fx = await createFixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceAId,
      legacyTaskId: 'p4-stages',
      title: 'p4 stages',
      createdBy: 'legacy_pipeline',
      objective: 'p4 stages',
      workspace: fx.workspaceA,
    });
    for (const include of ['stages', 'snapshot,stages', 'stages,snapshot']) {
      const response = await fetch(`${fx.baseA}/v2/runs/${created.run.id}?include=${encodeURIComponent(include)}`);
      assert.equal(response.status, 200);
      const body = await response.json() as Record<string, unknown>;
      assert.deepEqual((body.stages as Array<{ sequence: number }>).map(stage => stage.sequence), [1, 2, 3, 4]);
      if (include !== 'stages') {
        assert.ok(body.snapshot);
        assert.match(body.contentHash as string, /^[0-9a-f]{64}$/);
      }
    }
  } finally {
    await closeFixture(fx);
  }
});

test('P4 GET v2 Run returns stages=[] for an unbound Run and exposes snapshot metadata', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA, 'unbound p4');
    const runId = await createRunViaApi(fx.baseA, taskId);
    const stagesResponse = await fetch(`${fx.baseA}/v2/runs/${runId}?include=stages`);
    assert.equal(stagesResponse.status, 200);
    const stagesBody = await stagesResponse.json() as Record<string, unknown>;
    assert.equal(stagesBody.snapshotAvailable, true);
    assert.equal(stagesBody.snapshotSchemaVersion, 1);
    assert.deepEqual(stagesBody.stages, []);
    const snapshotResponse = await fetch(`${fx.baseA}/v2/runs/${runId}?include=snapshot`);
    const snapshotBody = await snapshotResponse.json() as Record<string, unknown>;
    assert.equal((snapshotBody.snapshot as { workflow: { definitionKey: string } }).workflow.definitionKey, 'unbound-task-run');
    assert.equal((snapshotBody.snapshot as { workflow: { stages: unknown[] } }).workflow.stages.length, 0);
  } finally {
    await closeFixture(fx);
  }
});

test('P4 GET v2 Run rejects malformed include values with VALIDATION_FAILED', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA, 'include validation');
    const runId = await createRunViaApi(fx.baseA, taskId);
    for (const query of [
      'include=', 'include=snapshot,', 'include=,snapshot', 'include=snapshot,,stages',
      'include=unknown', 'include=Snapshot', 'include[]=snapshot', 'include=snapshot&include=stages',
    ]) {
      const response = await fetch(`${fx.baseA}/v2/runs/${runId}?${query}`);
      assert.equal(response.status, 400, query);
      assert.equal((await response.json() as { code: string }).code, 'VALIDATION_FAILED');
    }
    const duplicate = await fetch(`${fx.baseA}/v2/runs/${runId}?include=snapshot,snapshot`);
    assert.equal(duplicate.status, 200);
    const duplicateBody = await duplicate.json() as Record<string, unknown>;
    assert.ok(duplicateBody.snapshot);
  } finally {
    await closeFixture(fx);
  }
});

test('P4 GET v2 Run preserves pre-M2.5 false/null/empty compatibility', async () => {
  const fx = await createFixture();
  try {
    const task = fx.store.taskRepository().insert({ workspaceId: fx.workspaceAId, title: 'pre-m25', createdBy: 'test' });
    const legacyRun = fx.store.runRepository().insert({
      workspaceId: fx.workspaceAId,
      taskId: task.id,
      origin: 'v2_api',
      createdBy: 'test',
    });
    const defaultResponse = await fetch(`${fx.baseA}/v2/runs/${legacyRun.id}`);
    const jsonRun = JSON.parse(JSON.stringify(legacyRun));
    assert.deepEqual(await defaultResponse.json(), {
      run: jsonRun,
      snapshotAvailable: false,
      snapshotSchemaVersion: null,
    });
    const snapshotResponse = await fetch(`${fx.baseA}/v2/runs/${legacyRun.id}?include=snapshot`);
    assert.deepEqual(await snapshotResponse.json(), {
      run: jsonRun,
      snapshotAvailable: false,
      snapshotSchemaVersion: null,
      snapshot: null,
      contentHash: null,
    });
    const stagesResponse = await fetch(`${fx.baseA}/v2/runs/${legacyRun.id}?include=stages`);
    assert.deepEqual((await stagesResponse.json() as { stages: unknown[] }).stages, []);
  } finally {
    await closeFixture(fx);
  }
});

test('T77 cross-workspace Run access returns RUN_NOT_FOUND', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA);
    const runId = await createRunViaApi(fx.baseA, taskId);
    const response = await fetch(`${fx.baseB}/v2/runs/${runId}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json() as { code: string }).code, 'RUN_NOT_FOUND');
  } finally {
    await closeFixture(fx);
  }
});

test('T83 cancelling a queued v2 Run succeeds and releases the active slot', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA);
    const runId = await createRunViaApi(fx.baseA, taskId);
    const cancel = await fetch(`${fx.baseA}/v2/runs/${runId}/cancel`, { method: 'POST' });
    assert.equal(cancel.status, 200);
    const { run } = await cancel.json() as { run: Record<string, unknown> };
    assert.equal(run.status, 'cancelled');
    assert.ok(run.cancellationRequestedAt);

    const nextRunId = await createRunViaApi(fx.baseA, taskId);
    assert.ok(nextRunId);
  } finally {
    await closeFixture(fx);
  }
});

test('T84 cancelling a running Run returns 409 RUN_NOT_CANCELLABLE', async () => {
  const fx = await createFixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceAId, legacyTaskId: 'L1', title: 'bridge', createdBy: 'legacy_pipeline', objective: 'bridge', workspace: fx.workspaceA,
    });
    fx.service.startRunForBridge(fx.workspaceAId, created.run.id);
    const response = await fetch(`${fx.baseA}/v2/runs/${created.run.id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'RUN_NOT_CANCELLABLE');
  } finally {
    await closeFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// M2.6 P3 — Route idempotency integration (R08)
// ---------------------------------------------------------------------------

test('R08 run cancel replay is evaluated before RUN_NOT_CANCELLABLE', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA, 'r08');
    const runId = await createRunViaApi(fx.baseA, taskId);
    const first = await fetch(`${fx.baseA}/v2/runs/${runId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'r08-key-0001' },
      body: JSON.stringify({}),
    });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('idempotency-replayed'), null);
    const firstRun = (await first.json() as { run: { id: string; status: string } }).run;
    assert.equal(firstRun.status, 'cancelled');
    // The run is already cancelled; without idempotency this would be a 409 RUN_NOT_CANCELLABLE.
    const replay = await fetch(`${fx.baseA}/v2/runs/${runId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'r08-key-0001' },
      body: JSON.stringify({}),
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    const replayRun = (await replay.json() as { run: { id: string; status: string } }).run;
    assert.deepEqual(replayRun, firstRun);
    const conflict = await fetch(`${fx.baseA}/v2/runs/${runId}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'r08-key-0002' },
      body: JSON.stringify({}),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { code: string }).code, 'RUN_NOT_CANCELLABLE');
    const recordCount = fx.store.getDatabase()
      .prepare('SELECT COUNT(*) AS count FROM idempotency_records')
      .get() as { count: number };
    assert.equal(recordCount.count, 1);
  } finally {
    await closeFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// M2.6 P4 — run.cancel optional expectedVersion (route coverage)
// ---------------------------------------------------------------------------

async function postRunCancel(baseA: string, runId: string, body: unknown, key?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key !== undefined) headers['Idempotency-Key'] = key;
  return fetch(`${baseA}/v2/runs/${runId}/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });
}

test('P401/P402 route run.cancel honors matching and stale expectedVersion', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA, 'p401-route');
    const runId = await createRunViaApi(fx.baseA, taskId);
    const stale = await postRunCancel(fx.baseA, runId, { expectedVersion: 2 });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: 'Version conflict', code: 'VERSION_CONFLICT' });
    const untouched = fx.store.runRepository().findById(fx.workspaceAId, runId)!;
    assert.equal(untouched.status, 'queued');
    assert.equal(untouched.version, 1);
    const matching = await postRunCancel(fx.baseA, runId, { expectedVersion: 1 });
    assert.equal(matching.status, 200);
    const body = await matching.json() as { run: { status: string; version: number } };
    assert.equal(body.run.status, 'cancelled');
    assert.equal(body.run.version, 2);
  } finally {
    await closeFixture(fx);
  }
});

test('P425/P427 route run.cancel invalid expectedVersion returns 400, no mutation, no record', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA, 'p425-run');
    const runId = await createRunViaApi(fx.baseA, taskId);
    for (const value of [null, 0, -1, 1.5, '1', [1], { v: 1 }]) {
      const response = await postRunCancel(fx.baseA, runId, { expectedVersion: value }, 'p425-run-key');
      assert.equal(response.status, 400, `expectedVersion=${JSON.stringify(value)} must be rejected`);
      assert.deepEqual(await response.json(), {
        error: 'expectedVersion must be a positive safe integer',
        code: 'VALIDATION_FAILED',
      });
    }
    const untouched = fx.store.runRepository().findById(fx.workspaceAId, runId)!;
    assert.equal(untouched.status, 'queued');
    const recordCount = fx.store.getDatabase()
      .prepare('SELECT COUNT(*) AS count FROM idempotency_records')
      .get() as { count: number };
    assert.equal(recordCount.count, 0);
  } finally {
    await closeFixture(fx);
  }
});

test('P414-run route a successful keyed replay precedes the stale run version guard', async () => {
  const fx = await createFixture();
  try {
    const taskId = await createTaskViaApi(fx.baseA, 'p414-run');
    const runId = await createRunViaApi(fx.baseA, taskId);
    const first = await postRunCancel(fx.baseA, runId, { expectedVersion: 1 }, 'p414-run-001');
    assert.equal(first.status, 200);
    const replay = await postRunCancel(fx.baseA, runId, { expectedVersion: 1 }, 'p414-run-001');
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(await replay.json(), await first.json());
  } finally {
    await closeFixture(fx);
  }
});

test('T85 cancelling a terminal Run returns 409 RUN_NOT_CANCELLABLE', async () => {
  const fx = await createFixture();
  try {
    const created = fx.service.createLegacyRunForBridge({
      workspaceId: fx.workspaceAId, legacyTaskId: 'L1', title: 'bridge', createdBy: 'legacy_pipeline', objective: 'bridge', workspace: fx.workspaceA,
    });
    fx.service.startRunForBridge(fx.workspaceAId, created.run.id);
    fx.service.completeRunForBridge(fx.workspaceAId, created.run.id);
    const response = await fetch(`${fx.baseA}/v2/runs/${created.run.id}/cancel`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, 'RUN_NOT_CANCELLABLE');
  } finally {
    await closeFixture(fx);
  }
});
