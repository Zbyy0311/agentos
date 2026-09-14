import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(args['repo-root'] ?? '.');
const evidenceRoot = resolve(args['evidence-root'] ?? '');
const setup = JSON.parse(readFileSync(resolve(args['setup-json']), 'utf8'));
const metadata = JSON.parse(readFileSync(resolve(args['metadata-json']), 'utf8'));
const pre = JSON.parse(readFileSync(resolve(args['pre-json']), 'utf8'));
const recovery = JSON.parse(readFileSync(resolve(args['recovery-json']), 'utf8'));
const outputPath = resolve(args.output);

function sha256(path) {
  const bytes = readFileSync(path);
  return {
    path: relative(repoRoot, path).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}

function rawLogs(names) {
  return names.map(name => {
    const path = resolve(evidenceRoot, name);
    if (!existsSync(path)) return { path: relative(repoRoot, path).replaceAll('\\', '/'), missing: true };
    return sha256(path);
  });
}

function counts(assertions) {
  const result = { total: assertions.length, passed: 0, failed: 0, skipped: 0 };
  for (const assertion of assertions) {
    if (assertion.outcome === 'passed') result.passed += 1;
    else if (assertion.outcome === 'failed') result.failed += 1;
    else if (assertion.outcome === 'skipped') result.skipped += 1;
  }
  return result;
}

function verdict(assertions, phaseExitCode, logs) {
  const logMissing = logs.some(log => log.missing === true);
  const actualCounts = counts(assertions);
  if (phaseExitCode !== 0 || actualCounts.failed > 0) return 'failed';
  if (actualCounts.total === 0 || actualCounts.skipped > 0 || logMissing) return 'insufficient-evidence';
  return 'candidate-supported';
}

const spec = {
  'LITE-00-004': {
    text: 'a Run survives browser disconnect;',
    specFile: 'docs/Runtime-Specification lite/00-Vision.md',
    specLine: 406,
    phase: pre,
    phaseExitCode: metadata.preRawExitCode,
    assertions: pre.assertions.filter(item => item.requirementId === 'LITE-00-004'),
    logs: rawLogs(['prepare.stdout.txt', 'prepare.stderr.txt', 'pre.stdout.txt', 'pre.stderr.txt', 'server-pre.stdout.txt', 'server-pre.stderr.txt']),
    why: 'The evidence observes one canonical Run as running, disconnects the canonical browser/Event subscription, observes that same Run still running, then ends it with the ordinary Operation cancellation action.',
    limits: 'It proves survival across this controlled subscription disconnect and explicit later cancellation. It does not prove successful completion, provider quota, or every browser/network failure mode.',
  },
  'LITE-00-007': {
    text: 'recovery classifies uncertainty without guessing completion;',
    specFile: 'docs/Runtime-Specification lite/00-Vision.md',
    specLine: 409,
    phase: recovery,
    phaseExitCode: metadata.recoveryRawExitCode,
    assertions: [...pre.assertions, ...recovery.assertions].filter(item => item.requirementId === 'LITE-00-007'),
    logs: rawLogs(['pre.stdout.txt', 'pre.stderr.txt', 'server-pre.stdout.txt', 'server-pre.stderr.txt', 'recovery.stdout.txt', 'recovery.stderr.txt', 'server-recovery.stdout.txt', 'server-recovery.stderr.txt']),
    why: 'The evidence records queued/running/waiting_user before stopping the server, records a new server process, and observes queued/running become failed while waiting_user remains waiting_user, with zero completed rows.',
    limits: 'It proves the three recorded legacy fixture states and their restart classification. It does not prove recovery of a live native Process identity or later resume behavior.',
  },
  'LITE-02-009': {
    text: 'browser disconnect leaves Run and Process active;',
    specFile: 'docs/Runtime-Specification lite/02-Runtime-Lifecycle.md',
    specLine: 530,
    phase: pre,
    phaseExitCode: metadata.preRawExitCode,
    assertions: pre.assertions.filter(item => item.requirementId === 'LITE-02-009'),
    logs: rawLogs(['prepare.stdout.txt', 'prepare.stderr.txt', 'pre.stdout.txt', 'pre.stderr.txt', 'server-pre.stdout.txt', 'server-pre.stderr.txt']),
    why: 'The evidence links a Process id to the Run in Runtime Inspector before disconnect and checks the same Process id and Run id remain active after the canonical subscription abort.',
    limits: 'It proves the observed active Process during this run. It does not claim that explicit cancellation leaves the Process active.',
  },
  'LITE-03-010': {
    text: 'browser disconnect without Run cancellation;',
    specFile: 'docs/Runtime-Specification lite/03-Event-Model.md',
    specLine: 550,
    phase: pre,
    phaseExitCode: metadata.preRawExitCode,
    assertions: pre.assertions.filter(item => item.requirementId === 'LITE-03-010'),
    logs: rawLogs(['prepare.stdout.txt', 'prepare.stderr.txt', 'pre.stdout.txt', 'pre.stderr.txt', 'server-pre.stdout.txt', 'server-pre.stderr.txt']),
    why: 'The evidence names the canonical stream route, records a received Event frame, records the client abort, and separately checks post-abort Run status and persisted cancellation event types.',
    limits: 'It proves the causal boundary for this canonical SSE subscription action and observed interval. It does not prove all transport failures are equivalent or prohibit a later explicit cancel.',
  },
};

const requirements = Object.entries(spec).map(([id, item]) => {
  const itemCounts = counts(item.assertions);
  const logs = item.logs;
  return {
    id,
    specification: {
      text: item.text,
      sourceFile: item.specFile,
      sourceLine: item.specLine,
    },
    baselineSha: setup.baselineSha,
    command: metadata.command,
    rawExitCode: item.phaseExitCode,
    phaseRawExitCodes: {
      pre: metadata.preRawExitCode,
      recovery: metadata.recoveryRawExitCode,
      prepare: metadata.prepareRawExitCode,
    },
    counts: itemCounts,
    observedCounts: itemCounts,
    rawLogs: logs,
    assertionCoverage: item.assertions,
    whyAssertionsSuffice: item.why,
    adjacentBehaviorNotProven: item.limits,
    verdict: verdict(item.assertions, item.phaseExitCode, logs),
  };
});

const allLogs = rawLogs([
  'prepare.stdout.txt', 'prepare.stderr.txt', 'pre.stdout.txt', 'pre.stderr.txt',
  'server-pre.stdout.txt', 'server-pre.stderr.txt', 'recovery.stdout.txt', 'recovery.stderr.txt',
  'server-recovery.stdout.txt', 'server-recovery.stderr.txt',
]);
const output = {
  schemaVersion: 1,
  evidencePackage: 'S8-four-row-candidate-evidence',
  generatedAt: new Date().toISOString(),
  baselineSha: setup.baselineSha,
  testCodeSha: setup.baselineSha,
  exactParent: 'f9cfbd00c807d91bd80eadcfa6f74b014df07eb5',
  finalRun: {
    command: metadata.command,
    rawExitCodes: {
      prepare: metadata.prepareRawExitCode,
      pre: metadata.preRawExitCode,
      recovery: metadata.recoveryRawExitCode,
    },
    allRawLogs: allLogs,
    serverLifecycle: metadata.serverLifecycle,
  },
  routeModels: setup.routeModels,
  modelScopeStatement: setup.modelScopeStatement,
  requirements,
  matrixProtection: {
    passFreezeEdited: false,
    passPromotionExecuted: false,
    requireClosedExecuted: false,
    verdictVocabulary: ['candidate-supported', 'insufficient-evidence', 'failed'],
  },
};

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
const bad = requirements.some(item => item.verdict !== 'candidate-supported');
process.stdout.write(`${JSON.stringify({ outputPath, verdicts: Object.fromEntries(requirements.map(item => [item.id, item.verdict])) })}\n`);
process.exitCode = bad ? 1 : 0;
