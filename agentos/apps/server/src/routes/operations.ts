import { Router, type NextFunction, type Request, type Response } from 'express';
import type { OperationService } from '../services/OperationService.js';
import { OperationNotFoundError } from '../store/OperationRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';

export interface OperationRouteStore {
  operationService(): OperationService;
  runtimeEventRepository(): RuntimeEventRepository;
}

const OPERATION_NOT_FOUND = { error: 'Operation not found', code: 'OPERATION_NOT_FOUND' } as const;
const VALIDATION_FAILED = { error: 'Query parameters are not accepted', code: 'VALIDATION_FAILED' } as const;
const INTERNAL_ERROR = { error: 'Internal server error', code: 'INTERNAL_ERROR' } as const;

function isOperationNotFound(error: unknown): boolean {
  return error instanceof OperationNotFoundError
    || (error as { code?: unknown } | null)?.code === 'OPERATION_NOT_FOUND';
}

function respondInternalError(res: Response): void {
  res.status(500).json(INTERNAL_ERROR);
}

export function createOperationRoutes(store: OperationRouteStore): Router {
  const router = Router();
  const operationService = store.operationService();
  const runtimeEventRepository = store.runtimeEventRepository();
  const workspaceByRequest = new WeakMap<Request, string>();

  const resolveOperationWorkspace = (req: Request, res: Response, next: NextFunction): void => {
    const { operationId } = req.params as { operationId: string };
    try {
      const workspaceId = operationService.findWorkspaceIdByOpaqueId(operationId);
      if (workspaceId === undefined) {
        res.status(404).json(OPERATION_NOT_FOUND);
        return;
      }
      workspaceByRequest.set(req, workspaceId);
      next();
    } catch {
      respondInternalError(res);
    }
  };

  const rejectQuery = (req: Request, res: Response, next: NextFunction): void => {
    if (Object.keys(req.query ?? {}).length > 0) {
      res.status(400).json(VALIDATION_FAILED);
      return;
    }
    next();
  };

  const getAuthorizedOperation = (req: Request): ReturnType<OperationService['findById']> => {
    const workspaceId = workspaceByRequest.get(req);
    if (workspaceId === undefined) throw new Error('OPERATION_WORKSPACE_CONTEXT_MISSING');
    const { operationId } = req.params as { operationId: string };
    return operationService.findById(workspaceId, operationId);
  };

  const getOperation = (req: Request, res: Response): void => {
    try {
      res.status(200).json({ data: getAuthorizedOperation(req) });
    } catch (error) {
      if (isOperationNotFound(error)) {
        res.status(404).json(OPERATION_NOT_FOUND);
        return;
      }
      respondInternalError(res);
    }
  };

  const getOperationEvents = (req: Request, res: Response): void => {
    try {
      const operation = getAuthorizedOperation(req);
      const events = runtimeEventRepository
        .listByRunAndCorrelation(operation.runId, operation.correlationId)
        .map(result => result.event);
      res.status(200).json({ events, hasMore: false });
    } catch (error) {
      if (isOperationNotFound(error)) {
        res.status(404).json(OPERATION_NOT_FOUND);
        return;
      }
      respondInternalError(res);
    }
  };

  router.get('/operations/:operationId/events', resolveOperationWorkspace, rejectQuery, getOperationEvents);
  router.get('/operations/:operationId', resolveOperationWorkspace, rejectQuery, getOperation);

  return router;
}
