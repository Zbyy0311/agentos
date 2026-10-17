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
import { SqliteStore } from '../store/SqliteStore.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { createUsageRoutes } from './usage.js';

interface Fixture {
  root: string;
  store: SqliteStore;
  server: ReturnType<express.Express['listen']>;
  baseApi: string;
  workspaceId: string;
  db: TransactionDatabase;
}

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-usage-routes-'));
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

async function createFixture(): Promise<Fixture> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const workspace = await manager.create('Usage Workspace', join(root, 'workspace-a'), {
    git: false, memory: false, readme: false, docs: false,
  });
  const db = store.usageRepository().transactionDatabase;

  // Two usage events: one authoritative, one estimated with prompt content
  // that must never surface.
  db.prepare(`
    INSERT INTO agent_events (
      event_id, schema_version, event_type, workspace_id, conversation_id,
      run_id, execution_id, agent_id, sequence, timestamp, payload_json
    ) VALUES ('evt_route_1', 2, 'execution.usage.recorded', ?, 'conv_1', 'run_r1', 'exec_1', 'agent_1', 1, '2026-10-17T00:00:00.000Z', ?)
  `).run(workspace.id, JSON.stringify({
    source: 'cli', provider: 'kimi', model: 'k2', inputTokens: 100, outputTokens: 25,
  }));
  db.prepare(`
    INSERT INTO agent_events (
      event_id, schema_version, event_type, workspace_id, conversation_id,
      run_id, execution_id, agent_id, sequence, timestamp, payload_json
    ) VALUES ('evt_route_2', 2, 'execution.usage.recorded', ?, 'conv_1', 'run_r2', 'exec_2', 'agent_1', 2, '2026-10-17T01:00:00.000Z', ?)
  `).run(workspace.id, JSON.stringify({
    provider: 'codex', estimated: true, inputTokens: 50, outputTokens: 10,
    prompt: 'TOP SECRET PROMPT', stdout: 'top secret stdout',
  }));

  const app = express();
  app.use(createRequestIdMiddleware());
  app.head('/__test_fetch_port_probe', (_req, res) => {
    res.setHeader('Connection', 'close');
    res.status(204).end();
  });
  app.use('/api/workspaces/:workspaceId', createUsageRoutes(store, manager));
  app.use('/api', createApiNotFoundHandler());
  app.use(createProblemErrorHandler());
  const { server, origin } = await listenOnFetchSafePort(app);
  return { root, store, server, baseApi: `${origin}/api`, workspaceId: workspace.id, db };
}

async function getJson(fixture: Fixture, path: string): Promise<{ status: number; body: unknown; contentType: string | null }> {
  const response = await fetch(`${fixture.baseApi}/workspaces/${fixture.workspaceId}${path}`);
  return {
    status: response.status,
    body: await response.json(),
    contentType: response.headers.get('content-type'),
  };
}

test('usage routes: records endpoint syncs, filters, paginates and never leaks prompt content', async (t) => {
  const fixture = await createFixture();
  try {
    const first = await getJson(fixture, '/usage/records');
    assert.equal(first.status, 200);
    const firstBody = first.body as {
      records: Array<Record<string, unknown>>;
      hasMore: boolean;
      nextCursor: string | null;
    };
    assert.equal(firstBody.records.length, 2);
    assert.equal(firstBody.hasMore, false);
    const providers = firstBody.records.map(record => record.provider).sort();
    assert.deepEqual(providers, ['codex', 'kimi']);
    const estimated = firstBody.records.find(record => record.provider === 'codex')!;
    assert.equal(estimated.estimated, true);
    assert.equal(estimated.totalTokens, 60);
    const serialized = JSON.stringify(firstBody);
    assert.ok(!serialized.includes('TOP SECRET PROMPT'));
    assert.ok(!serialized.includes('top secret stdout'));

    // Replay: repeated reads do not duplicate records.
    const replay = await getJson(fixture, '/usage/records');
    assert.equal((replay.body as typeof firstBody).records.length, 2);

    const runFilter = await getJson(fixture, '/usage/records?runId=run_r1');
    assert.equal((runFilter.body as typeof firstBody).records.length, 1);
    assert.equal((runFilter.body as typeof firstBody).records[0]!.provider, 'kimi');

    const window = await getJson(fixture, '/usage/records?from=2026-10-17T00:30:00.000Z');
    assert.equal((window.body as typeof firstBody).records.length, 1);

    const page = await getJson(fixture, '/usage/records?limit=1');
    const pageBody = page.body as typeof firstBody;
    assert.equal(pageBody.records.length, 1);
    assert.equal(pageBody.hasMore, true);
    const page2 = await getJson(fixture, `/usage/records?limit=1&cursor=${pageBody.nextCursor}`);
    assert.equal((page2.body as typeof firstBody).records.length, 1);
    assert.notEqual(
      (page.body as typeof firstBody).records[0]!.id,
      (page2.body as typeof firstBody).records[0]!.id,
    );

    await t.test('validation and 404 error family', async () => {
      for (const path of [
        '/usage/records?limit=0',
        '/usage/records?limit=201',
        '/usage/records?limit=abc',
        '/usage/records?from=not-a-date',
        '/usage/records?to=2026-10-17',
        '/usage/summary?groupBy=stage',
        '/usage/summary?from=garbage',
      ]) {
        const result = await getJson(fixture, path);
        assert.equal(result.status, 400, path);
        const problem = result.body as ApiProblem;
        assert.equal(problem.code, 'VALIDATION_FAILED');
        assert.equal(problem.status, 400);
        assert.ok((result.contentType ?? '').includes('application/problem+json'));
      }

      const missing = await fetch(`${fixture.baseApi}/workspaces/ws_00000000000000000000000009/usage/records`);
      assert.equal(missing.status, 404);
      assert.equal((await missing.json() as ApiProblem).code, 'WORKSPACE_NOT_FOUND');

      const missingSummary = await fetch(`${fixture.baseApi}/workspaces/ws_00000000000000000000000009/usage/summary`);
      assert.equal(missingSummary.status, 404);
    });

    await t.test('summary aggregates by provider and run', async () => {
      const byProvider = await getJson(fixture, '/usage/summary');
      assert.equal(byProvider.status, 200);
      const providerBody = byProvider.body as {
        groupBy: string;
        buckets: Array<{ key: string; recordCount: number; totalTokens: number; totalInputTokens: number; totalOutputTokens: number }>;
      };
      assert.equal(providerBody.groupBy, 'provider');
      const kimi = providerBody.buckets.find(bucket => bucket.key === 'kimi')!;
      assert.equal(kimi.recordCount, 1);
      assert.equal(kimi.totalTokens, 125);
      assert.equal(kimi.totalInputTokens, 100);
      assert.equal(kimi.totalOutputTokens, 25);

      const byRun = await getJson(fixture, '/usage/summary?groupBy=run');
      const runBody = byRun.body as typeof providerBody;
      assert.equal(runBody.groupBy, 'run');
      assert.deepEqual(runBody.buckets.map(bucket => bucket.key).sort(), ['run_r1', 'run_r2']);
    });
  } finally {
    await closeTestServer(fixture.server);
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
