import { Router, type Request, type Response } from 'express';

import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { createEntityId } from '../store/Identity.js';
import { inTransaction } from '../store/Transaction.js';
import { ArtifactCompletionRepository, type ArtifactCompletionConclusion } from '../store/ArtifactCompletionRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { hashMemoryText, normalizeMemoryText } from '../services/MemoryCandidateGenerationService.js';

/**
 * MF-2 review/test Artifact trigger (forward surface): durably record that a
 * review or test Artifact was completed, and generate one review-required
 * Memory Candidate capturing the conclusion as evidence, in the SAME
 * transaction. Only `review` and `test` Artifact types may complete; the
 * record is immutable once written and carries no secret value or raw output.
 */

const CONCLUSIONS = new Set<string>(['approved', 'changes_requested', 'pass', 'fail']);
const ARTIFACT_TYPES = new Set<string>(['review', 'test']);

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

export function createArtifactCompletionRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });
  const completions = new ArtifactCompletionRepository(store.getDatabase());
  const candidates = new MemoryCandidateRepository(store.getDatabase());

  const requireWorkspace = (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return null;
    }
    return workspace;
  };

  router.get('/artifact-completions', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    res.json({ completions: completions.listForWorkspace(workspace.id) });
  });

  router.post('/artifact-completions', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const artifactId = typeof body.artifactId === 'string' ? body.artifactId.trim() : '';
    const artifactType = typeof body.artifactType === 'string' ? body.artifactType : '';
    const conclusion = typeof body.conclusion === 'string' ? body.conclusion : '';
    if (artifactId === '' || !ARTIFACT_TYPES.has(artifactType) || !CONCLUSIONS.has(conclusion)) {
      res.status(400).json({ error: 'ARTIFACT_COMPLETION_INPUT_INVALID' });
      return;
    }
    const now = new Date().toISOString();
    try {
      const result = inTransaction(store.getDatabase(), () => {
        const record = completions.recordCompletion({
          id: createEntityId('artifact'),
          workspaceId: workspace.id,
          artifactId,
          artifactType: artifactType as 'review' | 'test',
          ...(typeof body.runId === 'string' ? { runId: body.runId } : {}),
          conclusion: conclusion as ArtifactCompletionConclusion,
          decidedAt: typeof body.decidedAt === 'string' ? body.decidedAt : now,
          createdAt: now,
        });
        const content = truncate([
          `结论：${record.conclusion}`,
          `Artifact：${record.artifactId}（${record.artifactType}）`,
          record.runId === null ? '' : `Run：${record.runId}`,
        ].filter(Boolean).join('\n'), 12000);
        const candidate = candidates.createCandidateWithinTransaction({
          id: createEntityId('memoryCandidate'),
          workspaceId: workspace.id,
          scope: 'workspace',
          category: 'decision',
          authority: 'user-explicit',
          confidence: 0.6,
          importance: 0.5,
          title: truncate(`评审/测试结论：${record.artifactType}（${record.conclusion}）`, 200),
          summary: truncate(`一个 ${record.artifactType} Artifact 已完成，结论为 ${record.conclusion}。`, 1000),
          content,
          exactContentHash: hashMemoryText(content),
          normalizedTextHash: hashMemoryText(normalizeMemoryText(content)),
          tokenEstimate: Math.max(1, Math.ceil(content.length / 4)),
          sources: record.runId === null ? [] : [{ kind: 'run' as const, id: record.runId }],
          createdAt: now,
          minConfidence: 0.9,
          maxTokenEstimate: 4000,
        });
        return { completion: record, candidate };
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
