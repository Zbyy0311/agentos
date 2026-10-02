// Capture the runner's actual process exit outside the runner itself.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const evidenceIndex = args.indexOf('--evidence-dir');
const shaIndex = args.indexOf('--expected-sha');
if (evidenceIndex < 0 || shaIndex < 0 || !args[evidenceIndex + 1] || !/^[a-f0-9]{40}$/iu.test(args[shaIndex + 1] ?? '')) {
  throw new Error('captured acceptance requires --evidence-dir and --expected-sha');
}
const evidenceRoot = resolve(args[evidenceIndex + 1]);
mkdirSync(evidenceRoot, { recursive: true });
const runner = fileURLToPath(new URL('./verify-existing-project-acceptance.mjs', import.meta.url));
const packageRoot = resolve(dirname(runner), '..');
const logs = { stdout: '', stderr: '' };
const sanitize = text => String(text).replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/giu, '$1[REDACTED]')
  .replace(/((?:api[_-]?key|access[_-]?token|password|secret|credential)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]');
const startedAt = new Date().toISOString();
const child = spawn(process.execPath, [runner, ...args], {
  cwd: packageRoot, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', chunk => { logs.stdout += chunk.toString(); process.stdout.write(sanitize(chunk.toString())); });
child.stderr.on('data', chunk => { logs.stderr += chunk.toString(); process.stderr.write(sanitize(chunk.toString())); });
let spawnError = null;
child.on('error', error => { spawnError = error.code ?? 'SPAWN_FAILED'; });
const outcome = await new Promise(done => child.on('close', (exitCode, signal) => done({ exitCode, signal, spawnError })));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const artifacts = {};
for (const stream of ['stdout', 'stderr']) {
  const content = sanitize(logs[stream]);
  const artifactPath = `runner-${stream}.log`;
  writeFileSync(join(evidenceRoot, artifactPath), content, { flag: 'wx' });
  artifacts[stream] = { artifactPath, sha256: hash(content) };
}
let receiptSha256 = null;
try { receiptSha256 = hash(readFileSync(join(evidenceRoot, 'receipt.json'))); } catch { /* failed runner */ }
writeFileSync(join(evidenceRoot, 'runner-outcome.json'), `${JSON.stringify({
  schemaVersion: 1, source: 'parent-child-process-close', commitSha: args[shaIndex + 1],
  argv: [process.execPath, runner, ...args], cwd: packageRoot, pid: child.pid,
  startedAt, finishedAt: new Date().toISOString(), result: outcome,
  receiptSha256, logs: artifacts,
}, null, 2)}\n`, { flag: 'wx' });
if (outcome.exitCode === 0 && outcome.signal === null && outcome.spawnError === null) {
  const verification = spawnSync(process.execPath, [runner, '--verify-receipt', join(evidenceRoot, 'receipt.json'),
    '--expected-sha', args[shaIndex + 1], '--evidence-dir', evidenceRoot],
  { cwd: packageRoot, windowsHide: true, shell: false, encoding: 'utf8', timeout: 30_000 });
  process.stdout.write(sanitize(verification.stdout));
  process.stderr.write(sanitize(verification.stderr));
  process.exitCode = verification.status === 0 && !verification.error ? 0 : 1;
} else process.exitCode = 1;
