import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore.js';
import { RunDecisionService } from './RunDecisionService.js';

function rootDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-run-decision-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'workspace', name: 'Workspace', rootPath: root, gitEnabled: true, memoryEnabled: false, agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }], lastOpenedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }] }), 'utf8');
  return root;
}

test('records a partial write failure idempotently and resolves once', () => {
  const root = rootDir();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const now = new Date().toISOString();
    store.createConversation({ id: 'conversation', workspaceId: 'workspace', type: 'direct', title: 'Conversation', agentId: 'codex', createdAt: now, updatedAt: now });
    store.createMessage({ id: 'message', workspaceId: 'workspace', conversationId: 'conversation', senderType: 'user', content: 'task', createdAt: now });
    const run = store.createRun({ id: 'run', workspaceId: 'workspace', conversationId: 'conversation', sourceMessageId: 'message', objective: 'task', status: 'running', createdAt: now, updatedAt: now });
    const execution = { id: 'execution', runId: run.id, conversationId: 'conversation', workspaceId: 'workspace', sourceMessageId: 'message', agentId: 'codex', status: 'failed' as const, mode: 'mock' as const, createdAt: now, updatedAt: now };
    store.createExecution(execution);
    const service = new RunDecisionService(store);
    const fileChanges = [{ runId: run.id, path: 'src/a.ts', changeType: 'modified' as const }];
    const first = service.recordPartialWriteFailure({ workspaceId: 'workspace', run, execution, fileChanges, writeCapable: true });
    const second = service.recordPartialWriteFailure({ workspaceId: 'workspace', run, execution, fileChanges, writeCapable: true });
    assert.equal(first?.id, second?.id);
    assert.equal(store.getRun('workspace', run.id)?.status, 'waiting_user');
    const resolved = service.resolve('workspace', first!.id, 'keep_and_continue');
    assert.equal(resolved.resolvedDecision, 'keep_and_continue');
    assert.equal(service.resolve('workspace', first!.id, 'keep_and_continue').resolvedDecision, 'keep_and_continue');
    assert.throws(() => service.resolve('workspace', first!.id, 'abort'), /already been resolved/);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
