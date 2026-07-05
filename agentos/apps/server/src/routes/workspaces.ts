import { Router } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';

export function createWorkspaceRoutes(manager: WorkspaceManager): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json({ workspaces: manager.list() });
  });

  router.get('/recent', (_req, res) => {
    res.json({ workspaces: manager.recent() });
  });

  router.get('/:id', (req, res) => {
    const workspace = manager.get(req.params.id);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    res.json({ workspace });
  });

  router.post('/', (req, res) => {
    const { name, rootPath, git, memory, readme, docs } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    if (!rootPath || typeof rootPath !== 'string') return res.status(400).json({ error: 'rootPath is required' });
    try {
      const workspace = manager.create(name, rootPath, { git, memory, readme, docs });
      res.status(201).json({ workspace });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/import', (req, res) => {
    const { rootPath } = req.body;
    if (!rootPath || typeof rootPath !== 'string') return res.status(400).json({ error: 'rootPath is required' });
    try {
      const workspace = manager.importExisting(rootPath);
      res.status(201).json({ workspace });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/:id', (req, res) => {
    manager.remove(req.params.id);
    res.json({ ok: true });
  });

  return router;
}
