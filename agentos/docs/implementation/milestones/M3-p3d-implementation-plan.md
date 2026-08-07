# M3 P3D：Operation Control Surface 实施计划

> P3D-0 PREPLANNING：COMPLETE。
>
> P3D CONTRACT CLOSURE：OWNER APPROVED / DOCUMENTED。
>
> P3D-1：DEPENDENCY READY / NOT AUTHORIZED。
>
> P3D-2：CONTRACT READY / NOT AUTHORIZED / DEPENDS ON P3D-1 ACCEPTANCE。
>
> P3D-3：NOT AUTHORIZED / DEPENDS ON P3D-2。
>
> 计划基线：5bfa66d074791cb1e1981968f28c3854d7d55d2a。
>
> 本计划只定义未来获授权后的最小 RED/GREEN/回归边界，不构成本轮代码或 schema 变更授权。

## 1. 先决条件与停止门

### 1.1 必须先满足

| 门 | 状态 | 通过标准 |
| --- | --- | --- |
| 代码基线 | IMPLEMENTED | 从 P3D-0 docs commit 的 exact parent 开始；不得基于漂移的 main、旧 worktree 或未核对 HEAD 实施。 |
| TD-26 至 TD-30 | IMPLEMENTED | 保持冻结，不重新选择 correlation、cancel、progress、Start completion、Retry Option。 |
| request contract | CONTRACT CLOSED / IMPLEMENTATION MISSING | M3-TD-31 已冻结 exact expectedVersion body、empty query、no ETag、locator/parser、response precedence 与 trusted metadata。 |
| waiting_approval lifecycle seam | CONTRACT CLOSED / IMPLEMENTATION MISSING | M3-TD-32 已批准 Option C 与 exactly-one unresolved Approval discovery/ordered cancellation；生产 seam 尚不存在。 |
| schema | NOT REQUIRED | 继续使用 001…013；不得以 Migration 014 规避 service/contract 缺口。 |
| production authorization | NOT AUTHORIZED | P3D-1、P3D-2、P3D-3 仍需单独授权；Owner contract approval 不携带实现授权。 |

### 1.2 绝对停止条件

任一条件发生即停止当前 P3D phase，保留 RED 证据与 rollback 状态，不扩大 allowlist：

- 实现偏离 M3-TD-31 exact body/query、使用 ETag/If-Match，或接受 client lifecycle metadata；
- waiting_approval 未通过 M3-TD-32 approval-aware discovery/order，而是直接扩大普通 cancelRunWithinTransaction；
- 任意一步会拆成独立 transaction，或必须引入第二 SQLite handle/第二 Operation；
- Operation 已 cancelled 却产生 lifecycle/Event/Outbox side effect；
- terminal Operation、binding mismatch 或 stale version 未 fail closed；
- Stage Event 顺序不是 stage.sequence ASC、stage.id ASC，或 run.cancelled 早于任一 affected Stage 的 stage.cancelled；
- 任意故障留下 Operation/Run/Stage/Event/Outbox 的 partial state；
- 需要修改 Shared、Migration、Registry、Web、Engine、Process/provider/CLI 才能继续，但没有新的 owner authorization。

## 2. P3D-1：Operation read surface

### 2.1 目标与边界

目标是只读、workspace-safe 的两个 endpoint：

- GET /api/operations/:operationId
- GET /api/operations/:operationId/events

不做 SSE、replay、OpenAPI completion、progress projection、operation_events 表或新 Operation type。

| 目标 | 状态 | 现有 seam/计划动作 |
| --- | --- | --- |
| locator-first | MISSING | 在 OperationRepository 增加只读 opaque-id locator；由 OperationService 暴露 service seam；路由先 locator，再解析 query/body。 |
| Operation projection | PARTIAL | 从现有 mapRow 输出 id/type/status/workspace/aggregate/run/correlation/result/error/timestamps/version；严格省略 progress。 |
| Event projection | IMPLEMENTED | 授权后从 Operation 取 runId/correlationId，调用 listByRunAndCorrelation，返回 ascending sequence；不创建 Operation Event Store。 |
| Retry semantics | IMPLEMENTED | Retry Operation 的 query 只用自身 runId+correlationId，通常为空；不混入 Child creation 或后续 Start Events。 |
| safe errors | PARTIAL | 新 route 采用 runLifecycle.ts 的稳定 code/status/sanitization 模式，避免全局 errorHandler.ts raw message。 |

### 2.2 RED：先写测试

新增 apps/server/src/routes/operations.test.ts，补充 OperationRepository.test.ts 与 OperationService.test.ts 的最小单元覆盖。RED 必须至少包含：

1. 未知 operationId 在 malformed JSON、非法 query 前返回 404 OPERATION_NOT_FOUND，且无 SQL/path 泄露。
2. 已知 Operation 只能按其 workspace 读取；客户端不能用 query/body 覆盖 workspace、runId 或 correlationId。
3. GET operation 映射所有已持久化字段，progress 不出现，unknown/invalid persisted shape 走稳定错误。
4. GET events 只返回目标 Operation 的 runId + correlationId，顺序为 sequence ASC。
5. run.start 能读到对应 startup Events；run.retry 不返回 Child creation 或独立 Start Events，并通常返回空集合。
6. Operation 绑定不一致时 fail closed；不能通过提供另一个 runId/correlationId 读取其他 Run。
7. route mount 只出现一次并位于 /api；Operation Router 必须在 global express.json() 前，P3D-1 GET routes 不运行 JSON parser，也不创建 Cancel stub。

### 2.3 GREEN：最小实现顺序

1. OperationRepository.findWorkspaceIdByOpaqueId(operationId)：只返回 workspaceId，unknown 返回 undefined，不改变任何 row。
2. OperationService 提供 locator/read seam，继续复用 workspace-scoped findById 与既有 mapper/validation。
3. 新建 routes/operations.ts：先 locator，再读取；GET events 只接收 URL operationId，不从 HTTP 输入接受 run/correlation。
4. index.ts 在 global express.json() 前把 Operation Router 精确挂载到 /api；GET 不解析 JSON，P3D-1 不注册 Cancel route。
5. route-local error map 只暴露稳定 code/status/safe message；未知异常统一 INTERNAL_ERROR。

### 2.4 回归与停止边界

| 验证 | 状态 | 通过标准 |
| --- | --- | --- |
| Operation/Run workspace isolation | MISSING | 新增 route/repository tests 全部通过；既有 OperationRepository、RunRepository tests 不回退。 |
| progress/operation_events 禁止项 | MISSING | rg/schema diff 证明无 progress persistence、无 operation_events、无 Migration 014。 |
| 既有 route precedence | MISSING | runLifecycle.test.ts 与新增 operations route tests 均通过；未知 id 优先于 malformed body。 |
| P3D-1 stop | MISSING | 若需要改 Shared/Runtime spec/Registry，或 Event query 不能证明授权后隔离，则停止并 reopen review。 |

## 3. P3D-2：Atomic Operation Cancel core

### 3.1 目标与明确选择

目标 endpoint：

- POST /api/operations/:operationId/cancel

M3-TD-31/32 已批准 Option C：专用 guarded Operation cancel + approval-aware Lifecycle cancellation seam。普通 OperationService.ALLOWED_TRANSITIONS 不得因为 P3D Cancel 而扩展。

| 方案 | 状态 | 决定 |
| --- | --- | --- |
| Option A：扩大普通 transition table | REJECTED | 会扩大普通 caller 的能力，削弱专用 guard，并可能影响 Engine/adjacent consumers。 |
| Option B：专用 Operation guard + ordinary cancelRunWithinTransaction | REJECTED AS INCOMPLETE | ordinary seam 拒绝 waiting_approval；扩大它会绕过 Approval ordering。 |
| Option C：专用 Operation guard + approval-aware Lifecycle seam | OWNER APPROVED / NOT IMPLEMENTED | 合同已闭合；只允许未来获授权的 canonical Operation Cancel 调用。 |

### 3.2 RED：先锁定原子与状态矩阵

在 OperationService.test.ts、routes/operations.test.ts 与必要的既有 lifecycle test seam 中先写失败测试：

| 场景 | 必须断言 |
| --- | --- |
| queued/running/waiting_approval/paused | 四类 Operation 均只能在契约批准且 bound Run 可取消时进入 cancel path。 |
| already cancelled | HTTP 200 current ApiOperation；即使 expectedVersion stale 也 zero lifecycle/Event/Outbox side effect。 |
| completed/failed | matching version 时 409 OPERATION_NOT_CANCELLABLE；所有 aggregate 保持不变。 |
| unknown | 404 OPERATION_NOT_FOUND；locator precedence 保持。 |
| exact request | query empty；body 只有 required positive-safe-integer expectedVersion；extra/client metadata/ETag transport 均拒绝。 |
| binding/Approval mismatch | fail closed、outer rollback、route sanitize 为 INTERNAL_ERROR；不新增 public code。 |
| stale Operation version | 非 cancelled 状态返回 VERSION_CONFLICT；不能继续 Run cancellation。 |
| fresh Run version | outer transaction re-read persisted Run.version 并作为 expectedRunVersion；HTTP 不提供该字段。 |
| waiting_approval | exactly one unresolved approval.required；保持 run/stage/approvalRequestId binding 与 frozen Event order。 |
| stage Event failure | Operation、Run、Stage、Runtime Event、Outbox、version 全恢复。 |
| run Event/Outbox failure | 同上，且不存在自动 failed Operation。 |
| commit failure | 同上；不留下 Operation cancelled 的孤儿状态。 |
| metadata/idempotency | operation_api、[]、true、reason absent；无第二 Operation、无 Idempotency Record、Idempotency-Key 不参与 replay。 |

### 3.3 GREEN：建议的事务组成

Future OperationService.cancelWithinTransaction 必须拥有唯一 outer transaction，内部不得开第二个 transaction：

1. Operation Router 在 global express.json() 前完成 locator/workspace authorization，再执行 Cancel route-scoped parser 与 exact validation。
2. BEGIN IMMEDIATE 后 workspace-scoped re-read Operation，并校验 aggregate/run/workspace/correlation binding。
3. cancelled 直接 HTTP 200 no-op；该优先级高于 expectedVersion。
4. 其他状态比较 body.expectedVersion；stale -> VERSION_CONFLICT。
5. matching-version completed/failed -> OPERATION_NOT_CANCELLABLE；四类可取消状态进入 dedicated guarded update。
6. 条件更新 Operation 为 cancelled；随后在同一 handle/transaction 内 re-read bound Run，并使用 fresh persisted Run.version。
7. queued/starting/running/paused Run 可复用 existing core；waiting_approval 进入 approval-aware seam，发现 exactly one unresolved Approval。
8. waiting_approval 写 approval.resolved(decision=cancel_run, decidedBy=operation_api)，再按 stage.sequence/id 写 stage.cancelled，最后 run.cancelled。
9. Event sequence contiguous、每 Event 一个 Outbox；Operation/Run/Stages/Events/Outbox/versions/sequences 全成或全回滚。
10. 成功返回 ApiOperation；不得创建第二 Operation、Operation Event 或 Idempotency Record。

### 3.4 composition allowlist

当前 SqliteStore 同时持有 LifecycleTransactionService 与 OperationService，但后者只接裸 database。P3D-2 最小 composition 需要：

- OperationService.ts 接受既有 lifecycle dependency/transaction seam；
- SqliteStore.ts 以同一 database handle 构造并注入既有 LifecycleTransactionService；
- LifecycleTransactionService.ts 只增加 approval-aware Operation cancellation seam；
- m3-p2c2b-composite-lifecycle.test.ts 为 REQUIRED，覆盖 Approval discovery/order/rollback/concurrency；
- m3-p2c2a-lifecycle-transaction.test.ts 为 REGRESSION ONLY，不改变 single-transition semantics；
- OperationRepository.ts 仅在 P3D-1 后仍有 cancel-specific conditional update evidence 时 CONDITIONAL；
- 不新增 OperationControlService、第二数据库连接或隐式 service singleton。

LifecycleTransactionService.ts 在 P3D-1 为 FORBIDDEN；在 P3D-2 为 OWNER-APPROVED NARROW REQUIRED SCOPE。不得借机重构 approval APIs、普通 Run lifecycle、startup/completion/failure 或 process runtime。

### 3.5 已闭合 request/error contract

M3-TD-31 已冻结：URL 只含 operationId、query empty、exact body 只有 expectedVersion、no ETag/If-Match、no client lifecycle metadata、trusted server metadata、already-cancelled/stale/terminal precedence，以及仅 VALIDATION_FAILED、OPERATION_NOT_FOUND、VERSION_CONFLICT、OPERATION_NOT_CANCELLABLE、INTERNAL_ERROR 五个 public codes。合同已就绪，但 GREEN 仍必须等待 P3D-2 独立生产授权。

## 4. P3D-3：Race 与 failure closure

### 4.1 目标

证明 Operation Cancel 与既有 RunEngine claim/Start completion 在同一 SQLite file-backed transaction model 下互斥，并且任意中途故障都不会留下 partial state。

| 对抗 | 状态 | 预期 invariant |
| --- | --- | --- |
| cancel vs queued run.start claim | MISSING | 一个 transaction 获得 Operation/Run 条件更新；另一个只能 stable conflict/no-op，不能双成功。 |
| cancel vs Start completion | MISSING | 依据先获得 BEGIN IMMEDIATE 的 transaction 完整提交；不出现 Operation cancelled + Run running 或 Operation completed + nonterminal Run 的混合结果。 |
| cancel vs existing Run terminal transition | MISSING | expected version/status fence 保证一个 winner；terminal Operation 不被回写。 |
| two independent file-backed stores | MISSING | 两个连接使用同一 SQLite 文件，结果与单连接模型一致；不依赖 in-process mutex。 |
| Event/Outbox injection | MISSING | stage/run Event、Outbox、Operation update、outer commit 任一点失败均全回滚。 |

### 4.2 RED/GREEN 测试序列

1. RED：在两个独立 Store/connection 上准备同一 queued/running Operation 与 Run，启动 cancel 与现有 Engine/Start worker；先验证当前缺少 P3D route/service 造成失败，而不是修改生产行为。
2. GREEN：只在获授权的 P3D allowlist 内连接 Operation guarded cancel 与既有 lifecycle core。
3. RED：为每个 Event/Outbox/Operation/commit seam 注入失败，快照比较 Operation、Run、Stage、runtime_events、outbox_messages、version/sequence。
4. GREEN：保证异常向 route safe map 传播，outer transaction rollback；禁止自动补写 failed Operation，除非 TD-29 的专属 C1a/C1b 条件明确命中；用户 Cancel 不进入 C1a/C1b。
5. 回归：重跑 OperationService、OperationRepository、P2C-2A、P2C-2B、RunEngine、runLifecycle、RunRepository、RunStageRepository、SqliteStore 全部定向测试。

### 4.3 P3D-3 stop conditions

- 看到两个 Operation、operation.cancel idempotency、或改变既有 run.cancel idempotency 时停止；
- RunEngine 需要修改才能证明互斥时停止并请求独立 owner review；优先利用现有 tickWithinTransaction/completeStartup seam；
- waiting_approval 未使用 M3-TD-32 approval-aware seam、Approval discovery 或 frozen Event order 时停止；
- 任一 failure injection 产生 partial Current State/Event/Outbox 时停止，不以重试或补偿写掩盖；
- 要求更改 Migration/Shared/Registry/Web/SSE/OpenAPI 才能通过时停止并扩大授权边界，而不是临时修改。

## 5. 精确 allowlist 与禁止范围

### 5.1 P3D-1 REQUIRED（DEPENDENCY READY / NOT AUTHORIZED）

| 文件 | 允许内容 |
| --- | --- |
| apps/server/src/routes/operations.ts | 只新增两个 GET endpoint、locator-first、projection、safe error map；不得实现 Cancel。 |
| apps/server/src/routes/operations.test.ts | GET、workspace isolation、Event correlation、no-parser/mount contract tests；不得加入 Cancel behavior。 |
| apps/server/src/services/OperationService.ts | locator/read facade；不得提前加入 cancel orchestration。 |
| apps/server/src/services/OperationService.test.ts | locator/read/progress omission tests。 |
| apps/server/src/store/OperationRepository.ts | opaque-id locator 与仅有证据支持的最小 repository seam。 |
| apps/server/src/store/OperationRepository.test.ts | locator 的 workspace/unknown/pure-read/isolation 测试。 |
| apps/server/src/index.ts | Operation Router 在 global express.json() 前于 /api 单次 mount。 |

SqliteStore.ts 在 P3D-1 为 FORBIDDEN；当前 operationService accessor 已足够。只有独立 composition evidence 证明必须暴露 Router accessor 时，才可重新分类为 CONDITIONAL。LifecycleTransactionService.ts 在 P3D-1 始终 FORBIDDEN。

### 5.2 P3D-2 REQUIRED（CONTRACT READY / NOT AUTHORIZED）

| 文件 | 允许内容 |
| --- | --- |
| apps/server/src/routes/operations.ts | 只增加 M3-TD-31 canonical Cancel route。 |
| apps/server/src/routes/operations.test.ts | exact request/precedence/error/idempotency HTTP tests。 |
| apps/server/src/services/OperationService.ts | Option C dedicated guarded cancel 与唯一 outer transaction。 |
| apps/server/src/services/OperationService.test.ts | four-status/no-op/version/binding/rollback tests。 |
| apps/server/src/store/SqliteStore.ts | 只做 same-handle Lifecycle/Operation composition。 |
| apps/server/src/services/LifecycleTransactionService.ts | 只增加 approval-aware Operation cancellation seam。 |
| apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts | REQUIRED：Approval discovery/resolution、ordered cancellation、rollback、concurrency。 |

apps/server/src/services/m3-p2c2a-lifecycle-transaction.test.ts 是 REGRESSION ONLY；不修改 single-transition behavior。OperationRepository.ts/OperationRepository.test.ts 只有 P3D-1 结束后仍出现 cancel-specific conditional-update evidence 时才为 CONDITIONAL。

### 5.3 P3D-3 boundary（NOT AUTHORIZED）

P3D-3 只负责 Claim vs Cancel、Start Completion vs Cancel、Startup Failure vs Cancel、duplicate Cancel、already cancelled、terminal Cancel、two independent SQLite connections、failure injection 与 rollback closure。不得增加新的 product behavior；RunEngine production code 保持 FORBIDDEN。

### 5.4 全阶段 FORBIDDEN

Shared/Registry/Migration 014、Web、SSE/replay/OpenAPI completion、runLifecycle/TaskRunService/v2 behavior、RunRepository/RunStageRepository ordinary semantics、ProcessManager/provider/CLI/worktree runtime、非 Run Operation、policy、production cutover、删除/重命名 run.cancel 或新增 operation.cancel idempotency，均保持 FORBIDDEN。

## 6. 测试、回归、提交与边界

### 6.1 P3D contract closure（本轮）

| 项目 | 状态 | 边界 |
| --- | --- | --- |
| 文档 | OWNER AUTHORIZED | 只修改 11-API-Specification.md、M3-owner-decisions.md、M3-p3d-current-state-audit.md、M3-p3d-implementation-plan.md。 |
| 生产代码/测试 | NOT AUTHORIZED | 不修改任何 .ts/.tsx/.js/.json/.sql；不进入 P3D-1/2/3。 |
| retained baseline tests | RETAINED EVIDENCE | 212/212 与 RunStageRepository 9/9 来自前一 P3D-0 运行；本次 docs-only closure 不重新运行、不声称新 PASS。 |
| schema | NOT REQUIRED / NOT AUTHORIZED | Registry 保持 001–013；Migration 014 absent。 |
| commit | DOCS-ONLY FORWARD | 门禁通过后创建 docs: freeze M3 P3D cancel contract；parent 必须为 7213a50fa1f516d94bcd56bb767cd454631e2c7c。 |
| push/PR | PUSH ONLY / NO PR | 推送 docs/m3-p3d-preplanning 并核对 remote SHA；不创建 Draft PR。 |

### 6.2 P3D-1/P3D-2/P3D-3 future commit boundaries

- P3D-1 read surface 应独立于 P3D-2 cancel core，先完成 locator/events contract 与 route tests。
- P3D-2 合同已由 M3-TD-31/32 闭合，但只有 P3D-1 acceptance 后且独立授权时才能开始；Operation/Run/Stage/Event/Outbox 组合必须在同一 commit/test gate 内闭合。
- P3D-3 只负责 cross-connection race/failure closure；不能顺便加入 SSE、Web、migration、policy 或 Engine 功能。
- 任一 phase fail 时保留失败测试与证据，回滚只允许撤销该 phase 自己的变更；不得 reset/checkout 覆盖用户工作。

### 6.3 最终验收命令

获授权后的每个实现 phase 至少应记录以下命令的 command/pass/fail/skip/exit：

    git status --short --branch
    git diff --check parent..HEAD
    git diff --name-only parent..HEAD
    pnpm.cmd exec node --import tsx --test --test-concurrency=1 exact-allowlisted-test-files

必须额外检查：

- changed files 与 allowlist 精确相等；
- no .ts/.tsx/.js/.json/.sql outside allowlist；
- no Migration 014、no registry change、no Shared/Web/SSE/OpenAPI change；
- local/remote branch SHA exact match；
- remote checks 若不可用，报告 UNAVAILABLE — NOT PASS，不猜测为 PASS。

## 7. 最终授权边界

| 项目 | 状态 | 结论 |
| --- | --- | --- |
| P3D-0 PREPLANNING | COMPLETE | 当前状态审计与 implementation plan 完成。 |
| P3D CONTRACT CLOSURE | COMPLETE | M3-TD-31/32 Owner approved/documented；生产代码未实现。 |
| M3-TD-31 | OWNER APPROVED / NOT IMPLEMENTED | HTTP request/replay contract frozen。 |
| M3-TD-32 | OWNER APPROVED / NOT IMPLEMENTED | Option C guarded + approval-aware lifecycle contract frozen。 |
| P3D-1 PRODUCTION IMPLEMENTATION | DEPENDENCY READY / NOT AUTHORIZED | 只允许未来单独授权的两个 GET endpoint。 |
| P3D-2 PRODUCTION IMPLEMENTATION | CONTRACT READY / NOT AUTHORIZED | DEPENDS ON P3D-1 ACCEPTANCE。 |
| P3D-3 PRODUCTION IMPLEMENTATION | NOT AUTHORIZED | DEPENDS ON P3D-2；只做 race/failure closure。 |
| P3E | NOT ENTERED / NOT AUTHORIZED | 未进入。 |
| Migration 014 | NOT REQUIRED / NOT AUTHORIZED / ABSENT | 不创建。 |
| Production cutover | NOT AUTHORIZED / NOT STARTED | 不执行。 |
| Draft PR | NOT CREATED | 本轮不创建。 |
