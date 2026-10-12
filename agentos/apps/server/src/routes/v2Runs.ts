import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService, type TaskRunServiceDeps } from '../services/TaskRunService.js';
import { RunNotFoundError } from '../store/RunRepository.js';
import type { RunLifecycleDispatchOptions } from './runLifecycle.js';
import { buildV2RunDetailResponse, parseV2RunInclude } from './v2RunApi.js';
import { parseOptionalExpectedVersion, requireV2Workspace, respondV2, V2ValidationError } from './v2Tasks.js';
import { createOptionalIdempotencyService, parseIdempotencyKey } from './v2Idempotency.js';
import {
  formatVersionETag,
  isVersionConflictError,
  resolveVersionPrecondition,
  StorageVersionConflictError,
} from './versionPrecondition.js';

const PAUSE_REASONS = ['user', 'policy', 'approval', 'scheduler', 'maintenance'] as const;
const RESUME_MODES = ['native-session', 'process-restart', 'scheduler', 'child-run'] as const;

function parsePauseReason(value: unknown): 'user' | 'policy' | 'approval' | 'scheduler' | 'maintenance' | undefined {
  if (value === undefined) return undefined;
  if ((PAUSE_REASONS as readonly unknown[]).includes(value)) return value as 'user' | 'policy' | 'approval' | 'scheduler' | 'maintenance';
  throw new V2ValidationError(`invalid reason: ${String(value)}`);
}

function parseResumeMode(value: unknown): 'native-session' | 'process-restart' | 'scheduler' | 'child-run' | undefined {
  if (value === undefined) return undefined;
  if ((RESUME_MODES as readonly unknown[]).includes(value)) return value as 'native-session' | 'process-restart' | 'scheduler' | 'child-run';
  throw new V2ValidationError(`invalid resumeMode: ${String(value)}`);
}

function parseOptionalRequestedBy(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new V2ValidationError('requestedBy must be a non-empty string');
  }
  return value;
}

export interface V2RunRouteOptions {
  /** P4B resume re-drive seam; same contract as the canonical family. */
  readonly resumeDispatch?: RunLifecycleDispatchOptions;
}

export function createV2RunRoutes(
  store: TaskRunServiceDeps,
  workspaceManager: WorkspaceManager,
  options: V2RunRouteOptions = {},
): Router {
  const router = Router({ mergeParams: true });
  const idempotencyService = createOptionalIdempotencyService(store);
  const resumeDispatch = options.resumeDispatch;
  const service = new TaskRunService(store, {
    ...(idempotencyService ? { idempotencyService } : {}),
    resumeFallbackWorktreePreparationAvailable: resumeDispatch?.prepareResumeFallbackChild !== undefined,
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

  /**
   * P4 Run-level Pause/Resume (current-v2 family). Pause is a logical marker.
   * Default resume continues the same Run; explicit child-run creates and
   * dispatches a durable Child. An already-running Run is an idempotent 200,
   * while other invalid states return 409.
   */
  router.post('/runs/:runId/pause', (req: Request, res: Response) => respondV2(req, res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { runId } = req.params as { runId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const precondition = resolveVersionPrecondition(req, parseOptionalExpectedVersion(body.expectedVersion));
    const normalizedKey = parseIdempotencyKey(req);
    const reason = parsePauseReason(body.reason);
    const requestedBy = parseOptionalRequestedBy(body.requestedBy);
    try {
      const result = service.pauseRunForV2(
        workspaceId,
        runId,
        normalizedKey,
        precondition.expectedVersion,
        { ...(reason === undefined ? {} : { reason }), ...(requestedBy === undefined ? {} : { requestedBy }) },
      );
      if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
      return { status: result.httpStatus, body: result.body };
    } catch (error) {
      if (precondition.fromHeader && isVersionConflictError(error)) {
        throw new StorageVersionConflictError('The run was changed by another request');
      }
      throw error;
    }
  }));

  router.post('/runs/:runId/resume', (req: Request, res: Response) => respondV2(req, res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { runId } = req.params as { runId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const precondition = resolveVersionPrecondition(req, parseOptionalExpectedVersion(body.expectedVersion));
    const normalizedKey = parseIdempotencyKey(req);
    const resumeMode = parseResumeMode(body.resumeMode);
    const requestedBy = parseOptionalRequestedBy(body.requestedBy);
    try {
      const before = store.runRepository().findById(workspaceId, runId);
      const result = service.resumeRunForV2(
        workspaceId,
        runId,
        normalizedKey,
        precondition.expectedVersion,
        { ...(resumeMode === undefined ? {} : { resumeMode }), ...(requestedBy === undefined ? {} : { requestedBy }) },
      );
      if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
      // Only a genuine paused -> running command is re-driven. Logical resume
      // dispatches the same Run; explicit child-run dispatches its Child.
      // The idempotent already-running response and keyed replays never dispatch.
      if (
        resumeDispatch?.enabled === true
        && !result.replayed
        && before?.status === 'paused'
      ) {
        const driveRunId = result.body.run.id;
        void resumeDispatch.drive(workspaceId, driveRunId).catch(() => {
          // Containment backstop only; the drive contains its own failures.
        });
      }
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
