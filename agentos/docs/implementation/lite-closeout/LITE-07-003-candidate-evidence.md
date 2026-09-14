# S1 精确/近似重复收敛候选证据包（LITE-07-003）

本报告只记录候选证据，不能直接改变验收矩阵状态。1 个 requirement 的 verdict 只能取 `candidate-supported`、`insufficient-evidence` 或 `failed`；本轮没有执行 PASS 提升，也没有执行 `--require-closed`。

- baseline SHA：`b32e7c0491c61c348b5127154817e4ef6f837377`
- 机器可读包：`docs/implementation/lite-closeout/LITE-07-003-candidate-evidence.json`
- 模型口径：本包不调用任何 Provider 模型：证据绑定 AgentOS 自身的去重边界、合并事务、审核门槛与来源证明。
- 这些 requirement 的矩阵状态在本轮保持 `GAP`，verdict 只是候选证据。

| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |
| --- | --- | --- | --- | ---: |
| `LITE-07-003` | `exact and near-duplicate convergence` | `candidate-supported` | 9 total / 9 passed / 0 failed / 0 skipped | 0 |

## 最终执行记录

```powershell
node --import tsx ../../scripts/verify-lite-07-003-candidate-evidence.mjs --out E:\workspace\Multi-Agent-worktrees\agentos-lite-runtime-verify\agentos\docs\implementation\lite-closeout\evidence\s003-candidate-evidence-20260914
```

raw exit = `0`；receipts 统计 `9 total / 9 passed / 0 failed / 0 skipped`。

| 日志 / 收据 | bytes | SHA-256 |
| --- | ---: | --- |
| `docs/implementation/lite-closeout/evidence/s003-candidate-evidence-20260914/receipts.json` | 7975 | `e8e484f7acbf7c618a320c4c81dc51fe366edda61b831c45e3782c1c7915e49e` |
| `docs/implementation/lite-closeout/evidence/s003-candidate-evidence-20260914/stdout.txt` | 63 | `3d60ecaa3eb925e7aa2c66f553651bfa5f55fbb60d58b3e81b4bea9c9b0c201f` |
| `docs/implementation/lite-closeout/evidence/s003-candidate-evidence-20260914/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s003-candidate-evidence-20260914/exit.txt` | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| `docs/implementation/lite-closeout/evidence/s003-candidate-evidence-20260914/scope-verifier.stdout.txt` | 93 | `c412198c0b3a31ba0bce0ce7a3d661de904524bc7082edd140be153a9d2eb5b1` |
| `docs/implementation/lite-closeout/evidence/s003-candidate-evidence-20260914/scope-verifier.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s003-candidate-evidence-20260914/targeted-tests/targeted.stdout.txt` | 4240 | `d42d2a7161b14b72107f56ea6e520336c6204c3c2ba91dc3f1274b8e7efd6798` |
| `docs/implementation/lite-closeout/evidence/s003-candidate-evidence-20260914/targeted-tests/targeted.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

### 被驱动的 gate 调用

```json
{}
```

## `LITE-07-003`

matrix 原文为 `exact and near-duplicate convergence`；条款来源 `apps/server/src/services/MemoryCandidateGenerationService.ts:189`，并引用：

- `apps/server/src/services/MemoryCandidateGenerationService.ts:196` — 精确命中 → mergeExactSourcesWithinTransaction / emitEntryDeduplicated
- `apps/server/src/store/MemoryEntryRepository.ts:361` — 合并在同一事务内校验 scope/owner/category/状态与精确哈希
- `apps/server/src/services/MemoryRuntimeEventEmitter.ts:135` — 合并变更才写 canonical memory.entry_deduplicated

- matrix 状态：`GAP`（workPackage `S1`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：同Scope/owner精确重复原子汇聚来源和规范事件；重放零新增；不同owner不错误汇聚，近似重复保留审核。
- 原始记录缺口（matrix `finding`）：精确/normalized hash查找仅限Workspace，未过滤status或Scope/owner；终态精确命中直接返回并丢弃新来源。见MemoryCandidateRepository.ts:617-637、MemoryCandidateGenerationService.ts:163-170。 S1-A终态与S1-D显式save的精确匹配补缺已有独立提交证据；近似重复审核、review promotion与来源真实性仍待闭合，状态保持GAP。
- 生产入口（matrix `implementation`）：`apps/server/src/services/MemoryCandidateGenerationService.ts`、`apps/server/src/routes/memoryRuntime.ts`、`apps/server/src/store/MemoryEntryRepository.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S003-EXACT-01` | `exact`：an exact duplicate converges on the accepted Entry and merges the new source atomically | `{"outcome":"converged","duplicateOfEntryIdMatches":true,"entrySources":["run:run_lite07003","task:task_lite07003"],"entryVersion":2,"contentUnchanged":true,"candidatesAdded":0,"entriesAdded":0,"entrySourcesAdded":1,"dedupEventsAdded":1,"dedupEventNameTheEntry":true}` | `{"outcome":"converged","duplicateOfEntryIdMatches":true,"entrySources":["run:run_lite07003","task:task_lite07003"],"entryVersion":2,"contentUnchanged":true,"candidatesAdded":0,"entriesAdded":0,"entryS…` | passed |
| `S003-EXACT-02` | `exact`：a replay of the same evaluation writes nothing further | `{"outcome":"converged","duplicateOfEntryIdMatches":true,"candidatesAdded":0,"entriesAdded":0,"sourcesAdded":0,"dedupEventsAdded":0,"entryVersion":2}` | `{"outcome":"converged","duplicateOfEntryIdMatches":true,"candidatesAdded":0,"entriesAdded":0,"sourcesAdded":0,"dedupEventsAdded":0,"entryVersion":2}` | passed |
| `S003-OWNER-01` | `owner`：identical content under a different owner does not converge | `{"outcome":"created","duplicateOfEntryId":null,"newCandidateId":"mcand_terminal_run_owner_07003","newCandidateCategory":"summary","otherOwnerEntryUnchanged":["task:task_other_07003"],"otherOwnerEntryContentUnchanged":true,"candidatesAdded":1}` | `{"outcome":"created","duplicateOfEntryId":null,"newCandidateId":"mcand_terminal_run_owner_07003","newCandidateCategory":"summary","otherOwnerEntryUnchanged":["task:task_other_07003"],"otherOwnerEntryC…` | passed |
| `S003-NEAR-01` | `near`：a normalized-hash near-duplicate is recorded as a review-required fact, never auto-accepted | `{"outcome":"created","duplicateOfEntryId":"mem_07003_normalized","candidateOutcome":"review-required","candidateDecision":"review-required","candidateAuthority":"agent-derived","promotedIntoEntry":null,"nearEntryStillIntact":true,"entriesAfter":3}` | `{"outcome":"created","duplicateOfEntryId":"mem_07003_normalized","candidateOutcome":"review-required","candidateDecision":"review-required","candidateAuthority":"agent-derived","promotedIntoEntry":nul…` | passed |
| `S003-NEAR-02` | `near`：an FTS-similar near-duplicate is likewise held for review | `{"outcome":"created","duplicateOfEntryId":"mem_07003_fts","candidateOutcome":"review-required","promotedIntoEntry":null}` | `{"outcome":"created","duplicateOfEntryId":"mem_07003_fts","candidateOutcome":"review-required","promotedIntoEntry":null}` | passed |
| `S003-REVIEW-01` | `review`：accepting a near-duplicate after review creates the Entry and keeps its sources | `{"outcomeAfterReview":"accept","mergedIntoEntry":true,"entryScope":"task","entryCategory":"summary","entryContentBytes":70,"entrySources":["run:run_fts_07003"]}` | `{"outcomeAfterReview":"accept","mergedIntoEntry":true,"entryScope":"task","entryCategory":"summary","entryContentBytes":70,"entrySources":["run:run_fts_07003"]}` | passed |
| `S003-PROOF-01` | `proof`：a source that names no real Entry is refused by the schema instead of being believed | `{"insertionRefused":true,"refusalCode":"ERR_SQLITE_ERROR","orphanSources":0}` | `{"insertionRefused":true,"refusalCode":"ERR_SQLITE_ERROR","orphanSources":0}` | passed |
| `S003-PROOF-02` | `proof`：a privileged origin without a durable row is refused instead of fabricating causation | `{"refusalCode":"ORIGIN_UNPROVEN"}` | `{"refusalCode":"ORIGIN_UNPROVEN"}` | passed |
| `S003-PROOF-03` | `proof`：the merge refuses when the boundary does not match the stored Entry | `{"mergeOutcome":"refused","entrySourcesAfter":["run:run_lite07003","task:task_lite07003"]}` | `{"mergeOutcome":"refused","entrySourcesAfter":["run:run_lite07003","task:task_lite07003"]}` | passed |

**同 Scope/owner 精确重复**：Memory 中已有同内容事实（task/subject/边界一致、来源是 task）时，生成器返回 `converged` 并指向该 Entry；同一事务把 Run 来源合并进去（来源数 +1、Entry version 1→2、内容与 authority 不变），并写入恰好一条 canonical `memory.entry_deduplicated`（payload 指向该 Entry）；候选与 Entry 数量都不增加。**重放零新增**：再执行一次同样评估仍为 `converged`，候选/Entry/来源/事件四类计数全部为 0 增量，version 不再变化。**不同 owner 不错误汇聚**：另一 task 边界里存在完全同内容的事实，并不阻止本 Run 产生自己的候选（`created`、`duplicateOfEntryId=null`、候选 +1），另一个 owner 的事实不变。**近似重复保留审核**：normalized-hash 命中与 FTS 命中都被记为 `created` + `duplicateOfEntryId` 指向已有 Entry + 候选 `review-required`（`decision=review-required`、`authority=agent-derived`、未自动并入 Entry），既有事实原样保留；经生产审核路径 accept 后才产生 Entry（scope=task、category=summary、内容长度与候选一致、来源随候选带入）。**来源真实性**：把来源指向不存在的 Entry 被数据库拒绝（0 条孤儿来源），没有持久行的特权 origin 被拒（`ORIGIN_UNPROVEN`），且边界不匹配时合并被拒（拒绝后来源保持原样）。

未证明的相邻行为：覆盖精确重复的收敛与来源合并、重放零新增、跨 owner 不汇聚、normalized/FTS 近似重复的审核门槛与审核后提升、以及来源与 origin 的拒绝路径；reject 分支与 FTS5 实体表不可用的组合不在本包。

## targeted tests 与 scope verifier

受影响测试（3 个文件：MemoryCandidateGenerationService / .emission / MemoryCandidateRepository，`node --import tsx --test --test-concurrency=1`，在 `apps/server` 下执行）raw exit = 0，Node summary 为 `51 pass / 0 fail / 0 skipped`；普通 scope verifier 未加 `--require-closed`，raw exit = 0，stdout 原文为 `{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}`。

- 精确命中分支的**进入方式**：Memory 里已存在同内容事实（由另一条来源写入，本包用生产 `MemoryEntryRepository.createEntry` 构造，即 S1-D 显式保存的形态），而承载它的 Candidate 行已不存在——本包删除那一行以复现该状态（与 LITE-07-102 崩溃窗口同一手法，已明示）。被验证的是生成器与合并事务的决策，不是那次删除本身。
- 近似重复用「同一内容仅空白差异」构造 normalized-hash 命中，用「同标题不同正文」构造 FTS 命中；两种构造都在独立的 task/owner 边界内，避免与其它断言互相污染。
- 来源真实性的最强守卫来自数据库外键与特权 origin 证明；本包据此断言「不存在的 Entry 无法被写成来源」「没有持久行的特权 origin 被拒」，没有额外实现新的来源校验。
- 审核分支只覆盖 accept（产生 Entry 并保留来源）；reject 分支由既有测试覆盖，本包未重放。

## 矩阵保护

生成前后未修改 `pass-freeze.json` / `matrix.json` / `pass-evidence-audit.json`，未执行任何 promotion 脚本，也未执行 `--require-closed`。与 baseline blob 的 SHA-256 对比：

| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |
| --- | --- | --- | --- |
| `docs/implementation/lite-closeout/matrix.json` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | true |
| `docs/implementation/lite-closeout/pass-freeze.json` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | true |
| `docs/implementation/lite-closeout/pass-evidence-audit.json` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | true |

工作区 delta（`git status --porcelain=v1`）：

```text
?? agentos/docs/implementation/lite-closeout/LITE-07-003-candidate-evidence.spec.json
?? agentos/docs/implementation/lite-closeout/evidence/s003-candidate-evidence-20260914/
?? agentos/scripts/verify-lite-07-003-candidate-evidence.mjs
```

