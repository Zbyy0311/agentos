# S8 四条 Requirement 候选证据包

本报告只记录候选证据，不能直接改变验收矩阵状态。四条 requirement 的本轮 verdict 只能取 `candidate-supported`、`insufficient-evidence` 或 `failed`；本轮没有执行 PASS 提升，也没有执行 `--require-closed`。

## 固定边界

- 开始记录：`git fetch origin-https main` 成功；`git rev-parse origin-https/main` 输出 `31020c9ba0cab64aa1706a48126c4681c12e562f`；在独立 worktree 中执行 `git status --short` 为空。原主 worktree 的既有无关脏状态保持原样，没有带入本分支。
- 最终测试 baseline SHA：`31020c9ba0cab64aa1706a48126c4681c12e562f`
- baseline 的 exact parent：`f9cfbd00c807d91bd80eadcfa6f74b014df07eb5`
- 分支：`audit/lite-four-row-candidate-evidence`
- 最终证据运行代码 SHA：baseline SHA 加本任务新增的证据 harness；机器可读包中的 `testCodeSha` 仍固定为上述 baseline，表示所有四条证据绑定的产品 baseline。
- 当前权威模型口径：**此证据验证的是指定路由模型下的 AgentOS Provider/Runtime canonical chain，不证明机器默认模型或额度受限模型可用。**
- 指定路由：Codex=`deepseek/deepseek-flash`，Kimi=`opencodex/deepseek/deepseek-flash`，OpenCode=`deepseek/deepseek-v4-flash`。

最终机器可读包：[S8-four-row-candidate-evidence.json](S8-four-row-candidate-evidence.json)。

| Requirement | 原文（matrix v15） | 最终 verdict | assertion counts | raw exit |
| --- | --- | --- | --- | ---: |
| `LITE-00-004` | `a Run survives browser disconnect;` | `candidate-supported` | 4 total / 4 passed / 0 failed / 0 skipped | 0 |
| `LITE-00-007` | `recovery classifies uncertainty without guessing completion;` | `candidate-supported` | 6 / 6 / 0 / 0 | 0 |
| `LITE-02-009` | `browser disconnect leaves Run and Process active;` | `candidate-supported` | 2 / 2 / 0 / 0 | 0 |
| `LITE-03-010` | `browser disconnect without Run cancellation;` | `candidate-supported` | 4 / 4 / 0 / 0 | 0 |

## 最终执行记录

完整 harness 命令：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/verify-lite-four-row-candidate-evidence.ps1 -ServerPort 3201 -AcceptanceRoot "E:\workspace\Multi-Agent-worktrees\agentos-lite-four-row-candidate-evidence\agentos\docs\implementation\lite-closeout\evidence\S8-four-row-candidate-evidence-20260914-09"
```

该命令拆出的真实子命令为 prepare、pre、recovery 和 assemble。最终 phase 结果如下；counts 是 assertion 原始记录统计，没有将空值或失败归一化为成功：

| 子命令 | raw exit | 实际结果 |
| --- | ---: | --- |
| `prepare-lite-four-row-candidate-evidence.mjs` | 0 | 创建一个 canonical Run、四个 workflow stage、持久 admission 和 `run.cancel` Operation |
| `verify-lite-four-row-candidate-evidence.mjs --phase pre` | 0 | 12 total / 12 passed / 0 failed / 0 skipped |
| `verify-lite-four-row-candidate-evidence.mjs --phase recovery` | 0 | 4 / 4 / 0 / 0 |
| `assemble-lite-four-row-candidate-evidence.mjs` | 0 | 生成 JSON，四条 verdict 全为 `candidate-supported` |

最终 raw stdout/stderr 日志都在 `docs/implementation/lite-closeout/evidence/S8-four-row-candidate-evidence-20260914-09/candidate-evidence/`，以下是实际收录的路径、字节数和 SHA-256：

| 日志 | bytes | SHA-256 |
| --- | ---: | --- |
| `prepare.stdout.txt` | 1009 | `af3360d2dc0cf53b463de71ddbcc9681dab9c7731103b33c1906428177caeb17` |
| `prepare.stderr.txt` | 82 | `f80b0a60011ab3a1f57ed1e27806a4a096dc9716a85a716ded2816e2b51c152f` |
| `pre.stdout.txt` | 308 | `63c76f4c1ff334fb40618ad8f6ed3daa1e975d29e6a883951311308e929a704a` |
| `pre.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `server-pre.stdout.txt` | 103 | `9b5dbf2d962467a6166eac14ea6e3c9f3920697f463dc3617775c83d159cf8ce` |
| `server-pre.stderr.txt` | 82 | `f80b0a60011ab3a1f57ed1e27806a4a096dc9716a85a716ded2816e2b51c152f` |
| `recovery.stdout.txt` | 316 | `78a7a49af4b727562e8f989f094f1e8c5580051c8c748e182d2156c72aa29da1` |
| `recovery.stderr.txt` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `server-recovery.stdout.txt` | 103 | `9b5dbf2d962467a6166eac14ea6e3c9f3920697f463dc3617775c83d159cf8ce` |
| `server-recovery.stderr.txt` | 140 | `be702983c83e6e93989599bda9d8f2e29603b1adbae7b52e6a157887a3b629b2` |

组装器自己的 stdout/stderr 没有被计入以上 raw test logs。每个 phase 的 assertion receipt 是同一目录中的 `pre.json`、`recovery.json`，setup 和命令元数据分别是 `candidate-setup.json`、`run-metadata.json`。

## `LITE-00-004`

规范原文为 `a Run survives browser disconnect;`，来源 `docs/Runtime-Specification lite/00-Vision.md:406`。本条绑定 canonical Run start、canonical SSE subscription、Runtime Inspector 和公开 Operation cancel 生命周期。

| Assertion | 测试步骤 / 观察对象 | 实际值 | 预期值 | 结果与 checkpoint |
| --- | --- | --- | --- | --- |
| `LITE-00-004-A1` | `POST /api/runs/:runId/start`；Run start HTTP acceptance | HTTP `202`；Operation `run.start`，状态 `queued` | HTTP `202`，Operation queued | passed；`canonical-run-start-accepted` |
| `LITE-00-004-A2` | start 后轮询 Runtime Inspector `projection.overview.status` | `running` | `running` | passed；`runtime-inspector-run-active-before-disconnect` |
| `LITE-00-004-A3` | `AbortController.abort` 后再次读同一 Run 的 Inspector | `running` | `running` | passed；`runtime-inspector-run-active-after-disconnect` |
| `LITE-00-004-A4` | 读取预建 `run.cancel` Operation，再以当前 version 调用 `POST /api/operations/:operationId/cancel` | read `200`；type=`run.cancel`；cancel `200`；Run=`cancelled` | cancel `200`；Run=`cancelled` | passed；`explicit-operation-cancel-after-disconnect` |

这些 assertion 足以覆盖本条的行为链：Run 先被真实启动并观察到 `running`，然后断开 canonical 浏览器/Event 订阅，再观察同一 Run 仍为 `running`，最后由独立的正常生命周期取消动作结束。它不能证明 Provider 成功完成、所有网络故障形态都相同或取消后仍保持 active。

完整 assertion 记录、实际 Run/Operation id、对象值、预期值和日志引用见 JSON 的 `requirements[].assertionCoverage`。

## `LITE-02-009`

规范原文为 `browser disconnect leaves Run and Process active;`，来源 `docs/Runtime-Specification lite/02-Runtime-Lifecycle.md:530`。

| Assertion | 测试步骤 / 观察对象 | 实际值 | 预期值 | 结果与 checkpoint |
| --- | --- | --- | --- | --- |
| `LITE-02-009-A1` | start 后 Runtime Inspector 的 `projection.processes[]` | 同一 Run id；Process type=`provider`；status=`starting` | linked Run id 相同；status 为 `starting` 或 `running` | passed；`runtime-inspector-run-and-process-active-before-disconnect` |
| `LITE-02-009-A2` | disconnect 后读取同一 Process id 的 Inspector projection | 同一 Run id；同一 Process；status=`starting` | linked Run id 相同；status 为 `starting` 或 `running` | passed；`runtime-inspector-process-active-after-disconnect` |

本条同时观察 Run 所属的具体 Process 身份和断线后的 active 状态，覆盖了比只检查 Run 更严格的要求。它不证明显式取消后 Process 仍 active，也不扩展到其他传输故障。

## `LITE-03-010`

规范原文为 `browser disconnect without Run cancellation;`，来源 `docs/Runtime-Specification lite/03-Event-Model.md:550`。

| Assertion | 测试步骤 / 观察对象 | 实际值 | 预期值 | 结果与 checkpoint |
| --- | --- | --- | --- | --- |
| `LITE-03-010-A1` | 在 Run start 前打开 `GET /api/runs/:runId/stream` | HTTP `200`；`text/event-stream; charset=utf-8` | HTTP `200`；SSE content type | passed；`canonical-stream-open-before-start` |
| `LITE-03-010-A2` | 消费生产 SSE body，直到 Run 启动期间收到事件 | `15` 个 frame；包含 `run.created`、stage 生命周期、`run.started` 等 | 至少 1 个 frame | passed；`canonical-stream-frame-received-before-disconnect` |
| `LITE-03-010-A3` | active Run/Process 已观察后执行 `AbortController.abort` | abort signal=`true`；reader 观察到 abort；非 abort error=`null` | 三项分别为 true、true、null | passed；`canonical-stream-client-disconnect-observed` |
| `LITE-03-010-A4` | 比较断开后的 Run status 与持久 Runtime Event projection | Run=`running`；事件类型中没有 `run.cancelled` 或 `run.cancellation_requested` | Run=`running`；禁止事件为空 | passed；`canonical-stream-disconnect-no-run-cancellation-observed` |

A1/A2 证明被断开的是实际生产 Event stream，A3 记录断开动作本身，A4 在断开之后独立观察 Run 和持久事件，形成“订阅断开未触发 Run cancellation”的因果边界证据。它只覆盖该 canonical SSE action 和观测时间窗，不能证明所有网络失败等价，也不能禁止之后由显式生命周期动作取消。

## `LITE-00-007`

规范原文为 `recovery classifies uncertainty without guessing completion;`，来源 `docs/Runtime-Specification lite/00-Vision.md:409`。

| Assertion | 测试步骤 / 观察对象 | 实际值 | 预期值 | 结果与 checkpoint |
| --- | --- | --- | --- | --- |
| `LITE-00-007-A1` | 创建专用恢复 fixture Conversation | HTTP `201`；conversation id 非空 | HTTP `201`；id 非空 | passed；`recovery-fixture-conversation-created` |
| `LITE-00-007-A2` | 模拟重启前插入并立即重读三条 `agent_runs` | `queued`、`running`、`waiting_user`；waiting question 为“保留 waiting_user 状态” | 三种状态全部存在 | passed；`recovery-before-state-recorded-before-server-stop` |
| `LITE-00-007-A3-queued` | 新 server 进程启动后读取 queued 行 | `failed`；failure reason=`服务重启导致执行中断`；非 completed | `failed`；completed=false | passed；`recovery-after-restart-queued-classified-failed` |
| `LITE-00-007-A3-running` | 新 server 进程启动后读取 running 行 | `failed`；failure reason=`服务重启导致执行中断`；非 completed | `failed`；completed=false | passed；`recovery-after-restart-running-classified-failed` |
| `LITE-00-007-A4` | 新 server 进程启动后读取 waiting_user 行 | `waiting_user`；原 waiting question 保留；非 completed | `waiting_user`；completed=false | passed；`recovery-after-restart-waiting-user-preserved` |
| `LITE-00-007-A5` | 对比完整 before/after 三行集合 | before=`queued,running,waiting_user`；after 两条 failed、一条 waiting_user；completed rows=`0` | completed rows=`0` | passed；`recovery-no-completed-guess` |

这组 assertion 明确记录了恢复前状态、停止旧 server、启动新 server、恢复后状态和最终集合；没有任何无法证明完成的执行被写成 `completed`。它覆盖三条 legacy fixture row 的启动恢复分类，不证明 live native Process identity 的恢复或后续 resume 流程。

## 相关 targeted tests

执行命令：

```powershell
pnpm --filter @agentos/server exec node --import tsx --test --test-concurrency=1 src/services/m3-p2c2b-composite-lifecycle.test.ts src/services/OutboxPublisher.test.ts
```

raw exit 为 `0`；Node test summary 为 `42 pass / 0 fail / 0 skipped / 0 cancelled / 0 todo`。日志：

- `docs/implementation/lite-closeout/evidence/S8-four-row-candidate-evidence-20260914-09/targeted-tests/targeted.stdout.txt`，SHA-256 `079d051df57d69e3817a313ba1be17d7d6bd52203845e8e667fb5447af948c75`，4455 bytes。
- `docs/implementation/lite-closeout/evidence/S8-four-row-candidate-evidence-20260914-09/targeted-tests/targeted.stderr.txt`，SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，0 bytes。

## 历史失败记录

所有失败尝试的 runner 和 phase raw logs 保留在 `docs/implementation/lite-closeout/evidence/S8-four-row-candidate-evidence-20260914-01` 至 `-08`，没有用成功重跑删除失败记录：

| 运行 | raw 结果 | 失败或修订原因 |
| --- | --- | --- |
| `-01` | prepare=`1` | Windows 下把绝对路径作为 ESM import specifier，触发 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。 |
| `-02` | prepare=`1` | 从错误运行位置加载 workspace package，触发 `@agentos/agent-core` exports resolution error。 |
| `-03` | prepare=`1` | 同类 package exports resolution error，随后改用编译后的 server dist。 |
| `-04` | prepare=`1` | 选到只存在于 JSON fallback 的 workspace，创建 Task 时触发真实 SQLite foreign-key failure。 |
| `-05` | pre=`1`、recovery=`1` | 未建立 canonical admission，Run 未进入 active；恢复 fixture 也触发 foreign-key failure。 |
| `-06` | pre=`1`、recovery=`0` | provider output mode 配置错误，Codex 返回 `PROVIDER_CONFIG_INVALID`；不是配额结论。 |
| `-07` | pre=`1`、recovery=`0` | 用已完成的 `run.start` Operation 做取消，取消 assertion 失败；随后改为预建 `run.cancel` Operation。 |
| `-08` | 所有 phase=`0` | 行为证据成功，但自审发现组装器自身空 stdout/stderr 被误列入 rawLogs，未作为最终包使用。 |
| `-09` | 所有 phase=`0` | 修订后最终候选包；rawLogs 仅含真实 phase/server stdout/stderr，哈希已复核。 |

## 矩阵保护

最终报告生成前后未修改 `pass-freeze.json`，未执行任何 promotion 脚本，未执行 `--require-closed`。任务末尾运行普通 scope verifier，raw exit=`0`，原始 stdout 为 `docs/implementation/lite-closeout/evidence/S8-four-row-candidate-evidence-20260914-09/scope-verifier.stdout.txt`，SHA-256=`c412198c0b3a31ba0bce0ce7a3d661de904524bc7082edd140be153a9d2eb5b1`；stderr 为同目录 `scope-verifier.stderr.txt`，SHA-256=`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。stdout 原文为：

```json
{"matrixVersion":15,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}
```

因此矩阵仍为 v15、`status=frozen`、PASS=0、GAP=26、RUNTIME-VERIFY=205、DEFERRED=164；四条 requirement 仍为 `RUNTIME-VERIFY`。

最终分支的新 HEAD、提交 parent、push 结果在人工交接时以 Git 原始输出为准；本文件中的所有行为证据都固定绑定到 baseline SHA `31020c9ba0cab64aa1706a48126c4681c12e562f`。
