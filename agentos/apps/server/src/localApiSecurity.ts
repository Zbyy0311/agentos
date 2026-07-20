import { isIP } from 'node:net';
import type { RequestHandler } from 'express';
import type { CorsOptions } from 'cors';

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
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'Last-Event-ID', 'X-Requested-With'],
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
      denyOrigin(res);
      return;
    }

    if (isLoopbackAddress(req.socket.remoteAddress)) {
      next();
      return;
    }

    denyOrigin(res);
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

function denyOrigin(res: Parameters<RequestHandler>[1]): void {
  res.status(403).json({ error: 'origin_not_allowed', code: 'origin_not_allowed' });
}

function securityError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
