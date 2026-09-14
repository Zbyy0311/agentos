import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const auditRoot = resolve(root, 'docs/implementation/lite-closeout');
const states = new Set(['PASS', 'GAP', 'RUNTIME-VERIFY', 'DEFERRED']);
const sha40 = /^[a-f0-9]{40}$/;
const sha64 = /^[a-f0-9]{64}$/;
const requirementId = /^LITE-\d{2}-\d{3}$/;
const digest = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const fileDigest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

// S0 v1 identity anchor; changing it requires a separately reviewed scope amendment.
const scopeLockHash = '140848da717c448daae0a6ddd44413c8d808eab70464bd0d482946f5f3f27aba';

// pass-freeze.json is anchored outside the file so changing both the file and
// its self-declared hash cannot silently authorize a new PASS.
export const PASS_FREEZE_BASELINE = '3ac02ceb54b701e3143c9ffdda7b782aac396ace';
export const PASS_FREEZE_MATRIX_VERSION = 14;
export const PASS_FREEZE_HASH_ANCHOR = '66ffb04af96000c074482bb3ad3f01405197290a6d0447515ff415315c17a05e';
// deferral-amendments.json is anchored outside the file for the same reason the
// pass freeze is: rewriting both the file and its self-declared hash must not be
// able to authorize a state change on its own. An amendment may only ever move a
// row into DEFERRED, so this anchor is never a promotion path.
export const DEFERRAL_AMENDMENT_HASH_ANCHOR = 'dd0c0dde61d23c1307516eb2f6a299d306136b73a5c2a044f7f702a523a3a5df';
const DEFERRAL_AMENDMENT_FILE = 'deferral-amendments.json';
// PASS promotion is a separate, additive authority. The original pass-freeze file
// remains immutable; this anchor only recognizes the user's explicit, controlled
// per-row release of that freeze and cannot authorize a scope addition or a deferral.
export const PASS_PROMOTION_AUTHORITY_HASH_ANCHOR = 'b8a3f061b5d8f1688c57e5abefd6c4f03b800d0ee8d0d9de92329d69b4655714';
const PASS_PROMOTION_AUTHORITY_FILE = 'pass-promotion-authority.json';
const PASS_PROMOTIONS_FILE = 'pass-promotions.json';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (value, label) => assert.ok(isObject(value), `${label} must be an object`);
const assertSha = (value, expression, label) => {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.match(value, expression, `${label} must be lowercase hexadecimal`);
};
const unique = (values, label) => {
  assert.ok(Array.isArray(values), `${label} must be an array`);
  assert.equal(new Set(values).size, values.length, `duplicate ${label}`);
};

function repositoryPath(repositoryRoot, candidate, label) {
  assert.equal(typeof candidate, 'string', `${label} must be a path`);
  const base = resolve(repositoryRoot);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate);
  const relativePath = relative(base, absolute);
  assert.ok(
    relativePath === ''
      || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)),
    `unsafe ${label}`,
  );
  return absolute;
}

function existingPath(repositoryRoot, candidate, label) {
  const path = repositoryPath(repositoryRoot, candidate, label);
  assert.ok(existsSync(path), `missing ${label}: ${candidate}`);
  return path;
}

function freezePayload(freeze) {
  return {
    schemaVersion: freeze.schemaVersion,
    baseline: freeze.baseline,
    matrixVersion: freeze.matrixVersion,
    rows: freeze.rows,
    frozenPassIds: freeze.frozenPassIds,
    allowedPassIds: freeze.allowedPassIds,
  };
}

export function hashPassFreeze(freeze) {
  return digest(JSON.stringify(freezePayload(freeze)));
}

export function validatePassFreeze(freeze) {
  object(freeze, 'pass-freeze');
  for (const key of Object.keys(freeze)) {
    assert.ok(['schemaVersion', 'baseline', 'matrixVersion', 'rows', 'frozenPassIds', 'allowedPassIds', 'hashAnchor'].includes(key),
      `pass-freeze has unknown field ${key}`);
  }
  assert.equal(freeze.schemaVersion, 1, 'invalid pass-freeze schemaVersion');
  assert.equal(freeze.baseline, PASS_FREEZE_BASELINE, 'pass-freeze baseline changed');
  assert.equal(freeze.matrixVersion, PASS_FREEZE_MATRIX_VERSION, 'pass-freeze matrixVersion changed');
  assert.ok(Array.isArray(freeze.rows), 'pass-freeze rows must be an array');
  const byId = new Map();
  for (const row of freeze.rows) {
    object(row, 'pass-freeze row');
    assert.deepEqual(Object.keys(row).sort(), ['id', 'state'], 'pass-freeze row schema changed');
    assert.match(row.id, requirementId, `invalid pass-freeze row id ${row.id}`);
    assert.ok(states.has(row.state), `invalid pass-freeze state ${row.id}`);
    assert.ok(!byId.has(row.id), `duplicate pass-freeze row ${row.id}`);
    byId.set(row.id, row.state);
  }
  unique(freeze.frozenPassIds, 'frozenPassIds');
  unique(freeze.allowedPassIds, 'allowedPassIds');
  for (const id of [...freeze.frozenPassIds, ...freeze.allowedPassIds]) {
    assert.match(id, requirementId, `invalid pass-freeze id ${id}`);
    assert.ok(byId.has(id), `pass-freeze id is absent from rows ${id}`);
  }
  const rowPassIds = [...byId].filter(([, state]) => state === 'PASS').map(([id]) => id);
  assert.deepEqual(new Set(freeze.frozenPassIds), new Set(rowPassIds), 'frozenPassIds mismatch');
  for (const id of freeze.allowedPassIds) assert.ok(freeze.frozenPassIds.includes(id), `allowed PASS is not frozen: ${id}`);
  const anchor = hashPassFreeze(freeze);
  assert.equal(anchor, PASS_FREEZE_HASH_ANCHOR, 'pass-freeze identity changed');
  if (Object.hasOwn(freeze, 'hashAnchor')) assert.equal(freeze.hashAnchor, anchor, 'pass-freeze hash anchor mismatch');
  return { byId, allowedPassIds: new Set(freeze.allowedPassIds), anchor };
}

/**
 * A user-authorized deferral amendment. It is deliberately narrow: it can only move
 * a row into DEFERRED, it must name the state it came from, it must carry the
 * authority for the change and the condition under which the row is reopened, and its
 * identity is anchored outside the file. Nothing here can create or restore a PASS.
 */
function amendmentPayload(amendments) {
  return { schemaVersion: amendments.schemaVersion, amendments: amendments.amendments };
}

export function hashDeferralAmendments(amendments) {
  return digest(JSON.stringify(amendmentPayload(amendments)));
}

export function validateDeferralAmendments(amendments) {
  object(amendments, 'deferral-amendments');
  for (const key of Object.keys(amendments)) {
    assert.ok(['schemaVersion', 'amendments', 'hashAnchor'].includes(key),
      `deferral-amendments has unknown field ${key}`);
  }
  assert.equal(amendments.schemaVersion, 1, 'invalid deferral-amendments schemaVersion');
  assert.ok(Array.isArray(amendments.amendments), 'deferral-amendments must be an array');
  const byId = new Map();
  for (const amendment of amendments.amendments) {
    object(amendment, 'deferral amendment');
    for (const key of Object.keys(amendment)) {
      assert.ok(['requirementId', 'from', 'to', 'authority', 'exitCondition', 'exitConditionSource',
        'reason', 'receipts', 'receiptBaseline', 'chainVerification', 'reopenCondition', 'boundary'].includes(key),
      `deferral amendment has unknown field ${key}`);
    }
    assert.match(amendment.requirementId, requirementId, `invalid deferral amendment id ${amendment.requirementId}`);
    assert.ok(states.has(amendment.from), `invalid deferral amendment from ${amendment.requirementId}`);
    // The only target an amendment may name is DEFERRED, and a row already in
    // DEFERRED has nothing to amend. Both refusals keep this file from becoming a
    // second, weaker route to a PASS.
    assert.equal(amendment.to, 'DEFERRED', `a deferral amendment may only defer: ${amendment.requirementId}`);
    assert.notEqual(amendment.from, 'DEFERRED', `a deferral amendment must move into DEFERRED: ${amendment.requirementId}`);
    for (const [field, label] of [['authority', 'authority'], ['reopenCondition', 'reopen condition'],
      ['boundary', 'boundary'], ['exitCondition', 'exit condition']]) {
      assert.equal(typeof amendment[field], 'string', `a deferral amendment requires ${label}: ${amendment.requirementId}`);
      assert.ok(amendment[field].trim().length > 0, `a deferral amendment requires ${label}: ${amendment.requirementId}`);
    }
    assert.ok(Array.isArray(amendment.reason) && amendment.reason.length > 0,
      `a deferral amendment requires reasons: ${amendment.requirementId}`);
    assert.ok(Array.isArray(amendment.receipts), `a deferral amendment requires receipts: ${amendment.requirementId}`);
    assert.ok(byId.get(amendment.requirementId) === undefined, `duplicate deferral amendment ${amendment.requirementId}`);
    byId.set(amendment.requirementId, amendment);
  }
  const anchor = hashDeferralAmendments(amendments);
  assert.equal(anchor, DEFERRAL_AMENDMENT_HASH_ANCHOR, 'deferral amendment identity changed');
  if (Object.hasOwn(amendments, 'hashAnchor')) {
    assert.equal(amendments.hashAnchor, anchor, 'deferral amendment hash anchor mismatch');
  }
  return byId;
}

function loadDeferralAmendments(repositoryRoot) {
  const path = resolve(repositoryRoot, 'docs/implementation/lite-closeout', DEFERRAL_AMENDMENT_FILE);
  return validateDeferralAmendments(readJson(existingPath(repositoryRoot, path, 'deferral amendment file')));
}

function promotionAuthorityPayload(authority) {
  return {
    schemaVersion: authority.schemaVersion,
    authorityId: authority.authorityId,
    grantedAt: authority.grantedAt,
    grantedBy: authority.grantedBy,
    purpose: authority.purpose,
    matrixVersion: authority.matrixVersion,
    allowedTransitions: authority.allowedTransitions,
    constraints: authority.constraints,
    deferredPolicy: authority.deferredPolicy,
    reopenCondition: authority.reopenCondition,
  };
}

export function hashPassPromotionAuthority(authority) {
  return digest(JSON.stringify(promotionAuthorityPayload(authority)));
}

export function validatePassPromotionAuthority(authority) {
  object(authority, 'pass-promotion-authority');
  for (const key of Object.keys(authority)) {
    assert.ok([
      'schemaVersion', 'authorityId', 'grantedAt', 'grantedBy', 'purpose', 'matrixVersion',
      'allowedTransitions', 'constraints', 'deferredPolicy', 'reopenCondition', 'hashAnchor',
    ].includes(key), `pass-promotion-authority has unknown field ${key}`);
  }
  assert.equal(authority.schemaVersion, 1, 'invalid pass-promotion-authority schemaVersion');
  for (const field of ['authorityId', 'grantedAt', 'grantedBy', 'purpose', 'deferredPolicy', 'reopenCondition']) {
    assert.equal(typeof authority[field], 'string', `pass-promotion-authority requires ${field}`);
    assert.ok(authority[field].trim().length > 0, `pass-promotion-authority requires ${field}`);
  }
  assert.equal(authority.authorityId, 'lite-pass-promotion-20260915', 'pass-promotion authority identity changed');
  assert.equal(authority.matrixVersion, 17, 'pass-promotion authority matrix version changed');
  assert.ok(Array.isArray(authority.allowedTransitions), 'pass-promotion-authority transitions must be an array');
  assert.deepEqual(authority.allowedTransitions, [
    { from: 'GAP', to: 'PASS' },
    { from: 'RUNTIME-VERIFY', to: 'PASS' },
  ], 'pass-promotion authority transitions changed');
  assert.ok(Array.isArray(authority.constraints) && authority.constraints.length > 0,
    'pass-promotion-authority constraints are required');
  for (const constraint of authority.constraints) {
    assert.equal(typeof constraint, 'string', 'pass-promotion authority constraint must be text');
    assert.ok(constraint.trim().length > 0, 'pass-promotion authority constraint must not be empty');
  }
  const anchor = hashPassPromotionAuthority(authority);
  assert.equal(anchor, PASS_PROMOTION_AUTHORITY_HASH_ANCHOR, 'pass-promotion authority identity changed');
  if (Object.hasOwn(authority, 'hashAnchor')) assert.equal(authority.hashAnchor, anchor, 'pass-promotion authority hash mismatch');
  return { ...authority, hashAnchor: anchor };
}

function loadPassPromotionAuthority(repositoryRoot, matrix) {
  assert.equal(typeof matrix.passPromotionAuthority, 'string', 'matrix.passPromotionAuthority is required');
  const path = resolve(repositoryRoot, 'docs/implementation/lite-closeout', matrix.passPromotionAuthority);
  return validatePassPromotionAuthority(readJson(existingPath(repositoryRoot, path, 'pass-promotion authority file')));
}

function promotionKeys(promotion) {
  return Object.keys(promotion).sort();
}

export function validatePassPromotions(matrix, freeze, authority, ledger, repositoryRoot = root, deferralAmendments = new Map()) {
  const validatedAuthority = validatePassPromotionAuthority(authority);
  object(ledger, 'pass-promotions');
  for (const key of Object.keys(ledger)) {
    assert.ok(['schemaVersion', 'authorityId', 'authorityHash', 'matrixVersion', 'baselineSha', 'promotions'].includes(key),
      `pass-promotions has unknown field ${key}`);
  }
  assert.equal(ledger.schemaVersion, 1, 'invalid pass-promotions schemaVersion');
  assert.equal(ledger.authorityId, validatedAuthority.authorityId, 'pass-promotions authority mismatch');
  assert.equal(ledger.authorityHash, validatedAuthority.hashAnchor, 'pass-promotions authority hash mismatch');
  assert.equal(ledger.matrixVersion, matrix.matrixVersion, 'pass-promotions matrix version mismatch');
  assertSha(ledger.baselineSha, sha40, 'pass-promotions baselineSha');
  assert.equal(ledger.baselineSha, matrix.promotionBaselineSha, 'pass-promotions baseline is not the authorized final implementation SHA');
  assert.ok(Array.isArray(ledger.promotions), 'pass-promotions promotions must be an array');
  const freezeInfo = validatePassFreeze(freeze);
  const rows = new Map(matrix.requirements.map(row => [row.id, row]));
  const byId = new Map();
  for (const promotion of ledger.promotions) {
    object(promotion, 'pass promotion');
    assert.deepEqual(promotionKeys(promotion), [
      'assertions', 'baselineSha', 'command', 'counts', 'cwd', 'evidenceIds', 'from', 'implementation',
      'promotionId', 'rationale', 'rawExitCode', 'requirementId', 'to',
    ], `pass promotion schema changed: ${promotion.requirementId ?? '<unknown>'}`);
    assert.match(promotion.requirementId, requirementId, `invalid pass promotion id ${promotion.requirementId}`);
    assert.equal(promotion.promotionId, `PROMOTION-${promotion.requirementId}`, `pass promotion identity mismatch: ${promotion.requirementId}`);
    assert.ok(!byId.has(promotion.requirementId), `duplicate pass promotion ${promotion.requirementId}`);
    const row = rows.get(promotion.requirementId);
    assert.ok(row, `pass promotion references unknown requirement: ${promotion.requirementId}`);
    assert.equal(row.state, 'PASS', `pass promotion row is not PASS: ${promotion.requirementId}`);
    assert.ok(!deferralAmendments.has(promotion.requirementId),
      `DEFERRED row is immutable under pass-promotion authority: ${promotion.requirementId}`);
    assert.ok(promotion.from === 'GAP' || promotion.from === 'RUNTIME-VERIFY', `invalid pass promotion from: ${promotion.requirementId}`);
    assert.equal(promotion.to, 'PASS', `pass promotion target must be PASS: ${promotion.requirementId}`);
    const frozenState = freezeInfo.byId.get(promotion.requirementId);
    assert.ok(frozenState !== undefined, `pass promotion is outside frozen scope: ${promotion.requirementId}`);
    // Old PASS rows were withdrawn to RUNTIME-VERIFY before this authority was
    // granted. They may only be restored through that explicit intermediate state.
    const expectedFrom = frozenState === 'PASS' ? 'RUNTIME-VERIFY' : frozenState;
    assert.equal(promotion.from, expectedFrom, `pass promotion transition is not the recorded row transition: ${promotion.requirementId}`);
    assert.equal(promotion.baselineSha, ledger.baselineSha, `pass promotion baseline mismatch: ${promotion.requirementId}`);
    assert.equal(typeof promotion.command, 'string', `pass promotion command is required: ${promotion.requirementId}`);
    assert.ok(promotion.command.trim().length > 0 && !/<[^>]+>/.test(promotion.command), `pass promotion command is not literal: ${promotion.requirementId}`);
    assert.equal(typeof promotion.cwd, 'string', `pass promotion cwd is required: ${promotion.requirementId}`);
    assert.equal(promotion.rawExitCode, 0, `pass promotion raw exit must be zero: ${promotion.requirementId}`);
    object(promotion.counts, `pass promotion counts ${promotion.requirementId}`);
    for (const key of ['passed', 'failed', 'skipped']) {
      assert.ok(Number.isSafeInteger(promotion.counts[key]) && promotion.counts[key] >= 0,
        `pass promotion count ${key} is required: ${promotion.requirementId}`);
    }
    assert.ok(promotion.counts.passed > 0, `pass promotion has no passing assertions: ${promotion.requirementId}`);
    assert.equal(promotion.counts.failed, 0, `pass promotion has failures: ${promotion.requirementId}`);
    assert.equal(promotion.counts.skipped, 0, `pass promotion has skipped assertions: ${promotion.requirementId}`);
    assert.ok(Array.isArray(promotion.implementation) && promotion.implementation.length > 0,
      `pass promotion implementation is required: ${promotion.requirementId}`);
    for (const file of promotion.implementation) existingPath(repositoryRoot, file, `pass promotion implementation ${promotion.requirementId}`);
    assert.ok(Array.isArray(promotion.evidenceIds) && promotion.evidenceIds.length > 0,
      `pass promotion evidenceIds are required: ${promotion.requirementId}`);
    unique(promotion.evidenceIds, `pass promotion evidenceIds ${promotion.requirementId}`);
    assert.ok(Array.isArray(promotion.assertions) && promotion.assertions.length > 0,
      `pass promotion assertions are required: ${promotion.requirementId}`);
    unique(promotion.assertions.map(assertion => assertion.id), `pass promotion assertion ids ${promotion.requirementId}`);
    for (const assertion of promotion.assertions) {
      object(assertion, `pass promotion assertion ${promotion.requirementId}`);
      assert.deepEqual(Object.keys(assertion).sort(), ['clause', 'expression', 'file', 'id', 'line', 'name', 'outcome', 'whyDirect'],
        `pass promotion assertion schema changed: ${promotion.requirementId}`);
      for (const field of ['id', 'clause', 'expression', 'file', 'name', 'whyDirect']) {
        assert.equal(typeof assertion[field], 'string', `pass promotion assertion ${field} is required: ${promotion.requirementId}`);
        assert.ok(assertion[field].trim().length > 0, `pass promotion assertion ${field} is empty: ${promotion.requirementId}`);
      }
      assert.ok(Number.isSafeInteger(assertion.line) && assertion.line > 0, `pass promotion assertion line is required: ${promotion.requirementId}`);
      assert.equal(assertion.outcome, 'passed', `pass promotion assertion outcome is not passed: ${promotion.requirementId}`);
      existingPath(repositoryRoot, assertion.file, `pass promotion assertion source ${promotion.requirementId}`);
      const source = readFileSync(existingPath(repositoryRoot, assertion.file, `pass promotion assertion source ${promotion.requirementId}`), 'utf8');
      assert.ok(/\b(?:assert|expect)\b/.test(assertion.expression), `pass promotion assertion expression is not an assertion: ${promotion.requirementId}`);
      assert.ok(source.split(/\r?\n/)[assertion.line - 1]?.includes(assertion.expression),
        `pass promotion assertion expression is not at the stated source line: ${promotion.requirementId}`);
      assert.ok(source.includes(assertion.name), `pass promotion assertion test name is absent: ${promotion.requirementId}`);
    }
    assert.equal(typeof promotion.rationale, 'string', `pass promotion rationale is required: ${promotion.requirementId}`);
    assert.ok(promotion.rationale.trim().length > 0, `pass promotion rationale is empty: ${promotion.requirementId}`);
    byId.set(promotion.requirementId, promotion);
  }
  for (const row of matrix.requirements) {
    if (row.state === 'PASS' && !freezeInfo.allowedPassIds.has(row.id)) {
      assert.ok(byId.has(row.id), `PASS row has no individually authorized promotion: ${row.id}`);
    }
  }
  return { authority: validatedAuthority, byId };
}

export function validatePassPromotionEvidence(row, promotion, evidenceMap, matrix, repositoryRoot = root) {
  assert.equal(row.state, 'PASS', `promotion evidence row is not PASS: ${row.id}`);
  assert.deepEqual(
    [...new Set(row.evidence)].sort(),
    [...new Set(promotion.evidenceIds)].sort(),
    `promotion evidence does not exactly match the row evidence: ${row.id}`,
  );
  const rawReceipts = [];
  for (const evidenceId of promotion.evidenceIds) {
    const proof = evidenceMap.get(evidenceId);
    assert.ok(proof, `promotion evidence is not present in evidence.json: ${row.id}:${evidenceId}`);
    rawReceipts.push(validatePassEvidence(row, proof, matrix, repositoryRoot));
  }
  for (const assertion of promotion.assertions) {
    const matched = rawReceipts.some(raw => raw.assertionCoverage.some(candidate => (
      candidate.id === assertion.id
      && candidate.requirementId === row.id
      && candidate.file === assertion.file
      && candidate.name === assertion.name
      && candidate.line === assertion.line
      && candidate.expression === assertion.expression
      && candidate.outcome === assertion.outcome
    )));
    assert.ok(matched, `promotion assertion has no matching raw evidence: ${row.id}:${assertion.id}`);
  }
}

function loadPassPromotions(repositoryRoot, matrix, freeze, deferralAmendments) {
  if (matrix.passPromotions === undefined) return new Map();
  assert.equal(typeof matrix.passPromotions, 'string', 'matrix.passPromotions is required');
  const path = resolve(repositoryRoot, 'docs/implementation/lite-closeout', matrix.passPromotions);
  const authority = loadPassPromotionAuthority(repositoryRoot, matrix);
  return validatePassPromotions(matrix, freeze, authority, readJson(existingPath(repositoryRoot, path, 'pass-promotions file')), repositoryRoot, deferralAmendments).byId;
}

export function validateFrozenScopeStates(matrix, freeze, deferralAmendments = new Map(), passPromotions = new Map()) {
  const { byId, allowedPassIds } = validatePassFreeze(freeze);
  const current = new Map(matrix.requirements.map(row => [row.id, row]));
  for (const id of byId.keys()) assert.ok(current.has(id), `removed frozen requirement ${id}`);
  for (const row of matrix.requirements) {
    const before = byId.get(row.id);
    if (before === undefined) {
      assert.notEqual(row.state, 'PASS', `new PASS is forbidden during pass freeze: ${row.id}`);
    } else if (before === 'PASS') {
      assert.ok(row.state === 'RUNTIME-VERIFY' || row.state === 'PASS',
        `frozen PASS may only be withdrawn to RUNTIME-VERIFY: ${row.id}`);
      if (row.state === 'PASS') assert.ok(allowedPassIds.has(row.id) || passPromotions.has(row.id), `PASS state is frozen and not allowed: ${row.id}`);
    } else {
      // A user-authorized deferral amendment may move a row from the state the freeze
      // recorded into DEFERRED, and only into DEFERRED: validateDeferralAmendments has
      // already refused every other target, so this cannot become a promotion path.
      const amendment = deferralAmendments.get(row.id);
      const authorizedDeferral = row.state === 'DEFERRED' && amendment !== undefined && amendment.from === before;
      const authorizedPromotion = row.state === 'PASS' && passPromotions.has(row.id);
      assert.ok(authorizedDeferral || authorizedPromotion || row.state === before,
        `original ${before} state changed: ${row.id}`);
    }
  }
  return { byId, allowedPassIds };
}

function loadRaw(proof, repositoryRoot, label) {
  assert.ok((proof.rawReceipt && !proof.raw) || (!proof.rawReceipt && proof.raw), `${label} requires one raw receipt`);
  return proof.rawReceipt
    ? readJson(existingPath(repositoryRoot, proof.rawReceipt, `${label} rawReceipt`))
    : proof.raw;
}

function validateRaw(proof, expectedBaseline, repositoryRoot, label) {
  const raw = loadRaw(proof, repositoryRoot, label);
  object(raw, `${label} raw receipt`);
  assert.equal(raw.schemaVersion, 1, `${label} raw receipt schemaVersion`);
  assertSha(raw.baseline, sha40, `${label} raw baseline`);
  assert.equal(raw.baseline, expectedBaseline, `${label} raw baseline mismatch`);
  object(raw.command, `${label} raw command`);
  assert.equal(typeof raw.command.executable, 'string', `${label} raw executable is required`);
  assert.ok(raw.command.executable && Array.isArray(raw.command.args), `${label} raw command is incomplete`);
  assert.ok(raw.command.args.every(argument => typeof argument === 'string'), `${label} raw command args are invalid`);
  assert.ok(!/<[^>]+>/.test(JSON.stringify(raw.command)), `${label} raw command is not literal`);
  assert.equal(typeof raw.cwd, 'string', `${label} raw cwd is required`);
  assert.equal(resolve(existingPath(repositoryRoot, raw.cwd, `${label} raw cwd`)),
    resolve(existingPath(repositoryRoot, proof.cwd, `${label} cwd`)), `${label} cwd mismatch`);
  assert.equal(raw.trackedCheckoutUnchanged, true, `${label} checkout changed during invocation`);
  assert.equal(raw.rawExitCode, 0, `${label} raw exit code must be zero`);
  assert.equal(raw.signal, null, `${label} invocation ended by signal`);
  assert.equal(raw.error, null, `${label} invocation reported a spawn error`);
  assert.ok(Array.isArray(raw.logs) && raw.logs.length > 0, `${label} requires original raw log`);
  for (const log of raw.logs) {
    object(log, `${label} raw log`);
    assertSha(log.sha256, sha64, `${label} raw log sha256`);
    const logPath = existingPath(repositoryRoot, log.path, `${label} raw log`);
    assert.equal(fileDigest(logPath), log.sha256, `${label} raw log checksum mismatch`);
  }
  object(raw.counts, `${label} raw counts`);
  for (const key of ['passed', 'failed', 'skipped']) {
    assert.ok(Number.isSafeInteger(raw.counts[key]) && raw.counts[key] >= 0, `${label} raw count ${key} is required`);
  }
  assert.ok(raw.counts.passed > 0, `${label} raw pass count is zero`);
  assert.equal(raw.counts.failed, 0, `${label} raw fail count is nonzero`);
  assert.equal(raw.counts.skipped, 0, `${label} raw skip count is nonzero`);
  assert.ok(Array.isArray(raw.assertionCoverage) && raw.assertionCoverage.length > 0,
    `${label} assertion mapping is required`);
  for (const assertion of raw.assertionCoverage) {
    object(assertion, `${label} assertion mapping`);
    for (const key of ['id', 'file', 'name']) assert.ok(typeof assertion[key] === 'string' && assertion[key], `${label} assertion ${key} is required`);
    assert.ok(Number.isSafeInteger(assertion.line) && assertion.line > 0, `${label} assertion line is required`);
    assert.equal(assertion.outcome, 'passed', `${label} assertion outcome is not passed`);
    existingPath(repositoryRoot, assertion.file, `${label} assertion source`);
  }
  const originalOutput = raw.logs.map(log => readFileSync(existingPath(repositoryRoot, log.path, `${label} raw log`), 'utf8')).join('\n');
  for (const [key, marker] of [['passed', 'pass'], ['failed', 'fail'], ['skipped', 'skipped']]) {
    const matches = [...originalOutput.matchAll(new RegExp('^# ' + marker + ' (\\d+)\\s*$', 'gm'))];
    assert.equal(matches.length, 1, `${label} raw summary ${marker} is missing or ambiguous`);
    assert.equal(Number(matches[0][1]), raw.counts[key], `${label} declared count disagrees with original output`);
  }
  for (const assertion of raw.assertionCoverage) {
    const source = readFileSync(existingPath(repositoryRoot, assertion.file, `${label} assertion source`), 'utf8');
    assert.ok(typeof assertion.expression === 'string' && /\b(?:assert|expect)\b/.test(assertion.expression), `${label} specific assertion expression is required`);
    assert.ok(source.split(/\r?\n/)[assertion.line - 1]?.includes(assertion.expression), `${label} assertion expression is not at the stated source line`);
    assert.ok(source.includes(assertion.name), `${label} test name is absent from source`);
    assert.ok(originalOutput.split(/\r?\n/).some(line => /^\s*ok \d+ - /.test(line) && line.includes(assertion.name)), `${label} assertion test has no executed passing TAP result`);
  }
  return raw;
}

function validateResult(proof, raw, label) {
  object(proof.result, `${label} result`);
  for (const key of ['passed', 'failed', 'skipped']) {
    assert.ok(Number.isSafeInteger(proof.result[key]), `${label} result ${key} is required`);
    assert.equal(proof.result[key], raw.counts[key], `${label} result ${key} disagrees with raw count`);
  }
  if (Object.hasOwn(proof.result, 'exitCode')) assert.equal(proof.result.exitCode, raw.rawExitCode, `${label} result exit mismatch`);
  if (Object.hasOwn(proof.result, 'conclusion')) assert.equal(proof.result.conclusion, 'success', `${label} conclusion is not success`);
}

export function validatePassEvidence(row, proof, matrix, repositoryRoot = root) {
  assert.equal(row.state, 'PASS', `PASS evidence row is not PASS: ${row.id}`);
  object(proof, `PASS evidence ${row.id}`);
  assertSha(proof.baseline, sha40, `evidence baseline ${proof.id ?? '<unknown>'}`);
  assert.equal(proof.baseline, row.evidenceBaseline ?? matrix.baseline, `wrong evidence baseline: ${proof.id ?? '<unknown>'}`);
  assert.equal(typeof proof.command, 'string', `PASS evidence command is required: ${proof.id ?? '<unknown>'}`);
  assert.ok(proof.command && !/<[^>]+>/.test(proof.command), `PASS evidence command is not literal: ${proof.id ?? '<unknown>'}`);
  assert.equal(typeof proof.cwd, 'string', `PASS evidence cwd is required: ${proof.id ?? '<unknown>'}`);
  assert.equal(typeof proof.limitation, 'string', `PASS evidence limitation is required: ${proof.id ?? '<unknown>'}`);
  assert.ok(Array.isArray(proof.requirementIds) && proof.requirementIds.includes(row.id), `evidence is not mapped to requirement: ${row.id}`);
  if (proof.kind === 'github-actions') assert.ok(proof.url, `unverified PASS evidence: ${proof.id}`);
  assert.ok(['local-tests', 'github-actions', 'runtime-verification'].includes(proof.kind), `unsupported PASS evidence kind: ${proof.kind}`);
  const raw = validateRaw(proof, proof.baseline, repositoryRoot, `PASS evidence ${proof.id}`);
  validateResult(proof, raw, `PASS evidence ${proof.id}`);
  assert.ok(raw.assertionCoverage.some(assertion => assertion.requirementId === row.id), `assertion mapping is not exact: ${row.id}`);
  return raw;
}

function loadFreeze(matrix, repositoryRoot) {
  assert.equal(typeof matrix.passFreeze, 'string', 'matrix.passFreeze is required');
  const path = resolve(repositoryRoot, 'docs/implementation/lite-closeout', matrix.passFreeze);
  return readJson(existingPath(repositoryRoot, path, 'pass-freeze file'));
}

function evidenceById(evidence) {
  assert.ok(Array.isArray(evidence), 'evidence must be an array');
  const byId = new Map(evidence.map(item => [item.id, item]));
  assert.equal(byId.size, evidence.length, 'duplicate evidence id');
  return byId;
}

export function validateFinalClosure(matrix, evidence, repositoryRoot = root) {
  assert.equal(matrix.requirements.filter(row => row.state === 'GAP' || row.state === 'RUNTIME-VERIFY').length, 0,
    'required Lite acceptance remains open');
  assertSha(matrix.finalMainSha, sha40, 'finalMainSha');
  const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  assert.equal(matrix.finalMainSha, actualHead, 'finalMainSha is not the real current HEAD');
  const byId = evidenceById(evidence);
  const ci = byId.get(matrix.finalCiEvidence);
  assert.ok(ci?.kind === 'github-actions' && ci.baseline === matrix.finalMainSha && ci.url, 'final main CI evidence is not verified');
  const ciRaw = validateRaw(ci, matrix.finalMainSha, repositoryRoot, 'final main CI');
  validateResult(ci, ciRaw, 'final main CI');
  assert.equal(ci.result.conclusion, 'success', 'final main CI conclusion is not success');
  assert.ok(Array.isArray(matrix.finalProviderEvidence) && matrix.finalProviderEvidence.length > 0,
    'final Provider gate evidence is required');
  const providers = new Set();
  for (const id of matrix.finalProviderEvidence) {
    const proof = byId.get(id);
    assert.ok(proof?.kind === 'runtime-verification' && proof.baseline === matrix.finalMainSha,
      `Provider gate is not on finalMainSha: ${id}`);
    const raw = validateRaw(proof, matrix.finalMainSha, repositoryRoot, `Provider gate ${id}`);
    validateResult(proof, raw, `Provider gate ${id}`);
    const provider = proof.provider?.toLowerCase();
    assert.ok(provider, `Provider gate ${id} has no provider identity`);
    assert.ok(raw.assertionCoverage.some(assertion => assertion.provider?.toLowerCase() === provider),
      `Provider gate ${id} has no provider assertion mapping`);
    providers.add(provider);
  }
  for (const provider of ['codex', 'kimi', 'opencode']) assert.ok(providers.has(provider), `missing Provider gate ${provider}`);
}

export function validateScope(matrix, evidence, lock, repositoryRoot = root, passFreeze = undefined, deferralAmendmentFile = undefined) {
  assert.equal(digest(JSON.stringify(lock, null, 2) + '\n'), scopeLockHash, 'permanent scope lock changed');
  assert.equal(matrix.schemaVersion, 1);
  assert.ok(['draft', 'frozen'].includes(matrix.status), 'invalid matrix status');
  assert.match(matrix.baseline, sha40);
  const evidenceMap = evidenceById(evidence);
  const lockedById = new Map(lock.map(item => [item.id, item]));
  assert.equal(lockedById.size, lock.length, 'duplicate locked id');
  const deferralAmendments = deferralAmendmentFile === undefined
    ? loadDeferralAmendments(repositoryRoot)
    : validateDeferralAmendments(deferralAmendmentFile);
  const ids = new Set();
  const documents = new Map();
  for (const doc of matrix.documents) {
    const content = readFileSync(resolve(repositoryRoot, 'docs/Runtime-Specification lite', doc.file), 'utf8');
    assert.equal(digest(content), doc.sha256, `spec changed without scope amendment: ${doc.file}`);
    documents.set(doc.file, content.split(/\r?\n/));
  }
  assert.equal(documents.size, 14, 'all 00-13 documents are required');
  for (const row of matrix.requirements) {
    assert.match(row.id, requirementId);
    assert.ok(!ids.has(row.id), `duplicate id ${row.id}`);
    ids.add(row.id);
    assert.ok(states.has(row.state), `invalid state ${row.id}`);
    assert.ok(documents.has(row.document), `unknown document ${row.id}`);
    assert.ok(row.section && row.requirement && row.finding && row.exit, `missing criterion ${row.id}`);
    assert.ok(row.state === 'DEFERRED' ? row.workPackage === null : /^S[1-8]$/.test(row.workPackage), `work package ${row.id}`);
    if (row.state === 'DEFERRED') {
      // A deferral is legitimate when S0 v1 already classified the row that way, or
      // when a separately anchored user authorization records the change.
      const originallyDeferred = lockedById.get(row.id)?.initialState === 'DEFERRED';
      const amendment = deferralAmendments.get(row.id);
      const authorizedDeferral = amendment?.to === 'DEFERRED';
      assert.ok(originallyDeferred || authorizedDeferral,
        `new deferral requires an explicit scope amendment: ${row.id}`);
      // Traceability: a row quoted from a document carries its literal line, while a
      // requirement derived from a user clarification has no literal line by
      // construction (all such rows are line-less). For those, the anchored amendment
      // must quote this row's exact exit condition, which ties the deferral to a real
      // criterion instead of letting a line-less row be deferred without a source.
      const traceable = row.line !== null
        || (amendment !== undefined && amendment.exitCondition === row.exit);
      assert.ok(traceable && row.finding && row.exit, `DEFERRED requires normative source: ${row.id}`);
    }
    const original = documents.get(row.document);
    if (row.line !== null) {
      assert.ok(Number.isSafeInteger(row.line) && row.line > 0, `source line ${row.id}`);
      assert.ok(original[row.line - 1]?.includes(row.requirement), `source quote mismatch ${row.id}`);
    }
    for (const file of [...row.implementation, ...row.tests]) {
      assert.ok(!file.includes('..') && !/^(?:[A-Z]:|\/)/i.test(file), `unsafe evidence path ${row.id}`);
      assert.ok(existsSync(resolve(repositoryRoot, file)), `missing evidence source ${row.id}: ${file}`);
    }
    for (const id of row.evidence) assert.ok(evidenceMap.has(id), `unknown evidence ${row.id}: ${id}`);
  }
  for (const frozen of lock) {
    const row = matrix.requirements.find(item => item.id === frozen.id);
    assert.ok(row, `removed permanent id ${frozen.id}`);
    assert.equal(row.document, frozen.document, `moved permanent id ${frozen.id}`);
    assert.equal(digest(row.requirement), frozen.sha256, `changed requirement identity ${frozen.id}`);
  }
  const locked = new Set(lock.map(item => item.id));
  assert.equal(lock.length, matrix.requirements.length, 'scope lock must cover every requirement');
  for (const row of matrix.requirements) {
    assert.ok(locked.has(row.id) || matrix.changes.some(change => change.addedIds?.includes(row.id) && change.authority), `unapproved scope addition ${row.id}`);
  }
  for (const [file, lines] of documents) {
    let inAcceptance = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^## /.test(lines[i])) inAcceptance = /Acceptance Expectations/.test(lines[i]);
      if (!inAcceptance || !lines[i].startsWith('- ')) continue;
      assert.equal(matrix.requirements.filter(row => row.document === file && row.line === i + 1).length, 1, `unmapped/duplicate acceptance ${file}:${i + 1}`);
    }
  }
  const freeze = passFreeze ?? loadFreeze(matrix, repositoryRoot);
  const passPromotions = loadPassPromotions(repositoryRoot, matrix, freeze, deferralAmendments);
  validateFrozenScopeStates(matrix, freeze, deferralAmendments, passPromotions);
  for (const row of matrix.requirements) {
    if (row.state !== 'PASS') continue;
    assert.ok(freeze.allowedPassIds.includes(row.id) || passPromotions.has(row.id), `PASS state is frozen and not allowed: ${row.id}`);
    assert.ok(row.evidence.length > 0, `PASS without evidence ${row.id}`);
    if (passPromotions.has(row.id)) {
      validatePassPromotionEvidence(row, passPromotions.get(row.id), evidenceMap, matrix, repositoryRoot);
    } else {
      for (const id of row.evidence) validatePassEvidence(row, evidenceMap.get(id), matrix, repositoryRoot);
    }
  }
  return Object.fromEntries([...states].map(state => [state, matrix.requirements.filter(row => row.state === state).length]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matrix = readJson(resolve(auditRoot, 'matrix.json'));
  const evidence = readJson(resolve(auditRoot, 'evidence.json'));
  const freeze = loadFreeze(matrix, root);
  const result = validateScope(matrix, evidence, readJson(resolve(auditRoot, 'scope-lock.json')), root, freeze);
  if (process.argv.includes('--require-closed')) {
    assert.equal(matrix.status, 'frozen', 'S0 is not frozen');
    assert.equal(result.GAP + result['RUNTIME-VERIFY'], 0, 'required Lite acceptance remains open');
    validateFinalClosure(matrix, evidence, root);
  }
  const index = process.argv.indexOf('--implement');
  if (index >= 0) {
    assert.equal(matrix.status, 'frozen', 'no implementation before S0 freeze');
    const requested = process.argv.slice(index + 1);
    assert.ok(requested.length > 0, 'implementation requires scope ids');
    for (const id of requested) {
      const row = matrix.requirements.find(row => row.id === id);
      assert.equal(row?.state, 'GAP', `implementation requires an evidence-backed GAP: ${id}`);
      assert.ok(row.evidence.some(key => evidence.some(proof => proof.id === key && proof.requirementIds?.includes(id)
        && proof.baseline && proof.command && (proof.kind === 'source-audit' || proof.result?.failed > 0))),
      `implementation requires mapped counterevidence: ${id}`);
    }
  }
  console.log(JSON.stringify({ matrixVersion: matrix.matrixVersion, status: matrix.status, ...result }));
}
