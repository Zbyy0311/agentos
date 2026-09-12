import { readFileSync, writeFileSync } from 'node:fs';
const matrixPath = 'docs/implementation/lite-closeout/matrix.json';
const evidencePath = 'docs/implementation/lite-closeout/evidence.json';
const baseline = 'ce5addbe';
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const byId = new Map(matrix.requirements.map(row => [row.id, row]));
const row = byId.get('LITE-09-108');
if (row === undefined) throw new Error('missing LITE-09-108');
row.state = 'PASS';
row.implementation = ['apps/server/src/services/ConversationCompactionService.ts', 'apps/server/src/services/ConversationCompactionTrigger.ts', 'apps/server/src/services/ConversationTurnDriver.ts', 'apps/server/src/routes/conversationRuntime.ts'];
row.tests = ['apps/server/src/services/CompactionContextApplication.test.ts', 'apps/server/src/services/ConversationCompactionService.test.ts', 'apps/server/src/services/ConversationCompactionTrigger.test.ts', 'apps/server/src/routes/conversationRuntime.compaction.test.ts'];
row.evidence = ['S6-LOCAL', 'S6-RETRY'];
row.evidenceBaseline = baseline;
row.finding = '硬预算分支：预算内继续并进入retry-pending（有界，重试上限1）；摘要+尾部超硬预算时在Provider调用前以TURN_DRIVER_COMPACTION_BUDGET_EXCEEDED失败、当前消息保留且不静默截断。显式重试接口 POST /conversations/:id/compactions/retry 复用同一评估：报告durable outcome(published/noop/retry-pending/failed)与blockedReason、任务状态、尝试次数与失败码，且不会伪造第二个任务。';
const byVersion = new Map();
for (const change of matrix.changes) byVersion.set(change.version, change);
byVersion.set(14, {
  version: 14,
  baseline,
  authority: 'Main-agent S6 explicit-retry slice within user-approved scope',
  reason: 'Add the explicit conversation-level compaction retry that reports durable state and blocked reasons; LITE-09-108 moves to PASS.',
  requirementIds: ['LITE-09-108'],
});
matrix.changes = [...byVersion.values()].sort((a, b) => a.version - b.version);
matrix.matrixVersion = Math.max(...matrix.changes.map(c => c.version));
for (const item of matrix.requirements) {
  if (item.state === 'PASS' && item.evidence.includes('S6-LOCAL')) item.evidenceBaseline = baseline;
}
writeFileSync(matrixPath, JSON.stringify(matrix, null, 2).replace(/\r?\n/g, '\n'));
const entries = JSON.parse(readFileSync(evidencePath, 'utf8'));
if (!entries.some(entry => entry.id === 'S6-RETRY')) {
  entries.push({
    id: 'S6-RETRY',
    baseline,
    kind: 'local-tests',
    command: 'node --import tsx --test --test-concurrency=1 src/services/ConversationCompactionTrigger.test.ts src/routes/conversationRuntime.compaction.test.ts',
    cwd: 'apps/server',
    environment: 'Windows Node24.18.0; real runtime router over real HTTP, deterministic Provider mock',
    result: { passed: 9, failed: 0, skipped: 0 },
    requirementIds: ['LITE-09-108'],
    limitation: 'Proves the retry contract (durable outcome, blocked reason, no fabricated task) and the over-budget block; it does not force a real summary failure over a real Provider.',
  });
}
writeFileSync(evidencePath, JSON.stringify(entries, null, 2).replace(/\r?\n/g, '\n'));
console.log('matrixVersion=' + matrix.matrixVersion);
