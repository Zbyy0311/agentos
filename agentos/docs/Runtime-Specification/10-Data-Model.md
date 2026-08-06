# AgentOS Runtime Specification v2.0

## 10 — Data Model

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Canonical Persistent Data Model  
> Depends On:
> - `00-Vision.md`
> - `01-Core-Concepts.md`
> - `02-Runtime-Lifecycle.md`
> - `03-Event-Model.md`
> - `04-Provider-Specification.md`
> - `05-Process-Runtime.md`
> - `06-Worktree-Runtime.md`
> - `07-Memory-Runtime.md`
> - `08-Policy-Runtime.md`
> - `09-Conversation-Runtime.md`
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的 Canonical Data Model。

它将前述 Runtime Specification 中的核心对象统一映射为可持久化的数据结构，并明确：

- Entity；
- Aggregate；
- Identity；
- Relationship；
- Foreign Key；
- Snapshot；
- Event Store；
- Projection；
- Version；
- Optimistic Concurrency；
- Soft Delete；
- Retention；
- Transaction Boundary；
- Idempotency；
- Index；
- Query Model；
- Migration；
- Backup；
- Recovery；
- Data Integrity；
- SQLite Schema；
- Future PostgreSQL Compatibility；
- Testing；
- Definition of Done。

本文件是以下实现的数据库基准：

- Runtime Core；
- Provider Runtime；
- Process Runtime；
- Worktree Runtime；
- Memory Runtime；
- Policy Runtime；
- Conversation Runtime；
- Artifact Runtime；
- Approval Center；
- Runtime Inspector；
- Timeline；
- Replay；
- Metrics；
- Extension Runtime；
- API Layer。

---

## 2. Data Model Goals

AgentOS v2 的数据模型必须同时满足：

1. **本地优先**  
   默认使用 SQLite 即可运行。

2. **持久执行**  
   Browser、SSE 或 Server 重启不能破坏 Run 状态。

3. **可恢复**  
   Run、Process、Worktree、Approval、Conversation、Streaming Message 都能在重启后恢复或稳定失败。

4. **可审计**  
   重要状态变化必须有 Event、Snapshot 或 Audit Record。

5. **可扩展**  
   Provider、Workflow、Extension、Artifact、Memory 类型可以增加。

6. **可迁移**  
   v1 JSON 和 Markdown 数据可以逐步导入。

7. **可查询**  
   前端 Timeline、Inspector、Conversation、Agent History 不依赖扫描日志文件。

8. **可并发**  
   多个 Run、Stage、Provider、Conversation 和客户端可以并发工作。

9. **可回放**  
   Runtime Event 保留严格顺序和历史事实。

10. **不重复表达同一事实**  
    Snapshot、Current State、Event、Projection 的职责必须清晰。

---

## 3. Core Modeling Principles

### 3.1 Current State and History Are Separate

当前状态：

```text
runs.status = running
```

历史事实：

```text
runtime_events:
  run.started
```

两者都需要，但作用不同。

### 3.2 Snapshot Is Immutable

以下对象进入 Run 后必须快照化：

- Agent Profile；
- Provider Configuration；
- Workflow Definition；
- Policy Profile；
- Isolation Plan；
- Memory Context；
- Prompt；
- Output Contract。

历史 Run 不受后续配置修改影响。

### 3.3 Event Is Append-only

Runtime Event 只能追加。

修正通过：

```text
event.corrected
```

而不是 UPDATE 原 Event。

### 3.4 Projection Is Rebuildable

Conversation Card、Timeline Summary、Metrics 等 Projection 必须可由 Source Data 重建。

### 3.5 Aggregate Owns Its Transaction Boundary

例如：

- Run Aggregate；
- Conversation Aggregate；
- Approval Aggregate；
- Worktree Aggregate。

不同 Aggregate 之间优先使用 Event 或 Saga，而不是超大事务。

### 3.6 IDs Are Application-generated

主键由 AgentOS 生成，而不是依赖 SQLite 自增 ID。

推荐：

```text
<entity_prefix>_<ulid>
```

### 3.7 Foreign Keys Are Explicit

即使某些关系跨 Aggregate，也应通过显式字段表达。

### 3.8 Soft Delete by Default

核心对象默认软删除：

- Workspace；
- Agent；
- Provider Configuration；
- Conversation；
- Message；
- Memory；
- Artifact Metadata。

Runtime Event 不软删除，只按 Retention 清理。

### 3.9 JSON Is for Extensibility, Not for Everything

稳定查询字段使用独立列。

变化频繁或 Provider-specific 内容使用 JSON。

### 3.10 Secret Values Never Enter Main Database

数据库只保存：

```text
secret_reference
secret_profile_id
```

不保存 Secret Value。

---

# Part I — Entity Overview

## 4. Core Entity Groups

### 4.1 Workspace Domain

- Workspace
- WorkspaceSetting
- WorkspaceEnvironmentProfile
- WorkspaceMember, future
- WorkspaceSnapshot

### 4.2 Agent Domain

- AgentProfile
- AgentCapability
- AgentProviderBinding
- AgentSnapshot

### 4.3 Provider Domain

- ProviderConfiguration
- ProviderValidation
- ProviderSession
- ProviderSnapshot
- ProviderHealth

### 4.4 Workflow Domain

- WorkflowDefinition
- WorkflowStageDefinition
- WorkflowEdge
- WorkflowSnapshot

### 4.5 Task and Run Domain

- Task
- Run
- RunStage
- RunAttemptLink
- RunCheckpoint
- RuntimeEvent

### 4.6 Process Domain

- RuntimeProcess
- ProcessUsageSample
- ProcessOutputReference
- ProcessRecoveryRecord

### 4.7 Worktree Domain

- Worktree
- WorktreeOwner
- WorktreeReview
- WorktreeMerge
- WorktreeBaseUpdate

### 4.8 Memory Domain

- MemoryEntry
- MemoryCandidate
- MemoryContext
- MemoryContextEntry
- MemoryConflict

### 4.9 Policy Domain

- PolicyProfile
- PolicyRule
- PolicySnapshot
- PolicyDecision
- ApprovalRequest
- PolicyGrant
- PolicyException

### 4.10 Conversation Domain

- Conversation
- ConversationMember
- Message
- MessageBlock
- MessageRevision
- MessageAttachment
- MessageReference
- MessageMention
- AgentTurn
- OrchestratorTurn
- ConversationSummary
- ConversationReadState
- ConversationNotification
- ConversationProjection

### 4.11 Artifact Domain

- Artifact
- ArtifactVersion
- ArtifactReference
- ArtifactRetentionPolicy

### 4.12 Extension Domain

- Extension
- ExtensionVersion
- ExtensionInstallation
- ExtensionPermissionGrant

### 4.13 System Domain

- SchemaMigration
- OutboxMessage
- DeadLetter
- RuntimeLock
- SchedulerJob
- RecoveryCheckpoint
- AuditRecord

---

## 5. High-level Relationship Diagram

```text
Workspace
├── AgentProfile
├── ProviderConfiguration
├── WorkflowDefinition
├── PolicyProfile
├── Conversation
├── Task
├── MemoryEntry
└── Artifact

Conversation
├── ConversationMember
├── Message
├── ConversationSummary
├── AgentTurn
└── links → Task / Run / Approval / Artifact

Task
├── Run
├── Task Memory
└── Conversation references

Run
├── RunStage
├── RuntimeEvent
├── ProviderSession
├── RuntimeProcess
├── Worktree
├── MemoryContext
├── PolicySnapshot
├── Artifact
└── Conversation Projection

RunStage
├── ProviderSession
├── RuntimeProcess
├── Worktree
├── RuntimeEvent
└── Artifact

ProviderConfiguration
└── ProviderSession

PolicyProfile
├── PolicyRule
└── PolicySnapshot

PolicyDecision
└── ApprovalRequest
    └── PolicyGrant

MemoryEntry
├── MemoryConflict
└── MemoryContextEntry

Artifact
└── referenced by Run / Stage / Message / Memory / Event
```

---

# Part II — Identity and Common Fields

## 6. ID Conventions

推荐前缀：

```text
ws_        Workspace
agent_     AgentProfile
provider_  ProviderConfiguration
psess_     ProviderSession
workflow_  WorkflowDefinition
wstage_    WorkflowStageDefinition
task_      Task
run_       Run
stage_     RunStage
evt_       RuntimeEvent
proc_      RuntimeProcess
wt_        Worktree
mem_       MemoryEntry
mcand_     MemoryCandidate
mctx_      MemoryContext
policy_    PolicyProfile
prule_     PolicyRule
pdec_      PolicyDecision
approval_  ApprovalRequest
grant_     PolicyGrant
conv_      Conversation
msg_       Message
turn_      AgentTurn
artifact_  Artifact
ext_       Extension
```

### 6.1 ULID

推荐 ULID：

- 可按时间排序；
- 分布式可生成；
- 适合 SQLite；
- 不依赖数据库序列。

### 6.2 No Semantic IDs

不要把完整用户名、Task Title 或 Branch Name 直接作为主键。

---

## 7. Common Audit Fields

多数可变实体应包含：

```ts
interface MutableEntityFields {
  createdAt: string;
  updatedAt: string;
  version: number;
  archivedAt?: string;
  deletedAt?: string;
}
```

### 7.1 Timestamp

统一 UTC ISO 8601：

```text
2026-07-19T12:00:00.000Z
```

数据库中使用 TEXT。

### 7.2 Version

从 1 开始。

每次修改：

```text
version = version + 1
```

用于 Optimistic Concurrency。

---

## 8. Soft Delete

软删除对象：

```text
deleted_at IS NOT NULL
```

默认查询必须排除。

### 8.1 Hard Delete

只允许：

- Retention；
- Privacy；
- Secret Cleanup；
- User Explicit Permanent Delete；
- Test Data。

### 8.2 Referential Integrity

软删除父对象时，不自动硬删除子对象。

---

## 9. Entity Status

状态字段使用稳定枚举字符串。

不使用：

```text
0 / 1 / 2
```

表达复杂生命周期。

### 9.1 Terminal Status

每个 Aggregate 必须明确 Terminal Status。

例如 Run：

```text
completed
failed
cancelled
```

---

## 10. Metadata JSON

允许：

```text
metadata_json
```

但要求：

- 不保存核心查询字段；
- 不保存 Secret；
- Schema Version；
- 大小限制；
- 可向后兼容。

---

# Part III — Workspace Data Model

## 11. Workspace

```ts
interface Workspace {
  id: string;

  name: string;

  description?: string;

  rootPath: string;

  canonicalRootPath: string;

  repositoryType:
    | 'git'
    | 'directory'
    | 'remote';

  defaultBranch?: string;

  defaultAgentId?: string;

  defaultProviderConfigId?: string;

  defaultWorkflowDefinitionId?: string;

  defaultPolicyProfileId?: string;

  status:
    | 'active'
    | 'unavailable'
    | 'archived'
    | 'deleted';

  settingsVersion: number;

  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  deletedAt?: string;

  version: number;
}
```

---

## 12. Workspace Schema

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,

  name TEXT NOT NULL,
  description TEXT,

  root_path TEXT NOT NULL,
  canonical_root_path TEXT NOT NULL UNIQUE,

  repository_type TEXT NOT NULL,
  default_branch TEXT,

  default_agent_id TEXT,
  default_provider_config_id TEXT,
  default_workflow_definition_id TEXT,
  default_policy_profile_id TEXT,

  status TEXT NOT NULL,

  settings_version INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,

  version INTEGER NOT NULL
);
```

---

## 13. Workspace Settings

稳定设置可以独立表：

```sql
CREATE TABLE workspace_settings (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, key)
);
```

适合：

- Worktree Root；
- Cleanup Policy；
- UI Setting；
- Default Timeout；
- Retention；
- Feature Flag。

---

## 14. Environment Profile

```sql
CREATE TABLE environment_profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  values_json TEXT NOT NULL,
  secret_reference_keys_json TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
```

`values_json` 不包含 Secret Value。

---

# Part IV — Agent Data Model

## 15. Agent Profile

```ts
interface AgentProfile {
  id: string;

  workspaceId: string;

  name: string;

  role: string;

  description?: string;

  instructions?: string;

  avatar?: string;

  status:
    | 'active'
    | 'disabled'
    | 'archived';

  defaultProviderConfigId?: string;

  defaultWorkflowRole?: string;

  capabilities: string[];

  metadata?: Record<string, unknown>;

  createdAt: string;
  updatedAt: string;
  archivedAt?: string;

  version: number;
}
```

---

## 16. Agent Schema

```sql
CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,

  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT,
  instructions TEXT,
  avatar TEXT,

  status TEXT NOT NULL,

  default_provider_config_id TEXT,
  default_workflow_role TEXT,

  capabilities_json TEXT NOT NULL,
  metadata_json TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,

  version INTEGER NOT NULL,

  UNIQUE(workspace_id, name)
);
```

---

## 17. Agent Provider Binding

用于 Agent 的 Provider 偏好和 Fallback：

```sql
CREATE TABLE agent_provider_bindings (
  id TEXT PRIMARY KEY,

  agent_id TEXT NOT NULL,
  provider_config_id TEXT NOT NULL,

  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL,

  purpose TEXT,
  conditions_json TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(agent_id, provider_config_id)
);
```

---

## 18. Agent Snapshot

Agent Snapshot 建议保存在 Run 或 Stage Snapshot JSON 中。

也可独立：

```sql
CREATE TABLE agent_snapshots (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

多个 Run 可复用完全相同 Snapshot。

---

# Part V — Provider Data Model

## 19. Provider Configuration

```sql
CREATE TABLE provider_configurations (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,

  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  adapter_id TEXT NOT NULL,

  runtime_mode TEXT NOT NULL,

  executable TEXT,
  args_template_json TEXT,

  model TEXT,

  environment_profile_id TEXT,
  secret_profile_id TEXT,

  working_directory_mode TEXT NOT NULL,
  custom_working_directory TEXT,

  capabilities_json TEXT NOT NULL,
  timeout_policy_json TEXT NOT NULL,

  approval_mode TEXT NOT NULL,
  output_mode TEXT NOT NULL,

  enabled INTEGER NOT NULL,

  version INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
```

---

## 20. Provider Validation

```sql
CREATE TABLE provider_validations (
  id TEXT PRIMARY KEY,

  provider_config_id TEXT NOT NULL,
  configuration_version INTEGER NOT NULL,

  valid INTEGER NOT NULL,

  executable_resolved TEXT,
  cli_version TEXT,
  authenticated INTEGER,

  capabilities_json TEXT NOT NULL,
  output_mode TEXT NOT NULL,

  warnings_json TEXT NOT NULL,
  errors_json TEXT NOT NULL,

  adapter_version TEXT NOT NULL,

  checked_at TEXT NOT NULL,

  cache_key TEXT NOT NULL,

  UNIQUE(provider_config_id, cache_key)
);
```

---

## 21. Provider Session

```sql
CREATE TABLE provider_sessions (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,

  agent_id TEXT NOT NULL,
  provider_config_id TEXT NOT NULL,

  provider_type TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,

  native_session_id TEXT,

  runtime_mode TEXT NOT NULL,

  process_id TEXT,

  status TEXT NOT NULL,

  capabilities_json TEXT NOT NULL,
  metadata_json TEXT,

  started_at TEXT,
  last_activity_at TEXT,
  completed_at TEXT,

  version INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

# Part VI — Workflow Data Model

## 22. Workflow Definition

```ts
interface WorkflowDefinition {
  id: string;

  workspaceId?: string;

  name: string;

  description?: string;

  status:
    | 'draft'
    | 'active'
    | 'archived';

  version: number;

  inputSchema?: Record<string, unknown>;

  outputContract?: Record<string, unknown>;

  metadata?: Record<string, unknown>;

  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}
```

---

## 23. Workflow Schema

```sql
CREATE TABLE workflow_definitions (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,

  name TEXT NOT NULL,
  description TEXT,

  status TEXT NOT NULL,

  definition_version INTEGER NOT NULL,

  input_schema_json TEXT,
  output_contract_json TEXT,
  metadata_json TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,

  UNIQUE(workspace_id, name, definition_version)
);
```

---

## 24. Workflow Stage Definition

```sql
CREATE TABLE workflow_stage_definitions (
  id TEXT PRIMARY KEY,

  workflow_definition_id TEXT NOT NULL,

  stage_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,

  sequence_hint INTEGER NOT NULL,

  agent_selector_json TEXT NOT NULL,
  provider_selector_json TEXT,
  prompt_template TEXT,

  input_contract_json TEXT,
  output_contract_json TEXT,

  retry_policy_json TEXT NOT NULL,
  timeout_policy_json TEXT,
  worktree_policy_json TEXT,
  memory_policy_json TEXT,
  policy_profile_override_id TEXT,

  condition_json TEXT,

  metadata_json TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(workflow_definition_id, stage_key)
);
```

---

## 25. Workflow Edge

```sql
CREATE TABLE workflow_edges (
  id TEXT PRIMARY KEY,

  workflow_definition_id TEXT NOT NULL,

  from_stage_id TEXT NOT NULL,
  to_stage_id TEXT NOT NULL,

  edge_type TEXT NOT NULL,

  condition_json TEXT,

  created_at TEXT NOT NULL,

  UNIQUE(workflow_definition_id, from_stage_id, to_stage_id)
);
```

---

# Part VII — Task and Run Data Model

## 26. Task

```ts
interface Task {
  id: string;

  workspaceId: string;

  title: string;

  description?: string;

  status:
    | 'draft'
    | 'ready'
    | 'running'
    | 'review'
    | 'completed'
    | 'cancelled'
    | 'archived';

  priority:
    | 'low'
    | 'normal'
    | 'high'
    | 'urgent';

  assignedAgentId?: string;

  workflowDefinitionId?: string;

  sourceConversationId?: string;

  sourceMessageId?: string;

  acceptedRunId?: string;

  acceptanceCriteria?: string;

  metadata?: Record<string, unknown>;

  createdBy: string;

  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  archivedAt?: string;

  version: number;
}
```

---

## 27. Task Schema

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT,

  status TEXT NOT NULL,
  priority TEXT NOT NULL,

  assigned_agent_id TEXT,
  workflow_definition_id TEXT,

  source_conversation_id TEXT,
  source_message_id TEXT,

  accepted_run_id TEXT,

  acceptance_criteria TEXT,

  metadata_json TEXT,

  created_by TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  archived_at TEXT,

  version INTEGER NOT NULL
);
```

---

## 28. Run

> **SUPERSEDED / HISTORICAL — NOT CURRENT M3 V2 CONTRACT.** The conceptual
> schema below is retained for pre-M2.5 compatibility history. The current
> persisted Run and Retry Child contract is §33A.

```ts
interface Run {
  id: string;

  workspaceId: string;

  taskId: string;

  parentRunId?: string;

  rootRunId: string;

  // Current M3 V2RunStatus; recovery_required is a separate field.
  status:
    | 'queued'
    | 'starting'
    | 'running'
    | 'waiting_approval'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';

  reason:
    | 'initial'
    | 'retry'
    | 'resume-fallback'
    | 'review-fix'
    | 'provider-comparison'
    | 'manual';

  priority: string;

  workflowDefinitionId?: string;
  workflowSnapshotId?: string;

  policySnapshotId?: string;

  isolationPlanSnapshotId?: string;

  defaultAgentId?: string;

  baseCommit?: string;

  resultSummary?: string;

  failureCode?: string;
  failureMessage?: string;

  cancellationRequestedAt?: string;

  startedAt?: string;
  completedAt?: string;

  nextEventSequence: number;

  createdBy: string;

  createdAt: string;
  updatedAt: string;

  version: number;
}
```

---

## 29. Run Schema

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,

  parent_run_id TEXT,
  root_run_id TEXT NOT NULL,

  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  priority TEXT NOT NULL,

  workflow_definition_id TEXT,
  workflow_snapshot_id TEXT,

  policy_snapshot_id TEXT,
  isolation_plan_snapshot_id TEXT,

  default_agent_id TEXT,

  base_commit TEXT,

  result_summary TEXT,

  failure_code TEXT,
  failure_message TEXT,

  cancellation_requested_at TEXT,

  started_at TEXT,
  completed_at TEXT,

  next_event_sequence INTEGER NOT NULL DEFAULT 1,

  created_by TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL
);
```

---

## 30. Run Stage

> **SUPERSEDED / HISTORICAL — NOT CURRENT M3 V2 CONTRACT.** The conceptual
> schema below is retained for compatibility history. The current persisted
> RunStage contract is §33A.

```ts
interface RunStage {
  id: string;

  workspaceId: string;

  taskId: string;

  runId: string;

  workflowStageDefinitionId?: string;

  stageKey: string;

  name: string;

  sequence: number;

  status:
    | 'created'
    | 'blocked'
    | 'ready'
    | 'starting'
    | 'running'
    | 'waiting_approval'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'skipped';

  attempt: number;

  agentId: string;

  agentSnapshotId?: string;

  providerConfigId: string;

  providerSnapshotId?: string;

  worktreeId?: string;

  memoryContextId?: string;

  outputContractJson?: string;

  resultArtifactId?: string;

  failureCode?: string;
  failureMessage?: string;

  startedAt?: string;
  completedAt?: string;

  createdAt: string;
  updatedAt: string;

  version: number;
}
```

---

## 31. Run Stage Schema

```sql
CREATE TABLE run_stages (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,

  workflow_stage_definition_id TEXT,

  stage_key TEXT NOT NULL,
  name TEXT NOT NULL,
  sequence INTEGER NOT NULL,

  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,

  agent_id TEXT NOT NULL,
  agent_snapshot_id TEXT,

  provider_config_id TEXT NOT NULL,
  provider_snapshot_id TEXT,

  worktree_id TEXT,
  memory_context_id TEXT,

  output_contract_json TEXT,

  result_artifact_id TEXT,

  failure_code TEXT,
  failure_message TEXT,

  started_at TEXT,
  completed_at TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL,

  UNIQUE(run_id, stage_key, attempt)
);
```

---

## 32. Stage Dependencies

```sql
CREATE TABLE run_stage_dependencies (
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  depends_on_stage_id TEXT NOT NULL,
  dependency_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, stage_id, depends_on_stage_id)
);
```

---

## 33. Run Attempt Link

> **SUPERSEDED / HISTORICAL — NOT CURRENT M3 V2 CONTRACT.** Current M3 Retry
> lineage is carried by `runs.parent_run_id` and `runs.root_run_id`; this
> conceptual link table is not required by the current schema.

用于 Retry、Fallback 和 Review Fix：

```sql
CREATE TABLE run_attempt_links (
  id TEXT PRIMARY KEY,

  parent_run_id TEXT NOT NULL,
  child_run_id TEXT NOT NULL,

  relation_type TEXT NOT NULL,

  reason TEXT,

  created_at TEXT NOT NULL,

  UNIQUE(parent_run_id, child_run_id)
);
```

---

## 33A. Current M3 V2 Run, Retry Child, Snapshot, and Stage contract

The following is the current data-model contract at the post-PR-#31 main
baseline. It is the only current M3 Retry model; the historical sections above
are not an alternate implementation.

### Current Run and Child fields

The current persisted Run has these relevant fields: `id`, `workspaceId`,
`taskId`, optional `parentRunId`, `rootRunId`, `status`,
`reason`, `origin`, optional `objective`, optional failure/cancellation fields,
`nextEventSequence`, optional lifecycle timestamps, `createdBy`, audit
timestamps, and `version`.

For the Retry Child, the exact values are:

| Field | Value |
| --- | --- |
| `workspaceId` | Parent workspace |
| `taskId` | Parent task |
| `parentRunId` | Parent ID |
| `rootRunId` | Parent root ID |
| `status` | `queued` |
| `reason` | `retry` |
| `origin` | `v2_api`, server-owned |
| `objective` | Parent objective |
| `createdBy` | Parent persisted `createdBy` |
| `nextEventSequence` | `1` |
| `version` | `1` |

The Parent must be `failed` at the requested version. Parent status, version,
failure data, timestamps, and all other fields remain unchanged. Task status,
version, and run pointers remain unchanged. Child IDs and timestamps are
fresh; Child runtime output and terminal fields are empty.

### Current Snapshot V2 clone

The Parent must have one valid persisted `RunSnapshotPayloadV2`. The Retry
Child does not resolve current configuration and does not silently upgrade a
V1 Snapshot. A missing, V1, malformed, or graph-mismatched Parent Snapshot is
`RUN_RETRY_STATE_INCONSISTENT` with no committed side effect.

The Child Snapshot is a new row with a new ID, fresh `capturedAt`, canonical
JSON, and content hash. Its `workflow` preserves the Parent Snapshot's
definition identity, version, name, definition hash, `worktreeMode`, ordered
stages, `dependsOn`, Agent snapshots, Provider snapshots, and security
redaction result. Its `run` block is remapped to the Child's workspace, task,
origin, reason, parent, and root IDs. Parent Snapshot ID, runtime state,
outputs, errors, stage IDs, and old timestamps are never copied.

### Current Child Stage graph

The Parent `RunStage` rows must match the Snapshot V2 stage keys and sequences.
Each Child Stage gets a new ID, Child Run ID, Child Snapshot ID, identical
workflow key and sequence, `attempt = 1`, `status = pending`, fresh audit
timestamps, and `version = 1`. No Parent Stage status, attempt, output,
failure, lifecycle timestamp, or ID is copied. Dependency metadata remains in
the immutable Snapshot V2 `workflow.stages[].dependsOn` values; it is not
re-resolved or rewritten into a mutable current-configuration table.

### Creation Events and Outbox

After Child Run, Snapshot, and Stages exist inside the same A2 transaction,
the existing graph-event seam appends Child `run.created` followed by ordered
`stage.created` Events and one matching Outbox row per Event. Creation Event
correlation is the Child Run ID. Each `stage.created` points by both
`causationId` and `parentEventId` to Child `run.created`. Future execution
Events use the independent `run.start` Operation ID. Retry does not create an
Operation Event.

### Current Retry Operation binding

The Retry Operation is not a Child aggregate. It is Parent-bound:

```text
type = run.retry
status: queued/v1 -> running/v2 -> completed/v3
aggregateType = run
aggregateId = Parent.id
runId = Parent.id
correlationId = operation.id
result = { resourceType: run, resourceId: Child.id }
```

The persisted HTTP 201 Idempotency envelope is schemaVersion 1 and contains
the original queued Child Run DTO plus the original completed v3 Operation
DTO. The discriminator is internal; HTTP exposes only `{run, operation}`.
Replay is immutable and does not read current Child or Operation state.

### Task active-slot and Retry history boundary

Retry Child creation uses Task active statuses `queued`, `starting`,
`running`, `waiting_approval`, and `paused`. A valid direct Child already
bound to exactly one completed version-3 Retry Operation is the duplicate
case; any other active Run for the Task prevents a second active Child and
maps to `409 RUN_ACTIVE_EXISTS`. A uniqueness race during insertion has the
same result and rolls back the transaction.

Creation is eligible only with zero direct Child rows, zero completed Retry
Operations, and zero non-terminal Retry Operations; any number of failed or
cancelled Retry history rows may remain. More than one non-terminal Retry,
completed Retry, or direct Child is ambiguous; missing or mismatched Retry,
Child, result, workspace, task, root, or lineage bindings are inconsistent.
After a replay miss, this decision order is Parent read, expectedVersion,
Parent status `failed`, structural ambiguity, structural inconsistency, valid
completed Retry/direct Child duplicate, Task active slot, Snapshot/Stage
validation, and then creation writes.

## 34. Run Checkpoint

```sql
CREATE TABLE run_checkpoints (
  id TEXT PRIMARY KEY,

  run_id TEXT NOT NULL,
  stage_id TEXT,

  checkpoint_type TEXT NOT NULL,

  state_json TEXT NOT NULL,

  last_event_sequence INTEGER NOT NULL,

  created_at TEXT NOT NULL
);
```

---

# Part VIII — Runtime Event Data Model

## 35. Runtime Event

完整 Schema 与 `03-Event-Model.md` 保持一致。

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

## 36. Event Store Rules

- Append-only；
- 单 Run Sequence 唯一；
- Event ID 全局唯一；
- Payload 校验；
- Secret Redaction；
- 先 Persist 再 Publish；
- Event 修正通过新 Event；
- Terminal Event 不压缩删除。

---

## 37. Event Sequence Allocation

推荐事务：

```sql
BEGIN IMMEDIATE;

SELECT next_event_sequence
FROM runs
WHERE id = ?;

UPDATE runs
SET next_event_sequence = next_event_sequence + 1
WHERE id = ?;

INSERT INTO runtime_events (...);

COMMIT;
```

允许 Gap，不允许重复。

---

# Part IX — Process Data Model

## 38. Runtime Process

```sql
CREATE TABLE runtime_processes (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  provider_session_id TEXT,
  parent_process_id TEXT,

  native_pid INTEGER,
  native_parent_pid INTEGER,

  process_type TEXT NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL,

  executable TEXT NOT NULL,
  args_redacted_json TEXT NOT NULL,
  cwd TEXT NOT NULL,

  shell INTEGER NOT NULL,
  detached INTEGER NOT NULL,

  stdin_mode TEXT NOT NULL,
  stdout_mode TEXT NOT NULL,
  stderr_mode TEXT NOT NULL,

  process_group_id INTEGER,
  platform_handle_id TEXT,
  recovery_token_hash TEXT,

  started_at TEXT,
  ready_at TEXT,
  last_activity_at TEXT,
  stopping_at TEXT,
  exited_at TEXT,

  exit_code INTEGER,
  exit_signal TEXT,
  termination_reason TEXT,

  version INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 39. Process Usage Samples

```sql
CREATE TABLE process_usage_samples (
  id TEXT PRIMARY KEY,

  process_id TEXT NOT NULL,
  run_id TEXT NOT NULL,

  sampled_at TEXT NOT NULL,

  cpu_percent REAL,
  memory_rss_bytes INTEGER,
  memory_virtual_bytes INTEGER,
  child_process_count INTEGER,
  read_bytes INTEGER,
  write_bytes INTEGER,
  output_bytes INTEGER
);
```

高频 Sample 可按 Retention 清理。

---

## 40. Process Output References

```sql
CREATE TABLE process_output_references (
  process_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  bytes_written INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  finalized INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(process_id, stream)
);
```

---

# Part X — Worktree Data Model

## 41. Worktree

```sql
CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  parent_worktree_id TEXT,

  worktree_type TEXT NOT NULL,
  isolation_mode TEXT NOT NULL,

  path TEXT NOT NULL UNIQUE,
  branch_name TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  head_commit TEXT,
  target_branch TEXT,

  status TEXT NOT NULL,

  ownership_token_hash TEXT NOT NULL,

  created_at TEXT NOT NULL,
  activated_at TEXT,
  last_inspected_at TEXT,
  merged_at TEXT,
  abandoned_at TEXT,
  deleted_at TEXT,

  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE(workspace_id, branch_name)
);
```

---

## 42. Worktree Ownership

```sql
CREATE TABLE worktree_owners (
  worktree_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY(worktree_id, owner_type, owner_id, acquired_at)
);
```

---

## 43. Worktree Review

```sql
CREATE TABLE worktree_reviews (
  id TEXT PRIMARY KEY,

  worktree_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,

  reviewer_id TEXT NOT NULL,

  outcome TEXT NOT NULL,

  head_commit TEXT NOT NULL,
  diff_artifact_id TEXT NOT NULL,
  review_artifact_id TEXT,

  created_at TEXT NOT NULL
);
```

---

## 44. Worktree Merge

```sql
CREATE TABLE worktree_merges (
  id TEXT PRIMARY KEY,

  worktree_id TEXT NOT NULL,

  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,

  strategy TEXT NOT NULL,

  source_head_commit TEXT NOT NULL,
  previous_target_commit TEXT,
  resulting_target_commit TEXT,
  merge_commit TEXT,

  status TEXT NOT NULL,

  conflict_artifact_id TEXT,
  merge_artifact_id TEXT,

  requested_by TEXT NOT NULL,

  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

---

## 45. Target Branch Lock

```sql
CREATE TABLE branch_locks (
  workspace_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT,
  version INTEGER NOT NULL,
  PRIMARY KEY(workspace_id, branch_name)
);
```

---

# Part XI — Memory Data Model

## 46. Memory Entry

```sql
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,

  scope TEXT NOT NULL,
  category TEXT NOT NULL,

  workspace_id TEXT,
  agent_id TEXT,
  conversation_id TEXT,
  task_id TEXT,
  run_id TEXT,
  stage_id TEXT,

  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  tags_json TEXT NOT NULL,

  source_type TEXT NOT NULL,
  source_id TEXT,
  source_event_id TEXT,
  source_artifact_id TEXT,
  source_run_id TEXT,
  source_stage_id TEXT,

  confidence REAL NOT NULL,
  importance REAL NOT NULL,
  authority TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'normal',

  status TEXT NOT NULL,
  pinned INTEGER NOT NULL,

  expires_at TEXT,
  valid_from TEXT,
  valid_until TEXT,

  supersedes_memory_id TEXT,
  superseded_by_memory_id TEXT,

  content_hash TEXT NOT NULL,
  token_estimate INTEGER,

  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  last_validated_at TEXT,

  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,

  version INTEGER NOT NULL
);
```

---

## 47. Memory Candidate

```sql
CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,

  proposed_scope TEXT NOT NULL,
  proposed_category TEXT NOT NULL,

  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  tags_json TEXT NOT NULL,

  source_type TEXT NOT NULL,
  source_ids_json TEXT NOT NULL,

  confidence REAL NOT NULL,
  importance REAL NOT NULL,
  authority TEXT NOT NULL,

  duplicate_of_memory_id TEXT,
  conflicts_with_json TEXT NOT NULL,

  recommendation TEXT NOT NULL,
  status TEXT NOT NULL,

  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
```

---

## 48. Memory Context

```sql
CREATE TABLE memory_contexts (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  agent_id TEXT NOT NULL,
  provider_config_id TEXT NOT NULL,

  query_text TEXT NOT NULL,
  query_hash TEXT NOT NULL,
  retrieval_strategy TEXT NOT NULL,

  budget_json TEXT NOT NULL,
  budget_used_json TEXT NOT NULL,

  prompt_artifact_id TEXT,

  generated_at TEXT NOT NULL,
  version INTEGER NOT NULL
);
```

---

## 49. Memory Context Entry

```sql
CREATE TABLE memory_context_entries (
  memory_context_id TEXT NOT NULL,
  memory_entry_id TEXT NOT NULL,

  memory_version INTEGER NOT NULL,

  scope TEXT NOT NULL,
  category TEXT NOT NULL,

  title_snapshot TEXT NOT NULL,
  content_snapshot TEXT NOT NULL,

  score REAL NOT NULL,
  rank INTEGER NOT NULL,

  reasons_json TEXT NOT NULL,

  authority TEXT NOT NULL,
  confidence REAL NOT NULL,
  importance REAL NOT NULL,

  token_estimate INTEGER NOT NULL,
  truncated INTEGER NOT NULL,

  PRIMARY KEY(memory_context_id, memory_entry_id)
);
```

---

## 50. Memory Conflict

```sql
CREATE TABLE memory_conflicts (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,

  memory_ids_json TEXT NOT NULL,
  conflict_type TEXT NOT NULL,

  status TEXT NOT NULL,

  resolution_json TEXT,

  created_at TEXT NOT NULL,
  resolved_at TEXT
);
```

---

# Part XII — Policy and Approval Data Model

## 51. Policy Profile

```sql
CREATE TABLE policy_profiles (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,

  name TEXT NOT NULL,
  description TEXT,

  mode TEXT NOT NULL,
  default_effect TEXT NOT NULL,

  protected_branch_policy_json TEXT,
  network_policy_json TEXT,
  secret_policy_json TEXT,
  extension_policy_json TEXT,

  enabled INTEGER NOT NULL,

  version INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
```

---

## 52. Policy Rule

```sql
CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY,

  policy_profile_id TEXT NOT NULL,

  name TEXT NOT NULL,
  description TEXT,

  enabled INTEGER NOT NULL,

  effect TEXT NOT NULL,
  priority INTEGER NOT NULL,

  principal_selector_json TEXT,
  action_selector_json TEXT NOT NULL,
  resource_selector_json TEXT,
  context_selector_json TEXT,

  risk_level TEXT,
  approval_scope_options_json TEXT,

  reason TEXT NOT NULL,
  tags_json TEXT NOT NULL,

  version INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 53. Policy Snapshot

```sql
CREATE TABLE policy_profile_snapshots (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,

  policy_profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,

  mode TEXT NOT NULL,
  default_effect TEXT NOT NULL,

  compiled_hash TEXT NOT NULL,
  compiler_version TEXT NOT NULL,

  snapshot_json TEXT NOT NULL,

  unsafe_mode INTEGER NOT NULL,

  created_at TEXT NOT NULL
);
```

---

## 54. Policy Decision

```sql
CREATE TABLE policy_decisions (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  stage_id TEXT,
  provider_session_id TEXT,
  process_id TEXT,

  policy_request_id TEXT NOT NULL,
  profile_snapshot_id TEXT NOT NULL,

  principal_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  resource_json TEXT NOT NULL,

  decision TEXT NOT NULL,
  risk_level TEXT NOT NULL,

  matched_rule_ids_json TEXT NOT NULL,
  constraints_json TEXT,

  reason TEXT NOT NULL,
  error_code TEXT,

  approval_request_id TEXT,

  executed INTEGER,
  execution_event_id TEXT,

  created_at TEXT NOT NULL,

  UNIQUE(policy_request_id, profile_snapshot_id)
);
```

---

## 55. Approval Request

```sql
CREATE TABLE approval_requests (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT NOT NULL,
  stage_id TEXT,
  provider_session_id TEXT,
  process_id TEXT,

  policy_decision_id TEXT NOT NULL,

  principal_snapshot_json TEXT NOT NULL,
  action_snapshot_json TEXT NOT NULL,
  resource_snapshot_json TEXT NOT NULL,

  category TEXT NOT NULL,
  risk_level TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT NOT NULL,
  request_summary_json TEXT NOT NULL,

  allowed_grant_scopes_json TEXT NOT NULL,

  status TEXT NOT NULL,

  expires_at TEXT,

  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_json TEXT,

  version INTEGER NOT NULL
);
```

---

## 56. Policy Grant

```sql
CREATE TABLE policy_grants (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  source_approval_request_id TEXT NOT NULL,

  principal_selector_json TEXT NOT NULL,
  action_selector_json TEXT NOT NULL,
  resource_selector_json TEXT,

  scope TEXT NOT NULL,

  run_id TEXT,
  stage_id TEXT,

  expires_at TEXT,

  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,

  revoked_at TEXT,
  revoked_by TEXT,

  version INTEGER NOT NULL
);
```

---

## 57. Policy Exception

```sql
CREATE TABLE policy_exceptions (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,

  name TEXT NOT NULL,

  principal_selector_json TEXT,
  action_selector_json TEXT NOT NULL,
  resource_selector_json TEXT,

  override_effect TEXT NOT NULL,
  overrides_rule_ids_json TEXT NOT NULL,

  reason TEXT NOT NULL,

  created_by TEXT NOT NULL,
  approved_by TEXT,

  expires_at TEXT,

  enabled INTEGER NOT NULL,

  version INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

# Part XIII — Conversation Data Model

## 58. Conversation

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,

  type TEXT NOT NULL,

  title TEXT NOT NULL,
  description TEXT,
  avatar TEXT,

  status TEXT NOT NULL,

  owner_user_id TEXT NOT NULL,

  default_agent_id TEXT,
  orchestrator_agent_id TEXT,

  linked_task_id TEXT,
  linked_run_id TEXT,

  reply_policy_json TEXT NOT NULL,
  context_policy_json TEXT NOT NULL,
  notification_policy_json TEXT NOT NULL,

  retention_policy_id TEXT,

  last_message_id TEXT,
  last_message_at TEXT,

  next_message_sequence INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,

  version INTEGER NOT NULL
);
```

---

## 59. Conversation Member

```sql
CREATE TABLE conversation_members (
  id TEXT PRIMARY KEY,

  conversation_id TEXT NOT NULL,

  member_type TEXT NOT NULL,
  member_id TEXT NOT NULL,

  display_name_snapshot TEXT NOT NULL,

  role TEXT NOT NULL,
  status TEXT NOT NULL,
  reply_mode TEXT NOT NULL,

  priority INTEGER NOT NULL,

  joined_at TEXT NOT NULL,
  removed_at TEXT,

  version INTEGER NOT NULL,

  UNIQUE(conversation_id, member_type, member_id)
);
```

---

## 60. Message

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,

  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,

  sender_type TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_display_name_snapshot TEXT NOT NULL,

  message_type TEXT NOT NULL,
  status TEXT NOT NULL,

  sequence INTEGER NOT NULL,

  reply_to_message_id TEXT,
  thread_root_message_id TEXT,

  source_message_id TEXT,
  source_event_id TEXT,
  source_task_id TEXT,
  source_run_id TEXT,
  source_stage_id TEXT,
  source_artifact_id TEXT,

  client_message_id TEXT,
  idempotency_key TEXT,

  created_at TEXT NOT NULL,
  finalized_at TEXT,
  edited_at TEXT,
  deleted_at TEXT,

  version INTEGER NOT NULL,

  UNIQUE(conversation_id, sequence),
  UNIQUE(conversation_id, client_message_id)
);
```

---

## 61. Message Block

```sql
CREATE TABLE message_blocks (
  id TEXT PRIMARY KEY,

  message_id TEXT NOT NULL,

  position INTEGER NOT NULL,

  type TEXT NOT NULL,

  content_json TEXT NOT NULL,
  content_text TEXT,

  status TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL,

  UNIQUE(message_id, position)
);
```

---

## 62. Message Revision

```sql
CREATE TABLE message_revisions (
  id TEXT PRIMARY KEY,

  message_id TEXT NOT NULL,

  revision INTEGER NOT NULL,

  blocks_snapshot_json TEXT NOT NULL,

  edit_reason TEXT,
  edited_by TEXT NOT NULL,

  created_at TEXT NOT NULL,

  UNIQUE(message_id, revision)
);
```

---

## 63. Message Attachment

```sql
CREATE TABLE message_attachments (
  id TEXT PRIMARY KEY,

  message_id TEXT NOT NULL,

  artifact_id TEXT,
  file_reference_id TEXT,

  type TEXT NOT NULL,

  name TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,

  sensitivity TEXT NOT NULL,

  created_at TEXT NOT NULL
);
```

---

## 64. Message Reference

```sql
CREATE TABLE message_references (
  id TEXT PRIMARY KEY,

  message_id TEXT NOT NULL,

  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,

  display_snapshot TEXT,

  created_at TEXT NOT NULL
);
```

---

## 65. Message Mention

```sql
CREATE TABLE message_mentions (
  id TEXT PRIMARY KEY,

  message_id TEXT NOT NULL,

  target_type TEXT NOT NULL,
  target_id TEXT,

  start_offset INTEGER,
  end_offset INTEGER,

  resolved INTEGER NOT NULL,

  created_at TEXT NOT NULL
);
```

---

## 66. Agent Turn

```sql
CREATE TABLE agent_turns (
  id TEXT PRIMARY KEY,

  conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,

  agent_id TEXT NOT NULL,

  orchestrator_turn_id TEXT,

  task_id TEXT,
  run_id TEXT,
  provider_session_id TEXT,

  status TEXT NOT NULL,
  trigger TEXT NOT NULL,

  reply_message_id TEXT,

  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,

  version INTEGER NOT NULL
);
```

---

## 67. Orchestrator Turn

```sql
CREATE TABLE orchestrator_turns (
  id TEXT PRIMARY KEY,

  conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,

  orchestrator_agent_id TEXT,

  selected_agent_ids_json TEXT NOT NULL,

  mode TEXT NOT NULL,
  rationale_summary TEXT,

  status TEXT NOT NULL,

  reply_budget_json TEXT NOT NULL,

  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

---

## 68. Conversation Summary

```sql
CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,

  conversation_id TEXT NOT NULL,

  from_sequence INTEGER NOT NULL,
  to_sequence INTEGER NOT NULL,

  summary TEXT NOT NULL,

  decisions_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  open_questions_json TEXT NOT NULL,

  task_references_json TEXT NOT NULL,
  run_references_json TEXT NOT NULL,
  source_message_ids_json TEXT NOT NULL,

  generated_at TEXT NOT NULL,

  supersedes_summary_id TEXT,

  version INTEGER NOT NULL
);
```

---

## 69. Read State

```sql
CREATE TABLE conversation_read_states (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  last_read_message_sequence INTEGER NOT NULL,
  last_read_message_id TEXT,
  last_read_at TEXT NOT NULL,

  unread_count INTEGER NOT NULL,
  mention_count INTEGER NOT NULL,
  approval_count INTEGER NOT NULL,

  PRIMARY KEY(conversation_id, user_id)
);
```

---

## 70. Conversation Projection

```sql
CREATE TABLE conversation_projections (
  id TEXT PRIMARY KEY,

  projector_id TEXT NOT NULL,

  source_event_id TEXT NOT NULL,

  projection_type TEXT NOT NULL,

  conversation_id TEXT NOT NULL,

  message_id TEXT,

  created_at TEXT NOT NULL,

  UNIQUE(projector_id, source_event_id, projection_type)
);
```

---

# Part XIV — Artifact Data Model

## 71. Artifact

```ts
interface Artifact {
  id: string;

  workspaceId: string;

  taskId?: string;

  runId?: string;

  stageId?: string;

  providerSessionId?: string;

  processId?: string;

  worktreeId?: string;

  conversationId?: string;

  messageId?: string;

  type: string;

  name: string;

  description?: string;

  storageUri: string;

  mimeType?: string;

  sizeBytes?: number;

  checksum?: string;

  sensitivity:
    | 'normal'
    | 'restricted'
    | 'secret';

  status:
    | 'creating'
    | 'finalized'
    | 'failed'
    | 'deleted';

  immutable: boolean;

  retentionPolicyId?: string;

  createdBy: string;

  createdAt: string;
  finalizedAt?: string;
  deletedAt?: string;

  version: number;
}
```

---

## 72. Artifact Schema

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,

  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  stage_id TEXT,
  provider_session_id TEXT,
  process_id TEXT,
  worktree_id TEXT,
  conversation_id TEXT,
  message_id TEXT,

  type TEXT NOT NULL,

  name TEXT NOT NULL,
  description TEXT,

  storage_uri TEXT NOT NULL,

  mime_type TEXT,
  size_bytes INTEGER,
  checksum TEXT,

  sensitivity TEXT NOT NULL,
  status TEXT NOT NULL,

  immutable INTEGER NOT NULL,

  retention_policy_id TEXT,

  created_by TEXT NOT NULL,

  created_at TEXT NOT NULL,
  finalized_at TEXT,
  deleted_at TEXT,

  version INTEGER NOT NULL
);
```

---

## 73. Artifact Reference

```sql
CREATE TABLE artifact_references (
  id TEXT PRIMARY KEY,

  artifact_id TEXT NOT NULL,

  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,

  relation TEXT NOT NULL,

  created_at TEXT NOT NULL,

  UNIQUE(artifact_id, reference_type, reference_id, relation)
);
```

适合：

- Run Result；
- Stage Output；
- Message Attachment；
- Memory Source；
- Approval Evidence；
- Debug Bundle。

---

## 74. Artifact Version

Artifact 内容需要版本化时：

```sql
CREATE TABLE artifact_versions (
  id TEXT PRIMARY KEY,

  artifact_id TEXT NOT NULL,

  version_number INTEGER NOT NULL,

  storage_uri TEXT NOT NULL,
  size_bytes INTEGER,
  checksum TEXT NOT NULL,

  created_at TEXT NOT NULL,

  UNIQUE(artifact_id, version_number)
);
```

---

# Part XV — Extension Data Model

## 75. Extension

```sql
CREATE TABLE extensions (
  id TEXT PRIMARY KEY,

  name TEXT NOT NULL,
  description TEXT,

  trust_level TEXT NOT NULL,

  status TEXT NOT NULL,

  current_version_id TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,

  version INTEGER NOT NULL
);
```

---

## 76. Extension Version

```sql
CREATE TABLE extension_versions (
  id TEXT PRIMARY KEY,

  extension_id TEXT NOT NULL,

  semantic_version TEXT NOT NULL,

  manifest_json TEXT NOT NULL,
  permission_manifest_json TEXT NOT NULL,

  package_artifact_id TEXT,

  checksum TEXT,

  created_at TEXT NOT NULL,

  UNIQUE(extension_id, semantic_version)
);
```

---

## 77. Extension Installation

```sql
CREATE TABLE extension_installations (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,

  extension_id TEXT NOT NULL,
  extension_version_id TEXT NOT NULL,

  status TEXT NOT NULL,

  installed_by TEXT NOT NULL,

  installed_at TEXT NOT NULL,
  enabled_at TEXT,
  disabled_at TEXT,
  uninstalled_at TEXT,

  version INTEGER NOT NULL
);
```

---

# Part XV.B — UI Preferences Data Model

## 78. Design Principle

UI Preferences 属于稳定偏好，进入 AgentOS 主 Runtime 数据库。

以下 UI 状态不进入主数据库，只存在于客户端本地存储：

- Hover、Focus、Scroll 位置
- 拖拽状态、动画状态、Pointer 速度
- 临时选中、打开的 Popover
- 未发送 Draft 内容（建议 IndexedDB 或 LocalStorage）
- Windows 位置（属于 Future Tauri 本地存储）

## 79. User UI Preferences

```sql
CREATE TABLE user_ui_preferences (
  user_id TEXT PRIMARY KEY,

  appearance TEXT NOT NULL,
  accent TEXT,
  density TEXT NOT NULL,

  reduced_motion_override TEXT,
  reduced_transparency_override TEXT,
  contrast_override TEXT,

  notification_preferences_json TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL
);
```

### 79.1 Fields

- `appearance`：`'system' | 'light' | 'dark'`
- `accent`：可选强调色
- `density`：`'comfortable' | 'compact'`
- `reduced_motion_override`、`reduced_transparency_override`、`contrast_override`：覆盖系统设置
- `notification_preferences_json`：通知偏好 JSON

## 80. Workspace UI Preferences

```sql
CREATE TABLE workspace_ui_preferences (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  default_area TEXT,
  default_conversation_id TEXT,

  sidebar_width INTEGER,
  inspector_width INTEGER,

  sidebar_collapsed INTEGER NOT NULL,
  inspector_default_open INTEGER NOT NULL,

  saved_filters_json TEXT,

  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL,

  PRIMARY KEY(workspace_id, user_id)
);
```

### 80.1 Fields

- `default_area`：默认打开区域
- `sidebar_width`：Context Sidebar 宽度（px）
- `inspector_width`：Inspector 宽度（px）
- `sidebar_collapsed`：Sidebar 是否折叠
- `inspector_default_open`：Inspector 默认是否打开
- `saved_filters_json`：已保存的运行时过滤条件

---

# Part XVI — System Data Model

## 78. Schema Migration

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,

  name TEXT NOT NULL,

  checksum TEXT NOT NULL,

  applied_at TEXT NOT NULL,

  execution_time_ms INTEGER NOT NULL
);
```

---

## 79. Outbox

用于 Persist then Publish：

```sql
CREATE TABLE outbox_messages (
  id TEXT PRIMARY KEY,

  topic TEXT NOT NULL,

  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,

  payload_json TEXT NOT NULL,

  status TEXT NOT NULL,

  attempts INTEGER NOT NULL DEFAULT 0,

  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  last_error TEXT
);
```

### 79.1 Outbox Pattern

业务事务中：

```text
Update Aggregate
+ Insert Runtime Event
+ Insert Outbox Message
```

同一事务提交。

Event Bus Worker 再发布。

---

## 80. Dead Letter

```sql
CREATE TABLE dead_letters (
  id TEXT PRIMARY KEY,

  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,

  subscriber_id TEXT NOT NULL,

  payload_json TEXT NOT NULL,

  error_code TEXT,
  error_message TEXT NOT NULL,

  attempts INTEGER NOT NULL,

  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,

  retryable INTEGER NOT NULL,

  resolved_at TEXT,
  resolved_by TEXT
);
```

---

## 81. Runtime Lock

```sql
CREATE TABLE runtime_locks (
  lock_key TEXT PRIMARY KEY,

  owner_id TEXT NOT NULL,

  acquired_at TEXT NOT NULL,
  expires_at TEXT,

  fencing_token INTEGER NOT NULL,

  metadata_json TEXT
);
```

用途：

- Branch Merge Lock；
- Worktree Cleanup Lock；
- Scheduler Lock；
- Recovery Lock；
- Projection Lock。

---

## 82. Scheduler Job

```sql
CREATE TABLE scheduler_jobs (
  id TEXT PRIMARY KEY,

  job_type TEXT NOT NULL,

  aggregate_type TEXT,
  aggregate_id TEXT,

  payload_json TEXT NOT NULL,

  status TEXT NOT NULL,

  scheduled_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,

  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,

  last_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

---

## 83. Audit Record

```sql
CREATE TABLE audit_records (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,
  task_id TEXT,
  run_id TEXT,

  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,

  action_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,

  result TEXT NOT NULL,

  summary TEXT NOT NULL,

  metadata_json TEXT,

  created_at TEXT NOT NULL
);
```

---

# Part XVII — Foreign Keys and Referential Integrity

## 84. Foreign Key Policy

SQLite 必须启用：

```sql
PRAGMA foreign_keys = ON;
```

### 84.1 Recommended Foreign Keys

应建立：

- Task → Workspace；
- Run → Task / Workspace；
- Stage → Run；
- ProviderSession → Run / Stage / ProviderConfig；
- Process → Run；
- Worktree → Run；
- MemoryContext → Run；
- Approval → PolicyDecision；
- Message → Conversation；
- AgentTurn → Conversation / Message / Agent；
- Artifact → Workspace；
- RuntimeEvent → Run。

---

## 85. Delete Behavior

推荐：

### RESTRICT

- Workspace with active Run；
- Provider Configuration referenced by active Run；
- Workflow Definition referenced by active Task；
- Policy Profile referenced by active Run。

### SET NULL

- Optional default references；
- Archived Agent；
- Deleted Message Attachment display metadata。

### CASCADE

只适合内部组成对象：

- Message → Message Blocks；
- Conversation → Read State，软删除时不实际 Cascade；
- Workflow Definition → Stage Definition，在未被引用且物理删除时；
- Memory Context → Context Entries。

---

## 86. Deferred Foreign Keys

复杂创建顺序可以使用：

```sql
DEFERRABLE INITIALLY DEFERRED
```

但应谨慎，SQLite 支持有限。

---

# Part XVIII — Index Strategy

## 87. Core Indexes

### Workspace

```sql
CREATE INDEX idx_workspaces_status
ON workspaces(status);
```

### Agent

```sql
CREATE INDEX idx_agents_workspace_status
ON agent_profiles(workspace_id, status);
```

### Provider

```sql
CREATE INDEX idx_provider_config_workspace
ON provider_configurations(workspace_id, enabled);

CREATE INDEX idx_provider_session_run
ON provider_sessions(run_id, status);
```

### Task

```sql
CREATE INDEX idx_tasks_workspace_status
ON tasks(workspace_id, status, updated_at);

CREATE INDEX idx_tasks_source_conversation
ON tasks(source_conversation_id);
```

### Run

```sql
CREATE INDEX idx_runs_task
ON runs(task_id, created_at);

CREATE INDEX idx_runs_workspace_status
ON runs(workspace_id, status, created_at);

CREATE INDEX idx_runs_root
ON runs(root_run_id);
```

### Stage

```sql
CREATE INDEX idx_run_stages_run
ON run_stages(run_id, sequence, attempt);

CREATE INDEX idx_run_stages_status
ON run_stages(status, updated_at);
```

### Event

```sql
CREATE INDEX idx_runtime_events_run_sequence
ON runtime_events(run_id, sequence);

CREATE INDEX idx_runtime_events_type_time
ON runtime_events(type, timestamp);

CREATE INDEX idx_runtime_events_stage_sequence
ON runtime_events(stage_id, sequence);

CREATE INDEX idx_runtime_events_correlation
ON runtime_events(correlation_id);
```

### Process

```sql
CREATE INDEX idx_runtime_processes_run
ON runtime_processes(run_id);

CREATE INDEX idx_runtime_processes_status
ON runtime_processes(status);

CREATE INDEX idx_runtime_processes_native_pid
ON runtime_processes(native_pid);
```

### Worktree

```sql
CREATE INDEX idx_worktrees_run
ON worktrees(run_id);

CREATE INDEX idx_worktrees_status
ON worktrees(status);

CREATE INDEX idx_worktree_merges_target
ON worktree_merges(target_branch, status);
```

### Memory

```sql
CREATE INDEX idx_memory_scope_status
ON memory_entries(scope, status);

CREATE INDEX idx_memory_workspace
ON memory_entries(workspace_id);

CREATE INDEX idx_memory_agent
ON memory_entries(agent_id);

CREATE INDEX idx_memory_content_hash
ON memory_entries(content_hash);
```

### Policy

```sql
CREATE INDEX idx_policy_decisions_run
ON policy_decisions(run_id, created_at);

CREATE INDEX idx_approval_requests_status
ON approval_requests(status, created_at);

CREATE INDEX idx_policy_grants_run
ON policy_grants(run_id, stage_id);
```

### Conversation

```sql
CREATE INDEX idx_conversations_workspace_status
ON conversations(workspace_id, status, last_message_at);

CREATE INDEX idx_messages_conversation_sequence
ON messages(conversation_id, sequence);

CREATE INDEX idx_messages_source_run
ON messages(source_run_id);

CREATE INDEX idx_turns_conversation_status
ON agent_turns(conversation_id, status);
```

### Artifact

```sql
CREATE INDEX idx_artifacts_run
ON artifacts(run_id, type);

CREATE INDEX idx_artifacts_workspace
ON artifacts(workspace_id, status);

CREATE INDEX idx_artifact_references_target
ON artifact_references(reference_type, reference_id);
```

---

## 88. Partial Indexes

SQLite 支持 Partial Index。

示例：

```sql
CREATE INDEX idx_active_runs
ON runs(workspace_id, updated_at)
WHERE status IN (
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'paused'
);
```

```sql
CREATE INDEX idx_pending_approvals
ON approval_requests(run_id, created_at)
WHERE status = 'pending';
```

```sql
CREATE INDEX idx_active_memory
ON memory_entries(workspace_id, scope, category)
WHERE status = 'active' AND deleted_at IS NULL;
```

---

# Part XIX — FTS Models

## 89. Memory FTS

```sql
CREATE VIRTUAL TABLE memory_entries_fts USING fts5(
  memory_id UNINDEXED,
  title,
  content,
  summary,
  tags,
  category,
  scope,
  tokenize = 'unicode61'
);
```

---

## 90. Message FTS

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  message_id UNINDEXED,
  conversation_id UNINDEXED,
  sender_display_name,
  content_text,
  task_text,
  run_text,
  tokenize = 'unicode61'
);
```

---

## 91. Artifact FTS

只对可安全索引的文本 Artifact：

```sql
CREATE VIRTUAL TABLE artifact_text_fts USING fts5(
  artifact_id UNINDEXED,
  workspace_id UNINDEXED,
  name,
  text_content,
  tags,
  tokenize = 'unicode61'
);
```

Restricted 和 Secret 默认不进入普通 FTS。

---

# Part XX — Snapshot Data Model

## 92. Generic Snapshot Table

为了减少独立 Snapshot 表，也可以引入统一表：

```sql
CREATE TABLE entity_snapshots (
  id TEXT PRIMARY KEY,

  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,

  snapshot_type TEXT NOT NULL,

  snapshot_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,

  created_at TEXT NOT NULL,

  UNIQUE(entity_type, entity_id, entity_version, snapshot_type)
);
```

### 92.1 Suitable Types

- Agent；
- Provider Configuration；
- Workflow；
- Policy；
- Isolation Plan；
- Output Contract。

### 92.2 Dedicated vs Generic

推荐：

- Policy Snapshot 使用独立表；
- Memory Context 使用独立表；
- 其他配置 Snapshot 可以使用 Generic Snapshot。

---

## 93. Run Snapshot References

Run 或 Stage 应保存 Snapshot ID，而不是只保存当前配置 ID。

```text
run.workflow_snapshot_id
run.policy_snapshot_id
stage.agent_snapshot_id
stage.provider_snapshot_id
```

---

# Part XXI — Transaction Boundaries

## 94. Workspace Aggregate

事务：

- Create Workspace；
- Set Defaults；
- Archive Workspace；
- Update Settings。

不应与 Run 创建放在同一大事务。

---

## 95. Task Aggregate

事务：

- Create Task；
- Update Task Status；
- Accept Run；
- Reopen Task。

---

## 96. Run Aggregate

事务：

- Create Run + Initial Stages；
- Status Transition；
- Allocate Event Sequence；
- Terminal Transition；
- Cancellation Request；
- Checkpoint。

---

## 97. Conversation Aggregate

事务：

- Allocate Message Sequence；
- Create Message + Blocks；
- Update lastMessage；
- Read State；
- Projection Insert。

---

## 98. Approval Aggregate

事务：

- Policy Decision；
- Approval Request；
- Approval Resolve；
- Grant Create；
- Run Status transition to/from waiting_approval。

跨 Run 状态可使用 Saga，避免锁住过多表。

---

## 99. Worktree Aggregate

事务：

- Reservation；
- Ownership；
- Status；
- Merge Record；
- Cleanup Record。

Git 操作本身无法加入数据库事务，使用 Saga。

---

## 100. Artifact Aggregate

事务：

- Metadata Create；
- Storage Write；
- Finalize；
- Reference Create。

文件系统和数据库使用 Saga。

---

# Part XXII — Sagas and Compensation

## 101. Process Spawn Saga

```text
Create RuntimeProcess reservation
  ↓
Spawn OS process
  ├── success → update PID
  └── failure → mark failed
```

Spawn 成功、DB 更新失败：

- 终止进程；
- 记录 Recovery。

---

## 102. Worktree Create Saga

```text
Reserve path and branch
  ↓
Create branch
  ↓
Create worktree
  ↓
Verify
  ↓
Activate
```

失败按阶段补偿。

---

## 103. Artifact Write Saga

```text
Create metadata(status=creating)
  ↓
Write temporary file
  ↓
Checksum
  ↓
Atomic rename
  ↓
Finalize metadata
```

---

## 104. Event Publish Saga

```text
Update aggregate
+ Insert runtime_event
+ Insert outbox
  ↓
Commit
  ↓
Outbox publisher
  ↓
Event Bus
```

---

## 105. Conversation Projection Saga

```text
Consume Runtime Event
  ↓
Create projection record
  ↓
Create / update message
  ↓
Commit
```

唯一约束避免重复。

---

# Part XXIII — Idempotency

## 106. Idempotency Keys

需要 Idempotency 的操作：

- Create Run；
- Send Message；
- Create Worktree；
- Start Process；
- Create Approval；
- Resolve Approval；
- Merge；
- Artifact Create；
- Projection；
- Memory Candidate Accept。

---

## 107. Generic Idempotency Table

```sql
CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,

  request_hash TEXT NOT NULL,

  status TEXT NOT NULL,

  response_json TEXT,

  aggregate_type TEXT,
  aggregate_id TEXT,

  created_at TEXT NOT NULL,
  expires_at TEXT,

  PRIMARY KEY(scope, key)
);
```

### 107.1 Request Hash

相同 Key 但不同 Request：

```text
IDEMPOTENCY_KEY_REUSED
```

---

# Part XXIV — Optimistic Concurrency

## 108. Update Pattern

```sql
UPDATE runs
SET
  status = ?,
  version = version + 1,
  updated_at = ?
WHERE id = ?
  AND version = ?;
```

受影响行数为 0：

```text
VERSION_CONFLICT
```

---

## 109. Terminal Transition

必须检查：

```text
current status is non-terminal
expected version matches
```

防止：

- Run Completed 与 Cancel 冲突；
- Process Exit 与 Timeout 冲突；
- Approval Approve 与 Reject 冲突；
- Merge 与 Cleanup 冲突。

---

# Part XXV — Query Models and Views

## 110. Active Run View

```sql
CREATE VIEW active_runs_view AS
SELECT
  r.*,
  t.title AS task_title,
  w.name AS workspace_name
FROM runs r
JOIN tasks t ON t.id = r.task_id
JOIN workspaces w ON w.id = r.workspace_id
WHERE r.status IN (
  'queued',
  'starting',
  'running',
  'waiting_approval',
  'paused'
);
```

---

## 111. Run Inspector View

推荐应用层聚合：

- Run；
- Task；
- Stage；
- Provider Session；
- Process；
- Worktree；
- Memory Context；
- Policy Snapshot；
- Approval；
- Artifact；
- Runtime Event。

不建议使用一个超大 SQL View。

---

## 112. Conversation List View

```sql
CREATE VIEW conversation_list_view AS
SELECT
  c.id,
  c.workspace_id,
  c.type,
  c.title,
  c.status,
  c.last_message_id,
  c.last_message_at
FROM conversations c
WHERE c.deleted_at IS NULL;
```

Unread 通过 Read State 聚合。

---

## 113. Agent History Query

按 Agent ID 查询：

- Conversation Membership；
- Message；
- Agent Turn；
- Run Stage；
- Provider Session；
- Artifact；
- Memory；
- Failure。

---

## 114. Approval Queue View

```sql
CREATE VIEW pending_approvals_view AS
SELECT
  a.*,
  r.status AS run_status,
  t.title AS task_title
FROM approval_requests a
JOIN runs r ON r.id = a.run_id
LEFT JOIN tasks t ON t.id = a.task_id
WHERE a.status = 'pending';
```

---

# Part XXVI — Retention and Archival

## 115. Retention Categories

### Permanent by Default

- Task；
- Run Terminal Summary；
- Runtime Terminal Event；
- Approval；
- Policy Deny；
- Merge；
- Memory；
- Final Artifact Metadata；
- Final Message。

### Time-limited

- Process Usage Sample；
- Streaming Delta；
- Heartbeat；
- Debug Event；
- Raw Output；
- Presence；
- Typing；
- Cache；
- Outbox Published Record。

---

## 116. Retention Policy Table

```sql
CREATE TABLE retention_policies (
  id TEXT PRIMARY KEY,

  workspace_id TEXT,

  name TEXT NOT NULL,

  entity_type TEXT NOT NULL,

  retention_days INTEGER,

  archive_before_delete INTEGER NOT NULL,

  hard_delete INTEGER NOT NULL,

  conditions_json TEXT,

  enabled INTEGER NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL
);
```

---

## 117. Archive Metadata

归档不一定移动数据库行。

可以：

- status = archived；
- archived_at；
- cold_storage_artifact_id；
- projection hidden。

---

# Part XXVII — Security and Privacy

## 118. Sensitive Columns

需要 Restricted 访问：

- executable；
- cwd；
- rootPath；
- canonicalPath；
- Provider nativeSessionId；
- Raw Error；
- Imported Message；
- Restricted Artifact；
- Memory Content。

---

## 119. Secret Exclusion

以下字段禁止出现 Secret Value：

- environment_profiles.values_json；
- provider_configurations；
- runtime_events.payload_json；
- policy_decisions；
- messages；
- memory_entries；
- artifacts metadata；
- audit_records；
- debug bundle metadata。

---

## 120. Encryption

Foundation 可以不要求整库加密，但应预留：

- SQLCipher；
- OS Keychain；
- Encrypted Secret Store；
- Per-artifact encryption；
- Restricted Column encryption。

---

## 121. Data Export

Export 必须：

- Sensitivity Filter；
- Secret Scan；
- User Confirmation；
- Audit；
- Artifact Reference；
- Deleted Content Policy。

---

# Part XXVIII — SQLite Configuration

## 122. Required PRAGMA

推荐：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
```

### 122.1 WAL

WAL 适合：

- 多读单写；
- 长期 Run；
- UI 查询；
- Event Append。

### 122.2 Busy Timeout

减少短暂锁冲突。

---

## 123. Connection Model

推荐：

- 一个 Write Queue；
- 多个 Read Connection；
- Transaction Boundary 明确；
- 不在 UI Request 中持有长事务；
- 不在 Provider 执行期间持有事务。

---

## 124. Vacuum

使用：

```sql
PRAGMA auto_vacuum = INCREMENTAL;
```

定期：

```sql
PRAGMA incremental_vacuum;
```

不在活跃 Run 高峰执行 Full VACUUM。

---

# Part XXIX — PostgreSQL Compatibility

## 125. Compatibility Goals

虽然 Foundation 使用 SQLite，但应避免：

- SQLite-only Business Logic；
- 依赖 RowID；
- 依赖弱类型；
- 大量动态 ALTER；
- 隐式布尔；
- 非标准日期函数。

---

## 126. Type Mapping

```text
SQLite TEXT
  → PostgreSQL text / varchar

SQLite INTEGER boolean
  → PostgreSQL boolean

JSON TEXT
  → PostgreSQL jsonb

ULID TEXT
  → text / uuid-like type

Timestamp TEXT
  → timestamptz
```

---

## 127. Future Migration

如果未来使用 PostgreSQL：

- Event Store；
- Queue；
- Multi-user；
- Remote Runtime；
- Horizontal Worker；

可逐步迁移。

本地单用户继续使用 SQLite。

---

# Part XXX — Migration System

## 128. Migration File Naming

```text
0001_initial.sql
0002_provider_runtime.sql
0003_process_runtime.sql
0004_worktree_runtime.sql
...
```

---

## 129. Migration Rules

每个 Migration 必须：

- 唯一版本；
- 不可修改已发布内容；
- 有 Checksum；
- 可重复检测；
- 有 Backup 建议；
- 有回滚说明；
- 测试升级路径。

---

## 130. Forward-only Preferred

生产数据库优先 Forward-only Migration。

复杂回滚通过：

- Backup Restore；
- New Migration；
- Data Repair。

---

## 131. Online Migration

Foundation 本地应用可在启动时迁移。

要求：

- 获取 Migration Lock；
- Backup；
- 显示进度；
- 失败不启动 Runtime；
- 不在 Run Active 时执行破坏性迁移。

---

## 132. Data Migration Jobs

大规模转换使用 Scheduler Job：

- v1 Task JSON；
- v1 Markdown Memory；
- Old Event；
- Artifact Metadata；
- Conversation Projection。

---

# Part XXXI — v1 Migration

## 133. Current v1 Data Model

当前 v1 主要依赖：

- JSON 文件；
- 固定配置；
- Task.outputs；
- Markdown；
- Runtime 内存；
- SSE；
- CLI 日志。

问题：

- Task 与 Run 混合；
- Stage 固定；
- Agent 与 Provider 混合；
- Process 不持久；
- Event 不持久；
- Conversation 不存在；
- Worktree 不存在；
- Memory 无结构化；
- Approval 无实体；
- Artifact 只是路径；
- 无版本控制；
- 无关系约束；
- 无恢复模型。

---

## 134. Migration Target

```text
v1 JSON / Markdown / Logs
  ↓
Migration Inventory
  ↓
Canonical Entity Mapping
  ↓
SQLite Transactions
  ↓
Validation
  ↓
Compatibility Read
  ↓
Canonical Runtime Only
```

---

## 135. Legacy Task Mapping

v1 Task：

```text
Task
+ status
+ outputs
```

迁移为：

```text
Task
└── Run
    ├── RunStage
    ├── RuntimeEvent
    ├── Artifact
    └── Result Summary
```

---

## 136. Legacy Agent Mapping

v1：

```text
role + cliCommand + model
```

迁移：

```text
AgentProfile
ProviderConfiguration
AgentProviderBinding
```

---

## 137. Legacy Output Mapping

旧 Stage Output：

- 小文本 → Artifact；
- 状态 → Runtime Event；
- 最终结果 → Run Result；
- 日志 → Raw Output Artifact；
- UI 输出 → Conversation Projection。

---

## 138. Legacy Memory Mapping

Markdown：

```text
parse
→ candidate
→ classify
→ deduplicate
→ memory entry
```

---

## 139. Legacy History Mapping

没有 Conversation 的旧 Task：

- 创建 Task Conversation；
- 用户需求作为 User Message；
- Stage Summary 作为 System / Agent Message；
- Final Result 作为 Result Message。

---

## 140. Migration Idempotency

每个旧对象记录：

```sql
CREATE TABLE legacy_migration_map (
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  migrated_at TEXT NOT NULL,
  PRIMARY KEY(source_type, source_id, target_type)
);
```

---

# Part XXXII — Backup and Recovery

## 141. Backup Scope

Backup 包含：

- SQLite；
- Artifact Metadata；
- Artifact Files；
- Worktree Metadata；
- Policy；
- Memory；
- Conversation；
- Extension Metadata；
- Secret Store separately。

---

## 142. Consistent Backup

推荐：

- SQLite Backup API；
- WAL Checkpoint；
- Artifact Manifest；
- Checksum；
- Version Manifest。

---

## 143. Restore

Restore 后必须运行：

- Schema Check；
- Foreign Key Check；
- Artifact Check；
- Active Run Recovery；
- Process Recovery；
- Worktree Recovery；
- Projection Recovery；
- FTS Rebuild；
- Outbox Recovery。

---

## 144. Integrity Checks

启动或维护时：

```sql
PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

并检查：

- Event Sequence；
- Missing Artifact；
- Missing Worktree；
- Active Process；
- Pending Approval；
- Message Projection；
- Snapshot Reference。

---

# Part XXXIII — Testing

## 145. Schema Tests

必须覆盖：

- Migration from empty DB；
- Migration from every supported version；
- Foreign Keys；
- Unique Constraints；
- Partial Index；
- FTS；
- WAL；
- Snapshot；
- Soft Delete；
- Retention；
- Backup / Restore。

---

## 146. Aggregate Tests

### Run

- Create；
- Stage；
- Event Sequence；
- Terminal Transition；
- Retry Link。

### Conversation

- Message Sequence；
- Client Idempotency；
- Revision；
- Projection。

### Approval

- Create；
- Resolve；
- Grant；
- Version Conflict。

### Worktree

- Reservation；
- Owner；
- Merge；
- Cleanup。

### Memory

- Candidate；
- Active；
- Conflict；
- Context Snapshot。

---

## 147. Concurrency Tests

必须覆盖：

- Two Event Writers same Run；
- Two Message Writers same Conversation；
- Approve vs Reject；
- Complete vs Cancel；
- Merge vs Cleanup；
- Process Exit vs Timeout；
- Memory Update Conflict；
- Provider Config Update while Run Snapshot exists。

---

## 148. Recovery Tests

- Server crash after Process Spawn before DB Update；
- Server crash during Worktree Create；
- Server crash after Event Persist before Publish；
- Server crash during Streaming Message；
- Server crash after Approval Decision before Run Resume；
- Server crash during Artifact Finalize；
- Outbox Replay；
- Projection Replay。

---

## 149. Data Migration Tests

- v1 Task；
- v1 Agent；
- v1 Memory Markdown；
- v1 Log；
- Duplicate；
- Corrupt JSON；
- Partial Migration；
- Restart Migration；
- Idempotent Retry。

---

## 150. Performance Tests

基准：

- 100k Runtime Events；
- 100k Messages；
- 10k Memory Entries；
- 1k Conversations；
- 10k Artifacts；
- Concurrent 20 Runs；
- FTS Query；
- Timeline Query；
- Inspector Query；
- Backup。

---

# Part XXXIV — Operational Metrics

## 151. Database Metrics

监控：

- DB Size；
- WAL Size；
- Write Latency；
- Read Latency；
- Busy Timeout Count；
- Transaction Retry；
- Migration Duration；
- Foreign Key Failure；
- Outbox Lag；
- Dead Letter Count；
- FTS Size；
- Backup Duration；
- Integrity Check Result。

---

## 152. Table Growth Metrics

重点：

- runtime_events；
- messages；
- process_usage_samples；
- artifacts；
- memory_entries；
- outbox_messages；
- dead_letters。

---

# Part XXXV — Implementation Structure

## 153. Recommended Package

```text
packages/storage/
├── src/
│   ├── database.ts
│   ├── connection-manager.ts
│   ├── transaction.ts
│   ├── migrations/
│   ├── schema/
│   ├── repositories/
│   │   ├── workspace-repository.ts
│   │   ├── agent-repository.ts
│   │   ├── provider-repository.ts
│   │   ├── workflow-repository.ts
│   │   ├── task-repository.ts
│   │   ├── run-repository.ts
│   │   ├── event-repository.ts
│   │   ├── process-repository.ts
│   │   ├── worktree-repository.ts
│   │   ├── memory-repository.ts
│   │   ├── policy-repository.ts
│   │   ├── conversation-repository.ts
│   │   └── artifact-repository.ts
│   ├── outbox/
│   ├── locks/
│   ├── retention/
│   ├── backup/
│   ├── integrity/
│   ├── errors.ts
│   └── testing/
└── package.json
```

---

## 154. Repository Rule

每个 Repository：

- 只操作一个 Aggregate 或紧密关系；
- 不包含业务流程；
- 不调用 Provider；
- 不调用 Process；
- 不发送 UI Message；
- 不直接 Publish Event；
- 可以在上层 Transaction Context 中工作。

---

## 155. Unit of Work

可以实现：

```ts
interface UnitOfWork {
  transaction<T>(
    operation: (
      tx: TransactionContext
    ) => Promise<T>
  ): Promise<T>;
}
```

---

# Part XXXVI — Error Model

## 156. Storage Error

```ts
interface StorageRuntimeError {
  code: StorageErrorCode;

  message: string;

  phase:
    | 'connection'
    | 'migration'
    | 'transaction'
    | 'query'
    | 'constraint'
    | 'serialization'
    | 'snapshot'
    | 'outbox'
    | 'backup'
    | 'restore'
    | 'integrity'
    | 'retention';

  entityType?: string;

  entityId?: string;

  retryable: boolean;

  suggestedAction?: string;

  details?: Record<string, unknown>;
}
```

---

## 157. Error Codes

```ts
type StorageErrorCode =
  | 'STORAGE_CONNECTION_FAILED'
  | 'STORAGE_BUSY'
  | 'STORAGE_TRANSACTION_FAILED'
  | 'STORAGE_CONSTRAINT_VIOLATION'
  | 'STORAGE_FOREIGN_KEY_VIOLATION'
  | 'STORAGE_UNIQUE_VIOLATION'
  | 'STORAGE_VERSION_CONFLICT'
  | 'STORAGE_ENTITY_NOT_FOUND'
  | 'STORAGE_SERIALIZATION_FAILED'
  | 'STORAGE_MIGRATION_FAILED'
  | 'STORAGE_MIGRATION_CHECKSUM_MISMATCH'
  | 'STORAGE_SNAPSHOT_FAILED'
  | 'STORAGE_OUTBOX_FAILED'
  | 'STORAGE_BACKUP_FAILED'
  | 'STORAGE_RESTORE_FAILED'
  | 'STORAGE_INTEGRITY_FAILED'
  | 'STORAGE_RETENTION_FAILED'
  | 'STORAGE_FTS_FAILED'
  | 'STORAGE_UNKNOWN_ERROR';
```

---

# Part XXXVII — Implementation Phases

## 158. Phase 1 — Core Storage

- SQLite Connection；
- Migration Framework；
- Workspace；
- Agent；
- Provider；
- Task；
- Run；
- Stage；
- Runtime Event；
- Artifact；
- Repository；
- Optimistic Version；
- WAL。

---

## 159. Phase 2 — Runtime Storage

- Process；
- Worktree；
- Policy；
- Approval；
- Memory；
- Conversation；
- Outbox；
- Dead Letter；
- Locks。

---

## 160. Phase 3 — Query and Recovery

- Inspector Queries；
- FTS；
- Projection；
- Backup；
- Integrity；
- Recovery；
- Retention。

---

## 161. Phase 4 — Advanced

- PostgreSQL Adapter；
- Multi-user；
- Encryption；
- Remote Worker；
- Partition / Archive；
- Advanced Metrics。

---

# Part XXXVIII — Definition of Done

## 162. Data Model Foundation DoD

Foundation 完成必须满足：

1. SQLite 成为 v2 主持久化层。
2. Workspace、Agent、Provider、Task、Run、Stage 有独立实体。
3. Task 与 Run 完全分离。
4. Agent 与 Provider 完全分离。
5. Runtime Event Append-only。
6. 同一 Run Event Sequence 唯一。
7. Conversation 与 Message 持久化。
8. Message Sequence 唯一。
9. Process 有 Durable Record。
10. Worktree 有 Durable Record。
11. Memory Entry 和 Memory Context 持久化。
12. Policy Profile、Decision、Approval、Grant 持久化。
13. Artifact 有统一 Metadata。
14. Run 使用 Snapshot，而不是读取当前配置。
15. Optimistic Concurrency 可用。
16. Soft Delete 规则明确。
17. Foreign Key 开启。
18. 核心 Unique Constraint 完整。
19. Outbox 支持 Persist then Publish。
20. Projection 可幂等重建。
21. Runtime Lock 支持 Merge、Cleanup、Recovery。
22. v1 JSON 和 Markdown 可迁移。
23. Migration 有版本和 Checksum。
24. WAL 模式可用。
25. Backup 和 Restore 可验证。
26. Integrity Check 可运行。
27. FTS 支持 Memory 和 Conversation Search。
28. Secret Value 不进入主数据库。
29. Runtime Recovery 所需字段完整。
30. Schema、Concurrency、Recovery 和 Migration Tests 通过。

---

# Part XXXIX — Anti-Patterns

## 163. Task Contains All Runtime State

错误：

```text
Task.outputs
Task.logs
Task.currentStage
Task.providerPid
```

正确：

```text
Task
└── Run
    ├── Stage
    ├── Event
    ├── Process
    ├── Worktree
    └── Artifact
```

---

## 164. Agent Contains CLI Fields

错误：

```text
Agent:
  cliCommand
  cliArgs
  model
```

正确：

```text
AgentProfile
  ↓ binding
ProviderConfiguration
```

---

## 165. JSON File as Transaction Store

错误：

```text
read whole json
modify
write whole json
```

正确：

```text
SQLite transaction
+ version
+ constraint
```

---

## 166. Event as Mutable Log Row

错误：

```text
UPDATE runtime_events
```

正确：

```text
append correction event
```

---

## 167. Current Config for Historical Run

错误：

```text
Run reads current Agent and Provider config
```

正确：

```text
Run references immutable snapshots
```

---

## 168. Artifact Path Only

错误：

```text
task.outputPath
```

正确：

```text
Artifact metadata
+ storageUri
+ checksum
+ source references
```

---

## 169. No Outbox

错误：

```text
commit DB
then publish event
maybe process crashes
```

正确：

```text
DB update + Event + Outbox
in one transaction
```

---

## 170. Cascade Delete Runtime History

错误：

```text
delete conversation
→ delete run
```

正确：

```text
soft delete projection container
preserve runtime facts
```

---

## 171. Everything in JSON

错误：

```text
one giant metadata_json
```

正确：

```text
queryable columns
+ limited extension JSON
```

---

## 172. PID as Process Identity

错误：

```text
native_pid primary key
```

正确：

```text
AgentOS process ID
+ PID
+ start time
+ recovery token
```

---

# Part XL — Global Invariants

## 173. Data Model Invariants

AgentOS v2 必须始终满足：

1. Workspace 是所有项目对象的主边界。
2. Task 不等于 Run。
3. Run 不等于 Provider Session。
4. Provider Session 不等于 Process。
5. Conversation 不等于 Run。
6. Message 不等于 Runtime Event。
7. Agent Profile 不等于 Provider Configuration。
8. Event 是 Append-only。
9. Projection 可重建。
10. Snapshot 不可变。
11. 历史 Run 不受当前配置修改影响。
12. 同一 Run Event Sequence 唯一。
13. 同一 Conversation Message Sequence 唯一。
14. Optimistic Version 必须用于可变 Aggregate。
15. Secret Value 不进入主数据库。
16. Soft Delete 是默认删除方式。
17. Foreign Key 必须开启。
18. Unique Constraint 必须表达关键业务不变量。
19. JSON 不能替代核心关系模型。
20. Runtime Process 必须有 AgentOS ID。
21. Worktree 必须有 Owner。
22. Approval 必须属于 Policy Decision。
23. Policy Grant 必须来源于 Approval 或明确 Exception。
24. Memory Context 必须保存历史 Snapshot。
25. Artifact 必须有来源和 Checksum。
26. Conversation Projection 必须幂等。
27. Event Publish 必须使用 Outbox 或等价机制。
28. DB 与 OS / Git / File System 操作必须使用 Saga。
29. Active Run Recovery 所需数据必须持久化。
30. Browser 状态不得作为 Runtime Source of Truth。
31. FTS 只索引允许的文本。
32. Restricted 和 Secret 数据必须分级。
33. Migration 必须有版本和 Checksum。
34. Backup 必须包含数据库与 Artifact Manifest。
35. Restore 后必须执行 Integrity 和 Recovery。
36. WAL 是默认日志模式。
37. 长 Provider 执行期间不得持有数据库事务。
38. Aggregate Transaction 不应跨越整个 Workflow。
39. Terminal State Transition 必须并发安全。
40. v1 JSON / Markdown 只能作为迁移来源和兼容层。

---

# Part XLI — Final Definition

## 174. Final Definition

AgentOS v2 Data Model 定义如下：

> AgentOS v2 使用 Workspace 作为项目边界，以 Agent Profile 表达长期角色，以 Provider Configuration 表达外部执行能力，以 Workflow Definition 表达执行图，以 Task 表达持久工程意图，以 Run 表达一次执行尝试，以 Run Stage 表达工作流执行单元，以 Runtime Event 表达不可变运行事实，以 Provider Session 和 Runtime Process 表达外部运行会话和操作系统进程，以 Worktree 表达代码隔离环境，以 Memory Entry 和 Memory Context 表达长期知识和本次注入快照，以 Policy Decision、Approval Request 和 Grant 表达安全控制，以 Conversation、Message 和 Agent Turn 表达持久协作，以 Artifact 表达可引用执行产物。所有可变 Aggregate 使用版本控制，所有关键历史使用 Snapshot 或 Append-only Event，所有数据库外副作用使用 Saga，所有事件发布使用 Outbox 或等价的 Persist-then-Publish 机制。

简化模型：

```text
Workspace
├── Agent Profiles
├── Provider Configurations
├── Workflows
├── Policies
├── Conversations
├── Tasks
├── Memories
└── Artifacts

Task
└── Run
    ├── Stages
    ├── Provider Sessions
    ├── Processes
    ├── Worktrees
    ├── Memory Contexts
    ├── Policy Decisions
    ├── Runtime Events
    └── Artifacts

Conversation
├── Members
├── Messages
├── Agent Turns
└── Projections of selected runtime facts
```

核心持久化边界：

```text
Current State
  → mutable aggregate tables

Historical Fact
  → append-only runtime_events

Configuration at execution time
  → immutable snapshots

User-facing runtime view
  → rebuildable projections

Large output
  → artifact store + metadata

Cross-system side effect
  → saga + recovery record

Event delivery
  → transactional outbox
```

本文件定义的 Data Model 是 AgentOS v2 Runtime Engine、API、Inspector、Timeline、Conversation UI、Memory、Policy、Recovery 和 Extension 系统共同依赖的持久化基础。
