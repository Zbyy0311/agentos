import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createGitRoutes, type GitCommandExecutor } from './git.js';

test('git status awaits an asynchronous command without blocking timers', async () => {
  let timerRan = false;
  const executeGit: GitCommandExecutor = async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    return ' M changed.ts\n';
  };
  const manager = {
    get: (workspaceId: string) => workspaceId === 'workspace-a'
      ? { id: workspaceId, rootPath: process.cwd() }
      : undefined,
  } as WorkspaceManager;
  const app = express();
  app.use('/workspaces/:workspaceId/git', createGitRoutes(manager, executeGit));
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const request = fetch(`http://127.0.0.1:${port}/workspaces/workspace-a/git/status`);
    setTimeout(() => { timerRan = true; }, 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(timerRan, true);
    assert.deepEqual(await (await request).json(), { status: ' M changed.ts\n' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

/**
 * LITE-06-011: Git observation wording never implies an AgentOS-owned Git workflow.
 *
 * The bounded Git surface is an observation surface: it reads the Workspace's
 * repository state and reports it. The two halves of that claim are asserted here -
 * every Git route is a read (a mutating method is not routed at all), and the
 * payload vocabulary stays observational rather than presenting AgentOS as the owner
 * of the branch, commit or merge workflow. This is the wording half of the
 * Workspace-admission guarantees; the admission behaviour itself is asserted in
 * WorkspaceAdmissionAuthority.test.ts.
 */
test('LITE-06-011 the Git surface observes only and its wording claims no ownership', async () => {
  const observed: string[][] = [];
  const executeGit: GitCommandExecutor = async (_cwd, args) => {
    observed.push(args);
    return 'observed output\n';
  };
  const manager = {
    get: (workspaceId: string) => workspaceId === 'workspace-a'
      ? { id: workspaceId, rootPath: process.cwd() }
      : undefined,
  } as WorkspaceManager;
  const app = express();
  app.use(express.json());
  app.use('/workspaces/:workspaceId/git', createGitRoutes(manager, executeGit));
  const server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/workspaces/workspace-a/git`;
  try {
    // Every documented route answers a read and stays a read.
    for (const route of ['status', 'diff', 'log']) {
      const response = await fetch(`${base}/${route}`);
      assert.equal(response.status, 200, `${route} is served as an observation`);
      const body = await response.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body), [route], 'the payload names the observation it returned');
      for (const value of Object.values(body)) {
        assert.equal(typeof value, 'string', 'an observation carries data, not a control');
      }
    }
    // No mutating method is routed: AgentOS does not own the Git workflow here.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${base}/status`, {
        method, headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(response.status, 404, `${method} must not be routed on the Git surface`);
    }
    // Every command the surface issues is a read-only Git query.
    assert.ok(observed.length >= 3, 'the surface ran the observations it was asked for');
    for (const args of observed) {
      assert.equal(['status', 'diff', 'log'].includes(args[0] ?? ''), true,
        `the Git surface only issues read-only queries; saw ${JSON.stringify(args)}`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
