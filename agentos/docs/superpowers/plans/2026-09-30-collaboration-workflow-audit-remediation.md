# AgentOS 协作工作流审查修复计划

日期：2026-09-30  
文档更新：2026-10-01；第 1.4 节为实际执行依据，第 1.1–1.3 节保留此前执行快照。  
状态：2026-10-01 已按用户“严格按照修复计划进行修复”完成本地实现及本计划覆盖范围的组合验收；第 1.1–1.4 节保留制定时的红灯与边界。最终结果见 [修复验收记录](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/2026-09-30-audit-remediation-verification.md)第 10.11 节与 [交接报告](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/2026-10-01-collaboration-workflow-remediation-handoff.md)。条件跳过和历史 W12 身份缺失如实保留，不代表全仓无漏洞、已提交或已发布；尚未验证的能力不以局部通过替代。  
依据：[严格复审报告](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/2026-09-30-collaboration-workflow-strict-reaudit.md)  
目标：关闭报告 F01–F26，并查明 V01/V02 的集成与验证阻塞；先恢复控制与数据正确性，再完成交互回归，不以既有绿色测试数替代修复验收。制定时状态：Server 类型两轮通过，Web 两轮各 3 条诊断、262 项中 256 通过/6 失败；F24 服务夹具 19 项通过，F25 启动准入 12 项失败；F26 两种外部 filter 竞态各三次复现。已有实现与红灯测试必须保留，计划生成与本地实现均不等于发布授权。

## 1. 基线、边界与默认决策

- 工作树：`C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos`；分支 `codex/collaboration-workflow-closure`；被审 HEAD 为 `7d2ddf87111ad39b639c2a1082c11be716b8084d` 加 76 个未提交文件。
- 开工重新记录 HEAD、文件指纹和实际服务路径。若代码已变化，先重放对应负向用例，不把本报告行号或缺陷状态视为永久事实。
- 保留现有未提交代码、工作区、私聊、群聊、候选、评审、已应用代码及 Git 历史。不得为通过测试清理业务数据或重写历史证据。
- 保留统一工作台、Liquid Glass、独立折叠、现有模板语义、三角色要求、最多两轮返工和人工确认应用；不新建通用 Workflow 引擎。
- 不自动应用候选、提交、推送、合并或部署。实机任务使用独立测试仓库，最后停在待用户应用。
- 数据变更只通过增量迁移；不得改写已经注册/应用的迁移校验和。历史无效关联只标记和阻止使用，不自动猜测或修复归属。
- 前端按实际会话身份隔离状态与订阅，采用基本类型依赖、请求 generation 和共享控制器；不为此次修复强制引入新的状态管理或请求库。

### 1.1 从当前未提交树开工，而不是覆盖已有实现

- 已有控制记录、journal、scope/真实路径、群聊 owner 和草稿隔离实现；先核对已有差异并补缺口，不重新复制另一套功能或 reset 工作树。
- 优先核验新增恢复缺口 F24/F25；为 F23 固化当前诊断的负向复现，再增加“合法换行规范化仍可交付”的修复回归。
- Web 目前有 12 条类型诊断；先完成预算/outbox、提交快照、可空会话、队列引用、附件元数据的整合，再重跑单元测试、构建和浏览器。不能通过删除能力或 `any`/非空断言掩盖对象隔离错误。
- W12 的两次失败保存为未定因信号；先调查实际进程身份，再判定产品清理缺陷、测试所有权误识别或环境竞争。未经证明不写成 flake。
- MUST 是发布硬门槛；SHOULD 是体验要求，偏差须记录；TARGET 仅记录观察指标，不用无依据的精确阈值代替正确性。

### 1.2 当前可直接执行的剩余工作清单

先记录新的工作树指纹。当前事实以报告第 8 节与 [复核证据 JSON](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-09-30-report-recheck.json) 为准；F01–F22 不整批重写，也不因已有局部绿色记录跳过最终负向回归。

| 批次 | 范围及主要文件 | 开工与交付顺序 | 该批完成门槛 |
|---|---|---|---|
| A-剩余 | F24/F25：CollaborationWorkflowService、CollaborationApplyJournal、准入生产接线及 control tests | 先为安全释放与 recovered/pending 窗口加入红灯测试，再统一队列续跑及 journal/control 提交；主改动由同一负责人整合 | 成功/回滚/journal 前失败均让排队 B 恰好继续一次；未知恢复状态不启动 B；真实 DB 重开两次收敛且零重放 |
| B-剩余 | F23：CollaborationCandidateSnapshot 及正式测试 | 保留已有红灯矩阵，分离原始字节稳定性与 Git clean 等价性；不改历史探针期待 | 合法 LF/CRLF、属性及二进制矩阵通过；真正源变化、scope/路径越界仍拒绝，真实 index 不变 |
| E-0 | V01：page.tsx、草稿仓库、outbox 类型 | 可以与 A/B 并行，但先核对共有 DTO；关闭 12 条诊断，不删除队列、附件或恢复能力 | 当前完整类型检查、Web 单元测试及 Web 生产构建通过；错误没有用 any、忽略规则或非空断言掩盖 |
| E-1 | F12/F13/F14/F16/F19/F21：页面接线、统一身份、提交结算、恢复与 Run 校验 | 在 E-0 的可构建页面上加入故障注入/页面级回归，再实机验证 | 排队恢复同键；切走后原身份正确结算；加载/存储风险可见；错误 Run 配对不加载证据；迟到结果不串会话 |
| F | 原有 A/C/D 安全回归、V02、全量测试/构建、实机与独立复审 | W12 先调查身份再修正；所有修复整合到同一版本后执行全矩阵，不拿各切片通过数相加 | 本计划所有 MUST 都有当前版本证据；失败、skip 与未验证逐项说明；无未关闭 P1 或未知副作用 |

A 与 B 可以分工；迁移注册、shared 类型及同一产品文件必须单一负责人整合。只读审查者负责反例与证据复核，不把其静态结论包装成真实 Provider 测试。每批结束先更新追踪记录，再进入依赖它的后续批次。

### 1.3 历史：18:51 交付后的开工顺序

第 1.2 节是此前状态快照；以下按报告第 9 节更新，不删除已有负向测试，也不重新实现已通过的候选逻辑。

| 顺序 | 实施内容与文件边界 | MUST 完成标准 |
|---|---|---|
| 1A | CollaborationWorkflowService / ApplyJournal / AdmissionAuthority / StartupReconciler：F24/F25，由同一负责人整合 | 三种安全释放恢复同一 B Run 恰好一次；未知状态零 dispatch；journal/control 联合事务与两次真实 DB 重开全部通过 |
| 1B，可并行 | page.tsx、草稿仓库和群聊 outbox：保留新增接线/恢复测试，关闭 V01 | 完整 Server/Web 类型诊断为零；Web 260 项现有测试及后续新增测试通过；不是删除 red tests 或仅满足源码正则 |
| 2 | F23 已通过实现的独立复核与 scope/path/review/apply 集成 | 当前两轮 20/20 结果保留；真正源变动、范围越界、外部 filter 及篡改仍拒绝，真实 index 未变 |
| 3 | W12 归因与所有切片集成 | 保存历史失败；补进程身份/所有权与同条件对照，不用当前 240/240 代替根因；重新运行当前版本全套与构建 |
| 4 | 独立测试实例实机与浏览器验收 | 三角色成功停待应用；另测真实取消、群聊停止、URL/草稿/附件/IME/101+任务、五档宽度双主题及独立复审 |

实施必须补齐两个容易被红灯掩盖的条件：

- F24 的 `before_prepare` 测试当前尚未触发真实故障；以可控 seam 或实际准备异常验证“已有准入但尚无 journal”的路径。测试先确认故障确实触发，再断言持久化失败和队列续跑，不能仅因 suite 红灯就认为该窗口已覆盖。
- F25 恢复/释放联合校验：至少要求 `committed + completed control`、`recovered + failed control` 或“无 journal 且可证明未写的 failed control”，并核对 task/candidate/epoch/工作区。terminal journal + pending control 先保持 writer hold，验证恢复材料与源状态后原子收敛；损坏材料、用户新改动或错误 epoch 不得被提前释放。已确认成功的应用不能因释放失败而回滚。

当前 Server 两条诊断来自 journal 测试与新事务回调合同未整合；Web 三条新增诊断来自 outbox 测试所需方法尚不存在。它们不是通过移除测试、非空断言或 `any` 可以合法关闭的“构建噪音”。详细实施和全量验收继续遵守第 3–10 节。

### 1.4 本次定稿：可直接执行的剩余修复计划

依据报告第 10 节与 [本次定稿证据](C:/Users/Administrator/.codex/worktrees/collaboration-workflow/Multi-Agent/agentos/docs/superpowers/reports/evidence/2026-09-30-md-report-final-check.json)。同一协作工作树的 `agentos` 内非文档 dirty/untracked 清单为 128 个文件，摘要 `A1F8D4DFB10FEC3BCC8C92007E573A1A6B863F50D7CBDA758003EC1F3A12F5D2`；开工先重算，不把 HEAD 或历史行号等同完整被审版本。

| 顺序 | 任务与单一写入负责人范围 | 必须产出与完成标准 |
|---|---|---|
| 1A | F25/F24：WorkflowService、ApplyJournal、AdmissionAuthority、StartupReconciler、index.ts 与相应测试，由一个后端负责人整合 | 启动恢复前 pending apply 保持 writer hold；材料/epoch/候选验证后联合收敛；四类真实库两次重开全部达到最终断言；生产 dispatch 开关和恢复后原队列续跑正确 |
| 1B，可并行 | F26：CandidateSnapshot 与 snapshot/scope/path/review 测试，由另一后端负责人处理，不编辑 1A 文件 | 所有可能 clean 的 Git 操作使用冻结输入/受控属性配置，不执行不支持的外部 filter；两种竞态各三套夹具通过；真实 index 不变，原 CRLF/二进制/路径安全矩阵不回归 |
| 1C，可并行 | V01、F12/F13/F14/F16/F19/F21：page、草稿控制器/仓库、outbox 与 Web 测试，由前端负责人完成接线 | 三条类型诊断清零；页面正确结算原身份、验证 Run、显示 ready/警告；outbox 原队列同键恢复；完整 Web 单元测试及行为级回归通过 |
| 2 | 1A/1B/1C 的最终组合；W12 测试所有权改动与迁移/受影响包，由主负责人汇总、独立人员复核 | 当前 Server/Web/Shared/Agent Core/Process Runtime 测试、类型和构建通过；新/旧库副本迁移及恢复材料验证；每项失败/skip 留痕，不以切片数字相加代替全套 |
| 3 | 专用本机 API/Web 与独立测试仓库；真实 Provider 和浏览器验收 | 三角色新任务停止待应用；真实取消/讨论停止/中断恢复；五档宽度双主题、草稿/图片/IME/URL/101+任务；保留测试、日志、网络和截图证据 |
| 4 | 最终独立复审与交接 | F01–F26、V01/V02 逐项标注已闭环/部分/阻塞/未验证及证据；未知副作用或未关闭 P1 均阻止发布；不自动应用或提交推送 |

本表不要求重新实现已经存在的控制、scope、owner 或 UI；负责人先读现有差异，保留有效回归，只修当前缺口。共享类型、迁移注册和同一文件不得多方并发编辑。不是为达成报告而清理业务数据。

**1A 的准确合同：**

- Authority 和 StartupReconciler 仅联合终态可释放：`committed + completed control`、`recovered + failed control`，或无 journal 且有“写前失败”的持久化证明。核对工作区、task/candidate、base/hash 和 control epoch；terminal journal + pending control 不能提前被归类 TERMINAL。
- 恢复协调器先验证材料完整性、目标 root/base、当前 task/candidate/version/epoch，再判 preimage/postimage；不能仅 postimage 分支检查关联、preimage 分支直接终结。材料损坏、用户新改动、错误 epoch 全部保留 hold 和可处理原因，不盲目恢复文件。
- 物理回滚确认后 journal/control 同事务提交；已提交应用不能因队列 release/dispatch 失败又回滚或改写为未知写入。释放/续跑失败另行可观察、可幂等恢复。
- 在生产创建协作服务前确定并传入现有 `AGENTOS_RUNTIME_DISPATCH_ENABLED`；确认、批准续跑、应用释放、启动恢复之后的队列都遵守同一开关。服务的默认值或 fixture 显式关闭不构成生产接线证据。
- startup 只收敛事实；完成所有恢复并开始对外服务后，调用同一持久化 GRANTED 处理入口。精确继续原 queued Run，零新 Run、零 attempt 重放，重复释放/恢复仅一次，列表超过 100 项也不漏。
- 当前 F24 的 19 项局部通过保留，但新增生产组合/启动开关回归。F25 的 12 项必须跑过当前提前释放断言，再完成两次真正 DB 重开和零副作用的最终断言，不能只看到套件名称便称“双重恢复通过”。

**1B 的准确合同：**

- 不只缩小 `git add` 路径或添加又一次属性预检。冻结候选路径、字节、有效属性及规范化配置，阻止后续 worktree/config 变化影响处理；使用不继承外部 filter 命令的受控 Git 上下文完成合法内容规范化与临时 index 入库。
- 保护可能触发 clean 的全部 Git 路径，包括 worktree diff、add、带 `--path` 的 hash-object，不只 add。禁止外部 filter/process/smudge 的配置不得先执行后拒绝；不修改用户本地或全局 Git 配置、不凭空扩展执行权限。
- 在同一安全机制下生成、评审校验及应用比较保持同一补丁/hash；保留标准 LF/CRLF、text/eol、二进制和删除/改名语义。若现有配置无法安全支持，准确报不支持，不静默改语义。
- 正式测试在冻结前后属性/配置变化、晚出现新文件及源字节/祖先变化窗口设 barrier；逐次确认 filter marker 不存在、真实 index 不变、没有外部内容进入 Artifact。F26 原有反例测试名称保留，追踪表关联新发现编号，不覆盖历史 F23 证据。

**1C 的准确合同：**

- 完成 `createdDirectConversation`/可空会话与持久化附件元数据的实际接线，不能只改变量名或强制断言。私聊发送完成即便当前观察 B，也先结算 A 的已提交 revision/附件，之后才决定 UI 更新；新内容及 B 保留。
- Run 明确关联检查通过前不装载 Inspector 或呈现取消/重试；draftReady、存储警告、滚动身份与可见消息/SSE generation 在页面落地。同 ID 不同来源、错误深链、快速切换均有行为测试。
- 先明确 outbox 的恢复与“新手动发送”合同：原 queued 条目以原 queue ID/key/payload 恢复；其他/未指定队列不能借用旧键。需要无参恢复入口时先明确识别并返回原条目身份，再由原目标继续，不与当前新输入混合。
- 当前 outbox 测试的末尾无 queue ID 调用与实现拒绝行为不同；用该合同更新调用方和正/负控制，不删除整个测试，也不为了绿色允许跨项借用。其余 5 个源码接线断言必须补异步页面/浏览器反例，正则匹配本身不是行为通过。

**W12 和最终门槛：** 已有三轮修正后单文件 19/19 是侧车证据，不能替代当前全包。主审需重跑完整 Process Runtime 和编译，保留真实 owned survivor 的失败能力、外部 helper/PID reuse 对照及耗时。旧失败 PID 无身份的历史边界如实保留；只能说明受控误识别已证实，不能证明全部历史失败或产品进程清理均已排除。最终全仓结论继续限定本次实际覆盖范围。

## 2. 全程必须保持的合同

1. 不匹配版本、错误关联、未取得执行权的请求，在任何新外部副作用之前被拒绝。
2. “请求失败”不能掩盖已写文件、已停止进程或已创建执行；存在不确定副作用时必须显式进入待处理状态。
3. task cancelled/applied 不被事件、评审收尾、返工或恢复覆盖；旧 Run、轮次、attempt 不推进新对象。
4. 已完成的启动 Operation 不代表 Run 完成，也不能被改写成“未启动”来规避取消问题。
5. 一个 interaction 同时只有一个执行 owner；消息、reply ledger 和预算一致。
6. scope、工作区/会话/源消息、候选 hash、评审者及 attempt 都是机器校验，不从文字或时间猜测。
7. 观察会话、页签、SSE 或浏览器连接变化，不停止或重启执行；只有明确操作改变执行状态。
8. 真实测试命令、退出码和有效版本绑定才授权交付；不能用模型输出替代证据。

## 3. Phase A｜版本、取消与应用安全

覆盖：F01、F02、F03、F04、F05、F18、F24、F25。先固化当前负向复现，再修改实现。

### 3.1 单一持久化控制入口

在现有协作服务上集中处理 confirm/cancel/apply，保留原 URL；不要让路由、后台收尾各自操作同一任务。

新增持久化协作控制记录，而不是只加进程内 mutex：

- 保存 workspace/task、action、幂等键、规范化请求 hash、请求 expectedVersion、冻结 Run/候选引用、控制 epoch、状态和结果/失败原因。
- 控制状态为 reserved、running、completed、failed、recovery_required；同一任务只能有一个未结束控制操作。
- 在一个短事务中校验归属、任务版本、动作允许状态，认领操作并推进控制 epoch；事务中不 await Git、文件或 Provider。
- 后台 progress、候选和评审收尾必须携带被处理的 Run/epoch，并做源状态 + 当前 Run + 版本 CAS；遇到已取消、已应用或控制栅栏变更只停止推进，不写入旧结果。
- confirm/cancel/apply 新请求必须提供有效 Idempotency-Key。旧无键请求明确返回 400，不静默声称可幂等重试；普通私聊与其他接口不受影响。
- 同键同 payload 返回持久化结果；同键不同 payload 为 409；不同键并发不能重复产生外部动作。
- 冲突统一返回 409。缺失、非法输入、不存在、关联错误和恢复待处理使用明确稳定错误码，不被泛化成 500。

任务业务状态与控制操作状态分开。现有状态枚举不为“正在应用/取消”随意改写；共享进度 DTO 展示 pending control，UI 以其禁用操作并说明当前控制动作。

### 3.2 确认与取消

**确认：**

- 比较客户端 expectedVersion，不能以最新 task.version 替换该比较。
- 在获得控制认领之后才创建 Run/隔离工作树；完成准备前不开始 Provider。
- Run 图、确认记录及版本绑定统一提交；准备失败保留可解释的失败控制记录，产生的 Run/工作树有明确归属和状态，不留下可自行执行的孤儿。
- 同一个确认重复/并发请求只对应一个 canonical Run 和一个实施工作树。

**取消：**

- 以真实 Run/活动 Stage/attempt 选择停止目标，不能要求 run.start Operation 仍未完成。
- 复用现有 dispatcher 的进程停止与证据核验，再通过 canonical lifecycle 事务提交 Run/Stage/Event/Outbox 的取消；已完成 start 记录保留其真实历史。
- 任务版本在停止前完成认领；停止期间冻结自动阶段推进。停止后核对 Run 版本和控制 epoch，避免延迟结果取消新一轮。
- Run 已终结但任务正在收尾时，取消只提交合法任务控制终态并阻止收尾，不再要求停止终结 Run。
- 停止证据缺失或进程状态不明时，保留 pending/recovery_required；不得显示“已取消且不再执行”。
- 对已经进入 coordinator 的启动调用，在 Provider 验证、launch plan、claim/reservation 等 await 后复核持久化授权；最终 spawn 回调内再次同步检查，检查与 native spawn 之间不引入 await。取消栅栏已建立但尚无 Session/Process 的状态必须有明确“未启动”证明，不能把查不到进程等同于停止成功。
- cancelled/applied 是不可自动覆盖的终态。failed/blocked 也不能被普通后台事件自动复活；后续重新执行需原有明确操作或新任务。
- 用允许转换表替代任意 progress：queued→running/failed/blocked/cancelled，running→reviewing/failed/blocked/cancelled，reviewing→awaiting_application/changes_requested/failed/blocked/cancelled；返工必须来自当前 changes_requested、当前 Run 和有效评审，且轮次仍在上限内。

### 3.3 应用 journal 与单写入权

仅提前比较一次版本不能解决 Git 与 SQLite 不同事务域的问题。

- 应用认领时冻结 task/version、candidate ID/hash、base、有效评审和测试证据，阻止同任务并发应用或后台变更。
- 应用取得现有工作区单写入权威的独占准入。原审查基线只支持 Run 主体；当前修复树已有协作应用主体，应补齐其释放与恢复衔接，不再重建第二套准入。不得借用终态 Run 伪造执行或绕开既有 writer。
- 准入后再次校验目标干净、基线未变、补丁/范围/路径有效，执行 git apply --check；严禁自动 stash、reset、checkout 或冲突解决。
- 写入前保存 durable apply journal：操作 ID、基线、候选 hash、各路径 preimage/postimage 摘要、新增/删除属性、必要恢复内容。恢复材料置于受管目录，不在目标仓库生成未跟踪备份。
- 使用同一份已审核补丁；写后重新验证目标结果，再以控制 epoch + 候选绑定提交任务/候选 applied。
- 数据库提交失败：仅在当前内容仍匹配本操作 postimage 时恢复本操作修改的精确路径；任何用户新增改动或归属不确定均停止回滚，保留 journal 并标记 recovery_required。
- 重启后：能证明写入完整且无新变化的操作可收敛持久化状态，不再次写文件；已证明完全未写则安全释放；不确定则阻止新应用并提供恢复材料。不得因 lease 超时盲目重放。
- 最终 committed/recovered 之后才释放写入权；未知副作用仍需在现有准入中阻止冲突写入。
- F25：物理回滚验证完成后，journal 的 recovered 与控制 failed/终结结果在同一数据库事务提交；启动恢复也处理“终态 journal + 未终态 control”的遗留组合。先验证基线、preimage、控制 epoch 与关联，不因看到 recovered 字样就无条件释放。
- F24：Run 释放与应用释放共用获准主体的处理入口，消费 authority 返回的结果或核对持久化 GRANTED，精确恢复已确认且可继续的排队 Run。重复释放不重复 dispatch；遵守现有执行开关、版本、attempt 与当前任务关系，不能新建 Run 或绕过未知恢复状态。
- 启动恢复阶段先收敛持久化事实；恢复完成后才由原有授权队列机制继续可证明未开始的任务，不盲目重放 Provider 调用。

**Phase A MUST：**

- 陈旧确认/取消/应用和不同键竞争均在副作用前返回冲突，文件、进程调用次数、Run 图和任务状态不变。
- running Run + completed start 可以真实停止；同版本重复取消不重复停止；未知进程不能伪报已停止。
- 在评审收尾、返工、取消、应用之间插入 barrier，取消终态不能复活。
- 应用覆盖“写前、写后 DB 前、DB 提交失败、恢复时”四个故障窗口；没有静默半应用。
- 额外注入“回滚已落盘/recovered 已记录，control 尚未终结”的中断；真实重开数据库两次后无永久 pending、无重复应用，用户并发改动仍保留。
- 让任务 B 在任务 A 应用占用写入权时排队；A 成功、证明回滚和 journal 前失败均使 B 获准后继续恰好一次。A 状态不明则 B 不得启动。
- 成功同键重放不重复写入；所有冲突 HTTP 为 409，不以自动写重试掩盖。

## 4. Phase B｜批准范围与真实路径边界

覆盖：F06、F07、F23、F26。F26 的安全收集设计与最新验收以第 1.4 节为准。

### 4.1 scope 规范

本轮选择可机器校验的最小格式，不用自然语言猜测范围：

- scope 每项为仓库根相对路径；统一为 POSIX 形式。末尾 / 表示目录及后代，否则为精确文件；显式 ./ 表示整个仓库且 UI 必须显示“全仓库”。
- 拒绝绝对路径、.. 越界、Windows 设备路径/ADS、歧义分隔符与 glob；不提供隐式“猜测意图”兼容。
- 在创建/确认时规范化并冻结 scope policy 版本及清单，纳入批准计划 hash。
- 既有 scope 能明确按同规则解释则按原批准范围校验；不能解释的历史任务仍可查看，但须创建新任务确认，不能默认扩成全仓库。
- 改名的旧/新路径、删除、新文件及二进制文件全部校验。范围外差异不裁切，而是阻止候选/评审并列出路径和原因。
- 显式申请扩大范围必须生成需重新确认的任务/计划；本次不添加静默“接受范围外修改”按钮。

### 4.2 真实文件路径

- 候选读取前遍历 Git 文件清单，校验每级祖先和现存末级路径的 realpath/lstat；在实际 OS 上验证 Windows junction/reparse point 和 symlink。
- 受审路径的链接祖先一律拒绝；删除路径至少验证最近存在祖先仍在根内。识别模式为 symlink/submodule 或其他不支持类型时明确拒绝。
- 外部内容不得先进入补丁/Artifact 再检查。临时 index 仍用于收集普通新文件、修改、删除及二进制内容，不修改真实 index。
- 候选、评审副本、目标应用和恢复 journal 均使用同一边界验证，不只保护生成端。
- 校验源文件后读取及冻结过程中复核稳定性；源内容/祖先变动时失败关闭，不继续用已验证路径读取不确定数据。
- 正常 ignored 缓存/构建产物保持排除；若验收依赖被忽略的真实源文件则报告不可交付，不把全部 ignored 文件自动打包。
- F23：将“源文件原始字节在采集前后保持稳定”与“Git clean/属性语义下与 staged blob 一致”分开验证。支持正常 CRLF/LF 与 `.gitattributes` 规范化，不能直接比较两个不同表示的哈希，也不能为了通过而全局关闭用户 autocrlf 或对二进制内容替换换行。
- 自定义 clean filter 若无法在现有权限内安全复现，应明确报告该配置不支持及原因；不能偷偷新增外部执行权限，也不能误报并发源内容变化。
- 不支持的外部 clean filter 必须在允许 Git 读取候选内容或执行该 filter 前识别；不能先执行它再返回 unsupported。支持的 Git 规范化语义使用真实 Git 对照验证，原始字节前后校验覆盖采集全过程，不能只因某次 normalized hash 相等就放行后续源变更。
- F26：预检后的新路径、属性与配置变更也不得触发外部 filter；禁止仅靠事后集合变化或哈希拒绝宣称无副作用。冻结输入和受控 Git 上下文必须覆盖所有会触发 clean 的命令。

**Phase B MUST：**

- 合法新增/修改/删除/改名/混合/二进制候选成功，真实 index 未被改变。
- scope 外路径、../、绝对/设备路径、目录 junction、symlink、变动祖先均在读取内容或评审前拒绝。
- 测试前后改变源文件、评审副本被修改、补丁被换、错误 hash/attempt/Agent 都不能放行。
- Windows 原生 fixture 必须跑 junction 用例；其他 OS 的 skip 不能替代 Windows 证据。
- `core.autocrlf=false/input/true`、LF/CRLF、`text`/`eol` 属性、普通新文件与二进制正向矩阵通过；真实 index 不变。真正采集中源变化、scope 越界或路径变动仍失败关闭。不得把诊断脚本“复现成功”的退出 0 当修复通过。
- F26 的两种竞态各三套 fresh fixture：候选可拒绝但 filter marker 必须不存在；稳定外部 filter 控制继续预拒绝。复核包含配置/属性窗口，不能只验证命令最终返回错误。

## 5. Phase C｜协作状态与重启恢复

覆盖：F08、F25，并保护 Phase A 的控制 journal。

- 在 canonical 恢复和启动准入收敛之后、对外提供操作之前，运行幂等协作恢复协调器。
- 只通过冻结的 workspace/task/Run/parentRun/candidate 关联恢复，不按标题、时间或消息文本猜测。
- 当前 Run failed/cancelled 时收敛非终态协作任务；Run recoveryRequired/进程未知时 task blocked 并显示中断原因，禁止自动重放。
- completed Run 仅在持久化完整候选、测试、当前 attempt 评审均有效时执行幂等结果判定；证据缺失为 blocked，不重新生成旧候选或补签评审。
- queued、待审批和未开始阶段恢复其既有等待语义。重建受管工作树映射和观察订阅，但不能仅因重启重新调用 Provider。
- 协作已取消/已应用与历史非当前 Run 保持不变；恢复重复执行不重复生成候选、评审、返工或事件。
- 控制操作/journal 不确定时优先显示待处理，保留原业务事实，不伪造成功恢复。
- 查到终态 journal 的 pending apply control 不能直接 continue 跳过；按同一恢复证明收敛或明确保留 recovery_required。重复启动不得留下既已安全回滚又永久阻塞的控制记录。

**Phase C MUST：**

- 实际关闭/重开数据库运行完整启动组合两次，分别覆盖 queued、running/missing、running/unknown、waiting_approval、completed 有/无证据、cancelled、applied。
- task/Run/Stage 状态与当前关联一致；unknown 不重放 Provider，历史轮次不覆盖当前轮次。
- 持久化 journal 故障窗口与重复启动只收敛一次；不会丢恢复材料。

## 6. Phase D｜群聊认领、记账与归属

覆盖：F09、F10、F11、F20、F21、F22。

### 6.1 一个 interaction，一个执行 owner

- 持久化认领绑定 workspace/conversation/interaction/sourceMessage、冻结参与顺序和预算、owner epoch、当前 Turn/Message 及状态。
- 在 Provider 调用前原子 claim；同 interaction 同时一个 owner，同会话同时一个活动讨论。进程内锁只能辅助，不能代替数据库认领。
- 重复 respond 不启动新 walk；活动 owner 已存在则返回 409 和原 interaction/观察入口，已结束则返回明确终态。
- GET SSE 只观察持久化事件，支持游标续传。断开浏览器不释放执行权、不重启 Provider。
- 不因超时 lease 自动启动新 owner。重启结果不明时标记 interrupted/待处理，旧 owner epoch 的迟到结果不能推进新讨论。
- 群聊 final message、Turn final、ledger reply、预算使用同一持久化提交边界；为群聊抽取最终化事务钩子，私聊保持原语义。不得先公开 final 消息，再发现无权记账。
- Stop 与 Provider 最终化竞争遵循现有已最终化回复记账约定，明确区分已输出结果与未开始的后续发言。

### 6.2 停止与版本同步

- turn final/failed/done 事件携带 interaction ID、最新 version、预算和 owner epoch；页面按单调版本合并，更新停止目标。
- stop 精确绑定当前 interaction，必须带 expectedVersion；持久化阻止后续发言，再向执行 owner 发出取消信号，不能只 abort 浏览器 SSE。
- 对支持中途取消的 Provider 核验实际停止；无法确认当前响应结束时显示“已停止后续发言，当前响应正在结束/状态待确认”，不宣称所有进程已停止。
- 真正版本冲突返回独立 GROUP_VERSION_CONFLICT，不伪装预算耗尽。UI 拉取同对象最新状态并保留停止入口，提示再次操作；不自动重试写操作。
- 已停止的同键重放不再取消；自然结束时如实显示已结束，不改造成用户停止。

### 6.3 消息归属与幂等发送

- 创建/读取/改设置/respond/reply/stop 均验证 workspace、group kind、active status 和对象关联。
- respond 的 sourceMessageId 必须等于 interaction 冻结的来源；旧无来源记录只能只读展示或明确受控兼容，不能绑定任意消息继续执行。
- reply 必须引用同 workspace/conversation 的正确 Agent Message，并验证 Turn/interaction/作者及公开内容 hash；不能仅确认消息 ID 存在。
- 数据库增加能落实同一归属的约束。迁移发现历史错误关联时保留材料并标记不可用，不删除或按文本补写。
- 原兼容创建路径委托同一校验服务；direct、archived 和成员不可用不能生成不可执行 active interaction。
- 客户端在请求前保存目标会话、提交内容摘要和 clientMessageId；响应丢失时用同键同 payload 查询/重发原创建请求，不生成新源消息。
- 查到原 interaction 后，仅在能证明尚未启动且取得 owner 的条件下继续；已有 owner 改为观察，未知启动副作用提示待处理。不能把“没有浏览器响应”当作未执行证明。

**Phase D MUST：**

- 同 interaction 2/10 个并发请求，runner 最多一次；消息数、ledger 和预算完全一致。
- 双服务实例对同一数据库的认领竞争、重复/乱序事件和重启未知状态不重复执行。
- 跨 workspace/conversation 的 message、Turn、Agent、source 拒绝且零写入；外键检查通过不替代归属断言。
- 三 Agent 顺序讨论、@单成员、预算耗尽、Provider 失败、第一/第二条回复后停止、停止与 final 竞争均正确。
- 创建已提交但响应丢失、刷新和重复点击不重复源消息/执行；不存在 active 卡住但没有恢复说明的状态。
- 所有讨论停止操作不取消协作 Run，协作取消也不误停止其他讨论。

## 7. Phase E｜前端会话隔离与可达性

覆盖：F12、F13、F14、F15、F16、F17、F19，以及 V01 编译阻塞。

### 7.1 会话状态和提交快照

- 内部身份键用 workspaceId + 实际 storageSource + conversationId；来源由已验证会话适配器确定，不能信任随意修改的 URL 参数。未创建私聊的草稿用该 Agent 的 pending 身份，创建后只迁移其所属草稿。
- 文本、@选择、模式、队列、附件和滚动位置按身份存储；文本/设置用版本化 localStorage，图片 Blob/元数据用 IndexedDB，不把大图 data URL 放进 localStorage。
- 存储不可用时保留内存状态并明确提示刷新风险；不把无法确定归属的旧全局草稿自动分配到当前会话。
- 发送冻结目标身份、内容、附件 ID 和草稿 revision；完成只清理已提交附件及对应已提交 revision，新输入和新粘贴图片保留。
- 排队条目必须保存提交时目标身份；完成/停止不能清理另一个会话的队列或把旧队列发给当前会话。
- 切换观察对象时取消旧查询/订阅并立即清空当前可见旧证据；不取消服务端执行。
- 执行观察按身份路由事件。所有请求/SSE/完成/错误回调验证 identity + generation；A 完成不能改 B 的消息、状态、错误或 selection，也不能无条件重新选 A。
- 遵循 React 基本类型 effect 依赖和集中订阅清理；异步正确性依靠身份/版本栅栏，不依赖“组件卸载大概会解决”。
- 关闭当前类型诊断时，统一正常提交与 outbox 恢复提交的快照契约，包含提交身份、revision、text、mentionedAgentIds 和附件 ID；预算只映射实际合法字段。附件持久化元数据不要求 previewUrl，读取 Blob 后再构造 UI 预览并正确释放 URL。
- 排队发送也按 identity + queueItemId/clientMessageId 查找对应持久化 outbox。恢复同一项只能使用原 key 和冻结 payload；队列有不同新项时不能误用上一项的记录，也不能跳过 outbox 后生成新 key。
- 私聊发送成功后，即使已经观察 B，也按 A 的提交快照结算已提交内容；只有 UI 更新受 current-scope 栅栏限制。pending 私聊创建后的草稿迁移同样保留归属和 revision，不抢回用户选择。
- 主页面显式传入 draftReady、draftPersistenceWarning 和会话滚动身份。加载未完成时禁用输入/发送，失败时展示保留内存内容与刷新风险；不能让组件默认 ready 导致输入被 hook 忽略。

### 7.2 URL、历史和输入

- 私聊/群聊统一根据明确 URL 身份恢复；先定位会话及 Agent，再加载所属列表。URL 显式不存在/关联错误时显示错误，不回落首条。
- 普通会话执行 Run 先核对所属会话。无会话的合法 Run 使用“未关联会话”展示；错误配对不能呈现目标证据或写操作。
- 服务端 Run 级 API 不为此改成假会话授权。跨工作区身份授权不是此次 UI 绑定修复的暗含目标。
- 普通私聊的显式 runId 必须接入 runLinkState 校验。loading/mismatch 时不构造目标 Inspector 或取消/重试操作；不能把未验证 hint 直接并入 legacyRunIds。合法 unattached Run 和错误配对分别展示，不伪装为同一错误。
- URL 群聊/私聊恢复都核验实际 storageSource。同 ID 不同来源的记录保持独立；用户点击生成来源明确的新链接。切换观察对象同步清空旧消息和证据，不能等新请求结束才撤下旧对象。
- 历史任务提供分页；显式 taskId 直接读取并核对会话，不通过是否出现在前 100 条判断存在性。用户选中历史任务后保持选择。
- 组合输入期间 Enter 不发送、不入队；同时兼容 nativeEvent.isComposing 与组合 Enter 的浏览器信号。Shift+Enter 保留换行。
- 页签/前进后退/刷新保留已保存草稿、附件和选中对象；执行页继续隐藏 Composer，不把修复变成 UI 重做。

**Phase E MUST：**

- A/B 快速切换、A 慢响应/失败/流式结束、同 ID 不同来源，均不串消息、草稿、图片、Run 或操作。
- 发送期间新增文本/图片，成功、失败、停止后不丢未提交内容；图片读取、存储失败和刷新也有明确结果。
- A 的私聊发送成功后切到 B，回到 A 时已提交 revision/附件已结算而新增内容仍在；B 草稿、错误和 selection 未改变。pending 私聊的创建/迁移也必须覆盖该时序。
- 草稿慢加载、IndexedDB/localStorage 失败时，Composer 的禁用与警告必须在页面中可验证，不能只测孤立 hook/helper。
- 群聊队列创建已提交但响应丢失，刷新后自动 drain 仍使用原幂等键、payload 和来源消息，零新增讨论/消息；不同队列项之间不借用 outbox。
- 非首条私聊、不同 Agent 私聊、旧/错误深链、前进后退均定位正确。
- 同一群聊至少 101 条任务，首屏分页和第 101 条显式深链均可查看，不误报不存在。
- 实际中文 IME 确认不发送；普通 Enter、Shift+Enter、粘贴和队列功能不回归。
- 错误会话/Run 配对在校验前不显示证据与取消/重试；切换页签不产生执行。
- 最新 `page.tsx`、草稿仓库与客户端接口的全部类型诊断关闭，完整 Web 单元测试和生产构建重新通过后才进入浏览器验收；旧版本的通过结果不可替代本次整合。

## 8. 最小接口与持久化变化

| 面 | 修复后的合同 |
|---|---|
| 协作 confirm/cancel/apply | 保留原路由；必须 expectedVersion + Idempotency-Key；同步完成返回原结果，未完成控制返回 202 + 控制引用，不伪报终态 |
| 协作 progress | 增量包含 pending/待处理控制、恢复原因和对象绑定；UI/Inspector 共用，不新增独立执行链 |
| 协作控制记录 | 增量迁移保存幂等请求、控制 epoch、动作结果和恢复引用；CAS 阻止迟到收尾 |
| 应用恢复/准入 | durable apply journal 与现有单写入准入的协作应用主体；记录绑定候选，不伪造 Run |
| scope | 原字符串入口保留，但按明确路径规则验证；新增规范化政策版本，冻结进计划/候选授权 |
| 群聊 respond/stop/事件 | 保留原路径；持久化 owner；重复启动 409；事件带最新版本/预算；停止冲突不误标预算错误 |
| 群聊关联 | reply/source/Turn/作者的服务端校验和数据库约束；历史错误记录只读标记 |
| 前端草稿 | 版本化完整身份键；图片 IndexedDB；提交 revision/附件 ID 精确清理 |

安全规则：控制结果/恢复引用不暴露私有日志、密钥或外部任意文件。新增 GET 和读取/刷新都不得启动执行或应用候选。

## 9. 发现到修复与回归的追踪表

| 报告 ID | 交付阶段 | 必须加入的反例测试 |
|---|---|---|
| F01 | A | 陈旧应用、写后 DB 失败、回滚竞争、journal 重启 |
| F02 | A | running Run + completed start 的取消与停止证据 |
| F03 | A | 陈旧取消零外部回调/零 canonical 变更 |
| F04 | A/C | 取消穿插评审/返工/恢复，终态不可复活 |
| F05 | A | actual=1、expected=100/0 拒绝，零 Run/工作树创建 |
| F06 | B | scope=src/，额外 unrelated/ 文件拒绝且不裁切 |
| F07 | B | Windows 父目录 junction、symlink、祖先变动 |
| F08 | C | 真实 DB 重开，missing/unknown/terminal 当前 Run 收敛 |
| F09 | D | 每条回复后立刻停止，版本更新和冲突文案 |
| F10 | D | 同 interaction 并发 2/10 路、跨实例 claim、预算=1 |
| F11 | D | 跨工作区/会话消息与回复归属拒绝 |
| F12 | E | A 草稿/图片切 B，发送目标与内容完整隔离 |
| F13 | E | A 的迟到 SSE/结束/错误不能更新 B 或切回 A |
| F14 | E | 非首条及不同 Agent 私聊刷新/历史恢复 |
| F15 | E | 101+ 任务分页与第 101 条显式深链 |
| F16 | E | 发送期间新图片保留，已提交图片只清理一次 |
| F17 | E | 原生 IME、组合 Enter、普通 Enter、Shift+Enter |
| F18 | A | 仓储 CONFLICT、控制/版本冲突正确 HTTP 映射 |
| F19 | E | 同工作区会话 A + Run B 深链在展示前拒绝 |
| F20 | D | 绑定源 A、请求源 B 在 reservation/Provider 前拒绝 |
| F21 | D/E | 创建提交成功响应丢失，同键恢复且零重复消息 |
| F22 | D | 兼容入口拒绝 direct/archived，不产生 active 记录 |
| F23 | B | 三套新仓库的 autocrlf/CRLF 反例、属性与二进制对照；合法规范化接受、实际源变化拒绝 |
| F24 | A/C | 应用安全释放后的排队 Run 恰好继续一次；重复释放与未知 journal 不误启动 |
| F25 | A/C | recovered journal / pending control 故障窗口、真实 DB 重开及重复恢复 |
| F26 | B/F | 属性预检后新增路径/改变属性的两种 clean-filter 竞态，各三次；零外部执行、真实 index 未变 |
| V01 | E/F | 关闭当前全部 Web 类型诊断（定稿时 3 条）及完整 suite 红灯，最新页面行为与构建通过 |
| V02 | F | W12 PID 所有权、创建时间与基线交叉调查；记录每次结果，不删除失败断言 |

## 10. Phase F｜最终验收与交付

### 10.1 自动化 MUST

- 将本报告临时探针固化到正式 Server/Web 测试；先见失败，再见修复通过，并保留正向控制。
- 核心版本、取消、应用、并发、归属负向测试各在全新夹具重复三次；使用同步 barrier/故障注入，不靠碰运气的 sleep。
- Server/Web 全套、受影响 shared/process-runtime/agent-core 测试、类型检查及生产构建均通过。Windows flake 必须记录并隔离复核，不能改业务代码掩盖。
- V02 必须先定位而非假定为 flake：保存 W12 失败时 PID 的创建时间、父进程、命令及 owned Job/测试归属，隔离串行重复至少三次，并对未修改的基线做同条件对照。若属产品清理问题修复并回归；若属测试误识别，仅修正所有权识别且保留真实 survivor 的失败能力。禁止宽泛杀进程、删 W12 或只挑最后一次绿色结果。
- 迁移在新库及旧库副本验证，重复启动、外键、约束和保留数据检查通过；不拿真实数据库当破坏性故障夹具。
- F01–F26、V01/V02 每项记录证据位置、测试命令、结果、复现次数和剩余边界；F24/F25/F26 特别补齐生产组合及负向运行证据。既有报告数字仅作基线，不当作修复后结果。
- 单元测试与 tsc/构建分别记录；当前“253/253 通过但 12 条类型诊断”是已知反例。正式 F23 红灯矩阵如果运行中断，只记录实际完成项和中断原因，不能填写虚构的完整结果。
- 证据记录每项最少包含：发现 ID、工作树/HEAD/未提交摘要、命令、退出码、夹具性质、重复次数、实际断言、产物路径、未验证项。动态闭环未运行的 S 级发现不得因审查者数量增加升级成 R 级。

建议执行命令（从本计划工作树运行，构建产生的缓存不算功能修改）：

```powershell
pnpm --filter @agentos/server test
pnpm --filter @agentos/web test
pnpm --filter @agentos/server exec tsc --noEmit
pnpm --filter @agentos/web exec tsc --noEmit --incremental false
pnpm --filter @agentos/process-runtime test
pnpm --filter @agentos/agent-core test
pnpm --filter @agentos/shared build
pnpm --filter @agentos/server exec node --import tsx --test ../../packages/shared/*.test.ts
pnpm -r run build
```

上述各包命令在实施时核实实际 scripts；不存在的脚本用其真实等价入口并记录，不宣称运行了不存在的命令。

已核实 shared 没有 `test` script 且自身不提供 `tsx` 可执行文件，因此 `pnpm --filter @agentos/shared test` 的无输出返回不能计为测试通过；从 Server 的已安装 tsx 环境运行实际 shared 测试文件。迁移 registry 与专项的通过，也不替代包含全部服务的 Server 全套。

### 10.2 实机 MUST

- 核对真实 API/Web 进程、工作树、数据目录、可用端口及 Provider 配置；4200 无监听时不能沿用地址。优先恢复已有 3101 预览，端口冲突先核对 owner，不随意杀进程。
- 在独立测试仓库使用现有 Codex/KimiCode/OpenCode 三角色完成新任务，核对完整补丁、范围、测试退出码、评审 hash/attempt 和阶段公开输出。
- 成功协作任务停在 awaiting_application。应用路径在自动化隔离仓库验证；对用户工作区或该实机候选的应用仍需用户明确要求。
- 另一个实机任务验证运行中取消与真实 Provider 停止证据；服务中断/恢复演练只在专用测试实例进行，不中断用户活动任务。
- 同群聊验证三 Agent 轮流、@单成员、停止、刷新、断线和响应丢失恢复。重复执行请求用测试实例与费用受控配置，不在用户任务上注入并发。
- 浏览器验证任务/会话快速切换、不同历史 Run、错误深链、中文 IME、图片及发送期间新输入，保存网络与持久化事实，不只看截图。

### 10.3 SHOULD / TARGET

- 617、719、1014、1440、1920px 深浅主题：无整体横向滚动、关键操作遮挡、Composer 遮挡末尾或弹层层级回归。
- 键盘完成选择、取消、证据展开、弹窗关闭与焦点恢复；状态不只用颜色表达。
- 200 条消息、持续事件、长输出下，输入与取消保持可用。
- 记录同步延迟、请求量、恢复耗时及实际用量；正常本地连接争取两秒内更新，不为指标隐藏错误或证据。

### 10.4 交付顺序与停点

1. A：正式负向测试 + 版本/控制/取消/应用 journal。
2. B/C/D：候选边界、启动恢复、群聊控制可在明确模块边界并行；涉及 shared types/迁移注册由单一负责人整合。
3. E：前端身份、恢复与状态投影；共享接口确定后可与后端测试并行。
4. F：完整自动化、专用实例实机、浏览器矩阵及独立复审。

每阶段留下可审查差异和证据；这不构成自动提交授权。最终交付修复代码、迁移/接口说明、F01–F26 与 V01/V02 闭环记录、实际测试与截图、恢复操作说明和更新交接报告。

停点：任一 P1 未关闭、未知副作用未解释、版本/归属或终态测试失败时，不宣称可发布；保留恢复材料并报告具体阻塞。是否提交、推送、合并、部署和应用候选，均按用户后续明确指令执行。

