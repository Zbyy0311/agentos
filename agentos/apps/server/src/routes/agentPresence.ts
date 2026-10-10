import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { AgentPresenceService } from '../services/AgentPresenceService.js';
import { SqliteStore } from '../store/SqliteStore.js';

export function createAgentPresenceRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const service = new AgentPresenceService(store);
  router.get('/agents/presence', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    return res.json({ presence: service.resolve(workspace.id) });
  });
  return router;
}

