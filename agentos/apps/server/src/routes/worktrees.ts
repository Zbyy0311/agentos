import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { WorktreeManager } from '../services/WorktreeManager.js';
import { WorktreeMergeError, WorktreeMergeService } from '../services/WorktreeMergeService.js';
import type { WorktreeMergeStrategy } from '../store/WorktreeMergeRepository.js';
import { WorktreeArtifactService } from '../services/WorktreeArtifactService.js';
import type { RuntimeArtifactService } from '../services/RuntimeArtifactService.js';
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
};

export function createWorktreeRoutes(
  workspaceManager: WorkspaceManager,
  manager: WorktreeManager,
  artifactService?: RuntimeArtifactService,
  runLookup?: RunLookup,
  workspaceRootFor: (workspaceId: string) => string | undefined = workspaceId => workspaceManager.get(workspaceId)?.rootPath,
  mergeService?: WorktreeMergeService,
): Router {
  const router = Router({ mergeParams: true });
  if (mergeService) {
    router.post('/worktrees/:worktreeId/merge', asyncHandler(async (req: Request, res: Response) => {
      const workspace = workspaceManager.get(req.params.workspaceId);
      if (!workspace) {
        sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
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
            detail: error.message,
            context: { worktreeId: req.params.worktreeId },
          });
          return;
        }
        sendProblem(req, res, { status: 500, code: 'WORKTREE_MERGE_FAILED', detail: error instanceof Error ? error.message : String(error) });
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
      return res.json({ lease: await manager.removeLease(lease.id, req.body?.confirmRecoveryBundle === true) });
    } catch (error) {
      sendProblem(req, res, { status: 409, code: 'WORKTREE_LEASE_REMOVE_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  }));
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
