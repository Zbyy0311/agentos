# S8 RUNTIME-VERIFY 改指与验证记录（matrix v16）

本轮把 S0 里 205 条 `RUNTIME-VERIFY` 的**证据路径**修正为它们真正的覆盖断言，并记录仍缺断言的行。**没有任何行使 state 改变，PASS 仍为 0。**

## 1. 矩阵变更（v15 → v16）

变更只有两类，逐行留痕于 `repoint-record.json`：

| 动作 | 行数 | 说明 |
| --- | ---: | --- |
| **改指 `tests`** | 75 | 指向该条款**真实覆盖断言**所在的测试文件（原先多指向无关文件，见下表）。每行 `finding` 前缀写入：`[matrix v16 re-point] previous tests: …; verified covering assertion: …` |
| **记录缺口** | 31 | 未找到任何**已执行**断言覆盖该条款。`finding` 前缀写入：`[matrix v16 triage] no executed assertion covers this clause yet: …` |

未改动：任何 `state`、`document`、`requirement`、`line`、`evidence`。`matrixVersion` 15 → 16，`changes` 新增一条说明；`matrix.json.v15.bak` 为本地备份（不入库）。

scope verifier（未加 `--require-closed`）raw exit 0：

```json
{"matrixVersion":16,"status":"frozen","PASS":0,"GAP":26,"RUNTIME-VERIFY":205,"DEFERRED":164}
```

## 2. 端到端验证：改指后批次集自动扩展

批次运行器的文件集**由矩阵 `tests` 推导**，因此改指会直接改变被执行的测试集：

| 指标 | v15（改指前） | v16（改指后） |
| --- | ---: | ---: |
| 批次文件数 | 27 | **51** |
| 覆盖条款数 | 221 | **225** |
| passed | 26 | **48** |
| not-clean（env-gated 跳过） | 1 | 3 |

三个 not-clean 全部是**按设计跳过**的真实 Provider 用例，不是失败：

- `apps/server/src/services/run-engine/CanonicalArtifactResult.liveGate.test.ts`（0 pass / 0 fail / 1 skip）
- `apps/server/src/services/run-engine/RuntimeApprovalGate.liveGate.test.ts`（0 pass / 0 fail / 1 skip）
- `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts`（32 pass / 0 fail / 4 skip）

这三个文件依赖 Provider CLI 环境变量；其真实调用证据来自本仓已合并的 gate 收据（`evidence/gates-20260914/`）与本轮 S2/S3 证据包，仓库既有约定即「CI 无 CLI 时按跳过记录，矩阵行承载本地真实执行结果，不断言 CI 会重跑」。

## 3. 断言级验证结果

用 v16 批次重算断言账本（`runtime-verify-ledger-v16.json`）：

| 指标 | v15 | v16 |
| --- | ---: | ---: |
| 账本自动命中 `candidate-supported` | 99 | **155** |
| 仍需人工判读 | 106 | 50 |

改指让 **56 行**从「人工确认」变为「自动可复算」——因为指针终于指向了含覆盖断言的文件。

把账本与人工判读合并（同一条款取二者之一的证据）：

| 状态 | 行数 |
| --- | ---: |
| 账本自动命中 | 155 |
| 其中同时经人工源码复核 | 56 |
| 仅人工复核确认（断言名用编码前缀，关键词匹配不到） | 19 |
| **已验证合计** | **174** |
| **记录在案的缺口**（无任何已执行断言覆盖） | **31** |
| 合计 | 205 |

31 条缺口与人工判读的驳回集合**完全一致**（无未判读项）。缺口分布：

- 复合条款缺一半：`LITE-04-006`（缺 retryability）、`LITE-13-005`（缺客户端状态有界）、`LITE-13-010`（缺 Policy 段与 committed Event 段）、`LITE-11-009`（缺 API 客户端侧）、`LITE-10-005`（缺 child remapping）
- 运行时行为无断言：`LITE-02-001`/`09-001`/`11-001`（message-only 不建 Task/Run 仅有 Composer 意图层断言）、`LITE-08-012`（断线不构成决定）、`LITE-13-008` 之外的眼罩类
- 安全/边界无断言：`LITE-13-013`（DTO 无秘密）、`LITE-11-012`（DTO 无存储路径）、`LITE-08-003`/`08-004`（Provider 原生动作桥与不可拦截可见性）
- UI 行为无断言：`LITE-12-005`（流式批处理/滚动稳定）、`LITE-12-007`（异步状态完备）、`LITE-12-015`（仅经 API 客户端访问）、`LITE-12-101`（导航/通知/键盘流）
- 文案层无断言：`LITE-06-011`/`LITE-13-007`（Git 观测措辞不得暗示拥有权）
- 其他：`LITE-00-002`、`LITE-00-011`、`LITE-01-015`、`LITE-04-007`、`LITE-04-008`、`LITE-04-101`（真实调用证据在 gate 收据而非该测试文件）、`LITE-05-009`、`LITE-09-008`、`LITE-11-005`、`LITE-13-009`、`LITE-13-102`

## 4. 边界（不声称的事）

- **改指不是提升**：75 条被改指的行仍全部是 `RUNTIME-VERIFY`，PASS 仍为 0。改指只修正「证据指向哪里」，不判定「验收是否通过」。
- **31 条缺口不等于实现缺陷**：本轮证明的是「没有已执行断言覆盖该条款」，**未**证明实现行为错误。按 S0 状态表，它们保持 `RUNTIME-VERIFY`（先验证；证实缺陷后转 GAP）。
- **env-gated 三文件**：其断言在无 CLI 环境下按设计跳过；真实执行证据来自已合并的 gate 收据与 S2/S3 证据包，本轮未在本机重跑真实 Provider。
- 本记录不改动 `pass-freeze.json` 与 `pass-evidence-audit.json`（与基线逐字节一致）。

