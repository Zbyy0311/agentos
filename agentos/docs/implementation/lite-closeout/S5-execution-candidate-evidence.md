# S5 Chat/Group 执行边界候选证据包（LITE-09-101 / LITE-09-013 / LITE-09-102）

本报告只记录候选证据，不能直接改变验收矩阵状态。3 个 requirement 的 verdict 只能取 `candidate-supported`、`insufficient-evidence` 或 `failed`；本轮没有执行 PASS 提升，也没有执行 `--require-closed`。

- baseline SHA：`b6476e1e4c4c460e4fcab9b2b09c05b9d61d3cc3`
- 机器可读包：`docs/implementation/lite-closeout/S5-execution-candidate-evidence.json`
- 模型口径：本包不调用任何 Provider 模型：它驱动的是生产 Turn 驱动的持久化、Scope 与授权边界（recording runner 记录 Provider 本会收到的内容）。
- 这些 requirement 的矩阵状态在本轮保持 `GAP`，verdict 只是候选证据。

| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |
| --- | --- | --- | --- | ---: |
| `LITE-09-101` | `Provider调用前持久化并实际注入有界Agent上下文` | `candidate-supported` | 2 total / 2 passed / 0 failed / 0 skipped | 0 |
| `LITE-09-013` | `per-Agent contexts remain isolated` | `candidate-supported` | 2 total / 2 passed / 0 failed / 0 skipped | 0 |
| `LITE-09-102` | `Chat/Group执行权限不能由串行或提示词代替` | `candidate-supported` | 2 total / 2 passed / 0 failed / 0 skipped | 0 |

## 最终执行记录

```powershell
node --import tsx ../../scripts/verify-lite-s5-execution-candidate-evidence.mjs --out E:\workspace\Multi-Agent-worktrees\agentos-lite-s5-evidence\agentos\docs\implementation\lite-closeout\evidence\s5-execution-candidate-evidence-20260914
```

raw exit = `0`；receipts 统计 `6 total / 6 passed / 0 failed / 0 skipped`。

| 日志 / 收据 | bytes | SHA-256 |
| --- | ---: | --- |
| `docs/implementation/lite-closeout/evidence/s5-execution-candidate-evidence-20260914/receipts.json` | 5962 | `d91a63eb6887225f3eea231156a030b82cb7966cf5aabbcbc263cb40df6a76a8` |
| `docs/implementation/lite-closeout/evidence/s5-execution-candidate-evidence-20260914/stdout.txt` | 71 | `a94808df3569a28c94b5fd2d60dbfea85c878e878c923df4426bea8ebbd7dd03` |
| `docs/implementation/lite-closeout/evidence/s5-execution-candidate-evidence-20260914/stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s5-execution-candidate-evidence-20260914/exit.txt` | 3 | `13bf7b3039c63bf5a50491fa3cfd8eb4e699d1ba1436315aef9cbe5711530354` |
| `docs/implementation/lite-closeout/evidence/s5-execution-candidate-evidence-20260914/scope-verifier.stdout.txt` | 93 | `c412198c0b3a31ba0bce0ce7a3d661de904524bc7082edd140be153a9d2eb5b1` |
| `docs/implementation/lite-closeout/evidence/s5-execution-candidate-evidence-20260914/scope-verifier.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `docs/implementation/lite-closeout/evidence/s5-execution-candidate-evidence-20260914/targeted-tests/targeted.stdout.txt` | 13645 | `47e39d24bcb11fdf97bede8edfcf0611ec017fd600fa33daef7b5505ff7cba21` |
| `docs/implementation/lite-closeout/evidence/s5-execution-candidate-evidence-20260914/targeted-tests/targeted.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

### 被驱动的 gate 调用

```json
{}
```

## `LITE-09-101`

matrix 原文为 `Provider调用前持久化并实际注入有界Agent上下文`；条款来源 `apps/server/src/services/ConversationTurnDriver.ts:407`，并引用：

- `apps/server/src/services/ChatMemorySelectionPort.ts:43` — 生产 chat 选择端口：MF-3 检索 + MF-4 预算，Scope 限于 global/workspace/agent/conversation
- `apps/server/src/routes/conversationRuntime.ts:91` — 组合根把该端口接入生产路由
- `apps/server/src/services/ConversationTurnDriver.ts:480` — 注入文本 = 刚持久化的那份选择，读一次复用

- matrix 状态：`GAP`（workPackage `S5`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：Direct/Group按实际调用前快照预算与Scope，provider收到冻结选中内容，事后记录引用原快照。
- 原始记录缺口（matrix `finding`）：快照在recordReply创建，driver已先调用Provider；history未使用该快照。
- 生产入口（matrix `implementation`）：`apps/server/src/services/ConversationTurnDriver.ts`、`apps/server/src/services/BoundedGroupService.ts`、`apps/server/src/services/GroupTurnDriver.ts`、`apps/server/src/routes/conversationRuntime.ts`、`apps/server/src/store/TurnContextSnapshotRepository.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S5E-DIRECT-01` | `direct`：the frozen selection is persisted before the Provider call and names the real Memory entries | `{"runnerSawSnapshot":true,"selectedIds":["mem_s5_02","mem_s5_01"],"totalTokens":23,"strategyVersion":"chat-memory.v1","turnStatus":"final","messageStatus":"final","turnReferencesThatSnapshot":true,"expectsWorkspaceEntry":true,"expectsAgentEntry":true}` | `{"runnerSawSnapshot":true,"selectedIds":["mem_s5_02","mem_s5_01"],"totalTokens":23,"strategyVersion":"chat-memory.v1","turnStatus":"final","messageStatus":"final","turnReferencesThatSnapshot":true,"ex…` | passed |
| `S5E-DIRECT-02` | `direct`：the Provider receives exactly the frozen selection text and the out-of-scope entry never enters it | `{"memoryContextMatchesSnapshotEntries":true,"injectedEntryCount":2,"contextMentionsWorkspaceEntry":true,"contextMentionsAgentEntry":true,"taskScopedEntrySelected":false,"contextMentionsTaskEntry":false,"otherAgentEntrySelected":false}` | `{"memoryContextMatchesSnapshotEntries":true,"injectedEntryCount":2,"contextMentionsWorkspaceEntry":true,"contextMentionsAgentEntry":true,"taskScopedEntrySelected":false,"contextMentionsTaskEntry":fals…` | passed |

真实驱动生产 ConversationTurnDriver（真实 MemoryEntryRepository 行 + 生产 ChatMemorySelectionPort + 生产 CR-5 快照端口）：runner 在自己的 run() 内读到的快照行已经存在，且其 selected ids 非空、totalTokens 与策略版本（chat-memory.v1）已持久；Turn 行的 context_snapshot_id 指向同一快照；runner 收到的 memoryContext 与「按该快照 ids 重新读 Entry 并用 injectedEntryText 组装」的文本逐字相等（即注入的是冻结内容而不是事后重新选的内容）；workspace 与 agent scope 的 Entry 进入选择，task scope 的 Entry 既不进 ids 也不进注入文本，另一个 Agent 的 agent-scope Entry 同样不进。

未证明的相邻行为：选择端口本身不是模型：它证明「持久化先于调用、注入等于冻结选择、Scope 有界」，不证明模型如何使用该上下文；有界窗口（MAX_FROZEN_HISTORY_MESSAGES）与快照预算字段由既有 driver 测试覆盖，本包只断言本次运行的实际值。

## `LITE-09-013`

matrix 原文为 `per-Agent contexts remain isolated`；条款来源 `apps/server/src/services/ChatMemorySelectionPort.ts:43`，并引用：

- `apps/server/src/store/MemoryEntryRepository.ts:448` — Entry 的 scope/owner 决定可读性
- `apps/server/src/services/ConversationTurnDriver.ts:409` — 每个 Turn 以自己的 agentId 选择并冻结

- matrix 状态：`GAP`（workPackage `S5`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：执行前固定有效权限与有界隔离快照，实际Provider输入引用该快照；跨会话/Run竞争及D3关闭有证据。
- 原始记录缺口（matrix `finding`）：Driver把历史交旧Runner；每Agent快照在Provider回复后recordReply才记录，未证明执行前隔离/授权。
- 生产入口（matrix `implementation`）：`apps/server/src/services/GroupTurnDriver.ts`、`apps/server/src/services/ConversationTurnDriver.ts`、`apps/server/src/services/BoundedGroupService.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S5E-ISOLATION-01` | `isolation`：each Agent receives only its own reachable Memory and its own frozen snapshot | `{"turnsObserved":1,"selectedIds":["mem_s5_03","mem_s5_01"],"seesOwnAgentEntry":true,"seesOtherAgentEntry":false,"seesWorkspaceEntry":true,"contextMentionsOwnEntry":true,"contextMentionsOtherAgentEntry":false,"distinctSnapshots":true,"turnStatus":"final"}` | `{"turnsObserved":1,"selectedIds":["mem_s5_03","mem_s5_01"],"seesOwnAgentEntry":true,"seesOtherAgentEntry":false,"seesWorkspaceEntry":true,"contextMentionsOwnEntry":true,"contextMentionsOtherAgentEntry…` | passed |
| `S5E-ISOLATION-02` | `isolation`：the earlier Agent keeps its own snapshot and history unchanged | `{"turnAPointsAtItsOwnSnapshot":true,"snapshotsForTheConversation":2,"snapshotAgents":[{"agentId":"agent_a","turnId":"turn_aaaaaaaaaaaaaaaaaaaa"},{"agentId":"agent_b","turnId":"turn_bbbbbbbbbbbbbbbbbbbb"}]}` | `{"turnAPointsAtItsOwnSnapshot":true,"snapshotsForTheConversation":2,"snapshotAgents":[{"agentId":"agent_a","turnId":"turn_aaaaaaaaaaaaaaaaaaaa"},{"agentId":"agent_b","turnId":"turn_bbbbbbbbbbbbbbbbbbb…` | passed |

同一个 Conversation 里两个 Agent 各跑一个真实 Turn：B 的选择包含自己的 agent-scope Entry 与 workspace Entry，不包含 A 的 agent-scope Entry；B 收到的注入文本提到自己的条目、不提到 A 的条目；两次 Turn 产生两个不同快照，快照行的 (agentId, turnId) 与各自 Turn 一一对应，且 A 的 Turn 仍指向它自己的快照（B 的运行没有改写 A 的冻结上下文）。

未证明的相邻行为：隔离是按 Scope/owner 的可读性证明的；跨会话或跨 Run 的竞争不在本包（09-010 与 09-102 的授权语义覆盖 Workspace 级互斥）。

## `LITE-09-102`

matrix 原文为 `Chat/Group执行权限不能由串行或提示词代替`；条款来源 `apps/server/src/services/ConversationTurnDriver.ts:391`，并引用：

- `apps/server/src/routes/conversationRuntime.ts:102` — 生产 authority 端口读 WorkspaceAdmissionRepository 的 MODIFYING+GRANTED 行
- `apps/server/src/services/ConversationTurnDriver.ts:396` — D2=A：拒绝并指向显式 Run 路径，而不是隐式授予 modifying 权限

- matrix 状态：`GAP`（workPackage `S5`，matrixVersion 15，本轮未改动）
- 冻结退出条件（matrix `exit`）：无隐式modifying authority，缺可靠只读证据显示不可用/要求显式Run；并发与拒绝路径测试。
- 原始记录缺口（matrix `finding`）：单interaction串行不证明与其他Conversation/Run共享Workspace权限；driver无显式admission。
- 生产入口（matrix `implementation`）：`apps/server/src/services/GroupTurnDriver.ts`、`apps/server/src/services/ConversationTurnDriver.ts`

| Assertion | 阶段 / 步骤 | 实际值 | 预期值 | 结果 |
| --- | --- | --- | --- | --- |
| `S5E-AUTHORITY-01` | `authority`：a chat Turn refuses instead of running beside another modifying holder, before any Provider call | `{"providerCalls":0,"turnStatus":"failed","failureCode":"CONVERSATION_WORKSPACE_MODIFYING_BUSY","messageStatus":"failed","snapshotCreatedForThatTurn":0,"refusalNamesTheHolder":true,"runtimeEvents":0}` | `{"providerCalls":0,"turnStatus":"failed","failureCode":"CONVERSATION_WORKSPACE_MODIFYING_BUSY","messageStatus":"failed","snapshotCreatedForThatTurn":0,"refusalNamesTheHolder":true,"runtimeEvents":0}` | passed |
| `S5E-AUTHORITY-02` | `authority`：the same Turn runs once the modifying holder is released, so the refusal is about authority only | `{"providerCalls":1,"status":"final"}` | `{"providerCalls":1,"status":"final"}` | passed |

当 Workspace 里存在另一个主体的 MODIFYING+GRANTED admission 时，chat Turn 以 CONVERSATION_WORKSPACE_MODIFYING_BUSY 失败，Provider 调用为 0 次、该 Turn 没有创建快照、没有 Runtime Event，失败信息点名了持有者；释放该 admission 后同一个 Turn 正常执行（Provider 调用 1 次、Turn final），因此拒绝来自授权状态而不是任何提示词或串行化副作用。

未证明的相邻行为：本包用生产 authority 端口 + 真实 admission 行证明拒绝路径；真实并发 HTTP 竞争与跨进程时序不在本包（#162 的既有路由测试与 S3 授权包覆盖相邻分支）。

## targeted tests 与 scope verifier

受影响测试（4 个文件：ChatMemorySelectionPort / ConversationTurnDriver / conversationRuntime / conversationRuntime.group，`node --import tsx --test --test-concurrency=1`，在 `apps/server` 下执行）raw exit = 0，Node summary 为 `34 pass / 0 fail / 0 skipped`；普通 scope verifier 未加 `--require-closed`，raw exit = 0，stdout 原文为 `{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}`。

- 本包用 recording runner 替代真实 CLI：证明的是「Provider 本会收到什么」与冻结顺序，不是模型输出质量（Provider 生产链由 S4/S9 gate 包覆盖）。
- 群聊的 mention/@all/顺序解析（LITE-09-010）不在本包：它需要一个把生产 GroupTurnDriver 与 group interaction 预算一起驱动的切片，尚未出具候选证据。
- D3 关闭（不提供 parallel-read-only）只在本包被记录为当前生产配置；其行为断言属于 09-010 的切片。
- 浏览器断开只结束订阅、取消/恢复沿用规范生命周期，由 S8/S9 相关包覆盖，不在本包。

## 矩阵保护

生成前后未修改 `pass-freeze.json` / `matrix.json` / `pass-evidence-audit.json`，未执行任何 promotion 脚本，也未执行 `--require-closed`。与 baseline blob 的 SHA-256 对比：

| 受保护文件 | worktree SHA-256 | baseline SHA-256 | 一致 |
| --- | --- | --- | --- |
| `docs/implementation/lite-closeout/matrix.json` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | `81202d2273568177df2ed370cc0f5525cd38f961b65e85d0f7e66feda2001690` | true |
| `docs/implementation/lite-closeout/pass-freeze.json` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | `7263d8c4d857804e5c3603658bd2f3081eda7cb46ab3380b5b87532cda88dcb6` | true |
| `docs/implementation/lite-closeout/pass-evidence-audit.json` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | `e5b81d9904136abe1aad251f25afba3e6c4d8765ccd4629bcd138a839eeb9795` | true |

工作区 delta（`git status --porcelain=v1`）：

```text
?? agentos/docs/implementation/lite-closeout/S5-execution-candidate-evidence.spec.json
?? agentos/docs/implementation/lite-closeout/evidence/s5-execution-candidate-evidence-20260914/
?? agentos/scripts/assemble-lite-candidate-evidence.mjs
?? agentos/scripts/verify-lite-s5-execution-candidate-evidence.mjs
```

