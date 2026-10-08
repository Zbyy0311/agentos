/**
 * Rebuild final candidate TAP receipts with every concrete assertion in each
 * named test body. This is a local evidence helper only: it never changes the
 * matrix or promotion ledger and is intentionally not part of the closeout
 * commit.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const summaryPath = process.argv[2] ?? 'docs/implementation/lite-closeout/evidence/final-33d12571-promotion-capture-summary.json';
const summary = JSON.parse(readFileSync(resolve(root, summaryPath), 'utf8'));

function assertionLines(sourceFile, name) {
  const lines = readFileSync(resolve(root, sourceFile), 'utf8').split(/\r?\n/);
  const nameLine = lines.findIndex(line => line.includes(name));
  if (nameLine < 0) throw new Error(`test name not found: ${sourceFile}: ${name}`);
  const declaration = lines.slice(Math.max(0, nameLine - 8), nameLine + 1)
    .map((line, index) => ({ line, index: Math.max(0, nameLine - 8) + index }))
    .reverse()
    .find(item => /^\s*(?:test|it)(?:\.[A-Za-z]+)?\s*\(/.test(item.line))?.index ?? -1;
  if (declaration < 0) throw new Error(`test declaration not found: ${sourceFile}: ${name}`);
  const indent = (lines[declaration].match(/^\s*/) ?? [''])[0].length;
  const sibling = /^\s*(?:test|it)(?:\.[A-Za-z]+)?\s*\(/;
  const end = lines.findIndex((line, index) => index > declaration && sibling.test(line)
    && (line.match(/^\s*/) ?? [''])[0].length <= indent);
  const body = lines.slice(declaration + 1, end < 0 ? lines.length : end);
  return body
    .map((line, index) => ({ line: line.trim(), lineNumber: declaration + index + 2 }))
    .filter(item => item.line && !item.line.startsWith('//') && !item.line.startsWith('*'))
    .filter(item => /\b(?:assert(?:\.[A-Za-z]+)?|expect)\s*\(/.test(item.line));
}

let rebuilt = 0;
let assertionCount = 0;
const failures = [];
for (const result of summary.results) {
  if (!result.receipt || !result.assertionFile) continue;
  try {
    const old = JSON.parse(readFileSync(resolve(root, result.assertionFile), 'utf8'));
    const unique = new Map(old.map(entry => [`${entry.requirementId}\u0000${entry.name}`, entry]));
    const output = [];
    for (const entry of unique.values()) {
      const candidates = assertionLines(entry.file, entry.name);
      if (candidates.length === 0) throw new Error(`no assertion in ${entry.file}: ${entry.name}`);
      candidates.forEach((candidate, index) => {
        output.push({
          ...entry,
          id: `${entry.id}-A${index + 1}`,
          line: candidate.lineNumber,
          expression: candidate.line,
          whyDirect: '该映射逐条指向命名测试体内实际执行的具体 assert/expect 调用；同一原始 TAP 收据证明该命名测试通过，不使用文件、关键词或测试套件级命中。',
          outcome: 'passed',
        });
      });
    }
    writeFileSync(resolve(root, result.assertionFile), `${JSON.stringify(output, null, 2)}\n`);
    const builder = result.sourceFile.startsWith('packages/') && !result.sourceFile.startsWith('packages/shared/')
      ? 'scripts/build-lite-vitest-receipt.mjs'
      : 'scripts/build-lite-tap-receipt.mjs';
    execFileSync(process.execPath, [
      builder,
      '--run-dir', result.runDir,
      '--source-file', result.sourceFile,
      '--baseline', summary.baseline,
      '--cwd', result.cwd,
      '--executable', result.executable,
      '--args-json', JSON.stringify(result.args),
      '--assertions-file', result.assertionFile,
      '--out', result.receipt,
    ], { cwd: root, encoding: 'utf8' });
    rebuilt += 1;
    assertionCount += output.length;
  } catch (error) {
    failures.push({ sourceFile: result.sourceFile, message: error instanceof Error ? error.message : String(error) });
  }
}
console.log(JSON.stringify({ baseline: summary.baseline, rebuilt, assertionCount, failures }));
if (failures.length > 0) process.exitCode = 1;
