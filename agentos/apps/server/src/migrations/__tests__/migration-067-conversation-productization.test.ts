import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../default-registry.js';
import { migration067, migration067Checksum } from '../migrations/067-conversation-summaries-notifications.js';
import { ConversationRepository } from '../../store/ConversationRepository.js';
import { ConversationSummaryService } from '../../services/ConversationSummaryService.js';
import { ConversationSearchReadStateService } from '../../services/ConversationSearchReadStateService.js';
import { RuntimeApprovalRepository } from '../../store/RuntimeApprovalRepository.js';
import { seedApprovalRun } from '../../store/RuntimeApproval.test-fixture.js';
import { inTransaction, type TransactionDatabase } from '../../store/Transaction.js';
import type { MinimalDatabaseSync } from '../types.js';

const NOW = '2026-10-22T00:00:00.000Z';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => TransactionDatabase & { close(): void };
};
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
function through065(db: InstanceType<typeof DatabaseSync>) {
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id <= '065')) migration.apply({ db: db as unknown as MinimalDatabaseSync });
}
function seed(db: TransactionDatabase) {
  db.prepare(`INSERT INTO workspaces (id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at)
    VALUES ('ws','WS','/test/product','/test/product',?,?,?)`).run(NOW, NOW, NOW);
  const conversations = new ConversationRepository(db);
  for (const id of ['conversation-a', 'conversation-b']) {
    conversations.createConversation({ id, workspaceId: 'ws', kind: 'direct', title: id, createdAt: NOW });
    conversations.appendMessage({ id: `message-${id}`, workspaceId: 'ws', conversationId: id,
      senderType: 'user', kind: 'text', status: 'final', content: 'must retain this message?', createdAt: NOW });
  }
}

test('067 fresh schema and reapply preserve 065, reserved slots, foreign keys, and immutable version chains', () => {
  const db = database();
  try {
    through065(db);
    migration067.apply({ db: db as unknown as MinimalDatabaseSync });
    seed(db);
    const summaries = new ConversationSummaryService(db, () => NOW);
    const first = summaries.createVersion({ workspaceId: 'ws', conversationId: 'conversation-a', trigger: 'manual' }).summary!;
    assert.deepEqual(first.openQuestions, ['User: must retain this message?']);
    assert.deepEqual(first.sourceMessageIds, ['message-conversation-a']);
    const clone = (id: string, conversationId: string, from: number, to: number, previous: string | null, version: number) => db.prepare(`
      INSERT INTO conversation_summaries (id,conversation_id,from_sequence,to_sequence,summary,
        decisions_json,constraints_json,open_questions_json,task_references_json,run_references_json,source_message_ids_json,
        generated_at,supersedes_summary_id,version,created_at)
      VALUES (?,?,?,?,'test','[]','[]','[]','[]','[]','[]',?,?,?,?)
    `).run(id, conversationId, from, to, NOW, previous, version, NOW);
    assert.throws(() => clone('cross-conversation', 'conversation-b', 2, 2, first.id, 2), /CHAIN_INVALID/);
    assert.throws(() => clone('missing-link', 'conversation-a', 2, 2, null, 2), /CHAIN_INVALID/);
    assert.throws(() => clone('gap', 'conversation-a', 3, 3, first.id, 2), /CHAIN_INVALID/);
    assert.throws(() => clone('invalid-root', 'conversation-b', 2, 2, null, 1), /CHAIN_INVALID/);
    clone('valid-v2', 'conversation-a', 2, 2, first.id, 2);
    assert.throws(() => clone('fork', 'conversation-a', 2, 2, first.id, 2), /UNIQUE/);
    assert.throws(() => db.prepare('UPDATE conversation_summaries SET summary = ? WHERE id = ?').run('overwrite', first.id), /IMMUTABLE/);
    assert.throws(() => db.prepare('DELETE FROM conversation_summaries WHERE id = ?').run(first.id), /IMMUTABLE/);
    assert.throws(() => db.prepare('DELETE FROM conversation_events WHERE conversation_id = ?').run('conversation-a'), /CONVERSATION_EVENT_IMMUTABLE/);
    assert.equal(summaries.latest('ws', 'conversation-a')?.id, 'valid-v2');
    migration067.apply({ db: db as unknown as MinimalDatabaseSync });
    assert.equal(summaries.list('ws', 'conversation-a').length, 2);
    assert.equal(DEFAULT_REGISTRY_MIGRATIONS.find(item => item.id === '067')?.checksum, migration067Checksum);
    assert.ok(DEFAULT_REGISTRY_MIGRATIONS.some(item => item.id === '065'));
    assert.equal(DEFAULT_REGISTRY_MIGRATIONS.filter(item => item.id === '066').length, 1);
    assert.equal(DEFAULT_REGISTRY_MIGRATIONS.find(item => item.id === '066')?.name, 'provider-validation-cache');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'scheduler_jobs'").get());
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  } finally { db.close(); }
});

test('067 upgrade keeps messages/read positions/old approvals and resolves their NULL Conversation bindings', () => {
  const db = database();
  try {
    through065(db);
    seed(db);
    const approval = seedApprovalRun(db, 'ws', NOW, 'conversation-a');
    const oldApproval = inTransaction(db, () => new RuntimeApprovalRepository(db).createWithinTransaction(approval));
    assert.equal(oldApproval.conversationId, null);
    const readStates = new ConversationSearchReadStateService(db);
    assert.equal(readStates.markRead({ workspaceId: 'ws', conversationId: 'conversation-a', userId: 'default', latest: true, now: NOW }).approvalCount, 1,
      'association remains resolvable even before the optional column exists');
    const messages = db.prepare('SELECT * FROM cr_messages ORDER BY id').all();
    const readState = db.prepare('SELECT * FROM conversation_read_states').all();
    migration067.apply({ db: db as unknown as MinimalDatabaseSync });
    assert.deepEqual(db.prepare('SELECT * FROM cr_messages ORDER BY id').all(), messages);
    assert.deepEqual(db.prepare('SELECT * FROM conversation_read_states').all(), readState);
    const upgraded = new RuntimeApprovalRepository(db).findById('ws', approval.id)!;
    assert.equal(upgraded.conversationId, null);
    assert.equal(upgraded.version, oldApproval.version);
    assert.equal(new ConversationSearchReadStateService(db).readState('ws', 'conversation-a', 'default', NOW)?.approvalCount, 1);
    assert.equal(new ConversationSearchReadStateService(db).readState('ws', 'conversation-b', 'default', NOW)?.approvalCount, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('067 refuses missing prerequisite schemas', () => {
  const db = database();
  try { assert.throws(() => migration067.apply({ db: db as unknown as MinimalDatabaseSync }), /MIGRATION_PREREQUISITE_MISSING/); }
  finally { db.close(); }
});
