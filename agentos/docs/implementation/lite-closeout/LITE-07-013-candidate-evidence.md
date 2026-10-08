# S1 FTS 降级可见性候选证据包（LITE-07-013）

本报告只记录候选证据，不能直接改变验收矩阵状态。1 个 requirement 的 verdict 只能取 `candidate-supported`、`insufficient-evidence` 或 `failed`；本轮没有执行 PASS 提升，也没有执行 `--require-closed`。

- baseline SHA：`b32e7c0491c61c348b5127154817e4ef6f837377`
- 机器可读包：`docs/implementation/lite-closeout/LITE-07-013-candidate-evidence.json`
- 模型口径：本包不调用任何 Provider 模型：证据绑定 AgentOS 自身的检索、快照与事件契约。
- 这些 requirement 的矩阵状态在本轮保持 `GAP`，verdict 只是候选证据。

| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |
| --- | --- | --- | --- | ---: |
| `LITE-07-013` | `visible FTS degraded mode` | `candidate-supported` | 3 total / 3 passed / 0 failed / 0 skipped | 0 |

## 最终执行记录

```powershell
node --import tsx ../../scripts/verify-lite-07-013-candidate-evidence.mjs --out E:\workspace\Multi-Agent-worktrees\agentos-lite-runtime-verify\agentos\docs\implementation\lite-closeout\evidence\s0713-candidate-evidence-20260914
```

raw exit = `0`；receipts 统计 `3 total / 3 passed / 0 failed / 0 skipped`。

| 日志 / 收据 | bytes | SHA-256 |
| --- | ---: | --- |
| `docs/implementation/lite-closeout/evidence/s0713-candidate-evidence-20260914/receipts.json` | 2778 | `165c987dfe18bf35cc30dcba720e8f7255a993b89f9967eb13d85322099dac52` |
| `docs/implementation/lite-closeout/evidence/s0713-candidate-evidence-20260914/stdout.txt` | 64 | `7e75ff81c764c85be2347db65ce03275a863e870e173844fdcb97278352c7c72` |
| `docs/implementation/lite-closeout/evidence/s0713-candidate-evidence-20260914/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s0713-candidate-evidence-20260914/exit.txt` | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| `docs/implementation/lite-closeout/evidence/s0713-candidate-evidence-20260914/scope-verifier.stdout.txt` | 93 | `c412198c0b3a31ba0bce0ce7a3d661de904524bc7082edd140be153a9d2eb5b1` |
| `docs/implementation/lite-closeout/evidence/s0713-candidate-evidence-20260914/scope-verifier.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s0713-candidate-evidence-20260914/targeted-tests/targeted.stdout.txt` | 3012 | `f705ab936f4064e3c71f9b810a5e60e18b541e1175ae5877895827f16c8888bc` |
| `docs/implementation/lite-closeout/evidence/s0713-candidate-evidence-20260914/targeted-tests/targeted.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

### 被驱动的 gate 调用

```json
{}
```

## `LITE-07-013`

matrix 原文为 `visible FTS degraded mode`；条款来源 `apps/server/src/services/MemoryContextBudgetSelector.ts:128`，并引用：

- `apps/server/src/store/MemoryContextSnapshotRepository.ts:48` — 快照持久化 retrieval_degraded 并在读回时还原
- `apps/server/src/migrations/migrations/031-mf5-retrieval-degraded.ts:16` — 031 增量加列，默认 0
- `apps/server/src/services/MemoryRetrievalService.ts:61` — degraded 语义：提供了查询但 FTS 排名未应用

- matrix 状态：`GAP`（workPackage `S1`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：验证本条完整行为，记录可复现命令、结果及适用的实际调用证据。
- 原始记录缺口（matrix `finding`）：selector.plan调用retrieve丢弃retrieveWithStatus.degraded；真实Context路径未保留降级说明。
- 生产入口（matrix `implementation`）：`apps/server/src/services/MemoryRetrievalService.ts`、`apps/server/src/store/MemoryEntryRepository.ts`、`apps/server/src/services/MemoryContextBudgetSelector.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S0713-RESOLVE-01` | `resolved`：the real Run context path records whether its retrieval ran degraded, per snapshot | `{"rankedSelectsEntry":true,"rankedSnapshotFlag":false,"rankedDurableColumn":0,"degradedSelectsEntry":true,"degradedSnapshotFlag":true,"degradedDurableColumn":1,"snapshotsDiffer":true,"sameSelectionEitherWay":true}` | `{"rankedSelectsEntry":true,"rankedSnapshotFlag":false,"rankedDurableColumn":0,"degradedSelectsEntry":true,"degradedSnapshotFlag":true,"degradedDurableColumn":1,"snapshotsDiffer":true,"sameSelectionEit…` | passed |
| `S0713-RESOLVE-02` | `resolved`：the flag survives the production read path and the injected text is unaffected by it | `{"degradedReadBack":true,"rankedReadBack":false,"degradedContextMatchesItsOwnSelection":true,"contextTextEqualsPersisted":true,"eventsWritten":2,"outboxMatchesEvents":true}` | `{"degradedReadBack":true,"rankedReadBack":false,"degradedContextMatchesItsOwnSelection":true,"contextTextEqualsPersisted":true,"eventsWritten":2,"outboxMatchesEvents":true}` | passed |
| `S0713-DEFAULT-01` | `default`：the stored flag is a non-null boolean column defaulting to the non-degraded value | `{"column":{"name":"retrieval_degraded","type":"INTEGER","notNull":1,"defaultValue":"0"},"nonDegradedRows":1,"totalSnapshots":2}` | `{"column":{"name":"retrieval_degraded","type":"INTEGER","notNull":1,"defaultValue":"0"},"nonDegradedRows":1,"totalSnapshots":2}` | passed |

两次真实的 Run 上下文解析都走生产 resolver + 生产 emitter（快照、canonical `memory.context_created` 事件与 Outbox 同事务提交）：带真实查询的一次快照 `retrievalDegraded=false`、持久列为 0；查询被中和（无可用 FTS token）的一次 `retrievalDegraded=true`、持久列为 1；两次的选中集合完全相同（降级只改排名来源，不改结构化选择），且注入文本仍等于该快照自身持久化的文本。生产读回路径（findById）还原出的标志与写入一致（true/false），两次解析共产生 2 条 canonical 事件且 Outbox 行数与事件数相等。列本身是 NOT NULL DEFAULT 0 的 INTEGER，因此 031 之前的快照行读作非降级。

未证明的相邻行为：证明降级模式在真实 Run 上下文路径上可见、可读回、且不影响注入内容；FTS5 整体不可用的分支与 UI 展示不在本包。

## targeted tests 与 scope verifier

受影响测试（4 个文件：MemoryContextBudgetSelector / MemoryRetrievalService / lite-migration-031 / MemoryContextSnapshotRepository，`node --import tsx --test --test-concurrency=1`，在 `apps/server` 下执行）raw exit = 0，Node summary 为 `44 pass / 0 fail / 0 skipped`；普通 scope verifier 未加 `--require-closed`，raw exit = 0，stdout 原文为 `{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}`。

- 两次解析的差异只在查询：`***` 会被 toSafeFtsQuery 中和为无可用 token，因此检索服务如实报告 degraded；FTS5 表整体不可用（另一种降级来源）未在本包重放。
- `api_operation` 之外的 origin 不在本包：这里用持久 Operation 行证明 privileged origin（与 Run 路径一致）。
- 本包证明降级标志在 Run Context Snapshot 上可见、可读回、且不改变选中集合；它不证明 UI 展示（Inspector/前端渲染不在本行范围）。

## 矩阵保护

生成前后未修改 `pass-freeze.json` / `matrix.json` / `pass-evidence-audit.json`，未执行任何 promotion 脚本，也未执行 `--require-closed`。与 baseline blob 的 SHA-256 对比：

| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |
| --- | --- | --- | --- |
| `docs/implementation/lite-closeout/matrix.json` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | true |
| `docs/implementation/lite-closeout/pass-freeze.json` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | true |
| `docs/implementation/lite-closeout/pass-evidence-audit.json` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | true |

工作区 delta（`git status --porcelain=v1`）：

```text
?? agentos/docs/implementation/lite-closeout/LITE-07-013-candidate-evidence.spec.json
?? agentos/docs/implementation/lite-closeout/evidence/s0713-candidate-evidence-20260914/
?? agentos/scripts/assemble-lite-candidate-evidence.mjs
?? agentos/scripts/verify-lite-07-013-candidate-evidence.mjs
```

