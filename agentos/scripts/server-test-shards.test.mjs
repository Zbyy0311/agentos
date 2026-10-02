import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionTests, validateReceipts } from './server-test-shards.mjs';

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
