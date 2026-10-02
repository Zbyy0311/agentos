import { Router, type Request, type Response } from 'express';

import { MEMORY_CANDIDATE_OUTCOMES, type MemoryCandidateOutcome, type MemoryRetrievalContext } from '@agentos/shared';
import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { MemoryEntryRepository, type CreateMemoryEntryInput, type MemoryEntryRecord, type UpdateMemoryEntryInput } from '../store/MemoryEntryRepository.js';
import { MemoryCandidateRepository, type MemoryCandidateEdits } from '../store/MemoryCandidateRepository.js';
import { MemoryContextSnapshotRepository } from '../store/MemoryContextSnapshotRepository.js';
import { areMemoryTextFieldsSafe } from '../store/MemoryContentSafety.js';
import { MemoryRetrievalService } from '../services/MemoryRetrievalService.js';
import { createMemoryRetrievalRuntime, memoryRetrievalRuntimeConfigFromEnvironment, type MemoryRetrievalRuntimeConfig } from '../services/MemoryRetrievalRuntime.js';
import { createEntityId } from '../store/Identity.js';
import { inTransaction } from '../store/Transaction.js';
import { deriveWorkspaceEventContext } from '../store/WorkspaceEventWriter.js';
import { hashMemoryText, normalizeMemoryText } from '../services/MemoryCandidateGenerationService.js';
import { listMemoryContexts, MEMORY_CONTEXT_KINDS, type MemoryContextKind } from '../services/MemoryContextProjection.js';
import { MemoryLifecycleService, type MemoryLifecycleInput } from '../services/MemoryLifecycleService.js';
import { MemoryWorkspaceKnowledgePromotionError, MemoryWorkspaceKnowledgePromotionService } from '../services/MemoryWorkspaceKnowledgePromotionService.js';

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
  if (/NOT_RESOLVABLE|NOT_REVIEWABLE|NOT_UPDATABLE|CONFLICT/.test(code) && !/NOT_FOUND/.test(code)) return { status: 409, code };
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

export function createMemoryRuntimeRoutes(store: SqliteStore, workspaceManager: WorkspaceManager, semanticConfig?: MemoryRetrievalRuntimeConfig): Router {
  const router = Router({ mergeParams: true });

  const entries = new MemoryEntryRepository(store.getDatabase());
  const workspacePromotion = new MemoryWorkspaceKnowledgePromotionService(store, { entries });
  const candidates = new MemoryCandidateRepository(store.getDatabase());
  const snapshots = new MemoryContextSnapshotRepository(store.getDatabase());
  const runtime = createMemoryRetrievalRuntime(store.getDatabase(), semanticConfig ?? memoryRetrievalRuntimeConfigFromEnvironment());
  const retrieval = runtime.retrieval;

  const requireWorkspace = (req: Request, res: Response) => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      res.status(404).json({ error: 'Workspace not found' });
      return null;
    }
    return workspace;
  };

  // Project knowledge manages the same Entries the Run/chat selectors read.
  router.get('/memory/contexts', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req,res);
    if (!workspace) return;
    const { kind, ownerId } = req.query;
    if ((kind !== undefined && !(MEMORY_CONTEXT_KINDS as readonly unknown[]).includes(kind))
      || (ownerId !== undefined && !nonBlank(ownerId))) {
      res.status(400).json({ error:'MEMORY_CONTEXT_INPUT_INVALID' }); return;
    }
    try { res.json({ contexts:listMemoryContexts(store.getDatabase(),workspace.id,kind as MemoryContextKind|undefined,ownerId as string|undefined) }); }
    catch (error) { fail(res,error); }
  });

  router.get('/memory/entries', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const { status, category, query } = req.query;
    if ([status, category, query].some(value => value !== undefined && typeof value !== 'string')) {
      res.status(400).json({ error: 'MEMORY_ENTRY_INPUT_INVALID' }); return;
    }
    try {
      res.json({ entries: entries.listEntries(workspace.id, {
        ...(status === undefined ? {} : { status: status as MemoryEntryRecord['status'] | 'all' }),
        ...(category === undefined ? {} : { category: category as MemoryEntryRecord['category'] }),
        ...(query === undefined ? {} : { query: query as string }),
      }) });
    } catch (error) { fail(res, error); }
  });

  router.get('/memory/entries/:entryId', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const entry = entries.findById(workspace.id, req.params.entryId)
      ?? entries.listConfirmedGlobalPreferences(workspace.id).find(item => item.id === req.params.entryId);
    if (entry === undefined) { res.status(404).json({ error: 'MEMORY_ENTRY_NOT_FOUND' }); return; }
    res.json({ entry });
  });

  router.post('/memory/entries/:entryId/promote-to-workspace-knowledge', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    if (!workspace.memoryEnabled) { res.status(409).json({ error: 'WORKSPACE_MEMORY_DISABLED' }); return; }
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some(key => key !== 'expectedVersion')
      || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
      res.status(400).json({ error: 'MEMORY_WORKSPACE_PROMOTION_INPUT_INVALID' }); return;
    }
    try {
      const result = workspacePromotion.promote({
        workspaceId: workspace.id,
        entryId: req.params.entryId,
        expectedVersion: body.expectedVersion as number,
        promotedAt: new Date().toISOString(),
      });
      res.status(result.outcome === 'created' ? 201 : 200).json(result);
    } catch (error) {
      if (error instanceof MemoryWorkspaceKnowledgePromotionError) {
        const status = error.code === 'ENTRY_NOT_FOUND' ? 404
          : error.code === 'VERSION_CONFLICT' || error.code === 'ENTRY_NOT_PROMOTABLE' || error.code === 'ENTRY_QUARANTINED' ? 409
            : error.code === 'INPUT_INVALID' ? 400 : error.code === 'SOURCE_INVALID' ? 422 : 500;
        res.status(status).json({ error: error.code });
        return;
      }
      res.status(500).json({ error: 'MEMORY_WORKSPACE_PROMOTION_FAILED' });
    }
  });

  const appendEditEvent = (entry: MemoryEntryRecord, timestamp: string, type: 'memory.entry_updated' | 'memory.entry_archived') => {
    const origin = { kind: 'memory.entry_edit', entryId: entry.id, entryVersion: entry.version } as const;
    store.workspaceEventWriter().appendWithinTransaction({
      type, workspaceId: entry.workspaceId, timestamp, origin, context: deriveWorkspaceEventContext(origin),
      payload: { memoryEntryId: entry.id, version: entry.version, scope: entry.scope, category: entry.category, authority: entry.authority },
    });
  };

  router.patch('/memory/entries/:entryId', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    if (!workspace.memoryEnabled) { res.status(409).json({ error: 'WORKSPACE_MEMORY_DISABLED' }); return; }
    const body = req.body;
    const keys = ['title', 'summary', 'content', 'tags', 'category', 'confidence', 'importance', 'pinned'];
    if (!isPlainRecord(body) || Object.keys(body).some(key => key !== 'expectedVersion' && !keys.includes(key))
      || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1
      || !keys.some(key => Object.prototype.hasOwnProperty.call(body, key))
      || keys.some(key => Object.prototype.hasOwnProperty.call(body, key) && body[key] === null)) {
      res.status(400).json({ error: 'MEMORY_ENTRY_INPUT_INVALID' }); return;
    }
    try {
      const updatedAt = new Date().toISOString();
      const entry = inTransaction(store.getDatabase(), () => {
        const record = entries.updateEntryWithinTransaction({ ...body, workspaceId: workspace.id,
          entryId: req.params.entryId, updatedAt } as unknown as UpdateMemoryEntryInput);
        appendEditEvent(record, updatedAt, 'memory.entry_updated');
        return record;
      });
      res.json({ entry });
    } catch (error) { fail(res, error); }
  });

  router.post('/memory/entries/:entryId/archive', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    if (!workspace.memoryEnabled) { res.status(409).json({ error: 'WORKSPACE_MEMORY_DISABLED' }); return; }
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some(key => key !== 'expectedVersion')
      || !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
      res.status(400).json({ error: 'MEMORY_ENTRY_INPUT_INVALID' }); return;
    }
    try {
      const updatedAt = new Date().toISOString();
      const entry = inTransaction(store.getDatabase(), () => {
        const current = entries.findById(workspace.id, req.params.entryId);
        if (current === undefined) throw new Error('MEMORY_ENTRY_NOT_FOUND');
        if (current.version !== body.expectedVersion) throw new Error('MEMORY_ENTRY_VERSION_CONFLICT');
        if (current.status !== 'active') throw new Error('MEMORY_ENTRY_NOT_UPDATABLE');
        const record = entries.updateStatusWithinTransaction({ workspaceId: workspace.id,
          entryId: current.id, expectedVersion: body.expectedVersion as number, status: 'archived', updatedAt });
        appendEditEvent(record, updatedAt, 'memory.entry_archived');
        return record;
      });
      res.json({ entry });
    } catch (error) { fail(res, error); }
  });

  // ---- Retrieval (read-only explanation surface) --------------------------
  router.post('/memory/entries/:entryId/lifecycle', (req:Request,res:Response)=>{
    const workspace=requireWorkspace(req,res);
    if(!workspace) return;
    if(!workspace.memoryEnabled) {res.status(409).json({error:'WORKSPACE_MEMORY_DISABLED'});return;}
    const body=req.body;
    if(!isPlainRecord(body)||Object.keys(body).some(key=>!['expectedVersion','action','validFrom','validUntil','expiresAt'].includes(key))) {
      res.status(400).json({error:'MEMORY_LIFECYCLE_INPUT_INVALID'});return;
    }
    try {
      const entry=new MemoryLifecycleService(store.getDatabase()).apply({...body,workspaceId:workspace.id,entryId:req.params.entryId} as unknown as MemoryLifecycleInput,
        (record,timestamp)=>appendEditEvent(record,timestamp,body.action==='archive'?'memory.entry_archived':'memory.entry_updated'));
      res.json({entry});
    } catch(error) {fail(res,error);}
  });

  // Preparation only sees server-selected, eligible Entries. Caller-authored
  // text and foreign owners cannot warm a workspace's derived vector cache.
  router.post('/memory/retrieve/prepare', async (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    if (!workspace.memoryEnabled) { res.status(409).json({ error: 'WORKSPACE_MEMORY_DISABLED' }); return; }
    const body = req.body;
    const allowed = ['query', 'limit', 'agentId', 'conversationId', 'taskId', 'runId', 'includeGlobal'];
    if (!isPlainRecord(body) || Object.keys(body).some(key => !allowed.includes(key))
      || !nonBlank(body.query) || body.query.length > 2000 || !areMemoryTextFieldsSafe([body.query])
      || (body.limit !== undefined && (!Number.isSafeInteger(body.limit) || (body.limit as number) < 1 || (body.limit as number) > 100))
      || (body.includeGlobal !== undefined && typeof body.includeGlobal !== 'boolean')
      || ['agentId', 'conversationId', 'taskId', 'runId'].some(key => body[key] !== undefined && !nonBlank(body[key]))) {
      res.status(400).json({ error: 'MEMORY_RETRIEVAL_INPUT_INVALID' }); return;
    }
    const { agentId, conversationId, taskId, runId } = body as Record<string, string | undefined>;
    const db = store.getDatabase();
    const run = runId === undefined ? undefined : store.runRepository().findById(workspace.id, runId);
    if ((agentId !== undefined && !workspace.agents.some(agent => agent.id === agentId))
      || (conversationId !== undefined && !db.prepare('SELECT 1 FROM cr_conversations WHERE workspace_id = ? AND id = ?').get(workspace.id, conversationId))
      || (taskId !== undefined && !store.taskRepository().findById(workspace.id, taskId))
      || (runId !== undefined && (run === undefined || (taskId !== undefined && run.taskId !== taskId)))) {
      res.status(404).json({ error: 'MEMORY_RETRIEVAL_OWNER_NOT_FOUND' }); return;
    }
    try {
      const result = await retrieval.retrievePrepared({
        context: { workspaceId: workspace.id, agentId, conversationId, taskId, runId,
          ...(typeof body.includeGlobal === 'boolean' ? { includeGlobal: body.includeGlobal } : {}) },
        query: body.query as string,
        limit: (body.limit as number | undefined) ?? 100,
      });
      res.json({ mode: runtime.mode, degraded: result.degraded,
        semantic: result.semantic ?? { degraded: false, reason: 'SEMANTIC_DISABLED', prepared: false, preparedEntryCount: 0 },
        eligibleCount: result.results.length });
    } catch (error) { fail(res, error); }
  });

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
        ...(result.semantic === undefined ? {} : { semantic: result.semantic }),
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
    if (!workspace.memoryEnabled) { res.status(409).json({ error: 'WORKSPACE_MEMORY_DISABLED' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const content = typeof body.content === 'string' ? body.content : '';
    if (title.length === 0 || content.length === 0) {
      res.status(400).json({ error: 'MEMORY_ENTRY_INPUT_INVALID' });
      return;
    }
    const summary = typeof body.summary === 'string' ? body.summary : '';
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === 'string')
      : [];
    if (!areMemoryTextFieldsSafe([title, summary, content, ...tags])) {
      res.status(400).json({ error: 'MEMORY_ENTRY_INPUT_INVALID' });
      return;
    }
    const confidence = body.confidence === undefined ? 1 : body.confidence;
    const importance = body.importance === undefined ? 0.5 : body.importance;
    if (!isUnitInterval(confidence) || !isUnitInterval(importance)) {
      res.status(400).json({ error: 'MEMORY_ENTRY_INPUT_INVALID' });
      return;
    }
    // This existing save surface has no owner-specific contract. Reject owner
    // claims rather than dropping them and saving into a broader scope.
    if (['ownerAgentId', 'ownerConversationId', 'ownerTaskId', 'ownerRunId']
      .some(key => body[key] !== undefined)) {
      res.status(400).json({ error: 'MEMORY_ENTRY_INPUT_INVALID' });
      return;
    }
    const scope = body.scope;
    const category = body.category;
    const now = new Date().toISOString();
    const exactHash = hashMemoryText(content);
    const normalizedHash = hashMemoryText(normalizeMemoryText(content));
    try {
      const db = store.getDatabase();
      const result = inTransaction(db, () => {
        // LITE-07-107: invalid input must not become valid because its content
        // happens to match an existing Entry. Do not silently discard malformed sources.
        const input = entries.validateCreateInput({
          id: createEntityId('memory'),
          workspaceId: workspace.id,
          scope: scope as never,
          category: category as never,
          authority: 'user-explicit',
          confidence, importance, title, content,
          ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
          ...(body.tags === undefined ? {} : { tags: body.tags as CreateMemoryEntryInput['tags'] }),
          status: 'active',
          exactContentHash: exactHash,
          normalizedTextHash: normalizedHash,
          tokenEstimate: Math.max(1, Math.ceil(('### ' + title + '\n' + content).length / 4)),
          sources: (body.sources === undefined ? [] : body.sources) as CreateMemoryEntryInput['sources'],
          createdAt: now,
        });
        const append = (type: 'memory.entry_created' | 'memory.entry_deduplicated', entry: MemoryEntryRecord) => {
          const origin = { kind: 'memory.entry_save', entryId: entry.id, entryVersion: entry.version } as const;
          store.workspaceEventWriter().appendWithinTransaction({
            type, workspaceId: workspace.id, timestamp: now, origin,
            context: deriveWorkspaceEventContext(origin),
            payload: { memoryEntryId: entry.id, version: entry.version,
              scope: entry.scope, category: entry.category, authority: entry.authority },
          });
        };
        const exactId = candidates.findEntryByExactHash(workspace.id, exactHash, input);
        if (exactId !== undefined) {
          const existing = entries.findById(workspace.id, exactId)!;
          if (input.sources.length === 0) return { entry: existing, converged: true };
          const merged = entries.mergeExactSourcesWithinTransaction({ ...input, entryId: exactId,
            exactContentHash: exactHash, updatedAt: now });
          if (merged !== undefined) {
            if (merged.changed) append('memory.entry_deduplicated', merged.record);
            return { entry: merged.record, converged: true };
          }
        }
        // Preserve the existing normalized-text save behavior within the exact
        // ownership boundary. Provenance-bearing near-duplicates remain a separate gap.
        const normalizedId = candidates.findEntryByNormalizedHash(workspace.id, normalizedHash, input);
        if (normalizedId !== undefined) {
          return { entry: entries.findById(workspace.id, normalizedId)!, converged: true };
        }
        const entry = entries.createEntryWithinTransaction(input);
        append('memory.entry_created', entry);
        return { entry, converged: false };
      });
      res.status(result.converged ? 200 : 201).json(result);
    } catch (error) {
      fail(res, error);
    }
  });

  // ---- Conflict resolution (transactional write) ---------------------------

  router.get('/memory/conflicts', (req: Request, res: Response) => {
    const workspace = requireWorkspace(req, res);
    if (!workspace) return;
    const status = req.query.status ?? 'open';
    if (typeof status !== 'string' || !['open', 'resolved', 'all'].includes(status)) {
      res.status(400).json({ error: 'MEMORY_CONFLICT_INPUT_INVALID' }); return;
    }
    try {
      res.json({ conflicts: candidates.listConflicts(workspace.id, status as 'open' | 'resolved' | 'all') });
    } catch (error) { fail(res, error); }
  });

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
