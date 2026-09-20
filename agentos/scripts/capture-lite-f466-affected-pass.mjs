/**
 * Re-capture the existing PASS rows whose recorded production paths changed
 * after their historical receipt. This is an evidence-only tool: it never
 * edits matrix.json, evidence.json, or pass-promotions.json.
 *
 * Every job is an explicit, isolated invocation. TAP jobs reuse the previous
 * assertion descriptions only after resolving the exact assertion line in the
 * current source. Controlled-harness jobs assemble a new receipt from the
 * source harness output and the captured process invocation.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const auditRoot = resolve(repositoryRoot, 'docs/implementation/lite-closeout');
const evidencePath = resolve(auditRoot, 'evidence.json');
const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const evidenceById = new Map(evidence.map(item => [item.id, item]));
const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
const outputRoot = 'docs/implementation/lite-closeout/evidence/final-f466-affected-pass';
const labelArgument = process.argv.find(argument => argument.startsWith('--labels='));

const jobs = [
  {
    label: 'memory-retrieval',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-MEMORY-CONTRACTS',
    sourceFile: 'apps/server/src/services/MemoryRetrievalService.test.ts',
    cwd: 'apps/server',
    executable: 'node',
    args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'src/services/MemoryRetrievalService.test.ts'],
    requirementIds: ['LITE-07-001'],
  },
  {
    label: 'memory-candidate',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-MEMORY-CONTRACTS',
    sourceFile: 'apps/server/src/store/MemoryCandidateRepository.test.ts',
    cwd: 'apps/server',
    executable: 'node',
    args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'src/store/MemoryCandidateRepository.test.ts'],
    requirementIds: ['LITE-07-002', 'LITE-07-004', 'LITE-07-011'],
  },
  {
    label: 'memory-context',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-MEMORY-CONTRACTS',
    sourceFile: 'apps/server/src/services/MemoryContextResolver.test.ts',
    cwd: 'apps/server',
    executable: 'node',
    args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'src/services/MemoryContextResolver.test.ts'],
    requirementIds: ['LITE-07-008'],
  },
  {
    label: 'memory-runtime',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-MEMORY-CONTRACTS',
    sourceFile: 'apps/server/src/routes/memoryRuntime.test.ts',
    cwd: 'apps/server',
    executable: 'node',
    args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'src/routes/memoryRuntime.test.ts'],
    requirementIds: ['LITE-07-001', 'LITE-07-009', 'LITE-07-101'],
  },
  {
    label: 'controlled-07003',
    kind: 'controlled-harness',
    oldEvidenceId: 'S9-FINAL-C517-07003',
    sourceFile: 'scripts/verify-lite-07-003-candidate-evidence.mjs',
    cwd: 'apps/server',
    executable: 'node',
    requirementIds: ['LITE-07-003'],
  },
  {
    label: 'controlled-s1-budget',
    kind: 'controlled-harness',
    oldEvidenceId: 'S9-FINAL-C517-S1-BUDGET',
    sourceFile: 'scripts/verify-lite-s1-budget-candidate-evidence.mjs',
    cwd: 'apps/server',
    executable: 'node',
    requirementIds: ['LITE-07-007', 'LITE-07-109'],
  },
  {
    label: 'controlled-07013',
    kind: 'controlled-harness',
    oldEvidenceId: 'S9-FINAL-C517-0713',
    sourceFile: 'scripts/verify-lite-07-013-candidate-evidence.mjs',
    cwd: 'apps/server',
    executable: 'node',
    requirementIds: ['LITE-07-013'],
  },
  {
    label: 'controlled-s7',
    kind: 'controlled-harness',
    oldEvidenceId: 'S9-FINAL-C517-S7',
    sourceFile: 'scripts/verify-lite-s7-candidate-evidence.mjs',
    cwd: 'apps/server',
    executable: 'node',
    requirementIds: ['LITE-07-107', 'LITE-07-108'],
  },
  {
    label: 'artifact',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-ARTIFACT',
    sourceFile: 'apps/server/src/services/ArtifactCompletionService.test.ts',
    cwd: 'apps/server',
    executable: 'node',
    args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'src/services/ArtifactCompletionService.test.ts'],
    requirementIds: ['LITE-07-104'],
  },
  {
    label: 'runtime-inspector',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-RUNTIME-INSPECTOR',
    sourceFile: 'apps/server/src/services/RuntimeInspector.test.ts',
    cwd: 'apps/server',
    executable: 'node',
    args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'src/services/RuntimeInspector.test.ts'],
    requirementIds: ['LITE-13-002', 'LITE-13-003', 'LITE-13-015'],
  },
  {
    label: 'recovery',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-RECOVERY',
    sourceFile: 'apps/server/src/services/TaskRunRecoveryService.test.ts',
    cwd: 'apps/server',
    executable: 'node',
    args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'src/services/TaskRunRecoveryService.test.ts'],
    requirementIds: ['LITE-13-008'],
  },
  {
    label: 'browser-13-101',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-13-101-BROWSER',
    sourceFile: 'scripts/verify-lite-13-101-browser.test.mjs',
    cwd: '.',
    executable: 'node',
    args: ['--test', '--test-concurrency=1', '--test-reporter=tap', 'scripts/verify-lite-13-101-browser.test.mjs'],
    requirementIds: ['LITE-13-101'],
  },
  {
    label: 'compaction-service',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-COMPACTION-SERVICE',
    sourceFile: 'apps/server/src/services/ConversationCompactionService.test.ts',
    cwd: 'apps/server',
    executable: 'node',
    args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'src/services/ConversationCompactionService.test.ts'],
    requirementIds: ['LITE-09-107'],
  },
  {
    label: 'compaction-trigger',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-COMPACTION-TRIGGER',
    sourceFile: 'apps/server/src/services/ConversationCompactionTrigger.test.ts',
    cwd: 'apps/server',
    executable: 'node',
    args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'src/services/ConversationCompactionTrigger.test.ts'],
    requirementIds: ['LITE-09-107'],
  },
  {
    label: 'compaction-repository',
    kind: 'tap',
    oldEvidenceId: 'S9-FINAL-C517-COMPACTION-REPOSITORY',
    sourceFile: 'apps/server/src/store/CompactionRepository.test.ts',
    cwd: 'apps/server',
    executable: 'node',
    args: ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-reporter=tap', 'src/store/CompactionRepository.test.ts'],
    requirementIds: ['LITE-09-107'],
  },
];
const selectedLabels = labelArgument === undefined
  ? null
  : new Set(labelArgument.slice('--labels='.length).split(',').map(value => value.trim()).filter(Boolean));
const selectedJobs = selectedLabels === null ? jobs : jobs.filter(job => selectedLabels.has(job.label));
if (selectedJobs.length === 0) throw new Error('no jobs selected');

function relativeRepoPath(path) {
  return relative(repositoryRoot, path).replaceAll('\\', '/');
}

function readOldAssertions(job) {
  const proof = evidenceById.get(job.oldEvidenceId);
  if (!proof?.rawReceipt) throw new Error(`missing old raw receipt: ${job.oldEvidenceId}`);
  const raw = JSON.parse(readFileSync(resolve(repositoryRoot, proof.rawReceipt), 'utf8'));
  const assertions = raw.assertions ?? raw.assertionCoverage;
  if (!Array.isArray(assertions)) throw new Error(`old receipt has no assertions: ${job.oldEvidenceId}`);
  const selected = assertions.filter(assertion => (
    job.requirementIds.includes(assertion.requirementId)
      && assertion.file.replaceAll('\\', '/') === job.sourceFile
  ));
  if (selected.length === 0) throw new Error(`no old assertions selected for ${job.label}`);
  return selected;
}

function resolveCurrentAssertions(job) {
  const sourcePath = resolve(repositoryRoot, job.sourceFile);
  if (!existsSync(sourcePath)) throw new Error(`missing source: ${job.sourceFile}`);
  const sourceLines = readFileSync(sourcePath, 'utf8').split(/\r?\n/);
  return readOldAssertions(job).map(assertion => {
    const expression = String(assertion.expression).trim();
    let line = sourceLines.findIndex(candidate => candidate.includes(expression));
    if (line < 0 && Number.isSafeInteger(assertion.line)) {
      const candidate = sourceLines[assertion.line - 1];
      if (candidate?.includes(expression)) line = assertion.line - 1;
    }
    if (line < 0) throw new Error(`current assertion expression moved or changed: ${job.sourceFile}:${assertion.line}:${expression}`);
    return {
      ...assertion,
      file: job.sourceFile,
      line: line + 1,
      expression: sourceLines[line].trim(),
      outcome: 'passed',
    };
  });
}

function runCapture(job, runDir, args) {
  mkdirSync(resolve(repositoryRoot, runDir), { recursive: true });
  return spawnSync(process.execPath, [
    'scripts/capture-lite-test-run.mjs',
    '--cwd', job.cwd,
    '--executable', job.executable,
    '--args-json', JSON.stringify(args),
    '--out-dir', runDir,
  ], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

const results = [];
for (const job of selectedJobs) {
  const runDir = `${outputRoot}/${job.label}`;
  const runPath = resolve(repositoryRoot, runDir);
  const sourceDir = resolve(runPath, 'source');
  // The capture helper compares the complete untracked checkout state. Create
  // the controlled harness output directory before capture so the harness
  // only overwrites pre-existing evidence files instead of changing the
  // checkout state during the invocation.
  if (job.kind === 'controlled-harness') mkdirSync(sourceDir, { recursive: true });
  const args = job.kind === 'controlled-harness'
    ? ['--import', 'tsx', `../../${job.sourceFile}`, '--out', sourceDir]
    : job.args;
  const capture = runCapture(job, runDir, args);
  const executionPath = resolve(runPath, 'execution.json');
  const execution = existsSync(executionPath) ? JSON.parse(readFileSync(executionPath, 'utf8')) : null;
  const result = {
    label: job.label,
    kind: job.kind,
    requirementIds: job.requirementIds,
    sourceFile: job.sourceFile,
    cwd: job.cwd,
    executable: job.executable,
    args,
    runDir,
    captureExitCode: capture.status,
    execution,
  };
  if (!execution || execution.rawExitCode !== 0 || execution.signal !== null || execution.error !== null) {
    results.push(result);
    console.log(JSON.stringify({ label: job.label, captureExitCode: capture.status, rawExitCode: execution?.rawExitCode ?? null, buildExitCode: null }));
    continue;
  }

  let build;
  let receipt;
  if (job.kind === 'controlled-harness') {
    receipt = `${outputRoot}/${job.label}.json`;
    build = spawnSync(process.execPath, [
      'scripts/build-lite-controlled-harness.mjs',
      '--run-dir', runDir,
      '--source-receipt', relativeRepoPath(resolve(sourceDir, 'receipts.json')),
      '--source-file', job.sourceFile,
      '--baseline', baseline,
      '--cwd', job.cwd,
      '--executable', job.executable,
      '--args-json', JSON.stringify(args),
      '--out', receipt,
    ], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } else {
    const assertionsPath = resolve(runPath, 'assertions.json');
    writeFileSync(assertionsPath, `${JSON.stringify(resolveCurrentAssertions(job), null, 2)}\n`);
    receipt = `${outputRoot}/${job.label}.json`;
    build = spawnSync(process.execPath, [
      'scripts/build-lite-tap-receipt.mjs',
      '--run-dir', runDir,
      '--source-file', job.sourceFile,
      '--baseline', baseline,
      '--cwd', job.cwd,
      '--executable', job.executable,
      '--args-json', JSON.stringify(args),
      '--assertions-file', relativeRepoPath(assertionsPath),
      '--out', receipt,
    ], { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  }
  result.buildExitCode = build.status;
  result.receipt = receipt;
  result.buildStdout = build.stdout?.trim() ?? '';
  result.buildStderr = build.stderr?.trim() ?? '';
  results.push(result);
  console.log(JSON.stringify({ label: job.label, captureExitCode: capture.status, rawExitCode: execution.rawExitCode, buildExitCode: build.status }));
}

const summary = {
  schemaVersion: 1,
  baseline,
  generatedAt: new Date().toISOString(),
  jobCount: selectedJobs.length,
  cleanReceipts: results.filter(result => result.buildExitCode === 0).length,
  results,
};
const summaryPath = resolve(repositoryRoot, `${outputRoot}-capture-summary.json`);
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ summary: relativeRepoPath(summaryPath), baseline, jobCount: selectedJobs.length, cleanReceipts: summary.cleanReceipts }));
