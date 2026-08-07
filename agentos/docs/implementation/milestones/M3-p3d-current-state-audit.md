# M3 P3D-0：Operation Control Surface 当前状态审计

> 审计性质：只读预规划与契约审计。本轮不授权生产实现，不改变运行时代码、测试、Shared、Migration、Registry、Web 或切换状态。
>
> 审计基线：5bfa66d074791cb1e1981968f28c3854d7d55d2a（PR #34 merge commit）。
>
> 审计日期：2026-08-07。

## 1. 基线、范围与结论

### 1.1 Git 与 PR 基线

| 检查项 | 状态 | 证据与结论 |
| --- | --- | --- |
| PR #34 元数据 | IMPLEMENTED | Zbyy0311/agentos#34 已关闭、已合并、非 Draft；标题 docs: close M3 P3C-1 retry acceptance；Base de0b88fb0bed4a27cc38318481a0c7ccd47732a9，Head 8d39aade0aa358756952ca49388e654853ed1ecf，Merge 5bfa66d074791cb1e1981968f28c3854d7d55d2a。不可变字段保持不变。 |
| PR #34 body 重检 | IMPLEMENTED | 只将 body 中唯一的 POST-MERGE REMOTE RECHECK: REQUIRED 改为 POST-MERGE REMOTE RECHECK: PASS；使用外部临时 body 文件，更新后已删除临时文件。 |
| origin/main 与本地 main | IMPLEMENTED | 已执行 git fetch origin；本地 main 与 origin/main 均指向 5bfa66d074791cb1e1981968f28c3854d7d55d2a，本地 main 在操作前 clean。 |
| 审计分支与工作树 | IMPLEMENTED | 已从 merge SHA 创建 docs/m3-p3d-preplanning，工作树为 E:/workspace/m3-p3d-preplanning；工作树根目录下的 AgentOS 内容位于 agentos/。 |
| 远程检查 | PARTIAL | GitHub combined status 请求不可用，merge SHA 的 workflow runs 返回空集合；不能把空集合或传输错误解释为 PASS。最终边界固定为 REMOTE CHECKS: UNAVAILABLE — NOT PASS。 |

### 1.2 本轮允许范围

| 范围项 | 状态 | 审计结论 |
| --- | --- | --- |
| P3D-1 Operation 只读面 | IMPLEMENTED | 只审计并规划 GET /api/operations/:operationId。 |
| P3D-2 原子 Cancel 核心 | IMPLEMENTED | 只审计并规划 POST /api/operations/:operationId/cancel 的 caller-owned transaction 组成；本轮不实现。 |
| P3D-3 竞态与失败闭环 | IMPLEMENTED | 只审计并规划路由、Operation、Run、Stage、Runtime Event、Outbox 的竞态/回滚证据；本轮不实现。 |
| 排除项 | IMPLEMENTED | SSE/replay、OpenAPI 补全、Web UI、非 Run Operation、ProcessManager/provider runtime/CLI/worktree runtime、policy、生产 Migration、cutover 均不在本轮。 |
| 变更文件 | IMPLEMENTED | 本轮只允许新增本文与 M3-p3d-implementation-plan.md 两个 Markdown 文件；不编辑任何既有 Markdown。 |

### 1.3 只读测试证据

| 命令 | 状态 | 结果 |
| --- | --- | --- |
| 定向 8 文件测试命令（首次） | PARTIAL | 退出码 1；测试尚未加载，全部 8 个实际执行文件在模块解析阶段因 workspace 包尚未生成 @agentos/shared/dist/index.js 而失败，不是断言失败。命令文件清单见第 11 节。 |
| pnpm.cmd run build:workspace-deps | IMPLEMENTED | 退出码 0；仅生成现有 workspace 测试所需构建产物。 |
| 同一组定向 8 文件测试命令（第二次） | IMPLEMENTED | 退出码 0；共 212 tests，212 pass、0 fail、0 skipped。覆盖 OperationService、OperationRepository、P2C-2A/P2C-2B lifecycle、RunEngine、P3C-1 lifecycle route、RunRepository、SqliteStore。 |
| pnpm.cmd exec node --import tsx --test --test-concurrency=1 src/store/RunStageRepository.test.ts | IMPLEMENTED | 退出码 0；共 9 tests，9 pass、0 fail、0 skipped。 |

## 2. 权威契约与冻结决策

以下文件已作为当前审计输入阅读；同名旧审计/计划仅作为历史输入，不能覆盖当前 owner decision 或本审计结论：

- docs/Runtime-Specification/02-Runtime-Lifecycle.md
- docs/Runtime-Specification/03-Event-Model.md
- docs/Runtime-Specification/10-Data-Model.md
- docs/Runtime-Specification/11-API-Specification.md
- docs/implementation/milestones/M3-owner-decisions.md
- docs/implementation/milestones/M3-p3-current-state-audit.md
- docs/implementation/milestones/M3-p3-implementation-plan.md

| 契约/决策 | 状态 | 文件、符号/章节与理由 |
| --- | --- | --- |
| M3 Operation 仅绑定 Task-domain Run | IMPLEMENTED | M3-owner-decisions.md 的 M3-TD-10/M3-TD-27；OperationRepository.mapRow 与 Migration 012 的 aggregate_type=run、aggregate_id=run_id、复合外键保持绑定。 |
| Operation 状态集合 | IMPLEMENTED | M3-owner-decisions.md M3-TD-10；OperationRepository 的状态约束与 Migration 012 CHECK 均为 queued/running/waiting_approval/paused/completed/failed/cancelled。 |
| Operation correlation identity | IMPLEMENTED | M3-TD-26；OperationRepository.assertOperationCorrelationBinding 保留历史 run.create -> run.id，其他 Operation 使用 operation.id，且唯一、不可变。 |
| Start completion 同一事务 | IMPLEMENTED | M3-TD-29；RunEngine.completeStartup 与 LifecycleTransactionService.completeRunStartupWithinTransaction 已在同一 caller-owned transaction 中完成 Stage/Run started、Event/Outbox 与 Operation completed。 |
| Retry Option A | IMPLEMENTED | M3-TD-30；RunEngine 不将 run.retry 作为执行授权，Retry Operation 与 Child creation correlation、后续 run.start correlation 分离；P3D 不重新选择 Option。 |
| Operation Cancel 三个端点 | IMPLEMENTED | M3-TD-12/M3-TD-27 与 11-API-Specification.md Operation API 章节冻结：GET operation、GET operation events、POST operation cancel。 |
| Cancel 的四类 Operation 状态 | PARTIAL | M3-TD-27 明确可取消状态为 queued/running/waiting_approval/paused；当前 OperationService.ALLOWED_TRANSITIONS 对 waiting_approval、paused 设置空出边，不能直接满足该契约。 |
| Cancel request body/header 的精确形状 | MISSING | 11-API-Specification.md 给出 Operation 端点及 ApiOperation，但没有冻结 Operation Cancel 的具体 JSON 字段、requestedBy 来源、reason 是否入参、expectedVersion 与 ETag 的二选一/并存方式；其中通用 Run Cancel 请求不是本端点的替代契约。实现前必须补齐 owner contract，不能复制 v2 默认值。 |
| Cancel Event payload | IMPLEMENTED | 03-Event-Model.md 的 run.cancelled payload 与 LifecycleTransactionService.CancelRunInput 均要求 requestedBy、terminatedProcessIds、worktreePreserved，reason 可选；字段不得通过 P3D 路由静默伪造。 |
| Cancel 顺序与原子性 | IMPLEMENTED | 02-Runtime-Lifecycle.md Cancel lifecycle、03-Event-Model.md 多 Event 顺序、M3-TD-24/M3-TD-25：按 stage.sequence ASC, stage.id ASC 取消每个非终态 Stage，之后写 run.cancelled；Current State/Event/Outbox/version 必须全成或全回滚。 |
| Progress | IMPLEMENTED | M3-TD-28；OperationService 测试已验证 progress 不接收、不持久化、不返回；P3D GET 必须省略 progress，不得新增列、表、projection 或估算值。 |
| Operation Event Store | NOT REQUIRED | M3-TD-12/M3-TD-30 明确不新增 operation_events；Operation events handler 通过授权后的 runId + correlationId 查询 runtime_events。 |

## 3. 当前实现清单与证据定位

### 3.1 Operation persistence 与服务层

| 组件 | 状态 | 当前事实、文件/符号与为什么 |
| --- | --- | --- |
| Operation 状态/身份持久化 | IMPLEMENTED | apps/server/src/store/OperationRepository.ts 的 OPERATION_TYPES、mapRow、insert、assertOperationCorrelationBinding 读写 workspaceId、aggregateId/runId、correlationId、timestamps、result/error、version。 |
| workspace-scoped Operation lookup | IMPLEMENTED | OperationRepository.findById(workspaceId, operationId) 使用 workspace_id 与 id 条件；OperationService.findById 将缺失映射为稳定 OPERATION_NOT_FOUND。 |
| Operation opaque-id locator | MISSING | OperationRepository 没有与 RunRepository.findWorkspaceIdByOpaqueId 对等的只读 locator；当前顶层 /api/operations/:operationId 没有 workspace path，因而路由无法在解析 body 前完成 workspace-scoped authorization。 |
| 普通 Operation transition | IMPLEMENTED | OperationService.ALLOWED_TRANSITIONS、transitionWithinTransactionAt 做状态/expectedVersion/条件更新；终态不可变，result/error 组合有契约校验。 |
| P3D guarded cancel | MISSING | OperationService 没有 cancelWithinTransaction 或等价 caller-owned cross-aggregate orchestration；现有 transition 不能把 waiting/paused 的取消语义安全地混入普通 transition 表。 |
| OperationService transaction ownership | PARTIAL | create/transition 自己调用 inTransaction，同时存在 createWithinTransaction/transitionWithinTransactionAt 供外层组合；P3D 需要新的 caller-owned cancel seam，但构造函数目前只接收 db，没有 Lifecycle service 依赖。 |

### 3.2 Run、Stage、Lifecycle 与 Runtime Event

| 组件 | 状态 | 当前事实、文件/符号与为什么 |
| --- | --- | --- |
| Run opaque-id locator | IMPLEMENTED | apps/server/src/store/RunRepository.ts 的 findWorkspaceIdByOpaqueId 只读 SELECT workspace_id FROM runs WHERE id = ?；RunRepository.test.ts 的 L01-L05 已覆盖 workspace、未知 id、终态与纯读不变性。该 locator 只能定位 Run，不能替代 Operation locator。 |
| Run versioned lifecycle update | IMPLEMENTED | RunRepository.transitionLifecycleWithinTransaction 使用 workspace/id/status/version 条件更新并抛出 RunNotFoundError、Invalid transition 或 VersionConflictError；为 cancel-vs-complete 提供 optimistic fence。 |
| Stage cancellation transition primitive | IMPLEMENTED | RunStageRepository.transitionLifecycleWithinTransaction 与 LifecycleTransactionService.cancelRunWithinTransactionBody 已按稳定 Stage 顺序逐个更新并写 Event/Outbox；P2C-2B 回滚矩阵与并发测试已通过。 |
| Direct Run cancellation core | PARTIAL | LifecycleTransactionService.cancelRunWithinTransaction 是 caller-owned 且覆盖 queued/starting/running/paused；它显式拒绝 Run waiting_approval。因此部分状态可复用，四状态契约尚未闭合。 |
| Approval-specific cancellation | PARTIAL | LifecycleTransactionService.resolveApprovalToCancellation 可处理 waiting approval 的 approval.resolved -> stage.cancelled* -> run.cancelled，但它要求 approval scope/decision/decidedBy，不是任意 Operation Cancel 的通用 Run input。 |
| Runtime Event append | IMPLEMENTED | apps/server/src/store/RuntimeEventRepository.ts 的 appendWithinTransaction 负责 registry 校验、sequence、durable Event 与 Outbox 组合的底层写入。 |
| Runtime Event operation query | PARTIAL | RuntimeEventRepository.listByRunAndCorrelation(runId, correlationId) 按 sequence ASC 查询，当前不接 workspace 参数；由于 Run ID 为全局主键、Operation 有复合 workspace/run 外键且路由必须先完成 Operation workspace authorization，当前查询可作为 P3D seam，但不能绕过前置授权。 |
| Runtime Event repository 专项测试 | MISSING | 不存在 RuntimeEventRepository.test.ts；当前 query/append 证据由 lifecycle/engine/store 测试间接覆盖。P3D route tests 必须直接验证 Operation correlation 隔离与 Retry 空集合，不得借空结果掩盖授权缺失。 |

### 3.3 Engine、组合根与 HTTP route

| 组件 | 状态 | 当前事实、文件/符号与为什么 |
| --- | --- | --- |
| RunEngine execution authorization | IMPLEMENTED | RunEngine.isExecutionAuthorization 与 tickWithinTransaction 只接受 run.start、queued Run 和唯一 active authorization；现有测试证明 run.create/run.cancel 不会授权 Engine claim。 |
| RunEngine claim/cancel race ownership | IMPLEMENTED | RunEngine.tickWithinTransaction 在 caller-owned BEGIN IMMEDIATE 内先 claim Operation 再 transition Run；文件数据库并发测试已证明一个 winner。P3D cancel 必须复用同一 SQLite transaction ownership，不得新增竞争层。 |
| RunEngine Start completion seam | IMPLEMENTED | RunEngine.completeStartup 重新读取 Run/Operation/Stage，在同一 transaction 调用 completeRunStartupWithinTransaction，随后完成 Start Operation；这是 cancel-vs-complete 的现有对照 seam。 |
| Operation route | MISSING | apps/server/src/index.ts 只挂载 createRunLifecycleRoutes 等既有 router，没有 /api/operations router；三条 P3D endpoint 均不存在。 |
| Locator-first route pattern | IMPLEMENTED | apps/server/src/routes/runLifecycle.ts 的 Start/Retry 路由先 findWorkspaceIdByOpaqueId，再解析 body/query；index.ts 将其挂在全局 express.json 前。该模式可作为 Operation route 的结构参考。 |
| Local safe error mapping | PARTIAL | runLifecycle.ts 有 RUN_LIFECYCLE_ERROR_STATUS 与 sanitized INTERNAL_ERROR；errorHandler.ts 全局 handler 会回传原始 err.message，所以 P3D route 必须自带稳定 code/status/safe message 映射，不能依赖全局 handler。 |
| Store composition | MISSING | apps/server/src/store/SqliteStore.ts 先构造 LifecycleTransactionService，再以裸 database 构造 new OperationService(this.database as any)；二者没有注入关系，当前不能由 OperationService 在一个 caller-owned transaction 中调用 P2 cancel core。 |
| Transaction primitive | IMPLEMENTED | apps/server/src/store/Transaction.ts 的 inTransaction 使用 BEGIN IMMEDIATE、同步 callback、COMMIT/ROLLBACK；Repository 写入不自行开启交易，适合作为唯一外层 transaction。 |

### 3.4 run.cancel、幂等与相邻消费者

| 组件/关键词 | 状态 | 当前事实、文件/符号与为什么 |
| --- | --- | --- |
| run.cancel vocabulary | IMPLEMENTED | OperationRepository.OPERATION_TYPES、idempotency/types.ts、RunEngine.test.ts 均保留 run.cancel；这是既有词汇/历史与 v2 consumer，P3D 不删除或重命名。 |
| 既有 v2 queued cancel | IMPLEMENTED | TaskRunService.cancelQueuedRunForV2 在 idempotency envelope 内调用 cancelRunWithinTransaction，并传入 requestedBy: 'v2_api'、空 terminatedProcessIds、worktreePreserved: false。这是既有 v2 行为，不是 P3D canonical Operation Cancel 的请求契约。 |
| P3D 复用 v2 idempotency | NOT REQUIRED | M3-TD-27 明确 Operation Cancel 不新增 operation.cancel idempotency；既有 run.cancel idempotency envelope 必须保持不变，不能从新顶层 route 复用为隐含协议。 |
| Process/Provider/CLI/Worktree control | NOT REQUIRED | P3D 只编排现有 P2 lifecycle transaction core；本审计不授权直接进入 ProcessManager、provider runtime、CLI、worktree runtime 或 Web。 |

## 4. 读面、事件面与取消面审计

### 4.1 GET /api/operations/:operationId

| 检查点 | 状态 | 结论 |
| --- | --- | --- |
| endpoint/route | MISSING | index.ts 与现有 routes 无 Operation router。 |
| opaque Operation locator | MISSING | 需要 OperationRepository.findWorkspaceIdByOpaqueId（或由 OperationService 暴露同等只读 seam），先从 URL id 得到 workspace，再调用现有 workspace-scoped findById。 |
| authorization precedence | PARTIAL | 现有 Run route 有 locator-first 模式；Operation route 尚不存在。未来必须在 body/query 解析前完成 Operation locator，避免未知 id 泄露 parser/validation 结果。 |
| response projection | PARTIAL | OperationRepository.mapRow 已提供 id/type/status/workspace/aggregate/run/correlation/result/error/timestamps/version；API ApiOperation 还包含可选字段，但 M3-TD-28 明确 P3D 必须省略 progress。HTTP envelope 的具体字段投影与错误 envelope 仍需实现。 |
| cross-workspace isolation | IMPLEMENTED | 现有 Operation reads 使用 workspace 条件；只要 route 不接受客户端 workspace override，locator 后的查询可复用该边界。 |

### 4.2 GET /api/operations/:operationId/events

| 检查点 | 状态 | 结论 |
| --- | --- | --- |
| endpoint/route | MISSING | 当前没有 Operation events route。 |
| authorization order | PARTIAL | 必须先定位/读取 Operation，验证其 workspace、aggregateType、runId、correlationId，再调用 Event repository；不能仅凭 URL id 直接查 Event。 |
| query seam | IMPLEMENTED | RuntimeEventRepository.listByRunAndCorrelation 已按 Run/correlation 与 ascending sequence 查询，满足 M3-TD-12 的数据来源；不需要 operation_events。 |
| correlation binding | IMPLEMENTED | Operation mapper/repository 验证 run.create 与非 create Operation 的 correlation 规则；events route 必须使用已验证的 Operation 字段，不能接受 query/body 中的 runId 或 correlationId。 |
| Retry event semantics | IMPLEMENTED | M3-TD-30 与 API spec 要求 run.retry 按其自身 runId + correlationId 查询，P3 通常为空，不得返回 Child creation 或独立 Start execution Events。 |
| SSE/replay | NOT REQUIRED | 本端点只做 durable read；SSE handoff、replay protocol、stream subscription 不进入 P3D。 |

### 4.3 POST /api/operations/:operationId/cancel

| 检查点 | 状态 | 结论 |
| --- | --- | --- |
| endpoint/route | MISSING | 当前没有 canonical Operation Cancel route。 |
| target validation | PARTIAL | Operation row 已有 aggregate/run binding 与 workspace；但没有 cross-aggregate cancel service method 将 Operation 与 Run/Stage 共同重读、校验、更新。 |
| cancellable statuses | CONFLICT | Owner contract 要求四状态；OperationService.ALLOWED_TRANSITIONS 的 waiting/paused 出边为空。不能把普通 transition 表直接当作 P3D Cancel contract。 |
| terminal behavior | PARTIAL | Operation/Run repository 与 tests 已对 terminal/version fence 提供基础；尚无 P3D-specific completed/failed -> 409 OPERATION_NOT_CANCELLABLE route mapping。 |
| already cancelled behavior | PARTIAL | 状态模型允许 cancelled 且 terminal 不可再转；缺少 Operation Cancel 专用的“返回当前 Operation、零副作用、不再调用 lifecycle”入口与测试。 |
| transaction composition | MISSING | OperationService 与 LifecycleTransactionService 在 SqliteStore 中分离构造；缺少同一 caller-owned BEGIN IMMEDIATE 的跨 aggregate seam。 |
| waiting_approval Run | CONFLICT | 当前 direct cancelRunWithinTransaction 拒绝 Run waiting_approval；approval-specific cancellation 不能无条件替代 Operation Cancel。这里是生产实现前的 STOP CONDITION。 |
| request shape | MISSING | 具体 body/header/actor mapping 未冻结。不能把 v2 requestedBy: 'v2_api' 等默认值静默带入 P3D。 |

## 5. 原子组合、竞态与失败注入准备度

### 5.1 目标交易顺序

M3-TD-27 的目标是一个 caller-owned transaction。未来实现不得拆成两个独立 HTTP/service transaction。建议的可审查顺序如下；这只是 P3D-0 的控制面规划，不是本轮实现授权：

1. 在 BEGIN IMMEDIATE 后，用 Operation opaque-id locator 完成 workspace 解析；在同一 workspace 中重读 Operation。
2. 校验 Operation 的 aggregateType=run、aggregateId=runId、correlation binding 与 target status。
3. 若 Operation 已为 cancelled，直接返回当前 Operation，禁止 lifecycle 调用与任何副作用。
4. 若 Operation 为 completed/failed 或其他不允许状态，返回稳定 409-class OPERATION_NOT_CANCELLABLE；不改 Operation、Run、Stage、Event、Outbox。
5. 重读绑定 Run，并验证 workspace、Run ID、生命周期状态与 expectedVersion/ETag fence。
6. 用 Operation 的 expected status/version 做条件更新为 cancelled；更新失败必须进入 VersionConflict/竞态错误路径，不能继续取消 Run。
7. 调用现有 caller-owned P2 lifecycle cancellation core，按 Stage 顺序取消所有非终态 Stage，写 stage.cancelled 与 Outbox，最后写 run.cancelled 与 Outbox。
8. 任一状态、Event、Outbox、版本或 commit 失败均回滚整个 transaction；成功才返回 Operation snapshot。

| 原子组合点 | 状态 | 证据与缺口 |
| --- | --- | --- |
| 单 SQLite 文件锁 | IMPLEMENTED | Transaction.ts:inTransaction 使用 BEGIN IMMEDIATE，已有 P2C-2A/P2C-2B/RunEngine file-backed concurrency tests。 |
| Operation 条件更新 | IMPLEMENTED | OperationRepository.update 有 expected status/version 条件更新与 version increment；需要由专用 cancel service 正确调用。 |
| Run/Stage/Event/Outbox 原子核心 | PARTIAL | LifecycleTransactionService.cancelRunWithinTransaction 对非 approval 状态已有 caller-owned core；P3D 尚未把 Operation 条件更新纳入同一外层 transaction。 |
| Start completion 对照 | IMPLEMENTED | RunEngine.completeStartup 已把 startup lifecycle 与 Start Operation completion 组合在同一 transaction，证明现有架构可承载 cross-aggregate composition。 |
| Cancel-vs-complete race | PARTIAL | 底层 lock/version 具备；P3D 缺少 cancel Operation 与 Start completion/Engine claim 的互斥测试及稳定 HTTP 结论。 |

### 5.2 Lifecycle Cancel input

| 输入/规则 | 状态 | 当前证据与实现边界 |
| --- | --- | --- |
| workspaceId、expected versions、correlation/causation context | IMPLEMENTED | LifecycleInputBase/RunOnlyCompositeInput 已有 caller-owned composite input 基础；P3D 应使用 Operation 绑定的 Run/correlation，不接受客户端伪造 runId。 |
| requestedBy | PARTIAL | CancelRunInput 要求非空字符串；HTTP actor 来源未由 Operation API 契约冻结。 |
| terminatedProcessIds | PARTIAL | CancelRunInput 要求非空字符串数组元素合法；P3D 不应在路由中假设 ProcessManager 已终止，也不能照抄 v2 空数组作为无声默认。 |
| worktreePreserved | PARTIAL | CancelRunInput 要求 boolean；其可信来源/HTTP 是否可写未冻结。 |
| reason | PARTIAL | Event payload 可选；Operation Cancel request 是否接受、长度/清洗与落盘边界未冻结。 |
| waiting approval | CONFLICT | 现有 cancelRunWithinTransactionBody 允许 queued/starting/running/paused，不允许 waiting_approval；resolveApprovalToCancellation 是 approval decision seam，不能未经 owner review 复用。 |

### 5.3 Failure injection readiness

| 故障点 | 状态 | 现有证据与 P3D 缺口 |
| --- | --- | --- |
| Operation update 失败/VersionConflict | IMPLEMENTED | OperationRepository/OperationService 已覆盖 stale writer 与 one-winner；需要加入 cancel-specific no-follow-on-mutation 断言。 |
| Stage Event/Outbox 写入失败 | IMPLEMENTED | m3-p2c2b-composite-lifecycle.test.ts 已覆盖 lifecycle rollback matrix；P3D 需要把 Operation row 同时纳入快照。 |
| Run Event/Outbox 写入失败 | IMPLEMENTED | P2C-2B 与 RunEngine failure-injection tests 已覆盖底层 rollback；P3D 需要从 Operation Cancel 入口触发。 |
| 外层 COMMIT 失败 | PARTIAL | RunEngine 有组合 transaction failure coverage；无 Operation Cancel route/service 专项断言。 |
| cancel-vs-start claim | PARTIAL | RunEngine 独立 claim 竞态已覆盖；无 cancel Operation 与 queued run.start 的双连接对抗测试。 |
| cancel-vs-start completion | PARTIAL | Start completion seam 已验证，缺少取消在 completion 前/后两种排队顺序的 Operation/Run/Stage 整体结果矩阵。 |

## 6. 错误映射、路由挂载与 schema sufficiency

### 6.1 错误映射

| 错误类别 | 状态 | P3D 约束 |
| --- | --- | --- |
| unknown Operation | IMPLEMENTED | 复用稳定 OPERATION_NOT_FOUND 语义，HTTP 404；必须由 workspace-scoped lookup 触发。 |
| terminal Operation | PARTIAL | M3-TD-27 要求 409-class OPERATION_NOT_CANCELLABLE；当前没有 P3D route map。 |
| expectedVersion/ETag race | PARTIAL | Repository 有 VersionConflictError/条件更新；HTTP header/body 的 exact mapping 未冻结，不能在本文隐含选型。 |
| Operation/Run binding mismatch | MISSING | 契约要求 fail closed 的稳定 conflict，但现有 P3D route/service 没有专用稳定映射；具体 code 需在请求契约/错误契约补齐后实现。 |
| lifecycle validation | PARTIAL | 现有 route 模式可映射 400/404/409；P3D 必须屏蔽 SQLite/SQL/path 原文，不得落入 errorHandler.ts 的 raw message fallback。 |
| unexpected internal error | IMPLEMENTED | 现有 runLifecycle.ts 的 sanitized INTERNAL_ERROR 模式可复用；P3D 应保留稳定 code/message，不回传底层错误。 |

### 6.2 Route mounting

| 检查项 | 状态 | 结论 |
| --- | --- | --- |
| /api mount point | IMPLEMENTED | index.ts 已在 /api 挂载 canonical lifecycle router；P3D Operation router 应继续挂在 /api，不添加 workspace path。 |
| locator-before-parser | IMPLEMENTED | index.ts 在 lifecycle router 后才挂全局 express.json；route-local parser 可保持未知 id 优先级。 |
| operation router | MISSING | 需要新增 apps/server/src/routes/operations.ts 并在 index.ts 精确挂载一次；本轮不创建。 |
| route test | MISSING | 需要新增 apps/server/src/routes/operations.test.ts；必须覆盖 malformed body/query、未知 id、workspace isolation、safe error 与三个端点。 |

### 6.3 Schema sufficiency

| 检查项 | 状态 | 证据与结论 |
| --- | --- | --- |
| Operation table | IMPLEMENTED | 012-m3-runtime-schema.ts 已有 operations 主键、状态/type CHECK、workspace/run 复合外键、unique correlation、result/error/timestamps/version。 |
| Runtime Event query index | IMPLEMENTED | Migration 012 已有 runtime_events_run_correlation_sequence 及 Run/sequence 索引，满足 P3D events read seam。 |
| Run/Stage version | IMPLEMENTED | Migration 006/009 已有 Run/Stage version 与 lifecycle 字段，P2 transaction core 已使用。 |
| Migration registry | IMPLEMENTED | default-registry.ts 只注册 001…013；SqliteStore.test.ts 校验该序列。 |
| Migration 014 | NOT REQUIRED | 现有主键、复合外键、唯一约束、version 与查询索引已经足够；本审计不新增 Migration 014，也不授权任何 schema DDL。 |
| progress persistence | NOT REQUIRED | M3-TD-28 明确禁止；无列/表/估算 projection。 |

## 7. Gap matrix 与阻断项

| Gap | 状态 | 证据 | 影响 | P3D-0 结论 |
| --- | --- | --- | --- | --- |
| Operation opaque-id locator 缺失 | MISSING | OperationRepository.findById 需要 workspace；没有 findWorkspaceIdByOpaqueId。 | 三个顶层 endpoint 无法安全 locator-first。 | 进入 P3D-1 read surface 的最小 repository/service allowlist。 |
| Operation route 三端点缺失 | MISSING | index.ts 无 /api/operations。 | P3D read/cancel HTTP surface 不存在。 | 进入未来 route + route tests allowlist。 |
| Operation events handler 缺失 | MISSING | 无 route；底层 listByRunAndCorrelation 已存在。 | 无法提供授权后的 Event read。 | 不新增 operation_events；只增加 route。 |
| OperationService 没有 cross-aggregate cancel orchestration | MISSING | 构造函数无 Lifecycle dependency；只有普通 transition。 | 不能以一笔交易同时更新 Operation 与 Run/Stage/Event/Outbox。 | 需要扩展 OperationService，并在 SqliteStore 注入已有 Lifecycle service。 |
| waiting_approval direct Run cancel | CONFLICT | cancelRunWithinTransactionBody 显式排除 waiting_approval；approval-specific seam 需要 approval decision。 | M3-TD-27 四状态目标无法由当前 P2 cancel input 完成。 | STOP CONDITION；LifecycleTransactionService 默认 FORBIDDEN，不得静默改成 REQUIRED。 |
| Cancel request exact shape | MISSING | Operation API 只冻结 endpoint/ApiOperation，未冻结 body/header/actor fields。 | 无法合法决定 requestedBy/terminatedProcessIds/worktreePreserved/reason/ETag mapping。 | owner contract review 是 P3D-2 开始前置条件。 |
| guarded cancel status path | CONFLICT | 普通 ALLOWED_TRANSITIONS 不允许 waiting/paused 出边。 | Option A 会扩大普通 transition 语义；Option B 需要独立 guard。 | 推荐 Option B，保留普通 lifecycle table，专门实现 expected status/version cancel。 |
| Operation + lifecycle failure matrix 缺失 | PARTIAL | 各子系统已有 rollback tests，但没有跨 aggregate P3D cancel tests。 | 无法证明 no partial 与 no failed invariant。 | P3D-3 RED/GREEN 必须补齐，且仅在实现获授权后。 |
| Schema/014 | NOT REQUIRED | Migration 012/006/009/registry 001…013 已覆盖。 | 新 migration 会扩大冻结范围且无需求。 | 明确禁止创建 Migration 014。 |

### 7.1 阻断与非阻断判断

- STOP CONDITION — waiting_approval：CONFLICT。M3-TD-27 要求 Operation waiting_approval 可取消，但当前通用 lifecycle cancel seam 明确拒绝对应 Run 状态。resolveApprovalToCancellation 的输入语义不同。没有 owner 对最小 lifecycle seam 或契约重新确认前，不得进入 P3D-2 production implementation。
- STOP CONDITION — request contract：MISSING。在 requestedBy、terminatedProcessIds、worktreePreserved、reason、expectedVersion/ETag 的来源和 HTTP 形状未定前，不得使用 v2 默认值或自行发明 canonical body。
- Implementation composition gap：MISSING。当前 SqliteStore 没有把 OperationService 与 LifecycleTransactionService 组合起来；这可以在授权后的 allowlist 中作为最小 composition 修复，但不能在本轮偷偷修改。
- Schema blocker：NOT REQUIRED。Migration 012 已提供 P3D 所需结构；Migration 014 不属于解决方案。
- Remote checks：PARTIAL。远程 status 不可用/无 workflow runs，不能作为通过证据；不阻止本地 docs-only audit commit，但最终必须标明 NOT PASS。

## 8. 决策记录

| 决策 | 状态 | 理由 |
| --- | --- | --- |
| Cancel 状态采用 Option B：专用 guarded cancel | IMPLEMENTED | 保持普通 OperationService.ALLOWED_TRANSITIONS 的既有语义与 Engine selector 不变；专用方法检查四类允许状态、expected status/version、terminal fence，且只由 canonical Operation Cancel 调用。 |
| 不采用 Option A 直接扩展普通 transition 表 | NOT REQUIRED | 直接给 waiting/paused 增加普通出边会扩大所有 transition caller 的语义，削弱 Cancel 专用 guard 与审计边界。 |
| 保留 run.cancel 既有词汇/idempotency | IMPLEMENTED | 既有 idempotency 与 Engine negative authorization 测试依赖它；P3D 不删除、不改名、不另造 operation.cancel idempotency。 |
| GET 不持久化/返回 progress | IMPLEMENTED | M3-TD-28 已冻结，当前 OperationService 测试已证明。 |
| 不新增 operation_events | NOT REQUIRED | 复用已授权的 Run Event Store 查询。 |
| LifecycleTransactionService 默认不修改 | IMPLEMENTED | 用户边界和旧 P3 计划都要求核心不足时 STOP/re-open review；当前 waiting_approval 缺口正是该 STOP 条件。 |
| SqliteStore 进入未来 composition allowlist | PARTIAL | 不是业务扩展，而是当前构造关系的必要闭合；本轮只记录，不编辑。 |
| 不创建 Migration 014 | NOT REQUIRED | schema sufficiency 已闭合。 |

## 9. 推荐 allowlist（未来生产实现，不是本轮授权）

### 9.1 REQUIRED

以下是按当前代码事实重算后的最小必需文件；只允许与 P3D endpoint、atomic cancel、tests 直接相关的行：

1. apps/server/src/routes/operations.ts（新增）：三条 canonical Operation endpoint、locator-first、safe error mapping、response projection。
2. apps/server/src/routes/operations.test.ts（新增）：HTTP contract、unknown/malformed precedence、workspace isolation、event correlation、cancel outcomes。
3. apps/server/src/services/OperationService.ts：Operation locator facade、Operation read projection 所需 seam、专用 caller-owned cancelWithinTransaction orchestration。
4. apps/server/src/services/OperationService.test.ts：Option B status guard、already-cancelled zero side effect、binding/version/no-partial contract。
5. apps/server/src/store/OperationRepository.ts：仅在其上新增 findWorkspaceIdByOpaqueId 只读 locator 及必要测试支持；不得改 identity/correlation/schema contract。
6. apps/server/src/store/OperationRepository.test.ts：locator workspace/unknown/pure-read/isolation cases。
7. apps/server/src/store/SqliteStore.ts：仅用于把已有 LifecycleTransactionService/transaction ownership 注入 OperationService，闭合当前 composition gap。
8. apps/server/src/index.ts：只新增一次 /api Operation router mount，保持 locator-first 的 parser 顺序。

### 9.2 CONDITIONAL

| 文件/范围 | 触发条件 | 限制 |
| --- | --- | --- |
| apps/server/src/services/LifecycleTransactionService.ts | 只有 owner 明确批准最小 waiting_approval direct-cancel seam，且 P3D-2 不可能通过现有 service composition 时才可重新审查。 | 默认 FORBIDDEN；当前审计已标记 STOP CONDITION，不能因实现方便而自动升为 REQUIRED。 |
| apps/server/src/store/RuntimeEventRepository.ts | 独立 security review 证明必须把 workspace predicate 物理下推到 Event query。 | 当前已授权 Operation 前置校验 + 全局 Run ID/复合 FK 足够；若不满足触发条件，不改。 |
| apps/server/src/store/RuntimeEventRepository.test.ts（新增） | 需要直接锁定 query seam 的 workspace/correlation regression，或上项被批准。 | 不新增 Event schema；只能覆盖已有 repository 行为。 |

### 9.3 FORBIDDEN

以下本轮与 P3D-0 后续默认均禁止触碰，除非另有独立 owner authorization：

- Shared 类型/DTO/Registry 与 packages/shared；
- 任意 Migration、default-registry.ts、Migration 014 或数据库 DDL/index；
- RunEngine.ts、runLifecycle.ts、TaskRunService.ts、ProcessManager/provider runtime/CLI/worktree runtime；
- RunRepository.ts、RunStageRepository.ts 的既有 lifecycle semantics（除非 conditional owner gate 明确重开）；
- SSE/replay/OpenAPI completion、Web UI、非 Run Operation、policy 与 production cutover；
- 删除/重命名 run.cancel、改变既有 idempotency envelope、增加 operation.cancel idempotency；
- 任何在本轮两份文档之外的文件。

## 10. P3D-0 结论

| 结论 | 状态 | 说明 |
| --- | --- | --- |
| P3D-0 文档审计 | IMPLEMENTED | 当前状态、契约、代码 seam、schema、竞态、失败注入、gap 与 allowlist 已记录。 |
| P3D-1 production implementation | NOT REQUIRED | 本轮不授权；未来需要先完成 read surface allowlist 与测试。 |
| P3D-2 production implementation | NOT REQUIRED | 本轮不授权；且受 waiting_approval/request contract 两个 STOP CONDITION 约束。 |
| P3D-3 production implementation | NOT REQUIRED | 本轮不授权；须在 P3D-2 后以独立 race/failure closure 进入。 |
| P3E | NOT REQUIRED | 未进入、未授权。 |
| Migration 014 | NOT REQUIRED | 未创建；当前 schema 足够。 |
| Production cutover | NOT REQUIRED | 未执行。 |
## 11. 定向测试文件清单

本审计记录的第二次通过命令使用以下实际文件：

- apps/server/src/services/OperationService.test.ts
- apps/server/src/store/OperationRepository.test.ts
- apps/server/src/services/m3-p2c2a-lifecycle-transaction.test.ts
- apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts
- apps/server/src/services/run-engine/RunEngine.test.ts
- apps/server/src/routes/runLifecycle.test.ts
- apps/server/src/store/__tests__/RunRepository.test.ts
- apps/server/src/store/SqliteStore.test.ts

另行执行并通过：

- apps/server/src/store/RunStageRepository.test.ts（9/9 pass，退出码 0）
