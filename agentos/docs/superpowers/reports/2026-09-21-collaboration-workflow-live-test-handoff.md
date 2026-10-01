# 协作开发闭环实机测试交接报告

日期：2026-09-21  
基线：`main@7d2ddf87111ad39b639c2a1082c11be716b8084d`  
实现分支：`codex/collaboration-workflow-closure`  
状态：已修复并完成修复后真实浏览器闭环；当前停在“评审通过，待应用”，未执行应用

## 1. 交接结论

协作任务面板、计划确认、canonical Run、隔离工作树和独立评审链路已经接入。修复后的第三次真实浏览器任务已完成“规划 → 用户确认 → 隔离实施 → 独立评审”，并停在待用户应用状态。此前浏览器实机测试连续暴露了两个独立的 Provider 配置问题：

1. Codex 使用了相对命令 `codex`，服务器进程的 PATH 中没有该命令，因此启动前校验失败。
2. 旧工作区中的 KimiCode Provider 使用历史适配器别名 `builtin.kimi`，而运行时冻结身份只识别规范标识 `builtin.kimicode`，因此在 Provider Adapter 解析阶段失败。

两处问题均已修复：代码已加入 KimiCode 历史别名兼容、为新数据生成规范适配器标识，并让 KimiCode 的持久化模型覆盖旧 argsTemplate 中的过期模型参数；Codex 解析也支持从 PATH 解析裸命令。服务器已重新构建并重启，修复后的端到端任务已成功完成。

## 2. 实机环境

| 项目 | 值 |
|---|---|
| 浏览器地址 | `http://localhost:3101/workspace/ws_01M31492G56HE43FYVC32Q0TT0` |
| 工作区 | `ws_01M31492G56HE43FYVC32Q0TT0` |
| 群聊 | `72260381-0a31-4440-9d10-6c8f1c1da78c`，修复后协作闭环实机验证 |
| API | `http://localhost:3000` |
| 计划角色 | Codex 规划、KimiCode 实施、OpenCode 评审 |
| 模型配置 | Codex `gpt-5.6-luna`；KimiCode/OpenCode `opencodex/gpt-5.6-luna` |
| 目标仓库基线 | `7d2ddf87` |

成功任务仍保存在持久化协作任务列表中并可切换查看；当前浏览器现场已回到成功任务主区，历史失败任务及其指定 Run 深链接也已完成复验。目标任务只在隔离工作树中创建 `LIVE_COLLABORATION_OK.md`，没有提交、推送、合并或应用到目标工作区。

## 2.1 修复后成功闭环证据

| 项目 | 值 |
|---|---|
| 协作任务 | `collab_01M3154RPPEHF0TWWQGHNP8J9S` |
| canonical Run | `run_01M3154ZWCW9V453AG7QZ9SPWW` |
| canonical Task | `task_01M3154ZWBSKHMSPBZYXXDT1PQ` |
| 基线 | `7d2ddf87111ad39b639c2a1082c11be716b8084d` |
| 角色 | Codex 规划、KimiCode 实施、OpenCode 评审 |
| Provider 模型 | Codex / KimiCode / OpenCode 均使用 `gpt-5.6-luna` 路由 |
| 最终任务状态 | `awaiting_application` |
| Run 状态 | `completed` |
| 返工轮次 | `0 / 2` |
| 当前候选 | `artifact_01M315DEJXDTDNWZ1225T29RFP` |
| 候选状态 | `reviewed`，OpenCode 结论 `approved` |
| 评审关联 | candidate、Run、review、stage、attempt 均一致关联 |

候选只包含一个未跟踪文件：

```text
LIVE_COLLABORATION_OK.md
```

文件内容为 `LIVE_COLLABORATION_OK`，大小 21 bytes，SHA-256 为 `551842ee91ffef7958485530ca8b0822ea311a52d13819ac8fcc0c3da5497dd0`。实际验收命令退出码为 `0`。候选工作树仍保留未跟踪文件，目标工作区 `C:\Users\Administrator\.codex\worktrees\collaboration-workflow\live-test-repo-clean` 仍干净且没有该文件。

## 3. 失败任务证据

### 第一次确认

- 任务：`collab_01M2ZVYGY2ADG4G8T0J97BJKH4`
- Run：`run_01M2ZVYMD2NSNTB36NDK0FFARE`
- 结果：`failed`
- 失败原因：`Codex executable is not accessible`
- 原因：Provider 配置中的 executable 为相对值 `codex`；服务器由独立 PowerShell 进程启动时没有继承可解析的 Codex CLI 路径。

### 第二次确认

- 任务：`collab_01M2ZW6J0VYEF0WZ2PD7XGRZ1H`
- Run：`run_01M2ZW6T4PGPR5J48G0E48MQZ5`
- 结果：`failed`
- 失败原因：`Exact provider adapter identity could not be resolved`
- 原因：KimiCode Provider 的 `providerType` 为 `kimicode`，但 `adapterId` 为旧值 `builtin.kimi`；`resolveFrozenProviderIdentity` 无法将它解析为 `builtin.kimicode@1.0.0`。

两次失败都发生在实施 Agent 能真正修改文件之前。对应的两个隔离工作树均仍基于 `7d2ddf87`、工作区干净，且没有生成 `LIVE_COLLABORATION_OK.md`。它们只作为历史失败证据保留，不能复用其租约作为成功证据；成功任务使用了独立的新 Run 和新工作树。

## 4. 已完成的修复

### Provider 兼容修复

- `packages/agent-core/src/providers/types.ts`
  - 将 `builtin.kimi` 作为 KimiCode 历史别名解析为规范身份 `builtin.kimicode@1.0.0`。
- `packages/agent-core/src/providers/kimiCodeAdapter.ts`
  - 在 Provider 边界把历史别名规范化，避免旧配置在校验阶段再次被拒绝。
- `apps/server/src/services/WorkspaceCompatibilityMigrationService.ts`
  - 新迁移数据根据 Provider 生成规范适配器 ID。
  - 比较旧数据时把 `builtin.kimi` 与 `builtin.kimicode` 视为同一兼容身份，避免无意义冲突。

### 本次实机环境修复

测试工作区的 Provider executable 已改为已验证存在的绝对路径：

- Codex：`C:\Users\Administrator\AppData\Local\OpenAI\Codex\bin\247581e40ee272fb\codex.exe`
- KimiCode：`C:\Users\Administrator\.kimi-code\bin\kimi.exe`
- OpenCode：`E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe`

这些是本机实测配置，不应写入生产默认值或提交到仓库；生产环境应通过工作区 Provider 配置或环境发现机制提供路径。

### 修复后运行时验证

- Codex 规划阶段成功完成。
- KimiCode 实施阶段成功完成，并实际在隔离工作树写入目标文件。
- OpenCode 只读评审阶段成功完成，评审结论为 `approved`。
- 候选测试使用实际命令、退出码和输出证据，不能由模型 Markdown 代替。
- 浏览器面板能显示待审批状态；本次成功任务没有遗留审批请求，最终显示“评审通过，待应用”。
- 刷新 Web 预览后重新进入同一群聊，打开“协作任务”会从持久化列表恢复该未应用任务，仍显示“评审通过，待应用”。

## 5. 已验证结果

| 检查 | 结果 |
|---|---:|
| `@agentos/agent-core` 全量测试 | 199 passed / 0 failed |
| Server 定向测试（Admission / Worktree / Snapshot / Workflow / Collaboration） | 68 passed / 0 failed |
| Web 测试 | 232 passed / 0 failed |
| Server 全量测试（修复后） | 2905 passed / 0 failed / 8 skipped |
| Server 生产构建 | 通过 |
| Web 生产构建 | 通过 |
| `git diff --check` | 通过 |
| 浏览器真实闭环 | Codex → KimiCode → OpenCode 成功，待应用 |
| 浏览器刷新恢复 | 成功恢复同一群聊的待应用任务 |

完整服务端套件曾先发现一条遗漏：新建工作区路径仍生成 `builtin.kimi`。已在 `WorkspaceManager` 统一改为 `builtin.kimicode`，相关 37 项测试通过，随后修复后完整服务端套件通过。

## 6. 当前停止点与后续路径

1. 当前无需重新创建任务；Server `3100`、Web `3101` 和浏览器现场已保留。
2. 当前唯一未执行动作是用户确认后的应用。确认后必须重新检查目标工作区干净、目标 HEAD 仍为 `7d2ddf87`、候选版本和任务版本未变化。
3. 应用时保留恢复材料；若基线、候选或工作区状态变化则拒绝应用，不自动解决冲突。
4. 应用成功后仍不自动 commit、push、merge 或 deploy。

建议首个成功候选仍只包含：

```text
LIVE_COLLABORATION_OK.md
```

验收命令：

```text
node -e "const fs=require('fs');if(fs.readFileSync('LIVE_COLLABORATION_OK.md','utf8')!=='LIVE_COLLABORATION_OK')process.exit(1)"
```

## 7. 发布边界

- 当前没有 commit、push、PR 或 merge。
- 当前实现仍在隔离分支和隔离 worktree 中。
- 目标工作区没有被应用候选文件。
- 两次失败任务仅作为历史失败证据；第三次任务已提供独立成功证据。
- 用户要求的“浏览器中可看”环境已启动；成功任务可从历史选择恢复，当前现场用于复验失败任务与 Runtime 深链接。

## 8. 协作任务可视化与 Runtime 导航（本轮新增）

本轮以同一实现分支和持久化测试数据库继续完成了“主区进度投影 + Runtime 指定 Run 导航”，不改变普通私聊、普通群聊发送和既有 Runtime 执行语义。

### 已交付

- 新增共享进度类型及工作区范围只读接口：
  `GET /api/workspaces/:workspaceId/collaboration/tasks/:id/progress`。
- 协作任务列表支持 `conversationId`、`limit`、`offset`，返回包含失败、取消、已应用的历史任务；服务端校验任务、Run、Stage、候选、评审和测试证据属于同一工作区与任务。
- 群聊主区在消息区顶部展示独立协作任务卡：任务状态、目标、历史任务切换、当前阶段、冻结 Agent、返工轮次、等待/失败原因、阶段证据和候选测试状态。
- 无公开输出时明确显示“该阶段暂未提供公开输出”，不从模型文本或隐藏日志伪造执行结论。
- 使用 canonical Run 的持久化状态与公开 durable 事件进行刷新；活动任务页面可见时按两秒非重叠快照校验，SSE 事件触发合并刷新，切换任务时隔离旧请求。
- Runtime 会话已纳入统一 Agent 导航，移除重复的左侧“运行时工作台”跳转按钮；Runtime 私聊和轮流讨论按来源隔离显示，并保留可访问名称与选中状态。
- 统一工作台主区提供“对话 / 执行详情”页签；协作任务卡“查看执行证据”直接切换当前页面的 exact Run，不再离开普通群聊界面。
- `/workspace/:id/runtime` 已改为兼容跳转入口：无参数时恢复 Runtime 会话集合，携带协作任务、会话和 Run 参数时恢复对应普通群聊与执行详情；执行链接显式保留 `runSource=workspace|canonical`。
- Runtime 按协作任务服务端投影校验指定 Run，不回落到会话中的其他 Run；执行详情页沿用现有 Inspector，且不显示浮动 Composer。
- Runtime 轻量对话继续区分 Chat/Task/Run；轮流讨论保留成员、@Agent、回复预算和停止讨论语义；普通群聊行为不变。

### 浏览器验收证据

| 场景 | 现场结果 |
|---|---|
| 成功任务历史 | 选择 `最终隔离协作闭环回归-v4 · 已应用`，显示 Codex → KimiCode → OpenCode 三阶段、候选、测试通过、评审 approved |
| 失败任务历史 | 选择 `最终隔离协作闭环回归-v3 · 执行失败`，显示当前阶段“实施”、负责 Agent“KimiCode”、失败原因，评审明确为“已跳过” |
| 指定 Run 深链接 | `run_01M314FRWWWCHCP2JVE3WAY93W` 在无聊天消息的 Runtime 页面仍显示 Run failed、3 个 Stage、2 个进程和 66 条事件 |
| 返回链路 | 从 Runtime 返回后恢复群聊 `72260381-0a31-4440-9d10-6c8f1c1da78c` 与 v3 历史任务选择 |
| 公开输出边界 | 现场各阶段没有公开输出时均显示明确缺失文案，没有生成替代内容 |
| Runtime 入口去重 | 移除群聊主区和左侧导航的独立 Runtime 工作台入口，Runtime 会话进入统一 Agent 导航；任务卡证据入口仍可用 |

### 本轮接口与构建证据

- 进度接口对当前失败任务返回 HTTP 200，并投影 3 个阶段、冻结 Agent 归属、候选/评审/测试证据及事件游标。
- `pnpm --filter @agentos/web test`：232 passed / 0 failed。
- `pnpm --filter @agentos/server test`：2913 tests，2905 passed / 0 failed / 8 skipped（环境门控）。
- `pnpm --filter @agentos/server build`：通过。
- `pnpm --filter @agentos/web build`：通过；`/workspace/[id]` 与 `/workspace/[id]/runtime` 均完成生产编译和类型检查。
- `git diff --check`：通过。

### 统一工作台补充验收（本轮）

| 场景 | 现场结果 |
|---|---|
| Runtime 轻量对话 | 创建并打开 `conv_01M3293H0RYYZJ8SYE58PEJP02`，统一 URL 为 `conversationSource=runtime`，对话为空态、Chat/Task/Run 选择器和执行详情页签可用 |
| Runtime 轮流讨论 | 创建并打开 `conv_01M329JNC2S71DHWG5B9WFS5W3`，统一主区显示成员、@Agent、回复预算和群聊发送入口 |
| 普通群聊恢复 | 从 Runtime 返回 `72260381-0a31-4440-9d10-6c8f1c1da78c` 后，协作任务卡和 Composer 正常恢复；Runtime 选择状态不会污染普通群聊 |
| 协作执行详情 | `run_01M3154ZWCW9V453AG7QZ9SPWW` 在 `/workspace/:id?view=execution` 中显示 completed、3 个 Stage、3 个进程和 91 条事件 |
| 旧 Runtime 深链接 | `/runtime?...&runId=...` 重定向后仍恢复 `view=execution` 和 exact Run；无参数 `/runtime` 恢复首个 Runtime 会话 |
| 浏览器日志 | 3101 最终页面无 error/warn 日志，真实截图已留存 |

本轮期间修复了两个前端状态问题：来源以 URL 为准，避免从 Runtime 切回群聊后旧选择状态覆盖主区；路由恢复不再把显式 `view=execution` 改写成对话，并让 URL 中的 `runId` 在刷新后直接进入 Inspector。

说明：最后补充的 Run 关联异常显式告警只改变进度投影的类型与展示；补丁后已重新完成 Server/Web 构建、进度接口实测和浏览器验收。上面的 Server 全量数字是在该非执行路径告警补丁之前取得，未将其重复计入全量套件。

## 9. 群聊能力合并与本机清理（2026-09-22）

本节覆盖本轮“一个群聊入口、默认轮流讨论”的最新状态，并优先于本报告前面基于旧数据库的 Runtime 群聊记录。旧 Runtime 会话、旧普通群聊和旧协作任务已在 3101 预览实际使用的数据库中按授权范围清理；本节列出的两个群聊是清理完成后重新创建的验收数据。

### 合并结果

- 群聊列表只读取 canonical `cr_conversations`，创建入口只要求名称和成员；新群聊固定使用 `reply_mode=sequential`。
- 侧栏不再提供“运行时会话／轻量对话／轮流讨论”的群聊创建分支；普通私聊仍保留原机制。
- 群聊发送通过持久化 interaction 串行驱动成员，每个参与 Agent 默认最多回复一次；`@Agent` 限定参与者，未指定时使用全部成员。
- 群聊停止只停止讨论，不调用普通 Run 取消；协作任务仍通过现有协作任务入口处理。
- `source_message_id` 的部分唯一约束、interaction 认领和回复账本用于幂等发送与刷新/重连隔离。
- Provider 最终回复与用户停止竞态已做持久化收敛：若停止获胜前 Provider 已完成最终回复，服务端将该回复记为一次 durable reply，且重复重试不会重复入账。

### 3101 浏览器验收

| 场景 | 结果 |
|---|---|
| 三 Agent 默认轮流讨论 | `群聊合并实机验收` 中 Codex → KimiCode → OpenCode 按成员顺序完成 3/3 回复，真实配置均为 GPT-5.6-Luna |
| `@Codex` 限定 | 同一群聊单独发送后仅 Codex 回复，预算显示 1/1 |
| 刷新恢复 | 刷新后消息、作者归属和 interaction 状态保持不变 |
| 停止竞态 | `停止竞态验收` 停止后显示 `1/3 次回复 · 1 位 Agent`，并保留 Codex 公开回复；刷新后仍一致 |
| UI 入口 | 浏览器可见 Agent、群聊和设置入口；不存在独立 Runtime 群聊创建入口，主区保留“对话／执行详情”页签 |

当前验收群聊：

- `conv_01M32EXZETPGAVEKNN02FJD5DQ`：`群聊合并实机验收`，含三 Agent 预算完成、@限定和停止前的回归记录。
- `conv_01M32FGVXCPYD1D28QD10563FW`：`停止竞态验收`，最终 interaction `conv_01M32FHBTTM5BYTP51F26Y6ZVV`，状态 `stopped`，`reply_count=1`，`stop_reason=user-stop`。

### 数据清理与完整性

- 清理前先完成预演、停止活动写入、暂停 API 并生成一致性备份；备份目录：
  `C:\Users\Administrator\.codex\worktrees\collaboration-workflow\live-test-server-db-v2\.agentos\migration-backups\group-merge-20260922-004224`
- 清理范围为当前 3101 预览 API 数据库内的全部工作区旧 Runtime 会话、旧群聊及其专属消息、成员、interaction、协作任务、候选、评审和执行证据；普通私聊、工作区、Agent、Provider、偏好和项目数据保留。
- 清理完成、重新验收前，目标旧表记录已归零；群聊合并的首轮验收阶段数据库仅包含上述两个新 canonical 群聊及其讨论消息/账本，后续真实协作任务及其候选证据见第 10 节。当前保留项为 `workspaces=1`、`agent_profiles=3`、`provider_configurations=3`。
- `PRAGMA integrity_check` 返回 `ok`，`foreign_key_check` 无记录。已删除的受管 Artifact 使用精确路径清理；项目文件、已应用代码和 Git 历史未删除。旧专用执行工作树未强制删除，以避免误触用户项目文件。
- 恢复方式：停止 API，将备份目录中的 `agentos.sqlite`（及存在的 sidecar 文件）复制回 `.agentos`，再用原 `AGENTOS_PROJECT_ROOT` 和端口启动 API。

### 最新验证与发布边界

- Web 测试：232 passed / 0 failed。
- Server 群聊/讨论聚焦测试：33 passed / 0 failed；覆盖三 Agent 轮流、@限定、停止、重复回复保护和停止竞态最终回复入账。
- Server 生产构建、Web 生产构建、Web TypeScript 检查和 `git diff --check`：通过。
- Web 预览仍为 `http://localhost:3101`，API 为 `http://localhost:3000`；最新前端构建已重启并完成浏览器复验。
- 本轮未 commit、push、merge、deploy，也未应用任何协作候选；工作树中的既有未提交修改均保留。

### 当前预览与边界

- Web 预览：`http://localhost:3101`；API：`http://localhost:3000`。
- 当前未执行候选应用；未 commit、push、merge 或 deploy。
- 当前工作树仍包含本分支及此前用户已有的未提交改动；本轮没有使用 reset、checkout 或清理无关文件。
- 3101 预览曾缓存旧 Next 语法错误，已仅重启前端预览进程后复验；数据库、API 数据和隔离工作树未被重置。

## 10. 最终收尾验证与真实协作任务证据（2026-09-22）

### 全量验证结果

- `pnpm --filter @agentos/server test`：2915 项，2907 passed、0 failed、8 skipped，耗时约 14 分钟；跳过项均为环境门控测试。
- `pnpm --filter @agentos/server build`：通过。
- `pnpm --filter @agentos/web test -- --runInBand`：232 passed、0 failed。
- `pnpm --filter @agentos/web exec tsc --noEmit`：通过。
- `pnpm --filter @agentos/web build`：通过；`/workspace/[id]` First Load JS 427 kB，`/workspace/[id]/runtime` First Load JS 88.2 kB。
- 群聊/讨论聚焦测试在附件补齐及旧群聊入口收敛后的最终结果仍为 33 passed、0 failed；另有 ConversationRepository 与 canonical 附件专项 25 passed、0 failed。

### 三 Agent 真实协作闭环

清理后的 3101 数据库中新建并完成了一个真实协作任务：

- 协作任务：`collab_01M32JBQKPZHK7MYGYQNJFEQPZ`
- canonical Task：`task_01M32JC2RT0M8GQ85EK7D6RFHQ`
- canonical Run：`run_01M32JC2RW3W25JFF69Z0W6JKJ`
- 角色快照：Codex 规划、KimiCode 实施、OpenCode 独立评审；实施者与评审者不同。
- 结果：规划、实施、评审各 1 次，返工 `0/2`；评审 `approved`，测试 `passed`，退出码 `0`；任务停在 `awaiting_application`。
- 候选版本：`artifact_01M32JZ3SGTF986TTE9NPEA97R`，评审绑定 `review_28d8b90e-a1dd-4bf1-bc4d-8a405b6fde4c`，候选工作树中仅生成 `LIVE_COLLABORATION_OK.md`。
- 目标测试仓库 `live-test-repo-clean` 在验收后仍为 clean，未应用候选；文件内容和测试证据保留在候选工作树中。

这证明了“确认计划 → 隔离实施 → 独立评审 → 测试证据 → 待用户应用”的首轮成功路径。未点击“确认应用候选版本”，没有修改目标工作区、没有 commit、没有 push、没有 merge。

### 清理与恢复补充

- 为使真实任务满足干净工作区门槛，仅将测试仓库原有的两个未跟踪验收遗留物移动到可恢复目录，没有删除：
  `C:\Users\Administrator\.codex\worktrees\collaboration-workflow\live-test-server-db-v2\.agentos\migration-backups\pre-collaboration-test-dirty-20260922-0120`。
- 旧数据库完整备份仍位于 `group-merge-20260922-004224`；恢复方式沿用本报告第 9 节的停 API、复制数据库及重启流程。
- 当前浏览器仍打开 3101 统一工作台，选中群聊 `群聊合并实机验收`；页面可见真实消息作者、停止状态、`@Agent` 选择和“对话／执行详情”页签。

### 发布边界

- 当前分支：`codex/collaboration-workflow-closure`；基线：`main@7d2ddf87111ad39b639c2a1082c11be716b8084d`。
- 本轮未执行 commit、push、merge、deploy 或候选应用；工作树中既有未提交修改均保留。
- 3101 预览：`http://localhost:3101`；API：`http://localhost:3000`。

## 11. 群聊协作任务操作优化与真实回归（2026-09-23）

本节记录本轮针对“历史任务选错、刷新丢选择、主区操作与弹窗对象不一致、状态含义不清、创建表单误填”的前端修复。服务端执行机制、版本校验、审批和候选应用规则未改变；本轮不清理数据、不应用候选、不提交或推送。

### 实现内容

- `useCollaborationProgress` 支持显式 `collaborationId` 选择：任务列表只在当前群聊范围内解析；显式任务不存在或关联错误时显示错误，不自动回落到最近任务。
- 用户选择任务时把 `collaborationId` 写入 URL，并清除旧 `runId/runSource`；自动选择只用 `replace`，不会污染浏览器历史。刷新、前进和后退恢复同一任务。
- 任务卡状态使用阶段/审批投影：等待审批不再显示“执行中”；操作按钮按状态显示“检查并确认任务”“查看审批”“检查并应用”“查看原因”等语义。
- “查看详情”和“查看执行证据”统一进入主区“执行详情”页签；主区显示任务概览、计划与分工、执行轮次、阶段与交接、候选/测试/评审证据，技术事件默认折叠。
- 主区详情、任务卡和右侧状态共用同一个进度控制器；详情页的审批、取消、确认和应用继续调用原有版本校验与幂等接口，群聊不再通过通用 Run 重试绕过协作约束。
- 创建任务弹窗仅保留创建用途；目标、修改范围和验收命令不再预填泛化内容，空字段会在客户端阻止提交并保留表单内容；“生成计划”改为“创建任务”，“后台运行”改为“返回对话”。

### 3101 实机证据

| 场景 | 结果 |
|---|---|
| 初始恢复 | `群聊合并实机验收` 自动选中最新待审批任务 `collab_01M32NPWV92DEE15ZYTBT4KGRP`，卡片显示“待审批”、实施阶段和 KimiCode，不再把底层 `running` 直接展示为执行中 |
| 历史任务选择 | 切换到 `合并群聊能力的最小真实验收` 后 URL 写入 `collab_01M32JBQKPZHK7MYGYQNJFEQPZ`，卡片显示“评审通过 · 待应用”、OpenCode 和测试通过证据 |
| 历史任务详情 | 点击“检查并应用”进入 `view=execution`，主区标题、基线、Run `run_01M32JC2RW3W25JFF69Z0W6JKJ`、候选、退出码 `0` 和 approved 评审全部属于该历史任务，没有出现另一任务的审批按钮 |
| 刷新恢复 | 在历史任务执行详情 URL 上刷新，仍恢复同一 `collaborationId`、任务标题、Run、候选和“确认应用候选版本”操作 |
| 快速切换 | 返回对话后切回待审批任务，详情页只显示 `collab_01M32NPWV92DEE15ZYTBT4KGRP`、Run `run_01M32NQ1RRS9V0P9S74ZG670S4`、审批说明和“批准本次执行/拒绝执行”，未混入待应用任务 |
| 状态一致性 | 任务卡、历史任务下拉项和执行详情均显示“待审批”，不再让同一任务同时显示“执行中”和“待审批” |
| 创建表单 | 点击“新建”后目标、范围、验收命令为空；直接点击“创建任务”显示“请填写任务标题、目标、修改范围和至少一条验收命令”，没有创建新记录 |
| 无效任务 URL | 使用当前工作区的不存在任务 ID 后，聊天区显示“协作任务无法加载：指定的协作任务不存在、已移除或不属于当前群聊”，没有回落到其他任务；随后恢复真实待审批任务 |
| 浏览器日志 | 上述刷新、切换、详情和表单操作期间 3101 页面未捕获 error/warn |

### 本轮验证

- `pnpm --filter @agentos/web exec tsc --noEmit`：通过。
- `pnpm --filter @agentos/web test -- --runInBand`：232 passed、0 failed、0 skipped。
- `pnpm --filter @agentos/web build`：通过；`/workspace/[id]` 生产编译成功，First Load JS 431 kB；`/workspace/[id]/runtime` 兼容路由仍可编译。
- 在补齐聊天页与执行详情页的无效任务错误投影后，已再次执行 Web TypeScript、232 项 Web 测试和生产构建，结果保持通过。
- `git diff --check`：通过。
- API `3000` 与 Web `3101` 已重启，浏览器使用重建后的 3101 版本完成上述回归；当前验收页仍保持打开并标记为交付页。

### 未覆盖与发布边界

- 本轮没有再次执行 Server 全量套件；本轮仅修改 Web 任务选择/详情/表单显示，最近一次 Server 全量结果见第 10 节。审批、取消、应用接口没有改动。
- 尚未对全部 617/719/1014/1440/1920px 深浅主题逐一截图；已完成当前 3101 实际工作区的核心对象、刷新和操作回归。
- 当前分支仍为 `codex/collaboration-workflow-closure`，工作树包含此前及本轮未提交修改；未执行 commit、push、merge、deploy 或候选应用。

## 12. 候选冻结、独立评审与进度体验回归（2026-09-24）

### 实施修复

- 候选快照使用以任务基线初始化的临时 Git index，生成同一份 `--binary` 补丁，涵盖已跟踪修改、删除、普通未跟踪新文件和二进制文件，不改活动工作树的真实 index；保存快照版本、补丁 SHA-256、变更路径与未跟踪文件摘要。
- 候选及实际验收命令在 Review 阶段启动前冻结；记录测试前后候选哈希，测试若改动候选则禁止评审通过。评审使用从冻结补丁创建的隔离工作树，并在启动及结果接收时复核哈希。
- 结构化评审要求唯一 `agentosArtifact` 评审对象，并校验 candidate ID/hash、canonical Run、评审阶段 attempt、Reviewer Agent 与结论。旧评审或普通模型文本不能替代当前候选的绑定证据。
- 任务卡、主区详情及 Inspector 继续共用任务进度控制器；本次 3101 实机观察到阶段事件数在未手动刷新的情况下自动增长，并自动从实施推进到评审、再显示“评审通过 · 待应用”。
- 执行详情中的长阶段公开输出现在默认收起为两行摘要，使用原生键盘可操作的 disclosure 展开全文；无输出状态仍按“未开始／未保存／无效／不可用”说明原因。
- 创建成功回调会关闭创建弹窗、选中任务、写入 `collaborationId`、切换到执行详情并将焦点移到任务标题；本轮未通过新增持久任务来实测创建表单，按代码路径核对该行为。

### 真实三角色任务证据

- 工作区：`ws_01M373HJTTD5XG15H59RHD2AJ3`；会话：`conv_01M373NSKE77ZGJT1ZKBMPVA2R`。
- 协作任务：`collab_01M37ZAB4ZS12F9RS01ZPJKJEW`；canonical Run：`run_01M37ZB55VKE41QDZXKZ69PZJT`。
- 角色：Codex 规划、KimiCode 实施、OpenCode 独立评审；修改范围仅为独立测试工作树内的 `taskboard-demo/`。
- 候选：`artifact_01M381DDX26RP4EDSMV2HWBA3G`，快照版本 2，authoritative 补丁 SHA-256：`aec1ae89bbd46a1089d50e4fa1c0f5512c8e67bf82c7771253d21ee0e7cfc4cf`。
- 实际验收：`npm --prefix taskboard-demo test`，5/5 通过、退出码 `0`。OpenCode 评审记录 `review_542e8cc7-73ff-41fe-9ccf-7d2152e62d03` 绑定同一候选哈希、Run、评审阶段 `stage_01M37ZB55YWS5B52G0S3MA9G9Q` attempt `1`，结论 `approved`。
- 任务当前为 `awaiting_application`；候选仍待用户应用。没有点击应用，没有改动目标测试仓库，没有 commit、push、merge 或 deploy。
- 目标候选工作树 `C:\Users\Administrator\.codex\worktrees\collaboration-workflow\live-test-server-db-v2\.agentos\worktrees\8c46d795\c2fac0fc\7d69ec28` 的状态为 `?? taskboard-demo/`；计划内所有产物均在此目录，未应用到目标工作区。

### 本轮验证与浏览器

- Web：`pnpm --filter @agentos/web test` 232 passed / 0 failed；`pnpm --filter @agentos/web exec tsc --noEmit` 通过；`pnpm --filter @agentos/web build` 通过，生产构建包含公开输出折叠改动。
- Server：全量套件最近记录为 2907 passed / 0 failed / 8 skipped；评审解析器更新后的候选快照、评审协议和仓储专项测试为 12/12 通过。全量套件未在本节记录的最新 UI 改动后重跑（该 UI 改动不涉及 Server）。
- 3101 AgentOS 预览已重启为本次生产构建，页面自动显示真实的规划／实施／评审归属、同哈希评审、测试退出码和待应用状态。长公开输出默认折叠、可展开；浏览器中完成了展开与收起验证。
- 另在 `http://127.0.0.1:3210` 运行冻结候选中的本地看板，浏览器验证了新增、完成切换及已完成筛选；使用唯一临时 `DATA_FILE`，不写入目标仓库。该浏览器标签保持打开供查看。
- 浏览器由 Codex In-app Browser / CUA 完成；本机无可用 Playwright Chromium，因此未使用 Playwright 截图/viewport 自动化。当前截图为实际浏览器视口检查，617/719/1014/1440/1920px 深浅主题完整矩阵未逐一完成，视觉门仍有此项待补。
- 一次临时手写 readiness 探针错过早先输出后等待不返回；确认进程属于该探针后，仅停止其 Node 探测进程及测试服务。正式 `npm --prefix taskboard-demo test` 随后通过，候选与目标文件未受影响。

### 发布边界

- 当前分支：`codex/collaboration-workflow-closure`。保留工作树已有修改；本轮未暂存、未提交、未推送、未合并、未部署，也未应用候选。
- 3101 AgentOS 预览与 3000 API 保持运行；3210 候选看板演示使用独立临时数据文件。候选应用仍由用户决定。
