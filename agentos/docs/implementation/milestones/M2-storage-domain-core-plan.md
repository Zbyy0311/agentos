# M2 — Storage and Domain Core — Milestone Plan

> **Milestone:** M2
> **Status:** M2.1 VERIFIED & MERGED — `b4613b2a`; M2.2 VERIFIED & MERGED — `0075d36e`; M2.3 VERIFIED & MERGED — `ab1fa905`; M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW; M2.5 NOT STARTED
> **Date:** 2026-07-21
> **Repository:** `Zbyy0311/agentos`
> **Plan Documents:**
> - `docs/implementation/schema-inventory.md`
> - `docs/implementation/domain-gap-analysis.md`
> - `docs/implementation/m2-migration-plan.md`

---

## 1. M1 Facts Corrected

The following facts were discovered during M2 planning and corrected from M1:

| M1 Claim | Corrected Fact | Evidence |
|---|---|---|
| Git root: `agentos/` | Git root: `E:/workspace/Multi-Agent/` (agentos is subdirectory) | `git rev-parse --show-toplevel` returned `E:/workspace/Multi-Agent` |
| Branch: HEAD (detached) | Branch: `docs/ui-architecture-alignment` | `git branch --show-current` returned `docs/ui-architecture-alignment` |
| "Browser close does NOT affect Run execution" | Browser close through SSE `res.on('close')` triggers AbortController, cancelling execution | Code at `tasks.ts:236-240`: `res.on('close', () => abortController.abort())` |

Both corrections were committed in `12207fb8`.

---

## 2. Current Schema Summary

### SQLite Tables (25 total)
- **Core:** `agent_profiles`, `conversations`, `conversation_members`, `messages`, `message_attachments`
- **Execution:** `executions`, `agent_runs`, `run_steps`, `execution_events`
- **Events:** `agent_events`, `run_event_sequences`
- **CLI/File tracking:** `run_cli_invocations`, `run_file_changes`
- **Decision/Approval:** `run_decisions`
- **Artifacts:** `runtime_artifacts`
- **Memory:** `memories`, `memory_sources`, `memory_fts`, `run_memory_usage`, `memory_candidates`
- **User/Preferences:** `user_profiles`, `preference_evidence`, `preference_projections`, `preference_projection_evidence`, `preference_applications`

### JSON Files (legacy, to retire)
- `workspace/workspaces.json` — workspace metadata + agents list
- `workspace/{id}/.agentos/tasks.json` — pipeline task items

### Key Observations
- `agent_events` table is close to v2 RuntimeEvent spec (has sequence, schema_version, event_type)
- `agent_runs` is close to v2 Run (missing parentRunId, rootRunId, taskId, version)
- `run_steps` is close to v2 RunStage (has stable_step_key, attempt, sequence)
- `run_event_sequences` matches v2 sequence allocation exactly
- `memories` has FTS5 search (matches v2 spec)
- **No snapshot tables exist** — this is the biggest gap
- **Migration system is ad-hoc** — no version tracking, no rollback, no backup

---

## 3. Largest Domain Conflicts

| # | Conflict | Severity | Root Cause |
|---|---|---|---|
| 1 | **Task == Run** | CRITICAL | `TaskItem.outputs` stores execution results on the task, no separation |
| 2 | **No immutable snapshot** | CRITICAL | Agent/Provider configs not frozen at Run creation — history is unreliable |
| 3 | **Dual JSON/SQLite storage** | HIGH | Workspace metadata in JSON, runtime data in SQLite — consistency risk |
| 4 | **No version/concurrency** | HIGH | No optimistic concurrency on mutable aggregates; races possible |
| 5 | **No idempotency** | HIGH | Network retry could create duplicate tasks, runs, approvals |
| 6 | **Ad-hoc migration** | HIGH | No version tracking, no rollback, no backup before schema changes |
| 7 | **Execution overlaps Run** | MEDIUM | `executions` table duplicates lifecycle tracked in `agent_runs` |
| 8 | **Fixed AgentStage union** | MEDIUM | `run_steps.kind` is already open; legacy TaskItem still uses fixed union |

---

## 4. M2 Work Package List

| WP | Name | Effort | Risk | Dependencies | Recommended Branch |
|---|---|---|---|---|---|
| M2.1 | Migration Runner and SQLite Foundation | Medium | Medium | None | `runtime/m2-1-migration-foundation` |
| M2.2 | Canonical Identity, Version and Repository | Medium | Medium | M2.1 | `runtime/m2-2-identity-version-repository` |
| M2.3 | Workspace, Agent Profile and Provider Configuration | High | Medium | M2.1, M2.2 | `runtime/m2-3-workspace-agent-provider` |
| M2.4 | Task and Run Separation | High | High | M2.3 | `m2/task-run-separation` |
| M2.5 | Stage, Workflow Snapshot and Runtime Snapshot | Medium | Medium | M2.4 | `m2/snapshots` |
| M2.6 | Idempotency and Optimistic Concurrency | Medium | Medium | M2.2 | `m2/idempotency-concurrency` |
| M2.7 | v1 Compatibility Read and Data Migration | Medium | Medium | M2.3, M2.4 | `m2/v1-migration` |
| M2.8 | Verification and Cutover Readiness | Medium | Low | All above | `m2/verification` |

---

## 5. Critical Path

```
M2.1 ──→ M2.2 ──→ M2.3 ──→ M2.4 ──→ M2.5
                    │                  │
                    └──→ M2.6 ─────────┘
                                      │
                                      └──→ M2.7 ──→ M2.8
```

Parallel opportunities:
- M2.3 and M2.6 can partially overlap (different aggregates, same foundation)
- M2.8 blocks on everything else

---

## 6. First Implementation Package

### M2.1 — Migration Runner and SQLite Foundation

**Rationale:** Without a structured migration system, every schema change from M2.2 through M2.7 is ad-hoc and unrevertable. This package builds the migration infrastructure first.

**Key deliverables:**
1. `apps/server/src/migrations/MigrationRunner.ts`
2. `apps/server/src/migrations/migrations/001-baseline-schema.ts`
3. `_schema_migrations` SQLite table
4. Wiring into SqliteStore constructor (delegate to MigrationRunner)

**Risk:** Medium — Blast radius: server startup and schema initialization. Legacy adoption requires strict structural verification of 25 tables.

**Success conditions:**
- Fresh database: empty → `_schema_migrations` → baseline → schema created
- Legacy database: strict structural verification → adopt baseline → continue
- Mismatched/worn schema: diagnostic report, not silent adoption
- `PRAGMA integrity_check` + `PRAGMA foreign_key_check` pass after migration
- Failed migration transaction rolls back its DDL, DML and migration record
- All existing tests still pass

---

## 7. Files Expected to Modify in M2

### New files
```
apps/server/src/migrations/MigrationRunner.ts
apps/server/src/migrations/migrations/001-initial-schema.ts
apps/server/src/migrations/migrations/002-add-versions.sql (or .ts)
apps/server/src/migrations/migrations/003-workspace-table.sql
apps/server/src/migrations/migrations/004-tasks-table.sql
apps/server/src/migrations/migrations/005-agent-runs-task-fields.sql
apps/server/src/migrations/migrations/006-idempotency.sql
apps/server/src/migrations/migrations/007-snapshot-columns.sql
apps/server/src/migrations/migrations/data-001-migrate-workspaces.ts
apps/server/src/migrations/migrations/data-002-migrate-tasks.ts
apps/server/src/store/Identity.ts
apps/server/src/store/Version.ts
apps/server/src/store/Transaction.ts
apps/server/src/services/SnapshotService.ts
apps/server/src/services/IdempotencyService.ts
```

### Modified files
```
apps/server/src/store/SqliteStore.ts     — multiple schema + CRUD changes
apps/server/src/store/Store.ts            — may extend interface
apps/server/src/index.ts                  — initialize MigrationRunner
apps/server/src/routes/tasks.ts           — append only the frozen Legacy Bridge persistence logic; Legacy URL/mount/request/response/SSE/JSON contracts remain unchanged
apps/server/src/routes/runs.ts            — historical M2 inventory only; denylisted for M2.4
apps/server/src/routes/approvals.ts       — add idempotency key
packages/shared/src/types/index.ts        — add v2 types alongside v1
```

> **M2.4 override:** The historical M2-wide inventory above is not an authorization to change those files in M2.4. For the current M2.4 plan, `apps/server/src/routes/runs.ts`, `apps/web/**`, existing tests, ConversationService and RunStepService are denylisted; v2 routes are new `/v2` files and Legacy routes remain at their original URLs. Repository ordering is deterministic (`Task: updated_at DESC, id ASC`; `Run: created_at ASC, id ASC`; latest Run: `created_at DESC, id DESC LIMIT 1`).
> Legacy Bridge must use `createLegacyRunForBridge` for its single-transaction find-or-create path; claim failure uses dedicated `failQueuedBridgeClaim`, then `resolveTaskAfterRunTerminal(task, terminalRun)`, while generic queued→failed is invalid. The same unified terminal reconciliation is mandatory for queued cancel, Bridge failure/cancellation and terminal JSON-save compensation: pending preserves Task `in_progress` and its pointer; no pending plus no active Run returns Task to `open`; no historical completed Run scan may restore the pointer. `pending_result_run_id` is the nullable persisted acceptance-window pointer; `cancelTask` clears it without modifying historical Runs and, for the non-done target, clears accepted/completed fields; reopen clears all three fields. GET/LIST routes may read a single Repository after WorkspaceManager validation, but all mutations and cross-Aggregate operations use TaskRunService; `TaskRepository.accept` writes only the Task transition and `TaskRunService.acceptRun` performs all Run checks. M2.4 currently plans 121 explicit new tests, with Server evidence value `298 + 121 = 419`; implementation reports must use actual results.

---

## 8. Files NOT to Modify in M2

| File | Reason |
|---|---|
| `packages/agent-core/src/runner.ts` | AgentRunner stays unchanged — wait for M3 |
| `packages/agent-core/src/executor.ts` | CLIExecutor stays unchanged — wait for M3 |
| `packages/agent-core/src/config.ts` | AGENT_CONFIGS stays — wait for Workflow in M3 |
| `packages/agent-core/src/adapters/*` | Adapter refactoring is M3 |
| `apps/server/src/services/WorktreeManager.ts` | Worktree Runtime is M3+ |
| `apps/server/src/services/ConversationService.ts` | Conversation Runtime is M3+ |
| `apps/web/src/**` | All UI — no changes in M2 |
| `apps/server/src/routes/conversations.ts` | Not in M2 scope |
| `scripts/**` | E2E test scripts not in M2 scope |
| `start-dev.ps1` | Not in M2 scope |
| `pnpm-workspace.yaml` | Not needed — no new packages |

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration runner bug prevents DB init | Low | Critical | Additive design with legacy fallback; tests on fresh + legacy DB |
| Legacy adoption misidentifies schema | Low | High | Strict structural verification; mismatch → diagnostic, not silent adoption |
| Task/Run separation breaks legacy pipeline | Medium | High | Keep JSON TaskItem working during transition; add comprehensive tests |
| JSON migration loses data | Low | Critical | Backup before migration; integrity check after; rollback capability |
| Version concurrency errors in existing callers | Low | Medium | Version column default=1; enforce only on v2 endpoints |
| Idempotency key conflicts with existing patterns | Low | Low | Idempotency key is optional — existing callers unchanged |
| Snapshot references create circular dependencies | Medium | Low | Snapshot stores JSON copy, not FK references |

---

## 10. M2 Readiness and Current Status

M2 is in implementation. M2.1, M2.2 and M2.3 are verified and merged
(M2.3 merge commit `ab1fa905`); M2.4 remediation is implemented on branch
`runtime/m2-4-task-run-separation` (PR review remediation `8b2ff01f`;
targeted 139/139, Server 437/437, Agent Core 123/123, Build PASS, diff check PASS
and Scope Audit PASS — see `docs/implementation/milestones/M2.4-task-run-separation-report.md`).
PR remediation re-review is pending; Reviewed Head `efcf7b8c`; Remote CI unavailable;
PR #3 remains open; merge not authorized.

| Check | Status |
|---|---|
| Schema inventory documented | ✅ schema-inventory.md (25 tables) |
| Domain gap analysis completed | ✅ domain-gap-analysis.md (12 questions) |
| Migration plan with 8 work packages | ✅ m2-migration-plan.md |
| First implementation package selected | ✅ M2.1 — Migration Runner |
| Branch naming convention defined | ✅ `runtime/m2-{N}-{name}` |
| Worktree isolation | ✅ `E:\workspace\Multi-Agent-worktrees\agentos-m2-1` for M2.1 |
| Clean git state confirmed | ✅ (worktree clean) |
| M2.1 | ✅ VERIFIED & MERGED — `b4613b2a` |
| M2.2 | ✅ VERIFIED & MERGED — `0075d36e` |
| M2.3 | ✅ VERIFIED & MERGED — `ab1fa905` (PR #2 MERGED at 2026-07-22T16:30:20Z, source head `ca541c8a`; `runtime/m2-3-workspace-agent-provider`, implementation `236fcc79`, original reviewed head `5dc0e47e`, remediation commit `9def4f15`, final remediation review head `c9c851c8`) |
| M2.4 | 🚧 IMPLEMENTED — PENDING PR REMEDIATION REVIEW (`runtime/m2-4-task-run-separation`, PR remediation `8b2ff01f`, Reviewed Head `efcf7b8c`, report `M2.4-task-run-separation-report.md`) |

> **M2.4 Owner-approved scope exception（2026-07-23）:** `apps/server/src/store/SqliteStore.test.ts` — migration_id expected list `001–004` → `001–006` only（Migration 005/006 注册后的必要预期同步）; 其他既有测试零修改；测试语义与验证强度不变。

> **M2.4 PR Review Remediation（2026-07-24）：** Owner Decision 采用 explicit retry reconciliation；R10–R16 已加入并通过；定向 139/139（`3787.9554ms`）；Server 437/437（`41043.7068ms`）；Agent Core 123/123；Build、diff check、Scope Audit PASS。恢复依据为持久化 Legacy JSON terminal status；无 Migration 007、startup recovery 或 v2 running cancel API。Remote CI unavailable；M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW；PR #3 OPEN；不得合并；M2.5 未启动。

### M2.4 Queued Recovery Update (2026-07-24)

The remaining PR #3 MEDIUM queued-crash finding is implemented by startup orphan reconciliation in code commit `59f982d5`. A single `TaskRunService` is created before startup recovery; `recoverInterruptedTaskRuntime` first preserves existing Legacy running-task recovery, then fails only queued `legacy_pipeline` Runs with `BRIDGE_PRESTART_INTERRUPTED` in one transaction per workspace. `v2_api` queued Runs, running Legacy Runs, `agent_runs`, schema/migrations, and normal Retry behavior remain unchanged.

R17-R24 use real persistent JSON and real `node:sqlite`: taskRecovery 9/9 passed, seven-file M2.4 targeted 140/140 passed, final Server 446/446 passed, Agent Core 123/123 passed, Build PASS, and diff check PASS. PR #3 remains OPEN, Auto Merge disabled, merge unauthorized, Remote CI unavailable, and M2.5 not started. Status remains `M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW`.

The remaining PR #3 MEDIUM ownership and LOW startup-leak findings are implemented by the Project-Root IPC Ownership Lock in code commit `c2828aac` (previous head `4195403b`). Ownership is acquired before SQLite, startup recovery, Worktree reconcile, routes, and HTTP listen via a Windows Named Pipe / Unix Domain Socket keyed by a SHA-256 hash of the canonical Project Root; startup failures exit through a single sanitized boundary with stable codes only (`SERVER_ALREADY_RUNNING`, `STARTUP_RECOVERY_FAILED`, `SERVER_LISTEN_FAILED`, `SERVER_STARTUP_FAILED`).

R25-R33 use real subprocesses, real `node:sqlite`, and a real SQLite Trigger: ownership/startup targeted 17 passed / 1 unix-only skip, taskRecovery 9/9, seven-file M2.4 targeted 140/140, Server 454 passed / 0 failed / 1 skipped, Agent Core 123/123, Build PASS, diff check PASS. PR #3 remains OPEN, Auto Merge disabled, merge unauthorized, Remote CI unavailable, and M2.5 not started. Status remains `M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW`.

### Next Step
M2.3 passed the final remediation review on PR #2 and was merged to main via merge
commit `ab1fa905` at 2026-07-22T16:30:20Z (source head `ca541c8a`); auto-merge stayed
disabled. M2.4 PR review remediation is implemented (Owner Decisions OD-1 to OD-5
remain frozen; actual test and scope evidence in the M2.4 report) on branch
`runtime/m2-4-task-run-separation`; PR remediation re-review is pending, merge is not
authorized, and M2.5 has not started.
