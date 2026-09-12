import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const auditRoot = resolve(root, 'docs/implementation/lite-closeout');
const states = new Set(['PASS', 'GAP', 'RUNTIME-VERIFY', 'DEFERRED']);
const digest = text => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
// S0 v1 identity anchor; changing it requires a separately reviewed scope amendment.
const scopeLockHash = '140848da717c448daae0a6ddd44413c8d808eab70464bd0d482946f5f3f27aba';

export function validateScope(matrix, evidence, lock, repositoryRoot = root) {
  assert.equal(digest(JSON.stringify(lock, null, 2) + '\n'), scopeLockHash, 'permanent scope lock changed');
  assert.equal(matrix.schemaVersion, 1);
  assert.ok(['draft', 'frozen'].includes(matrix.status), 'invalid matrix status');
  assert.match(matrix.baseline, /^[a-f0-9]{40}$/);
  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  assert.equal(evidenceById.size, evidence.length, 'duplicate evidence id');
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
    assert.match(row.id, /^LITE-\d{2}-\d{3}$/);
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
    for (const id of row.evidence) assert.ok(evidenceById.has(id), `unknown evidence ${row.id}: ${id}`);
    if (row.state === 'PASS') {
      assert.ok(row.evidence.length > 0, `PASS without evidence ${row.id}`);
      for (const id of row.evidence) {
        const proof = evidenceById.get(id);
        assert.ok(proof.baseline && proof.command && proof.limitation, `incomplete evidence ${id}`);
        assert.equal(proof.result.failed, 0, `failed evidence used for PASS: ${id}`);
        assert.equal(proof.baseline, row.evidenceBaseline ?? matrix.baseline, `wrong evidence baseline: ${id}`);
        assert.ok(proof.requirementIds?.includes(row.id), `evidence is not mapped to requirement: ${row.id}`);
        if (proof.kind === 'local-tests') {
          assert.ok(Number.isSafeInteger(proof.result.passed) && proof.result.passed > 0, `no executed passing tests: ${id}`);
          assert.equal(proof.result.skipped, 0, `skipped evidence used for PASS: ${id}`);
        } else {
          assert.ok(proof.kind === 'github-actions' && proof.result.conclusion === 'success' && proof.url, `unverified PASS evidence: ${id}`);
        }
      }
    }
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
  return Object.fromEntries([...states].map(state => [state, matrix.requirements.filter(row => row.state === state).length]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matrix = readJson(resolve(auditRoot, 'matrix.json'));
  const result = validateScope(matrix, readJson(resolve(auditRoot, 'evidence.json')), readJson(resolve(auditRoot, 'scope-lock.json')));
  if (process.argv.includes('--require-closed')) {
    assert.equal(matrix.status, 'frozen', 'S0 is not frozen');
    assert.equal(result.GAP + result['RUNTIME-VERIFY'], 0, 'required Lite acceptance remains open');
    assert.ok(matrix.finalMainSha && matrix.finalCiEvidence, 'final merged-main SHA and CI evidence are required');
    const finalProof = readJson(resolve(auditRoot, 'evidence.json')).find(item => item.id === matrix.finalCiEvidence);
    assert.ok(finalProof?.kind === 'github-actions' && finalProof.baseline === matrix.finalMainSha
      && finalProof.result.conclusion === 'success', 'final main CI is not verified');
  }
  const index = process.argv.indexOf('--implement');
  if (index >= 0) {
    assert.equal(matrix.status, 'frozen', 'no implementation before S0 freeze');
    const requested = process.argv.slice(index + 1);
    assert.ok(requested.length > 0, 'implementation requires scope ids');
    const evidence = readJson(resolve(auditRoot, 'evidence.json'));
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
