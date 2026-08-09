import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';
import type { ApiProblem } from '@agentos/shared';

/**
 * M3 P4A ApiProblem / request-id contract module.
 *
 * Owns the canonical HTTP error envelope (RFC 7807-style `ApiProblem`,
 * `application/problem+json`), the X-Request-ID lifecycle, the API 404
 * fallback, and the terminal error middleware. Clients must rely on the
 * stable `code` field, never on `detail` text.
 */

export const REQUEST_ID_HEADER = 'X-Request-ID';

/**
 * Client-supplied request ids are echoed only when they are a safe token:
 * 1-128 chars, ASCII alphanumeric first, then `[A-Za-z0-9._:-]`. Anything
 * else is replaced with a server-generated id so an unsanitized header
 * value is never reflected back.
 */
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Request-local seam keyed by the request object; no cross-request state. */
const requestIdByRequest = new WeakMap<object, string>();

function generateRequestId(): string {
  return `req_${randomUUID()}`;
}

/**
 * Returns the request id for this request. When the request-id middleware
 * ran, this is the validated id it installed (and already emitted as the
 * X-Request-ID response header); otherwise a generated fallback is
 * installed request-locally so the ApiProblem body always carries one.
 */
export function getRequestId(req: Request): string {
  const existing = requestIdByRequest.get(req);
  if (existing !== undefined) return existing;
  const generated = generateRequestId();
  requestIdByRequest.set(req, generated);
  return generated;
}

export function createRequestIdMiddleware(): RequestHandler {
  return (req, res, next) => {
    const raw = req.headers['x-request-id'];
    const candidate = typeof raw === 'string' ? raw.trim() : '';
    const requestId = CLIENT_REQUEST_ID_PATTERN.test(candidate) ? candidate : generateRequestId();
    requestIdByRequest.set(req, requestId);
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  };
}

const STATUS_TITLES: Record<number, string> = {
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * Deterministic problem type URI. `STORAGE_VERSION_CONFLICT` keeps the
 * documented spec URI; every other code derives mechanically so the value
 * is stable without a maintained table.
 */
function problemType(code: string): string {
  if (code === 'STORAGE_VERSION_CONFLICT') return 'urn:agentos:error:version-conflict';
  return `urn:agentos:error:${code.toLowerCase().replace(/_/g, '-')}`;
}

/** Path-only instance URI; the query string is never reflected. */
function requestInstance(req: Request): string {
  const raw = typeof req.originalUrl === 'string' && req.originalUrl.length > 0 ? req.originalUrl : req.url;
  const queryIndex = raw.indexOf('?');
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  return path.length > 0 ? path : '/';
}

export interface ProblemFields {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly title?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly suggestedAction?: string;
  readonly errors?: ApiProblem['errors'];
  readonly context?: ApiProblem['context'];
}

export function sendProblem(req: Request, res: Response, fields: ProblemFields): void {
  const problem: ApiProblem = {
    type: problemType(fields.code),
    title: fields.title ?? STATUS_TITLES[fields.status] ?? 'Error',
    status: fields.status,
    code: fields.code,
    detail: fields.detail,
    instance: requestInstance(req),
    requestId: getRequestId(req),
    retryable: fields.retryable ?? false,
    ...(fields.retryAfterMs !== undefined ? { retryAfterMs: fields.retryAfterMs } : {}),
    ...(fields.suggestedAction !== undefined ? { suggestedAction: fields.suggestedAction } : {}),
    ...(fields.errors !== undefined ? { errors: fields.errors } : {}),
    ...(fields.context !== undefined ? { context: fields.context } : {}),
  };
  res.status(fields.status);
  res.setHeader('Content-Type', 'application/problem+json; charset=utf-8');
  res.send(JSON.stringify(problem));
}

/**
 * Known client-side body/parser request errors: malformed JSON, unsupported
 * or invalid request encoding, and parser body-size request errors.
 * body-parser marks them with a 4xx status/statusCode and a string `type`;
 * anything else is an internal error and never reaches the 400 mapping.
 */
export function isClientBodyParseError(error: unknown): boolean {
  const candidate = error as { type?: unknown; status?: unknown; statusCode?: unknown } | null;
  if (!candidate || typeof candidate.type !== 'string') return false;
  const status = typeof candidate.status === 'number'
    ? candidate.status
    : (typeof candidate.statusCode === 'number' ? candidate.statusCode : undefined);
  return status !== undefined && status >= 400 && status < 500;
}

/** API 404 fallback: mounted after all API routers, before the error middleware. */
export function createApiNotFoundHandler(): RequestHandler {
  return (req, res) => {
    sendProblem(req, res, {
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Route not found',
    });
  };
}

/**
 * Terminal error middleware. Client body/parser errors map to a sanitized
 * 400 VALIDATION_FAILED; everything else maps to a generic 500
 * INTERNAL_ERROR whose detail never leaks the internal message.
 */
export function createProblemErrorHandler(): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (isClientBodyParseError(err)) {
      sendProblem(req, res, {
        status: 400,
        code: 'VALIDATION_FAILED',
        detail: 'Request body could not be parsed',
      });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[AgentOS Server] Unhandled error: ${message}`);
    sendProblem(req, res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'Internal server error',
    });
  };
}
