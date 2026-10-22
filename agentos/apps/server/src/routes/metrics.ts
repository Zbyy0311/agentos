import { Router, type Request, type Response } from 'express';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import type { SqliteStore } from '../store/SqliteStore.js';
import { WorkspaceMetricsService } from '../services/WorkspaceMetricsService.js';
import { sharedProviderMetricsService, type ProviderMetricsService } from '../services/ProviderMetricsService.js';
import { concurrencyLimitsFromEnvironment } from '../services/RunConcurrencyScheduler.js';

/**
 * 14-Roadmap §181-185 minimal monitoring metrics surface (read-only).
 * All values derive from existing tables / SQLite runtime state; the
 * response contains counts, latencies and sizes only — never prompt content
 * or secrets.
 */

function isValidTimestampParam(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

export function createMetricsRoutes(
  store: SqliteStore,
  workspaceManager: WorkspaceManager,
  options: { readonly providerMetrics?: ProviderMetricsService } = {},
): Router {
  const router = Router({ mergeParams: true });
  const usageRepository = store.usageRepository();
  const metricsService = new WorkspaceMetricsService(usageRepository.transactionDatabase, {
    providerMetrics: options.providerMetrics ?? sharedProviderMetricsService,
    concurrencyLimits: concurrencyLimitsFromEnvironment(process.env),
  });

  const requireWorkspace = (req: Request, res: Response, workspaceId: string): boolean => {
    if (workspaceManager.get(workspaceId)) return true;
    sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
    return false;
  };

  router.get('/metrics/summary', (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string };
    if (!requireWorkspace(req, res, workspaceId)) return;

    const { from, to } = req.query;
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

    const summary = metricsService.summarizeWorkspace(
      workspaceId,
      typeof from === 'string' ? from : undefined,
      typeof to === 'string' ? to : undefined,
    );
    res.json(summary);
  });

  return router;
}
