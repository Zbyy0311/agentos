/**
 * Builds the review worksheet for RUNTIME-VERIFY rows the assertion ledger could not match.
 *
 * For every row it prints the clause next to the FULL list of assertions that actually ran in the
 * row's named file, with each assertion's outcome. That is the input a reviewer needs, because
 * the matcher only understands lexical overlap: a file whose assertions carry coded ids
 * (CR5S-01, MF4I-01, INSP-12) covers its clause without sharing a single word with the clause text.
 *
 * The worksheet proposes nothing and edits nothing. Judgments are recorded separately.
 *
 * Usage (from the project root):
 *   node scripts/build-lite-runtime-verify-worksheet.mjs --batches <json> --ledger <json> \
 *     --out-json <path> --out-md <path> [--from 0] [--count 12]
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
const batches = JSON.parse(readFileSync(resolve(repoRoot, args.batches), 'utf8'));
const ledger = JSON.parse(readFileSync(resolve(repoRoot, args.ledger), 'utf8'));
const from = Number(args.from ?? 0);
const count = Number(args.count ?? 12);

function namesIn(stdout) {
  const found = [];
  for (const line of String(stdout ?? '').split(/\r?\n/u)) {
    const node = /^\s*(\u2714|\u2716|\u2796)\s+(.+?)\s+\((\d+(?:\.\d+)?)ms\)\s*$/u.exec(line);
    if (node !== null) {
      found.push({ name: node[2].trim(), outcome: node[1] === '\u2714' ? 'pass' : node[1] === '\u2716' ? 'FAIL' : 'skip' });
      continue;
    }
    const vitest = /^\s*(\u2713|\u2717|\u00d7|\u2192)\s+(.+?)(?:\s+(\d+)ms)?\s*$/u.exec(line);
    if (vitest !== null && !/^\s*(Test Files|Tests|Duration|Start at)/iu.test(line)) {
      found.push({ name: vitest[2].trim(), outcome: vitest[1] === '\u2713' ? 'pass' : 'FAIL' });
    }
  }
  return found;
}

const byFile = new Map(batches.results.map(result => [result.file, result]));
const open = ledger.rows.filter(row => row.verdict !== 'candidate-supported');
const slice = open.slice(from, from + count);

const entries = slice.map(row => {
  const result = row.namedTestFile === null ? undefined : byFile.get(row.namedTestFile);
  return {
    id: row.id, document: row.document, section: row.section, requirement: row.requirement,
    namedTestFile: row.namedTestFile, fileStatus: row.fileStatus,
    fileRawExit: result?.rawStatus ?? null, fileCounts: result?.counts ?? null,
    executedAssertions: result === undefined ? [] : namesIn(result.stdout),
  };
});

const out = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  source: { batches: args.batches, ledger: args.ledger },
  window: { from, count, openRows: open.length }, entries };
mkdirSync(dirname(resolve(repoRoot, args['out-json'])), { recursive: true });
writeFileSync(resolve(repoRoot, args['out-json']), JSON.stringify(out, null, 2) + LF, 'utf8');

const lines = [];
lines.push('# RUNTIME-VERIFY 判读工作表（' + String(from) + '..' + String(from + slice.length - 1) + ' / 共 ' + String(open.length) + ' 行待判读）');
lines.push('');
for (const entry of entries) {
  lines.push('## ' + md(entry.id) + '  ' + (entry.document ?? '') + (entry.section ? ' · ' + entry.section : ''));
  lines.push('');
  lines.push('**条款**：' + entry.requirement);
  lines.push('');
  lines.push('- 点名文件：' + md(String(entry.namedTestFile ?? '(未记录)')) + '（' + entry.fileStatus + '，raw exit ' + String(entry.fileRawExit) + '，计数 ' + JSON.stringify(entry.fileCounts) + '）');
  lines.push('- 该文件实际执行过的断言（' + String(entry.executedAssertions.length) + ' 条）：');
  lines.push('');
  for (const assertion of entry.executedAssertions) {
    lines.push('  - [' + assertion.outcome + '] ' + assertion.name);
  }
  lines.push('');
}
mkdirSync(dirname(resolve(repoRoot, args['out-md'])), { recursive: true });
writeFileSync(resolve(repoRoot, args['out-md']), lines.join(LF) + LF, 'utf8');

process.stdout.write(JSON.stringify({ window: { from, count, openRows: open.length }, ids: entries.map(entry => entry.id) }) + LF);

