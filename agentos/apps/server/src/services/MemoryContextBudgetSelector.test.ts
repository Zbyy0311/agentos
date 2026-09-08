import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MemoryBudgetPolicyV1 } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { MemoryRetrievalService } from './MemoryRetrievalService.js';
import {
  MemoryContextBudgetSelector,
  applyBudget,
  hashRetrievalQuery,
  type SelectMemoryContextInput,
} from './MemoryContextBudgetSelector.js';

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

const NOW = '2026-09-09T00:00:00.000Z';
const WS = 'ws_mf4b';
const TASK = 'task_mf4b';
const RUN = 'run_mf4b';
const SNAP = 'mctx_' + 'a'.repeat(26);

const BUDGET: MemoryBudgetPolicyV1 = {
  maxTokens: 30,
  maxEntries: 3,
  perScopeLimits: {},
  perCategoryLimits: {},
  minConfidence: 0.5,
  minImportance: 0.3,
  maxTruncation: 1,
  requireDiversity: false,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf4-budget-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(
    db as unknown as MinimalDatabaseSync,
    new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS),
    { backupProvider: createFileBackupProvider(join(root, 'backup')) },
  ).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_mf4b', 'C:/tmp/ws_mf4b', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(RUN, WS, TASK, RUN, 'queued', 'initial', 'test', NOW, NOW);
  const entries = new MemoryEntryRepository(db as unknown as TransactionDatabase);
  const retrieval = new MemoryRetrievalService(entries);
  const snapshots = new MemoryContextSnapshotRepository(db as unknown as TransactionDatabase);
  const selector = new MemoryContextBudgetSelector(retrieval, snapshots);
  return { db, entries, selector, snapshots, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

let seq = 0;
function addEntry(fx: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}): string {
  seq += 1;
  const id = 'mem_' + String(seq).padStart(4, '0') + 'b'.repeat(20);
  fx.entries.createEntry({
    id,
    workspaceId: WS,
    scope: 'task',
    ownerTaskId: TASK,
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.5,
    title: `entry ${seq}`,
    summary: 'summary',
    content: 'content',
    tags: [],
    status: 'active',
    sources: [{ kind: 'run', id: RUN }],
    createdAt: NOW,
    ...overrides,
  } as never);
  return id;
}

const RETRIEVAL = { context: { workspaceId: WS, taskId: TASK, runId: RUN } };

function selectInput(overrides: Partial<SelectMemoryContextInput> = {}): SelectMemoryContextInput {
  return {
    snapshotId: SNAP,
    retrieval: RETRIEVAL,
    budget: BUDGET,
    createdAt: NOW,
    ...overrides,
  };
}

// MF4B-01 — selection persists a snapshot and assembles context.
test('MF4B-01 selection persists snapshot and assembles context', () => {
  const fx = fixture();
  try {
    addEntry(fx, { title: 'alpha', content: 'body alpha' });
    const result = fx.selector.select(selectInput());
    assert.equal(result.snapshot.selected.length, 1);
    assert.ok(result.contextText.includes('alpha'));
    assert.ok(result.contextText.includes('body alpha'));
    const reloaded = fx.snapshots.findById(WS, SNAP);
    assert.ok(reloaded !== undefined);
    assert.deepEqual(reloaded.budget, BUDGET);
  } finally { fx.close(); }
});

// MF4B-02 — token budget truncates explicitly with an exclusion reason.
test('MF4B-02 token budget truncates explicitly', () => {
  const fx = fixture();
  try {
    addEntry(fx, { tokenEstimate: 20 });
    addEntry(fx, { tokenEstimate: 20 });
    const result = fx.selector.select(selectInput());
    assert.equal(result.snapshot.selected.length, 1);
    assert.equal(result.snapshot.totalTokens, 20);
    assert.equal(result.snapshot.truncated, true);
    assert.ok(result.snapshot.exclusions.some(e => e.reason === 'truncated'));
  } finally { fx.close(); }
});

// MF4B-03 — entry budget excludes beyond the cap.
test('MF4B-03 entry budget excludes beyond cap', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 5; i += 1) addEntry(fx, { tokenEstimate: 1 });
    const result = fx.selector.select(selectInput({ budget: { ...BUDGET, maxEntries: 2 } }));
    assert.equal(result.snapshot.selected.length, 2);
    assert.ok(result.snapshot.exclusions.filter(e => e.reason === 'entry-budget').length >= 1);
  } finally { fx.close(); }
});

// MF4B-04 — confidence and importance thresholds exclude.
test('MF4B-04 confidence and importance thresholds exclude', () => {
  const fx = fixture();
  try {
    addEntry(fx, { confidence: 0.9, importance: 0.9 });
    addEntry(fx, { confidence: 0.1, importance: 0.9 });
    addEntry(fx, { confidence: 0.9, importance: 0.05 });
    const result = fx.selector.select(selectInput());
    assert.equal(result.snapshot.selected.length, 1);
    const reasons = result.snapshot.exclusions.map(e => e.reason).sort();
    assert.deepEqual(reasons, ['below-confidence', 'below-importance']);
  } finally { fx.close(); }
});

// MF4B-05 — per-category limit excludes deterministically.
test('MF4B-05 per-category limit excludes', () => {
  const fx = fixture();
  try {
    addEntry(fx, { category: 'decision', tokenEstimate: 1 });
    addEntry(fx, { category: 'decision', tokenEstimate: 1 });
    const result = fx.selector.select(selectInput({
      budget: { ...BUDGET, perCategoryLimits: { decision: 1 }, maxTokens: 100 },
    }));
    assert.equal(result.snapshot.selected.length, 1);
    assert.ok(result.snapshot.exclusions.some(e => e.reason === 'category-budget'));
  } finally { fx.close(); }
});

// MF4B-06 — selection is reproducible for the same Store, query, and policy.
test('MF4B-06 selection is reproducible', () => {
  const fx = fixture();
  try {
    for (let i = 0; i < 3; i += 1) addEntry(fx, { tokenEstimate: 5 });
    const first = fx.selector.select(selectInput({ snapshotId: SNAP + '1' }));
    const second = fx.selector.select(selectInput({ snapshotId: SNAP + '2' }));
    assert.deepEqual(
      first.snapshot.selected.map(s => s.memoryId),
      second.snapshot.selected.map(s => s.memoryId),
    );
    assert.equal(first.snapshot.queryHash, second.snapshot.queryHash);
  } finally { fx.close(); }
});

// MF4B-07 — a later Entry edit does not change a persisted snapshot.
test('MF4B-07 later entry edits do not change a snapshot', () => {
  const fx = fixture();
  try {
    const id = addEntry(fx, { title: 'before', tokenEstimate: 5 });
    const result = fx.selector.select(selectInput());
    fx.entries.updateStatus({ workspaceId: WS, entryId: id, expectedVersion: 1, status: 'archived', updatedAt: NOW });
    const reloaded = fx.snapshots.findById(WS, SNAP);
    assert.equal(reloaded?.selected[0].memoryId, id);
    assert.equal(reloaded?.selected.length, result.snapshot.selected.length);
  } finally { fx.close(); }
});

// MF4B-08 — invalid input fails closed.
test('MF4B-08 invalid input fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.selector.select(selectInput({ snapshotId: '' })));
    assert.throws(() => fx.selector.select(selectInput({ budget: { ...BUDGET, maxTokens: 0 } })));
    assert.throws(() => fx.selector.select(selectInput({ retrieval: { context: { workspaceId: WS } } })));
  } finally { fx.close(); }
});

// MF4B-09 — query hash is stable and does not include query text.
test('MF4B-09 query hash is stable and opaque', () => {
  const a = hashRetrievalQuery({ context: { workspaceId: WS }, query: 'alpha' });
  const b = hashRetrievalQuery({ context: { workspaceId: WS }, query: 'alpha' });
  const c = hashRetrievalQuery({ context: { workspaceId: WS }, query: 'beta' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(!a.includes('alpha'));
});

// MF4B-10 — applyBudget is pure and records every considered Entry.
test('MF4B-10 applyBudget records every considered entry', () => {
  const entries = [
    { entry: { id: 'mem_1', scope: 'task', category: 'decision', confidence: 0.9, importance: 0.9, tokenEstimate: 5, pinned: false, version: 1, authority: 'system-verified', sources: [], title: 'a', content: 'a' }, rank: 1, score: 1, reasons: ['scope-match'], ftsRank: null },
    { entry: { id: 'mem_2', scope: 'task', category: 'decision', confidence: 0.1, importance: 0.9, tokenEstimate: 5, pinned: false, version: 1, authority: 'system-verified', sources: [], title: 'b', content: 'b' }, rank: 2, score: 0, reasons: ['scope-match'], ftsRank: null },
  ] as never;
  const outcome = applyBudget(entries, BUDGET);
  assert.equal(outcome.selected.length, 1);
  assert.equal(outcome.exclusions.length, 1);
});
