import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';

export function createAcceptanceServerControl() {
  const instanceId = randomBytes(16).toString('hex');
  return { instanceId, nonce: randomBytes(32).toString('hex'),
    pipePath: `\\\\.\\pipe\\agentos-local-${instanceId}-server` };
}

export async function requestAcceptanceServerShutdown(control, timeoutMs = 5_000) {
  if (!/^[a-f0-9]{32}$/u.test(control?.instanceId ?? '')
    || !/^[a-f0-9]{64}$/u.test(control?.nonce ?? '')
    || control.pipePath !== `\\\\.\\pipe\\agentos-local-${control.instanceId}-server`) {
    throw new Error('acceptance server shutdown identity is invalid');
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const socket = createConnection(control.pipePath);
    let response = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error); else resolvePromise(result);
    };
    const timer = setTimeout(() => finish(new Error('acceptance server shutdown control timed out')), timeoutMs);
    socket.on('error', () => finish(new Error('acceptance server shutdown control unavailable')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ operation: 'shutdown',
      instanceId: control.instanceId, nonce: control.nonce })}\n`));
    socket.on('data', chunk => {
      response += chunk.toString('utf8');
      if (response.length > 2_048) { finish(new Error('acceptance server shutdown response is too large')); return; }
      if (!response.includes('\n')) return;
      let result;
      try { result = JSON.parse(response.slice(0, response.indexOf('\n'))); }
      catch { finish(new Error('acceptance server shutdown response is invalid')); return; }
      if (result?.ok !== true || !['shutdown-accepted', 'shutdown-already-requested'].includes(result.state)) {
        finish(new Error('acceptance server shutdown was rejected')); return;
      }
      finish(undefined, { ok: true, state: result.state });
    });
    socket.on('end', () => finish(new Error('acceptance server shutdown response is missing')));
  });
}

/** Never force-terminate a Windows server that may still hold accepted writes. */
export async function stopAcceptanceServer(server, {
  platform = process.platform, timeoutMs = 120_000,
  requestShutdown = requestAcceptanceServerShutdown,
} = {}) {
  const child = server?.child;
  if (!child) return;
  const verifyCleanExit = () => {
    if (platform === 'win32' && (child.exitCode !== 0 || child.signalCode !== null
      || server.shutdownMechanism !== 'authenticated-windows-named-pipe')) {
      throw new Error('acceptance server did not exit cleanly after authenticated shutdown');
    }
  };
  if (child.exitCode !== null || child.signalCode !== null) { verifyCleanExit(); return; }
  let onExit;
  const exited = new Promise(resolvePromise => { onExit = resolvePromise; child.once('exit', onExit); });
  let timer;
  try {
    if (platform === 'win32') {
      const result = await requestShutdown(server.shutdownControl);
      server.shutdownMechanism = 'authenticated-windows-named-pipe';
      server.shutdownState = result.state;
    } else {
      child.kill('SIGTERM');
      server.shutdownMechanism = 'owned-child-signal';
    }
    if (child.exitCode === null && child.signalCode === null) {
      const drained = await Promise.race([exited.then(() => true), new Promise(resolvePromise => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
      })]);
      if (!drained) throw new Error('acceptance server shutdown deferred; process and data ownership retained');
    }
    verifyCleanExit();
  } finally {
    clearTimeout(timer);
    child.removeListener('exit', onExit);
  }
}

export function verifyAcceptanceServerStopEvidence(runtimeEvidence, platform) {
  const processEvidence = runtimeEvidence?.serverProcess;
  if (!Number.isSafeInteger(runtimeEvidence?.serverPid) || runtimeEvidence.serverPid < 1
    || processEvidence?.pid !== runtimeEvidence.serverPid || processEvidence.stopped !== true
    || !(Number.isInteger(processEvidence.exitCode) || typeof processEvidence.signalCode === 'string')) {
    throw new Error('isolated production server stop is not proven through its owned child process handle');
  }
  if (platform === 'win32' && (processEvidence.exitCode !== 0 || processEvidence.signalCode !== null
    || processEvidence.shutdownMechanism !== 'authenticated-windows-named-pipe')) {
    throw new Error('isolated Windows production server lacks clean authenticated shutdown evidence');
  }
}
