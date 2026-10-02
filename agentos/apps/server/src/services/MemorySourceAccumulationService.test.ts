import assert from 'node:assert/strict';
import test from 'node:test';
import { hashMemoryText, normalizeMemoryText } from './MemoryCandidateGenerationService.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { MemoryCandidateDraft } from './MemoryExtractor.js';
import { MemorySourceAccumulationService } from './MemorySourceAccumulationService.js';
import { MemoryWorkspaceKnowledgePromotionError, MemoryWorkspaceKnowledgePromotionService } from './MemoryWorkspaceKnowledgePromotionService.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { BoundedGroupService } from './BoundedGroupService.js';
import { ConversationStreamService } from './ConversationStreamService.js';
import { createMemoryCandidateRoutes } from '../routes/memoryCandidates.js';
import { createMemoryRuntimeRoutes } from '../routes/memoryRuntime.js';

const WS = 'workspace-memory-accumulation';
const NOW = '2026-10-02T00:00:00.000Z';

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-memory-accumulation-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({ workspaces: [{
    id: WS, name: 'Memory accumulation', rootPath: root, gitEnabled: true, memoryEnabled: true,
    agents: [{ id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] }],
    lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW,
  }] }), 'utf8');
  return root;
}

function drafts(count = 1): MemoryCandidateDraft[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'decision', title: `Decision ${index + 1}`, summary: 'A reviewed decision.',
    content: `Keep the durable decision ${index + 1}.`, confidence: 90, operation: 'create',
  }));
}

function addDirectTurn(store: SqliteStore, suffix: string, prompt: string, answer: string) {
  const conversations = store.conversationRepository();
  const id = 'conversation-direct';
  if (!conversations.findConversationById(WS, id)) {
    conversations.createConversation({ id, workspaceId: WS, kind: 'direct', title: 'Direct', createdAt: NOW });
  }
  const sourceMessageId = `message-source-${suffix}`;
  conversations.appendMessage({
    id: sourceMessageId, workspaceId: WS, conversationId: id,
    senderType: 'user', kind: 'text', status: 'final', content: prompt, createdAt: NOW,
  });
  const turns = store.agentTurnRepository();
  const stream = new ConversationStreamService(store.getDatabase(), conversations, turns);
  const responseMessageId = `message-reply-${suffix}`;
  const reservation = stream.beginAgentTurnStream({
    workspaceId: WS, conversationId: id, turnId: `turn-${suffix}`, messageId: responseMessageId,
    agentId: 'codex', sourceMessageId, createdAt: NOW,
  });
  stream.finalizeStream({
    workspaceId: WS, turnId: reservation.turn.id, messageId: responseMessageId,
    expectedTurnVersion: reservation.turn.version, expectedMessageVersion: reservation.message.version,
    outcome: 'final', content: answer, updatedAt: NOW,
  });
  return { conversationId: id, sourceMessageId, responseMessageId, turnId: reservation.turn.id };
}

function addGroupInteraction(store: SqliteStore, suffix: string, prompt: string, answer: string) {
  const conversations = store.conversationRepository();
  const conversationId = 'conversation-group';
  if (!conversations.findConversationById(WS, conversationId)) {
    conversations.createConversation({ id: conversationId, workspaceId: WS, kind: 'group', title: 'Group', createdAt: NOW });
  }
  const sourceMessageId = `group-source-${suffix}`;
  conversations.appendMessage({
    id: sourceMessageId, workspaceId: WS, conversationId,
    senderType: 'user', kind: 'text', status: 'final', content: prompt, createdAt: NOW,
  });
  const bounded = new BoundedGroupService(
    store.getDatabase(), store.groupInteractionRepository(), new TurnContextSnapshotRepository(store.getDatabase()),
  );
  const interaction = bounded.createInteraction({
    workspaceId: WS, conversationId, sourceMessageId, createdAt: NOW,
    budget: { maxAgentsPerTurn: 2, maxRepliesPerAgent: 2, maxTotalReplies: 4, maxAgentHops: 2 },
  });
  const owner = bounded.claimExecution({
    workspaceId: WS, conversationId, interactionId: interaction.id, sourceMessageId,
    participantAgentIds: ['codex'], ownerId: `group-owner-${suffix}`, createdAt: NOW,
  });
  const turnId = `group-turn-${suffix}`;
  const messageId = `group-reply-${suffix}`;
  bounded.setExecutionCurrentTurn({
    workspaceId: WS, interactionId: interaction.id, ownerId: owner.ownerId,
    ownerEpoch: owner.ownerEpoch, agentId: 'codex', turnId, messageId, updatedAt: NOW,
  });
  const turns = store.agentTurnRepository();
  const stream = new ConversationStreamService(store.getDatabase(), conversations, turns);
  const reservation = stream.beginAgentTurnStream({
    workspaceId: WS, conversationId, turnId, messageId, agentId: 'codex', sourceMessageId, createdAt: NOW,
  });
  stream.finalizeStream({
    workspaceId: WS, turnId, messageId,
    expectedTurnVersion: reservation.turn.version, expectedMessageVersion: reservation.message.version,
    outcome: 'final', content: answer, updatedAt: NOW,
  });
  bounded.recordReply({
    workspaceId: WS, interactionId: interaction.id, agentId: 'codex', messageId, turnId,
    ownerId: owner.ownerId, ownerEpoch: owner.ownerEpoch, content: answer, createdAt: NOW,
  });
  const current = store.groupInteractionRepository().findInteractionById(WS, interaction.id)!;
  bounded.completeExecution({
    workspaceId: WS, interactionId: interaction.id, ownerId: owner.ownerId,
    ownerEpoch: owner.ownerEpoch, completedAt: NOW,
  });
  return { conversationId, interactionId: interaction.id, sourceMessageId, responseMessageId: messageId, turnId, version: current.version };
}

function addLegacyRun(store: SqliteStore, runId: string, sourceMessageId: string, replyMessageId: string, objective: string, reply: string): void {
  if (!store.listConversations(WS).some(conversation => conversation.id === 'legacy-conversation')) {
    store.createConversation({
      id: 'legacy-conversation', workspaceId: WS, type: 'direct', title: 'Legacy', agentId: 'codex',
      createdAt: NOW, updatedAt: NOW,
    });
  }
  store.createMessage({
    id: sourceMessageId, workspaceId: WS, conversationId: 'legacy-conversation', senderType: 'user',
    content: objective, createdAt: NOW,
  });
  store.createRun({
    id: runId, workspaceId: WS, conversationId: 'legacy-conversation', sourceMessageId,
    objective, status: 'completed', resultSummary: reply, createdAt: NOW, updatedAt: NOW, completedAt: NOW,
  });
  store.createMessage({
    id: replyMessageId, workspaceId: WS, conversationId: 'legacy-conversation', senderType: 'agent',
    runId, content: reply, createdAt: NOW,
  });
}

test('direct accumulation binds two consecutive Turns to only their concrete source and reply Messages', () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const firstTurn = addDirectTurn(store, 'one', '采用短期凭证方案。', '决定使用短期凭证。');
    const secondTurn = addDirectTurn(store, 'two', '统一发布校验规则。', '必须校验发布端口。');
    const observed: string[][] = [];
    const service = new MemorySourceAccumulationService(store, {
      extractor: { extract: input => {
        observed.push([...input.visibleReplies]);
        return { drafts: drafts(4), reason: 'public_evidence' };
      } },
    });

    const first = service.generateForDirectTurn({ workspaceId: WS, ...firstTurn, createdAt: NOW });
    const second = service.generateForDirectTurn({ workspaceId: WS, ...secondTurn, createdAt: NOW });

    assert.deepEqual(observed, [['决定使用短期凭证。'], ['必须校验发布端口。']]);
    assert.equal(first.candidates.length, 3, 'the extractor result is bounded to three candidates');
    assert.equal(second.candidates.length, 3);
    assert.equal(first.candidates[0]?.outcome, 'review-required', 'agent-derived evidence stays in review');
    assert.ok(first.candidates.every(candidate => candidate.sources.some(source => source.id === firstTurn.responseMessageId)));
    assert.ok(first.candidates.every(candidate => !candidate.sources.some(source => source.id === secondTurn.responseMessageId)));
    assert.ok(second.candidates.every(candidate => candidate.sources.some(source => source.id === secondTurn.responseMessageId)));
    assert.ok(second.candidates.every(candidate => !candidate.sources.some(source => source.id === firstTurn.responseMessageId)));
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy accumulation selects replies by exact Run ID even when adjacent Runs share timestamps', () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    addLegacyRun(store, 'legacy-run-one', 'legacy-source-one', 'legacy-reply-one', '采用第一套认证方案。', '第一任务决定采用密钥轮换。');
    addLegacyRun(store, 'legacy-run-two', 'legacy-source-two', 'legacy-reply-two', '采用第二套发布方案。', '第二任务必须验证签名。');
    const observed: string[][] = [];
    const service = new MemorySourceAccumulationService(store, {
      extractor: { extract: input => {
        observed.push([...input.visibleReplies]);
        return { drafts: drafts(), reason: 'public_evidence' };
      } },
    });

    const first = service.generateForLegacyRun({ workspaceId: WS, runId: 'legacy-run-one', createdAt: NOW });
    const second = service.generateForLegacyRun({ workspaceId: WS, runId: 'legacy-run-two', createdAt: NOW });

    assert.deepEqual(observed, [['第一任务决定采用密钥轮换。'], ['第二任务必须验证签名。']]);
    assert.deepEqual(first.candidates[0]?.sources.filter(source => source.kind === 'run'), [{ kind: 'run', id: 'legacy-run-one' }]);
    assert.deepEqual(second.candidates[0]?.sources.filter(source => source.kind === 'run'), [{ kind: 'run', id: 'legacy-run-two' }]);
    assert.ok(first.candidates[0]?.sources.every(source => source.id !== 'legacy-reply-two'));
    assert.ok(second.candidates[0]?.sources.every(source => source.id !== 'legacy-reply-one'));
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('group accumulation follows each terminal interaction and only its validated reply Messages', () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const firstGroup = addGroupInteraction(store, 'one', '采用第一条协作方案。', '决定先由负责人验证。');
    const secondGroup = addGroupInteraction(store, 'two', '统一第二条协作规范。', '必须保留每个 Agent 的来源。');
    const observed: string[][] = [];
    const service = new MemorySourceAccumulationService(store, {
      extractor: { extract: input => {
        observed.push([...input.visibleReplies]);
        return { drafts: drafts(), reason: 'public_evidence' };
      } },
    });

    const first = service.generateForGroupInteraction({ workspaceId: WS, ...firstGroup, createdAt: NOW });
    const second = service.generateForGroupInteraction({ workspaceId: WS, ...secondGroup, createdAt: NOW });

    assert.deepEqual(observed, [['决定先由负责人验证。'], ['必须保留每个 Agent 的来源。']]);
    assert.ok(first.candidates[0]?.sources.some(source => source.id === firstGroup.sourceMessageId));
    assert.ok(first.candidates[0]?.sources.some(source => source.id === firstGroup.responseMessageId));
    assert.ok(first.candidates[0]?.sources.every(source => source.id !== secondGroup.responseMessageId));
    assert.ok(second.candidates[0]?.sources.some(source => source.id === secondGroup.responseMessageId));
    assert.ok(second.candidates[0]?.sources.every(source => source.id !== firstGroup.responseMessageId));
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed candidate write rolls back every draft from that source bundle', () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const turn = addDirectTurn(store, 'rollback', '采用受控回滚方案。', '验证每一步提交。');
    const repository = new MemoryCandidateRepository(store.getDatabase());
    let writes = 0;
    const candidates = {
      findCandidateById: repository.findCandidateById.bind(repository),
      createCandidateWithinTransaction(input: Parameters<MemoryCandidateRepository['createCandidateWithinTransaction']>[0]) {
        writes += 1;
        if (writes === 2) throw new Error('injected candidate persistence failure');
        return repository.createCandidateWithinTransaction(input);
      },
    } as MemoryCandidateRepository;
    const service = new MemorySourceAccumulationService(store, {
      candidates,
      extractor: { extract: () => ({ drafts: drafts(3), reason: 'public_evidence' }) },
    });

    assert.throws(() => service.generateForDirectTurn({ workspaceId: WS, ...turn, createdAt: NOW }), /GENERATION_FAILED/);
    assert.equal(repository.listCandidates(WS).length, 0, 'the first write is rolled back with the second');
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('secret-bearing extractor output is filtered before any Candidate is persisted', () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const turn = addDirectTurn(store, 'secret', '采用安全的凭证方案。', '不要保留凭证值。');
    const service = new MemorySourceAccumulationService(store, {
      extractor: { extract: () => ({
        drafts: [{
          type: 'decision', title: 'Secret leaked', summary: 'API_KEY=sk-fixture-only-value-123456789',
          content: 'Credential was present in the public reply.', confidence: 100, operation: 'create',
        }], reason: 'public_evidence',
      }) },
    });
    const result = service.generateForDirectTurn({ workspaceId: WS, ...turn, createdAt: NOW });
    assert.equal(result.outcome, 'none');
    assert.equal(new MemoryCandidateRepository(store.getDatabase()).listCandidates(WS).length, 0);
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the legacy accumulation route feeds the canonical review queue and promotion route keeps the source Entry', async () => {
  const root = createRoot();
  const store = new SqliteStore(root);
  const app = express();
  app.use(express.json());
  const manager = new WorkspaceManager(store);
  app.use('/api/workspaces/:workspaceId', createMemoryRuntimeRoutes(store, manager));
  app.use('/api/workspaces/:workspaceId', createMemoryCandidateRoutes(store, manager));
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/workspaces/${WS}`;
    addLegacyRun(store, 'legacy-run-queue', 'legacy-source-queue', 'legacy-reply-queue', '采用有审计的认证方案。', '决定保留逐次操作日志。');
    const accumulated = await fetch(`${base}/runs/legacy-run-queue/memory-candidates/accumulate`, { method: 'POST' });
    assert.equal(accumulated.status, 201);
    const accumulation = await accumulated.json() as { candidates: Array<{ id: string; outcome: string }> };
    assert.equal(accumulation.candidates.length, 1);
    assert.equal(accumulation.candidates[0]?.outcome, 'review-required');
    const queue = await fetch(`${base}/memory/candidates?outcome=review-required`)
      .then(response => response.json()) as { candidates: Array<{ id: string; sources: Array<{ kind: string; id: string }> }> };
    const queued = queue.candidates.find(candidate => candidate.id === accumulation.candidates[0]?.id);
    assert.ok(queued, 'source accumulation is visible through the forward review endpoint');
    assert.ok(queued.sources.some(source => source.kind === 'run' && source.id === 'legacy-run-queue'));

    const conversations = store.conversationRepository();
    conversations.createConversation({ id: 'promotion-route-conversation', workspaceId: WS, kind: 'direct', title: 'Promote', createdAt: NOW });
    conversations.appendMessage({
      id: 'promotion-route-message', workspaceId: WS, conversationId: 'promotion-route-conversation',
      senderType: 'user', kind: 'text', status: 'final', content: '确认长期发布规范。', createdAt: NOW,
    });
    const source = new MemoryEntryRepository(store.getDatabase()).createEntry({
      id: 'promotion-route-source', workspaceId: WS, scope: 'conversation',
      ownerConversationId: 'promotion-route-conversation', category: 'workflow', authority: 'agent-derived',
      confidence: 0.8, importance: 0.5, title: '发布规范', content: '发布前必须完成验证。', status: 'active',
      sources: [
        { kind: 'conversation', id: 'promotion-route-conversation' },
        { kind: 'message', id: 'promotion-route-message' },
      ], createdAt: NOW,
    });
    const promotedResponse = await fetch(`${base}/memory/entries/${source.id}/promote-to-workspace-knowledge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(promotedResponse.status, 201);
    const promoted = await promotedResponse.json() as { entry: { id: string; scope: string; sources: Array<{ kind: string; id: string }> } };
    assert.equal(promoted.entry.scope, 'workspace');
    assert.notEqual(promoted.entry.id, source.id);
    assert.deepEqual(promoted.entry.sources, source.sources);
    assert.equal(new MemoryEntryRepository(store.getDatabase()).findById(WS, source.id)?.scope, 'conversation');
    const stale = await fetch(`${base}/memory/entries/${source.id}/promote-to-workspace-knowledge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 2 }),
    });
    assert.equal(stale.status, 409);
    const replay = await fetch(`${base}/memory/entries/${source.id}/promote-to-workspace-knowledge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 }),
    });
    assert.equal(replay.status, 200);
    const replayed = await replay.json() as { outcome: string; entry: { id: string } };
    assert.equal(replayed.outcome, 'existing');
    assert.equal(replayed.entry.id, promoted.entry.id);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace promotion creates a separate Entry with validated links, CAS, and one rollback boundary', () => {
  const root = createRoot();
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(root);
    const conversations = store.conversationRepository();
    conversations.createConversation({ id: 'promote-conversation', workspaceId: WS, kind: 'direct', title: 'Promotion', createdAt: NOW });
    conversations.appendMessage({
      id: 'promote-source-message', workspaceId: WS, conversationId: 'promote-conversation',
      senderType: 'user', kind: 'text', status: 'final', content: '确认工作区发布策略。', createdAt: NOW,
    });
    const entries = new MemoryEntryRepository(store.getDatabase());
    const source = entries.createEntry({
      id: 'memory-conversation-source', workspaceId: WS, scope: 'conversation',
      ownerConversationId: 'promote-conversation', category: 'decision', authority: 'agent-derived',
      confidence: 0.8, importance: 0.5, title: '发布策略', summary: '发布必须经过验证。',
      content: '发布必须经过验证并保留回滚能力。', status: 'active',
      sources: [
        { kind: 'conversation', id: 'promote-conversation' },
        { kind: 'message', id: 'promote-source-message' },
      ], createdAt: NOW,
    });
    const sourceOrigin = { kind: 'memory.entry_save', entryId: source.id, entryVersion: source.version } as const;
    const sourceEvent = store.runInTransaction(() => store!.workspaceEventWriter().appendWithinTransaction({
      type: 'memory.entry_created',
      workspaceId: WS,
      timestamp: NOW,
      origin: sourceOrigin,
      context: deriveWorkspaceEventContext(sourceOrigin),
      payload: {
        memoryEntryId: source.id,
        version: source.version,
        scope: source.scope,
        category: source.category,
        authority: source.authority,
      },
    }));
    store.getDatabase().prepare(
      'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
    ).run('promote-task-owner', WS, 'Task-owned memory', 'open', 'test', NOW, NOW);

    const failingStore = {
      getDatabase: () => store!.getDatabase(),
      workspaceEventWriter: () => ({ appendWithinTransaction: () => { throw new Error('injected event failure'); } }),
    } as unknown as Pick<SqliteStore, 'getDatabase' | 'workspaceEventWriter'>;
    const failingPromotion = new MemoryWorkspaceKnowledgePromotionService(failingStore, { entries });
    assert.throws(() => failingPromotion.promote({ workspaceId: WS, entryId: source.id, expectedVersion: 1, promotedAt: NOW }),
      (error: unknown) => error instanceof MemoryWorkspaceKnowledgePromotionError && error.code === 'PROMOTION_FAILED');
    assert.equal(entries.listEntries(WS, { status: 'all' }).length, 1, 'failed Event append rolls back only the new Entry');
    assert.equal(entries.findById(WS, source.id)?.version, 1);

    const db = store.getDatabase();
    db.prepare(`INSERT INTO memory_version_feedback
      (id, workspace_id, entry_id, entry_version, current_entry_version, context_kind, context_id, context_hash, kind, comment, created_at)
      VALUES (?, ?, ?, 1, 1, 'run', ?, ?, 'wrong', ?, ?)`).run(
      'feedback-promotion-quarantine', WS, source.id, 'run-promotion-quarantine', 'e'.repeat(64), 'This version is wrong.', NOW,
    );
    db.prepare(`INSERT INTO memory_feedback_actions
      (id, feedback_id, workspace_id, entry_id, entry_version, action, status, version, created_at)
      VALUES (?, ?, ?, ?, 1, 'correction', 'pending', 1, ?)`).run(
      'action-promotion-quarantine', 'feedback-promotion-quarantine', WS, source.id, NOW,
    );

    const service = new MemoryWorkspaceKnowledgePromotionService(store, { entries });
    const eventCountBeforeQuarantine = Number((db.prepare('SELECT COUNT(*) AS count FROM workspace_events').get() as { count: number }).count);
    assert.throws(() => service.promote({ workspaceId: WS, entryId: source.id, expectedVersion: 1, promotedAt: NOW }),
      (error: unknown) => error instanceof MemoryWorkspaceKnowledgePromotionError && error.code === 'ENTRY_QUARANTINED');
    assert.equal(entries.listEntries(WS, { status: 'all' }).length, 1, 'a pending wrong source version cannot be copied to a fresh workspace Entry');
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM workspace_events').get() as { count: number }).count), eventCountBeforeQuarantine,
      'quarantine rejection does not append an audit Event');

    const correctedContent = '发布策略已校正：先验证本地证据，再决定是否发布。';
    db.prepare(`UPDATE memory_entries SET summary = ?, content = ?, exact_content_hash = ?, normalized_text_hash = ?,
      version = version + 1, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = 1`).run(
      '当前版本已完成纠正。', correctedContent,
      hashMemoryText(correctedContent), hashMemoryText(normalizeMemoryText(correctedContent)),
      '2026-10-02T00:01:00.000Z', WS, source.id,
    );
    assert.equal(entries.findById(WS, source.id)?.version, 2);
    assert.throws(() => service.promote({ workspaceId: WS, entryId: source.id, expectedVersion: 1, promotedAt: NOW }),
      (error: unknown) => error instanceof MemoryWorkspaceKnowledgePromotionError && error.code === 'VERSION_CONFLICT');

    const promoted = service.promote({ workspaceId: WS, entryId: source.id, expectedVersion: 2, promotedAt: NOW });
    assert.equal(promoted.outcome, 'created');
    assert.equal(promoted.entry.scope, 'workspace');
    assert.equal(promoted.entry.content, correctedContent, 'only the corrected active version is promoted');
    assert.deepEqual(promoted.entry.sources, [
      { kind: 'conversation', id: 'promote-conversation' },
      { kind: 'event', id: sourceEvent.id },
      { kind: 'message', id: 'promote-source-message' },
    ]);
    assert.equal(entries.findById(WS, source.id)?.scope, 'conversation', 'promotion preserves the scoped source Entry');
    assert.equal(service.promote({ workspaceId: WS, entryId: source.id, expectedVersion: 2, promotedAt: NOW }).outcome, 'existing');
    assert.throws(() => service.promote({ workspaceId: WS, entryId: source.id, expectedVersion: 1, promotedAt: NOW }),
      (error: unknown) => error instanceof MemoryWorkspaceKnowledgePromotionError && error.code === 'VERSION_CONFLICT');

    const taskEntry = entries.createEntry({
      id: 'memory-task-source', workspaceId: WS, scope: 'task', ownerTaskId: 'promote-task-owner',
      category: 'decision', authority: 'agent-derived', confidence: 0.8, importance: 0.5,
      title: 'Task decision', content: 'The task Entry remains attached to its task after promotion.', status: 'active',
      sources: [{ kind: 'task', id: 'promote-task-owner' }], createdAt: NOW,
    });
    const taskPromotion = service.promote({ workspaceId: WS, entryId: taskEntry.id, expectedVersion: 1, promotedAt: NOW });
    assert.equal(taskPromotion.entry.scope, 'workspace');
    assert.equal(entries.findById(WS, taskEntry.id)?.scope, 'task', 'promotion leaves the task-scoped source Entry intact');
    assert.deepEqual(taskPromotion.entry.sources, taskEntry.sources);

    const invalidSource = entries.createEntry({
      id: 'memory-invalid-source', workspaceId: WS, scope: 'conversation', ownerConversationId: 'promote-conversation',
      category: 'decision', authority: 'agent-derived', confidence: 0.8, importance: 0.5,
      title: 'Invalid source', content: 'This source does not exist.', status: 'active',
      sources: [{ kind: 'message', id: 'message-from-another-scope' }], createdAt: NOW,
    });
    assert.throws(() => service.promote({ workspaceId: WS, entryId: invalidSource.id, expectedVersion: 1, promotedAt: NOW }),
      (error: unknown) => error instanceof MemoryWorkspaceKnowledgePromotionError && error.code === 'SOURCE_INVALID');
  } finally {
    store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
