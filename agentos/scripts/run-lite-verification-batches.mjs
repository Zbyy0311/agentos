/**
 * S8 / Lite runtime verification batches.
 *
 * The S0 matrix records, for each RUNTIME-VERIFY requirement, the test file that
 * is expected to carry its clause-level evidence. This runner turns that into
 * executed evidence: it groups those requirements by their test file, runs each
 * file in the package that owns it, and reports per requirement whether the file
 * passed with zero skipped tests.
 *
 * A requirement is only reported as provable when its own batch passed with
 * `failed === 0 && skipped === 0 && passed > 0`; anything else stays open with
 * the raw numbers attached, so a flaky or environment-dependent file cannot
 * quietly promote a requirement.
 *
 * Usage:
 *   node scripts/run-lite-verification-batches.mjs [--only <id,id>] [--json <out>]
 *     [--timeoutMs <n>] [--list]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
};
const only = typeof arg('only', undefined) === 'string' ? String(arg('only')).split(',').map(s => s.trim()) : undefined;
const listOnly = arg('list', false) === true;
const timeoutMs = Number(arg('timeoutMs', 900_000));
const outPath = typeof arg('json', undefined) === 'string' ? String(arg('json')) : 'docs/implementation/lite-closeout/verification-batches.json';

const matrix = JSON.parse(readFileSync(join(repoRoot, 'docs/implementation/lite-closeout/matrix.json'), 'utf8'));
const isTestFile = value => /\.test\.(ts|tsx|ps1|mjs)$/.test(value) && !value.includes('progress');

function runnerFor(file) {
  if (file.startsWith('apps/server/')) return { cwd: 'apps/server', cmd: ['node', '--import', 'tsx', '--test', '--test-concurrency=1', file.slice('apps/server/'.length)] };
  if (file.startsWith('apps/web/')) return { cwd: 'apps/web', cmd: ['node', '--import', 'tsx', '--test', file.slice('apps/web/'.length)] };
  const pkg = /^(packages\/[^/]+)\//.exec(file);
  // A package may be a pure type/contract package with no local test tooling
  // (packages/shared). Its tests still run through the workspace root's tsx from
  // the server package, which is where the tooling is linked.
  if (pkg) {
    // Only a package that actually declares vitest can run it; a pure
    // contract package (packages/shared) has no local vitest even though it has
    // a node_modules/.bin directory.
    let declaresVitest = false;
    try {
      const manifest = JSON.parse(readFileSync(join(repoRoot, pkg[1], 'package.json'), 'utf8'));
      declaresVitest = Boolean(manifest.devDependencies?.vitest ?? manifest.dependencies?.vitest);
    } catch {
      declaresVitest = false;
    }
    return declaresVitest
      ? { cwd: pkg[1], cmd: ['pnpm', 'exec', 'vitest', 'run', file.slice(pkg[1].length + 1)] }
      : { cwd: 'apps/server', cmd: ['node', '--import', 'tsx', '--test', '--test-concurrency=1', '../../' + file] };
  }
  return undefined;
}

/** Parse both node:test (`# pass 12` / `ℹ pass 12`) and vitest (`Tests  12 passed`) summaries. */
function parseCounts(output) {
  const readNode = label => {
    const match = new RegExp('(?:^|\\n)\\s*(?:#|\u2139)?\\s*' + label + '\\s+(\\d+)').exec(output);
    return match === null ? undefined : Number(match[1]);
  };
  const passed = readNode('pass');
  const failed = readNode('fail');
  const skipped = readNode('skipped');
  if (passed !== undefined && failed !== undefined) return { passed, failed, skipped: skipped ?? 0 };
  // vitest prints `      Tests  21 passed (21)` with separate failed/skipped
  // lines when applicable.
  const vitestPassed = /Tests\s+(\d+)\s+passed/.exec(output);
  if (vitestPassed !== null) {
    const vitestFailed = /Tests\s+.*?(\d+)\s+failed/.exec(output);
    const vitestSkipped = /Tests\s+.*?(\d+)\s+skipped/.exec(output);
    return {
      passed: Number(vitestPassed[1]),
      failed: Number(vitestFailed?.[1] ?? 0),
      skipped: Number(vitestSkipped?.[1] ?? 0),
    };
  }
  return undefined;
}

const batches = new Map();
for (const row of matrix.requirements) {
  if (row.state !== 'RUNTIME-VERIFY') continue;
  if (only !== undefined && !only.includes(row.id)) continue;
  for (const file of (row.tests ?? []).filter(isTestFile)) {
    const batch = batches.get(file) ?? { file, ids: [] };
    batch.ids.push(row.id);
    batches.set(file, batch);
  }
}

const ordered = [...batches.values()].sort((a, b) => a.file.localeCompare(b.file));
if (listOnly) {
  for (const batch of ordered) console.log(batch.file + '  rows=' + batch.ids.length + '  runner=' + (runnerFor(batch.file) === undefined ? 'UNSUPPORTED' : 'ok'));
  console.log('batches=' + ordered.length + ' rows=' + ordered.reduce((n, b) => n + b.ids.length, 0));
  process.exit(0);
}

const results = [];
for (const batch of ordered) {
  const runner = runnerFor(batch.file);
  if (runner === undefined) {
    results.push({ file: batch.file, requirementIds: batch.ids, status: 'unsupported' });
    console.log('UNSUPPORTED  ' + batch.file);
    continue;
  }
  if (!existsSync(join(repoRoot, batch.file))) {
    results.push({ file: batch.file, requirementIds: batch.ids, status: 'missing-file' });
    console.log('MISSING      ' + batch.file);
    continue;
  }
  const startedAt = Date.now();
  const run = spawnSync(runner.cmd[0], runner.cmd.slice(1), {
    cwd: join(repoRoot, runner.cwd),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  const output = (run.stdout ?? '') + '\n' + (run.stderr ?? '');
  const counts = parseCounts(output);
  const durationMs = Date.now() - startedAt;
  const status = counts === undefined
    ? 'unparsed'
    : counts.passed > 0 && counts.failed === 0 && counts.skipped === 0
      ? 'passed'
      : 'not-clean';
  results.push({
    file: batch.file, requirementIds: batch.ids, status, durationMs,
    ...(counts === undefined ? {} : { counts }),
    outputTail: output.trim().split('\n').slice(-12).join('\n'),
  });
  console.log(
    status.padEnd(12) + batch.file + '  rows=' + batch.ids.length + '  '
    + (counts === undefined ? 'unparsed' : counts.passed + ' pass / ' + counts.failed + ' fail / ' + counts.skipped + ' skip')
    + '  ' + durationMs + 'ms',
  );
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  matrixVersion: matrix.matrixVersion,
  summary: {
    batches: results.length,
    passed: results.filter(r => r.status === 'passed').length,
    requirementsProvable: results.filter(r => r.status === 'passed').reduce((n, r) => n + r.requirementIds.length, 0),
    requirementsTotal: results.reduce((n, r) => n + r.requirementIds.length, 0),
  },
  results,
};
writeFileSync(join(repoRoot, outPath), JSON.stringify(report, null, 2) + '\n');
console.log('report=' + outPath);
console.log('batches=' + report.summary.batches + ' passed=' + report.summary.passed
  + ' provableRequirements=' + report.summary.requirementsProvable + '/' + report.summary.requirementsTotal);
