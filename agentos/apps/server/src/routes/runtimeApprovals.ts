import { Router, type Request, type Response } from 'express';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { RuntimeApprovalGate, RuntimeApprovalGateError, type RuntimeApprovalDecision } from '../services/RuntimeApprovalGate.js';
import { RuntimeApprovalRepositoryError } from '../store/RuntimeApprovalRepository.js';

/** S3 durable Runtime Authorization surface; legacy in-memory approvals stay compatibility. */
export function createRuntimeApprovalRoutes(
  store: SqliteStore,
  workspaceManager: WorkspaceManager,
  gate: RuntimeApprovalGate,
): Router {
  const router = Router({ mergeParams: true });
  router.use((req: Request, res: Response, next) => {
    if (!workspaceManager.get(req.params.workspaceId)) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'WORKSPACE_NOT_FOUND' });
      return;
    }
    next();
  });

  router.get('/runtime-approvals', (req: Request, res: Response) => {
    res.json({ requests: gate.list(req.params.workspaceId) });
  });

  router.get('/runtime-approvals/:requestId', (req: Request, res: Response) => {
    const request = gate.list(req.params.workspaceId).find(item => item.id === req.params.requestId);
    if (!request) {
      sendProblem(req, res, { status: 404, code: 'RUNTIME_APPROVAL_NOT_FOUND', detail: 'RUNTIME_APPROVAL_NOT_FOUND' });
      return;
    }
    res.json({ request });
  });

  router.post('/runtime-approvals/:requestId/resolve', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = body.decision;
    const expectedVersion = body.expectedVersion;
    const decidedBy = body.decidedBy;
    if ((decision !== 'approve_once' && decision !== 'reject') ||
      !Number.isSafeInteger(expectedVersion) || typeof decidedBy !== 'string' || decidedBy.trim() === '') {
      sendProblem(req, res, { status: 400, code: 'RUNTIME_APPROVAL_INPUT_INVALID', detail: 'RUNTIME_APPROVAL_INPUT_INVALID' });
      return;
    }
    try {
      const result = gate.resolve({
        workspaceId: req.params.workspaceId,
        requestId: req.params.requestId,
        expectedVersion: expectedVersion as number,
        decision: decision as RuntimeApprovalDecision,
        decidedBy,
      });
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      const status = error instanceof RuntimeApprovalGateError
        ? error.code === 'NOT_FOUND' ? 404
          : error.code === 'EXPIRED' ? 410
            : error.code === 'CONFLICT' || error.code === 'STALE' ? 409
              : 400
        : error instanceof RuntimeApprovalRepositoryError
          ? error.code === 'NOT_FOUND' ? 404 : error.code === 'CONFLICT' ? 409 : 400
          : 500;
      if (status === 500) {
        sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
        return;
      }
      const code = error instanceof Error ? error.message : String(error);
      sendProblem(req, res, { status, code, detail: code });
    }
  });

  return router;
}
