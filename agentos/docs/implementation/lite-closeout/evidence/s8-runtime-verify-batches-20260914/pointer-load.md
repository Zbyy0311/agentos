# RUNTIME-VERIFY 指针载荷分析

一个被点名的测试文件如果承担了**多于自身已执行断言数**的条款，就不可能为每一条条款提供一条可单独举证的断言。这是关于**指针**的机械陈述，不是覆盖度判断，而它正是撤回 PASS 时记录的那一类缺陷（*原矩阵点名文件未覆盖该条款*）。

- 账本：`docs/implementation/lite-closeout/evidence/s8-runtime-verify-batches-20260914/runtime-verify-ledger.json`（基线 `b32e7c0491c61c348b5127154817e4ef6f837377`）
- 汇总：`{"files":25,"clauses":205,"clausesInCorrectlySizedPointers":106,"clausesInOverAssignedPointers":99,"overAssignedFiles":7}`

| 点名文件 | 承担条款 | 已执行断言 | 状态 | 超额条款 |
| --- | ---: | ---: | --- | ---: |
| `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | 17 | 2 | `passed` | 15 |
| `apps/server/src/routes/runtimeInspector.test.ts` | 14 | 4 | `passed` | 10 |
| `apps/web/src/components/layout/WorkbenchShell.test.tsx` | 18 | 9 | `passed` | 9 |
| `(no runnable test file named)` | 6 | 0 | `not-in-batch` | 6 |
| `apps/server/src/services/OutboxPublisher.test.ts` | 17 | 12 | `passed` | 5 |
| `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | 12 | 10 | `passed` | 2 |
| `apps/server/src/services/ConversationTurnDriver.test.ts` | 15 | 14 | `passed` | 1 |
| `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | 27 | 30 | `passed` | 0 |
| `apps/server/src/routes/canonicalRunStream.test.ts` | 16 | 16 | `passed` | 0 |
| `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | 13 | 46 | `passed` | 0 |
| `apps/server/src/store/Identity.test.ts` | 13 | 38 | `passed` | 0 |
| `packages/agent-core/src/providers/kimiCodeAdapter.test.ts` | 11 | 21 | `passed` | 0 |
| `apps/server/src/services/MemoryContextResolver.test.ts` | 8 | 17 | `passed` | 0 |
| `apps/server/src/store/SqliteStore.test.ts` | 3 | 36 | `passed` | 0 |
| `apps/server/src/services/m3-p2c2a-lifecycle-transaction.test.ts` | 3 | 30 | `passed` | 0 |
| `apps/server/src/store/MemoryCandidateRepository.test.ts` | 3 | 24 | `passed` | 0 |
| `apps/server/src/services/GitObservationCollector.integration.test.ts` | 1 | 36 | `passed` | 0 |
| `apps/server/src/services/BoundedGroupService.test.ts` | 1 | 17 | `passed` | 0 |
| `apps/server/src/services/MemoryCandidateGenerationService.test.ts` | 1 | 15 | `passed` | 0 |
| `packages/shared/p6-l1a-admission.test.ts` | 1 | 23 | `passed` | 0 |
| `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts` | 1 | 33 | `not-clean` | 0 |
| `apps/server/src/routes/memoryRuntime.test.ts` | 1 | 16 | `passed` | 0 |
| `apps/server/src/services/AgentHistoryService.test.ts` | 1 | 7 | `passed` | 0 |
| `apps/server/src/services/RuntimeInspector.test.ts` | 1 | 12 | `passed` | 0 |
| `packages/shared/wf-template-instantiation.test.ts` | 1 | 10 | `passed` | 0 |

## 超额承担的文件及其条款

### `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（17 条款 / 2 断言）

- `LITE-10-001` fresh and supported upgrade migrations;（candidate-supported，命中 1）
- `LITE-10-002` checksum, backup, integrity, and foreign-key gates;（insufficient-evidence，命中 0）
- `LITE-10-003` opaque IDs and Process ID/PID distinction;（insufficient-evidence，命中 0）
- `LITE-10-004` Task zero/many Runs and retry child lineage;（insufficient-evidence，命中 0）
- `LITE-10-005` Snapshot immutability and child remapping;（insufficient-evidence，命中 0）
- `LITE-10-006` Event append-only and per-Run ordering;（insufficient-evidence，命中 0）
- `LITE-10-007` Event/Outbox atomicity and replay;（insufficient-evidence，命中 0）
- `LITE-10-008` idempotency convergence;（insufficient-evidence，命中 0）
- `LITE-10-009` optimistic race winner;（insufficient-evidence，命中 0）
- `LITE-10-010` Process reserve-before-spawn;（insufficient-evidence，命中 0）
- `LITE-10-011` immutable requested/effective mutation classification and `enforcedWorkspaceReadOnly` evidence per Run;（insufficient-evidence，命中 0）
- `LITE-10-012` fail-closed recovery evidence;（insufficient-evidence，命中 0）
- `LITE-10-013` bounded finalized output references;（insufficient-evidence，命中 0）
- `LITE-10-014` Workspace tombstones and non-cascading history;（insufficient-evidence，命中 0）
- `LITE-10-015` compatibility reads without data loss;（insufficient-evidence，命中 0）
- `LITE-10-016` no secret persistence;（insufficient-evidence，命中 0）
- `LITE-10-017` no clean-sheet schema replacement.（insufficient-evidence，命中 0）

### `apps/server/src/routes/runtimeInspector.test.ts`（14 条款 / 4 断言）

- `LITE-13-001` view facts match canonical records;（candidate-supported，命中 1）
- `LITE-13-002` Run, Stage, Provider, Process, and duration are distinct;（insufficient-evidence，命中 0）
- `LITE-13-003` Process ID is never confused with PID;（insufficient-evidence，命中 0）
- `LITE-13-004` strict Event order, gap recovery, and deduplication;（insufficient-evidence，命中 0）
- `LITE-13-005` bounded output without unbounded client state;（insufficient-evidence，命中 0）
- `LITE-13-006` Memory view reproduces Snapshot and explanations;（candidate-supported，命中 1）
- `LITE-13-007` Git wording never implies ownership;（insufficient-evidence，命中 0）
- `LITE-13-008` recovery never guesses success;（insufficient-evidence，命中 0）
- `LITE-13-009` no reattach/takeover/direct-kill control;（insufficient-evidence，命中 0）
- `LITE-13-010` Cancel/Retry route through API, Policy, Runtime, and committed Event;（insufficient-evidence，命中 0）
- `LITE-13-011` no two modifying Runs in one Workspace;（candidate-supported，命中 1）
- `LITE-13-013` no secrets in DTOs;（insufficient-evidence，命中 0）
- `LITE-13-014` browser disconnect leaves execution active;（insufficient-evidence，命中 0）
- `LITE-13-015` replay has zero external side effects.（insufficient-evidence，命中 0）

### `apps/web/src/components/layout/WorkbenchShell.test.tsx`（18 条款 / 9 断言）

- `LITE-00-012` the UI presents the four-column engineering workbench with a focused Inspector;（candidate-supported，命中 2）
- `LITE-12-001` four-column layout and adaptive collapse;（candidate-supported，命中 1）
- `LITE-12-002` shared semantic token coverage;（insufficient-evidence，命中 0）
- `LITE-12-003` dark/light contrast;（candidate-supported，命中 1）
- `LITE-12-004` reduced-motion behavior;（insufficient-evidence，命中 0）
- `LITE-12-005` batched streaming and stable scroll;（insufficient-evidence，命中 0）
- `LITE-12-006` cursor reconnect without gaps/duplicates;（insufficient-evidence，命中 0）
- `LITE-12-007` complete async states;（insufficient-evidence，命中 0）
- `LITE-12-008` explicit Chat/Task/Run actions;（insufficient-evidence，命中 0）
- `LITE-12-009` bounded Group controls;（insufficient-evidence，命中 0）
- `LITE-12-010` truthful parallel-read-only availability and modifying admission when write denial cannot be enforced;（candidate-supported，命中 1）
- `LITE-12-011` Memory selection explanation;（insufficient-evidence，命中 0）
- `LITE-12-012` Inspector parity with canonical data;（candidate-supported，命中 1）
- `LITE-12-013` Agent-unified History and secret-free Search;（insufficient-evidence，命中 0）
- `LITE-12-014` keyboard core flow and stable focus;（insufficient-evidence，命中 0）
- `LITE-12-015` API-client-only access;（insufficient-evidence，命中 0）
- `LITE-12-016` absence of active Worktree manager, full Policy editor, and Provider Comparison.（insufficient-evidence，命中 0）
- `LITE-12-101` 四栏正文要求的导航、通知状态及键盘流覆盖（insufficient-evidence，命中 0）

### `(no runnable test file named)`（6 条款 / 0 断言）

- `LITE-00-002` Conversation and Message records survive reconnect and restart;（insufficient-evidence，命中 0）
- `LITE-00-003` Task, Run, Process, and Event remain distinct and traceable;（insufficient-evidence，命中 0）
- `LITE-00-004` a Run survives browser disconnect;（insufficient-evidence，命中 0）
- `LITE-00-006` Windows cancellation handles the owned process tree;（insufficient-evidence，命中 0）
- `LITE-00-007` recovery classifies uncertainty without guessing completion;（insufficient-evidence，命中 0）
- `LITE-00-009` concurrent read-only Runs cannot mutate the Workspace because admission requires tested `enforcedWorkspaceReadOnly` evidence;（insufficient-evidence，命中 0）

### `apps/server/src/services/OutboxPublisher.test.ts`（17 条款 / 12 断言）

- `LITE-00-005` Runtime Events remain ordered, durable, replayable, and redacted;（candidate-supported，命中 2）
- `LITE-02-008` publication retry does not repeat a domain transition;（candidate-supported，命中 2）
- `LITE-03-001` envelope and payload schema validation;（candidate-supported，命中 1）
- `LITE-03-002` immutable Event records;（candidate-supported，命中 1）
- `LITE-03-003` strict unique per-Run ordering;（candidate-supported，命中 1）
- `LITE-03-007` reclaim, retry, and dead letter without duplicate domain transition;（candidate-supported，命中 3）
- `LITE-03-008` at-least-once delivery with idempotent consumers;（candidate-supported，命中 4）
- `LITE-03-010` browser disconnect without Run cancellation;（candidate-supported，命中 1）
- `LITE-03-011` unknown Event and future schema compatibility;（candidate-supported，命中 3）
- `LITE-03-012` provider mapping fidelity and no invented telemetry;（candidate-supported，命中 1）
- `LITE-03-013` redaction before persistence;（candidate-supported，命中 1）
- `LITE-03-014` payload limit and Artifact fallback;（candidate-supported，命中 1）
- `LITE-03-015` Conversation bridge deduplication;（candidate-supported，命中 1）
- `LITE-03-016` Memory selection explanation Events;（candidate-supported，命中 2）
- `LITE-03-017` Git observation wording that does not imply Git ownership;（candidate-supported，命中 1）
- `LITE-03-018` recovery classification preserves the **NON-GOAL** of reattach and never guesses success;（candidate-supported，命中 2）
- `LITE-03-019` replay with zero external side effects.（candidate-supported，命中 1）

### `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（12 条款 / 10 断言）

- `LITE-05-001` reserve-before-spawn ordering and idempotency;（insufficient-evidence，命中 0）
- `LITE-05-002` Windows Job assignment failure gate: provider instruction never executes, suspended provider is terminated, handles close, and spawn fails;（candidate-supported，命中 6）
- `LITE-05-003` Windows owned-spawn restart reaper gate: owned provider reaped, post-restart classification `MISSING`;（candidate-supported，命中 6）
- `LITE-05-004` Windows primitive identity gate: same creation identity -> `SAME`, different -> `MISMATCH`, unreadable -> `UNKNOWN`;（candidate-supported，命中 6）
- `LITE-05-005` production PID-reuse gate: persisted FILETIME A vs observed B, B != A -> `MISMATCH`, never `SAME`;（candidate-supported，命中 4）
- `LITE-05-006` evidence-version gates: v1 rows keep `MISSING`/`UNKNOWN`, v2 rows reach `SAME`/`MISMATCH`/`UNKNOWN`;（candidate-supported，命中 6）
- `LITE-05-007` cancel terminates the owned Windows process tree with survivor verification;（candidate-supported，命中 6）
- `LITE-05-008` browser disconnect leaves the Process running;（insufficient-evidence，命中 0）
- `LITE-05-009` timeout, approval-wait exclusion, and race-safe terminal transitions;（insufficient-evidence，命中 0）
- `LITE-05-010` bounded independent stdout/stderr with Artifact fallback;（candidate-supported，命中 1）
- `LITE-05-011` startup preflight never probes OS state inside a SQLite write transaction;（insufficient-evidence，命中 0）
- `LITE-05-012` classification never activates reattach, adoption, ownership transfer, or takeover.（candidate-supported，命中 1）

### `apps/server/src/services/ConversationTurnDriver.test.ts`（15 条款 / 14 断言）

- `LITE-09-001` Message-only Turns create no Task and no Run;（insufficient-evidence，命中 0）
- `LITE-09-002` Task creation and Run creation are distinct and idempotent;（insufficient-evidence，命中 0）
- `LITE-09-003` Run start passes Workspace admission;（candidate-supported，命中 1）
- `LITE-09-004` Messages survive reconnect and Provider switch;（candidate-supported，命中 4）
- `LITE-09-005` client retry creates exactly one Message;（candidate-supported，命中 3）
- `LITE-09-006` streams finalize durably;（candidate-supported，命中 1）
- `LITE-09-007` browser disconnect leaves Run and Process active;（insufficient-evidence，命中 0）
- `LITE-09-008` Event projection never duplicates cards;（insufficient-evidence，命中 0）
- `LITE-09-011` parallel-read-only mutation attempts are technically denied, while unavailable enforcement is admitted as modifying;（candidate-supported，命中 2）
- `LITE-09-012` budgets, stop, and loop guard terminate every group interaction;（insufficient-evidence，命中 0）
- `LITE-09-014` no Workspace has two AgentOS modifying Runs;（candidate-supported，命中 1）
- `LITE-09-015` @all never launches parallel modification;（insufficient-evidence，命中 0）
- `LITE-09-016` archive preserves linked records;（candidate-supported，命中 2）
- `LITE-09-017` templates use durable Task, Run, and Stage primitives;（candidate-supported，命中 1）
- `LITE-09-018` search excludes secrets.（insufficient-evidence，命中 0）

