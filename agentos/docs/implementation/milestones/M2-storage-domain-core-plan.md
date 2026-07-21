# M2 — Storage and Domain Core — Milestone Plan

> **Milestone:** M2
> **Status:** PLANNED — Ready for implementation
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
| M2.3 | Workspace, Agent Profile and Provider Configuration | High | Medium | M2.1, M2.2 | `m2/workspace-agent-provider` |
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
apps/server/src/routes/tasks.ts           — add v2 endpoints
apps/server/src/routes/runs.ts            — expand run details
apps/server/src/routes/approvals.ts       — add idempotency key
packages/shared/src/types/index.ts        — add v2 types alongside v1
```

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

## 10. M2 Readiness

**✅ M2 is Ready for implementation.**

| Check | Status |
|---|---|
| Schema inventory documented | ✅ schema-inventory.md (25 tables) |
| Domain gap analysis completed | ✅ domain-gap-analysis.md (12 questions) |
| Migration plan with 8 work packages | ✅ m2-migration-plan.md |
| First implementation package selected | ✅ M2.1 — Migration Runner |
| Branch naming convention defined | ✅ `runtime/m2-{N}-{name}` |
| Worktree isolation | ✅ `E:\workspace\Multi-Agent-worktrees\agentos-m2-1` for M2.1 |
| Clean git state confirmed | ✅ (worktree clean) |
| No code written yet | ✅ (planning only) |

### Next Step
M2.1 is VERIFIED on `runtime/m2-1-migration-foundation` (implementation `a804005f`).
M2.2 is VERIFIED on `runtime/m2-2-identity-version-repository` (implementation `bc9ff13d`).
Next: M2.2 PR review and merge, then M2.3 (Workspace, Agent Profile, Provider Configuration).