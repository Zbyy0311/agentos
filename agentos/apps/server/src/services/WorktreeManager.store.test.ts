import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { MigrationRegistry } from '../migrations/registry.js';
import { MigrationRunner } from '../migrations/MigrationRunner.js';
import { DEFAULT_REGISTRY_MIGRATIONS } from '../migrations/default-registry.js';
import type { MinimalDatabaseSync } from '../migrations/types.js';
import type { TransactionDatabase } from '../store/Transaction.js';
import { WorktreeRepository, type WorktreeLeaseRecord } from '../store/WorktreeRepository.js';
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

function legacyLease(fx: ReturnType<typeof fixture>, id: string, overrides: Partial<WorktreeLeaseRecord> = {}): WorktreeLeaseRecord {
  return {
    id,
    workspaceId: 'legacy-workspace',
    runId: `run-${id}`,
    executionId: `exec-${id}`,
    agentId: `agent-${id}`,
    branchName: `agentos/${id}`,
    pathLabel: `worktree/legacy/${id}`,
    baseCommit: 'deadbeef',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    absolutePath: join(fx.worktreeRoot, 'legacy-checkouts', id),
    workspaceRoot: join(fx.root, 'legacy-workspace'),
    ...overrides,
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
    assert.deepEqual(first.getLegacyImportReport(), []);
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

test('legacy import reports malformed records, keeps the source, and imports later valid records', () => {
  const fx = fixture();
  try {
    const valid = legacyLease(fx, 'wt-after-malformed');
    mkdirSync(fx.worktreeRoot, { recursive: true });
    writeFileSync(join(fx.worktreeRoot, 'leases.json'), JSON.stringify([
      { id: 'wt-malformed', workspaceId: 'legacy-workspace' },
      valid,
    ]), 'utf8');

    const manager = fx.manager();
    assert.deepEqual(manager.getLegacyImportReport(), [{ index: 0, id: 'wt-malformed', code: 'malformed_record' }]);
    assert.deepEqual(Object.keys(manager.getLegacyImportReport()[0]!).sort(), ['code', 'id', 'index']);
    assert.ok(fx.repository.getById(valid.id), 'valid record after malformed input is imported');
    assert.equal(existsSync(join(fx.worktreeRoot, 'leases.json')), true, 'failed record keeps source file');
    assert.equal(existsSync(join(fx.worktreeRoot, 'leases.json.migrated')), false);
  } finally {
    fx.close();
  }
});

test('identical duplicate IDs preserve SQLite state while conflicting identities are reported', () => {
  const fx = fixture();
  try {
    const current = legacyLease(fx, 'wt-duplicate', {
      status: 'cleanup_pending',
      updatedAt: '2026-10-12T01:00:00.000Z',
      recoveryBundle: {
        trackedPatchArtifactId: 'tracked',
        untrackedArchiveArtifactId: 'untracked',
        manifestArtifactId: 'manifest',
        entryCount: 1,
      },
    });
    fx.repository.create(current);
    const staleDuplicate = { ...current, status: 'active' as const, updatedAt: '2026-01-01T00:00:00.000Z' };
    const conflictingDuplicate = { ...current, workspaceId: 'other-workspace' };
    const later = legacyLease(fx, 'wt-after-conflict');
    mkdirSync(fx.worktreeRoot, { recursive: true });
    writeFileSync(join(fx.worktreeRoot, 'leases.json'), JSON.stringify([staleDuplicate, conflictingDuplicate, later]), 'utf8');

    const manager = fx.manager();
    assert.deepEqual(manager.getLegacyImportReport(), [{ index: 1, id: current.id, code: 'identity_conflict' }]);
    const persisted = fx.repository.getById(current.id);
    assert.equal(persisted?.status, 'cleanup_pending');
    assert.equal(persisted?.updatedAt, current.updatedAt);
    assert.deepEqual(persisted?.recoveryBundle, current.recoveryBundle);
    assert.equal(manager.getRecord(current.id)?.status, 'cleanup_pending');
    assert.ok(fx.repository.getById(later.id), 'later valid record is imported after identity conflict');
    assert.equal(existsSync(join(fx.worktreeRoot, 'leases.json')), true);
  } finally {
    fx.close();
  }
});

test('continues after a middle unique conflict and retries before a collision-safe archive on restart', () => {
  const fx = fixture();
  try {
    const blocker = legacyLease(fx, 'wt-blocker', { branchName: 'agentos/already-claimed' });
    fx.repository.create(blocker);

    const before = legacyLease(fx, 'wt-before-conflict');
    const conflict = legacyLease(fx, 'wt-unique-conflict', { branchName: blocker.branchName });
    const after = legacyLease(fx, 'wt-after-conflict');
    mkdirSync(before.absolutePath, { recursive: true });
    writeFileSync(join(before.absolutePath, 'checkout-sentinel.txt'), 'preserve');
    mkdirSync(fx.worktreeRoot, { recursive: true });
    const source = JSON.stringify([before, conflict, after]);
    const sourcePath = join(fx.worktreeRoot, 'leases.json');
    const existingArchive = join(fx.worktreeRoot, 'leases.json.migrated');
    writeFileSync(sourcePath, source, 'utf8');
    writeFileSync(existingArchive, 'keep-existing-archive', 'utf8');

    const first = fx.manager();
    assert.deepEqual(first.getLegacyImportReport(), [{ index: 1, id: conflict.id, code: 'unique_conflict' }]);
    assert.ok(fx.repository.getById(before.id));
    assert.equal(fx.repository.getById(conflict.id), undefined);
    assert.ok(fx.repository.getById(after.id), 'record after unique conflict is imported');
    assert.equal(readFileSync(sourcePath, 'utf8'), source, 'source remains intact when any record fails');
    assert.equal(readFileSync(existingArchive, 'utf8'), 'keep-existing-archive');
    assert.equal(existsSync(join(fx.worktreeRoot, 'leases.json.migrated.1')), false);

    assert.equal(fx.repository.delete(blocker.id), true);
    const restarted = fx.manager();
    assert.deepEqual(restarted.getLegacyImportReport(), []);
    assert.ok(fx.repository.getById(conflict.id), 'failed record is retried on restart');
    assert.equal(existsSync(sourcePath), false, 'source is moved out of the active filename after all records are handled');
    assert.equal(readFileSync(existingArchive, 'utf8'), 'keep-existing-archive', 'existing archive is never overwritten');
    assert.equal(readFileSync(join(fx.worktreeRoot, 'leases.json.migrated.1'), 'utf8'), source);
    assert.equal(readFileSync(join(before.absolutePath, 'checkout-sentinel.txt'), 'utf8'), 'preserve', 'import never deletes a checkout');

    const third = fx.manager();
    assert.equal(third.listLeases().length, 3);
    assert.deepEqual(third.getLegacyImportReport(), []);
  } finally {
    fx.close();
  }
});

test('rolls back a trigger-failed legacy row and imports later records', () => {
  const fx = fixture();
  try {
    const failed = legacyLease(fx, 'wt-trigger-failure');
    const later = legacyLease(fx, 'wt-after-trigger');
    fx.db.exec(`CREATE TRIGGER reject_legacy_worktree AFTER INSERT ON worktrees
      WHEN NEW.id = '${failed.id}' BEGIN SELECT RAISE(ABORT, 'injected trigger failure'); END`);
    mkdirSync(fx.worktreeRoot, { recursive: true });
    writeFileSync(join(fx.worktreeRoot, 'leases.json'), JSON.stringify([failed, later]), 'utf8');

    const manager = fx.manager();
    assert.deepEqual(manager.getLegacyImportReport(), [{ index: 0, id: failed.id, code: 'database_error' }]);
    assert.equal(fx.repository.getById(failed.id), undefined, 'failed transaction leaves no partial SQLite row');
    assert.ok(fx.repository.getById(later.id));
    assert.equal(existsSync(join(fx.worktreeRoot, 'leases.json')), true);
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
