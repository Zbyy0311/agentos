import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { ApiProblem } from '@agentos/shared';
import { createProblemErrorHandler, createRequestIdMiddleware } from './problemDetails.js';

async function withErrorApp(
  route: (req: express.Request, res: express.Response, next: express.NextFunction) => void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(createRequestIdMiddleware());
  app.get('/boom', route);
  app.use(createProblemErrorHandler());
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

test('problem error handler returns ApiProblem for errors passed through Express middleware', async () => {
  await withErrorApp(
    (_req, _res, next) => next(new Error('boom')),
    async origin => {
      const response = await fetch(`${origin}/boom`);
      assert.equal(response.status, 500);
      const contentType = response.headers.get('content-type') ?? '';
      assert.ok(contentType.startsWith('application/problem+json'));
      const body = await response.json() as ApiProblem;
      assert.equal(body.status, 500);
      assert.equal(body.code, 'INTERNAL_ERROR');
      assert.equal(body.detail, 'Internal server error');
      assert.equal(body.type, 'urn:agentos:error:internal-error');
      assert.equal(body.instance, '/boom');
      assert.equal(body.retryable, false);
      assert.equal(body.requestId, response.headers.get('x-request-id'));
    },
  );
});

test('problem error handler maps client body parser errors to 400 VALIDATION_FAILED', async () => {
  const parserError = Object.assign(new Error('Unexpected token'), {
    type: 'entity.parse.failed',
    status: 400,
  });
  await withErrorApp(
    (_req, _res, next) => next(parserError),
    async origin => {
      const response = await fetch(`${origin}/boom`);
      assert.equal(response.status, 400);
      const body = await response.json() as ApiProblem;
      assert.equal(body.code, 'VALIDATION_FAILED');
      assert.ok(!body.detail.includes('Unexpected token'), 'parser detail must be sanitized');
    },
  );
});

test('problem error handler never reflects the request query string', async () => {
  await withErrorApp(
    (_req, _res, next) => next(new Error('boom')),
    async origin => {
      const response = await fetch(`${origin}/boom?secret=1`);
      const body = await response.json() as ApiProblem;
      assert.equal(body.instance, '/boom');
    },
  );
});
