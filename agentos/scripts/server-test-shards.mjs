import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function serverTestArguments(files, timeoutMs = 300_000) {
  if (!Array.isArray(files) || !files.length || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Invalid bounded server test command');
  }
  // Unresolved tests fail and cancel within a documented bound. The CI job
  // also bounds processes with leaked resources; never force a passing exit.
  return ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap',
    `--test-timeout=${timeoutMs}`, ...files];
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
    if (receipt.rawExitCode !== 0 || receipt.signal !== null || receipt.spawnError !== null
      || receipt.sourceUnchanged !== true || receipt.counts?.failed !== 0
      || receipt.counts?.cancelled !== 0 || !(receipt.counts?.tests > 0)
      || receipt.counts?.passed + receipt.counts?.skipped + receipt.counts?.todo !== receipt.counts?.tests) {
      throw new Error(`Server shard ${index} did not pass`);
    }
  }
  const files = receipts.flatMap(receipt => receipt.files);
  if (files.length !== plan.files.length || new Set(files).size !== plan.files.length
    || [...files].sort().join('\n') !== plan.files.join('\n')) throw new Error('Incomplete server test coverage');
  return { complete: true, fileCount: files.length, shardCount: receipts.length,
    counts: Object.fromEntries(['passed', 'failed', 'skipped', 'cancelled', 'todo', 'tests']
      .map(key => [key, receipts.reduce((total, receipt) => total + receipt.counts[key], 0)])) };
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
  const argv = serverTestArguments(files);
  const startedAt = new Date().toISOString();
  const child = spawn(process.execPath, argv, { cwd: resolve(root, 'apps/server'), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', bytes => { stdout.push(bytes); process.stdout.write(bytes); });
  child.stderr.on('data', bytes => { stderr.push(bytes); process.stderr.write(bytes); });
  let spawnError = null;
  child.on('error', error => { spawnError = { code: error.code, message: error.message }; });
  const outcome = await new Promise(done => child.on('close', (rawExitCode, signal) => done({ rawExitCode, signal })));
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
  writeFileSync(resolve(directory, 'stdout.log'), out);
  writeFileSync(resolve(directory, 'stderr.log'), err);
  const counts = Object.fromEntries(['pass', 'fail', 'skipped', 'cancelled', 'todo', 'tests'].map(key => {
    const matches = [...out.toString().matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`, 'gm'))];
    return [key === 'pass' ? 'passed' : key === 'fail' ? 'failed' : key, matches.length === 1 ? Number(matches[0][1]) : null];
  }));
  const receipt = { schemaVersion: 1, commitSha: plan.commitSha, treeSha: plan.treeSha,
    runId: plan.runId, inventoryHash: plan.inventoryHash, shardCount: plan.shards.length, shard: index,
    files, command: [process.execPath, ...argv], platform: process.platform, nodeVersion: process.version,
    startedAt, finishedAt: new Date().toISOString(), ...outcome, spawnError, counts,
    sourceUnchanged: git('rev-parse', 'HEAD') === plan.commitSha && !git('status', '--porcelain', '--untracked-files=no'),
    logs: { stdout: createHash('sha256').update(out).digest('hex'), stderr: createHash('sha256').update(err).digest('hex') } };
  writeFileSync(resolve(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  if (receipt.rawExitCode !== 0 || !receipt.sourceUnchanged || spawnError || receipt.signal !== null
    || receipt.counts.failed !== 0 || receipt.counts.cancelled !== 0 || !(receipt.counts.tests > 0)) process.exitCode = 1;
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
