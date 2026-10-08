# S1 终态触发与重启收敛候选证据包（LITE-07-102）

本报告只记录候选证据，不能直接改变验收矩阵状态。1 个 requirement 的 verdict 只能取 `candidate-supported`、`insufficient-evidence` 或 `failed`；本轮没有执行 PASS 提升，也没有执行 `--require-closed`。

- baseline SHA：`b6476e1e4c4c460e4fcab9b2b09c05b9d61d3cc3`
- 机器可读包：`docs/implementation/lite-closeout/LITE-07-102-candidate-evidence.json`
- 模型口径：本包不调用任何 Provider 模型：Run 在启动阶段因 Provider 可执行文件不可用而失败，证据绑定的是 AgentOS 自身的终态触发、有界事实与重启清扫契约。
- 这些 requirement 的矩阵状态在本轮保持 `GAP`，verdict 只是候选证据。

| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |
| --- | --- | --- | --- | ---: |
| `LITE-07-102` | `Task/Run/Stage terminal outcome 触发及故障后收敛` | `candidate-supported` | 7 total / 7 passed / 0 failed / 0 skipped | 0 |

## 最终执行记录

```powershell
node --import tsx ../../scripts/verify-lite-07-102-candidate-evidence.mjs --out E:\workspace\Multi-Agent-worktrees\agentos-lite-s5-evidence\agentos\docs\implementation\lite-closeout\evidence\s102-candidate-evidence-20260914
```

raw exit = `0`；receipts 统计 `7 total / 7 passed / 0 failed / 0 skipped`。

| 日志 / 收据 | bytes | SHA-256 |
| --- | ---: | --- |
| `docs/implementation/lite-closeout/evidence/s102-candidate-evidence-20260914/receipts.json` | 8980 | `7e09d7da156d4f144c3c4a0fe8a09f0a2d6da16092ad779d159232c5ecfd826f` |
| `docs/implementation/lite-closeout/evidence/s102-candidate-evidence-20260914/stdout.txt` | 63 | `883de926c1ca6ca5f09f7f36d9882a57bad420c6463face24d9f67df02b49fe0` |
| `docs/implementation/lite-closeout/evidence/s102-candidate-evidence-20260914/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s102-candidate-evidence-20260914/exit.txt` | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| `docs/implementation/lite-closeout/evidence/s102-candidate-evidence-20260914/scope-verifier.stdout.txt` | 93 | `c412198c0b3a31ba0bce0ce7a3d661de904524bc7082edd140be153a9d2eb5b1` |
| `docs/implementation/lite-closeout/evidence/s102-candidate-evidence-20260914/scope-verifier.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s102-candidate-evidence-20260914/targeted-tests/targeted.stdout.txt` | 5632 | `d3147222cf56467d61c6b47f824add618ed856355769374f3f3805501bf370ad` |
| `docs/implementation/lite-closeout/evidence/s102-candidate-evidence-20260914/targeted-tests/targeted.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

### 被驱动的 gate 调用

```json
{}
```

## `LITE-07-102`

matrix 原文为 `Task/Run/Stage terminal outcome 触发及故障后收敛`；条款来源 `apps/server/src/services/MemoryCandidateGenerationService.ts:130`，并引用：

- `apps/server/src/services/run-engine/RunEngineProviderDispatcher.ts:571` — 派发时触发：非成功终态 Run 也要生成事实
- `apps/server/src/services/TerminalMemoryCandidateReconciler.ts:108` — 重启清扫：只修缺失的候选，不猜执行结果
- `apps/server/src/index.ts:222` — 生产组合根在启动时执行清扫并记录结果

- matrix 状态：`GAP`（workPackage `S1`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：有界规范终态按来源幂等生成，重启不遗漏；失败不得修改已终态Run或启动执行；不保存raw输出。
- 原始记录缺口（matrix `finding`）：仅成功最终Run路径触发；非成功终态、独立Stage和终态提交到候选生成之间的崩溃窗口未覆盖。
- 生产入口（matrix `implementation`）：`apps/server/src/services/run-engine/RunEngineProviderDispatcher.ts`、`apps/server/src/services/MemoryCandidateGenerationService.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S102-TRIGGER-01` | `trigger`：a non-success terminal Run produces exactly one bounded Candidate from the dispatch-time trigger | `{"runStatus":"failed","failureCode":"PROVIDER_EXECUTABLE_NOT_ACCESSIBLE","terminalEvents":["run.dequeued","run.started","run.failed"],"stageOutcomes":["failed","skipped","skipped","skipped"],"candidateCount":1,"candidate":[{"id":"mcand_terminal_run_lite102_a","scope":"task","category":"failure","authority":"agent-deriv…` | `{"runStatus":"failed","failureCode":"PROVIDER_EXECUTABLE_NOT_ACCESSIBLE","terminalEvents":["run.dequeued","run.started","run.failed"],"stageOutcomes":["failed","skipped","skipped","skipped"],"candidat…` | passed |
| `S102-BOUNDED-01` | `bounded`：the fact is bounded record-only evidence: allowlisted lines, truncated fields, no raw output | `{"contentBytes":404,"withinBound":true,"everyLineAllowlisted":true,"prefixesSeen":["任务：","结果：","失败代码：","失败说明：","Stage 结果："],"failureCodeLine":"失败代码：PROVIDER_EXECUTABLE_NOT_ACCESSIBLE","failureMessageTruncated":true,"stageSummary":true,"storedMessageIsTheRunsOwnBoundedMessage":true,"providerOutputRowsForThisWorkspace":0…` | `{"contentBytes":404,"withinBound":true,"everyLineAllowlisted":true,"prefixesSeen":["任务：","结果：","失败代码：","失败说明：","Stage 结果："],"failureCodeLine":"失败代码：PROVIDER_EXECUTABLE_NOT_ACCESSIBLE","failureMessageT…` | passed |
| `S102-IDEMPOTENT-01` | `idempotent`：a replay neither modifies the terminal Run nor creates a second fact or Event | `{"replayOutcome":"existing","replayCandidateMatches":true,"runRowsUnchanged":true,"candidatesAdded":0,"eventsAdded":0}` | `{"replayOutcome":"existing","replayCandidateMatches":true,"runRowsUnchanged":true,"candidatesAdded":0,"eventsAdded":0}` | passed |
| `S102-RESTART-01` | `restart`：the startup sweep repairs the crashed Run and reports the Run that has no authority to repair from | `{"terminalRunRows":3,"generated":1,"existing":1,"missingAuthority":1,"unresolved":0,"repairedCandidate":{"id":"mcand_terminal_run_lite102_b","scope":"task","category":"failure","decision":"review-required","citesRun":true},"candidateEventsBefore":1,"terminalEventBefore":1,"candidatesAfterSweep":2}` | `{"terminalRunRows":3,"generated":1,"existing":1,"missingAuthority":1,"unresolved":0,"repairedCandidate":{"id":"mcand_terminal_run_lite102_b","scope":"task","category":"failure","decision":"review-requ…` | passed |
| `S102-RESTART-02` | `restart`：the sweep never mutates a Run row, terminal or not | `{"runRowsUnchanged":true,"runs":[{"id":"run_lite102_a","status":"failed"},{"id":"run_lite102_b","status":"failed"},{"id":"run_lite102_c","status":"cancelled"}]}` | `{"runRowsUnchanged":true,"runs":[{"id":"run_lite102_a","status":"failed"},{"id":"run_lite102_b","status":"failed"},{"id":"run_lite102_c","status":"cancelled"}]}` | passed |
| `S102-RESTART-03` | `restart`：a second sweep converges with no new facts, so a restart loop cannot duplicate work | `{"generated":0,"existing":2,"missingAuthority":1,"candidates":2}` | `{"generated":0,"existing":2,"missingAuthority":1,"candidates":2}` | passed |
| `S102-REFUSE-01` | `refuse`：a non-terminal Run is refused without being touched and without any execution starting | `{"outcome":"not-terminal","runRowsUnchanged":true,"runStatus":"queued","candidateCreated":false,"providerProcesses":0,"runtimeEvents":0}` | `{"outcome":"not-terminal","runRowsUnchanged":true,"runStatus":"queued","candidateCreated":false,"providerProcesses":0,"runtimeEvents":0}` | passed |

**非成功终态触发**：一条真实 canonical Run 在生产派发链上于启动阶段失败（PROVIDER_EXECUTABLE_NOT_ACCESSIBLE），Run 状态 failed、Stage 为 failed+3×skipped、终态事件 run.failed 已写；派发时触发恰好产生一个 Candidate（`mcand_terminal_<runId>`，task scope / failure 类 / agent-derived / review-required），并有一条 canonical memory.candidate_created 事件；同时 provider 进程 0、provider 会话 0、进程输出引用 0——失败没有启动执行、也没有留下原始输出。**有界事实**：候选内容 404 字节，每一行都属于冻结字段前缀（任务/结果/失败代码/失败说明/Stage 结果），失败说明行等于该 Run 自身失败信息截断到 400 字符，Stage 结果行含 `codex_manager: failed`。**按来源幂等**：再次派发 + 用同一持久事件的上下文再次调用生成器 → outcome `existing`，Run 行（含 version/updated_at）逐字节不变，候选与事件数均不增。**重启不遗漏**：移除 run_b 的候选行（崩溃留下的状态）后，生产清扫器在 3 条终态 Run 上报告 generated=1（修复 run_b）、existing=1（run_a）、missingAuthority=1（run_c 无终态事件），且所有 Run 行逐字节不变；第二次清扫 generated=0、existing=2，收敛。**不修改终态 Run / 不启动执行**：非终态 Run 调用生成器返回 not-terminal，Run 行不变、无候选、无进程、无事件。

未证明的相邻行为：覆盖 failed 终态的真实派发触发、幂等重放、崩溃窗口重启修复、无权威不发明、以及非终态拒绝与零执行；cancelled 终态只以夹具行出现在 missingAuthority 分支（未走生产取消链），per-Stage 候选生成器在当前实现中不存在（Stage 终态以该 Run 事实内的 Stage 结果行体现）。

## targeted tests 与 scope verifier

受影响测试（3 个文件：MemoryCandidateGenerationService / TerminalMemoryCandidateReconciler / RunEngineProviderDispatcher，`node --import tsx --test --test-concurrency=1`，在 `apps/server` 下执行）raw exit = 0，Node summary 为 `52 pass / 0 fail / 4 skipped`（4 个 skip 是环境门控的真实 Provider 用例，本机无对应 CLI）；普通 scope verifier 未加 `--require-closed`，raw exit = 0，stdout 原文为 `{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}`。

- 崩溃窗口的复现方式是「保留终态 Run 与其 canonical 终态事件、只移除该 Run 的 Candidate 行」——这正是崩溃会留下的状态（终态已提交、候选未生成），修复由生产清扫器执行；本包不声称重放过崩溃本身。
- `run_c` 用于验证「无权威则不发明」：它直接以终态入库但**没有**终态 Runtime Event，清扫器如实报告 missingAuthority 且不生成候选。该行是夹具（模拟终态事件未写入），不是生产驱动的结果。
- 本包覆盖 failed 与 cancelled 两种非成功终态中的 failed（由真实派发链产生）；cancelled 只以夹具行出现，用于 missingAuthority 分支，未走生产取消链。
- 独立 Stage 的终态是以该 Run 事实内的 `Stage 结果：` 行体现的（stage 状态、attempt、duration），不存在 per-Stage 的候选生成器；这是当前实现的边界，本包按此记录。
- 「失败不得启动执行」在本包以 provider 进程数 0、provider 会话数 0、进程输出引用 0 三条持久事实取证（该失败发生在启动阶段）。

## 矩阵保护

生成前后未修改 `pass-freeze.json` / `matrix.json` / `pass-evidence-audit.json`，未执行任何 promotion 脚本，也未执行 `--require-closed`。与 baseline blob 的 SHA-256 对比：

| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |
| --- | --- | --- | --- |
| `docs/implementation/lite-closeout/matrix.json` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | true |
| `docs/implementation/lite-closeout/pass-freeze.json` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | true |
| `docs/implementation/lite-closeout/pass-evidence-audit.json` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | true |

工作区 delta（`git status --porcelain=v1`）：

```text
?? agentos/docs/implementation/lite-closeout/LITE-07-102-candidate-evidence.json
?? agentos/docs/implementation/lite-closeout/LITE-07-102-candidate-evidence.md
?? agentos/docs/implementation/lite-closeout/LITE-07-102-candidate-evidence.spec.json
?? agentos/docs/implementation/lite-closeout/evidence/s102-candidate-evidence-20260914/
?? agentos/scripts/verify-lite-07-102-candidate-evidence.mjs
```

