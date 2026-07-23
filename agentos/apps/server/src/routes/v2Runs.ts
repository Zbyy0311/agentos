import { Router, type Request, type Response } from 'express';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService } from '../services/TaskRunService.js';
import { RunNotFoundError } from '../store/RunRepository.js';
import { requireV2Workspace, respondV2 } from './v2Tasks.js';

export function createV2RunRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const service = new TaskRunService(store);

  router.get('/runs/:runId', (req: Request, res: Response) => respondV2(res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { runId } = req.params as { runId: string };
    const run = store.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    return { status: 200, body: { run } };
  }));

  router.post('/runs/:runId/cancel', (req: Request, res: Response) => respondV2(res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { runId } = req.params as { runId: string };
    const run = service.cancelQueuedRun(workspaceId, runId);
    return { status: 200, body: { run } };
  }));

  return router;
}
