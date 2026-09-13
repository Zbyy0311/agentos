import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateScope } from './verify-lite-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = name => JSON.parse(readFileSync(new URL('../docs/implementation/lite-closeout/' + name, import.meta.url), 'utf8'));
const evidence = json('evidence.json');
const lock = json('scope-lock.json');
const matrix = () => json('matrix.json');

test('S0 maps all acceptance bullets and uses existing evidence paths', () => {
  assert.ok(validateScope(matrix(), evidence, lock, root)['RUNTIME-VERIFY'] > 0);
});

test('S0 rejects deleted or recycled permanent requirement IDs', () => {
  const removed = matrix();
  removed.requirements.shift();
  assert.throws(() => validateScope(removed, evidence, lock, root), /removed permanent id/);
  const rewritten = matrix();
  rewritten.requirements[0].requirement = 'Claim a smaller goal';
  assert.throws(() => validateScope(rewritten, evidence, lock, root), /source quote mismatch|changed requirement identity/);
});

test('S0 rejects PASS without evidence and evidence with a failed test', () => {
  const changed = matrix();
  const row = changed.requirements.find(item => item.state === 'RUNTIME-VERIFY');
  row.state = 'PASS';
  // The case under test is "no evidence at all", so the row's existing pointers are
  // cleared explicitly. Relying on the chosen row happening to carry no evidence only
  // held while the matrix still had many RUNTIME-VERIFY rows; this keeps the case
  // testing the rule rather than the matrix's current composition.
  row.evidence = [];
  assert.throws(() => validateScope(changed, evidence, lock, root), /PASS without evidence/);

  // Now give it one well-formed local-tests proof and make exactly that proof fail, so
  // the assertion isolates the failed-result rule rather than whatever entry happens to
  // come first in evidence.json.
  const proof = evidence.find(item => item.kind === 'local-tests'
    && item.result?.failed === 0 && Number.isSafeInteger(item.result?.passed) && item.result.passed > 0);
  row.evidence = [proof.id];
  row.evidenceBaseline = proof.baseline;
  const failed = structuredClone(evidence);
  failed.find(item => item.id === proof.id).result.failed = 1;
  assert.throws(() => validateScope(changed, failed, lock, root), /failed evidence used for PASS/);
});

test('S0 rejects work outside the locked scope without an authorized amendment', () => {
  const changed = matrix();
  // The synthetic row must be neutral on every earlier rule so this case
  // actually exercises the scope lock. Cloning the first row verbatim only
  // worked while that row was RUNTIME-VERIFY: once it is legitimately PASS, the
  // PASS-evidence mapping check (evidence must be mapped to THIS requirement)
  // fires first and the lock assertion is never reached.
  changed.requirements.push({
    ...changed.requirements[0], id: 'LITE-00-800', line: null, state: 'GAP', evidence: [],
  });
  assert.throws(() => validateScope(changed, evidence, lock, root), /unapproved scope addition|scope lock must cover/);
});

test('S0 detects specification drift before evaluating completion', () => {
  const changed = matrix();
  changed.documents[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateScope(changed, evidence, lock, root), /spec changed without scope amendment/);
});

test('S0 rejects relabeling active acceptance as DEFERRED', () => {
  const changed = matrix();
  const row = changed.requirements.find(item => item.state === 'RUNTIME-VERIFY');
  row.state = 'DEFERRED';
  row.workPackage = null;
  assert.throws(() => validateScope(changed, evidence, lock, root), /new deferral/);
});

test('S0 detects self-rewriting of the frozen identity lock', () => {
  const changedLock = structuredClone(lock);
  changedLock[0].initialState = 'DEFERRED';
  assert.throws(() => validateScope(matrix(), evidence, changedLock, root), /permanent scope lock changed/);
});

test('S0 requires executed evidence mapped to the exact requirement and baseline', () => {
  const source = matrix();
  const row = source.requirements.find(item => item.state === 'PASS');
  for (const [change, error] of [
    [item => { item.baseline = 'f'.repeat(40); }, /wrong evidence baseline/],
    [item => { item.requirementIds = []; }, /not mapped to requirement/],
    [item => { item.result.skipped = 1; }, /skipped evidence/],
    [item => { item.result.passed = 0; }, /no executed passing tests/],
  ]) {
    const invalid = structuredClone(evidence);
    change(invalid.find(item => item.id === row.evidence[0]));
    assert.throws(() => validateScope(source, invalid, lock, root), error);
  }
});
