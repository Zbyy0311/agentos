import { Router, type Request, type Response } from 'express';

import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { RuntimeInspectorError } from '../services/RuntimeInspector.js';
import type { TimelineGroup, TimelineMode } from '../services/RuntimeTimeline.js';

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
    res.setHeader('Cache-Control', 'no-store');
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

  /**
   * §39-46 Timeline projection. mode=summary|detailed|raw, group=none|stage|
   * correlation|domain, plus the §44 types/severity/stageId filters and
   * afterSequence/limit pagination over the canonical Event order.
   */
  router.get('/runs/:runId/inspector/timeline', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const csv = (value: unknown): string[] | undefined => {
      if (typeof value !== 'string') return undefined;
      const parts = value.split(',').map(part => part.trim()).filter(part => part.length > 0);
      return parts.length === 0 ? undefined : parts;
    };
    try {
      const timeline = store.runtimeInspector().timeline({
        workspaceId: workspace.id,
        runId: req.params.runId,
        ...(typeof req.query.mode === 'string' ? { mode: req.query.mode as TimelineMode } : {}),
        ...(typeof req.query.group === 'string' ? { group: req.query.group as TimelineGroup } : {}),
        ...(csv(req.query.types) === undefined ? {} : { types: csv(req.query.types) }),
        ...(csv(req.query.severity) === undefined ? {} : { severities: csv(req.query.severity) }),
        ...(typeof req.query.domain === 'string' ? { domain: req.query.domain } : {}),
        ...(typeof req.query.stageId === 'string' ? { stageId: req.query.stageId } : {}),
        afterSequence: typeof req.query.afterSequence === 'string' ? Number(req.query.afterSequence) : 0,
        ...(typeof req.query.limit === 'string' ? { limit: Number(req.query.limit) } : {}),
      });
      res.json({ timeline });
    } catch (error) {
      if (error instanceof RuntimeInspectorError) {
        const status = error.code === 'RUN_NOT_FOUND' ? 404
          : error.code === 'CURSOR_EXPIRED' ? 410
            : error.code === 'INPUT_INVALID' ? 400 : 500;
        sendProblem(req, res, { status, code: error.code, detail: error.message });
        return;
      }
      sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
    }
  });

  return router;
}

