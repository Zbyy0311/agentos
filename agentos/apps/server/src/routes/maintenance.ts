import { Router, type Request, type Response } from 'express';
import { sendProblem } from '../problemDetails.js';
import type { MaintenanceBarrier } from '../services/MaintenanceBarrier.js';
import { beginMaintenanceRequestDrain } from '../services/MaintenanceRequestDrain.js';
import type { MaintenanceCoordinator } from '../services/MaintenanceCoordinator.js';
import { MaintenanceError as CoordinatorError } from '../services/MaintenanceCoordinator.js';
import type { MaintenanceDiagnosticsService } from '../services/MaintenanceDiagnosticsService.js';
import type { MaintenanceService } from '../services/MaintenanceService.js';
import { MaintenanceServiceError } from '../services/MaintenanceService.js';
import type { WorkspaceGitRootRegistry } from '../services/WorkspaceGitRootRegistry.js';
import { WorkspaceGitRootError } from '../services/WorkspaceGitRootRegistry.js';

const MAINTENANCE_CONTROL_PATHS = new Set([
  '/api/maintenance/backup',
  '/api/maintenance/cleanup/apply',
  '/api/maintenance/recover-expired',
]);

export function createMaintenanceRoutes(input: {
  readonly coordinator: MaintenanceCoordinator;
  readonly diagnostics: MaintenanceDiagnosticsService;
  readonly service: MaintenanceService;
  readonly instanceId: string;
  readonly workspaceGitRoots?: WorkspaceGitRootRegistry;
}): Router {
  const router = Router();

  router.get('/readiness', async (_req: Request, res: Response) => {
    try {
      const report = await input.diagnostics.readiness();
      return res.status(report.ok ? 200 : 503).json(report);
    } catch {
      return res.status(503).json({ ok: false, code: 'READINESS_CHECK_FAILED' });
    }
  });

  router.post('/backup', async (req: Request, res: Response) => {
    try {
      const result = await input.coordinator.run('backup', ({ signal }) => input.service.createBackup({ signal }));
      return res.status(201).json({
        ok: true,
        operationId: result.operationId,
        backupDirectory: result.result.backupDirectory,
        createdAt: result.result.manifest.createdAt,
        schemaVersion: result.result.manifest.schemaVersion,
        fileCount: result.result.manifest.files.length,
        durability: result.result.durability,
      });
    } catch (error) {
      return respondMaintenanceError(req, res, error);
    }
  });

  router.get('/cleanup/preview', async (_req: Request, res: Response) => {
    try {
      return res.json(await input.service.previewCleanup(input.instanceId));
    } catch {
      return res.status(500).json({ error: 'Cleanup preview failed', code: 'CLEANUP_PREVIEW_FAILED' });
    }
  });

  router.post('/cleanup/apply', async (req: Request, res: Response) => {
    try {
      const result = await input.coordinator.run('cleanup', ({ signal }) =>
        input.service.applyCleanup(req.body, input.instanceId, signal));
      return res.json({ ok: true, ...result.result });
    } catch (error) {
      return respondMaintenanceError(req, res, error);
    }
  });

  router.get('/storage', async (_req: Request, res: Response) => {
    try {
      return res.json(await input.service.inspectStorage());
    } catch {
      return res.status(500).json({ error: 'Storage diagnostics failed', code: 'STORAGE_DIAGNOSTICS_FAILED' });
    }
  });

  router.get('/workspaces/:workspaceId/git-root', async (req: Request, res: Response) => {
    if (!input.workspaceGitRoots) return res.status(503).json({ code: 'WORKSPACE_GIT_RECONNECT_UNAVAILABLE' });
    try { return res.json(await input.workspaceGitRoots.status(req.params.workspaceId)); }
    catch (error) { return respondMaintenanceError(req, res, error); }
  });

  router.post('/workspaces/:workspaceId/git-root/check', async (req: Request, res: Response) => {
    if (!input.workspaceGitRoots) return res.status(503).json({ code: 'WORKSPACE_GIT_RECONNECT_UNAVAILABLE' });
    if (typeof req.body?.rootPath !== 'string' || !req.body.rootPath.trim()) {
      return res.status(400).json({ code: 'WORKSPACE_GIT_ROOT_REQUIRED' });
    }
    try { return res.json(await input.workspaceGitRoots.check(req.params.workspaceId, req.body.rootPath.trim())); }
    catch (error) { return respondMaintenanceError(req, res, error); }
  });

  router.post('/workspaces/:workspaceId/git-root/reconnect', async (req: Request, res: Response) => {
    if (!input.workspaceGitRoots) return res.status(503).json({ code: 'WORKSPACE_GIT_RECONNECT_UNAVAILABLE' });
    if (typeof req.body?.rootPath !== 'string' || !req.body.rootPath.trim()) {
      return res.status(400).json({ code: 'WORKSPACE_GIT_ROOT_REQUIRED' });
    }
    try { return res.json(await input.workspaceGitRoots.reconnect(req.params.workspaceId, req.body.rootPath.trim())); }
    catch (error) { return respondMaintenanceError(req, res, error); }
  });

  router.post('/recover-expired', async (req: Request, res: Response) => {
    try {
      const released = await input.coordinator.releaseExpiredLease();
      return res.json({ ok: true, released, maintenance: input.coordinator.status });
    } catch (error) {
      return respondMaintenanceError(req, res, error);
    }
  });

  return router;
}

export function createMaintenanceWriteBarrier(barrier: MaintenanceBarrier) {
  return (req: Request, res: Response, next: (error?: unknown) => void): void => {
    const method = req.method.toUpperCase();
    const path = req.originalUrl.split('?', 1)[0];
    const maintenanceControl = method === 'POST' && MAINTENANCE_CONTROL_PATHS.has(path);
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || maintenanceControl) {
      next();
      return;
    }
    const release = barrier.enterMutation();
    if (!release) {
      res.setHeader('Retry-After', '5');
      sendProblem(req, res, {
        status: 503,
        code: 'MAINTENANCE_IN_PROGRESS',
        title: 'Service Unavailable',
        detail: 'Writes are paused while AgentOS completes maintenance.',
        retryable: true,
      });
      return;
    }
    beginMaintenanceRequestDrain(req, res, release);
    next();
  };
}

function respondMaintenanceError(req: Request, res: Response, error: unknown): void {
  const code = error instanceof CoordinatorError || error instanceof MaintenanceServiceError || error instanceof WorkspaceGitRootError
    ? error.code
    : 'MAINTENANCE_OPERATION_FAILED';
  const status = code === 'WORKSPACE_NOT_FOUND' ? 404
    : code === 'BACKUP_FILE_LIMIT_EXCEEDED' || code === 'BACKUP_TOTAL_LIMIT_EXCEEDED'
      || code === 'BACKUP_FILE_COUNT_LIMIT_EXCEEDED' || code === 'BACKUP_MANIFEST_LIMIT_EXCEEDED' ? 413
    : code === 'WORKSPACE_GIT_ROOT_NOT_ABSOLUTE' || code === 'WORKSPACE_GIT_ROOT_REQUIRED' ? 400
    : code.startsWith('WORKSPACE_GIT_') || code === 'MAINTENANCE_ALREADY_ACTIVE' || code === 'MAINTENANCE_LEASE_NOT_EXPIRED'
    || code === 'CLEANUP_PREVIEW_STALE' || code === 'CLEANUP_PREVIEW_INVALID'
    ? 409
    : code === 'MAINTENANCE_DRAIN_TIMEOUT' || code === 'MAINTENANCE_MAX_DURATION_EXCEEDED'
      || code === 'MAINTENANCE_SHUTTING_DOWN'
      ? 503
      : 500;
  sendProblem(req, res, {
    status,
    code,
    title: status === 409 ? 'Conflict' : status === 503 ? 'Service Unavailable' : 'Maintenance Failed',
    detail: status === 503 ? 'Maintenance could not obtain a safe drained state; retry after active work completes.' : 'Maintenance operation failed.',
    retryable: status === 503,
  });
}
