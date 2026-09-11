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
