import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEntityId } from '../store/Identity.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { eventRedactionServiceForDatabase } from './EventRedactionService.js';
import {
  ConversationNotificationService,
  type ConversationNotificationType,
} from './ConversationNotificationService.js';
import { ConversationSummaryService } from './ConversationSummaryService.js';
import { ConversationStreamService } from './ConversationStreamService.js';
import { AgentTurnRepository } from '../store/AgentTurnRepository.js';
import { ConversationEventRepository } from '../store/ConversationEventRepository.js';
import { inTransaction } from '../store/Transaction.js';
import { seedApprovalRun } from '../store/RuntimeApproval.test-fixture.js';

const NOW = '2026-10-20T10:00:00.000Z';
const WS = 'ws_conversation_productization';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-conversation-productization-'));
  const store = new SqliteStore(root);
  const db = store.getDatabase();
  db.prepare(`
    INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(WS, WS, root, root, NOW, NOW, NOW);
  const conversationId = createEntityId('conversation');
  const conversations = store.conversationRepository();
  conversations.createConversation({ id: conversationId, workspaceId: WS, kind: 'direct', title: 'Productization', createdAt: NOW });
  let sequence = 0;
  const append = (content: string, senderType: 'user' | 'agent' = 'user') => {
    sequence += 1;
    return conversations.appendMessage({
      id: createEntityId('message'), workspaceId: WS, conversationId, senderType,
      ...(senderType === 'agent' ? { senderAgentId: 'agent_codex' } : {}),
      kind: 'text', status: 'final', content, createdAt: NOW,
    });
  };
  return {
    root, store, db, conversationId, append,
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('manual and threshold Summary triggers append immutable deterministic versions', () => {
  const fx = fixture();
  try {
    const summaries = new ConversationSummaryService(fx.db, () => NOW);
    eventRedactionServiceForDatabase(fx.db).registerSecrets(WS, ['product-secret-value']);
    for (let i = 1; i < 50; i += 1) fx.append(`ordinary message ${i}`);
    assert.equal(summaries.latest(WS, fx.conversationId), null);
    fx.append('我们采用稳定方案；product-secret-value remains private');
    const first = summaries.latest(WS, fx.conversationId);
    assert.equal(first?.version, 1);
    assert.equal(first?.fromSequence, 1);
    assert.equal(first?.toSequence, 50);
    assert.ok(!first?.summary.includes('product-secret-value'));
    assert.equal(summaries.createVersion({ workspaceId: WS, conversationId: fx.conversationId, trigger: 'manual' }).created, false);

    fx.append('必须保留回滚路径。');
    const secondResult = summaries.createVersion({ workspaceId: WS, conversationId: fx.conversationId, trigger: 'manual' });
    assert.equal(secondResult.created, true);
    assert.equal(secondResult.summary?.version, 2);
    assert.equal(secondResult.summary?.supersedesSummaryId, first?.id);
    assert.deepEqual(secondResult.summary?.constraints, ['User: 必须保留回滚路径。']);
    assert.equal(summaries.latest(WS, fx.conversationId)?.id, secondResult.summary?.id);
    assert.deepEqual(summaries.list(WS, fx.conversationId).map(item => item.version), [2, 1]);
    assert.throws(() => fx.db.prepare('UPDATE conversation_summaries SET summary = ? WHERE id = ?').run('overwrite', first?.id), /CONVERSATION_SUMMARY_IMMUTABLE/);
    assert.equal(summaries.latest(WS, fx.conversationId)?.summary, secondResult.summary?.summary);

    fx.store.conversationRepository().appendMessage({
      id: createEntityId('message'), workspaceId: WS, conversationId: fx.conversationId,
      senderType: 'user', kind: 'text', status: 'streaming', content: 'partial response', createdAt: NOW,
    });
    assert.throws(
      () => summaries.createVersion({ workspaceId: WS, conversationId: fx.conversationId, trigger: 'manual' }),
      /CONVERSATION_SUMMARY_ACTIVE_STREAM/,
    );
    assert.equal(summaries.latest(WS, fx.conversationId)?.id, secondResult.summary?.id);
  } finally { fx.close(); }
});

test('four notification types are generated, deduplicated, redacted, and user/workspace scoped', () => {
  const fx = fixture();
  try {
    const db = fx.db;
    db.prepare(`INSERT INTO user_profiles (id, display_name, learning_enabled, created_at, updated_at)
      VALUES ('other-user', 'Other', 0, ?, ?)`).run(NOW, NOW);
    eventRedactionServiceForDatabase(db).registerSecrets(WS, ['notification-secret-value']);
    const notifications = new ConversationNotificationService(db, () => NOW);

    const mention = fx.append('@codex please review');
    fx.append('The Agent reply is ready', 'agent');
    notifications.notifyFromRuntimeEvent({
      type: 'run.completed', workspaceId: WS, conversationId: fx.conversationId,
      runId: 'run_product_completed', payload: { status: 'completed' },
    });
    notifications.notifyFromRuntimeEvent({
      type: 'run.completed', workspaceId: WS, conversationId: fx.conversationId,
      runId: 'run_product_completed', payload: { status: 'completed' },
    });
    notifications.notifyFromRuntimeEvent({
      type: 'approval.required', workspaceId: WS, conversationId: fx.conversationId,
      approvalRequestId: 'approval_product',
    });
    notifications.notifyFromRuntimeEvent({
      type: 'stage.completed', workspaceId: WS, conversationId: fx.conversationId,
      runId: 'run_product_completed', payload: { status: 'completed' },
    });
    notifications.notifyFromRuntimeEvent({
      type: 'approval.required', workspaceId: WS, conversationId: fx.conversationId,
      approvalRequestId: 'approval_product',
    });
    notifications.notify({
      workspaceId: WS, userId: 'default', conversationId: fx.conversationId, type: 'mention',
      source: { kind: 'message', messageId: 'msg_redacted_notification' },
      payload: { body: `value notification-secret-value hidden` },
    });

    const rows = notifications.list({ workspaceId: WS, userId: 'default' });
    const types = rows.map(row => row.type);
    for (const type of ['mention', 'agent-reply', 'run-completed', 'approval'] satisfies ConversationNotificationType[]) {
      assert.ok(types.includes(type));
    }
    assert.equal(types.filter(type => type === 'run-completed').length, 1);
    assert.equal(types.filter(type => type === 'approval').length, 1);
    const redacted = rows.find(row => row.payload.body !== undefined);
    assert.equal(redacted?.payload.body, 'value [REDACTED] hidden');
    assert.ok(rows.every(row => row.userId === 'default' && row.conversationId === fx.conversationId));
    assert.equal(notifications.list({ workspaceId: WS, userId: 'other-user' }).length, 0);
    assert.equal(notifications.list({ workspaceId: 'ws_other_workspace', userId: 'default' }).length, 0);

    const mentionNotification = rows.find(row => row.payload.messageId === mention.id && row.type === 'mention')!;
    const agentReply = rows.find(row => row.type === 'agent-reply')!;
    assert.equal(notifications.markRead(WS, 'default', mentionNotification.id)?.status, 'read');
    assert.equal(notifications.dismiss(WS, 'default', agentReply.id)?.status, 'dismissed');
    assert.equal(notifications.markRead('ws_other_workspace', 'default', mentionNotification.id), null);
    assert.equal(notifications.list({ workspaceId: WS, userId: 'default', status: 'read' }).length, 1);
    assert.equal(notifications.list({ workspaceId: WS, userId: 'default', status: 'dismissed' }).length, 1);
    const readAt = notifications.markRead(WS, 'default', mentionNotification.id)!.readAt;
    assert.equal(notifications.dismiss(WS, 'default', mentionNotification.id)?.status, 'dismissed');
    assert.equal(notifications.markRead(WS, 'default', mentionNotification.id)?.status, 'dismissed');
    assert.equal(notifications.dismiss(WS, 'default', mentionNotification.id)?.readAt, readAt);
    const events = new ConversationEventRepository(db).listAfter(WS, fx.conversationId, 'default');
    assert.equal(events.filter(event => event.type === 'conversation.notification_created').length, rows.length);
    assert.equal(events.filter(event => event.type === 'conversation.notification_updated').length, 3);
    assert.deepEqual(new ConversationEventRepository(db).listAfter(WS, fx.conversationId, 'other-user'), []);
  } finally { fx.close(); }
});

test('finalizing a production stream triggers the 50th-message Summary and Agent notification exactly once', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 49; i += 1) fx.append(`source ${i}`);
    const service = new ConversationStreamService(fx.db, fx.store.conversationRepository(), new AgentTurnRepository(fx.db));
    const handle = service.beginAgentTurnStream({ workspaceId: WS, conversationId: fx.conversationId,
      turnId: createEntityId('turn'), messageId: createEntityId('message'), agentId: 'agent_codex', createdAt: NOW });
    service.appendStreamDelta({ workspaceId: WS, turnId: handle.turn.id, messageId: handle.message.id, delta: '@codex final reply', createdAt: NOW });
    const summaries = new ConversationSummaryService(fx.db);
    const notifications = new ConversationNotificationService(fx.db);
    assert.equal(summaries.latest(WS, fx.conversationId), null);
    assert.deepEqual(notifications.list({ workspaceId: WS, userId: 'default' }), []);
    const finalInput = { workspaceId: WS, turnId: handle.turn.id, messageId: handle.message.id,
      expectedTurnVersion: handle.turn.version, expectedMessageVersion: handle.message.version, outcome: 'final' as const, updatedAt: NOW };
    const final = service.finalizeStream(finalInput);
    assert.equal(final.message.content, '@codex final reply');
    assert.equal(summaries.latest(WS, fx.conversationId)?.toSequence, 50);
    service.finalizeStream(finalInput);
    assert.equal(summaries.list(WS, fx.conversationId).length, 1);
    assert.deepEqual(notifications.list({ workspaceId: WS, userId: 'default' }).map(row => row.type).sort(), ['agent-reply', 'mention']);
    fx.store.conversationRepository().appendMessage({ id: createEntityId('message'), workspaceId: WS,
      conversationId: fx.conversationId, senderType: 'system', kind: 'text', status: 'final', content: 'run card', createdAt: NOW });
    assert.equal(notifications.list({ workspaceId: WS, userId: 'default' }).length, 2, 'system cards are not Agent replies');
  } finally { fx.close(); }
});

test('message, Summary, notification status and their events roll back together on persistence failure', () => {
  const fx = fixture();
  try {
    const failEvents = () => fx.db.exec(`CREATE TRIGGER fail_product_event BEFORE INSERT ON conversation_events
      BEGIN SELECT RAISE(ABORT, 'injected event persistence failure'); END`);
    failEvents();
    assert.throws(() => fx.append('@codex cannot commit'));
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM cr_messages').get() as { n: number }).n, 0);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS n FROM conversation_notifications').get() as { n: number }).n, 0);
    fx.db.exec('DROP TRIGGER fail_product_event');
    fx.append('must preserve an exact source');
    const summaries = new ConversationSummaryService(fx.db);
    failEvents();
    assert.throws(() => summaries.createVersion({ workspaceId: WS, conversationId: fx.conversationId, trigger: 'manual' }));
    assert.equal(summaries.latest(WS, fx.conversationId), null);
    fx.db.exec('DROP TRIGGER fail_product_event');
    const message = fx.append('@codex committed');
    const notifications = new ConversationNotificationService(fx.db);
    const notification = notifications.list({ workspaceId: WS, userId: 'default' })[0]!;
    failEvents();
    assert.throws(() => notifications.markRead(WS, 'default', notification.id));
    assert.equal(notifications.list({ workspaceId: WS, userId: 'default' })[0]?.status, 'unread');
    fx.db.exec('DROP TRIGGER fail_product_event');
    assert.throws(() => inTransaction(fx.db, () => {
      fx.store.conversationRepository().appendMessageWithinTransaction({ id: createEntityId('message'), workspaceId: WS,
        conversationId: fx.conversationId, senderType: 'user', kind: 'text', status: 'final', content: '@codex rollback', createdAt: NOW });
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(notifications.list({ workspaceId: WS, userId: 'default' }).length, 1);
    assert.equal(notifications.list({ workspaceId: WS, userId: 'default' })[0]?.sourceMessageId, message.id);
    assert.equal(new ConversationEventRepository(fx.db).listAfter(WS, fx.conversationId, 'default').length, 1);
  } finally { fx.close(); }
});

test('Summary version chain, source ids and event cursors survive a store restart', () => {
  const fx = fixture();
  let store = fx.store;
  try {
    fx.append('decision: retain the durable source');
    const summaries = new ConversationSummaryService(store.getDatabase(), () => NOW);
    const first = summaries.createVersion({ workspaceId: WS, conversationId: fx.conversationId, trigger: 'manual' }).summary!;
    fx.append('must not overwrite history?');
    const second = summaries.createVersion({ workspaceId: WS, conversationId: fx.conversationId, trigger: 'manual' }).summary!;
    const cursor = new ConversationEventRepository(store.getDatabase()).listAfter(WS, fx.conversationId, 'default')[0]!.sequence;
    store.close();
    store = new SqliteStore(fx.root);
    const restored = new ConversationSummaryService(store.getDatabase());
    assert.deepEqual(restored.latest(WS, fx.conversationId), second);
    assert.deepEqual(restored.list(WS, fx.conversationId), [second, first]);
    assert.deepEqual(new ConversationEventRepository(store.getDatabase()).listAfter(WS, fx.conversationId, 'default', cursor)
      .map(event => event.type), ['conversation.summary_created', 'conversation.summary_superseded']);
  } finally { store.close(); rmSync(fx.root, { recursive: true, force: true }); }
});

test('Summary thresholds count uncovered nondeleted messages and retain exact source and Task/Run references', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 50; i += 1) fx.append(`initial ${i}`);
    const summaries = new ConversationSummaryService(fx.db);
    const first = summaries.latest(WS, fx.conversationId)!;
    const frozen = JSON.stringify(first);
    for (let i = 0; i < 49; i += 1) fx.append(`follow-up ${i}`);
    fx.store.conversationRepository().appendMessage({ id: createEntityId('message'), workspaceId: WS,
      conversationId: fx.conversationId, senderType: 'user', kind: 'text', status: 'deleted', content: 'must not summarize this', createdAt: NOW });
    assert.equal(summaries.latest(WS, fx.conversationId)?.version, 1);
    const refs = seedApprovalRun(fx.db, WS, NOW, fx.conversationId);
    const last = fx.store.conversationRepository().appendMessage({ id: createEntityId('message'), workspaceId: WS,
      conversationId: fx.conversationId, senderType: 'user', kind: 'text', status: 'final',
      content: 'must retain the exact references?', taskId: refs.taskId, runId: refs.runId, createdAt: NOW });
    const second = summaries.latest(WS, fx.conversationId)!;
    assert.equal(second.version, 2);
    assert.equal(second.fromSequence, 51);
    assert.equal(second.toSequence, 101);
    assert.equal(second.sourceMessageIds.length, 50);
    assert.equal(second.sourceMessageIds.at(-1), last.id);
    assert.deepEqual(second.taskReferences, [refs.taskId]);
    assert.deepEqual(second.runReferences, [refs.runId]);
    assert.deepEqual(second.openQuestions, ['User: must retain the exact references?']);
    assert.equal(second.supersedesSummaryId, first.id);
    assert.equal(JSON.stringify(summaries.list(WS, fx.conversationId)[1]), frozen);
  } finally { fx.close(); }
});

test('extractive Summary preserves user and Agent authorship in text and structured items', () => {
  const fx = fixture();
  try {
    fx.append('Which approach best meets the deadline?');
    fx.append('Decision: use the phased rollout.', 'agent');
    const summary = new ConversationSummaryService(fx.db, () => NOW)
      .createVersion({ workspaceId: WS, conversationId: fx.conversationId, trigger: 'manual' }).summary!;
    assert.match(summary.summary, /User: Which approach best meets the deadline\?/u);
    assert.match(summary.summary, /Agent: Decision: use the phased rollout\./u);
    assert.deepEqual(summary.decisions, ['Agent: Decision: use the phased rollout.']);
    assert.deepEqual(summary.openQuestions, ['User: Which approach best meets the deadline?']);
  } finally { fx.close(); }
});

test('automatic threshold rechecks after the last active stream leaves streaming', () => {
  const fx = fixture();
  try {
    const repository = fx.store.conversationRepository();
    for (let i = 0; i < 49; i += 1) fx.append(`source ${i}`);
    const first = repository.appendMessage({ id: createEntityId('message'), workspaceId: WS,
      conversationId: fx.conversationId, senderType: 'agent', senderAgentId: 'agent_codex', kind: 'text',
      status: 'streaming', content: 'completed answer', createdAt: NOW });
    const second = repository.appendMessage({ id: createEntityId('message'), workspaceId: WS,
      conversationId: fx.conversationId, senderType: 'agent', senderAgentId: 'agent_codex', kind: 'text',
      status: 'streaming', content: 'partial failed output', createdAt: NOW });
    repository.transitionMessageStatus({ workspaceId: WS, messageId: first.id, expectedVersion: first.version,
      to: 'final', changedAt: NOW });
    assert.equal(new ConversationSummaryService(fx.db).latest(WS, fx.conversationId), null,
      'the remaining streaming Message defers the Summary');
    repository.transitionMessageStatus({ workspaceId: WS, messageId: second.id, expectedVersion: second.version,
      to: 'failed', changedAt: NOW });
    const summary = new ConversationSummaryService(fx.db).latest(WS, fx.conversationId)!;
    assert.equal(summary.toSequence, 51);
    assert.ok(summary.sourceMessageIds.includes(first.id) && summary.sourceMessageIds.includes(second.id));
    assert.match(summary.summary, /Agent \(failed\): partial failed output/u);
  } finally { fx.close(); }
});
