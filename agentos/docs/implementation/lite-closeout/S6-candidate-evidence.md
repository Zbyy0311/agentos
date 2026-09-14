# S6 自动压缩候选证据包（LITE-07-105 / LITE-09-104～110 / LITE-13-101）

本报告只记录候选证据，不能直接改变验收矩阵状态。九个 requirement 的本轮 verdict 只能取 `candidate-supported`、`insufficient-evidence` 或 `failed`；本轮没有执行 PASS 提升，也没有执行 `--require-closed`。

## 固定边界

- baseline SHA：`d89137ccbf72ef75faca8c807de61fb972f356ff`（本次证据运行绑定的 worktree HEAD）
- 分支：`audit/lite-s6-s7-candidate-evidence`
- 机器可读包：`docs/implementation/lite-closeout/S6-candidate-evidence.json`
- 指定路由模型：compaction = `gpt-5.6-luna`
- 权限模型口径：**此证据验证的是指定路由模型下的 AgentOS Provider/Runtime canonical chain，不证明机器默认模型或额度受限模型可用。**
- receipt 模板：本 harness 每条断言都记录 `actual`、`expected` 与 `outcome`，不做空值或失败归一化。

| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |
| --- | --- | --- | --- | ---: |
| `LITE-09-104` | `版本化lite-v1阈值和预算原因` | `candidate-supported` | 3 total / 3 passed / 0 failed / 0 skipped | 0 |
| `LITE-09-105` | `有界摘要发布、原消息保留和实际context应用` | `candidate-supported` | 7 total / 7 passed / 0 failed / 0 skipped | 0 |
| `LITE-09-106` | `压缩执行安全与Provider identity冻结` | `candidate-supported` | 5 total / 5 passed / 0 failed / 0 skipped | 0 |
| `LITE-09-107` | `每Conversation单持有者、持久恢复、租约与重试` | `candidate-supported` | 6 total / 6 passed / 0 failed / 0 skipped | 0 |
| `LITE-09-108` | `压缩失败的硬预算分支` | `candidate-supported` | 5 total / 5 passed / 0 failed / 0 skipped | 0 |
| `LITE-13-101` | `Inspector解释每次压缩为何触发及被谁采用` | `candidate-supported` | 4 total / 4 passed / 0 failed / 0 skipped | 0 |
| `LITE-09-109` | `仅复用现有Message修订/可见性校验摘要来源` | `candidate-supported` | 1 total / 1 passed / 0 failed / 0 skipped | 0 |
| `LITE-09-110` | `Provider-native compaction不得作为canonical evidence` | `candidate-supported` | 1 total / 1 passed / 0 failed / 0 skipped | 0 |
| `LITE-07-105` | `Conversation compaction 来源触发` | `candidate-supported` | 7 total / 7 passed / 0 failed / 0 skipped | 0 |

## 最终执行记录

harness 命令（在 `apps/server` 下执行，`PATH` 前置 `C:\Users\Administrator\.codex\.sandbox-bin` 以便 spawn 到真正的 `codex.exe`；该目录外只有 .ps1/.cmd shim，spawn 无法执行）：

```powershell
$env:PATH = 'C:\Users\Administrator\.codex\.sandbox-bin;' + $env:PATH
$env:AGENTOS_COMPACTION_MODEL = 'gpt-5.6-luna'
node --import tsx ../../scripts/verify-lite-s6-candidate-evidence.mjs --out E:\workspace\Multi-Agent-worktrees\agentos-lite-s67-evidence\agentos\docs\implementation\lite-closeout\evidence\s6-candidate-evidence-20260914
```

raw exit = `0`；receipts 统计 `39 total / 39 passed / 0 failed / 0 skipped`；真实 Provider 压缩耗时 60417 ms。

| 日志 / 收据 | bytes | SHA-256 |
| --- | ---: | --- |
| `docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/receipts.json` | 24852 | `d62e8cff5a109699eaa83988f42f10c94568261d851d0abf72e98a0c2e73a73b` |
| `docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/stdout.txt` | 82 | `db3561b868c255ae9313c05b8031cecc6d33e585240fc972ed78419ed670d253` |
| `docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/exit.txt` | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| `docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/scope-verifier.stdout.txt` | 93 | `c412198c0b3a31ba0bce0ce7a3d661de904524bc7082edd140be153a9d2eb5b1` |
| `docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/scope-verifier.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/targeted-tests/targeted.stdout.txt` | 4820 | `fbb6e9aac033a6208f4bfd29c115f268438bd971f4ba189fb4048f54cc6f5dbe` |
| `docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/targeted-tests/targeted.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s6-real-summary-20260914/stdout.txt` | 337 | `60e027d5cf126163909def98aeb671e9eaadc106a4ff57f1c1ada8bea8f70b33` |
| `docs/implementation/lite-closeout/evidence/s6-real-summary-20260914/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s6-real-summary-20260914/exit.txt` | 2 | `9a271f2a916b0b6ee6cecb2426f0b3206ef074578be55d9bc94f6f3fe3ab86aa` |

harness 源码与 receipts 位于 `docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914`；独立既有 harness 的真实 Provider 运行记录保留在 `docs/implementation/lite-closeout/evidence/s6-real-summary-20260914`，作为同一真实链路的补充原始日志。

## `LITE-09-104`

matrix 原文为 `版本化lite-v1阈值和预算原因`，matrix section 为 `user-approved automatic compaction`；冻结条款来源 `docs/implementation/lite-closeout/S6-compaction-authorization.md:17`，并引用：

- `docs/implementation/lite-closeout/S6-compaction-authorization.md:13` — lite-v1 默认值是实现策略而非规范常量
- `docs/implementation/lite-closeout/compaction-policy-lite-v1.json:1` — 策略参数与 estimator 版本的冻结记录

- matrix 状态：`GAP`（workPackage `S6`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：持久policyVersion及70%/50%/8/2048/120000/1；每次保存预算组成、上限来源、估算器版本；未来策略不重写历史。
- 原始记录缺口（matrix `finding`）：无持久策略或预算评估。
- 生产入口（matrix `implementation`）：`apps/server/src/services/ConversationTurnDriver.ts`
- 关联测试（matrix `tests`）：未记录

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S6E-REAL-10` | `real`：the lite-v1 policy records the versioned thresholds | `{"policyVersion":"lite-v1","triggerRatio":0.7,"targetRatio":0.5,"minRecentMessages":8,"summaryMaxTokens":2048,"timeoutMs":120000,"maxAutomaticRetries":1}` | `{"policyVersion":"lite-v1","triggerRatio":0.7,"targetRatio":0.5,"minRecentMessages":8,"summaryMaxTokens":2048,"timeoutMs":120000,"maxAutomaticRetries":1}` | passed |
| `S6E-REAL-11` | `real`：the task records the budget composition and estimator that produced it | `{"policyVersion":"lite-v1","estimatorVersion":"lite-v1-chars4","providerContextTokens":12000,"outputReserveTokens":2048,"applicationBudgetSource":"provider","triggerRatio":0.7,"targetRatio":0.5,"retainedRecentMessages":8,"taskEstimatorVersion":"lite-v1-chars4"}` | `{"policyVersion":"lite-v1","estimatorVersion":"lite-v1-chars4","providerContextTokens":12000,"outputReserveTokens":2048,"applicationBudgetSource":"provider","triggerRatio":0.7,"targetRatio":0.5,"retai…` | passed |
| `S6E-DB-01` | `durable`：a versioned policy row cannot be rewritten, so an old budget keeps its interpretation | `{"refusedWithCode":true,"storedMaxTokens":2048}` | `{"refusedWithCode":true,"storedMaxTokens":2048}` | passed |

Assertions read the production policy registry for lite-v1 (triggerRatio 0.70 / targetRatio 0.50 / minRecentMessages 8 / summaryMaxTokens 2048 / timeoutMs 120000 / maxAutomaticRetries 1) and then read back the real published task row, proving the effective policy version, the estimator version (lite-v1-chars4), the budget composition (providerContextTokens / outputReserveTokens / applicationBudgetSource), the trigger and target ratios and the retained window are all persisted with the summary, so a historical compaction stays explainable after the policy evolves.

未证明的相邻行为：Covers one real publish record, the threshold read for lite-v1, and the executed refusal of an in-place policy rewrite (COMPACTION_POLICY_IMMUTABLE, stored max tokens unchanged). It does not exercise a later policy version migration path, and it does not cover the 16384-token fallback application budget because the real task resolved applicationBudgetSource=provider.

## `LITE-09-105`

matrix 原文为 `有界摘要发布、原消息保留和实际context应用`，matrix section 为 `user-approved automatic compaction`；冻结条款来源 `docs/implementation/lite-closeout/S6-compaction-authorization.md:20`，并引用：

- `docs/implementation/lite-closeout/S6-compaction-authorization.md:24` — 有效上下文为 prior summary + uncompressed tail
- `docs/implementation/lite-closeout/S6-compaction-authorization.md:40` — Messages 永不静默截断

- matrix 状态：`GAP`（workPackage `S6`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：保留原消息，摘要不可变；前序摘要+有界前缀分批；近期至少8条+当前输入，采用摘要+未压缩尾部。
- 原始记录缺口（matrix `finding`）：无canonical summary/source range。
- 生产入口（matrix `implementation`）：`apps/server/src/store/ConversationRepository.ts`
- 关联测试（matrix `tests`）：未记录

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S6E-REAL-05` | `real`：the published summary is non-empty and inside the recorded budget | `{"lengthOk":true,"summaryHashMatches":true}` | `{"lengthOk":true,"summaryHashMatches":true}` | passed |
| `S6E-REAL-06` | `real`：the source range it covered is recorded | `{"sourceMessageCount":4,"hasStart":true,"hasEnd":true,"hasSourceHash":true}` | `{"sourceMessageCount":4,"hasStart":true,"hasEnd":true,"hasSourceHash":true}` | passed |
| `S6E-REAL-13` | `real`：the Messages the summary covered survive the published compaction unchanged | `{"rowsBefore":12,"rowsAfter":12,"digestUnchanged":true,"distinctStatuses":["final"]}` | `{"rowsBefore":12,"rowsAfter":12,"digestUnchanged":true,"distinctStatuses":["final"]}` | passed |
| `S6E-REAL-16` | `real`：only the bounded old prefix is compacted: the recent window stays uncompressed | `{"totalMessages":12,"sourceMessageCount":4,"retainedMessages":8,"minRecentMessages":8,"sourceStartIsOldest":true,"sourceEndIsLastCoveredMessage":true}` | `{"totalMessages":12,"sourceMessageCount":4,"retainedMessages":8,"minRecentMessages":8,"sourceStartIsOldest":true,"sourceEndIsLastCoveredMessage":true}` | passed |
| `S6E-GUARD-01` | `guard`：an oversized summary is refused, never published | `{"outcome":"retry-pending","failureCode":"COMPACTION_SUMMARY_INVALID","attempts":1,"summarizerCalls":1,"published":false,"candidates":0}` | `{"outcome":"retry-pending","failureCode":"COMPACTION_SUMMARY_INVALID","attempts":1,"summarizerCalls":1,"published":false,"candidates":0}` | passed |
| `S6E-DB-02` | `durable`：a published summary cannot be rewritten after it became canonical | `{"refusedWithCode":true,"summaryHashUnchanged":true}` | `{"refusedWithCode":true,"summaryHashUnchanged":true}` | passed |
| `S6E-TURNGATE-02` | `turngate`：the real published summary reaches the Provider context and replaces exactly the covered Messages | `{"status":"completed","runnerCalls":1,"summaryEntryIdPresent":true,"summaryTextInContext":true,"coveredIdsStillInContext":[],"tailIdsStillInContext":["msg_004","msg_005","msg_006","msg_007"]}` | `{"status":"completed","runnerCalls":1,"summaryEntryIdPresent":true,"summaryTextInContext":true,"coveredIdsStillInContext":[],"tailIdsStillInContext":["msg_004","msg_005","msg_006","msg_007"]}` | passed |

The publish path proves the summary is non-empty, inside the recorded summaryMaxTokens budget, hash-identical to its stored content, and carries the source range (start/end Message id, count, 64-char source hash). The same run compares real cr_messages rows before and after the publish and shows all 12 covered Messages are byte-identical and still status=final, i.e. the originals are neither deleted nor rewritten. Context application is covered by the production applyCompactionSummary: inside the budget it applies and reports summarizedMessages, over the hard budget it refuses.

未证明的相邻行为：The original-Message comparison covers the 12 Messages of this Conversation; multi-batch prefix compaction and cross-Conversation batches are not replayed here. Context application is asserted through the production Turn driver with a recording Runner (the summary entry and the untouched tail are what the Provider receives), not through a live Provider conversation; the summary is additionally shown to be unrewritable once published, and no UI rendering is proven.

## `LITE-09-106`

matrix 原文为 `压缩执行安全与Provider identity冻结`，matrix section 为 `user-approved automatic compaction`；冻结条款来源 `docs/implementation/lite-closeout/S6-compaction-authorization.md:25`，并引用：

- `docs/implementation/lite-closeout/S6-compaction-authorization.md:28` — 无法排除工具/写入时按失败处理，而不是放宽沙箱
- `apps/server/src/services/summarizationCliProfiles.ts:39` — codex 是唯一 allowlist profile，其余 Provider fail-closed

- matrix 状态：`GAP`（workPackage `S6`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：冻结触发轮Provider，禁止静默切换；不可保证禁工具/禁写则不可调用，按预算失败分支处理。
- 原始记录缺口（matrix `finding`）：无tool-free/write-denied摘要执行证据。
- 生产入口（matrix `implementation`）：`packages/agent-core/src/conversationRunner.ts`
- 关联测试（matrix `tests`）：未记录

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S6E-REAL-02` | `real`：the summary was produced by a real Provider process | `{"summaryNonEmpty":true}` | `{"summaryNonEmpty":true}` | passed |
| `S6E-REAL-03` | `real`：the frozen Provider identity is recorded on the task | `{"adapterId":"cli.codex","adapterVersion":"1.0.0","providerType":"codex","model":"gpt-5.6-luna"}` | `{"adapterId":"cli.codex","adapterVersion":"1.0.0","providerType":"codex","model":"gpt-5.6-luna"}` | passed |
| `S6E-REAL-04` | `real`：the summary ran under the allowlisted read-only CLI profile | `{"readOnly":true,"skipGitRepoCheck":true}` | `{"readOnly":true,"skipGitRepoCheck":true}` | passed |
| `S6E-REAL-14` | `real`：the summary run is read-only sandboxed with no approval or tool bypass | `{"args":["exec","--sandbox","read-only","--skip-git-repo-check"],"sandboxReadOnly":true,"bypassFlagsPresent":[],"approvalDecisions":0,"nonCandidateEvents":0}` | `{"args":["exec","--sandbox","read-only","--skip-git-repo-check"],"sandboxReadOnly":true,"bypassFlagsPresent":[],"approvalDecisions":0,"nonCandidateEvents":0}` | passed |
| `S6E-DB-03` | `durable`：the frozen Provider identity cannot be rewritten after the summary was published | `{"refusedWithCode":true,"storedModel":"gpt-5.6-luna"}` | `{"refusedWithCode":true,"storedModel":"gpt-5.6-luna"}` | passed |

The summary is produced by a real Codex CLI process started by the production summarizer, not by a stub. The published task row freezes adapterId cli.codex@1.0.0, providerType codex and the routed model, and the executed profile is asserted to be read-only sandboxed: --sandbox read-only present, no --dangerously-bypass-approvals-and-sandbox, no --full-auto, no workspace-write and no danger-full-access, zero approval_decisions rows written, and no Workspace Event other than the single memory.candidate_created of the real task.

未证明的相邻行为：The safety assertions cover the real execution, the argument-level composition of the single allowlisted profile (codex), and the executed refusal to edit the frozen provider identity after publication. kimi and opencode have no allowlist profile and fail closed; no real summary was produced through them, so their refusal path is not re-verified here.

## `LITE-09-107`

matrix 原文为 `每Conversation单持有者、持久恢复、租约与重试`，matrix section 为 `user-approved automatic compaction`；冻结条款来源 `docs/implementation/lite-closeout/S6-compaction-authorization.md:29`，并引用：

- `docs/implementation/lite-closeout/S6-compaction-authorization.md:32` — 自动重试在 maxAutomaticRetries 处停止

- matrix 状态：`GAP`（workPackage `S6`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：并发单持有者；重启先判断旧执行，不猜测结束；旧租约不可发布；自动重试最多一次，超时120秒。
- 原始记录缺口（matrix `finding`）：无压缩任务恢复状态。
- 生产入口（matrix `implementation`）：`apps/server/src/index.ts`
- 关联测试（matrix `tests`）：未记录

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S6E-GUARD-02` | `guard`：the schema carries a one-running-holder index per Conversation | `{"unwrapped":"CREATE UNIQUE INDEX conversation_compactions_one_running ON conversation_compactions (conversation_id) WHERE status = 'running'","isUnique":true,"scopedToRunning":true}` | `{"unwrapped":"CREATE UNIQUE INDEX conversation_compactions_one_running ON conversation_compactions (conversation_id) WHERE status = 'running'","isUnique":true,"scopedToRunning":true}` | passed |
| `S6E-GUARD-03` | `guard`：a second running holder for the same Conversation is refused by the store | `{"refused":true,"refusalIsStable":true}` | `{"refused":true,"refusalIsStable":true}` | passed |
| `S6E-GUARD-05` | `guard`：exactly one running holder remains after the refusal | `{"running":1}` | `{"running":1}` | passed |
| `S6E-GUARD-04` | `guard`：the automatic evaluation resumes the same attempt and stops at the bounded retry budget | `{"outcome":"failed","sameTask":true,"attempts":2,"failureCode":"COMPACTION_RETRIES_EXHAUSTED","summarizerCalls":2,"published":false,"running":0}` | `{"outcome":"failed","sameTask":true,"attempts":2,"failureCode":"COMPACTION_RETRIES_EXHAUSTED","summarizerCalls":2,"published":false,"running":0}` | passed |
| `S6E-GUARD-07` | `guard`：a spent automatic chain is never re-scheduled: no new attempt row and no new Provider call | `{"outcome":"failed","sameTask":true,"failureCode":"COMPACTION_RETRIES_EXHAUSTED","summarizerCalls":2,"guardTaskRows":1}` | `{"outcome":"failed","sameTask":true,"failureCode":"COMPACTION_RETRIES_EXHAUSTED","summarizerCalls":2,"guardTaskRows":1}` | passed |
| `S6E-DB-05` | `durable`：a publish from a lease that no longer holds the attempt is refused | `{"refused":true,"stableCode":true,"rowStillRunning":"running"}` | `{"refused":true,"stableCode":true,"rowStillRunning":"running"}` | passed |

The schema-level invariant is read from sqlite_master (UNIQUE INDEX conversation_compactions_one_running ON conversation_compactions (conversation_id) WHERE status = running), and the executed check claims a second running holder for the same Conversation while the first still holds it: the store refuses with the stable code COMPACTION_CONFLICT (no raw SQLite text leaks) and exactly one running row remains afterwards. The retry bound is executed as well: the first failing attempt records retry-pending with attempts=1 and one summarizer call, the second automatic evaluation resumes that same row, spends the single allowed automatic retry (attempts=2, second summarizer call) and records COMPACTION_RETRIES_EXHAUSTED, and the third automatic evaluation makes no Provider call at all and adds no row. Only the explicit retry starts a fresh attempt.

未证明的相邻行为：Covers the single-holder, refusal, stale-lease and bounded-retry branches (a publish from a lease that no longer holds the attempt is refused with the stable conflict code and the row stays running). Restart classification and the expired-lease reclaim are covered by the migration/unit tests of the same slice, not replayed against a real Provider in this harness. A Provider/model change during a pending chain starts a new attempt instead of continuing the frozen identity; that branch is covered by the identity comparison in the service and is not exercised here.

## `LITE-09-108`

matrix 原文为 `压缩失败的硬预算分支`，matrix section 为 `user-approved automatic compaction`；冻结条款来源 `docs/implementation/lite-closeout/S6-compaction-authorization.md:37`，并引用：

- `docs/implementation/lite-closeout/S6-compaction-authorization.md:40` — 超限时保留输入并提供显式重试

- matrix 状态：`GAP`（workPackage `S6`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：预算内继续且有界retry pending；超限不发Provider调用，保留当前消息与显式重试；无静默截断。
- 原始记录缺口（matrix `finding`）：无硬预算门禁。
- 生产入口（matrix `implementation`）：`apps/server/src/services/ConversationTurnDriver.ts`
- 关联测试（matrix `tests`）：未记录

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S6E-GUARD-08` | `guard`：the explicit retry spends its own attempt instead of being blocked by the spent chain | `{"outcome":"retry-pending","startsNewAttempt":true,"attempts":1,"summarizerCalls":3,"guardTaskRows":2,"published":false}` | `{"outcome":"retry-pending","startsNewAttempt":true,"attempts":1,"summarizerCalls":3,"guardTaskRows":2,"published":false}` | passed |
| `S6E-BUDGET-01` | `budget`：summary plus tail beyond the hard budget is refused | `{"kind":"over-budget"}` | `{"kind":"over-budget"}` | passed |
| `S6E-BUDGET-02` | `budget`：the refusal never truncates or drops the messages | `{"historyLength":3,"contents":[1,1,400]}` | `{"historyLength":3,"contents":[1,1,400]}` | passed |
| `S6E-BUDGET-03` | `budget`：the same history inside the budget applies the summary | `{"kind":"applied","summarizedMessages":2}` | `{"kind":"applied","summarizedMessages":2}` | passed |
| `S6E-TURNGATE-01` | `turngate`：an over-budget summary and tail block the Provider call before any reservation | `{"error":{"type":"ConversationTurnDriverError","code":"TURN_DRIVER_COMPACTION_BUDGET_EXCEEDED"},"runnerCalls":0,"messagesAdded":0,"turnsAdded":0,"digestsUnchanged":true}` | `{"error":{"type":"ConversationTurnDriverError","code":"TURN_DRIVER_COMPACTION_BUDGET_EXCEEDED"},"runnerCalls":0,"messagesAdded":0,"turnsAdded":0,"digestsUnchanged":true}` | passed |

On the production apply function, when prior summary plus the uncompressed tail exceeds the hard budget the result is over-budget and the input history is unchanged in length and in per-message content length (nothing truncated or dropped); the same history inside the budget applies the summary and reports summarizedMessages=2. The production Turn driver then refuses the same way end to end: TURN_DRIVER_COMPACTION_BUDGET_EXCEEDED before any reservation, zero Runner calls, zero Messages and zero Turns added, every Message digest unchanged. The explicit retry the failure branch promises is executed too: after the bounded automatic chain is spent, the retry with resume=explicit starts its own attempt (new row, attempts=1) instead of being blocked by the spent chain.

未证明的相邻行为：The over-budget branch is asserted on the production function and through the production Turn driver rather than as a live Provider conversation, and the explicit retry is asserted on the production engine/service path as the retry endpoint calls it (the endpoint itself adds no logic beyond passing the mode). The within-budget "continue plus retry-pending" Turn behaviour is covered by the ConversationTurnDriver unit tests.

## `LITE-13-101`

matrix 原文为 `Inspector解释每次压缩为何触发及被谁采用`，matrix section 为 `Inspector 压缩读面`；冻结条款来源 `apps/server/src/routes/conversationRuntime.ts:269`，并引用：

- `docs/implementation/lite-closeout/S6-compaction-authorization.md:17` — 每次压缩持久化策略版本、实际参数与预算组成
- `apps/server/src/services/ConversationTurnDriver.ts:416` — 采用摘要的 Turn 在冻结快照里记录 compactionSummaryId 与 summarizedMessages

- matrix 状态：`GAP`（workPackage `S6`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：展示触发值/阈值、预算组成、来源、策略、摘要、失败/重试和实际Turn/Snapshot引用。
- 原始记录缺口（matrix `finding`）：无compaction projection。
- 生产入口（matrix `implementation`）：`apps/server/src/services/RuntimeInspector.ts`、`apps/web/src/components/chat/RuntimeInspectorView.tsx`
- 关联测试（matrix `tests`）：`apps/server/src/routes/runtimeInspector.test.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S6E-INSPECTOR-01` | `inspector`：the read surface explains why this compaction happened, to whom and under which policy | `{"status":200,"taskCount":1,"tasksMatchDurableRows":true,"taskStatus":"published","taskModel":"gpt-5.6-luna","adapterId":"cli.codex","adapterVersion":"1.0.0","estimatorVersion":"lite-v1-chars4","attempts":1,"failureCode":null,"hasSummaryHash":true,"candidateMatches":true,"summaryMatchesDurableRow":true,"sourceRange":{"…` | `{"status":200,"taskCount":1,"tasksMatchDurableRows":true,"taskStatus":"published","taskModel":"gpt-5.6-luna","adapterId":"cli.codex","adapterVersion":"1.0.0","estimatorVersion":"lite-v1-chars4","attem…` | passed |
| `S6E-INSPECTOR-02` | `inspector`：the effective policy version and its parameters are readable, not implied | `{"policies":[{"policyVersion":"lite-v1","triggerRatio":0.7,"targetRatio":0.5,"minRecentMessages":8,"summaryMaxTokens":2048,"timeoutMs":120000,"maxAutomaticRetries":1,"fallbackApplicationBudgetTokens":16384}],"estimatorVersion":"lite-v1-chars4"}` | `{"policies":[{"policyVersion":"lite-v1","triggerRatio":0.7,"targetRatio":0.5,"minRecentMessages":8,"summaryMaxTokens":2048,"timeoutMs":120000,"maxAutomaticRetries":1,"fallbackApplicationBudgetTokens":…` | passed |
| `S6E-INSPECTOR-03` | `inspector`：the surface names the Turn and frozen snapshot that actually adopted the summary | `{"adoptions":[{"snapshotId":"snapshot_01M2FZ5RF398WPA1NPBJX42SEX","turnId":"turn_cccccccccccccccccccc","summaryId":"snapshot_01M2FZ3XCQ0H1EC3FD81SRQ4CV","createdAt":"2026-09-14T12:43:49.484Z"}],"turnPointsAtAdoptedSnapshot":true,"adoptedSummaryIsThePublishedRow":true}` | `{"adoptions":[{"snapshotId":"snapshot_01M2FZ5RF398WPA1NPBJX42SEX","turnId":"turn_cccccccccccccccccccc","summaryId":"snapshot_01M2FZ3XCQ0H1EC3FD81SRQ4CV","createdAt":"2026-09-14T12:43:49.484Z"}],"turnP…` | passed |
| `S6E-INSPECTOR-04` | `inspector`：failure and retry state are visible, and a Conversation without compactions reports none | `{"guardTasks":[{"status":"failed","attempts":2,"failureCode":"COMPACTION_RETRIES_EXHAUSTED"},{"status":"retry-pending","attempts":1,"failureCode":"COMPACTION_SUMMARY_INVALID"}],"guardAdoptions":0,"emptyTasks":0,"emptyPolicies":0,"emptyAdoptions":0}` | `{"guardTasks":[{"status":"failed","attempts":2,"failureCode":"COMPACTION_RETRIES_EXHAUSTED"},{"status":"retry-pending","attempts":1,"failureCode":"COMPACTION_SUMMARY_INVALID"}],"guardAdoptions":0,"emp…` | passed |

The production router is mounted and reached over real HTTP. The read surface answers all four questions from durable rows: why it triggered (the recorded historyTokens is above triggerRatio x historyBudgetTokens), under which policy (lite-v1 with all six parameters plus the fallback application budget and the estimator version), who adopted it (the adoption names the snapshot and the real Turn whose durable row points at that same snapshot, and the adopted summaryId is the published row), and what happened on failure (the refused Conversation shows attempts plus COMPACTION_SUMMARY_INVALID and COMPACTION_RETRIES_EXHAUSTED). A Conversation with no compaction reports empty tasks, policies and adoptions instead of borrowing another Conversation's state.

未证明的相邻行为：It proves the read surface for the states this harness produced. It does not render the UI, and it does not exercise a compaction whose source range was rejected as stale (that state is durable and readable through the same projection, but is not asserted here).

## `LITE-09-109`

matrix 原文为 `仅复用现有Message修订/可见性校验摘要来源`，matrix section 为 `user clarification; existing edits`；冻结条款来源 `docs/implementation/lite-closeout/S6-compaction-authorization.md:42`，并引用：

- `docs/implementation/lite-closeout/S6-compaction-authorization.md:45` — 历史已发布摘要与快照不被重写
- `apps/server/src/services/ConversationTurnDriver.ts:1` — 来源校验复用既有 Message 修订与可见性，不新增编辑能力

- matrix 状态：`GAP`（workPackage `S6`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：不新增编辑API/UI/versioning；实际内容变化或不可见使旧摘要不能进入新context，历史快照不变。
- 原始记录缺口（matrix `finding`）：editMessage及cr_message_revisions已有；无压缩source校验。
- 生产入口（matrix `implementation`）：`apps/server/src/store/ConversationRepository.ts`
- 关联测试（matrix `tests`）：`apps/server/src/store/ConversationRepository.test.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S6E-STALE-01` | `stale`：a summary whose covered Message was edited is refused | `{"kind":"stale-source","reason":"source-content-changed"}` | `{"kind":"stale-source","reason":"source-content-changed"}` | passed |

After a covered Message is edited, the production apply function refuses to reuse the old summary and reports kind=stale-source with reason=source-content-changed instead of building a new context from a summary whose source no longer matches. The slice adds no edit API, no edit UI and no Message Versioning: this branch only reuses the existing revision semantics.

未证明的相邻行为：Covers the content-changed invalidation path. The visibility (soft-deleted / no-longer-in-context) branch is covered by the existing unit tests and is not replayed against a real Provider here.

## `LITE-09-110`

matrix 原文为 `Provider-native compaction不得作为canonical evidence`，matrix section 为 `user clarification; 01 §7`；冻结条款来源 `docs/implementation/lite-closeout/S6-compaction-authorization.md:11`，并引用：

- `docs/Runtime-Specification lite/03-Event-Model.md:478` — Compaction 可用 Artifact 与序列区间替换高流量流细节
- `docs/implementation/lite-closeout/S6-compaction-authorization.md:12` — 永不把 Provider native compaction 当作 canonical evidence

- matrix 状态：`GAP`（workPackage `S6`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：只采用AgentOS持久summary/source/policy/budget/snapshot，native事件不发布canonical摘要或候选。
- 原始记录缺口（matrix `finding`）：新AgentOS压缩尚未实现，必须明确native诊断边界。
- 生产入口（matrix `implementation`）：`packages/agent-core/src/conversationRunner.ts`
- 关联测试（matrix `tests`）：未记录

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S6E-REAL-12` | `real`：only the AgentOS-persisted summary is canonical | `{"persistedSummaries":1,"matchesTask":true,"nativeRows":0}` | `{"persistedSummaries":1,"matchesTask":true,"nativeRows":0}` | passed |

The canonical store is asserted to hold exactly one compaction summary row with a non-null summary, identical to the summary on the published task, and zero rows whose provider_type is native: AgentOS trusts only the Summary, source range, policy, budget and snapshot it persisted itself, and no Provider-internal compaction can appear as a canonical record.

未证明的相邻行为：This is a disproving assertion over AgentOS authoritative storage (native row count 0 plus a single AgentOS-persisted summary). It does not inspect whether a Provider process compacted its own context internally.

## `LITE-07-105`

matrix 原文为 `Conversation compaction 来源触发`，matrix section 为 `§7; user-approved compaction`；冻结条款来源 `docs/implementation/lite-closeout/S6-compaction-authorization.md:33`，并引用：

- `docs/Runtime-Specification lite/07-Memory-Runtime.md:174` — Conversation compaction 是规范的 canonical Memory 来源之一
- `docs/implementation/lite-closeout/S6-compaction-authorization.md:36` — Candidate 永不自动接受

- matrix 状态：`GAP`（workPackage `S6`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：来源记录、完成摘要、候选与事件原子提交，review-required；摘要可用性不等于Memory审核。
- 原始记录缺口（matrix `finding`）：无canonical compaction任务、摘要、策略或生产调用链。
- 生产入口（matrix `implementation`）：`apps/server/src/services/ConversationTurnDriver.ts`
- 关联测试（matrix `tests`）：`apps/server/src/services/ConversationTurnDriver.test.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S6E-REAL-01` | `real`：a real Provider compaction publishes a durable task | `"published"` | `"published"` | passed |
| `S6E-REAL-07` | `real`：publishing records a review-required agent-derived Candidate | `{"decision":"review-required","outcome":"review-required","authority":"agent-derived","scope":"conversation"}` | `{"decision":"review-required","outcome":"review-required","authority":"agent-derived","scope":"conversation"}` | passed |
| `S6E-REAL-08` | `real`：the fact and its canonical Workspace Event are one causal record | `{"type":"memory.candidate_created","causationId":"snapshot_01M2FZ3XCQ0H1EC3FD81SRQ4CV","payloadCandidateMatches":true}` | `{"type":"memory.candidate_created","causationId":"snapshot_01M2FZ3XCQ0H1EC3FD81SRQ4CV","payloadCandidateMatches":true}` | passed |
| `S6E-REAL-09` | `real`：a repeat over the same source converges without a second fact | `{"outcome":"published","sameTask":true,"tasks":1}` | `{"outcome":"published","sameTask":true,"tasks":1}` | passed |
| `S6E-REAL-15` | `real`：publishing a summary does not create a Memory Entry: availability is not approval | `{"memoryEntries":0,"candidateDecision":"review-required","candidateOutcome":"review-required"}` | `{"memoryEntries":0,"candidateDecision":"review-required","candidateOutcome":"review-required"}` | passed |
| `S6E-GUARD-06` | `guard`：a refused summary leaves no Candidate, no published row and no canonical Event behind | `{"guardCandidates":0,"guardPublished":false,"guardTasksWithSummary":0,"compactionEvents":1}` | `{"guardCandidates":0,"guardPublished":false,"guardTasksWithSummary":0,"compactionEvents":1}` | passed |
| `S6E-DB-04` | `durable`：one published summary per Conversation source: a second publish of the same source is refused | `{"indexIsUnique":true,"scopedToPublished":true,"refusedByUnique":true,"publishedRowsInConversation":1}` | `{"indexIsUnique":true,"scopedToPublished":true,"refusedByUnique":true,"publishedRowsInConversation":1}` | passed |

The evidence walks the production trigger itself: a real Provider summary, a durable published task, a review-required / agent-derived / conversation-scoped Memory Candidate keyed to that task, and the canonical memory.candidate_created Workspace Event whose causation_id is the task id and whose payload names that Candidate. Re-evaluating the same source converges to the same task with a single fact row, and the refused-summary path leaves zero Candidate, no published row and no second Event behind.

未证明的相邻行为：Proves Candidate creation, its causal Event, and that availability is not approval (the published Candidate stays review-required and zero Memory Entries exist afterwards). It does not prove the later human review decision (a separate S3 row) and does not prove the Candidate became long-term Memory. Recorded adjacent behaviour: a repeated evaluation of a failed attempt leaves two retry-pending task rows, while the bounded quantities (running holder 0, published facts 0) remain correct.

## targeted tests 与 scope verifier

受影响测试（9 个 S6 文件，`node --import tsx --test --test-concurrency=1`，在 `apps/server` 下执行）raw exit = 0，Node summary 为 `51 pass / 0 fail / 0 skipped / 0 cancelled / 0 todo`；普通 scope verifier 未加 `--require-closed`，raw exit = 0，stdout 原文为 `{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}`。

## 已知限制与运行历史

- 本轮证据工作发现并修复了一个真实缺陷：`ConversationCompactionService.compact()` 每次评估都新建 `attempt: 1` 的任务，因此 `COMPACTION_RETRIES_EXHAUSTED` 分支在生产路径上不可达，自动重试没有上界（每次 Turn 都会再启动一次 Provider 摘要调用）。原单测只能手工 claim/fail 来模拟该分支。修复后自动评估复用同一 durable attempt 并在 `maxAutomaticRetries` 处停止，只有显式重试才会开始新尝试。
- 修复的单元测试证据：`ConversationCompactionService.test.ts` → “the automatic retry chain is bounded, and only an explicit retry spends a new attempt”（生产路径，断言 1 → 2 → 停止 → 显式重试新链）与 `ConversationCompactionTrigger.test.ts` → “S6 trigger spends a new attempt only for an explicit retry”（mode 传递）。本 harness 的 `S6E-GUARD-04/07/08` 在真实 store 上观测到同一行为（summarizer 调用 1 → 2 → 2 → 3）。
- HTTP 阶段是本 harness 唯一打开 socket 的阶段；它在关闭前销毁自己建立的连接并按正常路径退出，以便 `exit.txt` 记录真实的 raw exit code（此前 `process.exit` 与刚关闭的 server 竞态会在 Windows 触发 libuv 断言，产生不可用的退出码）。
- 本目录的 receipts/stdout/stderr 是当前断言集（39 条）的运行结果；同一路径上更早的运行（21 条、24 条、33 条、36 条断言）被覆盖而未单独归档。这些早期断言集是当前断言集的真子集，harness 已随本分支提交，可原样重放。
- `ProviderCompactionSummarizer` 的失败语义由单元测试覆盖（非零退出码、硬超时、空/超长摘要拒绝），真实链路只重放了成功发布；真实 Provider 失败注入未执行。
- 本轮没有对 kimi / opencode 取得真实摘要证据：它们没有 allowlist profile，按 fail-closed 处理。
- 证据只覆盖被点到编号的行为，没有把任何 skipped、缺日志或失败项折算为通过。

## 矩阵保护

生成前后未修改 `pass-freeze.json` / `matrix.json` / `pass-evidence-audit.json`，未执行任何 promotion 脚本，未执行 `--require-closed`。与 baseline blob 的 SHA-256 对比：

| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |
| --- | --- | --- | --- |
| `docs/implementation/lite-closeout/matrix.json` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | true |
| `docs/implementation/lite-closeout/pass-freeze.json` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | true |
| `docs/implementation/lite-closeout/pass-evidence-audit.json` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | true |

矩阵仍为 v15、`status=frozen`、PASS=0、GAP=26、RUNTIME-VERIFY=205、DEFERRED=164：这九个 requirement 保持 `GAP`，verdict 只是候选证据。

工作区 delta（`git status --porcelain=v1`）：

```text
 M agentos/apps/server/src/routes/conversationRuntime.ts
 M agentos/apps/server/src/services/ConversationCompactionService.test.ts
 M agentos/apps/server/src/services/ConversationCompactionService.ts
 M agentos/apps/server/src/services/ConversationCompactionTrigger.test.ts
 M agentos/apps/server/src/services/ConversationCompactionTrigger.ts
 M agentos/apps/server/src/store/CompactionRepository.ts
 M agentos/docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/receipts.json
 M agentos/docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/stdout.txt
 M agentos/docs/implementation/lite-closeout/evidence/s6-candidate-evidence-20260914/targeted-tests/targeted.stdout.txt
 M agentos/scripts/assemble-lite-s6-candidate-evidence.mjs
 M agentos/scripts/verify-lite-s6-candidate-evidence.mjs
```

