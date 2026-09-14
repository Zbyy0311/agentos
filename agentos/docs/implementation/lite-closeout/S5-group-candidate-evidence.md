# S5 群聊执行边界候选证据包（LITE-09-010）

本报告只记录候选证据，不能直接改变验收矩阵状态。1 个 requirement 的 verdict 只能取 `candidate-supported`、`insufficient-evidence` 或 `failed`；本轮没有执行 PASS 提升，也没有执行 `--require-closed`。

- baseline SHA：`b6476e1e4c4c460e4fcab9b2b09c05b9d61d3cc3`
- 机器可读包：`docs/implementation/lite-closeout/S5-group-candidate-evidence.json`
- 模型口径：本包不调用任何 Provider 模型：它驱动生产 GroupTurnDriver + BoundedGroupService（recording runner 记录每个 speaker Turn 的上下文），证明的是含提及解析、串行化、D3 关闭与准入的边界，不是模型输出。
- 这些 requirement 的矩阵状态在本轮保持 `GAP`，verdict 只是候选证据。

| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |
| --- | --- | --- | --- | ---: |
| `LITE-09-010` | `mention, @all, sequential, and parallel-read-only behavior follows admission and Policy` | `candidate-supported` | 7 total / 7 passed / 0 failed / 0 skipped | 0 |

## 最终执行记录

```powershell
node --import tsx ../../scripts/verify-lite-s5-group-candidate-evidence.mjs --out E:\workspace\Multi-Agent-worktrees\agentos-lite-s5-evidence\agentos\docs\implementation\lite-closeout\evidence\s5-group-candidate-evidence-20260914
```

raw exit = `0`；receipts 统计 `7 total / 7 passed / 0 failed / 0 skipped`。

| 日志 / 收据 | bytes | SHA-256 |
| --- | ---: | --- |
| `docs/implementation/lite-closeout/evidence/s5-group-candidate-evidence-20260914/receipts.json` | 11188 | `26dda0fcf18f054ef0923cef5cf7457a4033363addfec1e64da217fb5b13cfe1` |
| `docs/implementation/lite-closeout/evidence/s5-group-candidate-evidence-20260914/stdout.txt` | 67 | `a18866c0a19798b5e6102d7f0321db95d7ca9fcd99327e78979c8d976eef7f24` |
| `docs/implementation/lite-closeout/evidence/s5-group-candidate-evidence-20260914/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s5-group-candidate-evidence-20260914/exit.txt` | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| `docs/implementation/lite-closeout/evidence/s5-group-candidate-evidence-20260914/scope-verifier.stdout.txt` | 93 | `c412198c0b3a31ba0bce0ce7a3d661de904524bc7082edd140be153a9d2eb5b1` |
| `docs/implementation/lite-closeout/evidence/s5-group-candidate-evidence-20260914/scope-verifier.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s5-group-candidate-evidence-20260914/targeted-tests/targeted.stdout.txt` | 8419 | `d25a483cb17b6e2dedf5b41000055e1e970e2e3250329474c4fc689334134696` |
| `docs/implementation/lite-closeout/evidence/s5-group-candidate-evidence-20260914/targeted-tests/targeted.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

### 被驱动的 gate 调用

```json
{}
```

## `LITE-09-010`

matrix 原文为 `mention, @all, sequential, and parallel-read-only behavior follows admission and Policy`；条款来源 `apps/server/src/services/GroupSpeakerResolver.ts:149`，并引用：

- `apps/server/src/services/GroupTurnDriver.ts:21` — D1=B 模板声明顺序、D2=A 合并回复流、D3 关闭（无 parallel-read-only）
- `apps/server/src/services/GroupSpeakerResolver.ts:256` — declaredReadOnly 记录声明，effectiveMutationClass 仍为 modifying
- `apps/server/src/services/GroupTurnDriver.ts:222` — speaker Turn 未 final 即结束走 provider-failed，且不写回复、不动预算

- matrix 状态：`GAP`（workPackage `S5`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：执行前固定有效权限与有界隔离快照，实际Provider输入引用该快照；跨会话/Run竞争及D3关闭有证据。
- 原始记录缺口（matrix `finding`）：Driver把历史交旧Runner；每Agent快照在Provider回复后recordReply才记录，未证明执行前隔离/授权。
- 生产入口（matrix `implementation`）：`apps/server/src/services/GroupTurnDriver.ts`、`apps/server/src/services/ConversationTurnDriver.ts`、`apps/server/src/services/BoundedGroupService.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S5G-MENTION-01` | `plan`：a mention selects exactly the mentioned Agents, in mention order, and reports the rest as skipped | `{"speakers":[{"agentId":"agent_reviewer","source":"mention"},{"agentId":"agent_lead","source":"mention"}],"skipped":[{"agentId":null,"reason":"member-not-active"},{"agentId":"agent_worker","reason":"not-selected-manually"}],"repliesRecorded":[{"agentId":"agent_reviewer","status":"final","hasReply":true},{"agentId":"age…` | `{"speakers":[{"agentId":"agent_reviewer","source":"mention"},{"agentId":"agent_lead","source":"mention"}],"skipped":[{"agentId":null,"reason":"member-not-active"},{"agentId":"agent_worker","reason":"n…` | passed |
| `S5G-MENTION-02` | `plan`：the durable replies carry the serialized speaker order and the hop chain | `{"replyAgents":["agent_reviewer","agent_lead"],"hopOrders":[0,1],"hopChain":[null,"agent_reviewer"],"agentsSawTheirOwnSnapshot":[{"agentId":"agent_reviewer","sawSharedConversationEntry":true,"contextIsFrozenEntry":true},{"agentId":"agent_lead","sawSharedConversationEntry":true,"contextIsFrozenEntry":true}],"replySnapsh…` | `{"replyAgents":["agent_reviewer","agent_lead"],"hopOrders":[0,1],"hopChain":[null,"agent_reviewer"],"agentsSawTheirOwnSnapshot":[{"agentId":"agent_reviewer","sawSharedConversationEntry":true,"contextI…` | passed |
| `S5G-MENTION-03` | `plan`：without a mention only the always-mode member speaks and the mention-only members are reported as not-mentioned | `{"speakers":[{"agentId":"agent_worker","source":"mode"}],"skipped":[{"agentId":"agent_lead","reason":"not-mentioned"},{"agentId":"agent_reviewer","reason":"not-mentioned"},{"agentId":null,"reason":"member-not-active"}],"replies":["agent_worker"]}` | `{"speakers":[{"agentId":"agent_worker","source":"mode"}],"skipped":[{"agentId":"agent_lead","reason":"not-mentioned"},{"agentId":"agent_reviewer","reason":"not-mentioned"},{"agentId":null,"reason":"me…` | passed |
| `S5G-ALL-01` | `members`：the full member set speaks in the delivered order and the walk is serialized end to end | `{"speakerOrder":["agent_lead","agent_worker","agent_reviewer"],"declaredReadOnly":[false],"effectiveMutationClass":["modifying"],"repliesRecorded":["agent_lead","agent_worker","agent_reviewer"],"budgetAfter":{"repliesUsed":3,"repliesRemaining":0,"hopsUsed":2,"hopsRemaining":2,"distinctAgents":3,"agentsRemaining":0},"ma…` | `{"speakerOrder":["agent_lead","agent_worker","agent_reviewer"],"declaredReadOnly":[false],"effectiveMutationClass":["modifying"],"repliesRecorded":["agent_lead","agent_worker","agent_reviewer"],"budge…` | passed |
| `S5G-D3OFF-01` | `d3off`：a parallel-read-only request is recorded as declared but still classified modifying and stays serialized (D3 off) | `{"declaredReadOnly":[true],"effectiveMutationClass":["modifying"],"turnsStarted":2,"repliesRecorded":2,"maxConcurrent":1,"endedBy":"budget-total-replies"}` | `{"declaredReadOnly":[true],"effectiveMutationClass":["modifying"],"turnsStarted":2,"repliesRecorded":2,"maxConcurrent":1,"endedBy":"budget-total-replies"}` | passed |
| `S5G-CONTENTION-01` | `contention`：a foreign modifying holder stops the walk before any reply is recorded, with the refusal named on the Turn | `{"providerCalls":0,"repliesRecorded":0,"endedBy":"provider-failed","interactionStatus":{"status":"active","stopReason":null},"budgetUnmoved":{"repliesUsed":0,"repliesRemaining":2,"hopsUsed":0,"hopsRemaining":2,"distinctAgents":0,"agentsRemaining":2},"turnStatuses":[{"status":"failed","failureCode":"CONVERSATION_WORKSPA…` | `{"providerCalls":0,"repliesRecorded":0,"endedBy":"provider-failed","interactionStatus":{"status":"active","stopReason":null},"budgetUnmoved":{"repliesUsed":0,"repliesRemaining":2,"hopsUsed":0,"hopsRem…` | passed |
| `S5G-CONTENTION-02` | `contention`：once the holder is released the same interaction completes, so the stop was about authority only | `{"repliesRecorded":2,"endedBy":"budget-total-replies","replyAgents":["agent_lead","agent_worker"]}` | `{"repliesRecorded":2,"endedBy":"budget-total-replies","replyAgents":["agent_lead","agent_worker"]}` | passed |

七个断言的组合覆盖该行的四个行为面。**提及**：带提及的走只让被提及的 Agent 发言且按提及顺序（source=mention），未被提及的 always 成员以 not-selected-manually 记录；不带提及的走只有 always 成员发言，mentioned 模式成员以 not-mentioned 记录（两个方向的同一门槛），持久回复的 hopOrder/hopFromAgentId 形成串行链。**@all**：全体成员作为提及列表传入时三人全部发言、顺序等于传入顺序，walk 结束时 budgetStatus 显示 repliesUsed=3/repliesRemaining=0（终止原因 budget-total-replies）。**串行化**：三次走查中 runner 观测到的最大并发恒为 1，且每个 speaker 的 Turn 快照与群聊快照分别带 conversation/interaction 归属。**parallel-read-only（D3 关闭）**：会话声明 parallel-read-only 时，plan 记录的 declaredReadOnly 全为 true，而 effectiveMutationClass 仍为 modifying、走查仍串行、最多 2 条回复即被预算终止——即声明不被当作执行许可。**准入**：存在外来 MODIFYING 持有者时，首个 speaker 的 Turn 在 Provider 调用之前以 CONVERSATION_WORKSPACE_MODIFYING_BUSY 失败（providerCalls=0、回复 0 条、interaction 仍 active、预算未动），释放后同一 interaction 正常完成两条回复。

未证明的相邻行为：本行证明的是「提及/@all 展开/串行/D3 关闭/准入拒绝」在生产 driver 上的行为与持久结果；跨会话与 Run 的真实并发竞争、以及群聊的 loop-guard 终止分支不在本包。

## targeted tests 与 scope verifier

受影响测试（4 个文件：GroupTurnDriver / GroupSpeakerResolver / BoundedGroupService / conversationRuntime.group，`node --import tsx --test --test-concurrency=1`，在 `apps/server` 下执行）raw exit = 0，Node summary 为 `37 pass / 0 fail / 0 skipped`；普通 scope verifier 未加 `--require-closed`，raw exit = 0，stdout 原文为 `{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}`。

- **@all 的口径**：本路径没有服务端 `@all` 字面量；`@all` 的实际形态是调用方把全体成员 id 作为提及列表传入（`mentionedAgentIds`）。本包正是按该形态驱动（全体成员 + 模板顺序），并在收据里记录了 speaker 顺序。
- 本包用 recording runner 替代真实 CLI：证明 speaker 顺序、串行化、预算终止与准入拒绝，不证明模型输出（Provider 生产链由 S4/S9 gate 包覆盖）。
- `member-not-active` 中的 `agentId: null` 是会话里的 user 成员（非 Agent 成员）；这是解析器的既有语义，本包按原样记录。
- 群聊的跨会话/Run 竞争只在「外来 MODIFYING 持有者」这一条上取证；真实并发 HTTP 竞争与跨进程时序不在本包（S3 授权包与 #162 路由测试覆盖相邻分支）。
- loop-guard（同 Agent 自环、重复内容、重复提及）分支不属本包断言范围：本轮走的是预算终止与准入拒绝路径。

## 矩阵保护

生成前后未修改 `pass-freeze.json` / `matrix.json` / `pass-evidence-audit.json`，未执行任何 promotion 脚本，也未执行 `--require-closed`。与 baseline blob 的 SHA-256 对比：

| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |
| --- | --- | --- | --- |
| `docs/implementation/lite-closeout/matrix.json` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | true |
| `docs/implementation/lite-closeout/pass-freeze.json` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | true |
| `docs/implementation/lite-closeout/pass-evidence-audit.json` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | true |

工作区 delta（`git status --porcelain=v1`）：

```text
?? agentos/docs/implementation/lite-closeout/S5-group-candidate-evidence.spec.json
?? agentos/docs/implementation/lite-closeout/evidence/s5-group-candidate-evidence-20260914/
?? agentos/scripts/verify-lite-s5-group-candidate-evidence.mjs
```

