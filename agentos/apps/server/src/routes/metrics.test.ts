import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ApiProblem } from '@agentos/shared';
import {
  createApiNotFoundHandler,
  createProblemErrorHandler,
  createRequestIdMiddleware,
} from '../problemDetails.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from '../services/TaskRunService.js';
import { SqliteStore } from '../store/SqliteStore.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { createMetricsRoutes } from './metrics.js';

interface Fixture {
  root: string;
  store: SqliteStore;
  server: ReturnType<express.Express['listen']>;
  baseApi: string;
  workspaceId: string;
  db: TransactionDatabase;
}

interface MetricsSummaryBody {
  workspaceId: string;
  generatedAt: string;
  runs: {
    windowFrom: string | null;
    windowTo: string | null;
    totalRuns: number;
    completedRuns: number;
    failedRuns: number;
    cancelledRuns: number;
    cancelsRequested: number;
    averageCancelLatencyMs: number | null;
  };
  outbox: {
    pendingCount: number;
    retryCount: number;
    publishingCount: number;
    deadLetterCount: number;
    oldestPendingAgeMs: number | null;
  };
  database: {
    pageSizeBytes: number;
    pageCount: number;
    freelistPages: number;
    sizeBytes: number;
    journalMode: string;
    busyTimeoutMs: number;
  };
  events: {
    durableRuntimeEventsAppended: number;
    legacyAgentEventsAppended: number;
  };
}

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-metrics-routes-'));
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

const T0 = '2026-10-17T00:00:00.000Z';

async function createFixture(): Promise<Fixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = await manager.create('Metrics Workspace', join(root, 'workspace-a'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const db = store.usageRepository().transactionDatabase;
  const seeder = new TaskRunService(store);

  // Seed terminal Runs: 1 completed, 1 failed, 1 cancelled with a 5s cancel latency.
  const mkRun = (key: string): string => {
    const task = seeder.createTask(workspace.id, { title: `task-${key}`, createdBy: 'test' });
    return seeder.createRun(workspace.id, { taskId: task.id, createdBy: 'test' }).id;
  };
  const completedRunId = mkRun('completed');
  const failedRunId = mkRun('failed');
  const cancelledRunId = mkRun('cancelled');
  db.prepare(`
    UPDATE runs SET status = 'completed', started_at = ?, completed_at = ?, created_at = ?, updated_at = ?
    WHERE id = ?
  `).run(T0, '2026-10-17T00:10:00.000Z', T0, T0, completedRunId);
  db.prepare(`
    UPDATE runs SET status = 'failed', started_at = ?, completed_at = ?, created_at = ?, updated_at = ?
    WHERE id = ?
  `).run(T0, '2026-10-17T00:05:00.000Z', '2026-10-17T00:02:00.000Z', T0, failedRunId);
  db.prepare(`
    UPDATE runs SET status = 'cancelled', started_at = ?, cancellation_requested_at = ?,
      completed_at = ?, created_at = ?, updated_at = ?
    WHERE id = ?
  `).run(T0, '2026-10-17T00:06:00.000Z', '2026-10-17T00:06:05.000Z', '2026-10-17T00:04:00.000Z', T0, cancelledRunId);

  // One due Outbox message (available 30s in the past) + one published.
  // outbox_messages FK-references runtime_events, so seed minimal Events.
  const insertEvent = db.prepare(`
    INSERT INTO runtime_events (
      id, schema_version, type, workspace_id, task_id, run_id, sequence,
      timestamp, source, correlation_id, severity, visibility, durability,
      payload_json, created_at
    ) VALUES (?, 1, 'run.completed', ?, (SELECT task_id FROM runs WHERE id = ?), ?,
      (SELECT COALESCE(MAX(sequence), 0) + 1 FROM runtime_events WHERE run_id = ?),
      ?, 'metrics-test', 'corr_1', 'info', 'internal', 'durable', '{}', ?)
  `);
  insertEvent.run('evt_m1', workspace.id, cancelledRunId, cancelledRunId, cancelledRunId, T0, T0);
  insertEvent.run('evt_m2', workspace.id, completedRunId, completedRunId, completedRunId, T0, T0);
  db.prepare(`
    INSERT INTO outbox_messages (
      id, event_id, topic, aggregate_type, aggregate_id, payload_json,
      status, attempts, available_at, published_at, version, created_at
    ) VALUES ('outbox_m1', 'evt_m1', 'runtime-events', 'run', ?, '{"ok":true}',
      'pending', 0, '2026-10-17T00:09:30.000Z', NULL, 1, ?)
  `).run(cancelledRunId, T0);
  db.prepare(`
    INSERT INTO outbox_messages (
      id, event_id, topic, aggregate_type, aggregate_id, payload_json,
      status, attempts, available_at, published_at, version, created_at
    ) VALUES ('outbox_m2', 'evt_m2', 'runtime-events', 'run', ?, '{"ok":true}',
      'published', 1, ?, ?, 1, ?)
  `).run(completedRunId, T0, T0, T0);

  const app = express();
  app.use(createRequestIdMiddleware());
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.use('/api/workspaces/:workspaceId', createMetricsRoutes(store, manager));
  app.use('/api', createApiNotFoundHandler());
  app.use(createProblemErrorHandler());
  const { server, origin } = await listenOnFetchSafePort(app);
  return { root, store, server, baseApi: `${origin}/api`, workspaceId: workspace.id, db };
}

test('metrics summary returns the §181-185 minimal subset with values matching fixture state', async (t) => {
  const fixture = await createFixture();
  try {
    const response = await fetch(`${fixture.baseApi}/workspaces/${fixture.workspaceId}/metrics/summary`);
    assert.equal(response.status, 200);
    const body = await response.json() as MetricsSummaryBody;

    assert.equal(body.workspaceId, fixture.workspaceId);
    assert.equal(body.runs.windowFrom, null);
    assert.equal(body.runs.totalRuns, 3);
    assert.equal(body.runs.completedRuns, 1);
    assert.equal(body.runs.failedRuns, 1);
    assert.equal(body.runs.cancelledRuns, 1);
    assert.equal(body.runs.cancelsRequested, 1);
    assert.equal(body.runs.averageCancelLatencyMs, 5000);

    // 3 pending Outbox rows from the seeded run.created events + 1 explicit.
    assert.equal(body.outbox.pendingCount, 4);
    assert.equal(body.outbox.retryCount, 0);
    assert.equal(body.outbox.publishingCount, 0);
    assert.equal(body.outbox.deadLetterCount, 0);
    assert.ok(body.outbox.oldestPendingAgeMs !== null);
    assert.ok(body.outbox.oldestPendingAgeMs >= 30_000);

    assert.equal(body.database.pageSizeBytes, 4096);
    assert.ok(body.database.pageCount > 0);
    assert.equal(body.database.sizeBytes, body.database.pageSizeBytes * body.database.pageCount);
    assert.ok(['wal', 'delete', 'memory'].includes(body.database.journalMode));
    assert.equal(body.database.busyTimeoutMs, 5000);

    assert.equal(body.events.legacyAgentEventsAppended, 0);
    assert.equal(typeof body.events.durableRuntimeEventsAppended, 'number');

    await t.test('window filtering narrows run and event counts', async () => {
      const filtered = await fetch(
        `${fixture.baseApi}/workspaces/${fixture.workspaceId}/metrics/summary?from=2026-10-17T00:03:00.000Z`,
      );
      assert.equal(filtered.status, 200);
      const filteredBody = await filtered.json() as MetricsSummaryBody;
      assert.equal(filteredBody.runs.windowFrom, '2026-10-17T00:03:00.000Z');
      assert.equal(filteredBody.runs.totalRuns, 1); // only the cancelled run was created inside the window
      assert.equal(filteredBody.runs.cancelledRuns, 1);
      assert.equal(filteredBody.runs.failedRuns, 0);
    });

    await t.test('error family: 404 workspace and 400 validation', async () => {
      const missing = await fetch(`${fixture.baseApi}/workspaces/ws_00000000000000000000000009/metrics/summary`);
      assert.equal(missing.status, 404);
      const problem = await missing.json() as ApiProblem;
      assert.equal(problem.code, 'WORKSPACE_NOT_FOUND');
      assert.equal(problem.status, 404);
      assert.ok((missing.headers.get('content-type') ?? '').includes('application/problem+json'));

      const badFrom = await fetch(`${fixture.baseApi}/workspaces/${fixture.workspaceId}/metrics/summary?from=yesterday`);
      assert.equal(badFrom.status, 400);
      assert.equal((await badFrom.json() as ApiProblem).code, 'VALIDATION_FAILED');
    });
  } finally {
    await closeTestServer(fixture.server);
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
