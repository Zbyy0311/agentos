import { Router, type Request, type Response } from 'express';
import type { AgentRunDetails } from '@agentos/shared';
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
      usedMemories: store.listMemoryUsage(workspace.id, run.id),
    };
    res.json(details);
  });

  return router;
}

function parseRunLimit(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : 20;
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(100, Math.max(1, parsed));
}
