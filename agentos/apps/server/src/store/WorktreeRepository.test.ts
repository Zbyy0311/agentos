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
import { WorktreeRepository, type WorktreeLeaseRecord } from './WorktreeRepository.js';

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
  const root = mkdtempSync(join(tmpdir(), 'agentos-worktree-repo-'));
  const db = new DatabaseSync(join(root, 'agentos.sqlite'));
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner(db as unknown as MinimalDatabaseSync, new MigrationRegistry(DEFAULT_REGISTRY_MIGRATIONS)).run();
  const repo = new WorktreeRepository(db as unknown as TransactionDatabase);
  return { db, repo, root, close: () => { try { db.close(); } finally { rmSync(root, { recursive: true, force: true }); } } };
}

function leaseInput(overrides: Partial<WorktreeLeaseRecord> = {}): WorktreeLeaseRecord {
  return {
    id: 'wt_test_a',
    workspaceId: 'ws_test',
    runId: 'run_test',
    executionId: 'exec_a',
    agentId: 'agent_a',
    branchName: 'agentos/run-test-exec-a',
    pathLabel: 'worktree/ws_test/run_test/exec_a',
    baseCommit: 'base123',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    absolutePath: '/wt/ws_test/run_test/exec_a',
    workspaceRoot: '/ws/ws_test',
    ...overrides,
  };
}

test('creates and reads a lease with full field mapping', () => {
  const fx = fixture();
  try {
    const input = leaseInput({ recoveryBundle: { trackedPatchArtifactId: 'a1', untrackedArchiveArtifactId: 'a2', manifestArtifactId: 'a3', entryCount: 2 } });
    fx.repo.create(input);
    const record = fx.repo.getById('wt_test_a');
    assert.deepEqual(record, input);
    assert.equal(fx.repo.findByWorkspace('ws_test').length, 1);
    assert.equal(fx.repo.findByRun('run_test').length, 1);
    assert.deepEqual(fx.repo.findByWorkspace('other'), []);
    assert.deepEqual(fx.repo.findByRun('other'), []);
    assert.equal(fx.repo.getById('missing'), undefined);
  } finally {
    fx.close();
  }
});

test('enforces UNIQUE(workspace_id, branch_name) and UNIQUE(workspace_id, absolute_path)', () => {
  const fx = fixture();
  try {
    fx.repo.create(leaseInput());
    assert.throws(
      () => fx.repo.create(leaseInput({ id: 'wt_test_b' })),
      /UNIQUE/,
    );
    assert.throws(
      () => fx.repo.create(leaseInput({ id: 'wt_test_b', branchName: 'agentos/other', absolutePath: '/wt/ws_test/run_test/exec_a' })),
      /UNIQUE/,
    );
    // Same branch/path under a different workspace is allowed.
    fx.repo.create(leaseInput({ id: 'wt_test_b', workspaceId: 'ws_other', absolutePath: '/wt/ws_other/run_test/exec_a' }));
    assert.equal(fx.repo.list().length, 2);
  } finally {
    fx.close();
  }
});

test('save upserts and delete removes', () => {
  const fx = fixture();
  try {
    fx.repo.save(leaseInput());
    fx.repo.save(leaseInput({ status: 'cleanup_pending', updatedAt: '2026-10-12T01:00:00.000Z' }));
    assert.equal(fx.repo.list().length, 1);
    assert.equal(fx.repo.getById('wt_test_a')?.status, 'cleanup_pending');
    assert.equal(fx.repo.delete('wt_test_a'), true);
    assert.equal(fx.repo.delete('wt_test_a'), false);
    assert.equal(fx.repo.getById('wt_test_a'), undefined);
  } finally {
    fx.close();
  }
});

test('transitionStatus commits only valid in-transaction status transitions', () => {
  const fx = fixture();
  try {
    fx.repo.create(leaseInput({ status: 'active' }));
    assert.equal(fx.repo.transitionStatus('wt_test_a', 'cleanup_pending', NOW, ['active']), true);
    assert.equal(fx.repo.getById('wt_test_a')?.status, 'cleanup_pending');
    // Disallowed source status: no write.
    assert.equal(fx.repo.transitionStatus('wt_test_a', 'failed', NOW, ['active', 'creating']), false);
    assert.equal(fx.repo.getById('wt_test_a')?.status, 'cleanup_pending');
    assert.equal(fx.repo.transitionStatus('missing', 'failed', NOW), false);
    assert.equal(fx.repo.transitionStatus('wt_test_a', 'cleaned', NOW), true);
  } finally {
    fx.close();
  }
});

test('updateRecoveryBundle stores the bundle and completes the lease atomically', () => {
  const fx = fixture();
  try {
    fx.repo.create(leaseInput({ status: 'cleanup_pending' }));
    const bundle = { trackedPatchArtifactId: 'p1', untrackedArchiveArtifactId: 'p2', manifestArtifactId: 'p3', entryCount: 3 };
    assert.equal(fx.repo.updateRecoveryBundle('wt_test_a', bundle, NOW), true);
    const record = fx.repo.getById('wt_test_a');
    assert.equal(record?.status, 'completed');
    assert.deepEqual(record?.recoveryBundle, bundle);
    assert.equal(fx.repo.updateRecoveryBundle('missing', bundle, NOW), false);
  } finally {
    fx.close();
  }
});

test('importLegacy is idempotent by id', () => {
  const fx = fixture();
  try {
    const input = leaseInput();
    fx.repo.importLegacy(input);
    fx.repo.importLegacy(input);
    assert.equal(fx.repo.list().length, 1);
    assert.equal(fx.repo.getById('wt_test_a')?.status, 'active');
  } finally {
    fx.close();
  }
});
