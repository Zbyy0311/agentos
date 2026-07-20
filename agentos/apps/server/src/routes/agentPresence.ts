import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { AgentPresenceService } from '../services/AgentPresenceService.js';
import { SqliteStore } from '../store/SqliteStore.js';

export function createAgentPresenceRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const service = new AgentPresenceService(store);
  router.get('/agents/presence', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    return res.json({ presence: service.resolve(workspace.id) });
  });
  return router;
}

