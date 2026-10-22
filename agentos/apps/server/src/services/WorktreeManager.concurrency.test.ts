import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { MigrationRegistry } from '../migrations/registry.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import { RuntimeLockRepository } from '../store/RuntimeLockRepository.js';
import { WorktreeRepository } from '../store/WorktreeRepository.js';
import { WorktreeManager } from './WorktreeManager.js';
import { inTransaction } from '../store/Transaction.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new(path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown };
    close(): void;
  };
};

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

function cleanupSource(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); }
  catch (error) {
    // Windows Git can leave an unremovable temporary reparse file in .git.
    if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
  }
}

test('§8.4 worktreeCreation saturation waits on the durable SQLite slot and recovers after release', async () => {
  const root = repo();
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agentos-leases-concurrency-'));
  const databasePath = join(worktreeRoot, 'runtime.sqlite');
  const db = new DatabaseSync(databasePath);
  new MigrationRunner(db as never, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('w', 'w', ?, ?, ?, ?, ?)`).run(root, root, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  const repository = new WorktreeRepository(db as never);
  const otherDb = new DatabaseSync(databasePath);
  const locks = new RuntimeLockRepository(otherDb as never);
  const blockerOwner = 'test-blocker';
  const blockerKey = 'worktree-creation:test-blocker';
  locks.tryAcquire({
    id: 'lock-test-blocker', lockKey: blockerKey, ownerId: blockerOwner,
    purpose: 'worktree-creation-capacity', now: new Date().toISOString(),
    metadata: { kind: 'worktree-creation', processId: process.pid },
  });
  const manager = new WorktreeManager(worktreeRoot, repository, undefined, { creationConcurrencyLimit: 1 });
  try {
    const pending = manager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'exec-1', agentId: 'a' });
    for (let attempt = 0; attempt < 200 && repository.list().length === 0; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    assert.equal(repository.list()[0]?.status, 'creating', 'the accepted creation remains durably queued while the slot is full');
    const otherRepository = new WorktreeRepository(otherDb as never);
    const otherManager = new WorktreeManager(worktreeRoot, otherRepository, undefined, { creationConcurrencyLimit: 1 });
    const report = await otherManager.reconcile([root]);
    assert.deepEqual(report.failed, [], 'another instance must preserve the live waiting request');
    assert.equal(locks.findByKey(blockerKey)?.releasedAt, null, 'reconciliation cannot steal a live creator slot');
    locks.release(blockerKey, blockerOwner, new Date().toISOString());
    const firstLease = await pending;
    assert.equal(firstLease.status, 'active');
  } finally {
    inTransaction(otherDb as never, () => {
      for (const lock of locks.listActive(new Date().toISOString())) {
        if (lock.purpose === 'worktree-creation-capacity') locks.release(lock.lockKey, lock.ownerId, new Date().toISOString());
      }
    });
    otherDb.close();
    db.close();
    rmSync(worktreeRoot, { recursive: true, force: true });
    cleanupSource(root);
  }
});

test('§8.4 a crashed creator reservation is recovered before Git creation', async () => {
  const root = repo();
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agentos-creation-recovery-'));
  const db = new DatabaseSync(join(worktreeRoot, 'runtime.sqlite'));
  new MigrationRunner(db as never, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO workspaces (id, name, root_path, canonical_root_path, last_opened_at, created_at, updated_at)
    VALUES ('w', 'w', ?, ?, ?, ?, ?)`).run(root, root, now, now, now);
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true }));
  const locks = new RuntimeLockRepository(db as never);
  locks.tryAcquire({
    id: 'crashed-creator', lockKey: 'worktree-creation:crashed', ownerId: 'dead-creator',
    purpose: 'worktree-creation-capacity', now, metadata: { processId: deadPid },
  });
  try {
    const manager = new WorktreeManager(worktreeRoot, new WorktreeRepository(db as never), undefined, { creationConcurrencyLimit: 1 });
    const lease = await manager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'exec', agentId: 'a' });
    assert.equal(lease.status, 'active');
    assert.notEqual(locks.findByKey('worktree-creation:crashed')?.releasedAt, null);
    assert.equal(locks.listActive(new Date().toISOString()).length, 0);
  } finally {
    db.close();
    rmSync(worktreeRoot, { recursive: true, force: true });
    cleanupSource(root);
  }
});

test('§8.4 worktreeCreation: without a limit, concurrent creations are both admitted', async () => {
  const root = repo();
  const manager = new WorktreeManager(mkdtempSync(join(tmpdir(), 'agentos-leases-unlimited-')));
  const first = manager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'exec-1', agentId: 'a' });
  const second = manager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'exec-2', agentId: 'a' });
  assert.equal((await first).status, 'active');
  assert.equal((await second).status, 'active');
});
