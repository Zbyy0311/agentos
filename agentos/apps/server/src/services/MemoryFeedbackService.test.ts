import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { MemorySelectionExplanationV1 } from '@agentos/shared';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { migration047 } from '../migrations/migrations/047-memory-version-feedback.js';
import { ConversationRepository } from '../store/ConversationRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryExecutionContextRepository } from '../store/MemoryExecutionContextRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { MemoryFeedbackService } from './MemoryFeedbackService.js';

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

const NOW = '2026-10-01T00:00:00.000Z';
const WS = 'ws_memory_feedback';
const OTHER_WS = 'ws_memory_feedback_other';
const ENTRY = 'memory_feedback_entry';
const TASK = 'task_memory_feedback';
const RUN = 'run_memory_feedback';
const BODY_V1 = 'Original frozen body version one';
const BUDGET = {
  maxTokens: 100,
  maxEntries: 5,
  perScopeLimits: { workspace: 5 },
  perCategoryLimits: { knowledge: 5 },
  minConfidence: 0,
  minImportance: 0,
  maxTruncation: 1,
  requireDiversity: false,
};

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.prepare('PRAGMA foreign_keys = ON').run();
  const migrationDb = db as unknown as MinimalDatabaseSync;
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db: migrationDb });
  migration047.apply({ db: migrationDb });
  migration047.apply({ db: migrationDb });
  for (const workspaceId of [WS, OTHER_WS, 'ws_memory_feedback_origin']) {
    db.prepare(`INSERT INTO workspaces (
      id,name,root_path,canonical_root_path,last_opened_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?)`).run(workspaceId, workspaceId, `C:/tmp/${workspaceId}`, `C:/tmp/${workspaceId}`, NOW, NOW, NOW);
  }
  db.prepare(`INSERT INTO tasks (
    id,workspace_id,title,status,created_by,created_at,updated_at,version
  ) VALUES (?,?,'feedback test','open','test',?,?,1)`).run(TASK, WS, NOW, NOW);
  db.prepare(`INSERT INTO runs (
    id,workspace_id,task_id,root_run_id,status,reason,created_by,created_at,updated_at,version
  ) VALUES (?,?,?,?,'queued','initial','test',?,?,1)`).run(RUN, WS, TASK, RUN, NOW, NOW);

  const tx = db as unknown as TransactionDatabase;
  const entries = new MemoryEntryRepository(tx);
  entries.createEntry({
    id: ENTRY, workspaceId: WS, scope: 'workspace', category: 'knowledge', authority: 'user-explicit',
    confidence: 1, importance: 1, title: 'Feedback test memory', content: BODY_V1, status: 'active',
    sources: [], createdAt: NOW,
  });
  const service = new MemoryFeedbackService(tx);
  return { db, tx, entries, service, close: () => db.close() };
}

function selection(memoryId = ENTRY, scope: 'workspace' | 'global' = 'workspace'): MemorySelectionExplanationV1 {
  return {
    memoryId,
    memoryVersion: 1,
    rank: 1,
    score: 1,
    scope,
    category: 'knowledge',
    authority: 'user-explicit',
    confidence: 1,
    importance: 1,
    tokenCost: 5,
    reasons: ['scope-match'],
    sourceRefs: [{ kind: 'user', id: 'feedback-test-source' }],
  };
}

function freezeRunAndStage(fx: ReturnType<typeof fixture>, memoryIds: readonly string[] = [ENTRY]): void {
  const snapshots = new MemoryContextSnapshotRepository(fx.tx);
  for (const [id, stageId, memoryId] of [
    ['feedback_run_context', undefined, memoryIds[0] ?? ENTRY],
    ['feedback_stage_context', 'stage_feedback', memoryIds[1] ?? memoryIds[0] ?? ENTRY],
  ] as const) {
    snapshots.createSnapshot({
      id, workspaceId: WS, taskId: TASK, runId: RUN, stageId,
      queryHash: 'feedback-query', retrievalStrategyVersion: 'feedback-test-v1',
      budget: BUDGET, totalTokens: 5, truncated: false, contextText: BODY_V1,
      createdAt: NOW, selected: [selection(memoryId, memoryId.startsWith('memory_feedback_global') ? 'global' : 'workspace')], exclusions: [],
    });
  }
}

function freezeTurn(fx: ReturnType<typeof fixture>, memoryIds: readonly string[] = [ENTRY]): void {
  const memoryId = memoryIds[0] ?? ENTRY;
  const conversations = new ConversationRepository(fx.tx);
  conversations.createConversation({ id: 'feedback_conversation', workspaceId: WS, kind: 'direct', title: 'Feedback', createdAt: NOW });
  new TurnContextSnapshotRepository(fx.tx).insertWithinTransaction({
    id: 'feedback_turn_context', workspaceId: WS, conversationId: 'feedback_conversation', agentId: 'agent_feedback',
    budgetJson: '{}', selectedEntryIdsJson: JSON.stringify([memoryId]), totalTokens: 5, truncated: false,
    retrievalStrategyVersion: 'feedback-turn-v1', createdAt: NOW,
    memoryPayload: { contextText: BODY_V1, selected: [selection(memoryId)], exclusions: [], retrievalDegraded: false },
  });
}

function freezeLegacyExecution(fx: ReturnType<typeof fixture>, memoryIds: readonly string[] = [ENTRY], store: 'canonical' | 'legacy' = 'canonical'): void {
  const memoryId = memoryIds[0] ?? ENTRY;
  fx.db.prepare(`INSERT INTO conversations (
    id,workspace_id,conversation_type,title,created_at,updated_at
  ) VALUES ('feedback_legacy_conversation',?,'direct','feedback',?,?)`).run(WS, NOW, NOW);
  fx.db.prepare(`INSERT INTO messages (
    id,conversation_id,workspace_id,sender_type,content,created_at
  ) VALUES ('feedback_legacy_message','feedback_legacy_conversation',?,'user','feedback',?)`).run(WS, NOW);
  fx.db.prepare(`INSERT INTO executions (
    id,run_id,conversation_id,workspace_id,source_message_id,agent_id,status,mode,created_at,updated_at
  ) VALUES ('feedback_execution',?,'feedback_legacy_conversation',?,'feedback_legacy_message','agent_feedback','completed','mock',?,?)`)
    .run(RUN, WS, NOW, NOW);
  new MemoryExecutionContextRepository(fx.tx).freeze({
    workspaceId: WS, runId: RUN, executionId: 'feedback_execution', conversationId: 'feedback_legacy_conversation',
    agentId: 'agent_feedback', contextText: BODY_V1, queryHash: 'a'.repeat(64),
    selected: [{ memoryId, memoryVersion: 1, store, rank: 1, reasons: ['scope-match'], tokenCost: 5 }],
    exclusions: [], retrievalDegraded: false, truncated: false, createdAt: NOW,
  });
}

function contextRequest(
  contextKind: 'run' | 'stage' | 'turn' | 'legacy-execution',
  contextId: string,
  kind: 'helpful' | 'wrong' | 'outdated',
  expectedVersion = 2,
  memoryId = ENTRY,
) {
  return { expectedVersion, memoryId, memoryVersion: 1, contextId, contextKind, kind } as const;
}

function count(db: SqliteDb, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function editEntry(fx: ReturnType<typeof fixture>, entryId: string, content: string, title: string): void {
  inTransaction(fx.tx, () => fx.entries.updateEntryWithinTransaction({
    workspaceId: WS, entryId, expectedVersion: 1, updatedAt: NOW, title, content,
  }));
}

test('feedback uses each frozen canonical context version after its Entry advances to v2', () => {
  const fx = fixture();
  try {
    const stageEntry = 'memory_feedback_stage_entry';
    const turnEntry = 'memory_feedback_turn_entry';
    const legacyEntry = 'memory_feedback_legacy_entry';
    for (const id of [stageEntry, turnEntry, legacyEntry]) {
      fx.entries.createEntry({
        id, workspaceId: WS, scope: 'workspace', category: 'knowledge', authority: 'user-explicit',
        confidence: 1, importance: 1, title: 'Feedback test memory', content: BODY_V1, status: 'active',
        sources: [], createdAt: NOW,
      });
    }
    freezeRunAndStage(fx, [ENTRY, stageEntry]);
    freezeTurn(fx, [turnEntry]);
    freezeLegacyExecution(fx, [legacyEntry]);

    // Two Entries are edited and two are archived. Each snapshot still proves
    // the selected version and original body from v1.
    editEntry(fx, ENTRY, 'Changed body version two', 'Updated feedback memory');
    fx.entries.updateStatus({ workspaceId: WS, entryId: stageEntry, expectedVersion: 1, status: 'archived', updatedAt: NOW });
    editEntry(fx, turnEntry, 'Changed turn body version two', 'Updated turn feedback memory');
    fx.entries.updateStatus({ workspaceId: WS, entryId: legacyEntry, expectedVersion: 1, status: 'archived', updatedAt: NOW });
    const entryIds = [ENTRY, stageEntry, turnEntry, legacyEntry];
    const beforeFeedback = entryIds.map(id => fx.entries.findById(WS, id));
    assert.deepEqual(beforeFeedback.map(entry => entry?.version), [2, 2, 2, 2]);

    const cases = [
      ['run', 'feedback_run_context', 'helpful'],
      ['stage', 'feedback_stage_context', 'wrong'],
      ['turn', 'feedback_turn_context', 'outdated'],
      ['legacy-execution', 'mexec_feedback_execution', 'wrong'],
    ] as const;
    const created = cases.map(([contextKind, contextId, kind], index) =>
      fx.service.add(WS, contextRequest(contextKind, contextId, kind, 2, entryIds[index]!)));

    assert.deepEqual(created.map(item => [item.contextKind, item.memoryVersion, item.currentEntryVersion, item.kind]), [
      ['run', 1, 2, 'helpful'], ['stage', 1, 2, 'wrong'], ['turn', 1, 2, 'outdated'],
      ['legacy-execution', 1, 2, 'wrong'],
    ]);
    assert.ok(created.every(item => /^[a-f0-9]{64}$/u.test(item.contextHash)));
    assert.equal(created[0].action, null);
    assert.equal(created[1].action?.action, 'correction');
    assert.equal(created[2].action?.action, 'revalidation');
    assert.equal(created[3].action?.action, 'correction');

    const snapshots = new MemoryContextSnapshotRepository(fx.tx);
    assert.equal(snapshots.readContextText(WS, 'feedback_run_context'), BODY_V1);
    assert.equal(snapshots.readContextText(WS, 'feedback_stage_context'), BODY_V1);
    assert.equal(new TurnContextSnapshotRepository(fx.tx).readPayload(WS, 'feedback_turn_context')?.contextText, BODY_V1);
    assert.equal(new MemoryExecutionContextRepository(fx.tx).findForExecution(WS, 'feedback_execution')?.contextText, BODY_V1);
    assert.equal(snapshots.findById(WS, 'feedback_run_context')?.selected[0]?.memoryVersion, 1);
    assert.equal(new TurnContextSnapshotRepository(fx.tx).readPayload(WS, 'feedback_turn_context')?.selected[0]?.memoryVersion, 1);
    assert.deepEqual(entryIds.map(id => fx.entries.findById(WS, id)), beforeFeedback,
      'feedback must not mutate Entries or their versions');
    assert.equal(count(fx.db, 'memory_lifecycle_actions'), 0, 'feedback appends no Entry history rows');

    const listed = fx.service.list(WS);
    assert.equal(listed.length, 4);
    assert.ok(listed.every(item => typeof item.memoryId === 'string' && typeof item.contextId === 'string'));
    assert.ok(listed.every(item => !Object.keys(item).some(key => key.includes('_'))));
    assert.deepEqual(listed.map(item => item.memoryVersion).sort(), [1, 1, 1, 1]);

    const resolved = fx.service.resolveAction(WS, created[1].action!.id, 1, 'resolved');
    const rejected = fx.service.resolveAction(WS, created[2].action!.id, 1, 'rejected');
    assert.deepEqual([resolved.status, resolved.version, rejected.status, rejected.version], ['resolved', 2, 'rejected', 2]);
    assert.throws(() => fx.service.resolveAction(WS, resolved.id, 1, 'rejected'), /MEMORY_FEEDBACK_VERSION_CONFLICT/);
    const audit = fx.db.prepare(`SELECT from_status,to_status,expected_version,version
      FROM memory_feedback_action_audit ORDER BY to_status`).all() as Array<{
        from_status: string; to_status: string; expected_version: number; version: number;
      }>;
    assert.equal(audit.length, 2);
    assert.deepEqual(audit.map(row => [row.from_status, row.to_status, row.expected_version, row.version]), [
      ['pending', 'rejected', 1, 2], ['pending', 'resolved', 1, 2],
    ]);
    assert.throws(() => fx.db.prepare('UPDATE memory_feedback_action_audit SET to_status = ?').run('rejected'), /IMMUTABLE/);
    assert.throws(() => fx.db.prepare('DELETE FROM memory_feedback_action_audit').run(), /IMMUTABLE/);
  } finally { fx.close(); }
});

test('feedback rejects invalid, foreign, ambiguous compatibility, and stale inputs before persistence', () => {
  const fx = fixture();
  try {
    freezeRunAndStage(fx);
    freezeLegacyExecution(fx);
    const valid = contextRequest('run', 'feedback_run_context', 'helpful', 1);
    for (const invalid of [
      { ...valid, expectedVersion: 0 },
      { ...valid, expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, memoryVersion: 0 },
      { ...valid, kind: 'maybe' },
      { ...valid, contextKind: 'execution' },
      { ...valid, extra: 'forged' },
      { ...valid, memoryId: ' padded ' },
      { ...valid, comment: 'x'.repeat(2001) },
    ]) {
      assert.throws(() => fx.service.add(WS, invalid as never), /MEMORY_FEEDBACK_INPUT_INVALID/);
    }
    assert.throws(() => fx.service.add(WS, contextRequest('run', 'missing_context', 'helpful', 1)), /MEMORY_FEEDBACK_CONTEXT_INVALID/);
    assert.throws(() => fx.service.add(OTHER_WS, valid), /MEMORY_FEEDBACK_CONTEXT_INVALID/);
    assert.throws(() => fx.service.add(WS, contextRequest('run', 'feedback_run_context', 'helpful', 1, 'another-memory')),
      /MEMORY_FEEDBACK_CONTEXT_INVALID/);
    assert.throws(() => fx.service.add(WS, { ...valid, memoryVersion: 2 }), /MEMORY_FEEDBACK_CONTEXT_INVALID/);
    assert.throws(() => fx.service.add(WS, contextRequest('legacy-execution', 'mexec_feedback_execution', 'helpful', 2)),
      /MEMORY_FEEDBACK_VERSION_CONFLICT/);

    const rejectedLegacy = fixture();
    try {
      freezeLegacyExecution(rejectedLegacy, [ENTRY], 'legacy');
      assert.throws(() => rejectedLegacy.service.add(WS,
        contextRequest('legacy-execution', 'mexec_feedback_execution', 'helpful', 1)), /MEMORY_FEEDBACK_CONTEXT_INVALID/);
      assert.equal(count(rejectedLegacy.db, 'memory_version_feedback'), 0);
    } finally { rejectedLegacy.close(); }

    editEntry(fx, ENTRY, 'A newer body makes the v1 expectedVersion stale', 'Feedback test memory');
    assert.throws(() => fx.service.add(WS, valid), /MEMORY_FEEDBACK_VERSION_CONFLICT/);
    assert.equal(count(fx.db, 'memory_version_feedback'), 0);
    assert.equal(count(fx.db, 'memory_feedback_actions'), 0);
  } finally { fx.close(); }
});

test('confirmed global Entry selected cross-workspace accepts versioned feedback without changing its owner', () => {
  const fx = fixture();
  try {
    const origin = 'ws_memory_feedback_origin';
    const globalId = 'memory_feedback_global';
    fx.entries.createEntry({
      id: globalId, workspaceId: origin, scope: 'global', category: 'preference', authority: 'user-explicit',
      confidence: 1, importance: 1, title: 'Global preference', content: BODY_V1, status: 'active',
      sources: [], createdAt: NOW,
    });
    fx.db.prepare(`INSERT INTO preference_confirmations (
      id,projection_id,profile_id,projection_scope,projection_workspace_id,workspace_id,status,version,
      preferred_value,dimension,context_kind,scope,confidence,evidence_count,evidence_json,
      entry_id,entry_workspace_id,entry_version,created_at,updated_at
    ) VALUES ('confirmed_global','projection_global','default','global',NULL,?,'confirmed',2,
      'value','dimension','conversation','global',100,1,'[]',?,?,1,?,?)`)
      .run(origin, globalId, origin, NOW, NOW);
    freezeRunAndStage(fx, [globalId, globalId]);
    const feedback = fx.service.add(WS, contextRequest('run', 'feedback_run_context', 'wrong', 1, globalId));
    assert.equal(feedback.workspaceId, WS);
    assert.equal(feedback.action?.action, 'correction');
    assert.equal(count(fx.db, 'memory_version_feedback'), 1);
    assert.equal(fx.entries.findById(origin, globalId)?.version, 1);
    assert.equal(fx.entries.findById(WS, globalId), undefined);
  } finally { fx.close(); }
});

test('unsafe comments are rejected without logs or any feedback sink row', () => {
  const fx = fixture();
  const logged: unknown[][] = [];
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  try {
    freezeRunAndStage(fx);
    const secret = 'api_key=feedback-secret-must-not-be-persisted';
    console.log = (...args: unknown[]) => { logged.push(args); };
    console.info = (...args: unknown[]) => { logged.push(args); };
    console.warn = (...args: unknown[]) => { logged.push(args); };
    console.error = (...args: unknown[]) => { logged.push(args); };
    assert.throws(() => fx.service.add(WS, { ...contextRequest('run', 'feedback_run_context', 'wrong', 1), comment: secret }),
      /MEMORY_FEEDBACK_INPUT_INVALID/);
    assert.deepEqual(logged, []);
    assert.equal(count(fx.db, 'memory_version_feedback'), 0);
    assert.equal(count(fx.db, 'memory_feedback_actions'), 0);
    assert.equal(count(fx.db, 'memory_feedback_action_audit'), 0);
    const persisted = JSON.stringify(fx.db.prepare(`SELECT * FROM memory_version_feedback`).all());
    assert.equal(persisted.includes(secret), false);
  } finally {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    fx.close();
  }
});

test('action and audit insert failures roll back their enclosing feedback and CAS writes', () => {
  const fx = fixture();
  try {
    freezeRunAndStage(fx);
    fx.db.exec(`CREATE TRIGGER fail_feedback_action_insert BEFORE INSERT ON memory_feedback_actions
      BEGIN SELECT RAISE(ABORT,'injected action insert failure'); END`);
    assert.throws(() => fx.service.add(WS, contextRequest('run', 'feedback_run_context', 'wrong', 1)), /injected action insert failure/);
    assert.equal(count(fx.db, 'memory_version_feedback'), 0);
    assert.equal(count(fx.db, 'memory_feedback_actions'), 0);

    fx.db.exec('DROP TRIGGER fail_feedback_action_insert');
    const feedback = fx.service.add(WS, contextRequest('run', 'feedback_run_context', 'wrong', 1));
    const pendingAction = feedback.action;
    assert.ok(pendingAction);
    fx.db.exec(`CREATE TRIGGER fail_feedback_audit_insert BEFORE INSERT ON memory_feedback_action_audit
      BEGIN SELECT RAISE(ABORT,'injected audit insert failure'); END`);
    assert.throws(() => fx.service.resolveAction(WS, pendingAction.id, 1, 'resolved'), /injected audit insert failure/);
    const action = fx.db.prepare('SELECT status,version FROM memory_feedback_actions WHERE id=?').get(pendingAction.id) as {
      status: string; version: number;
    };
    assert.equal(action.status, 'pending');
    assert.equal(action.version, 1);
    assert.equal(count(fx.db, 'memory_feedback_action_audit'), 0);
    assert.equal(fx.service.list(WS)[0]?.id, feedback.id, 'failed action resolution leaves the original feedback intact');
  } finally { fx.close(); }
});

test('feedback, frozen context payloads, and selected-entry snapshots remain immutable', () => {
  const fx = fixture();
  try {
    freezeRunAndStage(fx);
    freezeTurn(fx);
    const feedback = fx.service.add(WS, contextRequest('turn', 'feedback_turn_context', 'helpful', 1));
    assert.throws(() => fx.db.prepare('UPDATE memory_version_feedback SET comment=? WHERE id=?').run('changed', feedback.id), /IMMUTABLE/);
    assert.throws(() => fx.db.prepare('DELETE FROM memory_version_feedback WHERE id=?').run(feedback.id), /IMMUTABLE/);
    assert.throws(() => fx.db.prepare('UPDATE cr_turn_memory_payloads SET context_text=? WHERE snapshot_id=?').run('changed', 'feedback_turn_context'), /IMMUTABLE/);
    assert.throws(() => fx.db.prepare('DELETE FROM cr_turn_memory_payloads WHERE snapshot_id=?').run('feedback_turn_context'), /IMMUTABLE/);
    assert.throws(() => fx.db.prepare('UPDATE memory_context_snapshots SET total_tokens=99 WHERE id=?').run('feedback_run_context'), /IMMUTABLE/);
    assert.throws(() => fx.db.prepare('DELETE FROM memory_context_snapshots WHERE id=?').run('feedback_run_context'), /FORBIDDEN/);
    assert.equal(fx.service.list(WS)[0]?.comment, '');
    assert.equal(new MemoryContextSnapshotRepository(fx.tx).readContextText(WS, 'feedback_run_context'), BODY_V1);
  } finally { fx.close(); }
});
