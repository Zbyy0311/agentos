// Capture one real process invocation. This records observations, never PASS rows.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 1) throw new Error('usage: node scripts/capture-lite-verification.mjs LABEL [CWD] -- executable args...');
const label = args[0];
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid label');
const cwd = resolve(root, args[1] && separator > 1 ? args[1] : '.');
const command = args.slice(separator + 1);
if (!command.length) throw new Error('Missing executable');
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
const baseline = git('rev-parse', 'HEAD');
const initialStatus = git('status', '--porcelain', '--untracked-files=no');
if (initialStatus) throw new Error('Verification requires a clean tracked checkout');
const folder = resolve(root, 'logs/pass-audit', baseline, label + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(folder, { recursive: true });
const stdoutFile = resolve(folder, 'stdout.log');
const stderrFile = resolve(folder, 'stderr.log');
const stdout = createWriteStream(stdoutFile);
const stderr = createWriteStream(stderrFile);
const startedAt = new Date().toISOString();
const child = spawn(command[0], command.slice(1), { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let error = null;
child.on('error', value => { error = { code: value.code, message: value.message }; });
child.stdout?.pipe(stdout);
child.stderr?.pipe(stderr);
const outcome = await new Promise(done => child.on('close', (rawExitCode, signal) => done({ rawExitCode, signal })));
await Promise.all([new Promise(done => stdout.end(done)), new Promise(done => stderr.end(done))]);
const out = readFileSync(stdoutFile, 'utf8');
const err = readFileSync(stderrFile, 'utf8');
const count = name => { const values = [...out.matchAll(new RegExp('^# ' + name + ' (\\d+)\\s*$', 'gm'))]; return values.length === 1 ? Number(values[0][1]) : null; };
const counts = { passed: count('pass'), failed: count('fail'), skipped: count('skipped'), cancelled: count('cancelled'), todo: count('todo'), tests: count('tests') };
const allowEnv = /^(M4_P4_REAL.*|AGENTOS_(KIMI|KIMICODE|CODEX|OPENCODE)_(MODEL|CLI))$/;
const metadata = {
  schemaVersion: 1, baseline, label, startedAt, finishedAt: new Date().toISOString(),
  command: { executable: command[0], args: command.slice(1) }, cwd: relative(root, cwd) || '.',
  environment: Object.fromEntries(Object.entries(process.env).filter(([key]) => allowEnv.test(key))),
  nodeVersion: process.version, ...outcome, error,
  trackedCheckoutUnchanged: git('rev-parse', 'HEAD') === baseline && git('status', '--porcelain', '--untracked-files=no') === initialStatus,
  counts, assertionCoverage: [],
  logs: [stdoutFile, stderrFile].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })),
  limitation: 'Counts are parsed only from a unique TAP summary; null means unparsed, never zero. Named test results remain in raw output. No acceptance promotion.',
};
writeFileSync(resolve(folder, 'receipt.json'), JSON.stringify(metadata, null, 2) + '\n');
console.log(JSON.stringify({ receipt: resolve(folder, 'receipt.json'), rawExitCode: outcome.rawExitCode, signal: outcome.signal, counts, error }));
console.log((out + '\n' + err).split('\n').slice(-18).join('\n'));
process.exitCode = metadata.trackedCheckoutUnchanged ? (outcome.rawExitCode ?? 1) : 1;
