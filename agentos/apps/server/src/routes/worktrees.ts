import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { WorktreeMergeError, WorktreeMergeService } from '../services/WorktreeMergeService.js';
import type { WorktreeMergeStrategy } from '../store/WorktreeMergeRepository.js';
import { WorktreeError, WorktreeManager } from '../services/WorktreeManager.js';
import { WorktreeArtifactService } from '../services/WorktreeArtifactService.js';
import { WorktreeControlError, WorktreeControlService } from '../services/WorktreeControlService.js';
import type { RuntimeArtifactService } from '../services/RuntimeArtifactService.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { asyncHandler } from '../utils/asyncHandler.js';

type RunLookup = { getRun(workspaceId: string, runId: string): { status: string } | undefined };

const MERGE_ERROR_STATUS: Record<string, number> = {
  WORKTREE_NOT_FOUND: 404,
  WORKTREE_MERGE_INVALID_REQUEST: 400,
  WORKTREE_MERGE_INVALID_STATUS: 409,
  WORKTREE_MERGE_TARGET_BRANCH_NOT_FOUND: 409,
  WORKTREE_SOURCE_BRANCH_NOT_FOUND: 409,
  WORKTREE_MERGE_HEAD_MISMATCH: 409,
  WORKTREE_MERGE_CONFLICTED: 409,
  WORKTREE_MERGE_FAILED: 500,
  WORKTREE_MERGE_DIRTY: 409,
  WORKTREE_MERGE_IDENTITY_MISMATCH: 409,
  WORKTREE_BRANCH_LOCK_HELD: 409,
  WORKTREE_BRANCH_LOCK_INVALID_REF: 400,
  WORKTREE_REF_RECOVERY_REQUIRED: 409,
};
function errorStatus(error: unknown): number {
  if (error instanceof WorktreeError) {
    if (error.code === 'not_found') return 404;
    if (['state_conflict', 'already_managed', 'branch_managed'].includes(error.code)) return 409;
  }
  return 400;
}

export function createWorktreeRoutes(
  workspaceManager: WorkspaceManager,
  manager: WorktreeManager,
  artifactService?: RuntimeArtifactService,
  runLookup?: RunLookup,
  workspaceRootFor: (workspaceId: string) => string | undefined = workspaceId => workspaceManager.get(workspaceId)?.rootPath,
  mergeService?: WorktreeMergeService,
  eventRepository?: RuntimeEventRepository,
  controlServiceOverride?: WorktreeControlService,
): Router {
  const router = Router({ mergeParams: true });
  const controlService = controlServiceOverride ?? new WorktreeControlService(manager, runLookup, artifactService);
  if (mergeService) {
    router.post('/worktrees/:worktreeId/merge', asyncHandler(async (req: Request, res: Response) => {
      const workspace = workspaceManager.get(req.params.workspaceId);
      if (!workspace) {
        sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
        return;
      }
      const lease = manager.getRecord(req.params.worktreeId);
      if (!lease || lease.workspaceId !== workspace.id) {
        sendProblem(req, res, { status: 404, code: 'WORKTREE_NOT_FOUND', detail: 'Worktree not found' });
        return;
      }
      try {
        const record = await mergeService.merge(req.params.worktreeId, {
          strategy: String(req.body?.strategy ?? '') as WorktreeMergeStrategy,
          targetBranch: String(req.body?.targetBranch ?? ''),
          expectedHeadCommit: String(req.body?.expectedHeadCommit ?? ''),
          requestedBy: typeof req.body?.requestedBy === 'string' && req.body.requestedBy ? req.body.requestedBy : 'api',
        });
        return res.status(200).json({ merge: record });
      } catch (error) {
        if (error instanceof WorktreeMergeError) {
          sendProblem(req, res, {
            status: MERGE_ERROR_STATUS[error.code] ?? 500,
            code: error.code,
            detail: (MERGE_ERROR_STATUS[error.code] ?? 500) >= 500 ? 'Worktree merge failed' : error.message,
            context: { worktreeId: req.params.worktreeId },
          });
          return;
        }
        sendProblem(req, res, { status: 500, code: 'WORKTREE_MERGE_FAILED', detail: 'Worktree merge failed' });
      }
    }));
  }
  router.get('/worktrees', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    return res.json({ leases: manager.listLeases().filter(lease => lease.workspaceId === workspace.id) });
  });
  router.post('/worktrees/:leaseId/bundle', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    if (!artifactService) {
      sendProblem(req, res, { status: 503, code: 'ARTIFACT_SERVICE_UNAVAILABLE', detail: 'Artifact service unavailable' });
      return;
    }
    const lease = manager.getLease(req.params.leaseId);
    if (!lease || lease.workspaceId !== workspace.id) {
      sendProblem(req, res, { status: 404, code: 'WORKTREE_LEASE_NOT_FOUND', detail: 'Worktree lease not found' });
      return;
    }
    try {
      const bundle = await new WorktreeArtifactService(artifactService, manager).createBundle(lease.id, { workspaceId: workspace.id, runId: lease.runId, executionId: lease.executionId, agentId: lease.agentId });
      return res.status(201).json({ bundle });
    } catch (error) {
      sendProblem(req, res, { status: 400, code: 'WORKTREE_BUNDLE_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  }));
  const registerControlRoute = (
    action: 'commit' | 'review' | 'rebase' | 'cleanup',
    invoke: (workspaceId: string, leaseId: string, body: unknown) => Promise<unknown>,
    responseKey: string,
    successStatus = 200,
  ): void => {
    router.post(`/worktrees/:leaseId/${action}`, asyncHandler(async (req: Request, res: Response) => {
      const workspace = workspaceManager.get(req.params.workspaceId);
      if (!workspace) {
        sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
        return;
      }
      try {
        const result = await invoke(workspace.id, req.params.leaseId, req.body ?? {});
        return res.status(successStatus).json({ [responseKey]: result });
      } catch (error) {
        if (error instanceof WorktreeControlError) {
          sendProblem(req, res, {
            status: error.status,
            code: error.code,
            detail: error.status >= 500 ? 'Worktree control failed' : error.message,
            ...(error.context ? { context: error.context } : {}),
          });
          return;
        }
        sendProblem(req, res, { status: 500, code: 'WORKTREE_CONTROL_FAILED', detail: 'Worktree control failed' });
      }
    }));
  };
  registerControlRoute('commit', (workspaceId, leaseId, body) => controlService.commit(workspaceId, leaseId, body), 'commit', 201);
  registerControlRoute('review', (workspaceId, leaseId, body) => controlService.review(workspaceId, leaseId, body), 'review');
  registerControlRoute('rebase', (workspaceId, leaseId, body) => controlService.rebase(workspaceId, leaseId, body), 'rebase');
  registerControlRoute('cleanup', (workspaceId, leaseId, body) => controlService.cleanup(workspaceId, leaseId, body), 'cleanup');
  router.delete('/worktrees/:leaseId', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const lease = manager.getLease(req.params.leaseId);
    if (!lease || lease.workspaceId !== workspace.id) {
      sendProblem(req, res, { status: 404, code: 'WORKTREE_LEASE_NOT_FOUND', detail: 'Worktree lease not found' });
      return;
    }
    const run = runLookup?.getRun(workspace.id, lease.runId);
    if (runLookup && (!run || !['completed', 'failed', 'cancelled'].includes(run.status))) {
      sendProblem(req, res, { status: 409, code: 'run_terminal_required', detail: 'run_terminal_required' });
      return;
    }
    try {
      if (req.body?.confirmRecoveryBundle !== true) {
        throw new WorktreeControlError('WORKTREE_RECOVERY_BUNDLE_CONFIRMATION_REQUIRED', 409, 'Cleanup requires confirmRecoveryBundle: true');
      }
      if (!manager.getRecord(lease.id)?.recoveryBundle) {
        throw new WorktreeControlError('WORKTREE_RECOVERY_BUNDLE_REQUIRED', 409, 'A verified recovery bundle is required');
      }
      if (lease.status === 'cleaned') return res.json({ lease });
      const head = req.body?.expectedHeadCommit ?? (await manager.gitStatusSnapshot(lease.id)).head;
      // Rebuild and verify the bundle while holding the same branch lock as
      // other controls. A historical bundle cannot authorize deleting new WIP.
      const result = await controlService.cleanup(workspace.id, lease.id, {
        expectedHeadCommit: head, confirmRecoveryBundle: true,
      });
      return res.json({ lease: result.lease });
    } catch (error) {
      const status = error instanceof WorktreeControlError ? error.status : 500;
      sendProblem(req, res, { status,
        code: error instanceof WorktreeControlError ? error.code : 'WORKTREE_LEASE_REMOVE_FAILED',
        detail: status >= 500 ? 'Worktree cleanup failed' : (error as Error).message,
      });
    }
  }));
  router.post('/worktrees/adopt', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const lease = await manager.adoptLease({
        path: String(body.path ?? ''),
        branchName: String(body.branchName ?? ''),
        workspaceId: workspace.id,
        workspaceRoot: workspaceRootFor(workspace.id) ?? '',
        runId: body.runId === undefined ? '' : String(body.runId),
        executionId: body.executionId === undefined ? '' : String(body.executionId),
        agentId: body.agentId === undefined ? '' : String(body.agentId),
      });
      return res.status(201).json({ lease });
    } catch (error) {
      sendProblem(req, res, { status: errorStatus(error), code: error instanceof WorktreeError ? error.code : 'adopt_failed', detail: error instanceof Error ? error.message : String(error) });
    }
  }));
  router.get('/worktrees/:leaseId/status', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const lease = manager.getLease(req.params.leaseId);
    if (!lease || lease.workspaceId !== workspace.id) {
      sendProblem(req, res, { status: 404, code: 'WORKTREE_NOT_FOUND', detail: 'Worktree not found' });
      return;
    }
    try {
      return res.json({ lease, git: await manager.gitStatusSnapshot(lease.id) });
    } catch (error) {
      sendProblem(req, res, { status: errorStatus(error), code: error instanceof WorktreeError ? error.code : 'worktree_status_failed', detail: error instanceof Error ? error.message : String(error) });
    }
  }));
  router.get('/worktrees/:leaseId/diff', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const lease = manager.getLease(req.params.leaseId);
    if (!lease || lease.workspaceId !== workspace.id) {
      sendProblem(req, res, { status: 404, code: 'WORKTREE_NOT_FOUND', detail: 'Worktree not found' });
      return;
    }
    const maxBytes = req.query.maxBytes === undefined ? undefined : Number(req.query.maxBytes);
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 16 * 1024 * 1024)) {
      sendProblem(req, res, { status: 400, code: 'INVALID_MAX_BYTES', detail: 'maxBytes must be an integer between 1024 and 16777216' });
      return;
    }
    try {
      return res.json({ diff: await manager.diffFromBase(lease.id, maxBytes) });
    } catch (error) {
      sendProblem(req, res, { status: errorStatus(error), code: error instanceof WorktreeError ? error.code : 'worktree_diff_failed', detail: error instanceof Error ? error.message : String(error) });
    }
  }));
  router.get('/worktrees/:leaseId/events', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const lease = manager.getLease(req.params.leaseId);
    if (!lease || lease.workspaceId !== workspace.id) {
      sendProblem(req, res, { status: 404, code: 'WORKTREE_NOT_FOUND', detail: 'Worktree not found' });
      return;
    }
    if (eventRepository) {
      const afterSequence = Number(req.query.afterSequence ?? 0);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        sendProblem(req, res, { status: 400, code: 'INVALID_SEQUENCE', detail: 'afterSequence must be a non-negative integer' });
        return;
      }
      const events = eventRepository.listByWorktree(workspace.id, lease.id, afterSequence)
        .filter(result => result.kind === 'known').map(result => result.event);
      return res.json({ events, eventModel: 'runtime_events', nextSequence: events.at(-1)?.sequence ?? afterSequence });
    }
    // Legacy embedded callers without an Event Store retain their minimal timeline.
    const events = [{ at: lease.createdAt, type: 'created', status: lease.status }, { at: lease.updatedAt, type: 'updated', status: lease.status }];
    return res.json({ events, eventModel: 'lease_timeline_minimal' });
  });
  router.get('/worktrees/:leaseId/artifacts', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const record = manager.getRecord(req.params.leaseId);
    if (!record || record.workspaceId !== workspace.id) {
      sendProblem(req, res, { status: 404, code: 'WORKTREE_NOT_FOUND', detail: 'Worktree not found' });
      return;
    }
    if (!artifactService) {
      sendProblem(req, res, { status: 503, code: 'ARTIFACT_SERVICE_UNAVAILABLE', detail: 'Artifact service unavailable' });
      return;
    }
    const bundle = record.recoveryBundle;
    const bundleArtifactIds = bundle ? [bundle.trackedPatchArtifactId, bundle.untrackedArchiveArtifactId, bundle.manifestArtifactId] : [];
    const artifacts = artifactService.listForRun(workspace.id, record.runId)
      .map(artifact => ({ ...artifact, recoveryBundleMember: bundleArtifactIds.includes(artifact.id) }));
    return res.json({ artifacts, recoveryBundle: bundle ?? null });
  });
  router.post('/worktrees/:leaseId/inspect', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const lease = manager.getLease(req.params.leaseId);
    if (!lease || lease.workspaceId !== workspace.id) {
      sendProblem(req, res, { status: 404, code: 'WORKTREE_NOT_FOUND', detail: 'Worktree not found' });
      return;
    }
    try {
      return res.json({ report: await manager.inspectReport(lease.id) });
    } catch (error) {
      sendProblem(req, res, { status: errorStatus(error), code: error instanceof WorktreeError ? error.code : 'worktree_inspect_failed', detail: error instanceof Error ? error.message : String(error) });
    }
  }));
  router.post('/worktrees/:leaseId/abandon', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const lease = manager.getLease(req.params.leaseId);
    if (!lease || lease.workspaceId !== workspace.id) {
      sendProblem(req, res, { status: 404, code: 'WORKTREE_NOT_FOUND', detail: 'Worktree not found' });
      return;
    }
    if (req.body?.confirm !== true) {
      sendProblem(req, res, { status: 400, code: 'CONFIRMATION_REQUIRED', detail: 'abandon requires body { confirm: true }; the worktree directory is preserved on disk' });
      return;
    }
    try {
      return res.json({ lease: manager.abandonLease(lease.id) });
    } catch (error) {
      sendProblem(req, res, { status: errorStatus(error), code: error instanceof WorktreeError ? error.code : 'worktree_abandon_failed', detail: error instanceof Error ? error.message : String(error) });
    }
  });
  router.post('/runs/:runId/worktrees', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const workspaceRoot = workspaceRootFor(workspace.id);
    if (!workspaceRoot) {
      sendProblem(req, res, { status: 409, code: 'WORKSPACE_GIT_ROOT_UNAVAILABLE', detail: 'workspace_git_reconnect_required' });
      return;
    }
    try {
      const lease = await manager.createLease({ workspaceId: workspace.id, workspaceRoot, runId: req.params.runId, executionId: String(req.body?.executionId ?? ''), agentId: String(req.body?.agentId ?? '') });
      return res.status(201).json({ lease });
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? (error as { code: string }).code : 'worktree_error';
      sendProblem(req, res, {
        status: code === 'workspace_dirty' ? 409 : 400,
        code,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }));
  return router;
}
