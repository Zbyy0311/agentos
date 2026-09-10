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
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { ConversationRepository } from '../store/ConversationRepository.js';
import { AgentTurnRepository } from '../store/AgentTurnRepository.js';
import {
  ConversationStreamError,
  ConversationStreamService,
  type AppendStreamDeltaInput,
  type BeginAgentTurnStreamInput,
  type ConversationStreamErrorCode,
} from './ConversationStreamService.js';

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

const NOW = '2026-09-10T00:00:00.000Z';
const NOW2 = '2026-09-10T01:00:00.000Z';
const NOW3 = '2026-09-10T02:00:00.000Z';
const WS = 'ws_cr3s';
const CONV = 'conv_' + 'b'.repeat(26);
const CONV2 = 'conv_' + 'f'.repeat(26);
const USER_MSG = 'msg_' + 'c'.repeat(26);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr3-stream-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_cr3s', 'C:/tmp/ws_cr3s', NOW, NOW, NOW);
  const conversations = new ConversationRepository(db as unknown as TransactionDatabase);
  conversations.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
  conversations.createConversation({ id: CONV2, workspaceId: WS, kind: 'direct', title: 'D2', createdAt: NOW });
  conversations.appendMessage({
    id: USER_MSG, conversationId: CONV, workspaceId: WS,
    senderType: 'user', kind: 'text', status: 'final', content: 'hello', createdAt: NOW,
  });
  const turns = new AgentTurnRepository(db as unknown as TransactionDatabase);
  const service = new ConversationStreamService(db as unknown as TransactionDatabase, conversations, turns);
  return {
    db, conversations, turns, service,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

let seq = 0;
function reserveInput(overrides: Partial<BeginAgentTurnStreamInput> = {}): BeginAgentTurnStreamInput {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    workspaceId: WS,
    conversationId: CONV,
    turnId: 'turn_' + n + 'd'.repeat(20),
    messageId: 'msg_' + n + 'e'.repeat(20),
    agentId: 'agent_main',
    sourceMessageId: USER_MSG,
    createdAt: NOW,
    ...overrides,
  };
}

function deltaInput(
  handle: BeginAgentTurnStreamInput,
  delta: string,
  overrides: Partial<AppendStreamDeltaInput> = {},
): AppendStreamDeltaInput {
  return {
    workspaceId: WS,
    turnId: handle.turnId,
    messageId: handle.messageId,
    delta,
    createdAt: NOW2,
    ...overrides,
  };
}

function expectCode(code: ConversationStreamErrorCode, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof ConversationStreamError && error.code === code);
}

test('CR3S-01 begin reserves a streaming Message and Turn in one transaction', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    const handle = fx.service.beginAgentTurnStream(input);
    assert.equal(handle.message.status, 'streaming');
    assert.equal(handle.message.senderType, 'agent');
    assert.equal(handle.message.senderAgentId, input.agentId);
    assert.equal(handle.message.sequence, 2);
    assert.equal(handle.message.content, '');
    assert.equal(handle.turn.status, 'streaming');
    assert.equal(handle.turn.version, 2);
    assert.equal(handle.turn.conversationId, CONV);
    // Durable pair ownership: the Turn's Message IS the Message it streams into.
    assert.equal(handle.turn.sourceMessageId, input.messageId);
    assert.equal(handle.message.replyToMessageId, USER_MSG);
    assert.deepEqual(fx.conversations.listMessages(WS, CONV).map(m => m.id), [USER_MSG, input.messageId]);
    assert.equal(fx.conversations.findConversationById(WS, CONV)?.lastMessageId, input.messageId);
  } finally { fx.close(); }
});

test('CR3S-02 begin rejects an archived Conversation and writes nothing', () => {
  const fx = fixture();
  try {
    const before = fx.conversations.findConversationById(WS, CONV);
    assert.equal(before?.version, 2);
    fx.conversations.transitionConversation({
      workspaceId: WS, conversationId: CONV,
      expectedVersion: before?.version ?? 2, action: 'archive', changedAt: NOW2,
    });
    const input = reserveInput();
    expectCode('STREAM_CONVERSATION_ARCHIVED', () => fx.service.beginAgentTurnStream(input));
    assert.equal(fx.conversations.listMessages(WS, CONV).length, 1);
    assert.equal(fx.turns.listTurnsByConversation(WS, CONV).length, 0);
    assert.equal(fx.conversations.findConversationById(WS, CONV)?.status, 'archived');
    fx.conversations.transitionConversation({
      workspaceId: WS, conversationId: CONV,
      expectedVersion: fx.conversations.findConversationById(WS, CONV)?.version ?? 3,
      action: 'restore', changedAt: NOW3,
    });
    assert.equal(fx.service.beginAgentTurnStream(input).turn.status, 'streaming');
  } finally { fx.close(); }
});

test('CR3S-03 begin is idempotent for the same ids and rejects conflicting reuse', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    const first = fx.service.beginAgentTurnStream(input);
    const second = fx.service.beginAgentTurnStream(input);
    assert.equal(second.message.id, first.message.id);
    assert.equal(second.turn.id, first.turn.id);
    assert.equal(fx.conversations.listMessages(WS, CONV).length, 2);
    assert.equal(fx.turns.listTurnsByConversation(WS, CONV).length, 1);
    expectCode('STREAM_RESERVATION_CONFLICT', () => fx.service.beginAgentTurnStream({ ...input, conversationId: CONV2 }));
    assert.equal(fx.turns.listTurnsByConversation(WS, CONV2).length, 0);
    expectCode('STREAM_RESERVATION_CONFLICT', () => fx.service.beginAgentTurnStream({ ...input, turnId: input.turnId + 'x' }));
    assert.equal(fx.turns.listTurnsByConversation(WS, CONV).length, 1);
    assert.equal(fx.conversations.listMessages(WS, CONV).length, 2);
  } finally { fx.close(); }
});

test('CR3S-04 begin fails closed for unknown Conversations and invalid input', () => {
  const fx = fixture();
  try {
    expectCode('STREAM_CONVERSATION_NOT_FOUND', () => fx.service.beginAgentTurnStream(reserveInput({ conversationId: 'conv_missing' })));
    expectCode('STREAM_INPUT_INVALID', () => fx.service.beginAgentTurnStream(reserveInput({ agentId: '   ' })));
    assert.equal(fx.turns.listTurnsByConversation(WS, CONV).length, 0);
  } finally { fx.close(); }
});

test('CR3S-05 append assigns contiguous ordinals and a monotonic cursor', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    const handle = fx.service.beginAgentTurnStream(input);
    const first = fx.service.appendStreamDelta(deltaInput(input, 'Hel'));
    const second = fx.service.appendStreamDelta(deltaInput(input, 'lo'));
    assert.equal(first.checkpoint.ordinal, 1);
    assert.equal(first.checkpoint.cursor, 1);
    assert.equal(first.appended, true);
    assert.equal(second.checkpoint.ordinal, 2);
    assert.equal(second.checkpoint.cursor, 2);
    const stored = fx.turns.listCheckpointsByMessage(input.messageId, 0);
    assert.deepEqual(stored.map(c => c.ordinal), [1, 2]);
    assert.deepEqual(stored.map(c => c.cursor), [1, 2]);
    assert.equal(stored[0]?.turnId, handle.turn.id);
    assert.equal(stored[1]?.delta, 'lo');
  } finally { fx.close(); }
});

test('CR3S-06 a retried append with the same ordinal converges on one checkpoint', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    fx.service.beginAgentTurnStream(input);
    const first = fx.service.appendStreamDelta(deltaInput(input, 'hello', { ordinal: 1 }));
    const retry = fx.service.appendStreamDelta(deltaInput(input, 'hello', { ordinal: 1, createdAt: NOW3 }));
    assert.equal(first.appended, true);
    assert.equal(retry.appended, false);
    assert.equal(retry.checkpoint.id, first.checkpoint.id);
    assert.equal(retry.nextCursor, 1);
    assert.equal(fx.turns.listCheckpointsByMessage(input.messageId, 0).length, 1);
  } finally { fx.close(); }
});

test('CR3S-07 a reused ordinal or a lost durable checkpoint fails closed', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    fx.service.beginAgentTurnStream(input);
    fx.service.appendStreamDelta(deltaInput(input, 'hello', { ordinal: 1 }));
    expectCode('STREAM_APPEND_CONFLICT', () => fx.service.appendStreamDelta(deltaInput(input, 'HELLO', { ordinal: 1 })));
    expectCode('STREAM_APPEND_CONFLICT', () => fx.service.appendStreamDelta(deltaInput(input, 'hello!', { ordinal: 1 })));
    assert.equal(fx.turns.listCheckpointsByMessage(input.messageId, 0).length, 1);
    fx.service.appendStreamDelta(deltaInput(input, 'tail'));
    fx.db.prepare('DELETE FROM cr_message_checkpoints WHERE message_id = ? AND ordinal = 1').run(input.messageId);
    expectCode('STREAM_APPEND_STALE', () => fx.service.appendStreamDelta(deltaInput(input, 'hello', { ordinal: 1 })));
  } finally { fx.close(); }
});

test('CR3S-08 an ordinal gap is rejected and writes nothing', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    fx.service.beginAgentTurnStream(input);
    expectCode('STREAM_APPEND_GAP', () => fx.service.appendStreamDelta(deltaInput(input, 'x', { ordinal: 2 })));
    assert.equal(fx.turns.listCheckpointsByMessage(input.messageId, 0).length, 0);
    expectCode('STREAM_APPEND_GAP', () => fx.service.appendStreamDelta(deltaInput(input, 'x', { ordinal: 3 })));
    assert.equal(fx.turns.listCheckpointsByMessage(input.messageId, 0).length, 0);
    assert.equal(fx.service.appendStreamDelta(deltaInput(input, 'x', { ordinal: 1 })).appended, true);
  } finally { fx.close(); }
});

test('CR3S-09 appends without an ordinal are not deduplicated', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    fx.service.beginAgentTurnStream(input);
    fx.service.appendStreamDelta(deltaInput(input, 'a'));
    fx.service.appendStreamDelta(deltaInput(input, 'a'));
    assert.equal(fx.turns.listCheckpointsByMessage(input.messageId, 0).length, 2);
  } finally { fx.close(); }
});

test('CR3S-10 append fails closed for unknown ids, empty deltas, and invalid ordinals', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    fx.service.beginAgentTurnStream(input);
    expectCode('STREAM_INPUT_INVALID', () => fx.service.appendStreamDelta(deltaInput(input, '')));
    expectCode('STREAM_INPUT_INVALID', () => fx.service.appendStreamDelta(deltaInput(input, 'x', { ordinal: 0 })));
    expectCode('STREAM_INPUT_INVALID', () => fx.service.appendStreamDelta(deltaInput(input, 'x', { ordinal: 1.5 })));
    expectCode('STREAM_TURN_NOT_FOUND', () => fx.service.appendStreamDelta(deltaInput(input, 'x', { turnId: input.turnId + 'z' })));
    expectCode('STREAM_MESSAGE_NOT_FOUND', () => fx.service.appendStreamDelta(deltaInput(input, 'x', { messageId: input.messageId + 'z' })));
    const other = reserveInput({ conversationId: CONV2, sourceMessageId: undefined });
    const otherPair = fx.service.beginAgentTurnStream(other);
    expectCode('STREAM_LINK_MISMATCH', () => fx.service.appendStreamDelta(deltaInput(input, 'x', { messageId: otherPair.message.id, turnId: input.turnId })));
  } finally { fx.close(); }
});

test('CR3S-19 a foreign Turn cannot hijack a Message before its first checkpoint', () => {
  const fx = fixture();
  try {
    const first = reserveInput();
    const hijacker = reserveInput({ sourceMessageId: undefined });
    const firstHandle = fx.service.beginAgentTurnStream(first);
    const hijackHandle = fx.service.beginAgentTurnStream(hijacker);
    assert.equal(hijackHandle.turn.sourceMessageId, hijacker.messageId);
    // Turn B appending into Message A would otherwise own A's ordinal 1.
    expectCode('STREAM_LINK_MISMATCH', () => fx.service.appendStreamDelta({
      workspaceId: WS, turnId: hijacker.turnId, messageId: first.messageId,
      delta: 'FOREIGN', createdAt: NOW2,
    }));
    assert.equal(fx.turns.listCheckpointsByMessage(first.messageId, 0).length, 0);
    assert.equal(fx.turns.listCheckpointsByMessage(hijacker.messageId, 0).length, 0);
    // the rightful pair still works, and content never contains the foreign delta
    const own = fx.service.appendStreamDelta(deltaInput(first, 'OWN'));
    assert.equal(own.checkpoint.ordinal, 1);
    expectCode('STREAM_LINK_MISMATCH', () => fx.service.replayStream({
      workspaceId: WS, messageId: first.messageId, afterCursor: 0, turnId: hijacker.turnId,
    }));
    expectCode('STREAM_LINK_MISMATCH', () => fx.service.finalizeStream({
      workspaceId: WS, turnId: hijacker.turnId, messageId: first.messageId,
      expectedTurnVersion: hijackHandle.turn.version, expectedMessageVersion: firstHandle.message.version,
      outcome: 'final', updatedAt: NOW3,
    }));
    const replay = fx.service.replayStream({ workspaceId: WS, messageId: first.messageId, afterCursor: 0 });
    assert.deepEqual(replay.checkpoints.map(c => c.delta), ['OWN']);
  } finally { fx.close(); }
});

test('CR3S-20 a Turn that was not created by the stream seam cannot stream', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    // A Turn created directly through the repository has no Message binding.
    fx.turns.createTurn({
      id: input.turnId, conversationId: CONV, workspaceId: WS,
      agentId: 'agent_main', createdAt: NOW,
    });
    fx.turns.transitionTurn({ workspaceId: WS, turnId: input.turnId, expectedVersion: 1, to: 'streaming', updatedAt: NOW });
    fx.conversations.appendMessage({
      id: input.messageId, conversationId: CONV, workspaceId: WS,
      senderType: 'agent', senderAgentId: 'agent_main', kind: 'text',
      status: 'streaming', content: '', createdAt: NOW,
    });
    expectCode('STREAM_LINK_MISMATCH', () => fx.service.appendStreamDelta(deltaInput(input, 'x')));
    expectCode('STREAM_LINK_MISMATCH', () => fx.service.replayStream({ workspaceId: WS, messageId: input.messageId, afterCursor: 0, turnId: input.turnId }));
    expectCode('STREAM_LINK_MISMATCH', () => fx.service.finalizeStream({
      workspaceId: WS, turnId: input.turnId, messageId: input.messageId,
      expectedTurnVersion: 2, expectedMessageVersion: 1, outcome: 'final', updatedAt: NOW3,
    }));
    assert.equal(fx.turns.listCheckpointsByMessage(input.messageId, 0).length, 0);
  } finally { fx.close(); }
});

test('CR3S-11 replay returns the contiguous window after a cursor with current state', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    const handle = fx.service.beginAgentTurnStream(input);
    fx.service.appendStreamDelta(deltaInput(input, 'a'));
    fx.service.appendStreamDelta(deltaInput(input, 'b'));
    fx.service.appendStreamDelta(deltaInput(input, 'c'));
    const replay = fx.service.replayStream({ workspaceId: WS, messageId: input.messageId, afterCursor: 1 });
    assert.deepEqual(replay.checkpoints.map(c => c.ordinal), [2, 3]);
    assert.deepEqual(replay.checkpoints.map(c => c.delta), ['b', 'c']);
    assert.equal(replay.nextCursor, 3);
    assert.equal(replay.message.status, 'streaming');
    assert.equal(replay.turn?.id, handle.turn.id);
    assert.equal(replay.turn?.status, 'streaming');
    const empty = fx.service.replayStream({ workspaceId: WS, messageId: input.messageId, afterCursor: 3 });
    assert.equal(empty.checkpoints.length, 0);
    assert.equal(empty.nextCursor, 3);
    expectCode('STREAM_MESSAGE_NOT_FOUND', () => fx.service.replayStream({ workspaceId: WS, messageId: 'msg_missing', afterCursor: 0 }));
    expectCode('STREAM_INPUT_INVALID', () => fx.service.replayStream({ workspaceId: WS, messageId: input.messageId, afterCursor: -1 }));
  } finally { fx.close(); }
});

test('CR3S-12 replay fails closed when durable checkpoints are not contiguous', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    fx.service.beginAgentTurnStream(input);
    fx.service.appendStreamDelta(deltaInput(input, 'a'));
    fx.service.appendStreamDelta(deltaInput(input, 'b'));
    fx.service.appendStreamDelta(deltaInput(input, 'c'));
    fx.db.prepare('DELETE FROM cr_message_checkpoints WHERE message_id = ? AND ordinal = 2').run(input.messageId);
    expectCode('STREAM_REPLAY_GAP', () => fx.service.replayStream({ workspaceId: WS, messageId: input.messageId, afterCursor: 0 }));
    // Strict rule: a hole anywhere in the durable set is not reconstructable, even
    // when the requested window starts after it.
    expectCode('STREAM_REPLAY_GAP', () => fx.service.replayStream({ workspaceId: WS, messageId: input.messageId, afterCursor: 1 }));
    expectCode('STREAM_REPLAY_GAP', () => fx.service.replayStream({ workspaceId: WS, messageId: input.messageId, afterCursor: 2 }));
    fx.db.prepare('INSERT INTO cr_message_checkpoints (id, message_id, turn_id, ordinal, cursor, delta, created_at) VALUES (?, ?, ?, 2, 2, ?, ?)')
      .run('cp_restore', input.messageId, input.turnId, 'b', NOW2);
    const repaired = fx.service.replayStream({ workspaceId: WS, messageId: input.messageId, afterCursor: 1 });
    assert.deepEqual(repaired.checkpoints.map(c => c.ordinal), [2, 3]);
    assert.equal(repaired.nextCursor, 3);
  } finally { fx.close(); }
});

test('CR3S-13 finalize assembles the final Message from durable checkpoints', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    const handle = fx.service.beginAgentTurnStream(input);
    fx.service.appendStreamDelta(deltaInput(input, 'Hel'));
    fx.service.appendStreamDelta(deltaInput(input, 'lo '));
    fx.service.appendStreamDelta(deltaInput(input, 'world'));
    const settled = fx.service.finalizeStream({
      workspaceId: WS, turnId: input.turnId, messageId: input.messageId,
      expectedTurnVersion: handle.turn.version, expectedMessageVersion: handle.message.version,
      outcome: 'final', updatedAt: NOW3,
    });
    assert.equal(settled.message.status, 'final');
    assert.equal(settled.message.content, 'Hello world');
    assert.equal(settled.message.version, 2);
    assert.equal(settled.turn.status, 'final');
    assert.equal(settled.turn.completedAt, NOW3);
    const replay = fx.service.replayStream({ workspaceId: WS, messageId: input.messageId, afterCursor: 0 });
    assert.equal(replay.turn?.status, 'final');
    assert.equal(replay.message.content, 'Hello world');
  } finally { fx.close(); }
});

test('CR3S-14 finalize(failed) records the failure on the Turn and fails the Message', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    const handle = fx.service.beginAgentTurnStream(input);
    fx.service.appendStreamDelta(deltaInput(input, 'partial'));
    const settled = fx.service.finalizeStream({
      workspaceId: WS, turnId: input.turnId, messageId: input.messageId,
      expectedTurnVersion: handle.turn.version, expectedMessageVersion: handle.message.version,
      outcome: 'failed', failureCode: 'PROVIDER_TIMEOUT', failureMessage: 'provider stream timed out',
      updatedAt: NOW3,
    });
    assert.equal(settled.turn.status, 'failed');
    assert.equal(settled.turn.failureCode, 'PROVIDER_TIMEOUT');
    assert.equal(settled.turn.failureMessage, 'provider stream timed out');
    assert.equal(settled.turn.completedAt, NOW3);
    assert.equal(settled.message.status, 'failed');
    assert.equal(settled.message.content, 'partial');
  } finally { fx.close(); }
});

test('CR3S-15 finalize(cancelled) maps the Message to failed and repeats converge', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    const handle = fx.service.beginAgentTurnStream(input);
    const request = {
      workspaceId: WS, turnId: input.turnId, messageId: input.messageId,
      expectedTurnVersion: handle.turn.version, expectedMessageVersion: handle.message.version,
      outcome: 'cancelled' as const, updatedAt: NOW3,
    };
    const settled = fx.service.finalizeStream(request);
    assert.equal(settled.turn.status, 'cancelled');
    assert.equal(settled.message.status, 'failed');
    const repeat = fx.service.finalizeStream(request);
    assert.equal(repeat.turn.status, 'cancelled');
    assert.equal(repeat.message.status, 'failed');
    expectCode('STREAM_FINALIZE_CONFLICT', () => fx.service.finalizeStream({ ...request, outcome: 'final' }));
  } finally { fx.close(); }
});

test('CR3S-16 finalize rejects stale optimistic versions without writing', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    const handle = fx.service.beginAgentTurnStream(input);
    fx.service.appendStreamDelta(deltaInput(input, 'x'));
    expectCode('STREAM_FINALIZE_CONFLICT', () => fx.service.finalizeStream({
      workspaceId: WS, turnId: input.turnId, messageId: input.messageId,
      expectedTurnVersion: 1, expectedMessageVersion: handle.message.version,
      outcome: 'final', updatedAt: NOW3,
    }));
    assert.equal(fx.turns.findTurnById(WS, input.turnId)?.status, 'streaming');
    assert.equal(fx.conversations.findMessageById(WS, input.messageId)?.status, 'streaming');
    expectCode('STREAM_FINALIZE_CONFLICT', () => fx.service.finalizeStream({
      workspaceId: WS, turnId: input.turnId, messageId: input.messageId,
      expectedTurnVersion: handle.turn.version, expectedMessageVersion: 9,
      outcome: 'final', updatedAt: NOW3,
    }));
    assert.equal(fx.turns.findTurnById(WS, input.turnId)?.status, 'streaming');
  } finally { fx.close(); }
});

test('CR3S-17 append after finalize fails closed while an exact retry converges', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    const handle = fx.service.beginAgentTurnStream(input);
    fx.service.appendStreamDelta(deltaInput(input, 'done', { ordinal: 1 }));
    fx.service.finalizeStream({
      workspaceId: WS, turnId: input.turnId, messageId: input.messageId,
      expectedTurnVersion: handle.turn.version, expectedMessageVersion: handle.message.version,
      outcome: 'final', updatedAt: NOW3,
    });
    expectCode('STREAM_NOT_ACTIVE', () => fx.service.appendStreamDelta(deltaInput(input, 'more')));
    expectCode('STREAM_NOT_ACTIVE', () => fx.service.appendStreamDelta(deltaInput(input, 'more', { ordinal: 2 })));
    const retry = fx.service.appendStreamDelta(deltaInput(input, 'done', { ordinal: 1 }));
    assert.equal(retry.appended, false);
    assert.equal(fx.turns.listCheckpointsByMessage(input.messageId, 0).length, 1);
  } finally { fx.close(); }
});

test('CR3S-18 within-transaction variants compose and roll back atomically', () => {
  const fx = fixture();
  try {
    const input = reserveInput();
    inTransaction(fx.db, () => {
      fx.service.beginAgentTurnStreamWithinTransaction(input);
      fx.service.appendStreamDeltaWithinTransaction(deltaInput(input, 'a', { ordinal: 1 }));
    });
    assert.equal(fx.turns.listCheckpointsByMessage(input.messageId, 0).length, 1);
    const doomed = reserveInput();
    assert.throws(() => inTransaction(fx.db, () => {
      fx.service.beginAgentTurnStreamWithinTransaction(doomed);
      fx.service.appendStreamDeltaWithinTransaction(deltaInput(doomed, 'b', { ordinal: 5 }));
    }));
    assert.equal(fx.conversations.listMessages(WS, CONV).length, 2);
    assert.equal(fx.turns.listTurnsByConversation(WS, CONV).length, 1);
    assert.equal(fx.turns.listCheckpointsByMessage(doomed.messageId, 0).length, 0);
    assert.equal(fx.turns.findTurnById(WS, doomed.turnId)?.id, undefined);
  } finally { fx.close(); }
});
