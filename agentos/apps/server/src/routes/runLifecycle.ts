import { json, Router, type NextFunction, type Request, type Response } from 'express';
import { normalizeRequestedMutationClass } from '@agentos/shared';
import { isClientBodyParseError, sendProblem } from '../problemDetails.js';
import { TaskRunService, type TaskRunServiceDeps } from '../services/TaskRunService.js';
import { createOptionalIdempotencyService, parseIdempotencyKey } from './v2Idempotency.js';
import { V2ValidationError } from './v2Tasks.js';

/**
 * P6-M1 Production Runtime Dispatch Activation seam. The start route is
 * accept-only by design; when the AGENTOS_RUNTIME_DISPATCH_ENABLED gate is on,
 * an accepted (non-replayed) start triggers exactly one background dispatch.
 * The callback is injected so the route owns no process/spawn authority
 * (Process Runtime owns native processes), and the dispatcher's CAS claim +
 * replay-no-respawn guarantees are preserved.
 */
export interface RunLifecycleDispatchOptions {
  /** Gate: when false (default OFF) no dispatch occurs and the 202 contract is unchanged. */
  readonly enabled: boolean;
  /**
   * Fire-and-forget dispatch. Implementations must contain their own failures
   * (route pre/post-claim failures to a canonical failure sink) so a rejection
   * never crashes the route or strands a running execution.
   */
  readonly drive: (workspaceId: string, runId: string) => Promise<unknown>;
}

export interface RunLifecycleRouteOptions {
  readonly runtimeDispatch?: RunLifecycleDispatchOptions;
}

/**
 * M3 P3C-1 narrow, sanitized error mapping for the canonical Start
 * acceptance route. This module owns its mapping and never widens respondV2.
 */
const RUN_LIFECYCLE_ERROR_STATUS: Record<string, number> = {
  VALIDATION_FAILED: 400,
  RUN_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  INVALID_RUN_TRANSITION: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RUN_START_ALREADY_ACTIVE: 409,
  IDEMPOTENCY_RECORD_INVALID: 500,
  RUN_START_AUTHORIZATION_AMBIGUOUS: 500,
  RUN_START_STATE_INCONSISTENT: 500,
};

const RUN_LIFECYCLE_SAFE_MESSAGE: Record<string, string> = {
  VERSION_CONFLICT: 'Version conflict',
  INVALID_RUN_TRANSITION: 'Run is not in a startable state',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key was already used with a different request',
  RUN_START_ALREADY_ACTIVE: 'Run start is already active',
  IDEMPOTENCY_RECORD_INVALID: 'Idempotency record is invalid',
  RUN_START_AUTHORIZATION_AMBIGUOUS: 'Run start authorization is ambiguous',
  RUN_START_STATE_INCONSISTENT: 'Run start state is inconsistent',
};

const RUN_RETRY_ERROR_STATUS: Record<string, number> = {
  VALIDATION_FAILED: 400,
  RUN_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  RUN_NOT_RETRYABLE: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  RUN_RETRY_ALREADY_CREATED: 409,
  RUN_ACTIVE_EXISTS: 409,
  IDEMPOTENCY_RECORD_INVALID: 500,
  RUN_RETRY_STATE_AMBIGUOUS: 500,
  RUN_RETRY_STATE_INCONSISTENT: 500,
  RUN_RETRY_BUSY: 503,
  INTERNAL_ERROR: 500,
};

const RUN_RETRY_SAFE_MESSAGE: Record<string, string> = {
  VALIDATION_FAILED: 'Invalid request',
  RUN_NOT_FOUND: 'Run not found',
  VERSION_CONFLICT: 'Version conflict',
  RUN_NOT_RETRYABLE: 'Run is not retryable',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key was already used with a different request',
  RUN_RETRY_ALREADY_CREATED: 'Retry child already exists',
  RUN_ACTIVE_EXISTS: 'Task already has an active run',
  IDEMPOTENCY_RECORD_INVALID: 'Idempotency record is invalid',
  RUN_RETRY_STATE_AMBIGUOUS: 'Retry state is ambiguous',
  RUN_RETRY_STATE_INCONSISTENT: 'Retry state is inconsistent',
};

/**
 * Only a genuine SQLite busy/locked timeout maps to 503. node:sqlite errors
 * carry the SQLite result code in `errcode` (SQLITE_BUSY = 5, SQLITE_LOCKED
 * = 6, with extended codes in the high bits). Ordinary same-key,
 * different-key, and no-key contention resolves through resolve or the
 * history matrix and never reaches this mapping.
 */
function isSqliteBusyError(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode === 'number' && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked/i.test(message);
}

function respondRunLifecycle(req: Request, res: Response, fn: () => { status: number; body: unknown }): void {
  try {
    const { status, body } = fn();
    res.status(status).json(body);
  } catch (err) {
    if (isSqliteBusyError(err)) {
      // Exact frozen contract; never leaks SQLITE_BUSY, SQL, paths, or owners.
      sendProblem(req, res, {
        status: 503,
        code: 'RUN_START_BUSY',
        detail: 'Run start is temporarily unavailable',
        retryable: true,
      });
      return;
    }
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code in RUN_LIFECYCLE_ERROR_STATUS) {
      sendProblem(req, res, {
        status: RUN_LIFECYCLE_ERROR_STATUS[code],
        code,
        detail: RUN_LIFECYCLE_SAFE_MESSAGE[code] ?? (err as Error).message,
      });
      return;
    }
    sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
  }
}

function respondRetry(req: Request, res: Response, fn: () => { status: number; body: unknown }): void {
  try {
    const { status, body } = fn();
    res.status(status).json(body);
  } catch (err) {
    if (isSqliteBusyError(err)) {
      sendProblem(req, res, {
        status: 503,
        code: 'RUN_RETRY_BUSY',
        detail: 'Run retry is temporarily unavailable',
        retryable: true,
      });
      return;
    }
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code in RUN_RETRY_ERROR_STATUS) {
      const status = RUN_RETRY_ERROR_STATUS[code];
      if (code === 'RUN_RETRY_BUSY') {
        sendProblem(req, res, {
          status,
          code,
          detail: 'Run retry is temporarily unavailable',
          retryable: true,
        });
        return;
      }
      if (code === 'RUN_ACTIVE_EXISTS') {
        sendProblem(req, res, {
          status,
          code,
          detail: 'Task already has an active run',
          retryable: false,
        });
        return;
      }
      sendProblem(req, res, {
        status,
        code,
        detail: RUN_RETRY_SAFE_MESSAGE[code] ?? 'Internal server error',
      });
      return;
    }
    sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const START_BODY_ERROR_MESSAGE = 'Request body must be a valid JSON object';

/**
 * Remote review HIGH-1 / MEDIUM-1: request-local seams keyed by the request
 * object itself, so no state can leak across requests. The workspaceId is
 * resolved by the locator middleware before any body parsing and is never
 * exposed through body/query/response; the raw payload length is recorded by
 * the scoped parser's verify callback (byte count only — body content is
 * never retained or logged).
 */
const startWorkspaceByRequest = new WeakMap<object, string>();
const startRawPayloadLengthByRequest = new WeakMap<object, number>();
const retryWorkspaceByRequest = new WeakMap<object, string>();
const retryRawPayloadLengthByRequest = new WeakMap<object, number>();

function parseStartExpectedVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new V2ValidationError('expectedVersion must be a positive safe integer');
  }
  return value;
}

function isJsonContentType(contentType: string | undefined): boolean {
  return typeof contentType === 'string' && /^application\/json(?:\s*;|\s*$)/i.test(contentType.trim());
}

/**
 * Scoped body parser for the Start route only — the third middleware in the
 * chain, after the locator and the query rejection, never first. This router
 * mounts ahead of the global strict JSON parser, so this non-strict scoped
 * parser is what lets non-object JSON bodies (null, primitives, arrays)
 * reach the frozen 400 VALIDATION_FAILED contract instead of a generic
 * parser-level 400. The verify callback records only the raw payload byte
 * length per request, so a zero-byte JSON payload is rejected instead of
 * being normalized into a valid {}.
 */
const startBodyParser = json({
  strict: false,
  verify: (req, _res, buf) => {
    startRawPayloadLengthByRequest.set(req, buf.length);
  },
});

const retryBodyParser = json({
  strict: false,
  verify: (req, _res, buf) => {
    retryRawPayloadLengthByRequest.set(req, buf.length);
  },
});

/**
 * M3 P3C-1 canonical lifecycle routes. Mounted exactly once at /api in
 * index.ts, so the final URL is precisely POST /api/runs/:runId/start — no
 * workspaceId in path, query, or body, and no /v2 prefix. The router owns
 * its IdempotencyService detection and its route-local TaskRunService.
 *
 * Remote review HIGH-1 middleware order (locator-first):
 *   resolveRunWorkspace → rejectStartQuery → startBodyParser →
 *   startBodyParserErrorHandler → startHandler.
 */
export function createRunLifecycleRoutes(store: TaskRunServiceDeps, options: RunLifecycleRouteOptions = {}): Router {
  const router = Router();
  const idempotencyService = createOptionalIdempotencyService(store);
  const service = new TaskRunService(store, {
    ...(idempotencyService ? { idempotencyService } : {}),
  });
  const runtimeDispatch = options.runtimeDispatch;

  /**
   * Middleware 1 — opaque path runId → single locator call. A miss responds
   * a safe 404 RUN_NOT_FOUND before any query/body handling; the resolved
   * workspaceId is stashed request-locally and never re-read by the handler.
   * SQLite errors flow to the route-local error handler (503/500).
   */
  const resolveRunWorkspace = (req: Request, res: Response, next: NextFunction): void => {
    const { runId } = req.params as { runId: string };
    let workspaceId: string | undefined;
    try {
      workspaceId = store.runRepository().findWorkspaceIdByOpaqueId(runId);
    } catch (error) {
      next(error);
      return;
    }
    if (workspaceId === undefined) {
      sendProblem(req, res, { status: 404, code: 'RUN_NOT_FOUND', detail: 'Run not found' });
      return;
    }
    startWorkspaceByRequest.set(req, workspaceId);
    next();
  };

  /** Middleware 2 — any query parameter is rejected before body parsing. */
  const rejectStartQuery = (req: Request, res: Response, next: NextFunction): void => {
    if (Object.keys(req.query ?? {}).length > 0) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Query parameters are not accepted' });
      return;
    }
    next();
  };

  /**
   * Middleware 4 — route-local error mapping for everything raised by the
   * earlier middlewares (locator SQLite failures included). Known client
   * body/parser errors collapse to one sanitized 400 VALIDATION_FAILED; a
   * genuine SQLite busy/locked timeout maps to the frozen 503; unknown
   * errors map to a safe 500. Raw parser messages never reach the global
   * error handler, and this handler can only affect this route's chain.
   */
  const startBodyParserErrorHandler = (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (isSqliteBusyError(err)) {
      sendProblem(req, res, {
        status: 503,
        code: 'RUN_START_BUSY',
        detail: 'Run start is temporarily unavailable',
        retryable: true,
      });
      return;
    }
    if (isClientBodyParseError(err)) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: START_BODY_ERROR_MESSAGE });
      return;
    }
    sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
  };

  /**
   * Middleware 5 — payload-existence, shape, field, and expectedVersion
   * validation, then Idempotency-Key normalization and the service call.
   */
  const startHandler = (req: Request, res: Response): void => respondRunLifecycle(req, res, () => {
    const { runId } = req.params as { runId: string };
    const workspaceId = startWorkspaceByRequest.get(req);
    if (workspaceId === undefined) {
      // Programming error — resolveRunWorkspace always runs first.
      throw new Error('RUN_START_WORKSPACE_CONTEXT_MISSING');
    }
    // An absent body carries no JSON content type (the "undefined body"
    // rejection); a zero-byte JSON payload is rejected via the request-local
    // raw length instead of being normalized into a valid {}.
    if (!isJsonContentType(req.headers['content-type'])) {
      throw new V2ValidationError(START_BODY_ERROR_MESSAGE);
    }
    if ((startRawPayloadLengthByRequest.get(req) ?? 0) === 0) {
      throw new V2ValidationError(START_BODY_ERROR_MESSAGE);
    }
    const body: unknown = req.body;
    if (!isPlainJsonObject(body)) {
      throw new V2ValidationError(START_BODY_ERROR_MESSAGE);
    }
    for (const key of Object.keys(body)) {
      if (key !== 'expectedVersion' && key !== 'requestedMutationClass') {
        throw new V2ValidationError('body contains an unknown field');
      }
    }
    const expectedVersion = parseStartExpectedVersion(body.expectedVersion);
    // P6-L1A: normalize requestedMutationClass BEFORE the service builds the
    // idempotency fingerprint. An omitted field and an explicit "MODIFYING"
    // normalize to the same logical request identity; any other value is a
    // VALIDATION_FAILED. No Admission is created and no scheduling behavior
    // changes in this slice.
    const requestedMutationClass = normalizeRequestedMutationClass(body.requestedMutationClass);
    const normalizedKey = parseIdempotencyKey(req);
    const result = service.startRunOperationForV2(workspaceId, runId, normalizedKey, expectedVersion, requestedMutationClass);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    // P6-M1: only a freshly accepted (non-replayed) start may dispatch. The
    // replay path converges on durable evidence and must never re-spawn.
    if (runtimeDispatch?.enabled === true && !result.replayed) {
      void runtimeDispatch.drive(workspaceId, runId).catch(() => {
        // Containment backstop: drive implementations route failures to a
        // canonical failure sink; this catch only guarantees no unhandled
        // rejection escapes into the route/process.
      });
    }
    return { status: result.httpStatus, body: result.body };
  });

  router.post(
    '/runs/:runId/start',
    resolveRunWorkspace,
    rejectStartQuery,
    startBodyParser,
    startBodyParserErrorHandler,
    startHandler,
  );

  const resolveRetryWorkspace = (req: Request, res: Response, next: NextFunction): void => {
    const { runId } = req.params as { runId: string };
    let workspaceId: string | undefined;
    try {
      workspaceId = store.runRepository().findWorkspaceIdByOpaqueId(runId);
    } catch (error) {
      next(error);
      return;
    }
    if (workspaceId === undefined) {
      sendProblem(req, res, { status: 404, code: 'RUN_NOT_FOUND', detail: 'Run not found' });
      return;
    }
    retryWorkspaceByRequest.set(req, workspaceId);
    next();
  };

  const rejectRetryQuery = (req: Request, res: Response, next: NextFunction): void => {
    if (Object.keys(req.query ?? {}).length > 0) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Invalid request' });
      return;
    }
    next();
  };

  const retryBodyParserErrorHandler = (err: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (isSqliteBusyError(err)) {
      sendProblem(req, res, {
        status: 503,
        code: 'RUN_RETRY_BUSY',
        detail: 'Run retry is temporarily unavailable',
        retryable: true,
      });
      return;
    }
    if (isClientBodyParseError(err)) {
      sendProblem(req, res, { status: 400, code: 'VALIDATION_FAILED', detail: 'Invalid request' });
      return;
    }
    sendProblem(req, res, { status: 500, code: 'INTERNAL_ERROR', detail: 'Internal server error' });
  };

  const parseRetryExpectedVersion = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new V2ValidationError('expectedVersion must be a positive safe integer');
    }
    return value;
  };

  const retryHandler = (req: Request, res: Response): void => respondRetry(req, res, () => {
    const { runId } = req.params as { runId: string };
    const workspaceId = retryWorkspaceByRequest.get(req);
    if (workspaceId === undefined) {
      throw new Error('RUN_RETRY_WORKSPACE_CONTEXT_MISSING');
    }
    if (!isJsonContentType(req.headers['content-type'])) {
      throw new V2ValidationError('Request body must be a valid JSON object');
    }
    if ((retryRawPayloadLengthByRequest.get(req) ?? 0) === 0) {
      throw new V2ValidationError('Request body must be a valid JSON object');
    }
    const body: unknown = req.body;
    if (!isPlainJsonObject(body)) {
      throw new V2ValidationError('Request body must be a valid JSON object');
    }
    for (const key of Object.keys(body)) {
      if (key !== 'expectedVersion') {
        throw new V2ValidationError('body contains an unknown field');
      }
    }
    const expectedVersion = parseRetryExpectedVersion(body.expectedVersion);
    const normalizedKey = parseIdempotencyKey(req);
    if (normalizedKey === undefined) {
      throw new V2ValidationError('Idempotency-Key is required');
    }
    const result = service.retryRunOperationForV2(workspaceId, runId, normalizedKey, expectedVersion);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return { status: result.httpStatus, body: result.body };
  });

  router.post(
    '/runs/:runId/retry',
    resolveRetryWorkspace,
    rejectRetryQuery,
    retryBodyParser,
    retryBodyParserErrorHandler,
    retryHandler,
  );

  return router;
}
