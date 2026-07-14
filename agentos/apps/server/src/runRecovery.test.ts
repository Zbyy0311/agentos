import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from './store/SqliteStore.js';
import { recoverInterruptedRuns } from './runRecovery.js';

test('marks only queued and running runs as interrupted after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentos-run-recovery-'));
  let store: SqliteStore | undefined;
  try {
    mkdirSync(join(root, 'workspace'), { recursive: true });
    writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
      id: 'workspace-a', name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [],
      lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z',
    }] }), 'utf8');
    store = new SqliteStore(root);
    store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'Recovery', agentId: 'missing', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
    store.createMessage({ id: 'message-a', conversationId: 'conversation-a', workspaceId: 'workspace-a', senderType: 'user', content: '恢复', createdAt: '2026-07-12T01:00:01.000Z' });
    for (const [id, status] of [['queued-run', 'queued'], ['running-run', 'running'], ['waiting-run', 'waiting_user'], ['done-run', 'completed'], ['failed-run', 'failed'], ['cancelled-run', 'cancelled']] as const) {
      store.createRun({ id, workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: id, status, createdAt: '2026-07-12T01:00:01.000Z', updatedAt: '2026-07-12T01:00:01.000Z' });
    }

    assert.equal(recoverInterruptedRuns(store), 2);
    assert.equal(store.getRun('workspace-a', 'queued-run')?.failureReason, '服务重启导致执行中断');
    assert.equal(store.getRun('workspace-a', 'running-run')?.status, 'failed');
    assert.equal(store.getRun('workspace-a', 'done-run')?.status, 'completed');
    assert.equal(store.getRun('workspace-a', 'failed-run')?.failureReason, undefined);
    assert.equal(store.getRun('workspace-a', 'cancelled-run')?.status, 'cancelled');
    assert.equal(store.getRun('workspace-a', 'waiting-run')?.status, 'waiting_user');
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
