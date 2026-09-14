# S1 检索预算与资格候选证据包（LITE-07-007 / LITE-07-109）

本报告只记录候选证据，不能直接改变验收矩阵状态。两个 requirement 的 verdict 只能取 `candidate-supported`、`insufficient-evidence` 或 `failed`；本轮没有执行 PASS 提升，也没有执行 `--require-closed`。

- baseline SHA：`d89137ccbf72ef75faca8c807de61fb972f356ff`
- 机器可读包：`docs/implementation/lite-closeout/S1-budget-candidate-evidence.json`
- 模型口径：**预算与资格路径不调用任何 Provider 模型**。
- 矩阵记录的两个条目仍为 `GAP`；本轮只提供候选证据，矩阵状态未改动。

| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |
| --- | --- | --- | --- | ---: |
| `LITE-07-007` | `token, count, Scope, category, and diversity budgets` | `candidate-supported` | 7 total / 7 passed / 0 failed / 0 skipped | 0 |
| `LITE-07-109` | `有效期、敏感度、FTS降级及预算策略符合规范` | `candidate-supported` | 2 total / 2 passed / 0 failed / 0 skipped | 0 |

## 最终执行记录

```powershell
node --import tsx ../../scripts/verify-lite-s1-budget-candidate-evidence.mjs --out E:\workspace\Multi-Agent-worktrees\agentos-lite-s67-evidence\agentos\docs\implementation\lite-closeout\evidence\s1-budget-candidate-evidence-20260914
```

raw exit = `0`；receipts 统计 `9 total / 9 passed / 0 failed / 0 skipped`。

| 日志 / 收据 | bytes | SHA-256 |
| --- | ---: | --- |
| `docs/implementation/lite-closeout/evidence/s1-budget-candidate-evidence-20260914/receipts.json` | 7023 | `a9d028bb68a78612723ddcc28de0ddfd89f9c1d3a6fcb557a196303802c2dd5b` |
| `docs/implementation/lite-closeout/evidence/s1-budget-candidate-evidence-20260914/stdout.txt` | 68 | `f815ee3fd5343a76c7cbafb367287a7f7b201e5f60feec25a534e9ad18d0d83b` |
| `docs/implementation/lite-closeout/evidence/s1-budget-candidate-evidence-20260914/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s1-budget-candidate-evidence-20260914/exit.txt` | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| `docs/implementation/lite-closeout/evidence/s1-budget-candidate-evidence-20260914/scope-verifier.stdout.txt` | 93 | `c412198c0b3a31ba0bce0ce7a3d661de904524bc7082edd140be153a9d2eb5b1` |
| `docs/implementation/lite-closeout/evidence/s1-budget-candidate-evidence-20260914/scope-verifier.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s1-budget-candidate-evidence-20260914/targeted-tests/targeted.stdout.txt` | 2108 | `49a1beb2885daef5d26804d5dac70ac594400b7779cd76dbc4a0e0b279b58f16` |
| `docs/implementation/lite-closeout/evidence/s1-budget-candidate-evidence-20260914/targeted-tests/targeted.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

## `LITE-07-007`

matrix 原文为 `token, count, Scope, category, and diversity budgets`；条款来源 `apps/server/src/services/MemoryContextBudgetSelector.ts:188`，并引用：

- `apps/server/src/services/MemoryContextBudgetSelector.ts:86` — 定价使用实际注入文本（### title + content），不是存储的 tokenEstimate
- `apps/server/src/services/MemoryContextBudgetSelector.ts:208` — per-Scope 限制归因为 scope-excluded，per-category 归因为 category-budget
- `apps/server/src/services/MemoryContextBudgetSelector.ts:245` — diversity 两趟：先每个 category 一条，再按 rank 填空，失败归因 diversity-limit

- matrix 状态：`GAP`（workPackage `S1`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：验证本条完整行为，记录可复现命令、结果及适用的实际调用证据。
- 原始记录缺口（matrix `finding`）：applyBudget未读取requireDiversity；只累计Entry tokenEstimate而非实际heading+content；scope限制误报category-budget，truncated分支实际是整条排除。
- 生产入口（matrix `implementation`）：`apps/server/src/services/MemoryRetrievalService.ts`、`apps/server/src/store/MemoryEntryRepository.ts`、`apps/server/src/services/MemoryContextBudgetSelector.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S1E-PRICING-01` | `budget`：an Entry is priced by the text that is actually injected, not by its stored estimate | `{"injectedText":"### short\ntiny","longInjectedTokens":124,"shortInjectedTokens":4,"storedEstimates":{"long":1,"short":9999},"selected":["mem_short"],"totalTokens":4,"reasons":{"mem_long":"token-budget"}}` | `{"injectedText":"### short\ntiny","longInjectedTokens":124,"shortInjectedTokens":4,"storedEstimates":{"long":1,"short":9999},"selected":["mem_short"],"totalTokens":4,"reasons":{"mem_long":"token-budge…` | passed |
| `S1E-THRESHOLD-01` | `budget`：confidence and importance thresholds exclude with their own reason | `{"selected":["mem_ok"],"reasons":{"mem_low_confidence":"below-confidence","mem_low_importance":"below-importance"}}` | `{"selected":["mem_ok"],"reasons":{"mem_low_confidence":"below-confidence","mem_low_importance":"below-importance"}}` | passed |
| `S1E-COUNT-01` | `budget`：the Entry count budget excludes the overflow and records every considered Entry | `{"selected":["mem_a","mem_b"],"reasons":{"mem_c":"entry-budget"},"considered":3}` | `{"selected":["mem_a","mem_b"],"reasons":{"mem_c":"entry-budget"},"considered":3}` | passed |
| `S1E-SCOPE-01` | `budget`：a per-Scope limit is attributed to the Scope, not to the category | `{"selected":["mem_task_1","mem_workspace"],"reasons":{"mem_task_2":"scope-excluded"}}` | `{"selected":["mem_task_1","mem_workspace"],"reasons":{"mem_task_2":"scope-excluded"}}` | passed |
| `S1E-CATEGORY-01` | `budget`：a per-category limit is attributed to the category | `{"selected":["mem_decision_1","mem_knowledge"],"reasons":{"mem_decision_2":"category-budget"}}` | `{"selected":["mem_decision_1","mem_knowledge"],"reasons":{"mem_decision_2":"category-budget"}}` | passed |
| `S1E-DIVERSITY-01` | `budget`：requireDiversity keeps the set from being monopolized and explains the exclusion | `{"selected":["mem_decision_1","mem_knowledge_1"],"reasons":{"mem_decision_2":"diversity-limit","mem_knowledge_2":"entry-budget"}}` | `{"selected":["mem_decision_1","mem_knowledge_1"],"reasons":{"mem_decision_2":"diversity-limit","mem_knowledge_2":"entry-budget"}}` | passed |
| `S1E-TRUNC-01` | `budget`：token-budget overflow is truncated explicitly and bounded, never silently | `{"selected":["mem_t1"],"reasons":{"mem_t2":"truncated","mem_t3":"token-budget"},"truncated":true,"totalTokens":7,"perEntryTokens":7,"budgetTokens":13}` | `{"selected":["mem_t1"],"reasons":{"mem_t2":"truncated","mem_t3":"token-budget"},"truncated":true,"totalTokens":7,"perEntryTokens":7,"budgetTokens":13}` | passed |

The five dimensions are exercised on the production applyBudget: an Entry whose stored tokenEstimate is deliberately wrong is priced by the text that is actually injected (a 124-token Entry is excluded while a 4-token Entry is selected, and totalTokens equals the contract formula); confidence and importance thresholds attribute below-confidence / below-importance; maxEntries excludes the overflow as entry-budget and every considered Entry is recorded; a per-Scope limit is attributed to scope-excluded rather than mislabelled as a category limit; a per-category limit is category-budget; requireDiversity keeps two same-category Entries from monopolizing the set (the deferred one explains itself as diversity-limit) while the second category is admitted; and token overflow is truncated explicitly and bounded, with the entry after the truncation budget reported as token-budget.

未证明的相邻行为：This is the budget function itself, called with ranked fixtures: it proves the decision and attribution rules, not retrieval ranking quality. The matrix row's recorded gaps (ignored requireDiversity, stored-estimate pricing, mis-attributed Scope limits) are closed by commit acecf93c on this baseline, which the assertions above verify; snapshot persistence and reproducibility are covered by the selector suite in the targeted tests rather than re-asserted here.

## `LITE-07-109`

matrix 原文为 `有效期、敏感度、FTS降级及预算策略符合规范`；条款来源 `apps/server/src/services/MemoryRetrievalService.ts:81`，并引用：

- `apps/server/src/services/MemoryRetrievalService.ts:100` — 可注入 clock，证据用固定时钟
- `apps/server/src/services/MemoryRetrievalService.ts:74` — toSafeFtsQuery 把查询中和为 token；无可用 token 时报告 degraded

- matrix 状态：`GAP`（workPackage `S1`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：固定时钟下验证有效期和敏感度，显式降级与真实快照理由，不重构无关排名。
- 原始记录缺口（matrix `finding`）：retrieveWithStatus和listRetrievalCandidates无validFrom/validUntil/expiresAt/sensitivity过滤，使用Date.now而非可固定时钟。 S1-C1已过滤有效期/敏感度并取得新快照证据；FTS降级与预算解释尚未闭合，不标PASS。
- 生产入口（matrix `implementation`）：`apps/server/src/services/MemoryRetrievalService.ts`、`apps/server/src/store/MemoryEntryRepository.ts`、`apps/server/src/services/MemoryContextBudgetSelector.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S1E-ELIGIBILITY-01` | `eligibility`：temporal and access eligibility decide before ranking | `{"now":"2026-09-14T00:00:00.000Z","returned":["mem_001eeeeeeeeeeeeeeeeeeee","mem_002eeeeeeeeeeeeeeeeeeee","mem_006eeeeeeeeeeeeeeeeeeee"],"degraded":false,"excludedIdsPresent":[]}` | `{"now":"2026-09-14T00:00:00.000Z","returned":["mem_001eeeeeeeeeeeeeeeeeeee","mem_002eeeeeeeeeeeeeeeeeeee","mem_006eeeeeeeeeeeeeeeeeeee"],"degraded":false,"excludedIdsPresent":[]}` | passed |
| `S1E-DEGRADED-01` | `eligibility`：a query with no usable FTS tokens reports degraded while structured filters stay authoritative | `{"degraded":true,"rankedResults":["mem_001eeeeeeeeeeeeeeeeeeee","mem_002eeeeeeeeeeeeeeeeeeee","mem_006eeeeeeeeeeeeeeeeeeee"],"sameSetAsRankedQuery":true,"queryTextStored":0}` | `{"degraded":true,"rankedResults":["mem_001eeeeeeeeeeeeeeeeeeee","mem_002eeeeeeeeeeeeeeeeeeee","mem_006eeeeeeeeeeeeeeeeeeee"],"sameSetAsRankedQuery":true,"queryTextStored":0}` | passed |

Real memory_entries rows are written through the production repository and read back through the production retrieval service with a FIXED clock: an Entry inside its validity window and one without a window are returned, while an expired Entry, a not-yet-valid Entry and a restricted-sensitivity Entry are all withheld (none of them appears in the result set). The FTS-degraded status is visible rather than silent: a query with no usable tokens reports degraded=true while the structured-filter result set stays exactly the same as the ranked query, and no snapshot or query text is written by the read.

未证明的相邻行为：Covers temporal and access eligibility plus the degraded-status signal for this baseline. The Run Context Snapshot projection of the degraded mode (LITE-07-013) is delivered by the separate FTS-degraded slice and is not re-asserted here; sensitivity is proven as a withheld-content rule, not as a grant mechanism, because the current callers have no verified restricted-content grant.

## targeted tests 与 scope verifier

受影响测试（2 个文件，`node --import tsx --test --test-concurrency=1`，在 `apps/server` 下执行）raw exit = 0，Node summary 为 `31 pass / 0 fail / 0 skipped / 0 cancelled / 0 todo`；普通 scope verifier 未加 `--require-closed`，raw exit = 0，stdout 原文为 `{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}`。

## 矩阵保护

生成前后未修改 `pass-freeze.json` / `matrix.json` / `pass-evidence-audit.json`，未执行任何 promotion 脚本，也未执行 `--require-closed`。与 baseline blob 的 SHA-256 对比：

| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |
| --- | --- | --- | --- |
| `docs/implementation/lite-closeout/matrix.json` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | true |
| `docs/implementation/lite-closeout/pass-freeze.json` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | true |
| `docs/implementation/lite-closeout/pass-evidence-audit.json` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | true |

工作区 delta（`git status --porcelain=v1`）：

```text
?? agentos/docs/implementation/lite-closeout/evidence/s1-budget-candidate-evidence-20260914/
?? agentos/scripts/assemble-lite-s1-budget-candidate-evidence.mjs
?? agentos/scripts/verify-lite-s1-budget-candidate-evidence.mjs
```

