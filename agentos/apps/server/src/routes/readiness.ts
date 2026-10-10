import { Router, type RequestHandler } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { MaintenanceDiagnosticsService } from '../services/MaintenanceDiagnosticsService.js';

export function createReadinessHandler(diagnostics: MaintenanceDiagnosticsService): RequestHandler {
  return asyncHandler(async (_req, res) => {
    try {
      const report = await diagnostics.readiness();
      res.status(report.ok ? 200 : 503).json(report);
    } catch {
      res.status(503).json({ ok: false, code: 'READINESS_CHECK_FAILED' });
    }
  });
}

export function createReadinessRoutes(diagnostics: MaintenanceDiagnosticsService): Router {
  const router = Router();
  const readiness = createReadinessHandler(diagnostics);
  router.get('/readiness', readiness);
  router.get('/health/ready', readiness);
  router.get('/diagnostics/export', asyncHandler(async (_req, res) => {
    try {
      const report = await diagnostics.exportSanitized();
      res.setHeader('Content-Disposition', 'attachment; filename="agentos-diagnostics.json"');
      return res.json(report);
    } catch {
      return res.status(500).json({ ok: false, code: 'DIAGNOSTICS_EXPORT_FAILED' });
    }
  }));
  return router;
}
