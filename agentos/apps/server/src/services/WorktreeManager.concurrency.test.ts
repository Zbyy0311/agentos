import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeConcurrencyLimitedError, WorktreeManager } from './WorktreeManager.js';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-worktree-concurrency-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), 'base');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
  return root;
}

test('§8.4 worktreeCreation limit: concurrent createLease beyond the cap fails fast, then succeeds after release', async () => {
  const root = repo();
  const manager = new WorktreeManager(
    mkdtempSync(join(tmpdir(), 'agentos-leases-concurrency-')),
    undefined,
    undefined,
    { creationConcurrencyLimit: 1 },
  );
  // The gate check and counter increment run synchronously at entry, so the
  // second creation deterministically observes the first one in flight.
  const first = manager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'exec-1', agentId: 'a' });
  await assert.rejects(
    () => manager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'exec-2', agentId: 'a' }),
    (error: unknown) => error instanceof WorktreeConcurrencyLimitedError
      && (error as { code?: string }).code === 'concurrency_limited',
  );
  const firstLease = await first;
  assert.equal(firstLease.status, 'active');
  // Capacity was released: the next creation succeeds.
  const third = await manager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'exec-3', agentId: 'a' });
  assert.equal(third.status, 'active');
});

test('§8.4 worktreeCreation: without a limit, concurrent creations are both admitted', async () => {
  const root = repo();
  const manager = new WorktreeManager(mkdtempSync(join(tmpdir(), 'agentos-leases-unlimited-')));
  const first = manager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'exec-1', agentId: 'a' });
  const second = manager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'exec-2', agentId: 'a' });
  assert.equal((await first).status, 'active');
  assert.equal((await second).status, 'active');
});
