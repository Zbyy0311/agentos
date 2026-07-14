# AgentOS 下一阶段优化全链路验收

记录日期：2026-07-14
工作区：`E:\workspace\Multi-Agent\agentos`

## 自动化入口与结果

统一入口：`scripts/verify-next-optimization-acceptance.ps1`

本记录只引用实际执行结果；测试中的 `node` 子进程代表真实 CLI 进程边界，Mock 测试用于不依赖外部 Agent 安装的稳定回归。外部 Codex/Kimi/OpenCode CLI 的完整浏览器链路受当前本机 CLI 进程环境影响，未冒充已通过。

| 检查 | 命令 | 结果 |
|---|---|---|
| frozen install | `pnpm install --frozen-lockfile` | 通过，退出码 0 |
| shared build | `pnpm --filter @agentos/shared build` | 通过，退出码 0 |
| Agent Core | `pnpm --filter @agentos/agent-core test` | 通过，74/74 |
| Server | `pnpm --filter @agentos/server test` | 通过，73/73 |
| Web build | `pnpm --filter @agentos/web build` | 通过，退出码 0 |
| Monorepo build | `pnpm -r run build` | 通过，4/5 workspace 项目构建，退出码 0 |
| API 健康检查 | `http://localhost:3000/api/health` | 已验证 HTTP 200 |
| Web 健康检查 | `http://localhost:3001/` | 已验证 HTTP 200 |

## 验收路径

1. 旧数据库迁移：`SqliteStore.test.ts` 构造旧版 conversations/messages/executions/execution_events，打开新 Store 后验证历史行数不减少、Execution 自动关联 legacy Run，且不重建原执行表。
2. Direct：`ConversationService.test.ts` 覆盖 Mock direct 持久化、真实 `node` 子进程成功、非零退出失败和 AbortSignal 取消；Run、Execution、终态和公开回复均可读取。
3. Group：覆盖两 Agent 群聊、三 Agent 并行成员执行和成员失败；所有 Execution 共享一个 Run，成员失败不会抹掉其他执行记录。
4. 重启恢复：`runRecovery.test.ts` 验证遗留 `queued/running` 变为“服务重启导致执行中断”，终态 Run 不修改。
5. RunDetails：路由聚合需求、状态耗时、参与 Agent、公开事件、CLI 元数据、文件变化、最终总结/失败原因和记忆用量；Workspace 越权返回 404。
6. 记忆治理：四类 Memory CRUD/归档、FTS5 与安全回退、5 条/6000/1800 字符预算、来源 Run、候选最多 3 条；pending 候选在接受前不进入正式记忆或检索，接受后才进入并保留来源，拒绝后保留审计状态。

## 隐私边界

- SQLite 和 AgentOS 持久化日志只保存公开状态、脱敏 CLI 标签、模型/思考强度、退出码、耗时、相对文件路径和用户可见结果。
- 诊断日志不写入完整参数、Prompt、CLI stdout/stderr；任务日志只保存输出长度和“content omitted”标记。
- 不保存 API Key、访问令牌或私有思维链；候选提取只接受结构化公开结果中的显式候选标记。

## 浏览器复核

3001 保持运行。内置浏览器已打开 Workspace，确认单聊消息和执行完成状态可见；刷新后消息和执行历史仍在；“项目知识”入口可打开并显示记忆管理面板，包含六个筛选项、标签/相关文件字段和 Markdown 只读预览。窄视口下 RunDetails 的第三侧栏按钮会按响应式布局隐藏，但 DOM 和构建产物包含详情入口；需要完整展示时扩大窗口即可。外部真实 Agent CLI 群聊和候选审核未在当前 CLI 进程环境中宣称通过。

## 文档与决策

- `README.md`、`docs/AGENTOS_V2.md` 链接并说明 AgentRun、RunDetails、Memory 和候选审批。
- `docs/MEMORY_SYSTEM.md` 说明数据模型、目录、预算、来源、审批、隐私、迁移和备份。
- `agent-memory/DECISIONS.md` 明确不使用向量数据库、不自动写永久记忆、只记录可观察执行证据。
- `agent-memory/LOG.md` 记录实施、验证命令和当前浏览器限制。

## 验收脚本说明

统一脚本中的构建、测试和 monorepo build 阶段均通过；此前一次脚本末尾健康检查因 `next dev` 与 `next build` 同时写入同一 `.next` 目录而出现缺失 chunk。已清理 `.next`、重新单独启动 3001，并再次确认 Web HTTP 200；当前开发服务未与构建并行运行。

## 收尾 E2E 记录（2026-07-14）

新增 `scripts/verify-agentos-e2e.ps1`、`scripts/verify-agentos-e2e.mjs` 及两个确定性 fixture。脚本在临时根目录启动 Server，使用临时 SQLite 和 Markdown 记忆目录，不使用 `AGENTOS_FORCE_MOCK`，也不输出 API Key、完整 Prompt 或 CLI 原始输出。

当前 gate 结果：

- `DETERMINISTIC_LIFECYCLE: passed`：普通单聊等待、resume 同一 Run 新 Execution、失败 Run，以及候选生成 409。
- `RECOVERY: passed`：重启后 queued/running 标记 failed，waiting_user 保持。
- 最新复验中 `MEMORY_CANDIDATE: failed`：候选流程依赖的后续真实 Agent 执行未完成，因此本次不能把候选生成、接受、拒绝和重新检索标记为 release gate 通过。此前曾有一次 Kimi 候选闭环通过，但不作为本次稳定性结论。
- `REAL_EXTERNAL_AGENT: failed`：本次 Codex 和 OpenCode CLI 返回退出码 1；Kimi 单聊一次通过但后续执行不稳定；真实三 Agent 群聊、真实等待用户尚未满足 release gate。
- 本次预恢复阶段输出 `RECOVERY: not_run`，重启恢复阶段输出 `RECOVERY: passed`；这是脚本按阶段隔离 gate 后的预期结果。
- 后续空目录 CLI 探针（不读取 AgentOS 私有 Workspace）确认：Codex 固定短提示 exit 0，OpenCode 固定短提示 exit 0；Kimi 的 OAuth 参数路径和按 AgentOS 映射的 API-Key 路径均返回 exit 1，错误为当前计费周期用量已达上限（HTTP 403）。因此完整三 Agent release gate 仍不能通过，且未将空目录探针替代 E2E。

因此本记录明确区分“自动化/确定性回归通过”和“真实外部 Agent release gate 未通过”，计划不能据此标记为全部完成。
