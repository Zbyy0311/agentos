import { Router, type Request, type Response } from 'express';
import type { Run } from '@agentos/shared';
import { sendProblem } from '../problemDetails.js';
import { RunEventQueryService, P5QueryError, parseRunEventsQuery } from '../services/RunEventQueryService.js';
import { RunReplayService, parseRunReplayQuery } from '../services/RunReplayService.js';
import type { RunRepository } from '../store/RunRepository.js';
import type { RunSnapshotRepository } from '../store/RunSnapshotRepository.js';
import type { RunStageRepository } from '../store/RunStageRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';

export interface CanonicalRunEventStore {
  runRepository(): RunRepository;
  runtimeEventRepository(): RuntimeEventRepository;
  runSnapshotRepository(): RunSnapshotRepository;
  runStageRepository(): RunStageRepository;
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

  return router;
}
