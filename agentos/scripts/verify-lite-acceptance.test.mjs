import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const acceptanceScript = join(repoRoot, 'scripts', 'verify-lite-acceptance.mjs');
const captureScript = join(repoRoot, 'scripts', 'capture-lite-verification.mjs');
const gatesScript = join(repoRoot, 'scripts', 'verify-lite-s8-gates.ps1');
const requiredGates = [
  'REAL_DIRECT_CODEX',
  'REAL_DIRECT_KIMI',
  'REAL_DIRECT_OPENCODE',
  'REAL_GROUP',
  'REAL_EXTERNAL_AGENT',
  'REAL_MEMORY_INJECTION',
  'REAL_MEMORY_CANDIDATE',
  'REAL_CLI_FAILURE',
  'REAL_CLI_CANCEL',
  'REAL_WAITING_USER',
  'DETERMINISTIC_LIFECYCLE',
  'RECOVERY',
];

function initFixture() {
  const root = mkdtempSync(join(tmpdir(), 'lite-acceptance-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(acceptanceScript, join(root, 'scripts', 'verify-lite-acceptance.mjs'));
  copyFileSync(captureScript, join(root, 'scripts', 'capture-lite-verification.mjs'));
  writeFileSync(join(root, '.gitignore'), 'logs/\n');
  const git = (...args) => execFileSync('git', ['-c', 'core.symlinks=false', ...args], { cwd: root, stdio: 'pipe' });
  git('init', '--quiet');
  git('add', '.');
  execFileSync('git', [
    '-c', 'core.symlinks=false',
    '-c', 'user.name=Lite Acceptance Test',
    '-c', 'user.email=lite-acceptance@example.invalid',
    'commit', '-qm', 'fixture',
  ], { cwd: root, stdio: 'pipe' });
  return root;
}

function runAcceptance(root, scenarios) {
  const specPath = join(root, 'spec.json');
  const resultsPath = join(root, 'results.json');
  writeFileSync(specPath, JSON.stringify({ specVersion: 1, scenarios }, null, 2) + '\n');
  const result = spawnSync(process.execPath, [
    'scripts/verify-lite-acceptance.mjs',
    '--spec', 'spec.json',
    '--results', 'results.json',
    '--timeoutMs', '15000',
  ], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.error, undefined);
  assert.equal(existsSync(resultsPath), true);
  return { result, report: JSON.parse(readFileSync(resultsPath, 'utf8')) };
}

function gateLog(overrides = {}, rawExit = 0) {
  const lines = ['S8_RAW_EXIT_CODE: ' + rawExit];
  for (const gate of requiredGates) lines.push(gate + ': ' + (overrides[gate] ?? 'passed'));
  return lines.join('\n') + '\n';
}

function runGateLog(content, rawExitArgument) {
  const root = mkdtempSync(join(tmpdir(), 'lite-s8-gates-'));
  try {
    const logPath = join(root, 'harness.log');
    writeFileSync(logPath, content);
    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', gatesScript,
      '-LogPath', logPath,
    ];
    if (rawExitArgument !== undefined) args.push('-RawExitCode', String(rawExitArgument));
    const result = spawnSync('pwsh', args, { cwd: repoRoot, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.error, undefined);
    const output = (result.stdout ?? '') + '\n' + (result.stderr ?? '');
    return { result, output, logPath, logSha256: createHash('sha256').update(readFileSync(logPath)).digest('hex') };
  } finally {
    // The child has exited before cleanup, so Windows has no live log handle.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

test('acceptance preserves raw nonzero exit, receipt logs, and SHA instead of normalizing to pass', () => {
  const root = initFixture();
  try {
    const { result, report } = runAcceptance(root, [{
      id: 'raw-failure',
      title: 'raw failure',
      kind: 'command',
      requirementIds: ['LITE-TEST-RAW'],
      verifyCommand: 'node -e "console.log(\'raw-stdout\'); console.error(\'raw-stderr\'); process.exit(7)"',
    }]);
    assert.equal(result.status, 1);
    assert.equal(report.verdict, 'not-passed');
    assert.equal(report.summary.passed, 0);
    assert.equal(report.summary.failed, 1);
    const observation = report.results[0];
    assert.equal(observation.status, 'failed');
    assert.equal(observation.exitCode, 7);
    assert.equal(observation.rawExitCode, 7);
    assert.equal(observation.captureReceipt.rawExitCode, 7);
    assert.equal(observation.rawLogsComplete, true);
    assert.match(observation.outputTail, /raw-stdout/);
    assert.match(observation.outputTail, /raw-stderr/);
    assert.equal(observation.rawLogs.length, 2);
    for (const log of observation.rawLogs) {
      const absolute = join(root, log.path);
      assert.equal(createHash('sha256').update(readFileSync(absolute)).digest('hex'), log.sha256);
    }
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('manual and skipped scenarios cannot produce a passing acceptance verdict', () => {
  const root = initFixture();
  try {
    const { result, report } = runAcceptance(root, [
      { id: 'manual', title: 'manual', kind: 'manual', requirementIds: ['LITE-TEST-MANUAL'] },
      { id: 'skip', title: 'skip', kind: 'skip', requirementIds: ['LITE-TEST-SKIP'] },
    ]);
    assert.equal(result.status, 1);
    assert.equal(report.verdict, 'not-passed');
    assert.equal(report.summary.passed, 0);
    assert.equal(report.summary.manualRequired, 1);
    assert.equal(report.summary.skipped, 1);
    assert.deepEqual(report.results.map(item => item.status), ['manual-required', 'skipped']);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a clean raw zero execution is the only acceptance control that passes', () => {
  const root = initFixture();
  try {
    const { result, report } = runAcceptance(root, [{
      id: 'raw-pass',
      title: 'raw pass',
      kind: 'command',
      requirementIds: ['LITE-TEST-PASS'],
      verifyCommand: 'node -e "console.log(\'# pass 1\\n# fail 0\\n# skipped 0\\n# cancelled 0\\n# todo 0\')"',
    }]);
    assert.equal(result.status, 0);
    assert.equal(report.verdict, 'passed');
    assert.equal(report.summary.passed, 1);
    assert.equal(report.results[0].rawExitCode, 0);
    assert.equal(report.results[0].rawLogsComplete, true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('strict S8 wrapper rejects external failure and reports raw log SHA', () => {
  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
  assert.equal(pwsh.error, undefined);
  assert.equal(pwsh.status, 0, 'PowerShell is required for this gate test');
  const content = gateLog({ REAL_DIRECT_KIMI: 'failed' }, 1);
  const { result, output, logPath } = runGateLog(content);
  assert.equal(result.status, 1);
  assert.match(output, /S8_GATES: failed/);
  assert.match(output, /raw_harness_exit_code: 1/);
  assert.match(output, /raw gate failure observed: REAL_DIRECT_KIMI = failed/);
  const sha = createHash('sha256').update(content).digest('hex');
  assert.match(output, new RegExp('log_sha256: ' + sha));
  assert.doesNotMatch(output, /S8_GATES: passed/);
});

test('strict S8 wrapper preserves an earlier failure and never uses a later pass to normalize it', () => {
  const content = 'S8_RAW_EXIT_CODE: 0\n'
    + 'REAL_DIRECT_KIMI: failed - quota\n'
    + gateLog({}, 0).split('\n').slice(1).join('\n');
  const { result, output } = runGateLog(content);
  assert.equal(result.status, 1);
  assert.match(output, /raw gate failure observed: REAL_DIRECT_KIMI = failed/);
  assert.doesNotMatch(output, /S8_GATES: passed/);
});

test('strict S8 wrapper rejects a green-looking log when raw exit is missing or nonzero', () => {
  const missing = runGateLog(gateLog({}, 0).replace('S8_RAW_EXIT_CODE: 0\n', ''));
  assert.equal(missing.result.status, 1);
  assert.match(missing.output, /raw harness exit code is missing/);
  const nonzero = runGateLog(gateLog({}, 7));
  assert.equal(nonzero.result.status, 1);
  assert.match(nonzero.output, /raw_harness_exit_code: 7/);
  assert.doesNotMatch(nonzero.output, /S8_GATES: passed/);
});

test('strict S8 wrapper accepts only a complete raw zero gate log', () => {
  const { result, output } = runGateLog(gateLog({}, 0));
  assert.equal(result.status, 0);
  assert.match(output, /S8_GATES: passed/);
  assert.match(output, /raw_harness_exit_code: 0/);
});

test('zero exit with skipped or unparsed tests never proves acceptance', () => {
  for (const summary of ['no test output', '# pass 1\\n# fail 0\\n# skipped 2\\n# cancelled 0\\n# todo 0']) {
    const root = initFixture();
    try {
      const { result, report } = runAcceptance(root, [{ id: 'UPPER.case_with_underscores', kind: 'command', requirementIds: ['LITE-TEST'], verifyCommand: `node -e "console.log('${summary}')"` }]);
      assert.equal(result.status, 1);
      assert.equal(report.results[0].rawExitCode, 0);
      assert.equal(report.summary.passed, 0);
      assert.equal(report.summary.requirementsCovered, 0);
    } finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
});
