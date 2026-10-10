import { Router, type Request, type Response } from 'express';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { MemoryMaintenanceService } from '../services/MemoryMaintenanceService.js';

/** Read-only, workspace-bound suggestions; lifecycle actions remain an explicit human step. */
export function createMemoryMaintenanceRoutes(store: SqliteStore, workspaces: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const maintenance = new MemoryMaintenanceService(store.getDatabase());

  router.get('/memory/maintenance', (req: Request, res: Response) => {
    const workspace = workspaces.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }

    try {
      // An older M1/M2 database gets an explicit unavailable result from the
      // service instead of making route registration or server startup fail.
      res.json(maintenance.list(workspace.id));
    } catch {
      // Keep SQLite details and persisted memory text out of the public error.
      sendProblem(req, res, { status: 500, code: 'MEMORY_MAINTENANCE_FAILED', detail: 'Memory maintenance failed' });
    }
  });

  return router;
}
