import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService, type TaskRunServiceDeps } from '../services/TaskRunService.js';
import { RunNotFoundError } from '../store/RunRepository.js';
import { buildV2RunDetailResponse, parseV2RunInclude } from './v2RunApi.js';
import { parseOptionalExpectedVersion, requireV2Workspace, respondV2, V2ValidationError } from './v2Tasks.js';
import { createOptionalIdempotencyService, parseIdempotencyKey } from './v2Idempotency.js';
import {
  formatVersionETag,
  isVersionConflictError,
  resolveVersionPrecondition,
  StorageVersionConflictError,
} from './versionPrecondition.js';

export function createV2RunRoutes(store: TaskRunServiceDeps, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const idempotencyService = createOptionalIdempotencyService(store);
  const service = new TaskRunService(store, {
    ...(idempotencyService ? { idempotencyService } : {}),
  });

  router.get('/runs/:runId', (req: Request, res: Response) => respondV2(req, res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { runId } = req.params as { runId: string };
    const run = store.runRepository().findById(workspaceId, runId);
    if (!run) throw new RunNotFoundError(runId);
    const query = req.query as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(query, 'include[]')) {
      throw new V2ValidationError('invalid include');
    }
    const include = parseV2RunInclude(query.include);
    const snapshot = store.runSnapshotRepository().findByRunId(workspaceId, runId);
    const stages = include.has('stages')
      ? store.runStageRepository().listByRun(workspaceId, runId)
      : [];
    res.setHeader('ETag', formatVersionETag(run.version));
    return { status: 200, body: buildV2RunDetailResponse({ run, snapshot, stages, include }) };
  }));

  router.post('/runs/:runId/cancel', (req: Request, res: Response) => respondV2(req, res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { runId } = req.params as { runId: string };
    const precondition = resolveVersionPrecondition(req, parseOptionalExpectedVersion((req.body ?? {}).expectedVersion));
    const normalizedKey = parseIdempotencyKey(req);
    try {
      const result = service.cancelQueuedRunForV2(workspaceId, runId, normalizedKey, precondition.expectedVersion);
      if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
      return { status: result.httpStatus, body: result.body };
    } catch (error) {
      if (precondition.fromHeader && isVersionConflictError(error)) {
        throw new StorageVersionConflictError('The run was changed by another request');
      }
      throw error;
    }
  }));

  return router;
}
