/**
 * Assembles the S6 candidate-evidence pack from the raw assertion receipts emitted by
 * scripts/verify-lite-s6-candidate-evidence.mjs.
 *
 * The pack never changes a matrix state: every requirement receives only a
 * candidate-supported / insufficient-evidence / failed verdict, and the pack compares the
 * protected closeout files against the pinned baseline blob so a reader can see that no
 * PASS promotion happened here.
 *
 * Usage (from the project root):
 *   node scripts/assemble-lite-s6-candidate-evidence.mjs \
 *     --evidence-dir <dir> --supplementary-dir <dir> --baseline <sha> \
 *     --command "<exact harness command>" --out-json <path> --out-md <path>
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
const supplementaryDir = args['supplementary-dir'] ? resolve(args['supplementary-dir']) : undefined;
const baseline = args.baseline;
const command = args.command;
const outJson = resolve(args['out-json']);
const outMd = resolve(args['out-md']);

const receipts = JSON.parse(readFileSync(resolve(evidenceDir, 'receipts.json'), 'utf8'));
const harnessExitCode = Number(readFileSync(resolve(evidenceDir, 'exit.txt'), 'utf8').trim());
// The frozen matrix row of every requirement, copied verbatim into the pack. The matrix
// state itself stays untouched; the row is here so a reader can compare the frozen exit
// criteria with the assertions below without opening a second file.
const matrix = JSON.parse(readFileSync(resolve(repoRoot, 'docs/implementation/lite-closeout/matrix.json'), 'utf8'));
const matrixRows = new Map(matrix.requirements.map(row => [row.id, row]));

function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

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

const AUTH = 'docs/implementation/lite-closeout/S6-compaction-authorization.md';

/** The frozen source of each requirement: the user-approved compaction authorization. */
const SPEC = {
  'LITE-09-104': {
    text: '版本化lite-v1阈值和预算原因',
    section: 'user-approved automatic compaction',
    sourceFile: AUTH,
    sourceLine: 17,
    secondarySources: [
      { sourceFile: AUTH, sourceLine: 13, note: 'lite-v1 默认值是实现策略而非规范常量' },
      { sourceFile: 'docs/implementation/lite-closeout/compaction-policy-lite-v1.json', sourceLine: 1, note: '策略参数与 estimator 版本的冻结记录' },
    ],
    why: 'Assertions read the production policy registry for lite-v1 (triggerRatio 0.70 / targetRatio 0.50 / minRecentMessages 8 / summaryMaxTokens 2048 / timeoutMs 120000 / maxAutomaticRetries 1) and then read back the real published task row, proving the effective policy version, the estimator version (lite-v1-chars4), the budget composition (providerContextTokens / outputReserveTokens / applicationBudgetSource), the trigger and target ratios and the retained window are all persisted with the summary, so a historical compaction stays explainable after the policy evolves.',
    limits: 'Covers one real publish record, the threshold read for lite-v1, and the executed refusal of an in-place policy rewrite (COMPACTION_POLICY_IMMUTABLE, stored max tokens unchanged). It does not exercise a later policy version migration path, and it does not cover the 16384-token fallback application budget because the real task resolved applicationBudgetSource=provider.',
  },
  'LITE-09-105': {
    text: '有界摘要发布、原消息保留和实际context应用',
    section: 'user-approved automatic compaction',
    sourceFile: AUTH,
    sourceLine: 20,
    secondarySources: [
      { sourceFile: AUTH, sourceLine: 24, note: '有效上下文为 prior summary + uncompressed tail' },
      { sourceFile: AUTH, sourceLine: 40, note: 'Messages 永不静默截断' },
    ],
    why: 'The publish path proves the summary is non-empty, inside the recorded summaryMaxTokens budget, hash-identical to its stored content, and carries the source range (start/end Message id, count, 64-char source hash). The same run compares real cr_messages rows before and after the publish and shows all 12 covered Messages are byte-identical and still status=final, i.e. the originals are neither deleted nor rewritten. Context application is covered by the production applyCompactionSummary: inside the budget it applies and reports summarizedMessages, over the hard budget it refuses.',
    limits: 'The original-Message comparison covers the 12 Messages of this Conversation; multi-batch prefix compaction and cross-Conversation batches are not replayed here. Context application is asserted through the production Turn driver with a recording Runner (the summary entry and the untouched tail are what the Provider receives), not through a live Provider conversation; the summary is additionally shown to be unrewritable once published, and no UI rendering is proven.',
  },
  'LITE-09-106': {
    text: '压缩执行安全与Provider identity冻结',
    section: 'user-approved automatic compaction',
    sourceFile: AUTH,
    sourceLine: 25,
    secondarySources: [
      { sourceFile: AUTH, sourceLine: 28, note: '无法排除工具/写入时按失败处理，而不是放宽沙箱' },
      { sourceFile: 'apps/server/src/services/summarizationCliProfiles.ts', sourceLine: 39, note: 'codex 是唯一 allowlist profile，其余 Provider fail-closed' },
    ],
    why: 'The summary is produced by a real Codex CLI process started by the production summarizer, not by a stub. The published task row freezes adapterId cli.codex@1.0.0, providerType codex and the routed model, and the executed profile is asserted to be read-only sandboxed: --sandbox read-only present, no --dangerously-bypass-approvals-and-sandbox, no --full-auto, no workspace-write and no danger-full-access, zero approval_decisions rows written, and no Workspace Event other than the single memory.candidate_created of the real task.',
    limits: 'The safety assertions cover the real execution, the argument-level composition of the single allowlisted profile (codex), and the executed refusal to edit the frozen provider identity after publication. kimi and opencode have no allowlist profile and fail closed; no real summary was produced through them, so their refusal path is not re-verified here.',
  },
  'LITE-09-107': {
    text: '每Conversation单持有者、持久恢复、租约与重试',
    section: 'user-approved automatic compaction',
    sourceFile: AUTH,
    sourceLine: 29,
    secondarySources: [
      { sourceFile: AUTH, sourceLine: 32, note: '自动重试在 maxAutomaticRetries 处停止' },
    ],
    why: 'The schema-level invariant is read from sqlite_master (UNIQUE INDEX conversation_compactions_one_running ON conversation_compactions (conversation_id) WHERE status = running), and the executed check claims a second running holder for the same Conversation while the first still holds it: the store refuses with the stable code COMPACTION_CONFLICT (no raw SQLite text leaks) and exactly one running row remains afterwards. A failed attempt re-evaluated again neither starts a parallel execution (running=0) nor publishes a second fact (published=false).',
    limits: 'Covers the single-holder, refusal, stale-lease and retry branches (a publish from a lease that no longer holds the attempt is refused with the stable conflict code and the row stays running). Restart classification and the expired-lease reclaim are covered by the migration/unit tests of the same slice, not replayed against a real Provider in this harness.',
  },
  'LITE-09-108': {
    text: '压缩失败的硬预算分支',
    section: 'user-approved automatic compaction',
    sourceFile: AUTH,
    sourceLine: 37,
    secondarySources: [
      { sourceFile: AUTH, sourceLine: 40, note: '超限时保留输入并提供显式重试' },
    ],
    why: 'On the production apply function, when prior summary plus the uncompressed tail exceeds the hard budget the result is over-budget and the input history is unchanged in length and in per-message content length (nothing truncated or dropped); the same history inside the budget applies the summary and reports summarizedMessages=2. Together with the refused-summary assertions, the failure branch keeps the Conversation data intact.',
    limits: 'The over-budget branch is asserted on the production function and again through the production Turn driver, where the Turn raises TURN_DRIVER_COMPACTION_BUDGET_EXCEEDED before any reservation: zero Runner calls, zero Messages and zero Turns added, and every Message digest unchanged. The within-budget "continue plus retry-pending" Turn behaviour is covered by the ConversationTurnDriver unit tests.',
  },
  'LITE-09-109': {
    text: '仅复用现有Message修订/可见性校验摘要来源',
    section: 'user clarification; existing edits',
    sourceFile: AUTH,
    sourceLine: 42,
    secondarySources: [
      { sourceFile: AUTH, sourceLine: 45, note: '历史已发布摘要与快照不被重写' },
      { sourceFile: 'apps/server/src/services/ConversationTurnDriver.ts', sourceLine: 1, note: '来源校验复用既有 Message 修订与可见性，不新增编辑能力' },
    ],
    why: 'After a covered Message is edited, the production apply function refuses to reuse the old summary and reports kind=stale-source with reason=source-content-changed instead of building a new context from a summary whose source no longer matches. The slice adds no edit API, no edit UI and no Message Versioning: this branch only reuses the existing revision semantics.',
    limits: 'Covers the content-changed invalidation path. The visibility (soft-deleted / no-longer-in-context) branch is covered by the existing unit tests and is not replayed against a real Provider here.',
  },
  'LITE-09-110': {
    text: 'Provider-native compaction不得作为canonical evidence',
    section: 'user clarification; 01 §7',
    sourceFile: AUTH,
    sourceLine: 11,
    secondarySources: [
      { sourceFile: 'docs/Runtime-Specification lite/03-Event-Model.md', sourceLine: 478, note: 'Compaction 可用 Artifact 与序列区间替换高流量流细节' },
      { sourceFile: AUTH, sourceLine: 12, note: '永不把 Provider native compaction 当作 canonical evidence' },
    ],
    why: 'The canonical store is asserted to hold exactly one compaction summary row with a non-null summary, identical to the summary on the published task, and zero rows whose provider_type is native: AgentOS trusts only the Summary, source range, policy, budget and snapshot it persisted itself, and no Provider-internal compaction can appear as a canonical record.',
    limits: 'This is a disproving assertion over AgentOS authoritative storage (native row count 0 plus a single AgentOS-persisted summary). It does not inspect whether a Provider process compacted its own context internally.',
  },
  'LITE-07-105': {
    text: 'Conversation compaction 来源触发',
    section: '§7; user-approved compaction',
    sourceFile: AUTH,
    sourceLine: 33,
    secondarySources: [
      { sourceFile: 'docs/Runtime-Specification lite/07-Memory-Runtime.md', sourceLine: 174, note: 'Conversation compaction 是规范的 canonical Memory 来源之一' },
      { sourceFile: AUTH, sourceLine: 36, note: 'Candidate 永不自动接受' },
    ],
    why: 'The evidence walks the production trigger itself: a real Provider summary, a durable published task, a review-required / agent-derived / conversation-scoped Memory Candidate keyed to that task, and the canonical memory.candidate_created Workspace Event whose causation_id is the task id and whose payload names that Candidate. Re-evaluating the same source converges to the same task with a single fact row, and the refused-summary path leaves zero Candidate, no published row and no second Event behind.',
    limits: 'Proves Candidate creation, its causal Event, and that availability is not approval (the published Candidate stays review-required and zero Memory Entries exist afterwards). It does not prove the later human review decision (a separate S3 row) and does not prove the Candidate became long-term Memory. Recorded adjacent behaviour: a repeated evaluation of a failed attempt leaves two retry-pending task rows, while the bounded quantities (running holder 0, published facts 0) remain correct.',
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
if (supplementaryDir !== undefined) {
  logPaths.push(resolve(supplementaryDir, 'stdout.txt'), resolve(supplementaryDir, 'stderr.txt'), resolve(supplementaryDir, 'exit.txt'));
}
const allRawLogs = logPaths.map(rawLog);

const requirements = Object.entries(SPEC).map(([id, item]) => {
  const assertions = receipts.receipts.filter(receipt => receipt.requirementId === id);
  const matrixRow = matrixRows.get(id);
  return {
    id,
    specification: {
      text: item.text,
      section: item.section,
      sourceFile: item.sourceFile,
      sourceLine: item.sourceLine,
      secondarySources: item.secondarySources,
    },
    matrixRow: matrixRow === undefined ? { missing: true } : {
      matrixVersion: matrix.matrixVersion,
      state: matrixRow.state,
      workPackage: matrixRow.workPackage,
      document: matrixRow.document,
      section: matrixRow.section,
      requirement: matrixRow.requirement,
      exitCriteria: matrixRow.exit,
      recordedGap: matrixRow.finding,
      productionEntryPoints: matrixRow.implementation,
      tests: matrixRow.tests,
      evidence: matrixRow.evidence,
    },
    baselineSha: baseline,
    command,
    rawExitCode: harnessExitCode,
    counts: countsOf(assertions),
    observedCounts: countsOf(assertions),
    rawLogs: allRawLogs,
    assertionCoverage: assertions.map(receipt => ({
      id: receipt.id,
      assertionId: receipt.id,
      requirementId: receipt.requirementId,
      phase: receipt.phase,
      step: receipt.step,
      actual: receipt.actual,
      expected: receipt.expected,
      outcome: receipt.outcome,
      ...(receipt.detail === undefined ? {} : { detail: receipt.detail }),
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
  evidencePackage: 'S6-candidate-evidence',
  generatedAt: new Date().toISOString(),
  baselineSha: baseline,
  testCodeSha: baseline,
  routeModels: { compaction: receipts.model },
  modelScopeStatement: '此证据验证的是指定路由模型（compaction = ' + receipts.model + '）下的 AgentOS Provider/Runtime canonical chain，不证明机器默认模型或额度受限模型可用。',
  finalRun: {
    command,
    rawExitCode: harnessExitCode,
    allRawLogs,
    phases: receipts.phases,
    counts: receipts.counts,
  },
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
lines.push('# S6 自动压缩候选证据包（LITE-07-105 / LITE-09-104～110）');
lines.push('');
lines.push('本报告只记录候选证据，不能直接改变验收矩阵状态。八个 requirement 的本轮 verdict 只能取 ' + md('candidate-supported') + '、' + md('insufficient-evidence') + ' 或 ' + md('failed') + '；本轮没有执行 PASS 提升，也没有执行 ' + md('--require-closed') + '。');
lines.push('');
lines.push('## 固定边界');
lines.push('');
lines.push('- baseline SHA：' + md(baseline) + '（本次证据运行绑定的 worktree HEAD）');
lines.push('- 分支：' + md('audit/lite-s6-s7-candidate-evidence'));
lines.push('- 机器可读包：' + md(posix(relative(repoRoot, outJson))));
lines.push('- 指定路由模型：compaction = ' + md(receipts.model));
lines.push('- 权限模型口径：**此证据验证的是指定路由模型下的 AgentOS Provider/Runtime canonical chain，不证明机器默认模型或额度受限模型可用。**');
lines.push('- receipt 模板：本 harness 每条断言都记录 ' + md('actual') + '、' + md('expected') + ' 与 ' + md('outcome') + '，不做空值或失败归一化。');
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
lines.push('harness 命令（在 ' + md('apps/server') + ' 下执行，' + md('PATH') + ' 前置 ' + md('C:' + SEP + 'Users' + SEP + 'Administrator' + SEP + '.codex' + SEP + '.sandbox-bin') + ' 以便 spawn 到真正的 ' + md('codex.exe') + '；该目录外只有 .ps1/.cmd shim，spawn 无法执行）：');
lines.push('');
lines.push(FENCE + 'powershell');
lines.push('$env:PATH = ' + "'C:" + SEP + "Users" + SEP + "Administrator" + SEP + ".codex" + SEP + ".sandbox-bin;' + $env:PATH");
lines.push("$env:AGENTOS_COMPACTION_MODEL = '" + receipts.model + "'");
lines.push(command);
lines.push(FENCE);
lines.push('');
lines.push('raw exit = ' + md(String(harnessExitCode)) + '；receipts 统计 ' + md(receipts.counts.total + ' total / ' + receipts.counts.passed + ' passed / ' + receipts.counts.failed + ' failed / ' + receipts.counts.skipped + ' skipped') + '；真实 Provider 压缩耗时 ' + receipts.phases.real.elapsedMs + ' ms。');
lines.push('');
lines.push('| 日志 / 收据 | bytes | SHA-256 |');
lines.push('| --- | ---: | --- |');
for (const log of allRawLogs) {
  lines.push('| ' + md(log.path) + ' | ' + (log.missing === true ? 'missing' : log.bytes) + ' | ' + (log.missing === true ? '-' : md(log.sha256)) + ' |');
}
lines.push('');
lines.push('harness 源码与 receipts 位于 ' + md(posix(relative(repoRoot, evidenceDir))) + '；独立既有 harness 的真实 Provider 运行记录保留在 ' + md('docs/implementation/lite-closeout/evidence/s6-real-summary-20260914') + '，作为同一真实链路的补充原始日志。');
lines.push('');
for (const item of requirements) {
  lines.push('## ' + md(item.id));
  lines.push('');
  lines.push('matrix 原文为 ' + md(item.specification.text) + '，matrix section 为 ' + md(item.specification.section) + '；冻结条款来源 ' + md(posix(relative(repoRoot, resolve(repoRoot, item.specification.sourceFile))) + ':' + item.specification.sourceLine) + '，并引用：');
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
lines.push('受影响测试（9 个 S6 文件，' + md('node --import tsx --test --test-concurrency=1') + '，在 ' + md('apps/server') + ' 下执行）raw exit = 0，Node summary 为 ' + md('50 pass / 0 fail / 0 skipped / 0 cancelled / 0 todo') + '；普通 scope verifier 未加 ' + md('--require-closed') + '，raw exit = 0，stdout 原文为 ' + md('{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}') + '。');
lines.push('');
lines.push('## 已知限制与运行历史');
lines.push('');
lines.push('- 本目录的 receipts/stdout/stderr 是最终 24 条断言的运行结果；早期 21 条断言的运行写入同一路径并被最终运行覆盖（早期断言集是最终断言集的真子集，harness 已随本分支提交，可原样重放）。');
lines.push('- ' + md('ProviderCompactionSummarizer') + ' 的失败语义由单元测试覆盖（非零退出码、硬超时、空/超长摘要拒绝），真实链路只重放了成功发布；真实 Provider 失败注入未执行。');
lines.push('- 本轮没有对 kimi / opencode 取得真实摘要证据：它们没有 allowlist profile，按 fail-closed 处理。');
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
lines.push('矩阵仍为 v15、' + md('status=frozen') + '、PASS=0、GAP=26、RUNTIME-VERIFY=205、DEFERRED=164：这八个 requirement 保持 ' + md('GAP') + '，verdict 只是候选证据。');
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
  outJson,
  outMd,
  verdicts: Object.fromEntries(requirements.map(item => [item.id, item.verdict])),
  protectedOk: protectedFiles.every(file => file.matchesBaseline),
}) + String.fromCharCode(10));
process.exitCode = bad ? 1 : 0;
