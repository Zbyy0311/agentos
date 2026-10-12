import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from './Transaction.js';
import { WorktreeMergeRepository, type WorktreeMergeRecord } from './WorktreeMergeRepository.js';

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  close(): void;
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};
const NOW = '2026-10-12T00:00:00.000Z';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-worktree-merge-repo-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  const repo = new WorktreeMergeRepository(db as unknown as TransactionDatabase);
  return { db, repo, root, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function mergeInput(overrides: Partial<WorktreeMergeRecord> = {}): WorktreeMergeRecord {
  return {
    id: 'wtmg_test_a',
    worktreeId: 'wt_test_a',
    strategy: 'squash',
    sourceBranch: 'agentos/run-x',
    targetBranch: 'main',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    expectedHeadCommit: 'a'.repeat(40),
    previousTargetCommit: 'a'.repeat(40),
    resultingTargetCommit: null,
    mergeCommit: null,
    result: 'merged',
    requestedBy: 'tester',
    createdAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

test('worktree merge repository persists and round-trips merge records', () => {
  const fx = fixture();
  try {
    fx.repo.create(mergeInput());
    const stored = fx.repo.getById('wtmg_test_a');
    assert.ok(stored);
    assert.equal(stored.worktreeId, 'wt_test_a');
    assert.equal(stored.strategy, 'squash');
    assert.equal(stored.result, 'merged');
    assert.equal(stored.conflictSummary, undefined);

    fx.repo.create(mergeInput({
      id: 'wtmg_test_b',
      result: 'conflicted',
      conflictSummary: { conflictedPaths: ['src/a.ts', 'src/b.ts'] },
      completedAt: NOW,
    }));
    const conflicted = fx.repo.getById('wtmg_test_b');
    assert.ok(conflicted);
    assert.equal(conflicted.result, 'conflicted');
    assert.deepEqual(conflicted.conflictSummary, { conflictedPaths: ['src/a.ts', 'src/b.ts'] });
    assert.equal(conflicted.completedAt, NOW);

    assert.deepEqual(fx.repo.findByWorktree('wt_test_a').map(record => record.id), ['wtmg_test_a', 'wtmg_test_b']);
    assert.equal(fx.repo.findByWorktree('wt_other').length, 0);
    assert.equal(fx.repo.list().length, 2);
    assert.equal(fx.repo.getById('wtmg_missing'), undefined);
  } finally {
    fx.close();
  }
});

test('worktree merge repository createInTransaction rolls back on failure', () => {
  const fx = fixture();
  try {
    assert.throws(() => fx.repo.createInTransaction(mergeInput({ id: 'wtmg_dup', strategy: 'rebase' as never })), /CHECK/);
    assert.equal(fx.repo.getById('wtmg_dup'), undefined);
  } finally {
    fx.close();
  }
});
