import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConversationRunResult } from '@agentos/agent-core';
import type { ConversationMessage } from '@agentos/shared';
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
import {
  MAX_FROZEN_HISTORY_MESSAGES,
  TURN_CONTEXT_STRATEGY_VERSION,
  createDurableTurnContextSnapshotPort,
  type TurnContextSnapshotPort,
  type ConversationTurnContextOptions,
} from './ConversationTurnDriver.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';

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

function fixture(
  emit?: (onEvent: (e: { status: string; activity: string; content?: string }) => void) => ConversationRunResult,
  context?: ConversationTurnContextOptions,
  beforeRunner?: (history: readonly ConversationMessage[]) => void,
) {
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
  const snapshots = new TurnContextSnapshotRepository(db as unknown as TransactionDatabase);
  const stream = new ConversationStreamService(db as unknown as TransactionDatabase, conversations, turns);
  const driver = new ConversationTurnDriver(
    conversations,
    stream,
    (_ws, agentId) => (agentId === 'agent_main' ? ({} as never) : undefined),
    (options) => ({
      run: async () => {
        beforeRunner?.(options.history);
        if (emit === undefined) return makeResult('completed', '');
        const onEvent = (e: { status: string; activity: string; content?: string }) => options.onEvent?.(e as never);
        return emit(onEvent);
      },
    }),
    context,
  );
  return {
    db, conversations, turns, snapshots, stream, driver,
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

/** LITE-09-101 fixture: real snapshot store plus a captured Provider history. */
function freezeFixture(historyCount: number, snapshots?: TurnContextSnapshotPort) {
  const root = mkdtempSync(join(tmpdir(), 'agentos-turndriver-freeze-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_dcux', 'C:/tmp/ws_dcux', NOW, NOW, NOW);
  const conversationDb = db as unknown as TransactionDatabase;
  const conversations = new ConversationRepository(conversationDb);
  conversations.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
  conversations.appendMessage({
    id: USER_MSG, conversationId: CONV, workspaceId: WS,
    senderType: 'user', kind: 'text', status: 'final', content: 'hello', createdAt: NOW,
  });
  for (let index = 0; index < historyCount; index += 1) {
    conversations.appendMessage({
      id: 'hist_' + String(index).padStart(22, '0'), conversationId: CONV, workspaceId: WS,
      senderType: index % 2 === 0 ? 'user' : 'agent', kind: 'text', status: 'final',
      ...(index % 2 === 0 ? {} : { senderAgentId: 'agent_main' }),
      content: 'history-' + index, createdAt: NOW,
    });
  }
  const turns = new AgentTurnRepository(conversationDb);
  const stream = new ConversationStreamService(conversationDb, conversations, turns);
  const seenHistory: string[][] = [];
  let snapshotRowsAtProviderCall = -1;
  const driver = new ConversationTurnDriver(
    conversations,
    stream,
    (_ws, agentId) => (agentId === 'agent_main' ? ({} as never) : undefined),
    (options) => ({
      run: async () => {
        snapshotRowsAtProviderCall = conversations.listMessages(WS, CONV).length >= 0
          ? (db.prepare('SELECT COUNT(*) AS n FROM cr_turn_context_snapshots').get() as { n: number }).n
          : -1;
        seenHistory.push([...options.history].map(message => message.content));
        return makeResult('completed', 'ok');
      },
    }),
    {
      snapshots: snapshots ?? createDurableTurnContextSnapshotPort({ getDatabase: () => conversationDb }),
      selection: {
        select: () => ({
          selectedEntryIds: ['mem_selected'],
          totalTokens: 42,
          truncated: false,
          retrievalStrategyVersion: TURN_CONTEXT_STRATEGY_VERSION,
        }),
      },
      contextTokenBudget: 4096,
    },
  );
  return {
    db, conversations, turns, seenHistory, driver,
    snapshotCount: () => (db.prepare('SELECT COUNT(*) AS n FROM cr_turn_context_snapshots').get() as { n: number }).n,
    snapshotRowsAtProviderCall: () => snapshotRowsAtProviderCall,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
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

test('LITE-09-101 TD-07 freezes a bounded history and persists its selector result before the Provider', async () => {
  const request = input();
  const expectedHistoryIds = Array.from({ length: 12 }, (_, index) => 'msg_hist_' + String(index + 2).padStart(2, '0'));
  let runnerSawSnapshot = false;
  let receivedHistory: readonly ConversationMessage[] = [];
  const fx = fixture(undefined, {
    snapshots: createDurableTurnContextSnapshotPort({ getDatabase: () => fx.db as unknown as TransactionDatabase }),
    selection: {
      select: ({ contextTokenBudget }) => {
        assert.equal(contextTokenBudget, 321);
        return { selectedEntryIds: ['mem_direct'], totalTokens: 7, truncated: true, retrievalStrategyVersion: TURN_CONTEXT_STRATEGY_VERSION };
      },
    },
    contextTokenBudget: 321,
  }, history => {
    receivedHistory = history;
    const turn = fx.turns.findTurnById(WS, request.turnId);
    assert.ok(turn?.contextSnapshotId);
    assert.ok(fx.snapshots.findById(WS, turn.contextSnapshotId));
    runnerSawSnapshot = true;
  });
  for (let index = 1; index <= 13; index += 1) {
    fx.conversations.appendMessage({
      id: 'msg_hist_' + String(index).padStart(2, '0'), conversationId: CONV, workspaceId: WS,
      senderType: 'user', kind: 'text', status: 'final', content: 'history-' + String(index), createdAt: NOW,
    });
  }
  try {
    const result = await fx.driver.replyWithTurn(request);
    assert.equal(result.status, 'completed');
    assert.equal(runnerSawSnapshot, true);
    assert.deepEqual(receivedHistory.map(message => message.id), expectedHistoryIds);
    assert.deepEqual(receivedHistory.map(message => message.content), expectedHistoryIds.map(id => 'history-' + Number(id.slice(-2))));

    assert.ok(result.turn.contextSnapshotId);
    const snapshot = fx.snapshots.findById(WS, result.turn.contextSnapshotId);
    assert.ok(snapshot);
    assert.equal(snapshot.interactionId, null);
    assert.equal(snapshot.turnId, request.turnId);
    assert.deepEqual(JSON.parse(snapshot.selectedEntryIdsJson), ['mem_direct']);
    const budget = JSON.parse(snapshot.budgetJson) as Record<string, unknown>;
    assert.equal(budget.contextTokenBudget, 321);
    assert.equal(budget.maxFrozenHistoryMessages, MAX_FROZEN_HISTORY_MESSAGES);
    assert.deepEqual(budget.frozenHistoryMessageIds, expectedHistoryIds);
    assert.equal(snapshot.retrievalStrategyVersion, TURN_CONTEXT_STRATEGY_VERSION);
    assert.equal(snapshot.totalTokens, 7);
    assert.equal(snapshot.truncated, true);
  } finally { fx.close(); }
});

test('LITE-09-101 TD-08 a context snapshot persistence failure fails the Turn without invoking the Provider', async () => {
  let runnerCalled = false;
  const failing: TurnContextSnapshotPort = { insert: () => { throw new Error('snapshot write failed'); } };
  const fx = fixture(undefined, { snapshots: failing }, () => { runnerCalled = true; });
  try {
    const result = await fx.driver.replyWithTurn(input());
    assert.equal(runnerCalled, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.turn.status, 'failed');
    assert.equal(result.turn.failureCode, 'CONTEXT_SNAPSHOT_FAILED');
    assert.equal(result.message.status, 'failed');
    assert.equal(result.message.content, '');
    assert.equal(result.checkpointCount, 0);
    assert.equal(fx.turns.listTurnsByConversation(WS, CONV).length, 1);
    assert.equal(fx.snapshots.findById(WS, result.turn.contextSnapshotId ?? ''), undefined);
  } finally { fx.close(); }
});

/** LITE-09-102: seed a Workspace admission row holding the modifying authority. */
function seedModifyingHolder(db: SqliteDb, workspaceId: string, mutationClass: 'MODIFYING' | 'READ_ONLY'): void {
  const runId = 'run_' + 'd'.repeat(26);
  db.prepare(
    'INSERT OR IGNORE INTO tasks (id, workspace_id, title, status, priority, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('task_' + 'e'.repeat(24), workspaceId, 'holder', 'open', 'normal', 'test', NOW, NOW);
  db.prepare(
    'INSERT OR IGNORE INTO runs (id, workspace_id, task_id, root_run_id, status, reason, origin, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(runId, workspaceId, 'task_' + 'e'.repeat(24), runId, 'running', 'initial', 'v2_api', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO workspace_admissions (id, workspace_id, subject_kind, canonical_run_id, legacy_run_id, requested_mutation_class, effective_mutation_class, enforcement_evidence_json, request_order, state, queue_reason, release_reason, requested_at, granted_at, released_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, 1, ?, NULL, NULL, ?, ?, NULL, ?, ?, 1)',
  ).run('adm_' + 'f'.repeat(26), workspaceId, 'CANONICAL_RUN', runId, mutationClass, mutationClass, 'GRANTED', NOW, NOW, NOW, NOW);
}

function workspaceAuthorityFrom(db: SqliteDb) {
  return {
    findModifyingHolder: (workspaceId: string) => {
      const row = db.prepare(
        "SELECT subject_kind AS subjectKind, canonical_run_id AS canonicalRunId, legacy_run_id AS legacyRunId, id FROM workspace_admissions WHERE workspace_id = ? AND effective_mutation_class = 'MODIFYING' AND state = 'GRANTED' ORDER BY request_order, id LIMIT 1",
      ).get(workspaceId) as { subjectKind: 'CANONICAL_RUN' | 'LEGACY_AGENT_RUN'; canonicalRunId: string | null; legacyRunId: string | null; id: string } | undefined;
      if (row === undefined) return undefined;
      return { subjectKind: row.subjectKind, subjectId: row.canonicalRunId ?? row.legacyRunId ?? row.id };
    },
  };
}

test('LITE-09-102 chat refuses while another subject holds the Workspace modifying authority', async () => {
  let runnerCalled = false;
  const fx = fixture(undefined, undefined, () => { runnerCalled = true; });
  seedModifyingHolder(fx.db, WS, 'MODIFYING');
  const driver = new ConversationTurnDriver(
    fx.conversations,
    fx.stream,
    (_ws, agentId) => (agentId === 'agent_main' ? ({} as never) : undefined),
    () => ({ run: async () => { runnerCalled = true; return makeResult('completed', 'should-not-run'); } }),
    { workspaceAuthority: workspaceAuthorityFrom(fx.db) },
  );
  try {
    const result = await driver.replyWithTurn(input());
    assert.equal(runnerCalled, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.turn.status, 'failed');
    assert.equal(result.turn.failureCode, 'CONVERSATION_WORKSPACE_MODIFYING_BUSY');
    assert.match(result.turn.failureMessage ?? '', /explicit Run/);
    assert.equal(result.message.status, 'failed');
    assert.equal(result.checkpointCount, 0);
  } finally { fx.close(); }
});

test('LITE-09-102 a READ_ONLY holder does not block chat and D3 parallel-read-only stays unavailable', async () => {
  const fx = fixture(undefined, { workspaceAuthority: undefined });
  seedModifyingHolder(fx.db, WS, 'READ_ONLY');
  const driver = new ConversationTurnDriver(
    fx.conversations,
    fx.stream,
    (_ws, agentId) => (agentId === 'agent_main' ? ({} as never) : undefined),
    () => ({ run: async () => makeResult('completed', 'ok') }),
    { workspaceAuthority: workspaceAuthorityFrom(fx.db) },
  );
  try {
    const result = await driver.replyWithTurn(input());
    assert.equal(result.status, 'completed');
    assert.equal(result.checkpointCount, 0);
  } finally { fx.close(); }
});
