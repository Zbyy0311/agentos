import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import test from 'node:test';

import { closeLocalShutdownControl, startLocalShutdownControl } from './LocalShutdownControl.js';

async function exchange(pipePath: string, request: string): Promise<Record<string, unknown>> {
  const socket = createConnection(pipePath);
  return new Promise((resolve, reject) => {
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timed out waiting for the shutdown pipe response'));
    }, 3_000);
    socket.once('connect', () => socket.write(`${request}\n`));
    socket.on('data', chunk => {
      response += chunk.toString('utf8');
    });
    socket.once('end', () => {
      clearTimeout(timeout);
      const newline = response.indexOf('\n');
      try {
        if (newline < 0) throw new Error('Shutdown pipe response was not newline-terminated');
        resolve(JSON.parse(response.slice(0, newline)) as Record<string, unknown>);
      } catch (error) { reject(error); }
    });
    socket.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test('Windows shutdown pipe rejects malformed identities and remains live after duplicate requests', {
  skip: process.platform !== 'win32',
}, async () => {
  const instanceId = randomUUID().replace(/-/gu, '');
  const nonce = randomBytes(32).toString('hex');
  const pipePath = `\\\\.\\pipe\\agentos-local-${instanceId}-server`;
  let shutdownCalls = 0;
  const server = await startLocalShutdownControl({ pipePath, instanceId, nonce, onShutdown: () => { shutdownCalls++; } });
  const valid = JSON.stringify({ operation: 'shutdown', instanceId, nonce });
  const mismatchNonce = `${nonce.slice(0, -1)}${nonce.endsWith('0') ? '1' : '0'}`;

  try {
    assert.deepEqual(await exchange(pipePath, JSON.stringify({ operation: 'shutdown', instanceId, nonce: mismatchNonce })), {
      ok: false, code: 'CONTROL_IDENTITY_MISMATCH',
    });
    for (const raw of ['null', 'true', '42', '"primitive"', '[]']) {
      assert.deepEqual(await exchange(pipePath, raw), { ok: false, code: 'INVALID_REQUEST' }, raw);
      assert.equal(server.listening, true, `pipe remains available after ${raw}`);
    }
    assert.equal(shutdownCalls, 0, 'invalid requests do not invoke shutdown');

    assert.deepEqual(await exchange(pipePath, valid), { ok: true, state: 'shutdown-accepted' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(shutdownCalls, 1);
    assert.deepEqual(await exchange(pipePath, valid), { ok: true, state: 'shutdown-already-requested' });
    assert.deepEqual(await exchange(pipePath, 'null'), { ok: false, code: 'INVALID_REQUEST' });
    assert.equal(shutdownCalls, 1, 'duplicate and malformed requests never repeat the shutdown callback');
    assert.equal(server.listening, true, 'the control server remains alive after rejected and duplicate requests');
  } finally {
    await closeLocalShutdownControl(server);
  }
});
