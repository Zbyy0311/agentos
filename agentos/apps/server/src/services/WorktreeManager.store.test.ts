import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { WorktreeRepository } from '../store/WorktreeRepository.js';
import { WorktreeManager } from './WorktreeManager.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown };
    close(): void;
  };
};

function repo() { const root = mkdtempSync(join(tmpdir(), 'agentos-worktree-')); execFileSync('git', ['init', '-q'], { cwd: root }); execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root }); execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root }); writeFileSync(join(root, 'README.md'), 'base'); execFileSync('git', ['add', '.'], { cwd: root }); execFileSync('git', ['commit', '-qm', 'base'], { cwd: root }); return root; }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentos-wt-store-'));
  const worktreeRoot = join(root, 'worktrees');
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  const repository = new WorktreeRepository(db as unknown as TransactionDatabase);
  return {
    root, worktreeRoot, db, repository,
    manager: () => new WorktreeManager(worktreeRoot, repository),
    close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } },
  };
}

test('restores leases from SQLite after restart without any leases.json', async () => {
  const fx = fixture();
  try {
    const gitRoot = repo();
    const manager = fx.manager();
    const lease = await manager.createLease({ workspaceId: 'w', workspaceRoot: gitRoot, runId: 'run', executionId: 'exec', agentId: 'a' });
    assert.equal(existsSync(join(fx.worktreeRoot, 'leases.json')), false, 'SQLite persistence must not write leases.json');

    // Simulate restart: a fresh manager over the same repository sees the lease.
    const restarted = fx.manager();
    const restored = restarted.getLease(lease.id);
    assert.ok(restored, 'lease restored from DB');
    assert.equal(restored.status, 'active');
    assert.equal(restored.branchName, lease.branchName);
    assert.equal(restored.pathLabel, lease.pathLabel);
    assert.equal(restarted.listLeases().length, 1);
    assert.equal(fx.repository.getById(lease.id)?.absolutePath, manager.getRecord(lease.id)?.absolutePath);
  } finally {
    fx.close();
  }
});

test('persists status transitions and recovery bundles to SQLite', async () => {
  const fx = fixture();
  try {
    const gitRoot = repo();
    const manager = fx.manager();
    const lease = await manager.createLease({ workspaceId: 'w', workspaceRoot: gitRoot, runId: 'run', executionId: 'exec', agentId: 'a' });
    manager.markCleanupPending(lease.id);
    assert.equal(fx.repository.getById(lease.id)?.status, 'cleanup_pending');
    const bundle = { trackedPatchArtifactId: 'p1', untrackedArchiveArtifactId: 'p2', manifestArtifactId: 'p3', entryCount: 1 };
    manager.markRecoveryBundleVerified(lease.id, bundle);
    const record = fx.repository.getById(lease.id);
    assert.equal(record?.status, 'completed');
    assert.deepEqual(record?.recoveryBundle, bundle);

    const restarted = fx.manager();
    assert.equal(restarted.getLease(lease.id)?.status, 'completed');
    assert.deepEqual(restarted.getRecord(lease.id)?.recoveryBundle, bundle);
  } finally {
    fx.close();
  }
});

test('imports a legacy leases.json once and archives it (idempotent across restarts)', async () => {
  const fx = fixture();
  try {
    const legacy = [{
      id: 'wt-legacy-1', workspaceId: 'w', runId: 'run', executionId: 'exec', agentId: 'a',
      branchName: 'agentos/legacy', pathLabel: 'worktree/w/run/exec', baseCommit: 'deadbeef',
      status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      absolutePath: join(fx.worktreeRoot, 'legacy-target'), workspaceRoot: '/ws/legacy',
    }];
    mkdirSync(fx.worktreeRoot, { recursive: true });
    writeFileSync(join(fx.worktreeRoot, 'leases.json'), JSON.stringify(legacy), 'utf8');

    const first = fx.manager();
    assert.equal(first.listLeases().length, 1);
    assert.equal(first.getLease('wt-legacy-1')?.status, 'active');
    assert.equal(existsSync(join(fx.worktreeRoot, 'leases.json')), false, 'legacy file archived');
    assert.equal(existsSync(join(fx.worktreeRoot, 'leases.json.migrated')), true);

    // Second restart: no leases.json left, DB rows already imported — no duplicates.
    const second = fx.manager();
    assert.equal(second.listLeases().length, 1);
    assert.equal(fx.repository.list().length, 1);
  } finally {
    fx.close();
  }
});

test('legacy import is idempotent when leases.json and DB rows overlap', async () => {
  const fx = fixture();
  try {
    const gitRoot = repo();
    const manager = fx.manager();
    const lease = await manager.createLease({ workspaceId: 'w', workspaceRoot: gitRoot, runId: 'run', executionId: 'exec', agentId: 'a' });
    const record = manager.getRecord(lease.id);
    // Recreate a legacy file containing the already-imported lease.
    writeFileSync(join(fx.worktreeRoot, 'leases.json'), JSON.stringify([record]), 'utf8');
    const restarted = fx.manager();
    assert.equal(restarted.listLeases().length, 1, 'no duplicate lease after overlapping import');
    assert.equal(fx.repository.list().length, 1);
    assert.equal(existsSync(join(fx.worktreeRoot, 'leases.json.migrated')), true);
  } finally {
    fx.close();
  }
});

test('reconcile reads the lease set from SQLite and preserves cleanup_pending leases', async () => {
  const fx = fixture();
  try {
    const gitRoot = repo();
    const manager = fx.manager();
    const lease = await manager.createLease({ workspaceId: 'w', workspaceRoot: gitRoot, runId: 'run', executionId: 'exec', agentId: 'a' });
    manager.markCleanupPending(lease.id);
    // A lease whose directory vanished is reconciled to failed, in DB and memory.
    const gone = await manager.createLease({ workspaceId: 'w', workspaceRoot: gitRoot, runId: 'run', executionId: 'gone', agentId: 'a' });
    rmSync(manager.getRecord(gone.id)!.absolutePath, { recursive: true, force: true });

    // Restart reads the lease set from SQLite, then reconciles each entry.
    const restarted = fx.manager();
    await restarted.reconcile();
    assert.equal(restarted.getLease(lease.id)?.status, 'cleanup_pending');
    assert.equal(fx.repository.getById(lease.id)?.status, 'cleanup_pending');
    assert.equal(restarted.getLease(gone.id)?.status, 'failed');
    assert.equal(fx.repository.getById(gone.id)?.status, 'failed');
  } finally {
    fx.close();
  }
});
