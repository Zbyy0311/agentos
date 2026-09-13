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

export function validateFrozenScopeStates(matrix, freeze) {
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
      if (row.state === 'PASS') assert.ok(allowedPassIds.has(row.id), `PASS state is frozen and not allowed: ${row.id}`);
    } else {
      assert.equal(row.state, before, `original ${before} state changed: ${row.id}`);
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

export function validateScope(matrix, evidence, lock, repositoryRoot = root, passFreeze = undefined) {
  assert.equal(digest(JSON.stringify(lock, null, 2) + '\n'), scopeLockHash, 'permanent scope lock changed');
  assert.equal(matrix.schemaVersion, 1);
  assert.ok(['draft', 'frozen'].includes(matrix.status), 'invalid matrix status');
  assert.match(matrix.baseline, sha40);
  const evidenceMap = evidenceById(evidence);
  const lockedById = new Map(lock.map(item => [item.id, item]));
  assert.equal(lockedById.size, lock.length, 'duplicate locked id');
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
      assert.equal(lockedById.get(row.id)?.initialState, 'DEFERRED', `new deferral requires an explicit scope amendment: ${row.id}`);
      assert.ok(row.line !== null && row.finding && row.exit, `DEFERRED requires normative source: ${row.id}`);
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
  validateFrozenScopeStates(matrix, freeze);
  for (const row of matrix.requirements) {
    if (row.state !== 'PASS') continue;
    assert.ok(freeze.allowedPassIds.includes(row.id), `PASS state is frozen and not allowed: ${row.id}`);
    assert.ok(row.evidence.length > 0, `PASS without evidence ${row.id}`);
    for (const id of row.evidence) validatePassEvidence(row, evidenceMap.get(id), matrix, repositoryRoot);
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
