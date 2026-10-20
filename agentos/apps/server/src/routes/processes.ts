import { open } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';
import { Router, type Request, type Response } from 'express';
import type { ProcessStopResult } from '@agentos/process-runtime';

import type { SqliteStore } from '../store/SqliteStore.js';
import type { WorkspaceManager } from '../managers/WorkspaceManager.js';
import { sendProblem } from '../problemDetails.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Process Query/Control API (spec 05-Process-Runtime §86/§87, Raw Output
 * Artifact reads per §55). Read-only query routes never mutate, never spawn
 * and never force a Run status; the single control route is the minimal
 * graceful stop, owned by the ProcessCancelCoordinator and idempotent per
 * Process. Every route is scoped to the workspace in the path: a Process or
 * Run from another workspace is indistinguishable from a missing one.
 */

const OUTPUT_DEFAULT_LIMIT_BYTES = 64 * 1024;
const OUTPUT_MAX_LIMIT_BYTES = 1024 * 1024;
const EVENT_DEFAULT_LIMIT = 50;
const EVENT_MAX_LIMIT = 200;

export interface ProcessRoutesOptions {
  /** Restricted artifact sink root (the FileArtifactSink root). */
  readonly artifactRoot: string;
  /** §87 graceful stop via the ProcessCancelCoordinator (idempotent). */
  readonly stopProcess: (input: {
    readonly workspaceId: string;
    readonly processId: string;
    readonly reason?: string;
  }) => Promise<ProcessStopResult>;
  /**
   * In-memory fallback for a stream with no output artifact (§86 output
   * fallback marker). Optional: without it the response is an explicit,
   * marked empty page instead of a guessed buffer.
   */
  readonly memoryOutputReader?: (input: {
    readonly workspaceId: string;
    readonly processId: string;
    readonly stream: 'stdout' | 'stderr';
    readonly offsetBytes: number;
    readonly maxBytes: number;
  }) => { readonly text: string; readonly retainedBytes: number } | null | undefined;
}

function parseNonNegativeInteger(raw: unknown): number | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** Resolve a managed sink key inside the artifact root; never a client path. */
function artifactPathFor(artifactRoot: string, storageKey: string): string | null {
  const segments = storageKey.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null;
  const root = resolve(artifactRoot);
  const path = resolve(join(root, ...segments));
  if (path !== root && !path.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
  return normalize(path);
}

export function createProcessRoutes(
  store: SqliteStore,
  workspaceManager: WorkspaceManager,
  options: ProcessRoutesOptions,
): Router {
  const router = Router({ mergeParams: true });

  const workspaceOrProblem = (req: Request, res: Response): { id: string } | null => {
    const workspace = workspaceManager.get(req.params.workspaceId);
    if (!workspace) {
      sendProblem(req, res, { status: 404, code: 'WORKSPACE_NOT_FOUND', detail: 'Workspace not found' });
      return null;
    }
    return workspace;
  };

  const processOrProblem = (req: Request, res: Response, workspaceId: string) => {
    const process = store.processRepository().findById(workspaceId, req.params.processId);
    if (!process) {
      sendProblem(req, res, { status: 404, code: 'PROCESS_NOT_FOUND', detail: 'Process not found' });
      return null;
    }
    return process;
  };

  // §86: the Process list of one Run.
  router.get('/runs/:runId/processes', (req: Request, res: Response) => {
    const workspace = workspaceOrProblem(req, res);
    if (!workspace) return;
    const run = store.runRepository().findById(workspace.id, req.params.runId);
    if (!run) {
      sendProblem(req, res, { status: 404, code: 'RUN_NOT_FOUND', detail: 'Run not found' });
      return;
    }
    const processes = store.processRepository().listByRun(workspace.id, run.id);
    res.json({ processes });
  });

  // §86: single Process snapshot.
  router.get('/processes/:processId', (req: Request, res: Response) => {
    const workspace = workspaceOrProblem(req, res);
    if (!workspace) return;
    const process = processOrProblem(req, res, workspace.id);
    if (!process) return;
    res.json({ process });
  });

  // §86: parent/child hierarchy from the runtime_processes parent relation.
  router.get('/processes/:processId/tree', (req: Request, res: Response) => {
    const workspace = workspaceOrProblem(req, res);
    if (!workspace) return;
    const root = processOrProblem(req, res, workspace.id);
    if (!root) return;
    const all = store.processRepository().listByRun(workspace.id, root.runId);
    const childrenOf = new Map<string | null, typeof all>();
    for (const candidate of all) {
      const bucket = childrenOf.get(candidate.parentProcessId) ?? [];
      bucket.push(candidate);
      childrenOf.set(candidate.parentProcessId, bucket);
    }
    interface TreeNode {
      readonly process: (typeof all)[number];
      readonly children: TreeNode[];
    }
    const build = (process: (typeof all)[number]): TreeNode => ({
      process,
      children: (childrenOf.get(process.id) ?? []).map(build),
    });
    res.json({ tree: build(root) });
  });

  // §86: the durable Event/fact stream bound to this Process.
  router.get('/processes/:processId/events', (req: Request, res: Response) => {
    const workspace = workspaceOrProblem(req, res);
    if (!workspace) return;
    const process = processOrProblem(req, res, workspace.id);
    if (!process) return;
    const afterSequence = parseNonNegativeInteger(req.query.afterSequence) ?? 0;
    const limit = parseNonNegativeInteger(req.query.limit) ?? EVENT_DEFAULT_LIMIT;
    if (afterSequence < 0 || limit < 1 || limit > EVENT_MAX_LIMIT) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'afterSequence must be >= 0 and limit between 1 and 200' });
      return;
    }
    const events = store.runtimeEventRepository().listByProcess(workspace.id, process.id, afterSequence, limit);
    const lastSequence = events.length === 0
      ? afterSequence
      : events[events.length - 1].event.sequence;
    res.json({
      events,
      hasMore: events.length === limit,
      nextAfterSequence: lastSequence,
    });
  });

  // §86 + §55: paged raw output. Artifact is the source of truth; without a
  // reference (or readable artifact) the response is an explicitly marked
  // fallback page, never a fabricated buffer.
  router.get('/processes/:processId/output', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceOrProblem(req, res);
    if (!workspace) return;
    const process = processOrProblem(req, res, workspace.id);
    if (!process) return;
    const stream = req.query.stream;
    if (stream !== 'stdout' && stream !== 'stderr') {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'stream must be stdout or stderr' });
      return;
    }
    const offset = parseNonNegativeInteger(req.query.offset) ?? 0;
    const limit = parseNonNegativeInteger(req.query.limit) ?? OUTPUT_DEFAULT_LIMIT_BYTES;
    if (limit < 1 || limit > OUTPUT_MAX_LIMIT_BYTES) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: `limit must be between 1 and ${OUTPUT_MAX_LIMIT_BYTES}` });
      return;
    }

    const reference = store.processOutputReferenceRepository().findReference(workspace.id, process.id, stream);
    const artifact = reference === undefined ? null : {
      artifactId: reference.artifactId,
      storageKey: reference.storageKey,
      sha256: reference.sha256,
      finalized: reference.finalized,
      truncated: reference.truncated,
      redactionMode: reference.redactionMode,
    };

    if (reference !== undefined) {
      const path = artifactPathFor(options.artifactRoot, reference.storageKey);
      if (path !== null) {
        const handle = await open(path, 'r');
        try {
          const size = (await handle.stat()).size;
          const start = Math.min(offset, size);
          const length = Math.min(limit, size - start);
          const buffer = Buffer.alloc(length);
          let read = 0;
          while (read < length) {
            const result = await handle.read(buffer, read, length - read, start + read);
            if (result.bytesRead <= 0) break;
            read += result.bytesRead;
          }
          const bytes = buffer.subarray(0, read);
          res.json({
            processId: process.id,
            stream,
            source: 'artifact',
            artifact,
            text: new TextDecoder('utf-8', { fatal: false }).decode(bytes),
            offset: start,
            nextOffset: start + read,
            retainedBytes: size,
            ended: reference.finalized,
            warnings: reference.truncated ? ['PROCESS_OUTPUT_TRUNCATED'] : [],
          });
          return;
        } finally {
          await handle.close();
        }
      }
    }

    // Fallback (§86): no artifact backing for this stream.
    const fallback = options.memoryOutputReader?.({
      workspaceId: workspace.id,
      processId: process.id,
      stream,
      offsetBytes: offset,
      maxBytes: limit,
    });
    if (fallback != null) {
      res.json({
        processId: process.id,
        stream,
        source: 'memory',
        artifact,
        text: fallback.text,
        offset,
        nextOffset: offset + Buffer.byteLength(fallback.text),
        retainedBytes: fallback.retainedBytes,
        ended: true,
        warnings: ['PROCESS_OUTPUT_FALLBACK_MEMORY'],
      });
      return;
    }
    res.json({
      processId: process.id,
      stream,
      source: 'none',
      artifact,
      text: '',
      offset,
      nextOffset: offset,
      retainedBytes: 0,
      ended: true,
      warnings: ['PROCESS_OUTPUT_ARTIFACT_UNAVAILABLE'],
    });
  }));

  // §87: minimal control. Graceful stop through the ProcessCancelCoordinator;
  // idempotent per Process (stable idempotency key); terminal Processes join
  // as a natural-terminal no-op. Cleanup stays in the maintenance domain.
  router.post('/processes/:processId/stop', asyncHandler(async (req: Request, res: Response) => {
    const workspace = workspaceOrProblem(req, res);
    if (!workspace) return;
    const process = processOrProblem(req, res, workspace.id);
    if (!process) return;
    const reason = (req.body as { reason?: unknown } | undefined)?.reason;
    if (reason !== undefined && typeof reason !== 'string') {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'reason must be a string' });
      return;
    }
    try {
      const result = await options.stopProcess({
        workspaceId: workspace.id,
        processId: process.id,
        ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
      });
      res.json({
        process: result.process,
        stopAccepted: result.stopAccepted,
        authority: result.authority,
        proven: result.proven,
        reason: result.reason,
      });
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === 'PROCESS_NOT_FOUND') {
        sendProblem(req, res, { status: 404, code: 'PROCESS_NOT_FOUND', detail: 'Process not found' });
        return;
      }
      if (typeof error === 'object' && error !== null && String((error as Error).message).includes('claim')) {
        sendProblem(req, res, { status: 409, code: 'PROCESS_CLAIM_CONFLICT', detail: 'Process claim conflict' });
        return;
      }
      sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
    }
  }));

  return router;
}
