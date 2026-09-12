import { Router, type Request, type Response } from 'express';

import { MEMORY_CANDIDATE_OUTCOMES, type MemoryCandidateOutcome, type MemoryRetrievalContext } from '@agentos/shared';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryEntryRepository } from '../store/MemoryEntryRepository.js';
import { MemoryCandidateRepository, type MemoryCandidateEdits } from '../store/MemoryCandidateRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { MemoryRetrievalService } from '../services/MemoryRetrievalService.js';
import { createEntityId } from '../store/Identity.js';
import { inTransaction } from '../store/Transaction.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';
import { hashMemoryText, normalizeMemoryText } from '../services/MemoryCandidateGenerationService.js';

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
 *   POST /memory/entries                        MF-2 explicit user save: one
 *                                                forward Entry + one
 *                                                `memory.entry_created` Event
*
* Boundary notes:
* - Retrieval is a pure read: it never persists a Context Snapshot. Budget
*   selection + snapshot freeze are bound to Run startup (PR #92); the frozen
*   result is exposed through the two snapshot routes.
 * - Conflict resolution, Candidate review, and explicit user save each commit
 *   their fact and their Workspace Events in ONE transaction through the MF-5
 *   Workspace Event stream (PR #127/#128 + the entry-save amendment #136); a
 *   user-initiated write has no Run scope, so it goes to the Workspace stream,
 *   never to `runtime_events`, Outbox, or `operations`.
 * - Forward Candidate paths live under /memory/ because the literal Lite
 *   section-14 /memory-candidates paths are held by the COMPATIBILITY router.
 * - This router never spawns a Process or touches Provider credentials. Candidate
 *   review can promote an Entry or append source evidence transactionally.
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

function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
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

interface ReviewBody {
  readonly expectedVersion: number;
  readonly outcome: MemoryCandidateOutcome;
  readonly mergedIntoEntryId?: string;
  readonly edits?: MemoryCandidateEdits;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseReviewBody(value: unknown): ReviewBody | undefined {
  if (!isPlainRecord(value)) return undefined;
  const allowedKeys = new Set(['expectedVersion', 'outcome', 'mergedIntoEntryId', 'edits']);
  if (Object.keys(value).some(key => !allowedKeys.has(key))) return undefined;
  if (!Number.isSafeInteger(value.expectedVersion) || (value.expectedVersion as number) < 1) return undefined;
  if (!isOutcome(value.outcome)) return undefined;

  const hasMergedTarget = Object.prototype.hasOwnProperty.call(value, 'mergedIntoEntryId');
  const hasEdits = Object.prototype.hasOwnProperty.call(value, 'edits');
  let mergedIntoEntryId: string | undefined;
  if (value.outcome === 'merge-with-existing') {
    if (!hasMergedTarget || !nonBlank(value.mergedIntoEntryId)) return undefined;
    mergedIntoEntryId = value.mergedIntoEntryId;
  } else if (hasMergedTarget) {
    return undefined;
  }

  let edits: MemoryCandidateEdits | undefined;
  if (value.outcome === 'edit-and-accept') {
    if (!hasEdits) return undefined;
    edits = parseReviewEdits(value.edits);
    if (edits === undefined) return undefined;
  } else if (hasEdits) {
    return undefined;
  }

  return {
    expectedVersion: value.expectedVersion as number,
    outcome: value.outcome,
    ...(mergedIntoEntryId === undefined ? {} : { mergedIntoEntryId }),
    ...(edits === undefined ? {} : { edits }),
  };
}

function parseReviewEdits(value: unknown): MemoryCandidateEdits | undefined {
  if (!isPlainRecord(value)) return undefined;
  const allowedKeys = new Set(['title', 'summary', 'content', 'tags']);
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some(key => !allowedKeys.has(key))) return undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'title') && !nonBlank(value.title)) return undefined;
  for (const key of ['summary', 'content'] as const) {
    if (Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] !== 'string') return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'tags')) {
    if (!Array.isArray(value.tags) || value.tags.some(tag => !nonBlank(tag))) return undefined;
    if (new Set(value.tags).size !== value.tags.length) return undefined;
  }
  return value as MemoryCandidateEdits;
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

  // ---- Explicit user save (MF-2 trigger; entry-save amendment) --------------
  // Creates a forward Memory Entry and emits `memory.entry_created` on the
  // Workspace stream in the SAME transaction, so a user-initiated save is a
  // committed Workspace-scoped Memory fact with its canonical Event.
  router.post('/memory/entries', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.content === 'string' ? body.content : '';
    if (title.length === 0 || content.length === 0) {
      res.status(400).json({ error: 'MEMORY_ENTRY_INPUT_INVALID' });
      return;
    }
    const confidence = body.confidence === undefined ? 1 : body.confidence;
    const importance = body.importance === undefined ? 0.5 : body.importance;
    if (!isUnitInterval(confidence) || !isUnitInterval(importance)) {
      res.status(400).json({ error: 'MEMORY_ENTRY_INPUT_INVALID' });
      return;
    }
    const scope = body.scope;
    const category = body.category;
    const now = new Date().toISOString();
    const exactHash = hashMemoryText(content);
    const normalizedHash = hashMemoryText(normalizeMemoryText(content));
    try {
      // Dedup convergence (MF2T-03): an exact or normalized near-duplicate save
      // returns the existing Entry without a second row or a second Event.
      const existingId =
        candidates.findEntryByExactHash(workspace.id, exactHash) ??
        candidates.findEntryByNormalizedHash(workspace.id, normalizedHash);
      if (existingId !== undefined) {
        const existing = entries.findById(workspace.id, existingId);
        if (existing !== undefined) {
          res.json({ entry: existing, converged: true });
          return;
        }
      }

      const db = store.getDatabase();
      const entry = inTransaction(db, () => {
        const created = entries.createEntryWithinTransaction({
          id: createEntityId('memory'),
          workspaceId: workspace.id,
          scope: scope as never,
          category: category as never,
          authority: 'user-explicit',
          confidence, importance, title, content,
          ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
          ...(Array.isArray(body.tags) ? { tags: (body.tags as unknown[]).filter((t): t is string => typeof t === 'string') } : {}),
          status: 'active',
          exactContentHash: exactHash,
          normalizedTextHash: normalizedHash,
          sources: Array.isArray(body.sources)
            ? (body.sources as unknown[]).filter((s): s is { kind: never; id: string } =>
                typeof s === 'object' && s !== null && typeof (s as Record<string, unknown>).id === 'string')
            : [],
          createdAt: now,
        });
        const origin = { kind: 'memory.entry_save', entryId: created.id, entryVersion: created.version } as const;
        store.workspaceEventWriter().appendWithinTransaction({
          type: 'memory.entry_created',
          workspaceId: workspace.id,
          timestamp: now,
          origin,
          context: deriveWorkspaceEventContext(origin),
          payload: {
            memoryEntryId: created.id, version: created.version,
            scope: created.scope, category: created.category, authority: created.authority,
          },
        });
        return created;
      });
      res.status(201).json({ entry, converged: false });
    } catch (error) {
      fail(res, error);
    }
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
    const body = parseReviewBody(req.body);
    if (body === undefined) {
      res.status(400).json({ error: 'MEMORY_CANDIDATE_INPUT_INVALID' });
      return;
    }
    try {
      const candidate = candidates.reviewCandidate({
        workspaceId: workspace.id,
        candidateId: req.params.candidateId,
        expectedVersion: body.expectedVersion,
        outcome: body.outcome,
        ...(body.mergedIntoEntryId === undefined ? {} : { mergedIntoEntryId: body.mergedIntoEntryId }),
        ...(body.edits === undefined ? {} : { edits: body.edits }),
        reviewedAt: new Date().toISOString(),
      }, { writer: store.workspaceEventWriter() });
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
      }, { writer: store.workspaceEventWriter() });
      res.json({ conflict });
    } catch (error) {
      fail(res, error);
    }
  });

  return router;
}
