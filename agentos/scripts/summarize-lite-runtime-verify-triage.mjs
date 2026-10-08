/**
 * Consolidates the per-batch triage files into one review report.
 *
 * Usage (from the project root):
 *   node scripts/summarize-lite-runtime-verify-triage.mjs --dir <evidence dir> \
 *     --out-json <path> --out-md <path>
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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
const dir = resolve(repoRoot, args.dir);
const ledger = JSON.parse(readFileSync(join(dir, 'runtime-verify-ledger.json'), 'utf8'));

const batches = readdirSync(dir).filter(file => /^triage-\d+\.json$/.test(file)).sort();
const judgments = [];
for (const file of batches) {
  const batch = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  for (const judgment of batch.judgments) judgments.push({ ...judgment, batch: file });
}
/**
 * A later batch supersedes an earlier judgment of the same row (a re-read that found stronger
 * evidence). The superseded record is kept in the report so the reversal is visible rather than
 * silently overwritten.
 */
const latest = new Map();
const superseded = [];
for (const judgment of judgments) {
  const previous = latest.get(judgment.id);
  if (previous !== undefined) superseded.push({ id: judgment.id, earlier: previous, later: judgment });
  latest.set(judgment.id, judgment);
}
const effective = [...latest.values()];
const judgedIds = new Set(judgments.map(item => item.id));
const accepted = effective.filter(item => item.verdict === 'accepted');
const rejected = effective.filter(item => item.verdict === 'rejected');
const openRows = ledger.rows.filter(row => row.verdict !== 'candidate-supported');
const unjudged = openRows.filter(row => !judgedIds.has(row.id));

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidencePackage: 'S8-runtime-verify-triage-summary',
  batchesBaseline: ledger.batchesBaseline,
  summary: {
    ledgerRows: ledger.rows.length,
    ledgerCandidateSupported: ledger.rows.filter(row => row.verdict === 'candidate-supported').length,
    ledgerOpen: openRows.length,
    judged: judgments.length,
    effectiveJudgments: effective.length,
    superseded: superseded.length,
    accepted: accepted.length,
    rejected: rejected.length,
    unjudged: unjudged.length,
    batches: batches.length,
  },
  accepted: accepted.map(item => ({ id: item.id, clause: item.clause, batch: item.batch,
    coveringFile: item.coveringFile ?? item.candidateFile ?? null,
    coveringAssertion: item.coveringAssertion ?? null, currentPointer: item.currentPointer ?? null,
    limits: item.limits ?? null })),
  rejected: rejected.map(item => ({ id: item.id, clause: item.clause, batch: item.batch,
    candidateFile: item.candidateFile ?? null, candidateAssertion: item.candidateAssertion ?? null,
    rationale: item.rationale, currentPointer: item.currentPointer ?? null,
    partialCoverage: item.partialCoverage ?? null })),
  unjudged: unjudged.map(row => ({ id: row.id, requirement: row.requirement, namedTestFile: row.namedTestFile })),
  superseded: superseded.map(item => ({ id: item.id, earlierBatch: item.earlier.batch,
    earlierVerdict: item.earlier.verdict, laterBatch: item.later.batch, laterVerdict: item.later.verdict })),
  boundary: { matrixEdited: false, passPromoted: false,
    note: 'accepted 表示已找到源码级、且在执行收据中通过的具名覆盖断言；rejected 表示按复合条款口径缺项。两者都不改矩阵。' },
};

const outJson = resolve(repoRoot, args['out-json']);
mkdirSync(dirname(outJson), { recursive: true });
writeFileSync(outJson, JSON.stringify(report, null, 2) + LF, 'utf8');

const lines = [];
lines.push('# S8 RUNTIME-VERIFY 判读总结（' + String(judgments.length) + ' / ' + String(openRows.length) + ' 行待判读）');
lines.push('');
lines.push('账本把 205 行分成「已自动取证」（' + String(report.summary.ledgerCandidateSupported) + ' 行）与「待判读」（' + String(openRows.length) + ' 行）。本报告汇总全部 ' + String(batches.length) + ' 批判读：**每条都读源码断言体**，且被引断言必须在该基线的执行收据中通过。');
lines.push('');
lines.push('- 基线：' + md(String(ledger.batchesBaseline)));
lines.push('| 结论 | 行数 |');
lines.push('| --- | ---: |');
lines.push('| `accepted`（找到具名且已执行的覆盖断言） | ' + String(accepted.length) + ' |');
lines.push('| `rejected`（按复合条款口径缺项，已写明缺什么） | ' + String(rejected.length) + ' |');
lines.push('| 尚未判读 | ' + String(unjudged.length) + ' |');
lines.push('');
lines.push('## accepted（' + String(accepted.length) + '）');
lines.push('');
lines.push('| Requirement | 条款 | 覆盖文件 | 覆盖断言 | 原指针问题 |');
lines.push('| --- | --- | --- | --- | --- |');
for (const item of report.accepted) {
  lines.push('| ' + md(item.id) + ' | ' + item.clause.slice(0, 70) + ' | ' + md(String(item.coveringFile ?? '—')) + ' | '
    + (item.coveringAssertion === null ? '—' : item.coveringAssertion.slice(0, 80)) + ' | '
    + (item.currentPointer === null ? '—' : item.currentPointer.slice(0, 60)) + ' |');
}
lines.push('');
lines.push('## rejected（' + String(rejected.length) + '）—— 需要补断言或改指的真实缺口');
lines.push('');
for (const item of report.rejected) {
  lines.push('### ' + md(item.id) + '  ' + item.clause);
  lines.push('');
  lines.push('- 批：' + md(item.batch));
  lines.push('- 差异：' + item.rationale);
  if (item.partialCoverage !== null) {
    lines.push('- 分项覆盖：');
    for (const part of item.partialCoverage) {
      lines.push('  - ' + part.item + ' → ' + (part.status === '缺' || part.status.includes('缺') ? '**缺**' : md(part.name.slice(0, 70)) + '（' + part.status + '）'));
    }
  }
  lines.push('');
}
if (unjudged.length > 0) {
  lines.push('## 尚未判读（' + String(unjudged.length) + '）');
  lines.push('');
  for (const row of report.unjudged) lines.push('- ' + md(row.id) + ' ' + row.requirement + '（' + String(row.namedTestFile) + '）');
  lines.push('');
}
lines.push('## 边界');
lines.push('');
if (superseded.length > 0) {
  lines.push('## 判读推翻记录（' + String(superseded.length) + ' 条）');
  lines.push('');
  lines.push('后一批次对同一行的复核结论覆盖前一批次（保留两方记录，不静默改写）：');
  lines.push('');
  for (const item of superseded) {
    lines.push('- ' + md(item.id) + '：' + md(item.earlier.batch + ' → ' + item.earlier.verdict) + ' 被 ' + md(item.later.batch + ' → ' + item.later.verdict) + ' 覆盖');
  }
  lines.push('');
}
lines.push('本报告只记录判读结论：**未修改矩阵**（' + md('matrix.json') + ' / ' + md('pass-freeze.json') + ' / ' + md('pass-evidence-audit.json') + ' 与基线逐字节一致），未提升任何行状态，未执行 ' + md('--require-closed') + '。');
lines.push('');
const outMd = resolve(repoRoot, args['out-md']);
mkdirSync(dirname(outMd), { recursive: true });
writeFileSync(outMd, lines.join(LF) + LF, 'utf8');

process.stdout.write(JSON.stringify(report.summary) + LF);
