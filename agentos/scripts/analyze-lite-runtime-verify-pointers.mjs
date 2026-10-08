/**
 * Pointer-load analysis: how many clauses each named test file is asked to carry versus how many
 * assertions it actually executes.
 *
 * A file with more assigned clauses than executed assertions cannot carry an individually
 * justified assertion for each of them. That is a mechanical statement about the pointer, not a
 * judgment about coverage, and it is exactly the defect class the withdrawn-PASS audit named
 * ('the originally named file does not cover the clause').
 *
 * Usage (from the project root):
 *   node scripts/analyze-lite-runtime-verify-pointers.mjs --ledger <json> \
 *     --out-json <path> --out-md <path>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const LF = String.fromCharCode(10);
const B = String.fromCharCode(96);
const md = value => B + value + B;

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
const ledger = JSON.parse(readFileSync(resolve(repoRoot, args.ledger), 'utf8'));

const groups = new Map();
for (const row of ledger.rows) {
  const key = row.namedTestFile ?? '(no runnable test file named)';
  const group = groups.get(key) ?? { file: key, rows: [], asserted: 0, fileStatus: row.fileStatus };
  group.rows.push({ id: row.id, requirement: row.requirement, verdict: row.verdict,
    matchingAssertions: row.matchingAssertions.length });
  group.asserted = Math.max(group.asserted, row.executedAssertions);
  groups.set(key, group);
}

const analysis = [...groups.values()].map(group => ({
  file: group.file,
  assignedClauses: group.rows.length,
  executedAssertions: group.asserted,
  fileRawExit: group.rows.length === 0 ? null : undefined,
  fileStatus: group.fileStatus,
  individuallyJustifiable: group.rows.length <= group.asserted,
  unsupportedByCount: Math.max(0, group.rows.length - group.asserted),
  clauses: group.rows,
})).sort((left, right) => right.unsupportedByCount - left.unsupportedByCount
  || right.assignedClauses - left.assignedClauses);

const overAssigned = analysis.filter(item => !item.individuallyJustifiable);
const summary = {
  files: analysis.length,
  clauses: ledger.rows.length,
  clausesInCorrectlySizedPointers: analysis.filter(item => item.individuallyJustifiable)
    .reduce((total, item) => total + item.assignedClauses, 0),
  clausesInOverAssignedPointers: overAssigned.reduce((total, item) => total + item.assignedClauses, 0),
  overAssignedFiles: overAssigned.length,
};

const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  evidencePackage: 'S8-runtime-verify-pointer-load', ledgerPath: args.ledger,
  batchesBaseline: ledger.batchesBaseline, summary, analysis };
mkdirSync(dirname(resolve(repoRoot, args['out-json'])), { recursive: true });
writeFileSync(resolve(repoRoot, args['out-json']), JSON.stringify(report, null, 2) + LF, 'utf8');

const lines = [];
lines.push('# RUNTIME-VERIFY 指针载荷分析');
lines.push('');
lines.push('一个被点名的测试文件如果承担了**多于自身已执行断言数**的条款，就不可能为每一条条款提供一条可单独举证的断言。这是关于**指针**的机械陈述，不是覆盖度判断，而它正是撤回 PASS 时记录的那一类缺陷（*原矩阵点名文件未覆盖该条款*）。');
lines.push('');
lines.push('- 账本：' + md(args.ledger) + '（基线 ' + md(String(ledger.batchesBaseline)) + '）');
lines.push('- 汇总：' + md(JSON.stringify(summary)));
lines.push('');
lines.push('| 点名文件 | 承担条款 | 已执行断言 | 状态 | 超额条款 |');
lines.push('| --- | ---: | ---: | --- | ---: |');
for (const item of analysis) {
  lines.push('| ' + md(item.file) + ' | ' + String(item.assignedClauses) + ' | ' + String(item.executedAssertions)
    + ' | ' + md(item.fileStatus) + ' | ' + String(item.unsupportedByCount) + ' |');
}
lines.push('');
lines.push('## 超额承担的文件及其条款');
lines.push('');
for (const item of overAssigned) {
  lines.push('### ' + md(item.file) + '（' + String(item.assignedClauses) + ' 条款 / ' + String(item.executedAssertions) + ' 断言）');
  lines.push('');
  for (const clause of item.clauses) {
    lines.push('- ' + md(clause.id) + ' ' + clause.requirement + '（' + clause.verdict + '，命中 ' + String(clause.matchingAssertions) + '）');
  }
  lines.push('');
}
mkdirSync(dirname(resolve(repoRoot, args['out-md'])), { recursive: true });
writeFileSync(resolve(repoRoot, args['out-md']), lines.join(LF) + LF, 'utf8');

process.stdout.write(JSON.stringify(summary) + LF);

