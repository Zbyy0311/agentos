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

const FORBIDDEN_ERROR_PATTERNS = [
  /SQLITE_CONSTRAINT/i,
  /constraint failed/i,
  /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b/i,
  /\.sqlite/i,
  /^\s+at\s/m,
];

function assertSanitizedErrorBody(body: unknown, context: string): void {
  const serialized = JSON.stringify(body);
  for (const pattern of FORBIDDEN_ERROR_PATTERNS) {
    assert.ok(!pattern.test(serialized), `${context}: error response leaked forbidden detail matching ${pattern}: ${serialized}`);
  }
}

test('provider POST validates enums, duplicate names, and forbidden secret fields', async () => {
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
    const post = (base: string, body: Record<string, unknown>) => fetch(`${base}/provider-configs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    // 1-5. Invalid enum values -> 400 VALIDATION_ERROR
    const invalidEnumCases: Array<Record<string, unknown>> = [
      { name: 'Bad Type', providerType: 'not-a-provider' },
      { name: 'Bad Runtime', runtimeMode: 'quantum' },
      { name: 'Bad Workdir', workingDirectoryMode: 'anywhere' },
      { name: 'Bad Approval', approvalMode: 'yolo' },
      { name: 'Bad Output', outputMode: 'telepathy' },
    ];
    for (const body of invalidEnumCases) {
      const response = await post(baseA, body);
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const parsed = await response.json() as { code?: string };
      assert.equal(parsed.code, 'VALIDATION_ERROR');
      assertSanitizedErrorBody(parsed, `POST ${JSON.stringify(body)}`);
    }

    // Non-string enum value -> 400
    const nonStringEnum = await post(baseA, { name: 'Numeric Runtime', runtimeMode: 42 });
    assert.equal(nonStringEnum.status, 400);
    assert.equal((await nonStringEnum.json() as { code?: string }).code, 'VALIDATION_ERROR');

    // 6. Duplicate name in same workspace -> 409 PROVIDER_CONFIG_NAME_CONFLICT
    const first = await post(baseA, { name: 'Duplicate Name' });
    assert.equal(first.status, 201);
    const duplicate = await post(baseA, { name: 'Duplicate Name' });
    assert.equal(duplicate.status, 409);
    const duplicateBody = await duplicate.json() as { code?: string };
    assert.equal(duplicateBody.code, 'PROVIDER_CONFIG_NAME_CONFLICT');
    assertSanitizedErrorBody(duplicateBody, 'POST duplicate name');

    // 7. Same name in a different workspace -> allowed
    const otherWorkspace = await post(baseB, { name: 'Duplicate Name' });
    assert.equal(otherWorkspace.status, 201);

    // 8-12. Forbidden secret value fields -> 400 SECRET_VALUE_NOT_ALLOWED
    for (const field of ['apiKey', 'password', 'token', 'secretValue', 'credentialValue']) {
      const response = await post(baseA, { name: `Secret ${field}`, [field]: 'should-be-rejected' });
      assert.equal(response.status, 400, `expected 400 for secret field ${field}`);
      const parsed = await response.json() as { code?: string; error?: string };
      assert.equal(parsed.code, 'SECRET_VALUE_NOT_ALLOWED');
      assert.equal(parsed.error, 'Raw secret values are not accepted; use secretProfileId');
      assertSanitizedErrorBody(parsed, `POST secret field ${field}`);
    }

    // secretProfileId (a reference, not a raw value) remains allowed
    const withProfileRef = await post(baseA, { name: 'With Secret Profile', secretProfileId: 'secret-profile-1' });
    assert.equal(withProfileRef.status, 201);
  } finally {
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider PUT validates enums, rename conflicts, secret fields, and preserves version/isolation semantics', async () => {
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
    const post = (base: string, body: Record<string, unknown>) => fetch(`${base}/provider-configs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const put = (base: string, id: string, body: Record<string, unknown>) => fetch(`${base}/provider-configs/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    const firstResponse = await post(baseA, { name: 'First Config' });
    assert.equal(firstResponse.status, 201);
    const first = (await firstResponse.json() as { providerConfig: { id: string; version: number } }).providerConfig;
    const secondResponse = await post(baseA, { name: 'Second Config' });
    assert.equal(secondResponse.status, 201);
    const second = (await secondResponse.json() as { providerConfig: { id: string; version: number } }).providerConfig;

    // 1-5. Invalid enum values -> 400 VALIDATION_ERROR
    const invalidEnumCases: Array<Record<string, unknown>> = [
      { providerType: 'not-a-provider' },
      { runtimeMode: 'quantum' },
      { workingDirectoryMode: 'anywhere' },
      { approvalMode: 'yolo' },
      { outputMode: 'telepathy' },
    ];
    for (const patch of invalidEnumCases) {
      const response = await put(baseA, first.id, { ...patch, expectedVersion: first.version });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(patch)}`);
      const parsed = await response.json() as { code?: string };
      assert.equal(parsed.code, 'VALIDATION_ERROR');
      assertSanitizedErrorBody(parsed, `PUT ${JSON.stringify(patch)}`);
    }

    // 6. Rename to an existing name in the same workspace -> 409 PROVIDER_CONFIG_NAME_CONFLICT
    const renameConflict = await put(baseA, first.id, { name: 'Second Config', expectedVersion: first.version });
    assert.equal(renameConflict.status, 409);
    const renameBody = await renameConflict.json() as { code?: string };
    assert.equal(renameBody.code, 'PROVIDER_CONFIG_NAME_CONFLICT');
    assertSanitizedErrorBody(renameBody, 'PUT rename conflict');

    // Renaming to the provider's own current name is allowed
    const selfRename = await put(baseA, first.id, { name: 'First Config', expectedVersion: first.version });
    assert.equal(selfRename.status, 200);
    const afterSelfRename = (await selfRename.json() as { providerConfig: { version: number } }).providerConfig;

    // 7. Forbidden secret value field -> 400 SECRET_VALUE_NOT_ALLOWED
    const secretResponse = await put(baseA, first.id, { credentialValue: 'nope', expectedVersion: afterSelfRename.version });
    assert.equal(secretResponse.status, 400);
    const secretBody = await secretResponse.json() as { code?: string; error?: string };
    assert.equal(secretBody.code, 'SECRET_VALUE_NOT_ALLOWED');
    assert.equal(secretBody.error, 'Raw secret values are not accepted; use secretProfileId');
    assertSanitizedErrorBody(secretBody, 'PUT secret field');

    // 8. expectedVersion semantics preserved: missing -> 400, stale -> 409
    const missingVersion = await put(baseA, first.id, { name: 'No Version' });
    assert.equal(missingVersion.status, 400);
    assert.equal((await missingVersion.json() as { code?: string }).code, 'VALIDATION_ERROR');
    const staleVersion = await put(baseA, first.id, { name: 'Stale', expectedVersion: 0 });
    assert.equal(staleVersion.status, 409);
    assert.equal((await staleVersion.json() as { code?: string }).code, 'VERSION_CONFLICT');

    // 9. Cross-workspace access still -> 404
    const crossWorkspace = await put(baseB, first.id, { name: 'Cross', expectedVersion: afterSelfRename.version });
    assert.equal(crossWorkspace.status, 404);
    assert.equal((await crossWorkspace.json() as { code?: string }).code, 'PROVIDER_CONFIG_NOT_FOUND');

    // Same name in a different workspace is not a conflict
    const otherWorkspaceResponse = await post(baseB, { name: 'Other WS Config' });
    const otherWorkspace = (await otherWorkspaceResponse.json() as { providerConfig: { id: string; version: number } }).providerConfig;
    const renameInOtherWorkspace = await put(baseB, otherWorkspace.id, { name: 'First Config', expectedVersion: otherWorkspace.version });
    assert.equal(renameInOtherWorkspace.status, 200);
  } finally {
    server?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
