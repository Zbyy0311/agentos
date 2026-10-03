import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const SERVER_TEST_CASE_TIMEOUT_MS = 300_000;
// The CI shard job is capped at 60 minutes. A 20-minute per-file wall clock
// leaves room for setup and the remaining shard inventory while allowing the
// observed long SQLite/Git files to exceed the old five-minute assumption.
export const SERVER_TEST_FILE_TIMEOUT_MS = 20 * 60_000;
const countKeys = ['passed', 'failed', 'skipped', 'cancelled', 'todo', 'tests'];

export function serverTestArguments(files, perTestTimeoutMs = SERVER_TEST_CASE_TIMEOUT_MS) {
  if (!Array.isArray(files) || !files.length || !Number.isSafeInteger(perTestTimeoutMs) || perTestTimeoutMs < 1) {
    throw new Error('Invalid bounded server test command');
  }
  return ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap',
    `--test-timeout=${perTestTimeoutMs}`, ...files];
}

export function partitionTests(files, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw new Error('Invalid shard count');
  if (!files.length || new Set(files.map(file => file.path)).size !== files.length) throw new Error('Invalid test inventory');
  const shards = Array.from({ length: count }, () => ({ files: [], weight: 0 }));
  for (const file of [...files].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path, 'en'))) {
    const target = shards.reduce((best, shard) => shard.weight < best.weight ? shard : best);
    target.files.push(file.path);
    target.weight += file.bytes;
  }
  return shards.map(shard => shard.files.sort());
}

export function validateReceipts(plan, receipts) {
  if (receipts.length !== plan.shards.length) throw new Error('Missing or duplicate shard receipt');
  const seen = new Set();
  for (const receipt of receipts) {
    const index = receipt.shard;
    if (!Number.isSafeInteger(index) || !plan.shards[index] || seen.has(index)) throw new Error('Duplicate or invalid shard');
    seen.add(index);
    if (receipt.commitSha !== plan.commitSha || receipt.treeSha !== plan.treeSha
      || receipt.inventoryHash !== plan.inventoryHash || receipt.runId !== plan.runId
      || JSON.stringify(receipt.files) !== JSON.stringify(plan.shards[index])) throw new Error('Shard evidence does not match frozen inventory');
    if (receipt.schemaVersion !== 2 || receipt.timedOut !== false
      || receipt.budgets?.perTestTimeoutMs !== SERVER_TEST_CASE_TIMEOUT_MS
      || receipt.budgets?.perFileTimeoutMs !== SERVER_TEST_FILE_TIMEOUT_MS
      || !Array.isArray(receipt.fileResults) || receipt.fileResults.length !== receipt.files.length
      || JSON.stringify(receipt.fileResults.map(result => result.file)) !== JSON.stringify(receipt.files)) {
      throw new Error(`Server shard ${index} has incomplete per-file execution evidence`);
    }
    for (const result of receipt.fileResults) {
      if (result.rawExitCode !== 0 || result.signal !== null || result.spawnError !== null || result.timedOut !== false
        || result.perTestTimeoutMs !== SERVER_TEST_CASE_TIMEOUT_MS || result.perFileTimeoutMs !== SERVER_TEST_FILE_TIMEOUT_MS
        || !validTestCounts(result.counts)) {
        throw new Error(`Server test file ${result.file} did not pass within its budgets`);
      }
    }
    const fileCounts = sumCounts(receipt.fileResults.map(result => result.counts));
    if (JSON.stringify(receipt.counts) !== JSON.stringify(fileCounts)) throw new Error('Shard totals do not match per-file evidence');
    if (receipt.rawExitCode !== 0 || receipt.signal !== null || receipt.spawnError !== null
      || receipt.sourceUnchanged !== true || !validTestCounts(receipt.counts)) {
      throw new Error(`Server shard ${index} did not pass`);
    }
  }
  const files = receipts.flatMap(receipt => receipt.files);
  if (files.length !== plan.files.length || new Set(files).size !== plan.files.length
    || [...files].sort().join('\n') !== plan.files.join('\n')) throw new Error('Incomplete server test coverage');
  return { complete: true, fileCount: files.length, shardCount: receipts.length,
    counts: sumCounts(receipts.map(receipt => receipt.counts)) };
}

function validTestCounts(counts) {
  return counts && countKeys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
    && counts.failed === 0 && counts.cancelled === 0 && counts.tests > 0
    && counts.passed + counts.skipped + counts.todo === counts.tests;
}

function sumCounts(countsList) {
  return Object.fromEntries(countKeys.map(key => [key,
    countsList.every(counts => Number.isSafeInteger(counts?.[key]))
      ? countsList.reduce((total, counts) => total + counts[key], 0) : null]));
}

function parseTapCounts(output) {
  const text = output.toString('utf8');
  return Object.fromEntries(['pass', 'fail', 'skipped', 'cancelled', 'todo', 'tests'].map(key => {
    const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))];
    return [key === 'pass' ? 'passed' : key === 'fail' ? 'failed' : key,
      matches.length === 1 ? Number(matches[0][1]) : null];
  }));
}

function terminateOwnedProcessTree(child) {
  if (child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 10_000,
      });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* the owned process may already be closed */ }
  }
}

export async function runTestFile(file, {
  cwd = resolve(root, 'apps/server'),
  perTestTimeoutMs = SERVER_TEST_CASE_TIMEOUT_MS,
  perFileTimeoutMs = SERVER_TEST_FILE_TIMEOUT_MS,
  onStdout = () => {},
  onStderr = () => {},
} = {}) {
  if (typeof file !== 'string' || !file || !Number.isSafeInteger(perFileTimeoutMs) || perFileTimeoutMs < 1) {
    throw new Error('Invalid bounded server test file');
  }
  const command = [process.execPath, ...serverTestArguments([file], perTestTimeoutMs)];
  const started = Date.now();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(command[0], command.slice(1), {
    cwd, env, windowsHide: true, shell: false, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [], stderr = [];
  child.stdout.on('data', bytes => { stdout.push(bytes); onStdout(bytes); });
  child.stderr.on('data', bytes => { stderr.push(bytes); onStderr(bytes); });
  let spawnError = null;
  let timedOut = false;
  let timeoutHandle;
  const outcome = await new Promise(done => {
    child.on('error', error => { spawnError = { code: error.code, message: error.message }; });
    child.on('close', (rawExitCode, signal) => {
      clearTimeout(timeoutHandle);
      done({ rawExitCode, signal });
    });
    timeoutHandle = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      terminateOwnedProcessTree(child);
    }, perFileTimeoutMs);
  });
  return {
    command, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started, ...outcome, spawnError, timedOut,
    perTestTimeoutMs, perFileTimeoutMs,
    stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
  };
}

function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim(); }
function currentPlan(count) {
  const repositoryRoot = git('rev-parse', '--show-toplevel');
  const commitSha = git('rev-parse', 'HEAD');
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commitSha) throw new Error('Checkout differs from GITHUB_SHA');
  if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('Server gate requires a clean tracked checkout');
  const paths = git('ls-files', '--full-name', 'apps/server/src').split('\n')
    .filter(path => /^agentos\/apps\/server\/src\/.*\.test\.ts$/u.test(path));
  const inventory = paths.sort().map(path => ({ path: path.replace(/^agentos\/apps\/server\//u, ''),
    bytes: readFileSync(resolve(repositoryRoot, path)).length }));
  return { commitSha, treeSha: git('rev-parse', 'HEAD^{tree}'),
    runId: process.env.P4_CI_RUN_ID || 'local', files: inventory.map(file => file.path),
    inventoryHash: hash(inventory), shards: partitionTests(inventory, count) };
}

async function runShard(plan, index, output) {
  const files = plan.shards[index];
  if (!files?.length) throw new Error('Invalid or empty shard');
  const directory = resolve(output, `shard-${index}`);
  mkdirSync(directory, { recursive: true });
  const startedAt = new Date().toISOString();
  const fileResults = [];
  const stdout = [], stderr = [];
  for (const [fileIndex, file] of files.entries()) {
    const fileDirectory = resolve(directory, `file-${String(fileIndex).padStart(3, '0')}`);
    mkdirSync(fileDirectory, { recursive: true });
    const result = await runTestFile(file, {
      onStdout: bytes => { stdout.push(bytes); process.stdout.write(bytes); },
      onStderr: bytes => { stderr.push(bytes); process.stderr.write(bytes); },
    });
    writeFileSync(resolve(fileDirectory, 'stdout.log'), result.stdout);
    writeFileSync(resolve(fileDirectory, 'stderr.log'), result.stderr);
    const fileResult = {
      file, command: result.command, startedAt: result.startedAt, finishedAt: result.finishedAt,
      elapsedMs: result.elapsedMs, rawExitCode: result.rawExitCode, signal: result.signal,
      spawnError: result.spawnError, timedOut: result.timedOut,
      perTestTimeoutMs: result.perTestTimeoutMs, perFileTimeoutMs: result.perFileTimeoutMs,
      counts: parseTapCounts(result.stdout),
      logs: { stdout: createHash('sha256').update(result.stdout).digest('hex'),
        stderr: createHash('sha256').update(result.stderr).digest('hex') },
    };
    writeFileSync(resolve(fileDirectory, 'file-result.json'), JSON.stringify(fileResult, null, 2) + '\n');
    fileResults.push(fileResult);
  }
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  writeFileSync(resolve(directory, 'stdout.log'), out);
  writeFileSync(resolve(directory, 'stderr.log'), err);
  const counts = sumCounts(fileResults.map(result => result.counts));
  const filePassed = result => result.rawExitCode === 0 && result.signal === null
    && result.spawnError === null && result.timedOut === false && validTestCounts(result.counts);
  const firstFailure = fileResults.find(result => !filePassed(result));
  const receipt = { schemaVersion: 2, commitSha: plan.commitSha, treeSha: plan.treeSha,
    runId: plan.runId, inventoryHash: plan.inventoryHash, shardCount: plan.shards.length, shard: index,
    files, commands: fileResults.map(result => result.command), fileResults,
    budgets: { perTestTimeoutMs: SERVER_TEST_CASE_TIMEOUT_MS, perFileTimeoutMs: SERVER_TEST_FILE_TIMEOUT_MS },
    platform: process.platform, nodeVersion: process.version,
    startedAt, finishedAt: new Date().toISOString(),
    rawExitCode: firstFailure ? firstFailure.rawExitCode : 0,
    signal: firstFailure?.signal ?? null, spawnError: firstFailure?.spawnError ?? null,
    timedOut: fileResults.some(result => result.timedOut), counts,
    sourceUnchanged: git('rev-parse', 'HEAD') === plan.commitSha && !git('status', '--porcelain', '--untracked-files=no'),
    logs: { stdout: createHash('sha256').update(out).digest('hex'), stderr: createHash('sha256').update(err).digest('hex') } };
  writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (firstFailure || receipt.rawExitCode !== 0 || !receipt.sourceUnchanged || receipt.spawnError
    || receipt.signal !== null || receipt.timedOut || !validTestCounts(receipt.counts)) process.exitCode = 1;
}

function collectReceipts(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? collectReceipts(path) : entry.name === 'receipt.json' ? [JSON.parse(readFileSync(path, 'utf8'))] : [];
  });
}

async function main() {
  const [mode, countText, indexOrDirectory, outputDirectory] = process.argv.slice(2);
  const plan = currentPlan(Number(countText));
  if (mode === 'list') { console.log(JSON.stringify(plan, null, 2)); return; }
  if (mode === 'run') { await runShard(plan, Number(indexOrDirectory), outputDirectory ?? resolve(root, 'logs/p4-server-shards', plan.commitSha, plan.runId)); return; }
  if (mode === 'verify') {
    const result = validateReceipts(plan, collectReceipts(resolve(indexOrDirectory)));
    const output = { ...result, commitSha: plan.commitSha, treeSha: plan.treeSha, inventoryHash: plan.inventoryHash, runId: plan.runId };
    const target = resolve(root, 'logs/p4-server-shards', plan.commitSha, plan.runId, 'coverage.json');
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output)); return;
  }
  throw new Error('Usage: server-test-shards.mjs list|run|verify COUNT [INDEX|RECEIPT_DIRECTORY] [OUTPUT_DIRECTORY]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
