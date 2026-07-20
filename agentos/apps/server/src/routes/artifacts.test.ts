import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { RuntimeArtifactService } from '../services/RuntimeArtifactService.js';
import { createArtifactRoutes } from './artifacts.js';

test('serves owned artifact content and rejects metadata-only artifacts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-artifact-route-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    { id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' },
  ] }), 'utf8');
  const store = new SqliteStore(root);
  const service = new RuntimeArtifactService(store, root);
  const manager = new WorkspaceManager(store);
  const app = express();
  app.use('/api/workspaces/:workspaceId', createArtifactRoutes(store, manager, service));
  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const instance = app.listen(0, () => resolve(instance));
  });
  try {
    const now = '2026-07-12T01:00:00.000Z';
    store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Artifacts', agentId: 'codex', createdAt: now, updatedAt: now });
    store.createMessage({ id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user', content: 'artifact', createdAt: now });
    store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: 'artifact', status: 'running', createdAt: now, updatedAt: now });
    store.createExecution({ id: 'execution-a', runId: 'run-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-a', agentId: 'codex', status: 'running_cli', mode: 'mock', createdAt: now, updatedAt: now });
    const contentArtifact = await service.create({ workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex', type: 'report', title: 'report.txt', source: { kind: 'text', content: '1 passed' } });
    const metadataArtifact = await service.create({ workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex', type: 'report', title: 'large-report.txt', source: { kind: 'text', content: 'x'.repeat(1024 * 1024 + 1) } });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a/artifacts`;
    const content = await fetch(`${base}/${contentArtifact.id}/content`);
    assert.equal(content.status, 200);
    assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
    assert.match(content.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.equal(await content.text(), '1 passed');
    assert.equal((await fetch(`${base}/${metadataArtifact.id}/content`)).status, 409);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/workspaces/workspace-b/artifacts/${contentArtifact.id}/content`)).status, 404);
  } finally {
    server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
