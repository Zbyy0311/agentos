import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConversationRunResult } from '@agentos/agent-core';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { ConversationRepository } from '../store/ConversationRepository.js';
import { AgentTurnRepository } from '../store/AgentTurnRepository.js';
import { ConversationStreamService } from './ConversationStreamService.js';
import { ConversationTurnDriver, ConversationTurnDriverError } from './ConversationTurnDriver.js';

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
const WS = 'ws_dcux';
const CONV = 'conv_' + 'b'.repeat(26);
const USER_MSG = 'msg_' + 'c'.repeat(26);

function makeResult(status: ConversationRunResult['status'], content: string): ConversationRunResult {
  return { status, content, mode: 'mock', startedAt: NOW, completedAt: NOW2 } as ConversationRunResult;
}

function fixture(emit?: (onEvent: (e: { status: string; activity: string; content?: string }) => void) => ConversationRunResult) {
  const root = mkdtempSync(join(tmpdir(), 'agentos-turndriver-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_dcux', 'C:/tmp/ws_dcux', NOW, NOW, NOW);
  const conversations = new ConversationRepository(db as unknown as TransactionDatabase);
  conversations.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
  conversations.appendMessage({
    id: USER_MSG, conversationId: CONV, workspaceId: WS,
    senderType: 'user', kind: 'text', status: 'final', content: 'hello', createdAt: NOW,
  });
  const turns = new AgentTurnRepository(db as unknown as TransactionDatabase);
  const stream = new ConversationStreamService(db as unknown as TransactionDatabase, conversations, turns);
  const driver = new ConversationTurnDriver(
    conversations,
    stream,
    (_ws, agentId) => (agentId === 'agent_main' ? ({} as never) : undefined),
    (options) => ({
      run: async () => {
        if (emit === undefined) return makeResult('completed', '');
        const onEvent = (e: { status: string; activity: string; content?: string }) => options.onEvent?.(e as never);
        return emit(onEvent);
      },
    }),
  );
  return {
    db, conversations, turns, stream, driver,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WS, workspaceRoot: 'C:/tmp/ws_dcux', conversationId: CONV, agentId: 'agent_main',
    sourceMessageId: USER_MSG, content: 'hello',
    turnId: 'turn_' + 'a'.repeat(20), responseMessageId: 'msg_' + 'b'.repeat(20),
    createdAt: NOW, ...overrides,
  };
}

test('TD-01 a completed reply streams every delta as a durable checkpoint and finalizes', async () => {
  const fx = fixture((emit) => {
    emit({ status: 'streaming_response', activity: '', content: 'Hel' });
    emit({ status: 'streaming_response', activity: '', content: 'lo ' });
    emit({ status: 'streaming_response', activity: '', content: 'world' });
    return makeResult('completed', 'Hello world');
  });
  try {
    const result = await fx.driver.replyWithTurn(input());
    assert.equal(result.status, 'completed');
    assert.equal(result.content, 'Hello world');
    assert.equal(result.message.status, 'final');
    assert.equal(result.turn.status, 'final');
    assert.equal(result.checkpointCount, 3);
    // the durable checkpoints replay in order from the cursor
    const replay = fx.stream.replayStream({ workspaceId: WS, messageId: 'msg_' + 'b'.repeat(20), afterCursor: 0 });
    assert.deepEqual(replay.checkpoints.map(c => c.delta), ['Hel', 'lo ', 'world']);
    assert.equal(replay.nextCursor, 3);
    // replay after a cursor returns only the tail
    const tail = fx.stream.replayStream({ workspaceId: WS, messageId: 'msg_' + 'b'.repeat(20), afterCursor: 1 });
    assert.deepEqual(tail.checkpoints.map(c => c.delta), ['lo ', 'world']);
    assert.equal(tail.nextCursor, 3);
  } finally { fx.close(); }
});

test('TD-02 a provider failure finalizes failed and preserves the checkpoints', async () => {
  const fx = fixture((emit) => {
    emit({ status: 'streaming_response', activity: '', content: 'partial' });
    return { ...makeResult('failed', ''), error: 'provider blew up' } as ConversationRunResult;
  });
  try {
    const result = await fx.driver.replyWithTurn(input());
    assert.equal(result.status, 'failed');
    assert.equal(result.turn.status, 'failed');
    assert.equal(result.turn.failureCode, 'PROVIDER_FAILED');
    assert.equal(result.message.status, 'failed');
    assert.equal(result.message.content, 'partial');
    assert.equal(result.checkpointCount, 1);
  } finally { fx.close(); }
});

test('TD-03 a cancelled reply finalizes the Turn cancelled and the Message failed', async () => {
  const fx = fixture(() => ({ ...makeResult('cancelled', ''), error: 'cancelled' } as ConversationRunResult));
  try {
    const result = await fx.driver.replyWithTurn(input());
    assert.equal(result.turn.status, 'cancelled');
    assert.equal(result.message.status, 'failed');
    assert.equal(result.turn.failureCode, 'TURN_CANCELLED');
  } finally { fx.close(); }
});

test('TD-04 an unknown Agent fails closed without reserving a stream', async () => {
  const fx = fixture(() => makeResult('completed', ''));
  try {
    await assert.rejects(
      fx.driver.replyWithTurn(input({ agentId: 'agent_missing' })),
      (error: unknown) => error instanceof ConversationTurnDriverError && error.code === 'TURN_DRIVER_AGENT_UNAVAILABLE',
    );
    assert.equal(fx.turns.listTurnsByConversation(WS, CONV).length, 0);
    assert.equal(fx.conversations.listMessages(WS, CONV).length, 1);
  } finally { fx.close(); }
});

test('TD-05 waiting_user finalizes the Turn final with the question as content', async () => {
  const fx = fixture(() => ({ ...makeResult('waiting_user', ''), waitingQuestion: 'which env?' } as ConversationRunResult));
  try {
    const result = await fx.driver.replyWithTurn(input());
    assert.equal(result.status, 'waiting_user');
    assert.equal(result.turn.status, 'final');
    assert.equal(result.message.status, 'final');
    assert.equal(result.message.content, 'which env?');
  } finally { fx.close(); }
});

test('TD-06 a runner crash finalizes failed instead of leaving an open stream', async () => {
  const fx = fixture();
  // replace the factory with a runner that throws
  const crashDriver = new ConversationTurnDriver(
    fx.conversations,
    fx.stream,
    () => ({} as never),
    () => ({ run: async () => { throw new Error('spawn failed'); } }),
  );
  try {
    const result = await crashDriver.replyWithTurn(input());
    assert.equal(result.turn.status, 'failed');
    assert.equal(result.turn.failureCode, 'PROVIDER_CRASH');
    assert.equal(result.message.status, 'failed');
  } finally { fx.close(); }
});

