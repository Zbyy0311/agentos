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
