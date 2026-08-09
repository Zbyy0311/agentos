import { isIP } from 'node:net';
import type { Request, RequestHandler } from 'express';
import type { CorsOptions } from 'cors';
import { sendProblem } from './problemDetails.js';

export interface LocalApiSecurityConfig {
  host: string;
  allowedOrigins: string[];
  allowRemote: boolean;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_ORIGINS = ['http://localhost:3001', 'http://127.0.0.1:3001'];
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function resolveLocalApiSecurityConfig(env: NodeJS.ProcessEnv): LocalApiSecurityConfig {
  const host = env.AGENTOS_SERVER_HOST?.trim() || DEFAULT_HOST;
  const allowRemote = env.AGENTOS_ALLOW_REMOTE?.trim().toLowerCase() === 'true';
  const configuredOrigins = (env.AGENTOS_WEB_ORIGINS ?? '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  const allowedOrigins = configuredOrigins.length > 0 ? [...new Set(configuredOrigins)] : [...DEFAULT_ORIGINS];

  if (allowedOrigins.includes('*')) {
    throw securityError('origin_wildcard_disabled', '本地 API 不允许使用通配符 Origin');
  }
  if (!isLoopbackHost(host) && !allowRemote) {
    throw securityError('remote_bind_disabled', '远程监听已禁用；如需远程访问，请显式设置 AGENTOS_ALLOW_REMOTE=true');
  }

  return { host, allowedOrigins, allowRemote };
}

export function createLocalCorsOptions(config: LocalApiSecurityConfig): CorsOptions {
  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, config.allowedOrigins.includes(origin));
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PATCH', 'PUT', 'DELETE'],
    // M3 P4A HIGH-1: If-Match / X-Request-ID are the P4A browser contract
    // headers; without them an approved-origin preflight rejects the
    // request before the 412/precondition contract can run. Existing
    // allowed headers are preserved; no wildcard.
    // M3 P4B: Idempotency-Key is the browser contract header for the
    // idempotent command routes (create/cancel/start/retry).
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'Authorization',
      'Last-Event-ID',
      'X-Requested-With',
      'If-Match',
      'X-Request-ID',
      'Idempotency-Key',
    ],
    // M3 P4B Remediation 1 (HIGH-1): approved-origin browser JavaScript
    // must be able to READ the P4 response headers, otherwise the
    // ETag -> If-Match precondition chain and the idempotent-replay signal
    // cannot form a real browser contract. No wildcard; only headers the
    // P4 surface actually emits are exposed.
    exposedHeaders: [
      'ETag',
      'X-Request-ID',
      'Idempotency-Replayed',
    ],
    optionsSuccessStatus: 204,
  };
}

export function createLocalWriteGuard(config: LocalApiSecurityConfig): RequestHandler {
  return (req, res, next) => {
    if (!WRITE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const origin = req.get('origin');
    if (origin) {
      if (config.allowedOrigins.includes(origin)) {
        next();
        return;
      }
      denyOrigin(req, res);
      return;
    }

    if (isLoopbackAddress(req.socket.remoteAddress)) {
      next();
      return;
    }

    denyOrigin(req, res);
  };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return true;
  if (normalized === '127.0.0.1' || normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isLoopbackHost(normalized.slice('::ffff:'.length));
  return false;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];
  if (normalized === '::1' || normalized === '127.0.0.1') return true;
  if (normalized.startsWith('::ffff:')) return isLoopbackAddress(normalized.slice('::ffff:'.length));
  return isIP(normalized) === 4 && normalized.startsWith('127.');
}

/**
 * M3 P4A MEDIUM-1: the local write guard rejection is an ApiProblem. The
 * stable code `origin_not_allowed` is preserved verbatim; the rejected
 * Origin and the remote address are never exposed in the response.
 */
function denyOrigin(req: Request, res: Parameters<RequestHandler>[1]): void {
  sendProblem(req, res, {
    status: 403,
    code: 'origin_not_allowed',
    title: 'Forbidden',
    detail: 'Origin is not allowed',
    retryable: false,
  });
}

function securityError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
