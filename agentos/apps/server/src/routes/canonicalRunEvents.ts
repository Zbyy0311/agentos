import { Router, type Request, type Response } from 'express';
import type { Run } from '@agentos/shared';
import { sendProblem } from '../problemDetails.js';
import { RunEventQueryService, P5QueryError, parseNonNegativeInteger, parseRunEventsQuery } from '../services/RunEventQueryService.js';
import { RunReplayService, parseRunReplayQuery } from '../services/RunReplayService.js';
import type { RunStreamService } from '../services/RunStreamService.js';
import type { RunRepository } from '../store/RunRepository.js';
import type { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { startRuntimeKeepalive, writeRuntimeEventFrame } from './runtimeSse.js';

export interface CanonicalRunEventStore {
  runRepository(): RunRepository;
  runtimeEventRepository(): RuntimeEventRepository;
  runSnapshotRepository(): RunSnapshotRepository;
  runStageRepository(): RunStageRepository;
  runStreamService(): RunStreamService;
}

class P5RunNotFoundError extends Error {
  readonly code = 'RUN_NOT_FOUND' as const;
}

function sendP5Error(req: Request, res: Response, error: unknown): void {
  if (error instanceof P5RunNotFoundError) {
    sendProblem(req, res, { status: 404, code: 'RUN_NOT_FOUND', detail: 'Run not found' });
    return;
  }
  if (error instanceof P5QueryError) {
    const status = error.code === 'INPUT_ENUM_INVALID'
      ? 422
      : error.code === 'EVENT_VISIBILITY_FORBIDDEN'
        ? 403
        : 400;
    sendProblem(req, res, {
      status,
      code: error.code,
      detail: error.message,
      ...(status === 403 ? { title: 'Forbidden' } : {}),
    });
    return;
  }
  sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
}

export function createCanonicalRunEventRoutes(store: CanonicalRunEventStore): Router {
  const router = Router();
  const queryService = new RunEventQueryService(store.runtimeEventRepository());
  const replayService = new RunReplayService(store);

  const resolveRun = (runId: string): { workspaceId: string; run: Run } => {
    const workspaceId = store.runRepository().findWorkspaceIdByOpaqueId(runId);
    if (workspaceId === undefined) throw new P5RunNotFoundError();
    const run = store.runRepository().findById(workspaceId, runId);
    if (!run) throw new P5RunNotFoundError();
    return { workspaceId, run };
  };

  router.get('/runs/:runId/events', (req, res) => {
    try {
      const { runId } = req.params as { runId: string };
      const { workspaceId } = resolveRun(runId);
      const query = parseRunEventsQuery(req.query as Record<string, unknown>);
      res.status(200).json(queryService.list(workspaceId, runId, query));
    } catch (error) {
      sendP5Error(req, res, error);
    }
  });

  router.get('/runs/:runId/replay', (req, res) => {
    try {
      const { runId } = req.params as { runId: string };
      const { workspaceId, run } = resolveRun(runId);
      const query = parseRunReplayQuery(req.query as Record<string, unknown>);
      res.status(200).json(replayService.replay(workspaceId, run, query));
    } catch (error) {
      sendP5Error(req, res, error);
    }
  });

  const STREAM_QUERY_KEYS = new Set(['afterSequence']);

  const parseStreamAfterSequence = (query: Record<string, unknown>): number => {
    for (const key of Object.keys(query)) {
      if (!STREAM_QUERY_KEYS.has(key)) {
        throw new P5QueryError('VALIDATION_FAILED', 'query is invalid');
      }
    }
    return parseNonNegativeInteger(query['afterSequence'], 'afterSequence', 0) ?? 0;
  };

  const resolveLastEventIdSequence = (workspaceId: string, runId: string, raw: string | undefined): number => {
    if (raw === undefined) return 0;
    const event = store.runtimeEventRepository().findById(raw)?.event;
    if (!event || event.workspaceId !== workspaceId || event.runId !== runId) {
      throw new P5QueryError('VALIDATION_FAILED', 'Last-Event-ID is invalid');
    }
    return event.sequence;
  };

  router.get('/runs/:runId/stream', (req, res) => {
    try {
      // Locator first: an unknown Run outranks any cursor problem (404).
      const { runId } = req.params as { runId: string };
      const { workspaceId } = resolveRun(runId);
      // Every validation completes before the first SSE byte is written.
      const queryCursor = parseStreamAfterSequence(req.query as Record<string, unknown>);
      const headerCursor = resolveLastEventIdSequence(workspaceId, runId, req.get('Last-Event-ID'));
      const effectiveAfterSequence = Math.max(queryCursor, headerCursor);

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      let closed = false;
      let unsubscribe: () => void = () => {};
      let stopKeepalive: () => void = () => {};
      // Idempotent: close, write failure and overflow may all fire; the
      // subscription is released exactly once and the Run is never touched.
      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        stopKeepalive();
        unsubscribe();
        if (!res.writableEnded) {
          try {
            res.end();
          } catch {
            // Transport already gone.
          }
        }
      };
      res.once('close', cleanup);
      res.once('error', cleanup);

      try {
        unsubscribe = store.runStreamService().subscribe({
          workspaceId,
          runId,
          afterSequence: effectiveAfterSequence,
          onEvent: (event) => {
            if (!writeRuntimeEventFrame(res, event)) {
              cleanup();
              // Fail-closed: the subscription must not treat the event as
              // consumed when the transport could not carry it.
              throw new Error('runtime SSE transport write failed');
            }
          },
          onOverflow: () => cleanup(),
        });
      } catch {
        cleanup();
        return;
      }
      if (closed) return;
      stopKeepalive = startRuntimeKeepalive(res, cleanup);
    } catch (error) {
      sendP5Error(req, res, error);
    }
  });

  return router;
}
