import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderConfigRoutes } from './providerConfigs.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-provider-routes-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [] }), 'utf8');
  return root;
}

async function listen(app: express.Express): Promise<{ server: ReturnType<typeof app.listen>; base: string }> {
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');
  return { server, base: `http://127.0.0.1:${address.port}/api/workspaces` };
}

test('provider routes enforce workspace isolation, versioned updates, and versioned archive', async () => {
  const root = createProjectRoot();
  let store: SqliteStore | undefined;
  let server: ReturnType<express.Express['listen']> | undefined;
  let serverBase = '';
  try {
    store = new SqliteStore(root);
    const manager = new WorkspaceManager(store);
    const workspaceA = manager.create('Workspace A', join(root, 'a'), { git: false, memory: false, readme: false, docs: false });
    const workspaceB = manager.create('Workspace B', join(root, 'b'), { git: false, memory: false, readme: false, docs: false });
    const app = express();
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createProviderConfigRoutes(store, manager));
    ({ server, base: serverBase } = await listen(app));

    const baseA = `${serverBase}/${workspaceA.id}`;
    const baseB = `${serverBase}/${workspaceB.id}`;
    const configsA = await fetch(`${baseA}/provider-configs`).then(response => response.json()) as {
      providerConfigs: Array<{ id: string; version: number }>;
    };
    const active = configsA.providerConfigs[0]!;

    for (const method of ['GET', 'DELETE', 'PUT'] as const) {
      const response = await fetch(`${baseB}/provider-configs/${active.id}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'PUT' ? JSON.stringify({ expectedVersion: active.version, name: 'cross-workspace' }) : undefined,
      });
      assert.equal(response.status, 404, `${method} must reject a Provider from another Workspace`);
    }

    const missingVersion = await fetch(`${baseA}/provider-configs/${active.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'missing-version' }),
    });
    assert.equal(missingVersion.status, 400);

    const staleVersion = await fetch(`${baseA}/provider-configs/${active.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 0, name: 'stale-version' }),
    });
    assert.equal(staleVersion.status, 409);

    const unreferencedResponse = await fetch(`${baseA}/provider-configs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unreferenced' }),
    });
    assert.equal(unreferencedResponse.status, 201);
    const unreferenced = (await unreferencedResponse.json() as { providerConfig: { id: string; version: number } }).providerConfig;

    const archiveWithoutVersion = await fetch(`${baseA}/provider-configs/${unreferenced.id}`, { method: 'DELETE' });
    assert.equal(archiveWithoutVersion.status, 400);

    const archiveInUse = await fetch(`${baseA}/provider-configs/${active.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: active.version }),
    });
    assert.equal(archiveInUse.status, 409);
    assert.equal((await archiveInUse.json() as { code: string }).code, 'PROVIDER_CONFIG_IN_USE');
  } finally {
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
