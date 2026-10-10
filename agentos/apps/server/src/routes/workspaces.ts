import { Router } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export function createWorkspaceRoutes(manager: WorkspaceManager): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ workspaces: manager.list() });
  });

  router.get('/recent', (_req, res) => {
    res.json({ workspaces: manager.recent() });
  });

  router.get('/:id', (req, res) => {
    const workspace = manager.get(req.params.id);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    res.json({ workspace });
  });

  router.post('/', asyncHandler(async (req, res) => {
    const { name, rootPath, git, memory, readme, docs } = req.body;
    if (!name || typeof name !== 'string') {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'name is required' });
      return;
    }
    if (!rootPath || typeof rootPath !== 'string') {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'rootPath is required' });
      return;
    }
    try {
      const workspace = await manager.create(name, rootPath, { git, memory, readme, docs });
      res.status(201).json({ workspace });
    } catch (err) {
      sendProblem(req, res, { status: 400, code: 'WORKSPACE_CREATE_FAILED', detail: err instanceof Error ? err.message : String(err) });
    }
  }));

  router.post('/import', asyncHandler(async (req, res) => {
    const { rootPath } = req.body;
    if (!rootPath || typeof rootPath !== 'string') {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'rootPath is required' });
      return;
    }
    try {
      const workspace = await manager.importExisting(rootPath);
      res.status(201).json({ workspace });
    } catch (err) {
      sendProblem(req, res, { status: 400, code: 'WORKSPACE_IMPORT_FAILED', detail: err instanceof Error ? err.message : String(err) });
    }
  }));

  router.delete('/:id', (req, res) => {
    manager.remove(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
