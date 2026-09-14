/**
 * Assemble a controlled-harness receipt from a candidate harness run.
 *
 * The candidate harness owns the assertions and writes receipts.json with
 * actual/expected values. This utility only preserves that output together
 * with its literal invocation, checksums every original log, and maps each
 * receipt to the source expect/assert call that produced it. It refuses to
 * manufacture a mapping when the source call cannot be found.
 *
 * Usage:
 *   node scripts/build-lite-controlled-harness.mjs \
 *     --run-dir docs/.../captured-run \
 *     --source-receipt docs/.../receipts.json \
 *     --source-file scripts/verify-lite-s6-candidate-evidence.mjs \
 *     --baseline <40-char-sha> \
 *     --cwd apps/server \
 *     --executable node \
 *     --args-json '["--import","tsx","../../scripts/verify-lite-s6-candidate-evidence.mjs"]' \
 *     --out docs/.../raw.json
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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

function sourceAssertion(sourceText, receipt) {
  const lines = sourceText.split(/\r?\n/);
  const quotedId = new RegExp(`['"]${receipt.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
  const quotedRequirement = new RegExp(`['"]${receipt.requirementId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
  const candidates = lines
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(item => /\b(?:expect|assert)\b/.test(item.line))
    .filter(item => quotedId.test(item.line) && quotedRequirement.test(item.line));
  if (candidates.length !== 1) {
    throw new Error(`expected exactly one source assertion for ${receipt.id}, found ${candidates.length}`);
  }
  const candidate = candidates[0];
  return {
    id: receipt.id,
    requirementId: receipt.requirementId,
    actual: receipt.actual,
    expected: receipt.expected,
    file: relativeRepoPath(sourceFilePath),
    name: receipt.step,
    expression: candidate.line,
    line: candidate.lineNumber,
    outcome: receipt.outcome,
  };
}

const runDirectoryInput = required('--run-dir');
const runDirectory = repoPath(runDirectoryInput, 'run directory');
const sourceReceiptInput = required('--source-receipt');
const sourceReceiptPath = repoPath(sourceReceiptInput, 'source receipt');
const sourceFileInput = required('--source-file');
const sourceFilePath = repoPath(sourceFileInput, 'source file');
const baseline = required('--baseline');
const cwdInput = required('--cwd');
const cwdPath = repoPath(cwdInput, 'cwd');
const executable = required('--executable');
const argsJson = required('--args-json');
const outputPath = resolve(repositoryRoot, required('--out'));

const sourceRelativeToRun = relative(runDirectory, sourceReceiptPath);
if (sourceRelativeToRun === '..' || sourceRelativeToRun.startsWith(`..${sep}`) || isAbsolute(sourceRelativeToRun)) {
  throw new Error('source receipt must be inside the run directory');
}

if (!/^[0-9a-f]{40}$/.test(baseline)) throw new Error('baseline must be a 40-character SHA');
const args = JSON.parse(argsJson);
if (!Array.isArray(args) || !args.every(argument => typeof argument === 'string')) {
  throw new Error('--args-json must be an array of strings');
}
if (/<[^>]+>/.test(JSON.stringify({ executable, args }))) {
  throw new Error('literal command cannot contain placeholders');
}

const source = JSON.parse(readFileSync(sourceReceiptPath, 'utf8'));
if (source.schemaVersion !== 1 || !Array.isArray(source.receipts)) {
  throw new Error('source receipt must have schemaVersion 1 and receipts');
}
if (!source.counts || source.counts.total !== source.receipts.length) {
  throw new Error('source receipt counts do not cover every receipt');
}
for (const receipt of source.receipts) {
  if (receipt.outcome !== 'passed') throw new Error(`source receipt is not passed: ${receipt.id}`);
  if (JSON.stringify(receipt.actual) !== JSON.stringify(receipt.expected)) {
    throw new Error(`source receipt actual/expected mismatch: ${receipt.id}`);
  }
}

// The source receipt is only a structured assertion payload. The invocation
// facts must come from the capture utility's execution record in the same log
// directory, not from the arguments passed to this assembler.
const executionPath = repoPath(resolve(runDirectory, 'execution.json'), 'execution record');
const execution = JSON.parse(readFileSync(executionPath, 'utf8'));
if (execution.schemaVersion !== 1) throw new Error('execution record schemaVersion must be 1');
if (JSON.stringify(execution.command) !== JSON.stringify({ executable, args })) {
  throw new Error('execution command does not match the literal command');
}
if (execution.cwd !== relativeRepoPath(cwdPath)) throw new Error('execution cwd does not match the literal cwd');
if (execution.rawExitCode !== 0) throw new Error(`execution raw exit code is not zero: ${execution.rawExitCode}`);
if (execution.signal !== null) throw new Error('execution ended by signal');
if (execution.error !== null) throw new Error('execution reported a spawn error');
if (execution.trackedCheckoutUnchanged !== true) throw new Error('execution changed the checkout');

const sourceText = readFileSync(sourceFilePath, 'utf8');
const assertionCoverage = source.receipts.map(receipt => sourceAssertion(sourceText, receipt));
const logPaths = filesUnder(runDirectory);
if (!logPaths.includes(sourceReceiptPath)) throw new Error('source receipt is not in its log directory');

const raw = {
  schemaVersion: 1,
  format: 'controlled-harness',
  baseline,
  command: { executable, args },
  cwd: relativeRepoPath(cwdPath),
  trackedCheckoutUnchanged: execution.trackedCheckoutUnchanged,
  rawExitCode: execution.rawExitCode,
  signal: execution.signal,
  error: execution.error,
  logs: logPaths.map(path => ({ path: relativeRepoPath(path), sha256: digest(path) })),
  sourceReceipt: relativeRepoPath(sourceReceiptPath),
  counts: source.counts,
  assertionCoverage,
};

writeFileSync(outputPath, `${JSON.stringify(raw, null, 2)}\n`);
console.log(JSON.stringify({ output: relativeRepoPath(outputPath), sourceReceipt: raw.sourceReceipt, counts: raw.counts }));
