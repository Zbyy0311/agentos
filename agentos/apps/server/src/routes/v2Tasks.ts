import { Router, type Request, type Response } from 'express';
import type { V2RunReason, V2TaskPriority, V2TaskStatus } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { TaskRunService, type TaskRunServiceDeps } from '../services/TaskRunService.js';
import { TaskNotFoundError } from '../store/TaskRepository.js';
import { createOptionalIdempotencyService, parseIdempotencyKey } from './v2Idempotency.js';

const V2_TASK_PRIORITIES: readonly V2TaskPriority[] = ['low', 'normal', 'high', 'critical'];
const V2_RUN_REASONS: readonly V2RunReason[] = ['initial', 'retry', 'resume-fallback', 'review-fix', 'provider-comparison', 'manual'];
const V2_TASK_STATUSES: readonly V2TaskStatus[] = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];

const V2_ERROR_STATUS: Record<string, number> = {
  WORKSPACE_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  PARENT_RUN_NOT_FOUND: 404,
  TASK_TITLE_REQUIRED: 400,
  VALIDATION_FAILED: 400,
  TASK_ARCHIVED: 409,
  TASK_CANCELLED: 409,
  TASK_HAS_ACTIVE_RUN: 409,
  RUN_ACTIVE_EXISTS: 409,
  RUN_NOT_COMPLETED: 409,
  TASK_NO_ACCEPTANCE_WINDOW: 409,
  TASK_BLOCKED: 409,
  TASK_DONE: 409,
  RUN_NOT_CANCELLABLE: 409,
  INVALID_TASK_TRANSITION: 409,
  INVALID_RUN_TRANSITION: 409,
  VERSION_CONFLICT: 409,
  AGENT_NOT_AVAILABLE: 409,
  PROVIDER_CONFIG_NOT_AVAILABLE: 409,
  WORKFLOW_NOT_AVAILABLE: 409,
  RUN_SNAPSHOT_FAILED: 500,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_RECORD_INVALID: 500,
};

const V2_SAFE_ERROR_MESSAGE: Record<string, string> = {
  AGENT_NOT_AVAILABLE: 'Agent is not available',
  PROVIDER_CONFIG_NOT_AVAILABLE: 'Provider configuration is not available',
  WORKFLOW_NOT_AVAILABLE: 'Workflow is not available',
  RUN_SNAPSHOT_FAILED: 'Run snapshot creation failed',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key was already used with a different request',
  IDEMPOTENCY_RECORD_INVALID: 'Idempotency record is invalid',
  VERSION_CONFLICT: 'Version conflict',
};

export class WorkspaceNotFoundError extends Error {
  readonly code = 'WORKSPACE_NOT_FOUND' as const;
  constructor(workspaceId: string) {
    super('Workspace not found');
    this.name = 'WorkspaceNotFoundError';
  }
}

export class V2ValidationError extends Error {
  readonly code: string;
  constructor(message: string, code = 'VALIDATION_FAILED') {
    super(message);
    this.name = 'V2ValidationError';
    this.code = code;
  }
}

export function requireV2Workspace(req: Request, workspaceManager: WorkspaceManager): string {
  const { workspaceId } = req.params as { workspaceId: string };
  if (!workspaceManager.get(workspaceId)) throw new WorkspaceNotFoundError(workspaceId);
  return workspaceId;
}

/** Uniform v2 error contract: { error, code }; unknown failures are sanitized to INTERNAL_ERROR. */
export function respondV2(res: Response, fn: () => { status: number; body: unknown }): void {
  try {
    const { status, body } = fn();
    res.status(status).json(body);
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code in V2_ERROR_STATUS) {
      res.status(V2_ERROR_STATUS[code]).json({ error: V2_SAFE_ERROR_MESSAGE[code] ?? (err as Error).message, code });
      return;
    }
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * M2.6 P4 optional optimistic-concurrency body field. Absent stays
 * `undefined`; anything present must be a positive safe integer. The error
 * message never echoes the supplied value.
 */
export function parseOptionalExpectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new V2ValidationError('expectedVersion must be a positive safe integer');
  }
  return value;
}

export function createV2TaskRoutes(store: TaskRunServiceDeps, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const idempotencyService = createOptionalIdempotencyService(store);
  const service = new TaskRunService(store, {
    ...(idempotencyService ? { idempotencyService } : {}),
  });

  router.get('/tasks', (req: Request, res: Response) => respondV2(res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const status = optionalString(req.query.status);
    if (status && !V2_TASK_STATUSES.includes(status as V2TaskStatus)) {
      throw new V2ValidationError(`invalid status: ${status}`);
    }
    const includeArchived = req.query.includeArchived === 'true';
    const tasks = store.taskRepository().listByWorkspace(workspaceId, { status: status as V2TaskStatus | undefined, includeArchived });
    return { status: 200, body: { tasks } };
  }));

  router.post('/tasks', (req: Request, res: Response) => respondV2(res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const body = req.body ?? {};
    const title = optionalString(body.title);
    if (!title) throw new V2ValidationError('title is required', 'TASK_TITLE_REQUIRED');
    if (body.priority !== undefined && !V2_TASK_PRIORITIES.includes(body.priority)) {
      throw new V2ValidationError(`invalid priority: ${String(body.priority)}`);
    }
    const normalizedKey = parseIdempotencyKey(req);
    const result = service.createTaskForV2(workspaceId, {
      title,
      description: optionalString(body.description),
      priority: body.priority as V2TaskPriority | undefined,
      sourceConversationId: optionalString(body.sourceConversationId),
      sourceMessageId: optionalString(body.sourceMessageId),
      createdBy: optionalString(body.createdBy) ?? 'v2_api',
    }, normalizedKey);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return { status: result.httpStatus, body: result.body };
  }));

  router.get('/tasks/:taskId', (req: Request, res: Response) => respondV2(res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { taskId } = req.params as { taskId: string };
    const task = store.taskRepository().findById(workspaceId, taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    return { status: 200, body: { task } };
  }));

  router.post('/tasks/:taskId/runs', (req: Request, res: Response) => respondV2(res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { taskId } = req.params as { taskId: string };
    const body = req.body ?? {};
    if (body.reason !== undefined && !V2_RUN_REASONS.includes(body.reason)) {
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

  router.get('/tasks/:taskId/runs', (req: Request, res: Response) => respondV2(res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { taskId } = req.params as { taskId: string };
    if (!store.taskRepository().findById(workspaceId, taskId)) throw new TaskNotFoundError(taskId);
    const runs = store.runRepository().listByTask(workspaceId, taskId);
    return { status: 200, body: { runs } };
  }));

  router.post('/tasks/:taskId/accept', (req: Request, res: Response) => respondV2(res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { taskId } = req.params as { taskId: string };
    const body = req.body ?? {};
    const runId = optionalString(body.runId);
    if (!runId) throw new V2ValidationError('runId is required');
    const expectedVersion = parseOptionalExpectedVersion(body.expectedVersion);
    const normalizedKey = parseIdempotencyKey(req);
    const result = service.acceptRunForV2(workspaceId, taskId, runId, normalizedKey, expectedVersion);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return { status: result.httpStatus, body: result.body };
  }));

  router.post('/tasks/:taskId/cancel', (req: Request, res: Response) => respondV2(res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { taskId } = req.params as { taskId: string };
    const expectedVersion = parseOptionalExpectedVersion((req.body ?? {}).expectedVersion);
    const normalizedKey = parseIdempotencyKey(req);
    const result = service.cancelTaskForV2(workspaceId, taskId, normalizedKey, expectedVersion);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return { status: result.httpStatus, body: result.body };
  }));

  router.post('/tasks/:taskId/reopen', (req: Request, res: Response) => respondV2(res, () => {
    const workspaceId = requireV2Workspace(req, workspaceManager);
    const { taskId } = req.params as { taskId: string };
    const expectedVersion = parseOptionalExpectedVersion((req.body ?? {}).expectedVersion);
    const normalizedKey = parseIdempotencyKey(req);
    const result = service.reopenTaskForV2(workspaceId, taskId, normalizedKey, expectedVersion);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return { status: result.httpStatus, body: result.body };
  }));

  return router;
}
