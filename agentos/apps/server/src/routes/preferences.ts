import { Router, type Request, type Response } from 'express';
import type { PreferenceContextKind, PreferenceProjectionStatus } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { PreferenceService } from '../services/PreferenceService.js';
import { PreferenceConfirmationError } from '../services/PreferenceConfirmationService.js';
import { SqliteStore } from '../store/SqliteStore.js';

const contextKinds = new Set<PreferenceContextKind>(['coding', 'debugging', 'planning', 'review', 'explanation', 'general']);
const projectionStatuses = new Set<PreferenceProjectionStatus>(['observed', 'provisional', 'stable', 'dormant']);

export function createPreferenceRoutes(store: SqliteStore, workspaceManager: WorkspaceManager, preferenceService = new PreferenceService(store)): Router {
  const router = Router({ mergeParams: true });
  const getWorkspace = (req: Request) => workspaceManager.get(typeof req.params.workspaceId === 'string' ? req.params.workspaceId : typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '');

  const list = (req: Request, res: Response) => {
    const workspace = getWorkspace(req);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const profile = store.getDefaultUserProfile();
    const context = typeof req.query.context === 'string' && contextKinds.has(req.query.context as PreferenceContextKind) ? req.query.context as PreferenceContextKind : undefined;
    const status = typeof req.query.status === 'string' && projectionStatuses.has(req.query.status as PreferenceProjectionStatus) ? req.query.status as PreferenceProjectionStatus : undefined;
    const projections = store.listPreferenceProjections(profile.id, workspace.id).filter(item => (!context || item.contextKind === context) && (!status || item.status === status));
    res.json({ profile, projections });
  };
  router.get('/preferences', list);

  router.get('/preferences/suggestions', (req: Request, res: Response) => {
    const workspace = getWorkspace(req);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    res.json({ suggestions: preferenceService.confirmations.listSuggestions(workspace.id) });
  });

  const actionInput = (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.workspaceId !== 'string' || body.workspaceId.trim() === ''
      || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1
      || (body.confirmGlobal !== undefined && typeof body.confirmGlobal !== 'boolean')
      || Object.keys(body).some(key => !['workspaceId', 'expectedVersion', 'confirmGlobal'].includes(key))) {
      sendProblem(req, res, { status: 400, code: 'PREFERENCE_INPUT_INVALID', detail: 'PREFERENCE_INPUT_INVALID' });
      return undefined;
    }
    if (typeof req.params.workspaceId === 'string' && req.params.workspaceId !== body.workspaceId) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return undefined;
    }
    if (!workspaceManager.get(body.workspaceId)) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return undefined;
    }
    return { projectionId: req.params.projectionId, workspaceId: body.workspaceId,
      expectedVersion: body.expectedVersion as number, ...(body.confirmGlobal === true ? { confirmGlobal: true } : {}) };
  };

  const sendAction = (req: Request, res: Response, action: () => unknown) => {
    try { res.json(action()); }
    catch (error) {
      if (error instanceof PreferenceConfirmationError) {
        const status = error.code.endsWith('_NOT_FOUND') ? 404
          : error.code.endsWith('_CONFLICT') || error.code.includes('BINDING') ? 409 : 400;
        sendProblem(req, res, { status, code: error.code, detail: error.code });
        return;
      }
      sendProblem(req, res, { status: 500, code: 'PREFERENCE_PERSISTENCE_FAILED', detail: 'Preference persistence failed' });
    }
  };

  router.post('/preferences/:projectionId/confirm', (req: Request, res: Response) => {
    const input = actionInput(req, res);
    if (input) sendAction(req, res, () => preferenceService.confirmations.confirm(input));
  });

  router.post('/preferences/:projectionId/reject', (req: Request, res: Response) => {
    const input = actionInput(req, res);
    if (input) sendAction(req, res, () => preferenceService.confirmations.reject(input));
  });

  router.post('/preferences/:projectionId/revoke', (req: Request, res: Response) => {
    const input = actionInput(req, res);
    if (input) sendAction(req, res, () => preferenceService.confirmations.revoke(input));
  });

  router.get('/preferences/evidence', (req: Request, res: Response) => {
    const workspace = getWorkspace(req);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const profile = store.getDefaultUserProfile();
    const projectionId = typeof req.query.projectionId === 'string' ? req.query.projectionId : undefined;
    let evidence = store.listPreferenceEvidence(profile.id, workspace.id);
    if (projectionId) {
      const frozenEvidence = preferenceService.confirmations.evidenceForProjection(projectionId, workspace.id, profile.id);
      if (frozenEvidence === null) {
        sendProblem(req, res, { status: 404, code: 'PREFERENCE_EVIDENCE_NOT_FOUND', detail: 'Preference evidence not found' });
        return;
      }
      if (frozenEvidence !== undefined) return res.json({ evidence: frozenEvidence });
      const projection = store.listPreferenceProjections(profile.id, workspace.id).find(item => item.id === projectionId);
      if (!projection || projection.scope !== 'workspace') {
        sendProblem(req, res, { status: 404, code: 'PREFERENCE_PROJECTION_NOT_FOUND', detail: 'Preference projection not found' });
        return;
      }
      evidence = store.listPreferenceEvidenceForProjection(projection.id, profile.id, workspace.id);
    }
    res.json({ evidence });
  });

  const setLearning = (req: Request, res: Response) => {
    if (!getWorkspace(req)) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    if (typeof req.body?.enabled !== 'boolean') {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'enabled must be boolean' });
      return;
    }
    if (req.body.enabled) preferenceService.resumeLearning('default'); else preferenceService.pauseLearning('default');
    res.json({ profile: store.getDefaultUserProfile() });
  };
  router.post('/preferences/learning', setLearning);
  router.post('/preferences/pause', (req: Request, res: Response) => { req.body = { ...(req.body as Record<string, unknown>), enabled: false }; return setLearning(req, res); });

  const clear = (req: Request, res: Response) => {
    if (!getWorkspace(req)) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    preferenceService.clearLearning('default');
    res.json({ profile: store.getDefaultUserProfile(), projections: [] });
  };
  router.post('/preferences/clear', clear);

  router.post('/preferences/:projectionId/sleep', (req: Request, res: Response) => {
    const workspace = getWorkspace(req);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const projection = store.listPreferenceProjections('default', workspace.id).find(item => item.id === req.params.projectionId);
    if (!projection) {
      sendProblem(req, res, { status: 404, code: 'PREFERENCE_PROJECTION_NOT_FOUND', detail: 'Preference projection not found' });
      return;
    }
    try { res.json({ projection: preferenceService.sleepProjection('default', projection.id) }); }
    catch (error) {
      sendProblem(req, res, { status: 400, code: 'PREFERENCE_SLEEP_FAILED', detail: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/runs/:runId/preferences', (req: Request, res: Response) => {
    const workspace = getWorkspace(req);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return;
    }
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run) {
      sendProblem(req, res, { status: 404, code: 'RUN_NOT_FOUND', detail: 'Run not found' });
      return;
    }
    const applications = store.listPreferenceApplications(workspace.id, run.id);
    const projections = store.listPreferenceProjections('default', workspace.id).filter(item => applications.some(application => application.projectionId === item.id));
    res.json({ runId: run.id, applications, projections });
  });

  return router;
}
