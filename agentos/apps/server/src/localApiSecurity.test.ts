import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
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
    const response = {
      status(code: number) { responseStatus = code; return this; },
      json(body: unknown) { responseBody = body; return this; },
    } as unknown as Response;
    guard({ method, get: () => 'https://evil.example', socket: { remoteAddress: '192.0.2.1' } } as unknown as Request, response, () => { nextCalled = true; });
    assert.equal(nextCalled, false, method);
    assert.equal(responseStatus, 403, method);
    assert.deepEqual(responseBody, { error: 'origin_not_allowed', code: 'origin_not_allowed' });
  }
});
