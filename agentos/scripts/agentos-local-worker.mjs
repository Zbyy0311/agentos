import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const ROTATED_LOG_COUNT = 3;
const MAX_PENDING_LOG_LINE_CHARS = 64 * 1024;
const SENSITIVE_ENV_NAME = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|authorization|cookie)/i;

function collectSensitiveValues(env) {
  return [...new Set(Object.entries(env)
    .filter(([name]) => SENSITIVE_ENV_NAME.test(name))
    .map(([, value]) => String(value || ''))
    .filter(value => value.length >= 4 && value.length <= 8192))]
    .sort((left, right) => right.length - left.length);
}

function redactDiagnostic(text, sensitiveValues) {
  let safe = text;
  for (const value of sensitiveValues) safe = safe.split(value).join('[REDACTED]');
  safe = safe
    .replace(/((?:authorization|proxy-authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|token|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[REDACTED_TOKEN]');
  return safe;
}

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
  constructor(path, sensitiveValues) {
    this.path = path;
    this.bytes = existsSync(path) ? statSync(path).size : 0;
    this.fd = null;
    this.decoder = new StringDecoder('utf8');
    this.pending = '';
    this.suppressLongLine = false;
    this.sensitiveValues = sensitiveValues;
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
    const safe = Buffer.from(redactDiagnostic(text, this.sensitiveValues), 'utf8');
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

function startChild(role, command, args, cwd, env, stateDir, sensitiveValues, onClosed) {
  const stdout = new RotatingLog(join(stateDir, role + '.stdout.log'), sensitiveValues);
  let stderr;
  try {
    stderr = new RotatingLog(join(stateDir, role + '.stderr.log'), sensitiveValues);
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

function terminateEntries(entries) {
  const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  for (const entry of [...entries].reverse()) {
    const child = entry.child;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
    if (result.error || result.status !== 0) {
      try { child.kill(); } catch {}
    }
  }
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
  const serverEntry = resolve(root, 'apps', 'server', 'dist', 'index.js');
  const nextEntry = resolve(root, 'apps', 'web', 'node_modules', 'next', 'dist', 'bin', 'next');
  const serverEnv = { ...process.env, PORT: String(serverPort), AGENTOS_SERVER_HOST: serverHost, AGENTOS_PROJECT_ROOT: dataPath };
  const webEnv = { ...process.env, PORT: String(webPort), HOSTNAME: webHost };
  const sensitiveValues = collectSensitiveValues(process.env);
  mkdirSync(stateDir, { recursive: true });
  const entries = [];
  let startupComplete = false;
  let stopping = false;
  let heartbeat = null;
  let shutdownDeadline = null;
  let shutdownExitCode = 0;
  const finishShutdownIfReady = () => {
    if (stopping && entries.every(entry => entry.closed || entry.child.exitCode !== null || entry.child.signalCode !== null)) {
      if (shutdownDeadline !== null) clearTimeout(shutdownDeadline);
      process.exit(shutdownExitCode);
    }
  };
  const shutdown = exitCode => {
    if (stopping) return;
    stopping = true;
    shutdownExitCode = exitCode;
    if (heartbeat !== null) clearInterval(heartbeat);
    terminateEntries(entries);
    shutdownDeadline = setTimeout(() => process.exit(shutdownExitCode), 10_000);
    shutdownDeadline.unref();
    finishShutdownIfReady();
  };
  const childClosed = () => {
    if (startupComplete && !stopping) shutdown(1);
    else finishShutdownIfReady();
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGHUP', () => shutdown(0));
  try {
    if (mode === 'production') {
      entries.push(startChild('server', process.execPath, ['--disable-warning=ExperimentalWarning', serverEntry], root, serverEnv, stateDir, sensitiveValues, childClosed));
      entries.push(startChild('web', process.execPath, [nextEntry, 'start', '--hostname', webHost, '--port', String(webPort)], resolve(root, 'apps', 'web'), webEnv, stateDir, sensitiveValues, childClosed));
    } else if (mode === 'development') {
      const shell = process.env.ComSpec || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
      const serverScript = args.stable === 'true' ? 'dev:stable' : 'dev';
      entries.push(startChild('server', shell, ['/d', '/s', '/c', 'pnpm.cmd --filter @agentos/server run ' + serverScript], root, serverEnv, stateDir, sensitiveValues, childClosed));
      entries.push(startChild('web', process.execPath, [nextEntry, 'dev', '--hostname', webHost, '--port', String(webPort)], resolve(root, 'apps', 'web'), webEnv, stateDir, sensitiveValues, childClosed));
    } else { throw new Error('Unsupported lifecycle mode.'); }

    await Promise.all(entries.map((entry, index) => waitForSpawn(entry, index === 0 ? 'server' : 'web')));
    if (stopping || entries.some(entry => entry.closed || entry.child.exitCode !== null || entry.child.signalCode !== null)) {
      throw new Error('A local service exited during startup; the remaining owned service will be stopped.');
    }
    const pidsPath = resolve(args['pids-file'] || join(stateDir, 'worker-pids.json'));
    writeJsonAtomic(pidsPath, {
      schemaVersion: 1, instanceId, supervisorPid: process.pid,
      serverPid: entries[0].child.pid, webPid: entries[1].child.pid,
    });
    startupComplete = true;
    heartbeat = setInterval(() => {}, 60_000);
    if (entries.some(entry => entry.closed || entry.child.exitCode !== null || entry.child.signalCode !== null)) {
      throw new Error('A local service exited during startup; the remaining owned service will be stopped.');
    }
    await new Promise(() => {});
  } catch (error) {
    stopping = true;
    if (heartbeat !== null) clearInterval(heartbeat);
    terminateEntries(entries);
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
