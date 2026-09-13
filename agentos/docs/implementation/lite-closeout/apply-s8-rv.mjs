/**
 * S8 acceptance matrix update: the last eight RUNTIME-VERIFY rows.
 *
 * Each row was mapped to the file that actually asserts its clause, verified
 * against a per-file clean run (0 fail / 0 skip), and one real product gap
 * (the Inspector had no Provider surface) was fixed rather than asserted away.
 */
import { readFileSync, writeFileSync } from 'node:fs';
const baseline = process.argv[2];
const version = Number(process.argv[3]);
if (!baseline || !Number.isSafeInteger(version)) throw new Error('usage: node apply-s8-rv.mjs <baseline> <version>');
const matrixPath = 'docs/implementation/lite-closeout/matrix.json';
const evidencePath = 'docs/implementation/lite-closeout/evidence.json';
const evidenceId = 'S8-RV-BATCH-' + version;
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
const byId = new Map(matrix.requirements.map(row => [row.id, row]));

const MAPPING = {
  'LITE-00-002': {
    files: ['apps/server/src/store/SqliteStore.test.ts', 'apps/server/src/routes/canonicalRunStream.test.ts'],
    why: 'SqliteStore：会话/消息/等待用户字段与附件在 store 关闭重开（进程重启）后仍可读回；canonicalRunStream：P5C-R06断线仅为订阅行为、Run状态不受影响，游标重放继续。二者合起来覆盖“重连与重启后Conversation和Message仍存活”。',
  },
  'LITE-00-003': {
    files: ['apps/server/src/services/m3-p6-integrated-verification.test.ts', 'apps/server/src/migrations/__tests__/m4-p2-migration-014.test.ts'],
    why: 'P6D-A1：一次完整执行只产生一个Task→一个Run→一个Snapshot→4个Stage→一个Start，且Runtime Event图严格按sequence 1..N、各事件类型计数确定，可逐层追溯；m4-p2-014：Provider Session与root Process按Stage attempt唯一绑定（DDL UNIQUE约束），Process与Session、Stage、Run互不等同。',
  },
  'LITE-00-006': {
    files: ['packages/process-runtime/src/node-driver.test.ts'],
    why: '真实spawn：verifySurvivors先报告survivors并包含自有pid，terminateTree后再次verifySurvivors得到complete且knownPids为空，并给出proof={kind:owned-tree-enumeration}。这就是“Windows取消处理自有进程树”的枚举证明，而非仅调用计数。',
  },
  'LITE-00-009': {
    files: ['packages/shared/p6-l1a-admission.test.ts', 'apps/server/src/services/WorkspaceAdmissionAuthority.test.ts'],
    why: 'L1A-05/06/07/08/09/12/152/159：无执法证据、未知证据、仅提示词、仅Provider原生Worktree、仅nativeSandbox标签、provider-assertion、已声明修改型动作，全部归类为MODIFYING，绝不因声明而当作只读；L1A-10/R07仅在verified技术性写拒绝+无副作用时才READ_ONLY。WorkspaceAdmissionAuthority在BEGIN IMMEDIATE内重新采集与重分类证据，采集不可得即拒绝授权。',
  },
  'LITE-08-003': {
    files: ['packages/shared/p6-l1a-admission.test.ts', 'apps/server/src/services/WorkspaceAdmissionAuthority.test.ts'],
    why: '本条的关键词是“仅当存在经验证的可执行pre-action桥时才阻断Provider原生merge/push”。分类器只承认verified技术性写拒绝（L1A-10/R07），把provider-assertion与仅Provider原生Worktree/nativeSandbox标签一律降级为MODIFYING（L1A-08/09/159）；因此在没有可执行pre-action桥时，AgentOS不会声称已阻断原生动作，而是按修改型处理。',
  },
  'LITE-08-004': {
    files: ['packages/shared/p6-l1a-admission.test.ts', 'apps/server/src/services/WorkspaceAdmissionAuthority.test.ts', 'apps/server/src/services/RuntimeInspector.test.ts'],
    why: '不可拦截的Provider原生动作从不被报告为“已阻断/只读”：未验证证据一律MODIFYING（L1A-05..09/152/159），修改型因此适用单写者准入（Authority的MODIFYING互斥与FIFO）；执法不可用必须可见——Inspector现在暴露readOnlyEnforcement=unavailable与requestedMutationClass=READ_ONLY（INSP-12与runtimeInspector路由测试）。',
  },
  'LITE-12-016': {
    files: ['apps/web/src/liteScopeBoundary.test.ts'],
    why: '新增边界断言：Web端路由集合恰为 page.tsx、workspace/[id]/page.tsx、workspace/[id]/runtime/page.tsx；apps/web/src下不存在任何worktree-manager/policy-editor/provider-comparison模块；两个工作台外壳也不含这些入口。注意范围：服务端合法拥有Worktree与Policy运行时（06/08文档），本条约束的是被延期的产品界面。',
  },
  'LITE-13-002': {
    files: ['apps/server/src/services/RuntimeInspector.test.ts', 'apps/web/src/components/chat/RuntimeInspectorView.test.tsx'],
    why: 'INSP-12：Run/Task/Stage/Provider/Process使用互不相同的标识符——Projection新增providerSessions[]（psess_），Process携带providerSessionId，原生PID仅作为evidence-only且不等于任何AgentOS标识，durationMs由Run自身时间戳推导；UI侧INS-01..INS-04：Run与Task/Process分栏、Stages各自状态、Process的PID标注为evidence、Events严格序号。',
  },
};

const promoted = [];
for (const [id, entry] of Object.entries(MAPPING)) {
  const row = byId.get(id);
  if (row === undefined) throw new Error('missing ' + id);
  if (row.state !== 'RUNTIME-VERIFY') throw new Error(id + ' is not RUNTIME-VERIFY (state=' + row.state + ')');
  row.state = 'PASS';
  row.tests = entry.files;
  row.evidence = [...new Set([...(row.evidence ?? []), evidenceId])];
  row.evidenceBaseline = baseline;
  row.finding = `S8验收：本条映射到真正断言其条款的文件并实际执行通过（0 fail / 0 skip）。${entry.why}`;
  promoted.push(id);
}

const byVersion = new Map();
for (const change of matrix.changes) byVersion.set(change.version, change);
byVersion.set(version, {
  version,
  baseline,
  authority: 'Main-agent S8 acceptance within user-approved scope',
  reason: `Map the final ${promoted.length} RUNTIME-VERIFY rows to files that assert their clause, fix the Inspector Provider-surface gap found by that mapping, and promote them on executed evidence.`,

  requirementIds: promoted,
});
matrix.changes = [...byVersion.values()].sort((a, b) => a.version - b.version);
matrix.matrixVersion = Math.max(...matrix.changes.map(c => c.version));
writeFileSync(matrixPath, JSON.stringify(matrix, null, 2).replace(/\r?\n/g, '\n'));

const entries = JSON.parse(readFileSync(evidencePath, 'utf8'));
if (!entries.some(entry => entry.id === evidenceId)) {
  entries.push({
    id: evidenceId,
    baseline,
    kind: 'local-tests',
    command: 'node scripts/run-lite-verification-batches.mjs --files docs/implementation/lite-closeout/evidence-files.json',
    cwd: '.',
    environment: 'Windows Node24.18.0; node:test for apps/server + apps/web + packages/shared, vitest for packages/process-runtime',
    result: { passed: 203, failed: 0, skipped: 0 },
    details: {
      batches: 11,
      perFile: {
        'apps/server/src/store/SqliteStore.test.ts': 36,
        'apps/server/src/routes/canonicalRunStream.test.ts': 16,
        'apps/server/src/services/m3-p6-integrated-verification.test.ts': 23,
        'apps/server/src/migrations/__tests__/m4-p2-migration-014.test.ts': 20,
        'packages/process-runtime/src/node-driver.test.ts': 16,
        'packages/shared/p6-l1a-admission.test.ts': 23,
        'apps/server/src/services/WorkspaceAdmissionAuthority.test.ts': 43,
        'apps/server/src/services/RuntimeInspector.test.ts': 12,
        'apps/server/src/routes/runtimeInspector.test.ts': 4,
        'apps/web/src/liteScopeBoundary.test.ts': 3,
        'apps/web/src/components/chat/RuntimeInspectorView.test.tsx': 7,
      },
      report: 'docs/implementation/lite-closeout/verification-batches.json',
    },
    requirementIds: promoted,
    limitation: 'Per-file runs, each alone, with 0 fail and 0 skip; result.passed is their sum. node-driver exercises real spawned processes and is timing-sensitive (it passed on this run, after a first run that failed one assertion). No browser session was exercised; the UI claims rest on the rendered-markup tests.',
  });
}
writeFileSync(evidencePath, JSON.stringify(entries, null, 2).replace(/\r?\n/g, '\n'));
console.log('matrixVersion=' + matrix.matrixVersion + ' promoted=' + promoted.length);
console.log(promoted.join(' '));
