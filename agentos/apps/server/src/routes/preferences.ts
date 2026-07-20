import { Router, type Request, type Response } from 'express';
import type { PreferenceContextKind, PreferenceProjectionStatus } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { PreferenceService } from '../services/PreferenceService.js';
import { SqliteStore } from '../store/SqliteStore.js';

const contextKinds = new Set<PreferenceContextKind>(['coding', 'debugging', 'planning', 'review', 'explanation', 'general']);
const projectionStatuses = new Set<PreferenceProjectionStatus>(['observed', 'provisional', 'stable', 'dormant']);

export function createPreferenceRoutes(store: SqliteStore, workspaceManager: WorkspaceManager, preferenceService = new PreferenceService(store)): Router {
  const router = Router({ mergeParams: true });
  const getWorkspace = (req: Request) => workspaceManager.get(typeof req.params.workspaceId === 'string' ? req.params.workspaceId : typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '');

  const list = (req: Request, res: Response) => {
    const workspace = getWorkspace(req);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const profile = store.getDefaultUserProfile();
    const context = typeof req.query.context === 'string' && contextKinds.has(req.query.context as PreferenceContextKind) ? req.query.context as PreferenceContextKind : undefined;
    const status = typeof req.query.status === 'string' && projectionStatuses.has(req.query.status as PreferenceProjectionStatus) ? req.query.status as PreferenceProjectionStatus : undefined;
    const projections = store.listPreferenceProjections(profile.id, workspace.id).filter(item => (!context || item.contextKind === context) && (!status || item.status === status));
    res.json({ profile, projections });
  };
  router.get('/preferences', list);

  router.get('/preferences/evidence', (req: Request, res: Response) => {
    const workspace = getWorkspace(req);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const profile = store.getDefaultUserProfile();
    const projectionId = typeof req.query.projectionId === 'string' ? req.query.projectionId : undefined;
    let evidence = store.listPreferenceEvidence(profile.id, workspace.id);
    if (projectionId) {
      const projection = store.listPreferenceProjections(profile.id, workspace.id).find(item => item.id === projectionId);
      if (!projection) return res.status(404).json({ error: 'Preference projection not found' });
      evidence = evidence.filter(item => item.dimension === projection.dimension && item.contextKind === projection.contextKind && item.candidateValue === projection.preferredValue);
    }
    res.json({ evidence });
  });

  const setLearning = (req: Request, res: Response) => {
    if (!getWorkspace(req)) return res.status(404).json({ error: 'Workspace not found' });
    if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    if (req.body.enabled) preferenceService.resumeLearning('default'); else preferenceService.pauseLearning('default');
    res.json({ profile: store.getDefaultUserProfile() });
  };
  router.post('/preferences/learning', setLearning);
  router.post('/preferences/pause', (req: Request, res: Response) => { req.body = { ...(req.body as Record<string, unknown>), enabled: false }; return setLearning(req, res); });

  const clear = (req: Request, res: Response) => {
    if (!getWorkspace(req)) return res.status(404).json({ error: 'Workspace not found' });
    preferenceService.clearLearning('default');
    res.json({ profile: store.getDefaultUserProfile(), projections: [] });
  };
  router.post('/preferences/clear', clear);

  router.post('/preferences/:projectionId/sleep', (req: Request, res: Response) => {
    const workspace = getWorkspace(req);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const projection = store.listPreferenceProjections('default', workspace.id).find(item => item.id === req.params.projectionId);
    if (!projection) return res.status(404).json({ error: 'Preference projection not found' });
    try { res.json({ projection: preferenceService.sleepProjection('default', projection.id) }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  router.get('/runs/:runId/preferences', (req: Request, res: Response) => {
    const workspace = getWorkspace(req);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const applications = store.listPreferenceApplications(workspace.id, run.id);
    const projections = store.listPreferenceProjections('default', workspace.id).filter(item => applications.some(application => application.projectionId === item.id));
    res.json({ runId: run.id, applications, projections });
  });

  return router;
}
