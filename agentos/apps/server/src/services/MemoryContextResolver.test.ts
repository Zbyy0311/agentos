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
import { MemoryContextBudgetSelector } from './MemoryContextBudgetSelector.js';
import {
  MemoryContextResolver,
  DEFAULT_MEMORY_BUDGET_POLICY_V1,
  MemoryContextResolverError,
} from './MemoryContextResolver.js';

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
const WS = 'ws_mf4i';
const TASK = 'task_mf4i';
const RUN = 'run_mf4i';
const STAGE = 'stage_mf4i';

const BUDGET: MemoryBudgetPolicyV1 = {
  maxTokens: 100,
  maxEntries: 3,
  perScopeLimits: {},
  perCategoryLimits: {},
  minConfidence: 0.5,
  minImportance: 0.3,
  maxTruncation: 1,
  requireDiversity: false,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-mf4-resolver-'));
  const path = join(root, 'agentos.sqlite');
  const db = new DatabaseSync(path);
  db.prepare('PRAGMA foreign_keys = ON').run();
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS), {
    backupProvider: createFileBackupProvider(join(root, 'backup')),
  }).run();
  db.prepare(
    'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(WS, WS, 'C:/tmp/ws_mf4i', 'C:/tmp/ws_mf4i', NOW, NOW, NOW);
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, status, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(TASK, WS, 'task', 'open', 'test', NOW, NOW);
  db.prepare(
    'INSERT INTO runs (id, workspace_id, task_id, root_run_id, status, reason, created_by, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)',
  ).run(RUN, WS, TASK, RUN, 'queued', 'initial', 'test', NOW, NOW);

  const tx = db as unknown as TransactionDatabase;
  const entries = new MemoryEntryRepository(tx);
  const snapshots = new MemoryContextSnapshotRepository(tx);
  const selector = new MemoryContextBudgetSelector(new MemoryRetrievalService(entries), snapshots);
  const resolver = new MemoryContextResolver({ store: { getDatabase: () => tx }, selector, entries, snapshots });
  return { db, entries, snapshots, resolver, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

let seq = 0;
function addEntry(fx: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}): string {
  seq += 1;
  const id = 'mem_' + String(seq).padStart(4, '0') + 'i'.repeat(20);
  fx.entries.createEntry({
    id, workspaceId: WS, scope: 'task', ownerTaskId: TASK, category: 'decision',
    authority: 'system-verified', confidence: 0.9, importance: 0.5,
    title: `entry ${seq}`, summary: 's', content: `content ${seq}`, tags: [],
    status: 'active', sources: [{ kind: 'run', id: RUN }], createdAt: NOW, tokenEstimate: 10,
    ...overrides,
  } as never);
  return id;
}

function resolveInput(overrides: Record<string, unknown> = {}) {
  return { workspaceId: WS, runId: RUN, taskId: TASK, budget: BUDGET, createdAt: NOW, ...overrides } as never;
}

// MF4I-01 — resolve persists a snapshot before returning context.
test('MF4I-01 resolve persists a snapshot and returns bounded context', () => {
  const fx = fixture();
  try {
    addEntry(fx, { title: 'alpha', content: 'body alpha' });
    const resolved = fx.resolver.resolve(resolveInput());
    assert.equal(resolved.reused, false);
    assert.ok(resolved.contextText.includes('body alpha'));
    assert.ok(fx.snapshots.findById(WS, resolved.snapshot.id) !== undefined);
    assert.equal(resolved.snapshot.runId, RUN);
    assert.deepEqual(resolved.snapshot.budget, BUDGET);
  } finally { fx.close(); }
});

// MF4I-02 — a second resolve for the same scope reuses the snapshot.
test('MF4I-02 resolve is idempotent per run scope', () => {
  const fx = fixture();
  try {
    addEntry(fx);
    const first = fx.resolver.resolve(resolveInput());
    const second = fx.resolver.resolve(resolveInput());
    assert.equal(second.reused, true);
    assert.equal(second.snapshot.id, first.snapshot.id);
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_context_snapshots').get() as { c: number }).c, 1);
  } finally { fx.close(); }
});

// MF4I-03 — stage-scoped resolve is separate from the run-scoped snapshot.
test('MF4I-03 stage scope is distinct from run scope', () => {
  const fx = fixture();
  try {
    addEntry(fx);
    const runLevel = fx.resolver.resolve(resolveInput());
    const stageLevel = fx.resolver.resolve(resolveInput({ stageId: STAGE }));
    assert.notEqual(stageLevel.snapshot.id, runLevel.snapshot.id);
    assert.equal(stageLevel.snapshot.stageId, STAGE);
    assert.equal(stageLevel.reused, false);
    const again = fx.resolver.resolve(resolveInput({ stageId: STAGE }));
    assert.equal(again.reused, true);
  } finally { fx.close(); }
});

// MF4I-04 — snapshot persistence failure blocks injection.
test('replaying an earlier scope after a later Stage does not recreate its snapshot', () => {
  const fx = fixture();
  try {
    addEntry(fx);
    const run = fx.resolver.resolve(resolveInput());
    const stageA = fx.resolver.resolve(resolveInput({ stageId: 'stage_a', createdAt: '2026-09-09T01:00:00.000Z' }));
    fx.resolver.resolve(resolveInput({ stageId: 'stage_b', createdAt: '2026-09-09T02:00:00.000Z' }));
    const replayA = fx.resolver.resolve(resolveInput({ stageId: 'stage_a' }));
    const replayRun = fx.resolver.resolve(resolveInput());
    assert.equal(replayA.reused, true);
    assert.equal(replayA.snapshot.id, stageA.snapshot.id);
    assert.equal(replayRun.reused, true);
    assert.equal(replayRun.snapshot.id, run.snapshot.id);
    assert.equal(fx.snapshots.listForRun(WS, RUN).length, 3);
    assert.equal(fx.snapshots.findLatestForScope('another-workspace', RUN, 'stage_a'), undefined);
  } finally { fx.close(); }
});

test('MF4I-04 snapshot failure blocks injection', () => {
  const fx = fixture();
  try {
    // Unknown Run: snapshot FK/write fails, so resolve must throw.
    assert.throws(
      () => fx.resolver.resolve(resolveInput({ runId: 'run_missing' })),
      (error: unknown) => {
        assert.ok(error instanceof MemoryContextResolverError);
        assert.equal(error.code, 'SNAPSHOT_FAILED');
        return true;
      },
    );
    assert.equal((fx.db.prepare('SELECT COUNT(*) AS c FROM memory_context_snapshots').get() as { c: number }).c, 0);
  } finally { fx.close(); }
});

// MF4I-05 — invalid input and budget fail closed.
test('MF4I-05 invalid input fails closed', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.resolver.resolve(resolveInput({ workspaceId: '' })));
    assert.throws(() => fx.resolver.resolve(resolveInput({ budget: { ...BUDGET, maxTokens: 0 } })));
  } finally { fx.close(); }
});

// MF4I-06 — the injection gate rejects an absent snapshot.
test('MF4I-06 injection gate rejects absent snapshot', () => {
  const fx = fixture();
  try {
    assert.equal(fx.resolver.isInjectable(undefined), false);
    const resolved = fx.resolver.resolve(resolveInput());
    assert.equal(fx.resolver.isInjectable(resolved), true);
  } finally { fx.close(); }
});

// MF4I-07 — later entry edits do not change a resolved snapshot.
test('MF4I-07 later entry edits do not rewrite the snapshot', () => {
  const fx = fixture();
  try {
    const id = addEntry(fx, { title: 'before' });
    const resolved = fx.resolver.resolve(resolveInput());
    fx.entries.updateStatus({ workspaceId: WS, entryId: id, expectedVersion: 1, status: 'archived', updatedAt: NOW });
    const reloaded = fx.snapshots.findById(WS, resolved.snapshot.id);
    assert.equal(reloaded?.selected.length, resolved.snapshot.selected.length);
    assert.equal(reloaded?.selected[0].memoryId, id);
  } finally { fx.close(); }
});

// MF4I-08 — no memories still persists an empty snapshot (reproducible).
test('MF4I-08 empty store still persists a snapshot', () => {
  const fx = fixture();
  try {
    const resolved = fx.resolver.resolve(resolveInput());
    assert.equal(resolved.snapshot.selected.length, 0);
    assert.equal(resolved.contextText, '');
    assert.equal(fx.resolver.isInjectable(resolved), true);
  } finally { fx.close(); }
});

// MF4I-09 — default budget is a frozen, valid policy.
test('MF4I-09 default budget is frozen and valid', () => {
  assert.equal(DEFAULT_MEMORY_BUDGET_POLICY_V1.maxEntries, 5);
  assert.equal(DEFAULT_MEMORY_BUDGET_POLICY_V1.maxTokens, 6000);
  const fx = fixture();
  try {
    addEntry(fx);
    const resolved = fx.resolver.resolve({ workspaceId: WS, runId: RUN, taskId: TASK, createdAt: NOW } as never);
    assert.deepEqual(resolved.snapshot.budget, DEFAULT_MEMORY_BUDGET_POLICY_V1);
  } finally { fx.close(); }
});

// MF4I-10 — workspace isolation: another Workspace cannot reuse the snapshot.
test('MF4I-10 workspace isolation', () => {
  const fx = fixture();
  try {
    fx.db.prepare(
      'INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('ws_other', 'ws_other', 'C:/tmp/ws_other', 'C:/tmp/ws_other', NOW, NOW, NOW);
    addEntry(fx);
    const resolved = fx.resolver.resolve(resolveInput());
    assert.equal(fx.snapshots.findById('ws_other', resolved.snapshot.id), undefined);
  } finally { fx.close(); }
});
