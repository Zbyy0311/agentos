import { readFileSync, writeFileSync } from 'node:fs';
const matrixPath = 'docs/implementation/lite-closeout/matrix.json';
const evidencePath = 'docs/implementation/lite-closeout/evidence.json';
const baseline = process.argv[2];
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const byId = new Map(matrix.requirements.map(row => [row.id, row]));
const set = (id, patch) => {
  const row = byId.get(id);
  if (row === undefined) throw new Error('missing ' + id);
  Object.assign(row, patch);
};
const impl = [
  'apps/server/src/services/ConversationCompactionService.ts',
  'apps/server/src/services/ConversationCompactionTrigger.ts',
  'apps/server/src/services/ProviderCompactionSummarizer.ts',
  'apps/server/src/services/summarizationCliProfiles.ts',
  'apps/server/src/services/ConversationTurnDriver.ts',
  'apps/server/src/store/CompactionRepository.ts',
  'apps/server/src/routes/conversationRuntime.ts',
];
const tests = [
  'apps/server/src/services/ConversationCompactionService.test.ts',
  'apps/server/src/services/ConversationCompactionTrigger.test.ts',
  'apps/server/src/services/ProviderCompactionSummarizer.test.ts',
  'apps/server/src/services/CompactionContextApplication.test.ts',
  'apps/server/src/store/CompactionRepository.test.ts',
  'apps/server/src/routes/conversationCompactionInspector.test.ts',
  'apps/server/src/routes/conversationRuntime.compaction.test.ts',
  'scripts/verify-compaction-real-summary.mjs',
];
const evidence = ['S6-LOCAL', 'S6-REAL-SUMMARY', 'S6-TRIGGER-INTEGRATION'];
set('LITE-07-105', {
  state: 'PASS', implementation: impl, tests, evidence,
  finding: '真实触发：Turn组装前评估阈值，publish在一次事务内写入有界摘要+review-required候选+workspace事件（correlation=memory-compaction:<taskId>）。真实Provider运行与真实HTTP Turn均验证；摘要可用不等于Memory审核，候选保持待审核。',
});
set('LITE-09-104', {
  state: 'PASS', implementation: impl, tests, evidence,
  finding: 'lite-v1作为不可变版本行持久化（0.70/0.50/8/2048/120000/1+16384回退），每次压缩记录预算组成、上限来源与estimator版本（lite-v1-chars4）；真实运行与真实HTTP Inspector均读到同一策略，历史不被后续策略改写。',
});
set('LITE-09-105', {
  state: 'PASS', implementation: impl, tests, evidence,
  finding: '真实HTTP路径证明：只压缩有界旧前缀（10条中2条），原消息保留（status<>deleted计数不变），触发它的同一Turn即为采用者（snapshot budget记录compactionSummaryId与summarizedMessages），frozen history = 摘要+未压缩尾部，已被覆盖的消息不再重发。',
});
set('LITE-09-106', {
  state: 'PASS', implementation: impl, tests, evidence,
  finding: '真实Codex CLI产生摘要（verify-compaction-real-summary: passed, model=gpt-5.6-luna, adapter=cli.codex@1.0.0）。身份与模型在触发时冻结并落库；缺失profile、身份漂移、空模型、缺CLI级只读沙箱、出现任何tool.*/approval事件、超时、非零退出均fail-closed。修复了“只读仅靠提示词”的真实缺陷。',
});
set('LITE-09-110', {
  state: 'PASS', implementation: impl, tests, evidence,
  finding: '来源审计：生产代码中没有任何路径读取Provider原生压缩作为canonical证据；canonical摘要只能由CompactionRepository.publishWithinTransaction发布，Inspector只读AgentOS持久化的policy/budget/source/summary/snapshot。',
});
set('LITE-13-101', {
  state: 'PASS', implementation: impl, tests, evidence,
  finding: 'Inspector同时回答“为何触发”（策略版本、触发/目标比例、预算组成与上限来源、来源范围与条数、estimator版本、尝试与失败码）与“被谁采用”（adoptions：summaryId→turnId→snapshotId，且与turn.context_snapshot_id一致），未采用的摘要明确报告为未采用。',
});
set('LITE-09-107', {
  state: 'GAP', implementation: impl, tests, evidence: ['S6-LOCAL', 'S6-TRIGGER-INTEGRATION'],
  finding: '单Conversation唯一running（部分唯一索引）+租约+版本CAS+重试上限1+稳定失败已具备，真实HTTP重复轮次收敛为1个任务；但“重启后先判断旧执行状态再恢复”尚无真实重启场景证据，保持GAP。',
});
set('LITE-09-108', {
  state: 'GAP', implementation: impl, tests, evidence: ['S6-LOCAL'],
  finding: '已实现并测试：预算内继续并进入retry-pending；摘要+尾部超硬预算时在任何Provider调用前以TURN_DRIVER_COMPACTION_BUDGET_EXCEEDED失败且不截断消息。规范要求的“显式重试”接口尚未提供（当前依赖下一轮自动触发），保持GAP。',
});
set('LITE-09-109', {
  state: 'GAP', implementation: impl, tests, evidence: ['S6-LOCAL'],
  finding: '复用现有消息可见性与内容修订/哈希：来源锚点缺失时不再复用旧摘要作为前缀，改为按全文重算，历史快照不变；未新增编辑API或versioning。真实编辑场景（canonical message被编辑后摘要失效）仍待S8实测，保持GAP。',
});
matrix.matrixVersion = 12;
matrix.changes.push({
  version: 12,
  baseline,
  authority: 'Main-agent S6 implementation and real-Provider verification within user-approved scope',
  reason: 'Production-wire the automatic compaction trigger and a real Provider summary channel, then close the requirements proven by a real Codex run plus real-HTTP Turn adoption; restart recovery, explicit retry and a real message-edit scenario remain GAP.',
  requirementIds: ['LITE-07-105', 'LITE-09-104', 'LITE-09-105', 'LITE-09-106', 'LITE-09-107', 'LITE-09-108', 'LITE-09-109', 'LITE-09-110', 'LITE-13-101'],
});
writeFileSync(matrixPath, JSON.stringify(matrix, null, 2).replace(/\r?\n/g, '\n'));

const entries = JSON.parse(readFileSync(evidencePath, 'utf8'));
const head = '69d12243';
const push = entry => { if (!entries.some(item => item.id === entry.id)) entries.push(entry); };
push({
  id: 'S6-REAL-SUMMARY',
  baseline,
  kind: 'real-provider',
  command: 'node --import tsx ../../scripts/verify-compaction-real-summary.mjs',
  cwd: 'apps/server',
  environment: 'Windows Node24.18.0; real Codex CLI (gpt-5.6-luna) under --sandbox read-only in an isolated scratch directory',
  result: { outcome: 'published', firstRunMs: 15124, repeatMs: 1, summaryChars: 209, sourceMessages: 4, tasks: 1 },
  requirementIds: ['LITE-07-105', 'LITE-09-104', 'LITE-09-106'],
  limitation: 'Proves the real Provider summary path, the frozen identity, the read-only enforcement and convergence over the same source. It does not exercise a server restart, the over-budget failure branch, or a message edit.',
});
push({
  id: 'S6-TRIGGER-INTEGRATION',
  baseline,
  kind: 'local-tests',
  command: 'node --import tsx --test --test-concurrency=1 src/routes/conversationRuntime.compaction.test.ts src/routes/conversationCompactionInspector.test.ts',
  cwd: 'apps/server',
  environment: 'Windows Node24.18.0; real HTTP through createConversationRuntimeRoutes with AGENTOS_FORCE_MOCK for the Provider call only',
  result: { passed: 2, failed: 0, skipped: 0 },
  requirementIds: ['LITE-09-105', 'LITE-13-101'],
  limitation: 'The turn path is real (route, trigger, engine, store); the Provider output is the deterministic mock, so it proves wiring and application rather than Provider behaviour.',
});
writeFileSync(evidencePath, JSON.stringify(entries, null, 2).replace(/\r?\n/g, '\n'));
console.log('matrix v12 + evidence written; head=' + head);
