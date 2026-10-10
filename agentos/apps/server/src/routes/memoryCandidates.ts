import { Router, type Request, type Response } from 'express';
import type { MemoryCandidateStatus } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryCandidateService } from '../services/MemoryCandidateService.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { EventBus } from '../events/EventBus.js';
import { MemorySourceAccumulationService, MemorySourceAccumulationError } from '../services/MemorySourceAccumulationService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export function createMemoryCandidateRoutes(store: SqliteStore, workspaceManager: WorkspaceManager, eventBus?: EventBus): Router {
  const router = Router({ mergeParams: true });
  const service = new MemoryCandidateService(store, undefined, undefined, eventBus);
  const sourceAccumulator = new MemorySourceAccumulationService(store);

  router.get('/memory-candidates', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const status = typeof req.query.status === 'string' ? req.query.status as MemoryCandidateStatus | 'all' : 'pending';
      res.json({ candidates: service.list(workspace.id, status) });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/runs/:runId/memory-candidates/generate', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const result = await service.generate({
        workspaceId: workspace.id, workspaceRoot: workspace.rootPath, runId: req.params.runId,
        memoryEnabled: workspace.memoryEnabled, force: req.body?.force === true,
      });
      res.status(201).json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'Run not found' || message === 'Run source message not found'
        ? 404
        : message.includes('must be completed') || message === 'Workspace memory is disabled' ? 409 : 400;
      res.status(status).json({ error: message });
    }
  }));

  // P1 source-ownership path for old agent_runs. The existing generate route
  // remains available to compatibility clients; the workspace UI uses this
  // route so new evidence enters the canonical Candidate/review queue.
  router.post('/runs/:runId/memory-candidates/accumulate', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    if (!workspace.memoryEnabled) return res.status(409).json({ error: 'WORKSPACE_MEMORY_DISABLED' });
    try {
      const result = sourceAccumulator.generateForLegacyRun({
        workspaceId: workspace.id,
        runId: req.params.runId,
        createdAt: new Date().toISOString(),
      });
      res.status(result.outcome === 'created' ? 201 : 200).json(result);
    } catch (error) {
      if (error instanceof MemorySourceAccumulationError) {
        const status = error.code === 'SOURCE_NOT_FOUND' ? 404
          : error.code === 'SOURCE_NOT_TERMINAL' ? 409
            : error.code === 'INPUT_INVALID' ? 400 : 422;
        res.status(status).json({ error: error.code });
        return;
      }
      res.status(500).json({ error: 'MEMORY_SOURCE_ACCUMULATION_FAILED' });
    }
  });

  router.post('/memory-candidates/:candidateId/accept', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      const candidate = await service.accept(workspace.id, workspace.rootPath, workspace.memoryEnabled, req.params.candidateId, {
        title: typeof req.body?.title === 'string' ? req.body.title : undefined,
        summary: typeof req.body?.summary === 'string' ? req.body.summary : undefined,
        content: typeof req.body?.content === 'string' ? req.body.content : undefined,
      });
      res.json({ candidate });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'Memory candidate not found' ? 404 : message.includes('already been reviewed') ? 409 : 400;
      res.status(status).json({ error: message });
    }
  }));

  router.post('/memory-candidates/:candidateId/reject', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    try {
      res.json({ candidate: service.reject(workspace.id, req.params.candidateId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'Memory candidate not found' ? 404 : message.includes('already been reviewed') ? 409 : 400;
      res.status(status).json({ error: message });
    }
  });
  return router;
}
