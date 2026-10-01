import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import {
  CollaborationWorkflowError,
  type CollaborationMutationInput,
  type CollaborationWorkflowService,
  type CreateCollaborationPlanInput,
} from '../services/CollaborationWorkflowService.js';
import { parseIdempotencyKey } from './v2Idempotency.js';
import { formatVersionETag, resolveVersionPrecondition } from './versionPrecondition.js';
import { parseOptionalExpectedVersion, V2ValidationError } from './v2Tasks.js';
import { sendProblem } from '../problemDetails.js';
import { CollaborationRepositoryError } from '../store/CollaborationRepository.js';

const ERROR_STATUS: Record<string, number> = {
  WORKSPACE_NOT_FOUND: 404,
  COLLABORATION_NOT_FOUND: 404,
  COLLABORATION_CANDIDATE_NOT_FOUND: 404,
  COLLABORATION_INVALID: 400,
  COLLABORATION_ASSOCIATION_INVALID: 409,
  COLLABORATION_PERMISSION_INVALID: 409,
  COLLABORATION_AGENT_UNAVAILABLE: 409,
  COLLABORATION_REQUIRES_GIT: 409,
  COLLABORATION_CONFIRM_CONFLICT: 409,
  COLLABORATION_APPLY_NOT_READY: 409,
  COLLABORATION_BASE_CHANGED: 409,
  COLLABORATION_WORKTREE_MISSING: 409,
  COLLABORATION_CANDIDATE_CHANGED: 409,
  COLLABORATION_PATH_INVALID: 409,
  COLLABORATION_DIFF_TOO_LARGE: 413,
  COLLABORATION_RUN_CREATE_FAILED: 409,
  COLLABORATION_TEMPLATE_UNAVAILABLE: 500,
  COLLABORATION_STAGE_MISSING: 500,
  COLLABORATION_CONFLICT: 409,
  COLLABORATION_STATE: 409,
  COLLABORATION_IDEMPOTENCY_REQUIRED: 400,
  COLLABORATION_SCOPE_INVALID: 400,
  COLLABORATION_SCOPE_OUTSIDE_APPROVED: 409,
  COLLABORATION_PATH_BOUNDARY_INVALID: 409,
  COLLABORATION_PATH_BOUNDARY: 409,
  COLLABORATION_WRITER_CONFLICT: 409,
  COLLABORATION_ADMISSION_UNAVAILABLE: 409,
  COLLABORATION_RECOVERY_REQUIRED: 409,
  COLLABORATION_INTERRUPTED: 409,
  COLLABORATION_RECOVERY_PATH_INVALID: 409,
  COLLABORATION_CANDIDATE_INVALID: 409,
  COLLABORATION_CANDIDATE_EMPTY: 409,
  COLLABORATION_APPLY_VERIFY_FAILED: 409,
  COLLABORATION_REVIEW_INVALID: 409,
  COLLABORATION_GIT_ATTRIBUTE_UNSUPPORTED: 409,
  COLLABORATION_SNAPSHOT_SOURCE_CHANGED: 409,
  COLLABORATION_GIT_CLEAN_MISMATCH: 409,
  COLLABORATION_CONTROL_FAILED: 409,
  VERSION_CONFLICT: 409,
  VALIDATION_FAILED: 400,
  workspace_dirty: 409,
  not_git: 409,
  bare_repository: 409,
  root_inside_workspace: 409,
  root_not_absolute: 400,
  branch_exists: 409,
  target_exists: 409,
};

function workspaceIdOf(req: Request, workspaces: WorkspaceManager): string {
  const workspaceId = req.params.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaces.get(workspaceId)) {
    const error = new CollaborationWorkflowError('WORKSPACE_NOT_FOUND', 'Workspace not found');
    throw error;
  }
  return workspaceId;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) throw new V2ValidationError('Expected a non-negative integer');
  return parsed as number;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new V2ValidationError('Expected an array of strings');
  return value.map(item => {
    if (typeof item !== 'string') throw new V2ValidationError('Expected an array of strings');
    return item;
  });
}

function requiredVersion(req: Request): number {
  const body = req.body ?? {};
  const precondition = resolveVersionPrecondition(req, parseOptionalExpectedVersion(body.expectedVersion));
  if (precondition.expectedVersion === undefined) {
    throw new V2ValidationError('expectedVersion is required');
  }
  return precondition.expectedVersion;
}

function errorCode(error: unknown): string {
  if (error instanceof CollaborationRepositoryError) return `COLLABORATION_${error.code}`;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  if (error instanceof Error && error.name === 'IdempotencyKeyValidationError') return 'VALIDATION_FAILED';
  if (error instanceof Error) {
    const prefix = /^(COLLABORATION_[A-Z_]+):/u.exec(error.message)?.[1];
    if (prefix && Object.hasOwn(ERROR_STATUS, prefix)) return prefix;
  }
  return 'INTERNAL_ERROR';
}

async function respondCollaboration(
  req: Request,
  res: Response,
  fn: () => Promise<{ status: number; body: unknown }> | { status: number; body: unknown },
): Promise<void> {
  try {
    const result = await fn();
    res.status(result.status).json(result.body);
  } catch (error) {
    const code = errorCode(error);
    const status = ERROR_STATUS[code] ?? 500;
    sendProblem(req, res, {
      status,
      code,
      detail: status >= 500 ? 'Internal server error' : error instanceof Error ? error.message : 'Request failed',
    });
  }
}

function mutationInput(req: Request, workspaces: WorkspaceManager, collaborationId: string): CollaborationMutationInput {
  const idempotencyKey = parseIdempotencyKey(req);
  if (idempotencyKey === undefined) throw new CollaborationWorkflowError('COLLABORATION_IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
  return {
    workspaceId: workspaceIdOf(req, workspaces),
    collaborationId,
    expectedVersion: requiredVersion(req),
    idempotencyKey,
  };
}

export function createCollaborationRoutes(
  service: CollaborationWorkflowService,
  workspaceManager: WorkspaceManager,
): Router {
  const router = Router({ mergeParams: true });

  router.get('/collaboration/tasks', (req, res) => respondCollaboration(req, res, () => {
    const workspaceId = workspaceIdOf(req, workspaceManager);
    const conversationId = optionalString(req.query.conversationId);
    const offset = optionalNonNegativeInteger(req.query.offset) ?? 0;
    const limit = optionalNonNegativeInteger(req.query.limit) ?? 50;
    return { status: 200, body: { tasks: service.list(workspaceId, { ...(conversationId === undefined ? {} : { conversationId }), limit, offset }), offset, limit } };
  }));

  router.post('/collaboration/tasks', (req, res) => respondCollaboration(req, res, async () => {
    const workspaceId = workspaceIdOf(req, workspaceManager);
    const body = req.body ?? {};
    const title = optionalString(body.title);
    const objective = optionalString(body.objective);
    const plannerAgentId = optionalString(body.plannerAgentId);
    const implementerAgentId = optionalString(body.implementerAgentId);
    const reviewerAgentId = optionalString(body.reviewerAgentId);
    if (!title || !objective || !plannerAgentId || !implementerAgentId || !reviewerAgentId) {
      throw new V2ValidationError('title, objective and all three Agent bindings are required');
    }
    const input: CreateCollaborationPlanInput = {
      workspaceId,
      ...(optionalString(body.conversationId) === undefined ? {} : { conversationId: optionalString(body.conversationId) }),
      ...(optionalString(body.sourceMessageId) === undefined ? {} : { sourceMessageId: optionalString(body.sourceMessageId) }),
      title,
      objective,
      scope: stringArray(body.scope),
      acceptanceCommands: stringArray(body.acceptanceCommands),
      plannerAgentId,
      implementerAgentId,
      reviewerAgentId,
      ...(typeof body.maxReworkRounds === 'number' ? { maxReworkRounds: body.maxReworkRounds } : {}),
    };
    const task = await service.createPlan(input);
    return { status: 201, body: { task } };
  }));

  router.get('/collaboration/tasks/:collaborationId', (req, res) => respondCollaboration(req, res, () => {
    const workspaceId = workspaceIdOf(req, workspaceManager);
    const details = service.getDetails(workspaceId, req.params.collaborationId);
    res.setHeader('ETag', formatVersionETag(details.task.version));
    return { status: 200, body: details };
  }));

  router.get('/collaboration/tasks/:collaborationId/progress', (req, res) => respondCollaboration(req, res, () => {
    const workspaceId = workspaceIdOf(req, workspaceManager);
    const progress = service.getProgress(workspaceId, req.params.collaborationId);
    res.setHeader('ETag', formatVersionETag(progress.task.version));
    return { status: 200, body: { progress } };
  }));

  router.post('/collaboration/tasks/:collaborationId/confirm', (req, res) => respondCollaboration(req, res, async () => {
    const task = await service.confirm(mutationInput(req, workspaceManager, req.params.collaborationId));
    res.setHeader('ETag', formatVersionETag(task.version));
    return { status: 202, body: { task } };
  }));

  router.post('/collaboration/tasks/:collaborationId/cancel', (req, res) => respondCollaboration(req, res, async () => {
    const task = await service.cancel(mutationInput(req, workspaceManager, req.params.collaborationId));
    res.setHeader('ETag', formatVersionETag(task.version));
    return { status: task.pendingControl ? 202 : 200, body: { task } };
  }));

  router.post('/collaboration/tasks/:collaborationId/apply', (req, res) => respondCollaboration(req, res, async () => {
    const task = await service.apply(mutationInput(req, workspaceManager, req.params.collaborationId));
    res.setHeader('ETag', formatVersionETag(task.version));
    return { status: task.pendingControl ? 202 : 200, body: { task } };
  }));

  return router;
}
