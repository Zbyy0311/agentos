# S8 RUNTIME-VERIFY 判读总结（107 / 106 行待判读）

账本把 205 行分成「已自动取证」（99 行）与「待判读」（106 行）。本报告汇总全部 12 批判读：**每条都读源码断言体**，且被引断言必须在该基线的执行收据中通过。

- 基线：`b32e7c0491c61c348b5127154817e4ef6f837377`
| 结论 | 行数 |
| --- | ---: |
| `accepted`（找到具名且已执行的覆盖断言） | 75 |
| `rejected`（按复合条款口径缺项，已写明缺什么） | 31 |
| 尚未判读 | 0 |

## accepted（75）

| Requirement | 条款 | 覆盖文件 | 覆盖断言 | 原指针问题 |
| --- | --- | --- | --- | --- |
| `LITE-00-004` | a Run survives browser disconnect; | `apps/server/src/routes/canonicalRunStream.test.ts` | P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecyc | （未记录可运行测试文件） |
| `LITE-01-008` | one Workspace cannot admit two modifying Runs; | `apps/server/src/migrations/__tests__/p6-l1b-migration-016.test.ts` | L1B-13 two MODIFYING + GRANTED rows in one Workspace rejected by DB fence | apps/server/src/store/Identity.test.ts（内容为 ULID 身份测试，不覆盖本条） |
| `LITE-01-010` | prompt-only or user-forced capability claims never create read-only el | `apps/server/src/services/GroupSpeakerResolver.test.ts` | CG-S1/CG-S9: parallel-read-only declares intent but never claims an unproven rea | apps/server/src/store/Identity.test.ts（不覆盖） |
| `LITE-01-005` | retry creates a new Run lineage; | `apps/server/src/services/TaskRunService.test.ts` | P3C1-RY-S01 Retry acceptance creates a queued Child and completed v3 Operation | apps/server/src/store/Identity.test.ts（不覆盖） |
| `LITE-00-007` | recovery classifies uncertainty without guessing completion; | `apps/server/src/services/TaskRunRecoveryService.test.ts` | P6M2b running + mismatch -> no recovery, recovery failure (uncertainty) recorded | （未记录可运行测试文件） |
| `LITE-00-006` | Windows cancellation handles the owned process tree; | `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts` | P5E composes Dispatcher cancellation, owned Process cleanup, and LTS handoff exa | — |
| `LITE-00-010` | Memory selection is reproducible and explainable; | `apps/server/src/services/MemoryContextResolver.test.ts` | MF4I-02 resolve is idempotent per run scope | 同一文件（指针正确，断言名不含条款词元） |
| `LITE-07-101` | 显式用户保存触发 | `apps/server/src/routes/memoryRuntime.test.ts` | MF-2 explicit user save: creates the Entry and one Workspace Event in one transa | 同一文件（指针正确，只是断言名不含条款词元） |
| `LITE-01-101` | 有界Workflow templates及真实实例化 | `packages/shared/wf-template-instantiation.test.ts` | WFI-10 every template compiles | — |
| `LITE-01-011` | Stage remains optional and bounded; | `packages/shared/wf-template-instantiation.test.ts` | WFI-04 optional security review | apps/server/src/store/Identity.test.ts（不覆盖） |
| `LITE-02-013` | Process exit does not falsely complete a Run; | `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts` | consumes an internal stopped outcome without mutating canonical Stage or Run lif | apps/server/src/services/m3-p2c2b-composite-lifecycle.test.t |
| `LITE-00-013` | Group Conversation and workflow templates remain bounded. | `apps/server/src/services/BoundedGroupService.test.ts` | CR5S-03 reaching the total cap exhausts the interaction with a stable reason | 同一文件（群聊半句覆盖；模板半句在另一文件） |
| `LITE-02-006` | transition-to-Event mappings remain exact; | `apps/server/src/services/m3-p2c2a-lifecycle-transaction.test.ts` | P2C-2A Run queued -> starting emits run.dequeued with service timestamp | 同一文件（指针正确） |
| `LITE-02-012` | retry creates a new Run with preserved lineage; | `apps/server/src/services/TaskRunService.test.ts` | P3C1-RY-S02 Retry persists the exact fingerprint, Child fields, Events, and Outb | apps/server/src/services/m3-p2c2b-composite-lifecycle.test.t |
| `LITE-02-002` | Task creation is idempotent and separate from Run creation; | `apps/server/src/services/ConversationBridgeService.test.ts` | CR4B-02 create-task is idempotent across retries and starts nothing | apps/server/src/services/m3-p2c2b-composite-lifecycle.test.t |
| `LITE-01-004` | Task supports zero or many Runs; | `apps/server/src/services/TaskRunService.test.ts` | TaskRunService atomically rolls back a Run and a newly created Legacy Task when  | apps/server/src/store/Identity.test.ts（内容为 ULID 身份测试，不覆盖本条） |
| `LITE-01-006` | Run and Process can be queried independently; | `apps/server/src/services/RuntimeInspector.test.ts` | INSP-04 process PID is evidence-only | apps/server/src/store/Identity.test.ts（不覆盖） |
| `LITE-06-006` | non-Git Workspaces report `not-git` without silent fallback; | `apps/server/src/services/GitObservationCollector.integration.test.ts` | non-Git directory yields the exact C-locale NOT_GIT snapshot | apps/server/src/services/WorkspaceAdmissionAuthority.test.ts |
| `LITE-06-007` | diff Artifacts are immutable and checksummed; | `packages/shared/p6-l1c-git-observation-contract.test.ts` | L1C-M1-20 canonical diff Artifact crash ordering forbids DB-first availability | apps/server/src/services/WorkspaceAdmissionAuthority.test.ts |
| `LITE-06-008` | historical Worktree fields and Events remain readable; | `apps/server/src/migrations/__tests__/m3-p2c0-workflow-creation-metadata.test.ts` | WorkflowDefinitionRepository selects and exposes exact V2 metadata | apps/server/src/services/WorkspaceAdmissionAuthority.test.ts |
| `LITE-06-010` | no automatic or destructive Git command is executed by observation; | `packages/shared/p6-l1c-git-observation-contract.test.ts` | L1C-M1-04 GitCommandPort accepts only structured read families | apps/server/src/services/WorkspaceAdmissionAuthority.test.ts |
| `LITE-05-001` | reserve-before-spawn ordering and idempotency; | `packages/process-runtime/src/durable-coordinator.test.ts` | only the winning created->starting CAS calls spawn; losers join without spawning | packages/process-runtime/src/p6-m3b-windows-birth-identity.t |
| `LITE-05-008` | browser disconnect leaves the Process running; | `docs/implementation/lite-closeout/S8-four-row-candidate-evidence.json` | LITE-02-009-A2 runtime-inspector-process-active-after-disconnect | packages/process-runtime/src/p6-m3b-windows-birth-identity.t |
| `LITE-05-011` | startup preflight never probes OS state inside a SQLite write transact | `apps/server/src/taskRecovery.test.ts` | P6M2b-composition A: recoverInterruptedTaskRuntime consumes the supplied port | packages/process-runtime/src/p6-m3b-windows-birth-identity.t |
| `LITE-07-002` | source requirement for automatic Entries; | `apps/server/src/store/MemoryCandidateRepository.test.ts` | MF2R-03 automatic candidate without source rejects | apps/server/src/services/MemoryContextResolver.test.ts（快照/注入 |
| `LITE-07-006` | deterministic ranking with reasons; | `apps/server/src/routes/memoryRuntime.test.ts` | MF-5 retrieve: ranked results with reasons, filters, limit, and degraded flag | apps/server/src/services/MemoryContextResolver.test.ts（指针正确， |
| `LITE-07-010` | no bulk transcript or Provider-history promotion; | `apps/server/src/services/MemoryCandidateGenerationService.test.ts` | MF2R-G1 completed Run generates a review-required Candidate with bounded evidenc | 同一文件（指针正确，断言名不含条款词元） |
| `LITE-09-002` | Task creation and Run creation are distinct and idempotent; | `apps/server/src/services/ConversationBridgeService.test.ts` | CR4B-02 create-task is idempotent across retries and starts nothing | apps/server/src/services/ConversationTurnDriver.test.ts（Turn |
| `LITE-09-018` | search excludes secrets. | `apps/server/src/services/AgentHistoryService.test.ts` | CR6-A3 the q filter never searches message bodies (secrets excluded from search) | apps/server/src/services/ConversationTurnDriver.test.ts（不覆盖） |
| `LITE-10-002` | checksum, backup, integrity, and foreign-key gates; | `apps/server/src/migrations/__tests__/m2-4-task-run-schema.test.ts` | T14 PRAGMA integrity_check returns ok after 005/006 | apps/server/src/migrations/M2MigrationRegistryAcceptance.tes |
| `LITE-09-007` | browser disconnect leaves Run and Process active; | `docs/implementation/lite-closeout/S8-four-row-candidate-evidence.json` | LITE-02-009-A2 runtime-inspector-process-active-after-disconnect | apps/server/src/services/ConversationTurnDriver.test.ts（不覆盖本 |
| `LITE-09-012` | budgets, stop, and loop guard terminate every group interaction; | `apps/server/src/services/BoundedGroupService.test.ts` | CR5S-03 reaching the total cap exhausts the interaction with a stable reason | apps/server/src/services/ConversationTurnDriver.test.ts（不覆盖本 |
| `LITE-09-015` | @all never launches parallel modification; | `apps/server/src/services/GroupSpeakerResolver.test.ts` | CG-S1/CG-S9: parallel-read-only declares intent but never claims an unproven rea | apps/server/src/services/ConversationTurnDriver.test.ts（不覆盖本 |
| `LITE-11-010` | optimistic races have one winner; | `apps/server/src/routes/runLifecycle.test.ts` | P3C1-R27 no-key race: exactly one live 202, one stable 409 RUN_START_ALREADY_ACT | apps/server/src/routes/canonicalRunStream.test.ts（SSE 流契约，不覆 |
| `LITE-11-002` | create-task and start-run are separate and idempotent; | `apps/server/src/routes/conversationRuntime.test.ts` | create-task and start-run bridge a Message into durable work | apps/server/src/routes/canonicalRunStream.test.ts（不覆盖本条） |
| `LITE-11-011` | History is Agent-unified and Search is secret-free; | `apps/server/src/routes/conversationRuntime.test.ts` | history endpoint returns the agent unified references | apps/server/src/routes/canonicalRunStream.test.ts（不覆盖本条） |
| `LITE-11-013` | deferred API families are not active requirements. | `apps/web/src/liteScopeBoundary.test.ts` | LITE-12-016 no web module implements a deferred product surface | apps/server/src/routes/canonicalRunStream.test.ts（不覆盖） |
| `LITE-11-008` | one Workspace never admits two modifying Runs; | `apps/server/src/migrations/__tests__/p6-l1b-migration-016.test.ts` | L1B-13 two MODIFYING + GRANTED rows in one Workspace rejected by DB fence | apps/server/src/routes/canonicalRunStream.test.ts（不覆盖） |
| `LITE-12-006` | cursor reconnect without gaps/duplicates; | `apps/web/src/lib/directConversation.test.ts` | DCUX-S03 reconnect resumes from the durable cursor and resyncs | apps/web/src/components/layout/WorkbenchShell.test.tsx（布局，不覆 |
| `LITE-12-009` | bounded Group controls; | `apps/web/src/components/chat/GroupConversationCanvas.test.tsx` | GRP-canvas: the group canvas mounts with a composer and the budget controls | apps/web/src/components/layout/WorkbenchShell.test.tsx（不覆盖） |
| `LITE-12-011` | Memory selection explanation; | `apps/web/src/components/chat/RuntimeInspectorView.test.tsx` | INS-07 Memory Context explains selection and exclusion from the frozen Snapshot | apps/web/src/components/layout/WorkbenchShell.test.tsx（不覆盖） |
| `LITE-12-014` | keyboard core flow and stable focus; | `apps/web/src/lib/uiFoundation.test.ts` | UIF-13 accessibility rules | apps/web/src/components/layout/WorkbenchShell.test.tsx（布局断言不 |
| `LITE-12-002` | shared semantic token coverage; | `apps/web/src/lib/uiFoundation.test.ts` | UIF-14 uiCssVariables flattens all semantic tokens | apps/web/src/components/layout/WorkbenchShell.test.tsx（同一主题的 |
| `LITE-12-013` | Agent-unified History and secret-free Search; | `apps/server/src/services/AgentHistoryService.test.ts` | CR6-A3 the q filter never searches message bodies (secrets excluded from search) | apps/web/src/components/layout/WorkbenchShell.test.tsx（不覆盖） |
| `LITE-13-002` | Run, Stage, Provider, Process, and duration are distinct; | `apps/server/src/services/RuntimeInspector.test.ts` | INSP-12 Run, Stage, Provider, Process and duration stay distinct | apps/server/src/routes/runtimeInspector.test.ts（同一投影的 HTTP 面 |
| `LITE-13-003` | Process ID is never confused with PID; | `apps/server/src/services/RuntimeInspector.test.ts` | INSP-04 process PID is evidence-only | apps/server/src/routes/runtimeInspector.test.ts（不覆盖） |
| `LITE-13-004` | strict Event order, gap recovery, and deduplication; | `apps/server/src/services/RuntimeInspector.test.ts` | INSP-05 events are ordered and bounded | apps/server/src/routes/runtimeInspector.test.ts（不覆盖） |
| `LITE-13-014` | browser disconnect leaves execution active; | `apps/server/src/services/m3-p6-integrated-verification.test.ts` | P6D-A5 browser disconnect is transport-only: execution, Events, Outbox and termi | apps/server/src/routes/runtimeInspector.test.ts（不覆盖） |
| `LITE-13-015` | replay has zero external side effects; | `apps/server/src/services/RuntimeInspector.test.ts` | INSP-07 inspect performs no writes | apps/server/src/routes/runtimeInspector.test.ts（不覆盖） |
| `LITE-13-008` | recovery never guesses success; | `apps/server/src/services/TaskRunRecoveryService.test.ts` | P6M2b running + mismatch -> no recovery, recovery failure (uncertainty) recorded | apps/server/src/routes/runtimeInspector.test.ts（不覆盖） |
| `LITE-10-003` | opaque IDs and Process ID/PID distinction; | `apps/server/src/services/RuntimeInspector.test.ts` | INSP-04 process PID is evidence-only | M2MigrationRegistryAcceptance.test.ts（仅注册顺序，不覆盖） |
| `LITE-10-004` | Task zero/many Runs and retry child lineage; | `apps/server/src/services/TaskRunService.test.ts` | TaskRunService atomically rolls back a Run and a newly created Legacy Task when  | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-006` | Event append-only and per-Run ordering; | `apps/server/src/migrations/__tests__/m3-p2a-migration-012.test.ts` | runtime Events are append-only and preserve Run correlation constraints | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-007` | Event/Outbox atomicity and replay; | `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts` | P2C-2B every Event and Outbox position rolls back the composite transaction | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-008` | idempotency convergence; | `apps/server/src/routes/runLifecycle.test.ts` | P3C1-R27 no-key race: exactly one live 202, one stable 409 RUN_START_ALREADY_ACT | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-009` | optimistic race winner; | `apps/server/src/store/__tests__/RunRepository.test.ts` | T48 concurrent transitions produce exactly one winner | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-010` | Process reserve-before-spawn; | `packages/process-runtime/src/durable-coordinator.test.ts` | only the winning created->starting CAS calls spawn; losers join without spawning | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-011` | immutable requested/effective mutation classification and `enforcedWor | `apps/server/src/services/WorkspaceAdmissionAuthority.test.ts` | L1D-U03 frozen classifier, not requested class, is effective authority | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-012` | fail-closed recovery evidence; | `packages/process-runtime/src/durable-coordinator.test.ts` | cleanup terminateTree throw fails closed as unknown platform uncertainty | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-013` | bounded finalized output references; | `packages/process-runtime/src/durable-coordinator.test.ts` | retained cap fails closed BEFORE any byte commit | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-014` | Workspace tombstones and non-cascading history; | `apps/server/src/store/SqliteStore.test.ts` | records the tombstone schema through MigrationRunner and keeps it after restart | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-015` | compatibility reads without data loss; | `apps/server/src/migrations/__tests__/m2-7-workspace-compatibility.test.ts` | [M27-P5-T012] Workspace copy-only scope preserves source bytes and writes no Tas | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-016` | no secret persistence; | `apps/server/src/store/MemoryEntryRepository.test.ts` | MF1R-15 record exposes no secret value field | M2MigrationRegistryAcceptance.test.ts（不覆盖） |
| `LITE-10-017` | no clean-sheet schema replacement; | `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts` | P2 Migration Registry contains exactly the registered migrations in contract ord | 同一文件（本条是唯一指针正确的行） |
| `LITE-00-003` | Task, Run, Process, and Event remain distinct and traceable; | `apps/server/src/services/RuntimeInspector.test.ts` | INSP-12 Run, Stage, Provider, Process and duration stay distinct | （未记录可运行测试文件） |
| `LITE-00-009` | concurrent read-only Runs cannot mutate the Workspace because admissio | `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts` | L1D-I17 stale GRANTED READ_ONLY authority cannot reach RunEngine, provider, proc | （未记录可运行测试文件） |
| `LITE-08-001` | every high-impact action at an AgentOS-controlled or verified Provider | `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts` | LITE-08-005/006/007: ASK_USER pauses before spawn and one approved original Run  | m3-p2c2b-composite-lifecycle.test.ts（审批生命周期，不是闸门前置性） |
| `LITE-08-002` | DENY blocks AgentOS-owned spawn, destructive filesystem action, merge, | `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts` | LITE-08-006/007: reject is terminal, replay-safe, and a changed launch plan cann | m3-p2c2b-composite-lifecycle.test.ts（不覆盖） |
| `LITE-08-008` | snapshot hashes detect changed actions; | `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts` | LITE-08-006/007: reject is terminal, replay-safe, and a changed launch plan cann | m3-p2c2b-composite-lifecycle.test.ts（不覆盖） |
| `LITE-08-013` | no policy path bypasses single-writer admission; | `apps/server/src/migrations/__tests__/p6-l1b-migration-016.test.ts` | L1B-13 two MODIFYING + GRANTED rows in one Workspace rejected by DB fence | m3-p2c2b-composite-lifecycle.test.ts（不覆盖） |
| `LITE-08-014` | modifying execution succeeds without an AgentOS-owned Worktree; | `docs/implementation/lite-closeout/S2S3-live-candidate-evidence.json` | S2E-ARTIFACT-01 / S2E-COMPLETION-01（真实运行） | m3-p2c2b-composite-lifecycle.test.ts（不覆盖） |
| `LITE-08-015` | no full DSL, grants, simulation, or RBAC feature is active Lite scope. | `apps/web/src/liteScopeBoundary.test.ts` | LITE-12-016 no web module implements a deferred product surface | m3-p2c2b-composite-lifecycle.test.ts（不覆盖） |
| `LITE-12-004` | reduced-motion behavior; | `apps/web/src/components/layout/WorkbenchShell.test.tsx` | SHELL-05 reduced motion collapses panel transitions to zero | 同一文件（指针正确） |
| `LITE-12-008` | explicit Chat/Task/Run actions; | `apps/web/src/lib/directConversation.test.ts` | DCUX-P02 task and run modes map to distinct explicit actions | WorkbenchShell.test.tsx（布局，不覆盖） |
| `LITE-12-016` | absence of active Worktree manager, full Policy editor, and Provider C | `apps/web/src/liteScopeBoundary.test.ts` | LITE-12-016 the UI ships only the Lite route surface | WorkbenchShell.test.tsx（不覆盖） |

## rejected（31）—— 需要补断言或改指的真实缺口

### `LITE-00-011`  Git changes are observable without AgentOS owning Git workflow execution;

- 批：`triage-00.json`
- 差异：断言体只覆盖 HTTP run.start 接受与执行到终态，与 Git 可观测性无关（关键词 'execution'/'acceptance' 是巧合）。本条需重新寻找覆盖 Git observation 的断言。

### `LITE-00-002`  Conversation and Message records survive reconnect and restart;

- 批：`triage-00.json`
- 差异：断言体覆盖的是 reply 行的外键与级联删除，与「记录在重连/重启后存活」无关。需另找覆盖持久化后重开/重连的断言。

### `LITE-01-015`  archived or compatibility records do not disappear destructively;

- 批：`triage-00.json`
- 差异：断言体覆盖 legacy 导入只写兼容行、可重跑为 no-op 与退出码；与「归档/兼容记录不被破坏性移除」不是同一命题。需另找断言。

### `LITE-04-006`  errors normalize to stable codes with retryability;

- 批：`triage-01.json`
- 差异：断言体覆盖「稳定分类码」这一半（另有 'fails closed to unknown for timeout, spawn, unrelated and malformed auth evidence' 等），但没有任何断言覆盖条款后半句 retryability（可重试性）。条款为两部分，缺一不可。

### `LITE-04-007`  capability declarations match tested behavior;

- 批：`triage-01.json`
- 差异：该文件的断言集中在版本冻结、启动计划、环境语义与鉴权分类；没有任何断言把「能力声明」与「被测试行为」对齐（例如声明 sessionResume 就必须有对应行为断言）。需另找或按缺口记录。

### `LITE-04-008`  concurrent read-only admission is available only when attempted Workspace writes are technically denied and tested;

- 批：`triage-01.json`
- 差异：条款属于准入/只读资格（admission）子系统，而该文件是 Provider 适配器测试。真正的候选在 WorkspaceAdmissionAuthority.test.ts（L1D-I17/I18 关于 GRANTED READ_ONLY 与零副作用）或 p6-l1b-migration-016.test.ts。

### `LITE-13-102`  Inspector各section规范字段及Cancel/Retry源链

- 批：`triage-01.json`
- 差异：断言体覆盖各 section 的投影字段与顺序（含 INSP-12 身份区分），但**没有任何断言覆盖条款后半句 Cancel/Retry 源链**（即 Inspector 是否暴露取消/重试的来源链）。条款两部分，缺一不可。

### `LITE-04-101`  Codex/Kimi/OpenCode 的实际生产链接入与真实调用

- 批：`triage-01.json`
- 差异：该文件 33 条断言覆盖的是调度器/协调器/生命周期组合，其**真实 Provider 调用**部分是 env-gated 且本机跳过（文件 raw exit 0 但 4 skip）。真实调用证据不在本文件，而在 evidence/gates-20260914/ 的三个 Provider gate 收据（codex / kimi-routed / opencode，各自 exit 0）。本行应指向那些收据，而不是这个测试文件。

### `LITE-02-001`  Message-only turns do not create modifying Runs;

- 批：`triage-02.json`
- 差异：仅有 UI 意图层断言（resolveComposerAction 的 actionCreatesWork===false），它证明的是 Composer 不会把 chat 模式映射成建 Task/Run 的动作，**不证明运行时**在 message-only turn 后不产生 Task/Run 行。全仓检索未找到运行时段言该行为的断言（ConversationTurnDriver.test.ts 的 TD-01..06 也不含此类断言）。按缺口记录：需要一条「chat turn 后 cr_agent_turns 之外的 Task/Run 行数不变」的断言。

### `LITE-02-016`  Worktree absence does not block a modifying Run after Workspace admission;

- 批：`triage-03.json`
- 差异：断言体覆盖 WorktreeManager 对缺失路径的**协调与失败标记**，与「无 Worktree 时被准入的 modifying Run 仍可继续」不是同一命题。全仓检索未见断言「worktree 缺失 + 已准入 → Run 照常执行」的断言。按缺口记录。

### `LITE-06-011`  Git observation wording never implies AgentOS-owned Git workflow.

- 批：`triage-04.json`
- 差异：断言体保证的是「原始诊断不外泄」，不覆盖「措辞不得暗示 AgentOS 拥有 Git 工作流」这一类**文案/接口措辞**约束；全仓检索未找到措辞层面的断言。按缺口记录。

### `LITE-05-009`  timeout, approval-wait exclusion, and race-safe terminal transitions;

- 批：`triage-05.json`
- 差异：三项并列中两项有具名断言，第三项「approval 等待不消耗 idle 预算」在全仓检索（approval.*inactiv / idle.*approval / waiting_approval.*timeout / approvalTimeoutMs 的使用断言）中未见专门断言。按复合条款口径记驳回：需补一条「Run 处于 waiting_approval 期间 idle 预算不被消耗」的断言。
- 分项覆盖：
  - timeout → `idle timeout resets on activity`（有具名断言）
  - race-safe terminal transitions → `RACE-S5: terminal boundary joins every late caller`（有具名断言（另有 RACE-S1..S4 与 durable-coordinator 的 late-success never running））
  - approval-wait exclusion → **缺**

### `LITE-09-008`  Event projection never duplicates cards;

- 批：`triage-06.json`
- 差异：候选断言覆盖的是「SSE 重放不重复投递同一 sequence」（传输层去重），而条款要求的是**投影层不产生重复卡片**（同一 canonical 事实在 UI 投影中只出现一次）。两者不是同一层。全仓检索未见「投影/卡片去重」的具名断言。按缺口记录。

### `LITE-11-001`  Message post creates no Task or Run;

- 批：`triage-07.json`
- 差异：与 LITE-02-001 同一情形：候选断言只覆盖 Composer 意图层（actionCreatesWork===false），不覆盖运行时「POST 消息后 Task/Run 行数不变」。全仓检索未见该运行时断言。按缺口记录。

### `LITE-11-012`  Artifact DTOs leak no storage path;

- 批：`triage-07.json`
- 差异：该文件唯一的断言覆盖 content 服务（200、nosniff、CSP、metadata-only 409）与跨 Workspace 404，**没有任何断言检查 DTO 字段中不含存储路径**（例如 job 目录、绝对路径或内部文件名）。按缺口记录：需要一条对 Artifact DTO 字段集合/敏感字段的断言。

### `LITE-11-005`  frozen start/retry/cancel semantics and errors remain exact;

- 批：`triage-07.json`
- 差异：候选断言只覆盖「新路由不遮蔽既有 Start 路由」这一条存在性/路由表性质，**没有断言 start/retry/cancel 的具体语义与错误码保持不变**（例如同一输入仍返回相同 httpStatus + error code 组合、字段形状不变）。虽然 R27/RY-C03 覆盖了 start/retry 的竞争错误码，但缺少一条对三者语义的**冻结基线对照**断言。按缺口记录。

### `LITE-11-009`  API clients cannot obtain concurrent read-only admission through prompt or unverified claims;

- 批：`triage-07.json`
- 差异：发言者侧的「声明不等于资格」有断言；但条款主语是 **API 客户端**，需要通过准入接口提交能力声明并被拒的断言（例如 POST admission 携带未验证 enforcedWorkspaceReadOnly 时得到 MODIFYING/拒绝）。全仓检索未见该 API 侧断言。按复合条款口径记驳回。
- 分项覆盖：
  - prompt/声明不足以获得只读资格 → `CG-S1/CG-S9 ...`（有具名断言（发言者侧））
  - API 客户端无法通过未验证声明获得并发只读准入 → **缺**

### `LITE-12-005`  batched streaming and stable scroll;

- 批：`triage-08.json`
- 差异：全仓检索 `batched streaming` / `stable scroll` / `autoscroll` 均无命中；布局断言与流式批处理、滚动稳定性无关。条款两项（批处理流式、滚动稳定）都没有具名断言。按缺口记录。

### `LITE-12-007`  complete async states;

- 批：`triage-08.json`
- 差异：检索 `async state` / `loading.*error.*empty` / `four states` 无命中；布局断言不覆盖「加载/错误/空/成功」等异步状态完备性。按缺口记录。

### `LITE-12-015`  API-client-only access;

- 批：`triage-08.json`
- 差异：候选断言覆盖的是「只发布 Lite 路由面」（范围边界），不是「访问仅经 API 客户端」（即 UI 不直连数据库/文件系统、所有数据经 HTTP API）。全仓检索未见该断言。按缺口记录。

### `LITE-12-101`  四栏正文要求的导航、通知状态及键盘流覆盖

- 批：`triage-08.json`
- 差异：四项中只有「四栏布局」有组件级断言；导航与通知状态缺具名断言，键盘流只有契约常量（非组件/浏览器行为）。按复合条款口径记驳回：需补导航、通知状态与组件级键盘流断言。
- 分项覆盖：
  - 四栏布局与 landmark → `SHELL-01 wide mode renders all four columns with landmarks`（有具名断言）
  - 导航 → **缺**
  - 通知状态 → **缺**
  - 键盘流 → `UIF-13 accessibility rules（契约常量）`（仅有契约层断言）

### `LITE-13-005`  bounded output without unbounded client state;

- 批：`triage-09.json`
- 差异：「bounded output」由 INSP-05 覆盖（截断并显式置 truncated）；「without unbounded client state」需要 UI 侧断言（组件在超长流下不累积状态），全仓检索未见该断言。按复合条款口径记驳回。
- 分项覆盖：
  - 服务端输出有界 → `INSP-05 events are ordered and bounded（maxEvents=3 → events.length===3`（有具名断言）
  - 客户端状态不无界增长 → **缺**

### `LITE-13-010`  Cancel/Retry route through API, Policy, Runtime, and committed Event;

- 批：`triage-09.json`
- 差异：四段中 API 与 Runtime 有具名断言，Policy 段与「committed Event」段没有（未找到断言 cancel/retry 产生并持久化对应规范事件的用例）。按复合条款口径记驳回。
- 分项覆盖：
  - API → `P3C1-RY01 … returns HTTP 201`（有具名断言）
  - Runtime → `P3C1-RY-C03 … one 201 and one RUN_ACTIVE_EXISTS 409（存活 Run 数为 1）`（有具名断言）
  - Policy → **缺**
  - committed Event → **缺**

### `LITE-13-009`  no reattach/takeover/direct-kill control;

- 批：`triage-09.json`
- 差异：全仓检索 Inspector 断言中无 control/kill/reattach/takeover 相关断言；`process-reattach` 只出现在 m3-runtime 的**恢复模式事件载荷**枚举里，与「Inspector 不提供重连/接管/直接杀进程控件」不是同一命题。按缺口记录。

### `LITE-13-013`  no secrets in DTOs;

- 批：`triage-09.json`
- 差异：投影测试插入 `args_redacted_json`（结构上使用已脱敏列），但**没有一条断言检查 DTO 内不含秘密值**（例如断言投影字段集合、或断言某秘密串不出现在序列化结果中）。记忆侧的 `MF2R-11 record exposes no secret value field` 覆盖的是记忆记录形状，不是 Inspector/Artifact DTO。按缺口记录。

### `LITE-13-007`  Git wording never implies ownership;

- 批：`triage-09.json`
- 差异：与 LITE-06-011 同一缺口：全仓未见「Git 观测措辞不得暗示 AgentOS 拥有 Git 工作流」的文案/接口层断言。按缺口记录。

### `LITE-10-005`  Snapshot immutability and child remapping;

- 批：`triage-10.json`
- 差异：不可变性有两条具名断言（契约冻结 + resolver 的不改写断言）；但「child remapping」（子实体在迁移/复述时的 ID 重映射）在全仓检索（child.*remap / remaps / 重映射断言）无命中。按复合条款口径记驳回。
- 分项覆盖：
  - 快照不可变 → `MF0-19 snapshot immutability and event payload rules are frozen（mutabl`（有具名断言）
  - child remapping → **缺**

### `LITE-08-003`  DENY blocks Provider-native merge or push only when a verified enforceable pre-action bridge exposes that action before execution;

- 批：`triage-11.json`
- 差异：检索未找到「Provider 原生 merge/push 的可执行前置桥」相关断言；现有断言覆盖的是 AgentOS 控制的 spawn 闸门，不覆盖「Provider 原生动作 + 已验证可执行桥」这一条件式。按缺口记录。

### `LITE-08-004`  un-interceptable Provider-native actions are never reported as blocked; their Runs are modifying, single-writer admission applies, and unavailable enforcement is visible;

- 批：`triage-11.json`
- 差异：检索 `un-interceptable` / `never reported as blocked` 无命中；未找到「不可拦截动作不得被报告为已阻断」的断言，也未找到「不可用执行能力必须可见」的断言。按缺口记录。

### `LITE-08-012`  browser disconnect does not decide;

- 批：`triage-11.json`
- 差异：检索 `disconnect does not decide` / `disconnect.*approval` 无命中；未找到「浏览器断开不构成审批决定」的断言（断线相关的两条断言是 Run 存活与执行继续，属 00-004/02-009/13-014，不是「不代替决定」）。按缺口记录。

### `LITE-09-001`  Message-only Turns create no Task and no Run;

- 批：`triage-11.json`
- 差异：与 LITE-02-001/11-001 同一缺口：ConversationTurnDriver 的 14 条断言覆盖流式、失败、取消、快照与冻结选择，**没有**「message-only Turn 之后 Task/Run 行数不变」的运行时断言；唯一相关候选是 Composer 意图层断言（DCUX-P01），不在运行时。按缺口记录。

## 边界

## 判读推翻记录（1 条）

后一批次对同一行的复核结论覆盖前一批次（保留两方记录，不静默改写）：

- `LITE-00-010`：`triage-00.json → rejected` 被 `triage-02.json → accepted` 覆盖

本报告只记录判读结论：**未修改矩阵**（`matrix.json` / `pass-freeze.json` / `pass-evidence-audit.json` 与基线逐字节一致），未提升任何行状态，未执行 `--require-closed`。

