import { Router, type Request, type Response } from 'express';
import type { MemoryStatus, MemoryType } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryService } from '../services/MemoryService.js';
import { SqliteStore } from '../store/SqliteStore.js';

export function createMemoryRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const service = new MemoryService(store);

  router.get('/memories', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const status = typeof req.query.status === 'string' ? req.query.status as MemoryStatus | 'all' : 'active';
      const type = typeof req.query.type === 'string' ? req.query.type as MemoryType : undefined;
      res.json({ memories: service.list(workspace.id, { query: typeof req.query.query === 'string' ? req.query.query : undefined, type, status }) });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  router.post('/memories', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const memory = await service.create({ ...(req.body as Record<string, unknown>), workspaceId: workspace.id, workspaceRoot: workspace.rootPath, memoryEnabled: workspace.memoryEnabled } as never);
      res.status(201).json({ memory, content: memory.content });
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  router.get('/memories/:memoryId', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const memory = await service.get(workspace.id, workspace.rootPath, req.params.memoryId);
      if (!memory) return res.status(404).json({ error: 'Memory not found' });
      res.json({ memory, content: memory.content });
    } catch (error) { res.status(404).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  router.patch('/memories/:memoryId', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const memory = await service.update(workspace.id, workspace.rootPath, req.params.memoryId, req.body);
      res.json({ memory, content: memory.content });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'Memory not found' ? 404 : 400).json({ error: message });
    }
  });

  router.post('/memories/:memoryId/archive', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try { res.json({ memory: service.archive(workspace.id, req.params.memoryId) }); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); res.status(message === 'Memory not found' ? 404 : 400).json({ error: message }); }
  });
  return router;
}
