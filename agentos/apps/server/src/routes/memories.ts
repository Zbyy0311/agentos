import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { MemoryStatus, MemoryType } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { MemoryService } from '../services/MemoryService.js';
import { SqliteStore } from '../store/SqliteStore.js';

export function createMemoryRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const service = new MemoryService(store);

  router.get('/memories', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    try {
      const status = typeof req.query.status === 'string' ? req.query.status as MemoryStatus | 'all' : 'active';
      const type = typeof req.query.type === 'string' ? req.query.type as MemoryType : undefined;
      res.json({ memories: service.list(workspace.id, { query: typeof req.query.query === 'string' ? req.query.query : undefined, type, status }) });
    } catch (error) {
      sendProblem(req, res, { status: 400, code: 'MEMORY_LIST_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/memories', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    try {
      const memory = await service.create({ ...(req.body as Record<string, unknown>), workspaceId: workspace.id, workspaceRoot: workspace.rootPath, memoryEnabled: workspace.memoryEnabled } as never);
      res.status(201).json({ memory, content: memory.content });
    } catch (error) {
      sendProblem(req, res, { status: 400, code: 'MEMORY_CREATE_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  }));

  router.get('/memories/:memoryId', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    try {
      const memory = await service.get(workspace.id, workspace.rootPath, req.params.memoryId);
      if (!memory) {
        sendProblem(req, res, { status: 404, code: 'MEMORY_NOT_FOUND', detail: 'Memory not found' });
        return;
      }
      res.json({ memory, content: memory.content });
    } catch (error) {
      sendProblem(req, res, { status: 404, code: 'MEMORY_NOT_FOUND', detail: error instanceof Error ? error.message : String(error) });
    }
  }));

  router.patch('/memories/:memoryId', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    try {
      const memory = await service.update(workspace.id, workspace.rootPath, req.params.memoryId, req.body);
      res.json({ memory, content: memory.content });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'Memory not found' ? 404 : 400;
      sendProblem(req, res, { status, code: status === 404 ? 'MEMORY_NOT_FOUND' : 'MEMORY_UPDATE_FAILED', detail: message });
    }
  }));

  router.post('/memories/:memoryId/archive', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    try {
      res.json({ memory: service.archive(workspace.id, req.params.memoryId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'Memory not found' ? 404 : 400;
      sendProblem(req, res, { status, code: status === 404 ? 'MEMORY_NOT_FOUND' : 'MEMORY_ARCHIVE_FAILED', detail: message });
    }
  });
  return router;
}
