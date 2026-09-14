# S8 RUNTIME-VERIFY 逐行断言账本

本账本把「点名文件整体通过」升级为「该文件里**实际执行过**的断言」，正是撤回 196 个 PASS 时缺失的那一环：`No immutable per-requirement mapping to specific executed test assertions and their outcomes.`

它只产出候选判定，不改矩阵状态：每行 verdict 取 `candidate-supported`、`insufficient-evidence` 或 `failed`；未执行 PASS 提升，未执行 `--require-closed`。

- 批次收据：`docs/implementation/lite-closeout/evidence/s8-runtime-verify-batches-20260914/verification-batches.json`
- 收据绑定基线：`b32e7c0491c61c348b5127154817e4ef6f837377`
- 批次汇总：`{"batches":27,"passed":26,"failed":1,"requirementsProvable":0,"requirementsTotal":221}`
- 判定规则：该文件在该基线上以干净计数退出，且文件内至少一条**已执行且通过**的断言与条款文本共享具区别性的词元（≥6 字符，或两个独立 4–5 字符词元）。

## 汇总

| 判定 | 行数 |
| --- | ---: |
| `candidate-supported` | 99 |
| `insufficient-evidence` | 106 |
| `failed` | 0 |
| 合计 | 205 |

未判为 candidate-supported 的分布：

| 原因 | 行数 |
| --- | ---: |
| `not-clean / no-clause-match` | 1 |
| `not-in-batch / no-assertion-parsed` | 6 |
| `passed / no-clause-match` | 99 |

## 逐行明细

| Requirement | 点名文件 | 文件状态 | 已解析断言 | 命中断言（示例） | 判定 |
| --- | --- | --- | ---: | --- | --- |
| `LITE-00-001` | `apps/server/src/store/SqliteStore.test.ts` | `passed` | 36 | Workspace.agents projected fields match Provider Configuration after update | candidate-supported |
| `LITE-00-002` | `(未记录)` | `not-in-batch` | 0 | — | insufficient-evidence |
| `LITE-00-003` | `(未记录)` | `not-in-batch` | 0 | — | insufficient-evidence |
| `LITE-00-004` | `(未记录)` | `not-in-batch` | 0 | — | insufficient-evidence |
| `LITE-00-005` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P15 delivery changes only Outbox/dead-letter/notifier state, never domain rows or R | candidate-supported |
| `LITE-00-006` | `(未记录)` | `not-in-batch` | 0 | — | insufficient-evidence |
| `LITE-00-007` | `(未记录)` | `not-in-batch` | 0 | — | insufficient-evidence |
| `LITE-00-008` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | L1D-U09 an active MODIFYING admission blocks every later request | candidate-supported |
| `LITE-00-009` | `(未记录)` | `not-in-batch` | 0 | — | insufficient-evidence |
| `LITE-00-010` | `apps/server/src/services/MemoryContextResolver.test.ts` | `passed` | 17 | — | insufficient-evidence |
| `LITE-00-011` | `apps/server/src/services/GitObservationCollector.integration.test.ts` | `passed` | 36 | — | insufficient-evidence |
| `LITE-00-012` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | SHELL-01 wide mode renders all four columns with landmarks | candidate-supported |
| `LITE-00-013` | `apps/server/src/services/BoundedGroupService.test.ts` | `passed` | 17 | — | insufficient-evidence |
| `LITE-01-001` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | Identity — canonical entity IDs | candidate-supported |
| `LITE-01-002` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | Identity — canonical entity IDs | candidate-supported |
| `LITE-01-003` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | operation IDs remain distinct from all existing kinds | candidate-supported |
| `LITE-01-004` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | — | insufficient-evidence |
| `LITE-01-005` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | — | insufficient-evidence |
| `LITE-01-006` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | — | insufficient-evidence |
| `LITE-01-007` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | snapshot prefix is not confused with other kinds | candidate-supported |
| `LITE-01-008` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | — | insufficient-evidence |
| `LITE-01-009` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | L1D-U02 a missing Workspace fails with WORKSPACE_NOT_FOUND | candidate-supported |
| `LITE-01-010` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | — | insufficient-evidence |
| `LITE-01-011` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | — | insufficient-evidence |
| `LITE-01-012` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | snapshot kind exists with snapshot prefix | candidate-supported |
| `LITE-01-013` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | Identity — canonical entity IDs | candidate-supported |
| `LITE-01-014` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > sanitizes discovery warn | candidate-supported |
| `LITE-01-015` | `apps/server/src/store/Identity.test.ts` | `passed` | 38 | — | insufficient-evidence |
| `LITE-02-001` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-02-002` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-02-003` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P2C-2B same-file concurrency permits only one composite cancellation | candidate-supported |
| `LITE-02-004` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approva | candidate-supported |
| `LITE-02-005` | `apps/server/src/services/m3-p2c2a-lifecycle-transaction.test.ts` | `passed` | 30 | failure during Event append rolls back the entire creation graph and idempotency miss | candidate-supported |
| `LITE-02-006` | `apps/server/src/services/m3-p2c2a-lifecycle-transaction.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-02-007` | `apps/server/src/services/m3-p2c2a-lifecycle-transaction.test.ts` | `passed` | 30 | P3D-2 operation approval Event and Outbox failures roll back all state | candidate-supported |
| `LITE-02-008` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-02-009` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged | candidate-supported |
| `LITE-02-010` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native recon | candidate-supported |
| `LITE-02-011` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P2C-2B completeRunStartup commits Stage then Run started events with snapshots | candidate-supported |
| `LITE-02-012` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-02-013` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-02-014` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approva | candidate-supported |
| `LITE-02-015` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership | candidate-supported |
| `LITE-02-016` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-02-017` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P3D-2 operation approval Event and Outbox failures roll back all state | candidate-supported |
| `LITE-03-001` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-002` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-003` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-004` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P3D-2 operation approval Event and Outbox failures roll back all state | candidate-supported |
| `LITE-03-005` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership | candidate-supported |
| `LITE-03-006` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P3D-2 operation approval Event and Outbox failures roll back all state | candidate-supported |
| `LITE-03-007` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-008` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-009` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native recon | candidate-supported |
| `LITE-03-010` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-011` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-012` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-013` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-014` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-015` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-016` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-017` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-018` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-03-019` | `apps/server/src/services/OutboxPublisher.test.ts` | `passed` | 12 | M3 P6A P01/P02 success claims outside-sink transaction and marks published only after acce | candidate-supported |
| `LITE-04-001` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > sanitizes discovery warn | candidate-supported |
| `LITE-04-002` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > parses golden, malformed | candidate-supported |
| `LITE-04-003` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > routes version, help, an | candidate-supported |
| `LITE-04-004` | `apps/server/src/store/SqliteStore.test.ts` | `passed` | 36 | new Workspace assigns kimicode provider type to Kimi agent | candidate-supported |
| `LITE-04-005` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continu | candidate-supported |
| `LITE-04-006` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | — | insufficient-evidence |
| `LITE-04-007` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | — | insufficient-evidence |
| `LITE-04-008` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | — | insufficient-evidence |
| `LITE-04-009` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > fails closed to unknown  | candidate-supported |
| `LITE-04-010` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > parses golden, malformed | candidate-supported |
| `LITE-04-011` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > freezes an absent persis | candidate-supported |
| `LITE-04-012` | `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | `passed` | 21 | src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > normalizes the legacy ki | candidate-supported |
| `LITE-05-001` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | — | insufficient-evidence |
| `LITE-05-002` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W1: kill | candidate-supported |
| `LITE-05-003` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W1: kill | candidate-supported |
| `LITE-05-004` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W3: prob | candidate-supported |
| `LITE-05-005` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams | candidate-supported |
| `LITE-05-006` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W3: prob | candidate-supported |
| `LITE-05-007` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2: spaw | candidate-supported |
| `LITE-05-008` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | — | insufficient-evidence |
| `LITE-05-009` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | — | insufficient-evidence |
| `LITE-05-010` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2 oracl | candidate-supported |
| `LITE-05-011` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | — | insufficient-evidence |
| `LITE-05-012` | `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | `passed` | 10 | src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W1: kill | candidate-supported |
| `LITE-06-001` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | L1D-U02 a missing Workspace fails with WORKSPACE_NOT_FOUND | candidate-supported |
| `LITE-06-002` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | L1D-U02 a missing Workspace fails with WORKSPACE_NOT_FOUND | candidate-supported |
| `LITE-06-003` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | L1D-U06 MODIFYING winner follows durable request_order FIFO | candidate-supported |
| `LITE-06-004` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | L1D-U06 MODIFYING winner follows durable request_order FIFO | candidate-supported |
| `LITE-06-005` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | L1D-R02 grant state, timestamp, classification, and version commit atomically | candidate-supported |
| `LITE-06-006` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | — | insufficient-evidence |
| `LITE-06-007` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | — | insufficient-evidence |
| `LITE-06-008` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | — | insufficient-evidence |
| `LITE-06-009` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | L1D-U06 MODIFYING winner follows durable request_order FIFO | candidate-supported |
| `LITE-06-010` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | — | insufficient-evidence |
| `LITE-06-011` | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | `passed` | 46 | — | insufficient-evidence |
| `LITE-07-001` | `apps/server/src/services/MemoryContextResolver.test.ts` | `passed` | 17 | MF4I-05 invalid input fails closed | candidate-supported |
| `LITE-07-002` | `apps/server/src/services/MemoryContextResolver.test.ts` | `passed` | 17 | — | insufficient-evidence |
| `LITE-07-004` | `apps/server/src/store/MemoryCandidateRepository.test.ts` | `passed` | 24 | MF2R-09 conflict open and resolve | candidate-supported |
| `LITE-07-005` | `apps/server/src/services/MemoryContextResolver.test.ts` | `passed` | 17 | LITE-07-013 MF4I-DEGRADED the persisted snapshot records the retrieval degradation | candidate-supported |
| `LITE-07-006` | `apps/server/src/services/MemoryContextResolver.test.ts` | `passed` | 17 | — | insufficient-evidence |
| `LITE-07-008` | `apps/server/src/store/MemoryCandidateRepository.test.ts` | `passed` | 24 | MF4I-07 later entry edits do not rewrite the snapshot | candidate-supported |
| `LITE-07-009` | `apps/server/src/services/MemoryContextResolver.test.ts` | `passed` | 17 | payload failure rolls back the snapshot and its selections | candidate-supported |
| `LITE-07-010` | `apps/server/src/services/MemoryCandidateGenerationService.test.ts` | `passed` | 15 | — | insufficient-evidence |
| `LITE-07-011` | `apps/server/src/store/MemoryCandidateRepository.test.ts` | `passed` | 24 | MF2R-03 automatic candidate without source rejects | candidate-supported |
| `LITE-07-012` | `apps/server/src/services/MemoryContextResolver.test.ts` | `passed` | 17 | LITE-07-109: new snapshots exclude ineligible content while historical snapshots stay froz | candidate-supported |
| `LITE-07-014` | `apps/server/src/services/MemoryContextResolver.test.ts` | `passed` | 17 | MF4I-01 resolve persists a snapshot and returns bounded context | candidate-supported |
| `LITE-08-001` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-08-002` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-08-003` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-08-004` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-08-008` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-08-009` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P2C-2B completeRunStartup commits Stage then Run started events with snapshots | candidate-supported |
| `LITE-08-010` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes | candidate-supported |
| `LITE-08-011` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails close | candidate-supported |
| `LITE-08-012` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-08-013` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-08-014` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-08-015` | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | `passed` | 30 | — | insufficient-evidence |
| `LITE-09-001` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | — | insufficient-evidence |
| `LITE-09-002` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | — | insufficient-evidence |
| `LITE-09-003` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | LITE-09-102 chat refuses while another subject holds the Workspace modifying authority | candidate-supported |
| `LITE-09-004` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | TD-02 a provider failure finalizes failed and preserves the checkpoints | candidate-supported |
| `LITE-09-005` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | TD-03 a cancelled reply finalizes the Turn cancelled and the Message failed | candidate-supported |
| `LITE-09-006` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | TD-01 a completed reply streams every delta as a durable checkpoint and finalizes | candidate-supported |
| `LITE-09-007` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | — | insufficient-evidence |
| `LITE-09-008` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | — | insufficient-evidence |
| `LITE-09-009` | `apps/server/src/store/SqliteStore.test.ts` | `passed` | 36 | new Workspace assigns kimicode provider type to Kimi agent | candidate-supported |
| `LITE-09-011` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | LITE-09-102 a READ_ONLY holder does not block chat and D3 parallel-read-only stays unavail | candidate-supported |
| `LITE-09-012` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | — | insufficient-evidence |
| `LITE-09-014` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | LITE-09-102 chat refuses while another subject holds the Workspace modifying authority | candidate-supported |
| `LITE-09-015` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | — | insufficient-evidence |
| `LITE-09-016` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | TD-02 a provider failure finalizes failed and preserves the checkpoints | candidate-supported |
| `LITE-09-017` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | TD-01 a completed reply streams every delta as a durable checkpoint and finalizes | candidate-supported |
| `LITE-09-018` | `apps/server/src/services/ConversationTurnDriver.test.ts` | `passed` | 14 | — | insufficient-evidence |
| `LITE-10-001` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | P2 Migration Registry contains exactly the registered migrations in contract order | candidate-supported |
| `LITE-10-002` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-003` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-004` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-005` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-006` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-007` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-008` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-009` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-010` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-011` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-012` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-013` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-014` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-015` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-016` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-10-017` | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | `passed` | 2 | — | insufficient-evidence |
| `LITE-11-001` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | — | insufficient-evidence |
| `LITE-11-002` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | — | insufficient-evidence |
| `LITE-11-003` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | P5C afterSequence-only cursor replays strictly greater durable sequences | candidate-supported |
| `LITE-11-004` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continu | candidate-supported |
| `LITE-11-005` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | — | insufficient-evidence |
| `LITE-11-006` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | P5C-R07 transport backpressure during initial replay closes transport and subscription fai | candidate-supported |
| `LITE-11-007` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0) | candidate-supported |
| `LITE-11-008` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | — | insufficient-evidence |
| `LITE-11-009` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | — | insufficient-evidence |
| `LITE-11-010` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | — | insufficient-evidence |
| `LITE-11-011` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | — | insufficient-evidence |
| `LITE-11-012` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | — | insufficient-evidence |
| `LITE-11-013` | `apps/server/src/routes/canonicalRunStream.test.ts` | `passed` | 16 | — | insufficient-evidence |
| `LITE-12-001` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse | candidate-supported |
| `LITE-12-002` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-003` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | SHELL-07 dark and light themes emit their own token values | candidate-supported |
| `LITE-12-004` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-005` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-006` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-007` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-008` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-009` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-010` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse | candidate-supported |
| `LITE-12-011` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-012` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | SHELL-03 standard mode collapses the Inspector into an affordance | candidate-supported |
| `LITE-12-013` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-014` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-015` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-12-016` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-13-001` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | GET /runs/:runId/inspector returns the redacted projection for a canonical Run | candidate-supported |
| `LITE-13-002` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-13-003` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-13-004` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-13-005` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-13-006` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring) | candidate-supported |
| `LITE-13-007` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-13-008` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-13-009` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-13-010` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-13-011` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | GET /runs/:runId/inspector fails closed for an unknown Run and workspace | candidate-supported |
| `LITE-13-012` | `packages/shared/p6-l1a-admission.test.ts` | `passed` | 23 | L1A-10 READ_ONLY + verified technical denial + no side effects -> READ_ONLY | candidate-supported |
| `LITE-13-013` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-13-014` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-13-015` | `apps/server/src/routes/runtimeInspector.test.ts` | `passed` | 4 | — | insufficient-evidence |
| `LITE-04-101` | `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts` | `not-clean` | 33 | — | insufficient-evidence |
| `LITE-07-101` | `apps/server/src/routes/memoryRuntime.test.ts` | `passed` | 16 | — | insufficient-evidence |
| `LITE-09-103` | `apps/server/src/services/AgentHistoryService.test.ts` | `passed` | 7 | CR6-A5 provider filter scopes Turns to their Provider configuration | candidate-supported |
| `LITE-12-101` | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | `passed` | 9 | — | insufficient-evidence |
| `LITE-13-102` | `apps/server/src/services/RuntimeInspector.test.ts` | `passed` | 12 | — | insufficient-evidence |
| `LITE-01-101` | `packages/shared/wf-template-instantiation.test.ts` | `passed` | 10 | — | insufficient-evidence |

