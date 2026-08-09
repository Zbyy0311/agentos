import test from 'node:test';
import assert from 'node:assert/strict';
import cors from 'cors';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Request, Response } from 'express';
import type { ApiProblem } from '@agentos/shared';
import { createLocalCorsOptions, createLocalWriteGuard, isLoopbackAddress, isLoopbackHost, resolveLocalApiSecurityConfig } from './localApiSecurity.js';

test('uses safe local defaults and parses an explicit origin allowlist', () => {
  assert.deepEqual(resolveLocalApiSecurityConfig({}), {
    host: '127.0.0.1',
    allowedOrigins: ['http://localhost:3001', 'http://127.0.0.1:3001'],
    allowRemote: false,
  });
  assert.deepEqual(resolveLocalApiSecurityConfig({
    AGENTOS_SERVER_HOST: '127.0.0.1',
    AGENTOS_WEB_ORIGINS: 'http://localhost:3001, http://localhost:3001, http://127.0.0.1:3001',
    AGENTOS_ALLOW_REMOTE: 'TRUE',
  }), {
    host: '127.0.0.1',
    allowedOrigins: ['http://localhost:3001', 'http://127.0.0.1:3001'],
    allowRemote: true,
  });
});

test('requires an explicit switch before binding a non-loopback host', () => {
  assert.throws(
    () => resolveLocalApiSecurityConfig({ AGENTOS_SERVER_HOST: '0.0.0.0' }),
    error => error instanceof Error && 'code' in error && error.code === 'remote_bind_disabled',
  );
  assert.equal(resolveLocalApiSecurityConfig({ AGENTOS_SERVER_HOST: '0.0.0.0', AGENTOS_ALLOW_REMOTE: 'true' }).allowRemote, true);
  assert.throws(() => resolveLocalApiSecurityConfig({ AGENTOS_WEB_ORIGINS: '*' }), /通配符 Origin/);
});

test('recognizes loopback hosts and addresses including IPv4-mapped IPv6', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('192.0.2.1'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('cors only grants headers to the configured origins and never enables credentials', async () => {
  const options = createLocalCorsOptions(resolveLocalApiSecurityConfig({}));
  assert.equal(options.credentials, false);
  const origin = options.origin;
  if (typeof origin !== 'function') throw new Error('origin callback missing');

  const result = (value: string | undefined) => new Promise<unknown>((resolve, reject) => origin(value, (error, allowed) => error ? reject(error) : resolve(allowed)));
  await Promise.all([
    result('http://localhost:3001').then(value => assert.equal(value, true)),
    result('https://evil.example').then(value => assert.equal(value, false)),
    result(undefined).then(value => assert.equal(value, true)),
  ]);
});

test('write guard rejects every dangerous method from an unknown or non-loopback origin', () => {
  const guard = createLocalWriteGuard(resolveLocalApiSecurityConfig({}));
  const methods = ['POST', 'PATCH', 'PUT', 'DELETE'];
  for (const method of methods) {
    let nextCalled = false;
    let responseStatus: number | undefined;
    let responseBody: unknown;
    const responseHeaders = new Map<string, string>();
    const response = {
      status(code: number) { responseStatus = code; return this; },
      setHeader(name: string, value: string) { responseHeaders.set(name.toLowerCase(), value); return this; },
      send(body: unknown) { responseBody = typeof body === 'string' ? JSON.parse(body) : body; return this; },
      json(body: unknown) { responseBody = body; return this; },
    } as unknown as Response;
    guard({
      method,
      originalUrl: '/api/workspaces/ws_probe/v2/tasks',
      url: '/tasks',
      headers: {},
      get: () => 'https://evil.example',
      socket: { remoteAddress: '192.0.2.1' },
    } as unknown as Request, response, () => { nextCalled = true; });
    assert.equal(nextCalled, false, method);
    assert.equal(responseStatus, 403, method);
    // M3 P4A MEDIUM-1: the security rejection is an ApiProblem. The stable
    // code is preserved verbatim; the rejected Origin and the remote
    // address are never exposed.
    const problem = responseBody as ApiProblem;
    assert.equal(problem.status, 403, method);
    assert.equal(problem.code, 'origin_not_allowed', method);
    assert.equal(problem.retryable, false, method);
    assert.equal(typeof problem.type, 'string', method);
    assert.equal(typeof problem.title, 'string', method);
    assert.equal(typeof problem.detail, 'string', method);
    assert.equal(typeof problem.instance, 'string', method);
    assert.equal(typeof problem.requestId, 'string', method);
    assert.ok(problem.requestId.length > 0, method);
    assert.equal(responseHeaders.get('content-type'), 'application/problem+json; charset=utf-8', method);
    const serialized = JSON.stringify(problem);
    assert.ok(!serialized.includes('evil.example'), method);
    assert.ok(!serialized.includes('192.0.2.1'), method);
  }
});

async function withCorsApp(run: (origin: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(cors(createLocalCorsOptions(resolveLocalApiSecurityConfig({}))));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === 'string') throw new Error('test server did not bind a port');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function allowedHeaders(response: globalThis.Response): string[] {
  return (response.headers.get('access-control-allow-headers') ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

test('P4A HIGH-1 approved-origin preflight authorizes the P4A browser headers', async () => {
  await withCorsApp(async origin => {
    const response = await fetch(`${origin}/api/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3001',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, If-Match, X-Request-ID',
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:3001');
    const headers = allowedHeaders(response);
    assert.ok(headers.includes('content-type'), `Content-Type missing from ${headers}`);
    assert.ok(headers.includes('if-match'), `If-Match missing from ${headers}`);
    assert.ok(headers.includes('x-request-id'), `X-Request-ID missing from ${headers}`);
    assert.notEqual(response.headers.get('access-control-allow-credentials'), 'true');
  });
});

test('P4A HIGH-1 preflight from an unknown origin is not authorized', async () => {
  await withCorsApp(async origin => {
    const response = await fetch(`${origin}/api/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type, If-Match',
      },
    });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});
