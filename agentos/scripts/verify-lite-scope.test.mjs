import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateFinalClosure,
  validateDeferralAmendments,
  hashDeferralAmendments,
  validatePassPromotionAuthority,
  validatePassPromotions,
  validatePassEvidence,
  validatePassFreeze,
  validateFrozenScopeStates,
  validateScope,
} from './verify-lite-scope.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = name => JSON.parse(readFileSync(new URL('../docs/implementation/lite-closeout/' + name, import.meta.url), 'utf8'));
const evidence = json('evidence.json');
const lock = json('scope-lock.json');
const freeze = () => json('pass-freeze.json');
const deferralAmendments = () => json('deferral-amendments.json');
const matrix = () => json('matrix.json');

/**
 * The deferral amendment is the only way a row may move away from the state the
 * freeze recorded, and it may only ever move a row into DEFERRED. These cases pin
 * that narrowness: an amendment cannot promote, cannot move a row out of DEFERRED,
 * must carry its authority, and stays hash-anchored outside itself.
 */
test('the recorded deferral amendment authorizes exactly the LITE-04-101 change', () => {
  const amendments = deferralAmendments();
  const byId = validateDeferralAmendments(amendments);
  const amendment = byId.get('LITE-04-101');
  assert.ok(amendment, 'the LITE-04-101 amendment is recorded');
  assert.equal(amendment.from, 'RUNTIME-VERIFY');
  assert.equal(amendment.to, 'DEFERRED');
  assert.ok(amendment.authority.includes('2026-09-14'));
  // The amendment must quote the row exit condition verbatim, because a requirement
  // derived from a user clarification has no literal document line to point at.
  const row = matrix().requirements.find(item => item.id === 'LITE-04-101');
  assert.equal(amendment.exitCondition, row.exit, 'the amendment quotes the exit condition verbatim');
  assert.equal(row.state, 'DEFERRED');
  assert.equal(row.workPackage, null);
  assert.ok(row.evidence.includes('S4-04-101-DEFERRAL'));
});

test('an amendment may never promote a row or leave DEFERRED', () => {
  const promoted = deferralAmendments();
  promoted.amendments[0].to = 'PASS';
  assert.throws(() => validateDeferralAmendments(promoted), /may only defer/);
  const fromDeferred = deferralAmendments();
  fromDeferred.amendments[0].from = 'DEFERRED';
  assert.throws(() => validateDeferralAmendments(fromDeferred), /must move into DEFERRED/);
});

test('an amendment requires its authority, a reopen condition and a boundary', () => {
  for (const field of ['authority', 'reopenCondition', 'boundary', 'exitCondition']) {
    const changed = deferralAmendments();
    changed.amendments[0][field] = '   ';
    assert.throws(() => validateDeferralAmendments(changed), /requires/);
  }
});

test('an amendment cannot be added or edited without moving the outside anchor', () => {
  const added = deferralAmendments();
  added.amendments.push({
    requirementId: 'LITE-07-101', from: 'RUNTIME-VERIFY', to: 'DEFERRED',
    authority: 'synthetic', exitCondition: 'synthetic', exitConditionSource: 'synthetic',
    reason: ['synthetic'], receipts: [], receiptBaseline: '0'.repeat(40),
    chainVerification: { method: 'synthetic', result: 'synthetic', boundary: 'synthetic' },
    reopenCondition: 'synthetic', boundary: 'synthetic',
  });
  assert.throws(() => validateDeferralAmendments(added), /deferral amendment identity changed/);
  const edited = deferralAmendments();
  edited.amendments[0].reason = ['rewritten reason'];
  assert.throws(() => validateDeferralAmendments(edited), /deferral amendment identity changed/);
  const rehashed = deferralAmendments();
  rehashed.amendments[0].reason = ['rewritten reason'];
  rehashed.hashAnchor = hashDeferralAmendments(rehashed);
  assert.throws(() => validateDeferralAmendments(rehashed), /deferral amendment identity changed/);
});

test('a line-less requirement cannot be deferred without its own amendment', () => {
  // LITE-07-101 is also derived from a user clarification and therefore line-less, but
  // no amendment names it, so it may not become DEFERRED.
  const changed = matrix();
  const row = changed.requirements.find(item => item.id === 'LITE-07-101');
  assert.equal(row.line, null, 'the fixture row is line-less');
  assert.equal(row.state, 'RUNTIME-VERIFY');
  row.state = 'DEFERRED';
  row.workPackage = null;
  assert.throws(() => validateScope(changed, evidence, lock, root), /new deferral/);
});

const sha256 = file => createHash('sha256').update(readFileSync(new URL('../' + file, import.meta.url))).digest('hex');

function passFixture() {
  const currentMatrix = matrix();
  const currentFreeze = freeze();
  const row = { ...currentMatrix.requirements.find(item => currentFreeze.frozenPassIds.includes(item.id)), state: 'PASS' };
  const baseline = row.evidenceBaseline ?? currentMatrix.baseline;
  const proof = {
    id: 'SYNTHETIC-RAW', baseline, kind: 'local-tests', cwd: '.',
    command: 'node scripts/verify-lite-scope.test.mjs', limitation: 'synthetic receipt',
    requirementIds: [row.id],
    result: { passed: 1, failed: 0, skipped: 0, exitCode: 0 },
    raw: {
      schemaVersion: 1, baseline,
      command: { executable: 'node', args: ['scripts/verify-lite-scope.test.mjs'] },
      cwd: '.', rawExitCode: 0, signal: null, error: null, trackedCheckoutUnchanged: true,
      logs: [{ path: 'scripts/verify-lite-scope.mjs', sha256: sha256('scripts/verify-lite-scope.mjs') }],
      counts: { passed: 1, failed: 0, skipped: 0 },
      assertionCoverage: [{
        id: 'synthetic.pass', requirementId: row.id, file: 'scripts/verify-lite-scope.test.mjs',
        name: 'synthetic PASS receipt', line: 1, outcome: 'passed',
      }],
    },
  };
  return { currentMatrix, row, proof };
}

test('scope accepts the frozen matrix with individually authorized PASS rows', () => {
  const result = validateScope(matrix(), evidence, lock, root);
  assert.equal(result.PASS, 17);
  assert.equal(result.GAP, 12);
  // 201 / 165 rather than 205 / 164: the user-authorized LITE-04-101 deferral moves
  // exactly one row, and the controlled v18 promotions close seventeen independently
  // evidenced rows without changing the permanent scope.
  assert.equal(result['RUNTIME-VERIFY'], 201);
  assert.equal(result.DEFERRED, 165);
});

test('freeze anchor rejects a rewritten original state', () => {
  const changed = freeze();
  changed.rows[0].state = 'RUNTIME-VERIFY';
  assert.throws(() => validatePassFreeze(changed), /pass-freeze identity changed|frozenPassIds mismatch/);
});

test('freeze rejects old PASS re-upgrade and GAP or DEFERRED closure', () => {
  for (const before of ['PASS', 'GAP', 'DEFERRED']) {
    const changed = matrix();
    const frozen = freeze();
    const authorizedPromotions = new Set(json('pass-promotions.json').promotions.map(item => item.requirementId));
    const row = changed.requirements.find(item => frozen.rows.find(original => original.id === item.id)?.state === before
      && (before !== 'GAP' || !authorizedPromotions.has(item.id)));
    row.state = before === 'DEFERRED' ? 'GAP' : 'PASS';
    if (before === 'DEFERRED') row.workPackage = 'S8';
    assert.throws(() => validateScope(changed, evidence, lock, root, frozen), before === 'PASS'
      ? /PASS state is frozen|allowed PASS|individually authorized promotion/
      : new RegExp(`original ${before} state changed|individually authorized promotion`));
  }
});

test('old PASS evidence declaration is rejected without a raw receipt', () => {
  const currentMatrix = matrix();
  const row = { ...currentMatrix.requirements.find(item => item.evidence.includes('S0-V01')), state: 'PASS' };
  const oldProof = evidence.find(item => item.id === row.evidence[0]);
  assert.throws(() => validatePassEvidence(row, oldProof, currentMatrix, root), /raw receipt/);
});

test('PASS evidence requires baseline, literal command, raw exit, counts and assertion mapping', () => {
  const cases = [
    ['baseline', proof => { proof.baseline = 'f'.repeat(40); }, /wrong evidence baseline/],
    ['command', proof => { proof.command = 'node <placeholder>'; }, /command is not literal/],
    ['raw exit', proof => { proof.raw.rawExitCode = 1; }, /raw exit code/],
    ['counts', proof => { proof.raw.counts.failed = 1; }, /raw fail count/],
    ['assertions', proof => { proof.raw.assertionCoverage = []; }, /assertion mapping/],
    ['log checksum', proof => { proof.raw.logs[0].sha256 = '0'.repeat(64); }, /checksum/],
  ];
  for (const [, change, error] of cases) {
    const { currentMatrix, row, proof } = passFixture();
    change(proof);
    assert.throws(() => validatePassEvidence(row, proof, currentMatrix, root), error);
  }
});

test('declared five fields cannot turn a source file into a raw execution log', () => {
  const { currentMatrix, row, proof } = passFixture();
  assert.throws(() => validatePassEvidence(row, proof, currentMatrix, root), /raw summary/);
});

test('final closure checks the real HEAD before CI or Provider evidence', () => {
  const changed = matrix();
  changed.requirements = changed.requirements.map(row => (
    row.state === 'GAP' || row.state === 'RUNTIME-VERIFY' ? { ...row, state: 'DEFERRED', workPackage: null } : row
  ));
  changed.finalImplementationSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  changed.finalMainSha = '0'.repeat(40);
  assert.throws(() => validateFinalClosure(changed, [], root), /real current HEAD/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().length, 40);
});

test('permanent scope still rejects removed, recycled, and additional requirement IDs', () => {
  const removed = matrix();
  removed.requirements.shift();
  assert.throws(() => validateScope(removed, evidence, lock, root), /removed permanent id/);
  const rewritten = matrix();
  rewritten.requirements[0].requirement = 'Claim a smaller goal';
  assert.throws(() => validateScope(rewritten, evidence, lock, root), /source quote mismatch|changed requirement identity/);
  const added = matrix();
  added.requirements.push({ ...added.requirements[0], id: 'LITE-00-800', line: null, state: 'GAP', evidence: [] });
  assert.throws(() => validateScope(added, evidence, lock, root), /scope lock must cover|unapproved scope addition/);
});

test('specification, deferral, and permanent scope-lock drift remain rejected', () => {
  const changed = matrix();
  changed.documents[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateScope(changed, evidence, lock, root), /spec changed without scope amendment/);
  const deferred = matrix();
  deferred.requirements[0].state = 'DEFERRED';
  deferred.requirements[0].workPackage = null;
  assert.throws(() => validateScope(deferred, evidence, lock, root), /new deferral/);
  const changedLock = structuredClone(lock);
  changedLock[0].initialState = 'DEFERRED';
  assert.throws(() => validateScope(matrix(), evidence, changedLock, root), /permanent scope lock changed/);
});

function promotionFixture() {
  const currentMatrix = matrix();
  const row = currentMatrix.requirements.find(item => item.id === 'LITE-07-003');
  const frozen = freeze();
  const frozenById = new Map(frozen.rows.map(item => [item.id, item.state]));
  for (const item of currentMatrix.requirements) {
    if (item.state === 'PASS') {
      const frozenState = frozenById.get(item.id);
      // The original freeze recorded two historical PASS rows that were
      // explicitly withdrawn to RUNTIME-VERIFY before this promotion authority.
      item.state = frozenState === 'PASS' ? 'RUNTIME-VERIFY' : frozenState;
    }
  }
  row.state = 'PASS';
  const authority = json('pass-promotion-authority.json');
  const promotion = {
    promotionId: 'PROMOTION-LITE-07-003',
    requirementId: 'LITE-07-003',
    from: 'GAP',
    to: 'PASS',
    baselineSha: currentMatrix.promotionBaselineSha,
    implementation: ['apps/server/src/routes/runs.ts'],
    evidenceIds: ['PROMO-EVIDENCE-LITE-07-003'],
    command: 'node --import tsx --test --test-reporter=tap src/routes/runs.test.ts',
    cwd: 'apps/server',
    rawExitCode: 0,
    counts: { passed: 1, failed: 0, skipped: 0 },
    assertions: [{
      id: 'PROMO-ASSERT-LITE-07-003',
      file: 'apps/server/src/routes/runs.test.ts',
      name: 'returns run list and aggregated details with workspace isolation and capped limit',
      line: 44,
      expression: "assert.deepEqual(list.runs.map(run => run.id), ['run-a']);",
      clause: 'The production route returns the run details for the requested workspace and run.',
      whyDirect: 'This assertion exercises the route through HTTP and checks the exact scoped response, rather than merely loading the test file.',
      outcome: 'passed',
    }],
    rationale: 'The direct route assertion is mapped to the production implementation and a raw TAP receipt for this one requirement.',
  };
  const ledger = {
    schemaVersion: 1,
    authorityId: authority.authorityId,
    authorityHash: authority.hashAnchor,
    matrixVersion: currentMatrix.matrixVersion,
    baselineSha: currentMatrix.promotionBaselineSha,
    promotions: [promotion],
  };
  return { currentMatrix, row, authority, ledger, promotion };
}

test('controlled promotion authorizes one directly evidenced row and no other row', () => {
  const { currentMatrix, authority, ledger, promotion } = promotionFixture();
  const promotions = validatePassPromotions(currentMatrix, freeze(), authority, ledger, root, validateDeferralAmendments(deferralAmendments()));
  assert.deepEqual([...promotions.byId.keys()], [promotion.requirementId]);
  assert.doesNotThrow(() => validateFrozenScopeStates(currentMatrix, freeze(), validateDeferralAmendments(deferralAmendments()), promotions.byId));
});

test('controlled promotion requires direct assertion fields, not a file-level claim', () => {
  const { currentMatrix, authority, ledger } = promotionFixture();
  ledger.promotions[0].assertions = [];
  assert.throws(() => validatePassPromotions(currentMatrix, freeze(), authority, ledger, root, validateDeferralAmendments(deferralAmendments())), /assertions are required/);
});

test('controlled promotion requires the one final implementation baseline', () => {
  const { currentMatrix, authority, ledger } = promotionFixture();
  ledger.baselineSha = '0'.repeat(40);
  assert.throws(() => validatePassPromotions(currentMatrix, freeze(), authority, ledger, root, validateDeferralAmendments(deferralAmendments())), /baseline is not the authorized final implementation SHA/);
});

test('controlled promotion cannot bulk-close a row without its own record', () => {
  const { currentMatrix, authority, ledger } = promotionFixture();
  ledger.promotions = [];
  assert.throws(() => validatePassPromotions(currentMatrix, freeze(), authority, ledger, root, validateDeferralAmendments(deferralAmendments())), /no individually authorized promotion/);
});

test('controlled promotion never changes an explicitly deferred row', () => {
  const { currentMatrix, authority, ledger } = promotionFixture();
  const row = currentMatrix.requirements.find(item => item.id === 'LITE-04-101');
  row.state = 'PASS';
  ledger.promotions[0].requirementId = row.id;
  ledger.promotions[0].promotionId = `PROMOTION-${row.id}`;
  ledger.promotions[0].from = 'RUNTIME-VERIFY';
  assert.throws(() => validatePassPromotions(currentMatrix, freeze(), authority, ledger, root, validateDeferralAmendments(deferralAmendments())), /DEFERRED row is immutable/);
});

test('promotion authority remains hash-anchored outside the mutable ledger', () => {
  const authority = json('pass-promotion-authority.json');
  authority.constraints[0] = 'tampered';
  assert.throws(() => validatePassPromotionAuthority(authority), /authority identity changed/);
});
