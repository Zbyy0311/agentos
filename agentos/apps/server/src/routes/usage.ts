import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import { inTransaction } from '../store/Transaction.js';
import {
  USAGE_RECORD_DEFAULT_LIMIT,
  USAGE_RECORD_MAX_LIMIT,
  UsageRepositoryError,
} from '../store/UsageRepository.js';
import { UsageAggregator } from '../services/UsageAggregator.js';

/**
 * §50 read-only Usage surface (backend closed loop, no UI Dashboard):
 * - GET /usage/records  — paginated, filterable Usage Records
 * - GET /usage/summary  — per-provider / per-run metric aggregation
 *
 * Both endpoints synchronise pending usage facts into usage_records first
 * (idempotent by source_event_id) so reads observe a complete ledger.
 */

function parseLimit(raw: unknown): number | null {
  if (raw === undefined) return USAGE_RECORD_DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > USAGE_RECORD_MAX_LIMIT) return null;
  return limit;
}

function isValidTimestampParam(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

export function createUsageRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const usageRepository = store.usageRepository();
  const db = usageRepository.transactionDatabase;
  const aggregator = new UsageAggregator(db, usageRepository);

  const requireWorkspace = (req: Request, res: Response, workspaceId: string): boolean => {
    if (workspaceManager.get(workspaceId)) return true;
    sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
    return false;
  };

  router.get('/usage/records', (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string };
    if (!requireWorkspace(req, res, workspaceId)) return;

    const limit = parseLimit(req.query.limit);
    if (limit === null) {
      sendProblem(req, res, {
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: `limit must be an integer between 1 and ${USAGE_RECORD_MAX_LIMIT}`,
      });
      return;
    }
    const { runId, from, to, cursor } = req.query;
    for (const [field, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && (typeof value !== 'string' || !isValidTimestampParam(value))) {
        sendProblem(req, res, {
          status: 400,
          code: 'VALIDATION_FAILED',
          detail: `${field} must be canonical UTC ISO 8601 milliseconds`,
        });
        return;
      }
    }

    try {
      inTransaction(db, () => {
        aggregator.ingestWorkspaceUsageWithinTransaction(workspaceId);
      });
      const page = usageRepository.queryRecords({
        workspaceId,
        ...(typeof runId === 'string' && runId.length > 0 ? { runId } : {}),
        ...(typeof from === 'string' ? { from } : {}),
        ...(typeof to === 'string' ? { to } : {}),
        limit,
        ...(typeof cursor === 'string' && cursor.length > 0 ? { cursor } : {}),
      });
      res.json({
        records: page.records,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (error instanceof UsageRepositoryError && error.code === 'USAGE_RECORD_VALIDATION_FAILED') {
        sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: error.message });
        return;
      }
      throw error;
    }
  });

  router.get('/usage/summary', (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string };
    if (!requireWorkspace(req, res, workspaceId)) return;

    const { from, to, groupBy } = req.query;
    for (const [field, value] of [['from', from], ['to', to]] as const) {
      if (value !== undefined && (typeof value !== 'string' || !isValidTimestampParam(value))) {
        sendProblem(req, res, {
          status: 400,
          code: 'VALIDATION_FAILED',
          detail: `${field} must be canonical UTC ISO 8601 milliseconds`,
        });
        return;
      }
    }
    const group = groupBy === undefined ? 'provider' : groupBy;
    if (group !== 'provider' && group !== 'run') {
      sendProblem(req, res, {
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: "groupBy must be 'provider' or 'run'",
      });
      return;
    }

    inTransaction(db, () => {
      aggregator.ingestWorkspaceUsageWithinTransaction(workspaceId);
    });
    const summary = usageRepository.summarize({
      workspaceId,
      ...(typeof from === 'string' ? { from } : {}),
      ...(typeof to === 'string' ? { to } : {}),
      groupBy: group,
    });
    res.json(summary);
  });

  return router;
}
