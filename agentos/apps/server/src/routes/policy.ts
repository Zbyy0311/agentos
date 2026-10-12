import { Router, type Request, type Response } from 'express';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { PolicyRepository, PolicyRepositoryError } from '../store/PolicyRepository.js';

const DEFAULT_DECISIONS_LIMIT = 50;
const MAX_DECISIONS_LIMIT = 200;

function toRepositoryError(req: Request, res: Response, error: unknown): void {
  if (error instanceof PolicyRepositoryError && error.code === 'INPUT_INVALID') {
    sendProblem(req, res, { status: 400, code: 'POLICY_QUERY_INVALID', detail: error.message });
    return;
  }
  sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
}

/**
 * Policy Runtime read-only surface (PR-2C). Two GET endpoints expose the
 * workspace default policy profile with its enabled rules and the immutable
 * policy decision audit trail. There are deliberately no write endpoints
 * here: profile mutation is out of scope, and the profile endpoint must
 * never trigger the PolicyEngine's lazy default-profile seeding — a read
 * API with side effects would make polling callers mutate state.
 */
export function createPolicyRoutes(
  store: SqliteStore,
  workspaceManager: WorkspaceManager,
): Router {
  const router = Router({ mergeParams: true });
  router.use((req: Request, res: Response, next) => {
    if (!workspaceManager.get(req.params.workspaceId)) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'WORKSPACE_NOT_FOUND' });
      return;
    }
    next();
  });

  const policy = new PolicyRepository(store.getDatabase());

  router.get('/policy/profile', asyncHandler(async (req: Request, res: Response) => {
    try {
      const profile = policy.findDefaultProfile(req.params.workspaceId);
      if (profile === undefined) {
        sendProblem(req, res, { status: 404, code: 'POLICY_PROFILE_NOT_FOUND', detail: 'POLICY_PROFILE_NOT_FOUND' });
        return;
      }
      const rules = policy.findRulesByProfile(profile.id).map(rule => ({
        id: rule.id,
        action: rule.action,
        selector: rule.selector,
        decision: rule.decision,
        priority: rule.priority,
        specificity: rule.specificity,
      }));
      res.json({ profile, rules });
    } catch (error) {
      toRepositoryError(req, res, error);
    }
  }));

  router.get('/policy-decisions', asyncHandler(async (req: Request, res: Response) => {
    const runIdParam = req.query.runId;
    const runId = typeof runIdParam === 'string' && runIdParam.trim() !== '' ? runIdParam : undefined;
    const limit = parseBoundedInteger(req.query.limit, DEFAULT_DECISIONS_LIMIT, MAX_DECISIONS_LIMIT);
    const offset = parseBoundedInteger(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
    if (limit === undefined || offset === undefined) {
      sendProblem(req, res, { status: 400, code: 'POLICY_QUERY_INVALID', detail: 'POLICY_QUERY_INVALID' });
      return;
    }
    try {
      const decisions = policy.listDecisions(req.params.workspaceId, { runId, limit, offset, order: 'desc' });
      res.json({ decisions, limit, offset });
    } catch (error) {
      toRepositoryError(req, res, error);
    }
  }));

  return router;
}

function parseBoundedInteger(value: unknown, fallback: number, max: number): number | undefined {
  if (value === undefined) return fallback;
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || !/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return Math.min(parsed, max);
}
