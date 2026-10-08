import { Router, type Request, type Response } from 'express';

import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createEntityId } from '../store/Identity.js';
import { inTransaction } from '../store/Transaction.js';
import { ApprovalDecisionRepository, type ApprovalDecisionValue } from '../store/ApprovalDecisionRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { hashMemoryText, normalizeMemoryText } from '../services/MemoryCandidateGenerationService.js';

/**
 * MF-2 approval-decision trigger (forward surface): durably record an approval
 * decision and, when accepted, generate one review-required Memory Candidate
 * in the same transaction. The legacy `ApprovalRegistry` routes are
 * COMPATIBILITY and unchanged.
 *
 * The candidate carries the approval evidence only — ids, the decision, the
 * risk level, and the action fingerprint. No secret value, no raw tool output.
 */

const DECISIONS = new Set<string>(['allow_once', 'allow_run', 'allow_conversation', 'deny']);
const RISK_LEVELS = new Set<string>(['low', 'medium', 'high', 'critical']);

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

export function createApprovalDecisionRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const decisions = new ApprovalDecisionRepository(store.getDatabase());
  const candidates = new MemoryCandidateRepository(store.getDatabase());

  const requireWorkspace = (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return null;
    }
    return workspace;
  };

  router.get('/approval-decisions', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    res.json({ decisions: decisions.listForWorkspace(workspace.id) });
  });

  router.post('/approval-decisions', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const decision = typeof body.decision === 'string' ? body.decision : '';
    const riskLevel = typeof body.riskLevel === 'string' ? body.riskLevel : '';
    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const toolName = typeof body.toolName === 'string' ? body.toolName.trim() : '';
    const actionFingerprint = typeof body.actionFingerprint === 'string' ? body.actionFingerprint.trim() : '';
    if (!DECISIONS.has(decision) || !RISK_LEVELS.has(riskLevel)
      || agentId === '' || provider === '' || toolName === '' || actionFingerprint === '') {
      res.status(400).json({ error: 'APPROVAL_DECISION_INPUT_INVALID' });
      return;
    }
    const now = new Date().toISOString();
    try {
      const result = inTransaction(store.getDatabase(), () => {
        const record = decisions.recordDecision({
          id: createEntityId('approval'),
          workspaceId: workspace.id,
          ...(typeof body.runId === 'string' ? { runId: body.runId } : {}),
          ...(typeof body.approvalRequestId === 'string' ? { approvalRequestId: body.approvalRequestId } : {}),
          agentId, provider, toolName, actionFingerprint,
          riskLevel: riskLevel as 'low' | 'medium' | 'high' | 'critical',
          decision: decision as ApprovalDecisionValue,
          ...(typeof body.decidedBy === 'string' ? { decidedBy: body.decidedBy } : {}),
          decidedAt: typeof body.decidedAt === 'string' ? body.decidedAt : now,
          createdAt: now,
        });

        // Only an accepted decision generates a Candidate; a `deny` records the
        // durable row and nothing else.
        if (!ApprovalDecisionRepository.isAccepted(record.decision)) {
          return { decision: record, candidate: null };
        }
        const title = truncate(`审批决定：${record.toolName}（${record.decision}）`, 200);
        const content = truncate([
          `决定：${record.decision}`,
          `工具：${record.toolName}`,
          `风险等级：${record.riskLevel}`,
          `动作指纹：${record.actionFingerprint}`,
          `Provider：${record.provider}`,
          `Agent：${record.agentId}`,
          record.runId === null ? '' : `Run：${record.runId}`,
        ].filter(Boolean).join('\n'), 12000);
        // The outer inTransaction owns BEGIN/COMMIT, so the candidate write uses
        // the WithinTransaction variant — calling createCandidate would nest a
        // transaction and fail closed.
        const candidate = candidates.createCandidateWithinTransaction({
          id: createEntityId('memoryCandidate'),
          workspaceId: workspace.id,
          scope: 'workspace',
          category: 'decision',
          authority: 'user-explicit',
          confidence: 0.6,
          importance: 0.5,
          title,
          summary: truncate(`用户接受了 ${record.toolName} 的审批决定。`, 1000),
          content,
          exactContentHash: hashMemoryText(content),
          normalizedTextHash: hashMemoryText(normalizeMemoryText(content)),
          tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
          sources: record.runId === null ? [] : [{ kind: 'run' as const, id: record.runId }],
          createdAt: now,
          // Force review-required: the reviewer, never the trigger, decides.
          minConfidence: 0.9,
          maxTokenEstimate: 4000,
        });
        return { decision: record, candidate };
      });
      res.status(201).json(result);
    } catch (error) {
      const code = error instanceof Error ? (error as { code?: string }).code ?? error.message : String(error);
      const status = /INPUT_INVALID/.test(code) ? 400 : /NOT_FOUND/.test(code) ? 404 : 500;
      res.status(status).json({ error: code });
    }
  });

  return router;
}
