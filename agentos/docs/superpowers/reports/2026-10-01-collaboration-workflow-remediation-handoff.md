# 协作工作流严格修复交接

更新时间：2026-10-01 04:25 +08:00。状态：本地修复及本计划覆盖范围内的最终验收已完成；**不是发布报告或“全仓绝无漏洞”的证明**。条件跳过、历史证据缺失及实际 Provider 限制见第 6 节。

## 1. 版本与边界

- 实际工作树：`C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos`。
- 分支：`codex/collaboration-workflow-closure`；HEAD：`7d2ddf87111ad39b639c2a1082c11be716b8084d`。HEAD 加未提交改动才是验收对象，不能只用 HEAD 标识修复版本。
- 执行依据：[审查修复计划](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/plans/2026-09-30-collaboration-workflow-audit-remediation.md)。历史失败及按时序取得的证据见[修复验收记录](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/2026-09-30-audit-remediation-verification.md)第 10 节；以其 10.11 节和本报告为最终结果，不把中途快照当当前状态。
- 最终非文档 dirty/untracked 指纹为 `4e32b9fd8d7272ff90b45d5732514c5361aa2088a3080b452f80e987a9baec33`，136 个文件；它包含既有修改，不代表 136 个文件全由本轮改动。[逐文件 SHA、完整命令及源码绑定](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-10-01-remediation-final-verification.json)；[最终补充核验](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-10-01-remediation-final-addendum.json)。HEAD 标识未变；未变的已跟踪内容以 HEAD 为基础，指纹不是全磁盘哈希。
- 没有清理业务数据、应用真实候选、提交、推送、合并或部署。用户原生 IME 人工验收已通过，未发送或清除其“测试”草稿。

## 2. 本轮修复范围

| 发现 | 当前实现与正式回归 | 当前结论与边界 |
|---|---|---|
| F01 | `CollaborationWorkflowService.control.test.ts`、`CollaborationApplyJournal.test.ts`：写前/写后/提交前故障，原字节恢复、同键仅一次、用户新改动保留 | 已闭环；各故障三套 fresh fixture，当前完整 Server 通过；应用只在隔离仓库测试 |
| F02 | control 的三套 completed Start + running Run 取消；另有真实 Kimi PID/birth 停止记录 | 已闭环；不把未知 owner 写成已停止 |
| F03 | control 的三套陈旧取消及竞争 fence：外部取消回调、Run/Stage 均零副作用 | 已闭环；实际版本冲突不能自动重试写操作 |
| F04 | control/terminal repository：取消/应用后 CAS，不被阶段、评审、返工或恢复复活 | 已闭环；原终态事实保留 |
| F05 | control 的三套 expectedVersion 100 等拒绝，Run 图及工作树创建前检查 | 已闭环；不只校验客户端字段类型 |
| F06 | `CollaborationScopePolicy.test.ts` 与 workflow 路由：精确文件、目录、全仓及改名双路径 | 已闭环；范围外改动拒绝而非裁切；最新边界/评审三轮各 16/16 |
| F07 | `CollaborationPathBoundary.test.ts`、Snapshot、Journal：Windows 原生 junction、祖先变动、Git 控制路径及设备/ADS 拒绝 | 已闭环；当前 Windows 未跳过 junction；同组三轮 16/16 |
| F08 | control 的 queued/missing/unknown/waiting/terminal 全启动组合、两次实际 DB 重开；专用 API 强制中断 | 已闭环；unknown 保持待处理，不能重放 Provider，旧未知进程退出未证实 |
| F09 | `BoundedGroupService.test.ts`、Driver、HTTP route：stop 版本、final/stop 竞争、预算=1 及事件版本 | 已闭环；四文件群聊三轮 63/63；停止后续发言不等于未知原生进程已终止 |
| F10 | `GroupTurnDriver.test.ts`：两 SQLite 连接、2/10 并发各三套 fresh fixture；HTTP headers 前拒绝已有/中断 owner | 已闭环；四文件三轮、实机断线与 409 零重放均核验 |
| F11 | Bounded、Repository/迁移 041：source、Turn、作者、Message/ledger 跨工作区/会话拒绝 | 已闭环；四文件三轮加当前 Server/迁移验证，不能用 FK 正常代替归属断言 |
| F12 | Web draft/Blob/controller 与 `workspace-identity.spec.ts`：实际 storageSource 身份隔离及迟到发送结算 | 已闭环；最终 Web 270/270，页面三轮 15/15，发送期间新文本/图片保留 |
| F13 | Web generation、订阅清理与原身份结算；A 的迟到响应/错误不影响 B | 已闭环；浏览器 fixture 为页面行为证据，不冒充真实 Provider |
| F14 | 显式非首条、跨 Agent 私聊、legacy canonical group 与同 ID 不同来源 URL | 已闭环；刷新/前后退、错误及歧义链接 fail closed 三轮验证 |
| F15 | 同群真实 102 条未确认任务，100+2 分页、第 101 条深链；页面 fixture 重复 | 已闭环；实机 5/5、零 Run，不是 102 次 Agent 执行 |
| F16 | IndexedDB 元数据/Blob 及提交附件 ID/revision 精确结算 | 已闭环；页面 fixture 验发送期间新增图片；真实未发送 Blob 5/5，不证明 Provider 识图 |
| F17 | ChatPanel composition、Enter/Shift+Enter 与用户原生 IME | 已闭环；人工通过、自动 composition 三轮通过，未操控用户输入法或草稿 |
| F18 | `collaborations.control.test.ts`：真实仓储、版本与 WorktreeError HTTP 409/400 映射 | 已闭环；既有 HTTP 500 红灯保留，三套新错误夹具及当前完整 Server 通过 |
| F19 | 页面 Run 关联栅栏：loading/mismatch 时无 Inspector、证据、取消/重试请求 | 已闭环；错误深链三轮通过，不借用首条执行 |
| F20 | Driver 的冻结 source A/请求 source B 拒绝，Provider 前零写入 | 已闭环；四文件群聊三轮覆盖，源消息不可按时间或文本猜测 |
| F21 | Web outbox 同原 queue ID/key/payload 恢复；HTTP 创建响应丢失与幂等读取 | 已闭环；真实浏览器 fixture 三轮验证零新增消息/讨论，新项不能借旧键 |
| F22 | 群聊兼容创建路由统一服务校验 direct/archived/unavailable | 已闭环；四文件三轮验证不留下 active 无效记录 |
| F23 | `CollaborationCandidateSnapshot.test.ts`：raw 字节稳定与 clean 语义分离，LF/CRLF/autocrlf/属性/二进制 | 已闭环；完整 Snapshot 三轮 38/38，真实 index 不改，真正源变化仍拒绝 |
| F24 | control/Authority/Startup：安全 release-gap、cancel-gap、原队列仅一次、生产 dispatch flag、原 GRANTED 写前互斥 | 已闭环；原 27 项冲突红灯修为 36/36；最终 Startup 138/138、生产四用例三轮 4/4、当前完整 Server 通过 |
| F25 | Journal/control/epoch 联合证明，preimage/postimage 同关联验证；损坏/用户新改动保持 hold | 已闭环；双重真实重开、release 失败不回滚已提交事实、当前完整 Server 通过 |
| F26 | 受控 Git 上下文覆盖 status/diff/add/hash/checkout：冻结属性/配置、no-checkout 协作树、精确 postimage 应用/恢复 | 已闭环；Snapshot 三轮、Journal 最终 55/55、受控 Worktree 13/13、边界 16/16 三轮及完整 Server；普通非协作 Runtime 默认分支不重写 |
| F27（新增） | 空 speaker plan 同样持久化 claim/plan/done；内部空计划许可不放松默认 claim | 已闭环；正式三套 fresh 和实机三组×两条 completed、后续 201、重放 409、零 Provider |
| V01 | shared DTO、可空会话、outbox/附件 metadata 页面接线及最新类型整合 | 已关闭当前验证阻塞；Web 270/270、两侧 tsc 0、全仓 build 0、正式 desktop 16/16 |
| V02/W12 | PID/birth/parent/command/owned Job 识别；外部 helper、PID reuse 与真实 owned survivor 负向控制 | 已关闭当前验证阻塞；Runtime 243/243、native 三轮 19/19、编译通过。**历史归因仍部分**：旧 PID 身份缺失，按计划 1.4 保留，不能反向证明所有旧失败或所有清理路径 |

上述行是逐发现追踪表。路径未写目录的 Server 测试位于 `apps/server/src/services`；路由位于 `apps/server/src/routes`，Web 页面用例位于 `apps/web/e2e`。当前完整 Server/Web 套件包含这些正式测试；第 4 节列出可重放入口及精确证据。专项数不相加成“全仓总数”，旧专项不覆盖后来改动的文件；完整套件与最终源码绑定另行核验。

## 3. 实机事实

专用 API 数据根：`C:/Users/Administrator/AppData/Local/Temp/agentos-audit-live-20260930-9a853e6a`；独立项目为其 `project`，baseline `8117d2ae378cd0be17ef3edfc3a21ab2c1904a00`。API 3000 / Web 3101 均来自本工作树。原业务库、用户项目及 Git 历史未改。

- 新三角色任务 `collab_01M3SQNAQHNHQYCD3B12R3KVV3`，Run `run_01M3SQNDA46BSKEDJS0ZX4H1CC`；Codex 规划、KimiCode 实施、OpenCode 评审，使用既有 GPT-5.6-Luna 配置。
- 实际命令 `node --test test/*.test.js`：10/10、退出 0。候选 `artifact_01M3SQWFFM7R6ZQJQKXTM90WT6`，SHA-256 `ef5b879f4d1f8dcd297dd5268eb29bb5f1d9d13031a0c49f2ea6bbf54725141f`；评审 `review_edbf6fef-abea-40cb-b852-6fb93809e0ce` 绑定同一候选/hash/Run/attempt 1。状态保持 `awaiting_application`。
- Codex 公开规划答复说明 CLI 终端不可用，未真实读 README/test；不能报告所有 Agent 工具均正常。Provider 的 `COMPACTION_SUMMARIZER_UNAVAILABLE` 非致命告警保留。
- 成功纵向证据：[任务、差异、测试、评审及浏览器记录](C:/Users/Administrator/AppData/Local/Temp/agentos-audit-live-20260930-9a853e6a/vertical-2026-09-30T18-01-35-146Z/result.json)。该任务未应用。
- 图片本地草稿通过 file input、页签与刷新核验 Blob SHA；未发送的这个用例不证明服务端上传或 Provider 识图。
- 最终只读 GET 再核对该任务：规划/实施/评审均 completed、attempt 1，作者分别 codex/kimi/opencode，公开输出状态均 available，长度分别 567/563/186 字；没有用替代文本补齐。候选 `diffText` 3295 bytes 的 SHA 已独立重算，等于候选及评审的 `diffHash`。[最终补充证据](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-10-01-remediation-final-addendum.json)只保存公开元数据及长度，不包含内部日志或提示。
- 04:08 只读安全检查：无活动 canonical Run，无 claimed/running owner；owner 17 completed、1 interrupted；两个真实成功任务仍 awaiting_application，integrity OK、FK 0。独立项目 `src`/`test`/README 无改动、HEAD 仍 baseline，未应用候选。
- 04:15 核实 API 3000 PID 21244、Web 3101 PID 7388；`GET /api/health` 返回 200/ok。原业务库没有作为故障夹具，用户浏览器未连接自动化。

## 4. 最终测试、版本绑定与浏览器验收

所有命令均从本工作树运行；完整命令、起止时间、退出码、log/result SHA 与前后源码清单在最终两个证据 JSON 中。下表不把重复跑或重叠专项相加。

| 验证 | 最终实际结果 | 精确日志标签/入口 |
|---|---|---|
| 完整 Server | 3421 项：3413 通过、0 失败、8 条件跳过；exit 0，约 46.6 分钟 | `server-2026-09-30T18-59-42-734Z`；`pnpm --filter @agentos/server test` |
| 完整 Web | 270/270、0 skip；exit 0 | `web-2026-09-30T19-46-51-657Z`；`pnpm --filter @agentos/web test` |
| Server/Web 类型 | 均 exit 0 | `types-2026-09-30T19-46-51-657Z`、`webtypes-2026-09-30T19-36-00-307Z`；各包 `exec tsc --noEmit`，Web 另加 `--incremental false` |
| Shared | 186/186、0 skip；exit 0 | `shared-2026-09-30T19-37-43-854Z`；从 Server 的 tsx 运行 `../../packages/shared/*.test.ts` |
| Agent Core | 199/199、31 文件；exit 0 | `core-2026-09-30T19-37-43-801Z`；`pnpm --filter @agentos/agent-core test` |
| Process Runtime | 243/243、19 文件；exit 0 | `runtime-2026-09-30T19-37-43-840Z`；`pnpm --filter @agentos/process-runtime test` |
| 全仓生产构建 | exit 0；Next 14.2.35；配置跳过 lint | `build-2026-09-30T19-36-06-623Z`；`pnpm -r run build`；workspace First Load JS 448kB，仅记录非性能门槛 |
| 官方 desktop Chrome | 16/16、0 skip；exit 0 | `browser-2026-09-30T19-35-49-980Z`；`pnpm --filter @agentos/web exec playwright test --config playwright.phase-e.config.ts` |
| 正式页面完整重复 | 617/1440/617 ×900，每轮 15/15、exit 0；合计 45 次，0 retry | [三轮 commands/五文件 SHA/45 traces](C:/Users/Administrator/AppData/Local/Temp/agentos-web-final-repeat-20260930-194242-934e9d24/command-records.json)；临时 config 只改 viewport/output |
| 四文件群聊重复 | 每轮 63/63、0 skip、exit 0 | `groups-2026-09-30T19-37-53-995Z`、`…19-41-05-236Z`、`…19-41-05-253Z`；后两轮为独立夹具、并行运行 |
| scope/path/review 重复 | 每轮 16/16、0 skip、exit 0 | `boundary-2026-09-30T20-15-02-837Z`、`…20-15-26-859Z`、`…20-15-26-885Z`；后两轮独立夹具 |
| W12/native 隔离串行 | 每轮 19/19、0 skip、exit 0 | `native-2026-09-30T18-33-07-016Z`、`…18-40-39-184Z`、`…18-40-56-327Z`；`vitest run src/node-driver.test.ts --maxWorkers=1` |
| 原生产 startup 集成 | 每轮 4/4、0 skip、exit 0 | `startup-2026-09-30T19-01-49-882Z`、`…19-03-15-175Z`、`…19-03-25-476Z`；原四用例/超时未放松 |
| 真实 API 响应式/双主题 | 617/719/1014/1440/1920 × light/dark，十格、180/180，0 写请求 | [最终矩阵](C:/Users/Administrator/AppData/Local/Temp/agentos-audit-live-20260930-9a853e6a/matrix-live-2026-09-30T19-16-00-226Z/results.json) |

### 4.1 哪些源码真的冻结

- 完整 Server 的全树 `sourceStable=false` 如实保留：运行时仅 `apps/web/e2e/workspace-identity.spec.ts` 和 `ChatPanel.tsx` 变化。逐文件比较证明**所有记录到的非 Web 源码（含 Server、三个依赖包及根配置）**运行前后及最终时点均相同；据此计为当前 Server/依赖验证，不伪称全仓同时冻结。
- 最终 Web、Shared/Core/Runtime、两侧 tsc、build、official browser 的全部非文档 dirty/untracked 摘要均稳定并匹配最终指纹。W12 早期三次只按 Process Runtime 包和根配置核对；Server 后续变化不属于其证明范围，最新完整 Runtime/build 另验。
- 三轮 15 条 Browser 边车仅声明五个列出文件 SHA 稳定；主审完整命令的全树指纹另核对，不能拿五文件证据当全仓证明。最终 e2e SHA `dd154fd631c67b66d935a952834fc27afc8617860361a5d7461e344569fbb2bc`；ChatPanel SHA `258eb8adc22e5038b99a6a04b2753ad0de983f2ce93f56ca860ec67d55b482c9`。
- 保留早先 I07 真实生产缺陷及 wheel 15/16 失败。I07 是 terminal cleanup 掩盖原 GRANTED 冲突，已用写前校验修复；wheel 最后红灯则是用例未等待 execution/Composer 卸载，修正测试前置，420/540、pending、ready 和 storage 断言原样保留，未修改产品去放松门禁。

### 4.2 浏览器 QA

路径：3101 指定群聊/任务 → 对话与执行页切换 → 草稿/图片/历史选择/滚动恢复 → 刷新或前后退 → 当前对象、草稿和证据不串联、不产生写入。

使用前端测试调试技能：Browser 插件未提供，采用已安装 Chrome、全新非持久化 Playwright context；不使用 CDP 或用户 storageState。页面 fixture 与真实 API/Provider 证据分别记账。React 接线保留基本类型 identity/generation 与 transient ref，不引入新状态库。

| 检查 | 结果 | 依据 |
|---|---|---|
| 页面身份/非空 | 通过 | 最终矩阵每格 task/Run/URL 与 ready Composer 断言 |
| Framework error overlay | 未出现 | 实际 DOM 与截图复核 |
| Console 健康 | 最终矩阵及成功任务无 error/warn | 原中断 UI 的一个旧 GET ERR_ABORTED 单独分类，不笼统忽略网络失败 |
| 截图 | 已核验 | 主审查看最终 617-dark 对话及 1440-light 执行截图，实际末尾安全间距约 +56.8px，不作为所有 DPR 的像素合同 |
| 真实交互 | 通过 | 十格中页签、目标折叠、草稿、主题、刷新与 scroll identity 共 180 断言；正式 API fixture 三轮另验故障时序 |
| 人工 IME | 用户确认通过 | “测试”只上屏未发送，未操作用户草稿 |

截图：[窄屏深色对话](C:/Users/Administrator/AppData/Local/Temp/agentos-audit-live-20260930-9a853e6a/matrix-live-2026-09-30T19-16-00-226Z/617-dark/chat-after-refresh-at-max.png)、[桌面浅色执行详情](C:/Users/Administrator/AppData/Local/Temp/agentos-audit-live-20260930-9a853e6a/matrix-live-2026-09-30T19-16-00-226Z/1440-light/execution-collapsed.png)。完整导航下 Inspector 尚有部分原始英文状态；这不是“所有中文视觉细节已重做”的验收。Browser 插件若以后安装，可补内置浏览器同路径复核，本轮没有安装依赖或插件。

## 5. 迁移、恢复材料与维护边界

- 新增 040/041，不改已登记 001–039 checksum。本轮重跑实际 MigrationRunner：新库、039 版非空夹具、实际 038 旧审计副本、原业务 seed 的一致性只读备份；039/038 均迁移到 041，旧列逐表内容哈希保留。每库连续关闭重开三次，全表摘要/迁移记录稳定、integrity OK、FK 0；两个来源连接只读且前后相同。[完整演练](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-10-01-migration-rehearsal-final.json)。恢复/副本材料保留于 `C:/Users/Administrator/AppData/Local/Temp/agentos-final-migration-20261001-7LVbIz`。此次迁移未触发 destructive backup hook；不伪报 hook 或独立 P3 Restore 已运行。
- 应用 journal 恢复用隔离仓库测试，真实用户候选仍未应用。prepared/written/mixed 等窗口使用原候选的恢复材料和 preimage/postimage；正确 task/candidate/base/hash/epoch/version 经验证后，事实与 control 同事务收敛。终态 journal + pending control 不提前释放 writer。
- 维护时先核对绝对项目根、真实服务/DB、活动 writer，生成一致性 SQLite 备份并单独保留 journal/候选/受管工作树；不得只复制处于 WAL 写入中的裸 DB 或删除恢复目录。**本轮没有在用户库执行上述维护写操作。**
- 正常且可证明的恢复由现有生产启动协调器收敛；只继续原已取得准入的 queued Run，不创建新 Run/attempt。材料损坏、关联错误、用户新改动或进程 unknown 保持 recovery_required/hold。没有证据时禁止手改 DB 为 completed/RELEASED、盲目重放、stash/覆盖用户文件或宽泛杀进程。
- 应用已 committed 而 release/dispatch 失败，保留 applied/committed/completed 与可观察警告；同一原幂等请求或启动恢复只补安全 release，不重写已应用文件。是否执行维护或应用仍需另外授权。
- 中断群聊的旧 interaction 保持 interrupted/unusable、明确原因，重复 respond 实际 HTTP 409 且原消息/Turn/ledger 不变。[最终重启复查](C:/Users/Administrator/AppData/Local/Temp/agentos-audit-live-20260930-9a853e6a/group-restart-recheck-2026-09-30T19-28-45-614Z/result.json)。没有实现可凭一次“继续”安全重放未知 Provider 的新功能；原记录只读保留。
- 临时证据、日志和 traces 位于 TEMP，会受用户后续清理影响；交接时应保存这些明确列出的目录。仓库内 JSON 保存命令、哈希、结果和关联，不能在日志遗失后声称仍拥有完整原始证据。

## 6. 条件跳过、未证实边界与发布状态

完整 Server 的八项条件跳过：

1. P3 real-copy migration / Backup / isolated Restore：未设置 `AGENTOS_P3_SOURCE_ROOT`；本轮 SQLite 副本演练不等价于需要 legacy JSON 的该用例。
2. R34 Unix socket clean-close：仅文档化 Unix 行为，在 Windows 跳过。
3. LITE-07-104 真实 Provider 到 accepted Memory Entry。
4. current-machine Kimi 完整链 gate。
5. LITE-04-101 current-machine Codex gate。
6. LITE-04-101 Kimi 显式 routed model gate。
7. LITE-04-101 real OpenCode canonical production gate。
8. LITE-08-005/006/007 + LITE-07-103 真实 Provider 持久化审批 gate。

后三到八项为单独的 env-gated 用例，未开启。本轮三角色开发任务、真实审批/取消/讨论是另有实机证据，不反向把六个 skip 改成 passed。[原始八项名称](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-10-01-remediation-final-addendum.json)。

剩余边界：历史 W12 PID 身份不可补采；旧中断讨论原生进程退出未证实；Codex 规划终端不可用；非致命压缩告警存在；真实图片用例未发送/未验 Provider 识图；只验证 Windows+Chrome，不声称 Edge/Firefox/macOS/Linux 都通过；build 跳过 lint，CI 未启动。以上不以“无错误”或“所有工具可用”掩盖。当前被复现的控制/候选/恢复/前端 P1 回归均有当前证据，没有把历史缺失升级为已证实安全。

**交付停点：本地未提交修复及验收材料。** 没有 commit/push/merge/部署，也没有真实候选 apply。本轮本地验收不替代发布审批、未来 CI 或使用方复审；源码若改变须重算指纹并重跑相关门槛。预览保留 3101，可只读打开本次成功任务的对话/执行详情。

## 7. 后续授权上传与重新验证（2026-10-01）

本节记录用户随后明确要求“上传 github，并测试”的新发布阶段；第 1–6 节及旧证据 JSON 是此前交付时点，保留原样，不追改历史结果或哈希。上传仅限 `codex/collaboration-workflow-closure`，不建 PR、不合并 main、不部署、不应用候选。

- 发布内容逐项核对原 136 文件非文档 manifest；其中唯一的后续源码变化为 `packages/process-runtime/src/node-driver.test.ts` 的测试夹具。公开检查另核对计划 1 份、报告 4 份和 evidence 8 份，没有发现真实凭证、业务数据库或 Provider 原始提示/进程日志内容。日志、截图、HAR、数据库和临时工作树仍留在本机，不打包上传。
- 本次重跑首先保留真实红灯：`runtime-2026-10-01T04-28-49-945Z`，242/243、exit 1。W12 记录 PID 34068 时短命 control child 已自然退出，没有采到 birth；最后快照同 PID 属于并行 Server 测试 `CollaborationApplyJournal.test.ts`。这是采集夹具缺失身份的复现，不是证明产品进程泄漏，也不掩盖 fail-closed 的未知身份断言。
- natural-exit 夹具现用 ready/release 文件握手，采集 live birth 后才允许子进程自然退出；该 controller 明确标注 test-owned-control。新增“birth 缺失依然失败”负向用例。产品 ProcessDriver/cleanup 及 W12 survivor 判定未改，不杀观察到的其他进程。
- 修复后 native 三次均 20/20、exit 0：`native-…04-36-00-355Z`、`…04-37-46-938Z`、`…04-38-42-861Z`。Runtime 全套三次均 244/244、exit 0：`runtime-…04-37-36-673Z`、`…04-39-28-073Z`、`…04-41-22-579Z`；运行期间 Server 测试仍并行，未用停止其他进程规避 PID 复用。上述标签全部前缀为 `2026-10-01T`，原日志保留在第 3 节所列 TEMP 目录。
- 本次 Web 270/270、Shared 186/186、Agent Core 199/199，Server/Web tsc 无诊断。`pnpm -r run build` 在夹具修改后再次 exit 0；Next 依配置 skips lint，不计 lint 通过。
- 独立 `127.0.0.1:4200` 生产 Web 的官方 Chrome browser fixture 16/16、exit 0（所有 API 拦截，不触碰业务实例）；真实 3101 的 617/719/1014/1440/1920 双主题矩阵十格通过，180 断言、0 API 写请求。截图、task/Run 选择、草稿、页签/刷新 scroll 和 Composer safe area 均复核，用户人工输入的“测试”草稿未操作。
- Lite 脚本回归 38/38；scope verifier exit 0，冻结矩阵仍为 230 PASS / 165 DEFERRED，没有更改冻结范围或升级任何历史状态。
- 发布时完整 Server 重跑 `server-2026-10-01T04-25-10-821Z` 仍执行；不得以第 4 节旧结果填成本轮结果。GitHub 使用现有 `workflow_dispatch`，其结果也须在实际结束后单独记账。当前段落不是 CI 通过证明。

发布版本的实际 commit、远端 SHA、CI URL 和本轮最终 Server 结果将在后续发布核验中补充；不会将执行中的验证写成全绿。两份真实成功候选经只读 SQLite 检查仍为 `awaiting_application`，integrity OK、FK 0，无 active Run/claimed owner。

