import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../services/WorktreeManager.js';
import { WorktreeMergeError } from '../services/WorktreeMergeService.js';
import type { WorktreeMergeRecord } from '../store/WorktreeMergeRepository.js';
import { createWorktreeRoutes } from './worktrees.js';

function mergeRecord(overrides: Partial<WorktreeMergeRecord> = {}): WorktreeMergeRecord {
  return {
    id: 'wtmg_route_a',
    worktreeId: 'wt_route_a',
    strategy: 'ff',
    sourceBranch: 'agentos/run-x',
    targetBranch: 'main',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    expectedHeadCommit: 'a'.repeat(40),
    previousTargetCommit: 'a'.repeat(40),
    resultingTargetCommit: 'b'.repeat(40),
    mergeCommit: null,
    result: 'merged',
    requestedBy: 'api',
    createdAt: '2026-10-12T00:00:00.000Z',
    completedAt: '2026-10-12T00:00:01.000Z',
    ...overrides,
  };
}

function appWith(mergeImpl: (worktreeId: string, request: unknown) => Promise<WorktreeMergeRecord>) {
  const app = express();
  app.use(express.json());
  const workspaceManager = { get: (id: string) => id === 'workspace-a' ? { id, rootPath: '/tmp/x' } : undefined };
  const manager = new WorktreeManager(mkdtempSync(join(tmpdir(), 'agentos-worktree-route-merge-')));
  const mergeService = { merge: mergeImpl } as never;
  app.use('/api/workspaces/:workspaceId', createWorktreeRoutes(workspaceManager as never, manager, undefined, undefined, undefined, mergeService));
  return app;
}

async function withServer(app: express.Express, run: (base: string) => Promise<void>): Promise<void> {
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    await run(`http://127.0.0.1:${address.port}/api/workspaces/workspace-a`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('merge route returns the persisted merge record on success', async () => {
  const app = appWith(async () => mergeRecord());
  await withServer(app, async base => {
    const response = await fetch(`${base}/worktrees/wt_route_a/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'ff', targetBranch: 'main', expectedHeadCommit: 'a'.repeat(40) }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { merge: WorktreeMergeRecord };
    assert.equal(body.merge.id, 'wtmg_route_a');
    assert.equal(body.merge.result, 'merged');
  });
});

test('merge route maps error codes to 404/400/409 problem details', async () => {
  const cases: Array<{ error: WorktreeMergeError; status: number }> = [
    { error: new WorktreeMergeError('WORKTREE_NOT_FOUND', 'missing'), status: 404 },
    { error: new WorktreeMergeError('WORKTREE_MERGE_INVALID_REQUEST', 'bad strategy'), status: 400 },
    { error: new WorktreeMergeError('WORKTREE_MERGE_INVALID_STATUS', 'status'), status: 409 },
    { error: new WorktreeMergeError('WORKTREE_MERGE_HEAD_MISMATCH', 'advanced'), status: 409 },
    { error: new WorktreeMergeError('WORKTREE_MERGE_CONFLICTED', 'conflict', mergeRecord({ result: 'conflicted' })), status: 409 },
  ];
  for (const { error, status } of cases) {
    const app = appWith(async () => { throw error; });
    await withServer(app, async base => {
      const response = await fetch(`${base}/worktrees/wt_route_a/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy: 'ff', targetBranch: 'main', expectedHeadCommit: 'a'.repeat(40) }),
      });
      assert.equal(response.status, status, error.code);
      const body = await response.json() as { code: string };
      assert.equal(body.code, error.code);
    });
  }
});

test('merge route 404s for unknown workspaces and passes requestedBy through', async () => {
  let seenRequestedBy: string | undefined;
  const app = appWith(async (_id, request) => {
    seenRequestedBy = (request as { requestedBy: string }).requestedBy;
    return mergeRecord();
  });
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const missing = await fetch(`http://127.0.0.1:${address.port}/api/workspaces/unknown/worktrees/wt/merge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'ff', targetBranch: 'main', expectedHeadCommit: 'a'.repeat(40) }),
    });
    assert.equal(missing.status, 404);
    const ok = await fetch(`http://127.0.0.1:${address.port}/api/workspaces/workspace-a/worktrees/wt_route_a/merge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'ff', targetBranch: 'main', expectedHeadCommit: 'a'.repeat(40), requestedBy: 'operator-1' }),
    });
    assert.equal(ok.status, 200);
    assert.equal(seenRequestedBy, 'operator-1');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('merge route is not registered when no merge service is supplied', async () => {
  const app = express();
  app.use(express.json());
  const workspaceManager = { get: (id: string) => id === 'workspace-a' ? { id, rootPath: '/tmp/x' } : undefined };
  const manager = new WorktreeManager(mkdtempSync(join(tmpdir(), 'agentos-worktree-route-nomerge-')));
  app.use('/api/workspaces/:workspaceId', createWorktreeRoutes(workspaceManager as never, manager));
  await withServer(app, async base => {
    const response = await fetch(`${base}/worktrees/wt/merge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategy: 'ff', targetBranch: 'main', expectedHeadCommit: 'a'.repeat(40) }),
    });
    assert.equal(response.status, 404);
  });
});
