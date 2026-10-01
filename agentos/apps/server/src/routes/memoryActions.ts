import { Router, type Request, type Response } from 'express';
import type { MemoryVersionFeedbackRequestV1 } from '@agentos/shared';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryFeedbackService } from '../services/MemoryFeedbackService.js';
import { VerifiedMemoryFactService } from '../services/VerifiedMemoryFactService.js';

function failure(res: Response, error: unknown): void {
  const code = error instanceof Error ? error.message : 'MEMORY_ACTION_FAILED';
  const status = /NOT_FOUND/.test(code) ? 404
    : /CONFLICT|UNSUPPORTED|UNAVAILABLE/.test(code) ? 409 : /INVALID/.test(code) ? 400 : 500;
  res.status(status).json({ error: status === 500 ? 'MEMORY_ACTION_FAILED' : code });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Versioned actions use the frozen selection as evidence, never current text as history. */
export function createMemoryActionRoutes(store: SqliteStore, workspaces: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const feedback = new MemoryFeedbackService(store.getDatabase());
  const facts = new VerifiedMemoryFactService(store.getDatabase());
  const workspace = (req: Request, res: Response, write = false) => {
    const current = workspaces.get(req.params.workspaceId);
    if (!current) { res.status(404).json({ error: 'Workspace not found' }); return undefined; }
    if (write && !current.memoryEnabled) { res.status(409).json({ error: 'WORKSPACE_MEMORY_DISABLED' }); return undefined; }
    return current;
  };

  router.get('/memory/feedback', (req, res) => {
    const current = workspace(req, res);
    if (!current) return;
    try { res.json({ feedback: feedback.list(current.id) }); } catch (error) { failure(res, error); }
  });
  router.post('/memory/feedback', (req, res) => {
    const current = workspace(req, res, true);
    if (!current) return;
    try { res.status(201).json({ feedback: feedback.add(current.id, req.body as MemoryVersionFeedbackRequestV1) }); }
    catch (error) { failure(res, error); }
  });
  router.get('/memory/feedback-actions', (req, res) => {
    const current = workspace(req, res);
    if (!current) return;
    try {
      res.json({ actions: feedback.list(current.id).flatMap(item => item.action ? [item.action] : []) });
    } catch (error) { failure(res, error); }
  });
  router.post('/memory/feedback-actions/:actionId/resolve', (req, res) => {
    const current = workspace(req, res, true);
    if (!current) return;
    const body = req.body;
    if (!record(body) || Object.keys(body).some(key => !['expectedVersion', 'status'].includes(key))) {
      res.status(400).json({ error: 'MEMORY_FEEDBACK_INPUT_INVALID' }); return;
    }
    try { res.json({ action: feedback.resolveAction(current.id, req.params.actionId, body.expectedVersion as number, body.status as 'resolved'|'rejected') }); }
    catch (error) { failure(res, error); }
  });

  router.get('/memory/auto-accept-policy', (req, res) => {
    const current = workspace(req, res);
    if (!current) return;
    try { res.json({ policy: facts.policy(current.id) }); } catch (error) { failure(res, error); }
  });
  router.post('/memory/auto-accept-policy', (req, res) => {
    const current = workspace(req, res, true);
    if (!current) return;
    const body = req.body;
    if (!record(body) || Object.keys(body).some(key => !['expectedVersion', 'enabled'].includes(key))) {
      res.status(400).json({ error: 'MEMORY_POLICY_INPUT_INVALID' }); return;
    }
    try { res.json({ policy: facts.setPolicy(current.id, body.expectedVersion as number, body.enabled as boolean) }); }
    catch (error) { failure(res, error); }
  });
  return router;
}
