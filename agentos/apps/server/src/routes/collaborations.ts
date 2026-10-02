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
import { MAX_COLLABORATION_PREVIEW_PAGE_SIZE } from '../services/CollaborationCandidatePreview.js';

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

function candidatePreviewIdentity(req: Request): { readonly candidateBaseCommit: string; readonly candidateContentHash: string } {
  const candidateBaseCommit = req.query.candidateBaseCommit;
  const candidateContentHash = req.query.candidateContentHash;
  if (typeof candidateBaseCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(candidateBaseCommit)
    || typeof candidateContentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(candidateContentHash)) {
    throw new V2ValidationError('Preview requests require the exact candidateBaseCommit and candidateContentHash');
  }
  return { candidateBaseCommit, candidateContentHash };
}

function previewPageNumber(value: unknown, name: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) throw new V2ValidationError(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new V2ValidationError(`${name} is outside the preview bounds`);
  return parsed;
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

function mutationInput(
  req: Request,
  workspaces: WorkspaceManager,
  collaborationId: string,
  action: 'confirm' | 'cancel' | 'apply',
): CollaborationMutationInput {
  const idempotencyKey = parseIdempotencyKey(req);
  if (idempotencyKey === undefined) throw new CollaborationWorkflowError('COLLABORATION_IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
  const input: CollaborationMutationInput = {
    workspaceId: workspaceIdOf(req, workspaces),
    collaborationId,
    expectedVersion: requiredVersion(req),
    idempotencyKey,
  };
  if (action !== 'apply') return input;
  const body = req.body ?? {};
  const hasCandidateId = body.candidateId !== undefined;
  const hasCandidateBaseCommit = body.candidateBaseCommit !== undefined;
  const hasCandidateContentHash = body.candidateContentHash !== undefined;
  if (!hasCandidateId || !hasCandidateBaseCommit || !hasCandidateContentHash) {
    throw new V2ValidationError('Applying a candidate requires candidateId, candidateBaseCommit, and candidateContentHash from its frozen preview');
  }
  if (typeof body.candidateId !== 'string' || body.candidateId.length === 0 || body.candidateId !== body.candidateId.trim()
    || body.candidateId.length > 200 || typeof body.candidateBaseCommit !== 'string'
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(body.candidateBaseCommit)
    || typeof body.candidateContentHash !== 'string' || !/^[a-f0-9]{64}$/u.test(body.candidateContentHash)) {
    throw new V2ValidationError('candidateId, candidateBaseCommit, and candidateContentHash must identify the frozen candidate preview');
  }
  return { ...input, candidateId: body.candidateId, candidateBaseCommit: body.candidateBaseCommit, candidateContentHash: body.candidateContentHash };
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

  router.get('/collaboration/tasks/:collaborationId/candidates/:candidateId/preview', (req, res) => respondCollaboration(req, res, () => {
    res.setHeader('Cache-Control', 'no-store');
    const workspaceId = workspaceIdOf(req, workspaceManager);
    const { candidateBaseCommit, candidateContentHash } = candidatePreviewIdentity(req);
    const offset = previewPageNumber(req.query.offset, 'offset', 0, 499);
    const limit = previewPageNumber(req.query.limit, 'limit', MAX_COLLABORATION_PREVIEW_PAGE_SIZE, MAX_COLLABORATION_PREVIEW_PAGE_SIZE);
    if (limit === 0) throw new V2ValidationError('limit must be a positive integer');
    return { status: 200, body: service.getCandidatePreview(workspaceId, req.params.collaborationId, req.params.candidateId,
      candidateBaseCommit, candidateContentHash, { offset, limit }) };
  }));

  router.get('/collaboration/tasks/:collaborationId/candidates/:candidateId/preview/files/:fileIndex', (req, res) => respondCollaboration(req, res, () => {
    res.setHeader('Cache-Control', 'no-store');
    const workspaceId = workspaceIdOf(req, workspaceManager);
    const { candidateBaseCommit, candidateContentHash } = candidatePreviewIdentity(req);
    const fileIndex = previewPageNumber(req.params.fileIndex, 'fileIndex', -1, 499);
    if (fileIndex < 0) throw new V2ValidationError('fileIndex must be a non-negative integer');
    return { status: 200, body: service.getCandidatePreviewFileDiff(workspaceId, req.params.collaborationId, req.params.candidateId,
      candidateBaseCommit, candidateContentHash, fileIndex) };
  }));

  router.post('/collaboration/tasks/:collaborationId/confirm', (req, res) => respondCollaboration(req, res, async () => {
    const task = await service.confirm(mutationInput(req, workspaceManager, req.params.collaborationId, 'confirm'));
    res.setHeader('ETag', formatVersionETag(task.version));
    return { status: 202, body: { task } };
  }));

  router.post('/collaboration/tasks/:collaborationId/cancel', (req, res) => respondCollaboration(req, res, async () => {
    const task = await service.cancel(mutationInput(req, workspaceManager, req.params.collaborationId, 'cancel'));
    res.setHeader('ETag', formatVersionETag(task.version));
    return { status: task.pendingControl ? 202 : 200, body: { task } };
  }));

  router.post('/collaboration/tasks/:collaborationId/apply', (req, res) => respondCollaboration(req, res, async () => {
    const task = await service.apply(mutationInput(req, workspaceManager, req.params.collaborationId, 'apply'));
    res.setHeader('ETag', formatVersionETag(task.version));
    return { status: task.pendingControl ? 202 : 200, body: { task } };
  }));

  return router;
}
