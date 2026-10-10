import { Router, type Request, type Response } from 'express';
import type { MemoryVersionFeedbackRequestV1 } from '@agentos/shared';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { MemoryFeedbackService, type MemoryFeedbackEntryChange } from '../services/MemoryFeedbackService.js';
import { VerifiedMemoryFactService } from '../services/VerifiedMemoryFactService.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';

function failure(req: Request, res: Response, error: unknown): void {
  const code = error instanceof Error ? error.message : 'MEMORY_ACTION_FAILED';
  const status = /NOT_FOUND/.test(code) ? 404
    : /CONFLICT|UNSUPPORTED|UNAVAILABLE|RESOLUTION_REQUIRED|OWNER_REQUIRED|NOT_UPDATABLE|UNCHANGED/.test(code) ? 409
      : /INVALID/.test(code) ? 400 : 500;
  if (status === 500) {
    sendProblem(req, res, { status: 500, code: 'MEMORY_ACTION_FAILED', detail: 'Memory action failed' });
    return;
  }
  sendProblem(req, res, { status, code, detail: code });
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
    if (!current) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return undefined;
    }
    if (write && !current.memoryEnabled) {
      sendProblem(req, res, { status: 409, code: 'WORKSPACE_MEMORY_DISABLED', detail: 'WORKSPACE_MEMORY_DISABLED' });
      return undefined;
    }
    return current;
  };

  router.get('/memory/feedback', (req, res) => {
    const current = workspace(req, res);
    if (!current) return;
    try { res.json({ feedback: feedback.list(current.id) }); } catch (error) { failure(req, res, error); }
  });
  router.post('/memory/feedback', (req, res) => {
    const current = workspace(req, res, true);
    if (!current) return;
    try { res.status(201).json({ feedback: feedback.add(current.id, req.body as MemoryVersionFeedbackRequestV1) }); }
    catch (error) { failure(req, res, error); }
  });
  router.get('/memory/feedback-actions', (req, res) => {
    const current = workspace(req, res);
    if (!current) return;
    try {
      res.json({ actions: feedback.list(current.id).flatMap(item => item.action ? [item.action] : []) });
    } catch (error) { failure(req, res, error); }
  });
  router.post('/memory/feedback-actions/:actionId/resolve', (req, res) => {
    const current = workspace(req, res, true);
    if (!current) return;
    const body = req.body;
    if (record(body) && Object.keys(body).every(key => ['expectedVersion', 'status'].includes(key))
      && Object.keys(body).length === 2 && body.status === 'resolved') {
      sendProblem(req, res, {
        status: 409,
        code: 'MEMORY_FEEDBACK_RESOLUTION_REQUIRED',
        detail: '先选择修正并提交新版本、归档，或提供重新验证结论与依据，再应用解决操作。',
      });
      return;
    }
    try {
      if (record(body) && Object.keys(body).length === 2
        && Object.keys(body).every(key => ['expectedVersion', 'status'].includes(key))
        && body.status === 'rejected') {
        res.json({ action: feedback.resolveAction(current.id, req.params.actionId, body.expectedVersion as number, 'rejected') });
        return;
      }
      const onEntryChange: MemoryFeedbackEntryChange = (entry, _action, resolution, timestamp) => {
        const origin = { kind: 'memory.entry_edit', entryId: entry.id, entryVersion: entry.version } as const;
        store.workspaceEventWriter().appendWithinTransaction({
          type: resolution.resolution === 'archived' ? 'memory.entry_archived' : 'memory.entry_updated',
          workspaceId: entry.workspaceId,
          timestamp,
          origin,
          context: deriveWorkspaceEventContext(origin),
          payload: {
            memoryEntryId: entry.id,
            version: entry.version,
            scope: entry.scope,
            category: entry.category,
            authority: entry.authority,
          },
        });
      };
      res.json({ ...feedback.applyAction(current.id, req.params.actionId, body, onEntryChange) });
    } catch (error) { failure(req, res, error); }
  });

  router.get('/memory/auto-accept-policy', (req, res) => {
    const current = workspace(req, res);
    if (!current) return;
    try { res.json({ policy: facts.policy(current.id) }); } catch (error) { failure(req, res, error); }
  });
  router.post('/memory/auto-accept-policy', (req, res) => {
    const current = workspace(req, res, true);
    if (!current) return;
    const body = req.body;
    if (!record(body) || Object.keys(body).some(key => !['expectedVersion', 'enabled'].includes(key))) {
      sendProblem(req, res, { status: 400, code: 'MEMORY_POLICY_INPUT_INVALID', detail: 'MEMORY_POLICY_INPUT_INVALID' }); return;
    }
    try { res.json({ policy: facts.setPolicy(current.id, body.expectedVersion as number, body.enabled as boolean) }); }
    catch (error) { failure(req, res, error); }
  });
  return router;
}
