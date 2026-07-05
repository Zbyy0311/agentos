import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';

export function createGitRoutes(workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });

  function runGit(workspaceId: string, args: string[]): string {
    const workspace = workspaceManager.get(workspaceId);
    if (!workspace) throw new Error('Workspace not found');
    if (!existsSync(workspace.rootPath)) throw new Error('Workspace path does not exist');
    return execSync(`git ${args.join(' ')}`, {
      cwd: workspace.rootPath,
      encoding: 'utf-8',
      timeout: 10000,
    });
  }

  router.get('/diff', (req: Request, res: Response) => {
    try {
      const diff = runGit(req.params.workspaceId, ['diff']);
      res.json({ diff: diff || '(no changes)' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ diff: `(git diff failed: ${message})` });
    }
  });

  router.get('/status', (req: Request, res: Response) => {
    try {
      const status = runGit(req.params.workspaceId, ['status', '--short']);
      res.json({ status: status || '(clean)' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ status: `(git status failed: ${message})` });
    }
  });

  router.get('/log', (req: Request, res: Response) => {
    try {
      const log = runGit(req.params.workspaceId, ['log', '--oneline', '-20']);
      res.json({ log });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ log: `(git log failed: ${message})` });
    }
  });

  return router;
}
