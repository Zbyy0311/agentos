import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { RuntimeArtifactService } from './RuntimeArtifactService.js';

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-artifact-service-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
    agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
    lastOpenedAt: '2026-07-17T00:00:00.000Z', createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
  }] }), 'utf8');
  const store = new SqliteStore(root);
  const now = '2026-07-17T00:00:00.000Z';
  store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Artifacts', agentId: 'codex', createdAt: now, updatedAt: now });
  store.createMessage({ id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user', content: 'artifact test', createdAt: now });
  store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: 'artifact test', status: 'running', createdAt: now, updatedAt: now });
  store.createExecution({ id: 'execution-a', runId: 'run-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', sourceMessageId: 'message-a', agentId: 'codex', status: 'running_cli', mode: 'real', createdAt: now, updatedAt: now });
  return { root, store, service: new RuntimeArtifactService(store, root) };
}

test('creates an immutable file Artifact snapshot with provenance and hash', async () => {
  const fixture = createFixture();
  const source = join(fixture.root, 'executor.ts');
  writeFileSync(source, 'before', 'utf8');
  try {
    const artifact = await fixture.service.create({
      workspaceId: 'workspace-a', workspaceRoot: fixture.root, runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex',
      type: 'file', title: 'executor.ts', originalPath: 'executor.ts', source: { kind: 'workspace-file', absolutePath: source },
    });
    assert.equal(artifact.contentAvailable, true);
    assert.equal(artifact.originalPath, 'executor.ts');
    assert.equal(artifact.sizeBytes, 6);
    assert.ok(artifact.sha256);
    assert.equal(fixture.store.listRuntimeArtifacts('workspace-a', 'run-a').length, 1);
    writeFileSync(source, 'after', 'utf8');
    const managedPath = join(fixture.root, '.agentos', 'artifacts', 'workspace-a', 'run-a', artifact.id, 'content');
    assert.equal(readFileSync(managedPath, 'utf8'), 'before');
    assert.equal(existsSync(managedPath), true);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects path traversal and produces metadata-only artifacts over the limit', async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(fixture.service.create({
      workspaceId: 'workspace-a', workspaceRoot: fixture.root, runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex',
      type: 'file', title: 'escape', originalPath: '../escape', source: { kind: 'text', content: 'unsafe' },
    }), /workspace path/);
    const artifact = await fixture.service.create({
      workspaceId: 'workspace-a', workspaceRoot: fixture.root, runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex',
      type: 'file', title: 'large', source: { kind: 'text', content: 'x'.repeat(2 * 1024 * 1024 + 1) },
    });
    assert.equal(artifact.contentAvailable, false);
    assert.match(artifact.summary ?? '', /limit/i);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects an image artifact without a supported raster signature', async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(fixture.service.create({
      workspaceId: 'workspace-a', workspaceRoot: fixture.root, runId: 'run-a', sourceExecutionId: 'execution-a', agentId: 'codex',
      type: 'image', title: 'fake.png', source: { kind: 'text', content: 'not a png' },
    }), /Unsupported image artifact format/);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
