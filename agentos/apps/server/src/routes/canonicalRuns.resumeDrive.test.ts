import test from 'node:test';
import assert from 'node:assert/strict';
import cors from 'cors';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * P4B Resume re-drive route tests (canonical + current-v2 families).
 *
 * A resume that genuinely transitions the Run paused -> running triggers
 * exactly one background dispatch through the injected resumeDispatch seam
 * (the same RunEngineProviderDispatcher channel the canonical start route
 * uses). The idempotent already-running 200 and durable idempotency replays
 * must never re-dispatch.
 */

const NOW = '2026-08-01T00:00:00.000Z';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-resume-drive-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  return root;
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
      if ((error as { cause?: { message?: unknown } } | null)?.cause?.message !== 'bad port') throw error;
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
  runId: string;
  drives: Array<{ workspaceId: string; runId: string }>;
}

async function createFixture(): Promise<Fixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = await manager.create('Resume Drive Workspace', join(root, 'workspace-a'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const seeder = new TaskRunService(store);
  const task = seeder.createTask(workspace.id, { title: 'resume-drive-target', createdBy: 'test' });
  const run = seeder.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
  const drives: Array<{ workspaceId: string; runId: string }> = [];
  const resumeDispatch = {
    enabled: true,
    drive: async (workspaceId: string, runId: string) => {
      drives.push({ workspaceId, runId });
    },
  };
  const security = resolveLocalApiSecurityConfig({});
  const app = express();
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
  app.use('/api/workspaces/:workspaceId/v2', createV2RunRoutes(store, manager, { resumeDispatch }));
  app.use('/api', createCanonicalRunRoutes(store, manager, { resumeDispatch }));
  app.use('/api', createApiNotFoundHandler());
  app.use(createProblemErrorHandler());
  const { server, origin } = await listenOnFetchSafePort(app);
  return {
    root,
    store,
    server,
    baseApi: `${origin}/api`,
    workspaceId: workspace.id,
    runId: run.id,
    drives,
  };
}

async function closeFixture(fx: Fixture): Promise<void> {
  await closeTestServer(fx.server);
  fx.store.close();
  rmSync(fx.root, { recursive: true, force: true });
}

function setRunStatus(fx: Fixture, runId: string, status: 'running' | 'paused'): void {
  fx.store.getDatabase().prepare(`
    UPDATE runs
    SET status = ?, started_at = ?, completed_at = NULL
    WHERE workspace_id = ? AND id = ?
  `).run(status, NOW, fx.workspaceId, runId);
}

async function api(
  fx: Fixture,
  method: string,
  path: string,
  options: { body?: unknown; key?: string } = {},
): Promise<{ status: number; replayed: string | null }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
  const response = await fetch(`${fx.baseApi}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  await response.text();
  return { status: response.status, replayed: response.headers.get('idempotency-replayed') };
}

test('P4B: canonical resume re-drives exactly once after a genuine paused -> running transition', async () => {
  const fx = await createFixture();
  try {
    setRunStatus(fx, fx.runId, 'running');
    const paused = await api(fx, 'POST', `/runs/${fx.runId}/pause`, { body: {} });
    assert.equal(paused.status, 200);
    assert.equal(fx.drives.length, 0, 'pause must never dispatch');

    const resumed = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: {} });
    assert.equal(resumed.status, 200);
    assert.deepEqual(fx.drives, [{ workspaceId: fx.workspaceId, runId: fx.runId }]);
  } finally {
    await closeFixture(fx);
  }
});

test('P4B: idempotent resume on an already running Run returns 200 without re-dispatching', async () => {
  const fx = await createFixture();
  try {
    setRunStatus(fx, fx.runId, 'running');
    await api(fx, 'POST', `/runs/${fx.runId}/pause`, { body: {} });
    const first = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: {} });
    assert.equal(first.status, 200);
    assert.equal(fx.drives.length, 1);
    const second = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: {} });
    assert.equal(second.status, 200);
    assert.equal(fx.drives.length, 1, 'idempotent resume must not re-dispatch');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B: durable idempotency replay of a resume never re-dispatches', async () => {
  const fx = await createFixture();
  try {
    setRunStatus(fx, fx.runId, 'running');
    await api(fx, 'POST', `/runs/${fx.runId}/pause`, { body: {} });
    const first = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: {}, key: 'resume-key-1' });
    assert.equal(first.status, 200);
    assert.equal(first.replayed, null);
    assert.equal(fx.drives.length, 1);
    const replay = await api(fx, 'POST', `/runs/${fx.runId}/resume`, { body: {}, key: 'resume-key-1' });
    assert.equal(replay.status, 200);
    assert.equal(replay.replayed, 'true');
    assert.equal(fx.drives.length, 1, 'replayed resume must not re-dispatch');
  } finally {
    await closeFixture(fx);
  }
});

test('P4B: resume without the dispatch seam (legacy mounts) changes state without driving', async () => {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  try {
    const manager = new WorkspaceManager(store);
    const workspace = await manager.create('No Seam Workspace', join(root, 'workspace-b'), {
      git: false, memory: false, readme: false, docs: false,
    });
    const seeder = new TaskRunService(store);
    const task = seeder.createTask(workspace.id, { title: 'no-seam', createdBy: 'test' });
    const run = seeder.createRun(workspace.id, { taskId: task.id, createdBy: 'test' });
    store.getDatabase().prepare(`
      UPDATE runs SET status = 'paused', started_at = ? WHERE workspace_id = ? AND id = ?
    `).run(NOW, workspace.id, run.id);
    const service = new TaskRunService(store);
    const result = service.resumeRunForV2(workspace.id, run.id);
    assert.equal(result.httpStatus, 200);
    const resumed = store.runRepository().findById(workspace.id, run.id);
    assert.equal(resumed?.status, 'running');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('P4B: current-v2 family re-drives on genuine resume and not on idempotent resume', async () => {
  const fx = await createFixture();
  try {
    setRunStatus(fx, fx.runId, 'running');
    const paused = await api(fx, 'POST', `/workspaces/${fx.workspaceId}/v2/runs/${fx.runId}/pause`, { body: {} });
    assert.equal(paused.status, 200);
    const resumed = await api(fx, 'POST', `/workspaces/${fx.workspaceId}/v2/runs/${fx.runId}/resume`, { body: {} });
    assert.equal(resumed.status, 200);
    assert.equal(fx.drives.length, 1);
    const again = await api(fx, 'POST', `/workspaces/${fx.workspaceId}/v2/runs/${fx.runId}/resume`, { body: {} });
    assert.equal(again.status, 200);
    assert.equal(fx.drives.length, 1);
  } finally {
    await closeFixture(fx);
  }
});
