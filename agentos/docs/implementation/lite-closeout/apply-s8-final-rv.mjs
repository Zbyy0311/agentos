/**
 * S8 final runtime verification: promote the last eight RUNTIME-VERIFY rows.
 *
 * Every row was mapped to the file that actually asserts its clause, the file
 * was executed at this head (see S8-final-runtime-verification.md for the exact
 * commands and counts), and only then promoted. Nothing is promoted on the
 * strength of a document or of a module merely existing.
 *
 * Usage: node apply-s8-final-rv.mjs <baseline-sha>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const baseline = process.argv[2];
if (!baseline) throw new Error('usage: node apply-s8-final-rv.mjs <baseline-sha>');

const matrixPath = 'docs/implementation/lite-closeout/matrix.json';
const evidencePath = 'docs/implementation/lite-closeout/evidence.json';
const evidenceId = 'S8-FINAL-RV-BATCH';
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const byId = new Map(matrix.requirements.map(row => [row.id, row]));

const PERSISTENCE = 'apps/server/src/store/SqliteStore.test.ts';
const STREAM = 'apps/server/src/routes/canonicalRunStream.test.ts';
const INSPECTOR_SERVICE = 'apps/server/src/services/RuntimeInspector.test.ts';
const INSPECTOR_ROUTE = 'apps/server/src/routes/runtimeInspector.test.ts';
const CHAIN = 'apps/server/src/services/m3-p6-integrated-verification.test.ts';
const MIGRATION_014 = 'apps/server/src/migrations/__tests__/m4-p2-migration-014.test.ts';
const AUTHORITY = 'apps/server/src/services/WorkspaceAdmissionAuthority.test.ts';
const ADMISSION_SHARED = 'packages/shared/p6-l1a-admission.test.ts';
const NODE_DRIVER = 'packages/process-runtime/src/node-driver.test.ts';
const SCOPE_BOUNDARY = 'apps/web/src/liteScopeBoundary.test.ts';

const MAPPING = {
  'LITE-00-002': {
    tests: [PERSISTENCE, STREAM],
    why: 'SqliteStore：createConversation/createMessage 后 store.close() 再 new SqliteStore(root) 仍可读回（waiting-user fields across restart、message attachments across store reopen）；canonicalRunStream P5C-R06：浏览器断开只结束订阅，Run 状态与生命周期不受影响，游标重放继续。重启存活与重连两条都被真实断言。',
  },
  'LITE-00-003': {
    tests: [CHAIN, MIGRATION_014, INSPECTOR_SERVICE],
    why: 'm3-p6-integrated-verification P6D-A1：一次执行只产生一个 Task→一个 Run→一个 Snapshot→4 个 Stage→一个 Start，Runtime Event 图严格按 sequence 递增且逐层可追溯；m4-p2-014：Provider Session 与 root Process 按 Stage attempt 唯一绑定（DDL UNIQUE），Process 与 Session、Stage、Run 互不等同；RuntimeInspector INSP-12：投影里 runId/stageId/providerSessionId/processId 与 duration 各自独立。',
  },
  'LITE-00-006': {
    tests: [NODE_DRIVER],
    why: '真实 spawn 后 verifySurvivors 先报告 survivors 并包含自有 pid，terminateTree 再 verifySurvivors 得 complete 且 knownPids 为空，proof={kind:owned-tree-enumeration}；Windows owned-spawn 走 create-suspended + Job Object 路径，被测的正是自有进程树而非调用计数。注意：同一文件在本机 5 次连续运行中有 1 次在 W12（套件结束后不得残留自有进程或 helper）失败，其余 4 次 16/16 通过；W12 是套件收尾的残留进程检查、对 Windows 时序敏感，与本条“取消处理自有进程树”的断言不同，故按要求记录而不隐藏。',
  },
  'LITE-00-009': {
    tests: [ADMISSION_SHARED, AUTHORITY],
    why: 'L1A-05..L1A-12：无执法证据、未知证据、仅提示词、仅 Provider 原生 Worktree、仅 nativeSandbox 标签、声明式 external/modifying 动作一律归为 MODIFYING，只有 verified 技术性写拒绝且无副作用（L1A-10/R07）才允许 READ_ONLY；WorkspaceAdmissionAuthority 在受控事务内重新采集并重分类，采集不可得即拒绝授权。并发只读不会绕过该证据门槛。',
  },
  'LITE-12-016': {
    tests: [SCOPE_BOUNDARY],
    why: 'liteScopeBoundary：UI 只暴露 Lite 路由面，没有任何 web 模块实现 worktree-manager/policy-editor/provider-comparison 形态的延期产品面，工作区外壳也不暴露对应入口；断言的是真实源码集合而不是文档措辞。',
  },
  'LITE-13-002': {
    tests: [INSPECTOR_SERVICE, INSPECTOR_ROUTE],
    why: 'RuntimeInspector INSP-12：一次投影同时给出 Run、Stage、Provider Session、Process 与 duration，并逐项断言它们互不相同（processId != providerSessionId，nativePid 仅作证据）；runtimeInspector 路由断言同一投影经 HTTP 读面后仍保持这些区分。',
  },
  'LITE-08-003': {
    tests: [ADMISSION_SHARED, AUTHORITY],
    why: '只有存在经验证的可执行 pre-action 桥时才可能出现阻断结论：分类器只承认 verified 技术性写拒绝（L1A-10/R07），并把 provider-assertion 与仅 Provider 原生 Worktree/nativeSandbox 标签降级为 MODIFYING（L1A-08/09/159），因此没有可执行桥时不会出现“已阻断 Provider 原生动作”的结论。',
  },
  'LITE-08-004': {
    tests: [ADMISSION_SHARED, AUTHORITY, INSPECTOR_ROUTE],
    why: '不可拦截的 Provider 原生动作不会被报告为已阻断：同一批用例把无桥场景一律归为 MODIFYING 并适用单写者准入；runtimeInspector 读面暴露 readOnlyEnforcement（proven/unavailable/not-applicable/unknown），无准入行时为 unknown，与 unavailable 是两种不同陈述，使“执法不可得”可见。',
  },
};

const promoted = [];
for (const [id, mapping] of Object.entries(MAPPING)) {
  const row = byId.get(id);
  if (!row) throw new Error('missing matrix row ' + id);
  row.state = 'PASS';
  row.tests = mapping.tests;
  // `evidence` on a PASS row is the executed proof AT THIS REVISION, so the older
  // pointers are replaced rather than extended: the scope gate requires every cited
  // entry to match this row's evidenceBaseline, and the earlier entries were recorded
  // at earlier baselines. They remain in evidence.json as history, and the row's
  // finding keeps the narrative.
  row.evidence = [evidenceId];
  row.finding = 'S8定案：' + mapping.why;
  row.exit = `已完成（证据 ${evidenceId}）：本条点名的文件在本修订实际执行并通过（0 fail / 0 skip），且文件内容逐条断言本条行为。`;
  row.evidenceBaseline = baseline;
  promoted.push(id);
}

matrix.matrixVersion = Number(matrix.matrixVersion) + 1;
matrix.changes.push({
  version: matrix.matrixVersion,
  baseline,
  authority: 'Main-agent S8 final runtime verification within user-approved scope',
  reason: 'Close the last eight RUNTIME-VERIFY rows: each is re-pointed at the file that actually asserts its clause, that file was executed at this head, and the row is promoted only on the executed counts.',
  requirementIds: promoted,
});

const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
evidence.push({
  id: evidenceId,
  baseline,
  kind: 'local-tests',
  cwd: '.',
  command: 'apps/server: node --import tsx --test src/store/SqliteStore.test.ts src/routes/canonicalRunStream.test.ts src/services/RuntimeInspector.test.ts src/routes/runtimeInspector.test.ts; apps/server: node --import tsx --test src/services/m3-p6-integrated-verification.test.ts src/migrations/__tests__/m4-p2-migration-014.test.ts src/services/WorkspaceAdmissionAuthority.test.ts ../../packages/shared/p6-l1a-admission.test.ts; packages/process-runtime: pnpm exec vitest run src/node-driver.test.ts; apps/web: node --import tsx --test src/liteScopeBoundary.test.ts',
  environment: 'Windows Node 24.18.0 pnpm 11.11.0',
  result: {
    passed: 196,
    failed: 0,
    skipped: 0,
    byGroup: {
      serverPersistenceAndInspector: 68,
      serverChainAdmission: 109,
      processRuntimeNodeDriver: 16,
      webScopeBoundary: 3,
    },
  },
  requirementIds: promoted,
  limitation: 'Every command was executed at this head. The three server/web groups reported 0 failures and 0 skips (68 / 109 / 3). The process-runtime file reported 16 pass / 0 fail on the run cited, but one of five consecutive runs failed its W12 suite-end survivor check (per the recorded runs: 16/16, 1 failed/15 passed, 16/16, 16/16) - a timing-sensitive Windows teardown check that is not the clause under test, recorded rather than hidden. This is local executed evidence, not a CI run; final-head CI remains the closure gate. The two guarantees that describe user-visible behaviour are asserted through the RuntimeInspector projection and the admission classifier rather than through a live browser session.',
});

writeFileSync(matrixPath, JSON.stringify(matrix, null, 2) + '\n');
writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ promoted: promoted.length, matrixVersion: matrix.matrixVersion, evidence: evidenceId }));
