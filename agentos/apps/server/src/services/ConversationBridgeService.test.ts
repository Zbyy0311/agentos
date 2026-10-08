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
import { TaskRepository } from '../store/TaskRepository.js';
import { RunRepository } from '../store/RunRepository.js';
import { WorkspaceAdmissionRepository } from '../store/WorkspaceAdmissionRepository.js';
import {
  ConversationBridgeError,
  ConversationBridgeService,
  deriveTaskTitleFromMessage,
  type CreateTaskFromMessageInput,
  type ConversationBridgeErrorCode,
  type StartRunFromMessageInput,
} from './ConversationBridgeService.js';

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
const WS = 'ws_cr4b';
const CONV = 'conv_' + 'b'.repeat(26);
const USER_MSG = 'msg_' + 'c'.repeat(26);
const AGENT_MSG = 'msg_' + 'd'.repeat(26);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-cr4-bridge-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_cr4b', 'C:/tmp/ws_cr4b', NOW, NOW, NOW);
  const conversations = new ConversationRepository(db as unknown as TransactionDatabase);
  conversations.createConversation({ id: CONV, workspaceId: WS, kind: 'direct', title: 'D', createdAt: NOW });
  conversations.appendMessage({
    id: USER_MSG, conversationId: CONV, workspaceId: WS,
    senderType: 'user', kind: 'text', status: 'final', content: 'please plan the release', createdAt: NOW,
  });
  const tasks = new TaskRepository(db as unknown as TransactionDatabase);
  const runs = new RunRepository(db as unknown as TransactionDatabase);
  const admissions = new WorkspaceAdmissionRepository(db as unknown as TransactionDatabase);
  const bridge = new ConversationBridgeService(
    db as unknown as TransactionDatabase, conversations, tasks, runs, admissions,
  );
  return {
    db, conversations, tasks, runs, admissions, bridge,
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

function createTaskInput(overrides: Partial<CreateTaskFromMessageInput> = {}): CreateTaskFromMessageInput {
  return { workspaceId: WS, messageId: USER_MSG, createdBy: 'user_1', createdAt: NOW2, ...overrides };
}

function startRunInput(overrides: Partial<StartRunFromMessageInput> = {}): StartRunFromMessageInput {
  return { workspaceId: WS, messageId: USER_MSG, createdBy: 'user_1', objective: 'ship it', createdAt: NOW2, ...overrides };
}

function expectCode(code: ConversationBridgeErrorCode, fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof ConversationBridgeError && error.code === code);
}

function countRows(db: SqliteDb, table: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n;
}

test('CR4B-01 create-task creates exactly one Task and binds it to the Message', () => {
  const fx = fixture();
  try {
    const result = fx.bridge.createTaskFromMessage(createTaskInput());
    assert.equal(result.created, true);
    assert.equal(result.task.id.startsWith('task_'), true);
    assert.equal(result.task.status, 'open');
    assert.equal(result.task.sourceConversationId, CONV);
    assert.equal(result.task.sourceMessageId, USER_MSG);
    assert.equal(result.task.createdBy, 'user_1');
    assert.equal(result.message.taskId, result.task.id);
    assert.equal(result.message.runId, null);
    assert.equal(result.message.version, 2);
    assert.equal(countRows(fx.db, 'tasks'), 1);
    assert.equal(countRows(fx.db, 'runs'), 0);
    assert.equal(fx.runs.findById(WS, 'run_absent'), undefined);
  } finally { fx.close(); }
});

test('CR4B-02 create-task is idempotent across retries and starts nothing', () => {
  const fx = fixture();
  try {
    const first = fx.bridge.createTaskFromMessage(createTaskInput());
    const second = fx.bridge.createTaskFromMessage(createTaskInput());
    const third = fx.bridge.createTaskFromMessage(createTaskInput({ title: 'different title' }));
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(third.created, false);
    assert.equal(second.task.id, first.task.id);
    assert.equal(third.task.id, first.task.id);
    assert.equal(countRows(fx.db, 'tasks'), 1);
    assert.equal(countRows(fx.db, 'runs'), 0);
    assert.equal(fx.conversations.findMessageById(WS, USER_MSG)?.version, 2);
  } finally { fx.close(); }
});

test('CR4B-03 create-task fails closed for unknown ids and invalid input', () => {
  const fx = fixture();
  try {
    expectCode('BRIDGE_MESSAGE_NOT_FOUND', () => fx.bridge.createTaskFromMessage(createTaskInput({ messageId: 'msg_missing' })));
    expectCode('BRIDGE_INPUT_INVALID', () => fx.bridge.createTaskFromMessage(createTaskInput({ createdBy: '   ' })));
    expectCode('BRIDGE_INPUT_INVALID', () => fx.bridge.createTaskFromMessage(createTaskInput({ priority: 'urgent' as never })));
    assert.equal(countRows(fx.db, 'tasks'), 0);
    assert.equal(fx.admissions.listByWorkspace(WS).length, 0);
  } finally { fx.close(); }
});

test('CR4B-04 derived titles are deterministic and bounded', () => {
  const fx = fixture();
  try {
    assert.equal(deriveTaskTitleFromMessage('hello world'), 'hello world');
    assert.equal(deriveTaskTitleFromMessage('  spaced\n\nsecond line'), 'spaced');
    assert.equal(deriveTaskTitleFromMessage('   '), 'Conversation task');
    assert.equal(deriveTaskTitleFromMessage('x'.repeat(300)).length, 120);
    const fx2 = fixture();
    try {
      const result = fx2.bridge.createTaskFromMessage(createTaskInput());
      assert.equal(result.task.title, 'please plan the release');
    } finally { fx2.close(); }
  } finally { fx.close(); }
});

test('CR4B-05 start-run resolves the Task, creates one queued canonical Run, and binds both references', () => {
  const fx = fixture();
  try {
    const result = fx.bridge.startRunFromMessage(startRunInput());
    assert.equal(result.runCreated, true);
    assert.equal(result.taskCreated, true);
    assert.equal(result.run.id.startsWith('run_'), true);
    assert.equal(result.run.status, 'queued');
    assert.equal(result.run.origin, 'v2_api');
    assert.equal(result.run.reason, 'initial');
    assert.equal(result.run.taskId, result.task.id);
    assert.equal(result.run.objective, 'ship it');
    assert.equal(result.message.taskId, result.task.id);
    assert.equal(result.message.runId, result.run.id);
    assert.equal(result.message.version, 2);
    assert.equal(countRows(fx.db, 'tasks'), 1);
    assert.equal(countRows(fx.db, 'runs'), 1);
  } finally { fx.close(); }
});

test('CR4B-06 start-run converges on the same Run for a retried call', () => {
  const fx = fixture();
  try {
    const first = fx.bridge.startRunFromMessage(startRunInput());
    const second = fx.bridge.startRunFromMessage(startRunInput({ objective: 'something else' }));
    assert.equal(second.runCreated, false);
    assert.equal(second.taskCreated, false);
    assert.equal(second.run.id, first.run.id);
    assert.equal(second.task.id, first.task.id);
    assert.equal(second.run.objective, 'ship it');
    assert.equal(countRows(fx.db, 'runs'), 1);
    assert.equal(countRows(fx.db, 'tasks'), 1);
    assert.equal(fx.conversations.findMessageById(WS, USER_MSG)?.version, 2);
  } finally { fx.close(); }
});

test('CR4B-07 start-run reuses a Task created by create-task', () => {
  const fx = fixture();
  try {
    const task = fx.bridge.createTaskFromMessage(createTaskInput());
    const run = fx.bridge.startRunFromMessage(startRunInput());
    assert.equal(run.taskCreated, false);
    assert.equal(run.task.id, task.task.id);
    assert.equal(run.run.taskId, task.task.id);
    assert.equal(countRows(fx.db, 'tasks'), 1);
    assert.equal(countRows(fx.db, 'runs'), 1);
    assert.equal(fx.conversations.findMessageById(WS, USER_MSG)?.version, 3);
  } finally { fx.close(); }
});

test('CR4B-08 start-run reports the observed admission state, never a granted one', () => {
  const fx = fixture();
  try {
    const result = fx.bridge.startRunFromMessage(startRunInput({ requestedIntent: 'READ_ONLY' }));
    assert.equal(result.admission.requestedIntent, 'READ_ONLY');
    assert.equal(result.admission.admissionState, null);
    assert.equal(result.admission.effectiveMutationClass, null);
    assert.equal(result.admission.hasEnforcementEvidence, false);
    assert.equal(fx.admissions.listByWorkspace(WS).length, 0);
  } finally { fx.close(); }
});

test('CR4B-09 a durable GRANTED admission is reported as effective class and evidence', () => {
  const fx = fixture();
  try {
    const started = fx.bridge.startRunFromMessage(startRunInput());
    fx.admissions.insertAdmission({
      id: 'grant_01', workspaceId: WS, subjectKind: 'CANONICAL_RUN',
      canonicalRunId: started.run.id, legacyRunId: null,
      requestedMutationClass: 'READ_ONLY', effectiveMutationClass: 'READ_ONLY',
      enforcementEvidenceJson: JSON.stringify({ kind: 'adapter-denial', tested: true }),
      requestOrder: 1, state: 'GRANTED', queueReason: null, releaseReason: null,
      requestedAt: NOW, grantedAt: NOW2, releasedAt: null, createdAt: NOW, updatedAt: NOW2, version: 1,
    });
    const report = fx.bridge.reportAdmission(WS, started.run.id, 'MODIFYING');
    assert.equal(report.admissionState, 'GRANTED');
    assert.equal(report.effectiveMutationClass, 'READ_ONLY');
    assert.equal(report.hasEnforcementEvidence, true);
    assert.equal(report.requestedIntent, 'MODIFYING');
    assert.equal(fx.admissions.listByWorkspace(WS).length, 1);
  } finally { fx.close(); }
});

test('CR4B-10 one active Run per Task is enforced by durable state', () => {
  const fx = fixture();
  try {
    const started = fx.bridge.startRunFromMessage(startRunInput());
    assert.throws(() => fx.runs.insert({
      workspaceId: WS, taskId: started.task.id, origin: 'v2_api', createdBy: 'user_1',
    }));
    assert.equal(countRows(fx.db, 'runs'), 1);
  } finally { fx.close(); }
});

test('CR4B-11 an archived Conversation still accepts explicit Task and Run actions', () => {
  const fx = fixture();
  try {
    const before = fx.conversations.findConversationById(WS, CONV);
    fx.conversations.transitionConversation({
      workspaceId: WS, conversationId: CONV, expectedVersion: before?.version ?? 2,
      action: 'archive', changedAt: NOW2,
    });
    const task = fx.bridge.createTaskFromMessage(createTaskInput());
    assert.equal(task.created, true);
    const run = fx.bridge.startRunFromMessage(startRunInput());
    assert.equal(run.runCreated, true);
    assert.equal(fx.conversations.findMessageById(WS, USER_MSG)?.runId, run.run.id);
    assert.equal(fx.conversations.findConversationById(WS, CONV)?.status, 'archived');
  } finally { fx.close(); }
});

test('CR4B-12 within-transaction variants compose and roll back atomically', () => {
  const fx = fixture();
  try {
    inTransaction(fx.db, () => {
      fx.bridge.createTaskFromMessageWithinTransaction(createTaskInput());
      fx.bridge.startRunFromMessageWithinTransaction(startRunInput());
    });
    assert.equal(countRows(fx.db, 'tasks'), 1);
    assert.equal(countRows(fx.db, 'runs'), 1);
    const other = 'msg_' + 'e'.repeat(26);
    fx.conversations.appendMessage({
      id: other, conversationId: CONV, workspaceId: WS,
      senderType: 'user', kind: 'text', status: 'final', content: 'second', createdAt: NOW2,
    });
    assert.throws(() => inTransaction(fx.db, () => {
      fx.bridge.createTaskFromMessageWithinTransaction(createTaskInput({ messageId: other }));
      throw new Error('boom');
    }));
    assert.equal(countRows(fx.db, 'tasks'), 1);
    assert.equal(fx.conversations.findMessageById(WS, other)?.taskId, null);
  } finally { fx.close(); }
});

test('CR4B-13 reason values that need a parent run are rejected as caller errors', () => {
  const fx = fixture();
  try {
    expectCode('BRIDGE_INPUT_INVALID', () => fx.bridge.startRunFromMessage(startRunInput({ reason: 'retry' })));
    expectCode('BRIDGE_INPUT_INVALID', () => fx.bridge.startRunFromMessage(startRunInput({ reason: 'review-fix' })));
    expectCode('BRIDGE_INPUT_INVALID', () => fx.bridge.startRunFromMessage(startRunInput({ reason: 'provider-comparison' })));
    assert.equal(countRows(fx.db, 'tasks'), 0);
    assert.equal(countRows(fx.db, 'runs'), 0);
    const manual = fx.bridge.startRunFromMessage(startRunInput({ reason: 'manual' }));
    assert.equal(manual.run.reason, 'manual');
    assert.equal(manual.run.parentRunId, undefined);
    assert.equal(countRows(fx.db, 'runs'), 1);
  } finally { fx.close(); }
});

test('CR4B-14 a second start-run for the same Task reports a durable conflict', () => {
  const fx = fixture();
  try {
    const first = fx.bridge.startRunFromMessage(startRunInput());
    assert.equal(first.runCreated, true);
    const other = 'msg_' + 'f'.repeat(26);
    fx.conversations.appendMessage({
      id: other, conversationId: CONV, workspaceId: WS,
      senderType: 'user', kind: 'text', status: 'final', content: 'second ask', createdAt: NOW2,
    });
    const otherMessage = fx.conversations.findMessageById(WS, other);
    fx.conversations.bindMessageReferences({
      workspaceId: WS, messageId: other, expectedVersion: otherMessage?.version ?? 1,
      taskId: first.task.id, boundAt: NOW2,
    });
    expectCode('BRIDGE_CONFLICT', () => fx.bridge.startRunFromMessage({
      workspaceId: WS, messageId: other, createdBy: 'user_1', createdAt: NOW2,
    }));
    assert.equal(countRows(fx.db, 'runs'), 1);
    assert.equal(countRows(fx.db, 'tasks'), 1);
    assert.equal(fx.conversations.findMessageById(WS, other)?.runId, null);
  } finally { fx.close(); }
});
