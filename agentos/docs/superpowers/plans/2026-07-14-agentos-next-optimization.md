# AgentOS 下一阶段优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不推翻现有聊天、群聊、SQLite 和 CLI 执行架构的前提下，把 AgentOS 升级为“执行过程可追溯、项目知识可沉淀、相关记忆可按需注入”的研发协作平台。

**Architecture:** 保留现有 `AgentExecution` 和 `ExecutionEvent` 作为单个 Agent 调用记录，在其上新增一次用户请求级别的 `AgentRun`。服务端使用轻量进程内有序事件总线产生可持久化的公开事件；记忆正文继续保持 Markdown 可读性，SQLite 保存索引、来源和状态；检索先使用 SQLite FTS5，不引入向量数据库。

**Tech Stack:** Node.js >= 22.5、TypeScript、Express、`node:sqlite`、Next.js 14、React 18、Vitest、Node Test Runner、PowerShell、pnpm workspace。

## Global Constraints

- 使用中文作为用户界面、文档和用户可见错误信息的默认语言，并确保源文件统一为 UTF-8。
- 只做与执行档案和项目记忆直接相关的修改，不重构无关 UI、Agent Provider 或任务流水线。
- 兼容当前 `.agentos/agentos.sqlite`，所有数据库升级必须为增量迁移，不删除已有会话、消息、执行或事件。
- 继续支持旧 `workspace/workspaces.json` 和现有 `agent-memory/*.md` 文件。
- 不引入 Kafka、Redis、消息队列、向量数据库、知识图谱或新的模型 SDK。
- 不记录模型私有思维链；只保存公开消息、公开执行状态、CLI 调用元数据、文件变化和用户可见结果。
- 不伪造无法观察的数据。通用 CLI 内部执行的具体 Shell 命令和工具调用无法可靠获知时，只记录 AgentOS 实际发起的 CLI 调用。
- 所有新数据必须按 `workspaceId` 隔离；所有文件路径必须经过工作区边界校验。
- 每个计划项先写失败测试，再做最小实现，再跑局部测试，最后跑阶段回归。
- 每个计划项独立提交；不得把多个阶段混在一个提交中。

---

## 0. 当前基线与目标边界

当前已经存在，禁止重复实现：

- `apps/server/src/store/SqliteStore.ts` 已有 `executions` 与 `execution_events` 表。
- `apps/server/src/services/ConversationService.ts` 已负责单聊、群聊、执行状态持久化。
- `apps/server/src/routes/conversations.ts` 已提供消息流和执行历史 API。
- `apps/web/src/components/chat/ExecutionInspector.tsx` 已展示执行时间线。
- `packages/agent-core/src/conversationRunner.ts` 已产生排队、准备上下文、CLI 执行、回复、完成/失败/取消状态。
- `packages/agent-core/src/runner.ts` 已读取部分 `agent-memory/*.md` 文件作为流水线上下文。
- Workspace 已有 `memoryEnabled` 配置。

本计划完成后必须具备：

1. 一条用户请求对应一个稳定的 `runId`，群聊中的多个 Agent 调用归属于同一 Run。
2. 用户可以从历史记录还原一次 Run 的需求、Agent、事件、文件变化、验证说明和结果。
3. 用户可以手动创建、编辑、归档和检索项目记忆。
4. Agent 执行前只注入相关记忆，并记录本次使用了哪些记忆。
5. 成功 Run 可以生成“待确认记忆”，但不能未经用户审批直接写入正式记忆。

本计划不包含：

- 根据历史评分自动选择模型或 Agent。
- 跨 Workspace 共享记忆。
- 自动删除、自动覆盖或自动合并正式记忆。
- 读取任意 CLI 的内部思维链、内部工具调用或不可观察命令。
- 将现有固定 Pipeline 改造成完全动态调度器。

---

## 1. 固化现有版本基线并清理中文编码问题

**目标：** 在增加数据模型前确认当前真实运行链路可用，并建立后续阶段统一使用的验收入口。

**Files:**

- Create: `scripts/verify-next-optimization-baseline.ps1`
- Create: `docs/acceptance/agentos-next-optimization-baseline.md`
- Modify only if confirmed corrupted: `README.md`
- Modify only if confirmed corrupted: `docs/AGENTOS_V2.md`
- Modify only if confirmed corrupted: affected UTF-8 source files under `apps/` and `packages/`

**Interfaces:**

```powershell
./scripts/verify-next-optimization-baseline.ps1
```

脚本固定执行：

```powershell
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/server test
pnpm --filter @agentos/web build
pnpm -r run build
```

- [x] **1.1 记录未修改前的基线**

在 `docs/acceptance/agentos-next-optimization-baseline.md` 记录当前分支、Node/pnpm 版本、四条命令、退出码和失败测试名称。不能只写“通过”或“失败”。

- [x] **1.2 创建统一验收脚本**

脚本使用 `$LASTEXITCODE` 检查每条命令，任一命令失败立即退出非零；成功时输出四项检查的明确名称。

- [x] **1.3 核对 UTF-8 中文文本**

使用 `Get-Content -Encoding utf8` 检查 README、V2 文档、`ConversationService.ts`、`conversationRunner.ts` 和 `ExecutionInspector.tsx`。只有文件字节实际损坏时才修复，不能根据终端代码页显示异常盲目批量替换。

- [x] **1.4 完成真实 UI 冒烟验收**

使用真实浏览器完成：打开 Workspace、创建单聊、发送消息、查看执行时间线、刷新页面、确认消息和执行历史仍在。结果写入基线文档。

### 验收标准

- 四条自动化命令退出码全部为 `0`。
- 基线文档包含实际命令、时间、退出码和浏览器验收路径。
- 中文在源文件、浏览器和 API JSON 中均正常，不存在新增乱码。
- 本阶段不得改变数据库结构和业务行为。

### 建议提交

```powershell
git add scripts/verify-next-optimization-baseline.ps1 docs/acceptance/agentos-next-optimization-baseline.md README.md docs/AGENTOS_V2.md apps/server/src/services/ConversationService.ts packages/agent-core/src/conversationRunner.ts apps/web/src/components/chat/ExecutionInspector.tsx
git commit -m "chore: establish AgentOS optimization baseline"
```

如果编码核对证明后三个源码文件没有损坏，则它们不会产生 diff；不得使用 `git add apps packages` 批量暂存无关修改。

---

## 2. 新增用户请求级 `AgentRun` 数据模型

**目标：** 让一次用户请求成为稳定的追踪单位；direct conversation 对应一个 Execution，group conversation 对应多个 Execution，但都属于同一 Run。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/services/ConversationService.test.ts`
- Create: `apps/server/src/runRecovery.ts`
- Create: `apps/server/src/runRecovery.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**

```ts
export type AgentRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentRun {
  id: string;
  workspaceId: string;
  conversationId: string;
  sourceMessageId: string;
  objective: string;
  status: AgentRunStatus;
  resultSummary?: string;
  failureReason?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

`AgentExecution` 增加必填字段：

```ts
runId: string;
```

SQLite 新表与增量列：

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  result_summary TEXT,
  failure_reason TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE RESTRICT
);
```

- [x] **2.1 先写 Store 失败测试**

测试必须覆盖：创建 Run、重开 Store 后仍存在、Workspace 隔离、合法状态更新、删除 Conversation 时级联删除 Run、旧数据库自动增加 `executions.run_id`。

- [x] **2.2 实现增量迁移**

新增 `agent_runs` 表和索引：

```sql
CREATE INDEX IF NOT EXISTS agent_runs_conversation_updated
ON agent_runs (conversation_id, updated_at DESC);
```

为 `executions` 增加可迁移列 `run_id TEXT`。迁移函数随后逐条回填旧执行：每条未关联 Run 的旧 Execution 创建一个对应的 legacy Run，`objective` 取其 source message，无法读取时使用“历史执行记录”；再把 Execution 指向该 Run。迁移完成后 Store 层读取的所有 Execution 都必须具有非空 `runId`。不得重建或删除 `executions` 表。

- [x] **2.3 实现 Store 方法**

```ts
createRun(run: AgentRun): AgentRun;
updateRun(workspaceId: string, runId: string, update: Partial<Pick<AgentRun,
  'status' | 'resultSummary' | 'failureReason' | 'startedAt' | 'completedAt'
>>): AgentRun;
getRun(workspaceId: string, runId: string): AgentRun | undefined;
listRuns(workspaceId: string, conversationId: string, limit?: number): AgentRun[];
```

- [x] **2.4 接入 direct conversation**

保存用户消息后立即创建 Run；创建 Execution 时写入同一个 `runId`；运行开始时更新为 `running`；成功、失败和取消分别写入终态和对应摘要。

- [x] **2.5 接入 group conversation**

每条用户群聊消息只创建一个 Run。群主规划、成员执行、群主总结创建的所有 Execution 使用同一 `runId`。只有最终总结完成后 Run 才能变为 `completed`；任一成员失败不能覆盖其他成员执行记录，最终 Run 是否失败由群主总结是否成功决定。

- [x] **2.6 增加 Run 启动恢复**

创建 `apps/server/src/runRecovery.ts` 和 `apps/server/src/runRecovery.test.ts`。Server 启动时把遗留的 `queued/running` Run 标记为 `failed`，`failureReason` 固定为“服务重启导致执行中断”；已完成、失败和取消的 Run 不得修改。把恢复函数接入 `apps/server/src/index.ts`，并记录恢复数量。

### 验收标准

- direct 消息产生 `1 AgentRun + 1 AgentExecution`，二者 `runId` 一致。
- 三 Agent 群聊产生 `1 AgentRun + N AgentExecution`，所有 Execution 的 `runId` 相同。
- 服务重启后 Run、Execution 和关联关系不丢失。
- 旧 SQLite 可以启动，不删除历史数据；新执行全部具有 `runId`。
- `pnpm --filter @agentos/server test` 退出码为 `0`。

### 建议提交

```powershell
git add packages/shared/src/types/index.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/services/ConversationService.ts apps/server/src/services/ConversationService.test.ts apps/server/src/runRecovery.ts apps/server/src/runRecovery.test.ts apps/server/src/index.ts
git commit -m "feat: add request-level agent runs"
```

---

## 3. 建立轻量统一事件模型和进程内有序 Event Bus

**目标：** 让聊天、历史、记忆和未来统计消费同一份公开事件，避免 `ConversationService` 继续直接承担所有下游工作。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/events/EventBus.ts`
- Create: `apps/server/src/events/EventBus.test.ts`
- Create: `apps/server/src/events/createAgentEvent.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/routes/conversations.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**

```ts
export type AgentEventType =
  | 'conversation.message.created'
  | 'run.created'
  | 'run.started'
  | 'execution.status.changed'
  | 'execution.cli.started'
  | 'execution.cli.completed'
  | 'execution.files.changed'
  | 'memory.used'
  | 'memory.candidate.created'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled';

export interface AgentEvent<TPayload = Record<string, unknown>> {
  eventId: string;
  schemaVersion: 1;
  type: AgentEventType;
  workspaceId: string;
  conversationId: string;
  runId: string;
  executionId?: string;
  agentId?: string;
  timestamp: string;
  payload: TPayload;
}

export interface EventBus {
  publish(event: AgentEvent): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void | Promise<void>): () => void;
}
```

- [x] **3.1 编写 Event Bus 顺序和退订测试**

断言订阅者按注册顺序收到事件；异步订阅者完成后 `publish()` 才返回；退订后不再收到事件；某订阅者抛错时 `publish()` 拒绝并保留原错误，不得静默吞掉。

- [x] **3.2 实现最小同步 Event Bus**

只使用进程内订阅者数组或 `Set`，并按顺序 `await` 每个订阅者；不增加队列、重试线程和外部依赖。Event Bus 生命周期由 `apps/server/src/index.ts` 创建，经 `apps/server/src/routes/conversations.ts` 注入 ConversationService。

- [x] **3.3 新增持久化事件表**

```sql
CREATE TABLE IF NOT EXISTS agent_events (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  execution_id TEXT,
  agent_id TEXT,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
```

增加 `(workspace_id, run_id, timestamp)` 索引，并实现：

```ts
appendAgentEvent(event: AgentEvent): void;
listAgentEvents(workspaceId: string, runId: string): AgentEvent[];
```

- [x] **3.4 注册唯一持久化订阅者**

在 Server 启动时注册 `event => store.appendAgentEvent(event)`。业务 Service 只发布事件，不直接调用多个消费者。

- [x] **3.5 保持 SSE 兼容**

现有 `ExecutionEvent` 和 SSE `execution` 事件暂时保留；由同一次状态变化同时产生兼容 SSE 输出和统一 AgentEvent。完成前必须验证前端无需同时改动即可继续工作。

### 验收标准

- 每个 AgentEvent 都包含完整 `eventId/schemaVersion/workspaceId/conversationId/runId/timestamp/payload`。
- 同一 Run 的持久化事件时间顺序稳定，重启后可读取。
- SSE 的事件名和已有前端行为不变。
- 没有 Kafka、Redis 或后台重试线程。
- Event Bus 测试、Store 测试和 ConversationService 测试全部通过。

### 建议提交

```powershell
git add packages/shared/src/types/index.ts apps/server/src/events apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/services/ConversationService.ts apps/server/src/routes/conversations.ts apps/server/src/index.ts
git commit -m "feat: add persisted AgentOS event bus"
```

---

## 4. 采集可验证的执行证据

**目标：** 为 Run 增加 AgentOS 真正能够观察到的 CLI 调用、文件变化和验证说明，不伪造 CLI 内部工具行为。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `packages/agent-core/src/workspaceChanges.ts`
- Create: `packages/agent-core/src/workspaceChanges.test.ts`
- Modify: `packages/agent-core/src/executor.ts`
- Modify: `packages/agent-core/src/executor.test.ts`
- Modify: `packages/agent-core/src/conversationRunner.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Modify: `apps/server/src/services/ConversationService.ts`

**Interfaces:**

```ts
export interface RunCliInvocation {
  id: string;
  runId: string;
  executionId: string;
  agentId: string;
  cliKind: string;
  commandLabel: string;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  exitCode: number | null;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

export interface RunFileChange {
  runId: string;
  path: string;
  changeType: 'created' | 'modified' | 'deleted' | 'renamed';
}

export interface CliInvocationObservation {
  invocationId: string;
  cliKind: string;
  commandLabel: string;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  exitCode?: number | null;
  durationMs?: number;
  startedAt: string;
  completedAt?: string;
}
```

`commandLabel` 只能是脱敏后的可读标识，例如 `codex exec`、`kimi -p`，不得保存 API Key、完整 Prompt 或凭据路径。

- [x] **4.1 编写 Workspace 变化采集测试**

使用临时 Git 仓库覆盖：修改已跟踪文件、新增未跟踪文件、删除文件、无 Git 仓库。无 Git 仓库返回空数组和明确的 `gitUnavailable` 标志，不能使 Run 失败。

- [x] **4.2 实现执行前后快照**

在 AgentOS 启动 CLI 前采集 Git 状态快照，CLI 结束后再次采集，计算本次 Execution 新增的变化。只保存工作区相对路径，拒绝 `..` 或绝对路径。

- [x] **4.3 增加 CLI 生命周期回调**

扩展 `ExecuteContext`：

```ts
onInvocationStarted?: (observation: CliInvocationObservation) => void;
onInvocationCompleted?: (observation: Required<Pick<CliInvocationObservation,
  'invocationId' | 'cliKind' | 'commandLabel' | 'startedAt' | 'completedAt' |
  'exitCode' | 'durationMs'
>> & Pick<CliInvocationObservation, 'model' | 'thinkingEffort'>) => void;
onFileChanges?: (changes: Array<Omit<RunFileChange, 'runId'>>) => void;
```

`agent-core` 只产生不含业务 ID 的观察结果；`ConversationService` 使用当前 `runId/executionId/agentId` 补全为 `RunCliInvocation` 和 `RunFileChange` 后再持久化，避免底层 Executor 依赖服务端 Run 生命周期。

- [x] **4.4 持久化执行证据**

新增 `run_cli_invocations` 和 `run_file_changes` 表。唯一约束至少保证同一 `invocation.id` 不会重复写入；同一 Run 的文件变化按 `(run_id, path, change_type)` 去重。

持久化完成后分别发布 `execution.cli.started`、`execution.cli.completed` 和 `execution.files.changed`；这些事件的 payload 只允许包含脱敏元数据和相对路径。

- [x] **4.5 明确验证说明的可信边界**

第一版不解析任意 CLI 内部命令。Agent 回复中提到的测试命令只能作为 `resultSummary` 的文本证据，不能标记为“系统已验证”。只有 AgentOS 自己运行的测试命令才允许标记为系统验证；本阶段不新增自动测试执行器。

### 验收标准

- 任一 Execution 都能看到脱敏 CLI 标识、模型、思考强度、退出码和耗时。
- Git Workspace 的新增、修改、删除文件可关联到 `runId`。
- 非 Git Workspace 仍可执行，只是文件变化显示“不可采集”。
- 数据库和日志中不包含 API Key、完整 Prompt、访问令牌或凭据文件内容。
- 既有 CLI 失败、取消和超时语义不改变。

### 建议提交

```powershell
git add packages/shared/src/types/index.ts packages/agent-core/src/workspaceChanges.ts packages/agent-core/src/workspaceChanges.test.ts packages/agent-core/src/executor.ts packages/agent-core/src/executor.test.ts packages/agent-core/src/conversationRunner.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/services/ConversationService.ts
git commit -m "feat: capture observable run evidence"
```

---

## 5. 增加 Run 历史详情 API 与前端页面

**目标：** 用户无需查看原始数据库或日志，即可完整理解一次执行发生了什么。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/routes/runs.ts`
- Create: `apps/server/src/routes/runs.test.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/web/src/lib/runDetails.ts`
- Create: `apps/web/src/lib/runDetails.test.ts`
- Create: `apps/web/src/components/runs/RunDetails.tsx`
- Modify: `apps/web/src/components/chat/ExecutionInspector.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`

**Interfaces:**

```ts
export interface AgentRunDetails {
  run: AgentRun;
  sourceMessage: ConversationMessage;
  executions: AgentExecution[];
  events: AgentEvent[];
  cliInvocations: RunCliInvocation[];
  fileChanges: RunFileChange[];
  usedMemories: MemoryUsage[];
}
```

API：

```http
GET /api/workspaces/:workspaceId/runs?conversationId=:conversationId&limit=20
GET /api/workspaces/:workspaceId/runs/:runId
```

- [x] **5.1 编写路由失败测试**

覆盖：正确详情、Workspace 越权返回 404、未知 Run 返回 404、`limit` 上限为 100、列表按 `updatedAt DESC`。

- [x] **5.2 实现聚合 API**

聚合逻辑放在 `routes/runs.ts` 或独立纯函数中，不把 UI 展示文本写进 Store。API 不返回完整 Prompt、密钥或内部思维链。

- [x] **5.3 编写前端数据归一化测试**

覆盖事件时间排序、重复文件变化去重、缺少 Git 变化时的空状态、失败 Run 的失败原因展示。

- [x] **5.4 实现 RunDetails**

固定展示顺序：原始需求、状态与耗时、参与 Agent、公开事件时间线、CLI 调用、修改文件、最终总结或失败原因、使用的项目记忆。

- [x] **5.5 从 ExecutionInspector 打开详情**

在已有时间线增加“查看本次执行详情”入口。保持右侧面板尺寸和现有聊天行为，不重做整个 Workspace 页面。

### 验收标准

- direct 和 group Run 都能从聊天历史打开详情。
- 刷新页面后详情内容不丢失。
- 失败、取消、无 Git、无文件变化都有明确空状态。
- Workspace A 的 Run 不能通过 Workspace B 的 URL 读取。
- Server 测试、Web 单元测试与 Web build 全部通过。

### 建议提交

```powershell
git add packages/shared/src/types/index.ts apps/server/src/routes/runs.ts apps/server/src/routes/runs.test.ts apps/server/src/index.ts apps/web/src/lib/runDetails.ts apps/web/src/lib/runDetails.test.ts apps/web/src/components/runs/RunDetails.tsx apps/web/src/components/chat/ExecutionInspector.tsx apps/web/src/app/workspace/[id]/page.tsx
git commit -m "feat: add traceable run history details"
```

---

## 6. 实现四类手动项目记忆 MVP

**目标：** 先让用户可靠地管理项目知识，再做自动提炼。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/services/MemoryService.ts`
- Create: `apps/server/src/services/MemoryService.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Modify: `apps/server/src/store/SqliteStore.test.ts`
- Create: `apps/server/src/routes/memories.ts`
- Create: `apps/server/src/routes/memories.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**

```ts
export type MemoryType = 'overview' | 'convention' | 'decision' | 'experience';
export type MemoryStatus = 'active' | 'archived';

export interface MemoryRecord {
  id: string;
  workspaceId: string;
  type: MemoryType;
  status: MemoryStatus;
  title: string;
  summary: string;
  contentPath: string;
  tags: string[];
  relatedFiles: string[];
  sourceRunIds: string[];
  importance: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
}
```

Markdown 固定目录：

```text
agent-memory/records/
├── overview/
├── conventions/
├── decisions/
└── experiences/
```

- [x] **6.1 编写 MemoryService 路径安全测试**

覆盖合法标题、重复标题、`../` 路径逃逸、非法类型、`importance/confidence` 超出 `0..100`、Workspace 未启用记忆。

- [x] **6.2 新增 SQLite 元数据和 FTS5 表**

创建 `memories`、`memory_sources` 和 `memory_fts`。`memory_fts` 索引 `title/summary/content/tags`；归档记录默认不参与检索。

- [x] **6.3 实现 Markdown 原子写入**

创建时先写同目录临时文件，rename 为 `memoryId.md` 后再插入数据库；数据库插入失败时删除刚创建的正文。更新时先把旧正文复制为同目录备份，再 rename 新正文并更新数据库；数据库更新失败时用备份恢复旧正文。成功后删除临时文件和备份。文件名只能使用 `memoryId.md`，不能直接使用未经处理的标题。

- [x] **6.4 实现 CRUD API**

```http
GET    /api/workspaces/:workspaceId/memories?query=&type=&status=active
POST   /api/workspaces/:workspaceId/memories
GET    /api/workspaces/:workspaceId/memories/:memoryId
PATCH  /api/workspaces/:workspaceId/memories/:memoryId
POST   /api/workspaces/:workspaceId/memories/:memoryId/archive
```

删除操作第一版不提供；归档代替删除，避免误删团队知识。

- [x] **6.5 兼容现有 Markdown**

现有 `PROJECT.md/DECISIONS.md/KNOWLEDGE.md/TEST.md/LOG.md` 不自动拆分、不删除。新系统只管理 `agent-memory/records/`，避免误改历史文件。

### 验收标准

- 四种类型均可创建、读取、更新和归档。
- 正文是可直接打开的 UTF-8 Markdown，元数据可在 SQLite 重启后恢复。
- 路径逃逸、跨 Workspace 访问和非法分值均返回 400/404。
- 归档记忆不出现在默认列表和默认检索中，但可通过显式状态过滤读取。
- 现有 `agent-memory/*.md` 文件内容完全保留。

### 建议提交

```powershell
git add packages/shared/src/types/index.ts apps/server/src/services/MemoryService.ts apps/server/src/services/MemoryService.test.ts apps/server/src/store/SqliteStore.ts apps/server/src/store/SqliteStore.test.ts apps/server/src/routes/memories.ts apps/server/src/routes/memories.test.ts apps/server/src/index.ts
git commit -m "feat: add workspace project memory MVP"
```

---

## 7. 增加项目记忆管理界面

**目标：** 用户可以查看来源、编辑内容和归档记忆，系统知识不成为不可解释黑箱。

**Files:**

- Create: `apps/web/src/lib/memories.ts`
- Create: `apps/web/src/lib/memories.test.ts`
- Create: `apps/web/src/components/memory/MemoryPanel.tsx`
- Create: `apps/web/src/components/memory/MemoryList.tsx`
- Create: `apps/web/src/components/memory/MemoryEditor.tsx`
- Create: `apps/web/src/components/memory/MemorySourceLinks.tsx`
- Modify: `apps/web/src/components/layout/WorkspaceLayout.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`

- [x] **7.1 编写前端 API 和表单校验测试**

覆盖：标题 trim、空标题拒绝、类型枚举、分值范围、API 错误保留用户输入、归档后列表刷新。

- [x] **7.2 增加“项目知识”入口**

在现有 Workspace 导航增加一个入口，不替换聊天主界面。默认展示 active 记忆，按更新时间倒序。

- [x] **7.3 实现类型筛选和搜索**

提供全部、项目概览、开发规范、架构决策、问题经验、已归档六个筛选项；搜索由服务端 FTS5 完成，前端不加载全部正文后本地过滤。

- [x] **7.4 实现编辑与来源查看**

编辑器必须显示标题、类型、摘要、正文、标签、相关文件、重要性、置信度、来源 Run。来源 Run 点击后打开第 5 阶段的 RunDetails。

- [x] **7.5 实现归档确认**

归档前明确显示记忆标题；成功后从 active 列表移除；失败时保留当前编辑内容并显示服务端错误。

### 验收标准

- 用户可以从 Workspace 导航进入项目知识页。
- 创建、编辑、搜索、筛选、查看来源和归档流程均可完成。
- API 失败不会清空表单或错误提示。
- 记忆正文中的 Markdown 在只读详情中正确渲染。
- `pnpm --filter @agentos/web build` 退出码为 `0`，真实浏览器流程通过。

### 建议提交

```powershell
git add apps/web/src/lib/memories.ts apps/web/src/lib/memories.test.ts apps/web/src/components/memory apps/web/src/components/layout/WorkspaceLayout.tsx apps/web/src/app/workspace/[id]/page.tsx
git commit -m "feat: add project memory management UI"
```

---

## 8. 实现记忆检索、Token 预算和上下文注入

**目标：** Agent 开始任务前只获得与当前请求相关的少量项目知识，并可以追踪使用来源。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/services/MemoryRetriever.ts`
- Create: `apps/server/src/services/MemoryRetriever.test.ts`
- Create: `apps/server/src/services/RunContextBuilder.ts`
- Create: `apps/server/src/services/RunContextBuilder.test.ts`
- Modify: `apps/server/src/services/ConversationService.ts`
- Modify: `apps/server/src/services/ConversationService.test.ts`
- Modify: `packages/agent-core/src/conversationRunner.ts`
- Modify: `packages/agent-core/src/conversationRunner.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`

**Interfaces:**

```ts
export interface MemorySearchInput {
  workspaceId: string;
  query: string;
  relatedFiles?: string[];
  types?: MemoryType[];
  limit: number;
  maxCharacters: number;
}

export interface MemoryUsage {
  runId: string;
  memoryId: string;
  rank: number;
  injectedCharacters: number;
  usedAt: string;
}
```

第一版固定预算：

```ts
const MAX_MEMORY_ITEMS = 5;
const MAX_MEMORY_CHARACTERS = 6000;
const MAX_SINGLE_MEMORY_CHARACTERS = 1800;
```

- [x] **8.1 编写确定性检索测试**

固定同一批 Memory，断言关键词匹配优先、相关文件匹配加权、归档项排除、超过字符预算时截断、相同输入得到相同顺序。

- [x] **8.2 实现 FTS5 检索**

检索顺序使用：FTS5 匹配排名、相关文件精确匹配、importance、updatedAt。不要加入随机数、模型评分或外部 embedding。

- [x] **8.3 实现 RunContextBuilder**

输出固定格式：

```markdown
## 与本次任务相关的项目记忆

### [decision] ADR 标题
摘要与受预算限制的正文
来源记忆：<memoryId>
```

没有命中时返回空字符串，不注入空标题。

- [x] **8.4 接入 direct 和 group 执行**

在 Runner 构建最终 Prompt 之前由服务端检索。群聊同一个 Run 只检索一次，群主与成员共享同一组正式记忆；成员之间的临时输出仍通过现有群聊委派文本传递。

- [x] **8.5 持久化 MemoryUsage**

增加 `run_memory_usage` 表，保存 Run 使用的 memoryId、排名和实际注入字符数；RunDetails 返回这些记录。

- [x] **8.6 验证 memoryEnabled=false**

关闭 Workspace 记忆时不检索、不注入、不创建 usage；聊天和群聊仍正常执行。

### 验收标准

- 相关任务最多注入 5 条、总计不超过 6000 字符的正式 active 记忆。
- 无关或已归档记忆不会被注入。
- 用户可以在 RunDetails 看到本次使用的记忆和来源。
- `memoryEnabled=false` 时行为与改造前一致。
- Prompt 不包含整库记忆，不包含候选或已归档记忆。
- MemoryRetriever、RunContextBuilder、ConversationService 和 ConversationRunner 测试全部通过。

### 建议提交

```powershell
git add packages/shared/src/types/index.ts apps/server/src/services/MemoryRetriever.ts apps/server/src/services/MemoryRetriever.test.ts apps/server/src/services/RunContextBuilder.ts apps/server/src/services/RunContextBuilder.test.ts apps/server/src/services/ConversationService.ts apps/server/src/services/ConversationService.test.ts packages/agent-core/src/conversationRunner.ts packages/agent-core/src/conversationRunner.test.ts apps/server/src/store/SqliteStore.ts
git commit -m "feat: inject relevant project memories into runs"
```

---

## 9. 实现 Run 结束后的“待确认记忆”

**目标：** 成功 Run 可以由用户触发生成结构化候选，但永久记忆必须经过用户确认。第一版不在后台自动调用模型，避免隐藏费用、额外等待和进程重启丢任务。

**Files:**

- Modify: `packages/shared/src/types/index.ts`
- Create: `apps/server/src/services/MemoryCandidateService.ts`
- Create: `apps/server/src/services/MemoryCandidateService.test.ts`
- Create: `apps/server/src/services/MemoryExtractor.ts`
- Create: `apps/server/src/services/MemoryExtractor.test.ts`
- Modify: `apps/server/src/store/SqliteStore.ts`
- Create: `apps/server/src/routes/memoryCandidates.ts`
- Create: `apps/server/src/routes/memoryCandidates.test.ts`
- Modify: `apps/server/src/index.ts`
- Create: `apps/web/src/components/memory/MemoryCandidateQueue.tsx`
- Modify: `apps/web/src/app/workspace/[id]/page.tsx`

**Interfaces:**

```ts
export type MemoryCandidateStatus = 'pending' | 'accepted' | 'rejected';

export interface MemoryCandidate {
  id: string;
  workspaceId: string;
  runId: string;
  type: MemoryType;
  title: string;
  summary: string;
  content: string;
  confidence: number;
  operation: 'create' | 'update' | 'merge' | 'ignore';
  conflictingMemoryIds: string[];
  status: MemoryCandidateStatus;
  createdAt: string;
  reviewedAt?: string;
}
```

- [x] **9.1 编写候选状态机测试**

覆盖 `pending -> accepted`、`pending -> rejected`；accepted/rejected 不得再次审批；失败 Run 默认不生成候选；接受候选后创建正式 MemoryRecord 并保留 sourceRunId。

- [x] **9.2 实现结构化提取器边界**

提取器输入只包含原始需求、公开结果摘要、文件变化和用户可见回复。输出必须通过运行时 JSON 校验；解析失败只记录“未生成候选”，不能把 Run 标记为失败。

候选生成入口固定为已完成 Run 的显式操作；同一 Run 重复生成时，先返回现有 pending 候选，除非请求中明确传入 `force=true`。失败、取消和仍在运行的 Run 返回 409。

- [x] **9.3 实现去重和冲突提示**

使用同 Workspace、同类型的 FTS5 标题/摘要检索寻找最多 5 条相似正式记忆。相似项只写入 `conflictingMemoryIds`，不得自动覆盖或合并。

- [x] **9.4 实现候选 API**

```http
GET  /api/workspaces/:workspaceId/memory-candidates?status=pending
POST /api/workspaces/:workspaceId/runs/:runId/memory-candidates/generate
POST /api/workspaces/:workspaceId/memory-candidates/:candidateId/accept
POST /api/workspaces/:workspaceId/memory-candidates/:candidateId/reject
```

接受时允许用户编辑标题、摘要和正文后再写入正式记忆。

- [x] **9.5 实现待确认队列 UI**

RunDetails 对 completed Run 显示“生成记忆候选”；候选队列展示类型、标题、摘要、来源 Run、置信度、冲突记忆链接。审批按钮只有“编辑后接受”和“拒绝”，不提供“一键接受全部”。

### 验收标准

- 用户对成功 Run 发起生成后最多得到 3 条候选；失败、取消和运行中 Run 不能生成。
- 候选生成失败不影响原 Run 的 completed 状态。
- 用户接受前，候选不会进入正式检索和 Prompt 注入。
- 接受后正式记忆带有 sourceRunId；拒绝后保留审计状态但不参与检索。
- 相似记忆只提示冲突，不自动覆盖。
- fake extractor、候选状态机、API 和 UI 流程全部通过。

### 建议提交

```powershell
git add packages/shared/src/types/index.ts apps/server/src/services/MemoryCandidateService.ts apps/server/src/services/MemoryCandidateService.test.ts apps/server/src/services/MemoryExtractor.ts apps/server/src/services/MemoryExtractor.test.ts apps/server/src/store/SqliteStore.ts apps/server/src/routes/memoryCandidates.ts apps/server/src/routes/memoryCandidates.test.ts apps/server/src/index.ts apps/web/src/components/memory/MemoryCandidateQueue.tsx apps/web/src/app/workspace/[id]/page.tsx
git commit -m "feat: add reviewable memory candidates"
```

---

## 10. 全链路验收、迁移验证和文档收尾

**目标：** 证明新系统在真实 Windows 环境、旧数据库、单聊、群聊和记忆启停场景下可用。

**Files:**

- Modify: `README.md`
- Modify: `docs/AGENTOS_V2.md`
- Create: `docs/MEMORY_SYSTEM.md`
- Create: `docs/acceptance/agentos-memory-acceptance.md`
- Modify: `agent-memory/DECISIONS.md`
- Modify: `agent-memory/LOG.md`

- [x] **10.1 执行全量自动化验证**

```powershell
pnpm install --frozen-lockfile
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/server test
pnpm --filter @agentos/web build
pnpm -r run build
```

每条命令必须记录退出码、测试数量和失败名称；任一失败不得继续标记项目完成。

- [x] **10.2 验证旧数据库迁移**

复制一份改造前的 `.agentos/agentos.sqlite` 到临时验收目录，启动新 Store，确认原 Workspace、Agent、Conversation、Message、Execution 和 ExecutionEvent 数量不减少，再创建一条新 Run。

- [x] **10.3 验证 direct conversation**

发送涉及已有项目知识的问题，确认创建 Run、记录 Execution、检索相关 Memory、产生 MemoryUsage、完成后可打开 RunDetails。

- [ ] **10.4 验证 group conversation**

使用至少三名 Agent，确认一个 Run 下存在群主规划、成员执行和群主总结多个 Execution；同一组检索记忆被共享；最终总结和失败成员均可追溯。

- [x] **10.5 验证失败、取消和重启恢复**

分别触发非零退出码、用户取消和 Server 中断。确认 Run 终态正确；重启后不得残留永久 `running` 状态，恢复策略必须写入验收文档。

- [x] **10.6 验证记忆治理**

创建四类记忆；归档其中一条；确认归档项不被检索；生成候选并拒绝一条、接受一条；确认只有正式 active 记忆进入下一次 Prompt。

- [x] **10.7 更新文档和架构决策**

`docs/MEMORY_SYSTEM.md` 必须说明：数据模型、目录结构、检索预算、来源追踪、候选审批、隐私边界、迁移与备份。`DECISIONS.md` 记录“不使用向量数据库”“不自动写永久记忆”“只记录可观察执行证据”三项决策。

### 最终验收标准

- 全量测试和构建命令退出码全部为 `0`。
- 旧数据库升级后历史数据数量不减少。
- direct、group、失败、取消、重启恢复五条真实路径均有验收证据。
- RunDetails 可以还原需求、Agent、事件、CLI 调用、文件变化、记忆来源和最终结果。
- 记忆 CRUD、FTS5 检索、预算注入、来源追踪和候选审批全部可用。
- 不存在未经审批直接进入 Prompt 的候选记忆。
- 不存在 API Key、完整 Prompt、访问令牌或私有思维链泄漏。
- README、V2 文档、Memory 文档、DECISIONS 和 LOG 与实际实现一致。

### 建议提交

```powershell
git add README.md docs/AGENTOS_V2.md docs/MEMORY_SYSTEM.md docs/acceptance/agentos-memory-acceptance.md agent-memory/DECISIONS.md agent-memory/LOG.md
git commit -m "docs: complete AgentOS memory system acceptance"
```

---

## 阶段执行顺序与停止条件

必须严格按以下顺序执行：

1. 基线与编码确认。
2. AgentRun 数据模型。
3. 统一事件模型。
4. 可观察执行证据。
5. Run 历史详情。
6. 手动 Memory MVP。
7. Memory 管理 UI。
8. 检索与上下文注入。
9. 待确认记忆。
10. 全链路验收。

每完成一个阶段先执行该阶段验收。以下任一情况出现时必须停止进入下一阶段：

- 数据库迁移导致旧数据数量减少。
- 既有单聊、群聊、SSE 或取消行为回归。
- Workspace 隔离测试失败。
- Prompt 或日志出现密钥、完整凭据或私有思维链。
- 阶段自动化测试或 build 非零退出。
- 当前阶段的真实 UI 验收无法复现。

## 建议的里程碑切分

| 里程碑 | 包含计划项 | 可独立交付结果 |
|---|---:|---|
| M1 执行可追溯 | 1–5 | 每次请求形成 AgentRun，并可查看完整执行详情 |
| M2 手动项目记忆 | 6–7 | 用户可可靠管理四类项目知识 |
| M3 智能上下文 | 8 | Agent 自动获得有限、相关、可追踪的项目记忆 |
| M4 知识沉淀闭环 | 9–10 | 成功任务可生成可审批候选，并完成真实验收 |

建议每个里程碑单独发布。M1 未通过前不得开始 M2；M2 未经过实际使用不得开始 M3；M3 的检索质量未稳定前不得启用 M4 的候选生成。

## 收尾增补验收（2026-07-14）

- [x] 事件持久化失败不会被吞掉
- [x] 验收脚本独立管理服务生命周期
- [x] 已完成 Run 耗时固定
- [x] 无隐藏标记的成功任务可生成候选
- [x] 单聊 waiting_user 可恢复
- [ ] 真实外部 Agent 单聊和群聊通过
- [x] 阶段性提交和最终工作区清理完成
