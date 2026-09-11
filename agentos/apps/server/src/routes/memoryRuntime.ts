import { Router, type Request, type Response } from 'express';

import { MEMORY_CANDIDATE_OUTCOMES, type MemoryCandidateOutcome, type MemoryRetrievalContext } from '@agentos/shared';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryCandidateRepository } from '../store/MemoryCandidateRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { MemoryRetrievalService } from '../services/MemoryRetrievalService.js';

/**
 * MF-5 forward Memory API surface (Lite 11-API-Specification section 14).
 *
 * Workspace-scoped under the app's existing /api/workspaces/:workspaceId mount,
 * mirroring the Conversation Runtime precedent; the legacy /memories and
 * /memory-candidates routers remain COMPATIBILITY and are untouched.
 *
 *   POST /memory/retrieve                        MF-3 retrieval + reasons (read-only)
 *   GET  /runs/:runId/memory-context             every frozen Context Snapshot of a Run
 *   GET  /memory-contexts/:memoryContextId       one frozen Context Snapshot
 *   POST /memory-conflicts/:conflictId/resolve   MF-2 transactional conflict resolution
 *   GET  /memory/candidates                      forward Candidate queue (MF-2 tables)
 *   POST /memory/candidates/:candidateId/review  version-guarded review (accept /
 *                                                edit-and-accept / reject /
 *                                                merge-with-existing)
 *
 * Boundary notes:
 * - Retrieval is a pure read: it never persists a Context Snapshot. Budget
 *   selection + snapshot freeze are bound to Run startup (PR #92); the frozen
 *   result is exposed through the two snapshot routes.
 * - Conflict resolution commits through the MF-2 repository in one
 *   transaction. Canonical Memory Event emission is Run-scoped
 *   (MemoryRuntimeEventEmitter requires a Run + L1C event context); a
 *   user-initiated resolution has no Run scope, so this route records the
 *   fact without emitting a canonical Event. That contract gap is recorded in
 *   MF-progress.md. The same applies to user-initiated Candidate review.
 * - Forward Candidate paths live under /memory/ because the literal Lite
 *   section-14 /memory-candidates paths are held by the COMPATIBILITY router.
 * - This router never spawns a Process, never touches Provider credentials,
 *   and never mutates an Entry.
 */

interface ErrorMapping { readonly status: number; readonly code: string }

function mapError(error: unknown): ErrorMapping {
  const code = error instanceof Error ? (error as { code?: string }).code ?? error.message : String(error);
  if (/NOT_FOUND/.test(code)) return { status: 404, code };
  if (/NOT_RESOLVABLE|NOT_REVIEWABLE|CONFLICT/.test(code) && !/NOT_FOUND/.test(code)) return { status: 409, code };
  if (/INPUT_INVALID|INVALID/.test(code)) return { status: 400, code };
  return { status: 500, code };
}

function fail(res: Response, error: unknown): void {
  const mapped = mapError(error);
  res.status(mapped.status).json({ error: mapped.code });
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value: unknown): string | undefined {
  return nonBlank(value) ? value : undefined;
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(nonBlank);
  return items.length > 0 ? items : undefined;
}

function isOutcome(value: unknown): value is MemoryCandidateOutcome {
  return (MEMORY_CANDIDATE_OUTCOMES as readonly unknown[]).includes(value);
}

export function createMemoryRuntimeRoutes(store: SqliteStore, workspaceManager: WorkspaceManager): Router {
  const router = Router({ mergeParams: true });

  const entries = new MemoryEntryRepository(store.getDatabase());
  const candidates = new MemoryCandidateRepository(store.getDatabase());
  const snapshots = new MemoryContextSnapshotRepository(store.getDatabase());
  const retrieval = new MemoryRetrievalService(entries);

  const requireWorkspace = (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return null;
    }
    return workspace;
  };

  // ---- Retrieval (read-only explanation surface) --------------------------

  router.post('/memory/retrieve', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.query !== undefined && typeof body.query !== 'string') {
      res.status(400).json({ error: 'MEMORY_RETRIEVAL_INPUT_INVALID' });
      return;
    }
    if (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || (body.limit as number) < 1)) {
      res.status(400).json({ error: 'MEMORY_RETRIEVAL_INPUT_INVALID' });
      return;
    }
    const context: MemoryRetrievalContext = {
      workspaceId: workspace.id,
      ...(optionalString(body.agentId) === undefined ? {} : { agentId: optionalString(body.agentId) }),
      ...(optionalString(body.conversationId) === undefined ? {} : { conversationId: optionalString(body.conversationId) }),
      ...(optionalString(body.taskId) === undefined ? {} : { taskId: optionalString(body.taskId) }),
      ...(optionalString(body.runId) === undefined ? {} : { runId: optionalString(body.runId) }),
      ...(typeof body.includeGlobal === 'boolean' ? { includeGlobal: body.includeGlobal } : {}),
    };
    try {
      const result = retrieval.retrieveWithStatus({
        context,
        ...(typeof body.query === 'string' ? { query: body.query } : {}),
        ...(optionalStringArray(body.categoryFilter) === undefined
          ? {}
          : { categoryFilter: optionalStringArray(body.categoryFilter) }),
        ...(optionalStringArray(body.tagFilter) === undefined
          ? {}
          : { tagFilter: optionalStringArray(body.tagFilter) }),
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
      });
      res.json({
        degraded: result.degraded,
        results: result.results,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  // ---- Frozen Context Snapshots -------------------------------------------

  router.get('/runs/:runId/memory-context', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const run = store.runRepository().findById(workspace.id, req.params.runId);
    if (run === undefined) {
      res.status(404).json({ error: 'RUN_NOT_FOUND' });
      return;
    }
    res.json({ snapshots: snapshots.listForRun(workspace.id, req.params.runId) });
  });

  router.get('/memory-contexts/:memoryContextId', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const snapshot = snapshots.findById(workspace.id, req.params.memoryContextId);
    if (snapshot === undefined) {
      res.status(404).json({ error: 'MEMORY_CONTEXT_SNAPSHOT_NOT_FOUND' });
      return;
    }
    res.json({ snapshot });
  });

  // ---- Conflict resolution (transactional write) ---------------------------

  // ---- Forward Candidate queue (MF-2 tables) -------------------------------

  router.get('/memory/candidates', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const outcomeParam = req.query.outcome;
    let outcome: MemoryCandidateOutcome | undefined;
    if (outcomeParam !== undefined) {
      if (typeof outcomeParam !== 'string' || !isOutcome(outcomeParam)) {
        res.status(400).json({ error: 'MEMORY_CANDIDATE_INPUT_INVALID' });
        return;
      }
      outcome = outcomeParam;
    }
    res.json({ candidates: candidates.listCandidates(workspace.id, outcome) });
  });

  router.post('/memory/candidates/:candidateId/review', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const candidate = candidates.reviewCandidate({
        workspaceId: workspace.id,
        candidateId: req.params.candidateId,
        expectedVersion: body.expectedVersion as number,
        outcome: body.outcome as MemoryCandidateOutcome,
        ...(nonBlank(body.mergedIntoEntryId) ? { mergedIntoEntryId: body.mergedIntoEntryId as string } : {}),
        reviewedAt: new Date().toISOString(),
      });
      res.json({ candidate });
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/memory-conflicts/:conflictId/resolve', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const conflict = candidates.resolveConflict({
        workspaceId: workspace.id,
        conflictId: req.params.conflictId,
        expectedVersion: body.expectedVersion as number,
        disposition: body.disposition as never,
        resolvedAt: new Date().toISOString(),
      });
      res.json({ conflict });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
