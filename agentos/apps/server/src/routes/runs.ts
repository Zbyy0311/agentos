import { Router, type Request, type Response } from 'express';
import type { AgentRunDetails, RuntimeArtifact } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';

export function createRunRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });

  router.get('/runs', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : '';
    if (!conversationId) return res.status(400).json({ error: 'conversationId is required' });
    res.json({ runs: store.listRuns(workspace.id, conversationId, parseRunLimit(req.query.limit)) });
  });

  router.get('/runs/:runId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const sourceMessage = store.getMessage(workspace.id, run.sourceMessageId);
    if (!sourceMessage) return res.status(404).json({ error: 'Run source message not found' });
    const details: AgentRunDetails = {
      run,
      sourceMessage,
      executions: store.listExecutions(workspace.id, run.conversationId).filter(execution => execution.runId === run.id),
      events: store.listAgentEvents(workspace.id, run.id),
      cliInvocations: store.listRunCliInvocations(workspace.id, run.id),
      fileChanges: store.listRunFileChanges(workspace.id, run.id),
      // `originalPath` is an internal provenance field.  It may be useful to
      // storage and collection code, but it is not part of the public Run
      // Details DTO: exposing it would disclose a local filesystem path.
      artifacts: store.listRuntimeArtifacts(workspace.id, run.id).map(toPublicRuntimeArtifact),
      usedMemories: store.listMemoryUsage(workspace.id, run.id),
      preferenceApplications: store.listPreferenceApplications(workspace.id, run.id),
      steps: store.listRunSteps(workspace.id, run.id),
    };
    res.json(details);
  });

  return router;
}

function toPublicRuntimeArtifact(artifact: RuntimeArtifact): RuntimeArtifact {
  const { originalPath: _originalPath, ...publicArtifact } = artifact;
  return publicArtifact;
}

function parseRunLimit(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : 20;
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(100, Math.max(1, parsed));
}
