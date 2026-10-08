import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorktreeManager } from './WorktreeManager.js';

function repo() { const root = mkdtempSync(join(tmpdir(), 'agentos-worktree-')); execFileSync('git',['init','-q'],{cwd:root}); execFileSync('git',['config','user.email','test@example.com'],{cwd:root}); execFileSync('git',['config','user.name','Test'],{cwd:root}); writeFileSync(join(root,'README.md'),'base'); execFileSync('git',['add','.'],{cwd:root}); execFileSync('git',['commit','-qm','base'],{cwd:root}); return root; }

test('rejects dirty repositories and creates execution-unique worktree names', async () => {
  const root = repo(); const manager = new WorktreeManager(mkdtempSync(join(tmpdir(), 'agentos-leases-')));
  writeFileSync(join(root, 'dirty.txt'), 'dirty');
  await assert.rejects(() => manager.createLease({ workspaceId:'w', workspaceRoot:root, runId:'run', executionId:'exec', agentId:'a' }), /workspace_dirty/);
  execFileSync('git',['clean','-fd'],{cwd:root});
  const first = await manager.createLease({ workspaceId:'w', workspaceRoot:root, runId:'run', executionId:'exec-1', agentId:'a' });
  const second = await manager.createLease({ workspaceId:'w', workspaceRoot:root, runId:'run', executionId:'exec-2', agentId:'a' });
  assert.notEqual(first.branchName, second.branchName); assert.notEqual(first.pathLabel, second.pathLabel);
});

test('reconciles missing paths as failed without deleting worktrees', async () => {
  const root = repo(); const manager = new WorktreeManager(mkdtempSync(join(tmpdir(), 'agentos-leases-')));
  const lease = await manager.createLease({ workspaceId:'w', workspaceRoot:root, runId:'run', executionId:'exec', agentId:'a' });
  manager.markCleanupPending(lease.id); await manager.reconcile();
  assert.equal(manager.getLease(lease.id)?.status, 'cleanup_pending');
});

test('marks active and creating leases failed while preserving files and remaining idempotent', async () => {
  const root = repo(); const manager = new WorktreeManager(mkdtempSync(join(tmpdir(), 'agentos-leases-')));
  const active = await manager.createLease({ workspaceId:'w', workspaceRoot:root, runId:'run', executionId:'active', agentId:'a' });
  const creating = await manager.createLease({ workspaceId:'w', workspaceRoot:root, runId:'run', executionId:'creating', agentId:'a' });
  manager.getRecord(creating.id)!.status = 'creating';
  const activeFile = join(manager.getRecord(active.id)!.absolutePath, 'preserved.txt');
  const creatingFile = join(manager.getRecord(creating.id)!.absolutePath, 'preserved.txt');
  writeFileSync(activeFile, 'keep active'); writeFileSync(creatingFile, 'keep creating');

  manager.markFailedPreserved(active.id); manager.markFailedPreserved(creating.id);
  assert.equal(manager.getLease(active.id)?.status, 'failed');
  assert.equal(manager.getLease(creating.id)?.status, 'failed');
  assert.equal(existsSync(activeFile), true); assert.equal(existsSync(creatingFile), true);

  const activeUpdatedAt = manager.getRecord(active.id)!.updatedAt;
  manager.markFailedPreserved(active.id); manager.markFailedPreserved(creating.id);
  assert.equal(manager.getRecord(active.id)!.updatedAt, activeUpdatedAt);
  assert.equal(manager.getLease(active.id)?.status, 'failed');
  assert.equal(manager.getLease(creating.id)?.status, 'failed');
  assert.equal(existsSync(activeFile), true); assert.equal(existsSync(creatingFile), true);
});

test('does not change cleanup_pending, completed, or cleaned leases', async () => {
  const root = repo(); const manager = new WorktreeManager(mkdtempSync(join(tmpdir(), 'agentos-leases-')));
  const cleanupPending = await manager.createLease({ workspaceId:'w', workspaceRoot:root, runId:'run', executionId:'cleanup', agentId:'a' });
  manager.markCleanupPending(cleanupPending.id);
  const completed = await manager.createLease({ workspaceId:'w', workspaceRoot:root, runId:'run', executionId:'completed', agentId:'a' });
  manager.getRecord(completed.id)!.status = 'completed';
  const cleaned = await manager.createLease({ workspaceId:'w', workspaceRoot:root, runId:'run', executionId:'cleaned', agentId:'a' });
  manager.getRecord(cleaned.id)!.status = 'cleaned';

  for (const lease of [cleanupPending, completed, cleaned]) {
    const file = join(manager.getRecord(lease.id)!.absolutePath, 'preserved.txt');
    writeFileSync(file, 'keep');
    const updatedAt = manager.getRecord(lease.id)!.updatedAt;
    manager.markFailedPreserved(lease.id);
    assert.equal(manager.getLease(lease.id)?.status, lease === cleanupPending ? 'cleanup_pending' : lease === completed ? 'completed' : 'cleaned');
    assert.equal(manager.getRecord(lease.id)!.updatedAt, updatedAt);
    assert.equal(existsSync(file), true);
  }
});

test('rejects unsafe roots, bare repositories, existing branches, and occupied targets', async () => {
  const root = repo();
  const manager = new WorktreeManager(mkdtempSync(join(tmpdir(), 'agentos-leases-')));
  await assert.rejects(() => manager.createLease({ workspaceId: 'w', workspaceRoot: 'relative-repo', runId: 'run', executionId: 'exec', agentId: 'a' }), /root_not_absolute/);
  const nestedManager = new WorktreeManager(join(root, '.agentos-worktrees'));
  await assert.rejects(() => nestedManager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'exec', agentId: 'a' }), /root_inside_workspace/);
  const branch = `agentos/run-${createHash('sha256').update('run').digest('hex').slice(0, 8)}-exec-${createHash('sha256').update('branch').digest('hex').slice(0, 8)}`;
  execFileSync('git', ['-C', root, 'branch', branch]);
  await assert.rejects(() => manager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'branch', agentId: 'a' }), /branch_exists/);
  const occupiedRoot = mkdtempSync(join(tmpdir(), 'agentos-occupied-'));
  const occupiedManager = new WorktreeManager(occupiedRoot);
  const target = join(occupiedRoot, createHash('sha256').update('w').digest('hex').slice(0, 8), createHash('sha256').update('run').digest('hex').slice(0, 8), createHash('sha256').update('occupied').digest('hex').slice(0, 8));
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'marker'), 'occupied');
  await assert.rejects(() => occupiedManager.createLease({ workspaceId: 'w', workspaceRoot: root, runId: 'run', executionId: 'occupied', agentId: 'a' }), /target_exists/);
});
