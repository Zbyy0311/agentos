# AgentOS M4-P2 Schema Authorization Package — Frozen Design

Status: FROZEN DESIGN — DOCS ONLY — NO MIGRATION FILE — NO REGISTRY ENTRY — NO CHECKSUM — IMPLEMENTATION NOT AUTHORIZED

## 1. Authorization basis and scope

| Field | Value |
|---|---|
| Authoritative base | `main @ 6a3a257af1d71ec5c8884311c4427c5f1ea1a543` |
| Owner Decision | `OD-M4-01 = Option A — SELECTED` (recorded in `M4-owner-decisions.md` section 2) |
| Package kind | Schema authorization package: exact design freeze for a future additive migration |

The Option A selection authorizes **only continued preparation of the P2
schema/migration package**. It does not authorize Migration 014 implementation,
and it does not authorize P2 production implementation. Both still require a
separate P2 entry authorization plus independent schema/security/recovery
review. This document creates no SQL file, no registry entry, no checksum and
no production code.

Frozen inputs this design is derived from:

- `M4-p0-schema-proposal.md` (three-resource proposal, fields, constraints, CAS,
  terminal immutability, upgrade/fresh and forward-only boundaries)
- `M4-p0-runtime-contract.md` (Process state machine, cleanup result
  vocabulary, cancel/timeout semantics)
- `M4-p0-event-error-contract.md` (Event/Outbox binding, stable error codes)
- `M4-process-provider-runtime-implementation-plan.md` (P2 phase scope, file
  ownership, migration decision boundary, testing matrix)
- Current migrations `001`–`013` implementation patterns (`Migration`
  interface, DDL statement arrays, checksum rule, registry ordering, backup
  provider, trigger and CAS conventions)
- P1 `packages/process-runtime` accepted contracts (`PROCESS_STATES`,
  `CleanupResult`, launch/redaction policy)

## 2. Resource inventory (exactly three resources)

The future migration creates **exactly three new tables** and nothing else:

| # | Table | Resource | Primary identity |
|---|---|---|---|
| 1 | `runtime_processes` | Runtime Process (durable reservation, CAS state, native/recovery/tree/terminal evidence) | `id` (`proc_` + ULID) |
| 2 | `provider_sessions` | Provider Session (frozen Provider/Adapter identity, claim fence, Session outcome) | `id` (`psess_` + ULID) |
| 3 | `process_output_references` | Per-stream output reference (canonical artifact identity, bounded offsets/integrity) | composite `(process_id, stream)` plus unique `artifact_id` |

The same migration additionally creates exactly three **supporting unique
indexes on pre-existing parent tables** (no new columns, no row semantics
change), required as composite FK targets:

| Supporting unique index | On | Columns |
|---|---|---|
| `provider_configurations_id_workspace` | `provider_configurations` | `(id, workspace_id)` |
| `runs_id_workspace_task` | `runs` | `(id, workspace_id, task_id)` |
| `run_stages_id_workspace_run_attempt` | `run_stages` | `(id, workspace_id, run_id, attempt)` |

`agent_profiles(workspace_id, id)` already provides the Agent parent key and is
reused as-is. No other existing table is touched. No old Conversation table
(`agent_runs`, `executions`, `run_cli_invocations`, old
`runtime_artifacts`) is read, altered or repurposed.

## 3. Exact schema

Conventions frozen from migrations 001–013: timestamps are TEXT in canonical
UTC ISO 8601 milliseconds; booleans are INTEGER constrained to 0/1; every
mutable row carries `version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)`;
ID CHECKs pin prefix and total length (`proc_`+26=31, `psess_`+26=32,
`artifact_`+26=35). Post-baseline style: no `IF NOT EXISTS`.

### 3.1 `provider_sessions`

| Column | Type / constraint |
|---|---|
| `id` | TEXT NOT NULL PRIMARY KEY, CHECK (`length(id) = 32 AND substr(id, 1, 6) = 'psess_'`) |
| `workspace_id` | TEXT NOT NULL |
| `task_id` | TEXT NOT NULL |
| `run_id` | TEXT NOT NULL |
| `stage_id` | TEXT NOT NULL |
| `stage_attempt` | INTEGER NOT NULL CHECK (`stage_attempt >= 1`) |
| `authority_role` | TEXT NOT NULL CHECK (`authority_role = 'primary-provider'`); first-schema only value |
| `agent_id` | TEXT NOT NULL; frozen Agent identity from the accepted Run snapshot |
| `provider_config_id` | TEXT NOT NULL |
| `provider_config_version` | INTEGER NOT NULL CHECK (`provider_config_version >= 1`) |
| `provider_type` | TEXT NOT NULL CHECK (`length(provider_type) > 0 AND provider_type <> 'kimi'`); canonical vocabulary (e.g. `kimicode`) owned by the Provider contract |
| `adapter_id` | TEXT NOT NULL |
| `adapter_version` | TEXT NOT NULL |
| `config_schema_version` | INTEGER NOT NULL CHECK (`config_schema_version >= 1`) |
| `runtime_mode` | TEXT NOT NULL CHECK (`runtime_mode IN ('cli','api','ssh','container')`); first slice `cli` |
| `native_session_id` | TEXT NULL; restricted diagnostic, never AgentOS Session identity |
| `status` | TEXT NOT NULL CHECK (`status IN ('starting','active','waiting','paused','completed','failed','cancelled')`); first durable row is `starting` |
| `claim_epoch` | INTEGER NOT NULL CHECK (`claim_epoch >= 1`) |
| `claim_owner_id` | TEXT NULL; service identity, never browser identity |
| `claim_lease_expires_at` | TEXT NULL (UTC ISO 8601 ms) |
| `adapter_start_requested_at` | TEXT NULL; CAS-set exactly once before Adapter start; never cleared or reused |
| `capabilities_json` | TEXT NOT NULL CHECK (`json_valid(capabilities_json)`); canonical validated bounded JSON; no secret values |
| `error_code` | TEXT NULL; stable code |
| `error_detail_redacted` | TEXT NULL; bounded safe detail |
| `started_at` / `last_activity_at` / `completed_at` | TEXT NULL (UTC ISO 8601 ms) |
| `version` | INTEGER NOT NULL DEFAULT 1 CHECK (`version >= 1`) |
| `created_at` / `updated_at` | TEXT NOT NULL (UTC ISO 8601 ms) |
| `archived_at` | TEXT NULL; archive marker, never deletion |

Table-level constraints:

- CHECK (`(claim_owner_id IS NULL AND claim_lease_expires_at IS NULL) OR (claim_owner_id IS NOT NULL AND claim_lease_expires_at IS NOT NULL)`)
- CHECK (`status <> 'active' OR started_at IS NOT NULL`)
- CHECK (`status NOT IN ('completed','failed','cancelled') OR completed_at IS NOT NULL`)
- UNIQUE (`id, workspace_id, run_id`) — supporting key
- UNIQUE (`id, workspace_id, run_id, stage_id, stage_attempt`) — supporting parent key binding the Process FK to the Session's exact Stage/attempt
- UNIQUE (`workspace_id, run_id, stage_id, stage_attempt, authority_role`) — exactly-one primary Provider Session per Stage attempt

Foreign keys (all `ON DELETE RESTRICT`; runtime evidence is archived, never
cascade-deleted):

| From | To |
|---|---|
| `(workspace_id)` | `workspaces(id)` |
| `(run_id, workspace_id, task_id)` | `runs(id, workspace_id, task_id)` via supporting unique index |
| `(stage_id, workspace_id, run_id, stage_attempt)` | `run_stages(id, workspace_id, run_id, attempt)` via supporting unique index |
| `(provider_config_id, workspace_id)` | `provider_configurations(id, workspace_id)` via supporting unique index |
| `(workspace_id, agent_id)` | `agent_profiles(workspace_id, id)` |

Indexes:

- `provider_sessions_run_created` ON `(workspace_id, run_id, created_at, id)`
- `provider_sessions_status_updated` ON `(workspace_id, status, updated_at, id)`
- `provider_sessions_config_version` ON `(provider_config_id, provider_config_version, created_at, id)`
- `provider_sessions_native_session` ON `(workspace_id, provider_type, native_session_id)` — non-unique, partial `WHERE native_session_id IS NOT NULL`

Triggers:

- `provider_sessions_identity_immutable` — BEFORE UPDATE; rejects any change to `id, workspace_id, task_id, run_id, stage_id, stage_attempt, authority_role, agent_id, provider_config_id, provider_config_version, provider_type, adapter_id, adapter_version, config_schema_version, runtime_mode, created_at`.
- `provider_sessions_terminal_immutable` — BEFORE UPDATE WHEN `OLD.status IN ('completed','failed','cancelled')`; rejects every change except `archived_at`, `updated_at`, `version` (archival metadata only, under a separate retention contract).
- `provider_sessions_reject_delete` — BEFORE DELETE; rejects all row deletion.

### 3.2 `runtime_processes`

| Column | Type / constraint |
|---|---|
| `id` | TEXT NOT NULL PRIMARY KEY, CHECK (`length(id) = 31 AND substr(id, 1, 5) = 'proc_'`); allocated before spawn |
| `workspace_id` | TEXT NOT NULL |
| `task_id` | TEXT NOT NULL |
| `run_id` | TEXT NOT NULL |
| `stage_id` | TEXT NULL; required for root Provider Process (see table CHECK) |
| `stage_attempt` | INTEGER NULL CHECK (`stage_attempt IS NULL OR stage_attempt >= 1`) |
| `provider_session_id` | TEXT NULL; required for Provider root Process |
| `parent_process_id` | TEXT NULL; self-reference for managed children |
| `authority_role` | TEXT NULL CHECK (`authority_role IS NULL OR authority_role = 'primary-provider'`); first-schema root value `primary-provider` |
| `claim_epoch` | INTEGER NOT NULL CHECK (`claim_epoch >= 1`); Process-start fence epoch |
| `claim_owner_id` | TEXT NULL; service identity, never browser identity |
| `claim_lease_expires_at` | TEXT NULL (UTC ISO 8601 ms) |
| `process_type` | TEXT NOT NULL CHECK (`process_type IN ('provider','tool','command','git','test','system','extension')`); first slice `provider` |
| `platform` | TEXT NOT NULL CHECK (`length(platform) > 0`); normalized platform/capability family |
| `status` | TEXT NOT NULL CHECK (`status IN ('created','starting','running','waiting','stopping','exited','failed','orphaned','unknown')`) |
| `executable_resolved` | TEXT NOT NULL |
| `executable_fingerprint` | TEXT NULL until platform can resolve it |
| `args_redacted_json` | TEXT NOT NULL CHECK (`json_valid(args_redacted_json)`); canonical bounded JSON; redacted launch arguments only |
| `cwd_resolved` | TEXT NOT NULL |
| `shell` | INTEGER NOT NULL CHECK (`shell IN (0,1)`); P1 policy admits only 0 |
| `detached` | INTEGER NOT NULL CHECK (`detached IN (0,1)`); P1 policy admits only 0 |
| `stdin_mode` | TEXT NOT NULL CHECK (`stdin_mode IN ('closed','pipe')`); first slice `closed` |
| `stdout_mode` / `stderr_mode` | TEXT NOT NULL CHECK (`IN ('capture','null')`); first slice `capture` |
| `timeout_policy_json` | TEXT NOT NULL CHECK (`json_valid(timeout_policy_json)`); canonical bounded JSON of the frozen safe policy |
| `security_profile_ref` | TEXT NOT NULL; opaque reference, never resolved secret material |
| `native_pid` | INTEGER NULL CHECK (`native_pid IS NULL OR native_pid > 0`) |
| `native_parent_pid` | INTEGER NULL CHECK (`native_parent_pid IS NULL OR native_parent_pid > 0`) |
| `native_started_at` | TEXT NULL (UTC ISO 8601 ms); identity evidence, not Process `started_at` |
| `process_group_id` / `tree_ownership_mode` / `platform_handle_id` | TEXT NULL; restricted native ownership diagnostics; handle ID is not a reusable handle; `tree_ownership_mode` vocabulary is frozen by the P5 platform-driver contract |
| `recovery_token_hash` | TEXT NULL; one-way hash only, raw token is never persisted |
| `recovery_classification` | TEXT NULL CHECK (`IS NULL OR IN ('same','missing','mismatch','unknown')`) |
| `recovery_evidence_json` | TEXT NULL CHECK (`recovery_evidence_json IS NULL OR json_valid(recovery_evidence_json)`); bounded restricted summary |
| `recovery_checked_at` | TEXT NULL (UTC ISO 8601 ms) |
| `recovery_classifier_version` | TEXT NULL |
| `started_at` / `ready_at` / `last_activity_at` / `stopping_at` / `exited_at` | TEXT NULL (UTC ISO 8601 ms), allowed per state rules |
| `exit_code` | INTEGER NULL; signed/native normalized |
| `exit_signal` | TEXT NULL |
| `termination_reason` | TEXT NULL |
| `cleanup_result` | TEXT NULL CHECK (`IS NULL OR IN ('TERMINATED','ALREADY_EXITED','SURVIVORS','IDENTITY_MISMATCH','UNKNOWN_PLATFORM_UNAVAILABLE')`) |
| `survivor_pids_redacted_json` | TEXT NULL CHECK (`survivor_pids_redacted_json IS NULL OR json_valid(survivor_pids_redacted_json)`); restricted |
| `error_code` / `error_detail_redacted` | TEXT NULL; stable code and safe detail |
| `version` | INTEGER NOT NULL DEFAULT 1 CHECK (`version >= 1`) |
| `created_at` / `updated_at` | TEXT NOT NULL (UTC ISO 8601 ms) |
| `archived_at` | TEXT NULL |

Table-level constraints:

- CHECK (`(claim_owner_id IS NULL AND claim_lease_expires_at IS NULL) OR (claim_owner_id IS NOT NULL AND claim_lease_expires_at IS NOT NULL)`)
- Root Provider shape: CHECK (`authority_role IS NULL OR (provider_session_id IS NOT NULL AND stage_id IS NOT NULL AND stage_attempt IS NOT NULL AND parent_process_id IS NULL)`)
- Session-linked full binding: CHECK (`provider_session_id IS NULL OR (stage_id IS NOT NULL AND stage_attempt IS NOT NULL)`) — composite FKs use default MATCH NONE semantics (any NULL component skips enforcement), so a Session-linked Process must carry non-NULL Stage/attempt for the five-column FK to bite
- CHECK (`status <> 'created' OR (native_pid IS NULL AND native_started_at IS NULL)`)
- CHECK (`status <> 'running' OR (native_pid IS NOT NULL AND native_started_at IS NOT NULL AND started_at IS NOT NULL)`)
- CHECK (`status NOT IN ('exited','failed') OR exited_at IS NOT NULL`)
- CHECK (`parent_process_id IS NULL OR parent_process_id <> id`); cycle prevention beyond self-reference is repository-validated inside one transaction
- UNIQUE (`id, workspace_id, run_id`) — supporting key for child/parent/output FKs

Foreign keys (all `ON DELETE RESTRICT`):

| From | To |
|---|---|
| `(workspace_id)` | `workspaces(id)` |
| `(run_id, workspace_id, task_id)` | `runs(id, workspace_id, task_id)` via supporting unique index |
| `(stage_id, workspace_id, run_id, stage_attempt)` | `run_stages(id, workspace_id, run_id, attempt)` via supporting unique index |
| `(provider_session_id, workspace_id, run_id, stage_id, stage_attempt)` | `provider_sessions(id, workspace_id, run_id, stage_id, stage_attempt)` via its supporting UNIQUE key; makes root Process Session/Stage/attempt equality a real DDL constraint |
| `(parent_process_id, workspace_id, run_id)` | `runtime_processes(id, workspace_id, run_id)` self-reference, `DEFERRABLE INITIALLY DEFERRED` |

Indexes:

- `runtime_processes_root_claim_unique` UNIQUE ON `(workspace_id, run_id, stage_id, stage_attempt, authority_role)` WHERE `parent_process_id IS NULL AND authority_role IS NOT NULL` — exactly-one root Process claim per Stage attempt
- `runtime_processes_run_created` ON `(workspace_id, run_id, created_at, id)`
- `runtime_processes_stage_attempt` ON `(workspace_id, stage_id, stage_attempt, created_at, id)`
- `runtime_processes_status_updated` ON `(workspace_id, status, updated_at, id)`
- `runtime_processes_session` ON `(provider_session_id, created_at, id)`
- `runtime_processes_parent` ON `(parent_process_id, created_at, id)`
- `runtime_processes_native_identity` ON `(platform, native_pid, native_started_at)` — non-unique recovery scan support

Triggers:

- `runtime_processes_identity_immutable` — BEFORE UPDATE; rejects any change to `id, workspace_id, task_id, run_id, stage_id, stage_attempt, provider_session_id, parent_process_id, authority_role, created_at`.
- `runtime_processes_terminal_immutable` — BEFORE UPDATE WHEN `OLD.status IN ('exited','failed')`; rejects every change except `archived_at`, `updated_at`, `version`. `orphaned`/`unknown` stay mutable under CAS because later evidence may classify them.
- `runtime_processes_reject_delete` — BEFORE DELETE; rejects all row deletion.

### 3.3 `process_output_references`

| Column | Type / constraint |
|---|---|
| `process_id` | TEXT NOT NULL; part of composite PK |
| `stream` | TEXT NOT NULL CHECK (`stream IN ('stdout','stderr')`); part of composite PK |
| `workspace_id` | TEXT NOT NULL; denormalized isolation key enforced by the composite Process FK |
| `run_id` | TEXT NOT NULL; denormalized isolation key enforced by the composite Process FK |
| `artifact_id` | TEXT NOT NULL UNIQUE, CHECK (`length(artifact_id) = 35 AND substr(artifact_id, 1, 9) = 'artifact_'`); canonical stream-artifact identity; never references old `runtime_artifacts` |
| `storage_key` | TEXT NOT NULL; opaque managed-sink key; restricted, never a client path |
| `content_type` | TEXT NOT NULL |
| `encoding` | TEXT NOT NULL; may be `binary` when text decoding is unsafe |
| `access_classification` | TEXT NOT NULL CHECK (`access_classification = 'restricted'`) |
| `redaction_mode` | TEXT NOT NULL CHECK (`redaction_mode IN ('scan','strict')`); `none` prohibited |
| `source_bytes_seen` | INTEGER NOT NULL CHECK (`>= 0`); monotonic |
| `retained_bytes` | INTEGER NOT NULL CHECK (`>= 0`); monotonic |
| `next_source_offset` | INTEGER NOT NULL CHECK (`>= 0`); monotonic; original-stream byte offset |
| `segment_count` | INTEGER NOT NULL CHECK (`>= 0`); monotonic; zero before first retained bytes |
| `truncated` | INTEGER NOT NULL CHECK (`truncated IN (0,1)`) |
| `truncation_reason` | TEXT NULL; bounded; CHECK (`truncated = 1 OR truncation_reason IS NULL`) |
| `finalized` | INTEGER NOT NULL CHECK (`finalized IN (0,1)`); terminal |
| `sha256` | TEXT NULL CHECK (`sha256 IS NULL OR (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*')`); lowercase hex of retained bytes |
| `version` | INTEGER NOT NULL DEFAULT 1 CHECK (`version >= 1`) |
| `created_at` / `updated_at` | TEXT NOT NULL (UTC ISO 8601 ms) |
| `finalized_at` | TEXT NULL (UTC ISO 8601 ms) |
| `archived_at` | TEXT NULL |

Table-level constraints:

- PRIMARY KEY (`process_id, stream`) — at most one stdout and one stderr row per Process
- CHECK (`retained_bytes <= source_bytes_seen`)
- CHECK (`next_source_offset <= source_bytes_seen`)
- CHECK (`finalized = 0 OR (finalized_at IS NOT NULL AND sha256 IS NOT NULL)`)
- FOREIGN KEY (`process_id, workspace_id, run_id`) REFERENCES `runtime_processes(id, workspace_id, run_id)` ON DELETE RESTRICT — the single physical FK; Workspace/Run consistency is enforced through it

Indexes:

- `process_output_references_run_process` ON `(workspace_id, run_id, process_id, stream)`
- `process_output_references_finalized` ON `(workspace_id, finalized, updated_at, process_id)`

Triggers:

- `process_output_references_identity_immutable` — BEFORE UPDATE; rejects any change to `process_id, stream, workspace_id, run_id, artifact_id, created_at`.
- `process_output_references_monotonic` — BEFORE UPDATE; rejects `NEW.source_bytes_seen < OLD.source_bytes_seen`, `NEW.retained_bytes < OLD.retained_bytes`, `NEW.next_source_offset < OLD.next_source_offset` or `NEW.segment_count < OLD.segment_count`.
- `process_output_references_finalized_immutable` — BEFORE UPDATE WHEN `OLD.finalized = 1`; rejects every change except `archived_at`, `updated_at`, `version`. A finalized reference cannot append.
- `process_output_references_reject_delete` — BEFORE DELETE; rejects all row deletion.

Raw bytes never enter the database: they live in the managed append-only sink
keyed by `artifact_id`/`storage_key`; rolling segments are internal immutable
children ordered by the stream manifest, and `sha256` covers the retained-byte
concatenation.

### 3.4 Cross-cutting frozen rules

**CAS / version.** Session, Process and output-reference versions start at 1;
Session and process-backed root Process claim epochs start at 1. Every mutable
command supplies `expectedVersion` (plus `expectedClaimEpoch`/owner for claim
operations); updates match primary ID + Workspace + expected version + allowed
source state in one statement, incrementing `version` exactly once. Zero
affected rows is classified by a scoped follow-up read as not-found / workspace
mismatch / version conflict / fence conflict / invalid transition; it never
implicitly retries a spawn. `adapter_start_requested_at` is CAS-set exactly
once within the Session claim transaction before any Adapter call.

**Terminal immutability.** Process `exited`/`failed`, Session
`completed`/`failed`/`cancelled` and finalized output references are
immutable execution facts, enforced by the triggers above: no state, claim,
native identity, launch, Provider binding, exit, error, offset, artifact
identity or checksum change after terminal; archival metadata only via a
separate retention contract; later diagnostics append Runtime Events instead of
editing terminal rows; duplicate terminal observation returns the stored
result; inconsistent later evidence raises a restricted integrity diagnostic,
never an overwrite.

**Delete behavior.** Every FK is `ON DELETE RESTRICT`; all three tables carry
reject-delete triggers. Evidence is archived, never deleted, and old parent
rows cannot be removed while M4 evidence references them.

**Workspace/Run/Stage ownership consistency.** Ownership columns are mutually
consistent through the composite FKs above; `stage_attempt` must equal the
referenced Stage `attempt`. A root Provider Process shares the exact
Run/Stage/attempt of its Session, enforced as a real DDL constraint: the
five-column Process-to-Session FK references the Session's
`(id, workspace_id, run_id, stage_id, stage_attempt)` supporting UNIQUE key,
and the Session-linked full-binding CHECK guarantees no NULL component can
silently skip enforcement (SQLite composite FKs default to MATCH NONE, where
any NULL component disables the check). A child Process shares Workspace/Run
with its parent (composite self-FK) and cannot be its own parent.

**Exactly-one primary Provider claim.** `provider_sessions` UNIQUE
`(workspace_id, run_id, stage_id, stage_attempt, authority_role)` plus
`runtime_processes_root_claim_unique` partial unique index together enforce
one primary Provider Session and one root Process claim per Stage attempt. An
API/remote Session may have no Process and must not fabricate one.

**Output offset monotonicity / finalization.** The three counters and
`segment_count` never decrease (trigger-enforced); `retained_bytes` never
exceeds `source_bytes_seen`; finalization requires `finalized_at` + lowercase
`sha256`; finalized rows reject further mutation. Duplicate checkpoints at the
same offsets are idempotent at repository level under expected-version CAS.

**JSON fields.** Every JSON relational column (`capabilities_json`,
`args_redacted_json`, `timeout_policy_json`, `recovery_evidence_json`,
`survivor_pids_redacted_json`) carries a DDL `json_valid` CHECK (NULL-tolerant
where the column is nullable); `json_valid` is SQLite core since 3.38 and
available in the bundled runtime. Above that floor, the repository layer owns
canonical schema validation and bounded byte limits before persistence; the
exact byte budgets are owned by the respective frozen contracts (P1 launch /
output / recovery contracts) and are deliberately not re-invented here.

## 4. Proposed migration number

```text
Proposed migration number: 014
Proposed file name (future): 014-m4-process-runtime-schema.ts
Proposed migration name (future): m4-process-runtime-schema
```

The number 014 is **reserved and frozen inside this design document only**.
This package allocates no registry entry, computes no checksum and creates no
migration file. Registry id rules (`/^\d+$/`, unique, sorted) make 014 the
next and only valid id after 013. Number renumbering of 001–013 is forbidden.

## 5. Operational boundary

| Topic | Frozen rule |
|---|---|
| Fresh DB path | On an empty database the runner applies 001–013 then 014; 014 creates the three empty tables with constraints/indexes/triggers plus the three supporting unique indexes. No rows, no seed data, no secret material. The runner's existing fresh destructive skip applies to the backup gate; schema application itself is unchanged. |
| 001–013 upgrade path | Additive only: prove existing `provider_configurations`/`runs`/`run_stages` rows satisfy the supporting unique keys (duplicate pre-check fails the migration before any DDL), then create new objects. Existing rows/checksums and M3 Event/Outbox semantics are untouched. |
| Backfill | **No backfill.** No scan or import of old `agent_runs`, `executions`, `run_cli_invocations`, old `runtime_artifacts` or historical Event references. |
| Old-table reuse | Old Conversation tables and old `runtime_artifacts` are never reused as canonical Process/Session/output storage. |
| `destructive` flag | `true` — frozen deliberately to engage the existing MigrationRunner mandatory-backup gate. Schema/data behavior remains additive / no-backfill; the flag is the backup-gate mechanism, not a data-destruction statement. The MigrationRunner is not modified. |
| Backup point | Runner-enforced: with `destructive: true`, the existing MigrationRunner gate requires a backup provider and a database file path, and takes the verified file backup inside the migration transaction before `apply`; without them it fails closed before any DDL. A non-empty database therefore cannot run 014 without a backup. A fresh database may use the runner's existing fresh destructive skip. |
| Restore / failure boundary | 014 runs inside the runner's `BEGIN IMMEDIATE` transaction with post-apply integrity assertion; any failure rolls back completely to the 001–013 state. Restore is an offline copy from the verified backup; never in-place repair. |
| Forward-only evidence preservation | After the first M4 Session/Process/output row exists, rollback is forward-only application correction or authorized backup restore — never table drop, row deletion, schema downgrade, Event rewrite, ID reuse or mapping into old Conversation tables. |
| Old binary compatibility rule | Old binaries may open the upgraded database: 014 adds no columns and changes no semantics of existing tables (only new tables plus new unique indexes that constrain duplicates application invariants already prevent). Old code paths keep working unchanged and ignore the new tables. |
| Deployment ordering | (1) verified backup on non-empty DBs; (2) deploy the application build that contains the 014-aware code; (3) migration applies at startup before serving; (4) new canonical execution writes begin only after the application compatibility gate; (5) binaries older than the 014-aware build must not perform M4 writes but may run legacy paths. The minimum application version is the build that introduces 014, recorded via `_schema_migrations.app_version`. |

## 6. Future implementation allowlist

When — and only when — a separate P2 entry authorization is granted, the
Migration 014 phase may touch exactly:

| Action | Path |
|---|---|
| ADD | `agentos/apps/server/src/migrations/migrations/014-m4-process-runtime-schema.ts` |
| EDIT | `agentos/apps/server/src/migrations/default-registry.ts` (import + append `migration014` after `migration013`; no reorder, no renumber, no checksum edits of 001–013) |
| ADD | `agentos/apps/server/src/migrations/__tests__/m4-p2-migration-014.test.ts` (fresh/upgrade/DDL-exactness/checksum/registry/rollback/backup evidence) |
| ADD | `agentos/apps/server/src/store/ProcessRepository.ts`, `ProviderSessionRepository.ts`, `ProcessOutputReferenceRepository.ts` plus co-located `.test.ts` files |
| EDIT | `agentos/apps/server/src/store/Store.ts` and `agentos/apps/server/src/store/SqliteStore.ts` (repository wiring only) |
| ADD/EDIT | `agentos/packages/process-runtime/` repository-port and artifact-sink integration plus package-local tests (consume P1 contracts; no contract redefinition) |

Explicitly out of scope for that phase: Runtime Specification/contract document
edits, M3 lifecycle/Run/Stage services, HTTP routes, `agent-core`, legacy
tables, old `runtime_artifacts`, migration renumbering, checksum changes to
001–013, `MigrationRunner`/backup-runner code (the frozen `destructive: true`
flag engages the existing gate unchanged), and any production cutover.

## 7. Future acceptance matrix

| # | Acceptance item | Required evidence |
|---|---|---|
| 1 | Fresh DB | `:memory:` run of full registry produces exactly the three tables, supporting unique indexes, indexes and triggers; `integrity_check` clean |
| 2 | Upgrade 001–013 | Prefix-registry databases at every supported shape upgrade additively; existing rows/checksums preserved; exactly one new `_schema_migrations` row |
| 3 | FK check | `PRAGMA foreign_key_check` clean on fresh and upgraded DBs; RESTRICT behavior proven by rejected parent deletions |
| 4 | DDL/constraint exactness | Schema inspection proves every column type, NULL rule, CHECK, UNIQUE, FK, index and trigger matches this document |
| 5 | CAS races | Concurrent expected-version mutations: exactly one winner; zero-row outcomes classified without implicit retry |
| 6 | Exactly-one reservation races | Concurrent Session claim and root Process claim per Stage attempt produce exactly one winner; losers get stable classified errors |
| 7 | Terminal immutability | Post-terminal mutation attempts rejected by triggers; archival-only update path proven; duplicate terminal observation returns stored result |
| 8 | Output offset monotonicity | Counter regression rejected; `retained_bytes <= source_bytes_seen`; finalized rows reject append; duplicate checkpoint idempotent |
| 9 | Checksum / registry | 014 checksum recorded and mismatch fails closed (`MIGRATION_CHECKSUM_MISMATCH`); registry order 001–014; duplicate id rejected |
| 10 | Backup / restore | Runner mandatory-backup gate engaged by `destructive: true`: non-empty upgrade cannot reach DDL without backup provider + file path; verified backup taken inside the migration transaction before `apply`; fresh-DB destructive skip evidenced; failure rehearsal restores byte-identical pre-migration state offline |
| 11 | Old-path compatibility | Pre-014 binaries open the upgraded DB and run legacy paths unchanged; old Conversation/runtime_artifacts behavior green |
| 12 | Full server + process-runtime regression | Entire `apps/server` suite plus `packages/process-runtime` suite green; no skipped evidence |
| 13 | Workspace build | Full monorepo build passes |
| 14 | JSON validation | Invalid JSON rejected by the DDL `json_valid` CHECK on every JSON column; non-canonical or oversized JSON rejected by repository-layer schema validation and bounded byte limits; test evidence covers both rejection paths |

Acceptance never means rerun-until-green; a flaky pass is a failure.

## 8. Explicit prohibitions (restated)

```text
Migration 014 file: NOT CREATED
Migration 014 registry entry: NOT CREATED
Migration 014 checksum: NOT COMPUTED
Migration 014 IMPLEMENTATION: NOT AUTHORIZED
M4-P2 PRODUCTION IMPLEMENTATION: NOT AUTHORIZED
Production cutover: NOT AUTHORIZED
PR #45 change: NOT AUTHORIZED
```

This document is a design freeze. Any deviation from the frozen schema,
constraints, operational boundary or allowlist requires a new authorization
package and re-review before implementation.
