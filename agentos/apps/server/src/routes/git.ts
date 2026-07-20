import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';

const execFileAsync = promisify(execFile);

export type GitCommandExecutor = (cwd: string, args: string[]) => Promise<string>;

const executeGitFile: GitCommandExecutor = async (cwd, args) => {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  return result.stdout;
};

export function createGitRoutes(
  workspaceManager: WorkspaceManager,
  executeGit: GitCommandExecutor = executeGitFile,
): Router {
  const router = Router({ mergeParams: true });

  async function runGit(workspaceId: string, args: string[]): Promise<string> {
    const workspace = workspaceManager.get(workspaceId);
    if (!workspace) throw new Error('Workspace not found');
    if (!existsSync(workspace.rootPath)) throw new Error('Workspace path does not exist');
    return executeGit(workspace.rootPath, args);
  }

  router.get('/diff', async (req: Request, res: Response) => {
    try {
      const diff = await runGit(req.params.workspaceId, ['diff']);
      res.json({ diff: diff || '(no changes)' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ diff: `(git diff failed: ${message})` });
    }
  });

  router.get('/status', async (req: Request, res: Response) => {
    try {
      const status = await runGit(req.params.workspaceId, ['status', '--short']);
      res.json({ status: status || '(clean)' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ status: `(git status failed: ${message})` });
    }
  });

  router.get('/log', async (req: Request, res: Response) => {
    try {
      const log = await runGit(req.params.workspaceId, ['log', '--oneline', '-20']);
      res.json({ log });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ log: `(git log failed: ${message})` });
    }
  });

  return router;
}
