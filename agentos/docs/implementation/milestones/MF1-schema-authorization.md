# Memory Foundation MF-1 Schema Authorization Package — Frozen Design

Status: FROZEN DESIGN — DOCS ONLY — NO MIGRATION FILE — NO REGISTRY ENTRY — NO CHECKSUM — IMPLEMENTATION NOT AUTHORIZED

## 1. Authorization basis and scope

| Field | Value |
|---|---|
| Authoritative base | `origin-https/main @ acf7741c` (Merge PR #79, MF-0 contracts) |
| Entry audit | `docs/implementation/milestones/MF-entry-audit.md` |
| Contract source | `packages/shared/src/types/mf0-memory-contracts.ts` (MF-0, merged) |
| Product authority | `docs/Runtime-Specification lite/07-Memory-Runtime.md` |
| Package kind | Schema authorization package: exact design freeze for a future additive migration |

This package prepares **only** the MF-1 schema design. It does not authorize a
migration file, a registry entry, a checksum, a repository, a service, an API,
or any production behavior. MF-1 implementation still requires a separate entry
authorization plus independent schema/security review.

The entry audit (§6) proposed `MF-1 Memory Entry persistence + FTS5` as the
first additive slice after MF-0 contracts. This document freezes exactly what
that slice may create.

## 2. Design constraints (frozen)

1. **Additive only.** Migrations `001`–`016` are immutable. No historical file,
   checksum, table, column, index, or trigger is edited.
2. **No destructive rebuild.** Unlike migration 016, MF-1 needs no table
   rebuild; `destructive` must be `false`.
3. **No backfill.** Existing `memories` rows keep their legacy shape and are
   never converted into forward Memory Entries. A forward Entry is a new row.
4. **Baseline tables stay readable.** `memories`, `memory_sources`, `memory_fts`,
   `run_memory_usage`, and `memory_candidates` remain under **COMPATIBILITY**.
5. **No secret values.** Schema carries secret *references*, never values.
6. **Idempotent and prerequisite-guarded**, matching migrations 015/016.
7. **Registry id rule.** Ids must be numeric, unique, and sorted; `017` is the
   next and only valid id after `016`. Renumbering `001`–`016` is forbidden.

## 3. Proposed migration number

```text
Proposed migration number: 017
Proposed file name (future): 017-mf1-memory-entry-persistence.ts
Proposed migration name (future): mf1-memory-entry-persistence
Proposed destructive flag: false
```

The number `017` is reserved and frozen inside this document only. This package
allocates no registry entry, computes no checksum, and creates no migration file.

## 4. Resource inventory (exactly three resources)

| # | Resource | Purpose |
|---|---|---|
| 1 | `memory_entries` (new table) | Forward Memory Entry with Scope/Category/Authority/Confidence/Importance/Source and lifecycle. |
| 2 | `memory_entry_sources` (new table) | Typed stable source references per Entry. |
| 3 | `memory_entries_fts` (new FTS5 virtual table) | Retrieval index over title/content/summary/tags. |

Plus supporting indexes and immutability triggers listed in §5. No other table,
column, or object is created.

**Rationale for new tables instead of altering `memories`.** The baseline
`memories` table is a compatibility Markdown-index shape (`content_path`,
`memory_type`, `importance INTEGER`, `status` ∈ `active|archived`) consumed by
`MemoryService`, `MemoryRetriever`, `RunContextBuilder`, and the web memory
panel. Altering it would risk compatibility callers and would falsely present
legacy rows as forward Entries. A separate `memory_entries` table keeps the
forward model canonical and additive, exactly as the entry audit requires.

## 5. Exact schema

### 5.1 `memory_entries`

```sql
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  scope TEXT NOT NULL CHECK (scope IN
    ('global','workspace','agent','conversation','task','run')),
  -- Owner columns are Scope-conditional; enforced by CHECK below.
  owner_agent_id TEXT,
  owner_conversation_id TEXT,
  owner_task_id TEXT,
  owner_run_id TEXT,
  category TEXT NOT NULL CHECK (category IN
    ('decision','knowledge','preference','constraint','failure','review','test',
     'architecture','workflow','provider','environment','security','summary','reference')),
  authority TEXT NOT NULL CHECK (authority IN
    ('user-explicit','system-verified','imported-verified','agent-derived','user-inferred','unknown')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  title TEXT NOT NULL CHECK (length(title) > 0),
  summary TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  status TEXT NOT NULL CHECK (status IN
    ('candidate','active','conflicted','superseded','expired','archived','rejected','deleted')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  valid_from TEXT,
  valid_until TEXT,
  expires_at TEXT,
  exact_content_hash TEXT,
  normalized_text_hash TEXT,
  token_estimate INTEGER NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
  sensitivity TEXT NOT NULL DEFAULT 'ordinary' CHECK (sensitivity IN ('ordinary','restricted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Scope/owner binding, mirroring MF-0 validateMemoryScopeOwner.
  CHECK (
    (scope = 'global'    AND owner_agent_id IS NULL AND owner_conversation_id IS NULL
                         AND owner_task_id IS NULL AND owner_run_id IS NULL)
 OR (scope = 'workspace' AND owner_agent_id IS NULL AND owner_conversation_id IS NULL
                         AND owner_task_id IS NULL AND owner_run_id IS NULL)
 OR (scope = 'agent'    AND owner_agent_id IS NOT NULL AND owner_conversation_id IS NULL
                         AND owner_task_id IS NULL AND owner_run_id IS NULL)
 OR (scope = 'conversation' AND owner_agent_id IS NULL AND owner_conversation_id IS NOT NULL
                         AND owner_task_id IS NULL AND owner_run_id IS NULL)
 OR (scope = 'task'     AND owner_agent_id IS NULL AND owner_conversation_id IS NULL
                         AND owner_task_id IS NOT NULL AND owner_run_id IS NULL)
 OR (scope = 'run'      AND owner_agent_id IS NULL AND owner_conversation_id IS NULL
                         AND owner_task_id IS NOT NULL AND owner_run_id IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS memory_entries_workspace_status
  ON memory_entries (workspace_id, status, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS memory_entries_scope_owner
  ON memory_entries (workspace_id, scope, owner_task_id, owner_run_id);

CREATE INDEX IF NOT EXISTS memory_entries_dedup
  ON memory_entries (workspace_id, exact_content_hash)
  WHERE exact_content_hash IS NOT NULL;
```

Notes:

- `valid_from` / `valid_until` / `expires_at` are nullable; absence means no
  constraint. Expired rows are excluded by retrieval, not deleted.
- `sensitivity = 'restricted'` marks content requiring explicit access checks;
  it never stores a secret value.
- `version` supports optimistic concurrency for Entry updates.

### 5.2 `memory_entry_sources`

```sql
CREATE TABLE IF NOT EXISTS memory_entry_sources (
  memory_entry_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN
    ('user','message','conversation','task','run','stage','event','artifact','import')),
  source_id TEXT NOT NULL CHECK (length(source_id) > 0),
  PRIMARY KEY (memory_entry_id, source_kind, source_id),
  FOREIGN KEY (memory_entry_id) REFERENCES memory_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS memory_entry_sources_source
  ON memory_entry_sources (source_kind, source_id);
```

The MF-0 rule "automatic Entries require at least one stable source" is enforced
in the promotion service (MF-2) and asserted by tests; the table makes the
references durable.

### 5.3 `memory_entries_fts` (FTS5)

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts USING fts5(
  memory_entry_id UNINDEXED,
  title,
  content,
  summary,
  tags
);
```

- Separate from baseline `memory_fts` so legacy and forward indexes never
  collide.
- Synchronization is performed by the MF-1 repository inside the same
  transaction as the Entry write (delete + insert by `memory_entry_id`),
  mirroring the existing `replaceMemoryFts` pattern. No trigger-based
  synchronization is used, to keep the write path explicit and testable.

### 5.4 Immutability triggers

```sql
CREATE TRIGGER IF NOT EXISTS memory_entries_no_delete
BEFORE DELETE ON memory_entries
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_ENTRY_DELETE_FORBIDDEN');
END;

CREATE TRIGGER IF NOT EXISTS memory_entries_version_monotonic
BEFORE UPDATE ON memory_entries
WHEN NEW.version <> OLD.version + 1
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_ENTRY_VERSION_MUST_INCREMENT');
END;

CREATE TRIGGER IF NOT EXISTS memory_entries_identity_immutable
BEFORE UPDATE ON memory_entries
WHEN NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.scope IS NOT OLD.scope
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'MEMORY_ENTRY_IDENTITY_IMMUTABLE');
END;
```

- Delete is soft (`status = 'deleted'`); the trigger prevents destructive row
  removal and preserves audit history.
- Identity and `created_at` are immutable after insert.
- Every accepted change increments `version`.

### 5.5 Prerequisite guard

Migration 017 requires the schema through 016. `apply` must fail closed with a
stable `MIGRATION_PREREQUISITE_MISSING` error when `workspaces` or `memories` is
absent, so a 017 success record can never be written against an incomplete
parent schema.

## 6. Cross-cutting frozen rules

| Topic | Frozen rule |
|---|---|
| Ownership | Every Entry belongs to exactly one Workspace via FK. |
| Scope reach | Scope/owner CHECK mirrors MF-0; a `run` Entry names Task and Run. |
| Source | Automatic Entries need ≥1 `memory_entry_sources` row (service-enforced). |
| Dedup | `exact_content_hash` and `normalized_text_hash` are the first two signals. |
| Conflict | Conflicted Entries remain stored with `status = 'conflicted'`. |
| Supersession | Supersession is a status change plus a link, never deletion. |
| Immutability | No hard delete; identity and `created_at` immutable; version monotonic. |
| Secrets | No secret value column; `sensitivity` classifies access only. |
| FTS | Separate `memory_entries_fts`; synchronized in-transaction. |
| Compatibility | Baseline memory tables unchanged and still readable. |
| Timestamps | UTC ISO 8601 text. |
| IDs | `mem_` prefix per `ENTITY_ID_PREFIXES`; opaque and secret-free. |

## 7. Operational boundary

| Topic | Frozen rule |
|---|---|
| Migration file | Not created by this package. |
| Registry entry | Not created; `017` reserved here only. |
| Checksum | Not computed; the future file owns its checksum source. |
| Backup gate | `destructive: false`; the runner's fresh/upgrade paths apply normally. |
| Rollback | Additive DDL only; a rollback stops reading new tables and preserves 001–016. |
| Backfill | None. Legacy `memories` rows are never converted. |
| Wiring | No repository/service/route/UI is authorized by this package. |

## 8. Future implementation allowlist (MF-1 only)

When separately authorized, MF-1 may add:

- `apps/server/src/migrations/migrations/017-mf1-memory-entry-persistence.ts`;
- one registry entry in `default-registry.ts`;
- one registry-sequence assertion update in the affected migration tests;
- a `MemoryEntryRepository` (insert/read/update-status, FTS sync) in
  `apps/server/src/store/`;
- focused schema and repository tests.

MF-1 must not add retrieval ranking, budgets, Context Snapshots, candidate
promotion, events, API, or UI.

## 9. Future acceptance matrix (MF-1)

| Gate | Requirement |
|---|---|
| MF1-A1 | Fresh DB applies 001–017 and records all ids in order. |
| MF1-A2 | Upgrade from a 016 DB applies 017 additively with no data loss. |
| MF1-A3 | Prerequisite failure (no `workspaces`/`memories`) fails closed, no 017 record. |
| MF1-A4 | Scope/owner CHECK rejects every invalid binding MF-0 rejects. |
| MF1-A5 | `confidence`/`importance` outside 0..1 rejected. |
| MF1-A6 | Unknown scope/category/authority/status rejected. |
| MF1-A7 | Hard delete rejected; soft delete sets `status = 'deleted'`. |
| MF1-A8 | Identity/`created_at` update rejected. |
| MF1-A9 | `version` must increment on update. |
| MF1-A10 | FTS row synchronized with the Entry in one transaction. |
| MF1-A11 | Legacy `memories`/`memory_fts` rows remain readable and untouched. |
| MF1-A12 | No secret value column exists; `sensitive` content is reference/class only. |
| MF1-A13 | Repository rejects untyped invalid input fail-closed. |
| MF1-A14 | Migration 017 is idempotent and self-guarding. |

## 10. Explicit prohibitions

- No edit to migrations `001`–`016` or their checksums.
- No destructive table rebuild.
- No backfill or reinterpretation of legacy `memories` rows.
- No secret value storage.
- No retrieval ranking, budget selection, Context Snapshot, candidate
  promotion, event emission, API, UI, or Inspector work in MF-1.
- No Vector Database or embedding requirement.
- No production wiring of the forward tables until MF-1 is separately authorized.
