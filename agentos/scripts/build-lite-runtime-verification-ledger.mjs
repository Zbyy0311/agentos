/**
 * Builds the per-requirement verification ledger for the S0 RUNTIME-VERIFY rows.
 *
 * The withdrawn PASS audit found one defect behind every downgrade: 'No immutable
 * per-requirement mapping to specific executed test assertions and their outcomes.' This script
 * produces exactly that mapping, mechanically and reviewably, from the raw batch receipts:
 *
 *   row -> named test file -> the assertions that ACTUALLY ran in that file (names + outcomes)
 *       -> the ones that name the clause -> verdict
 *
 * Verdicts are candidate-supported / insufficient-evidence / failed. A clean file run is not
 * enough: a row is candidate-supported only when at least one executed assertion in its own
 * named file names the clause and passed. Rows the keyword pass cannot match stay
 * insufficient-evidence and are listed for manual triage - that is the honest signal, not a
 * zero.
 *
 * Usage (from the project root):
 *   node scripts/build-lite-runtime-verification-ledger.mjs \
 *     --batches <verification-batches.json> --out-json <path> --out-md <path>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const batchesPath = resolve(repoRoot, args.batches);
const outJson = resolve(repoRoot, args['out-json']);
const outMd = resolve(repoRoot, args['out-md']);
/**
 * Optional per-file receipts that carry fuller assertion names than the batch summary (for
 * example a verbose run of a package test file). The manifest maps a repo-relative test file to
 * a receipt base path; its stdout supplies additional executed assertions.
 */
const extraManifest = args['extra-assertions'] === undefined
  ? {}
  : JSON.parse(readFileSync(resolve(repoRoot, args['extra-assertions']), 'utf8'));
const batches = JSON.parse(readFileSync(batchesPath, 'utf8'));
const matrix = JSON.parse(readFileSync(resolve(repoRoot, 'docs/implementation/lite-closeout/matrix.json'), 'utf8'));

/** Node's test runner prints one line per executed test with its outcome glyph. */
function parseNodeAssertions(stdout) {
  const found = [];
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    const match = /^\s*(\u2714|\u2716|\u2796)\s+(.+?)\s+\((\d+(?:\.\d+)?)ms\)\s*$/u.exec(line);
    if (match === null) continue;
    found.push({
      name: match[2].trim(),
      outcome: match[1] === '\u2714' ? 'passed' : match[1] === '\u2716' ? 'failed' : 'skipped',
      source: 'node:test',
    });
  }
  return found;
}

/** Vitest prints its own glyphs; a skipped test carries no duration, so it is matched separately. */
function parseVitestAssertions(stdout) {
  const found = [];
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    const withDuration = /^\s*(\u2713|\u2717|\u00d7|\u2192)\s+(.+?)\s+(\d+)ms\s*$/u.exec(line);
    if (withDuration !== null) {
      found.push({
        name: withDuration[2].trim(),
        outcome: withDuration[1] === '\u2713' ? 'passed' : 'failed',
        source: 'vitest',
      });
      continue;
    }
    const bare = /^\s*(\u2713|\u2717|\u00d7)\s+(.+?)\s*$/u.exec(line);
    if (bare !== null && !/^\s*(Test Files|Tests|Duration|Start at)/iu.test(line)) {
      found.push({ name: bare[2].trim(), outcome: bare[1] === '\u2713' ? 'passed' : 'failed', source: 'vitest' });
    }
  }
  return found;
}

const STOPWORDS = new Set(['that', 'with', 'from', 'this', 'than', 'then', 'they', 'them', 'their', 'there',
  'when', 'which', 'while', 'where', 'have', 'has', 'had', 'does', 'must', 'only', 'also', 'into', 'onto',
  'before', 'after', 'under', 'over', 'each', 'every', 'same', 'left', 'right', 'still', 'well', 'without',
  'remain', 'remains', 'stays', 'stay', 'using', 'used', 'uses', 'true', 'false', 'null', 'undefined']);

function tokens(text) {
  return [...new Set(String(text ?? '').toLowerCase().match(/[a-z0-9_-]{4,}/gu) ?? [])]
    .filter(token => !STOPWORDS.has(token));
}

/**
 * Clause matching is deliberately conservative: an assertion must share a distinctive token with
 * the requirement text (a token of 6+ characters, or two independent 4-5 character tokens). A
 * single short generic word never counts.
 */
function matchScore(requirementTokens, assertionName) {
  const assertionTokens = new Set(tokens(assertionName));
  const shared = requirementTokens.filter(token => assertionTokens.has(token));
  const longShared = shared.filter(token => token.length >= 6);
  if (longShared.length >= 1) return { score: longShared.length + shared.length - longShared.length, shared, decisive: true };
  if (shared.length >= 2) return { score: shared.length, shared, decisive: true };
  return { score: 0, shared: [], decisive: false };
}

/** The batch receipt for one file, or undefined when the runner never produced one. */
const resultsByFile = new Map(batches.results.map(result => [result.file, result]));

const isTestFile = value => /\.test\.(ts|tsx|ps1|mjs)$/u.test(value) && !value.includes('progress');

/**
 * Every executed assertion the batch recorded, per file. Rows whose own named files do not cover
 * the clause are checked against this index so the ledger can name a file that does - a
 * recommendation for review, never an automatic re-point (the matrix stays untouched here).
 */
const allAssertions = [];
for (const result of batches.results) {
  const extraBase = extraManifest[result.file];
  const extra = extraBase === undefined
    ? []
    : [...parseNodeAssertions(readFileSync(resolve(repoRoot, extraBase + '.stdout.txt'), 'utf8')),
       ...parseVitestAssertions(readFileSync(resolve(repoRoot, extraBase + '.stdout.txt'), 'utf8'))];
  for (const assertion of [...parseNodeAssertions(result.stdout), ...parseVitestAssertions(result.stdout), ...extra]) {
    allAssertions.push({ ...assertion, file: result.file, fileStatus: result.status });
  }
}

/**
 * A row's verdict follows the assertion that actually covers it, not the whole file's tally:
 * an unrelated env-gated skip elsewhere in the same file does not make a passing assertion
 * unproven. What must hold is that the file's process exited 0 (so nothing failed to build or
 * crash), the matched assertion itself passed, and the coverage was found in a file the runner
 * actually executed. The file's own counts are still recorded on the row for a reader to see.
 */
function verdictFor(result, file, coverage, assertions) {
  if (file === undefined || result === undefined) return 'insufficient-evidence';
  if (['timeout', 'spawn-error', 'signaled'].includes(result.status)) return 'failed';
  if (['unsupported', 'missing-file'].includes(result.status)) return 'insufficient-evidence';
  if (assertions.length === 0 || coverage.length === 0) return 'insufficient-evidence';
  if (coverage.some(item => item.outcome === 'failed')) return 'failed';
  if (result.rawStatus !== 0) return 'failed';
  if (coverage.some(item => item.outcome !== 'passed')) return 'insufficient-evidence';
  return 'candidate-supported';
}

const rows = matrix.requirements.filter(row => row.state === 'RUNTIME-VERIFY').map(row => {
  // A row may name several files; the covering assertion can live in any of them, so every
  // named file that the batch actually ran is considered and the one that matched is recorded.
  const files = (row.tests ?? []).filter(isTestFile);
  const candidates = files.map(file => {
    const result = resultsByFile.get(file);
    const extraBase = extraManifest[file];
    const extraAssertions = extraBase === undefined
      ? []
      : [...parseNodeAssertions(readFileSync(resolve(repoRoot, extraBase + '.stdout.txt'), 'utf8')),
         ...parseVitestAssertions(readFileSync(resolve(repoRoot, extraBase + '.stdout.txt'), 'utf8'))];
    const assertions = [...(result === undefined ? [] : [...parseNodeAssertions(result.stdout), ...parseVitestAssertions(result.stdout)]),
      ...extraAssertions];
    return { file, result, assertions };
  });
  const primary = candidates.find(candidate => candidate.result !== undefined) ?? candidates[0];
  const file = primary?.file;
  const result = primary?.result;
  const assertions = primary?.assertions ?? [];
  /**
   * The S0 finding text records which assertion a previous audit identified as the one that
   * actually covers the clause, usually quoted. A quoted name of real length is a high-confidence
   * pointer, so it is matched exactly (substring) instead of by keyword overlap.
   */
  const quotedNames = [...String(row.finding ?? '').matchAll(/[\u201c"\u2018\u0060]([^\u201d"\u2019\u0060]{15,200})[\u201d"\u2019\u0060]/gu)]
    .map(match => match[1].trim()).filter(name => name.length >= 15);
  const requirementTokens = tokens([row.requirement, row.section, row.document].join(' '));
  /** Score every named file; the winning file is the one the ledger cites. */
  const scored = candidates.map(candidate => {
    const matched = candidate.assertions
      .map(assertion => ({ assertion, ...matchScore(requirementTokens, assertion.name) }))
      .filter(item => item.decisive)
      .sort((left, right) => right.score - left.score);
    return { ...candidate, matched };
  });
  const winner = scored.filter(candidate => candidate.matched.length > 0)
    .sort((left, right) => right.matched.length - left.matched.length)[0];
  const matchedIn = winner === undefined ? primary : winner;
  const matched = (winner?.matched ?? []).slice(0, 6)
    .map(item => ({ name: item.assertion.name, outcome: item.assertion.outcome,
      sharedTokens: item.shared, source: item.assertion.source, file: winner.file }));
  const quotedMatch = quotedNames.length === 0
    ? undefined
    : assertions.find(assertion => quotedNames.some(name => assertion.name.includes(name)));
  const quotedCoverage = quotedMatch === undefined
    ? []
    : [{ name: quotedMatch.name, outcome: quotedMatch.outcome, sharedTokens: [],
        source: quotedMatch.source, file, via: 'quoted-finding-name' }];
  const coverage = [...quotedCoverage, ...matched];
  const coveringFile = matchedIn?.file ?? file;
  const coveringResult = matchedIn?.result ?? result;
  /**
   * A recommendation only. When nothing in the row's own files covers the clause, the best
   * matching assertion anywhere in the batch is named so a reviewer can decide whether the row
   * points at the wrong file (the defect class the withdrawn-PASS audit documented).
   */
  const elsewhere = coverage.length > 0 || row.state !== 'RUNTIME-VERIFY'
    ? []
    : allAssertions
      .filter(assertion => !files.includes(assertion.file))
      .map(assertion => ({ assertion, ...matchScore(requirementTokens, assertion.name) }))
      .filter(item => item.decisive)
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map(item => ({ file: item.assertion.file, name: item.assertion.name,
        outcome: item.assertion.outcome, sharedTokens: item.shared }));
  return {
    id: row.id, document: row.document, section: row.section, requirement: row.requirement,
    workPackage: row.workPackage, namedTestFile: file ?? null,
    fileStatus: result?.status ?? 'not-in-batch', fileCounts: result?.counts ?? null,
    fileRawExit: result?.rawStatus ?? null, baseline: result?.baseline ?? null,
    executedAssertions: assertions.length, quotedCoverageNames: quotedNames.slice(0, 3),
    coveringFile: coverage.length === 0 ? null : coveringFile,
    suggestedCoveringAssertions: elsewhere,
    matchingAssertions: coverage,
    verdict: verdictFor(coveringResult, coveringFile, coverage, assertions),
  };
});

const supported = rows.filter(row => row.verdict === 'candidate-supported');
const insufficient = rows.filter(row => row.verdict === 'insufficient-evidence');
const failed = rows.filter(row => row.verdict === 'failed');
const reasons = {};
for (const row of insufficient) {
  const key = row.fileStatus + (row.executedAssertions === 0 ? ' / no-assertion-parsed' : ' / no-clause-match');
  reasons[key] = (reasons[key] ?? 0) + 1;
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  evidencePackage: 'S8-runtime-verify-ledger',
  batchesPath: args.batches,
  batchesBaseline: batches.results.find(result => typeof result.baseline === 'string')?.baseline ?? null,
  matrixVersion: matrix.matrixVersion,
  summary: { rows: rows.length, candidateSupported: supported.length,
    insufficientEvidence: insufficient.length, failed: failed.length, insufficientReasons: reasons },
  rows,
  matrixProtection: { passFreezeEdited: false, passPromotionExecuted: false, requireClosedExecuted: false,
    verdictVocabulary: ['candidate-supported', 'insufficient-evidence', 'failed'] },
};
mkdirSync(dirname(outJson), { recursive: true });
writeFileSync(outJson, JSON.stringify(report, null, 2) + LF, 'utf8');

const lines = [];
lines.push('# S8 RUNTIME-VERIFY 逐行断言账本');
lines.push('');
lines.push('本账本把「点名文件整体通过」升级为「该文件里**实际执行过**的断言」，正是撤回 196 个 PASS 时缺失的那一环：`No immutable per-requirement mapping to specific executed test assertions and their outcomes.`');
lines.push('');
lines.push('它只产出候选判定，不改矩阵状态：每行 verdict 取 ' + md('candidate-supported') + '、' + md('insufficient-evidence') + ' 或 ' + md('failed') + '；未执行 PASS 提升，未执行 ' + md('--require-closed') + '。');
lines.push('');
lines.push('- 批次收据：' + md(args.batches));
lines.push('- 收据绑定基线：' + md(String(report.batchesBaseline)));
lines.push('- 批次汇总：' + md(JSON.stringify(batches.summary)));
lines.push('- 判定规则：该文件在该基线上以干净计数退出，且文件内至少一条**已执行且通过**的断言与条款文本共享具区别性的词元（≥6 字符，或两个独立 4–5 字符词元）。');
lines.push('');
lines.push('## 汇总');
lines.push('');
lines.push('| 判定 | 行数 |');
lines.push('| --- | ---: |');
lines.push('| ' + md('candidate-supported') + ' | ' + String(supported.length) + ' |');
lines.push('| ' + md('insufficient-evidence') + ' | ' + String(insufficient.length) + ' |');
lines.push('| ' + md('failed') + ' | ' + String(failed.length) + ' |');
lines.push('| 合计 | ' + String(rows.length) + ' |');
lines.push('');
lines.push('未判为 candidate-supported 的分布：');
lines.push('');
lines.push('| 原因 | 行数 |');
lines.push('| --- | ---: |');
for (const [reason, count] of Object.entries(reasons).sort()) lines.push('| ' + md(reason) + ' | ' + String(count) + ' |');
lines.push('');
lines.push('## 逐行明细');
lines.push('');
lines.push('| Requirement | 点名文件 | 文件状态 | 已解析断言 | 命中断言（示例） | 判定 |');
lines.push('| --- | --- | --- | ---: | --- | --- |');
for (const row of rows) {
  const sample = row.matchingAssertions[0];
  lines.push('| ' + md(row.id) + ' | ' + md(row.namedTestFile ?? '(未记录)') + ' | ' + md(row.fileStatus) + ' | '
    + String(row.executedAssertions) + ' | ' + (sample === undefined ? '—' : sample.name.slice(0, 90)) + ' | ' + row.verdict + ' |');
}
lines.push('');
mkdirSync(dirname(outMd), { recursive: true });
writeFileSync(outMd, lines.join(LF) + LF, 'utf8');

process.stdout.write(JSON.stringify(report.summary) + LF);
process.exitCode = failed.length === 0 ? 0 : 1;
