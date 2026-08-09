import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cors from 'cors';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from './store/SqliteStore.js';
import { WorkspaceManager } from './managers/WorkspaceManager.js';
import { PreferenceService } from './services/PreferenceService.js';
import type { ModelDiscoveryService } from './services/CliModelDiscovery.js';
import { createWorkspaceRoutes } from './routes/workspaces.js';
import { createConversationRoutes } from './routes/conversations.js';
import { createPreferenceRoutes } from './routes/preferences.js';
import { createLocalCorsOptions, createLocalWriteGuard, resolveLocalApiSecurityConfig } from './localApiSecurity.js';
import { createRequestIdMiddleware } from './problemDetails.js';

/**
 * M3 P4A MEDIUM-1: the local write guard rejection is an ApiProblem. The
 * stable code `origin_not_allowed` is preserved verbatim; the requestId in
 * the body matches the X-Request-ID response header, and neither the
 * rejected Origin nor the remote address is reflected.
 */
async function assertOriginDeniedProblem(response: globalThis.Response): Promise<void> {
  assert.equal(response.status, 403);
  const contentType = response.headers.get('content-type') ?? '';
  assert.ok(contentType.startsWith('application/problem+json'), `expected application/problem+json, got ${contentType}`);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.status, 403);
  assert.equal(body.code, 'origin_not_allowed');
  assert.equal(body.retryable, false);
  assert.equal(typeof body.type, 'string');
  assert.equal(typeof body.title, 'string');
  assert.equal(typeof body.detail, 'string');
  assert.equal(typeof body.instance, 'string');
  assert.equal(typeof body.requestId, 'string');
  const requestId = response.headers.get('x-request-id');
  assert.ok(requestId && requestId.length > 0, 'X-Request-ID header must exist on the security rejection');
  assert.equal(body.requestId, requestId);
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes('evil.example'), 'rejected Origin must not be reflected');
}

async function startTestServer() {
  const app = express();
  const config = resolveLocalApiSecurityConfig({});
  let writeCalls = 0;
  app.use(createRequestIdMiddleware());
  app.use(cors(createLocalCorsOptions(config)));
  app.use(createLocalWriteGuard(config));
  app.use(express.json());
  app.all('/api/write', (req, res) => {
    writeCalls += 1;
    res.json({ method: req.method, writeCalls });
  });
  app.get('/api/read', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, getWriteCalls: () => writeCalls };
}

test('allowed Origin can write while evil Origin is rejected before the route handler', async () => {
  const { server, baseUrl, getWriteCalls } = await startTestServer();
  try {
    const allowed = await fetch(`${baseUrl}/api/write`, { method: 'POST', headers: { Origin: 'http://localhost:3001', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3001');

    const evil = await fetch(`${baseUrl}/api/write`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    await assertOriginDeniedProblem(evil);
    assert.equal(getWriteCalls(), 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('loopback CLI requests without Origin can write, while non-loopback requests cannot', async () => {
  const { server, baseUrl, getWriteCalls } = await startTestServer();
  try {
    const cli = await fetch(`${baseUrl}/api/write`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(cli.status, 200);

    const evil = await fetch(`${baseUrl}/api/write`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 403);
    const blockedPut = await fetch(`${baseUrl}/api/write`, { method: 'PUT', headers: { Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(blockedPut.status, 403);
    assert.equal(getWriteCalls(), 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('reads remain available but unknown Origins receive no CORS header', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const read = await fetch(`${baseUrl}/api/read`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(read.status, 200);
    assert.equal(read.headers.has('access-control-allow-origin'), false);
    const head = await fetch(`${baseUrl}/api/read`, { method: 'HEAD', headers: { Origin: 'https://evil.example' } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.has('access-control-allow-origin'), false);

    const preflight = await fetch(`${baseUrl}/api/write`, { method: 'OPTIONS', headers: {
      Origin: 'http://localhost:3001',
      'Access-Control-Request-Method': 'POST',
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:3001');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('protects the existing workspace, agent, conversation, and preference write routes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-local-api-security-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: false, memoryEnabled: true,
    agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
    lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
  }] }), 'utf8');
  const store = new SqliteStore(root);
  const manager = new WorkspaceManager(store);
  const preferenceService = new PreferenceService(store);
  const discovery: ModelDiscoveryService = {
    async discover() {
      return { cliKind: 'codex', models: [], source: 'fallback', stale: false, discoveredAt: new Date().toISOString() };
    },
  };
  const app = express();
  const config = resolveLocalApiSecurityConfig({});
  app.use(createRequestIdMiddleware());
  app.use(cors(createLocalCorsOptions(config)));
  app.use(createLocalWriteGuard(config));
  app.use(express.json({ limit: '50mb' }));
  app.use('/api/workspaces', createWorkspaceRoutes(manager));
  app.use('/api/workspaces/:workspaceId', createConversationRoutes(store, manager, discovery, undefined, undefined, preferenceService));
  app.use('/api/workspaces/:workspaceId', createPreferenceRoutes(store, manager, preferenceService));
  const originalForceMock = process.env.AGENTOS_FORCE_MOCK;
  process.env.AGENTOS_FORCE_MOCK = 'true';
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
    const base = `http://127.0.0.1:${address.port}`;
    const jsonHeaders = { Origin: 'http://localhost:3001', 'Content-Type': 'application/json' };
    const evilHeaders = { Origin: 'https://evil.example', 'Content-Type': 'application/json' };

    const createPayload = { name: 'New Workspace', rootPath: join(root, 'created-workspace'), git: false, memory: false, docs: false, readme: false };
    const blockedWorkspace = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: evilHeaders, body: JSON.stringify(createPayload) });
    await assertOriginDeniedProblem(blockedWorkspace);
    assert.equal(manager.list().length, 1);

    const createdWorkspace = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(createPayload) });
    assert.equal(createdWorkspace.status, 201);
    const createdWorkspaceBody = await createdWorkspace.json() as { workspace: { id: string } };
    const deletedWorkspace = await fetch(`${base}/api/workspaces/${createdWorkspaceBody.workspace.id}`, { method: 'DELETE', headers: { Origin: 'http://localhost:3001' } });
    assert.equal(deletedWorkspace.status, 200);

    const agentUpdate = { roleTitle: '架构负责人', systemPrompt: '先分析再执行。', permissions: ['read'], enabled: true, thinkingEffort: 'auto' };
    const blockedAgent = await fetch(`${base}/api/workspaces/workspace-a/agents/codex`, { method: 'PATCH', headers: evilHeaders, body: JSON.stringify(agentUpdate) });
    assert.equal(blockedAgent.status, 403);
    const allowedAgent = await fetch(`${base}/api/workspaces/workspace-a/agents/codex`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(agentUpdate) });
    assert.equal(allowedAgent.status, 200);

    const conversation = await fetch(`${base}/api/workspaces/workspace-a/conversations`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ agentId: 'codex' }) }).then(response => response.json()) as { conversation: { id: string } };
    const blockedMessage = await fetch(`${base}/api/workspaces/workspace-a/conversations/${conversation.conversation.id}/messages/stream`, { method: 'POST', headers: evilHeaders, body: JSON.stringify({ content: '不应执行' }) });
    assert.equal(blockedMessage.status, 403);
    const allowedMessage = await fetch(`${base}/api/workspaces/workspace-a/conversations/${conversation.conversation.id}/messages/stream`, { method: 'POST', headers: { ...jsonHeaders, Accept: 'text/event-stream' }, body: JSON.stringify({ content: '执行检查' }) });
    assert.equal(allowedMessage.status, 200);
    await allowedMessage.text();

    const blockedPreference = await fetch(`${base}/api/workspaces/workspace-a/preferences/learning`, { method: 'POST', headers: evilHeaders, body: JSON.stringify({ enabled: false }) });
    assert.equal(blockedPreference.status, 403);
    const allowedPreference = await fetch(`${base}/api/workspaces/workspace-a/preferences/learning`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ enabled: false }) });
    assert.equal(allowedPreference.status, 200);
  } finally {
    if (originalForceMock === undefined) delete process.env.AGENTOS_FORCE_MOCK;
    else process.env.AGENTOS_FORCE_MOCK = originalForceMock;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
