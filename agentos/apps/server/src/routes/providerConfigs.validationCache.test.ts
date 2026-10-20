import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderConfigRoutes } from './providerConfigs.js';
import { createMetricsRoutes } from './metrics.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { ProviderRegistry, ProviderValidationService } from '@agentos/agent-core/providers';
import type { ProviderConfigurationInput, ProviderValidationResult } from '@agentos/agent-core/providers';
import { ProviderMetricsService } from '../services/ProviderMetricsService.js';

const TTL_ENV = 'AGENTOS_PROVIDER_VALIDATION_CACHE_TTL_MS';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-provider-cache-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  return root;
}

class CountingValidationService extends ProviderValidationService {
  readonly results: ProviderValidationResult[] = [];
  constructor(private readonly makeResult: (callIndex: number) => ProviderValidationResult) {
    super(new ProviderRegistry([]));
  }
  override async validate(configuration: ProviderConfigurationInput): Promise<ProviderValidationResult> {
    const result = this.makeResult(this.results.length);
    this.results.push(result);
    return result;
  }
  get calls(): number {
    return this.results.length;
  }
}

function validResult(checkedAt: string): ProviderValidationResult {
  return {
    valid: true,
    capabilities: {} as ProviderValidationResult['capabilities'],
    outputMode: 'parsed-text',
    warnings: [],
    errors: [],
    checkedAt,
  };
}

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof app.listen>; base: string }> {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
  return { server, base: `http://127.0.0.1:${address.port}/api/workspaces` };
}

async function createConfig(base: string, name: string): Promise<{ id: string; version: number }> {
  const response = await fetch(`${base}/provider-configs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, providerType: 'custom-cli', adapterId: 'builtin.custom-cli', executable: process.execPath }),
  });
  assert.equal(response.status, 201);
  return (await response.json() as { providerConfig: { id: string; version: number } }).providerConfig;
}

async function validate(base: string, id: string, body: Record<string, unknown> = {}): Promise<{ status: number; json: { validation: ProviderValidationResult & { fromCache?: boolean } } }> {
  const response = await fetch(`${base}/provider-configs/${id}/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() as { validation: ProviderValidationResult & { fromCache?: boolean } } };
}

test('validate serves cache hits, honors forceRefresh, and invalidates on version change', async (t) => {
  const previousTtl = process.env[TTL_ENV];
  delete process.env[TTL_ENV];
  t.after(() => {
    if (previousTtl === undefined) delete process.env[TTL_ENV];
    else process.env[TTL_ENV] = previousTtl;
  });

  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  let server: ReturnType<express.Express['listen']> | undefined;
  let serverBase = '';
  try {
    store = new SqliteStore(root);
    const manager = new WorkspaceManager(store);
    const workspace = await manager.create('Workspace A', join(root, 'a'), { git: false, memory: false, readme: false, docs: false });
    const validationService = new CountingValidationService(() => validResult(new Date().toISOString()));
    const metrics = new ProviderMetricsService();
    const app = express();
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createProviderConfigRoutes(store, manager, { validationService, metrics }));
    ({ server, base: serverBase } = await listen(app));
    const base = `${serverBase}/${workspace.id}`;

    const config = await createConfig(base, 'Cacheable');
    const first = await validate(base, config.id);
    assert.equal(first.status, 200);
    assert.equal(first.json.validation.valid, true);
    assert.notEqual(first.json.validation.fromCache, true);
    assert.equal(validationService.calls, 1);

    // Immediate second validate reuses the short-term cache.
    const second = await validate(base, config.id);
    assert.equal(second.status, 200);
    assert.equal(second.json.validation.fromCache, true);
    assert.equal(validationService.calls, 1, 'cache hit must not re-run adapter validation');

    // forceRefresh bypasses the cache.
    const refreshed = await validate(base, config.id, { forceRefresh: true });
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.json.validation.fromCache, true);
    assert.equal(validationService.calls, 2);

    // A configuration version bump changes the cache key → miss.
    const update = await fetch(`${base}/provider-configs/${config.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: config.version, name: 'Cacheable v2' }),
    });
    assert.equal(update.status, 200);
    const afterUpdate = await validate(base, config.id);
    assert.notEqual(afterUpdate.json.validation.fromCache, true);
    assert.equal(validationService.calls, 3);
  } finally {
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate with TTL=0 disables the validation cache', async (t) => {
  const previousTtl = process.env[TTL_ENV];
  process.env[TTL_ENV] = '0';
  t.after(() => {
    if (previousTtl === undefined) delete process.env[TTL_ENV];
    else process.env[TTL_ENV] = previousTtl;
  });

  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  let server: ReturnType<express.Express['listen']> | undefined;
  let serverBase = '';
  try {
    store = new SqliteStore(root);
    const manager = new WorkspaceManager(store);
    const workspace = await manager.create('Workspace A', join(root, 'a'), { git: false, memory: false, readme: false, docs: false });
    const validationService = new CountingValidationService(() => validResult(new Date().toISOString()));
    const app = express();
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createProviderConfigRoutes(store, manager, { validationService }));
    ({ server, base: serverBase } = await listen(app));
    const base = `${serverBase}/${workspace.id}`;

    const config = await createConfig(base, 'NoCache');
    await validate(base, config.id);
    const second = await validate(base, config.id);
    assert.notEqual(second.json.validation.fromCache, true);
    assert.equal(validationService.calls, 2, 'TTL=0 must disable the validation cache');
  } finally {
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('metrics summary exposes per-provider validation and startup metrics', async (t) => {
  const previousTtl = process.env[TTL_ENV];
  delete process.env[TTL_ENV];
  t.after(() => {
    if (previousTtl === undefined) delete process.env[TTL_ENV];
    else process.env[TTL_ENV] = previousTtl;
  });

  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  let server: ReturnType<express.Express['listen']> | undefined;
  let serverBase = '';
  try {
    store = new SqliteStore(root);
    const manager = new WorkspaceManager(store);
    const workspace = await manager.create('Workspace A', join(root, 'a'), { git: false, memory: false, readme: false, docs: false });
    let call = 0;
    const validationService = new CountingValidationService(() => {
      call += 1;
      // First call fails with an auth failure; subsequent calls succeed.
      return call === 1
        ? {
          valid: false,
          capabilities: {} as ProviderValidationResult['capabilities'],
          outputMode: 'parsed-text',
          authentication: 'unauthenticated',
          warnings: [],
          errors: [{ code: 'PROVIDER_AUTH_REQUIRED', phase: 'validation', message: 'not authenticated', retryable: false }],
          checkedAt: new Date().toISOString(),
        }
        : validResult(new Date().toISOString());
    });
    const metrics = new ProviderMetricsService();
    const app = express();
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createProviderConfigRoutes(store, manager, { validationService, metrics }));
    app.use('/api/workspaces/:workspaceId', createMetricsRoutes(store, manager, { providerMetrics: metrics }));
    ({ server, base: serverBase } = await listen(app));
    const base = `${serverBase}/${workspace.id}`;

    const config = await createConfig(base, 'Measured');
    await validate(base, config.id, { forceRefresh: true }); // auth failure
    await validate(base, config.id, { forceRefresh: true }); // success
    await validate(base, config.id);                          // cache hit (success)

    const summaryResponse = await fetch(`${base}/metrics/summary`);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json() as {
      providers: Array<{
        providerConfigId: string;
        validationCount: number;
        validationSuccessCount: number;
        validationSuccessRate: number | null;
        authFailureCount: number;
        cacheHitCount: number;
        averageValidationLatencyMs: number | null;
        averageStartupLatencyMs: number | null;
      }>;
    };
    const entry = summary.providers.find(provider => provider.providerConfigId === config.id);
    assert.ok(entry, `expected providers entry for ${config.id}: ${JSON.stringify(summary.providers)}`);
    assert.equal(entry.validationCount, 3);
    assert.equal(entry.validationSuccessCount, 2);
    assert.equal(entry.validationSuccessRate, 2 / 3);
    assert.equal(entry.authFailureCount, 1);
    assert.equal(entry.cacheHitCount, 1);
    assert.equal(typeof entry.averageValidationLatencyMs, 'number');
    assert.equal(entry.averageStartupLatencyMs, null, 'no usage_records yet → startup latency null');
  } finally {
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
