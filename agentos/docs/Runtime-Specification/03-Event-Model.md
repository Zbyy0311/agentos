# AgentOS Runtime Specification v2.0

## 03 — Event Model

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Runtime Event Protocol  
> Depends On:
> - `00-Vision.md`
> - `01-Core-Concepts.md`
> - `02-Runtime-Lifecycle.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的 Runtime Event Model。

Runtime Event 是 AgentOS 内部描述“实际发生了什么”的统一结构化协议。

它用于连接：

- Run Engine；
- Workflow Executor；
- Stage Executor；
- Provider Adapter；
- Process Manager；
- Worktree Manager；
- Git Runtime；
- Memory Engine；
- Policy Engine；
- Approval Center；
- Artifact Manager；
- Usage Aggregator；
- Recovery Manager；
- SSE / WebSocket Gateway；
- Timeline；
- Runtime Inspector；
- Replay；
- Metrics；
- Debug Bundle；
- Extension。

本文件明确：

- Event Envelope；
- Event Naming；
- Event Type；
- Payload Schema；
- Ordering；
- Sequence；
- Causation；
- Correlation；
- Persistence；
- Broadcast；
- Replay；
- Deduplication；
- Versioning；
- Redaction；
- Retention；
- Provider Event Normalization；
- Client Stream Protocol；
- v1 兼容迁移。

后续任何重要 Runtime 状态变化，如果不能通过 Runtime Event 表达，就不应直接进入 UI、Metrics、Memory 或 Inspector。

---

## 2. Core Principle

AgentOS v2 的事件原则是：

> Events are immutable runtime facts.

Runtime Event 是不可变的执行事实，而不是可随意修改的状态快照。

状态由：

- 当前数据库实体；
- Runtime Event 历史；
- Snapshot；
- Artifact；

共同表达。

### 2.1 Event Is Not State

事件：

```text
run.started
```

状态：

```text
Run.status = running
```

事件记录状态变化发生过。

状态表示当前结果。

### 2.2 Event Is Not Log

Log 面向人类和调试。

Event 面向系统行为与自动处理。

错误：

```text
"[12:00:01] tool started"
```

正确：

```json
{
  "type": "tool.started",
  "payload": {
    "toolName": "shell",
    "callId": "call_123"
  }
}
```

### 2.3 Event Is Not Provider stdout

Provider stdout 是原始数据源之一。

Runtime Event 是经过 Adapter 归一化的系统事件。

### 2.4 Event Is Not Message

Message 属于 Conversation。

Runtime Event 属于 Run。

系统可以根据 Runtime Event 生成 Conversation Message，但二者不是同一个对象。

---

## 3. Event Architecture

```text
Event Producer
  ├── Run Engine
  ├── Stage Executor
  ├── Provider Adapter
  ├── Process Manager
  ├── Worktree Manager
  ├── Git Runtime
  ├── Memory Engine
  ├── Policy Engine
  ├── Approval Service
  ├── Artifact Manager
  └── Recovery Manager
        ↓
Event Factory
        ↓
Sequence Allocator
        ↓
Event Validator
        ↓
Event Store
        ↓
Transaction Commit
        ↓
Event Bus
  ├── SSE Gateway
  ├── WebSocket Gateway
  ├── Timeline Projector
  ├── Metrics Projector
  ├── Memory Processor
  ├── Artifact Processor
  ├── Notification Processor
  ├── Audit Processor
  └── Extension Subscribers
```

---

## 4. Event Delivery Guarantees

### 4.1 Persistence Guarantee

所有 Durable Runtime Event 必须持久化。

只有明确标记为 Ephemeral 的事件可以不进入主 Event Store。

### 4.2 Delivery Semantics

AgentOS v2 默认采用：

```text
At-least-once delivery
```

Subscriber 必须能够处理重复事件。

### 4.3 Ordering Guarantee

AgentOS 保证：

```text
同一个 Run 内按照 sequence 严格排序
```

不保证：

```text
不同 Run 之间的全局顺序
```

### 4.4 Broadcast Guarantee

事件持久化成功后才允许向客户端广播。

如果广播失败：

- Event 保留；
- 客户端重连后补齐；
- 不回滚 Event。

### 4.5 Replay Guarantee

只要 Event 未被清理，客户端和 Runtime Inspector 必须能够按 sequence Replay。

Replay 不重新执行 Provider。

---

# Part I — Event Envelope

## 5. Canonical Event Envelope

```ts
interface RuntimeEvent<TPayload = unknown> {
  id: string;
  schemaVersion: number;
  type: RuntimeEventType;

  workspaceId: string;
  taskId?: string;
  runId: string;
  stageId?: string;

  agentId?: string;
  providerConfigId?: string;
  providerSessionId?: string;
  processId?: string;
  worktreeId?: string;
  artifactId?: string;
  approvalRequestId?: string;
  conversationId?: string;
  messageId?: string;

  sequence: number;
  timestamp: string;
  source: EventSource;

  correlationId: string;
  causationId?: string;
  parentEventId?: string;

  severity: EventSeverity;
  visibility: EventVisibility;
  durability: EventDurability;

  payload: TPayload;
  metadata?: Record<string, unknown>;
}
```

---

## 6. Required Fields

以下字段必须存在：

```text
id
schemaVersion
type
workspaceId
runId
sequence
timestamp
source
correlationId
severity
visibility
durability
payload
```

### 6.1 `id`

全局唯一 Event ID。

推荐格式：

```text
evt_<ulid>
```

### 6.2 `schemaVersion`

Event Envelope 与 Payload 的版本。

初始值：

```text
1
```

### 6.3 `type`

Canonical Event Type。

例如：

```text
run.started
tool.completed
file.modified
approval.required
```

### 6.4 `workspaceId`

事件所属 Workspace。

### 6.5 `runId`

所有 Runtime Event 必须关联 Run。

无 Run 的系统级事件应进入独立 System Event Store，不应伪造 Run。

### 6.6 `sequence`

同一 Run 中严格递增的整数，从 1 开始。

### 6.7 `timestamp`

所有 Event Envelope 的 `timestamp` 以及 Payload 中的时间字段，必须使用
UTC ISO 8601 毫秒格式：`YYYY-MM-DDTHH:mm:ss.sssZ`。

示例：

```text
2026-07-19T12:00:00.000Z
```

### 6.8 `source`

事件生产者。

```ts
type EventSource =
  | 'run-engine'
  | 'scheduler'
  | 'workflow-executor'
  | 'stage-executor'
  | 'provider-adapter'
  | 'process-manager'
  | 'worktree-manager'
  | 'git-runtime'
  | 'memory-engine'
  | 'policy-engine'
  | 'approval-service'
  | 'artifact-manager'
  | 'usage-aggregator'
  | 'recovery-manager'
  | 'conversation-service'
  | 'extension'
  | 'system';
```

### 6.9 `correlationId`

用于关联一组相关操作。

通常一个 Run 使用一个主 Correlation ID，子操作可以继承或创建子 Correlation ID。

### 6.10 `payload`

与 Event Type 匹配的结构化内容。

禁止把整个对象或语义不明内容塞入单个字符串字段。

---

## 7. Optional Reference Fields

### 7.1 `taskId`

事件与 Task 关联时填写。

### 7.2 `stageId`

Stage 事件与 Stage 内部事件必须填写。

### 7.3 `agentId`

明确属于某个 Agent Profile 时填写。

Provider Native Subagent 不应伪造 Agent Profile ID。

### 7.4 `providerConfigId`

与 Provider Configuration 关联时填写。

### 7.5 `providerSessionId`

Provider Session 级事件必须填写。

### 7.6 `processId`

Process 级事件必须填写。

### 7.7 `worktreeId`

Worktree 与 Git 事件应填写。

### 7.8 `artifactId`

Artifact 创建或状态事件应填写。

### 7.9 `approvalRequestId`

Approval 事件应填写。

### 7.10 `conversationId` / `messageId`

事件来源于 Conversation 或触发 Message 时填写。

---

## 8. Causation and Parent Relationship

### 8.1 `causationId`

表示哪个 Request、Command 或 Event 导致当前 Event。

例如：

```text
approval.required
  causationId = policy.evaluated event id
```

### 8.2 `parentEventId`

表示结构层级中的父 Event。

例如：

```text
tool.started
  └── command.started
      ├── command.stdout
      └── command.completed
```

### 8.3 Causation Chain

推荐：

```text
message.created
  ↓
task.created
  ↓
run.created
  ↓
stage.started
  ↓
tool.started
```

---

## 9. Severity

```ts
type EventSeverity =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical';
```

- `debug`：低价值内部细节；
- `info`：正常执行事实；
- `notice`：值得注意但不是问题；
- `warning`：可以继续，但存在风险；
- `error`：当前操作失败；
- `critical`：Run 或系统安全受到严重影响。

Severity 不直接决定 Run 状态。

---

## 10. Visibility

```ts
type EventVisibility =
  | 'public'
  | 'internal'
  | 'restricted';
```

- `public`：可直接展示给用户；
- `internal`：默认不在普通 Timeline 展示；
- `restricted`：包含敏感元数据，需要授权查看。

---

## 11. Durability

```ts
type EventDurability =
  | 'durable'
  | 'ephemeral';
```

Ephemeral 只适合：

- 高频光标状态；
- UI Presence；
- 非关键性能采样。

以下事件不得使用 Ephemeral：

- Run 状态；
- Stage 状态；
- Approval；
- Process Exit；
- File Change；
- Artifact；
- Memory；
- Policy；
- Error；
- Merge。

### 11.1 Event Classification

AgentOS v2 按分类管理 Event 生命周期：

```text
Durable Runtime Event：
  持久化在 Event Store 中的执行事实。
  → run.*, stage.*, tool.*, command.*, approval.*

Projection Event：
  由 Runtime Event 投影产生的用户可读更新。
  → Conversation Message、Run Card、Status Card

Ephemeral UI Event：
  Hover、Focus、Panel、Gesture、Presence、Typing 等 UI 状态。
  不得进入 Durable Runtime Event Store。
```

Hover、Focus、Gesture 和 Panel 交互事件属于 `12-UI-Architecture.md` 定义的客户端本地 View State，不在 Event Model 中定义。

---

# Part II — Naming and Versioning

## 12. Naming Convention

Event Type 统一使用：

```text
<domain>.<action>
```

规则：

1. 全小写；
2. 使用点分隔；
3. Domain 使用单数；
4. Action 使用明确动作；
5. 不包含 Provider 名称；
6. 不使用 UI 名称；
7. 不使用模糊词；
8. 不把 Error Code 作为 Event Type；
9. 稳定后不得随意重命名。

Good：

```text
run.started
stage.completed
process.exited
file.modified
```

Bad：

```text
codex_output
kimi_thinking
agent_result
ui_refresh
something_failed
```

### 12.1 Reserved Domains

```text
task
run
stage
workflow
provider
process
stream
reasoning
message
subagent
tool
command
file
patch
git
worktree
policy
approval
artifact
memory
usage
recovery
cleanup
system
extension
event
```

---

## 13. Schema Versioning

### 13.1 Backward-Compatible Changes

以下修改不要求提升主版本：

- 新增 Optional Field；
- 新增 Metadata；
- 新增 Event Type；
- 增加可被 unknown fallback 处理的枚举值。

### 13.2 Breaking Changes

以下必须提升版本：

- 删除字段；
- 重命名字段；
- 修改字段类型；
- 改变 Event 语义；
- 改变排序规则；
- 改变 Payload 必填关系。

### 13.3 Consumer Rule

Consumer 必须：

- 检查 `schemaVersion`；
- 忽略未知 Optional Field；
- 保留未知 Event；
- 不因未知 Event Type 崩溃；
- 对不支持的高版本显示兼容警告。

---

## 14. Event Registry

所有 Event Type 必须在中央 Registry 注册。

```ts
interface EventDefinition {
  type: RuntimeEventType;
  schemaVersion: number;
  domain: string;
  description: string;
  defaultSeverity: EventSeverity;
  defaultVisibility: EventVisibility;
  defaultDurability: EventDurability;
  payloadSchema: JsonSchema;
}
```

Core 模块不得发出未注册 Event。

Extension Event 使用：

```text
extension.<extensionId>.<action>
```

---

# Part III — Task, Run, Workflow and Stage Events

## 15. Task Events

### `task.created`

```ts
interface TaskCreatedPayload {
  title: string;
  priority: TaskPriority;
  sourceConversationId?: string;
  sourceMessageId?: string;
  assignedAgentId?: string;
  createdBy: string;
}
```

### `task.status_changed`

```ts
interface TaskStatusChangedPayload {
  from: TaskStatus;
  to: TaskStatus;
  reason: string;
  changedBy: string;
}
```

### `task.completed`

```ts
interface TaskCompletedPayload {
  acceptedRunId: string;
  acceptedBy: string;
  notes?: string;
}
```

### `task.reopened`

```ts
interface TaskReopenedPayload {
  previousAcceptedRunId?: string;
  reason: string;
  reopenedBy: string;
}
```

---

## 16. Run Events

### `run.created`

```ts
interface RunCreatedPayload {
  reason:
    | 'initial'
    | 'retry'
    | 'resume-fallback'
    | 'review-fix'
    | 'provider-comparison'
    | 'manual';
  parentRunId?: string;
  rootRunId: string;
  workflowDefinitionId?: string;
  worktreeMode: WorktreeMode;
  createdBy: string;
}
```

### `run.queued`

```ts
interface RunQueuedPayload {
  priority: TaskPriority;
  queueName: string;
  position?: number;
}
```

### `run.dequeued`

`run.dequeued` is the unique canonical Event for the Run transition
`queued → starting`.

Envelope requirements:

- the standard Runtime Event envelope is required;
- `runId`, `workspaceId`, `sequence`, `timestamp`, and `correlationId` are
  required;
- `stageId` is absent because this Event is Run-scoped;
- `schemaVersion` is exactly `1` and `type` is exactly `run.dequeued`.

Registry metadata:

| Field | Value |
|---|---|
| domain | `run` |
| schemaVersion | `1` |
| source | `scheduler` |
| defaultSeverity | `info` |
| defaultVisibility | `internal` |
| defaultDurability | `durable` |
| requiresStageId | `false` |

Payload schema:

```ts
interface RunDequeuedPayload {
  dequeuedAt: string;
}
```

Payload requirements:

- `dequeuedAt` is a UTC timestamp in the exact form
  `YYYY-MM-DDTHH:mm:ss.sssZ`;
- no additional payload fields are accepted;
- the Event means that the scheduler selected/acquired the Run, committed
  `queued → starting`, and began startup preparation;
- it does not mean that startup preparation completed or that a Provider or
  Stage is active.

Example:

```json
{
  "id": "evt_01JZRUNDEQUEUED",
  "schemaVersion": 1,
  "type": "run.dequeued",
  "workspaceId": "ws_01JZ",
  "taskId": "task_01JZ",
  "runId": "run_01JZ",
  "sequence": 2,
  "timestamp": "2026-07-19T12:00:00.000Z",
  "source": "scheduler",
  "correlationId": "corr_run_01JZ",
  "severity": "info",
  "visibility": "internal",
  "durability": "durable",
  "payload": {
    "dequeuedAt": "2026-07-19T12:00:00.000Z"
  }
}
```

### `run.started`

`run.started` is the unique canonical Event for the Run transition
`starting → running`. It is emitted only after startup preparation succeeds
and the first eligible Stage formally enters `running`.

Registry metadata (unchanged):

| Field | Value |
|---|---|
| domain | `run` |
| schemaVersion | `1` |
| source | `run-engine` |
| defaultSeverity | `info` |
| defaultVisibility | `public` |
| defaultDurability | `durable` |
| requiresStageId | `false` |

```ts
interface RunStartedPayload {
  startedAt: string;
  workflowSnapshotVersion?: number;
  policySnapshotVersion?: number;
  baseCommit?: string;
}
```

Payload requirements:

- `startedAt` is a UTC timestamp in the exact form
  `YYYY-MM-DDTHH:mm:ss.sssZ`;
- `runs.started_at` is first written in the same transaction that emits this
  Event;
- `run.started` must not be emitted by the `queued → starting` transaction;
- no payload fields other than the required `startedAt` and the three listed
  optional snapshot fields are accepted.

### `run.paused`

```ts
interface RunPausedPayload {
  reason:
    | 'user'
    | 'policy'
    | 'approval'
    | 'scheduler'
    | 'maintenance';
  requestedBy?: string;
  resumable: boolean;
}
```

### `run.resumed`

```ts
interface RunResumedPayload {
  resumeMode:
    | 'native-session'
    | 'process-restart'
    | 'scheduler';
  requestedBy?: string;
}
```

### `run.cancellation_requested`

```ts
interface RunCancellationRequestedPayload {
  requestedBy: string;
  reason?: string;
}
```

### `run.cancelled`

```ts
interface RunCancelledPayload {
  requestedBy: string;
  terminatedProcessIds: string[];
  worktreePreserved: boolean;
  reason?: string;
}
```

### `run.completed`

```ts
interface RunCompletedPayload {
  durationMs: number;
  completedStageIds: string[];
  artifactIds: string[];
  worktreeStatus?: string;
  summaryArtifactId?: string;
}
```

### `run.failed`

```ts
interface RunFailedPayload {
  errorCode: string;
  message: string;
  phase: string;
  stageId?: string;
  providerType?: ProviderType;
  retryable: boolean;
  suggestedAction?: string;
  debugArtifactId?: string;
}
```

### `run.recovery_attempted`

```ts
interface RunRecoveryAttemptedPayload {
  previousStatus: RunStatus;
  processFound: boolean;
  providerSessionFound: boolean;
  worktreeFound: boolean;
}
```

### `run.recovered`

```ts
interface RunRecoveredPayload {
  recoveryMode:
    | 'process-reattach'
    | 'provider-session-resume'
    | 'queue-restore'
    | 'approval-restore';
}
```

### `run.recovery_failed`

```ts
interface RunRecoveryFailedPayload {
  errorCode: string;
  message: string;
  retryableAsNewRun: boolean;
}
```

---

## 17. Workflow Events

### `workflow.resolved`

```ts
interface WorkflowResolvedPayload {
  workflowDefinitionId: string;
  workflowVersion: number;
  stageCount: number;
  source:
    | 'run-override'
    | 'task'
    | 'conversation'
    | 'workspace-default'
    | 'system-default'
    | 'planner';
}
```

### `workflow.validation_failed`

```ts
interface WorkflowValidationFailedPayload {
  errors: Array<{
    code: string;
    path?: string;
    message: string;
  }>;
}
```

### `workflow.completed`

```ts
interface WorkflowCompletedPayload {
  completedStageIds: string[];
  skippedStageIds: string[];
  completionRule: string;
}
```

---

## 18. Stage Events

### `stage.created`

```ts
interface StageCreatedPayload {
  workflowStageKey: string;
  name: string;
  sequence: number;
  dependsOn: string[];
}
```

### `stage.ready`

```ts
interface StageReadyPayload {
  dependenciesCompleted: string[];
}
```

### `stage.starting`

`stage.starting` is the unique canonical Event for the Stage transition
`ready → starting`.

Envelope requirements:

- the standard Runtime Event envelope is required;
- `runId`, `workspaceId`, `stageId`, `sequence`, `timestamp`, and
  `correlationId` are required;
- `stageId` is required and identifies the Stage whose scheduling rights were
  acquired;
- `schemaVersion` is exactly `1` and `type` is exactly `stage.starting`.

Registry metadata:

| Field | Value |
|---|---|
| domain | `stage` |
| schemaVersion | `1` |
| source | `stage-executor` |
| defaultSeverity | `info` |
| defaultVisibility | `public` |
| defaultDurability | `durable` |
| requiresStageId | `true` |

Payload schema:

```ts
interface StageStartingPayload {
  workflowStageKey: string;
  name: string;
  attempt: number;
  startingAt: string;
}
```

Payload requirements:

- `workflowStageKey` and `name` are non-empty strings;
- `attempt` is a positive safe integer;
- `startingAt` is a UTC timestamp in the exact form
  `YYYY-MM-DDTHH:mm:ss.sssZ`;
- no additional payload fields are accepted;
- the Event means that scheduling rights were acquired and Provider startup
  preparation began; it does not mean that the Provider is active.

Example:

```json
{
  "id": "evt_01JZSTAGESTARTING",
  "schemaVersion": 1,
  "type": "stage.starting",
  "workspaceId": "ws_01JZ",
  "taskId": "task_01JZ",
  "runId": "run_01JZ",
  "stageId": "stage_impl",
  "sequence": 4,
  "timestamp": "2026-07-19T12:00:01.000Z",
  "source": "stage-executor",
  "correlationId": "corr_stage_impl",
  "severity": "info",
  "visibility": "public",
  "durability": "durable",
  "payload": {
    "workflowStageKey": "implement",
    "name": "Implementation",
    "attempt": 1,
    "startingAt": "2026-07-19T12:00:01.000Z"
  }
}
```

### `stage.started`

`stage.started` is the unique canonical Event for the Stage transition
`starting → running`. It is emitted only after the Provider is confirmed
active and the Agent/Provider snapshots are frozen.

Registry metadata (unchanged):

| Field | Value |
|---|---|
| domain | `stage` |
| schemaVersion | `1` |
| source | `stage-executor` |
| defaultSeverity | `info` |
| defaultVisibility | `public` |
| defaultDurability | `durable` |
| requiresStageId | `true` |

```ts
interface StageStartedPayload {
  workflowStageKey: string;
  name: string;
  attempt: number;
  agentSnapshot: AgentSnapshotV1;
  providerSnapshot: ProviderConfigurationSnapshotV1;
}
```

Payload requirements:

- `attempt` is a positive safe integer;
- `stage.started` must not represent `ready → starting`;
- `run_stages.started_at` is first written in the same transaction that emits
  this Event;
- no payload fields other than the five listed fields are accepted.

### `stage.paused`

```ts
interface StagePausedPayload {
  reason: string;
  resumable: boolean;
}
```

### `stage.resumed`

```ts
interface StageResumedPayload {
  resumeMode: string;
}
```

### `stage.completed`

```ts
interface StageCompletedPayload {
  attempt: number;
  durationMs: number;
  artifactIds: string[];
  summaryArtifactId?: string;
  outputContractSatisfied: boolean;
}
```

### `stage.failed`

```ts
interface StageFailedPayload {
  attempt: number;
  errorCode: string;
  message: string;
  retryable: boolean;
  retryScheduled: boolean;
}
```

### `stage.cancelled`

```ts
interface StageCancelledPayload {
  reason: string;
}
```

### `stage.skipped`

```ts
interface StageSkippedPayload {
  condition: string;
  reason: string;
}
```

### `stage.retry_scheduled`

```ts
interface StageRetryScheduledPayload {
  previousAttempt: number;
  nextAttempt: number;
  backoffMs: number;
  providerFallbackId?: string;
}
```


# Part IV — Provider, Process and Stream Events

## 19. Provider Events

### `provider.validation_started`

```ts
interface ProviderValidationStartedPayload {
  providerType: ProviderType;
  providerConfigId: string;
}
```

### `provider.validation_completed`

```ts
interface ProviderValidationCompletedPayload {
  providerType: ProviderType;
  valid: boolean;
  executableResolved?: string;
  cliVersion?: string;
  authenticated?: boolean;
  capabilities: ProviderCapabilities;
  warnings: string[];
}
```

### `provider.validation_failed`

```ts
interface ProviderValidationFailedPayload {
  providerType: ProviderType;
  errorCode:
    | 'PROVIDER_NOT_FOUND'
    | 'PROVIDER_AUTH_REQUIRED'
    | 'PROVIDER_CONFIG_INVALID'
    | 'PROVIDER_VERSION_UNSUPPORTED'
    | 'PROVIDER_VALIDATION_FAILED';
  message: string;
}
```

### `provider.session_started`

```ts
interface ProviderSessionStartedPayload {
  providerType: ProviderType;
  nativeSessionId?: string;
  runtimeMode: 'cli' | 'api' | 'ssh' | 'container';
  capabilities: ProviderCapabilities;
}
```

### `provider.session_resumed`

```ts
interface ProviderSessionResumedPayload {
  nativeSessionId?: string;
  resumeMode: string;
}
```

### `provider.session_completed`

```ts
interface ProviderSessionCompletedPayload {
  nativeSessionId?: string;
  durationMs: number;
  providerReportedSuccess?: boolean;
}
```

### `provider.session_failed`

```ts
interface ProviderSessionFailedPayload {
  errorCode: string;
  message: string;
  nativeErrorCode?: string;
  nativeSessionId?: string;
  retryable: boolean;
}
```

### `provider.raw_event`

用于 Adapter 暂未支持的 Provider 原生结构化事件。

```ts
interface ProviderRawEventPayload {
  providerType: ProviderType;
  nativeEventType?: string;
  rawArtifactId?: string;
  summary?: string;
}
```

`provider.raw_event` 只能作为兼容和调试事件，不应成为长期主要 UI 协议。

---

## 20. Process Events

### `process.started`

```ts
interface ProcessStartedPayload {
  processType:
    | 'provider'
    | 'tool'
    | 'command'
    | 'git'
    | 'test'
    | 'system';
  pid?: number;
  parentPid?: number;
  executable: string;
  argsRedacted: string[];
  cwd: string;
}
```

### `process.heartbeat`

```ts
interface ProcessHeartbeatPayload {
  lastActivityAt: string;
  cpuPercent?: number;
  memoryBytes?: number;
}
```

Heartbeat 可设为 Ephemeral，也可以按采样持久化。

### `process.stopping`

```ts
interface ProcessStoppingPayload {
  reason:
    | 'cancel'
    | 'timeout'
    | 'policy'
    | 'shutdown'
    | 'cleanup';
  graceful: boolean;
}
```

### `process.exited`

```ts
interface ProcessExitedPayload {
  exitCode?: number;
  signal?: string;
  durationMs: number;
  terminationReason:
    | 'normal'
    | 'non-zero'
    | 'cancelled'
    | 'idle-timeout'
    | 'total-timeout'
    | 'policy'
    | 'spawn-error'
    | 'shutdown'
    | 'orphan-cleanup';
}
```

### `process.orphaned`

```ts
interface ProcessOrphanedPayload {
  pid?: number;
  detectedAt: string;
  cleanupRequired: boolean;
}
```

### `process.cleanup_completed`

```ts
interface ProcessCleanupCompletedPayload {
  terminatedPids: number[];
  survivors: number[];
  method:
    | 'job-object'
    | 'taskkill'
    | 'signal'
    | 'already-exited';
}
```

---

## 21. Text Stream Events

### `stream.text_delta`

用于 Provider 面向用户的文本增量。

```ts
interface TextDeltaPayload {
  channel:
    | 'assistant'
    | 'analysis-summary'
    | 'status'
    | 'review'
    | 'system';
  delta: string;
  blockId?: string;
}
```

### `stream.text_completed`

```ts
interface TextCompletedPayload {
  channel: string;
  blockId?: string;
  artifactId?: string;
  characterCount: number;
}
```

### 21.1 Chunk Rules

- Delta 顺序依赖 Run Sequence；
- 不要求一个字符一个 Event；
- Adapter 应合理聚合小块；
- 完整文本最终应形成 Artifact 或结构化 Stage Result；
- 高频小 Chunk 可在短时间窗口内合并；
- Chunk 合并不得改变文本顺序。

---

## 22. Reasoning Events

### 22.1 Principle

AgentOS 不要求 Provider 暴露私有 Chain of Thought。

Reasoning Event 只表示 Provider 明确公开的：

- Reasoning Summary；
- Planning Status；
- Decision Summary；
- Structured Analysis；
- Progress Update。

### `reasoning.summary`

```ts
interface ReasoningSummaryPayload {
  summary: string;
  category:
    | 'planning'
    | 'decision'
    | 'review'
    | 'diagnosis'
    | 'progress';
}
```

### `reasoning.delta`

仅当 Provider 正式提供可展示的 Reasoning Stream 时使用。

```ts
interface ReasoningDeltaPayload {
  delta: string;
  blockId?: string;
  providerDeclaredPublic: boolean;
}
```

不得通过日志抓取、模型推断或隐藏接口泄露 Provider 私有 Chain of Thought。

---

# Part V — Subagent, Tool and Command Events

## 23. Provider Native Subagent Events

### `subagent.spawned`

```ts
interface SubagentSpawnedPayload {
  nativeSubagentId: string;
  name?: string;
  role?: string;
  providerType: ProviderType;
  parentNativeSubagentId?: string;
  taskSummary?: string;
}
```

### `subagent.status_changed`

```ts
interface SubagentStatusChangedPayload {
  nativeSubagentId: string;
  from?: string;
  to: string;
}
```

### `subagent.completed`

```ts
interface SubagentCompletedPayload {
  nativeSubagentId: string;
  success: boolean;
  summary?: string;
  artifactIds?: string[];
  durationMs?: number;
}
```

### `subagent.failed`

```ts
interface SubagentFailedPayload {
  nativeSubagentId: string;
  errorCode?: string;
  message: string;
}
```

### 23.1 Invariants

1. Native Subagent 不自动创建 Agent Profile。
2. Native Subagent ID 只在 Provider Session 范围内稳定。
3. Event 必须保留 Provider Type。
4. Provider 不暴露 Subagent 时不得伪造。
5. AgentOS 可以将 Native Subagent 显示在 Timeline，但不能当作长期团队成员。

---

## 24. Tool Events

### `tool.started`

```ts
interface ToolStartedPayload {
  callId: string;
  toolName: string;
  category:
    | 'shell'
    | 'filesystem'
    | 'search'
    | 'browser'
    | 'git'
    | 'test'
    | 'mcp'
    | 'custom';
  arguments: Record<string, unknown>;
  argumentsRedacted: boolean;
}
```

### `tool.progress`

```ts
interface ToolProgressPayload {
  callId: string;
  message?: string;
  progress?: number;
  unit?: string;
}
```

### `tool.completed`

```ts
interface ToolCompletedPayload {
  callId: string;
  toolName: string;
  success: boolean;
  durationMs: number;
  resultSummary?: string;
  artifactIds?: string[];
}
```

### `tool.failed`

```ts
interface ToolFailedPayload {
  callId: string;
  toolName: string;
  errorCode?: string;
  message: string;
  retryable: boolean;
}
```

### 24.1 Tool Argument Security

Event 中不得记录：

- Token；
- Password；
- Cookie；
- Private Key；
- OAuth Credential；
- 完整 Secret；
- 未经许可的敏感文件内容。

---

## 25. Command Events

### `command.started`

```ts
interface CommandStartedPayload {
  commandId: string;
  executable: string;
  argsRedacted: string[];
  cwd: string;
  shell: boolean;
  purpose?: string;
}
```

### `command.stdout`

```ts
interface CommandOutputPayload {
  commandId: string;
  delta: string;
  truncated: boolean;
}
```

### `command.stderr`

使用与 `command.stdout` 相同的 Payload。

### `command.completed`

```ts
interface CommandCompletedPayload {
  commandId: string;
  exitCode?: number;
  signal?: string;
  durationMs: number;
  stdoutArtifactId?: string;
  stderrArtifactId?: string;
}
```

### `command.blocked`

```ts
interface CommandBlockedPayload {
  commandId: string;
  executable: string;
  argsRedacted: string[];
  policyDecision:
    | 'deny'
    | 'require_approval';
  reason: string;
}
```

### 25.1 Output Volume

大量 stdout 和 stderr 不应全部作为 Durable Event 长期保存。

推荐：

- Timeline 保留增量摘要；
- 完整输出写 Raw Log Artifact；
- Event 保存 Artifact Reference；
- 单 Event Payload 设置上限；
- Terminal Event 永久保留。

---

# Part VI — File, Patch, Git and Worktree Events

## 26. File Events

### `file.read`

```ts
interface FileReadPayload {
  path: string;
  sizeBytes?: number;
  contentHash?: string;
  outsideWorktree: boolean;
}
```

### `file.created`

```ts
interface FileCreatedPayload {
  path: string;
  sizeBytes?: number;
  contentHash?: string;
  generatedByToolCallId?: string;
}
```

### `file.modified`

```ts
interface FileModifiedPayload {
  path: string;
  beforeHash?: string;
  afterHash?: string;
  linesAdded?: number;
  linesDeleted?: number;
  generatedByToolCallId?: string;
}
```

### `file.deleted`

```ts
interface FileDeletedPayload {
  path: string;
  previousHash?: string;
  outsideWorktree: boolean;
  approvalRequestId?: string;
}
```

### `file.access_denied`

```ts
interface FileAccessDeniedPayload {
  path: string;
  operation:
    | 'read'
    | 'write'
    | 'delete'
    | 'execute';
  reason: string;
}
```

### 26.1 File Content Rule

File Event 默认不包含完整文件内容。

完整内容通过：

- Artifact；
- Diff；
- Restricted Inspector；

访问。

---

## 27. Patch Events

### `patch.created`

```ts
interface PatchCreatedPayload {
  patchId: string;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  patchArtifactId: string;
}
```

### `patch.applied`

```ts
interface PatchAppliedPayload {
  patchId: string;
  targetWorktreeId: string;
  success: boolean;
  conflictedFiles: string[];
}
```

### `patch.rejected`

```ts
interface PatchRejectedPayload {
  patchId: string;
  reason: string;
}
```

---

## 28. Git Events

### `git.status_updated`

```ts
interface GitStatusUpdatedPayload {
  branch: string;
  staged: string[];
  modified: string[];
  untracked: string[];
  conflicted: string[];
}
```

### `git.diff_updated`

```ts
interface GitDiffUpdatedPayload {
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  diffArtifactId?: string;
}
```

### `git.commit_created`

```ts
interface GitCommitCreatedPayload {
  commitSha: string;
  message: string;
  author?: string;
  filesChanged: number;
}
```

### `git.merge_started`

```ts
interface GitMergeStartedPayload {
  sourceBranch: string;
  targetBranch: string;
  strategy: string;
}
```

### `git.merge_completed`

```ts
interface GitMergeCompletedPayload {
  sourceBranch: string;
  targetBranch: string;
  mergeCommitSha?: string;
  fastForward: boolean;
  mergeReportArtifactId?: string;
}
```

### `git.merge_conflicted`

```ts
interface GitMergeConflictedPayload {
  sourceBranch: string;
  targetBranch: string;
  conflictedFiles: string[];
  conflictArtifactId?: string;
}
```

### `git.push_requested`

```ts
interface GitPushRequestedPayload {
  remote: string;
  branch: string;
  force: boolean;
}
```

### `git.push_completed`

```ts
interface GitPushCompletedPayload {
  remote: string;
  branch: string;
  commitSha: string;
}
```

---

## 29. Worktree Events

### `worktree.creation_requested`

```ts
interface WorktreeCreationRequestedPayload {
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  path: string;
}
```

### `worktree.created`

```ts
interface WorktreeCreatedPayload {
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  path: string;
}
```

### `worktree.create_failed`

```ts
interface WorktreeCreateFailedPayload {
  errorCode: string;
  message: string;
  partialPath?: string;
  cleanupRequired: boolean;
}
```

### `worktree.dirty`

```ts
interface WorktreeDirtyPayload {
  changedFiles: number;
  untrackedFiles: number;
}
```

### `worktree.ready_for_review`

```ts
interface WorktreeReadyForReviewPayload {
  branchName: string;
  headCommit?: string;
  diffArtifactId?: string;
}
```

### `worktree.merged`

```ts
interface WorktreeMergedPayload {
  targetBranch: string;
  mergeCommitSha?: string;
  mergeArtifactId?: string;
}
```

### `worktree.abandoned`

```ts
interface WorktreeAbandonedPayload {
  reason?: string;
  diffArchived: boolean;
  diffArtifactId?: string;
}
```

### `worktree.deleted`

```ts
interface WorktreeDeletedPayload {
  path: string;
  branchDeleted: boolean;
}
```

### `worktree.cleanup_required`

```ts
interface WorktreeCleanupRequiredPayload {
  path: string;
  reason: string;
  uncommittedChanges: boolean;
}
```

---

# Part VII — Policy and Approval Events

## 30. Policy Events

### `policy.evaluated`

```ts
interface PolicyEvaluatedPayload {
  actionType: string;
  resource?: string;
  decision:
    | 'allow'
    | 'deny'
    | 'require_approval';
  ruleId?: string;
  riskLevel?: string;
  reason: string;
}
```

### `policy.allowed`

```ts
interface PolicyAllowedPayload {
  actionType: string;
  ruleId?: string;
}
```

### `policy.denied`

```ts
interface PolicyDeniedPayload {
  actionType: string;
  resource?: string;
  ruleId?: string;
  reason: string;
}
```

### `policy.profile_snapshot_created`

```ts
interface PolicyProfileSnapshotCreatedPayload {
  policyProfileId: string;
  version: number;
  unsafeMode: boolean;
}
```

---

## 31. Approval Events

### `approval.required`

```ts
interface ApprovalRequiredPayload {
  category:
    | 'command'
    | 'file-delete'
    | 'git-push'
    | 'network'
    | 'package-install'
    | 'secret-access'
    | 'merge'
    | 'custom';
  riskLevel:
    | 'low'
    | 'medium'
    | 'high'
    | 'critical';
  title: string;
  description: string;
  requestSummary: Record<string, unknown>;
  expiresAt?: string;
}
```

### `approval.resolved`

```ts
interface ApprovalResolvedPayload {
  decision:
    | 'approve_once'
    | 'approve_run'
    | 'approve_workspace'
    | 'reject'
    | 'cancel_run';
  decidedBy: string;
  decidedAt: string;
  modifiedRequest?: Record<string, unknown>;
}
```

### `approval.expired`

```ts
interface ApprovalExpiredPayload {
  expiredAt: string;
  resultingAction:
    | 'continue-waiting'
    | 'reject'
    | 'fail-run'
    | 'cancel-run';
}
```

### `approval.cancelled`

```ts
interface ApprovalCancelledPayload {
  reason: string;
}
```

Approval Event 中的 Secret、完整命令和文件内容必须脱敏。

---

# Part VIII — Artifact, Memory and Usage Events

## 32. Artifact Events

### `artifact.created`

```ts
interface ArtifactCreatedPayload {
  artifactType: ArtifactType;
  name: string;
  storageUri: string;
  mimeType?: string;
  sizeBytes?: number;
  checksum?: string;
  sensitivity:
    | 'normal'
    | 'restricted'
    | 'secret';
}
```

### `artifact.finalized`

```ts
interface ArtifactFinalizedPayload {
  checksum: string;
  sizeBytes: number;
  immutable: boolean;
}
```

### `artifact.creation_failed`

```ts
interface ArtifactCreationFailedPayload {
  artifactType: ArtifactType;
  name: string;
  errorCode: string;
  message: string;
  critical: boolean;
}
```

### `artifact.retention_changed`

```ts
interface ArtifactRetentionChangedPayload {
  from: string;
  to: string;
  changedBy: string;
}
```

### `artifact.deleted`

```ts
interface ArtifactDeletedPayload {
  storageUri: string;
  reason: string;
  deletedBy: string;
}
```

---

## 33. Memory Events

### `memory.retrieval_started`

```ts
interface MemoryRetrievalStartedPayload {
  scopes: MemoryScope[];
  categories?: MemoryCategory[];
  queryHash: string;
  maxEntries: number;
  maxCharacters: number;
}
```

### `memory.retrieved`

```ts
interface MemoryRetrievedPayload {
  entries: Array<{
    memoryEntryId: string;
    scope: MemoryScope;
    category: MemoryCategory;
    score: number;
    reason: string;
  }>;
  budgetUsed: number;
  totalCandidates: number;
}
```

### `memory.retrieval_failed`

```ts
interface MemoryRetrievalFailedPayload {
  errorCode: string;
  message: string;
  degraded: boolean;
}
```

### `memory.candidate_created`

```ts
interface MemoryCandidateCreatedPayload {
  category: MemoryCategory;
  proposedScope: MemoryScope;
  title: string;
  sourceIds: string[];
  importance: number;
}
```

### `memory.created`

```ts
interface MemoryCreatedPayload {
  memoryEntryId: string;
  scope: MemoryScope;
  category: MemoryCategory;
  importance: number;
  sourceType: string;
  sourceId?: string;
}
```

### `memory.updated`

```ts
interface MemoryUpdatedPayload {
  memoryEntryId: string;
  changedFields: string[];
  reason: string;
}
```

### `memory.deduplicated`

```ts
interface MemoryDeduplicatedPayload {
  candidateId?: string;
  existingMemoryEntryId: string;
  similarityReason: string;
}
```

### `memory.injected`

```ts
interface MemoryInjectedPayload {
  memoryEntryIds: string[];
  promptArtifactId?: string;
  characterCount: number;
}
```

---

## 34. Usage Events

### `usage.updated`

```ts
interface UsageUpdatedPayload {
  metrics: Array<{
    name:
      | 'input_tokens'
      | 'output_tokens'
      | 'cached_tokens'
      | 'estimated_cost'
      | 'tool_calls'
      | 'commands'
      | 'files_changed';
    value: number;
    unit: string;
    estimated?: boolean;
  }>;
}
```

### `usage.finalized`

```ts
interface UsageFinalizedPayload {
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCachedTokens?: number;
  totalCost?: number;
  currency?: string;
  estimated: boolean;
}
```

Provider 不支持 Usage 时不得伪造精确值。



# Part IX — Conversation, Recovery and System Events

## 35. Conversation Projection Events

Runtime 可以发出与 Conversation 相关的 Event，但 Message 仍由 Conversation Service 持久化。

### `message.created`

```ts
interface MessageCreatedPayload {
  conversationId: string;
  messageId: string;
  senderType: 'user' | 'agent' | 'system';
  messageType: string;
}
```

### `message.linked_to_task`

```ts
interface MessageLinkedToTaskPayload {
  messageId: string;
  taskId: string;
}
```

### `message.linked_to_run`

```ts
interface MessageLinkedToRunPayload {
  messageId: string;
  runId: string;
}
```

### 35.1 Projection Rule

以下 Runtime Event 可以投影为 Message：

- `task.created`；
- `run.started`；
- `approval.required`；
- `run.completed`；
- `run.failed`；
- `artifact.created`；
- `task.completed`。

投影必须使用：

```text
projectorId + eventId
```

防止重复生成 Message。

---

## 36. Recovery Events

### `recovery.scan_started`

```ts
interface RecoveryScanStartedPayload {
  activeRunCount: number;
  activeProcessCount: number;
  activeWorktreeCount: number;
}
```

### `recovery.process_checked`

```ts
interface RecoveryProcessCheckedPayload {
  processId: string;
  pid?: number;
  alive: boolean;
}
```

### `recovery.completed`

```ts
interface RecoveryCompletedPayload {
  recoveredRuns: string[];
  failedRuns: string[];
  orphanedProcesses: string[];
  cleanupWorktrees: string[];
}
```

---

## 37. Cleanup Events

### `cleanup.started`

```ts
interface CleanupStartedPayload {
  resourceType:
    | 'process'
    | 'worktree'
    | 'artifact'
    | 'session'
    | 'cache';
  resourceIds: string[];
  reason: string;
}
```

### `cleanup.completed`

```ts
interface CleanupCompletedPayload {
  resourceType: string;
  cleanedResourceIds: string[];
  failedResourceIds: string[];
}
```

### `cleanup.failed`

```ts
interface CleanupFailedPayload {
  resourceType: string;
  resourceId: string;
  errorCode: string;
  message: string;
  retryable: boolean;
}
```

---

## 38. System Events

系统级事件如果不属于某个 Run，应进入独立 System Event Store。

建议类型：

```text
system.started
system.shutdown_started
system.shutdown_completed
system.database_migration_started
system.database_migration_completed
system.event_store_degraded
system.disk_space_low
system.recovery_started
system.recovery_completed
```

如果系统事件影响某个 Run，应同时产生相应的 Run-scoped Event。

---

# Part X — Error Events

## 39. Canonical Error Event

### `error.occurred`

只用于无法映射到更具体领域 Event 的错误。

```ts
interface ErrorOccurredPayload {
  errorCode: string;
  message: string;
  domain: string;
  phase?: string;
  retryable: boolean;
  suggestedAction?: string;
  details?: Record<string, unknown>;
}
```

优先使用：

```text
run.failed
stage.failed
provider.session_failed
tool.failed
artifact.creation_failed
memory.retrieval_failed
```

而不是把所有错误都发成 `error.occurred`。

---

## 40. Error Code Registry

稳定 Error Code：

```text
PROVIDER_NOT_FOUND
PROVIDER_AUTH_REQUIRED
PROVIDER_RATE_LIMITED
PROVIDER_START_FAILED
PROVIDER_OUTPUT_PARSE_FAILED
PROCESS_STARTUP_TIMEOUT
PROCESS_IDLE_TIMEOUT
PROCESS_TOTAL_TIMEOUT
PROCESS_CANCELLED
WORKTREE_CREATE_FAILED
WORKTREE_CONFLICT
POLICY_DENIED
APPROVAL_REJECTED
MEMORY_RETRIEVAL_FAILED
ARTIFACT_WRITE_FAILED
DATABASE_ERROR
EVENT_PERSIST_FAILED
EVENT_TYPE_UNREGISTERED
EVENT_SCHEMA_INVALID
RUN_RECOVERY_FAILED
STAGE_OUTPUT_INVALID
```

Error Code 不应包含 Provider 原始报错全文。

原始错误可放入 Restricted Artifact。

---

# Part XI — Provider Adapter Mapping

## 41. Mapping Responsibility

Provider Adapter 必须将 Provider 原生输出映射为 Canonical Runtime Event。

```text
Provider Native Output
  ↓
Native Parser
  ↓
Provider-specific Intermediate Event
  ↓
Canonical Event Mapper
  ↓
Runtime Event
```

### 41.1 Native Structured Output

当 Provider 提供稳定结构化事件时，应直接映射。

### 41.2 Known Text Parser

Provider 只有稳定文本格式时，可以解析已知事件。

必须标记：

```ts
metadata: {
  inferred: true,
  confidence: 0.85
}
```

### 41.3 Raw Stream Fallback

无法可靠识别时只产生：

- `stream.text_delta`；
- `process.started`；
- `process.exited`；
- Raw Output Artifact。

不得为了丰富 Timeline 而伪造 Tool、File、Reasoning 或 Subagent Event。

---

## 42. KimiCode Mapping Example

KimiCode 必须由 `KimiCodeProviderAdapter` 直接调用 KimiCode CLI。

假设原生事件：

```json
{
  "event": "tool_call",
  "name": "shell",
  "args": {
    "command": "pnpm test"
  }
}
```

映射：

```json
{
  "type": "tool.started",
  "payload": {
    "callId": "call_shell_01",
    "toolName": "shell",
    "category": "shell",
    "arguments": {
      "command": "pnpm test"
    },
    "argumentsRedacted": false
  }
}
```

KimiCode 不得通过 OpenCode Adapter 伪装接入。

---

## 43. Provider Capability and Timeline Fidelity

Provider Configuration 必须声明：

```ts
interface ProviderCapabilities {
  sessionResume: boolean;
  structuredEvents: boolean;
  nativeApprovals: boolean;
  subagents: boolean;
  toolEvents: boolean;
  fileEvents: boolean;
  usageEvents: boolean;
  reasoningStream: boolean;
}
```

Timeline 应显示事件精细度：

```text
Native Structured
Parsed
Raw Stream
```

缺少某类 Event 不应被误判为 Provider 没有执行该行为。

---

# Part XII — Event Storage

## 44. SQLite Schema

推荐：

```sql
CREATE TABLE runtime_events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,

  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT NOT NULL,
  stage_id TEXT,

  agent_id TEXT,
  provider_config_id TEXT,
  provider_session_id TEXT,
  process_id TEXT,
  worktree_id TEXT,
  artifact_id TEXT,
  approval_request_id TEXT,
  conversation_id TEXT,
  message_id TEXT,

  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,

  source TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  parent_event_id TEXT,

  severity TEXT NOT NULL,
  visibility TEXT NOT NULL,
  durability TEXT NOT NULL,

  payload_json TEXT NOT NULL,
  metadata_json TEXT,

  created_at TEXT NOT NULL,

  UNIQUE(run_id, sequence)
);
```

---

## 45. Indexes

```sql
CREATE INDEX idx_runtime_events_run_sequence
ON runtime_events(run_id, sequence);

CREATE INDEX idx_runtime_events_workspace_time
ON runtime_events(workspace_id, timestamp);

CREATE INDEX idx_runtime_events_type_time
ON runtime_events(type, timestamp);

CREATE INDEX idx_runtime_events_stage_sequence
ON runtime_events(stage_id, sequence);

CREATE INDEX idx_runtime_events_correlation
ON runtime_events(correlation_id);

CREATE INDEX idx_runtime_events_causation
ON runtime_events(causation_id);
```

---

## 46. Sequence Allocation

同一 Run 的 Sequence 必须：

- 唯一；
- 单调递增；
- 并发安全；
- Server 重启后继续。

推荐在 Run 表保存：

```text
next_event_sequence
```

事务：

```text
BEGIN
  read next_event_sequence
  increment next_event_sequence
  insert runtime_event
COMMIT
```

允许事务失败造成 Sequence Gap。

不允许重复或倒序。

---

## 47. Payload Storage Rules

Payload 使用 JSON。

要求：

- Schema Validation；
- 大小限制；
- Secret Redaction；
- 不存大型二进制；
- 大内容写 Artifact；
- 字段名称稳定。

建议单个 Durable Event Payload 上限：

```text
64 KB
```

超出后：

- 内容写 Artifact；
- Event 保存摘要和 Artifact ID。

---

# Part XIII — Event Bus and Subscribers

## 48. Event Bus Responsibilities

Event Bus 负责：

- 发布已持久化 Event；
- Subscriber 注册；
- Subscriber 隔离；
- 重试；
- Dead Letter；
- Metrics；
- Extension Hook。

Event Store 负责 Durable History。

Event Bus 负责实时分发。

---

## 49. Subscriber Types

### 49.1 Critical Subscriber

- State Projector；
- Approval Projector；
- Required Audit；
- 必需 Artifact Registration。

失败可能阻止当前状态迁移。

### 49.2 Non-Critical Subscriber

- Metrics；
- UI Notification；
- Optional Memory Candidate；
- Analytics；
- Extension。

失败只记录 Warning，不应终止 Run。

### 49.3 Idempotent Consumer

每个 Subscriber 应记录：

```text
subscriber_id + event_id
```

防止重复处理。

---

## 50. Dead Letter

Subscriber 无法处理 Event 时，必须记录：

- Subscriber ID；
- Event ID；
- Error；
- Attempt Count；
- First Failed At；
- Last Failed At；
- Retryable。

Dead Letter 必须支持人工或自动 Replay。

---

# Part XIV — Client Stream Protocol

## 51. SSE Endpoint

```text
GET /api/runs/:runId/stream
```

Query：

```text
afterSequence=<number>
```

Header：

```text
Last-Event-ID: <eventId>
```

### 51.1 SSE Envelope

```text
id: evt_123
event: runtime-event
data: {"schemaVersion":1,"type":"tool.started",...}
```

### 51.2 Connection Sequence

Server：

1. 验证 Run；
2. 验证访问权限；
3. 查询 `sequence > afterSequence`；
4. 按顺序发送历史 Event；
5. 订阅实时 Event；
6. 发送 Keepalive。

### 51.3 Keepalive

```text
event: keepalive
data: {"time":"2026-07-19T12:00:00.000Z"}
```

Keepalive 不进入 Event Store。

### 51.4 Disconnect

客户端断开只终止订阅。

不得 Cancel Run。

---

## 52. WebSocket

WebSocket 可用于：

- Approval Interaction；
- Presence；
- Multi-Run Subscription；
- Conversation Live Update；
- Pause / Resume；
- Bidirectional Runtime Control。

Runtime Event Envelope 不因传输方式变化。

---

## 53. Client Deduplication

客户端按：

```text
event.id
```

去重。

按：

```text
sequence
```

排序。

发现 Gap：

```text
expected 101
received 104
```

必须请求补齐 101–103。

---

# Part XV — Timeline and Replay

## 54. Timeline Projection

Timeline 是 Runtime Event 的用户可读投影，不是原始 Event 列表。

可按以下结构分组：

- Stage；
- Provider Session；
- Tool Call；
- Command；
- File Change；
- Approval；
- Subagent；
- Artifact；
- Error。

### 54.1 Collapsing

高频事件可以折叠：

```text
command.stdout × 120
```

显示成一个 Command Card。

### 54.2 Visibility

普通 Timeline：

- Public；
- 必要 Internal 摘要。

Runtime Inspector：

- Public；
- Internal；
- 经授权的 Restricted。

### 54.3 Truth Preservation

UI 可以聚合、折叠和摘要。

不能改变 Event 事实。

---

## 55. Replay

Replay 根据持久化 Event 重建 Run 过程。

Replay 不：

- 重启 Process；
- 再次调用 Provider；
- 重新执行 Tool；
- 再次触发 Approval；
- 再次写 Memory。

支持模式：

- Real-time；
- Accelerated；
- Step-by-step；
- Stage Filter；
- Domain Filter。

```ts
interface ReplayCursor {
  runId: string;
  currentSequence: number;
  speed: number;
}
```

如果存在 Event Gap 或不支持的 Schema：

- 显示 Warning；
- 保留未知 Event；
- 不猜测缺失事实。

---

# Part XVI — Security and Redaction

## 56. Sensitive Data Classes

### Secret

- API Key；
- Token；
- Password；
- Cookie；
- Private Key；
- OAuth Credential。

### Restricted

- 本地绝对路径；
- 私有仓库 URL；
- 用户邮箱；
- 内网地址；
- 敏感命令参数；
- 受限 Artifact。

### Normal

可以正常展示的 Runtime 信息。

---

## 57. Redaction Pipeline

必须在 Event 持久化前完成：

```text
Event Draft
  ↓
Sensitive Field Detection
  ↓
Secret Redaction
  ↓
Path Normalization
  ↓
Payload Validation
  ↓
Persist
```

示例：

```text
sk-abc123
→
[REDACTED_SECRET]
```

### 57.1 Command

普通 Event 只保存：

```ts
argsRedacted: string[];
```

### 57.2 Environment

Event 不保存完整 Environment。

只保存：

- Environment Profile ID；
- Key 名称；
- 是否注入；
- 是否被 Policy 允许。

### 57.3 File Content

默认不写入 Event。

### 57.4 Raw Provider Output

Raw Output Artifact 必须进行：

- Secret Scan；
- Sensitivity Classification；
- Access Control。

---

# Part XVII — Retention and Compaction

## 58. Retention Policy

```ts
interface EventRetentionPolicy {
  durableRetentionDays: number | null;
  rawStreamRetentionDays: number;
  debugEventRetentionDays: number;
  restrictedRetentionDays: number;
}
```

以下事件默认永久保留：

- Run Terminal；
- Stage Terminal；
- Approval；
- Policy Denial；
- Merge；
- Artifact Creation；
- Memory Creation；
- Critical Error。

---

## 59. High-Volume Compaction

可压缩：

- `stream.text_delta`；
- `command.stdout`；
- `command.stderr`；
- `process.heartbeat`；
- `tool.progress`。

压缩前必须：

- 创建完整 Raw Artifact；
- 保留 Sequence 范围；
- 记录原 Event Count；
- 不删除 Terminal 事实。

### `event.compacted`

```ts
interface EventCompactedPayload {
  fromSequence: number;
  toSequence: number;
  eventTypes: string[];
  replacementArtifactId: string;
  originalCount: number;
}
```

---

# Part XVIII — Idempotency, Correction and Correlation

## 60. Deduplication

Event Producer 可使用：

- Event ID；
- Provider Native Event ID；
- Tool Call ID；
- Command ID；
- Idempotency Key。

相同：

```text
runId + providerSessionId + nativeEventId
```

只能映射一次。

---

## 61. Event Correction

Event 不可修改。

发现错误时发出：

```text
event.corrected
```

```ts
interface EventCorrectedPayload {
  targetEventId: string;
  reason: string;
  correctedFields: Record<string, unknown>;
}
```

Projection 根据 Correction 更新显示。

原 Event 保留。

---

## 62. Correlation

建议层级：

```text
Run Correlation
  └── Stage Correlation
      └── Tool Correlation
          └── Command Correlation
```

未来可在 Metadata 加入：

```ts
metadata: {
  traceId?: string;
  spanId?: string;
}
```

OpenTelemetry Trace 不替代 Event ID 和 Run Sequence。

---

# Part XIX — Validation

## 63. Validation Pipeline

```text
Producer creates Event Draft
  ↓
Registry lookup
  ↓
Envelope validation
  ↓
Payload schema validation
  ↓
Reference validation
  ↓
Redaction
  ↓
Size check
  ↓
Sequence allocation
  ↓
Persistence
```

### 63.1 Failure

Event 无法持久化时：

- 不静默丢弃；
- 记录系统 Error；
- 关键 Event 失败应阻止状态迁移；
- 非关键 Event 可降级到 Debug Artifact。

Core 模块发出未知 Event：

```text
EVENT_TYPE_UNREGISTERED
```

---

# Part XX — APIs

## 64. Query Run Events

```text
GET /api/runs/:runId/events
```

Query：

```text
afterSequence
beforeSequence
limit
types
stageId
severity
visibility
```

Response：

```ts
interface RuntimeEventPage {
  events: RuntimeEvent[];
  nextAfterSequence?: number;
  hasMore: boolean;
}
```

---

## 65. Get Event

```text
GET /api/events/:eventId
```

Restricted Event 需要权限检查。

---

## 66. Replay API

```text
GET /api/runs/:runId/replay
```

返回：

- Run Snapshot；
- Stage Snapshot；
- Ordered Event Stream；
- Artifact Index；
- Schema Compatibility。

---

# Part XXI — Canonical Examples

## 67. Run Started

```json
{
  "id": "evt_01JZRUNSTART",
  "schemaVersion": 1,
  "type": "run.started",
  "workspaceId": "ws_01JZ",
  "taskId": "task_01JZ",
  "runId": "run_01JZ",
  "sequence": 3,
  "timestamp": "2026-07-19T12:00:00.000Z",
  "source": "run-engine",
  "correlationId": "corr_run_01JZ",
  "severity": "info",
  "visibility": "public",
  "durability": "durable",
  "payload": {
    "startedAt": "2026-07-19T12:00:00.000Z",
    "workflowSnapshotVersion": 1,
    "policySnapshotVersion": 1,
    "baseCommit": "abc123"
  }
}
```

---

## 68. KimiCode Provider Session

```json
{
  "id": "evt_01JZKIMI",
  "schemaVersion": 1,
  "type": "provider.session_started",
  "workspaceId": "ws_01JZ",
  "taskId": "task_01JZ",
  "runId": "run_01JZ",
  "stageId": "stage_impl",
  "agentId": "agent_backend",
  "providerConfigId": "provider_kimicode",
  "providerSessionId": "session_kimicode_01",
  "sequence": 21,
  "timestamp": "2026-07-19T12:00:04.000Z",
  "source": "provider-adapter",
  "correlationId": "corr_stage_impl",
  "causationId": "evt_stage_started",
  "severity": "info",
  "visibility": "public",
  "durability": "durable",
  "payload": {
    "providerType": "kimicode",
    "nativeSessionId": "native_session_123",
    "runtimeMode": "cli",
    "capabilities": {
      "sessionResume": true,
      "structuredEvents": true,
      "nativeApprovals": false,
      "subagents": false,
      "toolEvents": true,
      "fileEvents": true,
      "usageEvents": true,
      "reasoningStream": false
    }
  }
}
```

---

## 69. Tool Call

```json
{
  "id": "evt_01JZTOOL",
  "schemaVersion": 1,
  "type": "tool.started",
  "workspaceId": "ws_01JZ",
  "taskId": "task_01JZ",
  "runId": "run_01JZ",
  "stageId": "stage_impl",
  "agentId": "agent_backend",
  "providerConfigId": "provider_kimicode",
  "providerSessionId": "session_kimicode_01",
  "sequence": 42,
  "timestamp": "2026-07-19T12:00:10.000Z",
  "source": "provider-adapter",
  "correlationId": "corr_tool_shell_01",
  "causationId": "evt_provider_session_started",
  "severity": "info",
  "visibility": "public",
  "durability": "durable",
  "payload": {
    "callId": "call_shell_01",
    "toolName": "shell",
    "category": "shell",
    "arguments": {
      "command": "pnpm test"
    },
    "argumentsRedacted": false
  }
}
```

---

## 70. Approval

```json
{
  "id": "evt_01JZAPPROVAL",
  "schemaVersion": 1,
  "type": "approval.required",
  "workspaceId": "ws_01JZ",
  "taskId": "task_01JZ",
  "runId": "run_01JZ",
  "stageId": "stage_impl",
  "approvalRequestId": "approval_01JZ",
  "sequence": 61,
  "timestamp": "2026-07-19T12:01:00.000Z",
  "source": "approval-service",
  "correlationId": "corr_approval_01JZ",
  "causationId": "evt_policy_evaluated",
  "severity": "warning",
  "visibility": "public",
  "durability": "durable",
  "payload": {
    "category": "package-install",
    "riskLevel": "medium",
    "title": "Install npm package",
    "description": "The agent requests installing a new dependency.",
    "requestSummary": {
      "package": "example-package"
    }
  }
}
```

---

# Part XXII — v1 Migration

## 71. Current v1 Events

当前 v1 SSE 主要发出：

```text
status
stage
thinking
done
```

问题：

- 未持久化；
- 与 HTTP 连接绑定；
- Event Type 粗糙；
- stdout 与 Event 混合；
- 无 Sequence；
- 无 Replay；
- 无 Provider Session；
- 无 Process Event；
- 无 Tool / File / Approval Event；
- 浏览器断开会取消执行。

---

## 72. Compatibility Mapping

```text
v1 status=running
  → run.started or state projection

v1 status=completed
  → run.completed

v1 status=failed
  → run.failed

v1 stage running
  → stage.started

v1 stage completed
  → stage.completed

v1 thinking
  → stream.text_delta

v1 done
  → run.completed / run.failed / run.cancelled
```

`thinking` 不得继续作为 v2 核心 Event Type。

---

## 73. Migration Steps

1. 增加 Event Store；
2. 旧 SSE 同时写 Runtime Event；
3. 为每次旧 Task 执行创建 Durable Run；
4. 增加 Run Sequence；
5. 前端支持 `runtime-event`；
6. 增加 Projection Layer 兼容旧 UI；
7. SSE 与 Run 生命周期解耦；
8. 删除浏览器断线自动取消；
9. 逐步退役 `status/stage/thinking/done`。

---

# Part XXIII — Testing and Operations

## 74. Unit Tests

必须覆盖：

- Envelope Validation；
- Registry；
- Naming；
- Sequence Allocation；
- Payload Schema；
- Redaction；
- Version Compatibility；
- Deduplication；
- Correlation；
- Payload Size；
- Correction Event。

---

## 75. Integration Tests

必须覆盖：

- Persist then Broadcast；
- Broadcast Failure Recovery；
- Client Reconnect；
- Sequence Gap；
- Duplicate Delivery；
- Provider Mapping；
- Approval Event；
- Process Exit；
- Worktree Event；
- Compaction；
- Restricted Access。

---

## 76. End-to-End Sequence

成功 Run：

```text
run.created
run.queued
run.dequeued
workflow.resolved
worktree.created
memory.retrieved
stage.starting
provider.session_started
process.started
stage.started
run.started
tool.started
command.started
command.completed
file.modified
artifact.created
stage.completed
provider.session_completed
process.exited
workflow.completed
run.completed
```

失败 Run：

```text
provider.validation_failed
stage.failed
artifact.created
run.failed
```

审批：

```text
policy.evaluated
approval.required
approval.resolved
run.resumed
```

断线续传：

- sequence 100 后断线；
- Run 继续；
- 客户端携带 100 重连；
- 接收 101...n；
- Timeline 不重复。

---

## 77. Operational Metrics

系统必须监控：

- Events per Run；
- Events per Second；
- Persist Latency；
- Broadcast Latency；
- Subscriber Lag；
- Validation Failure；
- Redaction Count；
- Payload Size；
- Replay Latency；
- Sequence Conflict；
- Event Store Disk Usage。

---

## 78. Backpressure

高频输出处理策略：

- Chunk Aggregation；
- Bounded Queue；
- Raw Output Artifact；
- 只丢弃非关键 Ephemeral Progress；
- 不丢弃 Terminal、Approval、Policy、File、Merge Event；
- 监控 Subscriber Lag。

---

# Part XXIV — Global Invariants

## 79. Event Model Invariants

AgentOS v2 必须始终满足：

1. Runtime Event 不可变。
2. Durable Event 必须持久化。
3. Event 持久化成功后才能广播。
4. 同一 Run 的 Sequence 必须唯一且递增。
5. 不同 Run 不要求全局顺序。
6. 浏览器断线不得影响 Event 生产。
7. Timeline 必须来自 Runtime Event。
8. stdout 不得作为唯一事实来源。
9. Provider 输出必须经过 Adapter。
10. 不支持的 Provider 能力不得伪造 Event。
11. Payload 必须经过 Schema Validation。
12. Secret 必须在持久化前脱敏。
13. 大型内容必须进入 Artifact。
14. Consumer 必须幂等。
15. Delivery 采用 At-least-once。
16. Replay 不得重新执行 Provider。
17. 未知 Event 不得导致客户端崩溃。
18. Breaking Change 必须提升 Schema Version。
19. Terminal Event 不得被压缩删除。
20. Approval Event 必须可审计。
21. Process Exit 不等于 Stage Completed。
22. Run Completed 不等于 Task Completed。
23. Native Subagent 不等于 Agent Profile。
24. Reasoning Event 不得泄露隐藏 Chain of Thought。
25. Event Correction 必须通过新 Event 表达。
26. Event Store 与 Event Bus 必须分离。
27. Subscriber 失败不得静默。
28. Sequence Gap 必须可检测。
29. Restricted Event 必须受权限控制。
30. v1 `thinking` 只能迁移为 `stream.text_delta`。

---

# Part XXV — Final Definition

## 80. Final Definition

AgentOS v2 Runtime Event 定义如下：

> Runtime Event 是一个与 Run 关联、带有严格顺序、不可变、可持久化、可版本化、可重放、可审计的结构化执行事实。它由 AgentOS Runtime 或 Provider Adapter 产生，经过 Schema Validation、Secret Redaction 和 Sequence Allocation 后写入 Event Store，再通过 Event Bus 分发给 Timeline、Inspector、Metrics、Memory、Artifact、Approval、Conversation Projection 和 Extension。Runtime Event 不等同于 stdout、日志、消息或状态，而是这些系统能力共同依赖的统一事实协议。

简化表达：

```text
Provider / Runtime Action
  ↓
Canonical Event
  ↓
Validate
  ↓
Redact
  ↓
Allocate Sequence
  ↓
Persist
  ↓
Publish
  ├── Timeline
  ├── Inspector
  ├── Replay
  ├── Metrics
  ├── Memory
  ├── Artifact
  ├── Approval
  └── Conversation Projection
```

本文件定义的 Event Model 是 AgentOS v2 Provider Runtime、Process Runtime、Timeline、Runtime Inspector 和 Replay 能力的协议基础。
