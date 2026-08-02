# AgentOS Runtime Specification v2.0

## 02 — Runtime Lifecycle

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Runtime Execution Lifecycle  
> Depends On:
> - `00-Vision.md`
> - `01-Core-Concepts.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 中一次工程任务从“被提出”到“被接受或终止”的完整 Runtime 生命周期。

它描述：

- Conversation 如何产生 Task；
- Task 如何创建 Run；
- Run 如何进入队列；
- Runtime 如何生成 Snapshot；
- Worktree 如何创建；
- Memory 如何检索；
- Workflow 如何实例化；
- Stage 如何调度；
- Provider Session 如何启动；
- Runtime Process 如何管理；
- Runtime Event 如何产生；
- Policy 和 Approval 如何介入；
- Run 如何暂停、恢复、取消、失败和重试；
- Artifact 如何生成；
- Memory 如何沉淀；
- Worktree 如何 Review、Merge 和 Cleanup；
- Server 重启后如何恢复；
- 页面断线后如何重新订阅；
- Task 如何最终被接受为完成。

本文件是以下模块的行为规范：

- Run Engine；
- Workflow Executor；
- Stage Executor；
- Provider Adapter；
- Process Manager；
- Worktree Manager；
- Memory Engine；
- Policy Engine；
- Approval Center；
- Artifact Manager；
- Event Store；
- SSE / WebSocket Gateway；
- Runtime Inspector；
- Recovery Manager。

---

## 2. Lifecycle Design Goals

AgentOS v2 的 Runtime Lifecycle 必须满足以下目标。

### 2.1 Durable

执行状态必须持久化。

浏览器刷新、网络断开或前端关闭，不得自动销毁 Run。

### 2.2 Observable

生命周期中的每个重要行为必须产生 Runtime Event。

### 2.3 Recoverable

Server 重启后必须能够识别：

- 已完成 Run；
- 未完成 Run；
- 存活进程；
- 孤儿进程；
- 待审批 Run；
- 可恢复 Provider Session；
- 未清理 Worktree。

### 2.4 Isolated

修改型 Run 默认在独立 Worktree 中执行。

### 2.5 Provider-Agnostic

Run Engine 不应包含 Codex、KimiCode、OpenCode 等 Provider 特定流程。

Provider 差异由 Adapter 处理。

### 2.6 Auditable

Run 的：

- 输入；
- Snapshot；
- Event；
- Approval；
- Process；
- Artifact；
- Memory Context；
- Error；
- Merge；

都必须可追踪。

### 2.7 Idempotent

重复请求、网络重试和 Server 重启不得重复创建关键资源或重复执行同一状态迁移。

### 2.8 Human-Controlled

用户必须能够：

- 暂停；
- 继续；
- 取消；
- 批准；
- 拒绝；
- 重试；
- 切换 Provider；
- 放弃 Worktree；
- 决定是否接受完成结果。

---

## 3. Lifecycle Layers

完整生命周期分为五个层次。

```text
Product Lifecycle
  Conversation → Task → Acceptance

Execution Lifecycle
  Run → Stage → Completion

Provider Lifecycle
  Provider Session → Runtime Process → Provider Events

Code Lifecycle
  Workspace → Worktree → Diff → Review → Merge / Abandon

Knowledge Lifecycle
  Memory Retrieval → Context Injection → Memory Extraction → Persistence
```

这些生命周期彼此关联，但不能混为同一个状态机。

---

## 4. Top-Level Flow

```text
User Message
    ↓
Task Created
    ↓
Run Requested
    ↓
Run Validation
    ↓
Snapshot Creation
    ↓
Workflow Resolution
    ↓
Worktree Preparation
    ↓
Memory Retrieval
    ↓
Run Queued
    ↓
Run Starting
    ↓
Stage Scheduling
    ↓
Provider Session Starting
    ↓
Runtime Process Running
    ↓
Runtime Events
    ↓
Policy / Approval / Tool / File / Git Activity
    ↓
Stage Completion
    ↓
Next Stage or Run Completion
    ↓
Artifact Finalization
    ↓
Run Summary
    ↓
Memory Extraction
    ↓
Review / Merge / Abandon
    ↓
Task Acceptance or New Run
```

---

# Part I — Task Lifecycle

## 5. Task Creation

### 5.1 Creation Sources

Task 可以通过以下来源创建：

- User 在 Conversation 中创建；
- User 从 Message 转换；
- User 在 Task 页面手动创建；
- Workflow 创建子 Task；
- 外部 API 创建；
- Extension 创建；
- 系统恢复时重建缺失 Task 引用。

### 5.2 Required Input

```ts
interface CreateTaskInput {
  workspaceId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  sourceConversationId?: string;
  sourceMessageId?: string;
  assignedAgentId?: string;
  createdBy: string;
  idempotencyKey?: string;
}
```

### 5.3 Creation Sequence

```text
Receive create task request
  ↓
Validate Workspace
  ↓
Validate source Conversation / Message
  ↓
Validate assigned Agent
  ↓
Check idempotency key
  ↓
Persist Task(status=open)
  ↓
Emit task.created
  ↓
Optionally post task-reference Message
```

### 5.4 Task Does Not Auto-Run by Default

创建 Task 不等于启动 Run。

默认流程：

```text
Task Created
  ↓
User reviews configuration
  ↓
Run requested
```

可以通过 Workspace 设置开启自动运行，但必须显式配置。

### 5.5 Task State Machine

```text
open
  ├── run starts → in_progress
  ├── dependency unresolved → blocked
  └── user cancels → cancelled

in_progress
  ├── accepted completion → done
  ├── all active runs end without acceptance → open
  ├── external dependency required → blocked
  └── user cancels intent → cancelled

blocked
  ├── unblocked → open
  └── user cancels → cancelled

done
  └── reopen → open

cancelled
  └── reopen → open
```

### 5.6 Task Completion

Task `done` 不应仅由 `Run.status === completed` 自动决定。

Task 进入 `done` 需要：

- User 接受；
- Workflow 明确自动接受；
- Policy 允许自动接受；
- 验收条件满足。

---

# Part II — Run Creation Lifecycle

## 6. Run Request

### 6.1 Definition

Run Request 表示用户或系统希望对一个 Task 发起一次新的执行尝试。

### 6.2 Input

```ts
interface CreateRunInput {
  taskId: string;
  workflowDefinitionId?: string;
  agentOverrides?: Record<string, string>;
  providerOverrides?: Record<string, string>;
  policyProfileId?: string;
  worktreeMode?: WorktreeMode;
  memoryBudget?: MemoryBudget;
  parentRunId?: string;
  reason:
    | 'initial'
    | 'retry'
    | 'resume-fallback'
    | 'review-fix'
    | 'provider-comparison'
    | 'manual';
  createdBy: string;
  idempotencyKey?: string;
}
```

### 6.3 Preconditions

Run 创建前必须验证：

- Task 存在且未归档；
- Workspace 存在；
- Task 未被永久取消；
- Workflow 可用；
- Agent 可用；
- Provider Configuration 可用；
- Policy Profile 可用；
- Workspace Path 可访问；
- Git 状态符合 Worktree 要求；
- 当前并发限制允许；
- 没有重复 idempotency key。

### 6.4 Creation Transaction

Run 创建应在一个数据库事务内完成：

1. 创建 Run；
2. 设置 `status = queued`；
3. 创建 Run Snapshot；
4. 创建 Stage Records；
5. 预留 Event Sequence；
6. 发出 `run.created`；
7. 更新 Task 状态；
8. 写入 Queue Record。

任何步骤失败，事务必须回滚。

---

## 7. Run Snapshot Lifecycle

### 7.1 Snapshot Timing

Snapshot 必须在 Run 开始执行前创建。

### 7.2 Snapshot Contents

Run Snapshot 应包含：

- Workspace execution settings；
- Task title and description；
- Workflow Definition version；
- Agent Snapshot；
- Provider Configuration Snapshot；
- Policy Profile Snapshot；
- Environment Profile references；
- Memory Budget；
- Worktree Mode；
- Base Branch；
- Base Commit；
- Timeout Policy；
- User overrides。

### 7.3 Snapshot Immutability

Run 开始后，Snapshot 不允许修改。

需要改变配置时：

- 创建新 Run；
- 或创建 Child Run；
- 不允许直接篡改历史 Run。

### 7.4 Snapshot Failure

Snapshot 创建失败时：

```text
Run remains queued or moves to failed
Error Code: RUN_SNAPSHOT_FAILED
No Provider Process may start
```

---

# Part III — Queue and Scheduling

## 8. Run Queue

### 8.1 Queue Responsibilities

Queue 负责：

- 排队；
- 并发限制；
- Workspace 锁；
- Provider 并发限制；
- 优先级；
- 重启恢复；
- 取消尚未启动的 Run。

### 8.2 Queue State

Run 在 Queue 中保持：

```text
status = queued
```

### 8.3 Scheduling Priority

推荐优先级：

```text
critical
high
normal
low
```

同一优先级按：

```text
createdAt ascending
```

### 8.4 Concurrency Dimensions

必须支持以下并发限制：

- 全局 Run 并发；
- 每 Workspace 并发；
- 每 Provider 并发；
- 每 Provider Configuration 并发；
- 每 Agent 并发；
- 修改型 Run 并发；
- Worktree 创建并发。

### 8.5 Workspace Concurrency

默认建议：

- 只读 Run 可并行；
- 修改型 Run 使用独立 Worktree 后可并行；
- 主 Workspace 直接修改模式仅允许一个活动 Run；
- Merge 操作必须串行。

### 8.6 Queue Events

```text
run.queued
run.dequeued
run.queue_position_updated
run.queue_blocked
```

`run.dequeued` is the canonical Event for the single Run transition
`queued → starting`. It records scheduler acquisition and the beginning of
startup preparation; it does not mean that the Run or a Provider is already
running.

---

# Part IV — Run Startup

## 9. Run Starting State

当 Scheduler 选择 Run 后：

```text
queued → starting
```

### 9.1 Startup Transaction

必须原子化：

- 确认 Run 未被取消；
- 获取执行锁；
- 将状态从 `queued` 原子更新为 `starting`；
- 生成 `run.dequeued` Event；
- 开始启动资源准备。

### 9.2 Startup Phases

```text
1. Validate Snapshot
2. Resolve Workflow
3. Resolve Stage Graph
4. Validate Providers
5. Prepare Worktree
6. Retrieve Memory
7. Build Prompt Context
8. Initialize Event Stream
9. Start first eligible Stage
```

### 9.3 Startup Completion Transaction

启动完成事务必须满足：

- 所有启动前检查成功；
- 第一个 eligible Stage 完成 `starting → running`；
- Run 在同一事务中完成 `starting → running`；
- 首次写入 `runs.started_at`；
- 生成 `run.started` Event；
- Current State、Runtime Event 与 Outbox 在同一事务中原子提交。

`run.started` 只能在上述启动完成事务中生成，不能在
`queued → starting` 事务中生成。

### 9.4 Startup Failure

任何启动阶段失败都必须：

- 生成结构化错误；
- 记录失败 Phase；
- 清理已创建资源；
- 更新 Run 为 `failed`；
- 发出 `run.failed`；
- 保留 Debug Artifact。

---

# Part V — Worktree Preparation

## 10. Worktree Decision

### 10.1 Modes

```ts
type WorktreeMode =
  | 'required'
  | 'preferred'
  | 'disabled';
```

### 10.2 Decision Rules

修改型 Workflow：

- 默认 `required`；
- 非 Git Workspace 无法满足时，Run 应失败或用户显式降级；
- 不允许静默回退到主目录。

只读 Workflow：

- 可以不创建 Worktree；
- 仍应记录 working directory。

### 10.3 Worktree Creation Sequence

```text
Resolve Workspace Git root
  ↓
Resolve base branch
  ↓
Resolve base commit
  ↓
Generate branch name
  ↓
Reserve Worktree record
  ↓
Execute git worktree add
  ↓
Verify path
  ↓
Persist active status
  ↓
Emit worktree.created
```

### 10.4 Branch Naming

```text
agentos/run/<runId>/<agent-or-workflow-slug>
```

### 10.5 Worktree Failure

失败后：

- 不启动 Provider；
- 清理部分目录；
- 删除无效分支或标记待清理；
- 发出 `worktree.create_failed`；
- Run 进入 `failed`。

### 10.6 Worktree Reuse

v2 Foundation 默认不复用不同 Run 的 Worktree。

Resume 同一 Run 时可以继续使用原 Worktree。

Retry 创建新 Run，默认创建新 Worktree。

---

# Part VI — Memory Retrieval

## 11. Memory Retrieval Lifecycle

### 11.1 Trigger

在 Provider Prompt 构建前进行。

### 11.2 Retrieval Scopes

推荐查询顺序：

```text
Run
Task
Conversation
Agent
Workspace
Global
```

### 11.3 Retrieval Input

```ts
interface RetrieveMemoryInput {
  workspaceId: string;
  taskId: string;
  runId: string;
  conversationId?: string;
  agentId: string;
  queryText: string;
  categories?: MemoryCategory[];
  budget: MemoryBudget;
}
```

### 11.4 Retrieval Sequence

```text
Build retrieval query
  ↓
Query FTS and structured filters
  ↓
Rank by relevance
  ↓
Apply scope priority
  ↓
Apply importance and recency
  ↓
Deduplicate
  ↓
Apply budget
  ↓
Create Memory Context
  ↓
Persist selected memory IDs
  ↓
Emit memory.retrieved
```

### 11.5 Retrieval Failure

Memory Retrieval 失败默认不应阻止 Run，除非 Workflow 明确要求。

降级行为：

- 创建 warning Event；
- 使用无 Memory Context；
- 在 Run Summary 中记录。

### 11.6 Memory Context Immutability

一次 Stage 启动时使用的 Memory Context 必须保存。

Stage 执行中新增 Memory 不自动注入当前 Provider Session，除非 Provider 支持并显式请求。

---

# Part VII — Workflow Instantiation

## 12. Workflow Resolution

### 12.1 Resolution Sources

Workflow 可来自：

- Run Request 显式选择；
- Task 默认；
- Workspace 默认；
- Conversation command；
- Planner 选择；
- Built-in Single Agent Workflow。

### 12.2 Resolution Priority

```text
Run override
  > Task setting
  > Conversation instruction
  > Workspace default
  > System default
```

### 12.3 Workflow Validation

必须检查：

- Stage Key 唯一；
- 依赖图无环；
- Agent Selector 可解析；
- Provider 可用；
- 并行修改规则有效；
- Approval Gate 有效；
- Retry Policy 有效；
- Completion Rule 有效。

### 12.4 Stage Graph

Workflow 实例化后生成 Stage Graph。

```text
Stage A
├── Stage B
└── Stage C
      ↓
Stage D
```

### 12.5 Fixed v1 Pipeline Migration

v1 固定流程：

```text
Codex Manager
KimiCode Worker
OpenCode Reviewer
Codex Final Review
```

迁移为一个 Built-in Workflow Definition。

Run Engine 不得知道这些固定名称。

---

# Part VIII — Stage Lifecycle

## 13. Stage State Machine

```text
pending
  ↓ dependencies satisfied
ready
  ↓ scheduled
starting
  ↓ provider session active
running
  ├── waiting_approval
  ├── paused
  ├── completed
  ├── failed
  └── cancelled
```

建议 Stage Status：

```ts
type StageStatus =
  | 'pending'
  | 'ready'
  | 'starting'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped';
```

### 13.1 Pending

Stage 已创建，但依赖未满足。

### 13.2 Ready

依赖已满足，等待 Scheduler。

### 13.3 Starting

正在准备：

- Agent Snapshot；
- Provider Snapshot；
- Prompt；
- Session；
- Process；
- Stage-specific Worktree。

### 13.4 Running

Provider 已开始执行。

### 13.5 Waiting Approval

当前 Stage 因 Approval 暂停。

### 13.6 Completed

Stage 满足 Completion Contract。

### 13.7 Failed

Stage 无法完成。

### 13.8 Skipped

Workflow 条件决定跳过。

---

## 14. Stage Startup

### 14.1 Sequence

```text
Stage ready
  ↓
Acquire stage execution lock
  ↓
Set starting and emit stage.starting
  ↓
Resolve Agent
  ↓
Resolve Provider
  ↓
Create snapshots
  ↓
Resolve working directory
  ↓
Build prompt
  ↓
Create Provider Session
  ↓
Start Runtime Process
  ↓
Confirm Provider active and freeze snapshots
  ↓
Set running, first write started_at, and emit stage.started
```

Stage transition Event ownership is fixed as follows:

- `ready → starting` emits `stage.starting` after scheduling rights are
  acquired and Provider startup preparation begins;
- `starting → running` emits `stage.started` only after the Provider is
  confirmed active and the Agent/Provider snapshots are frozen;
- `stage.started` never represents `ready → starting`.

`run_stages.started_at` is written for the first time only in the transaction
that enters `running` and emits `stage.started`.

### 14.2 Stage Prompt Composition

Prompt Builder 可以组合：

- Task；
- Current Stage；
- Agent role；
- Workflow instruction；
- Memory Context；
- Previous Stage Summaries；
- Artifact references；
- Worktree status；
- Policy guidance；
- User Message；
- Output Contract。

Prompt 必须生成 Prompt Artifact 或 Prompt Metadata，以支持审计。

Secret 必须脱敏。

### 14.3 Previous Stage Output

默认不应把全部 stdout 直接注入。

应优先使用：

- Stage Summary；
- Structured Output；
- Artifact；
- Selected Runtime Events；
- Diff；
- Review Findings。

---

# Part IX — Provider Session Lifecycle

## 15. Provider Validation

Provider 启动前必须验证：

- executable 存在；
- 登录状态；
- 必要环境变量；
- 工作目录；
- Provider capability；
- CLI 版本；
- 配置合法性。

### 15.1 Validation Cache

可缓存短期验证结果，但启动前必须确认关键配置未变化。

### 15.2 Auth Required

未登录时：

```text
PROVIDER_AUTH_REQUIRED
```

不得被误报为通用 Process Error。

---

## 16. Provider Session Creation

### 16.1 Session Sequence

```text
Create ProviderSession(status=starting)
  ↓
Adapter.start()
  ↓
Native session ID discovered
  ↓
Runtime Process registered
  ↓
ProviderSession(status=active)
  ↓
Emit provider.session_started
```

### 16.2 Native Session ID

Provider 支持时必须记录。

用途：

- Resume；
- Debug；
- History；
- Provider Inspector。

### 16.3 Session and Process

一个 Provider Session 可以：

- 对应一个长驻 Process；
- 跨多个 Process；
- 由 API 实现而没有 PID；
- 在 Approval 后继续；
- 在断线后恢复。

---

# Part X — Runtime Process Lifecycle

## 17. Process Startup

### 17.1 Sequence

```text
Resolve executable
  ↓
Resolve arguments
  ↓
Resolve environment
  ↓
Redact secrets for audit
  ↓
Spawn process
  ↓
Record PID
  ↓
Attach stdout/stderr listeners
  ↓
Attach exit/error listeners
  ↓
Start heartbeat and idle timer
  ↓
Emit process.started
```

### 17.2 Process Environment

环境变量来源优先级：

```text
Run Override
  > Provider Environment Profile
  > Workspace Environment Profile
  > AgentOS Process Environment
  > System Environment
```

需要明确允许列表和 Secret 管理。

### 17.3 Working Directory

优先：

```text
Stage Worktree
  > Run Worktree
  > Workspace Root for read-only
  > Explicit custom path after policy validation
```

### 17.4 Activity Tracking

以下行为更新 `lastActivityAt`：

- stdout；
- stderr；
- Provider Event；
- Tool Event；
- File Event；
- Heartbeat；
- Approval response；
- Session response。

---

## 18. Timeout Lifecycle

### 18.1 Timeout Types

```ts
interface TimeoutPolicy {
  startupTimeoutMs: number;
  idleTimeoutMs: number | null;
  totalTimeoutMs: number | null;
  approvalTimeoutMs: number | null;
  toolTimeoutMs?: number | null;
}
```

### 18.2 Startup Timeout

Provider 未在指定时间内进入 active。

### 18.3 Idle Timeout

一段时间内无任何活动。

默认应优先使用 Idle Timeout，而不是固定总时长。

### 18.4 Total Timeout

可选。

复杂工程任务默认可以关闭。

### 18.5 Approval Timeout

默认可以关闭。

等待用户审批不应计入 Idle Timeout。

### 18.6 Timeout Sequence

```text
Timeout detected
  ↓
Emit timeout event
  ↓
Request graceful stop
  ↓
Wait grace period
  ↓
Kill process tree
  ↓
Persist exit state
  ↓
Fail Stage / Run
```

---

## 19. Process Exit

### 19.1 Exit Types

- Normal exit；
- Non-zero exit；
- Spawn error；
- Cancelled；
- Idle timeout；
- Total timeout；
- Policy terminated；
- Server shutdown；
- Orphan cleanup。

### 19.2 Exit Is Not Completion

Process exit code 0 不等于 Stage 完成。

Stage 还需要：

- Provider Adapter finalize；
- Output Contract validation；
- Artifact finalization；
- Workflow completion check。

### 19.3 Windows Process Tree

Windows 下取消必须处理完整子进程树。

优先：

1. Windows Job Object；
2. `taskkill /PID <pid> /T /F` fallback；
3. 检查残留进程；
4. 发出 cleanup Event。

---

# Part XI — Runtime Event Lifecycle

## 20. Event Production

Runtime Event 可以来自：

- Run Engine；
- Stage Executor；
- Provider Adapter；
- Process Manager；
- Worktree Manager；
- Memory Engine；
- Policy Engine；
- Approval Center；
- Artifact Manager；
- Git Runtime；
- Extension。

### 20.1 Event Write Order

推荐：

```text
Create event payload
  ↓
Reserve run sequence
  ↓
Persist event
  ↓
Commit transaction
  ↓
Publish to Event Bus
  ↓
Stream to clients
```

### 20.2 Broadcast Failure

Event 已持久化但广播失败时：

- 不回滚 Event；
- 客户端通过 sequence 重连补齐。

### 20.3 Event Stream Resume

客户端提供：

```text
Last-Event-ID
```

或：

```text
afterSequence
```

Server 返回缺失 Event。

### 20.4 Duplicate Event Prevention

使用：

- Event ID；
- Run Sequence；
- Provider native event ID；
- Idempotency key。

---

# Part XII — Policy and Approval Lifecycle

## 21. Policy Evaluation

### 21.1 Evaluation Points

Policy 必须在以下行为前评估：

- 启动 Provider；
- 执行命令；
- 访问路径；
- 删除文件；
- 网络请求；
- 安装包；
- Git Push；
- Merge；
- Secret Access；
- 创建外部 Process；
- 调用高风险 Tool。

### 21.2 Decision Flow

```text
Action requested
  ↓
Normalize action
  ↓
Evaluate Policy
  ├── allow
  ├── deny
  └── require_approval
```

### 21.3 Allow

- 产生 `policy.allowed`；
- 继续执行。

### 21.4 Deny

- 产生 `policy.denied`；
- Provider 收到拒绝；
- Stage 是否失败由 Workflow 决定。

### 21.5 Require Approval

- 创建 Approval Request；
- 产生 `approval.required`；
- Stage 和 Run 进入 `waiting_approval`；
- 暂停相关动作；
- Process 可保持等待或安全挂起。

---

## 22. Approval Resolution

### 22.1 User Decisions

```ts
type ApprovalDecision =
  | 'approve_once'
  | 'approve_run'
  | 'approve_workspace'
  | 'reject'
  | 'cancel_run';
```

### 22.2 Resolution Sequence

```text
User submits decision
  ↓
Validate approval is pending
  ↓
Persist decision
  ↓
Emit approval.resolved
  ↓
Update policy cache if scoped approval
  ↓
Resume provider or reject action
  ↓
Restore Stage / Run state
```

### 22.3 Approval Concurrency

同一个 Approval 只能成功决策一次。

重复请求返回已存在结果。

### 22.4 Approval Rejection

拒绝不一定使 Run 失败。

可能：

- Provider 选择替代方案；
- Workflow 跳过当前动作；
- Stage 完成但有 warning；
- Stage 失败；
- Run 取消。

---

# Part XIII — Pause, Resume, Cancel

## 23. Pause Lifecycle

### 23.1 Pause Definition

Pause 表示保留 Run 状态，但停止继续调度或要求 Provider 暂停。

### 23.2 Pause Types

- User Pause；
- Policy Pause；
- Approval Pause；
- Scheduler Pause；
- System Maintenance Pause。

### 23.3 Pause Sequence

```text
Pause requested
  ↓
Validate Run is pausable
  ↓
Stop scheduling new stages
  ↓
Request provider pause if supported
  ↓
Otherwise safely stop and preserve session
  ↓
Persist paused state
  ↓
Emit run.paused
```

### 23.4 Provider Without Pause

如果 Provider 不支持原生 Pause：

- 可允许当前操作结束后暂停；
- 或停止 Process 并尝试 Session Resume；
- 或创建 Resume Child Run；
- UI 必须明确暂停语义。

---

## 24. Resume Lifecycle

### 24.1 Resume Paths

#### Native Resume

Provider 支持 nativeSessionId：

```text
paused Run
  ↓
Adapter.resume()
  ↓
Session active
  ↓
Run running
```

#### Process Restart Resume

Provider 可从 Worktree 和 Session Metadata 恢复。

#### Child Run Fallback

无法恢复原 Run 时：

- 原 Run 保持终态；
- 创建 Child Run；
- `parentRunId = previousRun.id`；
- reason = `resume-fallback`。

### 24.2 Resume Validation

必须检查：

- Worktree 存在；
- Provider 配置仍可用；
- Session 可恢复；
- Policy 未变化到禁止；
- Base Commit 关系仍有效；
- 没有冲突活动 Run。

---

## 25. Cancel Lifecycle

### 25.1 Cancel Semantics

Cancel 是用户明确终止 Run。

它不同于：

- 页面关闭；
- SSE 断线；
- Provider 临时无输出；
- Pause。

### 25.2 Cancel Sequence

```text
Cancel requested
  ↓
Acquire transition lock
  ↓
Mark cancellation requested
  ↓
Stop new stages
  ↓
Cancel pending approvals
  ↓
Adapter.cancel()
  ↓
Terminate process tree
  ↓
Finalize raw logs
  ↓
Mark active stages cancelled
  ↓
Mark Run cancelled
  ↓
Emit run.cancelled
  ↓
Preserve Worktree for review or cleanup policy
```

### 25.3 Cancel Idempotency

重复 Cancel 必须安全。

### 25.4 Browser Disconnect

浏览器断开不得自动 Cancel。

当前 v1 中：

```text
request close → abort pipeline
```

必须废弃。

v2 应改为：

```text
browser disconnect
  ↓
stream subscription ends
  ↓
Run continues
  ↓
client reconnects with last sequence
```

---

# Part XIV — Stage Completion

## 26. Stage Finalization

### 26.1 Finalization Sequence

```text
Provider process exits or session signals completion
  ↓
Adapter finalizes output
  ↓
Validate output contract
  ↓
Capture raw output artifact
  ↓
Capture structured artifact
  ↓
Capture diff and file changes
  ↓
Update usage
  ↓
Generate stage summary
  ↓
Mark Stage completed
  ↓
Emit stage.completed
```

### 26.2 Output Contract

Workflow Stage 可以定义：

```ts
interface OutputContract {
  schema?: JsonSchema;
  requiredArtifacts?: string[];
  requiredTests?: string[];
  allowUnstructuredFallback: boolean;
}
```

### 26.3 Contract Failure

Provider exit 0 但输出不符合 Contract：

```text
STAGE_OUTPUT_INVALID
```

Workflow 可：

- Retry Stage；
- Fail Run；
- Continue with warning；
- Request human review。

---

## 27. Stage Retry

### 27.1 Same-Run Stage Retry

只适用于：

- Workflow 明确允许；
- Stage 没有产生不可逆外部副作用；
- Worktree 状态可控；
- Provider Session 可重新启动。

### 27.2 Retry Policy

```ts
interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  retryOn: string[];
  providerFallbackIds?: string[];
}
```

### 27.3 Attempt Record

每个 Stage Attempt 必须独立记录。

推荐引入：

```ts
interface StageAttempt {
  id: string;
  stageId: string;
  attempt: number;
  providerSessionId?: string;
  status: StageStatus;
}
```

避免覆盖上一次尝试。

---

# Part XV — Run Completion

## 28. Completion Preconditions

Run 进入 `completed` 前必须满足：

- 所有 required Stage completed；
- 所有 required Approval resolved；
- 没有活动 Process；
- Event Store 已同步；
- Artifact finalization 完成；
- Worktree 状态已记录；
- Completion Rule 满足。

### 28.1 Completion Does Not Mean Accepted

```text
Run completed
  ≠
Task done
```

Run completed 表示执行尝试成功结束。

Task done 表示结果已被接受。

---

## 29. Run Finalization Sequence

```text
All required stages complete
  ↓
Stop remaining optional processes
  ↓
Collect final Git diff
  ↓
Generate Run Summary
  ↓
Finalize Artifacts
  ↓
Aggregate Usage
  ↓
Extract Memory Candidates
  ↓
Persist completion state
  ↓
Emit run.completed
  ↓
Post run-status Message
  ↓
Await acceptance / merge decision
```

### 29.1 Run Summary

Run Summary 应包含：

- Task；
- Agent；
- Provider；
- Workflow；
- Duration；
- Stage Results；
- Files Changed；
- Test Results；
- Review Findings；
- Approval History；
- Errors and Warnings；
- Artifact Links；
- Worktree Status；
- Recommended Next Action。

### 29.2 Run Completion Transaction

更新 Run 状态和 `run.completed` Event 应尽量在同一事务中。

---

# Part XVI — Failure Lifecycle

## 30. Failure Categories

### 30.1 Validation Failure

- Invalid Workspace；
- Missing Provider；
- Invalid Workflow；
- Missing Agent；
- Policy invalid。

### 30.2 Startup Failure

- Worktree create failed；
- Memory setup failed；
- Provider validation failed；
- Process spawn failed。

### 30.3 Runtime Failure

- Non-zero exit；
- Idle timeout；
- Total timeout；
- Tool failure；
- Policy denial；
- Approval rejection；
- Parse failure；
- Process crash。

### 30.4 Finalization Failure

- Artifact write failed；
- Event persist failed；
- Diff generation failed；
- Memory extraction failed；
- Summary failed。

### 30.5 Recovery Failure

- Session not resumable；
- Worktree missing；
- Process orphaned；
- Snapshot corrupted。

---

## 31. Failure State Transition

```text
active state
  ↓ unrecoverable error
Stage failed
  ↓ workflow policy
Run may:
  ├── retry stage
  ├── fallback provider
  ├── continue with warning
  └── fail
```

### 31.1 Run Failure Sequence

```text
Capture error
  ↓
Normalize error code
  ↓
Stop scheduling
  ↓
Cancel dependent stages
  ↓
Terminate active processes
  ↓
Finalize logs
  ↓
Preserve Worktree
  ↓
Create Debug Artifact
  ↓
Mark Run failed
  ↓
Emit run.failed
  ↓
Post error Message
```

### 31.2 Error Requirements

每个 Run Failure 必须记录：

- errorCode；
- message；
- phase；
- stageId；
- providerType；
- providerSessionId；
- processId；
- retryable；
- suggestedAction；
- sourceEventId。

---

# Part XVII — Retry and Child Run Lifecycle

## 32. Run Retry

### 32.1 Retry Creates New Run

```text
Run 1 failed
  ↓ retry
Run 2 created
```

不能把 Run 1 重置为 queued。

### 32.2 Retry Configuration

用户可以修改：

- Provider；
- Agent；
- Workflow；
- Policy；
- Memory Budget；
- Worktree Base；
- Timeout。

### 32.3 Parent Relationship

```text
Run 2.parentRunId = Run 1.id
Run 2.rootRunId = Run 1.rootRunId
```

### 32.4 Retry Context

可以引用：

- Previous Run Summary；
- Error Artifact；
- Diff；
- Failed Stage；
- Review Findings。

不应无差别注入全部旧 stdout。

---

## 33. Child Run

Child Run 用于：

- Provider Native Subtask 升级；
- Review 修复；
- Parallel Comparison；
- Delegated Task；
- Resume Fallback。

### 33.1 Child Run Is Durable

Child Run 必须像普通 Run 一样：

- 有状态；
- 有 Event；
- 有 Artifact；
- 有 Worktree；
- 可取消；
- 可回放。

### 33.2 Child Run Completion

父 Run 是否等待 Child Run，由 Workflow 定义。

---

# Part XVIII — Artifact Lifecycle

## 34. Artifact Creation

Artifact 创建来源：

- Runtime Event；
- Provider Adapter；
- Worktree Diff；
- Test Runner；
- User Upload；
- Extension；
- Run Finalizer。

### 34.1 Sequence

```text
Artifact candidate
  ↓
Validate type
  ↓
Redact / classify sensitivity
  ↓
Write content
  ↓
Compute checksum
  ↓
Persist metadata
  ↓
Emit artifact.created
```

### 34.2 Artifact Failure

非关键 Artifact 失败可降级。

关键 Artifact 失败可能使 Stage 或 Run 失败。

### 34.3 Artifact Retention

由 Workspace Policy 决定：

- Permanent；
- Until Task accepted；
- Until Worktree cleaned；
- Temporary；
- Restricted。

---

# Part XIX — Memory Write Lifecycle

## 35. Memory Extraction

### 35.1 Trigger

推荐在：

- Stage completed；
- Run completed；
- Run failed；
- User accepts result；
- User manually saves memory。

### 35.2 Candidate Sources

- Decision Event；
- Review Artifact；
- Test Artifact；
- User Message；
- Run Summary；
- Failure；
- Provider-specific workaround；
- Approval Decision。

### 35.3 Extraction Sequence

```text
Collect candidate sources
  ↓
Generate memory candidates
  ↓
Classify scope and category
  ↓
Deduplicate
  ↓
Score importance
  ↓
Optional user review
  ↓
Persist Memory Entry
  ↓
Emit memory.created
```

### 35.4 Automatic Memory Limits

不应自动保存：

- 每一段 reasoning；
- 大量重复 stdout；
- Secret；
- 临时命令；
- 无意义中间文本。

---

# Part XX — Review, Acceptance, Merge

## 36. Review Lifecycle

Run completed 后可进入 Review。

Review 可以是：

- User Review；
- Agent Review Stage；
- Automated Test Gate；
- Security Gate；
- Policy Gate。

### 36.1 Review Outcomes

```ts
type ReviewOutcome =
  | 'approve'
  | 'changes_requested'
  | 'reject'
  | 'needs_manual_review';
```

### 36.2 Changes Requested

推荐：

- 创建新 Run；
- reason = `review-fix`；
- parentRunId 指向当前 Run；
- 使用新 Worktree 或基于当前分支继续。

---

## 37. Task Acceptance

### 37.1 Acceptance Preconditions

根据 Workspace Policy：

- Run completed；
- Tests pass；
- Review approved；
- Required Artifact exists；
- No unresolved critical findings；
- Merge optional or completed。

### 37.2 Acceptance Sequence

```text
User accepts Run
  ↓
Persist acceptance
  ↓
Task status → done
  ↓
Emit task.completed
  ↓
Post Message
  ↓
Trigger final memory extraction
```

### 37.3 Acceptance Object

推荐：

```ts
interface TaskAcceptance {
  id: string;
  taskId: string;
  acceptedRunId: string;
  acceptedBy: string;
  notes?: string;
  acceptedAt: string;
}
```

---

## 38. Merge Lifecycle

### 38.1 Merge Is Separate from Run Completion

Run 可以 completed 但未 merge。

### 38.2 Merge Sequence

```text
Merge requested
  ↓
Policy evaluation
  ↓
Approval if required
  ↓
Verify worktree clean / expected
  ↓
Run tests if required
  ↓
Check target branch changed
  ↓
Perform merge
  ↓
Record commit
  ↓
Generate merge report Artifact
  ↓
Emit worktree.merged
  ↓
Update Worktree status
```

### 38.3 Merge Conflict

冲突时：

- 不自动破坏目标分支；
- 生成 Conflict Artifact；
- Worktree 保留；
- 创建修复 Run 或人工处理。

### 38.4 Push

Git Push 是独立高风险操作。

默认需要 Approval。

---

## 39. Abandon Lifecycle

用户可以放弃 Worktree。

### 39.1 Sequence

```text
Abandon requested
  ↓
Check uncommitted changes
  ↓
Warn user
  ↓
Persist abandoned status
  ↓
Optional archive diff
  ↓
Cleanup branch/worktree by policy
  ↓
Emit worktree.abandoned
```

---

# Part XXI — Cleanup Lifecycle

## 40. Cleanup Phases

Cleanup 包括：

- Process cleanup；
- Provider session cleanup；
- Temporary file cleanup；
- Worktree cleanup；
- Artifact cleanup；
- Queue lock cleanup；
- Event stream cleanup。

### 40.1 Cleanup Must Be Audited

每个资源清理产生 Event 或系统审计记录。

### 40.2 Cleanup Must Be Idempotent

重复执行不能造成错误或误删。

### 40.3 Worktree Cleanup Safety

如果存在：

- 未提交修改；
- 未生成 Diff Artifact；
- 未处理冲突；
- Pending Approval；
- User 保留标记；

不得自动删除。

---

# Part XXII — Server Shutdown and Recovery

## 41. Graceful Shutdown

### 41.1 Shutdown Sequence

```text
Stop accepting new Runs
  ↓
Pause Scheduler
  ↓
Persist active Run checkpoints
  ↓
Notify providers if supported
  ↓
Wait grace period
  ↓
Keep or terminate processes by policy
  ↓
Flush Event Store
  ↓
Close database
```

### 41.2 Shutdown Modes

- Graceful；
- Immediate；
- Maintenance；
- Upgrade。

---

## 42. Startup Recovery

### 42.1 Recovery Scan

Server 启动时扫描：

- Run status；
- Stage status；
- Provider Session；
- Runtime Process；
- Pending Approval；
- Worktree；
- Queue；
- Event sequence。

### 42.2 Recovery Classification

```text
Run says running + process alive
  → reattach or mark externally running

Run says running + process missing
  → failed or resumable

Run waiting_approval
  → restore approval state

Run queued
  → return to scheduler

Worktree active + Run terminal
  → preserve and flag cleanup

Process alive + no Run
  → orphaned
```

### 42.3 Recovery Events

```text
system.recovery_started
run.recovery_attempted
run.recovered
run.recovery_failed
process.orphaned
worktree.cleanup_required
system.recovery_completed
```

### 42.4 Never Guess Success

Server 重启后，无法确认的 Run 不能直接标记 completed。

---

# Part XXIII — Client Connection Lifecycle

## 43. Streaming Subscription

### 43.1 Client Connect

```text
GET /api/runs/:id/stream?afterSequence=100
```

Server：

- 验证权限；
- 读取缺失 Event；
- 顺序发送；
- 订阅实时 Event。

### 43.2 Client Disconnect

只结束订阅。

不改变 Run 状态。

### 43.3 Reconnect

客户端使用最后 sequence 恢复。

### 43.4 Multiple Clients

同一 Run 可以被多个客户端观察。

Event Store 是唯一事实来源。

---

## 44. Client Subscription Lifecycle

### 44.1 States

```text
connecting
  → connected
  → reconnecting
  → resyncing
  → connected / disconnected
```

### 44.2 Scope

Client Subscription Lifecycle 描述浏览器或 Desktop 客户端与 Server 之间实时订阅的生命周期。

### 44.3 Not Run Lifecycle

Client Subscription 生命周期不属于 Run Lifecycle。

```text
Client disconnected
  ≠
Run cancelled
```

Run 的取消永远需要通过明确的 Cancel API 触发。

详见 `12-UI-Architecture.md` 的 UI / Runtime Boundary 定义。

---

# Part XXIV — Idempotency and Concurrency Control

## 44. Idempotency

以下操作需要 idempotency key：

- Create Task；
- Create Run；
- Cancel Run；
- Approve Request；
- Retry Run；
- Merge Worktree；
- Create Artifact from external callback。

### 44.1 Idempotency Result

重复请求返回原结果，不重复执行。

---

## 45. Optimistic Concurrency

关键对象包含：

```ts
version: number;
```

适用于：

- Task；
- Run；
- Approval；
- Worktree；
- Provider Configuration；
- Workflow Definition；
- Policy Profile。

### 45.1 Transition Lock

Run 状态迁移必须使用：

- 数据库事务；
- version check；
- 或状态迁移锁。

防止：

- Cancel 与 Complete 同时发生；
- Approve 与 Reject 同时发生；
- Retry 重复创建；
- Merge 重复执行。

---

# Part XXV — State Transition Tables

## 46. Run Transition Table

| From | To | Trigger | Allowed |
|---|---|---|---|
| queued | starting | Scheduler | Yes |
| queued | cancelled | User cancel | Yes |
| starting | running | First stage active | Yes |
| starting | failed | Startup error | Yes |
| starting | cancelled | User cancel | Yes |
| running | waiting_approval | Policy | Yes |
| running | paused | User/System pause | Yes |
| running | completed | Completion rule | Yes |
| running | failed | Unrecoverable error | Yes |
| running | cancelled | User cancel | Yes |
| waiting_approval | running | Approved | Yes |
| waiting_approval | failed | Rejected and fatal | Yes |
| waiting_approval | cancelled | User cancel | Yes |
| paused | running | Resume | Yes |
| paused | cancelled | User cancel | Yes |
| paused | failed | Recovery failure | Yes |
| completed | running | — | No |
| failed | queued | — | No; create new Run |
| cancelled | running | — | No; create new Run |

---

## 47. Stage Transition Table

| From | To | Trigger |
|---|---|---|
| pending | ready | Dependencies satisfied |
| pending | skipped | Condition false |
| ready | starting | Scheduler |
| starting | running | Provider active |
| starting | failed | Startup error |
| running | waiting_approval | Approval required |
| running | paused | Pause |
| running | completed | Contract satisfied |
| running | failed | Error |
| running | cancelled | Run cancelled |
| waiting_approval | running | Approved |
| waiting_approval | failed | Rejected/fatal |
| paused | running | Resume |
| paused | cancelled | Run cancelled |

### 47.1 Canonical Lifecycle Event Ownership

The Run table in §46 and the Stage table in §47 retain their state sets
unchanged. This adjacent contract records their canonical Event ownership.
M3-TD-21 freezes these four unique
transition-to-Event mappings; one Event must not represent two lifecycle
transitions:

| Transition | Canonical Event |
|---|---|
| Run `queued → starting` | `run.dequeued` |
| Run `starting → running` | `run.started` |
| Stage `ready → starting` | `stage.starting` |
| Stage `starting → running` | `stage.started` |

The remaining transition rows retain their existing Event semantics and are
not remapped by this specification-alignment change.

---

## 48. Worktree Transition Table

| From | To | Trigger |
|---|---|---|
| creating | active | Created |
| creating | deleted | Failed cleanup |
| active | dirty | File changes detected |
| active | ready_for_review | Run completed |
| dirty | ready_for_review | Finalized |
| ready_for_review | merged | Merge success |
| ready_for_review | abandoned | User abandon |
| merged | deleted | Cleanup |
| abandoned | deleted | Cleanup |

---

# Part XXVI — End-to-End Scenarios

## 49. Scenario A: Successful Single-Agent Run

```text
User creates Task
  ↓
Run created (queued)
  ↓
Scheduler selects Run
  ↓
Snapshot created
  ↓
Worktree created
  ↓
Memory retrieved
  ↓
Single Agent Stage starts
  ↓
KimiCode Provider Session starts
  ↓
Process emits events
  ↓
Files modified
  ↓
Tests pass
  ↓
Stage completed
  ↓
Run completed
  ↓
Diff Artifact created
  ↓
User reviews and merges
  ↓
Task accepted
  ↓
Memory persisted
```

---

## 50. Scenario B: Approval Required

```text
Provider requests package installation
  ↓
Policy requires approval
  ↓
Run waiting_approval
  ↓
User approves once
  ↓
Provider resumes
  ↓
Stage completes
```

---

## 51. Scenario C: Provider Failure and Retry

```text
KimiCode Run starts
  ↓
Auth required
  ↓
Run failed with PROVIDER_AUTH_REQUIRED
  ↓
User logs in
  ↓
Retry creates new Run
  ↓
New Run completes
```

旧 Run 保留。

---

## 52. Scenario D: Browser Refresh

```text
Run running
  ↓
Browser refreshes
  ↓
SSE disconnects
  ↓
Run continues
  ↓
Browser reconnects afterSequence=120
  ↓
Events 121...n replay
```

---

## 53. Scenario E: Server Restart

```text
Run running
  ↓
Server restarts
  ↓
Recovery Manager scans process
  ↓
Provider process alive
  ↓
Reattach stream if supported
  ↓
Run recovered
```

如果无法恢复：

```text
Run failed with RUN_RECOVERY_FAILED
Worktree preserved
Retry available
```

---

## 54. Scenario F: Review Changes Requested

```text
Implementation Run completed
  ↓
Reviewer requests changes
  ↓
New Child Run created
  ↓
Parent Run referenced
  ↓
Fix applied in new Worktree
  ↓
Review passes
  ↓
Merge
  ↓
Task accepted
```

---

# Part XXVII — v1 Migration

## 55. Current v1 Lifecycle

当前 v1 主要是：

```text
Create Task
  ↓
POST /run opens SSE
  ↓
AgentRunner executes four fixed stages
  ↓
Browser disconnect aborts process
  ↓
Task stores outputs
```

### 55.1 Problems

- HTTP 连接决定执行生命周期；
- Task 与 Run 混合；
- Stage 固定；
- stdout 直接作为 UI；
- Retry 覆盖语义不清；
- 没有 Durable Run；
- Worktree 未接入；
- Provider Session 不存在；
- Process Recovery 不存在。

---

## 56. Migration Steps

### 56.1 Step 1 — Introduce Run

保留 Task API。

新增：

```text
POST /tasks/:taskId/runs
```

旧 `/run` 路由内部创建 Run。

### 56.2 Step 2 — Persist Event

将 SSE `thinking` 同时写入 Runtime Event。

### 56.3 Step 3 — Decouple Browser

Run 在后台执行。

SSE 仅订阅。

### 56.4 Step 4 — Convert Pipeline

四阶段转成 Workflow Definition。

### 56.5 Step 5 — Provider Adapter

CLIExecutor 移到 Adapter + Process Manager。

### 56.6 Step 6 — Worktree

修改型 Run 使用 Worktree。

### 56.7 Step 7 — Remove Task.outputs

前端从 Run / Stage / Event / Artifact 读取。

---

# Part XXVIII — Implementation Requirements

## 57. Required Runtime Services

```text
RunService
RunScheduler
RunEngine
WorkflowResolver
StageScheduler
StageExecutor
ProviderRegistry
ProviderSessionManager
ProcessManager
EventStore
EventBus
WorktreeManager
MemoryEngine
PromptBuilder
PolicyEngine
ApprovalService
ArtifactManager
UsageAggregator
RecoveryManager
CleanupManager
```

---

## 58. Transaction Boundaries

必须事务化：

- Task create；
- Run create；
- Run start；
- Stage transition；
- Event sequence reservation；
- Approval decision；
- Run completion；
- Task acceptance；
- Worktree ownership；
- Merge result。

---

## 59. Logging Requirements

系统 Log 必须包含：

- correlationId；
- workspaceId；
- taskId；
- runId；
- stageId；
- providerSessionId；
- processId；
- eventId；
- errorCode。

Log 不得替代 Runtime Event。

---

## 60. Testing Requirements

### 60.1 Unit Tests

- Run state machine；
- Stage state machine；
- Workflow graph；
- Timeout；
- Retry；
- Policy；
- Idempotency；
- Event sequence。

### 60.2 Integration Tests

- Durable Run；
- Browser disconnect；
- Process cancel；
- Approval pause/resume；
- Worktree lifecycle；
- Server recovery；
- Provider failure normalization。

### 60.3 End-to-End Tests

- Task → Run → Worktree → Provider → Events → Artifact → Merge → Acceptance；
- Retry with Provider switch；
- Restart recovery；
- Group Workflow；
- Memory retrieval。

---

# Part XXIX — Global Lifecycle Invariants

## 61. Invariants

AgentOS v2 Runtime Lifecycle 必须始终满足：

1. Task 与 Run 分离。
2. Run 创建后不可重置为另一执行尝试。
3. Retry 必须创建新 Run。
4. 浏览器断线不得取消 Run。
5. Runtime Event 必须持久化。
6. Run Event Sequence 必须单调递增。
7. Provider 特定逻辑必须通过 Adapter。
8. 修改型 Run 默认使用 Worktree。
9. Worktree 创建失败不得静默回退主目录。
10. Run 开始前必须保存 Snapshot。
11. Secret 不得进入普通 Snapshot、Event 或 Log。
12. Process exit code 0 不等于 Stage 自动成功。
13. Run completed 不等于 Task done。
14. Approval 必须持久化并可审计。
15. Cancel 必须处理完整 Process Tree。
16. Server 重启后必须执行 Recovery。
17. 无法确认的 Run 不得猜测为成功。
18. Stage 顺序由 Workflow Definition 决定。
19. Memory Retrieval 必须可观察。
20. Artifact 必须可追踪来源。
21. Merge 必须独立于 Run Completion。
22. Cleanup 必须幂等。
23. 状态迁移必须并发安全。
24. 所有重大状态变化必须产生 Event。
25. v1 固定四阶段只能作为 Workflow Template 存在。

---

# Part XXX — Final Lifecycle Definition

## 62. Final Definition

AgentOS v2 中一次完整执行的标准定义如下：

> 用户在 Workspace 的 Conversation 中提出需求并创建 Task。Task 创建一个持久 Run。Run 在启动前冻结 Agent、Provider、Workflow、Policy 和 Workspace Snapshot，准备独立 Worktree，检索相关 Memory，并实例化 Workflow Stage Graph。每个 Stage 通过 Provider Adapter 创建 Provider Session，由 Process Manager 管理实际进程，并将所有执行行为转换为不可变 Runtime Event。Policy Engine 在高风险行为前执行允许、拒绝或审批判断。Runtime 在失败、暂停、取消、重试、恢复和 Server 重启场景下保持状态一致。Run 完成后生成 Artifact、Summary、Usage 和 Memory Candidate，但只有在结果被用户或验收规则接受后，Task 才进入完成状态。代码 Merge、Worktree Cleanup 与 Task Acceptance 均作为独立、可审计的生命周期步骤执行。

简化表达：

```text
Conversation
  ↓
Task
  ↓
Run
  ↓
Snapshot
  ↓
Worktree + Memory + Workflow
  ↓
Stage
  ↓
Provider Session
  ↓
Runtime Process
  ↓
Runtime Event
  ↓
Policy / Approval / Artifact
  ↓
Run Completion
  ↓
Review / Merge
  ↓
Task Acceptance
  ↓
Memory Persistence
```

本文件定义的生命周期是 AgentOS v2 Runtime Engine、Process Manager、Worktree Manager、Event Model 和前端 Runtime Inspector 的实现基础。
