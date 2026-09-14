/**
 * S8 / Lite runtime verification batches.
 *
 * The S0 matrix records, for each RUNTIME-VERIFY requirement, the test file that
 * is expected to carry its clause-level evidence. This runner turns that into
 * executed evidence: it groups those requirements by their test file, runs each
 * file in the package that owns it, and records a process receipt for the batch.
 *
 * A file-level pass is deliberately not an assertion-level proof. This runner
 * does not inspect source text or invent a requirement-to-assertion mapping, so
 * requirementsProvable remains zero unless a future runner records verified,
 * per-assertion coverage explicitly.
 *
 * Usage:
 *   node scripts/run-lite-verification-batches.mjs [--only <id,id>] [--json <out>]
 *     [--timeoutMs <n>] [--files <json>] [--list]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest('hex');

function readArg(argv, name, fallback) {
  const index = argv.indexOf('--' + name);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

function countFromSingleLine(lines, label) {
  const expression = new RegExp('^\\s*(?:#|\\u2139)?\\s*' + label + '\\s+(\\d+)\\s*$', 'i');
  const values = [];
  for (const line of lines) {
    const match = expression.exec(line);
    if (match !== null) values.push(Number(match[1]));
  }
  return values.length === 1 ? values[0] : null;
}

/**
 * One vitest category. Vitest omits a category whose count is zero, so an absent token is a
 * zero - but only the parenthesized total can confirm that reading, which the caller checks.
 * Two matches for the same label are ambiguous and stay null (never guessed).
 */
function vitestCategory(line, label) {
  const matches = [...line.matchAll(new RegExp('(\\d+)\\s+' + label + '\\b', 'gi'))];
  if (matches.length === 0) return 0;
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

/**
 * Parse counts only when the output contains an unambiguous summary.
 * Missing fields stay null; they are never treated as zero.
 */
export function parseCounts(output) {
  const lines = String(output).split(/\r?\n/);
  const nodeCounts = {
    passed: countFromSingleLine(lines, 'pass'),
    failed: countFromSingleLine(lines, 'fail'),
    skipped: countFromSingleLine(lines, 'skipped'),
  };
  if (Object.values(nodeCounts).some(value => value !== null)) return nodeCounts;

  const vitestLines = lines.filter(line => /^\s*Tests\b/i.test(line));
  if (vitestLines.length !== 1) return undefined;
  const vitestLine = vitestLines[0];
  const total = /\((\d+)\)\s*$/u.exec(vitestLine.trim());
  if (total === null) return undefined;
  const passed = vitestCategory(vitestLine, 'passed');
  const failed = vitestCategory(vitestLine, 'failed');
  const skipped = vitestCategory(vitestLine, 'skipped');
  const todo = vitestCategory(vitestLine, 'todo');
  if ([passed, failed, skipped, todo].some(value => value === null)) return undefined;
  // A derived zero is only accepted when the categories add up to the reported total; anything
  // else stays unparsed instead of becoming a confident-looking number.
  if (passed + failed + skipped + todo !== Number(total[1])) return undefined;
  return { passed, failed, skipped };
}

export function serializeSpawnError(error) {
  if (error === undefined || error === null) return null;
  const serialized = {
    name: error.name ?? null,
    message: error.message ?? String(error),
  };
  for (const key of Object.keys(error)) serialized[key] = error[key];
  return serialized;
}

function hasCompleteCounts(counts) {
  return counts !== undefined
    && counts !== null
    && ['passed', 'failed', 'skipped'].every(key => Number.isSafeInteger(counts[key]));
}

function isCleanCounts(counts) {
  return hasCompleteCounts(counts)
    && counts.passed > 0
    && counts.failed === 0
    && counts.skipped === 0;
}

/** Classify a spawned batch only after considering the raw process receipt. */
export function classifyRun({ rawStatus, error, signal, counts }) {
  if (error?.code === 'ETIMEDOUT') return 'timeout';
  if (error !== undefined && error !== null) return 'spawn-error';
  if (signal !== undefined && signal !== null) return 'signaled';
  if (rawStatus !== 0) return 'not-clean';
  if (!hasCompleteCounts(counts)) return 'unparsed';
  return isCleanCounts(counts) ? 'passed' : 'not-clean';
}

/**
 * A batch result cannot promote a requirement merely because its source file
 * passed. Only a separately verified assertion receipt could change this in a
 * future schema; this runner emits no such receipt.
 */
export function summarizeResults(results) {
  return {
    batches: results.length,
    passed: results.filter(result => result.status === 'passed').length,
    failed: results.filter(result => result.status !== 'passed').length,
    requirementsProvable: 0,
    requirementsTotal: results.reduce((total, result) => total + result.requirementIds.length, 0),
  };
}

export function runnerFor(file) {
  if (file.startsWith('apps/server/')) {
    return {
      cwd: 'apps/server',
      cmd: ['node', '--import', 'tsx', '--test', '--test-concurrency=1', file.slice('apps/server/'.length)],
    };
  }
  if (file.startsWith('apps/web/')) {
    return { cwd: 'apps/web', cmd: ['node', '--import', 'tsx', '--test', file.slice('apps/web/'.length)] };
  }
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

function sourceSha256(file) {
  const absolute = resolve(repoRoot, file);
  return existsSync(absolute) ? digest(readFileSync(absolute)) : null;
}

function emptyReceipt() {
  return { rawStatus: null, error: null, signal: null, counts: null };
}

function resultWithNoProcess(batch, status) {
  const raw = emptyReceipt();
  return {
    file: batch.file,
    requirementIds: batch.ids,
    status,
    sourceSha256: sourceSha256(batch.file),
    rawLogSha256: null,
    ...raw,
    raw,
    assertionCoverage: [],
  };
}

function outputTail(output) {
  return output.trimEnd().split(/\r?\n/).slice(-12).join('\n');
}

export function createRunResult(batch, run, output, durationMs = 0) {
  const counts = parseCounts(output);
  const rawStatus = run.status ?? null;
  const error = serializeSpawnError(run.error);
  const signal = run.signal ?? null;
  const raw = { status: rawStatus, error, signal, counts: counts ?? null };
  return {
    file: batch.file,
    requirementIds: batch.ids,
    status: classifyRun({ rawStatus, error: run.error, signal, counts }),
    durationMs,
    sourceSha256: sourceSha256(batch.file),
    rawLogSha256: digest(output),
    rawOutput: output,
    rawStatus,
    error,
    signal,
    counts: counts ?? null,
    raw,
    assertionCoverage: [],
    outputTail: outputTail(output),
  };
}

export function main(argv = process.argv.slice(2)) {
  const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const trackedStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const onlyValue = readArg(argv, 'only', undefined);
  const only = typeof onlyValue === 'string' ? onlyValue.split(',').map(value => value.trim()) : undefined;
  const filesValue = readArg(argv, 'files', undefined);
  const filesArg = typeof filesValue === 'string' ? filesValue : undefined;
  const listOnly = readArg(argv, 'list', false) === true;
  const timeoutValue = Number(readArg(argv, 'timeoutMs', 900_000));
  if (!Number.isFinite(timeoutValue) || timeoutValue <= 0) throw new Error('--timeoutMs must be a positive number');
  const outValue = readArg(argv, 'json', undefined);
  const outPath = typeof outValue === 'string'
    ? outValue
    : 'docs/implementation/lite-closeout/verification-batches.json';

  const matrix = JSON.parse(readFileSync(join(repoRoot, 'docs/implementation/lite-closeout/matrix.json'), 'utf8'));
  const isTestFile = value => /\.test\.(ts|tsx|ps1|mjs)$/.test(value) && !value.includes('progress');
  const batches = new Map();
  if (filesArg !== undefined) {
    const requested = JSON.parse(readFileSync(resolve(repoRoot, filesArg), 'utf8'));
    if (!Array.isArray(requested) || requested.length === 0 || requested.some(file => typeof file !== 'string')) {
      throw new Error('file list must be a non-empty array of paths');
    }
    for (const file of requested) batches.set(file, { file, ids: [] });
  }
  for (const row of filesArg === undefined ? matrix.requirements : []) {
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
    for (const batch of ordered) {
      console.log(batch.file + '  rows=' + batch.ids.length + '  runner='
        + (runnerFor(batch.file) === undefined ? 'UNSUPPORTED' : 'ok'));
    }
    console.log('batches=' + ordered.length + ' rows=' + ordered.reduce((total, batch) => total + batch.ids.length, 0));
    return 0;
  }

  const results = [];
  for (const batch of ordered) {
    const runner = runnerFor(batch.file);
    if (runner === undefined) {
      const result = resultWithNoProcess(batch, 'unsupported');
      results.push(result);
      console.log('UNSUPPORTED  ' + batch.file);
      continue;
    }
    if (!existsSync(resolve(repoRoot, batch.file))) {
      const result = resultWithNoProcess(batch, 'missing-file');
      results.push(result);
      console.log('MISSING      ' + batch.file);
      continue;
    }

    const startedAt = Date.now();
    const run = spawnSync(runner.cmd[0], runner.cmd.slice(1), {
      cwd: join(repoRoot, runner.cwd),
      encoding: 'utf8',
      timeout: timeoutValue,
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    const stdout = run.stdout ?? '';
    const stderr = run.stderr ?? '';
    const output = stdout + '\n' + stderr;
    const durationMs = Date.now() - startedAt;
    const result = createRunResult(batch, run, output, durationMs);
    result.baseline = baseline;
    result.command = { executable: runner.cmd[0], args: runner.cmd.slice(1), shell: process.platform === 'win32' };
    result.cwd = runner.cwd;
    result.stdout = stdout;
    result.stderr = stderr;
    results.push(result);
    console.log(
      result.status.padEnd(12) + batch.file + '  rows=' + batch.ids.length + '  '
      + (result.counts === null
        ? 'unparsed'
        : result.counts.passed + ' pass / ' + result.counts.failed + ' fail / ' + result.counts.skipped + ' skip')
      + '  exit=' + String(result.rawStatus)
      + (result.signal === null ? '' : ' signal=' + result.signal)
      + '  ' + durationMs + 'ms',
    );
  }

  const report = {
    schemaVersion: 1,
    baseline,
    trackedStatus,
    generatedAt: new Date().toISOString(),
    matrixVersion: matrix.matrixVersion,
    summary: summarizeResults(results),
    results,
  };
  writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2) + '\n');
  console.log('report=' + outPath);
  console.log('batches=' + report.summary.batches + ' passed=' + report.summary.passed
    + ' failed=' + report.summary.failed
    + ' provableRequirements=' + report.summary.requirementsProvable + '/' + report.summary.requirementsTotal);
  return report.summary.failed === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
