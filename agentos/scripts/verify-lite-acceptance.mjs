/**
 * S8 / Lite acceptance runner.
 *
 * Executes a reviewed scenario spec against the real repository and records
 * one result per scenario, together with the requirement ids it covers. The
 * runner never decides PASS on its own: it only produces reproducible
 * observations (command, exit code, duration, output tail). The main agent
 * turns those observations into matrix evidence.
 *
 * Usage:
 *   node scripts/verify-lite-acceptance.mjs --spec <spec.json> [--only id,id]
 *     [--results <out.json>] [--timeoutMs <n>] [--dry-run]
 *
 * A scenario is executed only when it names a reviewer-controlled command:
 *   - `existingVerifier`: a path under scripts/ ending in .ps1/.mjs
 *   - `verifyCommand`:    a command starting with an allowlisted prefix
 * Scenarios whose kind is `ui` or `manual` are recorded as manual-required.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = [
  /\brm\s+-rf\b/i,
  /Remove-Item[^\n]*-Recurse/i,
  /git\s+reset\s+--hard/i,
  /git\s+push/i,
  /gh\s+pr\s+(merge|close)/i,
  /git\s+checkout\s+--\s/i,
];
const ALLOWED_PREFIXES = ['node ', 'pnpm ', 'pwsh ', 'gh run view ', 'gh pr view '];

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

const specPath = arg('spec');
if (typeof specPath !== 'string') {
  console.error('usage: node scripts/verify-lite-acceptance.mjs --spec <spec.json> [--only id,id] [--dry-run]');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(resolve(repoRoot, specPath), 'utf8'));
const only = typeof arg('only', undefined) === 'string' ? String(arg('only')).split(',').map(s => s.trim()) : undefined;
const dryRun = arg('dry-run', false) === true;
const timeoutMs = Number(arg('timeoutMs', 1_800_000));
const resultsPath = typeof arg('results', undefined) === 'string'
  ? String(arg('results'))
  : 'docs/implementation/lite-closeout/acceptance-results.json';

function assertSafe(command) {
  for (const pattern of FORBIDDEN) {
    if (pattern.test(command)) throw new Error('refusing destructive command: ' + command);
  }
  if (!ALLOWED_PREFIXES.some(prefix => command.startsWith(prefix))) {
    throw new Error('refusing command outside the allowlist: ' + command);
  }
}

function runCommand(command) {
  assertSafe(command);
  const startedAt = Date.now();
  const result = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    exitCode: result.status,
    timedOut: result.error?.code === 'ETIMEDOUT' || (result.signal === 'SIGTERM' && result.status === null),
    durationMs: Date.now() - startedAt,
    outputTail: (stdout + '\n' + stderr).trim().split('\n').slice(-40).join('\n'),
  };
}

function commandFor(scenario) {
  if (typeof scenario.existingVerifier === 'string') {
    const relative = scenario.existingVerifier.replace(/\\/g, '/');
    if (!relative.startsWith('scripts/') || !/\.(ps1|mjs)$/.test(relative)) {
      throw new Error('existingVerifier must be a script under scripts/: ' + relative);
    }
    if (!existsSync(join(repoRoot, relative))) {
      throw new Error('existingVerifier does not exist: ' + relative);
    }
    return relative.endsWith('.mjs') ? 'node ' + relative : 'pwsh -NoProfile -ExecutionPolicy Bypass -File ' + relative;
  }
  if (typeof scenario.verifyCommand === 'string' && scenario.verifyCommand.trim().length > 0) {
    return scenario.verifyCommand.trim();
  }
  return undefined;
}

const results = [];
let executed = 0;
let passed = 0;
let failed = 0;
let manual = 0;
const covered = new Set();
for (const scenario of spec.scenarios ?? []) {
  if (only !== undefined && !only.includes(scenario.id)) continue;
  const requirementIds = Array.isArray(scenario.requirementIds) ? scenario.requirementIds : [];
  for (const id of requirementIds) covered.add(id);
  const base = { id: scenario.id, title: scenario.title, kind: scenario.kind, requirementIds };
  if (scenario.kind === 'ui' || scenario.kind === 'manual') {
    results.push({ ...base, status: 'manual-required', reason: scenario.preconditions ?? 'needs an interactive or browser run' });
    manual += 1;
    continue;
  }
  let command;
  try {
    command = commandFor(scenario);
  } catch (error) {
    results.push({ ...base, status: 'invalid', reason: error instanceof Error ? error.message : String(error) });
    failed += 1;
    continue;
  }
  if (command === undefined) {
    results.push({ ...base, status: 'manual-required', reason: 'no reviewer-controlled command was attached' });
    manual += 1;
    continue;
  }
  if (dryRun) {
    results.push({ ...base, status: 'planned', command });
    continue;
  }
  const outcome = runCommand(command);
  const status = outcome.timedOut ? 'timed-out' : outcome.exitCode === 0 ? 'passed' : 'failed';
  if (status === 'passed') passed += 1; else failed += 1;
  executed += 1;
  results.push({ ...base, status, command, exitCode: outcome.exitCode, timedOut: outcome.timedOut, durationMs: outcome.durationMs, outputTail: outcome.outputTail });
  console.log(status.padEnd(12) + scenario.id + '  ' + String(outcome.durationMs) + 'ms  ' + requirementIds.length + ' requirement(s)');
}

const report = {
  schemaVersion: 1,
  spec: specPath,
  specVersion: spec.specVersion ?? null,
  generatedAt: new Date().toISOString(),
  dryRun,
  summary: { scenarios: results.length, executed, passed, failed, manualRequired: manual, requirementsCovered: covered.size },
  results,
};
const resultsFile = isAbsolute(resultsPath) ? resultsPath : join(repoRoot, resultsPath);
writeFileSync(resultsFile, JSON.stringify(report, null, 2) + '\n');
console.log('spec=' + specPath + ' results=' + resultsFile);
console.log('executed=' + executed + ' passed=' + passed + ' failed=' + failed + ' manual=' + manual + ' requirements=' + covered.size);
process.exit(failed === 0 ? 0 : 1);
