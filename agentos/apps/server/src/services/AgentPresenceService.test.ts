import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '../store/SqliteStore.js';
import { AgentPresenceService } from './AgentPresenceService.js';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-presence-'));
  const store = new SqliteStore(root);
  const now = '2026-07-18T00:00:00.000Z';
  store.saveWorkspaces([{ id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, lastOpenedAt: now, createdAt: now, updatedAt: now, agents: [
    { id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] },
    { id: 'disabled', name: 'Disabled', role: 'kimi', enabled: false, cliCommand: 'kimi', cliArgs: [] },
  ] }]);
  store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'A', agentId: 'codex', createdAt: now, updatedAt: now });
  store.createMessage({ id: 'message-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', senderType: 'user', content: 'run', createdAt: now });
  return { root, store, now };
}

test('disabled overrides active and recent failed executions', () => {
  const { root, store, now } = setup();
  try {
    const run = store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: 'run', status: 'running', createdAt: now, updatedAt: now });
    store.createExecution({ id: 'execution-running', runId: run.id, workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', agentId: 'codex', status: 'running_cli', mode: 'mock', createdAt: now, updatedAt: now });
    const failedRun = store.createRun({ id: 'run-failed', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: 'failed', status: 'failed', createdAt: now, updatedAt: now });
    store.createExecution({ id: 'execution-failed', runId: failedRun.id, workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', agentId: 'disabled', status: 'failed', mode: 'mock', completedAt: now, createdAt: now, updatedAt: now });
    const result = new AgentPresenceService(store).resolve('workspace-a', new Date('2026-07-18T00:00:10.000Z'));
    assert.equal(result.find(item => item.agentId === 'disabled')?.state, 'disabled');
    assert.equal(result.find(item => item.agentId === 'codex')?.state, 'working');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('recent failed presence decays to idle after thirty seconds', () => {
  const { root, store, now } = setup();
  try {
    const run = store.createRun({ id: 'run-failed', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: 'failed', status: 'failed', createdAt: now, updatedAt: now });
    store.createExecution({ id: 'execution-failed', runId: run.id, workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', agentId: 'codex', status: 'failed', mode: 'mock', completedAt: now, createdAt: now, updatedAt: now });
    assert.equal(new AgentPresenceService(store).resolve('workspace-a', new Date('2026-07-18T00:00:31.000Z')).find(item => item.agentId === 'codex')?.state, 'idle');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
