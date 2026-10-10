import { Router, type Request, type Response } from 'express';
import { RuntimeArtifactService } from '../services/RuntimeArtifactService.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { SqliteStore } from '../store/SqliteStore.js';

export function createArtifactRoutes(
  store: SqliteStore,
  workspaceManager: WorkspaceManager,
  artifactService: RuntimeArtifactService,
): Router {
  const router = Router({ mergeParams: true });

  router.get('/artifacts/:artifactId/content', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    let record;
    try {
      record = artifactService.getContentRecord(workspace.id, req.params.artifactId);
    } catch {
      sendProblem(req, res, { status: 403, code: 'ARTIFACT_CONTENT_PATH_INVALID', detail: 'Artifact content path is invalid' });
      return;
    }
    if (!record) {
      sendProblem(req, res, { status: 404, code: 'ARTIFACT_NOT_FOUND', detail: 'Artifact not found' });
      return;
    }
    if (!record.record.artifact.contentAvailable || !record.path) {
      sendProblem(req, res, { status: 409, code: 'ARTIFACT_CONTENT_METADATA_ONLY', detail: 'Artifact content is metadata-only' });
      return;
    }
    const artifact = record.record.artifact;
    const inline = artifact.type === 'image' || artifact.type === 'diff' || artifact.type === 'report' || artifact.type === 'log'
      || artifact.type === 'review' || artifact.type === 'test';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Type', safeMimeType(artifact.mimeType ?? undefined, artifact.type));
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeFilename(artifact.title)}"`);
    return res.sendFile(record.path, error => {
      if (error && !res.headersSent) {
        sendProblem(req, res, { status: 404, code: 'ARTIFACT_CONTENT_NOT_FOUND', detail: 'Artifact content not found' });
      }
    });
  });

  return router;
}

function safeFilename(value: string): string {
  const name = value.split(/[\\/]/).pop()?.trim() || 'artifact';
  return name.replace(/["\r\n]/g, '_');
}

function safeMimeType(value: string | undefined, type: string): string {
  if (!value) return type === 'image' ? 'application/octet-stream' : 'text/plain; charset=utf-8';
  const normalized = value.toLowerCase().split(';', 1)[0].trim();
  if (normalized === 'text/plain' || normalized === 'text/markdown' || normalized === 'text/css' || normalized === 'application/json' || normalized === 'application/pdf') {
    return normalized === 'text/plain' ? 'text/plain; charset=utf-8' : normalized;
  }
  if (/^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(normalized)) return normalized;
  if (normalized === 'application/octet-stream') return normalized;
  return 'application/octet-stream';
}
