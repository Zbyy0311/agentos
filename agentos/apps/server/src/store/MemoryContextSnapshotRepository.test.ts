import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MemoryBudgetPolicyV1, MemorySelectionExplanationV1 } from '@agentos/shared';
import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { createFileBackupProvider } from '../migrations/backup.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from './Transaction.js';
import {
  MemoryContextSnapshotRepository,
  MemoryContextSnapshotError,
  assertSnapshotPersisted,
} from './MemoryContextSnapshotRepository.js';

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
const NOW2 = '2026-09-09T01:00:00.000Z';
const WS = 'ws_mf4r';
const TASK = 'task_mf4r';
const RUN = 'run_mf4r';
const MEM = 'mem_' + 'e'.repeat(26);
const SNAP = 'mctx_' + 'f'.repeat(26);

const BUDGET: MemoryBudgetPolicyV1 = {
  maxTokens: 100,
  maxEntries: 5,
  perScopeLimits: { task: 3 },
  perCategoryLimits: { decision: 2 },
  minConfidence: 0.5,
  minImportance: 0.3,
  maxTruncation: 1,
  requireDiversity: true,
};

function fixture(): { db: SqliteDb; repo: MemoryContextSnapshotRepository; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf4-repo-'));
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
  ).run(WS, WS, 'C:/tmp/ws_mf4r', 'C:/tmp/ws_mf4r', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(RUN, WS, TASK, RUN, 'queued', 'initial', 'test', NOW, NOW);
  const repo = new MemoryContextSnapshotRepository(db as unknown as TransactionDatabase);
  return { db, repo, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function selected(overrides: Partial<MemorySelectionExplanationV1> = {}): MemorySelectionExplanationV1 {
  return {
    memoryId: MEM,
    memoryVersion: 1,
    rank: 1,
    score: 42.5,
    scope: 'task',
    category: 'decision',
    authority: 'system-verified',
    confidence: 0.9,
    importance: 0.5,
    tokenCost: 10,
    reasons: ['scope-match', 'importance'],
    sourceRefs: [{ kind: 'run', id: RUN }],
    ...overrides,
  };
}

function snapshotInput(overrides: Record<string, unknown> = {}) {
  return {
    id: SNAP,
    workspaceId: WS,
    taskId: TASK,
    runId: RUN,
    queryHash: 'qh',
    retrievalStrategyVersion: 'mf3-ranking-v1',
    budget: BUDGET,
    totalTokens: 10,
    truncated: false,
    createdAt: NOW,
    selected: [selected()],
    exclusions: [{ memoryId: MEM + 'x', reason: 'below-confidence' }],
    ...overrides,
  } as Parameters<MemoryContextSnapshotRepository['createSnapshot']>[0];
}

function expectCode(error: unknown, code: MemoryContextSnapshotError['code']): boolean {
  assert.ok(error instanceof MemoryContextSnapshotError);
  assert.equal(error.code, code);
  return true;
}

// MF4R-01 — snapshot and rows round-trip.
test('MF4R-01 snapshot round-trips selection and exclusions', () => {
  const fx = fixture();
  try {
    const snapshot = fx.repo.createSnapshot(snapshotInput());
    assert.equal(snapshot.id, SNAP);
    assert.equal(snapshot.runId, RUN);
    assert.deepEqual(snapshot.budget, BUDGET);
    assert.equal(snapshot.selected.length, 1);
    assert.equal(snapshot.selected[0].memoryId, MEM);
    assert.deepEqual(snapshot.selected[0].reasons, ['scope-match', 'importance']);
    assert.deepEqual(snapshot.exclusions, [{ memoryId: MEM + 'x', reason: 'below-confidence' }]);
  } finally { fx.close(); }
});

// MF4R-02 — write-once: no update path exists and DB rejects it.
test('MF4R-02 snapshot is write-once', () => {
  const fx = fixture();
  try {
    fx.repo.createSnapshot(snapshotInput());
    assert.throws(
      () => fx.db.prepare('UPDATE memory_context_snapshots SET total_tokens = 99 WHERE id = ?').run(SNAP),
      /MEMORY_CONTEXT_SNAPSHOT_IMMUTABLE/,
    );
    assert.throws(
      () => fx.db.prepare('DELETE FROM memory_context_snapshots WHERE id = ?').run(SNAP),
      /MEMORY_CONTEXT_SNAPSHOT_DELETE_FORBIDDEN/,
    );
  } finally { fx.close(); }
});

// MF4R-03 — later snapshot for the same Run is a new row; the first is unchanged.
test('MF4R-03 a later snapshot appends without rewriting history', () => {
  const fx = fixture();
  try {
    const first = fx.repo.createSnapshot(snapshotInput());
    const second = fx.repo.createSnapshot(snapshotInput({ id: SNAP + '2', createdAt: NOW2, totalTokens: 20 }));
    assert.notEqual(first.id, second.id);
    assert.equal(fx.repo.findById(WS, SNAP)?.totalTokens, 10);
    assert.equal(fx.repo.findLatestForRun(WS, RUN)?.id, SNAP + '2');
  } finally { fx.close(); }
});

// MF4R-04 — invalid input fails closed.
test('MF4R-04 invalid input fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.repo.createSnapshot(snapshotInput({ id: '' })), (e: unknown) => expectCode(e, 'INPUT_INVALID'));
    assert.throws(() => fx.repo.createSnapshot(snapshotInput({ totalTokens: -1 })), (e: unknown) => expectCode(e, 'INPUT_INVALID'));
    assert.throws(
      () => fx.repo.createSnapshot(snapshotInput({ selected: [selected({ reasons: [] })] })),
      (e: unknown) => expectCode(e, 'INPUT_INVALID'),
    );
    // An all-excluded snapshot is legitimate (no Entry met the budget).
    const emptySelection = fx.repo.createSnapshot(snapshotInput({ id: SNAP + 'e', selected: [] }));
    assert.equal(emptySelection.selected.length, 0);
    assert.throws(
      () => fx.repo.createSnapshot(snapshotInput({ selected: [selected(), selected()] })),
      (e: unknown) => expectCode(e, 'INPUT_INVALID'),
    );
  } finally { fx.close(); }
});

// MF4R-05 — unknown Run fails closed.
test('MF4R-05 unknown run fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createSnapshot(snapshotInput({ runId: 'run_missing' })),
      (e: unknown) => expectCode(e, 'INPUT_INVALID'),
    );
  } finally { fx.close(); }
});

// MF4R-06 — atomic: a failing exclusion rolls back the snapshot.
test('MF4R-06 snapshot creation is atomic', () => {
  const fx = fixture();
  try {
    assert.throws(
      () => fx.repo.createSnapshot(snapshotInput({ exclusions: [{ memoryId: MEM, reason: 'truncated' }] })),
      (e: unknown) => expectCode(e, 'INPUT_INVALID'),
    );
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_context_snapshots').get() as { c: number }).c, 0);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_context_snapshot_entries').get() as { c: number }).c, 0);
  } finally { fx.close(); }
});

// MF4R-07 — workspace scoping.
test('MF4R-07 reads are workspace-scoped', () => {
  const fx = fixture();
  try {
    fx.repo.createSnapshot(snapshotInput());
    assert.equal(fx.repo.findById('ws_other', SNAP), undefined);
    assert.equal(fx.repo.findLatestForRun('ws_other', RUN), undefined);
    assert.ok(fx.repo.findById(WS, SNAP) !== undefined);
  } finally { fx.close(); }
});

// MF4R-08 — injection gate fails closed on an absent snapshot.
test('MF4R-08 injection gate fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(() => assertSnapshotPersisted(undefined), (e: unknown) => expectCode(e, 'SNAPSHOT_NOT_FOUND'));
    const snapshot = fx.repo.createSnapshot(snapshotInput());
    assert.doesNotThrow(() => assertSnapshotPersisted(snapshot));
  } finally { fx.close(); }
});
