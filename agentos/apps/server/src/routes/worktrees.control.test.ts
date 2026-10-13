import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../services/WorktreeManager.js';
import { createWorktreeRoutes } from './worktrees.js';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-worktree-control-'));
  execFileSync('git', ['-c', 'core.symlinks=false', 'init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'agentos@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'AgentOS Test']);
  writeFileSync(join(root, 'README.md'), 'base');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  return root;
}

interface Fixture {
  root: string;
  worktreeRoot: string;
  base: string;
  close(): Promise<void>;
}

async function fixture(runLookup?: { getRun(workspaceId: string, runId: string): { status: string } | undefined }, artifactService?: unknown): Promise<Fixture & { manager: WorktreeManager }> {
  const root = repo();
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agentos-worktree-control-root-'));
  const manager = new WorktreeManager(worktreeRoot);
  const app = express();
  app.use(express.json());
  const workspaceManager = { get: (id: string) => id === 'workspace-a' ? { id, rootPath: root } : undefined };
  app.use('/api/workspaces/:workspaceId', createWorktreeRoutes(workspaceManager as never, manager, artifactService as never, runLookup));
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return {
    root, worktreeRoot, manager,
    base: `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`,
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
      rmSync(worktreeRoot, { recursive: true, force: true });
    },
  };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}

test('status endpoint reports lease state plus git-side snapshot', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.manager.createLease({ workspaceId: 'workspace-a', workspaceRoot: fx.root, runId: 'run-a', executionId: 'exec-a', agentId: 'agent-a' });
    const record = fx.manager.getRecord(lease.id);
    assert.ok(record);
    writeFileSync(join(record.absolutePath, 'dirty.txt'), 'dirty');
    const response = await fetch(`${fx.base}/worktrees/${lease.id}/status`);
    assert.equal(response.status, 200);
    const body = await response.json() as { lease: { id: string; status: string }; git: { exists: boolean; gitReachable: boolean; branch: string; head?: string; dirtyFiles: number; ahead: number; behind: number } };
    assert.equal(body.lease.id, lease.id);
    assert.equal(body.git.exists, true);
    assert.equal(body.git.gitReachable, true);
    assert.equal(body.git.branch, lease.branchName);
    assert.ok(body.git.head);
    assert.equal(body.git.dirtyFiles, 1);
    assert.equal(body.git.ahead, 0);
    assert.equal(body.git.behind, 0);
    const missing = await fetch(`${fx.base}/worktrees/nope/status`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'WORKTREE_NOT_FOUND');
  } finally { await fx.close(); }
});

test('diff endpoint reports stat and patch with truncation flag', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.manager.createLease({ workspaceId: 'workspace-a', workspaceRoot: fx.root, runId: 'run-b', executionId: 'exec-b', agentId: 'agent-b' });
    const record = fx.manager.getRecord(lease.id);
    assert.ok(record);
    writeFileSync(join(record.absolutePath, 'README.md'), `${readFileSync(join(record.absolutePath, 'README.md'), 'utf8')}\n${'changed-' + 'x'.repeat(2_000)}`);
    const response = await fetch(`${fx.base}/worktrees/${lease.id}/diff`);
    assert.equal(response.status, 200);
    const body = await response.json() as { diff: { stat: { filesChanged: number; insertions: number; deletions: number }; patch: string; truncated: boolean; baseCommit: string } };
    assert.equal(body.diff.stat.filesChanged, 1);
    assert.equal(body.diff.stat.insertions, 2);
    assert.equal(body.diff.stat.deletions, 1);
    assert.equal(body.diff.truncated, false);
    assert.match(body.diff.patch, /changed-/);
    assert.equal(body.diff.baseCommit, record.baseCommit);
    const truncated = await fetch(`${fx.base}/worktrees/${lease.id}/diff?maxBytes=1024`);
    assert.equal(truncated.status, 200);
    assert.equal((await truncated.json()).diff.truncated, true);
    const invalid = await fetch(`${fx.base}/worktrees/${lease.id}/diff?maxBytes=10`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).code, 'INVALID_MAX_BYTES');
  } finally { await fx.close(); }
});

test('events endpoint returns the minimal lease-derived timeline', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.manager.createLease({ workspaceId: 'workspace-a', workspaceRoot: fx.root, runId: 'run-c', executionId: 'exec-c', agentId: 'agent-c' });
    const response = await fetch(`${fx.base}/worktrees/${lease.id}/events`);
    assert.equal(response.status, 200);
    const body = await response.json() as { events: { at: string; type: string; status: string }[]; eventModel: string };
    assert.equal(body.eventModel, 'lease_timeline_minimal');
    assert.equal(body.events.length, 2);
    assert.equal(body.events[0].type, 'created');
    assert.equal(body.events[1].type, 'updated');
  } finally { await fx.close(); }
});

test('artifacts endpoint lists only the requested worktree artifacts and marks recovery bundle members', async () => {
  let requestedWorktreeId: string | undefined;
  const fx = await fixture(undefined, {
    listForRun: () => { throw new Error('The endpoint must not expose artifacts from other worktrees in the same Run'); },
    listForWorktree: (worktreeId: string) => {
      requestedWorktreeId = worktreeId;
      return [
        { id: 'patch-1', type: 'diff', title: 'Worktree tracked patch' },
        { id: 'other-1', type: 'log', title: 'Worktree diagnostic log' },
      ];
    },
  });
  try {
    const lease = await fx.manager.createLease({ workspaceId: 'workspace-a', workspaceRoot: fx.root, runId: 'run-d', executionId: 'exec-d', agentId: 'agent-d' });
    const record = fx.manager.getRecord(lease.id);
    assert.ok(record);
    record.recoveryBundle = { trackedPatchArtifactId: 'patch-1', untrackedArchiveArtifactId: 'arch-1', manifestArtifactId: 'man-1', entryCount: 0 };
    const response = await fetch(`${fx.base}/worktrees/${lease.id}/artifacts`);
    assert.equal(response.status, 200);
    assert.equal(requestedWorktreeId, lease.id);
    const body = await response.json() as { artifacts: { id: string; recoveryBundleMember: boolean }[]; recoveryBundle: { trackedPatchArtifactId: string } | null };
    assert.equal(body.artifacts.length, 2);
    assert.equal(body.artifacts.find(a => a.id === 'patch-1')?.recoveryBundleMember, true);
    assert.equal(body.artifacts.find(a => a.id === 'other-1')?.recoveryBundleMember, false);
    assert.equal(body.recoveryBundle?.trackedPatchArtifactId, 'patch-1');
  } finally { await fx.close(); }
});

test('inspect endpoint reports consistency and never mutates lease status', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.manager.createLease({ workspaceId: 'workspace-a', workspaceRoot: fx.root, runId: 'run-e', executionId: 'exec-e', agentId: 'agent-e' });
    const record = fx.manager.getRecord(lease.id);
    assert.ok(record);
    const healthy = await postJson(`${fx.base}/worktrees/${lease.id}/inspect`, {});
    assert.equal(healthy.status, 200);
    const healthyBody = await healthy.json() as { report: { consistent: boolean; checks: { directoryExists: boolean; gitReachable: boolean; pathWithinRoot: boolean | null; statusConsistent: boolean } } };
    assert.equal(healthyBody.report.consistent, true);
    assert.equal(healthyBody.report.checks.directoryExists, true);
    assert.equal(healthyBody.report.checks.gitReachable, true);
    assert.equal(healthyBody.report.checks.pathWithinRoot, true);
    assert.equal(healthyBody.report.checks.statusConsistent, true);
    rmSync(record.absolutePath, { recursive: true, force: true });
    const broken = await postJson(`${fx.base}/worktrees/${lease.id}/inspect`, {});
    assert.equal(broken.status, 200);
    const brokenBody = await broken.json() as { report: { consistent: boolean; checks: { directoryExists: boolean; gitReachable: boolean; statusConsistent: boolean } } };
    assert.equal(brokenBody.report.consistent, false);
    assert.equal(brokenBody.report.checks.directoryExists, false);
    assert.equal(brokenBody.report.checks.gitReachable, false);
    assert.equal(brokenBody.report.checks.statusConsistent, false);
    assert.equal(fx.manager.getLease(lease.id)?.status, 'active');
  } finally { await fx.close(); }
});

test('abandon requires confirmation, transitions status, and preserves the directory', async () => {
  const fx = await fixture();
  try {
    const lease = await fx.manager.createLease({ workspaceId: 'workspace-a', workspaceRoot: fx.root, runId: 'run-f', executionId: 'exec-f', agentId: 'agent-f' });
    const record = fx.manager.getRecord(lease.id);
    assert.ok(record);
    const unconfirmed = await postJson(`${fx.base}/worktrees/${lease.id}/abandon`, {});
    assert.equal(unconfirmed.status, 400);
    assert.equal((await unconfirmed.json()).code, 'CONFIRMATION_REQUIRED');
    assert.equal(fx.manager.getLease(lease.id)?.status, 'active');
    const abandoned = await postJson(`${fx.base}/worktrees/${lease.id}/abandon`, { confirm: true });
    assert.equal(abandoned.status, 200);
    assert.equal((await abandoned.json()).lease.status, 'failed');
    assert.equal(fx.manager.getLease(lease.id)?.status, 'failed');
    assert.ok(existsSync(record.absolutePath), 'abandon must not delete the worktree directory');
    const again = await postJson(`${fx.base}/worktrees/${lease.id}/abandon`, { confirm: true });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, 'state_conflict');
  } finally { await fx.close(); }
});

test('adopt registers an unmanaged on-disk worktree with dedupe and guards', async () => {
  const fx = await fixture();
  try {
    const managedPath = join(fx.worktreeRoot, 'orphan-branch');
    execFileSync('git', ['-C', fx.root, 'worktree', 'add', '--no-checkout', '-b', 'orphan/branch', managedPath], { stdio: 'ignore' });
    writeFileSync(join(managedPath, 'README.md'), 'base');
    execFileSync('git', ['-C', managedPath, 'add', '.']);
    const missingBranch = await postJson(`${fx.base}/worktrees/adopt`, { path: managedPath });
    assert.equal(missingBranch.status, 400);
    const notGitBranch = await postJson(`${fx.base}/worktrees/adopt`, { path: join(fx.worktreeRoot, 'nope'), branchName: 'orphan/branch' });
    assert.equal(notGitBranch.status, 400);
    assert.equal((await notGitBranch.json()).code, 'path_not_found');
    const outside = mkdtempSync(join(tmpdir(), 'agentos-outside-'));
    try {
      const outsideResponse = await postJson(`${fx.base}/worktrees/adopt`, { path: outside, branchName: 'orphan/branch' });
      assert.equal(outsideResponse.status, 400);
      assert.equal((await outsideResponse.json()).code, 'path_outside_root');
    } finally { rmSync(outside, { recursive: true, force: true }); }
    const ghost = join(fx.worktreeRoot, 'ghost-branch');
    const ghostResponse = await postJson(`${fx.base}/worktrees/adopt`, { path: ghost, branchName: 'orphan/branch' });
    assert.equal(ghostResponse.status, 400);
    assert.equal((await ghostResponse.json()).code, 'path_not_found');
    const adopted = await postJson(`${fx.base}/worktrees/adopt`, { path: managedPath, branchName: 'orphan/branch', runId: 'run-g', executionId: 'exec-g', agentId: 'agent-g' });
    assert.equal(adopted.status, 201);
    const lease = (await adopted.json()).lease as { id: string; status: string; branchName: string };
    assert.equal(lease.status, 'active');
    assert.equal(lease.branchName, 'orphan/branch');
    assert.ok(fx.manager.getRecord(lease.id));
    const duplicate = await postJson(`${fx.base}/worktrees/adopt`, { path: managedPath, branchName: 'orphan/branch' });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).code, 'already_managed');
    const branchOnly = await postJson(`${fx.base}/worktrees/adopt`, { path: ghost, branchName: 'orphan/branch' });
    assert.equal(branchOnly.status, 400);
  } finally { await fx.close(); }
});
