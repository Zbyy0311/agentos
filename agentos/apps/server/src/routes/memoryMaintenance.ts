import { Router, type Request, type Response } from 'express';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryMaintenanceService } from '../services/MemoryMaintenanceService.js';

/** Read-only, workspace-bound suggestions; lifecycle actions remain an explicit human step. */
export function createMemoryMaintenanceRoutes(store: SqliteStore, workspaces: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const maintenance = new MemoryMaintenanceService(store.getDatabase());

  router.get('/memory/maintenance', (req: Request, res: Response) => {
    const workspace = workspaces.get(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return;
    }

    try {
      // An older M1/M2 database gets an explicit unavailable result from the
      // service instead of making route registration or server startup fail.
      res.json(maintenance.list(workspace.id));
    } catch {
      // Keep SQLite details and persisted memory text out of the public error.
      res.status(500).json({ error: 'MEMORY_MAINTENANCE_FAILED' });
    }
  });

  return router;
}
