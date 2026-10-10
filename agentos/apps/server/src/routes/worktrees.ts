import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { WorktreeManager } from '../services/WorktreeManager.js';
import { WorktreeArtifactService } from '../services/WorktreeArtifactService.js';
import type { RuntimeArtifactService } from '../services/RuntimeArtifactService.js';
import { asyncHandler } from '../utils/asyncHandler.js';

type RunLookup = { getRun(workspaceId: string, runId: string): { status: string } | undefined };

export function createWorktreeRoutes(
  workspaceManager: WorkspaceManager,
  manager: WorktreeManager,
  artifactService?: RuntimeArtifactService,
  runLookup?: RunLookup,
  workspaceRootFor: (workspaceId: string) => string | undefined = workspaceId => workspaceManager.get(workspaceId)?.rootPath,
): Router {
  const router = Router({ mergeParams: true });
  router.get('/worktrees', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId); if (!workspace) return res.status(404).json({ error:'Workspace not found' });
    return res.json({ leases: manager.listLeases().filter(lease => lease.workspaceId === workspace.id) });
  });
  router.post('/worktrees/:leaseId/bundle', asyncHandler(async (req: Request, res: Response) => { const workspace=workspaceManager.get(req.params.workspaceId); if(!workspace)return res.status(404).json({error:'Workspace not found'}); if(!artifactService)return res.status(503).json({error:'Artifact service unavailable'}); const lease=manager.getLease(req.params.leaseId); if(!lease||lease.workspaceId!==workspace.id)return res.status(404).json({error:'Worktree lease not found'}); try { const bundle=await new WorktreeArtifactService(artifactService,manager).createBundle(lease.id,{workspaceId:workspace.id,runId:lease.runId,executionId:lease.executionId,agentId:lease.agentId}); return res.status(201).json({bundle}); } catch(error){ return res.status(400).json({error:error instanceof Error?error.message:String(error)}); } }));
  router.delete('/worktrees/:leaseId', asyncHandler(async (req: Request, res: Response) => {
    const workspace=workspaceManager.get(req.params.workspaceId);
    if(!workspace)return res.status(404).json({error:'Workspace not found'});
    const lease=manager.getLease(req.params.leaseId);
    if(!lease||lease.workspaceId!==workspace.id)return res.status(404).json({error:'Worktree lease not found'});
    const run = runLookup?.getRun(workspace.id, lease.runId);
    if (runLookup && (!run || !['completed', 'failed', 'cancelled'].includes(run.status))) return res.status(409).json({ error: 'run_terminal_required', code: 'run_terminal_required' });
    try{return res.json({lease:await manager.removeLease(lease.id,req.body?.confirmRecoveryBundle===true)});}catch(error){return res.status(409).json({error:error instanceof Error?error.message:String(error)});}
  }));
  router.post('/runs/:runId/worktrees', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId); if (!workspace) return res.status(404).json({ error:'Workspace not found' });
    const workspaceRoot = workspaceRootFor(workspace.id);
    if (!workspaceRoot) return res.status(409).json({ error: 'workspace_git_reconnect_required', code: 'WORKSPACE_GIT_ROOT_UNAVAILABLE' });
    try { const lease = await manager.createLease({ workspaceId: workspace.id, workspaceRoot, runId:req.params.runId, executionId:String(req.body?.executionId ?? ''), agentId:String(req.body?.agentId ?? '') }); return res.status(201).json({ lease }); }
    catch (error) { const code = error instanceof Error && 'code' in error ? (error as {code:string}).code : 'worktree_error'; return res.status(code === 'workspace_dirty' ? 409 : 400).json({ error: error instanceof Error ? error.message : String(error), code }); }
  }));
  return router;
}
