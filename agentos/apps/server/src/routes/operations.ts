import { json, Router, type NextFunction, type Request, type Response } from 'express';
import { isClientBodyParseError, sendProblem } from '../problemDetails.js';
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
import { formatVersionETag } from './versionPrecondition.js';

export interface OperationRouteStore {
  operationService(): OperationService;
  runtimeEventRepository(): RuntimeEventRepository;
}

function isOperationNotFound(error: unknown): boolean {
  return error instanceof OperationNotFoundError
    || (error as { code?: unknown } | null)?.code === 'OPERATION_NOT_FOUND';
}

function respondInternalError(req: Request, res: Response): void {
  sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
}

function respondCancelError(req: Request, res: Response, error: unknown): void {
  if (isOperationNotFound(error)) {
    sendProblem(req, res, { status: 404, code: 'OPERATION_NOT_FOUND', detail: 'Operation not found' });
    return;
  }
  if (error instanceof OperationNotCancellableError
    || (error as { code?: unknown } | null)?.code === 'OPERATION_NOT_CANCELLABLE') {
    sendProblem(req, res, { status: 409, code: 'OPERATION_NOT_CANCELLABLE', detail: 'Operation is not cancellable' });
    return;
  }
  if (error instanceof VersionConflictError) {
    if (error.entityType === 'operations') {
      // Frozen P3D contract: the Operation Cancel version transport is the
      // body expectedVersion only; its conflict mapping stays 409.
      sendProblem(req, res, { status: 409, code: 'VERSION_CONFLICT', detail: 'Version conflict' });
      return;
    }
    respondInternalError(req, res);
    return;
  }
  if (error instanceof OperationIntegrityError
    || error instanceof OperationLifecycleDependencyError
    || error instanceof OperationValidationError) {
    respondInternalError(req, res);
    return;
  }
  respondInternalError(req, res);
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
        sendProblem(req, res, { status: 404, code: 'OPERATION_NOT_FOUND', detail: 'Operation not found' });
        return;
      }
       cancelWorkspaceByRequest.set(req, workspaceId);
      next();
    } catch {
      respondInternalError(req, res);
    }
  };

  const rejectQuery = (req: Request, res: Response, next: NextFunction): void => {
    if (Object.keys(req.query ?? {}).length > 0) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Query parameters are not accepted' });
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
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Invalid request' });
      return;
    }
    respondInternalError(req, res);
  };

  const validateCancelRequest = (req: Request, res: Response, next: NextFunction): void => {
    if (Object.keys(req.query ?? {}).length > 0) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Invalid request' });
      return;
    }
    if (!isJsonContentType(req.headers['content-type'])
      || (cancelRawPayloadLengthByRequest.get(req) ?? 0) === 0
      || !isPlainJsonObject(req.body)) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Invalid request' });
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
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Invalid request' });
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
      respondCancelError(req, res, error);
    }
  };

  const getOperation = (req: Request, res: Response): void => {
    try {
      const operation = getAuthorizedOperation(req);
      res.setHeader('ETag', formatVersionETag(operation.version));
      res.status(200).json({ data: operation });
    } catch (error) {
      if (isOperationNotFound(error)) {
        sendProblem(req, res, { status: 404, code: 'OPERATION_NOT_FOUND', detail: 'Operation not found' });
        return;
      }
      respondInternalError(req, res);
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
        sendProblem(req, res, { status: 404, code: 'OPERATION_NOT_FOUND', detail: 'Operation not found' });
        return;
      }
      respondInternalError(req, res);
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
