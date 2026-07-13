# AgentOS v2 聊天协作说明

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

## 分阶段任务顺序与验收

| 阶段 | 交付内容 | 验收标准 | 当前状态 |
|---|---|---|---|
| 0 | v2 数据模型与旧数据迁移 | 旧 Workspace Agent 仅迁移一次，聊天数据按 Workspace 隔离 | 已完成 |
| 1 | Agent 身份、权限与历史会话 | 可编辑身份；选择 Agent 后仅显示其私聊历史 | 已完成 |
| 2 | 单 Agent 聊天与实时状态 | 输入消息可调用 CLI；SSE 顺序显示排队、准备、执行、回复、完成 | 已完成 |
| 3 | 右侧执行状态 | 仅展示可观测状态、公开摘要和权限，不展示私有思维链 | 已完成 |
| 4 | 群聊与角色协作 | 至少两名成员、唯一群主；按群主规划、成员执行、群主总结顺序持久化并实时推送 | 已完成 |
| 5 | 页面视觉与交互验收 | 群聊标题正确切换；Markdown 标题、列表和代码块可读；输入框和时间线正常滚动 | 待人工刷新确认 |

## 核心 API

- `GET /api/workspaces/:workspaceId/agents`
- `PATCH /api/workspaces/:workspaceId/agents/:agentId`
- `GET|POST /api/workspaces/:workspaceId/conversations`
- `PATCH /api/workspaces/:workspaceId/conversations/:conversationId`
- `GET /api/workspaces/:workspaceId/conversations/:conversationId/messages`
- `GET /api/workspaces/:workspaceId/conversations/:conversationId/executions`
- `POST /api/workspaces/:workspaceId/conversations/:conversationId/messages/stream`

最后一个接口使用 SSE，发送 `execution`、`message`、`done` 与 `error` 事件。
