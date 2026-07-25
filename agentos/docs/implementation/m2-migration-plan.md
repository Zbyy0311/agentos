# M2 — Storage and Domain Core — Implementation Plan

> **Milestone:** M2
> **Status:** M2.1 VERIFIED & MERGED — `b4613b2a`; M2.2 VERIFIED & MERGED — `0075d36e`; M2.3 VERIFIED & MERGED — `ab1fa905`; M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW; M2.5 NOT STARTED
> **Date:** 2026-07-21
> **Repository:** `Zbyy0311/agentos`
> **Branch:** `runtime/m2-3-workspace-agent-provider` (active M2.3 work), based on merged main@`0075d36e`
> **Reference:** docs/Runtime-Specification/10-Data-Model.md, 01-Core-Concepts.md

---

## Current Implementation Status (2026-07-22)

| Package | Status | Evidence / active branch |
|---|---|---|
| M2.1 | VERIFIED & MERGED | `b4613b2a` |
| M2.2 | VERIFIED & MERGED | `0075d36e` / merged main baseline |
| M2.3 | VERIFIED & MERGED — `ab1fa905` | `runtime/m2-3-workspace-agent-provider`, verified implementation `236fcc79`, original reviewed head `5dc0e47e`, remediation code `9def4f15` (provider API input validation), final remediation review head `c9c851c8`, PR #2 MERGED at 2026-07-22T16:30:20Z, source head `ca541c8a` |
| M2.4 | IMPLEMENTED — PENDING PR REMEDIATION REVIEW | `runtime/m2-4-task-run-separation`, report `docs/implementation/milestones/M2.4-task-run-separation-report.md`; Reviewed Head `efcf7b8c`; Remediation Code `8b2ff01f`; targeted 139/139 in 7 files (`3787.9554ms`); Server 437/437 (`41043.7068ms`); Agent Core 123/123; Build PASS; Scope Audit PASS; Remote CI unavailable; PR #3 OPEN; merge not authorized; M2.5 not started |

> **M2.4 Owner-approved scope exception（2026-07-23）:** `apps/server/src/store/SqliteStore.test.ts` — migration_id expected list `001–004` → `001–006` only（required expectation synchronization after registering Migration 005/006）; no other existing test modified; test semantics and verification strength unchanged.

> **M2.4 PR Review Remediation（2026-07-24）：** Owner Decision 采用 explicit retry reconciliation；代码提交 `8b2ff01f`；恢复依据为持久化 Legacy JSON terminal status；新增 R10–R16；定向 139/139、Server 437/437、Agent Core 123/123、Build、diff check 与 Scope Audit 均通过。无 Migration 007、startup recovery 或 v2 running cancel API；Remote CI unavailable；M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW；PR #3 OPEN；不得合并；M2.5 未启动。

M2.3 is verified (Server 298/298, Agent Core 123/123, local runs; Remote CI unavailable) and was merged to `main` via PR #2 merge commit `ab1fa905` at 2026-07-22T16:30:20Z (source head `ca541c8a`).

## Current M2.4 Queued Recovery Update (2026-07-24)

PR #3 now contains queued Legacy Bridge startup recovery on code commit `59f982d5` (`fix(runtime): recover orphaned legacy queued runs on startup`). The Owner decision is startup orphan reconciliation: only `legacy_pipeline` queued Runs are recovered after a server restart; queued `v2_api` Runs and running Legacy Runs remain untouched. The implementation uses `BRIDGE_PRESTART_INTERRUPTED`, preserves Task pending acceptance windows, fails closed on transaction errors, and does not modify schema, `runRecovery.ts`, v2 APIs, or M2.5.

Evidence after implementation: taskRecovery 9/9, M2.4 seven-file targeted 140/140, Server 446/446, Agent Core 123/123, Build PASS, diff check PASS. PR #3 remains OPEN and unmerged; Auto Merge is disabled, merge is unauthorized, Remote CI is unavailable, and M2.5 is NOT STARTED. The exit gate remains `M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW`.

---

## 1. M2 Objective

**Converge the current persistence layer** into a canonical Storage and Domain Core that provides:

1. Single SQLite-based storage (retire JSON files)
2. v2-aligned domain types with proper ID prefix convention
3. Version-based optimistic concurrency
4. Idempotency key support for critical operations
5. Structured, reversible database migrations
6. Task/Run separation at the data level
7. Agent + Provider Configuration separation at the data level
8. Immutable snapshots for historical fidelity
9. v1 read compatibility layer during migration

---

## 2. M2 Work Packages

### M2.0 — Existing Schema Inventory
*Already completed as part of M2 planning.*

**Goal:** Document all current tables, columns, relations, and migration logic.

**Deliverable:** `docs/implementation/schema-inventory.md`
**Status:** ✅ Complete in this planning phase

---

### M2.1 — Migration Runner and SQLite Foundation

**Goal:** Build structured migration infrastructure before any schema change.

#### Domain Types
- `MigrationRecord` — tracks applied migrations:
  migrationId, name, checksum, appliedAt, executionMs, appVersion?

#### Schema Changes
- Create `_schema_migrations` table (authoritative migration tracking):

```sql
CREATE TABLE _schema_migrations (
  migration_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  execution_ms INTEGER NOT NULL,
  app_version TEXT
);
```

- Optionally sync `PRAGMA user_version` as secondary indicator, not sole source of truth
- No existing table changes yet

#### Existing Files
- `apps/server/src/store/SqliteStore.ts` — all schema creation and migration logic

#### New Files
- `apps/server/src/migrations/MigrationRunner.ts` — version-aware migration runner
- `apps/server/src/migrations/v001-initial-schema.sql` or .ts
- `apps/server/src/migrations/v002-add-versions.sql` (future)
- `apps/server/src/migrations/utils.ts` — backup, integrity check helpers

#### Files Modified
- `apps/server/src/store/SqliteStore.ts` — reduce `migrateSchema()` to invoke MigrationRunner
- `apps/server/src/index.ts` — pass MigrationRunner to SqliteStore constructor

#### API Impact
- None — no endpoint changes

#### Compatibility Impact
- Existing `migrateSchema()` must continue to work unchanged for legacy path
- MigrationRunner is additive; `migrateSchema()` is progressively migrated one table at a time
- Legacy adoption (non-empty database discovered at startup) uses **strict structural verification**:
  1. Inspect existing tables, columns, and indexes
  2. Compare against known legacy baseline schema
  3. **Exact match** → adopt as base and record baseline migration
  4. **Mismatch** → stop with diagnostic report; do NOT blindly mark latest migration as applied
  5. Unknown or corrupted schema is never silently accepted
- All existing IF NOT EXISTS / ensureColumn calls remain until formally migrated

#### Tests
- MigrationRunner unit tests (apply, skip already-applied, detect checksum mismatch)
- Migration from scratch creates expected schema
- Migration on existing legacy database via strict structural verification
- Migration failure rollback (transaction-level: failure before commit rolls back DDL + _schema_migrations record)
- Backup is created before destructive changes

#### Dependencies
- None — can start immediately

#### Risks
- **Medium** — Blast radius: server startup and schema initialization
- Touches `SqliteStore.migrateSchema()` which currently creates all 25 tables; a migration runner bug could prevent database initialization
- Legacy adoption (detecting existing DB and verifying its structure) requires precise inspection of 25 tables, columns, and indexes
- Unknown or corrupted schemas must be detected and rejected, not silently adopted
- Risk is mitigated by: additive design, strict structural verification, integrity_check after migration, rollback support, and backup before destructive changes

#### Out of Scope
- Rolling back data migrations
- Automated migration generation

#### Exit Gate
- `_schema_migrations` table exists and is populated
- All existing tables can be recreated via MigrationRunner
- Fresh database: empty → `_schema_migrations` → baseline migration → schema created
- Legacy database: strict structural verification → adopt baseline → continue
- Unknown or mismatched schema: diagnostic report, not silent adoption
- MigrationRunner tests pass (apply, rollback, detect already-applied, legacy adoption)
- `PRAGMA integrity_check` and `PRAGMA foreign_key_check` pass after migration

#### Recommended Branch
- `runtime/m2-1-migration-foundation` (historical implementation; merged as `b4613b2a`)

#### Recommended Worktree
- Required — dedicated worktree at `E:\workspace\Multi-Agent-worktrees\agentos-m2-1`

#### Integration Order
- 1/8 — must be first to enable all other schema changes

---

### M2.2 — Canonical Identity, Version and Repository

**Goal:** Establish ID generation, version column convention, transaction helper, and base repository pattern.

#### Domain Types
- ID prefix constants and generation utility
- `WithVersion` — `{ version: number }` interface for mutable aggregates
- Transaction helper — `inTransaction<T>(fn: () => T): T`

#### Schema Changes
- Add `version INTEGER NOT NULL DEFAULT 1` to: `agent_profiles`, `conversations`, `agent_runs`
- Add unique `_id_prefixes` documentation (no schema change needed)

#### Existing Files
- `apps/server/src/store/SqliteStore.ts` — add version columns via ensureColumn
- `apps/server/src/store/Store.ts` — may extend interface

#### New Files
- `apps/server/src/store/Identity.ts` — ID generation with prefixes
- `apps/server/src/store/Version.ts` — version constants and helper
- `apps/server/src/store/Transaction.ts` — transaction helper
- `apps/server/src/store/Repository.ts` — base repository interface (optional, guide)

#### Files Modified
- `apps/server/src/store/SqliteStore.ts` — add version columns, use transaction helper

#### API Impact
- None — version not exposed through API yet

#### Compatibility Impact
- New columns have defaults — existing records get version=1
- No read/write behavior change

#### Tests
- ID generation with correct prefix
- Version increment on update
- Transaction commit/rollback
- Concurrent update with version check

#### Dependencies
- M2.1 (needs migration runner to add version columns)

#### Risks
- Low — additive columns with defaults

#### Out of Scope
- Optimistic concurrency enforcement in API calls

#### Exit Gate
- Version columns exist on mutable aggregates
- ID utility produces correctly prefixed IDs
- Transaction helper is tested and used in at least one write path

#### Recommended Branch
- `runtime/m2-2-identity-version-repository` (historical implementation; merged as `0075d36e`)

#### Integration Order
- 2/8 — foundational for all subsequent work

---

### M2.3 — Workspace, Agent Profile and Provider Configuration

**Goal:** Move workspace metadata from JSON to SQLite, separate Agent Profile from Provider Configuration.

**Current status:** VERIFIED & MERGED — `ab1fa905`. Merged branch:
`runtime/m2-3-workspace-agent-provider`. Original reviewed head `5dc0e47e`; Provider API
remediation code `9def4f15`; final remediation review head `c9c851c8`; PR #2 MERGED at
2026-07-22T16:30:20Z, source head `ca541c8a`. Final scope cleanup is recorded in `236fcc79`.

#### Domain Types (new or modified in shared)
- `Workspace` — add SQLite-backed fields, remove `agents` array
- `ProviderConfiguration` — new type per v2 spec
- `AgentProfile` — simplify to v2 spec, reference providerConfigId instead of cliCommand/cliArgs

#### Schema Changes
- Create `workspaces` table in SQLite
- Create `provider_configurations` table
- Modify `agent_profiles` — add `provider_config_id TEXT`, remove or deprecate `cli_command`, `cli_args_json`, `provider` (direct type)

#### Existing Files
- `apps/server/src/store/JsonFileStore.ts` — workspaces.json will be retired
- `apps/server/src/store/SqliteStore.ts` — workspace methods, agent_profiles
- `apps/server/src/store/Store.ts` — workspace interface
- `packages/shared/src/types/index.ts` — Workspace, WorkspaceAgent, AgentProfile types

#### New Files
- `packages/shared/src/types/provider-config.ts` or extend types/index.ts
- `apps/server/src/migrations/v002-workspace-table.sql`
- `apps/server/src/migrations/v003-provider-configuration.sql`

#### Files Modified
- `apps/server/src/store/SqliteStore.ts` — add workspace table CRUD
- `apps/server/src/store/Store.ts` — extend with workspace CRUD
- `apps/server/src/managers/WorkspaceManager.ts` — may need to update source
- `apps/server/src/index.ts` — remove JsonFileStore dependency for workspaces

#### API Impact
- Workspace CRUD endpoints now backed by SQLite
- New `GET/POST /api/provider-configurations` endpoints
- Agent profile response changes shape

#### Compatibility Impact
- Workspace read operations must check SQLite first, fall back to JSON
- On first write, migrate workspace from JSON to SQLite
- Agent profile responses include both old fields (cliCommand, cliArgs) and new (providerConfigId) during transition

#### Tests
- Workspace CRUD in SQLite
- Migration from JSON to SQLite
- Agent Profile + Provider Configuration separation
- Backward compatible reads

#### Dependencies
- M2.1, M2.2

#### Risks
- Medium — workspace JSON has complex agents array that must be mapped to agent_profiles
- WorkspaceManager currently reads agents from Workspace.agents; after separation, reads must consult agent_profiles

#### Out of Scope
- Provider Configuration validation
- Provider Adapter integration

#### Exit Gate
- Workspace data stored and readable from SQLite
- Provider configurations can be created, read, updated
- Agent profiles reference provider configurations
- JSON file writes stopped for workspaces
- All existing tests still pass with JSON+SQLite dual read

#### Recommended Branch
- `m2/workspace-agent-provider`

#### Integration Order
- 3/8 — unblocks task/run separation

---

### M2.4 — Task and Run Separation

**Goal:** Separate Task (intent) from Run (execution attempt) at data model level while preserving the Legacy API and keeping Conversation Runs separate.

#### Domain Types
- `Task` — v2 type: `id`, `workspaceId`, `title`, `description`, `status: open|in_progress|blocked|done|cancelled`, `priority`, `createdBy`, `assignedAgentId`, sourceConversationId, sourceMessageId, `acceptedRunId`, `pendingResultRunId`, timestamps, version
- `Run` — canonical Task Run with `taskId`, `parentRunId`, `rootRunId`, `failureCode`, `failureMessage`, `reason`, `origin`, lifecycle status and version. TypeScript uses `failureCode`/`failureMessage`; DDL uses `failure_code`/`failure_message`.

#### Schema Changes
- Create `tasks` table in Migration 005 and `runs` table in Migration 006; do not extend `agent_runs`.
- `tasks.workspace_id` cascades on Workspace deletion and has `UNIQUE(id, workspace_id)` for the composite FK; nullable `pending_result_run_id` persists the current acceptance window and has no FK.
- `runs` cascades on Workspace/Task deletion and uses `(task_id, workspace_id)`, `(parent_run_id, task_id)` and `(root_run_id, task_id)` FKs; real `node:sqlite` tests must prove cross-scope rejection, self-root INSERT, cascades and `foreign_key_check`.
- Keep existing `TaskItem` in JSON until full migration; keep `agent_runs` as the Conversation Run table.

#### Existing Files
- `packages/shared/src/types/index.ts` — TaskItem, AgentRun, TaskStatus
- `apps/server/src/store/SqliteStore.ts` — agent_runs CRUD
- `apps/server/src/store/JsonFileStore.ts` — tasks.json storage (retain during transition)
- `apps/server/src/routes/tasks.ts` — Legacy REST/SSE endpoints; Legacy URL、挂载点、请求响应、SSE payload 和 JSON 数据契约不变，内部只追加计划冻结的 Bridge 持久化逻辑
- `apps/server/src/routes/taskPipeline.ts` — pipeline logic
- `apps/server/src/routes/runs.ts` — existing Conversation Run reader; no M2.4 change

#### New Files
- `apps/server/src/migrations/migrations/005-tasks-table.ts`
- `apps/server/src/migrations/migrations/006-runs-table.ts`
- `apps/server/src/store/TaskRepository.ts`
- `apps/server/src/store/RunRepository.ts`
- `apps/server/src/services/TaskRunService.ts`
- `apps/server/src/routes/v2Tasks.ts`
- `apps/server/src/routes/v2Runs.ts`
- `apps/server/src/routes/taskRunBridge.ts`
- `apps/server/src/migrations/__tests__/m2-4-task-run-schema.test.ts`
- `apps/server/src/store/__tests__/TaskRepository.test.ts`
- `apps/server/src/store/__tests__/RunRepository.test.ts`
- `apps/server/src/services/__tests__/TaskRunService.test.ts`
- `apps/server/src/routes/v2Tasks.test.ts`
- `apps/server/src/routes/v2Runs.test.ts`
- `apps/server/src/routes/taskPipelineBridge.test.ts`

#### Files Modified
- `packages/shared/src/types/index.ts` — append v2 Task/Run types; existing TaskItem/AgentRun unchanged
- `apps/server/src/migrations/default-registry.ts` — register 005/006
- `apps/server/src/store/SqliteStore.ts` — expose the two repositories; existing legacy and Conversation methods unchanged
- `apps/server/src/routes/tasks.ts` — Legacy contract unchanged; append only the frozen Bridge persistence logic
- `apps/server/src/index.ts` — mount v2 routes under `/api/workspaces/:workspaceId/v2`; Legacy mount unchanged
- `apps/server/src/routes/runs.ts` — **not modified**

#### API Impact
- Legacy paths remain exactly:
  - `/api/workspaces/:workspaceId/tasks`
  - `/api/workspaces/:workspaceId/tasks/:taskId/run`
  - `/api/workspaces/:workspaceId/tasks/:taskId/status`
  - `/api/workspaces/:workspaceId/tasks/:taskId/logs`
- v2 paths all use `/api/workspaces/:workspaceId/v2`:
  - `/tasks`, `/tasks/:taskId`, `/tasks/:taskId/runs`, `/tasks/:taskId/accept`, `/tasks/:taskId/cancel`, `/tasks/:taskId/reopen`
  - `/runs/:runId`, `/runs/:runId/cancel`
- v2 POST runs creates durable `queued` Run only; it does not trigger AgentRunner, background execution or recovery.
- GET/LIST v2 routes may call a single Repository after WorkspaceManager validation; all mutation, state transition, accept/cancel/reopen, Bridge and cross-Aggregate operations call TaskRunService, with no direct Repository composition or versioned UPDATE in routes.

#### Compatibility Impact
- v1 `TaskItem` continues to work via JSON store
- v2 Task/Run and v1 TaskItem coexist with explicit ownership boundaries
- Legacy pipeline execution appends a v2 Bridge record without changing the Legacy URL, mount, request/response, SSE payload or JSON data contract; queued→running is the only point that advances Task to `in_progress`
- Completed Run writes `pendingResultRunId`; `resolveTaskAfterRunTerminal(task, terminalRun)` is the single terminal reconciliation rule for queued cancel、claim failure、Bridge failure/cancellation and terminal JSON-save compensation: pending preserves `in_progress`/pointer/accepted/completed fields, while no pending and no active Run returns Task to `open`; `cancelTask` clears pending without touching historical Runs and, for its non-done target, writes accepted/completed fields as null; reopen clears all three fields and historical completed Runs never reopen the window.
- `agent_runs` and `runs` are not merged; existing `/api/workspaces/:id/runs/:runId` remains read-only against `agent_runs`
- `apps/web` is unchanged

#### Tests
- Revised plan matrix: **121** explicit new tests; Existing Server baseline **298**, planned total `298 + 121 = 419`, with final implementation report required to use actual counts.
- Schema: workspace/task cascades, composite FK rejection, parent/root same-Task rejection, initial self-root INSERT and `foreign_key_check` in real `node:sqlite`.
- Migration rollback, all schema columns/CHECKs, `integrity_check`, and partial unique indexes are separate assertions.
- TaskRepository: ID/roundtrip, Legacy mapping, workspace uniqueness, list filters, stable `updated_at DESC, id ASC`, version guards, illegal transitions, pure Task-only `accept` write and reopen cleanup; it never reads or validates Run.
- RunRepository: ID/parent/root/retry/review-fix, active uniqueness, transitions, failure/cancel fields, terminal guards, version/concurrency and stable `created_at ASC, id ASC` ordering.
- Service: queued semantics, Bridge start/terminal transitions, acceptance, blocked/done guards, active Run guard, cross-workspace rejection and persisted pending acceptance window; `TaskRunService.acceptRun` owns all Run completion/ownership/active/window checks before calling TaskRepository.accept.
- `createLegacyRunForBridge`: single-transaction find-or-create/latest-run/retry contract and concurrent duplicate protection; `compensateLegacyClaimFailure` reads Task → invokes dedicated `failQueuedBridgeClaim` → invokes unified terminal reconciliation → commits and rethrows the original JSON error; generic queued→failed is rejected.
- State closure: completed→pending, retry failure/cancellation and queued cancellation preservation, earlier completed acceptance, cancelTask/reopen cleanup and post-reopen running re-entry; no historical completed Run scan may restore pending.
- T109-T110 prove dedicated queued claim failure versus generic rejection; T111-T121 prove persisted acceptance-window, terminal reconciliation and cancel cleanup semantics.
- Bridge/API/persistence: JSON compensation, original Legacy URLs, `/v2` prefix, queued cancel, `RUN_NOT_CANCELLABLE`, unchanged legacy `runs.ts`, reopen persistence and deterministic `findLatestByTask` ordering.

#### Dependencies
- M2.3 (workspace SQLite needed for task workspace reference)

#### Risks
- HIGH — Task/Run separation is the most impactful change to the core data model
- All existing pipeline code reads and writes TaskItem.outputs — must add compatibility layer
- Composite self-FK behavior must be proved by real SQLite before implementation; if invalid, keep the plan pending and propose an explicit alternative
- JSON/SQLite Bridge compensation must not leave an active Run or a Task state that disagrees with its pending acceptance window

#### Out of Scope
- Pipeline refactoring (AgentRunner stays unchanged)
- Workflow Definition integration
- Snapshot creation
- Legacy URL/mount changes, `apps/web`, existing `runs.ts`, ConversationService, RunStepService, existing tests, and M2.5
- v2 background execution, recovery scanning and ProcessManager integration

#### Exit Gate
- All OD-1~OD-5 decisions recorded and final Plan Review passed before implementation
- Database proves Workspace/Task cascade and composite FK scope invariants in real SQLite
- TaskRunService owns all cross-Repository transactions and state guards
- v2 queued Run cancel and Legacy Bridge compensation all use unified terminal reconciliation; no-pending and pending outcomes match the revised plan
- Legacy URLs, `runs.ts`, `apps/web` and existing tests remain unchanged
- Final report records current remediation evidence: Server 437/437, targeted 139/139, Agent Core 123/123, Build PASS and `git diff --check` PASS; Remote CI unavailable

#### Verification Closure (2026-07-24)

- Final remediation review: **APPROVED**；BLOCKER 0 / HIGH 0 / MEDIUM 0 / LOW 0。
- Final remediation head: `38448dd6`；remediation code: `615a53a9`；remediation documentation: `cd3696b6`。
- M2.4 targeted tests: 7 files, 139/139 passed, `3787.9554ms`（R10–R16 included）。
- Server full suite: one remediation run, 437/437 passed, `41043.7068ms`。
- Agent Core: 123/123；Build: PASS；diff check: PASS；Scope Audit: PASS。
- Remote CI unavailable；M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW；PR #3 open；merge not authorized；M2.5 not started。

#### Recommended Branch
- `runtime/m2-4-task-run-separation`

#### Integration Order
- 4/8 — core domain change

---

### M2.5 — Stage, Workflow Snapshot and Runtime Snapshot

**Goal:** Begin freezing immutable snapshots at Run creation time, align stage model with v2.

#### Domain Types
- `RunStage` — enhanced from `RunStep`: add `workflowStageKey`, `agentSnapshotJson`, `providerSnapshotJson`
- `WorkflowDefinition` — new type: `id`, `name`, `version`, `stages[]`, timestamps
- `AgentSnapshot` — `{ agentId, name, role, systemPrompt, capabilities, providerConfigId }`
- `ProviderConfigurationSnapshot` — `{ providerConfigId, name, providerType, executable?, argsTemplate?, model?, capabilities }`

#### Schema Changes
- Create `workflow_definitions` table
- Create `run_snapshots` table or add `snapshot_json` columns to agent_runs
- Add to `run_steps`: `workflow_stage_key TEXT`, `agent_snapshot_json TEXT`, `provider_snapshot_json TEXT`
- Add to `agent_runs`: `agent_snapshot_json TEXT`, `provider_snapshot_json TEXT`, `workflow_snapshot_json TEXT`, `workflow_definition_id TEXT`

#### Existing Files
- `packages/shared/src/types/index.ts` — RunStep, AgentRun types
- `apps/server/src/store/SqliteStore.ts` — run_steps CRUD, agent_runs CRUD
- `apps/server/src/services/RunStepService.ts` — step lifecycle

#### New Files
- `apps/server/src/migrations/v006-workflow-definitions.sql`
- `apps/server/src/migrations/v007-snapshot-columns.sql`
- `apps/server/src/services/SnapshotService.ts` — snapshot creation utility

#### Files Modified
- `apps/server/src/store/SqliteStore.ts` — snapshot CRUD, run_steps enhancement
- `apps/server/src/routes/runs.ts` — return snapshots in run details
- `apps/server/src/services/RunStepService.ts` — populate snapshot data

#### API Impact
- Run creation stores snapshot automatically
- Run detail response includes snapshot data

#### Compatibility Impact
- Snapshot columns are nullable — existing runs get null snapshots
- New runs automatically get snapshot at creation time (before execution)
- `run_steps.workflow_stage_key` is a string, not fixed union — progressive adoption

#### Tests
- Snapshot is created at Run creation time
- Snapshot is immutable after creation
- Agent profile change after Run creation does not affect snapshot
- Provider config change after Run creation does not affect snapshot
- Existing runs return null for snapshot fields

#### Dependencies
- M2.4 (needs Task/Run separation)

#### Risks
- Medium — snapshots are additive; hardest part is deciding WHAT to snapshot
- Must avoid circular dependencies (snapshot references ProviderConfiguration which references...)

#### Out of Scope
- Workflow Definition execution — just the data model and snapshot
- Policy snapshot — wait for Policy Runtime

#### Exit Gate
- Run snapshots stored and returnable via API
- Snapshot tests pass
- Existing runs backward compatible

#### Recommended Branch
- `m2/snapshots`

#### Integration Order
- 5/8 — depends on Task/Run separation

---

### M2.6 — Idempotency and Optimistic Concurrency

**Goal:** Add idempotency key support and version-based optimistic concurrency to critical operations.

#### Domain Types
- `IdempotencyRecord` — `{ idempotencyKey, operation, ownerId, resultJson, createdAt, expiresAt }`
- Update existing types with `version` field

#### Schema Changes
- Create `idempotency_records` table
- Version columns already added in M2.2
- Add `UNIQUE(idempotency_key, operation)` constraint

#### Existing Files
- `apps/server/src/store/SqliteStore.ts` — all mutation methods
- `apps/server/src/routes/tasks.ts` — run creation
- `apps/server/src/routes/runs.ts` — cancel, retry
- `apps/server/src/routes/approvals.ts` — approve/reject

#### New Files
- `apps/server/src/services/IdempotencyService.ts`
- `apps/server/src/migrations/v008-idempotency-records.sql`
- `apps/server/src/store/OptimisticLock.ts` — version guard helper

#### Files Modified
- `apps/server/src/store/SqliteStore.ts` — use version in UPDATE WHERE clauses
- `apps/server/src/routes/tasks.ts` — add idempotency key to create/run
- `apps/server/src/routes/runs.ts` — add idempotency key to cancel
- `apps/server/src/routes/approvals.ts` — add idempotency key to approve
- `apps/server/src/services/RunStepService.ts` — version check on step transitions

#### API Impact
- `POST /api/tasks` accepts `Idempotency-Key` header or body field
- `POST /api/tasks/:taskId/runs` accepts idempotency key
- `POST /api/runs/:runId/cancel` accepts idempotency key
- `POST /api/approvals/:id/resolve` accepts idempotency key
- 409 Conflict when version mismatch

#### Compatibility Impact
- Idempotency key is OPTIONAL — existing callers unaffected
- Version is managed internally — API consumers not affected

#### Tests
- Idempotent Create Task (same key → same result, no duplicate)
- Idempotent Cancel Run
- Idempotent Approval decision
- Version conflict detection
- Version increment on each state transition
- Concurrent updates produce one winner

#### Dependencies
- M2.2 (version infrastructure already in place)

#### Risks
- Medium — adding version check to all mutation paths is broad
- Must ensure no existing caller breaks due to version errors

#### Out of Scope
- Distributed idempotency (single-node only for M2)
- Idempotency key expiration/cleanup

#### Exit Gate
- Idempotency key accepted on create task, create run, cancel run, resolve approval
- Duplicate key returns existing result
- Version guard in place on at least 3 mutation paths
- All tests pass

#### Recommended Branch
- `m2/idempotency-concurrency`

#### Integration Order
- 6/8 — after core types settled

---

### M2.7 — v1 Compatibility Read and Data Migration

**Goal:** Ensure all existing v1 data is readable through the new schema during transition.

#### Tasks
1. Migrate workspace JSON → SQLite workspaces table
2. Migrate tasks JSON → SQLite tasks table
3. Create Run records for existing TaskItem executions
4. Add compatibility views/queries for frontend reading both old and new
5. Add `SqliteStore.ensureWorkspaceMigrated()` check

#### Existing Files
- `apps/server/src/store/JsonFileStore.ts` — reads to be replaced with SQLite reads
- `apps/server/src/store/SqliteStore.ts` — dual read paths
- `apps/server/src/managers/WorkspaceManager.ts` — currently reads from JSON

#### New Files
- `apps/server/src/migrations/data-v001-migrate-workspaces.ts`
- `apps/server/src/migrations/data-v002-migrate-tasks.ts`

#### Files Modified
- `apps/server/src/store/SqliteStore.ts` — stop delegating to JSON
- `apps/server/src/index.ts` — cleanup JSON initialization

#### Compatibility Impact
- On first boot after migration, all workspace data moves to SQLite
- Tasks.json data moves to SQLite tasks table
- Old JSON files are preserved but no longer read
- If migration fails, system falls back to JSON reads

#### Tests
- Full migration from JSON to SQLite
- Rollback restores JSON reads
- Data integrity check after migration (record count match)
- Application still works with migrated data

#### Dependencies
- M2.3 (workspace SQLite), M2.4 (task SQLite)

#### Risks
- Medium — data loss risk if migration is buggy
- Need backup + integrity check before committing migration

#### Out of Scope
- agent-memory/ Markdown file migration to SQLite (future)

#### Exit Gate
- All workspace data readable from SQLite
- All task data readable from SQLite
- JSON files are backup-only
- System starts and works without JSON files
- Rollback restores JSON read capability

#### Recommended Branch
- `m2/v1-migration`

#### Integration Order
- 7/8 — after domain schemas are stable

---

### M2.8 — Verification and Cutover Readiness

**Goal:** Verify the entire M2 implementation against acceptance criteria.

#### Verification Items
1. All tests pass (unit + integration + smoke + migration-specific)
2. Legacy pipeline `POST /tasks/:id/run` still works end-to-end
3. Conversation-based execution still works
4. Workspace CRUD fully on SQLite
5. Agent profiles with provider configuration references
6. Task/Run separation — task created without outputs, run linked
7. Snapshots stored and immutable
8. Idempotency keys accepted on critical endpoints
9. Version checks prevent concurrent state corruption
10. Migration from scratch creates correct schema
11. Migration from v1 data preserves all records
12. Rollback restores previous state

#### Existing Files
- All modified files
- Test files across server and agent-core

#### New Files
- `apps/server/test/migration.test.ts`
- `apps/server/test/idempotency.test.ts`
- `apps/server/test/version-concurrency.test.ts`
- `apps/server/test/compatibility.test.ts`

#### Tests
- Full migration acceptance test
- Schema version upgrade test
- Schema downgrade test
- Data preservation test
- Concurrent access test
- API backward compatibility test

#### Dependencies
- All M2 work packages

#### Risks
- Low — this is pure verification

#### Out of Scope
- Performance benchmarking
- Load testing

#### Exit Gate
- All 8 work package exit gates met
- All existing tests pass
- Data migration tests pass
- No regression in legacy pipeline
- Cutover plan documented

#### Recommended Branch
- `m2/verification`

#### Integration Order
- 8/8 — final verification

---

## 3. M2 Dependencies Map

```
M2.1 Migration Runner
  └── M2.2 Identity/Version/Repository
        ├── M2.3 Workspace/Agent/Provider
        │     └── M2.4 Task/Run Separation
        │           └── M2.5 Snapshot/Stage
        └── M2.6 Idempotency/Concurrency
              └── M2.7 v1 Compatibility
```

M2.1 through M2.7 can be partially parallelized:
- M2.1 + M2.2: sequential
- M2.3 + M2.6: parallel (different aggregates)
- M2.4 depends on M2.3
- M2.5 depends on M2.4
- M2.7 depends on M2.3 + M2.4
- M2.8: final

---

## 4. M2 Boundary — What We Do NOT Implement

The following are explicitly out of scope for M2:

| Feature | Rationale |
|---|---|
| Event Store publish/outbox full pipeline | M3 (Event Model) |
| ProcessManager | M3 (Process Runtime) |
| ProviderAdapter refactoring | M3 (Provider Spec) |
| Worktree Runtime refactoring | M3+ |
| Policy Engine | M3+ |
| Conversation Runtime refactoring | M3+ |
| Web UI changes | M3+ |
| Runtime Inspector | M3+ |
| Tauri Desktop | M4+ |
| Extension SDK | M4+ |
| agent-memory/ Markdown → SQLite | M3+ |
| Preference system changes | Not required |

---

## 5. First Implementation Package

**Package: M2.1 — Migration Runner and SQLite Foundation**

### Why start here
1. **Unblocks everything** — every subsequent WP needs schema changes
2. **Verifiable immediately** — tests run in isolation
3. **Smallest blast radius among M2 packages** — only touches startup and schema init
4. **Risk is Medium, not Low** — any migration runner bug could prevent database initialization; legacy adoption requires precise structural verification of 25 tables

### Estimated scope
- New file: `apps/server/src/migrations/MigrationRunner.ts`
- New file: `apps/server/src/migrations/migrations/001-baseline-schema.ts`
- New table: `_schema_migrations`
- Minimal change to `SqliteStore.ts`: delegate to `MigrationRunner` instead of `migrateSchema()`
- Tests: MigrationRunner with in-memory SQLite (fresh + legacy + mismatched schemas)

### Key design decisions
1. Migrations are versioned by number (001, 002, ...)
2. Each migration exposes a single `apply(context)` method; there is no generic `down()`.
   Rollback is handled by:
   - **Transaction rollback** — if `apply()` fails before committing, the DDL + `_schema_migrations` record are rolled back together.
   - **Pre-migration backup restore** — for post-commit recovery, restore the backup taken before the migration.
   - **Forward repair migration** — for production schema fixes, write a new migration rather than reverting.
3. MigrationRunner compares version against `_schema_migrations` table
4. Each migration runs in its own transaction; `BEGIN IMMEDIATE` prevents dual-server race
5. Migration files are immutable after application — checksum mismatch is a hard failure
6. Failed migrations are rolled back and NOT recorded in `_schema_migrations`
7. Destructive schema changes are preceded by automatic backup
8. Integrity checks run after each migration

### Exit gate for M2.1
- [ ] `_schema_migrations` table created on fresh database
- [ ] MigrationRunner applies pending migrations in order
- [ ] Already-applied migrations are skipped (checksum match)
- [ ] Checksum mismatch → hard failure, not silent re-execution
- [ ] Migration failure → transaction rollback (DDL + record undone)
- [ ] Fresh database: empty → `_schema_migrations` → baseline migration → schema created
- [ ] Legacy database: strict structural verification → adopt baseline → continue
- [ ] Structural mismatch → diagnostic report, not silent baseline adoption
- [ ] Backup created before destructive schema changes
- [ ] Each migration runs in its own transaction with `BEGIN IMMEDIATE`
- [ ] Failed migration is rolled back and NOT recorded in `_schema_migrations`
- [ ] `PRAGMA integrity_check` and `PRAGMA foreign_key_check` pass after migration
- [ ] `SqliteStore` delegates to MigrationRunner instead of raw `migrateSchema()`
- [ ] All existing tests pass with MigrationRunner

## M2.4 Project-Root Ownership Remediation Note (2026-07-25)

M2.4 PR #3 ownership remediation (Project-Root IPC Ownership Lock; code commit `c2828aac` on `runtime/m2-4-task-run-separation`, previous head `4195403b`) added no migration and no schema change: ownership is enforced by an OS-level Named Pipe (Windows) / Unix Domain Socket keyed by a SHA-256 hash of the canonical Project Root, acquired before SQLite and startup recovery. R25-R33 pass (R30 unix-only, skipped on Windows); seven-file targeted 140/140; Server 454 passed / 0 failed / 1 skipped; Agent Core 123/123; Build PASS. Status remains `M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW`; Remote CI unavailable; PR #3 OPEN and unmerged with Auto Merge disabled; merge not authorized; M2.5 not started.

Update (2026-07-25, cross-platform ownership remediation): the filesystem Unix Domain Socket approach was withdrawn — a clean `server.close` removes Node-created sockets (invalidating the old R30 stale-socket test) and the probe-then-unlink stale cleanup had a TOCTOU race. Non-Windows ownership now uses a collision-aware loopback ownership socket on `127.0.0.1` (SHA-256-derived candidate ports, `AGENTOS_OWNER_V1` hash handshake, fail-closed unknown occupants); Windows Named Pipe ownership is unchanged. Still no migration and no schema change. Code commit `7d233386d0287a5976cfe8ec275aa8dec64d15a2`; R34-R40 pass (R34 unix-only, skipped on Windows); seven-file targeted 140/140; Server 466 tests / 465 passed / 0 failed / 1 skipped; Agent Core 123/123; Build PASS. Status remains `M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW`; Remote CI unavailable; PR #3 OPEN and unmerged with Auto Merge disabled; merge not authorized; M2.5 not started.
