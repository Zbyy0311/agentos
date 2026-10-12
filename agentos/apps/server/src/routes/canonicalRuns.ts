import { Router, type Request, type Response } from 'express';
import type { V2RunReason } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService, type TaskRunServiceDeps } from '../services/TaskRunService.js';
import { RunNotFoundError } from '../store/RunRepository.js';
import { TaskNotFoundError } from '../store/TaskRepository.js';
import { buildV2RunDetailResponse, parseV2RunInclude } from './v2RunApi.js';
import { parseOptionalExpectedVersion, respondV2, V2ValidationError } from './v2Tasks.js';
import { createOptionalIdempotencyService, parseIdempotencyKey } from './v2Idempotency.js';
import {
  formatVersionETag,
  isVersionConflictError,
  resolveVersionPrecondition,
  StorageVersionConflictError,
} from './versionPrecondition.js';

/**
 * M3 P4B canonical top-level Run compatibility routes:
 *
 *   POST /api/tasks/:taskId/runs   (Create Run)
 *   GET  /api/runs/:runId          (Get Run, emits the P4A version ETag)
 *   POST /api/runs/:runId/cancel   (Cancel Run)
 *   POST /api/runs/:runId/pause    (Pause Run, logical marker)
 *   POST /api/runs/:runId/resume   (Resume Run, logical marker)
 *
 * These routes are pure delegating compatibility surfaces: every command
 * reuses the existing TaskRunService application behavior (including the
 * durable idempotency chain) and the P4A ApiProblem / ETag / If-Match
 * contract. No parallel lifecycle logic lives here. Legacy and current-v2
 * route families are preserved unchanged, and the P5 routes
 * (/events, /replay, /stream) are intentionally NOT implemented.
 *
 * Mounting: after the global strict JSON parser (same body-contract seam
 * as the v2 routers), before the API 404 fallback. The canonical paths do
 * not overlap the frozen Start/Retry or Operation paths.
 */

const CANONICAL_RUN_REASONS: readonly V2RunReason[] = [
  'initial',
  'retry',
  'resume-fallback',
  'review-fix',
  'provider-comparison',
  'manual',
];

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const PAUSE_REASONS = ['user', 'policy', 'approval', 'scheduler', 'maintenance'] as const;
const RESUME_MODES = ['native-session', 'process-restart', 'scheduler'] as const;

function parsePauseReason(value: unknown): 'user' | 'policy' | 'approval' | 'scheduler' | 'maintenance' | undefined {
  if (value === undefined) return undefined;
  if ((PAUSE_REASONS as readonly unknown[]).includes(value)) return value as 'user' | 'policy' | 'approval' | 'scheduler' | 'maintenance';
  throw new V2ValidationError(`invalid reason: ${String(value)}`);
}

function parseResumeMode(value: unknown): 'native-session' | 'process-restart' | 'scheduler' | undefined {
  if (value === undefined) return undefined;
  if ((RESUME_MODES as readonly unknown[]).includes(value)) return value as 'native-session' | 'process-restart' | 'scheduler';
  throw new V2ValidationError(`invalid resumeMode: ${String(value)}`);
}

function parseOptionalRequestedBy(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new V2ValidationError('requestedBy must be a non-empty string');
  }
  return value;
}

export function createCanonicalRunRoutes(store: TaskRunServiceDeps, workspaceManager: WorkspaceManager): Router {
  const router = Router();
  const idempotencyService = createOptionalIdempotencyService(store);
  const service = new TaskRunService(store, {
    ...(idempotencyService ? { idempotencyService } : {}),
  });

  /**
   * Canonical task locator: resolves the owning workspace of an opaque
   * taskId by scanning the registered workspaces with the existing
   * workspace-scoped read. The P4B freeze adds no repository surface, and
   * every later Task/Run/Idempotency access stays workspace-scoped.
   */
  const resolveTaskWorkspace = (taskId: string): string => {
    for (const workspace of workspaceManager.list()) {
      if (store.taskRepository().findById(workspace.id, taskId)) return workspace.id;
    }
    throw new TaskNotFoundError(taskId);
  };

  /** Canonical run locator: the P3C-1 opaque global read, reused as-is. */
  const resolveRunWorkspace = (runId: string): string => {
    const workspaceId = store.runRepository().findWorkspaceIdByOpaqueId(runId);
    if (workspaceId === undefined) throw new RunNotFoundError(runId);
    return workspaceId;
  };

  router.post('/tasks/:taskId/runs', (req: Request, res: Response) => respondV2(req, res, () => {
    const { taskId } = req.params as { taskId: string };
    const workspaceId = resolveTaskWorkspace(taskId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.reason !== undefined && !CANONICAL_RUN_REASONS.includes(body.reason as V2RunReason)) {
      throw new V2ValidationError(`invalid reason: ${String(body.reason)}`);
    }
    if (body.parentRunId !== undefined && typeof body.parentRunId !== 'string') {
      throw new V2ValidationError('parentRunId must be a string');
    }
    const normalizedKey = parseIdempotencyKey(req);
    const result = service.createRunForV2(workspaceId, {
      taskId,
      reason: body.reason as V2RunReason | undefined,
      parentRunId: body.parentRunId as string | undefined,
      objective: optionalString(body.objective),
      createdBy: optionalString(body.createdBy) ?? 'v2_api',
    }, normalizedKey);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return { status: result.httpStatus, body: result.body };
  }));

  router.get('/runs/:runId', (req: Request, res: Response) => respondV2(req, res, () => {
    const { runId } = req.params as { runId: string };
    const workspaceId = resolveRunWorkspace(runId);
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
    const { runId } = req.params as { runId: string };
    const workspaceId = resolveRunWorkspace(runId);
    const precondition = resolveVersionPrecondition(
      req,
      parseOptionalExpectedVersion(((req.body ?? {}) as Record<string, unknown>).expectedVersion),
    );
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
   * P4 Run-level Pause/Resume (canonical, no /v2 prefix). Mirrors the Cancel
   * shape exactly: opaque runId locator, If-Match/body version precondition,
   * durable idempotency, replay header, and 412-on-header-conflict mapping.
   * Pause only succeeds from running (already-paused is an idempotent 200);
   * resume only from paused (already-running is an idempotent 200); every
   * other state fails with 409. Both are record-level logical markers: no
   * provider process is suspended or restarted in this slice.
   */
  router.post('/runs/:runId/pause', (req: Request, res: Response) => respondV2(req, res, () => {
    const { runId } = req.params as { runId: string };
    const workspaceId = resolveRunWorkspace(runId);
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
    const { runId } = req.params as { runId: string };
    const workspaceId = resolveRunWorkspace(runId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const precondition = resolveVersionPrecondition(req, parseOptionalExpectedVersion(body.expectedVersion));
    const normalizedKey = parseIdempotencyKey(req);
    const resumeMode = parseResumeMode(body.resumeMode);
    const requestedBy = parseOptionalRequestedBy(body.requestedBy);
    try {
      const result = service.resumeRunForV2(
        workspaceId,
        runId,
        normalizedKey,
        precondition.expectedVersion,
        { ...(resumeMode === undefined ? {} : { resumeMode }), ...(requestedBy === undefined ? {} : { requestedBy }) },
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

  return router;
}
