import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_CONVERSATION_PROJECTOR_ID } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { ConversationRepository } from '../store/ConversationRepository.js';
import {
  MessageProjectionRepository,
  MessageProjectionRepositoryError,
} from '../store/MessageProjectionRepository.js';
import {
  ConversationProjectionError,
  ConversationProjectionService,
  type ProjectConversationEventInput,
  type ConversationProjectionErrorCode,
} from './ConversationProjectionService.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-09-10T00:00:00.000Z';
const NOW2 = '2026-09-10T01:00:00.000Z';
const WS = 'ws_cr4p';
const CONV = 'conv_' + 'b'.repeat(26);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr4-proj-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_cr4p', 'C:/tmp/ws_cr4p', NOW, NOW, NOW);
  const conversations = new ConversationRepository(db as unknown as TransactionDatabase);
  conversations.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
  const projections = new MessageProjectionRepository(db as unknown as TransactionDatabase);
  const service = new ConversationProjectionService(db as unknown as TransactionDatabase, conversations, projections);
  return {
    db, conversations, projections, service,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

let seq = 0;
function eventInput(overrides: Partial<ProjectConversationEventInput> = {}): ProjectConversationEventInput {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    workspaceId: WS,
    conversationId: CONV,
    sourceEventId: 'evt_' + n + 'a'.repeat(20),
    messageId: 'msg_' + n + 'b'.repeat(20),
    card: { senderType: 'system', kind: 'system-notice', content: 'Run started' },
    createdAt: NOW2,
    ...overrides,
  };
}

function countRows(db: SqliteDb, table: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n;
}

function expectCode(code: ConversationProjectionErrorCode, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof ConversationProjectionError && error.code === code);
}

test('CR4P-01 one Event projects exactly one card with a durable projection row', () => {
  const fx = fixture();
  try {
    const input = eventInput();
    const result = fx.service.projectEvent(input);
    assert.equal(result.created, true);
    assert.equal(result.message.status, 'final');
    assert.equal(result.message.senderType, 'system');
    assert.equal(result.message.kind, 'system-notice');
    assert.equal(result.message.content, 'Run started');
    assert.equal(result.message.sourceEventId, input.sourceEventId);
    assert.equal(result.message.sequence, 1);
    assert.equal(countRows(fx.db, 'cr_messages'), 1);
    assert.equal(countRows(fx.db, 'cr_message_projections'), 1);
    const saved = fx.projections.findByKey(WS, DEFAULT_CONVERSATION_PROJECTOR_ID, input.sourceEventId);
    assert.equal(saved?.messageId, result.message.id);
    // the Message itself also carries the source Event, so both lookups agree
    assert.equal(fx.conversations.findMessageBySourceEvent(WS, input.sourceEventId)?.id, result.message.id);
  } finally { fx.close(); }
});

test('CR4P-02 a retried projection converges on the existing card', () => {
  const fx = fixture();
  try {
    const input = eventInput();
    const first = fx.service.projectEvent(input);
    const retry = fx.service.projectEvent(input);
    const retryWithOtherMessageId = fx.service.projectEvent({ ...input, messageId: 'msg_' + 'z'.repeat(26) });
    assert.equal(retry.created, false);
    assert.equal(retry.message.id, first.message.id);
    assert.equal(retryWithOtherMessageId.created, false);
    assert.equal(retryWithOtherMessageId.message.id, first.message.id);
    assert.equal(countRows(fx.db, 'cr_messages'), 1);
    assert.equal(countRows(fx.db, 'cr_message_projections'), 1);
  } finally { fx.close(); }
});

test('CR4P-03 each projector keeps its own card for the same Event', () => {
  const fx = fixture();
  try {
    const input = eventInput();
    const first = fx.service.projectEvent(input);
    const other = fx.service.projectEvent({
      ...input, projectorId: 'conversation.run-card.v2', messageId: 'msg_' + 'y'.repeat(26),
    });
    assert.equal(first.created, true);
    assert.equal(other.created, true);
    assert.notEqual(other.message.id, first.message.id);
    assert.equal(countRows(fx.db, 'cr_message_projections'), 2);
    assert.equal(countRows(fx.db, 'cr_messages'), 2);
    assert.equal(fx.service.listProjections(WS, CONV).length, 2);
  } finally { fx.close(); }
});

test('CR4P-04 distinct Events project distinct ordered cards', () => {
  const fx = fixture();
  try {
    const a = fx.service.projectEvent(eventInput({ card: { senderType: 'system', kind: 'status', content: 'A' } }));
    const b = fx.service.projectEvent(eventInput({ card: { senderType: 'system', kind: 'status', content: 'B' } }));
    assert.equal(a.message.sequence, 1);
    assert.equal(b.message.sequence, 2);
    assert.equal(countRows(fx.db, 'cr_messages'), 2);
    assert.equal(fx.conversations.listMessages(WS, CONV).map(m => m.content).join(','), 'A,B');
  } finally { fx.close(); }
});

test('CR4P-05 projection fails closed for unknown Conversations and invalid input', () => {
  const fx = fixture();
  try {
    expectCode('PROJECTION_CONVERSATION_NOT_FOUND', () => fx.service.projectEvent(eventInput({ conversationId: 'conv_missing' })));
    expectCode('PROJECTION_INPUT_INVALID', () => fx.service.projectEvent(eventInput({ sourceEventId: '   ' })));
    expectCode('PROJECTION_INPUT_INVALID', () => fx.service.projectEvent(eventInput({
      card: { senderType: 'agent', kind: 'text', content: 'no agent id' },
    })));
    expectCode('PROJECTION_INPUT_INVALID', () => fx.service.projectEvent(eventInput({ projectorId: '' })));
    assert.equal(countRows(fx.db, 'cr_messages'), 0);
    assert.equal(countRows(fx.db, 'cr_message_projections'), 0);
  } finally { fx.close(); }
});

test('CR4P-06 a projection failure is reported, never propagated (Run isolation)', () => {
  const fx = fixture();
  try {
    const bad = fx.service.tryProjectEvent(eventInput({ conversationId: 'conv_missing' }));
    assert.equal(bad.ok, false);
    assert.equal((bad as { code: string }).code, 'PROJECTION_CONVERSATION_NOT_FOUND');
    const good = fx.service.tryProjectEvent(eventInput());
    assert.equal('message' in good, true);
    assert.equal(countRows(fx.db, 'cr_messages'), 1);
  } finally { fx.close(); }
});

test('CR4P-07 a projected card carries canonical references without inventing them', () => {
  const fx = fixture();
  try {
    const withRefs = fx.service.projectEvent(eventInput({
      card: {
        senderType: 'agent', senderAgentId: 'agent_main', kind: 'run-reference',
        content: 'Run queued', taskId: 'task_1', runId: 'run_1',
      },
    }));
    assert.equal(withRefs.message.senderAgentId, 'agent_main');
    assert.equal(withRefs.message.taskId, 'task_1');
    assert.equal(withRefs.message.runId, 'run_1');
    const plain = fx.service.projectEvent(eventInput());
    assert.equal(plain.message.taskId, null);
    assert.equal(plain.message.runId, null);
    assert.equal(plain.message.senderAgentId, null);
  } finally { fx.close(); }
});

test('CR4P-08 a duplicate projection key is detected and then converges', () => {
  const fx = fixture();
  try {
    const input = eventInput();
    const first = fx.service.projectEvent(input);
    // Simulate a racing projector that committed the same key first.
    assert.throws(
      () => fx.projections.insertWithinTransaction({
        id: 'proj_race', workspaceId: WS, conversationId: CONV,
        projectorId: DEFAULT_CONVERSATION_PROJECTOR_ID, sourceEventId: input.sourceEventId,
        messageId: first.message.id, createdAt: NOW2,
      }),
      (error: unknown) => error instanceof MessageProjectionRepositoryError && error.code === 'PROJECTION_KEY_CONFLICT',
    );
    const converged = fx.service.projectEvent({ ...input, messageId: 'msg_' + 'w'.repeat(26) });
    assert.equal(converged.created, false);
    assert.equal(converged.message.id, first.message.id);
    assert.equal(countRows(fx.db, 'cr_message_projections'), 1);
    assert.equal(countRows(fx.db, 'cr_messages'), 1);
  } finally { fx.close(); }
});

test('CR4P-09 within-transaction projection composes and rolls back atomically', () => {
  const fx = fixture();
  try {
    const input = eventInput();
    inTransaction(fx.db, () => {
      fx.service.projectEventWithinTransaction(input);
    });
    assert.equal(countRows(fx.db, 'cr_messages'), 1);
    assert.equal(countRows(fx.db, 'cr_message_projections'), 1);
    const doomed = eventInput();
    assert.throws(() => inTransaction(fx.db, () => {
      fx.service.projectEventWithinTransaction(doomed);
      throw new Error('boom');
    }));
    assert.equal(countRows(fx.db, 'cr_messages'), 1);
    assert.equal(countRows(fx.db, 'cr_message_projections'), 1);
    assert.equal(fx.conversations.findMessageBySourceEvent(WS, doomed.sourceEventId), undefined);
  } finally { fx.close(); }
});

test('CR4P-10 the projection table stores no secret value and is readable by message', () => {
  const fx = fixture();
  try {
    const result = fx.service.projectEvent(eventInput());
    const columns = (fx.db.prepare('PRAGMA table_info(cr_message_projections)').all() as Array<{ name: string }>)
      .map(column => column.name);
    assert.ok(!columns.some(name => /secret|token|password/i.test(name)));
    const byMessage = fx.projections.listByMessage(result.message.id);
    assert.equal(byMessage.length, 1);
    assert.equal(byMessage[0]?.sourceEventId, result.message.sourceEventId);
  } finally { fx.close(); }
});

