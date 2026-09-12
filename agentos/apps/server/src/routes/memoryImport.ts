import { Router, type Request, type Response } from 'express';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryImportError, MemoryImportService } from '../services/MemoryImportService.js';

/**
 * S7 explicit Markdown import (authorization: S7-import-authorization.md).
 *
 *   POST /memory/import/preview   -> bounded fragments, no persistence
 *   POST /memory/import/confirm   -> Candidates + records + Workspace Events
 *   GET  /memory/imports          -> durable import records (Inspector/source)
 *
 * The body carries the user-selected file content as text; the service owns the
 * size, encoding, fragmentation and idempotency rules.
 */
export function createMemoryImportRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const service = new MemoryImportService(store);

  const requireWorkspace = (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'WORKSPACE_NOT_FOUND' });
      return null;
    }
    return workspace;
  };

  const readBody = (req: Request): { fileName: string; bytes: Buffer } | undefined => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.fileName !== 'string' || typeof body.content !== 'string') return undefined;
    return { fileName: body.fileName, bytes: Buffer.from(body.content, 'utf8') };
  };

  const fail = (res: Response, error: unknown): void => {
    if (error instanceof MemoryImportError) {
      const status = error.code === 'IMPORT_TOO_LARGE' ? 413 : error.code === 'IMPORT_NOT_UTF8' ? 415 : 400;
      res.status(status).json({ error: error.code });
      return;
    }
    res.status(500).json({ error: 'MEMORY_IMPORT_FAILED' });
  };

  router.post('/memory/import/preview', (req: Request, res: Response) => {
    if (!requireWorkspace(req, res)) return;
    const input = readBody(req);
    if (input === undefined) {
      res.status(400).json({ error: 'IMPORT_INPUT_INVALID' });
      return;
    }
    try {
      res.json({ preview: service.preview(input) });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/memory/import/confirm', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const input = readBody(req);
    if (input === undefined) {
      res.status(400).json({ error: 'IMPORT_INPUT_INVALID' });
      return;
    }
    try {
      const result = service.confirm({ workspaceId: workspace.id, ...input, createdAt: new Date().toISOString() });
      res.status(result.imported.length === 0 ? 200 : 201).json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/memory/imports', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    res.json({ imports: service.list(workspace.id) });
  });

  return router;
}

