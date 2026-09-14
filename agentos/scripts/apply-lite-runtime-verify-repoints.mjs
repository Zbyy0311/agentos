/**
 * Applies the RUNTIME-VERIFY re-points produced by the triage, without changing any row state.
 *
 * While the PASS freeze is in force the scope verifier forbids a state change on every row whose
 * frozen state is not PASS, and requires that permanent identity fields (id, document, requirement,
 * line) stay byte-identical. So this script can and does only:
 *
 *   - replace a row's `tests` pointer with the file that actually carries a named, executed
 *     assertion for the clause (recorded per row with the previous pointer and the covering
 *     assertion id);
 *   - append the evidence-gap reason to a row whose clause has no executed assertion;
 *   - bump the matrix version and record one change entry describing both actions.
 *
 * It refuses to write a PASS and it never changes a state.
 *
 * Usage (from the project root):
 *   node scripts/apply-lite-runtime-verify-repoints.mjs \
 *     --triage <triage-summary.json> [--apply] [--record <path>]
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LF = String.fromCharCode(10);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) { result[key] = true; continue; }
    result[key] = value;
    index += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(args['repo-root'] ?? '.');
const matrixPath = resolve(repoRoot, args['matrix'] ?? 'docs/implementation/lite-closeout/matrix.json');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const triage = JSON.parse(readFileSync(resolve(repoRoot, args.triage), 'utf8'));

/**
 * A triage verdict may cite a merged evidence pack rather than a test file. The matrix tests field
 * must name existing files, so pack-based coverage is mapped to the test file whose executed
 * receipt carries the assertion the pack was built from.
 */
const PACK_TO_TEST_FILE = {
  'docs/implementation/lite-closeout/S8-four-row-candidate-evidence.json': [
    'apps/server/src/routes/canonicalRunStream.test.ts',
    'apps/server/src/services/m3-p6-integrated-verification.test.ts',
  ],
  'docs/implementation/lite-closeout/S2S3-live-candidate-evidence.json': [
    'apps/server/src/services/run-engine/CanonicalArtifactResult.liveGate.test.ts',
    'apps/server/src/services/run-engine/RuntimeApprovalGate.liveGate.test.ts',
  ],
};

function resolveTests(judgment) {
  const candidates = [];
  const add = value => { if (typeof value === 'string') candidates.push(value); };
  add(judgment.coveringFile);
  for (const supportive of judgment.supportiveAssertions ?? []) add(supportive.file);
  const resolved = [];
  for (const candidate of candidates) {
    for (const file of (PACK_TO_TEST_FILE[candidate] ?? [candidate])) {
      const isTest = file.endsWith('.test.ts') || file.endsWith('.test.tsx') || file.endsWith('.test.mjs');
      if (!isTest || !existsSync(resolve(repoRoot, file))) continue;
      if (!resolved.includes(file)) resolved.push(file);
    }
  }
  return resolved;
}

const rows = new Map(matrix.requirements.map(row => [row.id, row]));
const repoints = [];
const gaps = [];
const skipped = [];
for (const judgment of triage.accepted) {
  const row = rows.get(judgment.id);
  if (row === undefined) { skipped.push({ id: judgment.id, why: 'row-not-found' }); continue; }
  if (row.state !== 'RUNTIME-VERIFY') { skipped.push({ id: judgment.id, why: 'state-is-' + row.state }); continue; }
  const tests = resolveTests(judgment);
  if (tests.length === 0) { skipped.push({ id: judgment.id, why: 'no-existing-test-file' }); continue; }
  repoints.push({ id: judgment.id, previousTests: [...row.tests], tests,
    coveringAssertion: judgment.coveringAssertion, batch: judgment.batch, limits: judgment.limits ?? null });
}
for (const judgment of triage.rejected) {
  const row = rows.get(judgment.id);
  if (row === undefined) { skipped.push({ id: judgment.id, why: 'row-not-found' }); continue; }
  if (row.state !== 'RUNTIME-VERIFY') { skipped.push({ id: judgment.id, why: 'state-is-' + row.state }); continue; }
  gaps.push({ id: judgment.id, reason: judgment.rationale, batch: judgment.batch,
    partialCoverage: judgment.partialCoverage ?? null });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidencePackage: 'LITE-runtime-verify-repoints',
  matrixVersionBefore: matrix.matrixVersion,
  matrixVersionAfter: matrix.matrixVersion + 1,
  summary: { repointed: repoints.length, gapsRecorded: gaps.length, skipped: skipped.length },
  repoints,
  gaps,
  skipped,
  boundary: { statesUnchanged: true, passUntouched: true },
};

if (args.apply === true) {
  copyFileSync(matrixPath, matrixPath + '.v' + String(matrix.matrixVersion) + '.bak');
  const version = report.matrixVersionAfter;
  for (const repoint of repoints) {
    const row = rows.get(repoint.id);
    row.tests = repoint.tests;
    const previous = repoint.previousTests.length === 0 ? '(none)' : repoint.previousTests.join(', ');
    row.finding = '[matrix v' + String(version) + ' re-point] previous tests: ' + previous
      + '; verified covering assertion: ' + String(repoint.coveringAssertion)
      + ' (triage ' + repoint.batch + '). Historical finding: ' + row.finding;
  }
  for (const gap of gaps) {
    const row = rows.get(gap.id);
    row.finding = '[matrix v' + String(version)
      + ' triage] no executed assertion covers this clause yet: ' + gap.reason
      + ' (triage ' + gap.batch + '). Historical finding: ' + row.finding;
  }
  matrix.matrixVersion = version;
  matrix.changes = [...matrix.changes, {
    version,
    baseline: matrix.baseline,
    authority: 'User-approved tightened Lite closeout plan: S0 is the only scope referee; re-pointing tests is not a promotion',
    reason: 'Adopt the assertion-level ledger and its source-level triage: ' + String(repoints.length)
      + ' rows are re-pointed to the test file that carries a named, executed covering assertion, and '
      + String(gaps.length) + ' rows record the specific assertion their clause still lacks.'
      + ' No state changed and no PASS was written (PASS remains 0).',
    requirementIds: [...repoints.map(item => item.id), ...gaps.map(item => item.id)],
  }];
  writeFileSync(matrixPath, JSON.stringify(matrix, null, 2) + LF, 'utf8');
}

if (args.record !== undefined) writeFileSync(resolve(repoRoot, args.record), JSON.stringify(report, null, 2) + LF, 'utf8');
process.stdout.write(JSON.stringify(report.summary) + LF);


