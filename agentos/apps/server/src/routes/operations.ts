import { json, Router, type NextFunction, type Request, type Response } from 'express';
import {
  OperationIntegrityError,
  OperationLifecycleDependencyError,
  OperationNotCancellableError,
  OperationValidationError,
} from '../services/OperationService.js';
import type { OperationService } from '../services/OperationService.js';
import { OperationNotFoundError } from '../store/OperationRepository.js';
import type { RuntimeEventRepository } from '../store/RuntimeEventRepository.js';
import { VersionConflictError } from '../store/Version.js';

export interface OperationRouteStore {
  operationService(): OperationService;
  runtimeEventRepository(): RuntimeEventRepository;
}

const OPERATION_NOT_FOUND = { error: 'Operation not found', code: 'OPERATION_NOT_FOUND' } as const;
const QUERY_VALIDATION_FAILED = { error: 'Query parameters are not accepted', code: 'VALIDATION_FAILED' } as const;
const CANCEL_VALIDATION_FAILED = { error: 'Invalid request', code: 'VALIDATION_FAILED' } as const;
const VERSION_CONFLICT = { error: 'Version conflict', code: 'VERSION_CONFLICT' } as const;
const NOT_CANCELLABLE = { error: 'Operation is not cancellable', code: 'OPERATION_NOT_CANCELLABLE' } as const;
const INTERNAL_ERROR = { error: 'Internal server error', code: 'INTERNAL_ERROR' } as const;

function isOperationNotFound(error: unknown): boolean {
  return error instanceof OperationNotFoundError
    || (error as { code?: unknown } | null)?.code === 'OPERATION_NOT_FOUND';
}

function respondInternalError(res: Response): void {
  res.status(500).json(INTERNAL_ERROR);
}

function respondCancelError(res: Response, error: unknown): void {
  if (isOperationNotFound(error)) {
    res.status(404).json(OPERATION_NOT_FOUND);
    return;
  }
  if (error instanceof OperationNotCancellableError
    || (error as { code?: unknown } | null)?.code === 'OPERATION_NOT_CANCELLABLE') {
    res.status(409).json(NOT_CANCELLABLE);
    return;
  }
  if (error instanceof VersionConflictError) {
    if (error.entityType === 'operations') {
      res.status(409).json(VERSION_CONFLICT);
      return;
    }
    respondInternalError(res);
    return;
  }
  if (error instanceof OperationIntegrityError
    || error instanceof OperationLifecycleDependencyError
    || error instanceof OperationValidationError) {
    respondInternalError(res);
    return;
  }
  respondInternalError(res);
}

function isClientBodyParseError(error: unknown): boolean {
  const candidate = error as { type?: unknown; status?: unknown; statusCode?: unknown } | null;
  if (!candidate || typeof candidate.type !== 'string') return false;
  const status = typeof candidate.status === 'number'
    ? candidate.status
    : (typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined);
  return status !== undefined && status >= 400 && status < 500;
}

function isJsonContentType(contentType: string | undefined): boolean {
  return typeof contentType === 'string' && /^application\/json(?:\s*;|\s*$)/i.test(contentType.trim());
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const cancelWorkspaceByRequest = new WeakMap<object, string>();
const cancelRawPayloadLengthByRequest = new WeakMap<object, number>();
const cancelExpectedVersionByRequest = new WeakMap<object, number>();

const cancelBodyParser = json({
  strict: false,
  verify: (req, _res, buf) => {
    cancelRawPayloadLengthByRequest.set(req, buf.length);
  },
});

export function createOperationRoutes(store: OperationRouteStore): Router {
  const router = Router();
  const operationService = store.operationService();
  const runtimeEventRepository = store.runtimeEventRepository();

  const resolveOperationWorkspace = (req: Request, res: Response, next: NextFunction): void => {
    const { operationId } = req.params as { operationId: string };
    try {
      const workspaceId = operationService.findWorkspaceIdByOpaqueId(operationId);
      if (workspaceId === undefined) {
        res.status(404).json(OPERATION_NOT_FOUND);
        return;
      }
       cancelWorkspaceByRequest.set(req, workspaceId);
      next();
    } catch {
      respondInternalError(res);
    }
  };

  const rejectQuery = (req: Request, res: Response, next: NextFunction): void => {
    if (Object.keys(req.query ?? {}).length > 0) {
      res.status(400).json(QUERY_VALIDATION_FAILED);
      return;
    }
    next();
  };

  const getAuthorizedOperation = (req: Request): ReturnType<OperationService['findById']> => {
     const workspaceId = cancelWorkspaceByRequest.get(req);
    if (workspaceId === undefined) throw new Error('OPERATION_WORKSPACE_CONTEXT_MISSING');
    const { operationId } = req.params as { operationId: string };
    return operationService.findById(workspaceId, operationId);
  };

  const cancelBodyParserErrorHandler = (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (isClientBodyParseError(error)) {
      res.status(400).json(CANCEL_VALIDATION_FAILED);
      return;
    }
    respondInternalError(res);
  };

  const validateCancelRequest = (req: Request, res: Response, next: NextFunction): void => {
    if (Object.keys(req.query ?? {}).length > 0) {
      res.status(400).json(CANCEL_VALIDATION_FAILED);
      return;
    }
    if (!isJsonContentType(req.headers['content-type'])
      || (cancelRawPayloadLengthByRequest.get(req) ?? 0) === 0
      || !isPlainJsonObject(req.body)) {
      res.status(400).json(CANCEL_VALIDATION_FAILED);
      return;
    }
    const body = req.body;
    const keys = Object.getOwnPropertyNames(body);
    if (Object.getOwnPropertySymbols(body).length !== 0
      || keys.length !== 1
      || keys[0] !== 'expectedVersion'
      || typeof body.expectedVersion !== 'number'
      || !Number.isSafeInteger(body.expectedVersion)
      || body.expectedVersion < 1) {
      res.status(400).json(CANCEL_VALIDATION_FAILED);
      return;
    }
    cancelExpectedVersionByRequest.set(req, body.expectedVersion);
    next();
  };

  const cancelOperation = (req: Request, res: Response): void => {
    try {
      const workspaceId = cancelWorkspaceByRequest.get(req);
      if (workspaceId === undefined) throw new Error('OPERATION_CANCEL_WORKSPACE_CONTEXT_MISSING');
      const expectedVersion = cancelExpectedVersionByRequest.get(req);
      if (expectedVersion === undefined) throw new Error('OPERATION_CANCEL_EXPECTED_VERSION_MISSING');
      const { operationId } = req.params as { operationId: string };
      const current = operationService.cancel({ workspaceId, operationId, expectedVersion });
      res.status(200).json({ data: current });
    } catch (error) {
      respondCancelError(res, error);
    }
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

  router.post(
    '/operations/:operationId/cancel',
    resolveOperationWorkspace,
    cancelBodyParser,
    cancelBodyParserErrorHandler,
    validateCancelRequest,
    cancelOperation,
  );
  router.get('/operations/:operationId/events', resolveOperationWorkspace, rejectQuery, getOperationEvents);
  router.get('/operations/:operationId', resolveOperationWorkspace, rejectQuery, getOperation);

  return router;
}
