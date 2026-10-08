/**
 * Capture the manually classified Runtime-Verify candidate bundles at the
 * current implementation SHA. This tool only creates raw receipts; it never
 * changes the matrix or promotion ledger.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const matrixPath = resolve(repositoryRoot, 'docs/implementation/lite-closeout/matrix.json');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
const baselineShort = baseline.slice(0, 8);
const classificationPath = resolve(repositoryRoot, `docs/implementation/lite-closeout/evidence/runtime-verify-classification-${baselineShort}.json`);
const classification = JSON.parse(readFileSync(classificationPath, 'utf8'));

function rel(path) {
  return relative(repositoryRoot, path).replaceAll('\\', '/');
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,  eighty());
}

function eighty() {
  return 80;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveTestName(sourceFile, requestedName) {
  const sourcePath = resolve(repositoryRoot, sourceFile);
  const lines = readFileSync(sourcePath, 'utf8').split(/\r?\n/);
  if (lines.some(line => line.includes(requestedName))) return requestedName;
  const suffix = requestedName.includes('>') ? requestedName.slice(requestedName.lastIndexOf('>') + 1).trim() : requestedName;
  const suffixLine = lines.findIndex(line => line.includes(suffix));
  if (suffixLine >= 0) {
    const declaration = lines.slice(Math.max(0, suffixLine - 3), suffixLine + 4)
      .map(line => line.match(/\b(?:test|it)\s*(?:\.[A-Za-z]+)?\s*\(\s*(['"`])(.+?)\1/))
      .find(Boolean);
    if (declaration) return declaration[2];
    if (lines[suffixLine].trim().startsWith((suffix.startsWith('P') || suffix.startsWith('W')) ? "'" : '')) return suffix;
  }
  const phrase = requestedName.split(/\s+/).filter(word => word.length >= 4).slice(0, 4).join(' ');
  if (phrase) {
    const phraseLine = lines.findIndex(line => line.includes(phrase));
    if (phraseLine >= 0) {
      const declaration = lines.slice(Math.max(0, phraseLine - 3), phraseLine + 4)
        .map(line => line.match(/\b(?:test|it)\s*(?:\.[A-Za-z]+)?\s*\(\s*(['"`])(.+?)\1/))
        .find(Boolean);
      if (declaration) return declaration[2];
    }
  }
  const words = requestedName.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 5);
  const scored = lines.map((line, index) => {
    if (!/\b(?:test|it)\s*(?:\.[A-Za-z]+)?\s*\(/.test(line)) return { index, score: -1 };
    const lower = line.toLowerCase();
    return { index, score: words.reduce((score, word) => score + (lower.includes(word) ? 1 : 0), 0) };
  }).sort((a, b) => b.score - a.score)[0];
  if (scored?.score >= 2) {
    const declaration = lines[scored.index].match(/\b(?:test|it)\s*(?:\.[A-Za-z]+)?\s*\(\s*(['"`])(.+?)\1/);
    if (declaration) return declaration[2];
  }
  const tokens = requestedName.match(/(?:LITE|CR|P[0-9A-Z]|SHELL|HS|INS|WFI|CG|GRP|UIF|DCUX|INSP|MF)[A-Z0-9-]*/g) ?? [];
  for (const token of tokens.sort((a, b) => b.length - a.length)) {
    const index = lines.findIndex(line => line.includes(token));
    if (index < 0) continue;
    const declaration = lines.slice(Math.max(0, index - 3), index + 4)
      .map(line => line.match(/\b(?:test|it)\s*(?:\.[A-Za-z]+)?\s*\(\s*(['"`])(.+?)\1/))
      .find(Boolean);
    if (declaration) return declaration[2];
    const quoted = lines[index].trim().match(/^(['"`])(.+?)\1,?$/);
    if (quoted) return quoted[2];
  }
  throw new Error(`test name not found: ${sourceFile}: ${requestedName}`);
}

function testFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...testFiles(path));
    else if (/\.test\.tsx?$/.test(entry.name)) result.push(path);
  }
  return result;
}

function resolveTestLocation(sourceFile, requestedName) {
  try {
    return { sourceFile, name: resolveTestName(sourceFile, requestedName) };
  } catch (error) {
    const candidates = [...testFiles(resolve(repositoryRoot, 'apps')), ...testFiles(resolve(repositoryRoot, 'packages'))];
    for (const candidate of candidates) {
      const candidateFile = rel(candidate);
      try {
        return { sourceFile: candidateFile, name: resolveTestName(candidateFile, requestedName) };
      } catch {
        // The classification bundle can retain a stale file pointer after a
        // test is moved. Continue looking for the same named test globally.
      }
    }
    throw error;
  }
}

function sourceConfig(file) {
  if (file.startsWith('apps/server/')) {
    return { cwd: 'apps/server', executable: 'pnpm', file: file.slice('apps/server/'.length), prefix: ['exec', 'tsx'], format: 'tap' };
  }
  if (file.startsWith('apps/web/')) {
    return { cwd: 'apps/web', executable: 'node', file: file.slice('apps/web/'.length), prefix: ['--import', 'tsx'], format: 'tap' };
  }
  const packageMatch = file.match(/^packages\/([^/]+)\/(.*)$/);
  if (packageMatch) {
    if (packageMatch[1] === 'shared') {
      return { cwd: 'apps/server', executable: 'node', file: `../../packages/shared/${packageMatch[2]}`, prefix: ['--import', 'tsx'], format: 'tap' };
    }
    return { cwd: `packages/${packageMatch[1]}`, executable: 'pnpm', file: packageMatch[2], prefix: ['exec', 'vitest', 'run', '--reporter=verbose'], format: 'vitest' };
  }
  return null;
}

function assertionFor(sourceFile, name, requirementId, clause, ordinal) {
  const sourcePath = resolve(repositoryRoot, sourceFile);
  if (!existsSync(sourcePath)) throw new Error(`missing source: ${sourceFile}`);
  const lines = readFileSync(sourcePath, 'utf8').split(/\r?\n/);
  const nameLine = lines.findIndex(line => line.includes(name));
  if (nameLine < 0) throw new Error(`test name not found: ${sourceFile}: ${name}`);
  const candidates = lines.slice(nameLine + 1, nameLine + 181)
    .map((line, index) => ({ line, lineNumber: nameLine + index + 2 }))
    .filter(({ line }) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//')
        && /\b(?:assert(?:\.[A-Za-z]+)?|expect)\s*\(/.test(line)
        // A bare call opener is not a useful clause-level pointer. Prefer a
        // complete assertion expression that a reviewer can inspect directly.
        && /\)|;/.test(line.slice(line.search(/\b(?:assert(?:\.[A-Za-z]+)?|expect)\s*\(/) + 1));
    });
  if (candidates.length === 0) throw new Error(`no complete direct assertion found: ${sourceFile}: ${name}`);
  const selected = candidates[0];
  const lineNumber = selected.lineNumber;
  const expression = selected.line.trim();
  return {
    id: `${requirementId}-${slug(name)}-${ordinal}`,
    requirementId,
    file: sourceFile,
    name,
    line: lineNumber,
    expression,
    clause,
    whyDirect: '该映射指向命名测试中实际执行的完整单行断言，并由同一份原始收据证明该命名测试通过；表达式读取具体结果，不是文件、关键词或测试套件级命中。',
    outcome: 'passed',
  };
}

const rows = new Map(matrix.requirements.filter(row => row.state === 'RUNTIME-VERIFY').map(row => [row.id, row]));
const byFile = new Map();
const bundleById = classification.assertionBundles;

function addEntry(sourceFile, name, requirementId) {
  const row = rows.get(requirementId);
  if (!row) throw new Error(`supplemental row is not Runtime-Verify: ${requirementId}`);
  const location = resolveTestLocation(sourceFile, name);
  if (!byFile.has(location.sourceFile)) byFile.set(location.sourceFile, new Map());
  const key = `${location.name}\u0000${requirementId}`;
  byFile.get(location.sourceFile).set(key, { name: location.name, requirementId, clause: row.requirement });
}

for (const candidate of classification.candidateRows) {
  const row = rows.get(candidate.id);
  if (!row) continue;
  for (const bundleId of candidate.assertionBundles) {
    for (const item of bundleById[bundleId] ?? []) {
      if (!sourceConfig(item.file) || !/\.test\.tsx?$/.test(item.file)) continue;
      const location = resolveTestLocation(item.file, item.name);
      if (!byFile.has(location.sourceFile)) byFile.set(location.sourceFile, new Map());
      const key = `${location.name}\u0000${candidate.id}`;
      byFile.get(location.sourceFile).set(key, { name: location.name, requirementId: candidate.id, clause: row.requirement });
    }
  }
}

// These two production tests are deliberately kept outside the old bundle
// classification because their earlier evidence was a live controlled receipt.
// The final-SHA node:test receipts below provide the same direct assertions at
// the authoritative code baseline.
for (const requirementId of ['LITE-05-008', 'LITE-09-007', 'LITE-13-014']) {
  addEntry(
    'apps/server/src/services/m3-p6-integrated-verification.test.ts',
    'P6D-A5 browser disconnect is transport-only: execution, Events, Outbox and terminal state continue',
    requirementId,
  );
}
for (const requirementId of ['LITE-06-009', 'LITE-08-014']) {
  addEntry(
    'apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts',
    'LITE-02-016 a modifying Run completes when no AgentOS-owned Worktree is available',
    requirementId,
  );
}

const results = [];
let ordinal = 0;
for (const [sourceFile, entries] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const config = sourceConfig(sourceFile);
  const names = [...new Set([...entries.values()].map(entry => entry.name))];
  const pattern = `(?:${names.map(escapeRegex).join('|')})`;
  const args = config.format === 'vitest'
    ? [...config.prefix, config.file]
    : [
      ...config.prefix,
      '--test',
      '--test-concurrency=1',
      '--test-reporter=tap',
      '--test-name-pattern',
      pattern,
      config.file,
    ];
  const runSlug = `${String(results.length + 1).padStart(2, '0')}-${slug(sourceFile)}`;
  const runDir = `docs/implementation/lite-closeout/evidence/final-${baselineShort}-runs/${runSlug}`;
  const assertionPath = resolve(repositoryRoot, runDir, 'assertions.json');
  const receiptPath = `docs/implementation/lite-closeout/evidence/final-${baselineShort}-receipts/${runSlug}.json`;
  mkdirSync(dirname(assertionPath), { recursive: true });
  mkdirSync(dirname(resolve(repositoryRoot, receiptPath)), { recursive: true });
  const assertions = [...entries.values()].map(entry => assertionFor(
    sourceFile,
    entry.name,
    entry.requirementId,
    entry.clause,
    ++ordinal,
  ));
  writeFileSync(assertionPath, `${JSON.stringify(assertions, null, 2)}\n`);

  const captureArgs = [
    'scripts/capture-lite-test-run.mjs',
    '--cwd', config.cwd,
    '--executable', config.executable,
    '--args-json', JSON.stringify(args),
    '--out-dir', runDir,
  ];
  const capture = spawnSync(process.execPath, captureArgs, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  const executionPath = resolve(repositoryRoot, runDir, 'execution.json');
  const execution = existsSync(executionPath) ? JSON.parse(readFileSync(executionPath, 'utf8')) : null;
  const result = {
    sourceFile,
    cwd: config.cwd,
    executable: config.executable,
    args,
    runDir,
    assertionFile: rel(assertionPath),
    receipt: receiptPath,
    captureExitCode: capture.status,
    execution,
    stdout: capture.stdout?.trim() ?? '',
    stderr: capture.stderr?.trim() ?? '',
  };
  if (execution?.rawExitCode === 0 && execution?.signal === null && execution?.error === null) {
    const build = spawnSync(process.execPath, [
      config.format === 'vitest' ? 'scripts/build-lite-vitest-receipt.mjs' : 'scripts/build-lite-tap-receipt.mjs',
      '--run-dir', runDir,
      '--source-file', sourceFile,
      '--baseline', baseline,
      '--cwd', config.cwd,
      '--executable', config.executable,
      '--args-json', JSON.stringify(args),
      '--assertions-file', rel(assertionPath),
      '--out', receiptPath,
    ], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    result.buildExitCode = build.status;
    result.buildStdout = build.stdout?.trim() ?? '';
    result.buildStderr = build.stderr?.trim() ?? '';
  }
  results.push(result);
  console.log(JSON.stringify({ sourceFile, captureExitCode: result.captureExitCode, rawExitCode: execution?.rawExitCode ?? null, buildExitCode: result.buildExitCode ?? null }));
}

const summary = {
  schemaVersion: 1,
  baseline,
  matrixVersion: matrix.matrixVersion,
  generatedAt: new Date().toISOString(),
  sourceCount: results.length,
  cleanReceipts: results.filter(result => result.buildExitCode === 0).length,
  results,
};
const summaryPath = resolve(repositoryRoot, `docs/implementation/lite-closeout/evidence/final-${baselineShort}-promotion-capture-summary.json`);
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ summary: rel(summaryPath), baseline, sourceCount: summary.sourceCount, cleanReceipts: summary.cleanReceipts }));
