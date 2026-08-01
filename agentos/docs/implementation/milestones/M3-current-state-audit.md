# AgentOS M3 Current-State Audit

Status: PREPARED FOR INDEPENDENT REVIEW — DOCS-ONLY — M3 P1 NOT AUTHORIZED — PRODUCTION CUTOVER NOT AUTHORIZED

Audit date: 2026-08-01

This audit is a read-only assessment of the current repository implementation. It does not implement M3, run a migration or restore, change production data, switch a Web default, remove a compatibility path, or approve a production operation.

## 1. Scope, baseline, and evidence rules

### 1.1 Audited baseline

- Repository: `Zbyy0311/agentos`
- Intended M3 source baseline: `origin/main` at `80e398d5074ca8e0d6367d95a1aba3951b9a8843`
- Planning branch: `docs/m3-cutover-preplanning`
- The independent worktree was created from the fetched `origin/main` reference. The Git worktree root contains the application source in its `agentos/` child directory.
- `git fetch origin` succeeded.

Preflight found a local-reference mismatch that must remain visible:

- local `main` is clean at `b61aedf6f2aaacd846324d5abd452a8875579840`
- `origin/main` is `80e398d5074ca8e0d6367d95a1aba3951b9a8843`
- local `main` is an ancestor of `origin/main`, but `main != origin/main`
- local `main` was not reset, merged, fast-forwarded, or otherwise modified

The audit therefore treats the fetched `origin/main` commit as the requested frozen M3 planning baseline and records the local-main mismatch as a release-process issue. This is not evidence that local `main` is current.

### 1.2 Carried M2 boundary

The current M2.8 documents record the following prior status: M2 is `VERIFIED & MERGED / FULLY COMPLETE`, final remediation PR #16 is merged, Remote Checks are `UNAVAILABLE — NOT PASS`, Production Cutover is `NOT AUTHORIZED / NOT STARTED`, and M3 Cutover is deferred. These are carried status statements from the merged M2 documentation, not new M3 verification claims.

Relevant retained contracts:

- [M2.8 Owner Decisions](./M2.8-owner-decisions.md) keeps Legacy JSON and Legacy API active for M2, keeps the Web default unchanged, keeps `runs` and `agent_runs` separate, and defers v2 realtime.
- [M2.8 Verification and Cutover Readiness Plan](./M2.8-verification-cutover-readiness-plan.md) states that Production Cutover and physical Legacy retirement are outside M2.
- [M2.8 P5 Post-Merge Closeout](./M2.8-p5-post-merge-closeout.md) records that no production data was restored or cut over by the M2 closeout.

### 1.3 Evidence classification

This document uses four labels:

- `OBSERVED`: directly supported by the current source tree or Git state.
- `CARRIED`: a status or boundary retained from an existing merged M2 document.
- `PENDING OWNER`: a decision not determinable from code facts alone.
- `NOT EVIDENCED`: the current checkout contains no acceptable proof for the required cutover gate.

No build, test, server, migration, restore, production copy, or browser command was run for this docs-only planning task. No `SOURCE_QUIESCENT` flag was set and no process was stopped.

## 2. Current authority matrix

The repository is in a mixed-state transition. “Authority” is separated into current write authority, compatibility read authority, and durable evidence. A path being present in SQLite does not by itself prove that its legacy source can be deleted.

| Domain | Current durable representation | Current readers | Current writers | Current assessment | M3 consequence |
| --- | --- | --- | --- | --- | --- |
| Workspace | SQLite `workspaces` plus `_workspace_tombstones`; legacy `workspace/workspaces.json` remains available | `SqliteStore.loadWorkspaces()` reads SQLite first, then JSON records absent from SQLite and not tombstoned | `SqliteStore.saveWorkspaces()` writes SQLite workspace, profile, and provider rows; the standalone `JsonFileStore` can still write JSON | `OBSERVED: SQLite write authority with dual-read compatibility` | Define the exact stop-read condition, conflict policy, quarantine disposition, backup, and rollback window before retiring JSON reads |
| Agent/Profile | SQLite `agent_profiles`; effective provider binding is joined from `provider_configurations`; nested legacy agent data remains an adoption source | `SqliteStore.listAgentProfiles()` and snapshot helpers | `SqliteStore.updateAgentProfile()` and workspace adoption helpers write SQLite | `OBSERVED: SQLite current authority; legacy JSON is historical/adoption input` | Prove field-level parity and decide how unknown, duplicate, or conflicting profiles are handled |
| Provider Configuration | SQLite `provider_configurations`, linked from `agent_profiles.provider_config_id` | `ProviderConfigurationRepository` and profile joins | `WorkspaceManager`/SQLite repositories and compatibility adoption | `OBSERVED: SQLite execution configuration authority` | Freeze provider conflict and executable/model binding policy before any source retirement |
| Legacy TaskItem | `workspace/<workspaceId>/.agentos/tasks.json`, including `TaskLog[]` outputs | `SqliteStore.loadTasks()` delegates to `JsonFileStore`; Legacy Task routes and startup recovery use it | `saveTask()`/`saveTasks()` through Legacy Task routes and `taskRecovery.ts` | `OBSERVED: Legacy JSON remains the TaskItem authority` | Decide migration/retention, historical execution meaning, and stop-read/stop-write sequence; no bulk conversion is implied |
| Canonical Task | SQLite `tasks`, with optional `legacy_task_id` | `TaskRepository`, `TaskRunService`, v2 Task routes | v2 Task routes and Legacy Bridge creation | `OBSERVED: canonical authority for v2 Task-domain operations only` | Reconcile the two task populations without inventing history or silently changing the Legacy API |
| Conversation | SQLite `conversations`, `conversation_members`, `messages`, and message attachments | `ConversationService`, conversation routes, Web workspace page | Conversation create/update/message flows | `OBSERVED: SQLite Conversation authority` | Keep Conversation history and task execution history distinct while changing client defaults |
| Task-domain Run | SQLite `runs`, `run_snapshots`, and `run_stages` | `RunRepository`, `TaskRunService`, v2 Task/Run routes, Legacy Bridge | v2 Run creation/mutations and Legacy Bridge terminal reconciliation | `OBSERVED: canonical Task-domain Run authority` | Define bridge retirement and keep `runs` separate from `agent_runs` |
| Conversation Agent Run | SQLite `agent_runs` plus `run_steps`, `run_event_sequences`, and related collaboration records | `ConversationService`, Conversation `/runs` routes, Web run details | direct/group Conversation execution and recovery | `OBSERVED: separate Conversation runtime aggregate` | No automatic merge with Task-domain `runs`; future unification requires a separate owner-approved design |
| Execution | SQLite `executions` and `execution_events`, linked to Conversation and optionally `agent_runs` | Conversation routes and `SqliteStore.listExecutions()` | `ConversationService` execution lifecycle and recovery | `OBSERVED: child execution authority inside Conversation runtime` | Define active/interrupted recovery and how execution evidence survives a client or process transition |
| Event | Conversation `agent_events` with `run_event_sequences`; execution detail in `execution_events`; Legacy Task SSE frames; in-memory `RunStreamRegistry` transport buffer | EventBus consumers, Conversation routes, run detail routes, Legacy SSE clients | EventBus persists Conversation events; execution and Legacy route code emits their respective records/frames | `OBSERVED: no single durable v2 Event authority spanning Task-domain runs and Conversation agent_runs` | Freeze whether v2 Durable Events/Run stream belongs to M3; do not call the current in-memory cursor or Conversation event table a completed v2 Event Store |
| Memory | SQLite `memories`, `memory_sources`, `memory_fts`, candidates, usage, and preference records; Markdown content under `agent-memory/records/` | `MemoryService` reads metadata from SQLite and content from the recorded path | `MemoryService` atomically writes content and then persists metadata/FTS | `OBSERVED: hybrid authority; SQLite metadata plus file payload` | Keep Memory outside Legacy JSON retirement and define content/metadata backup and mismatch behavior |
| Artifact | SQLite `runtime_artifacts` metadata plus content under `.agentos/artifacts/` | `RuntimeArtifactService` and artifact routes | `RuntimeArtifactService` writes content atomically and inserts provenance metadata | `OBSERVED: hybrid authority; metadata plus content store` | Keep artifact retention and provenance separate from Legacy JSON deletion and include it in backup/restore evidence |

### 2.1 Task-domain and Conversation boundary

The current code has two intentional runtime aggregates:

1. Task-domain `Task` → `runs` → `run_snapshots`/`run_stages`, used by v2 routes and the Legacy Bridge.
2. Conversation → `agent_runs` → `executions`/`run_steps`/`agent_events`, used by direct and group Conversation execution.

`runs != agent_runs`. A Legacy Bridge Run is not a Conversation Agent Run. Conversation `run_steps`, `agent_events`, and execution history must not be counted as Task-domain Run evidence. API or Web route changes must not merge these aggregates as an incidental side effect.

## 3. Current compatibility paths

| Compatibility surface | Current implementation | Current status | Cutover risk |
| --- | --- | --- | --- |
| Workspace JSON fallback | `SqliteStore.loadWorkspaces()` calls `JsonFileStore.loadWorkspaces()` for SQLite-missing, non-tombstoned IDs | `OBSERVED: active read fallback` | A JSON record can remain visible after SQLite adoption; stop-read needs parity, conflict, tombstone, and rollback evidence |
| Legacy Task `tasks.json` | `SqliteStore.loadTasks/saveTasks/saveTask()` delegate to `JsonFileStore`; `taskRecovery.ts` also loads/saves it | `OBSERVED: active read/write authority` | Stopping it changes list/create/run/recovery behavior and can lose old TaskItem history if mapping is incomplete |
| Legacy API | `/api/workspaces/:workspaceId/tasks`, `POST /:taskId/run`, `GET /:taskId/status`, and `GET /:taskId/logs` are mounted in `index.ts` | `OBSERVED: active route family` | Existing consumers and Web still depend on the JSON-backed contract |
| Web Legacy default | `apps/web/src/lib/useTask.ts` calls `/api/workspaces/:workspaceId/tasks` for list/create; workspace page uses Conversation routes separately | `OBSERVED: no global v2 Task default switch` | A global switch changes user-visible task state, retry, refresh, cancel, and stream semantics |
| v2 Task/Run REST | `/api/workspaces/:workspaceId/v2/tasks`, `/tasks/:taskId/runs`, `/runs/:runId`, cancel, accept, and reopen routes use `TaskRunService` and SQLite repositories | `OBSERVED: active REST contract` | REST resource state does not prove a durable v2 event stream or a completed client migration |
| Legacy Task SSE | `POST /tasks/:taskId/run` emits `status`, `stage`, `thinking`, `done`, and `error` frames; request close aborts the pipeline and records cancellation | `OBSERVED: active request-bound stream` | Browser disconnect, retry, and terminal reconciliation are not the same as a durable resumable Run stream |
| Conversation stream | Conversation message/resume/GET stream routes use `RunStreamRegistry`; persisted AgentEvents are separate from the in-memory stream cursor and session buffer | `OBSERVED: active Conversation stream with process-local replay window` | A 60-second in-memory session is not durable replay after process loss and is not the v2 Task-domain stream contract |

The Legacy Task SSE, the Conversation stream, and the v2 Task/Run REST contract are distinct. The current checkout does not expose a v2 Task-domain `GET /api/runs/:runId/stream` or a durable event query under the v2 route family.

## 4. Migration registry and compatibility services

### 4.1 Registered schema

`apps/server/src/migrations/default-registry.ts` registers exactly migrations `001` through `011`. Migration `011` creates `legacy_data_migrations` and immutable `legacy_task_items` compatibility evidence for `workspaces.json` and `tasks.json`. It does not prove that all JSON has been imported, that all TaskItems have canonical history, or that source files can be deleted.

`MigrationRunner` records checksums in `_schema_migrations`, adopts compatible legacy databases, applies pending migrations transactionally, and asserts integrity. `SqliteStore` invokes the runner during construction and then performs legacy execution and workspace adoption helpers. This is startup migration/adoption behavior, not a Production Cutover controller.

### 4.2 Existing safety mechanisms

- `WorkspaceCompatibilityMigrationService` supports `dry-run` and `apply`, source hashing, path/symlink checks, classification, backup-before-apply, and durable migration outcomes.
- `LegacyTaskItemImportService` supports `dry-run` and `apply`, workspace-scoped source validation, source hashing, backup-before-apply, and append-only compatibility snapshots.
- `LegacyBackupVerifier` creates and verifies SQLite and exact-byte JSON backups. It does not restore and does not modify the source.
- `LegacyMigrationExecutionLock` coordinates project ownership and database-wide migration ownership.

These mechanisms reduce operational risk, but `NOT EVIDENCED` in the current implementation is a production Restore workflow, a downgrade controller, a production operator gate, source quiescence proof, process ownership proof for a live cutover, and post-cutover observation evidence.

### 4.3 Migration 012 finding

The current audit does not authorize or recommend creating Migration 012. The v2 Durable Event question is a contract and architecture gap, but it is not yet a proven schema gap because the M3 event scope, retention, query, and relationship to `runs` have not been owner-approved. Migration 012 may be proposed only if a later contract-closure review produces a schema diff showing that the required M3 invariant cannot be represented by registry `001`–`011`. A speculative migration is forbidden.

## 5. Cutover work still outstanding

| Work item | Current finding | Required evidence before authorization |
| --- | --- | --- |
| Legacy JSON authority retirement | `NOT EVIDENCED`; Workspace has dual-read and Legacy Task still reads/writes JSON | writer/read inventory, parity thresholds, quarantine policy, stop-read/stop-write order, backup and rollback |
| Legacy API retirement | `NOT EVIDENCED`; route family is mounted and used by Web | consumer inventory, deprecation period, API contract replacement, no-caller telemetry, removal review |
| Web default switch | `NOT EVIDENCED`; `useTask` still uses Legacy Task endpoints | browser/API contract matrix, user-visible acceptance, feature flag and rollback |
| Task-domain runtime authority transition | `NOT EVIDENCED`; bridge is per-execution and not a completed bulk TaskItem conversion | legacy ID mapping, no-history-synthesis proof, active-run treatment, cohort reconciliation |
| `runs` versus `agent_runs` boundary | `OBSERVED: separate`; future unification remains unresolved | owner decision; no incidental merge during API/Web transition |
| v2 realtime / Durable Events | `NOT EVIDENCED` for Task-domain v2; current v2 is REST-only | owner decision on M3 scope, event contract, persistence, replay, retention, consumer, and schema trigger |
| Rollback and downgrade | `NOT EVIDENCED` for production; backup verifier is not Restore | tested reversible boundary, downgrade compatibility, operator authority, stop and abort procedure |
| Production backup and operator gate | backup verification exists, production authorization does not | copy binding, exact-byte/hash manifest, retention, signed gate, access control |
| Source quiescence and process ownership | lock infrastructure exists; no current production cutover proof | no-new-work proof, active/interrupted inventory, process ownership, release of ownership |
| Post-cutover verification | `NOT EVIDENCED` | telemetry, read comparison, error budget, observation window, incident and rollback thresholds |
| Legacy data deletion | not performed and not automatically implied | separate owner-approved destructive-operation gate after stable observation |

## 6. M2 / M3 / post-M3 separation

### 6.1 Capabilities carried as M2 evidence

The merged M2 documents carry evidence for SQLite-first Workspace writes, legacy compatibility retention, canonical Task/Run repositories, Conversation runtime persistence, migration registry `001`–`011`, backup and isolated rehearsal evidence, current Legacy/v2 REST/Conversation compatibility, and separate `runs`/`agent_runs` aggregates. This audit does not re-run or upgrade those claims.

### 6.2 Work that M3 must decide or execute later

M3 must first close authority and Owner Decisions, refresh readers/writers and consumers, validate backup/copy/rehearsal gates, define a reversible controlled transition, authorize any production cohort, execute only the authorized transition, observe it, and only then consider Legacy retirement. The implementation plan separates those stages and leaves their execution unauthorized in this branch.

### 6.3 Work that should remain after M3 or outside this scope

Unless a separate Owner Decision explicitly brings it into M3, Task/Conversation aggregate unification, broad runtime redesign, speculative schema expansion, and any new product behavior beyond the approved cutover contract remain later work. Physical deletion of Legacy data is never automatically coupled to a successful cutover.

### 6.4 Not required or forbidden in this P0 task

- No production code, API, Web, runtime, test, package, database, registry, or migration file changes.
- No Migration 012 creation.
- No real migration, production restore, destructive operation, or user-data copy.
- No production server/Web startup, `SOURCE_QUIESCENT` setting, or process termination.
- No M3 P1 execution, PR creation, or merge outside the single docs-only commit required by the objective.

## 7. Audit conclusion

The current baseline is ready for Owner Decision drafting, not for M3 implementation or Production Cutover. The highest-risk facts are the still-active JSON/Legacy Task authority, the Web Legacy default, the separate Task and Conversation runtime aggregates, the lack of a Task-domain durable v2 Event/stream contract, and the absence of a production Restore/operator gate.

The M3 planning branch must remain `DOCS-ONLY` and `PENDING INDEPENDENT REVIEW`. `M3 P1 NOT AUTHORIZED`. `PRODUCTION CUTOVER NOT AUTHORIZED`. `PRODUCTION DATA UNCHANGED`.

## 8. Evidence index

### Existing contracts

- `docs/implementation/milestones/M2.8-owner-decisions.md`
- `docs/implementation/milestones/M2.8-verification-cutover-readiness-plan.md`
- `docs/implementation/milestones/M2.8-p5-post-merge-closeout.md`
- `docs/implementation/migration-register.md`
- `docs/Runtime-Specification/02-Runtime-Lifecycle.md`
- `docs/Runtime-Specification/03-Event-Model.md`
- `docs/Runtime-Specification/09-Conversation-Runtime.md`
- `docs/Runtime-Specification/10-Data-Model.md`
- `docs/Runtime-Specification/11-API-Specification.md`
- `docs/Runtime-Specification/14-Roadmap.md`

### Current implementation

- `apps/server/src/store/SqliteStore.ts`
- `apps/server/src/store/JsonFileStore.ts`
- `apps/server/src/store/WorkspaceRepository.ts`
- `apps/server/src/store/ProviderConfigurationRepository.ts`
- `apps/server/src/store/TaskRepository.ts`
- `apps/server/src/store/RunRepository.ts`
- `apps/server/src/store/LegacyTaskItemRepository.ts`
- `apps/server/src/store/LegacyDataMigrationRepository.ts`
- `apps/server/src/migrations/default-registry.ts`
- `apps/server/src/migrations/MigrationRunner.ts`
- `apps/server/src/migrations/migrations/011-legacy-data-migration-foundation.ts`
- `apps/server/src/services/WorkspaceCompatibilityMigrationService.ts`
- `apps/server/src/services/LegacyTaskItemImportService.ts`
- `apps/server/src/services/LegacyBackupVerifier.ts`
- `apps/server/src/services/LegacyMigrationExecutionLock.ts`
- `apps/server/src/services/TaskRunService.ts`
- `apps/server/src/services/ConversationService.ts`
- `apps/server/src/services/RunStreamRegistry.ts`
- `apps/server/src/routes/tasks.ts`
- `apps/server/src/routes/v2Tasks.ts`
- `apps/server/src/routes/v2Runs.ts`
- `apps/server/src/routes/conversations.ts`
- `apps/server/src/routes/runs.ts`
- `apps/server/src/taskRecovery.ts`
- `apps/server/src/runRecovery.ts`
- `apps/web/src/lib/useTask.ts`
- `apps/web/src/app/workspace/[id]/page.tsx`

### Git evidence

- fetched `origin/main`: `80e398d5074ca8e0d6367d95a1aba3951b9a8843`
- untouched local `main`: `b61aedf6f2aaacd846324d5abd452a8875579840`
- current planning branch source: fetched `origin/main`
