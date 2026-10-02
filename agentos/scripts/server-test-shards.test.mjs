import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partitionTests, serverTestArguments, validateReceipts } from './server-test-shards.mjs';

const files = [{ path: 'src/a.test.ts', bytes: 100 }, { path: 'src/nested/b.test.ts', bytes: 70 }, { path: 'src/c.test.ts', bytes: 30 }];
const plan = { commitSha: 'a'.repeat(40), treeSha: 'b'.repeat(40), runId: 'run-1', inventoryHash: 'c'.repeat(64),
  files: files.map(file => file.path).sort(), shards: partitionTests(files, 2) };
const receipts = () => plan.shards.map((files, shard) => ({ ...plan, shard, files, rawExitCode: 0, signal: null, spawnError: null, sourceUnchanged: true,
  counts: { passed: 3, failed: 0, skipped: 1, cancelled: 0, todo: 0, tests: 4 } }));

test('every nested test belongs to exactly one stable, balanced shard', () => {
  assert.deepEqual(partitionTests([...files].reverse(), 2), plan.shards);
  assert.deepEqual(plan.shards.flat().sort(), plan.files);
  assert.equal(new Set(plan.shards.flat()).size, files.length);
  assert.deepEqual(validateReceipts(plan, receipts()).counts, { passed: 6, failed: 0, skipped: 2, cancelled: 0, todo: 0, tests: 8 });
});
test('missing, duplicate, stale, failed and unparsed evidence cannot satisfy the full server gate', () => {
  assert.throws(() => validateReceipts(plan, receipts().slice(1)), /Missing/);
  const duplicate = receipts(); duplicate[1] = duplicate[0]; assert.throws(() => validateReceipts(plan, duplicate), /Duplicate/);
  for (const change of [{ commitSha: 'd'.repeat(40) }, { runId: 'other-run' }, { inventoryHash: 'd'.repeat(64) },
    { files: ['src/missing.test.ts'] }, { rawExitCode: 1 }, { signal: 'SIGTERM' }, { sourceUnchanged: false },
    { counts: { passed: null, failed: null, cancelled: 0, skipped: 0, todo: 0, tests: null } }]) {
    const bad = receipts(); Object.assign(bad[0], change); assert.throws(() => validateReceipts(plan, bad));
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
