import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyRun,
  createRunResult,
  parseCounts,
  summarizeResults,
} from './run-lite-verification-batches.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const closeoutDir = resolve(repoRoot, 'docs/implementation/lite-closeout');
const applyScripts = [
  'apply-s8-acceptance.mjs',
  'apply-s8-matrix.mjs',
  'apply-s8-repoint.mjs',
  'apply-s8-rv.mjs',
];

test('missing summary counts remain null and cannot produce a clean batch', () => {
  const counts = parseCounts('# pass 2\n# fail 0\n');
  assert.deepEqual(counts, { passed: 2, failed: 0, skipped: null });
  assert.equal(classifyRun({ rawStatus: 0, error: null, signal: null, counts }), 'unparsed');
});

test('raw nonzero exit defeats a clean-looking parsed summary', () => {
  const counts = { passed: 2, failed: 0, skipped: 0 };
  assert.equal(classifyRun({ rawStatus: 17, error: null, signal: null, counts }), 'not-clean');
});

test('timeout and spawn error stay non-passing even with output counts', () => {
  const counts = { passed: 2, failed: 0, skipped: 0 };
  assert.equal(classifyRun({ rawStatus: null, error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM', counts }), 'timeout');
  assert.equal(classifyRun({ rawStatus: null, error: { code: 'ENOENT' }, signal: null, counts }), 'spawn-error');
});

test('process receipt retains source SHA, full log SHA, raw fields, and counts', () => {
  const output = '# pass 2\n# fail 0\n# skipped 0\n';
  const result = createRunResult(
    { file: 'scripts/run-lite-verification-batches.test.mjs', ids: ['LITE-TEST-001'] },
    { status: 7, signal: null, error: { code: 'E_TEST', message: 'synthetic failure' } },
    output,
    12,
  );
  assert.equal(result.status, 'spawn-error');
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(result.rawLogSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.rawOutput, output);
  assert.equal(result.rawStatus, 7);
  assert.deepEqual(result.error, { name: null, message: 'synthetic failure', code: 'E_TEST' });
  assert.equal(result.signal, null);
  assert.deepEqual(result.counts, { passed: 2, failed: 0, skipped: 0 });
  assert.deepEqual(result.raw, {
    status: 7,
    error: { name: null, message: 'synthetic failure', code: 'E_TEST' },
    signal: null,
    counts: { passed: 2, failed: 0, skipped: 0 },
  });
});

test('a passing source file does not become assertion coverage', () => {
  const summary = summarizeResults([{
    file: 'example.test.mjs',
    requirementIds: ['LITE-TEST-001'],
    status: 'passed',
    assertionCoverage: [],
  }]);
  assert.equal(summary.passed, 1);
  assert.equal(summary.requirementsTotal, 1);
  assert.equal(summary.requirementsProvable, 0);
});

test('missing and unsupported batches make the runner return failure', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'agentos-lite-runner-'));
  const fileList = join(temporary, 'files.json');
  const reportPath = join(temporary, 'report.json');
  writeFileSync(fileList, JSON.stringify([
    'apps/server/does-not-exist.test.mjs',
    'scripts/unsupported-does-not-exist.test.mjs',
  ]));
  try {
    const run = spawnSync(process.execPath, [
      resolve(repoRoot, 'scripts/run-lite-verification-batches.mjs'),
      '--files', fileList,
      '--json', reportPath,
    ], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(run.status, 1);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.deepEqual(report.results.map(result => result.status), ['missing-file', 'unsupported']);
    assert.equal(report.summary.failed, 2);
    assert.equal(report.summary.requirementsProvable, 0);
    for (const result of report.results) {
      assert.equal(result.rawStatus, null);
      assert.equal(result.error, null);
      assert.equal(result.signal, null);
      assert.equal(result.counts, null);
      assert.equal(result.rawLogSha256, null);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('freeze guards reject all historical S8 writers before any write', () => {
  const matrixPath = join(closeoutDir, 'matrix.json');
  const evidencePath = join(closeoutDir, 'evidence.json');
  const matrixBefore = readFileSync(matrixPath);
  const evidenceBefore = readFileSync(evidencePath);
  for (const script of applyScripts) {
    const result = spawnSync(process.execPath, [join(closeoutDir, script), 'baseline', '99'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, script);
    assert.match((result.stdout ?? '') + (result.stderr ?? ''), /pass-freeze\.json/);
  }
  assert.deepEqual(readFileSync(matrixPath), matrixBefore);
  assert.deepEqual(readFileSync(evidencePath), evidenceBefore);
});
