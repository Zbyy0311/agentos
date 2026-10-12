import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { WorktreeMergeRepository } from '../store/WorktreeMergeRepository.js';
import { WorktreeManager } from './WorktreeManager.js';
import { WorktreeMergeError, WorktreeMergeService } from './WorktreeMergeService.js';
import { withWorktreeBranchLock } from './WorktreeBranchLock.js';

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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentos-worktree-merge-'));
  const root = join(directory, 'source');
  mkdirSync(root);
  const worktreeRoot = join(directory, 'worktrees');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  const repository = new WorktreeMergeRepository(db as unknown as TransactionDatabase);
  const manager = new WorktreeManager(worktreeRoot);
  const service = new WorktreeMergeService(manager, repository);

  const sourceGit = (args: string[]) => git(root, args);
  sourceGit(['init', '-q', '-b', 'main']);
  sourceGit(['config', 'user.name', 'Merge fixture']);
  sourceGit(['config', 'user.email', 'merge@agentos.invalid']);
  sourceGit(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(root, 'README.md'), 'base\n');
  sourceGit(['add', '.']);
  sourceGit(['commit', '-qm', 'base']);
  const baseCommit = sourceGit(['rev-parse', 'HEAD']).trim();

  const lease = await manager.createLease({ workspaceId: 'ws-merge', workspaceRoot: root, runId: 'run-merge', executionId: 'exec-merge', agentId: 'agent-merge' });
  const record = manager.getRecord(lease.id);
  assert.ok(record);
  const checkout = record.absolutePath;
  const branch = record.branchName;
  const worktreeGit = (args: string[]) => git(checkout, args);

  const commitInWorktree = (file: string, content: string, message: string) => {
    writeFileSync(join(checkout, file), content);
    worktreeGit(['add', '.']);
    worktreeGit(['commit', '-qm', message]);
    return worktreeGit(['rev-parse', 'HEAD']).trim();
  };
  const commitInMain = (file: string, content: string, message: string) => {
    writeFileSync(join(root, file), content);
    sourceGit(['add', '.']);
    sourceGit(['commit', '-qm', message]);
    return sourceGit(['rev-parse', 'HEAD']).trim();
  };

  return {
    directory, root, checkout, branch, manager, service, repository, db,
    baseCommit, sourceGit, worktreeGit, commitInWorktree, commitInMain,
    close: () => { try { db.close(); } finally {
      try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (error) {
        if (process.platform !== 'win32' || !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        process.emitWarning(`Fixture cleanup incomplete; retained ${directory}: ${(error as NodeJS.ErrnoException).code}`);
      }
    } },
  };
}

test('merge ff strategy fast-forwards the target branch inside the worktree checkout', async () => {
  const fx = await fixture();
  try {
    const head = fx.commitInWorktree('feature.txt', 'feature\n', 'feature work');
    const record = await fx.service.merge(fx.manager.listLeases()[0].id, {
      strategy: 'ff', targetBranch: 'main', expectedHeadCommit: fx.baseCommit, requestedBy: 'tester',
    });
    assert.equal(record.result, 'merged');
    assert.equal(record.resultingTargetCommit, head);
    assert.equal(record.mergeCommit, null);
    assert.equal(fx.sourceGit(['rev-parse', 'main']).trim(), head);
    assert.equal(fx.repository.findByWorktree(record.worktreeId).length, 1);
    // §115: the merge ran inside the worktree checkout; the main workspace
    // working tree is never written by merge execution.
    assert.equal(existsSync(join(fx.root, 'feature.txt')), false, 'main worktree files untouched');
    assert.equal(readFileSync(join(fx.checkout, 'feature.txt'), 'utf8'), 'feature\n');
    assert.equal(fx.worktreeGit(['symbolic-ref', '--short', 'HEAD']).trim(), fx.branch, 'managed source branch restored for later controls');
  } finally {
    fx.close();
  }
});

test('merge squash strategy collapses the worktree branch into a single commit', async () => {
  const fx = await fixture();
  try {
    fx.commitInWorktree('one.txt', 'one\n', 'one');
    fx.commitInWorktree('two.txt', 'two\n', 'two');
    const targetHead = fx.commitInMain('main.txt', 'main\n', 'main advance');
    const record = await fx.service.merge(fx.manager.listLeases()[0].id, {
      strategy: 'squash', targetBranch: 'main', expectedHeadCommit: targetHead, requestedBy: 'tester',
    });
    assert.equal(record.result, 'merged');
    assert.equal(fx.sourceGit(['rev-parse', 'main']).trim(), record.resultingTargetCommit);
    assert.equal(record.mergeCommit, null);
    const parents = fx.sourceGit(['rev-list', '--parents', '-n', '1', 'main']).trim().split(/\s+/);
    assert.equal(parents.length, 2, 'squash commit has exactly one parent');
    assert.equal(parents[1], targetHead);
    assert.match(fx.sourceGit(['log', '-1', '--format=%s', 'main']), /Squash merge branch/);
    assert.equal(fx.sourceGit(['show', 'main:one.txt']), 'one\n');
    assert.equal(fx.sourceGit(['show', 'main:two.txt']), 'two\n');
    assert.equal(existsSync(join(fx.root, 'one.txt')), false, 'main worktree files untouched');
  } finally {
    fx.close();
  }
});

test('merge merge-commit strategy creates a two-parent merge commit', async () => {
  const fx = await fixture();
  try {
    const head = fx.commitInWorktree('feature.txt', 'feature\n', 'feature work');
    const targetHead = fx.commitInMain('main.txt', 'main\n', 'main advance');
    const record = await fx.service.merge(fx.manager.listLeases()[0].id, {
      strategy: 'merge-commit', targetBranch: 'main', expectedHeadCommit: targetHead, requestedBy: 'tester',
    });
    assert.equal(record.result, 'merged');
    assert.equal(record.mergeCommit, record.resultingTargetCommit);
    const parents = fx.sourceGit(['rev-list', '--parents', '-n', '1', 'main']).trim().split(/\s+/);
    assert.equal(parents.length, 3, 'merge commit has two parents');
    assert.equal(parents[1], targetHead);
    assert.equal(parents[2], head);
  } finally {
    fx.close();
  }
});

test('merge rejects when the target branch does not match expectedHeadCommit', async () => {
  const fx = await fixture();
  try {
    fx.commitInWorktree('feature.txt', 'feature\n', 'feature work');
    const mismatch = await fx.service.merge(fx.manager.listLeases()[0].id, {
      strategy: 'ff', targetBranch: 'main', expectedHeadCommit: 'f'.repeat(40), requestedBy: 'tester',
    }).then(() => undefined, error => error as WorktreeMergeError);
    assert.ok(mismatch instanceof WorktreeMergeError);
    assert.equal(mismatch.code, 'WORKTREE_MERGE_HEAD_MISMATCH');
    assert.equal(fx.sourceGit(['rev-parse', 'main']).trim(), fx.baseCommit, 'target branch untouched');
    assert.equal(fx.repository.list().length, 0, 'rejected merge is not persisted');
  } finally {
    fx.close();
  }
});

for (const conflictStrategy of ['merge-commit', 'squash'] as const) {
test(`${conflictStrategy} conflict aborts, records conflicted result and leaves the worktree clean`, async () => {
  const fx = await fixture();
  try {
    fx.commitInWorktree('README.md', 'worktree version\n', 'worktree change');
    const targetHead = fx.commitInMain('README.md', 'main version\n', 'main change');
    const leaseId = fx.manager.listLeases()[0].id;
    const error = await fx.service.merge(leaseId, {
      strategy: conflictStrategy, targetBranch: 'main', expectedHeadCommit: targetHead, requestedBy: 'tester',
    }).then(() => undefined, error => error as WorktreeMergeError);
    assert.ok(error instanceof WorktreeMergeError);
    assert.equal(error.code, 'WORKTREE_MERGE_CONFLICTED');
    assert.ok(error.record);
    assert.equal(error.record.result, 'conflicted');
    assert.deepEqual(error.record.conflictSummary, { conflictedPaths: ['README.md'] });
    assert.equal(fx.sourceGit(['rev-parse', 'main']).trim(), targetHead, 'target branch untouched after conflict');
    assert.equal(fx.worktreeGit(['status', '--porcelain']), '', 'worktree checkout clean after merge --abort');
    assert.equal(fx.worktreeGit(['symbolic-ref', '--short', 'HEAD']).trim(), fx.branch);
    const stored = fx.repository.getById(error.record.id);
    assert.ok(stored);
    assert.equal(stored.result, 'conflicted');
  } finally {
    fx.close();
  }
});
}

test('target branch lock serializes concurrent merges; loser sees the advanced head', async () => {
  const fx = await fixture();
  try {
    fx.commitInWorktree('feature.txt', 'feature\n', 'feature work');
    const leaseId = fx.manager.listLeases()[0].id;
    const request = { strategy: 'ff' as const, targetBranch: 'main', expectedHeadCommit: fx.baseCommit, requestedBy: 'tester' };
    const [first, second] = await Promise.all([
      fx.service.merge(leaseId, request).then(() => undefined, error => error as WorktreeMergeError),
      fx.service.merge(leaseId, request).then(() => undefined, error => error as WorktreeMergeError),
    ]);
    const outcomes = [first, second];
    assert.equal(outcomes.filter(outcome => outcome === undefined).length, 1, 'exactly one merge wins');
    const loser = outcomes.find(outcome => outcome !== undefined) as WorktreeMergeError;
    assert.equal(loser.code, 'WORKTREE_MERGE_HEAD_MISMATCH');
    assert.equal(fx.repository.list().length, 1, 'only the winning merge is persisted');
  } finally {
    fx.close();
  }
});

test('merge rejects invalid requests and unmergeable lease statuses', async () => {
  const fx = await fixture();
  try {
    const leaseId = fx.manager.listLeases()[0].id;
    await assert.rejects(fx.service.merge(leaseId, { strategy: 'rebase' as never, targetBranch: 'main', expectedHeadCommit: fx.baseCommit, requestedBy: 't' }), (error: unknown) => (error as WorktreeMergeError).code === 'WORKTREE_MERGE_INVALID_REQUEST');
    await assert.rejects(fx.service.merge(leaseId, { strategy: 'ff', targetBranch: 'main', expectedHeadCommit: 'short', requestedBy: 't' }), (error: unknown) => (error as WorktreeMergeError).code === 'WORKTREE_MERGE_INVALID_REQUEST');
    await assert.rejects(fx.service.merge('wt_missing', { strategy: 'ff', targetBranch: 'main', expectedHeadCommit: fx.baseCommit, requestedBy: 't' }), (error: unknown) => (error as WorktreeMergeError).code === 'WORKTREE_NOT_FOUND');

    fx.manager.markCleanupPending(leaseId);
    await assert.rejects(fx.service.merge(leaseId, { strategy: 'ff', targetBranch: 'main', expectedHeadCommit: fx.baseCommit, requestedBy: 't' }), (error: unknown) => (error as WorktreeMergeError).code === 'WORKTREE_MERGE_INVALID_STATUS');
  } finally {
    fx.close();
  }
});

test('merge refuses existing target or source locks and retries after release', async () => {
  const fx = await fixture();
  try {
    const head = fx.commitInWorktree('feature.txt', 'feature\n', 'feature work');
    const leaseId = fx.manager.listLeases()[0].id;
    const request = { strategy: 'ff' as const, targetBranch: 'main', expectedHeadCommit: fx.baseCommit, requestedBy: 'tester' };
    for (const branch of ['main', fx.branch]) {
      await withWorktreeBranchLock(fx.checkout, branch, async () => {
        await assert.rejects(fx.service.merge(leaseId, request), (error: unknown) =>
          error instanceof WorktreeMergeError && error.code === 'WORKTREE_BRANCH_LOCK_HELD');
        assert.equal(fx.sourceGit(['rev-parse', 'main']).trim(), fx.baseCommit);
        assert.equal(fx.worktreeGit(['symbolic-ref', '--short', 'HEAD']).trim(), fx.branch);
        assert.equal(fx.repository.list().length, 0);
      });
    }
    const record = await fx.service.merge(leaseId, request);
    assert.equal(record.resultingTargetCommit, head);
  } finally { fx.close(); }
});

test('merge refuses dirty worktrees without moving refs or overwriting files', async () => {
  const fx = await fixture();
  try {
    writeFileSync(join(fx.checkout, 'uncommitted.txt'), 'preserve me\n');
    await assert.rejects(fx.service.merge(fx.manager.listLeases()[0].id, {
      strategy: 'merge-commit', targetBranch: 'main', expectedHeadCommit: fx.baseCommit, requestedBy: 'tester',
    }), (error: unknown) => error instanceof WorktreeMergeError && error.code === 'WORKTREE_MERGE_DIRTY');
    assert.equal(readFileSync(join(fx.checkout, 'uncommitted.txt'), 'utf8'), 'preserve me\n');
    assert.equal(fx.worktreeGit(['symbolic-ref', '--short', 'HEAD']).trim(), fx.branch);
    assert.equal(fx.sourceGit(['rev-parse', 'main']).trim(), fx.baseCommit);
    assert.equal(fx.repository.list().length, 0);
  } finally { fx.close(); }
});
