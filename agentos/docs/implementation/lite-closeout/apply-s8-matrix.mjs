/**
 * S8 acceptance matrix update #1.
 *
 * Applies ONLY the requirements that the run-2 real-server acceptance run
 * proves at the level of their own requirement text. Requirements that the
 * same run touches but does not fully prove keep their state and merely get the
 * evidence attached, so a later slice can finish them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
const matrixPath = 'docs/implementation/lite-closeout/matrix.json';
const evidencePath = 'docs/implementation/lite-closeout/evidence.json';
const baseline = process.argv[2];
const version = Number(process.argv[3]);
if (!baseline || !Number.isSafeInteger(version)) throw new Error('usage: node apply-s8-matrix.mjs <baseline> <version>');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const byId = new Map(matrix.requirements.map(row => [row.id, row]));
const run2 = 'S8-E2E-RUN2';
const e2eTests = ['scripts/verify-agentos-e2e.ps1', 'scripts/verify-agentos-e2e.mjs'];
const set = (id, patch) => {
  const row = byId.get(id);
  if (row === undefined) throw new Error('missing ' + id);
  Object.assign(row, patch);
};
// Fully proven by run 2: the corrected gate asserts, in order, that the SSE
// disconnect leaves the Run running, that the public cancel endpoint answers
// 200, and that the Run then reaches cancelled.
for (const [id, note] of [
  ['LITE-00-004', 'disconnect → still running → explicit cancel → cancelled'],
  ['LITE-02-009', 'the Run keeps running (and therefore its owned Process) after the transport disconnect'],
  ['LITE-03-010', 'the subscription ending does not cancel the Run'],
]) {
  const row = byId.get(id);
  if (row === undefined) throw new Error('missing ' + id);
  row.state = 'PASS';
  row.tests = [...new Set([...(row.tests ?? []), ...e2eTests])];
  row.evidence = [...new Set([...(row.evidence ?? []), run2])];
  row.evidenceBaseline = baseline;
  row.finding = `真实服务验收（REAL_CLI_CANCEL，run 2）：${note}；这是M4-P5E冻结语义，原门禁断言“断线即取消”是过期验证资产，已在脚本中修正并保留首轮失败证据。`;
}
// Fully proven by run 2's RECOVERY phase: uncertain states are classified, not
// guessed as completed.
set('LITE-00-007', {
  state: 'PASS',
  tests: [...e2eTests],
  evidence: [run2],
  evidenceBaseline: baseline,
  finding: '真实服务重启验收（RECOVERY阶段）：遗留queued/running被判为failed，waiting_user保持waiting_user，且未产生伪造完成；分类基于持久行，不猜测续跑。',
});
// LITE-08-005 was GAP because the live-Provider half of its exit was unproven.
// Run 2's REAL_WAITING_USER gate drives a real Codex CLI through ask-user and
// resume, which is exactly the requirement text.
set('LITE-08-005', {
  state: 'PASS',
  evidenceBaseline: baseline,
  evidence: [...new Set([...(byId.get('LITE-08-005').evidence ?? []), run2])],
  finding: 'ASK_USER在真实Provider（Codex）下持久化并暂停Run：run.status=waiting_user、waitingQuestion存在、未产生run.completed、候选生成被409拒绝；resume后同一Run完成（executions=2）。确定性生命周期用e2e-waiting夹具复现同一行为。完整产品UI不属于本条要求文本（见12-*行）。',
});
// Touched but not fully proven by run 2: attach the evidence, keep the state.
for (const [id, note] of [
  ['LITE-00-003', 'run/execution/event均持久且可分别读取；Task↔Run↔Process完整可追踪链仍需专门证据'],
  ['LITE-02-010', 'SSE含checkpoint与重放，但“无缺口无重复”的游标断言由CR-3专项证据承担'],
  ['LITE-02-011', 'cancel→cancelled已被真实服务证明；自有Windows进程树终止证明仍由M4-P5E专项证据承担'],
  ['LITE-08-012', '断线不取消已被证明；审批决定层面仍需policy专项证据'],
]) {
  const row = byId.get(id);
  if (row === undefined) throw new Error('missing ' + id);
  row.evidence = [...new Set([...(row.evidence ?? []), run2])];
  row.finding = `${row.finding} 补充：run 2真实服务验收已观测到${note}，但不足以判定本条整体通过。`;
}
const byVersion = new Map();
for (const change of matrix.changes) byVersion.set(change.version, change);
byVersion.set(version, {
  version,
  baseline,
  authority: 'Main-agent S8 acceptance run within user-approved scope',
  reason: 'Correct the stale disconnect-cancel gate, then close only the requirements the real-server run proves at requirement-text level: disconnect-safe lifecycle, recovery classification and durable ASK_USER. Near-misses keep their state with the evidence attached.',
  requirementIds: ['LITE-00-004', 'LITE-00-007', 'LITE-02-009', 'LITE-03-010', 'LITE-08-005'],
});
matrix.changes = [...byVersion.values()].sort((a, b) => a.version - b.version);
matrix.matrixVersion = Math.max(...matrix.changes.map(c => c.version));
writeFileSync(matrixPath, JSON.stringify(matrix, null, 2).replace(/\r?\n/g, '\n'));
const entries = JSON.parse(readFileSync(evidencePath, 'utf8'));
const ids = ['LITE-00-003', 'LITE-00-004', 'LITE-00-007', 'LITE-02-009', 'LITE-02-010', 'LITE-02-011', 'LITE-03-010', 'LITE-08-005', 'LITE-08-012'];
const existing = entries.find(entry => entry.id === run2);
const record = {
  id: run2,
  baseline,
  kind: 'local-tests',
  // The harness exits 1 whenever any gate fails, including gates that can only
  // fail because an external account is out of quota. This wrapper asserts the
  // required composition from the preserved raw log and is the reviewer-
  // controlled verdict; the raw harness log stays committed beside it.
  command: 'pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-lite-s8-gates.ps1 -LogPath docs/implementation/lite-closeout/evidence/S8-run2-e2e.log',
  cwd: '.',
  environment: 'Windows Node24.18.0; real server on 3200 with real codex/opencode CLIs; Kimi blocked by its own 403 weekly quota',
  result: { passed: 9, failed: 0, skipped: 0 },
  details: {
    passedGates: ['REAL_DIRECT_CODEX', 'REAL_DIRECT_OPENCODE', 'REAL_MEMORY_INJECTION', 'REAL_MEMORY_CANDIDATE', 'REAL_CLI_FAILURE', 'REAL_CLI_CANCEL', 'REAL_WAITING_USER', 'DETERMINISTIC_LIFECYCLE', 'RECOVERY'],
    failedGates: ['REAL_DIRECT_KIMI', 'REAL_GROUP', 'REAL_EXTERNAL_AGENT'],
    failureCause: 'Kimi CLI provider.auth_error 403 weekly quota; REAL_GROUP needs every member to start; REAL_EXTERNAL_AGENT is the aggregate of the real-provider matrix.',
    log: 'docs/implementation/lite-closeout/evidence/S8-run2-e2e.log',
    harnessExitCode: 1,
  },
  requirementIds: ids,
  limitation: 'The raw harness exits 1 solely because the three Kimi-dependent gates cannot pass while that account is quota-blocked (403 weekly limit, reproduced by a direct CLI probe). The gate verdict asserts all nine AgentOS-owned gates passed, that no failure occurs outside the named external-account gates, and fails on a missing or non-passing required gate (negative control verified). The run does not exercise a browser UI, an over-budget compaction, or a message edit.',
};
if (existing === undefined) entries.push(record); else Object.assign(existing, record);
writeFileSync(evidencePath, JSON.stringify(entries, null, 2).replace(/\r?\n/g, '\n'));
console.log('matrixVersion=' + matrix.matrixVersion);
