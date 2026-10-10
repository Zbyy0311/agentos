import { Router, type Request, type Response } from 'express';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { ArtifactCompletionRepository, ArtifactCompletionRepositoryError } from '../store/ArtifactCompletionRepository.js';
import { ArtifactCompletionService } from '../services/ArtifactCompletionService.js';

// Reuses the draft prefix. Production automatic finalizers do not call this API.
export function createArtifactCompletionRoutes(store: SqliteStore, workspaces: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const records = new ArtifactCompletionRepository(store.getDatabase());
  const service = new ArtifactCompletionService(store);
  router.use((req, res, next) => {
    if (!workspaces.get(req.params.workspaceId)) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'WORKSPACE_NOT_FOUND' });
      return;
    }
    next();
  });
  router.get('/artifact-completions', (req: Request, res: Response) => {
    res.json({ completions: records.list(req.params.workspaceId) });
  });
  router.get('/artifact-completions/:completionId', (req: Request, res: Response) => {
    const completion = records.findById(req.params.workspaceId, req.params.completionId);
    if (!completion) {
      sendProblem(req, res, { status: 404, code: 'ARTIFACT_COMPLETION_NOT_FOUND', detail: 'ARTIFACT_COMPLETION_NOT_FOUND' });
      return;
    }
    res.json({ completion });
  });
  router.post('/artifact-completions', (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body.artifactId !== 'string') {
      sendProblem(req, res, { status: 400, code: 'ARTIFACT_COMPLETION_INPUT_INVALID', detail: 'ARTIFACT_COMPLETION_INPUT_INVALID' });
      return;
    }
    try {
      const previous = records.findByArtifact(req.params.workspaceId, body.artifactId);
      const result = service.complete({ workspaceId: req.params.workspaceId, artifactId: body.artifactId,
        conclusion: body.conclusion, artifactType: body.artifactType, runId: body.runId,
        sourceKey: previous?.sourceKey ?? 'artifact:' + body.artifactId, decidedAt: new Date().toISOString() });
      res.status(result.converged ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof ArtifactCompletionRepositoryError) {
        sendProblem(req, res, {
          status: error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400,
          code: error.code,
          detail: error.message,
        });
      } else {
        sendProblem(req, res, { status: 500, code: 'ARTIFACT_COMPLETION_PERSISTENCE_FAILED', detail: 'Artifact completion persistence failed' });
      }
    }
  });
  return router;
}
