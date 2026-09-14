/**
 * Assemble a strict Vitest evidence receipt from a captured verbose run.
 * The source assertion manifest is explicit and is checked against both the
 * source line and the original passing `✓` output line.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');

function value(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name) {
  const result = value(name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function repoPath(input, label) {
  const path = resolve(repositoryRoot, input);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${input}`);
  return path;
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function filesUnder(directory) {
  const result = [];
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) result.push(...filesUnder(path));
    else result.push(path);
  }
  return result;
}

function relativeRepoPath(path) {
  return relative(repositoryRoot, path).replaceAll('\\', '/');
}

const runDirectory = repoPath(required('--run-dir'), 'run directory');
const sourceFile = required('--source-file');
const baseline = required('--baseline');
const cwdInput = required('--cwd');
const executable = required('--executable');
const args = JSON.parse(required('--args-json'));
const assertionsPath = repoPath(required('--assertions-file'), 'assertions file');
const outputPath = resolve(repositoryRoot, required('--out'));

if (!/^[0-9a-f]{40}$/.test(baseline)) throw new Error('baseline must be a 40-character SHA');
if (!Array.isArray(args) || !args.every(argument => typeof argument === 'string')) {
  throw new Error('--args-json must be an array of strings');
}
if (/<[^>]+>/.test(JSON.stringify({ executable, args }))) {
  throw new Error('literal command cannot contain placeholders');
}
const assertions = JSON.parse(readFileSync(assertionsPath, 'utf8'));
if (!Array.isArray(assertions) || assertions.length === 0) throw new Error('assertions file must be a non-empty array');
const sourcePath = repoPath(sourceFile, 'source assertion file');
const sourceText = readFileSync(sourcePath, 'utf8');

const execution = JSON.parse(readFileSync(resolve(runDirectory, 'execution.json'), 'utf8'));
const stdoutPath = repoPath(relativeRepoPath(resolve(runDirectory, 'stdout.txt')), 'stdout log');
const stderrPath = repoPath(relativeRepoPath(resolve(runDirectory, 'stderr.txt')), 'stderr log');
const output = `${readFileSync(stdoutPath, 'utf8')}\n${readFileSync(stderrPath, 'utf8')}`;
const summaries = [...output.matchAll(/^\s*Tests\s+(.+)$/gm)];
if (summaries.length !== 1) throw new Error('Vitest Tests summary is missing or ambiguous');
const summary = summaries[0][1];
const count = phrase => {
  const match = summary.match(new RegExp(`(\\d+)\\s+${phrase}\\b`));
  return match ? Number(match[1]) : 0;
};
const counts = { passed: count('passed'), failed: count('failed'), skipped: count('skipped') };
if (counts.passed <= 0 || counts.failed !== 0 || counts.skipped !== 0) {
  throw new Error(`run is not clean: ${JSON.stringify(counts)}`);
}

const lines = sourceText.split(/\r?\n/);
const assertionCoverage = assertions.map(assertion => {
  for (const key of ['id', 'requirementId', 'name', 'expression']) {
    if (typeof assertion[key] !== 'string' || assertion[key].trim().length === 0) {
      throw new Error(`assertion ${key} is required: ${assertion.id ?? '<unknown>'}`);
    }
  }
  if (!Number.isSafeInteger(assertion.line) || assertion.line <= 0) throw new Error(`assertion line is required: ${assertion.id}`);
  if (assertion.outcome !== 'passed') throw new Error(`assertion is not passed: ${assertion.id}`);
  if (!lines[assertion.line - 1]?.includes(assertion.expression)) {
    throw new Error(`expression is not at source line: ${assertion.id}`);
  }
  if (!sourceText.includes(assertion.name)) throw new Error(`test name is absent from source: ${assertion.id}`);
  if (!output.split(/\r?\n/).some(line => /^\s*✓\s+/.test(line) && line.includes(assertion.name))) {
    throw new Error(`test name has no executed passing Vitest result: ${assertion.id}`);
  }
  return { ...assertion };
});

const logPaths = filesUnder(runDirectory);
const raw = {
  schemaVersion: 1,
  format: 'vitest',
  baseline,
  command: { executable, args },
  cwd: cwdInput.replaceAll('\\', '/'),
  trackedCheckoutUnchanged: execution.trackedCheckoutUnchanged === true,
  rawExitCode: execution.rawExitCode,
  signal: execution.signal ?? null,
  error: execution.error ?? null,
  logs: logPaths.map(path => ({ path: relativeRepoPath(path), sha256: digest(path) })),
  counts: { ...counts, total: counts.passed + counts.failed + counts.skipped },
  assertionCoverage,
};

writeFileSync(outputPath, `${JSON.stringify(raw, null, 2)}\n`);
console.log(JSON.stringify({ output: relativeRepoPath(outputPath), counts, assertions: assertionCoverage.length }));
