# M3 P3D：Operation Control Surface 实施计划

> 计划状态：P3D-0 预规划完成；P3D-1/P3D-2/P3D-3 生产实现均未授权。
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
| request contract | MISSING | Owner 必须冻结 Operation Cancel 的 body/header、actor/requestedBy 来源、reason、terminatedProcessIds、worktreePreserved 产生方式及 expectedVersion/ETag 语义。 |
| waiting_approval lifecycle seam | CONFLICT | Owner 必须确认：提供最小 direct cancellation seam，或明确调整/分层现有 approval cancellation 契约；未确认前 STOP。 |
| schema | NOT REQUIRED | 继续使用 001…013；不得以 Migration 014 规避 service/contract 缺口。 |
| production authorization | MISSING | 需要单独授权 P3D-1、P3D-2、P3D-3；P3D-0 commit 本身不携带实现授权。 |

### 1.2 绝对停止条件

任一条件发生即停止当前 P3D phase，保留 RED 证据与 rollback 状态，不扩大 allowlist：

- Operation request body 或 ETag/expectedVersion 仍靠猜测；
- waiting_approval 仍只能通过需要 approval decision 的专用入口处理；
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
7. route mount 只出现一次，位于 /api，且保持全局 JSON parser 之后的既有 locator-first 设计。

### 2.3 GREEN：最小实现顺序

1. OperationRepository.findWorkspaceIdByOpaqueId(operationId)：只返回 workspaceId，unknown 返回 undefined，不改变任何 row。
2. OperationService 提供 locator/read seam，继续复用 workspace-scoped findById 与既有 mapper/validation。
3. 新建 routes/operations.ts：先 locator，再读取；GET events 只接收 URL operationId，不从 HTTP 输入接受 run/correlation。
4. index.ts 在 /api 精确挂载一次，保留 route-local parser/未知 id precedence。
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

推荐 Option B：专用 guarded cancel。它不扩展普通 OperationService.ALLOWED_TRANSITIONS 的所有 caller 语义，而是在一个专用 caller-owned service method 中检查 M3-TD-27 的四类状态、expected status/version、binding 与 terminal fence。

| 方案 | 状态 | 决定 |
| --- | --- | --- |
| Option A：直接给普通 transition 表增加 waiting/paused -> cancelled | NOT REQUIRED | 会把所有普通 transition caller 的语义扩大，且可能让 Engine/其他服务绕过 Cancel 专用 guard。 |
| Option B：cancelWithinTransaction 专用 guard | IMPLEMENTED | 与现有 terminal/version invariants 及 caller-owned transaction 兼容；只由 canonical Operation Cancel 调用。 |

### 3.2 RED：先锁定原子与状态矩阵

在 OperationService.test.ts、routes/operations.test.ts 与必要的既有 lifecycle test seam 中先写失败测试：

| 场景 | 必须断言 |
| --- | --- |
| queued/running/waiting_approval/paused | 四类 Operation 均只能在契约批准且 bound Run 可取消时进入 cancel path。 |
| already cancelled | 返回当前 Operation；Operation/Run/Stage/Event/Outbox 全部 zero side effect。 |
| completed/failed | 409-class OPERATION_NOT_CANCELLABLE；所有 aggregate 保持不变。 |
| unknown | 404 OPERATION_NOT_FOUND；locator precedence 保持。 |
| binding mismatch | stable conflict/fail closed；不调用 lifecycle，不写 Operation。 |
| stale Operation version | VERSION_CONFLICT 或获批准的 ETag conflict；不能继续 Run cancellation。 |
| stale Run version | 同上；Operation 条件更新与 lifecycle 共同回滚。 |
| stage Event failure | Operation、Run、Stage、Runtime Event、Outbox、version 全恢复。 |
| run Event/Outbox failure | 同上，且不存在自动 failed Operation。 |
| commit failure | 同上；不留下 Operation cancelled 的孤儿状态。 |
| waiting_approval direct lifecycle seam | 在 owner contract 未解决时测试必须保持 STOP；不得用 v2 defaults 让它“通过”。 |

### 3.3 GREEN：建议的事务组成

Future OperationService.cancelWithinTransaction 必须由外层 inTransaction/runInTransaction 调用，内部不得开第二个 transaction：

1. locator/authorization 后，在同一个 BEGIN IMMEDIATE 中 workspace-scoped re-read Operation。
2. 校验 aggregateType=run、aggregateId 等于 runId、workspace 与 correlation binding。
3. 对 cancelled 做 no-op replay；对 terminal/unsupported status 返回稳定 409；不执行 lifecycle。
4. workspace-scoped re-read bound Run，校验 Operation/Run 的期望版本及 status compatibility。
5. 按 Operation expected status/version 条件更新 Operation 为 cancelled；条件更新失败立即抛 conflict。
6. 调用现有 LifecycleTransactionService.cancelRunWithinTransaction 处理其已覆盖的 Run 状态；waiting_approval 必须等待 owner 批准的最小 seam，不能调用 resolveApprovalToCancellation 伪装成 generic cancel。
7. P2 lifecycle core 按 stage sequence/id 取消非终态 Stage，写每个 stage.cancelled/Outbox，最后写 run.cancelled/Outbox。
8. 捕获/传播稳定错误，由外层 rollback；成功后再生成 ApiOperation response。不得创建第二 Operation，不写 operation Event。

### 3.4 composition allowlist

当前 SqliteStore 同时持有 LifecycleTransactionService 与 OperationService，但后者只接裸 database。P3D-2 最小 composition 需要：

- OperationService.ts 接受既有 lifecycle dependency/transaction seam；
- SqliteStore.ts 以同一 database handle 构造并注入既有 LifecycleTransactionService；
- OperationRepository.ts 仅补 locator/必要 conditional update seam；
- 不新增 OperationControlService、第二数据库连接或隐式 service singleton。

LifecycleTransactionService.ts 默认仍为 FORBIDDEN。若 waiting_approval 缺口不能通过现有 seam 关闭，P3D-2 在这里 STOP，进入 owner review；不能把该文件偷偷加入 REQUIRED。

### 3.5 request/error gate

在 GREEN 前必须有已批准的 request contract：

- canonical body 的字段、是否允许空 body、Content-Type/query 规则；
- requestedBy 是认证 actor、服务端固定来源还是其他已批准来源；
- terminatedProcessIds 与 worktreePreserved 如何由受信任 lifecycle/process 结果产生；
- reason 是否入参、长度与持久化规则；
- expectedVersion 与 ETag 的 exact transport 语义；
- binding mismatch、Run terminal/不兼容、busy/unknown 的稳定 codes/status/safe messages。

没有这些批准项，只有 RED/审计可以继续，GREEN 必须 STOP。

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
- waiting_approval 仍无批准的 generic cancellation seam 时停止；
- 任一 failure injection 产生 partial Current State/Event/Outbox 时停止，不以重试或补偿写掩盖；
- 要求更改 Migration/Shared/Registry/Web/SSE/OpenAPI 才能通过时停止并扩大授权边界，而不是临时修改。

## 5. 精确 allowlist 与禁止范围

### 5.1 REQUIRED（获授权后）

| 文件 | 允许内容 |
| --- | --- |
| apps/server/src/routes/operations.ts | 新增三条 endpoint、locator-first、projection、safe error map。 |
| apps/server/src/routes/operations.test.ts | 新增 HTTP/read/cancel/race-facing contract tests。 |
| apps/server/src/services/OperationService.ts | locator facade、Operation DTO seam、Option B caller-owned cancel orchestration。 |
| apps/server/src/services/OperationService.test.ts | Operation status/identity/version/no-op/rollback 单元与集成覆盖。 |
| apps/server/src/store/OperationRepository.ts | opaque-id locator 与仅有证据支持的最小 repository seam。 |
| apps/server/src/store/OperationRepository.test.ts | locator 的 workspace/unknown/pure-read/isolation 测试。 |
| apps/server/src/store/SqliteStore.ts | 同一 database handle 下的 service dependency composition。 |
| apps/server/src/index.ts | /api router 单次 mount，保持 parser 顺序。 |

### 5.2 CONDITIONAL

- apps/server/src/services/LifecycleTransactionService.ts：默认 FORBIDDEN；只有 owner 批准 waiting_approval 最小 seam 且证明现有 seam 不足时才可重新审查。
- apps/server/src/store/RuntimeEventRepository.ts：只有独立 security review 要求物理 workspace predicate 时才可改；当前 route 前置授权方案不要求改。
- apps/server/src/store/RuntimeEventRepository.test.ts：只有需要锁定上述 query security seam 时才新增。

### 5.3 FORBIDDEN

Shared/Registry/Migration/014、Web、SSE/replay/OpenAPI completion、RunEngine、runLifecycle、TaskRunService、RunRepository/RunStageRepository lifecycle semantics、ProcessManager/provider/CLI/worktree runtime、非 Run Operation、policy、production cutover，以及任何既有 Markdown（本轮除两份新增文档外）均禁止修改。

## 6. 测试、回归、提交与边界

### 6.1 P3D-0（本轮）

| 项目 | 状态 | 边界 |
| --- | --- | --- |
| 文档 | IMPLEMENTED | 只新增 current-state audit 与 implementation plan 两份 Markdown。 |
| 生产代码 | NOT REQUIRED | 不修改 .ts/.tsx/.js/.json/.sql。 |
| 测试 | IMPLEMENTED | 只读定向测试已在 exact base 上通过 212/212，另行通过 RunStageRepository 9/9；首次环境解析失败已记录。 |
| schema | NOT REQUIRED | 不创建 Migration 014，不修改 Registry/DDL。 |
| commit | MISSING | 文档通过范围验证后，才允许一个 docs-only commit：docs: plan M3 P3D operation control surface。 |
| push/PR | MISSING | commit 后可 push docs/m3-p3d-preplanning 做远程 SHA 核对；不创建 Draft PR。 |

### 6.2 P3D-1/P3D-2/P3D-3 future commit boundaries

- P3D-1 read surface 应独立于 P3D-2 cancel core，先完成 locator/events contract 与 route tests。
- P3D-2 只有 request contract、waiting_approval seam、composition gate 全部通过后才能开始；Operation/Run/Stage/Event/Outbox 组合必须在同一 commit/test gate 内闭合。
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
| P3D-0 PREPLANNING | IMPLEMENTED | 审计与计划完成；结果受两个 STOP CONDITION 明确约束。 |
| P3D-1 PRODUCTION IMPLEMENTATION | NOT REQUIRED | 本轮未授权。 |
| P3D-2 PRODUCTION IMPLEMENTATION | NOT REQUIRED | 本轮未授权；waiting_approval 与 request contract 未闭合。 |
| P3D-3 PRODUCTION IMPLEMENTATION | NOT REQUIRED | 本轮未授权。 |
| P3E | NOT REQUIRED | 未进入、未授权。 |
| Migration 014 | NOT REQUIRED | 不创建。 |
| Production cutover | NOT REQUIRED | 不执行。 |
| Draft PR | NOT REQUIRED | 本轮不创建。 |
