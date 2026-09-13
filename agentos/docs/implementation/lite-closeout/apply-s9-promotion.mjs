/**
 * S9 promotion batch: close the four rows whose implementation is already on the
 * target revision and which therefore needed executed evidence and a pointer,
 * not new code.
 *
 * Usage: node apply-s9-promotion.mjs <baseline-sha>
 *
 * Every cited evidence entry is a command that was actually run at <baseline-sha>
 * and re-runs on any checkout of it. Counter-evidence that justified the earlier
 * GAP state (a failing run, or a source audit with no executed result) is NOT kept
 * in `evidence`: the scope gate reads `evidence` as executed proof for a PASS row.
 * That history stays where it belongs, in the row's `finding` text and in the
 * evidence entries themselves, which are left in place.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const baseline = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(baseline ?? '')) {
  throw new Error('usage: node apply-s9-promotion.mjs <40-char-baseline-sha>');
}

const matrixPath = 'docs/implementation/lite-closeout/matrix.json';
const evidencePath = 'docs/implementation/lite-closeout/evidence.json';

const GENERATION = 'apps/server/src/services/MemoryCandidateGenerationService.test.ts';
const EMISSION = 'apps/server/src/services/MemoryCandidateGenerationService.emission.test.ts';
const RECONCILER = 'apps/server/src/services/TerminalMemoryCandidateReconciler.test.ts';
const BUDGET = 'apps/server/src/services/MemoryContextBudgetSelector.test.ts';

const NEW_EVIDENCE = [
  {
    id: 'S9-PROMOTION-DEDUP',
    baseline,
    kind: 'local-tests',
    cwd: 'apps/server',
    command: `node --import tsx --test ${GENERATION} ${EMISSION}`,
    environment: 'Windows Node 24.18.0; merged main after the S1 slices',
    result: { tests: 27, passed: 27, failed: 0, skipped: 0 },
    requirementIds: ['LITE-07-003', 'LITE-07-107'],
    limitation: 'Covers convergence and the audit trail on the terminal-outcome path: exact-content convergence adds the missing source once without rewriting the accepted Entry and stays a no-op on replay, near-duplicate detection (normalized hash and FTS) forces review-required instead of a silent merge, dedup is isolated by Scope/owner/category and by active status (another task, workspace scope, another category, archived and deleted all fail to converge), the dedup fact and its Outbox row commit together, and an archived match falling through to a Candidate is covered. Concurrency is exercised as the same-source replay and the lookup-versus-transaction window; it is not a multi-process stress test.',
  },
  {
    id: 'S9-PROMOTION-BUDGET',
    baseline,
    kind: 'local-tests',
    cwd: 'apps/server',
    command: `node --import tsx --test ${BUDGET}`,
    environment: 'Windows Node 24.18.0; merged main after the S1 slices',
    result: { tests: 13, passed: 13, failed: 0, skipped: 0 },
    requirementIds: ['LITE-07-007'],
    limitation: 'Covers all five budget dimensions on the persisted-selection path: the token budget prices the text that is actually injected (MF4B-02 deliberately carries a stale tokenEstimate to prove the stored estimate is not trusted), the entry budget caps the count, per-category and per-Scope limits exclude with their own reason codes, and requireDiversity prefers an unrepresented category, explains the exclusion as diversity-limit, and still fills the remaining capacity from deferred entries. Threshold, truncation and reproducibility behaviour are covered alongside. It does not cover the FTS-degradation half of the neighbouring row LITE-07-013, which remains open.',
  },
  {
    id: 'S9-PROMOTION-TERMINAL',
    baseline,
    kind: 'local-tests',
    cwd: 'apps/server',
    command: `node --import tsx --test ${GENERATION} ${RECONCILER}`,
    environment: 'Windows Node 24.18.0; merged main after the S1 slices',
    result: { tests: 20, passed: 20, failed: 0, skipped: 0 },
    requirementIds: ['LITE-07-102'],
    limitation: 'Covers every terminal Run outcome and the restart window: a completed Run produces the bounded review-required summary, a failed Run and a cancelled Run each produce a bounded failure fact carrying the failure code and message but never raw provider output, a still-running Run produces nothing, one deterministic id per Run keeps a replay convergent, and the startup sweep repairs a terminal Run whose Candidate was lost to a crash using the Run own persisted terminal Event as causation (a terminal Run with no such Event is reported and skipped, a throwing generator is contained, and the sweep is bounded per Workspace). Stage-level terminal status alone is deliberately not a trigger. Explicit-cancellation acceptance lands in the operation layer rather than the dispatcher, so that path is covered by the sweep rather than in-process.',
  },
];

const PROMOTION = {
  'LITE-07-003': {
    tests: [GENERATION, EMISSION],
    evidence: ['S9-PROMOTION-DEDUP'],
    finding: '已闭合：同 Scope/owner/category 且处于 active 的精确重复会原子汇聚缺失来源与规范事件（去重事实与 Outbox 同事务），重放零新增；另一 task、workspace scope、另一 category、archived 与 deleted 均不错误汇聚；近似重复（normalized hash 与 FTS）一律 review-required 而不静默合并。此前的 GAP 反证（S1A-RED 的失败运行与 S1D-SOURCE 的源码审计）按门禁规则不得作为 PASS 依据，已不再列入 evidence，保留为历史记录。',
    exit: '已完成（证据 S9-PROMOTION-DEDUP）：27 项断言在本基线全绿、0 失败、0 跳过；并发维度以同源重放与查找-事务窗口覆盖，未做多进程压力测试。',
  },
  'LITE-07-107': {
    tests: [GENERATION, EMISSION],
    evidence: ['S9-PROMOTION-DEDUP'],
    finding: '已闭合：按 Scope/owner/category 与稳定来源去重，同源来源合并保留审计证据（去重事实+Outbox 同事务、重放零新增），跨 Run 的授权被拒绝且不合并来源，归档命中在查找与事务之间发生时回退为待审核 Candidate 而不是丢失事实。',
    exit: '已完成（证据 S9-PROMOTION-DEDUP）：27 项断言在本基线全绿、0 失败、0 跳过；来源保留与拒绝分支均有具名断言。',
  },
  'LITE-07-007': {
    tests: [BUDGET, 'apps/server/src/services/MemoryRetrievalService.test.ts'],
    evidence: ['S9-PROMOTION-BUDGET'],
    finding: '已闭合：五个预算维度都被真实执行断言——token 预算按实际注入文本计价（不再信任存储的 tokenEstimate）、条目数上限、分类上限、Scope 上限各自给出正确的排除原因码，requireDiversity 优先未被代表的分类、以 diversity-limit 解释排除，并用被推迟条目填满剩余容量。此前的 S1C-SOURCE 为无执行结果的源码审计，不得作为 PASS 依据，已不再列入 evidence。',
    exit: '已完成（证据 S9-PROMOTION-BUDGET）：13 项断言在本基线全绿、0 失败、0 跳过。相邻条 LITE-07-013（FTS 降级可见性）仍独立开放。',
  },
  'LITE-07-102': {
    tests: [GENERATION, RECONCILER],
    evidence: ['S9-PROMOTION-TERMINAL'],
    finding: '已闭合：终态覆盖 completed/failed/cancelled 三种；非成功终态生成有界失败事实（仅状态、失败码与消息、Stage 结果，绝不含原始模型输出），未终结 Run 不生成，每 Run 一个确定 id 使重放收敛；崩溃窗口由启动扫描用该 Run 自己持久化的终态 Runtime Event 作为因果修复，无该事件时报出并跳过而不伪造，生成器抛错被隔离且扫描按 Workspace 有界。',
    exit: '已完成（证据 S9-PROMOTION-TERMINAL）：20 项断言在本基线全绿、0 失败、0 跳过；显式取消的进程内验收位于 operation 层，由启动扫描覆盖并在证据 limitation 中说明。',
  },
};

const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const byId = new Map(matrix.requirements.map(row => [row.id, row]));
const promoted = [];
for (const [id, patch] of Object.entries(PROMOTION)) {
  const row = byId.get(id);
  if (!row) throw new Error('missing matrix row ' + id);
  if (row.state !== 'GAP') throw new Error(`expected ${id} to be GAP, found ${row.state}`);
  row.state = 'PASS';
  row.tests = patch.tests;
  row.evidence = patch.evidence;
  row.finding = patch.finding;
  row.exit = patch.exit;
  row.evidenceBaseline = baseline;
  promoted.push(id);
}

matrix.matrixVersion = Number(matrix.matrixVersion) + 1;
matrix.changes.push({
  version: matrix.matrixVersion,
  baseline,
  authority: 'Main-agent S9 promotion within the user-approved tightened plan',
  reason: 'Promote LITE-07-003, LITE-07-007, LITE-07-102 and LITE-07-107: their implementation is already on this revision, so each is closed with executed evidence at this baseline and a pointer to the files that assert it, replacing counter-evidence pointers that a PASS row may not cite.',
  requirementIds: promoted,
});

const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
for (const entry of NEW_EVIDENCE) {
  if (evidence.some(existing => existing.id === entry.id)) throw new Error('duplicate evidence id ' + entry.id);
  evidence.push(entry);
}

writeFileSync(matrixPath, JSON.stringify(matrix, null, 2) + '\n');
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ promoted, matrixVersion: matrix.matrixVersion, evidence: NEW_EVIDENCE.map(entry => entry.id) }));
