# AgentOS 协作工作流严格复审报告

日期：2026-09-30  
性质：代码审查与负向验证报告，不是修复完成或发布证明  
文档更新：2026-09-30；本次交付以第 10 节为准，第 7–9 节保留此前快照，不覆盖原始发现和失败记录。  
审查时结论：**不建议合并、发布或应用协作候选。审查基线的现有套件全绿，但关键控制路径存在可重复复现的缺陷。**

时间边界：以下 F01–F22 与第 2 节测试数字记录的是修复前审查基线，不代表后续未提交实现仍保持相同缺陷；对应源码行号也属于该基线。第 7 节单独记录后续修复增量的检查，不混用版本。当前状态另见 [修复进度与验收记录](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/2026-09-30-audit-remediation-verification.md)；达到全部门槛之前，不建议发布。

修复计划：[协作工作流审查修复计划](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/plans/2026-09-30-collaboration-workflow-audit-remediation.md)。

阅读摘要：原始复审确认 **22 项发现：P1 12 项、P2 9 项、P3 1 项**，包含运行复现、处理器复现和完整源码链确认三种证据，不能把它们都称为浏览器端到端复现。后续另有 F23–F26：CRLF 误拒、应用释放衔接、journal/control 恢复和 clean-filter 竞态。编号是累计发现目录，不表示当前仍有 26 个未经修复的漏洞。最新状态与剩余门槛见第 10 节。

上一轮文档交付复核（19:24 +08:00，修复前）：Server 类型检查两次通过；Web 类型检查两次均失败，剩余 **3 条诊断**；Web 全套两次均为 **262 项：256 通过、6 失败**。F24/F25 隔离控制专项 **31 项：19 通过、12 失败**，失败均在启动准入提前释放 writer 的断言，尚未执行到完整双重恢复。F26 的两种 filter 竞态各重复三次，均触发了本应禁止的外部 filter。此段保留历史红灯，不代表后续实现的当前结果。2026-10-01 已继续实施，最新代码及实机证据见 [修复验收记录](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/2026-09-30-audit-remediation-verification.md)第 10 节；最终组合门槛尚未全部关闭，不自动合并、发布或应用候选。

## 1. 审查对象与边界

| 项目 | 本轮核实结果 |
|---|---|
| 实际工作树 | `C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos` |
| 实际分支 | `codex/collaboration-workflow-closure` |
| HEAD | `7d2ddf87111ad39b639c2a1082c11be716b8084d` |
| 审查前未提交文件 | 76 个：55 个已跟踪修改、21 个未跟踪文件 |
| 源码指纹 | `A0F012AF8619B22511398CD23B849A2586FD8708982D249936B57C078DD4655F` |
| 本轮重点 | 协作确认、候选与评审、取消、应用、重启恢复、群聊执行和前端会话隔离 |
| 并行复核 | 群聊/持久化链路、前端/异步选择链路分别独立复核，重要发现交叉验证 |

默认 shell 目录 `E:/workspace/Multi-Agent/agentos` 是另一个分支，不作为本轮协作功能结论的对象。报告针对上表所示 HEAD 加未提交实现；不能仅凭 HEAD 重建被审版本。

审查前后上述 76 个文件的指纹相同。审查没有修改源码、操作真实业务数据库、应用候选、调用真实 Provider、提交、推送或合并。随后新增本报告与修复计划是文档交付，不改变该源码基线。

本轮覆盖协作增量及其相关执行路径，不宣称所有未改动模块均已逐行审完，也不宣称已完成依赖漏洞扫描或全量实机回归。

## 2. 证据等级与测试结果

### 2.1 证据等级

- **R：重复执行验证。** 独立临时 SQLite、Git 仓库或受控执行夹具运行真实产品服务，断言结果重复一致。明确区分真实状态机与模拟 Provider 结果。
- **H：处理器级验证。** 提取当前源码中的原始处理器，在内存中验证状态行为；不等同于真实浏览器端到端操作。
- **S：完整源码链确认。** 已追踪调用方、状态和消费端，但本轮没有运行时复现全部用户路径。
- **N：未证实或撤回。** 不计入已确认缺陷，也不能据此声称不存在风险。

### 2.2 本轮实际执行

| 检查 | 结果 | 限制 |
|---|---|---|
| `pnpm --filter @agentos/server test` | 2926 项：2918 通过、8 跳过、0 失败 | 跳过项不计为已验证 |
| `pnpm --filter @agentos/web test` | 232 通过、0 失败 | 不替代真实浏览器交互 |
| Server / Web `tsc --noEmit` | 均通过 | 仅证明类型检查通过 |
| 候选快照、评审协议、协作仓储专项 | 连续两轮，各 12/12 通过 | 不覆盖本报告全部负向时序 |
| 群聊路由、BoundedGroupService、GroupTurnDriver 专项 | 34 通过、0 失败 | 路由使用 mock，Driver 使用 stub runner |
| F01–F11 关键失效场景 | 每类主审重复 3 次 | F04、F08 含受控完成/进程分类条件 |
| 群聊并发、跨工作区关联独立交叉复核 | 各额外重复 2 次 | 无真实 Provider 费用或外部副作用验证 |
| F18 冲突 HTTP 映射 | 实际临时 HTTP 服务重复 2 次，均返回 500 | 不针对真实业务 API |
| 前端选择、附件清理、IME 处理器 | 每类重复 3 次 | H 级，不是浏览器 E2E |

正常评审绑定、错误 hash/attempt、多重结论和普通“通过”文字的正负控制也重复通过。忽略文件的哈希行为另做了两次条件性验证，没有把正常忽略构建产物列为缺陷。

独立探针通过 stdin/内存执行，未加入仓库现有测试文件。本报告记录了断言与复现条件；不能声称仓库已经包含这些可直接重跑的正式回归测试。修复第一步应将探针固化为测试。

## 3. P1：发布前必须修复

### F01｜应用先写文件，再检查任务版本

- 等级：R，3/3；真实 Git 仓库、补丁、工作树管理器和 SQLite。
- 触发：构造合法待应用候选，以陈旧 `expectedVersion` 请求应用。
- 结果：请求返回 `CONFLICT`，目标文件已经写入，任务仍为 `awaiting_application`；正确版本重试又被 `workspace_dirty` 拒绝。
- 原因：Git 应用在先，任务版本校验在后续数据库事务；该事务失败不在前面的文件回滚保护范围内。
- 影响：用户收到失败，却已产生代码变更；留下未说明的半应用状态。
- 定位：[应用与事务顺序](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationWorkflowService.ts:554)。

### F02｜运行中任务取消没有取消 canonical Run

- 等级：R，3/3；使用真实 RunEngine 的启动生命周期，Provider 阶段为受控 active。
- 触发：Run 已 running，而启动请求对应的 `run.start` Operation 已 completed。
- 结果：任务变 cancelled，Run 仍 running，停止回调调用次数为 0。
- 原因：取消只查 queued/running/waiting_approval/paused 的启动 Operation；但“启动请求完成”不等于“Run 执行完成”。
- 影响：界面宣称已取消，实际执行仍可能继续。
- 定位：[取消对象筛选](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationWorkflowService.ts:497)、[真实启动生命周期](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/run-engine/RunEngine.ts:523)。

### F03｜陈旧取消请求在被拒绝前已经改变 Run

- 等级：R，3/3；真实 canonical Run 和 Operation 取消事务。
- 触发：queued 任务提交陈旧版本取消。
- 结果：最终 `CONFLICT`，任务仍 queued，但 Run 已 cancelled，停止回调已调用。
- 原因：外部停止及 Run 事务先执行，最后才调用任务版本校验。
- 影响：失败请求仍有副作用，任务与执行事实分裂。
- 定位：[取消顺序](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationWorkflowService.ts:501)。

### F04｜取消终态被评审收尾覆盖

- 等级：R，3/3；冻结候选和有效绑定评审，受控完成时序。
- 触发：评审收尾正在异步核对副本时取消任务。
- 结果：立即返回 cancelled，收尾继续后变为 awaiting_application。
- 原因：收尾重新读取最新任务，但没有检查允许的源状态和取消栅栏；通用 progress 允许覆盖取消终态。
- 影响：已取消任务复活；要求修改的同类收尾分支也缺少终态保护，自动返工风险需在修复测试中覆盖。
- 定位：[评审收尾重新推进](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationWorkflowService.ts:762)、[无源状态保护的更新](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/store/CollaborationRepository.ts:229)。

### F05｜确认忽略请求中的 expectedVersion

- 等级：R，3/3。
- 触发：任务实际版本 1，请求携带 `expectedVersion=100`。
- 结果：仍创建 canonical Run 并进入 queued；探针拒绝执行准入，因此没有 Provider 调用。
- 原因：确认使用服务端读取到的 `task.version`，没有核对请求预期版本。
- 影响：接口宣称的确认版本约束失效。当前没有完整计划编辑入口，不能扩大表述为已实测“旧计划修改后被执行”。
- 定位：[确认版本参数](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationWorkflowService.ts:647)。

### F06｜scope 不是可执行的文件范围约束

- 等级：R，3/3。
- 触发：计划 scope 为 `src/`，实施工作树额外生成 `unrelated/outside.txt`。
- 结果：范围外文件进入冻结补丁，实际验收命令退出 0，并进入评审副本。
- 原因：scope 进入提示词/计划哈希，候选与应用路径没有按批准范围校验差异路径。
- 影响：评审通过不能证明修改在用户批准范围内。
- 定位：[候选生成](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationWorkflowService.ts:811)、[整树暂存](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationCandidateSnapshot.ts:55)。

### F07｜目录 junction 绕过候选路径边界

- 等级：R，Windows 3/3。
- 触发：工作树内目录 junction 指向工作树外，目录中有普通文件。
- 结果：树外文件真实内容进入候选补丁，路径仍显示为 `linked/external.txt`。
- 原因：仅做词法路径和末级 lstat 检查，没有核对 realpath 与祖先目录。
- 影响：候选可能携带批准工作树之外的文件内容；探针只使用虚构测试内容，未读取真实密钥。
- 定位：[候选边界检查](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationCandidateSnapshot.ts:65)。

### F08｜重启恢复没有同步协作任务状态

- 等级：R，3/3；真实关闭/重开 SQLite，注入 missing 进程分类后运行现有恢复入口。
- 结果：canonical Run failed，协作任务仍 running。
- 原因：启动恢复收敛 Run/Stage，没有对应的协作任务收敛路径。
- 影响：任务列表继续将其当作活动任务，状态与执行事实不一致。
- 边界：这是恢复服务组合验证，不是本轮真实 Provider 中途重启演练。
- 定位：[启动恢复组合](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/index.ts:213)。

### F09｜首条回复后，“停止讨论”使用陈旧版本

- 等级：R+S；服务端旧版本停止 3/3，页面版本消费链已确认。
- 触发：页面保留 interaction 版本 1，首条回复使服务端推进到版本 2，再点击停止。
- 结果：停止被拒绝，interaction 仍 active；错误被映射为 `GROUP_BUDGET_EXCEEDED`。
- 原因：页面只在创建/结束等路径更新 interaction，收到 `group.turn.final` 时不刷新版本。
- 影响：停止后仅断开浏览器 SSE，不能据此认为服务端已停止。错误码也不能被解释为预算真的耗尽。
- 定位：[页面初始版本](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:866)、[停止请求](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:1053)、[停止更新](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/BoundedGroupService.ts:352)。

### F10｜同一 interaction 可重复启动执行

- 等级：R，主审 3/3，独立复核额外 2/2。
- 触发：对同一 active interaction 并发启动两条 walk，回复预算设为 1。
- 结果：stub 执行器调用 2 次、持久化 final Agent 消息 2 条、ledger reply 仅 1 条。
- 原因：没有 interaction 级持久化认领；每条 walk 生成独立 Turn/Message，结果最终化后才记账。
- 准入核对：探针包含读取真实 workspace_admissions 的生产同款检查。没有其他已授权 writer 时，该检查不为 chat-chat 建立互斥。
- 影响：重复回复、预算与消息不一致。真实 Provider 的费用、项目文件副作用没有在本轮验证。
- 定位：[respond 输入检查](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/routes/conversationRuntime.ts:771)、[独立 Turn 创建](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/GroupTurnDriver.ts:212)。

### F11｜reply 可跨 workspace/conversation 关联消息

- 等级：R，主审 3/3，独立复核额外 2/2。
- 触发：向 B 工作区 interaction 提交 A 工作区消息的 ID。
- 结果：成功保存关联；主审开启外键且 `foreign_key_check` 仍为 0。
- 原因：服务未核对消息归属，数据库只约束引用存在，没有约束它与 interaction 的工作区/会话一致。
- 影响：污染讨论归属；不能将这条事实泛化为整个系统已实测用户身份越权。
- 定位：[reply API](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/routes/conversationRuntime.ts:727)、[reply 持久化](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/store/GroupInteractionRepository.ts:222)。

### F12｜草稿和图片跨会话串用

- 等级：H+S；原始选择处理器重复 3/3，发送目标消费链确认。
- 触发：在 A 输入草稿/图片，切换到 B。
- 结果：A 的草稿、附件仍是页面共享状态，发送使用当前 B 会话。
- 原因：缺少按实际会话身份隔离的草稿与附件控制器。
- 影响：内容可能发往错误会话。没有真实浏览器发送验证。
- 定位：[页面共享状态](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:178)、[发送目标](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:788)、[会话切换](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:1241)。

## 4. P2/P3：其余确认发现

| ID | 优先级/证据 | 触发与后果 | 定位 |
|---|---|---|---|
| F13 | P2 / S，选择处理器 H 3/3 | A 流式中切换 B；A 回调仍更新共享消息，结束后无条件重新选择 A | [响应更新与收尾](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:945) |
| F14 | P2 / S | 选择非首条私聊后刷新；URL 恢复只查群聊，私聊默认选择首条 | [默认私聊选择](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:622) |
| F15 | P2 / S | 同会话任务超过 100 条；固定第一页无翻页，旧深链任务被误报不存在 | [固定分页查询](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/lib/useCollaborationProgress.ts:101) |
| F16 | P2 / H 3/3 + S | 发送期间粘贴新图片，完成回调清空当前全部附件，未发送图片丢失 | [附件清理](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:899) |
| F17 | P2 / H 3/3 | 组合输入期间 Enter 仍触发 onSend，没有 isComposing 判断 | [输入处理](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/components/chat/ChatPanel.tsx:436) |
| F18 | P2 / R 2/2 | 仓储 CONFLICT 未命中路由 COLLABORATION_CONFLICT 映射，实际返回 HTTP 500 | [错误映射](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/routes/collaborations.ts:91) |
| F19 | P2 / S | 普通会话 A 的深链指定同工作区 B 的 Run，前端无会话关联检查，呈现 B 的证据/操作 | [Run 列表构造](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:1412) |
| F20 | P2 / S | interaction 已绑定消息 A，却可 respond 同会话消息 B；执行/回复针对 B，讨论绑定仍是 A | [源消息检查](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/routes/conversationRuntime.ts:795) |
| F21 | P2 / S | 创建讨论已提交但响应丢失；页面不保存/复用原幂等键，也不恢复原讨论启动状态；再次发送可能被 active 阻止，停止重发可能重复用户消息 | [客户端幂等键](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:855) |
| F22 | P3 / S | 旧创建 interaction 路由允许 direct/archived 会话创建 active 记录，respond 又拒绝执行 | [兼容创建入口](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/routes/conversationRuntime.ts:692) |

F19 是 UI 对象绑定问题。Inspector 按 workspace + Run 查询、全局 Run 级 API 按不透明 Run ID 定位，不能仅因没有 conversation 参数就认定服务端越权。

## 5. 收紧、撤回与已通过机制

### 5.1 撤回/不计入缺陷

1. “正常切换协作任务后持续显示并操作上一任务”：初步局部 hook 判断遗漏父级 URL 更新；完整链会在 preferredTaskId 变化后清空旧 progress，故撤回。短暂导航窗口没有运行时复现，不作为确认缺陷。
2. 正常 `.gitignore` 排除缓存/构建产物：不是通用缺陷。忽略目录中实际源文件不进入哈希，只作为条件性风险，不能据此要求把全部 ignored 文件打入候选。
3. “git apply 必然半应用”：没有按该笼统结论报错。F01 证明的是文件写入与后续数据库失败之间的边界，不是 Git 默认补丁校验本身必然部分成功。
4. 全局 Run API 缺少会话参数：符合现有 Run 级契约。跨工作区身份授权要求与 F19 的 UI 绑定问题需分开处理。

### 5.2 本轮通过的机制

- 未跟踪新文件已经能进入统一二进制补丁；旧的“只进清单、不进差异”问题不能重复列为当前事实。
- 候选在评审前冻结；错误候选 hash、错误 attempt、多重评审结论、仅普通“通过”文字被评审协议拒绝。
- canonical 附件链路能追到 Provider runner 输入构造；没有确认到“群聊图片被静默丢弃”。本轮没有真实 Provider 图像理解验收。
- 正常同版本评审、仓储及快照专项通过；它们不能替代对取消、应用和并发负向场景的覆盖。

## 6. 未验证项、处置与交付状态

本轮未完成：

- 真实 Codex/KimiCode/OpenCode 新任务端到端运行。
- 真实 Provider 原生进程取消、外部文件副作用和中途服务重启演练。
- 生产构建、真实浏览器深浅主题矩阵、长消息性能与无障碍回归。
- 全部包的独立全量测试、依赖漏洞扫描以及所有未改动模块逐行审查。

浏览器给出的 4200 地址当时没有监听；没有将旧截图或既往成功任务当成本轮实机证据。

建议修复顺序：**版本校验和取消终态 → 候选范围/真实路径 → 恢复 → 群聊认领与归属 → 前端隔离 → 完整验收。**

报告状态：复审记录与可执行计划已形成，已有部分后续修复，但完整验收尚未通过。发布判断须以最终代码的负向回归与实机证据重新作出，不能引用修复前的绿色测试数宣称已安全。本次文档整理没有继续修改业务代码、启动服务或操作业务数据库。

## 7. 后续修复增量检查与当前阻塞

本节针对 2026-09-30 文档交付时的未提交修复树，不回写原 F01–F22 的复现事实。P1/P2 表示处理优先级；R/S 表示证据强度，两者不能互相替代。

### F23｜P2 / R：Git 换行规范化导致合法候选被误拒

- 条件：普通文本文件使用 CRLF，仓库 `core.autocrlf=true`；范围和路径均合法，快照期间没有写入者。
- 主审交叉验证：**三套全新临时 Git 仓库 3/3** 返回 `COLLABORATION_SNAPSHOT_SOURCE_CHANGED`；源文件、真实 index、HEAD、Git status 均保持不变。`autocrlf=false` 的 CRLF、LF 两个正向对照均接受。
- 原因：[候选快照](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationCandidateSnapshot.ts) 直接比较工作树原始字节和经过 Git clean 转换的 staged blob；合法 CRLF→LF 转换被当作并发源内容变化。
- 影响：Windows 常见仓库可能无法交付合法候选。没有证明误放行或秘密泄露，不扩大结论。
- 可重跑诊断：[CRLF 候选探针](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-09-30-crlf-candidate-probe.mjs)。从 `apps/server` 执行 `node --import tsx ../../docs/superpowers/reports/evidence/2026-09-30-crlf-candidate-probe.mjs`。退出 0 仅表示缺陷与对照已按预期复现，不代表修复通过。探针只写全新 Temp 夹具，保留夹具供复查。

### F24｜P2 / S：应用释放后的获准排队执行缺少恢复衔接

- 链路：准入 authority 的 `releaseCollaborationApplication()` 会推进队列并返回新获准主体；[生产接线](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/index.ts) 的应用释放回调丢弃结果，没有调用恢复执行入口。
- 对照：[协作服务](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationWorkflowService.ts) 的 Run 释放封装会查询 GRANTED 的排队协作 Run 并 `resumeRun()`，应用释放路径没有这一步。
- 后果范围：有任务在应用持有写入权期间排队时，准入已获准但业务启动缺少触发，可能保持 queued。完整“应用→释放→下一任务启动”尚未做运行复现；不宣称所有排队任务必然卡死。
- 必须验证：应用成功、已证明回滚、无 journal 准备失败三个安全释放场景，新获准 Run 都恰好继续一次；未知恢复状态不得释放或启动下一 writer。

### F25｜P2 / S：recovered journal 与控制终结间有恢复缺口

- 链路：[应用 journal](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationApplyJournal.ts) 回滚完成后先持久化 `recovered`；调用方随后在另一事务中终结控制。
- 崩溃窗口：若在两次持久化之间中断，`loadPending()` 不包含 recovered journal；协作启动恢复遇到任何已有 journal 又直接跳过该 apply 控制。控制可能永久 pending，即使文件已安全回滚。
- 边界：主审与独立审查均追踪到上述分支；本次没有在真实服务中注入崩溃，不称为完整重启实机复现。它是可执行的故障注入回归项。
- 必须验证：回滚已落盘但 control 未终结的真实数据库重开，以及重复重开；安全证明后收敛 control/准入且不重复应用。记录损坏或文件被用户改动时保留待处理，不能盲目释放。

### V01｜当前 Web 集成未通过类型检查

文档整理时重新运行 Server `tsc --noEmit` 通过；Web 同类检查失败，**12 条诊断**集中于群聊预算/outbox、提交快照、可空会话、缺失变量/队列引用及附件元数据。不能引用前一轮 252/252 单元测试，声称最新页面整合可构建。具体命令与诊断分类见修复验收记录。

### V02｜W12 失败待定因，不能标为偶发或已排除

已有实际结果：Process Runtime 全套 239 通过、1 失败；首轮隔离 `node-driver.test.ts` 15 通过、1 失败，均为 W12。前者检测到 test-owned PID `39788`，后者检测到新增 PowerShell PID `34132`。随后 17:13 的另一轮隔离重跑 16/16 通过；三次结果均保留，不能只引用最后绿色一轮。两次失败的断言对象不同，原因尚未确定；晚些时候 PID 消失不能证明断言时已无存活进程，也不能仅凭 PID 断言就确认当前业务进程泄漏。

下一步应记录 PID 的创建时间、父进程、命令和测试所有权，排除 PID 复用及并发工具进程，隔离串行重放并核对未修改的基线。此前失败保留在记录中；不得删断言、强制通过或宽泛杀进程。**原因明确且相应回归通过前，不宣称 Process Runtime 全绿。**

## 8. 当前文档交付复核（18:05 +08:00）

本节重新检查当前未提交工作树，而不是重新执行第 2 节的全部历史测试。主审复核源码与实际命令，并收集三个相关切片的只读交叉核对；没有把多个审查者读到同一段代码算成多次运行复现。

### 8.1 当前版本及可复查证据

- 分支与 HEAD 仍为 `codex/collaboration-workflow-closure` / `7d2ddf87111ad39b639c2a1082c11be716b8084d`，必须同时保存未提交实现。
- 文档更新前为 76 个已跟踪修改、52 个未跟踪文件。排除本次三份 Markdown 和复核 JSON 后，125 个文件的路径/内容摘要为 `F9694A77ABF5375CC83A7B246EEE4BCE8AC990FC16A633E88E1366010AF1CEEF`；算法及逐文件哈希均在证据附件中。该摘要不是全仓库或发布版本指纹。
- [本次命令结果与源码清单](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-09-30-report-recheck.json) 保存两轮类型检查、两轮 Web 测试摘要、最新完整 Web 测试输出及五个 CRLF 夹具结果。
- 本次未启动 API/Web。3000、3101、4200 均未查到监听，因此不提供当前真实页面或 Provider 运行通过结论。

### 8.2 当前实际重复验证

| 检查 | 重复与结果 | 可作出的结论 |
|---|---|---|
| Server TypeScript，禁用 incremental | 2 次，均退出 0 | 当前服务端类型检查通过，不代表完整服务端回归通过 |
| Web TypeScript，禁用 incremental | 2 次，均退出 1；每轮相同 12 条诊断 | 页面整合仍有确定的编译阻塞 |
| Web 完整单元套件 | 2 次，每轮 253 通过、0 失败、0 跳过 | 当前单元测试全绿，未覆盖所有页面接线缺口 |
| F23，`autocrlf=true` + 稳定 CRLF | 3 套全新临时仓库，全部误拒 | 当前产品缺陷仍可重复复现 |
| F23，`autocrlf=false` + CRLF/LF | 2 个正向对照均接受 | 不是所有候选都失败，不能扩大成通用快照失效 |

CRLF 探针退出 0 代表按预期复现缺陷，并明确输出 `bugFixed:false`。此前新增的正式 F23 回归矩阵只取得过部分红灯输出、未取得完整汇总/退出码，不记作完成的测试运行；产品快照代码仍直接比较原始字节和 staged blob。

### 8.3 前端修复接线仍需补齐（S 级）

以下沿用既有发现编号，属于当前静态链路确认，不新增一批“已做浏览器复现”的结论：

| 对应项 | 当前源码事实与最小触发路径 | 修复验收重点 |
|---|---|---|
| F21 | [页面 outbox 读取](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:915) 对 queuedItem 不读取原记录；后续无 outbox 时生成新键。排队发送已提交、响应丢失、刷新后 drain 是待运行反例 | 队列恢复沿用原 key、payload、source message 和 interaction；不是生成新讨论 |
| F16 | [私聊发送收尾](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:1211) 在 A 不再当前时提前返回，跳过已提交草稿的结算 | A 已提交内容按 A 身份结算，B 当前输入不受影响，A 发送期间新增内容保留 |
| F12 | [主页面 Composer 接线](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:1632) 未传 draftReady / draftPersistenceWarning；ChatPanel 默认 ready | 草稿加载时不接受会被忽略的输入；存储失败提示可见并保留内存草稿 |
| F19 | [Run 选择构造](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:1630) 仍将显式 Run hint 加入列表；runLinkState 尚未用于限制呈现或操作 | 会话 A + Run B 在加载证据前拒绝；合法未关联 Run 明确展示，不错误回落 |
| F13/F14 | [私聊切换](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/web/src/app/workspace/[id]/page.tsx:1459) 没有同步清除旧消息/全部证据；URL 群聊恢复分支未核验 storage source | 快速切换先撤下旧证据；同 ID 不同来源、刷新与前进后退只定位正确会话 |

组件/helper 测试通过不等于页面正确接入。先关闭 12 条类型诊断，再以页面级异步、队列恢复和错误 Run 深链测试验收；不能用强制类型转换或隐藏控件代替正确接线。

### 8.4 应用与恢复的剩余闭环

- **F24（S）：** [生产应用释放回调](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/index.ts:198) 仍丢弃 authority 的获准结果；[续跑 helper](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationWorkflowService.ts:1195) 仅用于 Run 释放。必须以真实准入竞争验证应用安全释放后队列恰好继续一次，不可只 mock 一个 release 回调。
- **F25（S）：** [rollback](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationApplyJournal.ts:129) 与 [control 终结](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationWorkflowService.ts:590) 仍分离；loadPending 不取 recovered，已有 journal 的 pending apply 又跳过。当前正式控制测试尚无 F24/F25 反例，仍需故障注入及真实数据库重开。
- **V02：** W12 原有失败未能追溯失败时进程身份。本次不把后来查不到 PID 当作已证明无泄漏；产品清理问题、PID 复用与外部 helper 干扰尚未区分。

### 8.5 文档交付判断

审查报告与修复计划可以交付，产品发布门槛仍未达成。下一步优先 F24/F25、F23 和前端整合，同时保留 F01–F22 已有修复的完整回归；最后完成 W12 归因、全套/构建、真实任务/取消、浏览器矩阵及独立复审。生成文档阶段没有修改产品代码、操作业务数据库、应用候选、提交、推送或合并。

## 9. 历史：18:51 报告生成复核

本节取代前文的“当前”交付判断，不改写其历史事实。验证仍位于同一协作工作树和 HEAD 加未提交实现。主审只维护文档与证据，保留此前切片已有的候选实现和新负向测试；没有继续产品修复、启动服务、调用真实 Provider、操作业务数据库或发布。

### 9.1 最新检查与证据边界

| 检查 | 本次实际结果 | 能证明 / 不能证明 |
|---|---|---|
| Server `tsc --noEmit --incremental false --pretty false` | 主审两次均退出 1；每次 2 条 TS2554 | 新 journal 原子终结测试传入回调，当前 rollback 只有一个参数；属于测试合同与实现未整合，不等于新发现两个生产漏洞 |
| Web 同类类型检查 | 主审两次均退出 1；每次 15 条诊断 | 原 12 条整合诊断仍在，另 3 条来自新增 outbox 测试调用尚不存在的方法；不能用删除测试或强制类型转换消除门槛 |
| Web 完整单元套件 | 主审两次均退出 1；最近一次 260 项，253 通过、7 失败、0 跳过 | 6 个源码接线断言和 1 个 outbox 功能测试失败；前 6 个不是浏览器行为验证，也不能仅通过匹配变量名就宣称行为已修复 |
| F23 候选快照专项 | 主审连续两轮，每轮 20 通过、0 失败、0 跳过，退出 0 | 包含 LF/CRLF、autocrlf/属性、二进制、外部 filter 预拒绝、实际源变化、范围外路径及 Windows junction；这是局部修复回归，不替代最终集成、评审与应用全链 |
| F24/F25 控制专项 | 侧车执行两次；修正夹具自身问题后的第二次为 24 项：3 通过、21 失败、0 跳过，退出 1 | 使用真实临时 Git/SQLite/准入 authority，dispatch 为计数 stub；没有真实 Provider 执行。第一次有测试自身错误，不能把两轮当作完全独立的正确反例 |
| W12 后续隔离与全套 | 侧车串行三次：第 1/3 次各 16/16，第 2 次汇总不可恢复；后续全套 240/240、退出 0 | 不补写第 2 次结果；历史失败 PID 身份仍未取得，因此原因未明，不写成 flake 或已关闭 |

主审命令、退出码、诊断和快照专项完整输出，以及侧车返回的证据范围，保存于 [本次交付复核证据](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-09-30-report-delivery-check.json)。旧证据 JSON 与旧 CRLF 诊断脚本保持原样；不能修改其期待结果制造修复成功。

### 9.2 仍需实施的具体缺口

1. **F24：安全释放后恢复原队列。** A 持有真实应用准入期间 B 确实排队；成功应用三套夹具均观察到 B 的 dispatch 列表为空。安全回滚反例也失败。`before_prepare` 用例所需注入点尚未实现，不能将该用例失败单独当作“准备前异常已实测”；需要实际准备失败路径。未知应用的三个正向安全控制均通过，保留用户改动与 writer hold。
2. **F25：恢复必须联合终结。** recovered journal + running control 的四类夹具各三次，首次真实数据库重开后的控制未收敛；测试在该断言失败，尚未到第二次重开，不能称“双重重启已验证”。同时静态确认 authority 和启动准入层只看 terminal journal 即可释放，没有联合核验 control 终态；修复需一并收紧，不能先放行下一个 writer 再验证恢复材料。
3. **V01 / F12–F21 前端接线：** 先统一提交快照与 outbox 契约，再落实原会话结算、草稿 ready/存储警告、真实来源 URL、可见消息身份和 Run 展示栅栏。新增源码形状断言只是早期信号，必须补异步页面与真实浏览器反例。
4. **F23：局部通过但未完成最终关闭。** 当前 raw 源稳定性与 Git clean 等价性已分开，正式矩阵两轮通过；继续运行路径/scope/评审和应用集成，不重写旧候选或历史评审。
5. **V02 与最终验收：** 不凭最后一次绿色清除历史失败；保留根因调查、当前完整 Server/受影响包、迁移副本、生产构建、真实三角色任务/取消和浏览器矩阵门槛。

### 9.3 发布判断

报告和修复计划可交付；**产品仍不可据此宣称已修复完成或可发布**。当前明确门槛是 F24/F25、Server/Web 类型与 Web 红灯测试，以及未完成的最终实机/恢复验收。本报告不是整个仓库逐行覆盖或依赖安全扫描的证明。

## 10. 本次 Markdown 定稿：当前结论与可执行交接

本节是最新结论，取代第 7–9 节的“当前”表述，但不覆盖其历史结果。核对时间：2026-09-30 19:19–19:24 +08:00。用户本次要求生成报告和修复计划，主审只整理文档、读取源码和执行隔离诊断；没有继续产品修复。此前实施阶段留下的半完成代码和测试全部保留。

### 10.1 当前版本与检查结果

工作树/分支/HEAD 与第 1 节相同。当前 `agentos` 目录内有 **128 个非文档 dirty/untracked 文件**，按路径及 SHA-256 聚合的指纹为 `A1F8D4DFB10FEC3BCC8C92007E573A1A6B863F50D7CBDA758003EC1F3A12F5D2`。算法排除整个 `docs/`，不包含干净文件或 Git 根目录之外的变动，不能作为全仓库、发布版本或与早期不同排除集合等价的指纹。定稿前后对同一集合核对，结果与逐文件摘要见 [本次定稿证据](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-09-30-md-report-final-check.json)。

| 检查 | 主审本次结果 | 结论边界 |
|---|---|---|
| Server `tsc --noEmit --incremental false --pretty false` | 两次退出 0 | 先前 journal 回调类型红灯已不再出现；不是 Server 全量测试或构建通过 |
| Web 同类类型检查 | 两次退出 1，每次相同 3 条诊断 | 仍无法通过完整类型检查，不能宣称页面可交付 |
| Web 完整单元套件 | 两次均 262 项：256 通过、6 失败、0 跳过，退出 1 | 5 个页面源码接线断言、1 个 outbox 合同测试失败；不是 6 个浏览器 E2E 缺陷 |
| F24/F25 控制专项，名称过滤 | 31 项：19 通过、12 失败、0 跳过，退出 1 | 真实 Temp Git/SQLite/准入 authority，Provider dispatch 是计数 stub |
| 外部 filter 预拒绝与两种竞态 | 连续三轮，每轮 1 通过、2 失败、0 跳过，子命令退出 1 | 稳定配置可预拒绝；预检后变化仍先产生外部 filter 副作用 |
| API/Web 监听 | 3000、3101、4200 均未观察到监听 | 本轮未启动服务，也没有当前浏览器或真实 Provider 通过证据 |

Web 的三条诊断分别是 `page.tsx:1213` 的可空 conversation、`:1223` 未定义的 `createdConversation`、`conversationDraftRepository.ts:177` 将持久化附件元数据当作已有 previewUrl 的 UI 附件。它们是当前实测整合阻塞，不新增三个业务漏洞编号。

### 10.2 F26｜P1 / R：clean-filter 预检存在可重复的竞态窗口

- 新发现与 F23 的换行误拒不同：F23 比较两个不同表示的内容；F26 则在拒绝不支持配置之前已经执行外部命令。两者不能因为位于同一文件就视为同一根因。
- 定位：[预检](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationCandidateSnapshot.ts:277)、[全树 git add](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationCandidateSnapshot.ts:301)、[事后路径集合检查](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationCandidateSnapshot.ts:310)。
- 反例一：[预检后新增文件](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationCandidateSnapshot.test.ts:165)。属性已指定未来文件的 filter；较早 inventory 中没有该文件，预检后再创建它。全树 add 触发 filter，之后才拒绝路径集合变化。
- 反例二：[预检后改变属性](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/CollaborationCandidateSnapshot.test.ts:193)。预检时没有 filter，之后改 `.gitattributes` 给已有 tracked 文件添加 filter；Git 使用变化后的配置执行 filter。
- 两类各 **3/3** 失败于“marker 不应存在”断言：候选被拒绝，但 marker 已存在，证明被禁止的命令实际执行。稳定 filter 的正向安全控制 **3/3** 通过，说明不是所有预拒绝路径失效。
- 独立侧车还以临时仓库探针确认 marker=`ran` 且真实 index 未变。主审正式测试在 marker 断言失败后未执行到最后的 index 断言，不把侧车的 index 证明包装成主审三轮都完成了全部断言。
- 影响仅限已证明的快照执行权限边界失守。本轮 filter 只写虚构 marker 并回传 stdin，没有访问真实秘密；不宣称已实测远程利用、秘密泄露或用户项目损坏。
- 修复不能只把 add 改为显式路径或再检查一次属性：第二类反例仍要求保护属性与配置上下文。采用冻结输入和无外部 filter 执行能力的受控 Git 上下文，并保留合法换行、真实 source-change、scope 与路径反例。

### 10.3 F24/F25：局部修复与当前阻塞分别记录

**F24：服务级回归局部通过，生产接线未完成。** 六类场景（成功、已证明回滚、before_prepare、unknown、dispatch 禁用、当前 Run 不匹配）各三次，再加 101 个排队项反例，共 19 项通过。before_prepare 本轮确实触发，成功/安全失败继续原 B Run，unknown/禁用/错误关联不 dispatch。这不是此前“注入点未触发”的结果。生产 `index.ts` 仍未向协作服务传入现有 dispatch 开关，启动恢复中的释放路径也未统一到获准队列续跑；因此不能关闭整个 F24 或据服务夹具证明真实启动已安全。

**F25：启动准入过早释放仍可复现。** 安全 preimage、用户新改动、损坏恢复材料、错误 epoch 四类各三次，全部在首次真实 DB 重开后、协作恢复协调器之前失败：持有者不再保持 GRANTED。源码对照：[Authority](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/WorkspaceAdmissionAuthority.ts:566) 与 [StartupReconciler](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/apps/server/src/services/WorkspaceAdmissionStartupReconciler.ts:546) 只凭 terminal journal 判可释放，没有联合验证 control。journal rollback 已加入事务回调、loadPending 已能读 terminal journal + pending control，但这些局部改动不能弥补更早的释放。

12 个红灯代表同一释放缺口的场景/重复矩阵，不是 12 个独立漏洞。失败发生在早期断言，未到协作恢复、第二次重开或下一 writer 实际运行；不宣称双重恢复已验完，也不宣称已实测两条真实 Provider 写入冲突。

### 10.4 前端与 W12 的剩余工作

- **前端：** 私聊结束仍在结算原身份前因切到另一会话而 return；Run hint 仍直接送入 Inspector；草稿 ready/警告、可见证据身份和来源 URL 尚未接完。新增控制器/helper 的局部通过不能替代页面行为验收。
- **outbox 合同：** 当前失败的测试最后要求“未指定 queue ID 时返回已有 queue-a”，实现选择拒绝错配。尚不能直接认定实现错误；修复应先确定恢复入口的显式队列身份，再统一调用方与测试。无论采用哪种恢复入口，都不能借用另一条队列的 key/payload 来换取绿色测试。
- **W12：** 侧车已仅修改测试的进程身份/所有权判别，加入真实 Job 成员存活正控、不同父进程 PowerShell 负控和 PID reuse 对照。修正后单文件 fresh 三轮各 19/19；定向选择为 4 通过、15 跳过。主审本轮未重新运行 native 验证；不得将该数字当当前全包通过。
- **历史根因：** 侧车在未修改基线的三轮隔离中报告 16/16、15/16、15/16，后两轮 W12 涉及 PID 40912/40340；失败时身份未留存。受控外部 helper PID 38108 可证明旧测试会误收外部进程，但不能证明所有历史失败都来自该原因。修正后的全包测试、编译和耗时评估仍缺失，也没有证明产品进程清理缺陷已经排除。

### 10.5 修复顺序与交付判断

1. 先修 **F26 的无副作用 filter 边界** 和 **F25 的 journal/control/准入联合恢复**；完成 F24 生产 dispatch 开关与启动队列接线。
2. 并行完成 Web 三条诊断与页面身份/结算/Run 绑定，按正确合同修正 outbox 恢复入口和回归，不只满足源码正则。
3. 运行当前整合版本的全套、迁移副本和生产构建；补 W12 修正后的完整验证及历史失败边界。
4. 专用本机实例验证真实三角色任务、取消、讨论停止和浏览器矩阵；候选停在待应用，最后独立复审。

本次交付是 **审查报告与可执行修复计划**，不是修复完成、全仓逐行覆盖、发布或应用授权。保留全部旧证据、现有修改、业务数据和候选；本轮没有提交、推送、合并、部署或应用真实候选。

