# AgentOS Runtime Specification v2.0

## 01 — Core Concepts

> Status: Draft  
> Version: 2.0  
> Last Updated: 2026-07-19  
> Scope: AgentOS v2 Runtime Domain Model  
> Depends On: `00-Vision.md`  
> Repository: `Zbyy0311/agentos`

---

## 1. Document Purpose

本文件定义 AgentOS v2 的核心概念、术语、领域对象、边界、关系和系统不变量。

它的目标不是描述具体实现，而是为以下工作建立统一语言：

- 数据库设计；
- TypeScript 类型设计；
- API 设计；
- Runtime 生命周期；
- Runtime Event Model；
- Provider Adapter；
- Conversation UI；
- Task / Run 工作流；
- Worktree 隔离；
- Memory；
- Artifact；
- Policy 与 Approval；
- Timeline 与 Runtime Inspector。

后续文档与代码不得随意改变本文件中核心概念的语义。

如果某个概念需要调整，应先修改本文件，再同步修改：

1. 数据模型；
2. API；
3. Runtime；
4. 前端；
5. 测试；
6. 迁移逻辑。

---

## 2. Conceptual Overview

AgentOS v2 的核心领域关系如下：

```text
User
└── Workspace
    ├── Agent Profile
    │   └── Provider Configuration
    ├── Conversation
    │   ├── Conversation Member
    │   └── Message
    │       ├── may create Task
    │       └── may reference Run / Artifact / Approval
    ├── Task
    │   └── Run
    │       ├── Run Stage
    │       │   └── Provider Session
    │       │       └── Runtime Process
    │       ├── Runtime Event
    │       ├── Worktree
    │       ├── Artifact
    │       ├── Approval Request
    │       ├── Usage Record
    │       └── Memory Context
    ├── Workflow Definition
    ├── Memory Entry
    ├── Policy Profile
    └── Extension Configuration
```

最重要的概念关系是：

```text
Agent ≠ Provider
Task ≠ Run
Run ≠ Process
Conversation ≠ Task
Message ≠ Prompt
Event ≠ Log
Artifact ≠ File
Memory ≠ Conversation History
Policy ≠ Prompt Rule
Workflow ≠ Runtime
```

---

## 3. Terminology Rules

### 3.1 Canonical Terms

代码、数据库、API 和文档应统一使用以下英文术语：

| 中文含义 | Canonical Term |
|---|---|
| 工作空间 | Workspace |
| 智能体身份 | Agent Profile |
| 提供方 | Provider |
| 提供方配置 | Provider Configuration |
| 会话 | Conversation |
| 消息 | Message |
| 任务 | Task |
| 执行尝试 | Run |
| 执行阶段 | Run Stage |
| 工作流 | Workflow Definition |
| 运行时事件 | Runtime Event |
| 提供方会话 | Provider Session |
| 运行进程 | Runtime Process |
| 工作树 | Worktree |
| 产物 | Artifact |
| 记忆条目 | Memory Entry |
| 策略 | Policy |
| 策略配置 | Policy Profile |
| 审批请求 | Approval Request |
| 使用量记录 | Usage Record |
| 扩展 | Extension |

### 3.2 Terms to Avoid

以下表述容易混淆，不应作为核心类型名称：

- Agent Instance
- Agent Task
- Execution Task
- Job
- Worker Process
- Chat Task
- Output
- Result File
- Memory File
- Permission Prompt
- Pipeline Agent
- Provider Agent

如果业务中确实需要使用这些词，必须明确它们对应的 Canonical Term。

### 3.3 ID Rules

所有持久化领域对象都必须有稳定 ID。

推荐：

```text
ws_        Workspace
agent_     Agent Profile
provider_  Provider Configuration
conv_      Conversation
msg_       Message
task_      Task
run_       Run
stage_     Run Stage
evt_       Runtime Event
session_   Provider Session
proc_      Runtime Process
wt_        Worktree
art_       Artifact
mem_       Memory Entry
policy_    Policy Profile
approval_  Approval Request
workflow_  Workflow Definition
usage_     Usage Record
ext_       Extension
```

ID 必须：

- 全局唯一；
- 不依赖数据库自增；
- 不暴露业务敏感信息；
- 可在日志、URL、事件和 Artifact 中稳定引用；
- 创建后不可改变。

---

# Part I — Actors and Environment

## 4. User

### 4.1 Definition

User 是操作 AgentOS 的真实用户或外部调用者。

在 v2 本地单用户版本中，User 可以只有一个逻辑身份，但领域模型仍应保留 `userId`，以支持未来：

- 多用户；
- 团队；
- 审批人；
- 操作审计；
- 权限区分；
- API 调用者。

### 4.2 User Owns

User 最终决定：

- 创建和删除 Workspace；
- 配置 Provider；
- 创建 Agent Profile；
- 创建 Task；
- 启动、暂停、恢复和取消 Run；
- 批准或拒绝高风险操作；
- 合并或放弃 Worktree；
- 删除或保留 Artifact；
- 修改 Policy；
- 是否启用不安全模式。

### 4.3 User Is Not an Agent

即使 User 通过 Chat UI 与 Agent 对话，User 也不是 Agent Profile。

消息发送方必须区分：

```ts
type SenderType = 'user' | 'agent' | 'system';
```

---

## 5. Workspace

### 5.1 Definition

Workspace 是 AgentOS 中长期存在的项目运行边界。

它通常对应一个本地项目目录，但其语义不只是“文件夹”。

Workspace 聚合：

- 项目路径；
- Git 状态；
- Agent Profile；
- Provider Configuration；
- Conversation；
- Task；
- Run；
- Worktree；
- Memory；
- Artifact；
- Policy；
- Workflow；
- Metrics。

### 5.2 Workspace Responsibilities

Workspace 负责定义：

- 项目根目录；
- 默认 Git 分支；
- 可访问路径边界；
- 默认 Provider；
- 默认 Policy；
- Memory Scope；
- Artifact 路径；
- Worktree 根目录；
- 环境配置；
- 可用 Agent Team。

### 5.3 Workspace Invariants

1. 一个 Run 必须属于一个 Workspace。
2. 一个 Task 必须属于一个 Workspace。
3. 一个 Conversation 必须属于一个 Workspace。
4. Workspace 删除前，必须显式处理其 Run、Worktree 和 Artifact。
5. Workspace Root Path 必须标准化并防止路径穿越。
6. 不允许两个活动 Workspace 在未确认的情况下指向同一根目录。
7. Workspace 的核心数据不能只存储在项目目录中的 Markdown 文件。
8. Workspace 可以在 Git 未启用时运行，但修改隔离能力会受限。

### 5.4 Workspace Types

v2 初期支持：

```ts
type WorkspaceType =
  | 'git'
  | 'directory';
```

未来可扩展：

- Remote Repository；
- Container Workspace；
- SSH Workspace；
- Cloud Workspace。

### 5.5 Workspace Is Not Worktree

Workspace 是长期项目边界。

Worktree 是某次 Run 的临时或半持久执行目录。

```text
Workspace
└── many Worktrees
```

---

# Part II — Agent and Provider

## 6. Agent Profile

### 6.1 Definition

Agent Profile 是一个长期存在的 AI 团队成员身份。

它表达的是：

- 谁在团队中工作；
- 承担什么角色；
- 拥有什么能力；
- 使用哪些 Memory；
- 默认使用哪个 Provider；
- 有什么行为约束。

Agent Profile 不等于模型，也不等于 CLI。

### 6.2 Example

```text
Agent Profile:
  Name: Backend Engineer
  Role: Backend implementation
  Capabilities:
    - backend
    - database
    - testing
  Default Provider:
    KimiCode
```

这里：

- “Backend Engineer”是 Agent Profile；
- “KimiCode”是 Provider；
- KimiCode 内部使用什么模型，由 Provider Configuration 决定。

### 6.3 Agent Profile Fields

```ts
interface AgentProfile {
  id: string;
  workspaceId: string;
  name: string;
  role: string;
  description?: string;
  avatar?: string;
  systemPrompt?: string;
  defaultProviderConfigId: string;
  capabilities: string[];
  memoryScopes: MemoryScope[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 6.4 Agent Profile Responsibilities

Agent Profile 定义：

- 角色身份；
- 行为提示；
- 默认 Provider；
- 能力标签；
- Memory 访问范围；
- 是否可被选择；
- 历史 Run 归属。

### 6.5 Agent Profile Invariants

1. Agent Profile 必须属于一个 Workspace。
2. Agent Profile 必须引用一个有效的默认 Provider Configuration。
3. Agent Profile 可以在不同 Run 中覆盖默认 Provider。
4. 禁用 Agent 不得被新 Run 自动选择。
5. 删除 Agent 前必须保留历史 Run 中的快照信息。
6. Agent 名称可以修改，但历史事件中应保留执行时名称快照。
7. Agent Profile 不持有运行中进程。
8. Agent Profile 不直接存储完整 Conversation History。

### 6.6 Agent Snapshot

Run 创建时必须保存 Agent Snapshot，防止 Agent Profile 后续修改导致历史不可解释。

```ts
interface AgentSnapshot {
  agentId: string;
  name: string;
  role: string;
  systemPrompt?: string;
  capabilities: string[];
  providerConfigId: string;
}
```

### 6.7 Persistent Agent vs Provider Subagent

Persistent Agent：

- 由 AgentOS 创建；
- 有稳定 ID；
- 长期存在；
- 有角色和 Memory；
- 可参与多个 Conversation 和 Run。

Provider Subagent：

- 由 Provider 内部创建；
- 可能只有临时 ID；
- 生命周期属于某次 Provider Session；
- 通过 Runtime Event 被观察；
- 不自动升级为 Agent Profile。

---

## 7. Provider

### 7.1 Definition

Provider 是能够执行 AI 工程任务的外部运行能力类型。

示例：

- Codex；
- Claude Code；
- KimiCode；
- OpenCode；
- Gemini CLI；
- Custom CLI；
- Remote Agent；
- Local Model Runtime。

Provider 是类型，不是某个具体配置实例。

```ts
type ProviderType =
  | 'codex'
  | 'claude-code'
  | 'kimicode'
  | 'opencode'
  | 'gemini-cli'
  | 'custom-cli'
  | 'remote';
```

### 7.2 Provider Responsibilities

Provider 负责：

- 模型推理；
- 原生 Session；
- 原生工具；
- 原生子 Agent；
- Provider 特定上下文处理；
- Provider 特定模型选择；
- Provider 特定输出格式。

### 7.3 Provider Does Not Own

Provider 不负责 AgentOS 的：

- Task；
- Run；
- Worktree 生命周期；
- Runtime Event 持久化；
- Policy；
- Approval；
- Artifact 统一管理；
- Memory 总体策略；
- 跨 Provider 历史。

---

## 8. Provider Configuration

### 8.1 Definition

Provider Configuration 是某个 Provider 在 AgentOS 中的可执行配置实例。

例如同一个 Workspace 可以存在：

```text
Provider Configuration A
  Type: Codex
  Model/Profile: default
  Executable: codex

Provider Configuration B
  Type: Codex
  Model/Profile: high-reasoning
  Executable: codex

Provider Configuration C
  Type: KimiCode
  Executable:
    C:\Users\Administrator\.kimi-code\bin\kimi.exe
```

### 8.2 Fields

```ts
interface ProviderConfiguration {
  id: string;
  workspaceId?: string;
  name: string;
  providerType: ProviderType;
  runtimeMode: 'cli' | 'api' | 'ssh' | 'container';
  executable?: string;
  argsTemplate?: string[];
  model?: string;
  environmentProfileId?: string;
  workingDirectoryMode: 'workspace' | 'worktree' | 'custom';
  capabilities: ProviderCapabilities;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 8.3 Provider Capabilities

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

### 8.4 Configuration Invariants

1. KimiCode Provider 必须直接调用 KimiCode CLI。
2. Provider Configuration 必须可独立验证。
3. 密钥和 Token 不得直接明文存储在普通配置表中。
4. executable 和 argsTemplate 必须在启动前规范化。
5. 不允许 Agent Profile 与 Provider Type 混为同一字段。
6. Provider Configuration 删除后，历史 Run 必须保留配置快照。
7. 环境变量应通过 Environment Profile 注入，而不是散落在代码中。

### 8.5 Provider Configuration Snapshot

每个 Run 必须保存执行时 Provider 快照：

```ts
interface ProviderConfigurationSnapshot {
  providerConfigId: string;
  name: string;
  providerType: ProviderType;
  runtimeMode: string;
  executable?: string;
  argsTemplate?: string[];
  model?: string;
  capabilities: ProviderCapabilities;
}
```

敏感环境变量不得进入普通快照。

---

## 9. Provider Adapter

### 9.1 Definition

Provider Adapter 是 AgentOS Runtime 与具体 Provider 之间的协议适配层。

它负责把 AgentOS 的统一执行请求转换成 Provider 特定调用，并把 Provider 输出转换成 Runtime Event。

### 9.2 Responsibilities

- 配置验证；
- 命令发现；
- 启动 Provider Session；
- 恢复 Session；
- 取消 Session；
- 输出解析；
- 错误归一化；
- 能力声明；
- 原生审批桥接；
- 原生子 Agent Event 转换。

### 9.3 Adapter Is Not Provider Configuration

Provider Configuration 是数据。

Provider Adapter 是代码实现。

```text
Provider Configuration
        ↓ consumed by
Provider Adapter
        ↓ controls
Provider Runtime
```

---

# Part III — Communication and Intent

## 10. Conversation

### 10.1 Definition

Conversation 是 User、Agent 和 System 之间长期存在的消息上下文。

Conversation 用于承载：

- 私聊；
- 群聊；
- 系统通知；
- Task 创建；
- Run 状态；
- Approval；
- Artifact；
- Review 反馈。

### 10.2 Conversation Types

```ts
type ConversationType =
  | 'direct'
  | 'group'
  | 'system';
```

#### Direct

User 与一个主要 Agent 之间的长期会话。

#### Group

User 与多个 Agent 之间的协作会话。

#### System

用于系统级通知、迁移、故障和全局事件。

### 10.3 Conversation Invariants

1. Conversation 必须属于 Workspace。
2. Direct Conversation 至少包含一个 User 和一个 Agent。
3. Group Conversation 可包含多个 Agent。
4. Conversation 不直接代表 Task。
5. 一个 Conversation 可以创建多个 Task。
6. 一个 Task 可以关联一个来源 Conversation。
7. 历史 Message 不应因 Agent Profile 重命名而失去发送者快照。
8. Conversation 删除必须是软删除或归档，避免破坏 Task / Run 来源链。

---

## 11. Conversation Member

### 11.1 Definition

Conversation Member 描述某个 User 或 Agent 是否属于一个 Conversation。

```ts
interface ConversationMember {
  conversationId: string;
  memberType: 'user' | 'agent';
  memberId: string;
  role: 'owner' | 'member' | 'observer';
  joinedAt: string;
  leftAt?: string;
}
```

### 11.2 Member Role

- `owner`：管理 Conversation 和成员；
- `member`：可参与消息与执行；
- `observer`：只读取，不自动响应。

### 11.3 Invariants

1. Agent 只有作为 Member 时才应自动参与该 Conversation。
2. 被移除成员的历史 Message 保留。
3. Observer 不得被 Planner 自动选择执行。
4. Group Conversation 必须限制自动回复循环。

---

## 12. Message

### 12.1 Definition

Message 是 Conversation 中不可变的通信记录。

Message 可以包含：

- 用户需求；
- Agent 回答；
- 系统状态；
- Task 卡片；
- Run 卡片；
- Approval 卡片；
- Artifact 卡片；
- Review 反馈。

### 12.2 Message Types

```ts
type MessageType =
  | 'text'
  | 'task-reference'
  | 'run-status'
  | 'approval'
  | 'artifact'
  | 'system'
  | 'error';
```

### 12.3 Message Fields

```ts
interface Message {
  id: string;
  conversationId: string;
  senderType: 'user' | 'agent' | 'system';
  senderId: string;
  senderSnapshot: {
    name: string;
    avatar?: string;
  };
  type: MessageType;
  content: string;
  replyToMessageId?: string;
  taskId?: string;
  runId?: string;
  artifactId?: string;
  approvalRequestId?: string;
  createdAt: string;
  editedAt?: string;
}
```

### 12.4 Message Is Not Prompt

Message 是用户可见的通信对象。

Prompt 是 Provider 执行时构造的运行输入。

一个 Prompt 可能由以下内容组合：

- 当前 Message；
- Task 描述；
- Agent Snapshot；
- Memory Context；
- Policy Guidance；
- Workflow Stage；
- Previous Stage Output；
- Worktree 状态。

Prompt 不应直接作为 Message 存储。

### 12.5 Message Immutability

原始 Message 应不可被覆盖。

编辑操作应保留：

- 原始内容；
- 编辑时间；
- 版本或审计事件。

---

## 13. Task

### 13.1 Definition

Task 是一个长期存在、可追踪的工作意图。

它描述：

> 要完成什么。

Task 不描述：

> 这一次具体如何执行。

### 13.2 Task Examples

- 修复 KimiCode Provider 调用错误；
- 增加 Task / Run 分离；
- 实现 Worktree 隔离；
- Review 当前 PR；
- 为 Workspace 添加长期 Memory；
- 对比 Codex 与 KimiCode 的实现方案。

### 13.3 Task Fields

```ts
interface Task {
  id: string;
  workspaceId: string;
  sourceConversationId?: string;
  sourceMessageId?: string;
  title: string;
  description?: string;
  status:
    | 'open'
    | 'in_progress'
    | 'blocked'
    | 'done'
    | 'cancelled';
  priority:
    | 'low'
    | 'normal'
    | 'high'
    | 'critical';
  createdBy: string;
  assignedAgentId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

### 13.4 Task Invariants

1. Task 必须属于 Workspace。
2. Task 可存在零个、一个或多个 Run。
3. Task 状态不能直接等同于最新 Run 状态。
4. Run 失败不一定使 Task 结束。
5. Task `done` 表示用户或 Workflow 接受任务完成。
6. Task Retry 必须创建新 Run。
7. Task 不应直接保存 Provider stdout。
8. Task 不应直接保存全部 Runtime Event。
9. Task 删除应优先采用归档。

### 13.5 Task Status Derivation

建议：

```text
open
  No active run

in_progress
  Has queued / starting / running / waiting_approval / paused run

blocked
  Requires external user action or unresolved dependency

done
  Accepted completion exists

cancelled
  User explicitly cancels task intent
```

---

# Part IV — Execution

## 14. Run

### 14.1 Definition

Run 是 Task 的一次具体执行尝试。

它回答：

- 谁执行；
- 用哪个 Provider；
- 使用哪个 Workflow；
- 在哪个 Worktree；
- 何时开始；
- 发生了什么；
- 是否成功；
- 产生了什么 Artifact；
- 是否经过 Approval。

### 14.2 Run Fields

```ts
interface Run {
  id: string;
  workspaceId: string;
  taskId: string;
  workflowDefinitionId?: string;
  parentRunId?: string;
  rootRunId: string;
  status:
    | 'queued'
    | 'starting'
    | 'running'
    | 'waiting_approval'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'cancelled';
  createdBy: string;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 14.3 Root Run and Parent Run

`parentRunId` 用于表达：

- Retry；
- Resume fallback；
- Review 返工；
- Provider 切换；
- Child Run。

`rootRunId` 用于将一系列相关 Run 聚合。

```text
Run 1: Initial attempt
├── Run 2: Retry with KimiCode
└── Run 3: Fix after review
```

### 14.4 Run Invariants

1. Run 必须属于 Task 和 Workspace。
2. Run 的历史状态不可被覆盖。
3. Run 完成后仍可产生后处理 Event，但主状态不可反复切换。
4. Retry 创建新 Run。
5. Run 必须持久化 Agent 和 Provider Snapshot。
6. 修改型 Run 应关联 Worktree。
7. Run 必须有单调递增的 Runtime Event Sequence。
8. Run 取消必须触发 Process Manager。
9. Run 完成并不自动表示 Task 已被接受。
10. Run 与 Provider Session 是一对多或一对一关系，取决于 Workflow。

### 14.5 Run Is Not Process

Run 是业务执行尝试。

Process 是操作系统层面的执行单元。

一个 Run 可能启动多个 Process：

```text
Run
├── Provider CLI Process
├── Test Process
├── Git Process
└── Tool Child Process
```

---

## 15. Run Stage

### 15.1 Definition

Run Stage 是 Run 中一个可独立追踪的执行阶段。

Stage 用于表示：

- Workflow 步骤；
- 不同 Agent 的责任段；
- 可重试和可审批的边界；
- 并行执行节点；
- 输出契约。

### 15.2 Stage Examples

- Planning；
- Implementation；
- Review；
- Security Review；
- Testing；
- Final Decision。

### 15.3 Stage Fields

```ts
interface RunStage {
  id: string;
  runId: string;
  workflowStageKey: string;
  name: string;
  sequence: number;
  agentSnapshot: AgentSnapshot;
  providerSnapshot: ProviderConfigurationSnapshot;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  errorCode?: string;
  errorMessage?: string;
}
```

### 15.4 Stage Invariants

1. Stage 必须属于一个 Run。
2. Stage 顺序由 Workflow 决定，而不是硬编码类型。
3. 不允许使用固定联合类型限制未来 Stage。
4. Stage 可以串行或并行。
5. Stage 必须保留执行时 Agent / Provider Snapshot。
6. Stage 失败是否终止 Run，由 Workflow Policy 决定。
7. Stage 输出应通过 Event 和 Artifact 表达。
8. Stage 不直接保存大段 stdout 作为唯一结果。

### 15.5 Current v1 Migration

v1 的：

```text
codex_manager
kimi_worker
opencode_reviewer
codex_final_review
```

迁移为 Workflow Stage Key，而不是系统核心类型。

---

## 16. Workflow Definition

### 16.1 Definition

Workflow Definition 是描述 Run 如何组织 Stage 的可配置模板。

它定义：

- Stage；
- 依赖；
- 顺序；
- 并行关系；
- Agent Selector；
- Provider Override；
- Approval Gate；
- Retry Policy；
- Output Contract；
- Completion Rule。

### 16.2 Workflow Is Not Runtime

Workflow 描述执行结构。

Runtime 负责可靠执行 Workflow。

### 16.3 Fields

```ts
interface WorkflowDefinition {
  id: string;
  workspaceId?: string;
  name: string;
  description?: string;
  version: number;
  stages: WorkflowStageDefinition[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 16.4 Built-in Workflow Examples

- Single Agent；
- Plan → Implement → Review；
- Parallel Provider Comparison；
- Security Gate；
- Test and Fix Loop；
- Research and Synthesis。

### 16.5 Workflow Snapshot

Run 创建时必须保存 Workflow Snapshot。

否则 Workflow 后续编辑会导致历史 Run 无法复现。

---

## 17. Provider Session

### 17.1 Definition

Provider Session 是 AgentOS 与某个 Provider 原生会话之间的绑定。

它可能对应：

- Codex Session；
- Claude Code Session；
- KimiCode Session；
- OpenCode Session；
- 某次 API Thread；
- 某个 Remote Agent Session。

### 17.2 Fields

```ts
interface ProviderSession {
  id: string;
  runId: string;
  stageId?: string;
  providerConfigId: string;
  nativeSessionId?: string;
  status:
    | 'starting'
    | 'active'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  metadata: Record<string, unknown>;
}
```

### 17.3 Invariants

1. Provider Session 必须属于 Run。
2. nativeSessionId 只由 Provider Adapter 解释。
3. Provider Session Resume 必须通过 Adapter。
4. Session 不等于 Conversation。
5. Session 可短于或长于单个 Process。
6. Session 的原生敏感信息不得写入普通日志。

---

## 18. Runtime Process

### 18.1 Definition

Runtime Process 是 AgentOS 管理的操作系统进程记录。

它负责表达：

- PID；
- Process Tree；
- 启动参数；
- 工作目录；
- 活动时间；
- 退出码；
- 终止原因；
- Heartbeat。

### 18.2 Fields

```ts
interface RuntimeProcess {
  id: string;
  runId: string;
  stageId?: string;
  providerSessionId?: string;
  pid: number;
  parentPid?: number;
  processType:
    | 'provider'
    | 'tool'
    | 'command'
    | 'git'
    | 'test'
    | 'system';
  status:
    | 'starting'
    | 'running'
    | 'stopping'
    | 'exited'
    | 'orphaned';
  cwd: string;
  startedAt: string;
  lastActivityAt: string;
  exitedAt?: string;
  exitCode?: number;
}
```

### 18.3 Process Invariants

1. Runtime Process 必须关联 Run。
2. Provider 主进程必须关联 Provider Session。
3. 取消 Run 时必须处理完整 Process Tree。
4. Process 退出不一定表示 Run 成功。
5. Server 重启后必须检查活动 Process。
6. 命令参数中的 Secret 必须脱敏。
7. Process stdout / stderr 必须转换成 Event 或 Raw Log Artifact。

---

# Part V — Runtime Data

## 19. Runtime Event

### 19.1 Definition

Runtime Event 是 AgentOS 中描述执行事实的不可变结构化记录。

它是 Runtime 的统一语言。

Runtime Event 用于驱动：

- Timeline；
- SSE / WebSocket；
- Runtime Inspector；
- Metrics；
- Artifact；
- Memory；
- Approval；
- Replay；
- Debug。

### 19.2 Event Structure

```ts
interface RuntimeEvent<T = unknown> {
  id: string;
  workspaceId: string;
  taskId?: string;
  runId: string;
  stageId?: string;
  agentId?: string;
  providerSessionId?: string;
  processId?: string;
  sequence: number;
  type: RuntimeEventType;
  timestamp: string;
  payload: T;
}
```

### 19.3 Event Invariants

1. Event 不可修改。
2. Event 必须关联 Run。
3. 同一 Run 内 sequence 必须单调递增。
4. Event 必须先持久化或与广播原子化。
5. Event Payload 必须可版本化。
6. UI 不应依赖 Provider 原始 stdout 格式。
7. Raw Output 必须可保留，但不是唯一事实来源。
8. Replay 只重放 Event，不重新执行 Provider。

### 19.4 Event Is Not Log

Log 是面向调试的文本记录。

Event 是面向系统行为的结构化事实。

```text
Log:
  "tool started"

Event:
  {
    "type": "tool.started",
    "payload": {
      "toolName": "shell",
      "arguments": {...}
    }
  }
```

---

## 20. Artifact

### 20.1 Definition

Artifact 是 Run 或 Task 产生的可独立保存、查看、下载、比较和引用的产物。

### 20.2 Artifact Examples

- Patch；
- Changed File；
- Markdown Report；
- Test Report；
- Coverage；
- Screenshot；
- Image；
- Video；
- JSON；
- Raw Provider Output；
- Debug Bundle；
- Build Output；
- Merge Report。

### 20.3 Fields

```ts
interface Artifact {
  id: string;
  workspaceId: string;
  taskId?: string;
  runId?: string;
  stageId?: string;
  sourceEventId?: string;
  type: ArtifactType;
  name: string;
  storageUri: string;
  mimeType?: string;
  sizeBytes?: number;
  checksum?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
```

### 20.4 Artifact Is Not File

File 是 Workspace 文件系统中的一个路径对象。

Artifact 是 AgentOS 管理的产物记录。

一个 Workspace File 可以被注册为 Artifact。

一个 Artifact 也可以不是 Workspace File，例如：

- stdout log；
- test report JSON；
- generated screenshot；
- diff patch。

### 20.5 Artifact Invariants

1. Artifact 创建后不可原地覆盖。
2. 修改后的产物应创建新 Artifact。
3. Artifact 必须可追踪来源 Run / Event。
4. Artifact 内容与元数据应分离存储。
5. Secret 必须在 Artifact 注册前脱敏或标记受限。

---

## 21. Worktree

### 21.1 Definition

Worktree 是 Git Worktree 在 AgentOS 中的托管记录。

它为修改型 Run 提供独立代码目录和分支。

### 21.2 Fields

```ts
interface Worktree {
  id: string;
  workspaceId: string;
  runId: string;
  path: string;
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  headCommit?: string;
  status:
    | 'creating'
    | 'active'
    | 'dirty'
    | 'ready_for_review'
    | 'merged'
    | 'abandoned'
    | 'deleted';
  createdAt: string;
  updatedAt: string;
}
```

### 21.3 Worktree Invariants

1. 修改型 Run 默认拥有独立 Worktree。
2. 一个 Worktree 只能被一个活动 Run 独占。
3. 并行 Stage 若同时修改代码，必须使用不同 Worktree。
4. Worktree 必须记录 Base Commit。
5. Merge 必须生成 Event 和 Artifact。
6. Worktree 清理不得删除未确认的修改。
7. 主 Workspace 默认不允许 Provider 直接修改。
8. 非 Git Workspace 可使用降级隔离，但必须明确标记。

### 21.4 Worktree Is Not Workspace

Workspace 是长期容器。

Worktree 是执行隔离资源。

---

## 22. Memory Entry

### 22.1 Definition

Memory Entry 是 AgentOS 从用户输入、历史执行和项目状态中沉淀的长期可检索知识单元。

### 22.2 Memory Scopes

```ts
type MemoryScope =
  | 'global'
  | 'workspace'
  | 'agent'
  | 'conversation'
  | 'task'
  | 'run';
```

### 22.3 Memory Categories

```ts
type MemoryCategory =
  | 'decision'
  | 'knowledge'
  | 'preference'
  | 'constraint'
  | 'failure'
  | 'review'
  | 'test'
  | 'summary';
```

### 22.4 Fields

```ts
interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  category: MemoryCategory;
  workspaceId?: string;
  agentId?: string;
  conversationId?: string;
  taskId?: string;
  runId?: string;
  title: string;
  content: string;
  sourceType:
    | 'user'
    | 'message'
    | 'event'
    | 'artifact'
    | 'agent'
    | 'manual';
  sourceId?: string;
  importance: number;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}
```

### 22.5 Memory Is Not History

Conversation History 是完整消息记录。

Memory 是经过筛选、结构化、可检索的长期知识。

### 22.6 Memory Is Not Markdown File

Markdown 可以作为：

- 人类可读导出；
- Workspace 文档；
- 兼容层；
- Agent 可编辑视图。

SQLite 中的 Memory Entry 才是 v2 的主数据。

### 22.7 Memory Context

Memory Context 是某次 Run 实际检索并注入的 Memory 集合。

```ts
interface MemoryContext {
  runId: string;
  entries: Array<{
    memoryEntryId: string;
    score: number;
    reason: string;
  }>;
  budgetUsed: number;
  createdAt: string;
}
```

每次 Memory 使用必须可观察。

---

## 23. Usage Record

### 23.1 Definition

Usage Record 是 Provider、Run、Stage 或 Process 的资源消耗记录。

### 23.2 Examples

- Input Tokens；
- Output Tokens；
- Cached Tokens；
- Cost；
- Duration；
- Tool Calls；
- Commands；
- Files Changed。

### 23.3 Fields

```ts
interface UsageRecord {
  id: string;
  workspaceId: string;
  runId: string;
  stageId?: string;
  providerConfigId?: string;
  metric: string;
  value: number;
  unit: string;
  sourceEventId?: string;
  recordedAt: string;
}
```

### 23.4 Invariants

1. Usage Record 应可增量追加。
2. Provider 不支持的指标允许为空。
3. 推算成本必须标记 `estimated`。
4. Metrics Dashboard 不应直接解析 stdout。

---

# Part VI — Safety and Control

## 24. Policy

### 24.1 Definition

Policy 是 AgentOS 对某个请求或行为进行允许、拒绝或要求审批的规则。

Policy 处理：

- 命令执行；
- 文件删除；
- 路径访问；
- Git 操作；
- 网络访问；
- 包安装；
- Secret 访问；
- Process 创建；
- Worktree Merge；
- Provider 权限。

### 24.2 Policy Decision

```ts
type PolicyDecision =
  | {
      action: 'allow';
    }
  | {
      action: 'deny';
      reason: string;
    }
  | {
      action: 'require_approval';
      riskLevel: 'low' | 'medium' | 'high' | 'critical';
      reason: string;
    };
```

### 24.3 Policy Is Not Prompt Rule

Prompt Rule：

> 不要删除文件。

Policy：

```text
file.delete request
  path outside worktree
  → deny
```

Prompt 可以指导 Agent。

Policy 必须控制 Runtime。

---

## 25. Policy Profile

### 25.1 Definition

Policy Profile 是 Workspace 或 Run 使用的一组策略配置。

### 25.2 Examples

- Safe；
- Standard；
- Trusted Local；
- Unsafe Development；
- Read Only；
- Review Only。

### 25.3 Fields

```ts
interface PolicyProfile {
  id: string;
  workspaceId?: string;
  name: string;
  rules: PolicyRuleConfiguration[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 25.4 Invariants

1. 每个 Workspace 必须有默认 Policy Profile。
2. Run 可覆盖 Workspace 默认 Policy。
3. Unsafe Profile 必须显式启用。
4. Policy Profile 修改后，历史 Run 保留执行时快照。
5. 默认配置不得包含危险绕过参数。

---

## 26. Approval Request

### 26.1 Definition

Approval Request 是 Policy 决定需要人工确认后创建的持久对象。

### 26.2 Fields

```ts
interface ApprovalRequest {
  id: string;
  workspaceId: string;
  runId: string;
  stageId?: string;
  sourceEventId?: string;
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
  requestPayload: Record<string, unknown>;
  status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'cancelled';
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}
```

### 26.3 Approval Invariants

1. Pending Approval 通常使 Run 进入 `waiting_approval`。
2. Approval 决策必须持久化。
3. Approval 必须保留原始请求。
4. 修改请求参数后批准，必须记录修改内容。
5. Approval 不能通过修改 Prompt 绕过。
6. Provider 原生 Approval 应映射为 AgentOS Approval Request。

---

# Part VII — Extensibility

## 27. Extension

### 27.1 Definition

Extension 是通过受控接口扩展 AgentOS 能力的模块。

### 27.2 Extension Types

- Provider Adapter；
- Event Processor；
- Artifact Processor；
- Memory Retriever；
- Policy Rule；
- Workflow Template；
- UI Panel；
- Integration；
- Command。

### 27.3 Extension Invariants

1. Extension 不得直接绕过 Runtime Event。
2. Extension 不得未经 Policy 访问敏感资源。
3. Extension 必须声明能力和权限。
4. Extension 错误不得导致 Event Store 损坏。
5. v2 初期 Extension SDK 先服务内置模块，不急于公开市场。

---

# Part VIII — System Relationships

## 28. Ownership Matrix

| Object | Owned By | Can Outlive Parent? |
|---|---|---|
| Workspace | User | Yes |
| Agent Profile | Workspace | No |
| Provider Configuration | Global or Workspace | Yes, if global |
| Conversation | Workspace | No |
| Message | Conversation | No |
| Task | Workspace | No |
| Run | Task | No |
| Run Stage | Run | No |
| Provider Session | Run / Stage | No |
| Runtime Process | Run | No |
| Runtime Event | Run | No |
| Worktree | Run | Temporarily |
| Artifact | Workspace / Run | Yes, after Run |
| Memory Entry | Scope owner | Depending on scope |
| Approval Request | Run | No |
| Usage Record | Run | No |
| Workflow Definition | Global or Workspace | Yes |
| Policy Profile | Global or Workspace | Yes |

---

## 29. Cardinality Summary

```text
Workspace 1 ── * Agent Profile
Workspace 1 ── * Provider Configuration
Workspace 1 ── * Conversation
Conversation 1 ── * Message
Conversation * ── * Agent Profile
Workspace 1 ── * Task
Task 1 ── * Run
Run 1 ── * Run Stage
Run 1 ── * Runtime Event
Run 1 ── * Provider Session
Provider Session 1 ── * Runtime Process
Run 1 ── 0..* Worktree
Run 1 ── * Artifact
Run 1 ── * Approval Request
Run 1 ── * Usage Record
Workspace 1 ── * Memory Entry
Agent Profile 1 ── * Memory Entry
Conversation 1 ── * Memory Entry
Task 1 ── * Memory Entry
Run 1 ── * Memory Entry
```

---

## 30. Snapshot Rules

历史可解释性要求以下对象在 Run 创建或 Stage 启动时生成 Snapshot：

- Agent Profile；
- Provider Configuration；
- Workflow Definition；
- Policy Profile；
- Memory Context；
- Workspace 执行相关配置。

Snapshot 的目标不是完整复制所有数据，而是保存影响执行结果的关键配置。

### 30.1 Snapshot Must Include

- 名称；
- 角色；
- Provider Type；
- Model；
- CLI 参数模板；
- Capabilities；
- Policy Version；
- Workflow Version；
- Memory Entry IDs；
- Base Commit；
- Worktree Path；
- Environment Profile ID。

### 30.2 Snapshot Must Exclude

- Secret 明文；
- Token；
- Cookie；
- 私钥；
- 大型二进制内容；
- 不相关 UI 配置。

---

## 31. Deletion and Retention Rules

### 31.1 Soft Delete Preferred

以下对象优先软删除或归档：

- Workspace；
- Agent Profile；
- Provider Configuration；
- Conversation；
- Task；
- Workflow Definition；
- Policy Profile。

### 31.2 Immutable Historical Objects

以下对象原则上不可修改或删除：

- Runtime Event；
- Approval Decision；
- Run Snapshot；
- Usage Record；
- Artifact Metadata；
- Message 原始版本。

### 31.3 Cleanup Objects

以下对象可以按策略清理：

- Worktree 目录；
- 临时 Process 记录；
- Raw Log；
- Cache；
- 临时 Artifact；
- Provider 临时 Session 数据。

清理必须产生审计 Event。

---

## 32. Time and Ordering

### 32.1 Timestamp

所有持久化时间统一使用 UTC ISO 8601。

示例：

```text
2026-07-19T12:00:00.000Z
```

### 32.2 Ordering

- Message 以 `createdAt + id` 排序；
- Runtime Event 以 `runId + sequence` 排序；
- Stage 以 Workflow Sequence 和依赖图排序；
- Artifact 以 `createdAt` 排序；
- Approval 以 `createdAt` 排序。

### 32.3 Clock Is Not Enough

Runtime Event 顺序不得只依赖时间戳。

必须使用 `sequence`。

---

# Part IX — Conceptual Scenarios

## 33. Scenario A: Direct Agent Chat to Run

```text
User
  ↓ sends Message
Direct Conversation
  ↓ user selects "Create Task"
Task created
  ↓ user starts Run
Agent Snapshot + Provider Snapshot
  ↓
Worktree created
  ↓
Provider Session started
  ↓
Runtime Events emitted
  ↓
Artifact created
  ↓
Run completed
  ↓
Summary Message posted to Conversation
  ↓
Memory candidates persisted
```

---

## 34. Scenario B: Retry with Another Provider

```text
Task
└── Run 1
    Agent: Backend Engineer
    Provider: KimiCode
    Status: failed
        ↓ Retry with provider override
└── Run 2
    Parent Run: Run 1
    Agent: Backend Engineer
    Provider: Codex
    Status: completed
```

Task 不变。

Run 新建。

历史保留。

---

## 35. Scenario C: Group Review

```text
Group Conversation
├── Architect Agent
├── Backend Agent
└── Reviewer Agent

User Message
  ↓
Task
  ↓
Workflow: Plan → Implement → Review
  ├── Stage 1 Architect / Codex
  ├── Stage 2 Backend / KimiCode
  └── Stage 3 Reviewer / OpenCode
```

这不是三个 CLI 随机聊天。

它是一个 Conversation 中由 Workflow 启动的结构化 Run。

---

## 36. Scenario D: Provider Native Subagent

```text
Run Stage
  ↓
Codex Provider Session
  ↓ Codex spawns native subagent
Runtime Event:
  subagent.spawned
  ↓
Runtime Event:
  subagent.completed
```

Provider Native Subagent 不自动创建 Agent Profile。

它属于 Provider Session 的执行细节。

---

## 37. Scenario E: Approval

```text
Provider requests:
  git push origin main
        ↓
Policy evaluates
        ↓
Approval Request created
        ↓
Run status: waiting_approval
        ↓
User rejects
        ↓
approval.resolved event
        ↓
Provider does not execute push
        ↓
Run continues or fails by workflow policy
```

---

## 38. Scenario F: Memory Retrieval

```text
Run starting
  ↓
Memory Engine queries:
  Task scope
  Conversation scope
  Agent scope
  Workspace scope
  ↓
Memory Context created
  ↓
memory.retrieved events emitted
  ↓
Prompt Builder injects selected entries
```

Memory 检索结果必须可查看。

---

# Part X — Anti-Patterns

## 39. Anti-Pattern: Agent Equals CLI

错误：

```ts
agent.role = 'kimi'
agent.cliCommand = 'opencode'
```

正确：

```text
Agent Profile:
  Backend Engineer

Provider Configuration:
  KimiCode CLI
```

---

## 40. Anti-Pattern: Task Stores Outputs

错误：

```ts
Task {
  outputs: TaskLog[]
}
```

正确：

```text
Task
└── Runs
    └── Events + Artifacts
```

---

## 41. Anti-Pattern: Fixed Stage Union

错误：

```ts
type AgentStage =
  | 'codex_manager'
  | 'kimi_worker'
  | 'opencode_reviewer';
```

正确：

```text
Run Stage is data defined by Workflow Definition.
```

---

## 42. Anti-Pattern: stdout Is Event Model

错误：

```text
Provider stdout
  ↓ directly shown as Timeline
```

正确：

```text
Provider stdout
  ↓ Adapter parser
  ↓ Runtime Event
  ↓ Timeline
```

Raw stdout 仍保留为 Artifact。

---

## 43. Anti-Pattern: Prompt Is Policy

错误：

```text
Prompt:
  Do not delete files.
```

正确：

```text
Policy Engine:
  file.delete outside worktree
  → deny
```

---

## 44. Anti-Pattern: Shared Working Directory

错误：

```text
Codex
KimiCode
OpenCode
  ↓
same workspace root
```

正确：

```text
Run / modifying Stage
  ↓
isolated Worktree
```

---

## 45. Anti-Pattern: Memory Equals Full Context Dump

错误：

```text
Read all Markdown files
  ↓
Inject all into every prompt
```

正确：

```text
Retrieve relevant Memory Entries
  ↓
Apply budget
  ↓
Create Memory Context
  ↓
Inject selected entries
```

---

## 46. Anti-Pattern: Run Status Follows HTTP Connection

错误：

```text
Browser disconnects
  ↓
Run disappears
```

正确：

```text
Run is durable
Browser reconnects
  ↓
Resume streaming persisted events
```

用户显式 Cancel 与页面断开连接必须区分。

---

# Part XI — Core Invariants

## 47. Global Invariants

AgentOS v2 必须始终满足：

1. Agent Profile 与 Provider Configuration 分离。
2. Task 与 Run 分离。
3. Run 与 Process 分离。
4. Runtime Event 不可变。
5. Retry 创建新 Run。
6. 修改型 Run 默认隔离。
7. 所有高风险操作经过 Policy。
8. 所有 Approval 决策可审计。
9. 所有历史执行保留 Snapshot。
10. Provider 特定逻辑只存在于 Adapter 或 Provider Package。
11. Secret 不得进入普通 Event、Log 或 Snapshot。
12. Runtime 不能以浏览器连接作为执行生命边界。
13. 所有重要状态必须持久化。
14. Timeline 必须来自 Runtime Event。
15. Memory 使用必须可追踪。
16. Artifact 必须可追踪到来源。
17. Workflow 不得硬编码在 Run Engine。
18. Provider Native Subagent 不等于 Persistent Agent。
19. Prompt Rule 不等于 Runtime Policy。
20. 主 Workspace 默认不直接承载并发修改。

---

## 48. Naming Invariants

### 48.1 KimiCode

统一命名：

- Provider Type：`kimicode`
- Adapter：`KimiCodeProviderAdapter`
- Environment Variable：`AGENTOS_KIMICODE_CLI`
- Default Windows Path：
  `C:\Users\<USER>\.kimi-code\bin\kimi.exe`

不得用 OpenCode CLI 代替 KimiCode Provider，除非用户显式配置 Custom CLI。

### 48.2 OpenCode

统一命名：

- Provider Type：`opencode`
- Adapter：`OpenCodeProviderAdapter`

### 48.3 Codex

统一命名：

- Provider Type：`codex`
- Adapter：`CodexProviderAdapter`

### 48.4 Agent Roles

Agent Role 使用业务角色，例如：

- `architect`
- `backend-engineer`
- `frontend-engineer`
- `reviewer`

不得把 Provider 名称作为唯一 Role。

---

# Part XII — Implementation Guidance

## 49. Recommended Package Boundaries

```text
packages/
├── shared/
│   └── canonical domain types
├── runtime-core/
│   ├── Run Engine
│   ├── Stage Executor
│   ├── Event Bus
│   └── State Machine
├── providers/
│   ├── codex/
│   ├── kimicode/
│   ├── opencode/
│   └── custom-cli/
├── storage/
│   ├── schema
│   ├── repositories
│   └── migrations
├── process-runtime/
├── git-runtime/
├── memory-engine/
├── artifact-core/
├── policy-engine/
└── extension-sdk/
```

### 49.1 Shared Package Rule

`packages/shared` 只放：

- Domain Types；
- API DTO；
- Event Schema；
- Error Code；
- Validation Schema。

不放：

- Node Process 实现；
- Database Client；
- Provider Adapter；
- 文件系统逻辑。

---

## 50. Core Repository Interfaces

建议领域仓储接口：

```ts
interface WorkspaceRepository {}
interface AgentRepository {}
interface ProviderConfigurationRepository {}
interface ConversationRepository {}
interface MessageRepository {}
interface TaskRepository {}
interface RunRepository {}
interface RunStageRepository {}
interface RuntimeEventRepository {}
interface ProviderSessionRepository {}
interface RuntimeProcessRepository {}
interface WorktreeRepository {}
interface ArtifactRepository {}
interface MemoryRepository {}
interface ApprovalRepository {}
interface WorkflowRepository {}
interface PolicyRepository {}
interface UsageRepository {}
```

Repository 不应包含跨领域 Runtime 业务流程。

---

## 51. Aggregate Boundaries

### 51.1 Workspace Aggregate

负责：

- Workspace 基础配置；
- 默认 Policy；
- 默认路径；
- 生命周期。

不直接一次性加载所有 Run、Event 和 Artifact。

### 51.2 Conversation Aggregate

负责：

- Conversation；
- Member；
- Message。

### 51.3 Task Aggregate

负责：

- Task；
- Task 状态；
- Run 引用关系。

### 51.4 Run Aggregate

负责：

- Run；
- Stage；
- Snapshot；
- Event Sequence；
- Session；
- Process；
- Approval 状态。

Run 是 Runtime 中最重要的执行聚合。

### 51.5 Memory Aggregate

负责：

- Memory Entry；
- Scope；
- Retrieval；
- Deduplication；
- Usage tracking。

---

# Part XIII — Glossary

## 52. Glossary

### Agent Profile

AgentOS 中长期存在的团队成员身份。

### Provider

提供 AI 执行能力的外部类型，如 Codex、KimiCode。

### Provider Configuration

某个 Provider 的具体可执行配置。

### Provider Adapter

将统一 Runtime 请求映射到具体 Provider 的代码适配层。

### Conversation

User、Agent 和 System 的长期消息空间。

### Message

Conversation 中不可变的通信记录。

### Task

长期存在的工作意图。

### Run

Task 的一次执行尝试。

### Run Stage

Run 中由 Workflow 定义的可追踪执行阶段。

### Workflow Definition

描述 Run 中 Stage 和依赖关系的模板。

### Runtime Event

描述执行事实的不可变结构化记录。

### Provider Session

AgentOS 与 Provider 原生 Session 的绑定。

### Runtime Process

AgentOS 托管的操作系统进程记录。

### Worktree

为 Run 提供代码隔离的 Git Worktree。

### Artifact

Run 或 Task 产生的受管理产物。

### Memory Entry

可检索、可追踪的长期知识单元。

### Memory Context

某次 Run 实际检索并使用的 Memory 集合。

### Policy

对 Runtime 行为作出 allow、deny 或 require approval 的规则。

### Policy Profile

一组可选择的 Policy 配置。

### Approval Request

等待 User 决策的持久高风险操作请求。

### Usage Record

Token、成本、耗时等资源消耗记录。

### Extension

通过稳定接口扩展 AgentOS 的模块。

### Snapshot

执行时关键配置的不可变副本。

### UI Surface

Runtime 资源与 Projection 的人类可读视图。

UI Surface 不拥有 Run、Provider Session 或 Process 生命周期。

### Client Session

浏览器或 Desktop 的临时连接。Client Session 不代表任何 Provider Session。

### View State

临时 UI 状态，包括当前选中项、打开 Inspector、Panel 尺寸、Focus 和滚动位置。

View State 不属于 Domain State，不进入 Event Store。

### Runtime Transport

Web 与未来 Tauri 之间共享的 REST、SSE 与 WebSocket 合同。

### Platform Adapter

前端对浏览器或 Desktop 原生能力的抽象。

不同 Platform 通过同一 Adapter 接口暴露差异。

---

## 53. UI Architecture Invariants

AgentOS v2 必须始终满足的 UI 相关不变量：

```text
UI Surface ≠ Runtime
Client Session ≠ Provider Session
View State ≠ Domain State
Platform Adapter ≠ Provider Adapter
Platform Adapter ≠ Runtime Transport
```

---

# Part XIV — Final Definition

## 53. Core Model Summary

AgentOS v2 的核心模型可压缩为：

```text
Workspace defines the long-lived project boundary.

Agent Profile defines who works.

Provider Configuration defines how an external AI runtime is invoked.

Conversation defines where communication happens.

Message records what was communicated.

Task defines what should be accomplished.

Run records one attempt to accomplish it.

Run Stage defines a workflow step.

Provider Session binds a stage to a native provider session.

Runtime Process represents operating-system execution.

Runtime Event records what happened.

Worktree isolates code modifications.

Artifact stores what was produced.

Memory Entry preserves what should be remembered.

Policy decides what is allowed.

Approval Request asks the user when policy requires a decision.
```

中文总结：

> Workspace 是长期项目边界；Agent Profile 表示“谁来工作”；Provider Configuration 表示“通过什么外部运行能力工作”；Conversation 和 Message 表示“在哪里沟通、说了什么”；Task 表示“要完成什么”；Run 表示“某一次如何尝试”；Stage 表示“执行的结构步骤”；Event 表示“实际发生了什么”；Worktree 表示“在哪里安全修改”；Artifact 表示“产生了什么”；Memory 表示“以后需要记住什么”；Policy 和 Approval 表示“什么可以做，以及何时必须由用户决定”。

本文件中的概念与边界，是 AgentOS v2 后续 Runtime Lifecycle、Event Model、数据库、API 与 UI 设计的基础。
