import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { MemoryBudgetPolicyV1 } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { hashMemoryText, normalizeMemoryText } from '../services/MemoryCandidateGenerationService.js';
import { createMemoryRuntimeRoutes } from './memoryRuntime.js';

const NOW = '2026-09-11T00:00:00.000Z';
const NOW2 = '2026-09-11T01:00:00.000Z';
const WS = 'workspace-a';
const TASK = 'task_mf5api';
const RUN = 'run_mf5api';
const MEM_A = 'mem_' + 'a'.repeat(26);
const MEM_B = 'mem_' + 'b'.repeat(26);
const SNAP_RUN = 'mctx_' + 'r'.repeat(26);
const SNAP_STAGE = 'mctx_' + 's'.repeat(26);
const CONFLICT = 'mcf_' + 'c'.repeat(26);
const CAND = 'mc_' + 'd'.repeat(26);

const BUDGET: MemoryBudgetPolicyV1 = {
  maxTokens: 100,
  maxEntries: 5,
  perScopeLimits: {},
  perCategoryLimits: {},
  minConfidence: 0.5,
  minImportance: 0.3,
  maxTruncation: 1,
  requireDiversity: false,
};

function createProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf5-api-'));
  mkdirSync(join(root, 'workspace'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'workspaces.json'), JSON.stringify({
    workspaces: [{
      id: WS, name: 'Workspace A', rootPath: root, gitEnabled: true, memoryEnabled: true,
      agents: [
        { id: 'codex', name: 'Codex', role: 'codex', enabled: true, cliCommand: 'codex', cliArgs: [] },
      ],
      lastOpenedAt: NOW, createdAt: NOW, updatedAt: NOW,
    }],
  }), 'utf-8');
  return root;
}

function seedDurableRows(store: SqliteStore): void {
  const db = store.getDatabase();
  // The workspaces row is already synced from workspaces.json by SqliteStore.
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(RUN, WS, TASK, RUN, 'queued', 'initial', 'test', NOW, NOW);
}

function seedEntries(store: SqliteStore): void {
  const entries = new MemoryEntryRepository(store.getDatabase());
  entries.createEntry({
    id: MEM_A,
    workspaceId: WS,
    scope: 'workspace',
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.8,
    title: 'Workspace uses pnpm workspaces',
    content: 'All package management goes through pnpm workspace protocols.',
    tags: ['tooling'],
    status: 'active',
    tokenEstimate: 12,
    sources: [{ kind: 'run', id: RUN }],
    createdAt: NOW,
  });
  entries.createEntry({
    id: MEM_B,
    workspaceId: WS,
    scope: 'workspace',
    category: 'preference',
    authority: 'user-explicit',
    confidence: 0.7,
    importance: 0.4,
    title: 'Prefers dark theme',
    content: 'The user prefers a dark editor theme.',
    tags: ['ui'],
    status: 'active',
    tokenEstimate: 8,
    sources: [{ kind: 'run', id: RUN }],
    createdAt: NOW2,
  });
}

function seedSnapshots(store: SqliteStore): void {
  const snapshots = new MemoryContextSnapshotRepository(store.getDatabase());
  const base = {
    workspaceId: WS,
    taskId: TASK,
    runId: RUN,
    queryHash: 'qh',
    retrievalStrategyVersion: 'mf3-ranking-v1',
    budget: BUDGET,
    truncated: false,
  };
  snapshots.createSnapshot({
    ...base,
    id: SNAP_RUN,
    totalTokens: 12,
    createdAt: NOW,
    selected: [{
      memoryId: MEM_A,
      memoryVersion: 1,
      rank: 1,
      score: 42.5,
      scope: 'workspace',
      category: 'decision',
      authority: 'system-verified',
      confidence: 0.9,
      importance: 0.8,
      tokenCost: 12,
      reasons: ['scope-match', 'importance'],
      sourceRefs: [{ kind: 'run', id: RUN }],
    }],
    exclusions: [{ memoryId: MEM_B, reason: 'below-confidence' }],
  });
  snapshots.createSnapshot({
    ...base,
    id: SNAP_STAGE,
    stageId: 'stage_mf5api',
    totalTokens: 8,
    createdAt: NOW2,
    selected: [{
      memoryId: MEM_B,
      memoryVersion: 1,
      rank: 1,
      score: 31,
      scope: 'workspace',
      category: 'preference',
      authority: 'user-explicit',
      confidence: 0.7,
      importance: 0.4,
      tokenCost: 8,
      reasons: ['scope-match'],
      sourceRefs: [{ kind: 'run', id: RUN }],
    }],
    exclusions: [],
  });
}

function seedConflict(store: SqliteStore): void {
  new MemoryCandidateRepository(store.getDatabase()).openConflict({
    id: CONFLICT,
    workspaceId: WS,
    conflictType: 'contradiction',
    entryAId: MEM_A,
    entryBId: MEM_B,
    createdAt: NOW,
  });
}

function seedCandidate(store: SqliteStore): void {
  new MemoryCandidateRepository(store.getDatabase()).createCandidate({
    id: CAND,
    workspaceId: WS,
    scope: 'workspace',
    category: 'preference',
    authority: 'agent-derived',
    confidence: 0.6,
    importance: 0.5,
    title: 'Inferred preference candidate',
    content: 'The user seems to prefer compact answers.',
    inferredPreference: true, // always review-required per the MF-0 gate
    sources: [{ kind: 'run', id: RUN }],
    createdAt: NOW,
    minConfidence: 0.5,
    maxTokenEstimate: 1000,
  });
}

async function withServer(run: (baseUrl: string, store: SqliteStore) => Promise<void>): Promise<void> {
  const root = createProjectRoot();
  const store = new SqliteStore(root);
  const app = express();
  const server = app.listen(0);
  try {
    app.use(express.json());
    app.use('/api/workspaces/:workspaceId', createMemoryRuntimeRoutes(store, new WorkspaceManager(store)));
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/workspaces/${WS}`, store);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close?.();
    rmSync(root, { recursive: true, force: true });
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

interface WorkspaceEventRow {
  readonly id: string;
  readonly type: string;
  readonly sequence: number;
  readonly correlation_id: string;
  readonly causation_id: string;
  readonly payload_json: string;
}

function workspaceEvents(store: SqliteStore, workspaceId: string): WorkspaceEventRow[] {
  return store.getDatabase().prepare(
    'SELECT id, type, sequence, correlation_id, causation_id, payload_json FROM workspace_events'
    + ' WHERE workspace_id = ? ORDER BY sequence ASC',
  ).all(workspaceId) as WorkspaceEventRow[];
}

function scalar(store: SqliteStore, sql: string, ...params: readonly string[]): number {
  const row = store.getDatabase().prepare(sql).get(...params) as { n: number | bigint };
  return Number(row.n);
}

test('MF5W-A10/A14: the review and resolve routes append Workspace Events, not Run-scoped rows', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    seedEntries(store);
    seedCandidate(store);
    seedConflict(store);
    assert.deepEqual(workspaceEvents(store, WS), []);

    const reviewed = await postJson(`${baseUrl}/memory/candidates/${CAND}/review`, {
      expectedVersion: 1, outcome: 'accept',
    });
    assert.equal(reviewed.status, 200);
    const reviewedRow = reviewed.json as { candidate: { mergedIntoEntryId: string | null; version: number } };
    assert.equal(reviewedRow.candidate.version, 2);
    assert.deepEqual(workspaceEvents(store, WS).map(event => event.type), [
      'memory.candidate_reviewed', 'memory.entry_created',
    ]);
    // The chain is the DERIVED one: the durable Candidate row owns it.
    const reviewEvent = workspaceEvents(store, WS)[0]!;
    assert.equal(reviewEvent.correlation_id, 'memory-candidate:' + CAND + ':v2');
    assert.equal(reviewEvent.causation_id, CAND);
    assert.deepEqual(JSON.parse(reviewEvent.payload_json), {
      candidateId: CAND, candidateVersion: 2, outcome: 'accept',
      memoryEntryId: reviewedRow.candidate.mergedIntoEntryId,
    });

    const resolved = await postJson(`${baseUrl}/memory-conflicts/${CONFLICT}/resolve`, {
      expectedVersion: 1, disposition: 'keep-both',
    });
    assert.equal(resolved.status, 200);
    assert.deepEqual(workspaceEvents(store, WS).map(event => [event.sequence, event.type]), [
      [1, 'memory.candidate_reviewed'], [2, 'memory.entry_created'],
      [3, 'memory.conflict_resolved'], [4, 'memory.entry_updated'], [5, 'memory.entry_updated'],
    ]);
    assert.equal(workspaceEvents(store, WS)[2]!.correlation_id, 'memory-conflict:' + CONFLICT + ':v2');
    assert.equal(workspaceEvents(store, WS)[2]!.causation_id, CONFLICT);

    // One Workspace stream only: no Run-scoped fact, sequence, or Outbox row.
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM runtime_events'), 0);
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM outbox_messages'), 0);
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM operations'), 0);
    assert.equal(scalar(store, 'SELECT next_event_sequence AS n FROM runs WHERE id = ?', RUN), 1);
    assert.equal(
      scalar(store, 'SELECT next_event_sequence AS n FROM workspaces WHERE id = ?', WS),
      workspaceEvents(store, WS).length + 1,
    );
    // Events survive as the Workspace's own history, readable in append order.
    const tail = workspaceEvents(store, WS).slice(-1)[0]!;
    assert.equal(tail.sequence, 5);
  });
});

test('MF-5 retrieve: ranked results with reasons, filters, limit, and degraded flag', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    seedEntries(store);

    const all = await postJson(`${baseUrl}/memory/retrieve`, {});
    assert.equal(all.status, 200);
    const allBody = all.json as { degraded: boolean; results: Array<{ entry: { id: string }; reasons: string[] }> };
    assert.equal(allBody.degraded, false);
    assert.equal(allBody.results.length, 2);
    assert.ok(allBody.results[0]!.reasons.length > 0);

    const queried = await postJson(`${baseUrl}/memory/retrieve`, { query: 'pnpm' });
    assert.equal(queried.status, 200);
    const queriedBody = queried.json as { degraded: boolean; results: Array<{ entry: { id: string }; ftsRank: number | null }> };
    assert.equal(queriedBody.degraded, false);
    assert.equal(queriedBody.results[0]!.entry.id, MEM_A);
    assert.ok(queriedBody.results[0]!.ftsRank !== null);

    const filtered = await postJson(`${baseUrl}/memory/retrieve`, { categoryFilter: ['preference'] });
    const filteredBody = filtered.json as { results: Array<{ entry: { id: string; category: string } }> };
    assert.equal(filteredBody.results.length, 1);
    assert.equal(filteredBody.results[0]!.entry.id, MEM_B);

    const limited = await postJson(`${baseUrl}/memory/retrieve`, { limit: 1 });
    assert.equal((limited.json as { results: unknown[] }).results.length, 1);

    const badLimit = await postJson(`${baseUrl}/memory/retrieve`, { limit: 0 });
    assert.equal(badLimit.status, 400);
    const badQuery = await postJson(`${baseUrl}/memory/retrieve`, { query: 42 });
    assert.equal(badQuery.status, 400);
  });
});

test('MF-5 retrieve: unknown Workspace is 404', async () => {
  await withServer(async (baseUrl) => {
    const missingBase = baseUrl.replace(`/api/workspaces/${WS}`, '/api/workspaces/ws_missing');
    const miss = await postJson(`${missingBase}/memory/retrieve`, {});
    assert.equal(miss.status, 404);
    const missContext = await fetch(`${missingBase}/memory-contexts/mctx_missing`);
    assert.equal(missContext.status, 404);
  });
});

test('MF-5 Run memory-context: 404 for unknown Run, ordered snapshots otherwise', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    seedEntries(store);

    const missingRun = await fetch(`${baseUrl}/runs/run_missing/memory-context`);
    assert.equal(missingRun.status, 404);

    const empty = await fetch(`${baseUrl}/runs/${RUN}/memory-context`).then(r => r.json()) as { snapshots: unknown[] };
    assert.equal(empty.snapshots.length, 0);

    seedSnapshots(store);
    const listed = await fetch(`${baseUrl}/runs/${RUN}/memory-context`).then(r => r.json()) as {
      snapshots: Array<{ id: string; stageId: string | null; selected: unknown[] }>;
    };
    assert.equal(listed.snapshots.length, 2);
    assert.equal(listed.snapshots[0]!.id, SNAP_RUN);
    assert.equal(listed.snapshots[0]!.stageId, null);
    assert.equal(listed.snapshots[1]!.id, SNAP_STAGE);
    assert.equal(listed.snapshots[1]!.stageId, 'stage_mf5api');
  });
});

test('MF-5 memory-context by id: frozen snapshot with selection and exclusion reasons', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    seedEntries(store);
    seedSnapshots(store);

    const missing = await fetch(`${baseUrl}/memory-contexts/mctx_missing`);
    assert.equal(missing.status, 404);

    const found = await fetch(`${baseUrl}/memory-contexts/${SNAP_RUN}`);
    assert.equal(found.status, 200);
    const { snapshot } = await found.json() as {
      snapshot: {
        id: string;
        runId: string;
        selected: Array<{ memoryId: string; reasons: string[] }>;
        exclusions: Array<{ memoryId: string; reason: string }>;
      };
    };
    assert.equal(snapshot.id, SNAP_RUN);
    assert.equal(snapshot.runId, RUN);
    assert.equal(snapshot.selected[0]!.memoryId, MEM_A);
    assert.deepEqual(snapshot.selected[0]!.reasons, ['scope-match', 'importance']);
    assert.equal(snapshot.exclusions[0]!.memoryId, MEM_B);
    assert.equal(snapshot.exclusions[0]!.reason, 'below-confidence');
  });
});

test('MF-5 conflict resolve: 200 once, 409 on replay or version skew, 404 unknown', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    seedEntries(store);
    seedConflict(store);

    const missing = await postJson(`${baseUrl}/memory-conflicts/mcf_missing/resolve`, {
      expectedVersion: 1, disposition: 'keep-both',
    });
    assert.equal(missing.status, 404);

    const skewed = await postJson(`${baseUrl}/memory-conflicts/${CONFLICT}/resolve`, {
      expectedVersion: 99, disposition: 'keep-both',
    });
    assert.equal(skewed.status, 409);

    const resolved = await postJson(`${baseUrl}/memory-conflicts/${CONFLICT}/resolve`, {
      expectedVersion: 1, disposition: 'keep-both',
    });
    assert.equal(resolved.status, 200);
    const { conflict } = resolved.json as { conflict: { id: string; status: string; disposition: string; version: number } };
    assert.equal(conflict.id, CONFLICT);
    assert.equal(conflict.status, 'resolved');
    assert.equal(conflict.disposition, 'keep-both');
    assert.equal(conflict.version, 2);

    const replay = await postJson(`${baseUrl}/memory-conflicts/${CONFLICT}/resolve`, {
      expectedVersion: 2, disposition: 'keep-both',
    });
    assert.equal(replay.status, 409);

    const badDisposition = await postJson(`${baseUrl}/memory-conflicts/${CONFLICT}/resolve`, {
      expectedVersion: 2, disposition: 'delete-everything',
    });
    assert.equal(badDisposition.status, 400);
  });
});

test('MF-5 candidate queue: list, outcome filter, and version-guarded review', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    seedEntries(store);
    seedCandidate(store);

    const queue = await fetch(`${baseUrl}/memory/candidates?outcome=review-required`)
      .then(r => r.json()) as { candidates: Array<{ id: string; outcome: string; decision: string }> };
    assert.equal(queue.candidates.length, 1);
    assert.equal(queue.candidates[0]!.id, CAND);
    assert.equal(queue.candidates[0]!.outcome, 'review-required');

    const all = await fetch(`${baseUrl}/memory/candidates`).then(r => r.json()) as { candidates: unknown[] };
    assert.equal(all.candidates.length, 1);

    const badFilter = await fetch(`${baseUrl}/memory/candidates?outcome=bogus`);
    assert.equal(badFilter.status, 400);

    const missing = await postJson(`${baseUrl}/memory/candidates/mc_missing/review`, {
      expectedVersion: 1, outcome: 'accept',
    });
    assert.equal(missing.status, 404);

    const skewed = await postJson(`${baseUrl}/memory/candidates/${CAND}/review`, {
      expectedVersion: 99, outcome: 'accept',
    });
    assert.equal(skewed.status, 409);

    const mergeNoTarget = await postJson(`${baseUrl}/memory/candidates/${CAND}/review`, {
      expectedVersion: 1, outcome: 'merge-with-existing',
    });
    assert.equal(mergeNoTarget.status, 400);

    const merged = await postJson(`${baseUrl}/memory/candidates/${CAND}/review`, {
      expectedVersion: 1, outcome: 'merge-with-existing', mergedIntoEntryId: MEM_A,
    });
    assert.equal(merged.status, 200);
    const { candidate } = merged.json as { candidate: { outcome: string; mergedIntoEntryId: string | null; version: number } };
    assert.equal(candidate.outcome, 'merge-with-existing');
    assert.equal(candidate.mergedIntoEntryId, MEM_A);
    assert.equal(candidate.version, 2);

    const rejected = await postJson(`${baseUrl}/memory/candidates/${CAND}/review`, {
      expectedVersion: 2, outcome: 'reject',
    });
    assert.equal(rejected.status, 409);
    assert.equal((rejected.json as { error: string }).error, 'CANDIDATE_NOT_REVIEWABLE');
  });
});

test('MF-5 candidate review: strict edits promote an Entry and retrieval sees only the active Entry', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    seedEntries(store);
    seedCandidate(store);

    const invalidEdit = await postJson(`${baseUrl}/memory/candidates/${CAND}/review`, {
      expectedVersion: 1,
      outcome: 'edit-and-accept',
      edits: { content: 'changed', scope: 'global' },
    });
    assert.equal(invalidEdit.status, 400);

    const forbiddenTopLevel = await postJson(`${baseUrl}/memory/candidates/${CAND}/review`, {
      expectedVersion: 1,
      outcome: 'accept',
      authority: 'user-explicit',
    });
    assert.equal(forbiddenTopLevel.status, 400);

    const edited = await postJson(`${baseUrl}/memory/candidates/${CAND}/review`, {
      expectedVersion: 1,
      outcome: 'edit-and-accept',
      edits: {
        title: 'Edited compact preference',
        summary: 'edited summary',
        content: 'Edited compact answers are preferred.',
        tags: ['reviewed'],
      },
    });
    assert.equal(edited.status, 200);
    const editedCandidate = edited.json as {
      candidate: { outcome: string; version: number; mergedIntoEntryId: string | null; title: string };
    };
    assert.equal(editedCandidate.candidate.outcome, 'edit-and-accept');
    assert.equal(editedCandidate.candidate.version, 2);
    assert.equal(editedCandidate.candidate.mergedIntoEntryId, CAND);
    assert.equal(editedCandidate.candidate.title, 'Edited compact preference');

    const entries = new MemoryEntryRepository(store.getDatabase());
    const entry = entries.findById(WS, CAND);
    assert.equal(entry?.status, 'active');
    assert.equal(entry?.scope, 'workspace');
    assert.equal(entry?.authority, 'agent-derived');
    assert.deepEqual(entry?.tags, ['reviewed']);

    const retrieved = await postJson(`${baseUrl}/memory/retrieve`, { query: 'compact' });
    assert.equal(retrieved.status, 200);
    const results = (retrieved.json as { results: Array<{ entry: { id: string }; ftsRank: number | null }> }).results;
    const promoted = results.find(result => result.entry.id === CAND);
    assert.ok(promoted);
    assert.ok(promoted.ftsRank !== null);

    const replay = await postJson(`${baseUrl}/memory/candidates/${CAND}/review`, {
      expectedVersion: 2, outcome: 'accept',
    });
    assert.equal(replay.status, 409);
  });
});
test('MF-2 explicit user save: creates the Entry and one Workspace Event in one transaction', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    const saved = await postJson(`${baseUrl}/memory/entries`, {
      title: '用户偏好', content: 'The user prefers compact answers.', scope: 'workspace', category: 'preference',
    });
    assert.equal(saved.status, 201);
    const savedBody = saved.json as { entry: { id: string; status: string; authority: string; scope: string }; converged: boolean };
    assert.equal(savedBody.converged, false);
    assert.equal(savedBody.entry.status, 'active');
    assert.equal(savedBody.entry.authority, 'user-explicit');
    assert.equal(savedBody.entry.scope, 'workspace');

    const db = store.getDatabase();
    const wsEvents = db.prepare('SELECT type, sequence, correlation_id, causation_id, payload_json FROM workspace_events WHERE workspace_id = ? ORDER BY sequence')
      .all(WS) as Array<{ type: string; sequence: number; correlation_id: string; causation_id: string; payload_json: string }>;
    assert.equal(wsEvents.length, 1);
    assert.equal(wsEvents[0]!.type, 'memory.entry_created');
    assert.equal(wsEvents[0]!.correlation_id, 'memory-entry:' + savedBody.entry.id + ':v1');
    assert.equal(wsEvents[0]!.causation_id, savedBody.entry.id);
    const payload = JSON.parse(wsEvents[0]!.payload_json) as Record<string, unknown>;
    assert.equal(payload.memoryEntryId, savedBody.entry.id);
    assert.equal(payload.version, 1);
    assert.equal(payload.authority, 'user-explicit');
    // No Run-scoped fact was written.
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM runtime_events').get() as { n: number | bigint }).n), 0);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM outbox_messages').get() as { n: number | bigint }).n), 0);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM operations').get() as { n: number | bigint }).n), 0);

    // The saved Entry is retrievable through the MF-3 explanation path.
    const retrieved = await postJson(`${baseUrl}/memory/retrieve`, { query: 'compact' });
    assert.equal(retrieved.status, 200);
    const retrievedBody = retrieved.json as { results: Array<{ entry: { id: string; authority: string } }> };
    assert.ok(retrievedBody.results.some(r => r.entry.id === savedBody.entry.id && r.entry.authority === 'user-explicit'));

    // A duplicate save converges: no second Entry, no second Event, no sequence bump.
    const dup = await postJson(`${baseUrl}/memory/entries`, {
      title: '用户偏好（重复）', content: 'The user prefers compact answers.', scope: 'workspace', category: 'preference',
    });
    assert.equal(dup.status, 200);
    assert.equal((dup.json as { converged: boolean }).converged, true);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM workspace_events WHERE workspace_id = ?').get(WS) as { n: number | bigint }).n), 1);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?').get(WS) as { n: number | bigint }).n), 1);

    // The legacy memories surface writes no Workspace Event.
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM workspace_events').get() as { n: number | bigint }).n), 1);
  });
});

test('LITE-07-003/107: explicit save validates invalid scope, category, sources, and owners before duplicate lookup', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    seedEntries(store);
    const sameContent = 'All package management goes through pnpm workspace protocols.';
    store.getDatabase().prepare('UPDATE memory_entries SET exact_content_hash = ?, normalized_text_hash = ?, version = version + 1 WHERE id = ?')
      .run(hashMemoryText(sameContent), hashMemoryText(normalizeMemoryText(sameContent)), MEM_A);

    const invalidBodies = [
      { scope: 'not-a-scope', category: 'decision' },
      { scope: 'workspace', category: 'not-a-category' },
      { scope: 'workspace', category: 'decision', sources: [{ kind: 'not-a-source', id: RUN }] },
      { scope: 'workspace', category: 'decision', sources: [null] },
      { scope: 'workspace', category: 'decision', sources: { kind: 'run', id: RUN } },
      { scope: 'workspace', category: 'decision', sources: [{ kind: 'run', id: RUN }, { kind: 'run', id: RUN }] },
      { scope: 'workspace', category: 'decision', tags: 'invalid-tags' },
      { scope: 'workspace', category: 'decision', tags: [null] },
      { scope: 'workspace', category: 'decision', ownerAgentId: 'agent_unsupported' },
      { scope: 'workspace', category: 'decision', ownerConversationId: 'conversation_unsupported' },
      { scope: 'workspace', category: 'decision', ownerTaskId: TASK },
      { scope: 'workspace', category: 'decision', ownerRunId: RUN },
    ];
    for (const fields of invalidBodies) {
      const response = await postJson(`${baseUrl}/memory/entries`, {
        title: 'same content, invalid envelope',
        content: 'All package management goes through pnpm workspace protocols.',
        ...fields,
      });
      assert.equal(response.status, 400);
    }

    assert.equal(workspaceEvents(store, WS).length, 0);
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?', WS), 2);
  });
});

test('LITE-07-003: explicit save does not converge across category or global/workspace scope', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    const entries = new MemoryEntryRepository(store.getDatabase());
    const content = 'This boundary probe must remain distinct by category and scope.';
    const globalEntryId = 'mem_' + 'g'.repeat(26);
    entries.createEntry({
      id: globalEntryId,
      workspaceId: WS,
      scope: 'global',
      category: 'decision',
      authority: 'system-verified',
      confidence: 1,
      importance: 0.5,
      title: 'global boundary seed',
      content,
      tags: [],
      status: 'active',
      tokenEstimate: 10,
      exactContentHash: hashMemoryText(content),
      normalizedTextHash: hashMemoryText(normalizeMemoryText(content)),
      sources: [{ kind: 'run', id: RUN }],
      createdAt: NOW,
    });
    const workspaceDecision = await postJson(`${baseUrl}/memory/entries`, {
      title: 'workspace decision', content, scope: 'workspace', category: 'decision',
      sources: [{ kind: 'run', id: RUN }],
    });
    const workspacePreference = await postJson(`${baseUrl}/memory/entries`, {
      title: 'workspace preference', content, scope: 'workspace', category: 'preference',
      sources: [{ kind: 'run', id: RUN }],
    });

    assert.equal(workspaceDecision.status, 201);
    assert.equal(workspacePreference.status, 201);
    const saved = [workspaceDecision, workspacePreference].map(result => result.json as {
      converged: boolean; entry: { id: string };
    });
    assert.deepEqual(saved.map(result => result.converged), [false, false]);
    assert.equal(new Set(saved.map(result => result.entry.id)).size, 2);
    assert.notEqual(saved[0]!.entry.id, globalEntryId);
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?', WS), 3);
    assert.deepEqual(workspaceEvents(store, WS).map(event => event.type), [
      'memory.entry_created', 'memory.entry_created',
    ]);
  });
});

test('LITE-07-003: an archived hash match does not swallow a legal explicit save', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    const first = await postJson(`${baseUrl}/memory/entries`, {
      title: 'archived source', content: 'An archived memory must not capture a new save.',
      scope: 'workspace', category: 'decision', sources: [{ kind: 'run', id: RUN }],
    });
    assert.equal(first.status, 201);
    const firstEntry = first.json as { entry: { id: string; version: number } };
    new MemoryEntryRepository(store.getDatabase()).updateStatus({
      workspaceId: WS, entryId: firstEntry.entry.id, expectedVersion: 1,
      status: 'archived', updatedAt: NOW2,
    });

    const saved = await postJson(`${baseUrl}/memory/entries`, {
      title: 'replacement save', content: 'An archived memory must not capture a new save.',
      scope: 'workspace', category: 'decision', sources: [{ kind: 'run', id: RUN }],
    });
    assert.equal(saved.status, 201);
    const savedBody = saved.json as { converged: boolean; entry: { id: string; status: string } };
    assert.equal(savedBody.converged, false);
    assert.notEqual(savedBody.entry.id, firstEntry.entry.id);
    assert.equal(savedBody.entry.status, 'active');
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?', WS), 2);
    assert.deepEqual(workspaceEvents(store, WS).map(event => event.type), [
      'memory.entry_created', 'memory.entry_created',
    ]);
  });
});

test('LITE-07-003: exact duplicate merges a new source once and emits one Workspace dedup event', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    const content = 'Exact duplicate provenance should extend the existing memory once.';
    const first = await postJson(`${baseUrl}/memory/entries`, {
      title: 'original provenance', content, scope: 'workspace', category: 'decision',
      sources: [{ kind: 'run', id: RUN }],
    });
    assert.equal(first.status, 201);
    const firstBody = first.json as { entry: { id: string; version: number } };
    assert.equal(firstBody.entry.version, 1);

    const duplicateBody = {
      title: 'new provenance', content, scope: 'workspace', category: 'decision',
      sources: [{ kind: 'task', id: TASK }],
    };
    const merged = await postJson(`${baseUrl}/memory/entries`, duplicateBody);
    assert.equal(merged.status, 200);
    const mergedBody = merged.json as { converged: boolean; entry: { id: string; version: number } };
    assert.equal(mergedBody.converged, true);
    assert.equal(mergedBody.entry.id, firstBody.entry.id);
    assert.equal(mergedBody.entry.version, 2);

    const replay = await postJson(`${baseUrl}/memory/entries`, duplicateBody);
    assert.equal(replay.status, 200);
    const replayBody = replay.json as { converged: boolean; entry: { id: string; version: number } };
    assert.equal(replayBody.converged, true);
    assert.equal(replayBody.entry.version, 2);

    const entry = new MemoryEntryRepository(store.getDatabase()).findById(WS, firstBody.entry.id);
    assert.ok(entry);
    assert.equal(entry.version, 2);
    assert.deepEqual(entry.sources.map(source => source.kind + ':' + source.id).sort(), [
      'run:' + RUN, 'task:' + TASK,
    ].sort());
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM memory_entries WHERE workspace_id = ?', WS), 1);
    const events = workspaceEvents(store, WS);
    assert.deepEqual(events.map(event => [event.sequence, event.type]), [
      [1, 'memory.entry_created'], [2, 'memory.entry_deduplicated'],
    ]);
    assert.equal(events.filter(event => event.type === 'memory.entry_deduplicated').length, 1);
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM runtime_events'), 0);
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM outbox_messages'), 0);
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM operations'), 0);
  });
});

test('LITE-07-003: Workspace Event failure rolls back exact-source merge, version, and sequence', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    const content = 'A failed dedup event must leave the original provenance untouched.';
    const first = await postJson(`${baseUrl}/memory/entries`, {
      title: 'transaction source', content, scope: 'workspace', category: 'decision',
      sources: [{ kind: 'run', id: RUN }],
    });
    assert.equal(first.status, 201);
    const firstBody = first.json as { entry: { id: string } };
    const entries = new MemoryEntryRepository(store.getDatabase());
    const before = entries.findById(WS, firstBody.entry.id);
    assert.ok(before);
    const sequenceBefore = scalar(store, 'SELECT next_event_sequence AS n FROM workspaces WHERE id = ?', WS);

    // Deterministically fail only the deduplication Workspace Event append.
    store.getDatabase().exec(`
      CREATE TRIGGER fail_memory_entry_deduplicated
      BEFORE INSERT ON workspace_events
      WHEN NEW.type = 'memory.entry_deduplicated'
      BEGIN
        SELECT RAISE(ABORT, 'injected workspace event failure');
      END;
    `);
    const failed = await postJson(`${baseUrl}/memory/entries`, {
      title: 'new source should roll back', content, scope: 'workspace', category: 'decision',
      sources: [{ kind: 'task', id: TASK }],
    });
    assert.equal(failed.status, 500);

    const after = entries.findById(WS, firstBody.entry.id);
    assert.ok(after);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.sources, before.sources);
    assert.equal(scalar(store, 'SELECT next_event_sequence AS n FROM workspaces WHERE id = ?', WS), sequenceBefore);
    assert.deepEqual(workspaceEvents(store, WS).map(event => [event.sequence, event.type]), [
      [1, 'memory.entry_created'],
    ]);
  });
});

test('LITE-07-003: source write failure rolls back dedup before any Event is published', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    const body = {
      title: 'source rollback', content: 'The original evidence must survive a failed new source.',
      scope: 'workspace', category: 'decision', sources: [{ kind: 'run', id: RUN }],
    };
    const first = await postJson(`${baseUrl}/memory/entries`, body);
    assert.equal(first.status, 201);
    const entryId = (first.json as { entry: { id: string } }).entry.id;
    const entries = new MemoryEntryRepository(store.getDatabase());
    const before = entries.findById(WS, entryId);
    const sequenceBefore = scalar(store, 'SELECT next_event_sequence AS n FROM workspaces WHERE id = ?', WS);
    store.getDatabase().exec(`
      CREATE TRIGGER fail_save_source BEFORE INSERT ON memory_entry_sources
      WHEN NEW.source_kind = 'task'
      BEGIN SELECT RAISE(ABORT, 'injected source failure'); END;
    `);
    const failed = await postJson(`${baseUrl}/memory/entries`, {
      ...body, sources: [{ kind: 'task', id: TASK }],
    });
    assert.equal(failed.status, 500);
    assert.deepEqual(entries.findById(WS, entryId), before);
    assert.equal(scalar(store, 'SELECT next_event_sequence AS n FROM workspaces WHERE id = ?', WS), sequenceBefore);
    assert.deepEqual(workspaceEvents(store, WS).map(event => event.type), ['memory.entry_created']);
  });
});

test('LITE-07-003: simultaneous exact saves converge to one source mutation and one Event', async () => {
  await withServer(async (baseUrl, store) => {
    seedDurableRows(store);
    const body = {
      title: 'concurrent provenance', content: 'Concurrent explicit saves share the same bounded target.',
      scope: 'workspace', category: 'decision', sources: [{ kind: 'run', id: RUN }],
    };
    const first = await postJson(`${baseUrl}/memory/entries`, body);
    assert.equal(first.status, 201);
    const entryId = (first.json as { entry: { id: string } }).entry.id;
    const replies = await Promise.all(Array.from({ length: 4 }, () =>
      postJson(`${baseUrl}/memory/entries`, { ...body, sources: [{ kind: 'task', id: TASK }] })));
    assert.deepEqual(replies.map(reply => reply.status), [200, 200, 200, 200]);
    const entry = new MemoryEntryRepository(store.getDatabase()).findById(WS, entryId)!;
    assert.equal(entry.version, 2);
    assert.equal(entry.sources.length, 2);
    assert.equal(scalar(store, 'SELECT COUNT(*) AS n FROM memory_entries'), 1);
    assert.deepEqual(workspaceEvents(store, WS).map(event => [event.sequence, event.type]), [
      [1, 'memory.entry_created'], [2, 'memory.entry_deduplicated'],
    ]);
  });
});
