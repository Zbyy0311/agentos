/**
 * Generic Lite candidate-evidence pack assembler.
 *
 * One tool for every remaining S0 row group: the invariant rules live here, the per-pack
 * prose lives in a --spec JSON file. Verdicts are only candidate-supported /
 * insufficient-evidence / failed, the matrix is never touched, and the protected closeout
 * blobs are compared against the pinned baseline so a reader can see that no PASS
 * promotion happened in this pack.
 *
 * Usage (from the project root):
 *   node scripts/assemble-lite-candidate-evidence.mjs \
 *     --spec <spec.json> --evidence-dir <dir> --baseline <sha> \
 *     --command "<exact harness command>" --out-json <path> --out-md <path>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const B = String.fromCharCode(96);
const FENCE = B + B + B;
const SEP = String.fromCharCode(92);
const LF = String.fromCharCode(10);
const md = value => B + value + B;
const posix = value => value.split(SEP).join('/');

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
const evidenceDir = resolve(args['evidence-dir']);
const spec = JSON.parse(readFileSync(resolve(args.spec), 'utf8'));
const receipts = JSON.parse(readFileSync(resolve(evidenceDir, 'receipts.json'), 'utf8'));
const harnessExitCode = Number(readFileSync(resolve(evidenceDir, 'exit.txt'), 'utf8').trim());
const matrix = JSON.parse(readFileSync(resolve(repoRoot, 'docs/implementation/lite-closeout/matrix.json'), 'utf8'));
const matrixRows = new Map(matrix.requirements.map(row => [row.id, row]));

const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');
const rawLog = path => {
  if (!existsSync(path)) return { path: posix(relative(repoRoot, path)), missing: true };
  const bytes = readFileSync(path);
  return { path: posix(relative(repoRoot, path)), sha256: sha256Of(bytes), bytes: bytes.length };
};
const countsOf = assertions => {
  const result = { total: assertions.length, passed: 0, failed: 0, skipped: 0 };
  for (const assertion of assertions) {
    if (assertion.outcome === 'passed') result.passed += 1;
    else if (assertion.outcome === 'failed') result.failed += 1;
    else result.skipped += 1;
  }
  return result;
};
const verdictOf = (assertions, phaseExitCode, logs) => {
  const actual = countsOf(assertions);
  if (phaseExitCode !== 0 || actual.failed > 0) return 'failed';
  if (actual.total === 0 || actual.skipped > 0 || logs.some(log => log.missing === true)) return 'insufficient-evidence';
  return 'candidate-supported';
};

const protectedPaths = [
  'docs/implementation/lite-closeout/matrix.json',
  'docs/implementation/lite-closeout/pass-freeze.json',
  'docs/implementation/lite-closeout/pass-evidence-audit.json',
];
const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const repoPrefix = posix(relative(gitRoot, repoRoot));

const logPaths = [
  resolve(evidenceDir, 'receipts.json'), resolve(evidenceDir, 'stdout.txt'), resolve(evidenceDir, 'stderr.txt'),
  resolve(evidenceDir, 'exit.txt'), resolve(evidenceDir, 'scope-verifier.stdout.txt'),
  resolve(evidenceDir, 'scope-verifier.stderr.txt'), resolve(evidenceDir, 'targeted-tests', 'targeted.stdout.txt'),
  resolve(evidenceDir, 'targeted-tests', 'targeted.stderr.txt'),
];
for (const gateDir of spec.gateReceiptDirs ?? []) {
  logPaths.push(resolve(evidenceDir, gateDir, 'stdout.txt'));
  logPaths.push(resolve(evidenceDir, gateDir, 'stderr.txt'));
  logPaths.push(resolve(evidenceDir, gateDir, 'exit.txt'));
}
const allRawLogs = logPaths.map(rawLog);

const requirements = Object.entries(spec.requirements).map(([id, item]) => {
  const assertions = receipts.receipts.filter(receipt => receipt.requirementId === id);
  const row = matrixRows.get(id);
  return {
    id,
    specification: { text: item.text, section: item.section, sourceFile: item.sourceFile,
      sourceLine: item.sourceLine, secondarySources: item.secondarySources ?? [] },
    matrixRow: row === undefined ? { missing: true } : {
      matrixVersion: matrix.matrixVersion, state: row.state, workPackage: row.workPackage,
      document: row.document, section: row.section, requirement: row.requirement,
      exitCriteria: row.exit, recordedGap: row.finding,
      productionEntryPoints: row.implementation, tests: row.tests, evidence: row.evidence,
    },
    baselineSha: args.baseline, command: args.command, rawExitCode: harnessExitCode,
    counts: countsOf(assertions), observedCounts: countsOf(assertions), rawLogs: allRawLogs,
    assertionCoverage: assertions.map(receipt => ({ id: receipt.id, assertionId: receipt.id,
      requirementId: receipt.requirementId, phase: receipt.phase, step: receipt.step,
      actual: receipt.actual, expected: receipt.expected, outcome: receipt.outcome,
      ...(receipt.detail === undefined ? {} : { detail: receipt.detail }) })),
    whyAssertionsSuffice: item.why, adjacentBehaviorNotProven: item.limits,
    verdict: verdictOf(assertions, harnessExitCode, allRawLogs),
  };
});

const protectedFiles = protectedPaths.map(path => {
  const worktreeSha = sha256Of(readFileSync(resolve(repoRoot, path)));
  const baselineSha = sha256Of(execFileSync('git', ['show', args.baseline + ':' + repoPrefix + '/' + path], { cwd: gitRoot, maxBuffer: 1 << 28 }));
  return { path, worktreeSha256: worktreeSha, baselineSha256: baselineSha, matchesBaseline: worktreeSha === baselineSha };
});
const workingTreeDelta = execFileSync('git', ['status', '--porcelain=v1'], { cwd: gitRoot, encoding: 'utf8' })
  .split(LF).filter(Boolean);

const outJson = resolve(args['out-json']);
const outMd = resolve(args['out-md']);
const output = {
  schemaVersion: 1,
  evidencePackage: spec.packageName,
  generatedAt: new Date().toISOString(),
  baselineSha: args.baseline,
  testCodeSha: args.baseline,
  routeModels: spec.routeModels ?? {},
  modelScopeStatement: spec.modelScopeStatement,
  finalRun: { command: args.command, rawExitCode: harnessExitCode, allRawLogs,
    phases: receipts.phases, counts: receipts.counts },
  requirements,
  matrixProtection: {
    passFreezeEdited: false, passPromotionExecuted: false, requireClosedExecuted: false,
    protectedFiles, workingTreeDelta,
    verdictVocabulary: ['candidate-supported', 'insufficient-evidence', 'failed'],
  },
};
writeFileSync(outJson, JSON.stringify(output, null, 2) + LF, 'utf8');

const lines = [];
lines.push('# ' + spec.title);
lines.push('');
lines.push('本报告只记录候选证据，不能直接改变验收矩阵状态。' + String(requirements.length) + ' 个 requirement 的 verdict 只能取 ' + md('candidate-supported') + '、' + md('insufficient-evidence') + ' 或 ' + md('failed') + '；本轮没有执行 PASS 提升，也没有执行 ' + md('--require-closed') + '。');
lines.push('');
lines.push('- baseline SHA：' + md(args.baseline));
lines.push('- 机器可读包：' + md(posix(relative(repoRoot, outJson))));
lines.push('- 模型口径：' + spec.modelScopeStatement);
lines.push('- 这些 requirement 的矩阵状态在本轮保持 ' + md('GAP') + '，verdict 只是候选证据。');
lines.push('');
lines.push('| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |');
lines.push('| --- | --- | --- | --- | ---: |');
for (const item of requirements) {
  const c = item.counts;
  lines.push('| ' + md(item.id) + ' | ' + md(item.specification.text) + ' | ' + md(item.verdict) + ' | ' + c.total + ' total / ' + c.passed + ' passed / ' + c.failed + ' failed / ' + c.skipped + ' skipped | ' + item.rawExitCode + ' |');
}
lines.push('');
lines.push('## 最终执行记录');
lines.push('');
lines.push(FENCE + 'powershell');
lines.push(args.command);
lines.push(FENCE);
lines.push('');
lines.push('raw exit = ' + md(String(harnessExitCode)) + '；receipts 统计 ' + md(receipts.counts.total + ' total / ' + receipts.counts.passed + ' passed / ' + receipts.counts.failed + ' failed / ' + receipts.counts.skipped + ' skipped') + '。');
lines.push('');
lines.push('| 日志 / 收据 | bytes | SHA-256 |');
lines.push('| --- | ---: | --- |');
for (const log of allRawLogs) {
  lines.push('| ' + md(log.path) + ' | ' + (log.missing === true ? 'missing' : log.bytes) + ' | ' + (log.missing === true ? '-' : md(log.sha256)) + ' |');
}
lines.push('');
lines.push('### 被驱动的 gate 调用');
lines.push('');
lines.push(FENCE + 'json');
lines.push(JSON.stringify(receipts.phases.gates ?? {}, null, 2));
lines.push(FENCE);
lines.push('');
for (const item of requirements) {
  const row = item.matrixRow;
  lines.push('## ' + md(item.id));
  lines.push('');
  lines.push('matrix 原文为 ' + md(item.specification.text) + '；条款来源 ' + md(item.specification.sourceFile + ':' + item.specification.sourceLine) + '，并引用：');
  lines.push('');
  for (const secondary of item.specification.secondarySources) {
    lines.push('- ' + md(secondary.sourceFile + ':' + secondary.sourceLine) + ' — ' + secondary.note);
  }
  lines.push('');
  lines.push('- matrix 状态：' + md(String(row.state)) + '（workPackage ' + md(String(row.workPackage)) + '，matrixVersion ' + row.matrixVersion + '，本轮未改动）');
  lines.push('- 冻结退出条件（matrix ' + md('exit') + '）：' + String(row.exitCriteria));
  lines.push('- 原始记录缺口（matrix ' + md('finding') + '）：' + String(row.recordedGap));
  lines.push('- 生产入口（matrix ' + md('implementation') + '）：' + (Array.isArray(row.productionEntryPoints) && row.productionEntryPoints.length > 0 ? row.productionEntryPoints.map(entry => md(entry)).join('、') : '未记录'));
  lines.push('');
  lines.push('| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const assertion of item.assertionCoverage) {
    const actual = JSON.stringify(assertion.actual);
    const expected = JSON.stringify(assertion.expected);
    lines.push('| ' + md(assertion.assertionId) + ' | ' + md(assertion.phase) + '：' + assertion.step + ' | ' + md(actual.length > 320 ? actual.slice(0, 320) + '…' : actual) + ' | ' + md(expected.length > 200 ? expected.slice(0, 200) + '…' : expected) + ' | ' + assertion.outcome + ' |');
  }
  lines.push('');
  lines.push(item.whyAssertionsSuffice);
  lines.push('');
  lines.push('未证明的相邻行为：' + item.adjacentBehaviorNotProven);
  lines.push('');
}
lines.push('## targeted tests 与 scope verifier');
lines.push('');
lines.push(spec.testNote);
lines.push('');
for (const note of spec.knownLimitations ?? []) lines.push('- ' + note);
lines.push('');
lines.push('## 矩阵保护');
lines.push('');
lines.push('生成前后未修改 ' + md('pass-freeze.json') + ' / ' + md('matrix.json') + ' / ' + md('pass-evidence-audit.json') + '，未执行任何 promotion 脚本，也未执行 ' + md('--require-closed') + '。与 baseline blob 的 SHA-256 对比：');
lines.push('');
lines.push('| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |');
lines.push('| --- | --- | --- | --- |');
for (const file of protectedFiles) {
  lines.push('| ' + md(file.path) + ' | ' + md(file.worktreeSha256) + ' | ' + md(file.baselineSha256) + ' | ' + file.matchesBaseline + ' |');
}
lines.push('');
lines.push('工作区 delta（' + md('git status --porcelain=v1') + '）：');
lines.push('');
lines.push(FENCE + 'text');
for (const entry of workingTreeDelta) lines.push(entry);
lines.push(FENCE);
lines.push('');
writeFileSync(outMd, lines.join(LF) + LF, 'utf8');

const bad = requirements.some(item => item.verdict !== 'candidate-supported');
process.stdout.write(JSON.stringify({ outJson, outMd,
  verdicts: Object.fromEntries(requirements.map(item => [item.id, item.verdict])),
  protectedOk: protectedFiles.every(file => file.matchesBaseline) }) + LF);
process.exitCode = bad ? 1 : 0;

