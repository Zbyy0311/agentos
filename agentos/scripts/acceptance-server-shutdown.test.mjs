import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { createAcceptanceServerControl, requestAcceptanceServerShutdown, stopAcceptanceServer, verifyAcceptanceServerStopEvidence } from './acceptance-server-shutdown.mjs';

function childFixture() {
  const child = new EventEmitter();
  Object.assign(child, { exitCode: null, signalCode: null, kills: [] });
  child.kill = signal => { child.kills.push(signal); return true; };
  return child;
}

test('acceptance server control binds a unique instance, nonce, and exact named pipe', async () => {
  const a = createAcceptanceServerControl(), b = createAcceptanceServerControl();
  assert.notEqual(a.instanceId, b.instanceId);
  assert.notEqual(a.nonce, b.nonce);
  assert.equal(a.pipePath, `\\\\.\\pipe\\agentos-local-${a.instanceId}-server`);
  await assert.rejects(requestAcceptanceServerShutdown({ ...a, pipePath: b.pipePath }), /identity is invalid/u);
});

test('accepted Windows shutdown waits for the owned process exit without kill', async () => {
  const child = childFixture(), server = { child, shutdownControl: createAcceptanceServerControl() };
  await stopAcceptanceServer(server, { platform: 'win32', timeoutMs: 1_000, requestShutdown: async control => {
    assert.equal(control, server.shutdownControl);
    setTimeout(() => { child.exitCode = 0; child.emit('exit', 0, null); }, 20);
    return { ok: true, state: 'shutdown-accepted' };
  } });
  assert.deepEqual(child.kills, []);
  assert.equal(server.shutdownMechanism, 'authenticated-windows-named-pipe');
  assert.equal(child.listenerCount('exit'), 0);
});

test('rejected or timed-out Windows shutdown preserves the running process', async () => {
  for (const unavailable of [false, true]) {
    const child = childFixture(), server = { child, shutdownControl: createAcceptanceServerControl() };
    await assert.rejects(stopAcceptanceServer(server, { platform: 'win32', timeoutMs: 15,
      requestShutdown: async () => {
        if (unavailable) throw new Error('control unavailable');
        return { ok: true, state: 'shutdown-accepted' };
      } }), unavailable ? /control unavailable/u : /shutdown deferred/u);
    assert.deepEqual(child.kills, []);
    assert.equal(child.exitCode, null);
    assert.equal(child.listenerCount('exit'), 0);
  }
});

test('a forced or unsuccessful Windows exit cannot satisfy clean shutdown evidence', async () => {
  const child = childFixture();
  await assert.rejects(stopAcceptanceServer({ child }, { platform: 'win32', requestShutdown: async () => {
    child.exitCode = 1;
    return { ok: true, state: 'shutdown-accepted' };
  } }), /did not exit cleanly/u);
});

test('an already exited Windows child still needs clean authenticated shutdown evidence', async () => {
  const child = childFixture();
  child.exitCode = 0;
  await assert.rejects(stopAcceptanceServer({ child }, { platform: 'win32' }), /did not exit cleanly/u);
  await stopAcceptanceServer({ child, shutdownMechanism: 'authenticated-windows-named-pipe' }, { platform: 'win32' });
  child.exitCode = 1;
  await assert.rejects(stopAcceptanceServer({ child, shutdownMechanism: 'authenticated-windows-named-pipe' },
    { platform: 'win32' }), /did not exit cleanly/u);
});

test('runtime receipt rejects forced exits, foreign identity and missing Windows shutdown proof', () => {
  const evidence = { serverPid: 1234, serverProcess: { pid: 1234, stopped: true,
    exitCode: 0, signalCode: null, shutdownMechanism: 'authenticated-windows-named-pipe' } };
  assert.doesNotThrow(() => verifyAcceptanceServerStopEvidence(evidence, 'win32'));
  for (const patch of [{ exitCode: 1 }, { signalCode: 'SIGTERM' }, { shutdownMechanism: undefined },
    { shutdownMechanism: 'owned-child-signal' }]) {
    assert.throws(() => verifyAcceptanceServerStopEvidence({ ...evidence,
      serverProcess: { ...evidence.serverProcess, ...patch } }, 'win32'), /clean authenticated shutdown/u);
  }
  assert.throws(() => verifyAcceptanceServerStopEvidence({ ...evidence,
    serverProcess: { ...evidence.serverProcess, pid: 1235 } }, 'win32'), /owned child/u);
});

test('Windows pipe transport sends the exact instance nonce and rejects malformed responses',
  { skip: process.platform !== 'win32' }, async () => {
    for (const reply of ['{"ok":true,"state":"shutdown-accepted"}\n', 'null\n',
      '{"ok":false,"state":"shutdown-accepted"}\n', 'not-json\n']) {
      const control = createAcceptanceServerControl();
      let observed;
      const pipe = createServer(socket => {
        let request = '';
        socket.on('data', bytes => {
          request += bytes.toString('utf8');
          if (!request.includes('\n')) return;
          observed = JSON.parse(request.slice(0, request.indexOf('\n')));
          socket.end(reply);
        });
      });
      await new Promise((done, reject) => { pipe.once('error', reject); pipe.listen(control.pipePath, done); });
      try {
        if (reply.startsWith('{"ok":true')) assert.deepEqual(await requestAcceptanceServerShutdown(control),
          { ok: true, state: 'shutdown-accepted' });
        else await assert.rejects(requestAcceptanceServerShutdown(control), /rejected|invalid/u);
        assert.deepEqual(observed, { operation: 'shutdown', instanceId: control.instanceId, nonce: control.nonce });
      } finally { await new Promise((done, reject) => pipe.close(error => error ? reject(error) : done())); }
    }
  });
