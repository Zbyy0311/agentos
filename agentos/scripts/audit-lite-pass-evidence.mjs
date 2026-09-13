import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = 'docs/implementation/lite-closeout/';
const baseline = '3ac02ceb54b701e3143c9ffdda7b782aac396ace';
const fromBaseline = file => execFileSync('git', ['show', `${baseline}:agentos/${dir}${file}`], { cwd: root, encoding: 'utf8' });
const original = fromBaseline('matrix.json');
const matrix = JSON.parse(original);
const evidence = JSON.parse(fromBaseline('evidence.json'));
const passRows = matrix.requirements.filter(row => row.state === 'PASS');
const write = (name, data) => writeFileSync(new URL('../' + dir + name, import.meta.url), JSON.stringify(data, null, 2) + '\n');
const defects = {
  'S0-V01': ['No preserved raw exit code or complete output tied to this invocation; file-level mapping is not an assertion map.'],
  'S0-V02': ['No preserved raw exit code or complete output tied to this invocation; file-level mapping is not an assertion map.'],
  'S0-V03': ['No preserved raw exit code or complete output tied to this invocation; file-level mapping is not an assertion map.'],
  'S8-PROVIDER-CONTRACT-SUITE': ['171/0/0 is a declared suite count without raw output/exit provenance; named adapter files do not identify executed assertions for the full clause.'],
  'S8-VERIFY-BATCH-10': ['result.passed=16 counts batches, not tests.', 'run-lite-verification-batches.mjs ignores spawn status/error/signal in its verdict.', 'apply-s8-acceptance.mjs coversClause accepts two source keywords, or defaults to true; neither proves assertions.', 'The mutable report on audited main has 26 batches and zero mapped requirements, while this record claims 16 batches and 178 provable requirements.'],
  'S8-VERIFY-BATCH-11': ['Command includes non-executable <re-pointed files> placeholder.', 'Declared passed=254 disagrees with executedFiles sum=275.', 'apply-s8-repoint.mjs contains hard-coded per-file results; no raw exit evidence or assertion mapping is preserved.'],
  'S8-E2E-RUN2': ['details.harnessExitCode=1 conflicts with result.failed=0.', 'verify-lite-s8-gates.ps1 permits three named external gate failures.', 'Referenced S8-run2-e2e.log is not tracked at audited main; a wrapper over an old log does not establish the invocation baseline.', 'Requirement prose is not a source assertion plus executed-result mapping.'],
};
const proofs = [...new Set(passRows.flatMap(row => row.evidence))].map(id => {
  const proof = evidence.find(item => item.id === id);
  if (!defects[id]) throw new Error('Unreviewed proof: ' + id);
  const commitExists = spawnSync('git', ['cat-file', '-e', proof.baseline + '^{commit}'], { cwd: root }).status === 0;
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', proof.baseline, baseline], { cwd: root }).status === 0;
  return {
    id, originalEvidence: proof,
    checks: {
      baselineSha: { value: proof.baseline, commitExists, ancestorOfAuditedMain: ancestor, invocationBound: false },
      command: { value: proof.command, cwd: proof.cwd, reproducibleLiteral: !proof.command.includes('<re-pointed files>'), rawInvocationRecord: false },
      rawExitCode: { value: proof.details?.harnessExitCode ?? null, preserved: proof.details?.harnessExitCode !== undefined, source: proof.details?.harnessExitCode !== undefined ? 'historical declaration, not raw process receipt' : 'missing' },
      actualCounts: { declared: proof.result, independentlyVerifiable: false, ...(proof.details?.executedFiles ? { declaredFileSum: Object.values(proof.details.executedFiles).reduce((a, b) => a + b, 0) } : {}) },
      assertionCoverage: { verified: false, reason: 'No immutable per-requirement mapping to specific executed test assertions and their outcomes.' },
    },
    issues: defects[id], eligibleForPass: false,
  };
});
const byId = new Map(proofs.map(proof => [proof.id, proof]));
const report = {
  schemaVersion: 1, auditedMainSha: baseline, matrixVersion: matrix.matrixVersion,
  originalMatrixSha256: createHash('sha256').update(original).digest('hex'),
  summary: { auditedPassRows: passRows.length, retainedPassRows: 0, downgradedRows: passRows.length, evidenceRecords: proofs.length },
  proofs,
  rows: passRows.map(row => ({ id: row.id, requirement: row.requirement, before: 'PASS', after: 'RUNTIME-VERIFY', evidenceIds: row.evidence, checks: row.evidence.map(id => ({ evidenceId: id, ...byId.get(id).checks })), reason: row.evidence.flatMap(id => byId.get(id).issues) })),
};
const freeze = { schemaVersion: 1, baseline, matrixVersion: matrix.matrixVersion, rows: matrix.requirements.map(({ id, state }) => ({ id, state })), frozenPassIds: passRows.map(row => row.id), allowedPassIds: [] };
if (process.argv.includes('--apply')) {
  const current = JSON.parse(readFileSync(new URL('../' + dir + 'matrix.json', import.meta.url), 'utf8'));
  if (current.matrixVersion !== 14) throw new Error('Refusing to overwrite a revised matrix; audit baseline is v14.');
  write('pass-freeze.json', freeze);
  write('pass-evidence-audit.json', report);
  for (const row of passRows) {
    row.state = 'RUNTIME-VERIFY';
    row.finding = 'Evidence integrity audit: previous PASS withdrawn; see pass-evidence-audit.json row ' + row.id + '. Historical finding (not current acceptance): ' + row.finding;
  }
  matrix.matrixVersion = 15;
  matrix.passFreeze = 'pass-freeze.json';
  delete matrix.finalMainSha;
  delete matrix.finalCiEvidence;
  matrix.changes.push({ version: 15, baseline, authority: 'User instruction 2026-09-13: freeze PASS and audit five-part evidence integrity', reason: 'Withdraw all 196 unsupported PASS claims; preserve historical evidence, scope identities, 26 GAP and 164 DEFERRED. New PASS and re-promotion are frozen.', requirementIds: passRows.map(row => row.id) });
  write('matrix.json', matrix);
}
console.log(JSON.stringify(report.summary));
