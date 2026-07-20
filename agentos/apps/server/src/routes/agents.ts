import { Router, type NextFunction, type Request, type Response } from 'express';
import { getAgentCapability, resolveCommand, FORCE_MOCK } from '@agentos/agent-core';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import type { Workspace } from '@agentos/shared';

export function createAgentRoutes(workspaceManager: WorkspaceManager): Router {
  const router = Router();

  // List agents for a given workspace, using its per-workspace agent config
  router.get('/:workspaceId/status', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const workspace = workspaceManager.get(req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

      const agents = await buildAgentList(workspace);
      res.json({ agents, workspaceId: workspace.id });
    } catch (err) {
      next(err);
    }
  });

  // Legacy: list global agents (no workspace context)
  router.get('/status', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Use the first workspace's agents if any exist, else fall back to empty
      const workspaces = workspaceManager.list();
      if (workspaces.length > 0) {
        const agents = await buildAgentList(workspaces[0]);
        res.json({ agents });
      } else {
        res.json({ agents: [] });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}

async function buildAgentList(workspace: Workspace): Promise<unknown[]> {
  const results = [];
  for (const workspaceAgent of workspace.agents) {
    if (!workspaceAgent.enabled) continue;
    const resolved = FORCE_MOCK ? null : await resolveCommand(workspaceAgent.cliCommand);
    const connected = resolved !== null;
    results.push({
      id: workspaceAgent.id,
      name: workspaceAgent.name,
      role: workspaceAgent.role,
      cli: workspaceAgent.cliCommand,
      model: workspaceAgent.model ?? '',
      connected,
      mode: FORCE_MOCK ? 'mock' : (connected ? 'real' : 'mock'),
      path: resolved ?? '',
      thinkingEffort: workspaceAgent.thinkingEffort ?? 'auto',
      capability: getAgentCapability(workspaceAgent.role, workspaceAgent.cliCommand, workspaceAgent.model),
    });
  }
  return results;
}
