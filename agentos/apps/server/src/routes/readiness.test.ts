import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { createReadinessRoutes } from './readiness.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { DEFAULT_CAPABILITIES, DEFAULT_TIMEOUT_POLICY } from '../store/ProviderConfigurationRepository.js';
import { MaintenanceDiagnosticsService } from '../services/MaintenanceDiagnosticsService.js';

test('/api/readiness and /api/health/ready share readiness while liveness stays independent', async () => {
  const app = express();
  let readinessCalls = 0;
  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'agentos-server' }));
  app.use('/api', createReadinessRoutes({
    async readiness() {
      readinessCalls += 1;
      return { ok: false, database: { status: 'failed' } };
    },
    async exportSanitized() { return { format: 'agentos-diagnostics', readiness: { ok: false } }; },
  } as any));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolvePromise => {
    const listening = app.listen(0, '127.0.0.1', () => resolvePromise(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const liveness = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    assert.equal(liveness.status, 200);
    assert.equal((await liveness.json() as { ok: boolean }).ok, true);
    for (const path of ['/api/readiness', '/api/health/ready']) {
      const readyResponse: globalThis.Response = await fetch(`http://127.0.0.1:${address.port}${path}`);
      assert.equal(readyResponse.status, 503);
      assert.equal((await readyResponse.json() as { ok: boolean }).ok, false);
    }
    assert.equal(readinessCalls, 2);
    const exported = await fetch(`http://127.0.0.1:${address.port}/api/diagnostics/export`);
    assert.equal(exported.status, 200);
    assert.equal((await exported.json() as { format: string }).format, 'agentos-diagnostics');
  } finally {
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  }
});

test('HTTP readiness and sanitized export report live SQLite state and Provider auth/version/capabilities', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-readiness-http-'));
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  const store = new SqliteStore(root);
  const workspaces = new WorkspaceManager(store);
  const workspace = workspaces.create('Readiness HTTP fixture', workspaceRoot,
    { git: false, memory: false, docs: false, readme: false });
  const now = new Date().toISOString();
  store.providerConfigurationRepository().insert({
    id: 'readiness-provider', workspaceId: workspace.id, name: 'Readiness provider', providerType: 'codex',
    adapterId: 'builtin.codex', runtimeMode: 'cli', workingDirectoryMode: 'workspace',
    capabilities: { ...DEFAULT_CAPABILITIES, structuredEvents: true, cancellation: true },
    timeoutPolicy: { ...DEFAULT_TIMEOUT_POLICY }, approvalMode: 'agentos', outputMode: 'structured',
    enabled: true, version: 1, createdAt: now, updatedAt: now,
  });
  const diagnostics = new MaintenanceDiagnosticsService(store, workspaces, {
    providerValidator: {
      async validate(configuration) {
        return {
          valid: false,
          executableResolved: 'C:\\private\\agent-cli.exe',
          cliVersion: '2.4.1',
          authentication: 'unauthenticated',
          capabilities: { ...configuration.capabilities, structuredEvents: true, cancellation: true },
          outputMode: configuration.outputMode,
          warnings: [],
          errors: [{ code: 'PROVIDER_AUTH_REQUIRED', phase: 'authentication',
            message: 'token=diagnostic-secret-must-not-escape', retryable: false }],
          checkedAt: now,
        };
      },
    },
  });
  const app = express();
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', createReadinessRoutes(diagnostics));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolvePromise => {
    const listening = app.listen(0, '127.0.0.1', () => resolvePromise(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/readiness`);
    assert.equal(response.status, 200, 'Provider auth degradation remains separately visible from database readiness');
    const body = await response.json() as any;
    assert.equal(body.database.integrity, 'ok');
    assert.equal(body.database.foreignKeys, 'ok');
    assert.equal(body.migrations.status, 'current');
    assert.equal(body.providers.entries[0].authentication, 'unauthenticated');
    assert.equal(body.providers.entries[0].cliVersion, '2.4.1');
    assert.equal(body.providers.entries[0].capabilities.structuredEvents, true);
    assert.deepEqual(body.providers.entries[0].errorCodes, ['PROVIDER_AUTH_REQUIRED']);

    const exportedResponse = await fetch(`http://127.0.0.1:${address.port}/api/diagnostics/export`);
    assert.equal(exportedResponse.status, 200);
    const exported = await exportedResponse.text();
    assert.equal(exported.includes('diagnostic-secret-must-not-escape'), false);
    assert.equal(exported.includes('private\\agent-cli.exe'), false);
    assert.equal(exported.includes(root), false);
    assert.equal(exported.includes('unauthenticated'), true);
    assert.equal(exported.includes('PROVIDER_AUTH_REQUIRED'), true);
  } finally {
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    store.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10 });
  }
});
