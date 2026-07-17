import { Router, type Request, type Response } from 'express';
import { RuntimeArtifactService } from '../services/RuntimeArtifactService.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';

export function createArtifactRoutes(
  store: SqliteStore,
  workspaceManager: WorkspaceManager,
  artifactService: RuntimeArtifactService,
): Router {
  const router = Router({ mergeParams: true });

  router.get('/artifacts/:artifactId/content', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    let record;
    try {
      record = artifactService.getContentRecord(workspace.id, req.params.artifactId);
    } catch {
      return res.status(403).json({ error: 'Artifact content path is invalid' });
    }
    if (!record) return res.status(404).json({ error: 'Artifact not found' });
    if (!record.record.artifact.contentAvailable || !record.path) {
      return res.status(409).json({ error: 'Artifact content is metadata-only' });
    }
    const artifact = record.record.artifact;
    const inline = artifact.type === 'image' || artifact.type === 'diff' || artifact.type === 'report' || artifact.type === 'log';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', artifact.mimeType ?? (artifact.type === 'image' ? 'application/octet-stream' : 'text/plain; charset=utf-8'));
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeFilename(artifact.title)}"`);
    return res.sendFile(record.path, error => {
      if (error && !res.headersSent) res.status(404).json({ error: 'Artifact content not found' });
    });
  });

  return router;
}

function safeFilename(value: string): string {
  const name = value.split(/[\\/]/).pop()?.trim() || 'artifact';
  return name.replace(/["\r\n]/g, '_');
}
