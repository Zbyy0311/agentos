import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { createDiagnosticRedactor, MAX_DIAGNOSTIC_LINE_CHARS } from './agentos-diagnostic-redaction.mjs';

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const ROTATED_LOG_COUNT = 3;
const MAX_PENDING_LOG_LINE_CHARS = MAX_DIAGNOSTIC_LINE_CHARS;

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { result._.push(value); continue; }
    const key = value.slice(2);
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) result[key] = true;
    else result[key] = argv[++index];
  }
  return result;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8' });
  renameSync(temporary, path);
}

class RotatingLog {
  constructor(path, redactDiagnostic) {
    this.path = path;
    this.bytes = existsSync(path) ? statSync(path).size : 0;
    this.fd = null;
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.suppressLongLine = false;
    this.redactDiagnostic = redactDiagnostic;
    if (this.bytes > MAX_LOG_BYTES) this.rotate();
    this.open();
  }
  open() { if (this.fd === null) this.fd = openSync(this.path, 'a'); }
  rotate() {
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
    try { unlinkSync(this.path + '.' + ROTATED_LOG_COUNT); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (let index = ROTATED_LOG_COUNT - 1; index >= 1; index -= 1) {
      try { renameSync(this.path + '.' + index, this.path + '.' + (index + 1)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { renameSync(this.path, this.path + '.1'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.bytes = 0;
    this.open();
  }
  writeSafe(text) {
    const safe = Buffer.from(this.redactDiagnostic(text), 'utf8');
    let offset = 0;
    while (offset < safe.length) {
      if (this.bytes >= MAX_LOG_BYTES) this.rotate();
      const count = Math.min(safe.length - offset, MAX_LOG_BYTES - this.bytes);
      this.open();
      this.bytes += writeSync(this.fd, safe, offset, count);
      offset += count;
    }
  }
  write(chunk) {
    this.pending += this.decoder.write(chunk);
    while (true) {
      const newline = this.pending.indexOf('\n');
      if (newline < 0) break;
      const line = this.pending.slice(0, newline + 1);
      this.pending = this.pending.slice(newline + 1);
      if (this.suppressLongLine) this.writeSafe('[long diagnostic line omitted]\n');
      else this.writeSafe(line);
      this.suppressLongLine = false;
    }
    if (this.pending.length > MAX_PENDING_LOG_LINE_CHARS) {
      this.pending = '';
      this.suppressLongLine = true;
    }
  }
  close() {
    this.pending += this.decoder.end();
    if (this.pending.length > 0) {
      if (this.suppressLongLine) this.writeSafe('[long diagnostic line omitted]');
      else this.writeSafe(this.pending);
    }
    this.pending = '';
    if (this.fd !== null) { closeSync(this.fd); this.fd = null; }
  }
}

function startChild(role, command, args, cwd, env, stateDir, redactDiagnostic, onClosed) {
  const stdout = new RotatingLog(join(stateDir, role + '.stdout.log'), redactDiagnostic);
  let stderr;
  try {
    stderr = new RotatingLog(join(stateDir, role + '.stderr.log'), redactDiagnostic);
  } catch (error) {
    stdout.close();
    throw error;
  }
  let child;
  try {
    child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  } catch (error) {
    stdout.close();
    stderr.close();
    throw error;
  }
  const entry = { child, closed: false };
  child.stdout.on('data', chunk => stdout.write(chunk));
  child.stderr.on('data', chunk => stderr.write(chunk));
  child.on('error', error => stderr.write(Buffer.from(new Date().toISOString() + ' spawn-error ' + (error.code || 'UNKNOWN') + '\n')));
  child.on('close', (code, signal) => {
    stdout.write(Buffer.from(new Date().toISOString() + ' exit code=' + (code === null ? 'null' : code) + ' signal=' + (signal || 'null') + '\n'));
    stdout.close();
    stderr.close();
    entry.closed = true;
    onClosed();
  });
  return entry;
}

function requestServerShutdown(pipePath, instanceId, nonce) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection(pipePath);
    let response = '';
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error('server shutdown control timed out'));
    }, 5_000);
    timer.unref();
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ operation: 'shutdown', instanceId, nonce }) + '\n'));
    socket.on('data', chunk => {
      response += chunk;
      if (response.length > 2_048) { socket.destroy(new Error('server shutdown response exceeded its limit')); return; }
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        const parsed = JSON.parse(response.slice(0, newline));
        if (!parsed.ok) rejectPromise(new Error('server rejected the bound shutdown identity'));
        else resolvePromise(parsed);
      } catch { rejectPromise(new Error('server shutdown response was invalid')); }
    });
    socket.on('error', error => { clearTimeout(timer); rejectPromise(error); });
  });
}

async function waitForSpawn(entry, role) {
  if (entry.child.pid) return;
  await new Promise((resolvePromise, rejectPromise) => {
    entry.child.once('spawn', resolvePromise);
    entry.child.once('error', rejectPromise);
  });
  if (!entry.child.pid) throw new Error(role + ' did not receive a process ID');
}

async function runWorker() {
  if (process.platform !== 'win32') throw new Error('The AgentOS local lifecycle launcher requires Windows.');
  const args = parseArgs(process.argv.slice(3));
  const root = resolve(args.root || '');
  const dataPath = resolve(args['data-path'] || root);
  const stateDir = resolve(args['state-dir'] || join(dataPath, '.agentos', 'local-runtime'));
  const mode = args.mode || 'production';
  const instanceId = args['instance-id'];
  const serverHost = args['server-host'] || '127.0.0.1';
  const serverPort = Number(args['server-port']);
  const webHost = args['web-host'] || '127.0.0.1';
  const webPort = Number(args['web-port']);
  const supervisorPipe = process.env.AGENTOS_LOCAL_SUPERVISOR_SHUTDOWN_PIPE;
  const serverPipe = process.env.AGENTOS_LOCAL_SERVER_SHUTDOWN_PIPE;
  const shutdownNonce = process.env.AGENTOS_LOCAL_SHUTDOWN_NONCE;
  if (!/^[a-f0-9]{32}$/u.test(instanceId || '') || !/^[a-f0-9]{64}$/u.test(shutdownNonce || '')
    || supervisorPipe !== `\\\\.\\pipe\\agentos-local-${instanceId}-supervisor`
    || serverPipe !== `\\\\.\\pipe\\agentos-local-${instanceId}-server`) {
    throw new Error('Local shutdown control identity is invalid.');
  }
  const serverEntry = resolve(root, 'apps', 'server', 'dist', 'index.js');
  const nextEntry = resolve(root, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
  const serverEnv = {
    ...process.env, PORT: String(serverPort), AGENTOS_SERVER_HOST: serverHost, AGENTOS_PROJECT_ROOT: dataPath,
    AGENTOS_SERVER_INSTANCE_ID: instanceId, AGENTOS_LOCAL_INSTANCE_ID: instanceId,
    AGENTOS_LOCAL_SHUTDOWN_NONCE: shutdownNonce, AGENTOS_LOCAL_SERVER_SHUTDOWN_PIPE: serverPipe,
  };
  const webEnv = { ...process.env, PORT: String(webPort), HOSTNAME: webHost };
  const redactDiagnostic = createDiagnosticRedactor(process.env);
  mkdirSync(stateDir, { recursive: true });
  const entries = [];
  let startupComplete = false;
  let stopping = false;
  let heartbeat = null;
  let shutdownExitCode = 0;
  let shutdownControl = null;
  let shutdownRequestActive = false;
  const finishShutdownIfReady = () => {
    if (stopping && entries.every(entry => entry.closed || entry.child.exitCode !== null || entry.child.signalCode !== null)) {
      process.exit(shutdownExitCode);
    }
  };
  const shutdown = (exitCode, serverAlreadyAccepted = false) => {
    if (stopping) return;
    stopping = true;
    shutdownExitCode = exitCode;
    if (heartbeat !== null) clearInterval(heartbeat);
    void performGracefulShutdown(serverAlreadyAccepted);
  };
  const performGracefulShutdown = async serverAlreadyAccepted => {
    try {
      if (!serverAlreadyAccepted) {
        if (shutdownRequestActive) return;
        shutdownRequestActive = true;
        await requestServerShutdown(serverPipe, instanceId, shutdownNonce);
      }
      const server = entries[0];
      if (server && !server.closed) await new Promise(resolvePromise => server.child.once('close', resolvePromise));
      const web = entries[1];
      if (web && !web.closed && web.child.pid) {
        const webClosed = new Promise(resolvePromise => web.child.once('close', resolvePromise));
        if (!web.child.kill()) throw new Error('verified web child cleanup failed after server shutdown');
        await webClosed;
      }
      finishShutdownIfReady();
    } catch (error) {
      shutdownRequestActive = false;
      stopping = false;
      shutdownExitCode = 1;
      if (heartbeat === null) heartbeat = setInterval(() => {}, 60_000);
      process.stderr.write(new Date().toISOString() + ' STOP_DEFERRED graceful-shutdown ' + (error.message || 'UNKNOWN') + '\n');
    }
  };
  const childClosed = () => {
    if (startupComplete && !stopping) {
      const server = entries[0];
      const serverExited = server && (server.closed || server.child.exitCode !== null || server.child.signalCode !== null);
      // A closed ChildProcess handle is positive evidence that the server is
      // gone. Only then can the supervisor clean up its sibling web process
      // without asking a pipe that no longer exists.
      shutdown(1, Boolean(serverExited));
    }
    else finishShutdownIfReady();
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGHUP', () => shutdown(0));
  try {
    if (mode === 'production') {
      entries.push(startChild('server', process.execPath, ['--disable-warning=ExperimentalWarning', serverEntry], root, serverEnv, stateDir, redactDiagnostic, childClosed));
      entries.push(startChild('web', process.execPath, [nextEntry, 'start', '--hostname', webHost, '--port', String(webPort)], resolve(root, 'apps', 'web'), webEnv, stateDir, redactDiagnostic, childClosed));
    } else if (mode === 'development') {
      const shell = process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      const serverScript = args.stable === 'true' ? 'dev:stable' : 'dev';
      entries.push(startChild('server', shell, ['/d', '/s', '/c', 'pnpm.cmd --filter @agentos/server run ' + serverScript], root, serverEnv, stateDir, redactDiagnostic, childClosed));
      entries.push(startChild('web', process.execPath, [nextEntry, 'dev', '--hostname', webHost, '--port', String(webPort)], resolve(root, 'apps', 'web'), webEnv, stateDir, redactDiagnostic, childClosed));
    } else { throw new Error('Unsupported lifecycle mode.'); }

    await Promise.all(entries.map((entry, index) => waitForSpawn(entry, index === 0 ? 'server' : 'web')));
    if (stopping || entries.some(entry => entry.closed || entry.child.exitCode !== null || entry.child.signalCode !== null)) {
      throw new Error('A local service exited during startup; the remaining owned service will be stopped.');
    }
    const pidsPath = resolve(args['pids-file'] || join(stateDir, 'worker-pids.json'));
    writeJsonAtomic(pidsPath, {
      schemaVersion: 1, instanceId, supervisorPid: process.pid,
      serverPid: entries[0].child.pid, webPid: entries[1].child.pid,
      supervisorPipe, serverPipe, shutdownNonce,
    });
    shutdownControl = net.createServer(socket => {
      socket.setTimeout(5_000, () => socket.destroy());
      let request = '';
      socket.on('data', chunk => {
        request += chunk.toString('utf8');
        if (request.length > 2_048) { socket.destroy(); return; }
        const newline = request.indexOf('\n');
        if (newline < 0) return;
        let message;
        try { message = JSON.parse(request.slice(0, newline)); } catch {
          socket.end('{"ok":false,"code":"INVALID_REQUEST"}\n');
          return;
        }
        const nonce = Buffer.from(typeof message.nonce === 'string' ? message.nonce : '', 'utf8');
        const expected = Buffer.from(shutdownNonce, 'utf8');
        const valid = message.operation === 'shutdown' && message.instanceId === instanceId
          && nonce.length === expected.length && timingSafeEqual(nonce, expected);
        if (!valid) { socket.end('{"ok":false,"code":"CONTROL_IDENTITY_MISMATCH"}\n'); return; }
        if (stopping) { socket.end('{"ok":true,"state":"shutdown-already-requested"}\n'); return; }
        shutdownRequestActive = true;
        void requestServerShutdown(serverPipe, instanceId, shutdownNonce).then(() => {
          socket.end('{"ok":true,"state":"shutdown-accepted"}\n', () => setImmediate(() => shutdown(0, true)));
        }).catch(error => {
          shutdownRequestActive = false;
          process.stderr.write(new Date().toISOString() + ' graceful-shutdown-rejected ' + (error.message || 'UNKNOWN') + '\n');
          socket.end('{"ok":false,"code":"SERVER_CONTROL_UNAVAILABLE"}\n');
        });
      });
    });
    await new Promise((resolvePromise, rejectPromise) => {
      shutdownControl.once('error', rejectPromise);
      shutdownControl.listen(supervisorPipe, resolvePromise);
    });
    startupComplete = true;
    heartbeat = setInterval(() => {}, 60_000);
    if (entries.some(entry => entry.closed || entry.child.exitCode !== null || entry.child.signalCode !== null)) {
      throw new Error('A local service exited during startup; the remaining owned service will be stopped.');
    }
    await new Promise(() => {});
  } catch (error) {
    stopping = true;
    shutdownExitCode = 1;
    if (heartbeat !== null) clearInterval(heartbeat);
    const server = entries[0];
    if (server && !server.closed && server.child.exitCode === null && server.child.signalCode === null) {
      // Startup failure still uses the server's authenticated shutdown path.
      // If control cannot be proven, retain the process and its evidence.
      await performGracefulShutdown(false);
    } else {
      // The server is already gone (or was never spawned), so its maintenance
      // work cannot still own SQLite. Only now may the owned web child stop.
      const web = entries[1];
      if (web && !web.closed && web.child.exitCode === null && web.child.signalCode === null && web.child.pid) {
        if (!web.child.kill()) {
          process.stderr.write(new Date().toISOString() + ' web-child-cleanup-deferred; preserve runtime evidence\\n');
        }
      }
    }
    throw error;
  }
}

if (process.argv[2] === 'worker') {
  runWorker().catch(error => {
    process.stderr.write('agentos-local worker failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
} else {
  process.stderr.write('This helper is started by scripts/agentos-local.ps1.\n');
  process.exitCode = 2;
}
