import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryCandidateDraft } from './MemoryExtractor.js';
import { MemoryCandidateService } from './MemoryCandidateService.js';
import { MemoryService } from './MemoryService.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { MemoryRetriever } from './MemoryRetriever.js';
import { EventBus } from '../events/EventBus.js';

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-candidate-service-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'workspace-a', name: 'A', rootPath: root, gitEnabled: true, memoryEnabled: true, agents: [], lastOpenedAt: '2026-07-12T00:00:00.000Z', createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z' }] }), 'utf8');
  return root;
}

function seedCompletedRun(store: SqliteStore): void {
  store.createConversation({ id: 'conversation-a', workspaceId: 'workspace-a', type: 'direct', title: 'A', agentId: 'codex', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' });
  store.createMessage({ id: 'message-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', senderType: 'user', content: '记录认证方案', createdAt: '2026-07-12T01:00:01.000Z' });
  store.createRun({ id: 'run-a', workspaceId: 'workspace-a', conversationId: 'conversation-a', sourceMessageId: 'message-a', objective: '记录认证方案', status: 'completed', resultSummary: '已完成', createdAt: '2026-07-12T01:00:01.000Z', updatedAt: '2026-07-12T01:00:02.000Z', completedAt: '2026-07-12T01:00:02.000Z' });
}

test('generates at most three pending candidates, deduplicates retries, and keeps approvals explicit', async () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    seedCompletedRun(store);
    const drafts: MemoryCandidateDraft[] = [
      { type: 'decision', title: '认证方案', summary: '令牌短期有效', content: '认证令牌必须短期有效。', confidence: 90, operation: 'create' },
      { type: 'experience', title: '调试经验', summary: '先看日志', content: '先检查诊断日志。', confidence: 80, operation: 'create' },
      { type: 'convention', title: '提交规范', summary: '保持提交聚焦', content: '每次提交只包含一个主题。', confidence: 70, operation: 'create' },
      { type: 'overview', title: '多余候选', summary: '不应生成', content: '最多三条。', confidence: 60, operation: 'create' },
    ];
    const extractor = { extract: () => ({ drafts, reason: 'public_evidence' as const }) };
    const service = new MemoryCandidateService(store, new MemoryService(store), extractor);
    const first = await service.generate({ workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', memoryEnabled: true });
    assert.equal(first.candidates.length, 3);
    assert.equal(first.outcome, 'created');
    const retry = await service.generate({ workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', memoryEnabled: true });
    assert.equal(retry.candidates.length, 3);
    assert.equal(retry.outcome, 'existing');
    const accepted = await service.accept('workspace-a', root, true, first.candidates[0]!.id, { title: '认证方案（已确认）' });
    assert.equal(accepted.status, 'accepted');
    assert.equal((await new MemoryService(store).get('workspace-a', root, first.candidates[0]!.id)), undefined);
    const memories = new MemoryService(store).list('workspace-a');
    assert.equal(memories.length, 1);
    assert.deepEqual(memories[0]?.sourceRunIds, ['run-a']);
    assert.throws(() => service.reject('workspace-a', first.candidates[0]!.id), /already been reviewed/);
    const rejected = service.reject('workspace-a', first.candidates[1]!.id);
    assert.equal(rejected.status, 'rejected');
    assert.equal(new MemoryService(store).list('workspace-a').length, 1);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('does not generate candidates for a non-completed run', async () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    seedCompletedRun(store);
    store.updateRun('workspace-a', 'run-a', { status: 'failed' });
    const service = new MemoryCandidateService(store);
    await assert.rejects(service.generate({ workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', memoryEnabled: true }), /must be completed/);
    store.updateRun('workspace-a', 'run-a', { status: 'waiting_user' });
    await assert.rejects(service.generate({ workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', memoryEnabled: true }), /must be completed/);
    assert.deepEqual(service.list('workspace-a'), []);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps pending candidates out of retrieval until explicit approval', async () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    seedCompletedRun(store);
    const service = new MemoryCandidateService(store, new MemoryService(store), {
      extract: () => ({ drafts: [{ type: 'decision', title: '令牌决策', summary: '短期令牌', content: '令牌必须短期有效。', confidence: 90, operation: 'create' }], reason: 'public_evidence' as const }),
    });
    const { candidates: generated } = await service.generate({ workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', memoryEnabled: true });
    const [candidate] = generated;
    assert.ok(candidate);
    assert.deepEqual(await new MemoryRetriever(store).search(root, { workspaceId: 'workspace-a', query: '令牌', limit: 5, maxCharacters: 6000 }), []);
    await service.accept('workspace-a', root, true, candidate!.id);
    assert.equal((await new MemoryRetriever(store).search(root, { workspaceId: 'workspace-a', query: '令牌', limit: 5, maxCharacters: 6000 })).length, 1);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps a candidate pending and rejects when event delivery fails', async () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    seedCompletedRun(store);
    const bus = new EventBus();
    bus.subscribe(() => { throw new Error('event persistence unavailable'); });
    const service = new MemoryCandidateService(store, new MemoryService(store), {
      extract: () => ({ drafts: [{ type: 'decision', title: 'event failure', summary: 'event failure', content: 'event failure', confidence: 90, operation: 'create' }], reason: 'public_evidence' as const }),
    }, bus);

    await assert.rejects(
      service.generate({ workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', memoryEnabled: true }),
      /event persistence unavailable/,
    );

    const candidates = service.list('workspace-a');
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.status, 'pending');
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
