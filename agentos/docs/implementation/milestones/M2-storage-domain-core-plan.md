# M2 — Storage and Domain Core — Milestone Plan

> **Milestone:** M2
> **Status:** M2.1 VERIFIED & MERGED — `b4613b2a`; M2.2 VERIFIED & MERGED — `0075d36e`; M2.3 VERIFIED & MERGED — `ab1fa905`; M2.4 VERIFIED & MERGED — `e02db3b0`; Build-order remediation MERGED — `bee118ed`; Runtime Specification 13/14 MERGED — `a1514d6e`; R39 remediation MERGED — `3e86464b`; M2.5 VERIFIED & MERGED — `39eb1d5a`; M2.6 VERIFIED & MERGED — POST-MERGE CLOSEOUT RECORDED; M2.7 CURRENT-STATE AUDIT AND PLANNING IN PROGRESS — IMPLEMENTATION NOT AUTHORIZED; M2.8 NOT STARTED
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
| M2.4 | Task and Run Separation — VERIFIED & MERGED `e02db3b0` | High | High | M2.3 | `runtime/m2-4-task-run-separation` |
| M2.5 | Stage, Workflow Snapshot and Runtime Snapshot — PLAN REVIEW CLOSED, READY FOR P1 AUTHORIZATION | Medium | Medium | M2.4 | `runtime/m2-5-stage-workflow-snapshots` |
| M2.6 | Idempotency and Optimistic Concurrency — VERIFIED & MERGED — `6727add8303b7d0ab659a427bfdd8299a98e5702` | Medium | Medium | M2.2 | `runtime/m2-6-idempotency-concurrency` |
| M2.7 | v1 Compatibility Read and Data Migration — CURRENT-STATE AUDIT AND PLANNING IN PROGRESS; IMPLEMENTATION NOT AUTHORIZED | Medium | Medium | M2.3, M2.4 | `runtime/m2-7-v1-compatibility-migration` |
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
> **M2.5 override (2026-07-26):** The same historical inventory is also not an authorization for M2.5. Entries such as `007-snapshot-columns.sql`, `SnapshotService.ts`, snapshot CRUD in `SqliteStore.ts`, and snapshot responses in `routes/runs.ts` reflect the pre-M2.4 draft and are superseded by the M2.5 current-state audit; the actual next migration ID is 007 with naming and contents subject to Owner Decisions OD-1 through OD-12 (see `M2.5-current-state-audit.md`, `M2.5-owner-decisions.md`, `M2.5-stage-workflow-snapshot-plan.md`).
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
| M2.4 | ✅ VERIFIED & MERGED — `e02db3b0` (PR #3 MERGED; `runtime/m2-4-task-run-separation`, report `M2.4-task-run-separation-report.md`) |
| M2.5 | ✅ VERIFIED & MERGED — `39eb1d5ae2238f9f65fe7475fa3271a93a946acd` (PR #7 MERGED via Merge Commit at 2026-07-28T09:39:46Z, 16 commits / 45 files, reviewed head `3c4dc5b8`; branch and worktree retained; report `M2.5-stage-workflow-snapshot-report.md`) |
| M2.6 | ✅ VERIFIED & MERGED — `6727add8303b7d0ab659a427bfdd8299a98e5702` (PR #8; 11 commits / 31 changed files; 24 implementation/test files; 7 documentation files; 30 effective M2.6 files; 1 retained M2.5 closeout; final reviewed head `5416729f`; Merge Commit method; Feature Branch and Worktree retained; Migration 010 now in Main; Remote CI none; M2.7/M2.8 NOT STARTED; historical plan-review and failure evidence retained) |

> **M2.4 Owner-approved scope exception（2026-07-23）:** `apps/server/src/store/SqliteStore.test.ts` — migration_id expected list `001–004` → `001–006` only（Migration 005/006 注册后的必要预期同步）; 其他既有测试零修改；测试语义与验证强度不变。

> **M2.4 PR Review Remediation（2026-07-24，HISTORICAL 时点记录 — 当前状态以本文档顶部 Status 与状态表为准）：** Owner Decision 采用 explicit retry reconciliation；R10–R16 已加入并通过；定向 139/139（`3787.9554ms`）；Server 437/437（`41043.7068ms`）；Agent Core 123/123；Build、diff check、Scope Audit PASS。恢复依据为持久化 Legacy JSON terminal status；无 Migration 007、startup recovery 或 v2 running cancel API。Remote CI unavailable；M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW；PR #3 OPEN；不得合并；M2.5 未启动。

### M2.4 Queued Recovery Update (2026-07-24 — HISTORICAL 时点记录，当前状态以本文档顶部 Status 与状态表为准)

The remaining PR #3 MEDIUM queued-crash finding is implemented by startup orphan reconciliation in code commit `59f982d5`. A single `TaskRunService` is created before startup recovery; `recoverInterruptedTaskRuntime` first preserves existing Legacy running-task recovery, then fails only queued `legacy_pipeline` Runs with `BRIDGE_PRESTART_INTERRUPTED` in one transaction per workspace. `v2_api` queued Runs, running Legacy Runs, `agent_runs`, schema/migrations, and normal Retry behavior remain unchanged.

R17-R24 use real persistent JSON and real `node:sqlite`: taskRecovery 9/9 passed, seven-file M2.4 targeted 140/140 passed, final Server 446/446 passed, Agent Core 123/123 passed, Build PASS, and diff check PASS. PR #3 remains OPEN, Auto Merge disabled, merge unauthorized, Remote CI unavailable, and M2.5 not started. Status remains `M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW`.

The remaining PR #3 MEDIUM ownership and LOW startup-leak findings are implemented by the Project-Root IPC Ownership Lock in code commit `c2828aac` (previous head `4195403b`). Ownership is acquired before SQLite, startup recovery, Worktree reconcile, routes, and HTTP listen via a Windows Named Pipe / Unix Domain Socket keyed by a SHA-256 hash of the canonical Project Root; startup failures exit through a single sanitized boundary with stable codes only (`SERVER_ALREADY_RUNNING`, `STARTUP_RECOVERY_FAILED`, `SERVER_LISTEN_FAILED`, `SERVER_STARTUP_FAILED`).

R25-R33 use real subprocesses, real `node:sqlite`, and a real SQLite Trigger: ownership/startup targeted 17 passed / 1 unix-only skip, taskRecovery 9/9, seven-file M2.4 targeted 140/140, Server 454 passed / 0 failed / 1 skipped, Agent Core 123/123, Build PASS, diff check PASS. PR #3 remains OPEN, Auto Merge disabled, merge unauthorized, Remote CI unavailable, and M2.5 not started. Status remains `M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW`.

Follow-up ownership safety remediation (code commit `7d233386`, previous head `04877811`): the filesystem Unix Domain Socket design was withdrawn because a clean `server.close` removes Node-created sockets (old R30 stale-socket construction was invalid) and the probe-then-unlink stale cleanup had a TOCTOU race. Non-Windows ownership now uses a collision-aware loopback ownership socket on `127.0.0.1` with SHA-256-derived candidate ports and an `AGENTOS_OWNER_V1` hash handshake; unknown occupants fail closed with `SERVER_OWNERSHIP_UNAVAILABLE`; Windows Named Pipe ownership remains unchanged. R34-R40 pass (R34 unix-only, skipped on Windows); R25-R33 regression passes; seven-file targeted 140/140; Server 466 tests / 465 passed / 0 failed / 1 skipped; Agent Core 123/123; Build PASS. PR #3 remains OPEN, Auto Merge disabled, merge unauthorized, Remote CI unavailable, and M2.5 not started. Status remains `M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW`.

Candidate-set ownership remediation (code commit `091b41b2`, previous head `55591a25`): fixed a HIGH fallback-churn defect where one Project Root could hold two loopback ownership endpoints after another root freed an earlier candidate. Ownership now performs a full pre-bind sweep of the candidate set (any same-root token or unknown occupant anywhere blocks acquisition), binds only sweep-free candidates, fails closed on non-EADDRINUSE bind errors, and runs a full post-bind verification sweep before returning ownership (concurrent same-root owners cancel the acquisition, releasing the fresh bind). Accepted handshake connections are tracked and destroyed on release, so held clients cannot block release. R41-R47 pass (all RED or hung before); R25-R40 regression passes; seven-file targeted 140/140; Server 478 tests / 477 passed / 0 failed / 1 skipped; Agent Core 123/123; Build PASS. PR #3 remains OPEN, Auto Merge disabled, merge unauthorized, Remote CI unavailable, and M2.5 not started. Status remains `M2.4 IMPLEMENTED — PENDING PR REMEDIATION REVIEW`.

Final verification closure (2026-07-25): final technical review `4779120698` (`COMMENTED`, technical verdict `APPROVE`, formal non-author approval `NOT PRESENT`) approved production Head `88e9b328` with BLOCKER/HIGH/MEDIUM 0 and LOW risks L1-L4 (active SSE shutdown delay, loopback candidate availability trade-off, Unix dispatch coverage residue, pre-existing conversations flake). All closure gates passed on first execution: ownership targeted 24 passed / 1 skipped (R34 unix-only), startup 7/7, taskRecovery 9/9, RunRepository 23/23, TaskRunService 34/34, seven-file 140/140, three independent full Server runs each 477 passed / 0 failed / 1 skipped / exit 0, Agent Core 123/123, Build PASS, diff check PASS. An earlier same-day attempt stopped at an environmental R39 port conflict and is disclosed, not covered. No production code or test changed after the reviewed Head; only the four M2.4 docs and the PR body record follow it. Status is now `M2.4 VERIFIED — READY FOR MERGE REVIEW`. PR #3 remains OPEN, Auto Merge disabled, merge unauthorized, Remote CI unavailable, and M2.5 not started; branch and worktree retained.

### Next Step
M2.4 has merged (`e02db3b0`, PR #3) and is archived. Build-order remediation (`bee118ed`),
Runtime Specification 13/14 (`a1514d6e`), and R39 remediation (`3e86464b`) are merged.
M2.5 owner decisions OD-1 through OD-12 were frozen on 2026-07-26 (see
`M2.5-owner-decisions.md`), and the independent plan review closed on 2026-07-27 with
BLOCKER 0 / HIGH 1 / MEDIUM 9 / LOW 2, all resolved (see `M2.5-plan-review.md`). The
current-state audit and the frozen architecture plan are `M2.5-current-state-audit.md` and
`M2.5-stage-workflow-snapshot-plan.md`. Frozen direction: Task-domain `runs` only;
proposed Migrations 007–009; ID prefixes `workflow_`/`stage_`/`snapshot_`; global built-in
Workflow definitions; composite workspace/run and snapshot/run FKs; stage-level bindings
in Snapshot JSON; one resolved configuration drives Snapshot, initial Stages, and the
Legacy Runner projection; all v2 Run reasons use the unbound Workflow; include-based API;
no down migration; no backfill; no Conversation changes. The historical M2.5 draft in
`m2-migration-plan.md` (agent_runs/run_steps/runs.ts targeting, v006/v007 filenames,
branch `m2/snapshots`) is superseded and retained only as history. M2.5 is PLAN REVIEW
CLOSED — READY FOR P1 AUTHORIZATION; implementation has not started; P1 requires separate
Owner authorization.

### M2.6 Post-Merge Closeout (2026-07-29)

M2.6 P1–P5 and the final independent review are complete. PR #8 merged with Merge Commit `6727add8303b7d0ab659a427bfdd8299a98e5702`; the Merge Tree matches reviewed Head `5416729f`; Main now points to the verified Merge Commit; Migration 010 is in Main. The original branch `runtime/m2-6-idempotency-concurrency` and Worktree are retained with unchanged Feature Head. Remote CI is NONE / NOT CLAIMED; M2.7 and M2.8 remain NOT STARTED.
