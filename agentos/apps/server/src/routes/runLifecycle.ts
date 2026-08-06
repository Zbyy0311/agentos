import { json, Router, type Request, type Response } from 'express';
import { TaskRunService, type TaskRunServiceDeps } from '../services/TaskRunService.js';
import { RunNotFoundError } from '../store/RunRepository.js';
import { createOptionalIdempotencyService, parseIdempotencyKey } from './v2Idempotency.js';
import { V2ValidationError } from './v2Tasks.js';

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

function respondRunLifecycle(res: Response, fn: () => { status: number; body: unknown }): void {
  try {
    const { status, body } = fn();
    res.status(status).json(body);
  } catch (err) {
    if (isSqliteBusyError(err)) {
      // Exact frozen contract; never leaks SQLITE_BUSY, SQL, paths, or owners.
      res.status(503).json({
        error: 'Run start is temporarily unavailable',
        code: 'RUN_START_BUSY',
        retryable: true,
      });
      return;
    }
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code in RUN_LIFECYCLE_ERROR_STATUS) {
      res.status(RUN_LIFECYCLE_ERROR_STATUS[code]).json({
        error: RUN_LIFECYCLE_SAFE_MESSAGE[code] ?? (err as Error).message,
        code,
      });
      return;
    }
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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
 * Scoped body parser for the Start route only. This router mounts ahead of
 * the global strict JSON parser, so this non-strict scoped parser is what
 * lets non-object JSON bodies (null, primitives, arrays) reach the frozen
 * 400 VALIDATION_FAILED contract instead of a generic parser-level 400.
 */
const startBodyParser = json({ strict: false });

/**
 * M3 P3C-1 canonical lifecycle routes. Mounted exactly once at /api in
 * index.ts, so the final URL is precisely POST /api/runs/:runId/start — no
 * workspaceId in path, query, or body, and no /v2 prefix. The router owns
 * its IdempotencyService detection and its route-local TaskRunService.
 */
export function createRunLifecycleRoutes(store: TaskRunServiceDeps): Router {
  const router = Router();
  const idempotencyService = createOptionalIdempotencyService(store);
  const service = new TaskRunService(store, {
    ...(idempotencyService ? { idempotencyService } : {}),
  });

  router.post('/runs/:runId/start', startBodyParser, (req: Request, res: Response) => respondRunLifecycle(res, () => {
    // Exact order: opaque path runId → locator (before any body validation)
    // → 404 → query rejection → plain-object body → unknown-field rejection
    // → optional expectedVersion → optional Idempotency-Key normalization.
    const { runId } = req.params as { runId: string };
    const workspaceId = store.runRepository().findWorkspaceIdByOpaqueId(runId);
    if (workspaceId === undefined) throw new RunNotFoundError(runId);
    if (Object.keys(req.query ?? {}).length > 0) {
      throw new V2ValidationError('query parameters are not accepted');
    }
    // An absent body carries no JSON content type, so this guard is also the
    // frozen "undefined body" rejection (the parser normalizes a missing
    // body to {}, which must not be accepted as an explicit {}).
    if (!isJsonContentType(req.headers['content-type'])) {
      throw new V2ValidationError('body must be an application/json object');
    }
    const body: unknown = req.body;
    if (!isPlainJsonObject(body)) {
      throw new V2ValidationError('body must be a plain JSON object');
    }
    for (const key of Object.keys(body)) {
      if (key !== 'expectedVersion') {
        throw new V2ValidationError('body contains an unknown field');
      }
    }
    const expectedVersion = parseStartExpectedVersion(body.expectedVersion);
    const normalizedKey = parseIdempotencyKey(req);
    const result = service.startRunOperationForV2(workspaceId, runId, normalizedKey, expectedVersion);
    if (result.replayed) res.setHeader('Idempotency-Replayed', 'true');
    return { status: result.httpStatus, body: result.body };
  }));

  return router;
}
