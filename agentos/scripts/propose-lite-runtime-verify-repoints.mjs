/**
 * Proposes, for every RUNTIME-VERIFY row the batch ledger could not evidence, the test file and
 * assertion that actually appears to cover the clause - searched over EVERY test file in the
 * repository, not only the 27 the batch set ran.
 *
 * This is a REVIEW AID. It proposes; it never re-points the matrix and never promotes a row. Each
 * proposal carries the source name, its file, the shared tokens, and whether the file is already
 * covered by a batch receipt, so a reviewer can decide quickly.
 *
 * Usage (from the project root):
 *   node scripts/propose-lite-runtime-verify-repoints.mjs \
 *     --ledger <runtime-verify-ledger.json> --out-json <path> --out-md <path>
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    if (!value || value.startsWith('--')) throw new Error('missing value for --' + key);
    result[key] = value;
    index += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = resolve(args['repo-root'] ?? '.');
const ledger = JSON.parse(readFileSync(resolve(repoRoot, args.ledger), 'utf8'));

const STOPWORDS = new Set(['that', 'with', 'from', 'this', 'than', 'then', 'they', 'them', 'their',
  'there', 'when', 'which', 'while', 'where', 'have', 'has', 'had', 'does', 'must', 'only', 'also',
  'into', 'onto', 'before', 'after', 'under', 'over', 'each', 'every', 'same', 'left', 'right',
  'still', 'well', 'without', 'remain', 'remains', 'stays', 'stay', 'using', 'used', 'uses', 'true',
  'false', 'null', 'undefined', 'test', 'tests']);
function tokensIn(text) {
  return [...new Set(String(text ?? '').toLowerCase().match(/[a-z0-9_-]{4,}/gu) ?? [])]
    .filter(token => !STOPWORDS.has(token));
}

/** Every test/it name in the repository, with the file it lives in. */
function indexRepositoryTests() {
  const files = execFileSync('git', ['ls-files', '*.test.ts', '*.test.tsx'],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/u).filter(Boolean);
  const index = [];
  for (const file of files) {
    const source = readFileSync(resolve(repoRoot, file), 'utf8');
    for (const match of source.matchAll(/^\s*(?:test|it)(?:\.\w+)?\(\s*(?:'([^']{10,300})'|"([^"]{10,300})"|`([^`]{10,300})`)/gmu)) {
      const name = (match[1] ?? match[2] ?? match[3]).trim();
      index.push({ file, name });
    }
  }
  return index;
}

const index = indexRepositoryTests();
const batchFiles = new Set(ledger.rows.map(row => row.namedTestFile).filter(Boolean));
const unevidenced = ledger.rows.filter(row => row.verdict !== 'candidate-supported');

/**
 * A proposal is accepted only for a strong signal: one distinctive token (6+ characters) shared
 * with the test name, or two independent shorter tokens. Weaker overlaps are dropped rather than
 * shown, because a noisy suggestion list is worse than none.
 */
function score(name, clauseTokens) {
  const nameTokens = new Set(tokensIn(name));
  const shared = clauseTokens.filter(token => nameTokens.has(token));
  const long = shared.filter(token => token.length >= 6);
  if (long.length >= 1) return { decisive: true, score: long.length * 2 + shared.length };
  if (shared.length >= 2) return { decisive: true, score: shared.length };
  return { decisive: false, score: 0, shared: [] };
}

const proposals = unevidenced.map(row => {
  const clauseTokens = tokensIn([row.requirement, row.section, row.document, row.requirement].join(' '));
  const scored = index
    .map(entry => ({ entry, ...score(entry.name, clauseTokens) }))
    .filter(item => item.decisive)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5)
    .map(item => ({ file: item.entry.file, name: item.entry.name,
      sharedTokens: item.sharedTokens ?? clauseTokens.filter(token => tokensIn(item.entry.name).includes(token)),
      score: item.score, alreadyInBatchSet: batchFiles.has(item.entry.file) }));
  return {
    id: row.id,
    requirement: row.requirement,
    currentNamedFile: row.namedTestFile,
    currentFileStatus: row.fileStatus,
    executedAssertionsInNamedFile: row.executedAssertions,
    proposals: scored,
    disposition: scored.length === 0 ? 'no-proposal' : scored[0].alreadyInBatchSet ? 'propose-repoint-in-batch' : 'propose-repoint-out-of-batch',
  };
});

const counts = {};
for (const proposal of proposals) counts[proposal.disposition] = (counts[proposal.disposition] ?? 0) + 1;

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidencePackage: 'S8-runtime-verify-repoint-proposals',
  ledgerPath: args.ledger,
  batchesBaseline: ledger.batchesBaseline,
  summary: { unevidencedRows: unevidenced.length, repositoryTestNames: index.length, dispositions: counts },
  proposals,
  boundary: {
    matrixEdited: false,
    passPromoted: false,
    note: 'Proposals only. Each one must be reviewed against the clause before any tests pointer is changed.',
  },
};
const outJson = resolve(repoRoot, args['out-json']);
mkdirSync(dirname(outJson), { recursive: true });
writeFileSync(outJson, JSON.stringify(report, null, 2) + LF, 'utf8');

const lines = [];
lines.push('# S8 RUNTIME-VERIFY 改指提案');
lines.push('');
lines.push('针对账本中未能取证的 **' + String(unevidenced.length) + ' 行**，在**全仓 ' + String(index.length) + ' 条测试名**里搜索真正覆盖该条款的断言。');
lines.push('');
lines.push('**这是复核线索，不是判定，也不是改指。** 本文件不修改矩阵、不提升任何行；每条提案都必须先与条款逐字核对，才能考虑改动 `tests` 指针。');
lines.push('');
lines.push('- 账本：' + md(args.ledger) + '（基线 ' + md(String(ledger.batchesBaseline)) + '）');
lines.push('- 提案分布：' + md(JSON.stringify(counts)));
lines.push('');
lines.push('| Requirement | 现点名文件（状态） | 建议覆盖文件 | 建议断言 | 在批次内 |');
lines.push('| --- | --- | --- | --- | --- |');
for (const proposal of proposals) {
  const best = proposal.proposals[0];
  lines.push('| ' + md(proposal.id) + ' | ' + md(String(proposal.currentNamedFile ?? '(未记录)') + ' (' + proposal.currentFileStatus + ')')
    + ' | ' + (best === undefined ? '—' : md(best.file))
    + ' | ' + (best === undefined ? '—' : best.name.slice(0, 80))
    + ' | ' + (best === undefined ? '—' : String(best.alreadyInBatchSet)) + ' |');
}
lines.push('');
const outMd = resolve(repoRoot, args['out-md']);
mkdirSync(dirname(outMd), { recursive: true });
writeFileSync(outMd, lines.join(LF) + LF, 'utf8');

process.stdout.write(JSON.stringify(report.summary) + LF);

