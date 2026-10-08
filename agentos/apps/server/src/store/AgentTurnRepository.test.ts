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
import { ConversationRepository } from './ConversationRepository.js';
import {
  AgentTurnRepository,
  AgentTurnRepositoryError,
  type CreateAgentTurnInput,
  type AppendCheckpointInput,
} from './AgentTurnRepository.js';

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

const NOW = '2026-09-10T00:00:00.000Z';
const NOW2 = '2026-09-10T01:00:00.000Z';
const NOW3 = '2026-09-10T02:00:00.000Z';
const WS = 'ws_cr2r';
const CONV = 'conv_' + 'b'.repeat(26);
const MSG = 'msg_' + 'c'.repeat(26);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr2-repo-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_cr2r', 'C:/tmp/ws_cr2r', NOW, NOW, NOW);
  const conversations = new ConversationRepository(db as unknown as TransactionDatabase);
  conversations.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
  conversations.appendMessage({
    id: MSG, conversationId: CONV, workspaceId: WS,
    senderType: 'user', kind: 'text', status: 'final', content: 'hello', createdAt: NOW,
  });
  const repo = new AgentTurnRepository(db as unknown as TransactionDatabase);
  return { db, repo, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

let seq = 0;
function turnInput(overrides: Partial<CreateAgentTurnInput> = {}): CreateAgentTurnInput {
  seq += 1;
  return {
    id: 'turn_' + String(seq).padStart(4, '0') + 'd'.repeat(20),
    conversationId: CONV,
    workspaceId: WS,
    agentId: 'agent_main',
    sourceMessageId: MSG,
    createdAt: NOW,
    ...overrides,
  };
}

let ckSeq = 0;
function checkpointInput(turnId: string, overrides: Partial<AppendCheckpointInput> = {}): AppendCheckpointInput {
  ckSeq += 1;
  return {
    id: 'ck_' + String(ckSeq).padStart(4, '0') + 'e'.repeat(20),
    messageId: MSG,
    turnId,
    ordinal: ckSeq,
    cursor: ckSeq,
    delta: 'delta ' + ckSeq,
    createdAt: NOW,
    ...overrides,
  };
}

function expectCode(error: unknown, code: AgentTurnRepositoryError['code']): boolean {
  assert.ok(error instanceof AgentTurnRepositoryError);
  assert.equal(error.code, code);
  return true;
}

// CR2R-01 — create turn persists created status and version 1.
test('CR2R-01 create turn', () => {
  const fx = fixture();
  try {
    const input = turnInput();
    const turn = fx.repo.createTurn(input);
    assert.equal(turn.id, input.id);
    assert.equal(turn.conversationId, CONV);
    assert.equal(turn.workspaceId, WS);
    assert.equal(turn.agentId, 'agent_main');
    assert.equal(turn.sourceMessageId, MSG);
    assert.equal(turn.status, 'created');
    assert.equal(turn.version, 1);
    assert.equal(turn.completedAt, null);
    assert.equal(turn.failureCode, null);
    assert.equal(turn.taskId, null);
    assert.equal(turn.runId, null);
  } finally { fx.close(); }
});

// CR2R-02 — create rejects blank/missing required input.
test('CR2R-02 create rejects invalid input', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createTurn(turnInput({ id: '   ' })),
      (e: unknown) => expectCode(e, 'TURN_INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.createTurn(turnInput({ agentId: '' })),
      (e: unknown) => expectCode(e, 'TURN_INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.createTurn(turnInput({ createdAt: '' })),
      (e: unknown) => expectCode(e, 'TURN_INPUT_INVALID'),
    );
  } finally { fx.close(); }
});

// CR2R-03 — create fails closed for an unknown conversation.
test('CR2R-03 unknown conversation fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createTurn(turnInput({ conversationId: 'conv_missing' })),
      (e: unknown) => expectCode(e, 'TURN_INPUT_INVALID'),
    );
    assert.equal(fx.repo.listTurnsByConversation(WS, CONV).length, 0);
  } finally { fx.close(); }
});

// CR2R-04 — find/list are workspace scoped.
test('CR2R-04 find and list turns', () => {
  const fx = fixture();
  try {
    const a = fx.repo.createTurn(turnInput());
    const b = fx.repo.createTurn(turnInput({ createdAt: NOW2 }));
    const found = fx.repo.findTurnById(WS, a.id);
    assert.equal(found?.id, a.id);
    assert.equal(fx.repo.findTurnById('ws_other', a.id), undefined);
    const listed = fx.repo.listTurnsByConversation(WS, CONV);
    assert.deepEqual(listed.map(t => t.id), [a.id, b.id]);
    assert.deepEqual(fx.repo.listTurnsByConversation('ws_other', CONV), []);
    assert.deepEqual(fx.repo.listTurnsByConversation(WS, ''), []);
  } finally { fx.close(); }
});

// CR2R-05 — created -> streaming -> final with optimistic version.
test('CR2R-05 transition to final', () => {
  const fx = fixture();
  try {
    const turn = fx.repo.createTurn(turnInput());
    const streaming = fx.repo.transitionTurn({
      workspaceId: WS, turnId: turn.id, expectedVersion: 1, to: 'streaming',
      providerSessionId: 'ps_1', updatedAt: NOW2,
    });
    assert.equal(streaming.status, 'streaming');
    assert.equal(streaming.version, 2);
    assert.equal(streaming.providerSessionId, 'ps_1');
    assert.equal(streaming.completedAt, null);
    const finalTurn = fx.repo.transitionTurn({
      workspaceId: WS, turnId: turn.id, expectedVersion: 2, to: 'final',
      taskId: 'task_1', runId: 'run_1', updatedAt: NOW3,
    });
    assert.equal(finalTurn.status, 'final');
    assert.equal(finalTurn.version, 3);
    assert.equal(finalTurn.taskId, 'task_1');
    assert.equal(finalTurn.runId, 'run_1');
    assert.equal(finalTurn.completedAt, NOW3);
  } finally { fx.close(); }
});

// CR2R-06 — failed terminal status carries failure code/message and completed_at.
test('CR2R-06 transition to failed', () => {
  const fx = fixture();
  try {
    const turn = fx.repo.createTurn(turnInput());
    const failed = fx.repo.transitionTurn({
      workspaceId: WS, turnId: turn.id, expectedVersion: 1, to: 'failed',
      failureCode: 'PROVIDER_ERROR', failureMessage: 'boom', updatedAt: NOW2,
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureCode, 'PROVIDER_ERROR');
    assert.equal(failed.failureMessage, 'boom');
    assert.equal(failed.completedAt, NOW2);
  } finally { fx.close(); }
});

// CR2R-07 — stale expected version is rejected.
test('CR2R-07 optimistic concurrency rejects stale version', () => {
  const fx = fixture();
  try {
    const turn = fx.repo.createTurn(turnInput());
    assert.throws(
      () => fx.repo.transitionTurn({ workspaceId: WS, turnId: turn.id, expectedVersion: 99, to: 'streaming', updatedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'TURN_NOT_TRANSITIONABLE'),
    );
    assert.equal(fx.repo.findTurnById(WS, turn.id)?.status, 'created');
  } finally { fx.close(); }
});

// CR2R-08 — terminal turns are not transitionable.
test('CR2R-08 terminal turn is not transitionable', () => {
  const fx = fixture();
  try {
    const turn = fx.repo.createTurn(turnInput());
    fx.repo.transitionTurn({ workspaceId: WS, turnId: turn.id, expectedVersion: 1, to: 'cancelled', updatedAt: NOW2 });
    assert.throws(
      () => fx.repo.transitionTurn({ workspaceId: WS, turnId: turn.id, expectedVersion: 2, to: 'streaming', updatedAt: NOW3 }),
      (e: unknown) => expectCode(e, 'TURN_NOT_TRANSITIONABLE'),
    );
  } finally { fx.close(); }
});

// CR2R-09 — invalid transition input and unknown turn fail closed.
test('CR2R-09 invalid transition input and unknown turn', () => {
  const fx = fixture();
  try {
    const turn = fx.repo.createTurn(turnInput());
    assert.throws(
      () => fx.repo.transitionTurn({ workspaceId: WS, turnId: turn.id, expectedVersion: 0, to: 'streaming', updatedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'TURN_INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.transitionTurn({ workspaceId: WS, turnId: turn.id, expectedVersion: 1, to: 'bogus' as never, updatedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'TURN_INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.transitionTurn({ workspaceId: WS, turnId: 'turn_missing', expectedVersion: 1, to: 'streaming', updatedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'TURN_NOT_FOUND'),
    );
    assert.throws(
      () => fx.repo.transitionTurn({ workspaceId: 'ws_other', turnId: turn.id, expectedVersion: 1, to: 'streaming', updatedAt: NOW2 }),
      (e: unknown) => expectCode(e, 'TURN_NOT_FOUND'),
    );
  } finally { fx.close(); }
});

// CR2R-10 — streaming cannot go back to created; same-status no-op rejected.
test('CR2R-10 backwards and same-status transitions rejected', () => {
  const fx = fixture();
  try {
    const turn = fx.repo.createTurn(turnInput());
    fx.repo.transitionTurn({ workspaceId: WS, turnId: turn.id, expectedVersion: 1, to: 'streaming', updatedAt: NOW2 });
    assert.throws(
      () => fx.repo.transitionTurn({ workspaceId: WS, turnId: turn.id, expectedVersion: 2, to: 'created', updatedAt: NOW3 }),
      (e: unknown) => expectCode(e, 'TURN_NOT_TRANSITIONABLE'),
    );
    assert.throws(
      () => fx.repo.transitionTurn({ workspaceId: WS, turnId: turn.id, expectedVersion: 2, to: 'streaming', updatedAt: NOW3 }),
      (e: unknown) => expectCode(e, 'TURN_NOT_TRANSITIONABLE'),
    );
  } finally { fx.close(); }
});

// CR2R-11 — append checkpoint persists and lists in ordinal order with cursor resume.
test('CR2R-11 checkpoints append and resume by cursor', () => {
  const fx = fixture();
  try {
    const turn = fx.repo.createTurn(turnInput());
    const ck1 = fx.repo.appendCheckpoint(checkpointInput(turn.id, { ordinal: 1, cursor: 1 }));
    const ck2 = fx.repo.appendCheckpoint(checkpointInput(turn.id, { ordinal: 2, cursor: 2 }));
    const ck3 = fx.repo.appendCheckpoint(checkpointInput(turn.id, { ordinal: 3, cursor: 3 }));
    assert.equal(ck1.ordinal, 1);
    const all = fx.repo.listCheckpointsByMessage(MSG);
    assert.deepEqual(all.map(c => c.id), [ck1.id, ck2.id, ck3.id]);
    const resumed = fx.repo.listCheckpointsByMessage(MSG, 1);
    assert.deepEqual(resumed.map(c => c.id), [ck2.id, ck3.id]);
    const byTurn = fx.repo.listCheckpointsByTurn(turn.id);
    assert.deepEqual(byTurn.map(c => c.id), [ck1.id, ck2.id, ck3.id]);
    assert.deepEqual(fx.repo.listCheckpointsByTurn('turn_missing'), []);
    assert.deepEqual(fx.repo.listCheckpointsByMessage(''), []);
  } finally { fx.close(); }
});

// CR2R-12 — duplicate (message, ordinal) is rejected and nothing partial persists.
test('CR2R-12 duplicate checkpoint ordinal rejected', () => {
  const fx = fixture();
  try {
    const turn = fx.repo.createTurn(turnInput());
    fx.repo.appendCheckpoint(checkpointInput(turn.id, { ordinal: 1, cursor: 1 }));
    assert.throws(
      () => fx.repo.appendCheckpoint(checkpointInput(turn.id, { ordinal: 1, cursor: 2 })),
      (e: unknown) => expectCode(e, 'CHECKPOINT_ORDINAL_CONFLICT'),
    );
    assert.equal(fx.repo.listCheckpointsByTurn(turn.id).length, 1);
  } finally { fx.close(); }
});

// CR2R-13 — invalid checkpoint input fails closed.
test('CR2R-13 invalid checkpoint input rejected', () => {
  const fx = fixture();
  try {
    const turn = fx.repo.createTurn(turnInput());
    assert.throws(
      () => fx.repo.appendCheckpoint(checkpointInput(turn.id, { ordinal: 0 })),
      (e: unknown) => expectCode(e, 'CHECKPOINT_INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.appendCheckpoint(checkpointInput(turn.id, { cursor: -1 })),
      (e: unknown) => expectCode(e, 'CHECKPOINT_INPUT_INVALID'),
    );
    assert.throws(
      () => fx.repo.appendCheckpoint(checkpointInput(turn.id, { messageId: ' ' })),
      (e: unknown) => expectCode(e, 'CHECKPOINT_INPUT_INVALID'),
    );
  } finally { fx.close(); }
});

// CR2R-14 — checkpoint referencing a missing turn violates FK and fails closed.
test('CR2R-14 checkpoint with unknown turn fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.appendCheckpoint(checkpointInput('turn_missing', { ordinal: 1, cursor: 1 })),
      (e: unknown) => expectCode(e, 'CHECKPOINT_PERSISTENCE_FAILED'),
    );
  } finally { fx.close(); }
});
