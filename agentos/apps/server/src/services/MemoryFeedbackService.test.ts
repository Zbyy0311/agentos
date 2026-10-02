import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { MemorySelectionExplanationV1 } from '@agentos/shared';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import { migration047 } from '../migrations/migrations/047-memory-version-feedback.js';
import { migration050 } from '../migrations/migrations/050-memory-feedback-resolutions.js';
import { ConversationRepository } from '../store/ConversationRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryExecutionContextRepository } from '../store/MemoryExecutionContextRepository.js';
import { TurnContextSnapshotRepository } from '../store/TurnContextSnapshotRepository.js';
import { inTransaction, type TransactionDatabase } from '../store/Transaction.js';
import { MemoryFeedbackService } from './MemoryFeedbackService.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';

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

function fixture(authority: 'user-explicit' | 'system-verified' = 'user-explicit') {
  const db = new DatabaseSync(':memory:');
  db.prepare('PRAGMA foreign_keys = ON').run();
  const migrationDb = db as unknown as MinimalDatabaseSync;
  for (const migration of DEFAULT_REGISTRY_MIGRATIONS) migration.apply({ db: migrationDb });
  migration047.apply({ db: migrationDb });
  migration047.apply({ db: migrationDb });
  migration050.apply({ db: migrationDb });
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
    id: ENTRY, workspaceId: WS, scope: 'workspace', category: 'knowledge', authority,
    confidence: 1, importance: 1, title: 'Feedback test memory', content: BODY_V1, status: 'active',
    sources: authority === 'system-verified' ? [{kind: 'run', id: RUN}] : [], createdAt: NOW,
  });
  const service = new MemoryFeedbackService(tx);
  return { db, tx, entries, service, close: () => db.close() };
}

function selection(memoryId = ENTRY, scope: 'workspace' | 'global' = 'workspace', memoryVersion = 1): MemorySelectionExplanationV1 {
  return {
    memoryId,
    memoryVersion,
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

function freezeTurn(
  fx: ReturnType<typeof fixture>,
  memoryIds: readonly string[] = [ENTRY],
  memoryVersion = 1,
  contextText = BODY_V1,
): void {
  const memoryId = memoryIds[0] ?? ENTRY;
  const conversations = new ConversationRepository(fx.tx);
  conversations.createConversation({ id: 'feedback_conversation', workspaceId: WS, kind: 'direct', title: 'Feedback', createdAt: NOW });
  new TurnContextSnapshotRepository(fx.tx).insertWithinTransaction({
    id: 'feedback_turn_context', workspaceId: WS, conversationId: 'feedback_conversation', agentId: 'agent_feedback',
    budgetJson: '{}', selectedEntryIdsJson: JSON.stringify([memoryId]), totalTokens: 5, truncated: false,
    retrievalStrategyVersion: 'feedback-turn-v1', createdAt: NOW,
    memoryPayload: {
      contextText,
      selected: [selection(memoryId, memoryId.startsWith('memory_feedback_global') ? 'global' : 'workspace', memoryVersion)],
      exclusions: [], retrievalDegraded: false,
    },
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
  memoryVersion = 1,
) {
  return { expectedVersion, memoryId, memoryVersion, contextId, contextKind, kind } as const;
}

function count(db: SqliteDb, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

function editEntry(fx: ReturnType<typeof fixture>, entryId: string, content: string, title: string): void {
  inTransaction(fx.tx, () => fx.entries.updateEntryWithinTransaction({
    workspaceId: WS, entryId, expectedVersion: 1, updatedAt: NOW, title, content,
  }));
}

function addConfirmedGlobalPreference(fx: ReturnType<typeof fixture>, entryId: string): void {
  const origin = 'ws_memory_feedback_origin';
  fx.entries.createEntry({
      id: entryId, workspaceId: origin, scope: 'global', category: 'preference', authority: 'user-explicit',
    confidence: 1, importance: 1, title: 'Global feedback preference', content: BODY_V1, status: 'active',
      pinned: true, tags: ['preference', 'dimension:feedback', 'context:general', 'value:feedback'],
      sources: [], createdAt: NOW,
  });
  fx.db.prepare(`INSERT INTO preference_confirmations (
    id,projection_id,profile_id,projection_scope,projection_workspace_id,workspace_id,status,version,
    preferred_value,dimension,context_kind,scope,confidence,evidence_count,evidence_json,
    entry_id,entry_workspace_id,entry_version,created_at,updated_at
  ) VALUES (?,?, 'default','global',NULL,?,'confirmed',2,
    'feedback','feedback','general','global',100,1,'[]',?,?,1,?,?)`)
    .run(`confirmed_${entryId}`, `projection_${entryId}`, origin, entryId, origin, NOW, NOW);
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

    assert.throws(() => fx.service.resolveAction(WS, created[1].action!.id, 1, 'resolved'), /MEMORY_FEEDBACK_RESOLUTION_REQUIRED/);
    const rejected = fx.service.resolveAction(WS, created[1].action!.id, 1, 'rejected');
    const revalidated = fx.service.applyAction(WS, created[2].action!.id, {
      expectedActionVersion: 1,
      expectedEntryVersion: 2,
      resolution: 'revalidated',
      conclusion: 'The current entry was checked against the maintained workflow.',
      evidence: 'Reviewed the current runbook and its active deployment command.',
    }, () => undefined);
    assert.deepEqual([revalidated.action.status, revalidated.action.version, rejected.status, rejected.version], [
      'resolved', 2, 'rejected', 2,
    ]);
    assert.equal(revalidated.entry.version, 3);
    assert.throws(() => fx.service.resolveAction(WS, rejected.id, 1, 'rejected'), /MEMORY_FEEDBACK_VERSION_CONFLICT/);
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

test('memory-relevance.v2 quarantines exact wrong versions across authorized global scopes until every pending action is rejected', () => {
  const fx = fixture();
  try {
    const globalId = 'memory_feedback_global_quarantine';
    const workspaceId = 'memory_feedback_workspace_quarantine';
    const origin = 'ws_memory_feedback_origin';
    addConfirmedGlobalPreference(fx, globalId);
    fx.entries.createEntry({
      id: workspaceId, workspaceId: WS, scope: 'workspace', category: 'knowledge', authority: 'user-explicit',
      confidence: 1, importance: 1, title: 'Workspace-only memory', content: BODY_V1, status: 'active',
      pinned: true, sources: [], createdAt: NOW,
    });
    freezeRunAndStage(fx, [globalId]);
    inTransaction(fx.tx, () => fx.entries.updateEntryWithinTransaction({
      workspaceId: origin, entryId: globalId, expectedVersion: 1, updatedAt: NOW,
      title: 'Global preference v2', content: 'Updated global preference body version two',
    }));

    const retrieval = new MemoryRetrievalService(fx.entries);
    const selectedIds = (workspace: string) => retrieval.retrieveWithStatus({
      context: { workspaceId: workspace },
      selectionPolicy: 'memory-relevance.v2',
    }).results.map(item => item.entry.id);
    assert.ok(selectedIds(WS).includes(globalId));
    assert.ok(selectedIds(WS).includes(workspaceId));
    assert.ok(selectedIds(OTHER_WS).includes(globalId));
    assert.ok(!selectedIds(OTHER_WS).includes(workspaceId));

    const historical = fx.service.add(WS,
      contextRequest('run', 'feedback_run_context', 'wrong', 2, globalId, 1));
    assert.equal(historical.action?.memoryVersion, 1);
    assert.ok(selectedIds(WS).includes(globalId), 'a report about frozen v1 cannot quarantine the current v2');
    assert.ok(selectedIds(OTHER_WS).includes(globalId), 'an old-version report cannot quarantine shared v2');

    freezeTurn(fx, [globalId], 2, 'Updated global preference body version two');
    const currentRequest = contextRequest('turn', 'feedback_turn_context', 'wrong', 2, globalId, 2);
    const firstCurrent = fx.service.add(WS, currentRequest);
    const secondCurrent = fx.service.add(WS, currentRequest);
    assert.equal(firstCurrent.action?.memoryVersion, 2);
    assert.equal(secondCurrent.action?.memoryVersion, 2);
    assert.ok(!selectedIds(WS).includes(globalId), 'current wrong feedback quarantines v2 in the reporting workspace');
    assert.ok(!selectedIds(OTHER_WS).includes(globalId), 'authorized consumers of a shared global Entry also quarantine v2');
    assert.ok(selectedIds(WS).includes(workspaceId), 'quarantine leaves a different workspace-scoped Entry available');

    fx.service.resolveAction(WS, firstCurrent.action!.id, 1, 'rejected');
    assert.ok(!selectedIds(WS).includes(globalId), 'one rejection cannot clear another pending report for the same version');
    fx.service.resolveAction(WS, secondCurrent.action!.id, 1, 'rejected');
    assert.ok(selectedIds(WS).includes(globalId), 'rejecting every current-version report releases v2');
    assert.ok(selectedIds(OTHER_WS).includes(globalId), 'the shared v2 is released for other authorized workspaces too');
    assert.equal(fx.entries.findById(origin, globalId)?.version, 2);
    assert.equal(fx.entries.findById(origin, globalId)?.authority, 'user-explicit');
    assert.equal(fx.service.list(WS).find(item => item.id === historical.id)?.memoryVersion, 1);
  } finally { fx.close(); }
});

test('evidenced correction atomically creates a new Entry version and preserves immutable snapshot authority and scope', () => {
  const fx = fixture();
  try {
    freezeRunAndStage(fx);
    const feedback = fx.service.add(WS, contextRequest('run', 'feedback_run_context', 'wrong', 1));
    const action = feedback.action;
    assert.ok(action);
    const current = fx.entries.findById(WS, ENTRY)!;
    assert.throws(() => fx.service.applyAction(WS, action.id, {
      expectedActionVersion: 2,
      expectedEntryVersion: current.version,
      resolution: 'corrected',
      conclusion: 'Corrected after review.',
      evidence: 'Source document confirms the corrected command.',
      correctedEntry: { title: 'Corrected title', content: 'Corrected body.' },
    }, () => undefined), /MEMORY_FEEDBACK_VERSION_CONFLICT/);
    assert.throws(() => fx.service.applyAction(WS, action.id, {
      expectedActionVersion: 1,
      expectedEntryVersion: current.version + 1,
      resolution: 'corrected',
      conclusion: 'Corrected after review.',
      evidence: 'Source document confirms the corrected command.',
      correctedEntry: { title: 'Corrected title', content: 'Corrected body.' },
    }, () => undefined), /MEMORY_FEEDBACK_ENTRY_VERSION_CONFLICT/);
    assert.throws(() => fx.service.applyAction(OTHER_WS, action.id, {
      expectedActionVersion: 1,
      expectedEntryVersion: current.version,
      resolution: 'corrected',
      conclusion: 'Corrected after review.',
      evidence: 'Source document confirms the corrected command.',
      correctedEntry: { title: 'Corrected title', content: 'Corrected body.' },
    }, () => undefined), /MEMORY_FEEDBACK_ACTION_NOT_FOUND/);

    let eventEntryVersion: number | undefined;
    const applied = fx.service.applyAction(WS, action.id, {
      expectedActionVersion: 1,
      expectedEntryVersion: current.version,
      resolution: 'corrected',
      conclusion: 'The reported command was superseded.',
      evidence: 'Reviewed the current deployment runbook and verified the replacement command.',
      correctedEntry: { title: 'Corrected deployment workflow', content: 'Use the reviewed deployment command.' },
    }, entry => { eventEntryVersion = entry.version; });
    assert.equal(applied.action.status, 'resolved');
    assert.equal(applied.action.version, 2);
    assert.equal(applied.action.resolution?.resolution, 'corrected');
    assert.equal(applied.action.resolution?.expectedActionVersion, 1);
    assert.equal(applied.action.resolution?.expectedEntryVersion, 1);
    assert.equal(applied.action.resolution?.resolvedEntryVersion, 2);
    assert.match(applied.action.resolution?.evidence ?? '', /deployment runbook/);
    assert.equal(applied.entry.version, 2);
    assert.equal(applied.entry.title, 'Corrected deployment workflow');
    assert.equal(applied.entry.content, 'Use the reviewed deployment command.');
    assert.equal(applied.entry.scope, 'workspace');
    assert.equal(applied.entry.authority, 'user-explicit', 'feedback evidence cannot award stronger authority');
    assert.equal(eventEntryVersion, 2);
    assert.equal(count(fx.db, 'memory_lifecycle_actions'), 1);
    assert.equal(count(fx.db, 'memory_feedback_action_resolutions'), 1);
    const lifecycle = fx.db.prepare('SELECT action,from_version,to_version FROM memory_lifecycle_actions WHERE entry_id=?')
      .get(ENTRY) as { action: string; from_version: number; to_version: number };
    assert.deepEqual([lifecycle.action, lifecycle.from_version, lifecycle.to_version], ['corrected', 1, 2]);
    assert.equal(new MemoryContextSnapshotRepository(fx.tx).readContextText(WS, 'feedback_run_context'), BODY_V1);
    assert.equal(new MemoryContextSnapshotRepository(fx.tx).findById(WS, 'feedback_run_context')?.selected[0]?.memoryVersion, 1);
  } finally { fx.close(); }
});

test('a human correction does not inherit the original system verification', () => {
  const fx = fixture('system-verified');
  try {
    freezeRunAndStage(fx);
    const report = fx.service.add(WS, contextRequest('run', 'feedback_run_context', 'wrong', 1));
    const corrected = fx.service.applyAction(WS, report.action!.id, {
      expectedActionVersion: 1, expectedEntryVersion: 1, resolution: 'corrected',
      conclusion: 'Human reviewed the correction.', evidence: 'Manual review of the workflow.',
      correctedEntry: { title: 'Human correction', content: 'Updated operational command.' },
    }, () => undefined);
    assert.equal(corrected.entry.authority, 'user-explicit');
    const audit = fx.db.prepare('SELECT before_json,after_json FROM memory_lifecycle_actions WHERE entry_id=?')
      .get(ENTRY) as { before_json: string; after_json: string };
    assert.equal(JSON.parse(audit.before_json).authority, 'system-verified');
    assert.equal(JSON.parse(audit.after_json).authority, 'user-explicit');
    assert.equal(new MemoryContextSnapshotRepository(fx.tx).readContextText(WS, 'feedback_run_context'), BODY_V1);
  } finally { fx.close(); }
});

test('archive and revalidation resolutions each bind evidence to their new Entry version', () => {
  for (const resolution of ['archived', 'revalidated'] as const) {
    const fx = fixture();
    try {
      freezeRunAndStage(fx);
      const kind = resolution === 'archived' ? 'wrong' : 'outdated';
      const feedback = fx.service.add(WS, contextRequest('run', 'feedback_run_context', kind, 1));
      assert.ok(feedback.action);
      const applied = fx.service.applyAction(WS, feedback.action.id, {
        expectedActionVersion: 1,
        expectedEntryVersion: 1,
        resolution,
        conclusion: `${resolution} after source review.`,
        evidence: `Reviewed the dated operational source for ${resolution}.`,
      }, () => undefined);
      assert.equal(applied.action.status, 'resolved');
      assert.equal(applied.action.resolution?.resolution, resolution);
      assert.equal(applied.action.resolution?.expectedActionVersion, 1);
      assert.equal(applied.action.resolution?.expectedEntryVersion, 1);
      assert.equal(applied.action.resolution?.resolvedEntryVersion, 2);
      assert.equal(applied.entry.version, 2);
      assert.equal(applied.entry.status, resolution === 'archived' ? 'archived' : 'active');
      const lifecycle = fx.db.prepare('SELECT action,from_version,to_version FROM memory_lifecycle_actions WHERE entry_id=?')
        .get(ENTRY) as { action: string; from_version: number; to_version: number };
      assert.deepEqual([lifecycle.action, lifecycle.from_version, lifecycle.to_version], [
        resolution === 'archived' ? 'archive' : 'revalidate', 1, 2,
      ]);
      assert.equal(count(fx.db, 'memory_feedback_action_resolutions'), 1);
    } finally { fx.close(); }
  }
});

test('a wrong report can be revalidated only with conclusion and text evidence linked to the new version', () => {
  const fx = fixture();
  try {
    freezeRunAndStage(fx);
    const feedback = fx.service.add(WS, contextRequest('run', 'feedback_run_context', 'wrong', 1));
    const action = feedback.action;
    assert.ok(action);
    const withoutEvidence = {
      expectedActionVersion: 1,
      expectedEntryVersion: 1,
      resolution: 'revalidated',
      conclusion: 'The report was reviewed.',
      evidence: '',
    };
    assert.throws(() => fx.service.applyAction(WS, action.id, withoutEvidence, () => undefined),
      /MEMORY_FEEDBACK_INPUT_INVALID/);
    const applied = fx.service.applyAction(WS, action.id, {
      ...withoutEvidence,
      evidence: 'Checked the dated source and confirmed the existing statement remains accurate.',
    }, () => undefined);
    assert.equal(applied.entry.version, 2);
    assert.equal(applied.entry.content, BODY_V1);
    assert.equal(applied.action.resolution?.expectedActionVersion, 1);
    assert.equal(applied.action.resolution?.expectedEntryVersion, 1);
    assert.equal(applied.action.resolution?.resolvedEntryVersion, 2);
    assert.equal(applied.action.resolution?.conclusion, withoutEvidence.conclusion);
    assert.equal(applied.action.resolution?.evidence,
      'Checked the dated source and confirmed the existing statement remains accurate.');
  } finally { fx.close(); }
});

test('failed Entry-change event rolls back correction, lifecycle, resolution, and action audit together', () => {
  const fx = fixture();
  try {
    freezeRunAndStage(fx);
    const feedback = fx.service.add(WS, contextRequest('run', 'feedback_run_context', 'wrong', 1));
    assert.ok(feedback.action);
    const original = fx.entries.findById(WS, ENTRY);
    assert.throws(() => fx.service.applyAction(WS, feedback.action!.id, {
      expectedActionVersion: 1,
      expectedEntryVersion: 1,
      resolution: 'corrected',
      conclusion: 'Correction reviewed.',
      evidence: 'Verified against the current runbook.',
      correctedEntry: { title: 'Corrected', content: 'Corrected content.' },
    }, () => { throw new Error('injected workspace event failure'); }), /injected workspace event failure/);
    assert.deepEqual(fx.entries.findById(WS, ENTRY), original);
    assert.equal(fx.entries.findById(WS, ENTRY)?.version, 1);
    assert.equal(fx.entries.findById(WS, ENTRY)?.content, BODY_V1);
    assert.equal((fx.db.prepare('SELECT status,version FROM memory_feedback_actions WHERE id=?')
      .get(feedback.action.id) as { status: string; version: number }).status, 'pending');
    assert.equal(count(fx.db, 'memory_lifecycle_actions'), 0);
    assert.equal(count(fx.db, 'memory_feedback_action_resolutions'), 0);
    assert.equal(count(fx.db, 'memory_feedback_action_audit'), 0);
  } finally { fx.close(); }
});

test('migration 050 can be reapplied without duplicating schema or restoring the weaker 047 resolution guard', () => {
  const fx = fixture();
  try {
    const countSchemaObjects = () => Number((fx.db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE name IN ('memory_feedback_action_resolutions','memory_feedback_actions_quarantine','memory_feedback_action_resolutions_workspace',
        'memory_feedback_actions_transition_guard','memory_feedback_action_audit_validate',
        'memory_feedback_action_resolutions_validate','memory_feedback_action_resolutions_immutable',
        'memory_feedback_action_resolutions_no_delete')`).get() as { count: number }).count);
    const before = countSchemaObjects();
    migration050.apply({ db: fx.db as unknown as MinimalDatabaseSync });
    migration050.apply({ db: fx.db as unknown as MinimalDatabaseSync });
    assert.equal(countSchemaObjects(), before);

    freezeRunAndStage(fx);
    const feedback = fx.service.add(WS, contextRequest('run', 'feedback_run_context', 'wrong', 1));
    const action = feedback.action;
    assert.ok(action);
    assert.throws(() => fx.db.prepare(`UPDATE memory_feedback_actions SET status='resolved',version=2 WHERE id=?`)
      .run(action.id), /MEMORY_FEEDBACK_ACTION_TRANSITION_INVALID/);
    assert.throws(() => fx.db.prepare('UPDATE memory_feedback_actions SET entry_version=2 WHERE id=?')
      .run(action.id), /MEMORY_FEEDBACK_ACTION_TRANSITION_INVALID/);
    assert.throws(() => fx.db.prepare('DELETE FROM memory_feedback_actions WHERE id=?').run(action.id), /IMMUTABLE/);
    assert.equal((fx.db.prepare('SELECT status,version FROM memory_feedback_actions WHERE id=?')
      .get(action.id) as { status: string; version: number }).status, 'pending');
  } finally { fx.close(); }
});

test('secret-bearing feedback and resolution text is rejected without logs or persistence', () => {
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
    const feedback = fx.service.add(WS, contextRequest('run', 'feedback_run_context', 'wrong', 1));
    assert.ok(feedback.action);
    const safeResolution = {
      expectedActionVersion: 1,
      expectedEntryVersion: 1,
      resolution: 'corrected' as const,
      conclusion: 'A reviewed correction was made.',
      evidence: 'Verified from the current runbook.',
      correctedEntry: { title: 'Corrected title', content: 'Corrected body.' },
    };
    const unsafeResolutions = [
      { ...safeResolution, conclusion: 'Authorization: Bearer feedback-resolution-secret' },
      { ...safeResolution, evidence: 'api_key=feedback-evidence-secret' },
      { ...safeResolution, correctedEntry: { ...safeResolution.correctedEntry, content: '-----BEGIN RSA PRIVATE KEY-----secret' } },
      { ...safeResolution, correctedEntry: { ...safeResolution.correctedEntry, summary: 'password=feedback-summary-secret' } },
      { ...safeResolution, correctedEntry: { ...safeResolution.correctedEntry, authority: 'system-verified' } },
    ];
    for (const unsafe of unsafeResolutions) {
      assert.throws(() => fx.service.applyAction(WS, feedback.action!.id, unsafe, () => undefined),
        /MEMORY_FEEDBACK_INPUT_INVALID/);
    }
    assert.deepEqual(logged, []);
    assert.equal(count(fx.db, 'memory_version_feedback'), 1);
    assert.equal(count(fx.db, 'memory_feedback_actions'), 1);
    assert.equal(count(fx.db, 'memory_feedback_action_audit'), 0);
    assert.equal(count(fx.db, 'memory_feedback_action_resolutions'), 0);
    assert.equal(count(fx.db, 'memory_lifecycle_actions'), 0);
    const persisted = JSON.stringify([
      fx.db.prepare('SELECT * FROM memory_version_feedback').all(),
      fx.db.prepare('SELECT * FROM memory_feedback_action_resolutions').all(),
      fx.db.prepare('SELECT * FROM memory_feedback_action_audit').all(),
    ]);
    for (const value of [secret, 'feedback-resolution-secret', 'feedback-evidence-secret',
      'feedback-summary-secret', '-----BEGIN RSA PRIVATE KEY-----secret']) {
      assert.equal(persisted.includes(value), false);
    }
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
    assert.throws(() => fx.service.resolveAction(WS, pendingAction.id, 1, 'rejected'), /injected audit insert failure/);
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
