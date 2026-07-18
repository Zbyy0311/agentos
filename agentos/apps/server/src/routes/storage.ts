import { createHash, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { RuntimeArtifactService } from '../services/RuntimeArtifactService.js';
import { RuntimeStorageService } from '../services/RuntimeStorageService.js';
import { DEFAULT_RUNTIME_STORAGE_POLICY } from '../services/RuntimeEventBuffer.js';
import { SqliteStore } from '../store/SqliteStore.js';

type Preview = {
  workspaceId: string;
  expiresAt: number;
  selection: string[];
  selectionHash: string;
  bytes: number;
};

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function createStorageRoutes(
  workspaceManager: WorkspaceManager,
  projectRoot: string,
  store?: SqliteStore,
  artifactService?: RuntimeArtifactService,
): Router {
  const router = Router({ mergeParams: true });
  const previews = new Map<string, Preview>();
  const serviceFor = (id: string) => new RuntimeStorageService(`${projectRoot}/.agentos/artifacts/${id}`, DEFAULT_RUNTIME_STORAGE_POLICY);

  router.get('/storage', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    return res.json(await serviceFor(workspace.id).usage());
  });

  router.post('/retention/preview', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const selection = parseSelection(req.body?.selection);
    if (!selection) return res.status(400).json({ error: 'selection must be an array of run ids' });
    const selectedRuns = store ? selection.map(runId => store.getRun(workspace.id, runId)) : [];
    if (store && selectedRuns.some(run => !run || !TERMINAL_RUN_STATUSES.has(run.status))) {
      return res.status(409).json({ error: 'only terminal runs in this workspace can be retained' });
    }
    const bytes = store
      ? selectedRuns.reduce((sum, run) => sum + (run ? store.listRuntimeArtifacts(workspace.id, run.id).reduce((total, artifact) => total + artifact.sizeBytes, 0) : 0), 0)
      : 0;
    const token = randomUUID();
    const selectionHash = hashSelection(selection);
    previews.set(token, { workspaceId: workspace.id, expiresAt: Date.now() + 300_000, selection, selectionHash, bytes });
    return res.json({
      token,
      workspaceId: workspace.id,
      selection,
      selectionHash,
      runs: selectedRuns.filter(Boolean).map(run => ({ runId: run!.id, status: run!.status })),
      bytes,
      automaticRunDeletion: false,
    });
  });

  router.post('/retention/apply', async (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const token = req.body?.token;
    const preview = typeof token === 'string' ? previews.get(token) : undefined;
    if (!preview || preview.workspaceId !== workspace.id || preview.expiresAt < Date.now()) {
      return res.status(409).json({ error: 'valid retention preview token is required' });
    }
    const selection = parseSelection(req.body?.selection);
    if (!selection || hashSelection(selection) !== preview.selectionHash) {
      return res.status(409).json({ error: 'retention selection does not match preview' });
    }
    previews.delete(token);
    if (!store || !artifactService) {
      return res.json({ workspaceId: workspace.id, selection, deletedRuns: 0, deletedArtifacts: 0, bytes: 0, dryRun: true });
    }
    const result = await artifactService.deleteRuns(workspace.id, selection);
    return res.json({ workspaceId: workspace.id, selection, deletedRuns: selection.length, ...result, dryRun: false });
  });

  return router;
}

function parseSelection(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) return undefined;
  return [...new Set(value as string[])];
}

function hashSelection(selection: string[]): string {
  return createHash('sha256').update(JSON.stringify(selection)).digest('hex');
}
