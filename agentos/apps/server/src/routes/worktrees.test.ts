import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../services/WorktreeManager.js';
import { createWorktreeRoutes } from './worktrees.js';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'agentos-worktree-route-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'agentos@example.test']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'AgentOS Test']);
  writeFileSync(join(root, 'README.md'), 'base');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'base']);
  return root;
}

test('worktree routes keep path private and require clean/confirmed cleanup gates', async () => {
  const root = repo();
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agentos-worktree-root-'));
  const manager = new WorktreeManager(worktreeRoot);
  const app = express();
  app.use(express.json());
  const workspaceManager = { get: (id: string) => id === 'workspace-a' ? { id, rootPath: root } : undefined };
  app.use('/api/workspaces/:workspaceId', createWorktreeRoutes(workspaceManager as never, manager));
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const base = `http://127.0.0.1:${address.port}/api/workspaces/workspace-a`;
    writeFileSync(join(root, 'dirty.txt'), 'dirty');
    const rejected = await fetch(`${base}/runs/run-1/worktrees`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executionId: 'exec-1', agentId: 'agent-1' }),
    });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).code, 'workspace_dirty');
    execFileSync('git', ['-C', root, 'clean', '-fd']);
    const created = await fetch(`${base}/runs/run-1/worktrees`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executionId: 'exec-1', agentId: 'agent-1' }),
    });
    assert.equal(created.status, 201);
    const lease = (await created.json()).lease as { id: string; pathLabel: string };
    assert.equal('absolutePath' in lease, false);
    const missingConfirmation = await fetch(`${base}/worktrees/${lease.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(missingConfirmation.status, 409);
    const missingBundle = await fetch(`${base}/worktrees/${lease.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmRecoveryBundle: true }) });
    assert.equal(missingBundle.status, 409);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test('worktree cleanup requires a terminal Run before recovery confirmation', async () => {
  const root = repo();
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'agentos-worktree-route-terminal-'));
  const manager = new WorktreeManager(worktreeRoot);
  const lease = await manager.createLease({ workspaceId: 'workspace-a', workspaceRoot: root, runId: 'run-a', executionId: 'execution-a', agentId: 'agent-a' });
  const app = express();
  app.use(express.json());
  const workspaceManager = { get: (id: string) => id === 'workspace-a' ? { id, rootPath: root } : undefined };
  app.use('/api/workspaces/:workspaceId', createWorktreeRoutes(workspaceManager as never, manager, undefined, { getRun: () => ({ status: 'running' }) as never }));
  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/workspaces/workspace-a/worktrees/${lease.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmRecoveryBundle: true }),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'run_terminal_required');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});
