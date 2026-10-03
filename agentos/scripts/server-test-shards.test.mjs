import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partitionTests, runTestFile, serverTestArguments, validateReceipts } from './server-test-shards.mjs';

const files = [{ path: 'src/a.test.ts', bytes: 100 }, { path: 'src/nested/b.test.ts', bytes: 70 }, { path: 'src/c.test.ts', bytes: 30 }];
const plan = { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), runId: 'run-1', inventoryHash: 'c'.repeat(64),
  files: files.map(file => file.path).sort(), shards: partitionTests(files, 2) };
const testCounts = { passed: 3, failed: 0, skipped: 1, cancelled: 0, todo: 0, tests: 4 };
const receipts = () => plan.shards.map((files, shard) => ({ ...plan, shard, schemaVersion: 2, files,
  rawExitCode: 0, signal: null, spawnError: null, timedOut: false, sourceUnchanged: true,
  budgets: { perTestTimeoutMs: 300_000, perFileTimeoutMs: 20 * 60_000 },
  fileResults: files.map(file => ({ file, rawExitCode: 0, signal: null, spawnError: null, timedOut: false,
    perTestTimeoutMs: 300_000, perFileTimeoutMs: 20 * 60_000, counts: testCounts })),
  counts: Object.fromEntries(Object.keys(testCounts).map(key => [key, testCounts[key] * files.length])) }));

test('every nested test belongs to exactly one stable, balanced shard', () => {
  assert.deepEqual(partitionTests([...files].reverse(), 2), plan.shards);
  assert.deepEqual(plan.shards.flat().sort(), plan.files);
  assert.equal(new Set(plan.shards.flat()).size, files.length);
  assert.deepEqual(validateReceipts(plan, receipts()).counts, { passed: 9, failed: 0, skipped: 3, cancelled: 0, todo: 0, tests: 12 });
});
test('missing, duplicate, stale, failed and unparsed evidence cannot satisfy the full server gate', () => {
  assert.throws(() => validateReceipts(plan, receipts().slice(1)), /Missing/);
  const duplicate = receipts(); duplicate[1] = duplicate[0]; assert.throws(() => validateReceipts(plan, duplicate), /Duplicate/);
  for (const change of [{ commitSha: 'd'.repeat(40) }, { runId: 'other-run' }, { inventoryHash: 'd'.repeat(64) },
    { files: ['src/missing.test.ts'] }, { rawExitCode: 1 }, { signal: 'SIGTERM' }, { sourceUnchanged: false },
    { counts: { passed: null, failed: null, cancelled: 0, skipped: 0, todo: 0, tests: null } }]) {
    const bad = receipts(); Object.assign(bad[0], change); assert.throws(() => validateReceipts(plan, bad));
  }
  const missingFileEvidence = receipts(); missingFileEvidence[0].fileResults.pop();
  assert.throws(() => validateReceipts(plan, missingFileEvidence), /per-file execution evidence/u);
});

test('Node per-test timeouts do not impose an aggregate per-file budget', async () => {
  const temporaryRoot = mkdtempSync(join(realpathSync(tmpdir()), 'agentos-shard-file-budget-'));
  const fixture = join(temporaryRoot, 'several-bounded-tests.test.mjs');
  try {
    writeFileSync(fixture, [
      'import test from "node:test";',
      'for (let index = 0; index < 4; index++) test(`bounded ${index}`, async () => new Promise(resolve => setTimeout(resolve, 200)));',
      '',
    ].join('\n'));
    const result = await runTestFile(fixture, { cwd: join(process.cwd(), 'apps/server'), perTestTimeoutMs: 700, perFileTimeoutMs: 10_000 });
    assert.equal(result.rawExitCode, 0, result.stderr.toString());
    assert.equal(result.timedOut, false);
    assert.ok(result.elapsedMs > 700, `expected aggregate runtime above the per-test budget, got ${result.elapsedMs}ms`);
    const tap = result.stdout.toString();
    assert.match(tap, /^# tests 4$/mu);
    assert.match(tap, /^# pass 4$/mu);
    assert.match(tap, /^# fail 0$/mu);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test('the external per-file watchdog fails a file before its longer per-test timeout', async () => {
  const temporaryRoot = mkdtempSync(join(realpathSync(tmpdir()), 'agentos-shard-file-watchdog-'));
  const fixture = join(temporaryRoot, 'file-watchdog.test.mjs');
  try {
    writeFileSync(fixture, [
      'import test from "node:test";',
      'test("outlives the file budget", async () => new Promise(resolve => setTimeout(resolve, 10_000)));',
      '',
    ].join('\n'));
    const result = await runTestFile(fixture, { cwd: join(process.cwd(), 'apps/server'), perTestTimeoutMs: 15_000, perFileTimeoutMs: 1_000 });
    assert.equal(result.timedOut, true);
    assert.ok(result.rawExitCode !== 0 || result.signal !== null, 'a file watchdog termination must be non-zero');
    assert.ok(result.elapsedMs >= 900 && result.elapsedMs < 8_000, `unexpected watchdog duration ${result.elapsedMs}ms`);
    const failed = receipts();
    failed[0].fileResults[0] = { ...failed[0].fileResults[0], rawExitCode: result.rawExitCode,
      signal: result.signal, timedOut: true };
    failed[0].timedOut = true;
    assert.throws(() => validateReceipts(plan, failed), /per-file execution evidence|did not pass within its budgets/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});

test('a hung server test fails within the bound and cannot satisfy a shard receipt', () => {
  const temporaryRoot = mkdtempSync(join(realpathSync(tmpdir()), 'agentos-shard-timeout-'));
  const fixture = join(temporaryRoot, 'hung.test.mjs');
  try {
    writeFileSync(fixture, 'import test from "node:test"; test("unresolved fixture", async context => { const timer = setInterval(() => {}, 1000); context.signal.addEventListener("abort", () => clearInterval(timer), { once: true }); await new Promise(() => {}); });\n');
    // The standalone fixture needs no TypeScript loader; all test-runner
    // arguments are otherwise identical to the production shard command.
    const argv = serverTestArguments([fixture], 200).slice(2);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, argv, { env, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.error, undefined);
    assert.notEqual(child.status, 0);
    assert.match(child.stdout, /testTimeoutFailure|timed out|timeout/iu);
    const failed = receipts();
    failed[0].rawExitCode = child.status;
    assert.throws(() => validateReceipts(plan, failed), /did not pass/u);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 });
  }
});
