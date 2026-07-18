# AgentOS 可观察协作工作台升级总计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 AgentOS 的下一阶段升级拆成五份可独立执行、验证和停止的计划，避免一个 Agent 连续修改 Provider、数据库、前端、群聊、安全、Git 与扩展系统造成上下文漂移。

**Architecture:** 保留 `CLIExecutor -> Provider Adapter -> EventBus/SQLite -> SSE -> React` 主链路。A-D 依次完成 Provider Runtime、执行工作台、角色化协作、Worktree 与发布；E 独立建设 CLI 原生 Skills/Plugins/MCP 的发现、管理和审计，不重新实现各 CLI 的扩展 Runtime。

**Tech Stack:** Node.js >= 22.5、TypeScript、Express、`node:sqlite`、Next.js 14、React 18、SSE、Vitest、Node Test Runner、Playwright、PowerShell、pnpm workspace、Git worktree。

## Global Constraints

- 默认中文 UI、文档和用户可见错误；新增文本使用 UTF-8 无 BOM。
- 不重写 monorepo，不引入 WebSocket、Redis、Kafka、向量数据库或云控制面。
- 不记录或展示模型私有思维链；只展示公开状态、工具、产物、审批和总结。
- CLI Provider、协作角色、权限策略必须是三个独立概念。
- Provider 工具轨迹只来自结构化事件；plain fallback 不得用正则伪造。
- SQLite schema 只做向前迁移；旧数据库启动后记录数不得减少。
- 当前工作区存在未提交修改；任何实施必须先完成计划 A 的安全基线与恢复点。
- 每份计划先写失败测试，再最小实现，再执行局部、全量和真实运行 Gate。
- 每份计划完成后停下来验收；不得把后续计划的功能顺手塞入当前批次。

---

## 1. 拆分后的执行计划

### 计划 A：Provider Runtime

[打开计划 A](./2026-07-18-agentos-provider-runtime.md)

范围：

1. 实施前环境冻结、完整 patch、未跟踪文件和 SQLite 备份。
2. 在任何新增高风险写接口前建立 loopback、CORS allowlist 和 Origin 防线。
3. 收口当前 Execution Inspector 与 OpenCode usage 改动。
4. 将配置 Provider、检测 Provider、命令路径和 Agent 身份分离。
5. 合并 Adapter/Probe 重复职责。
6. KimiCode `stream-json` Adapter 与真实 Gate。
7. OpenCode 安装/路径/结构化能力硬闸门与真实 Gate。

验收标准：

- 可从备份恢复实施前 tracked、untracked 和 SQLite 状态。
- 当前及后续危险写接口统一经过本地 API 安全中间件，不能由恶意 Origin 触发。
- `AGENTOS_OPENCODE_CLI=codex` 显示“配置 OpenCode / 实际 Codex”，并使用 Codex parser，不静默冒充 OpenCode。
- Kimi 结构化文字、工具和 usage 经真实 AgentOS 链路通过。
- OpenCode 未安装时保持明确 blocked，不创建伪造 fixture。

### 计划 B：执行工作台

[打开计划 B](./2026-07-18-agentos-execution-workbench.md)

范围：

1. 为 AgentEvent 增加 SQLite 持久化 `sequence`，不再用 timestamp 作为顺序真相。
2. RunStep 幂等 stable key、正确索引、attempt、waiting/resume 和重启 reconcile。
3. 右侧任务树、当前动作、工具、usage 和文件统计。
4. GFM Markdown、表格、代码高亮、Diff、长内容折叠、滚动锚点和长会话虚拟列表。
5. 静态可筛选执行档案与 Artifact 内联预览；不做视频式播放控制。

验收标准：

- 新旧数据库均可迁移，AgentEvent/RunStep 顺序由 sequence 决定。
- Server 重启后 Run、Execution 与 RunStep 终态一致，不残留 running。
- Markdown 表格不再显示成原始文本，代码块和 Diff 可读。
- 1000 个事件、100 个工具调用和长会话下 UI 可操作且无重复事件。

### 计划 C：角色化协作与审批

[打开计划 C](./2026-07-18-agentos-role-collaboration.md)

范围：

1. Presence 禁用优先级和 Workspace 全局状态。
2. 显式 `CollaborationRole`，不再用 Provider 或 permissions 推断 Reviewer。
3. `leader_route / full_pipeline / mentioned_only` 与 `@Agent` 路由。
4. Leader waiting_user 在同一 Run/RunStep 中恢复。
5. 共享工作区写入失败且产生变更时暂停，不默认带着残缺修改继续。
6. ask/execute/review 的工作区写入、网络、工具与 enforcement 审计。
7. Provider 支持时透传原生工具审批；不支持时只提供运行前策略，不伪造逐工具拦截。

验收标准：

- Provider、协作角色和权限能自由组合。
- 简单群聊默认由 leader 路由，不会每句话都启动完整团队。
- 写入失败并产生变化时 Run 进入 waiting_user，用户明确选择后才继续。
- “工作区只读”文案准确展示 enforcement 和 Provider 限制。

### 计划 D：Worktree、容量、安全与发布

[打开计划 D](./2026-07-18-agentos-isolation-release.md)

范围：

1. `parallel_isolated` 第一版强制主工作区 clean。
2. Worktree branch/path 使用 executionId，支持重试和同 Agent 多 turn。
3. tracked patch + untracked archive + manifest，清理前校验全部 Artifact。
4. usage source/provider/model/estimated 元数据。
5. 事件/Artifact/Workspace 容量报告和显式 retention。
6. 对计划 A 已建立的本地 API 防线做全量高风险路由回归与远程模式收口。
7. Playwright 自动浏览器 Gate、性能 Gate、真实 CLI Gate 与发布文档。

验收标准：

- 脏工作区启动 isolated Run 返回 409，不静默基于旧 HEAD 执行。
- 新建未跟踪文件可从 Artifact 完整恢复后才允许 force remove worktree。
- 删除 Worktree 等写接口不能被非允许 Origin 的浏览器请求触发。
- 一键验收实际启动 Playwright，保存截图并自动收集 console error。

### 计划 E：Skills / Plugins / MCP Extension Center

[打开计划 E](./2026-07-18-agentos-extension-center.md)

范围：

1. Provider 扩展能力发现与不可用原因。
2. 用户级、项目级、Agent 级、会话级 Skill Registry。
3. MCP Server 清单、传输类型、状态、工具列表和环境变量脱敏。
4. 插件来源、版本、hash、信任与 Workspace 授权。
5. Run 对 Skill/MCP/插件工具的版本与配置 hash 审计。

验收标准：

- AgentOS 只管理、展示和审计 CLI 原生扩展，不复制其 Runtime。
- 导入 Workspace 后第三方扩展默认不信任。
- 敏感环境变量值不进入 API、SQLite 公开事件或 UI。
- Run Details 能回答“本次使用了哪个扩展、什么版本、什么配置 hash”。

---

## 2. 强制执行顺序

```text
A Provider Runtime
  -> 人工确认 Provider 真实 Gate
  -> B 执行工作台
  -> 人工确认聊天与长任务体验
  -> C 角色化协作与审批
  -> 人工确认群聊路由和失败暂停
  -> D Worktree、安全与发布

E 在架构上不阻塞 B-D，但为避免长期分支漂移，推荐在 D6 人工验收后从其确认 HEAD 创建独立 Extension Center 分支。
其中 E0 依赖 A3 Provider 身份模型，E2-E4 写接口依赖 A1 本地 API 防线，E5 使用审计依赖 B1 persisted sequence。
```

不得跨越的硬闸门：

- A 的安全基线未完成，不得修改业务代码或数据库 schema。
- A1 本地 API 安全基础未完成，不得注册 run decision、approval resolve、worktree remove、retention apply、extension assignment、extension trust 或 MCP control 等危险写接口。
- A 的 Provider 身份未分离，不得新增 Kimi/OpenCode Adapter 分支。
- B 的 persisted sequence 未完成，不得实现执行档案排序。
- B 的 RunStep reconcile 未完成，不得接入群聊 steps。
- C 的串行路由未完成，不得启用 `parallel_isolated`。
- D 的 patch + untracked 恢复链路未完成，不得 force remove 脏 worktree。
- D 的安全回归未覆盖全部危险写接口，不得宣告发布 Gate 通过。
- E 的 Extension 控制、信任和 MCP start/stop 写接口在 A1 未完成时不得注册；E0-E1 只能只读发现。
- B1 persisted sequence 未完成，不得把 Extension 使用记录标为可重放、幂等的历史审计。

---

## 3. 对审阅意见的处理结论

### 已采纳并进入 A-D

- Task 0 安全基线、备份和回滚点。
- 配置 Provider 与实际命令/检测 Provider 分离。
- Adapter 自己负责 probe、invocation 和 parser，删除重复能力判断。
- RunStep 使用 `UNIQUE(run_id, stable_step_key)` 和 `(run_id, parent_step_id, sequence)`，不再把 id 放入伪唯一顺序索引。
- RunStep stable key、attempt、waiting resume 和重启 reconcile。
- disabled Presence 先于运行状态判断。
- 显式 collaboration role、群聊 dispatch mode 和 `@Agent`。
- 写入 Worker 失败且有文件变化时暂停。
- Worktree clean 前置、executionId 路径、untracked archive。
- AgentEvent persisted sequence。
- “工作区只读”精确文案和 enforcement 审计。
- 聊天 Markdown/代码/Diff/滚动/虚拟列表。
- 静态执行档案替代视频式 Replay。
- Playwright 自动浏览器 Gate。
- usage 来源、容量、本地 API 安全和性能 Gate。

### 需要按当前代码事实修正的意见

- 现有 SSE cursor 只存在于 `RunStreamRegistry` 的 60 秒内存重放窗口，SQLite `agent_events` 仍按 `timestamp, rowid` 排序。因此计划 B 新增 persisted `sequence`，而不是直接复用现有 cursor。
- 共享工作区上的自动回滚暂不提供：即使串行执行，也无法证明用户没有同时编辑相同文件。第一版在“写入失败 + 有变化”时暂停，允许保留并继续、重试或终止；可靠回滚由计划 D 的 Worktree Artifact 恢复承担。
- CLI 不一定暴露可暂停的逐工具审批协议。计划 C 只对明确支持 permission request/resume 的 Provider 做审批透传；其他 Provider 使用运行前沙箱/权限策略并显示 `unsupported`。

### 独立规划，不塞入 A-D

- Skills、Plugins、MCP 作为计划 E Extension Center。
- 自动 merge、自动 cherry-pick、自动冲突解决继续不在本轮范围。
- 云端控制面、Redis/Kafka/向量数据库继续不在范围。

### 第二轮执行前审阅已修订

- A0 改用 `git diff HEAD --binary --output`，同时覆盖 staged/unstaged 且不经过 PowerShell 文本编码；保存真实 base HEAD。
- 备份与恢复前都要求停止 AgentOS；SQLite 使用 `wal_checkpoint + VACUUM INTO + integrity_check`，并额外保存 JSON Workspace/Task fallback 状态。
- RunStep mutation 与 AgentEvent sequence/event insert 在同一 SQLite transaction 内提交；提交后只广播 persisted event，subscriber 错误隔离。
- Local API Security 提前为计划 A1，后续所有危险写路由自动继承，不再等到 Worktree 阶段才补防线。
- ConversationMember 增加唯一 sequence；Leader Router 优先 JSON Schema，fallback 使用随机 nonce envelope、独立只读无工具调用和服务端成员复核。
- ApprovalGrant 增加风险上限、过期、撤销与 Provider/version/config/fingerprint 失效规则；critical 仅允许单次授权。
- Extension probe 与普通 runtime probe 分离；所有 scope identity 禁止 nullable scope_id，Provider 控制按 scope 声明。
- Plugin trust hash 覆盖实际文件 bytes；Run 启动前复算。MCP start/stop 使用用户主动确认与 action audit，不复用 Provider tool approval。
- 总计划使用相对链接；B/C/D/E 分别固定上一阶段验收 HEAD 与独立 `codex/` 分支。
- Markdown 远程图片默认不加载，只允许同源 AgentOS Artifact 自动内联。

---

## 4. 总体验收标准

- 五份计划均有具体文件、接口、测试命令、停止条件和逐任务验收标准。
- A-D 任一计划可以独立交付工作软件，不要求一个 Agent 连续执行全部任务。
- Provider/角色/权限/扩展四个维度在类型和 UI 上没有概念混用。
- 运行顺序、RunStep 和执行档案使用 persisted sequence，不以 timestamp 猜顺序。
- Worktree 清理前同时验证 tracked patch、untracked archive、manifest、sha256 和可读性。
- 浏览器 Gate 由 Playwright 自动执行；人工体验确认作为额外 Gate，不冒充一键自动化。
- 计划 E 不重新实现 CLI 扩展 Runtime，只做发现、授权、展示和审计。
