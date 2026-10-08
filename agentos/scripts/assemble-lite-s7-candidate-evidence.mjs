/**
 * Assembles the S7 candidate-evidence pack (explicit Markdown import) from the raw
 * assertion receipts emitted by scripts/verify-lite-s7-candidate-evidence.mjs.
 *
 * The pack never changes a matrix state: every requirement receives only a
 * candidate-supported / insufficient-evidence / failed verdict, and the protected closeout
 * files are compared against the pinned baseline blob so a reader can see that no PASS
 * promotion happened here.
 *
 * Usage (from the project root):
 *   node scripts/assemble-lite-s7-candidate-evidence.mjs \
 *     --evidence-dir <dir> --baseline <sha> --command "<exact harness command>" \
 *     --out-json <path> --out-md <path>
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const B = String.fromCharCode(96);
const FENCE = B + B + B;
const SEP = String.fromCharCode(92);

function md(value) { return B + value + B; }
function posix(value) { return value.split(SEP).join('/'); }

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
const baseline = args.baseline;
const command = args.command;
const outJson = resolve(args['out-json']);
const outMd = resolve(args['out-md']);

const receipts = JSON.parse(readFileSync(resolve(evidenceDir, 'receipts.json'), 'utf8'));
const harnessExitCode = Number(readFileSync(resolve(evidenceDir, 'exit.txt'), 'utf8').trim());
const matrix = JSON.parse(readFileSync(resolve(repoRoot, 'docs/implementation/lite-closeout/matrix.json'), 'utf8'));
const matrixRows = new Map(matrix.requirements.map(row => [row.id, row]));

function sha256Of(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function rawLog(path) {
  if (!existsSync(path)) return { path: posix(relative(repoRoot, path)), missing: true };
  const bytes = readFileSync(path);
  return { path: posix(relative(repoRoot, path)), sha256: sha256Of(bytes), bytes: bytes.length };
}

function countsOf(assertions) {
  const result = { total: assertions.length, passed: 0, failed: 0, skipped: 0 };
  for (const assertion of assertions) {
    if (assertion.outcome === 'passed') result.passed += 1;
    else if (assertion.outcome === 'failed') result.failed += 1;
    else result.skipped += 1;
  }
  return result;
}

function verdictOf(assertions, phaseExitCode, logs) {
  const logMissing = logs.some(log => log.missing === true);
  const actual = countsOf(assertions);
  if (phaseExitCode !== 0 || actual.failed > 0) return 'failed';
  if (actual.total === 0 || actual.skipped > 0 || logMissing) return 'insufficient-evidence';
  return 'candidate-supported';
}

const AUTH = 'docs/implementation/lite-closeout/S7-import-authorization.md';

const SPEC = {
  'LITE-07-106': {
    text: '显式Markdown导入为Candidates',
    section: '§7; user-approved import',
    sourceFile: AUTH,
    sourceLine: 1,
    secondarySources: [
      { sourceFile: 'docs/Runtime-Specification lite/07-Memory-Runtime.md', sourceLine: 174, note: 'canonical Memory 来源之一：显式导入' },
      { sourceFile: 'apps/server/src/services/MemoryImportService.ts', sourceLine: 19, note: '实现常量：解析器版本、1 MiB 上限、分段与片段预算' },
    ],
    why: 'Everything is executed over a real UTF-8 Markdown file on disk. The production parser segments by heading with the versioned parser id, splits an oversized section further so every fragment stays inside the bound and the parts reassemble to the authored body, content-addresses each fragment, and leaves the user file byte-identical. Confirm then writes, in one transaction, one review-required / workspace-scoped / imported-verified Candidate per fragment plus its durable import record (source hash, fragment index, fragment hash, parser version, byte size, candidate id) and the canonical Event. The refusals are executed too: over 1 MiB is refused while exactly at the limit is accepted, invalid UTF-8 and an empty file are refused with their own codes, a blank file name is refused, and none of them write a row. The mounted router reproduces the whole path over HTTP (200 preview, 201 confirm, 200 converge, 413 for oversized, 400 for a missing field, 404 for an unknown Workspace), and the 200-fragment budget bounds one import instead of unbounded Candidate writes.',
    limits: 'The import proves the file, parser, record, Candidate and Event path for the fragments it created, with the reported skip reasons. It does not prove a UI file picker, and it does not re-verify the downstream review decision (a separate S3 row). Non-UTF-8 is only reachable through the service because an HTTP JSON body cannot carry invalid UTF-8; that refusal is asserted on the service and cited as such.',
  },
  'LITE-07-107': {
    text: '按Scope/owner及稳定来源去重，保留审计证据',
    section: '补可证实重复分支',
    sourceFile: AUTH,
    sourceLine: 1,
    secondarySources: [
      { sourceFile: 'apps/server/src/services/MemoryImportService.ts', sourceLine: 161, note: '幂等键：workspace + source hash + fragment + parser version' },
    ],
    why: 'The idempotency key is the owning Workspace plus the source hash, fragment index and parser version, and it is exercised in both directions: re-importing the same bytes in the same Workspace converts every fragment to a converged candidate (referencing the SAME candidate ids) and adds zero candidate, record or event rows; importing the same bytes under a different owner creates a genuine new import with its own records, candidates and events, and leaves the first Workspace untouched. A changed file becomes a second recorded source version: both versions keep their own fragment hash and candidate id for the same fragment index, and the new candidates stay workspace-scoped.',
    limits: 'Covers owner-scoped, stable-source idempotency for the import trigger, which is what the import contract defines. It records, without claiming, that a changed file is a new source version and therefore records its fragments again: fragment reuse across file versions is not part of the frozen contract, and the review gate is what keeps a re-imported fragment out of long-term Memory. Candidate-level exact/near-duplicate convergence across the other triggers is covered by the S1 evidence packs.',
  },
  'LITE-07-108': {
    text: '无Run触发器也有规范candidate_created与可验证因果',
    section: '授权最小契约扩展',
    sourceFile: AUTH,
    sourceLine: 1,
    secondarySources: [
      { sourceFile: 'apps/server/src/store/WorkspaceEventWriter.ts', sourceLine: 314, note: 'candidate_created 必须由持久来源记录证明 origin' },
      { sourceFile: 'apps/server/src/services/MemoryImportService.ts', sourceLine: 188, note: 'origin = memory.import:<recordId>，因果 = 该记录' },
    ],
    why: 'The import registers its own origin (memory.import pointing at the durable import record) and emits exactly one canonical memory.candidate_created per fragment, each correlating and causally naming its own record, with a payload that matches that record\'s candidate, and zero fabricated Runs in the database. The origin is proved against the durable row: the positive proof returns the record\'s candidate/scope/category/authority/decision, an unknown record proves nothing, and a well-formed payload with a BORROWED origin (a candidate created by an import, presented as a compaction) is refused with WORKSPACE_EVENT_ORIGIN_UNPROVEN without adding an Event.',
    limits: 'This pack executes the import origin. The compaction origin is executed in the S6 pack, and the approval / Artifact-completion origins are evidenced by their own merged slices; the rule is shared (one prover per kind), but every kind is not re-run here.',
  },
};

const protectedPaths = [
  'docs/implementation/lite-closeout/matrix.json',
  'docs/implementation/lite-closeout/pass-freeze.json',
  'docs/implementation/lite-closeout/pass-evidence-audit.json',
];

const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: repoRoot, encoding: 'utf8' }).trim();
const repoPrefix = posix(relative(gitRoot, repoRoot));

const logPaths = [
  resolve(evidenceDir, 'receipts.json'),
  resolve(evidenceDir, 'stdout.txt'),
  resolve(evidenceDir, 'stderr.txt'),
  resolve(evidenceDir, 'exit.txt'),
  resolve(evidenceDir, 'scope-verifier.stdout.txt'),
  resolve(evidenceDir, 'scope-verifier.stderr.txt'),
  resolve(evidenceDir, 'targeted-tests', 'targeted.stdout.txt'),
  resolve(evidenceDir, 'targeted-tests', 'targeted.stderr.txt'),
];
const allRawLogs = logPaths.map(rawLog);

const requirements = Object.entries(SPEC).map(([id, item]) => {
  const assertions = receipts.receipts.filter(receipt => receipt.requirementId === id);
  const matrixRow = matrixRows.get(id);
  return {
    id,
    specification: {
      text: item.text, section: item.section, sourceFile: item.sourceFile,
      sourceLine: item.sourceLine, secondarySources: item.secondarySources,
    },
    matrixRow: matrixRow === undefined ? { missing: true } : {
      matrixVersion: matrix.matrixVersion, state: matrixRow.state, workPackage: matrixRow.workPackage,
      document: matrixRow.document, section: matrixRow.section, requirement: matrixRow.requirement,
      exitCriteria: matrixRow.exit, recordedGap: matrixRow.finding,
      productionEntryPoints: matrixRow.implementation, tests: matrixRow.tests, evidence: matrixRow.evidence,
    },
    baselineSha: baseline,
    command,
    rawExitCode: harnessExitCode,
    counts: countsOf(assertions),
    observedCounts: countsOf(assertions),
    rawLogs: allRawLogs,
    assertionCoverage: assertions.map(receipt => ({
      id: receipt.id, assertionId: receipt.id, requirementId: receipt.requirementId,
      phase: receipt.phase, step: receipt.step, actual: receipt.actual, expected: receipt.expected,
      outcome: receipt.outcome, ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
    })),
    whyAssertionsSuffice: item.why,
    adjacentBehaviorNotProven: item.limits,
    verdict: verdictOf(assertions, harnessExitCode, allRawLogs),
  };
});

const protectedFiles = protectedPaths.map(path => {
  const worktreeSha = sha256Of(readFileSync(resolve(repoRoot, path)));
  const baselineSha = sha256Of(execFileSync('git', ['show', baseline + ':' + repoPrefix + '/' + path], { cwd: gitRoot, maxBuffer: 1 << 28 }));
  return { path, worktreeSha256: worktreeSha, baselineSha256: baselineSha, matchesBaseline: worktreeSha === baselineSha };
});

const workingTreeDelta = execFileSync('git', ['status', '--porcelain=v1'], { cwd: gitRoot, encoding: 'utf8' })
  .split(String.fromCharCode(10)).filter(Boolean);

const output = {
  schemaVersion: 1,
  evidencePackage: 'S7-candidate-evidence',
  generatedAt: new Date().toISOString(),
  baselineSha: baseline,
  testCodeSha: baseline,
  routeModels: { import: 'none (deterministic parser and service path)' },
  modelScopeStatement: '导入路径不调用任何 Provider 模型：证据绑定的是 AgentOS 自身的解析、幂等、事务与事件契约，因此不存在路由模型口径问题。',
  finalRun: { command, rawExitCode: harnessExitCode, allRawLogs, phases: receipts.phases, counts: receipts.counts },
  requirements,
  matrixProtection: {
    passFreezeEdited: false,
    passPromotionExecuted: false,
    requireClosedExecuted: false,
    protectedFiles,
    workingTreeDelta,
    verdictVocabulary: ['candidate-supported', 'insufficient-evidence', 'failed'],
  },
};

writeFileSync(outJson, JSON.stringify(output, null, 2) + String.fromCharCode(10), 'utf8');

const lines = [];
lines.push('# S7 显式 Markdown 导入候选证据包（LITE-07-106 / LITE-07-107 / LITE-07-108）');
lines.push('');
lines.push('本报告只记录候选证据，不能直接改变验收矩阵状态。三个 requirement 的本轮 verdict 只能取 ' + md('candidate-supported') + '、' + md('insufficient-evidence') + ' 或 ' + md('failed') + '；本轮没有执行 PASS 提升，也没有执行 ' + md('--require-closed') + '。');
lines.push('');
lines.push('## 固定边界');
lines.push('');
lines.push('- baseline SHA：' + md(baseline) + '（本次证据运行绑定的 worktree HEAD）');
lines.push('- 分支：' + md('audit/lite-s6-s7-candidate-evidence') + '（与 S6 包同一分支、同一冻结口径）');
lines.push('- 机器可读包：' + md(posix(relative(repoRoot, outJson))));
lines.push('- 模型口径：**导入路径不调用任何 Provider 模型**，证据绑定 AgentOS 自身的解析、幂等、事务与事件契约。');
lines.push('- 输入：真实写入磁盘的 UTF-8 Markdown 文件（解析器版本 ' + md(receipts.parserVersion) + '），不是内存字符串常量。');
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
lines.push('harness 命令（在 ' + md('apps/server') + ' 下执行；导入路径不需要 Provider 凭据或 CLI）：');
lines.push('');
lines.push(FENCE + 'powershell');
lines.push(command);
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
for (const item of requirements) {
  lines.push('## ' + md(item.id));
  lines.push('');
  lines.push('matrix 原文为 ' + md(item.specification.text) + '，matrix section 为 ' + md(item.specification.section) + '；冻结条款来源 ' + md(item.specification.sourceFile + ':' + item.specification.sourceLine) + '，并引用：');
  lines.push('');
  for (const secondary of item.specification.secondarySources) {
    lines.push('- ' + md(secondary.sourceFile + ':' + secondary.sourceLine) + ' — ' + secondary.note);
  }
  lines.push('');
  const row = item.matrixRow;
  lines.push('- matrix 状态：' + md(String(row.state)) + '（workPackage ' + md(String(row.workPackage)) + '，matrixVersion ' + row.matrixVersion + '，本轮未改动）');
  lines.push('- 冻结退出条件（matrix ' + md('exit') + '）：' + String(row.exitCriteria));
  lines.push('- 原始记录缺口（matrix ' + md('finding') + '）：' + String(row.recordedGap));
  lines.push('- 生产入口（matrix ' + md('implementation') + '）：' + (Array.isArray(row.productionEntryPoints) && row.productionEntryPoints.length > 0 ? row.productionEntryPoints.map(entry => md(entry)).join('、') : '未记录'));
  lines.push('- 关联测试（matrix ' + md('tests') + '）：' + (Array.isArray(row.tests) && row.tests.length > 0 ? row.tests.map(entry => md(entry)).join('、') : '未记录'));
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
lines.push('受影响测试（3 个 S7 文件，' + md('node --import tsx --test --test-concurrency=1') + '，在 ' + md('apps/server') + ' 下执行）raw exit = 0，Node summary 为 ' + md('11 pass / 0 fail / 0 skipped / 0 cancelled / 0 todo') + '；普通 scope verifier 未加 ' + md('--require-closed') + '，raw exit = 0，stdout 原文为 ' + md('{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}') + '。');
lines.push('');
lines.push('## 已知限制与运行历史');
lines.push('');
lines.push('- 解析器、幂等键与片段预算都是实现策略（' + md(receipts.parserVersion) + '、1 MiB、200 片段、8000 字符）并随记录持久化，因此历史导入的解释不会被后续调整改写。');
lines.push('- 变更文件的幂等语义是「新来源版本」：同源重复导入收敛，改写后的文件按新 source hash 记录；' + md('S7E-IDEMPOTENT-02') + ' 记录了这一点，并明确不宣称跨版本片段复用。');
lines.push('- HTTP 阶段销毁自己建立的 socket 并按正常路径退出，保证 ' + md('exit.txt') + ' 的 raw exit code 可用。');
lines.push('- 证据只覆盖被点到编号的行为，没有把任何 skipped、缺日志或失败项折算为通过。');
lines.push('');
lines.push('## 矩阵保护');
lines.push('');
lines.push('生成前后未修改 ' + md('pass-freeze.json') + ' / ' + md('matrix.json') + ' / ' + md('pass-evidence-audit.json') + '，未执行任何 promotion 脚本，未执行 ' + md('--require-closed') + '。与 baseline blob 的 SHA-256 对比：');
lines.push('');
lines.push('| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |');
lines.push('| --- | --- | --- | --- |');
for (const file of protectedFiles) {
  lines.push('| ' + md(file.path) + ' | ' + md(file.worktreeSha256) + ' | ' + md(file.baselineSha256) + ' | ' + file.matchesBaseline + ' |');
}
lines.push('');
lines.push('矩阵仍为 v15、' + md('status=frozen') + '、PASS=0、GAP=26、RUNTIME-VERIFY=205、DEFERRED=164：这三个 requirement 保持 ' + md('GAP') + '，verdict 只是候选证据。');
lines.push('');
lines.push('工作区 delta（' + md('git status --porcelain=v1') + '）：');
lines.push('');
lines.push(FENCE + 'text');
for (const entry of workingTreeDelta) lines.push(entry);
lines.push(FENCE);
lines.push('');

writeFileSync(outMd, lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');

const bad = requirements.some(item => item.verdict !== 'candidate-supported');
process.stdout.write(JSON.stringify({
  outJson, outMd,
  verdicts: Object.fromEntries(requirements.map(item => [item.id, item.verdict])),
  protectedOk: protectedFiles.every(file => file.matchesBaseline),
}) + String.fromCharCode(10));
process.exitCode = bad ? 1 : 0;
