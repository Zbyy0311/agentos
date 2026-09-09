import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from './Transaction.js';
import {
  ConversationRepository,
  ConversationRepositoryError,
  type AppendMessageInput,
} from './ConversationRepository.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-09-09T00:00:00.000Z';
const NOW2 = '2026-09-09T01:00:00.000Z';
const WS = 'ws_cr1r';
const CONV = 'conv_' + 'a'.repeat(26);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr1-repo-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_cr1r', 'C:/tmp/ws_cr1r', NOW, NOW, NOW);
  const repo = new ConversationRepository(db as unknown as TransactionDatabase);
  return { db, repo, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

let seq = 0;
function messageInput(overrides: Partial<AppendMessageInput> = {}): AppendMessageInput {
  seq += 1;
  return {
    id: 'msg_' + String(seq).padStart(4, '0') + 'a'.repeat(20),
    conversationId: CONV,
    workspaceId: WS,
    senderType: 'user',
    kind: 'text',
    status: 'final',
    content: `content ${seq}`,
    createdAt: NOW,
    ...overrides,
  };
}

function expectCode(error: unknown, code: ConversationRepositoryError['code']): boolean {
  assert.ok(error instanceof ConversationRepositoryError);
  assert.equal(error.code, code);
  return true;
}

// CR1R-01 — create conversation.
test('CR1R-01 create conversation', () => {
  const fx = fixture();
  try {
    const conversation = fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'group', title: 'Team', replyMode: 'sequential', createdAt: NOW });
    assert.equal(conversation.kind, 'group');
    assert.equal(conversation.status, 'active');
    assert.equal(conversation.replyMode, 'sequential');
    assert.equal(conversation.version, 1);
  } finally { fx.close(); }
});

// CR1R-02 — direct conversation rejects a reply mode.
test('CR1R-02 direct conversation rejects reply mode', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', replyMode: 'sequential', createdAt: NOW }),
      (e: unknown) => expectCode(e, 'INPUT_INVALID'),
    );
    const direct = fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    assert.equal(direct.replyMode, null);
  } finally { fx.close(); }
});

// CR1R-03 — missing workspace fails closed.
test('CR1R-03 missing workspace fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createConversation({ id: CONV, workspaceId: 'ws_missing', kind: 'direct', title: 'D', createdAt: NOW }),
      (e: unknown) => expectCode(e, 'WORKSPACE_NOT_FOUND'),
    );
  } finally { fx.close(); }
});

// CR1R-04 — archive/restore is versioned and one-way.
test('CR1R-04 archive and restore', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    const archived = fx.repo.transitionConversation({ workspaceId: WS, conversationId: CONV, expectedVersion: 1, action: 'archive', changedAt: NOW2 });
    assert.equal(archived.status, 'archived');
    assert.equal(archived.version, 2);
    assert.equal(archived.archivedAt, NOW2);
    assert.throws(
      () => fx.repo.transitionConversation({ workspaceId: WS, conversationId: CONV, expectedVersion: 2, action: 'archive', changedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'CONVERSATION_NOT_TRANSITIONABLE'),
    );
    const restored = fx.repo.transitionConversation({ workspaceId: WS, conversationId: CONV, expectedVersion: 2, action: 'restore', changedAt: NOW2 });
    assert.equal(restored.status, 'active');
    assert.equal(restored.archivedAt, null);
  } finally { fx.close(); }
});

// CR1R-05 — archive does not cascade.
test('CR1R-05 archive does not delete messages', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    fx.repo.appendMessage(messageInput());
    // Appending a message bumps the Conversation version.
    fx.repo.transitionConversation({ workspaceId: WS, conversationId: CONV, expectedVersion: 2, action: 'archive', changedAt: NOW2 });
    assert.equal(fx.repo.listMessages(WS, CONV).length, 1);
  } finally { fx.close(); }
});

// CR1R-06 — members are unique and listed.
test('CR1R-06 member management', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'group', title: 'G', replyMode: 'sequential', createdAt: NOW });
    fx.repo.addMember({ id: 'mem_1', conversationId: CONV, workspaceId: WS, subjectType: 'agent', subjectId: 'agent_1', displayNameSnapshot: 'A', role: 'participant', replyMode: 'always', joinedAt: NOW });
    assert.throws(
      () => fx.repo.addMember({ id: 'mem_2', conversationId: CONV, workspaceId: WS, subjectType: 'agent', subjectId: 'agent_1', displayNameSnapshot: 'A', role: 'participant', replyMode: 'always', joinedAt: NOW }),
      (e: unknown) => expectCode(e, 'PERSISTENCE_FAILED'),
    );
    assert.equal(fx.repo.listMembers(WS, CONV).length, 1);
  } finally { fx.close(); }
});

// CR1R-07 — messages get a transactional per-conversation sequence.
test('CR1R-07 message sequence is per-conversation', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    const first = fx.repo.appendMessage(messageInput());
    const second = fx.repo.appendMessage(messageInput());
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    const listed = fx.repo.listMessages(WS, CONV);
    assert.deepEqual(listed.map(m => m.sequence), [1, 2]);
    assert.deepEqual(fx.repo.listMessages(WS, CONV, 1).map(m => m.sequence), [2]);
  } finally { fx.close(); }
});

// CR1R-08 — repeated clientMessageId converges on one Message.
test('CR1R-08 client idempotency converges', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    const first = fx.repo.appendMessage(messageInput({ clientMessageId: 'c1' }));
    const second = fx.repo.appendMessage(messageInput({ clientMessageId: 'c1' }));
    assert.equal(second.id, first.id);
    assert.equal(second.sequence, first.sequence);
    assert.equal(fx.repo.listMessages(WS, CONV).length, 1);
  } finally { fx.close(); }
});

// CR1R-09 — agent message requires an agent id.
test('CR1R-09 agent message requires agent id', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    assert.throws(
      () => fx.repo.appendMessage(messageInput({ senderType: 'agent' })),
      (e: unknown) => expectCode(e, 'INPUT_INVALID'),
    );
    const ok = fx.repo.appendMessage(messageInput({ senderType: 'agent', senderAgentId: 'agent_1' }));
    assert.equal(ok.senderAgentId, 'agent_1');
  } finally { fx.close(); }
});

// CR1R-10 — message content edit appends a revision.
test('CR1R-10 edit message appends a revision', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    const original = fx.repo.appendMessage(messageInput({ content: 'first' }));
    const edited = fx.repo.editMessage({ workspaceId: WS, messageId: original.id, expectedVersion: 1, content: 'second', revisionId: 'rev_1', editedAt: NOW2 });
    assert.equal(edited.content, 'second');
    assert.equal(edited.status, 'edited');
    assert.equal(edited.version, 2);
    assert.equal(edited.sequence, original.sequence);
    const revisions = (fx.db.prepare('SELECT revision, content FROM cr_message_revisions WHERE message_id = ? ORDER BY revision ASC').all(original.id) as Array<{ revision: number; content: string }>)
      .map(row => ({ revision: row.revision, content: row.content }));
    assert.deepEqual(revisions, [{ revision: 1, content: 'second' }]);
  } finally { fx.close(); }
});

// CR1R-11 — stale edit version fails closed.
test('CR1R-11 stale edit version fails closed', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    const original = fx.repo.appendMessage(messageInput());
    assert.throws(
      () => fx.repo.editMessage({ workspaceId: WS, messageId: original.id, expectedVersion: 9, content: 'x', revisionId: 'rev_1', editedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'PERSISTENCE_FAILED'),
    );
  } finally { fx.close(); }
});

// CR1R-12 — source-event lookup supports idempotent projection.
test('CR1R-12 source event lookup', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    const message = fx.repo.appendMessage(messageInput({ sourceEventId: 'evt_1' }));
    assert.equal(fx.repo.findMessageBySourceEvent(WS, 'evt_1')?.id, message.id);
    assert.equal(fx.repo.findMessageBySourceEvent(WS, 'evt_missing'), undefined);
  } finally { fx.close(); }
});

// CR1R-13 — workspace scoping.
test('CR1R-13 reads are workspace-scoped', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    assert.equal(fx.repo.findConversationById('ws_other', CONV), undefined);
    assert.ok(fx.repo.findConversationById(WS, CONV) !== undefined);
  } finally { fx.close(); }
});

// CR1R-14 — invalid input fails closed.
test('CR1R-14 invalid input fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.repo.createConversation({ id: '', workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW }), (e: unknown) => expectCode(e, 'INPUT_INVALID'));
    assert.throws(() => fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'bogus' as never, title: 'D', createdAt: NOW }), (e: unknown) => expectCode(e, 'INPUT_INVALID'));
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    assert.throws(() => fx.repo.appendMessage(messageInput({ kind: 'bogus' as never })), (e: unknown) => expectCode(e, 'INPUT_INVALID'));
    assert.throws(() => fx.repo.appendMessage(messageInput({ conversationId: 'conv_missing' })), (e: unknown) => expectCode(e, 'CONVERSATION_NOT_FOUND'));
  } finally { fx.close(); }
});

// CR1R-15 — no secret value field is exposed.
test('CR1R-15 record exposes no secret value field', () => {
  const fx = fixture();
  try {
    fx.repo.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
    const message = fx.repo.appendMessage(messageInput());
    for (const forbidden of ['secret', 'token', 'password', 'credential']) {
      assert.ok(!Object.keys(message).includes(forbidden), forbidden);
    }
  } finally { fx.close(); }
});
