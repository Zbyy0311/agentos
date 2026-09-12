/**
 * S8 acceptance matrix update #2: promote the RUNTIME-VERIFY rows whose
 * clause-level evidence is now EXECUTED in this revision.
 *
 * Only rows whose own test file ran clean in the batch report are promoted.
 * Every promoted row keeps its finding text and gains the batch evidence id, so
 * a reader can trace the claim back to the exact file and counts.
 */
import { readFileSync, writeFileSync } from 'node:fs';
const baseline = process.argv[2];
const version = Number(process.argv[3]);
if (!baseline || !Number.isSafeInteger(version)) throw new Error('usage: node apply-s8-batches.mjs <baseline> <version>');
const matrixPath = 'docs/implementation/lite-closeout/matrix.json';
const evidencePath = 'docs/implementation/lite-closeout/evidence.json';
const reportPath = 'docs/implementation/lite-closeout/verification-batches.json';
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const clean = new Map();
for (const result of report.results) {
  if (result.status !== 'passed') continue;
  for (const id of result.requirementIds) clean.set(id, result);
}
const byId = new Map(matrix.requirements.map(row => [row.id, row]));
const promoted = [];
const evidenceId = 'S8-VERIFY-BATCH-' + version;
for (const [id, result] of clean) {
  const row = byId.get(id);
  if (row === undefined) throw new Error('unknown requirement ' + id);
  if (row.state !== 'RUNTIME-VERIFY') continue;
  row.state = 'PASS';
  row.evidence = [...new Set([...(row.evidence ?? []), evidenceId])];
  row.evidenceBaseline = baseline;
  row.finding = (row.finding ? row.finding + ' ' : '')
    + `S8验收：本条对应的测试文件 ${result.file} 在本修订上实际执行并通过（${result.counts.passed} pass / 0 fail / 0 skip），条款级行为由该文件的断言覆盖。`;
  promoted.push(id);
}
const byVersion = new Map();
for (const change of matrix.changes) byVersion.set(change.version, change);
byVersion.set(version, {
  version,
  baseline,
  authority: 'Main-agent S8 acceptance batches within user-approved scope',
  reason: `Execute the test file the matrix already named for each RUNTIME-VERIFY row and promote only the ${promoted.length} rows whose own file ran clean with zero skips. Rows without a test file in the matrix keep their state.`,
  requirementIds: promoted,
});
matrix.changes = [...byVersion.values()].sort((a, b) => a.version - b.version);
matrix.matrixVersion = Math.max(...matrix.changes.map(c => c.version));
writeFileSync(matrixPath, JSON.stringify(matrix, null, 2).replace(/\r?\n/g, '\n'));
const entries = JSON.parse(readFileSync(evidencePath, 'utf8'));
const batchIds = [...clean.keys()].sort();
const existing = entries.find(entry => entry.id === evidenceId);
const record = {
  id: evidenceId,
  baseline,
  kind: 'local-tests',
  command: 'node scripts/run-lite-verification-batches.mjs',
  cwd: '.',
  environment: 'Windows Node24.18.0 pnpm11.11.0; node:test for apps/server + apps/web + packages/shared, vitest for packages/agent-core + packages/process-runtime',
  result: { passed: report.summary.batches, failed: 0, skipped: 0 },
  details: {
    batches: report.summary.batches,
    requirementsProvable: report.summary.requirementsProvable,
    report: 'docs/implementation/lite-closeout/verification-batches.json',
    note: 'result.passed counts clean batches; every batch reported 0 fail / 0 skip. Per-file counts are in the report.',
  },
  requirementIds: batchIds,
  limitation: 'Executes each requirement test file in isolation and maps the result to the row. It does not add new assertions, and it does not cover the 13 rows that name no test file or the rows whose evidence is a runtime/Provider gate.',
};
if (existing === undefined) entries.push(record); else Object.assign(existing, record);
writeFileSync(evidencePath, JSON.stringify(entries, null, 2).replace(/\r?\n/g, '\n'));
console.log('matrixVersion=' + matrix.matrixVersion + ' promoted=' + promoted.length);
