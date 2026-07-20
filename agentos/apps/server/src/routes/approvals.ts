import { Router, type Request, type Response } from 'express';
import type { ApprovalDecision, AgentProvider } from '@agentos/shared';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { SqliteStore } from '../store/SqliteStore.js';
import { ApprovalRegistry } from '../services/ApprovalRegistry.js';
import { classifyToolRisk } from '../services/ToolRiskClassifier.js';

const decisions: ApprovalDecision[] = ['allow_once', 'allow_run', 'allow_conversation', 'deny'];

export function createApprovalRoutes(store: SqliteStore, workspaceManager: WorkspaceManager, registry = new ApprovalRegistry()): Router {
  const router = Router({ mergeParams: true });
  router.post('/runs/:runId/approvals', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const run = store.getRun(workspace.id, req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const body = req.body as Record<string, unknown>;
    const toolName = typeof body.toolName === 'string' ? body.toolName.trim() : '';
    if (!toolName) return res.status(400).json({ error: 'toolName is required' });
    const affectedPaths = Array.isArray(body.affectedPaths) ? body.affectedPaths.filter((value): value is string => typeof value === 'string').slice(0, 64) : [];
    const request = registry.createRequest({ workspaceId: workspace.id, runId: run.id, executionId: String(body.executionId ?? ''), agentId: String(body.agentId ?? ''), provider: isProvider(body.provider) ? body.provider : 'custom', providerVersion: typeof body.providerVersion === 'string' ? body.providerVersion : undefined, sanitizedConfigHash: String(body.sanitizedConfigHash ?? ''), toolName, actionFingerprint: String(body.actionFingerprint ?? `${toolName}:${affectedPaths.join(',')}`), riskLevel: classifyToolRisk({ toolName, commandSummary: typeof body.commandSummary === 'string' ? body.commandSummary : undefined, affectedPaths }), commandSummary: typeof body.commandSummary === 'string' ? body.commandSummary : undefined, affectedPaths });
    return res.status(201).json({ request });
  });

  router.post('/approvals/:approvalId/resolve', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const request = registry.getRequest(req.params.approvalId);
    if (!request || request.workspaceId !== workspace.id) return res.status(404).json({ error: 'Approval request not found' });
    const decision = req.body?.decision;
    if (!decisions.includes(decision)) return res.status(400).json({ error: 'decision is invalid' });
    try { registry.resolveRequest(request.id, decision); } catch (error) { return res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
    return res.json({ request, decision });
  });

  router.post('/approval-grants', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const body = req.body as Record<string, unknown>;
    const grant = registry.createGrant({ workspaceId: workspace.id, conversationId: String(body.conversationId ?? ''), provider: isProvider(body.provider) ? body.provider : 'custom', providerVersion: typeof body.providerVersion === 'string' ? body.providerVersion : undefined, sanitizedConfigHash: String(body.sanitizedConfigHash ?? ''), toolPattern: String(body.toolPattern ?? '*'), actionFingerprint: String(body.actionFingerprint ?? ''), maximumRisk: body.maximumRisk === 'low' || body.maximumRisk === 'medium' || body.maximumRisk === 'high' ? body.maximumRisk : 'low', expiresAt: String(body.expiresAt ?? new Date(Date.now() + 3600_000).toISOString()) });
    return res.status(201).json({ grant });
  });

  router.get('/approval-grants', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    return res.json({ grants: registry.listGrants(workspace.id) });
  });

  router.post('/approval-grants/:grantId/revoke', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const grant = registry.getGrant(req.params.grantId);
    if (!grant || grant.workspaceId !== workspace.id) return res.status(404).json({ error: 'Approval grant not found' });
    return res.json({ grant: registry.revokeGrant(grant.id) });
  });
  router.delete('/approval-grants/:grantId', (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
    const grant = registry.getGrant(req.params.grantId);
    if (!grant || grant.workspaceId !== workspace.id) return res.status(404).json({ error: 'Approval grant not found' });
    return res.json({ grant: registry.revokeGrant(grant.id) });
  });
  return router;
}

function isProvider(value: unknown): value is AgentProvider {
  return value === 'codex' || value === 'kimi' || value === 'opencode' || value === 'mimo' || value === 'custom';
}
