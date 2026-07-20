# AgentOS v2 聊天协作说明

## Execution Workbench（计划 B）

计划 B 已将执行过程升级为可回放工作台：AgentEvent 具备 SQLite 持久化 sequence，RunStep 支持 stable key、状态机、attempt 和 waiting resume；Web Inspector 展示当前动作、任务树、工具历史、统计和静态执行档案。消息支持安全 GFM、代码/diff 和 Artifact 预览，验收入口为 `docs/acceptance/execution-workbench-final.md` 与 `scripts/verify-execution-workbench.ps1`。

## Provider Runtime 状态

Provider 与 collaboration role 分离。`WorkspaceAgent.provider` 是配置身份，Adapter `probe()` 返回 `detectedProvider` 与结构化、工具、usage、只读和审批能力；mismatch 会通过诊断、Run invocation 和 Agent Editor 对外可见。Kimi 适配器已按本机 `0.23.5` help/stream-json 能力实现，OpenCode `1.17.11` 已完成真实 lifecycle gate，详见 `docs/acceptance/`。

## 运行要求

- Node.js `>= 22.5`：服务端使用内置 `node:sqlite` 保存 v2 聊天数据。
- 旧的 `workspace/workspaces.json` 与各 Workspace 的任务 JSON 保持兼容；首次启动会把已有 Agent 配置导入 SQLite。
- v2 数据库位于 `.agentos/agentos.sqlite`，不会提交到 Git。

## 使用方式

1. 打开一个 Workspace，选择左侧 Agent，点击“新建会话”。
2. 在聊天输入框发送消息；消息会直接调用对应 CLI，并通过 SSE 返回公开执行状态与回复。
3. 右侧“执行状态”展示准备上下文、调用 CLI、生成回复、完成/失败/取消等公开进度及历史事件。
4. 通过“编辑身份”更新 Agent 显示名、职责、系统提示、模型标识、启用状态和权限。CLI 命令与参数仍由 Workspace 配置管理。

## 群聊与标准开发团队

- 创建群聊至少选择两名已启用 Agent，并指定唯一群主。
- 群主负责：公开计划、依次委派成员、汇总最终结论。
- “标准开发团队”模板会选中 Codex、KimiCode、OpenCode：
  `Codex 规划 → KimiCode 执行 → OpenCode 审查 → Codex 总结`。
- 每一轮群聊都会持久化用户消息、每名 Agent 的执行、公开状态事件和回复；每名 Agent 完成后会立即通过 SSE 推送到聊天区，便于实时跟进与历史追溯。

## 安全与可见性边界

- 右侧状态面板只显示可观察的 CLI 执行进度、公开输出摘要和错误；不保存或展示模型私有思维链。
- 会话、消息、执行和成员关系均严格按 Workspace 隔离。
- Agent 禁用后不可发起新执行；身份权限在服务端配置中保存。
- 真实模式下，未授予 `write` 的 Codex CLI 会强制使用 `read-only` sandbox；其他无法确认只读能力的 CLI 会被拒绝执行。

## AgentRun 与项目知识

每条用户请求对应一个 `AgentRun`；群聊中规划、成员执行和最终总结的多个 `AgentExecution` 共享同一个 `runId`。Run 详情只展示可观察证据：公开事件、脱敏 CLI 标签与耗时、退出码、工作区相对文件变化、最终结果和使用的正式记忆。

项目知识由 `agent-memory/records/{overview,conventions,decisions,experiences}/` 下的 Markdown 正文和 SQLite 元数据组成。检索使用 FTS5，并受最多 5 条、总计 6000 字符、单条 1800 字符的预算限制；归档记忆和待审核候选不会进入 Prompt。完成 Run 后可生成最多 3 条候选，只有接受后才写入正式记忆，并保留来源 Run。

详细数据模型、迁移、备份和隐私边界见 [`docs/MEMORY_SYSTEM.md`](MEMORY_SYSTEM.md)。

## 分阶段任务顺序与验收

| 阶段 | 交付内容 | 验收标准 | 当前状态 |
|---|---|---|---|
| 0 | v2 数据模型与旧数据迁移 | 旧 Workspace Agent 仅迁移一次，聊天数据按 Workspace 隔离 | 已完成 |
| 1 | Agent 身份、权限与历史会话 | 可编辑身份；选择 Agent 后仅显示其私聊历史 | 已完成 |
| 2 | 单 Agent 聊天与实时状态 | 输入消息可调用 CLI；SSE 顺序显示排队、准备、执行、回复、完成 | 已完成 |
| 3 | 右侧执行状态 | 仅展示可观测状态、公开摘要和权限，不展示私有思维链 | 已完成 |
| 4 | 群聊与角色协作 | 至少两名成员、唯一群主；按群主规划、成员执行、群主总结顺序持久化并实时推送 | 已完成 |
| 5 | 页面视觉与交互验收 | 群聊标题正确切换；Markdown 标题、列表和代码块可读；输入框和时间线正常滚动 | 待人工刷新确认 |

## Codex Runtime 与 RuntimeArtifact

Codex 通过 Adapter 将 JSONL 转换为统一事件，Kimi 使用 `stream-json`，OpenCode 使用数据库增量 usage；未适配字段保持安全的 plain 文本降级。Artifact 元数据写入 SQLite，内容以不可变快照保存在 `.agentos/artifacts/<workspace>/<run>/<artifact>/content`，按类型限制大小并记录 SHA-256。Artifact 包括文件快照、Git diff、测试报告、图片和公开运行日志；删除会话时清理对应快照。当前 Codex sandbox 入口、Kimi 和 OpenCode 的真实 Provider Gate 均已通过，详见 [`agentos-provider-gates.md`](acceptance/agentos-provider-gates.md)。

## 核心 API

- `GET /api/workspaces/:workspaceId/agents`
- `PATCH /api/workspaces/:workspaceId/agents/:agentId`
- `GET|POST /api/workspaces/:workspaceId/conversations`
- `PATCH /api/workspaces/:workspaceId/conversations/:conversationId`
- `GET /api/workspaces/:workspaceId/conversations/:conversationId/messages`
- `GET /api/workspaces/:workspaceId/conversations/:conversationId/executions`
- `POST /api/workspaces/:workspaceId/conversations/:conversationId/messages/stream`
- `GET /api/workspaces/:workspaceId/runs`
- `GET /api/workspaces/:workspaceId/runs/:runId`
- `GET|POST /api/workspaces/:workspaceId/memories`
- `PATCH /api/workspaces/:workspaceId/memories/:memoryId`
- `POST /api/workspaces/:workspaceId/memories/:memoryId/archive`
- `GET|POST /api/workspaces/:workspaceId/memory-candidates`

最后一个接口使用 SSE，发送 `execution`、`message`、`done` 与 `error` 事件。

## 等待用户补充与隔离验收

单聊等待用户补充信息时，Run 会进入 `waiting_user` 并保留问题、等待 Execution 和 Agent；恢复使用：

```http
POST /api/workspaces/:workspaceId/conversations/:conversationId/runs/:runId/resume/stream
Content-Type: application/json

{"content":"用户补充的信息"}
```

恢复会在同一 Run 下创建新的 Execution，原始消息、事件、CLI 调用和文件证据保持可追溯；群聊返回等待标记时明确失败，不进入半等待状态。

生产验收使用 `scripts/verify-next-optimization-acceptance.ps1` 的 3100/3101 隔离生命周期，以及 `scripts/verify-agentos-e2e.ps1` 的临时数据库和确定性 fixture。脚本输出 `REAL_EXTERNAL_AGENT`、`DETERMINISTIC_LIFECYCLE`、`RECOVERY`、`MEMORY_CANDIDATE` 四个 gate。
# AgentOS V2 协作运行时

## 当前已落地

- Agent Presence：统一展示 idle、queued、working、waiting、failed。
- Collaboration Role：leader、worker、reviewer、specialist 与显式 sequence。
- Group Dispatch：leader_route、full_pipeline、mentioned_only；mentions 不会越权调用非成员。
- Partial Write Decision：写入失败有文件变化时暂停 Run，等待用户选择并可幂等恢复。
- Run Intent：ask、execute、review；每次 Run 保存 RuntimePolicy 快照。
- Approval 基础设施：风险分类、审批请求/决策、授权 grant、撤销 API 及 UI 卡片。
- Isolation Release：clean-base Worktree lease、recovery bundle、容量统计与显式 retention token。

## 安全边界

Provider、协作角色和 Agent permissions 是三层独立概念。工作区只读只有在 provider 能力可证明时才对外承诺；否则 ask/review 在启动前返回 409。共享工作区不自动回滚，也不保存 reasoning 或原始 CLI 日志。

## 下一阶段

继续补齐 provider 原生审批 stdin 等待和 SQLite lease 持久化；真实 Codex/Kimi/OpenCode lifecycle 与双 Agent `parallel_isolated` Worktree Gate 已通过，后续可在保持显式 recovery/cleanup 边界的前提下扩展发布范围。
