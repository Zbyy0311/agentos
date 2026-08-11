# AgentOS CI Production + Test Determinism Remediation 设计

## 目标

在不改变 GitHub Actions workflow、lockfile、Node 22、tsx 声明/解析版本和 server test 命令的前提下，关闭 PR #42 当前权威 CI run `31453823652` 登记的五项失败：R31、R32、R33、ConversationService 489、ConversationService 497。修复后必须由新提交 SHA 对应的 `pull_request` GitHub Actions run 证明四个阶段全部通过；PR 保持 OPEN/DRAFT，不执行 Ready、Merge 或 M4 工作。

## 冻结基线与修改范围

远端冻结基线为：

- `origin/main` 为 `77add6a0dc1a860d9d054b0bc146b231c9cccb88`。
- `origin/infra/github-actions-ci` 与 PR #42 remote head 均为 `56829742c6ec29a4a56e957deb530e34daa9b762`。
- PR #42 为 OPEN/DRAFT、未合并。

本地设计提交链为：

- initial design commit 为 `8e7f214fa9aff397cc6f6ed76b35941352f119cc`。
- `8e7f214fa9aff397cc6f6ed76b35941352f119cc^` 必须为 `56829742c6ec29a4a56e957deb530e34daa9b762`。
- 本次 review correction 开始时的 local HEAD 为 `8e7f214fa9aff397cc6f6ed76b35941352f119cc`。
- `IMPLEMENTATION_BASE` 定义为本设计通过最终独立复审时的最新 docs-only spec revision commit；开始 production 修改前必须记录其实际 SHA，并证明该提交沿第一父链追溯到 `8e7f214f` 和 `56829742`。

开始实施前还必须满足：工作树干净、`git diff --check` 通过，并且 `56829742..IMPLEMENTATION_BASE` 只包含本设计文档。这样 docs correction commit 不会与冻结的 remote PR head 混淆，也不会要求本地 HEAD 回退到旧远端 SHA。

除本设计文档外，实施 allowlist 仅包含：

- `agentos/apps/server/package.json`
- `agentos/apps/server/src/serverStartup.test.ts`
- `agentos/apps/server/src/services/ConversationService.ts`
- `agentos/apps/server/src/services/ConversationService.test.ts`

禁止修改 `.github/workflows/ci.yml`、`agentos/pnpm-lock.yaml`、`agentos/package.json`、`SqliteStore.ts`、migrations 和真实 `.agentos/agentos.sqlite`。若直接启动参数无法覆盖所需的真实 server 启动模式，并且事实证明必须新增 launcher，则报告证据并停止，等待独立的 launcher scope expansion；本 gate 不自行新增 launcher。

最终 changed-files gate 分成两个互不替代的视图：

- `IMPLEMENTATION DIFF`：`IMPLEMENTATION_BASE..final HEAD`，只允许上述四个 production/test 文件。
- `CUMULATIVE REMEDIATION DIFF`：`56829742..final HEAD`，只允许本设计文档和上述四个 production/test 文件。

## 方案选择

采用“生产策略修复 + 确定性测试夹具”方案：真实启动入口精确抑制 SQLite 所属的 `ExperimentalWarning`，关键异步持久化任务统一进入可观察 ledger，同时把两个依赖后台写入或墙钟速度的测试改为因果断言。

不采用以下替代方案：

- 不在测试中清洗 stderr、不移除 `SQLITE`/SQL/路径泄漏断言，因为这会掩盖真实启动输出缺陷。
- 不使用 `NODE_OPTIONS`、`--no-warnings`、warning listener 或 Node 版本分支，因为这些方案会扩大抑制范围或让测试拥有 production 不具备的私有路径。
- 不忽略、删除或排除 SQLite journal，因为这会削弱 R33 的无副作用契约。
- 不仅给 detached promise 添加吞错 `catch`，因为关键持久化失败必须继续被 run 级 flush 观察。
- 不用 `Date.now()`、固定 sleep 或毫秒阈值证明并发，因为这些断言依赖调度速度。

## R31 / R32：真实启动 warning policy

`node:sqlite` 在 Node 22 进程启动时产生 `ExperimentalWarning`，其 stderr 包含 R31/R32 禁止的 `SQLITE` 片段。修复必须把 `--disable-warning=ExperimentalWarning` 放入真实 server 启动策略，而不是只放入测试 child。

实施时先验证 `tsx watch` 是否能可靠接收并向实际 Node 进程应用该参数。能够直接表达时，在 `apps/server/package.json` 中覆盖所需的 source stable、watch 和 compiled start 启动模式，并让 `serverStartup.test.ts` 的 child 使用相同策略。若 watch 模式无法在不使用 `NODE_OPTIONS`、不依赖 tsx 私有内部路径且不改变既有 watch 语义的条件下表达，则触发前述 launcher 停止条件。

R31/R32 保留全部既有 forbidden-output assertions，并增加策略边界证明：

- SQLite `ExperimentalWarning` 不出现在真实启动输出中。
- 普通 stderr 仍可见。
- `DeprecationWarning` 未被全局抑制。
- 不存在测试专属 suppression path。

## R33：ownership 失败夹具

现有测试先启动 serverA，serverA 的后台 outbox writer 可能在目录快照期间创建瞬态 `.sqlite-journal`，因此测试把第一个 server 的合法后台写入误归因给被拒绝的 serverB。

新夹具按以下顺序运行：

1. 创建隔离临时 root，写入所需种子数据并关闭 store。
2. 确认基线不存在遗留 journal。
3. 直接调用 production `acquireServerOwnership(root)` 持有 ownership，不启动 background-writing serverA。
4. 获取完整 project-tree 前置快照。
5. 只启动 serverB，等待其失败退出，并断言 `SERVER_ALREADY_RUNNING`。
6. 断言完整后置快照与前置快照相等、run 状态未变化；不添加 journal exclusion。
7. 在 `finally` 中停止残留 child、释放 ownership，最后清理临时 root。

该结构证明 serverB 在 ownership 被拒绝后没有创建 SQLite store、没有进入 HTTP listen，也没有产生持久副作用。

## ConversationService 489：关键 Promise ledger

当前 `recordRuntimeEvent()` 的立即路径和 timer 路径都会 detached 调用 `flushRuntimeBuffer(runId)`。即使 `publishEvent()` 的内层 Promise 已登记，`flushRuntimeBuffer()` 返回的外层 Promise 仍可能拒绝且无人观察，从而触发 Node `unhandledRejection`。

引入一个最小的 `trackCriticalEventWork()` 私有 helper，并将 `pendingEvents` 扩展为 `Set<Promise<unknown>>`：

1. helper 把原始 Promise 加入 ledger。
2. helper 为同一 Promise 连接仅用于 Node rejection observation 的 handler，防止 detached unhandled rejection。
3. 原始 Promise 不被替换或丢弃，直到 `flushEvents()` 通过 `Promise.allSettled()` 读取结果并从 ledger 删除。
4. `publishEvent()`、立即 runtime-buffer flush 和 timer runtime-buffer flush 都通过该 helper 登记。

`flushEventsForRun()` 继续先 flush runtime buffer，再观察全部关键任务；任何失败仍将 run 标记为 failed 并重新抛出稳定错误。该设计不得造成双重 publication、失败丢失或 false success，`sendGroupMessage()` 仍应拒绝。

ledger 生命周期还必须满足以下硬契约：一次 `flushEventsForRun()` 尝试消费的全部 critical promises，在该调用的任何 terminal path 上都必须 settled 并从 ledger 删除，包括 `flushRuntimeBuffer()` 本身先拒绝的路径。被拒绝的 outer flush promise 不得残留并污染后续无关 run。implementation plan 可以选择批次快照、`finally` drain 或等价实现，但不能让清理依赖仅在成功路径才会执行。

489 必须增加跨 run 行为回归：第一个 run 注入 critical event persistence failure，断言 `sendGroupMessage()` 拒绝且 run 为 failed；恢复正常 persistence 后执行第二个独立 run，第二个 run 必须成功，且不得观察到第一个 run 的 stale rejection。

## ConversationService 497：确定性并发屏障

测试移除 worker 命令中的 `300ms` sleep、`Date.now()` 采样和 `<250ms` 阈值。两个测试 worker 使用测试临时目录中的双标记文件 barrier：各自的 inline worker command 启动后原子写入自己的标记，并等待对方标记出现；只有 A、B 两个进程都实际启动，屏障才允许任一 worker 输出结果并进入终态。标记目录由测试创建并在 `finally` 中清理，不进入 production 路径。

测试记录 worker 状态事件并断言：

- 两个不同 worker 都产生 `running_cli`。
- 两个 `running_cli` 的事件索引都早于第一个 terminal 状态（`completed`、`failed`、`cancelled` 或 `waiting_user`）。

若 production 改为串行启动，第一个 worker 无法越过屏障等待第二个 worker，测试会由自身超时确定性失败；正确并发实现无需依赖机器速度即可通过。

## 错误处理与停止条件

- 任一冻结 ref 漂移或实施前工作树非预期 dirty：`NO-GO`，停止。
- 需要新增 launcher：报告直接参数不可行的复现证据，停止等待 scope expansion。
- 定向或重复测试出现任一 flaky：`NO-GO — DETERMINISM NOT PROVEN`，停止。
- push 前远程 PR branch 不再指向旧 HEAD：`NO-GO — REMOTE HEAD DRIFT`，停止。
- 新权威 CI 出现附件未登记的新 failure class：`NO-GO — NEW REGRESSION`，读取准确日志后停止，不自动扩大 remediation。

## 验证矩阵

实施采用测试先行，并保留能证明旧实现失败的 negative control 证据。验证顺序为：

1. R31、R32、R33、489、497 定向测试全部通过。
2. startup 定向测试连续 10 次通过。
3. Conversation 定向测试在 `--unhandled-rejections=strict` 下连续 20 次通过。
4. Server full suite：1704 total、1702 pass、0 fail、2 existing skips。
5. Shared M3 contract harness：31/31。
6. Workspace build：PASS。
7. `git diff --check` 通过；`IMPLEMENTATION DIFF` 与 `CUMULATIVE REMEDIATION DIFF` 分别满足各自授权集合。
8. workflow、lockfile、Node 22、tsx declared `^4.23.1`、tsx resolved `4.23.11`、test command 均保持不变；`NODE_OPTIONS` 和 `--no-warnings` 均未添加。

本地验证全部通过后，按逻辑边界创建普通前向 commits，不 amend、rebase、squash、reset 或 force push。push 前再次 fetch 并核对远程旧 HEAD，只允许 fast-forward push 到 `infra/github-actions-ci`。

最终只接受新 pushed SHA 对应、event 为 `pull_request`、Node 为 22 的 GitHub Actions run。Install dependencies、Server tests、Shared M3、Workspace build 和 overall workflow 必须全部通过。即使完全绿色，PR #42 仍保持 OPEN/DRAFT，不修改 PR body，不执行 Ready、Merge 或 M4。

当前 PR body 声明 `CI infrastructure only` 和 `No runtime/product/migration changes`。production remediation push 后，这两项 metadata 预期会变为 stale；本 gate 只登记该事实，不修改 PR body。进入 Ready review 前必须另开一个获得授权的 metadata-only remediation，使 PR 描述重新与实际 diff 一致。
