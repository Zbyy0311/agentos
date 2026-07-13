import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createJsonErrorHandler } from './errorHandler.js';

test('returns JSON for errors passed through Express middleware', async () => {
  const app = express();
  app.get('/boom', (_req, _res, next) => next(new Error('boom')));
  app.use(createJsonErrorHandler());

  const server = app.listen(0);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind a port');

    const response = await fetch(`http://127.0.0.1:${address.port}/boom`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'boom' });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
