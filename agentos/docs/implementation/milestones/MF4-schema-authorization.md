# Memory Foundation MF-4 Schema Authorization Package — Frozen Design

Status: FROZEN DESIGN — DOCS ONLY — NO MIGRATION FILE — NO REGISTRY ENTRY — NO CHECKSUM — IMPLEMENTATION NOT AUTHORIZED

## 1. Authorization basis and scope

| Field | Value |
|---|---|
| Authoritative base | `origin-https/main @ 027cd4f0` (Merge PR #82, MF-3 retrieval) |
| Entry audit | `docs/implementation/milestones/MF-entry-audit.md` |
| Prior packages | `MF1-schema-authorization.md` (migration 017), MF-0 contracts |
| Contract source | `packages/shared/src/types/mf0-memory-contracts.ts` (`MemoryBudgetPolicyV1`, `MemoryContextSnapshotV1`) |
| Product authority | `docs/Runtime-Specification lite/07-Memory-Runtime.md` §11–§13 |
| Package kind | Schema authorization package: exact design freeze for a future additive migration |

This package prepares **only** the MF-4 schema design. It does not authorize a
migration file, a registry entry, a checksum, a repository, a service, an API,
or any production behavior. MF-4 implementation requires a separate entry
authorization plus independent schema/security review.

## 2. Design constraints (frozen)

1. **Additive only.** Migrations `001`–`017` are immutable.
2. **No destructive rebuild.** `destructive: false`.
3. **No backfill.** Existing Runs have no snapshot; absence is legitimate and
   never fabricated.
4. **Immutable after insert.** A Context Snapshot records exactly what one Run
   or Stage received; later Entry edits never rewrite it.
5. **Snapshot persistence failure blocks Provider injection** because the Run
   would otherwise be unreproducible (`07-Memory-Runtime.md` §12).
6. **No secret values.** The snapshot stores IDs, versions, scores, reasons,
   token costs, and bounded references, never raw secret content.
7. **Registry id rule.** `018` is the next and only valid id after `017`.

## 3. Proposed migration number

```text
Proposed migration number: 018
Proposed file name (future): 018-mf4-memory-context-snapshot.ts
Proposed migration name (future): mf4-memory-context-snapshot
Proposed destructive flag: false
```

## 4. Resource inventory (exactly two resources)

| # | Resource | Purpose |
|---|---|---|
| 1 | `memory_context_snapshots` (new table) | Immutable per-Run/Stage Context Snapshot header. |
| 2 | `memory_context_snapshot_entries` (new table) | Frozen per-Entry selection/exclusion explanation rows. |

Plus supporting indexes and an immutability trigger. No other table, column, or
object is created.

## 5. Exact schema

### 5.1 `memory_context_snapshots`

```sql
CREATE TABLE IF NOT EXISTS memory_context_snapshots (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  agent_id TEXT,
  task_id TEXT,
  run_id TEXT NOT NULL CHECK (length(run_id) > 0),
  stage_id TEXT,
  provider_config_id TEXT,
  query_hash TEXT NOT NULL CHECK (length(query_hash) > 0),
  retrieval_strategy_version TEXT NOT NULL CHECK (length(retrieval_strategy_version) > 0),
  budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
  total_tokens INTEGER NOT NULL CHECK (total_tokens >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  prompt_artifact_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Workspace-scoped composite FK, matching idx_runs_id_workspace from 008 so a
  -- snapshot can never bind a Run from a different Workspace.
  FOREIGN KEY (run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS memory_context_snapshots_run
  ON memory_context_snapshots (workspace_id, run_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS memory_context_snapshots_stage
  ON memory_context_snapshots (workspace_id, run_id, stage_id);
```

Notes:

- `budget_json` freezes the exact `MemoryBudgetPolicyV1` used, so the snapshot
  is reproducible even if the policy changes later.
- `query_hash` binds the snapshot to the exact retrieval query without storing
  the query text.
- `prompt_artifact_id` references the assembled prompt Artifact when one exists.

### 5.2 `memory_context_snapshot_entries`

```sql
CREATE TABLE IF NOT EXISTS memory_context_snapshot_entries (
  snapshot_id TEXT NOT NULL,
  memory_entry_id TEXT NOT NULL CHECK (length(memory_entry_id) > 0),
  memory_entry_version INTEGER NOT NULL CHECK (memory_entry_version >= 1),
  selected INTEGER NOT NULL CHECK (selected IN (0,1)),
  rank INTEGER,
  score REAL,
  scope TEXT,
  category TEXT,
  authority TEXT,
  confidence REAL,
  importance REAL,
  token_cost INTEGER NOT NULL DEFAULT 0 CHECK (token_cost >= 0),
  reasons_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons_json)),
  source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
  content_hash TEXT,
  PRIMARY KEY (snapshot_id, memory_entry_id),
  FOREIGN KEY (snapshot_id) REFERENCES memory_context_snapshots(id) ON DELETE CASCADE,
  -- Selected rows carry rank/score/reasons; excluded rows carry an exclusion reason.
  CHECK (selected = 0 OR (rank IS NOT NULL AND score IS NOT NULL AND reasons_json <> '[]'))
);

CREATE INDEX IF NOT EXISTS memory_context_snapshot_entries_selected
  ON memory_context_snapshot_entries (snapshot_id, selected, rank);
```

Notes:

- One row per considered Entry, whether selected or excluded, so exclusion
  reasons are durable (`07-Memory-Runtime.md` §13).
- `memory_entry_version` records the exact version selected; later edits do not
  alter the row.
- `content_hash` freezes a content reference without duplicating content.

### 5.3 Immutability trigger

```sql
CREATE TRIGGER IF NOT EXISTS memory_context_snapshots_immutable
BEFORE UPDATE ON memory_context_snapshots
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_CONTEXT_SNAPSHOT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS memory_context_snapshots_no_delete
BEFORE DELETE ON memory_context_snapshots
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_CONTEXT_SNAPSHOT_DELETE_FORBIDDEN');
END;
```

A snapshot is write-once. Corrections append a new snapshot; they never mutate
history.

### 5.4 Prerequisite guard

Migration 018 requires the 017 schema. `apply` fails closed with a stable
`MIGRATION_PREREQUISITE_MISSING` error when `memory_entries` or `runs` is
absent, so an 018 success record can never be written against an incomplete
parent schema.

## 6. Cross-cutting frozen rules

| Topic | Frozen rule |
|---|---|
| Immutability | Write-once; no update, no delete. |
| Scope | Snapshot binds Workspace, Run, optional Stage and Provider Configuration. |
| Reproducibility | `query_hash`, `retrieval_strategy_version`, and `budget_json` are frozen. |
| Explanation | Every considered Entry has a row with reasons or an exclusion reason. |
| Secrets | No content column; `content_hash` and bounded refs only. |
| Compatibility | Baseline memory tables and MF-1 tables unchanged. |
| Failure | Snapshot write failure blocks injection. |

## 7. Operational boundary

| Topic | Frozen rule |
|---|---|
| Migration file | Not created by this package. |
| Registry entry | Not created; `018` reserved here only. |
| Checksum | Not computed. |
| Wiring | No repository/service/route/UI is authorized by this package. |
| Backfill | None. |

## 8. Future implementation allowlist (MF-4 only)

- `apps/server/src/migrations/migrations/018-mf4-memory-context-snapshot.ts`;
- one registry entry;
- registry-sequence assertion updates;
- `MemoryContextSnapshotRepository` (insert snapshot + entries atomically, read
  by id/Run);
- a budget selector that consumes MF-3 ranked results and produces a snapshot;
- focused schema and service tests.

MF-4 must not add events, API, UI, Inspector, candidate promotion, or Provider
injection wiring.

## 9. Future acceptance matrix (MF-4)

| Gate | Requirement |
|---|---|
| MF4-A1 | Fresh DB applies 001–018 in order. |
| MF4-A2 | Upgrade from 017 applies 018 additively with no data loss. |
| MF4-A3 | Prerequisite failure fails closed with no 018 record. |
| MF4-A4 | Snapshot update rejected; delete rejected. |
| MF4-A5 | Snapshot + entries commit atomically. |
| MF4-A6 | Selected rows require rank/score/reasons; excluded rows carry a reason. |
| MF4-A7 | `budget_json` round-trips the exact `MemoryBudgetPolicyV1`. |
| MF4-A8 | Later Entry edits do not change snapshot rows or scores. |
| MF4-A9 | Budget selection respects token/entry/scope/category limits and records exclusions. |
| MF4-A10 | Snapshot persistence failure blocks injection. |
| MF4-A11 | No secret value is stored. |
| MF4-A12 | Retrieval is reproducible for the same Store, query, clock, and policy. |

## 10. Explicit prohibitions

- No edit to migrations `001`–`017` or their checksums.
- No destructive rebuild, no backfill.
- No secret value storage.
- No event emission, API, UI, or Inspector work in MF-4.
- No Vector Database or embedding requirement.
- No Provider injection wiring until MF-4 is separately authorized and MF-5
  integration is authorized.
