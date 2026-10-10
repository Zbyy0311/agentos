import { Router, type Request, type Response } from 'express';

import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { RuntimeInspectorError } from '../services/RuntimeInspector.js';

/**
 * Lite Runtime Inspector route (13-Runtime-Inspector.md).
 *
 * GET the read-only projection for one Run. The Inspector is never a source of truth:
 * this route composes the merged RuntimeInspector projection, and it never mutates,
 * never spawns a Process, never runs Git, and never forces a Run status.
 */
export function createRuntimeInspectorRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });

  router.get('/runs/:runId/inspector', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const afterSequence = typeof req.query.afterSequence === 'string' ? Number(req.query.afterSequence) : 0;
    const maxEvents = typeof req.query.maxEvents === 'string' ? Number(req.query.maxEvents) : undefined;
    try {
      const projection = store.runtimeInspector().inspect({
        workspaceId: workspace.id,
        runId: req.params.runId,
        ...(maxEvents === undefined ? {} : { maxEvents }),
        afterSequence,
      });
      res.json({ projection });
    } catch (error) {
      if (error instanceof RuntimeInspectorError) {
        const status = error.code === 'RUN_NOT_FOUND' ? 404 : error.code === 'INPUT_INVALID' ? 400 : 500;
        sendProblem(req, res, { status, code: error.code, detail: error.message });
        return;
      }
      sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
    }
  });

  return router;
}

