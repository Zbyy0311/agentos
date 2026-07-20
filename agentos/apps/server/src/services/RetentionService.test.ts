import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryCandidate } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { RetentionService } from './RetentionService.js';

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-retention-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [
    { id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  ] }), 'utf8');
  return root;
}

function candidate(id: string, runId: string, status: MemoryCandidate['status'], reviewedAt?: string): MemoryCandidate {
  return {
    id,
    workspaceId: 'workspace-a',
    runId,
    type: 'decision',
    title: id,
    summary: id,
    content: id,
    confidence: 80,
    operation: 'create',
    conflictingMemoryIds: [],
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(reviewedAt ? { reviewedAt } : {}),
  };
}

test('retains pending candidates and the latest 200 reviewed candidates', () => {
  const root = createRoot();
  const store = new SqliteStore(root);
  try {
    store.createConversation({ id: 'conversation-retention', workspaceId: 'workspace-a', type: 'direct', title: 'Retention', agentId: 'codex', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    store.createMessage({ id: 'message-retention', conversationId: 'conversation-retention', workspaceId: 'workspace-a', senderType: 'user', content: 'source', createdAt: '2026-01-01T00:00:00.000Z' });
    store.createRun({ id: 'run-retention', workspaceId: 'workspace-a', conversationId: 'conversation-retention', sourceMessageId: 'message-retention', objective: 'retention', status: 'completed', resultSummary: 'done', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

    for (let index = 0; index < 201; index += 1) {
      store.createMemoryCandidate(candidate(
        `candidate-${index}`,
        'run-retention',
        index === 0 ? 'rejected' : 'accepted',
        index === 0 ? '2025-01-01T00:00:00.000Z' : `2026-03-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      ));
    }
    store.createMemoryCandidate(candidate('candidate-pending', 'run-retention', 'pending'));

    const result = new RetentionService(store).run(new Date('2026-04-01T00:00:00.000Z'));

    assert.equal(result.reviewedMemoryCandidatesDeleted, 1);
    assert.equal(store.getMemoryCandidate('workspace-a', 'candidate-0'), undefined);
    assert.equal(store.getMemoryCandidate('workspace-a', 'candidate-pending')?.status, 'pending');
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
