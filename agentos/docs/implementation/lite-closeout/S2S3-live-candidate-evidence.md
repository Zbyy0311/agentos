# S2/S3 真实 Provider 候选证据包（LITE-07-104 / LITE-07-103 / LITE-08-005～007）

本报告只记录候选证据，不能直接改变验收矩阵状态。5 个 requirement 的 verdict 只能取 `candidate-supported`、`insufficient-evidence` 或 `failed`；本轮没有执行 PASS 提升，也没有执行 `--require-closed`。

- baseline SHA：`d89137ccbf72ef75faca8c807de61fb972f356ff`
- 机器可读包：`docs/implementation/lite-closeout/S2S3-live-candidate-evidence.json`
- 模型口径：这些 gate 用明确指定的 OpenCode CLI 与路由模型（deepseek/deepseek-v4-flash）驱动 AgentOS 的 canonical Provider/Runtime 链；证据只证明该指定模型下的链，不证明机器默认模型或额度受限模型可用。
- 这些 requirement 的矩阵状态在本轮保持 `GAP`，verdict 只是候选证据。

| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |
| --- | --- | --- | --- | ---: |
| `LITE-07-104` | `完成的真实review/test Artifact触发` | `candidate-supported` | 7 total / 7 passed / 0 failed / 0 skipped | 0 |
| `LITE-07-103` | `接受的真实审批决定触发` | `candidate-supported` | 1 total / 1 passed / 0 failed / 0 skipped | 0 |
| `LITE-08-005` | `ASK_USER persists and pauses the Run` | `candidate-supported` | 3 total / 3 passed / 0 failed / 0 skipped | 0 |
| `LITE-08-006` | `concurrent approve/reject is idempotent` | `candidate-supported` | 1 total / 1 passed / 0 failed / 0 skipped | 0 |
| `LITE-08-007` | `stale and expired approvals cannot execute` | `candidate-supported` | 1 total / 1 passed / 0 failed / 0 skipped | 0 |

## 最终执行记录

```powershell
node --import tsx ../../scripts/verify-lite-s2s3-live-candidate-evidence.mjs --out E:\workspace\Multi-Agent-worktrees\agentos-lite-s67-evidence\agentos\docs\implementation\lite-closeout\evidence\s2s3-live-candidate-evidence-20260914 --opencode-cli <opencode.exe> --model deepseek/deepseek-v4-flash
```

raw exit = `0`；receipts 统计 `13 total / 13 passed / 0 failed / 0 skipped`。

| 日志 / 收据 | bytes | SHA-256 |
| --- | ---: | --- |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/receipts.json` | 19395 | `e28632a68339ae73a33380fcde9a609f258c7a925566243887aaaa4789d5eeb1` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/stdout.txt` | 103 | `336b63e8d3d7476082bdfdddf0233732ea95a662120f225dd2f4f0179049bfc2` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/exit.txt` | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/scope-verifier.stdout.txt` | 93 | `c412198c0b3a31ba0bce0ce7a3d661de904524bc7082edd140be153a9d2eb5b1` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/scope-verifier.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/targeted-tests/targeted.stdout.txt` | 1894 | `e5c668bd57d8e55b92cf611c4c3bf6b918efd9801eed76e7934dce9f9bb4407d` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/targeted-tests/targeted.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/artifact-gate/stdout.txt` | 323 | `5f74f8a09adf5dc899cc80ce77ec9a0661ce350846a357ebc147a7f4d8e13ac1` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/artifact-gate/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/artifact-gate/exit.txt` | 1 | `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/approval-gate/stdout.txt` | 327 | `7795750e8f20b11b2ef0175b3c306a79d121c286006c45c03df5bb90f9c10f9c` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/approval-gate/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/approval-gate/exit.txt` | 1 | `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9` |

### 被驱动的 gate 调用

```json
{
  "artifact-gate": {
    "command": "node --import tsx --test --test-concurrency=1 src/services/run-engine/CanonicalArtifactResult.liveGate.test.ts",
    "exitCode": 0,
    "signal": null,
    "reusedFrom": "E:\\workspace\\Multi-Agent-worktrees\\agentos-lite-s67-evidence\\agentos\\docs\\implementation\\lite-closeout\\evidence\\s2s3-live-candidate-evidence-20260914\\artifact-gate",
    "stdoutBytes": 323,
    "stderrBytes": 0,
    "keptRoot": "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\agentos-live-artifact-Cm2eip",
    "testSummary": {
      "pass": 1,
      "fail": 0,
      "skipped": 0
    }
  },
  "approval-gate": {
    "command": "node --import tsx --test --test-concurrency=1 src/services/run-engine/RuntimeApprovalGate.liveGate.test.ts",
    "exitCode": 0,
    "signal": null,
    "reusedFrom": "E:\\workspace\\Multi-Agent-worktrees\\agentos-lite-s67-evidence\\agentos\\docs\\implementation\\lite-closeout\\evidence\\s2s3-live-candidate-evidence-20260914\\approval-gate",
    "stdoutBytes": 327,
    "stderrBytes": 0,
    "keptRoot": "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\agentos-live-approval-CGrnbn",
    "testSummary": {
      "pass": 1,
      "fail": 0,
      "skipped": 0
    }
  }
}
```

## `LITE-07-104`

matrix 原文为 `完成的真实review/test Artifact触发`；条款来源 `apps/server/src/services/ArtifactCompletionService.ts:70`，并引用：

- `agentos/docs/implementation/lite-closeout/S2-027-authorization.md:1` — 027 授权：Artifact + 完成事实 + 候选 + 事件原子提交
- `agentos/docs/implementation/lite-closeout/S2-artifact-evidence.md:1` — 既有组件级证据；本包补真实模型调用

- matrix 状态：`GAP`（workPackage `S2`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：真实review/test→持久完成→候选+事件→Review Queue→接受→Entry；不以手工POST作为闭环。
- 原始记录缺口（matrix `finding`）：保留基线反证：主线仅合并授权、原草稿无真实来源/事件。隔离提交02a50947已补显式退出证据、Collector及canonical结构化结果、027完成事实、事务候选/事件与审核来源链接；见S2-artifact-evidence.md。实际Node测试与页面审核已验证，但执行记录/Provider观察为夹具，真实模型调用、故障恢复及CI仍需验收，保持GAP。
- 生产入口（matrix `implementation`）：`apps/server/src/services/RuntimeArtifactService.ts`、`apps/server/src/services/RuntimeArtifactCollector.ts`、`apps/server/src/services/ConversationService.ts`、`apps/server/src/store/SqliteStore.ts`、`apps/server/src/services/ArtifactCompletionService.ts`、`apps/server/src/services/CanonicalArtifactResultService.ts`、`apps/web/src/components/memory/MemoryReviewQueue.tsx`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S2E-GATE-01` | `artifact`：the real-Provider artifact gate itself passed under its gated run | `{"exitCode":0,"signal":null,"testSummary":{"pass":1,"fail":0,"skipped":0}}` | `{"exitCode":0,"signal":null,"testSummary":{"pass":1,"fail":0,"skipped":0}}` | passed |
| `S2E-ARTIFACT-01` | `artifact`：a real review produced a canonical Artifact bound to the Run and a known Stage | `{"runStatus":"completed","allStagesCompleted":true,"artifactCount":3,"artifacts":[{"id":"3fb491df-951e-47d4-bac9-4f6b12845522","type":"review","runMatches":true,"provenance":"CANONICAL","stageKey":"codex_manager","summaryNonEmpty":true},{"id":"8e66877d-1e31-4e23-92af-04ea48455d57","type":"review","runMatches":true,"pro…` | `{"runStatus":"completed","allStagesCompleted":true,"artifactCount":3,"artifacts":[{"id":"3fb491df-951e-47d4-bac9-4f6b12845522","type":"review","runMatches":true,"provenance":"CANONICAL","stageKey":"co…` | passed |
| `S2E-COMPLETION-01` | `artifact`：every Artifact reached exactly one type-matched terminal completion from the canonical seam | `{"completions":3,"oneCompletionPerArtifact":true,"coveredArtifacts":["3fb491df-951e-47d4-bac9-4f6b12845522","8e66877d-1e31-4e23-92af-04ea48455d57","eeb6cf53-599f-4eb1-9c6f-f8eda2f492dd"],"types":["review","review","review"],"conclusionMatchesType":true,"fromCanonicalSeam":true}` | `{"completions":3,"oneCompletionPerArtifact":true,"coveredArtifacts":["3fb491df-951e-47d4-bac9-4f6b12845522","8e66877d-1e31-4e23-92af-04ea48455d57","eeb6cf53-599f-4eb1-9c6f-f8eda2f492dd"],"types":["rev…` | passed |
| `S2E-CANDIDATE-01` | `artifact`：each completion produced a review-required Candidate that cites the Artifact as its source | `{"candidateCount":3,"candidates":[{"id":"mcand_01M2G0A05ZKEYP7PDMASY8X8RE","scope":"workspace","category":"decision","authority":"agent-derived","decision":"review-required","citesArtifact":true},{"id":"mcand_01M2G0ABAX9ZSTQ0D8YYRNHTDH","scope":"workspace","category":"decision","authority":"agent-derived","decision":"r…` | `{"candidateCount":3,"candidates":[{"id":"mcand_01M2G0A05ZKEYP7PDMASY8X8RE","scope":"workspace","category":"decision","authority":"agent-derived","decision":"review-required","citesArtifact":true},{"id…` | passed |
| `S2E-EVENT-01` | `artifact`：each completion Candidate became a canonical Runtime Event with exactly one Outbox handoff | `{"eventTypes":["memory.candidate_created"],"eventCandidates":["mcand_01M2G0A05ZKEYP7PDMASY8X8RE","mcand_01M2G0ABAX9ZSTQ0D8YYRNHTDH","mcand_01M2G0B381YNGX43JR6KFWQ3RV","mcand_terminal_run_live_artifact"],"completionCandidates":["mcand_01M2G0A05ZKEYP7PDMASY8X8RE","mcand_01M2G0ABAX9ZSTQ0D8YYRNHTDH","mcand_01M2G0B381YNGX43…` | `{"eventTypes":["memory.candidate_created"],"eventCandidates":["mcand_01M2G0A05ZKEYP7PDMASY8X8RE","mcand_01M2G0ABAX9ZSTQ0D8YYRNHTDH","mcand_01M2G0B381YNGX43JR6KFWQ3RV","mcand_terminal_run_live_artifact…` | passed |
| `S2E-ENTRY-01` | `artifact`：accepting the Candidate promoted a durable Entry that keeps the Artifact provenance | `{"acceptedCandidates":["mcand_01M2G0A05ZKEYP7PDMASY8X8RE"],"entryCount":1,"entryIds":["mcand_01M2G0A05ZKEYP7PDMASY8X8RE"],"entriesMatchAccepted":true,"contentsNonEmpty":true,"artifactProvenanceKept":true,"entrySourceKinds":["artifact","run"]}` | `{"acceptedCandidates":["mcand_01M2G0A05ZKEYP7PDMASY8X8RE"],"entryCount":1,"entryIds":["mcand_01M2G0A05ZKEYP7PDMASY8X8RE"],"entriesMatchAccepted":true,"contentsNonEmpty":true,"artifactProvenanceKept":t…` | passed |
| `S2E-REVIEW-GATE-01` | `artifact`：only the reviewed Candidate was promoted; every unreviewed one stays review-required and unmapped | `{"artifactCandidates":3,"totalCandidates":4,"everyCandidateIsReviewRequired":true,"reviewedCandidateWasPromoted":true,"unreviewedCandidates":3,"unreviewedStayUnmapped":true,"acceptedCandidatePredatesNothing":true}` | `{"artifactCandidates":3,"totalCandidates":4,"everyCandidateIsReviewRequired":true,"reviewedCandidateWasPromoted":true,"unreviewedCandidates":3,"unreviewedStayUnmapped":true,"acceptedCandidatePredatesN…` | passed |

一次真实 Provider 运行（OpenCode CLI 1.17.11，deepseek/deepseek-v4-flash）跑完整条 canonical 链：4 个 Stage 全部 completed，产生 3 个 CANONICAL 来源的 review Artifact（分别落在 codex_manager / kimi_worker / codex_final_review 三个真实 Stage 上，摘要非空）；3 个 Artifact 各有一条来自 canonical result seam（`canonical-result:` 前缀）的完成记录，结论属于 review 词汇表（本次模型对带有真实缺陷的解析文件给出 changes_requested）；每个完成记录产生一个 workspace scope、decision 类、agent-derived、review-required 的候选，并引用其 Artifact 作为来源；每个候选都有对应的 canonical `memory.candidate_created` Runtime Event，且 Runtime Event 与 Outbox 行数相等（每事件恰好一次 handoff）；接受其中一个候选后产生持久 Memory Entry 且引用保留 Artifact provenance，其余候选保持 review-required 且未映射到 Entry。

未证明的相邻行为：证明的是这一条真实链与其持久事实，不证明 UI 渲染；Arifact 的结论值本身来自模型（本次为 changes_requested），本包只断言它属于类型词汇表而不是固定值；`M4_P4_REAL_ARTIFACT_GATE` 在 CI 上跳过，收据来自本地真实运行。

## `LITE-07-103`

matrix 原文为 `接受的真实审批决定触发`；条款来源 `apps/server/src/services/RuntimeApprovalGate.ts:120`，并引用：

- `agentos/docs/implementation/lite-closeout/S3-028-authorization.md:1` — 028 请求 / 026 决定 的冻结契约
- `apps/server/src/services/RuntimeApprovalGate.ts:267` — 接受决定后创建候选并返回 candidateId

- matrix 状态：`GAP`（workPackage `S3`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：真实审批→原Run行为→持久决定→唯一带来源候选+事件；deny不生成候选。
- 原始记录缺口（matrix `finding`）：保留基线反证：旧approval-decisions为独立入口。S3 ead3001b已在pre-spawn gate、028请求/026决定、approval.resolved Candidate Event和重放回滚上取得证据；真实Provider live调用及浏览器审批验收仍缺，保持GAP。
- 生产入口（matrix `implementation`）：`apps/server/src/routes/runtimeApprovals.ts`、`apps/server/src/services/RuntimeApprovalGate.ts`、`apps/server/src/store/RuntimeApprovalRepository.ts`、`apps/server/src/services/MemoryRuntimeEventEmitter.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S3E-DECISION-CANDIDATE-01` | `approval`：each accepted decision produced its own user-authority Candidate citing the Run and its resolution Event | `{"userAuthorityCandidates":2,"described":[{"scope":"workspace","category":"decision","authority":"user-explicit","outcome":"review-required","sourceKinds":["event","run"],"citesItsRun":true,"citesAResolutionEvent":true},{"scope":"workspace","category":"decision","authority":"user-explicit","outcome":"review-required","…` | `{"userAuthorityCandidates":2,"described":[{"scope":"workspace","category":"decision","authority":"user-explicit","outcome":"review-required","sourceKinds":["event","run"],"citesItsRun":true,"citesARes…` | passed |

同一真实调用里，两条被批准的决定各自产生一个 workspace scope、decision 类、user-explicit、review-required 的候选，且每个候选都引用它自己的 Run 与它自己的 resolution Event（两个不同的 event source id），并且这两个候选各有 canonical `memory.candidate_created` Event。决定触发的事实与决定记录一一对应，不存在把机器产生的事实写成用户权威的路径。

未证明的相邻行为：只覆盖 accept 分支的真实触发与来源；deny 不产生候选这一点由既有单元测试覆盖，本包未重放；候选进入长期 Memory 仍需审核（本包只证明候选与其来源）。

## `LITE-08-005`

matrix 原文为 `ASK_USER persists and pauses the Run`；条款来源 `apps/server/src/services/RuntimeApprovalGate.ts:199`，并引用：

- `apps/server/src/services/run-engine/RuntimeApprovalGate.liveGate.test.ts:212` — gate 断言：首次 drive 后 Run/Stage 为 waiting_approval、请求已持久、进程数为 0
- `apps/server/src/services/RuntimeApprovalGate.ts:44` — 生产 gate 实现

- matrix 状态：`GAP`（workPackage `S3`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：真实ASK_USER到持久决定、原Run恢复/拒绝；重启、决定竞争、过期/指纹变更可验证。
- 原始记录缺口（matrix `finding`）：S3已在真实协调器pre-spawn边界持久请求并使Run/Stage等待；批准后续跑原Run、重启扫描approved unconsumed、拒绝终止。实际Provider live调用与完整产品UI仍待验，保持GAP。
- 生产入口（matrix `implementation`）：`apps/server/src/routes/runtimeApprovals.ts`、`apps/server/src/services/RuntimeApprovalGate.ts`、`apps/server/src/store/RuntimeApprovalRepository.ts`、`apps/server/src/services/run-engine/StageExecutionCoordinator.ts`、`apps/server/src/services/run-engine/RunEngineProviderDispatcher.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S3E-GATE-01` | `approval`：the real-Provider approval gate itself passed under its gated run | `{"exitCode":0,"signal":null,"testSummary":{"pass":1,"fail":0,"skipped":0}}` | `{"exitCode":0,"signal":null,"testSummary":{"pass":1,"fail":0,"skipped":0}}` | passed |
| `S3E-REQUEST-01` | `approval`：the paused Run carries its own persisted request with frozen identities | `{"requestCount":2,"runsOnStage":["run_approved"],"stagesOnRequest":["stage_approved_2","stage_approved_3"],"statuses":["approved"],"resolutions":["approve_once"],"frozenIdentities":true,"snapshotsPersisted":true,"expiriesInFuture":true,"distinctActions":2}` | `{"requestCount":2,"runsOnStage":["run_approved"],"stagesOnRequest":["stage_approved_2","stage_approved_3"],"statuses":["approved"],"resolutions":["approve_once"],"frozenIdentities":true,"snapshotsPers…` | passed |
| `S3E-PROCESS-01` | `approval`：the authorized Run executed real provider processes while decision rows stay one per request | `{"providerProcesses":2,"processesPerRun":2,"distinctProcesses":2,"decisionRows":2,"decisions":["allow_once","allow_once"],"oneDecisionPerRequest":true,"runStatuses":["completed"],"stageStatuses":["completed"]}` | `{"providerProcesses":2,"processesPerRun":2,"distinctProcesses":2,"decisionRows":2,"decisions":["allow_once","allow_once"],"oneDecisionPerRequest":true,"runStatuses":["completed"],"stageStatuses":["com…` | passed |

真实运行结束时持久行显示：同一个 Run 下恰好两条请求，分别针对它在两个 write-capable Stage 上的动作（两个不同的 action fingerprint），两条都已 approved 且 resolution=approve_once，每条都带 64-hex 的 action/agent/provider/launch-plan 冻结哈希与非空请求快照，过期时间在未来；该 Run 真实执行了两个不同的 Provider 进程并最终 completed、所有 Stage completed；决定行恰好每请求一条。暂停早于进程创建、以及陈旧版本不能决定，由同一调用的 gate 断言覆盖。

未证明的相邻行为：本包从持久行重derive的是「请求/决定/进程/Run 的最终状态」；暂停与进程创建的先后顺序只在 gate 自身的断言里（同一次调用，exit 0），不是本包独立复算。

## `LITE-08-006`

matrix 原文为 `concurrent approve/reject is idempotent`；条款来源 `apps/server/src/services/RuntimeApprovalGate.ts:131`，并引用：

- `apps/server/src/migrations/migrations/026-mf2-approval-decision-persistence.ts:36` — approval_decisions 的不可改写触发器 APPROVAL_DECISION_IMMUTABLE
- `apps/server/src/services/RuntimeApprovalGate.ts:150` — 重放同一决定返回 replayed: true 并复用已提交的候选

- matrix 状态：`GAP`（workPackage `S3`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：真实ASK_USER到持久决定、原Run恢复/拒绝；重启、决定竞争、过期/指纹变更可验证。
- 原始记录缺口（matrix `finding`）：S3已验证版本CAS重放、路由重试收敛和Event失败整体回滚；真实并发HTTP竞争和live Provider证据仍需补齐，保持GAP。
- 生产入口（matrix `implementation`）：`apps/server/src/routes/runtimeApprovals.ts`、`apps/server/src/services/RuntimeApprovalGate.ts`、`apps/server/src/store/RuntimeApprovalRepository.ts`、`apps/server/src/services/run-engine/StageExecutionCoordinator.ts`、`apps/server/src/services/run-engine/RunEngineProviderDispatcher.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S3E-IDEMPOTENT-01` | `approval`：each resolved request keeps exactly one durable decision and that decision cannot be rewritten | `{"requests":2,"decisions":2,"perRequestDecisionCounts":[1,1],"everyRequestHasExactlyOneDecision":true,"distinctDecidedRequests":2,"distinctResolutions":1,"decisionsAreImmutable":true}` | `{"requests":2,"decisions":2,"perRequestDecisionCounts":[1,1],"everyRequestHasExactlyOneDecision":true,"distinctDecidedRequests":2,"distinctResolutions":1,"decisionsAreImmutable":true}` | passed |

持久层面：两个已解析请求各自恰好一条决定行（每请求决定数 = 1），决定所绑定的请求集合与请求集合一致，且 `approval_decisions_reject_update` 触发器存在并 RAISE `APPROVAL_DECISION_IMMUTABLE`，因此已提交的决定不能被改写；同一个决定重放时按已提交状态收敛（gate 断言 replayed=true 且候选 id 不变）。

未证明的相邻行为：并发竞争的真实 HTTP 竞争与重试收敛由 gate 断言与既有路由测试覆盖；本包从持久行证明的是「一请求一决定 + 决定不可改写」这一收敛目标的不变量，未重放并发请求流。

## `LITE-08-007`

matrix 原文为 `stale and expired approvals cannot execute`；条款来源 `apps/server/src/services/RuntimeApprovalGate.ts:228`，并引用：

- `apps/server/src/services/RuntimeApprovalGate.ts:108` — 过期在决定或新启动尝试时被惰性观察
- `agentos/docs/implementation/lite-closeout/S3-approval-live-evidence.md:1` — 过期语义（惰性、无 sweeper）的记录

- matrix 状态：`GAP`（workPackage `S3`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：真实ASK_USER到持久决定、原Run恢复/拒绝；重启、决定竞争、过期/指纹变更可验证。
- 原始记录缺口（matrix `finding`）：S3已验证持久过期、Launch Plan/Agent/Provider快照哈希漂移拒绝及一次性消费；跨进程时钟和live Provider验收仍缺，保持GAP。
- 生产入口（matrix `implementation`）：`apps/server/src/routes/runtimeApprovals.ts`、`apps/server/src/services/RuntimeApprovalGate.ts`、`apps/server/src/store/RuntimeApprovalRepository.ts`、`apps/server/src/services/run-engine/StageExecutionCoordinator.ts`、`apps/server/src/services/run-engine/RunEngineProviderDispatcher.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S3E-EXPIRY-01` | `approval`：an expired request records no decision, spawns nothing and keeps its paused attempt | `{"requests":[{"status":"expired","resolution":null,"frozen":true}],"decisions":0,"providerProcesses":0,"runStatuses":["waiting_approval"],"attemptStageStillWaiting":"waiting_approval","anyStageRunning":false,"stageStatuses":["completed","completed","pending","waiting_approval"]}` | `{"requests":[{"status":"expired","resolution":null,"frozen":true}],"decisions":0,"providerProcesses":0,"runStatuses":["waiting_approval"],"attemptStageStillWaiting":"waiting_approval","anyStageRunning…` | passed |

过期请求的持久行显示 status=expired、resolution=null、冻结哈希仍为 64-hex；该 workspace 里决定行 0 条、Provider 进程 0 个，Run 仍为 waiting_approval，被暂停的那个 Stage 仍为 waiting_approval，且没有任何 Stage 处于 running——也就是过期既没有执行也没有被静默改写。

未证明的相邻行为：过期是惰性观察的：本包证明「不执行、不记录决定、不改写 Run」，不证明 Run 自行终止（无 sweeper）；指纹/版本漂移的拒绝分支由 gate 断言，未在本包从持久行复算。

## targeted tests 与 scope verifier

受影响测试（S2 Artifact service/routes，3 个文件，`node --import tsx --test --test-concurrency=1`，在 `apps/server` 下执行）raw exit = 0，Node summary 为 `16 pass / 0 fail / 0 skipped`；普通 scope verifier 未加 `--require-closed`，raw exit = 0，stdout 原文为 `{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}`。两个 `*.liveGate.test.ts` 在 CI 上按环境跳过（无 Provider CLI），其真实运行收据由本包保存。

- gate 的 stdout/stderr/exit 是同一次真实调用的原始输出；本包的 per-clause receipt 是从该次调用保留的 durable store 副本重新读出的，不是事后重放。
- **已记录的 Provider 输出波动**：本会话较早的一次 artifact gate 调用失败于链入口之前（`PROVIDER_OUTPUT_INVALID: OpenCode produced no valid assistant output`，Run 变为 failed，没有伪造 Artifact）。该次运行的原始日志被后续调用覆盖，未保留为收据，因此这里作为观察记录而不是断言；保留收据的最终调用退出码为 0。
- 审批链的「暂停早于进程创建」「陈旧版本不能决定」「重放收敛」这类顺序性断言由 gate 自身在同一调用内断言（收据中的 gate 输出与 exit 0 是同一证据），本包从持久行只重derive最终状态。
- 指纹变更（动作/Launch Plan 漂移）拒绝分支由 gate 断言，持久行只保留冻结哈希，未在本包重放。
- 过期语义是惰性观察的：过期请求不会执行、不记录决定，但 Run 仍停在 waiting_approval，等操作者取消或要求新决定；这一点已在 S3-approval-live-evidence.md 记录。
- 通过审批链执行的 Run 还会产生一条终态 summary 候选（`mcand_terminal_*`，task scope、agent-derived），属于 LITE-07-102 的终态触发路径，本包只记录不改判。

## 矩阵保护

生成前后未修改 `pass-freeze.json` / `matrix.json` / `pass-evidence-audit.json`，未执行任何 promotion 脚本，也未执行 `--require-closed`。与 baseline blob 的 SHA-256 对比：

| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |
| --- | --- | --- | --- |
| `docs/implementation/lite-closeout/matrix.json` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | true |
| `docs/implementation/lite-closeout/pass-freeze.json` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | true |
| `docs/implementation/lite-closeout/pass-evidence-audit.json` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | true |

工作区 delta（`git status --porcelain=v1`）：

```text
?? agentos/docs/implementation/lite-closeout/S2S3-candidate-evidence.spec.json
?? agentos/docs/implementation/lite-closeout/evidence/s2s3-live-candidate-evidence-20260914/
?? agentos/scripts/assemble-lite-candidate-evidence.mjs
?? agentos/scripts/verify-lite-s2s3-live-candidate-evidence.mjs
```

