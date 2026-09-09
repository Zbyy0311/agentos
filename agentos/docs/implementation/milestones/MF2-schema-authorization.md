# Memory Foundation MF-2 Schema Authorization Package — Frozen Design

Status: FROZEN DESIGN — DOCS ONLY — NO MIGRATION FILE — NO REGISTRY ENTRY — NO CHECKSUM — IMPLEMENTATION NOT AUTHORIZED

## 1. Authorization basis and scope

| Field | Value |
|---|---|
| Authoritative base | `origin-https/main @ 4eb8d360` (Merge PR #85) |
| Entry audit | `docs/implementation/milestones/MF-entry-audit.md` |
| Prior packages | MF1 (migration 017), MF4 (migration 018) |
| Contract source | `packages/shared/src/types/mf0-memory-contracts.ts` (candidate outcomes, dedup order, conflict vocabulary, promotion gate) |
| Product authority | `docs/Runtime-Specification lite/07-Memory-Runtime.md` §7, §8 |
| Package kind | Schema authorization package: exact design freeze for a future additive migration |

This package prepares **only** the MF-2 schema design. It does not authorize a
migration file, a registry entry, a checksum, a repository, a service, an API,
or any production behavior.

## 2. Design constraints (frozen)

1. **Additive only.** Migrations `001`–`018` are immutable.
2. **No destructive rebuild.** `destructive: false`.
3. **No backfill.** Baseline `memory_candidates` rows are never reinterpreted.
4. **Conflict is not duplicate.** Conflicting Entries remain stored; resolution
   uses supersession links, never hard deletion.
5. **Baseline compatibility.** `memory_candidates` (001) stays readable and is
   **COMPATIBILITY**, not the forward model.
6. **No secret values.**
7. **Registry id rule.** `019` is the next and only valid id after `018`.

## 3. Proposed migration number

```text
Proposed migration number: 019
Proposed file name (future): 019-mf2-memory-candidate-conflict.ts
Proposed migration name (future): mf2-memory-candidate-conflict
Proposed destructive flag: false
```

## 4. Resource inventory (exactly three resources)

| # | Resource | Purpose |
|---|---|---|
| 1 | `memory_candidate_entries` (new table) | Forward Memory Candidate with outcome/review state. |
| 2 | `memory_candidate_sources` (new table) | Typed stable source references for a Candidate. |
| 3 | `memory_conflicts` (new table) | Durable conflict record between two Entries with explicit resolution. |

Plus supporting indexes. No other table, column, or object is created.

**Rationale for new tables.** Baseline `memory_candidates` is bound to legacy
`agent_runs` (`FOREIGN KEY (run_id) REFERENCES agent_runs(id)`) and stores an
integer `confidence` plus `memory_type`; it cannot represent the forward
Scope/Category/Authority model or canonical Run lineage. A separate forward
table keeps compatibility callers intact and avoids presenting legacy rows as
the forward pipeline.

## 5. Exact schema

### 5.1 `memory_candidate_entries`

```sql
CREATE TABLE IF NOT EXISTS memory_candidate_entries (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  scope TEXT NOT NULL CHECK (scope IN
    ('global','workspace','agent','conversation','task','run')),
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
  exact_content_hash TEXT,
  normalized_text_hash TEXT,
  token_estimate INTEGER NOT NULL DEFAULT 0 CHECK (token_estimate >= 0),
  inferred_preference INTEGER NOT NULL DEFAULT 0 CHECK (inferred_preference IN (0,1)),
  scope_promotion INTEGER NOT NULL DEFAULT 0 CHECK (scope_promotion IN (0,1)),
  contains_secret INTEGER NOT NULL DEFAULT 0 CHECK (contains_secret IN (0,1)),
  outcome TEXT NOT NULL CHECK (outcome IN
    ('pending','accept','edit-and-accept','reject','merge-with-existing','review-required')),
  decision TEXT CHECK (decision IN ('auto-accept','review-required','reject')),
  merged_into_entry_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
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
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (merged_into_entry_id) REFERENCES memory_entries(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS memory_candidate_entries_workspace_outcome
  ON memory_candidate_entries (workspace_id, outcome, created_at DESC, id);

CREATE INDEX IF NOT EXISTS memory_candidate_entries_dedup
  ON memory_candidate_entries (workspace_id, exact_content_hash)
  WHERE exact_content_hash IS NOT NULL;
```

### 5.2 `memory_candidate_sources`

```sql
CREATE TABLE IF NOT EXISTS memory_candidate_sources (
  candidate_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN
    ('user','message','conversation','task','run','stage','event','artifact','import')),
  source_id TEXT NOT NULL CHECK (length(source_id) > 0),
  PRIMARY KEY (candidate_id, source_kind, source_id),
  FOREIGN KEY (candidate_id) REFERENCES memory_candidate_entries(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS memory_candidate_sources_source
  ON memory_candidate_sources (source_kind, source_id);
```

### 5.3 `memory_conflicts`

```sql
CREATE TABLE IF NOT EXISTS memory_conflicts (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  conflict_type TEXT NOT NULL CHECK (conflict_type IN
    ('contradiction','overlapping-scope','authority-disagreement','temporal-disagreement')),
  entry_a_id TEXT NOT NULL CHECK (length(entry_a_id) > 0),
  entry_b_id TEXT NOT NULL CHECK (length(entry_b_id) > 0),
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  disposition TEXT CHECK (disposition IN
    ('keep-both','supersede-earlier','supersede-later','promote-source','reject-both')),
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  CHECK (entry_a_id <> entry_b_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_a_id) REFERENCES memory_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_b_id) REFERENCES memory_entries(id) ON DELETE CASCADE,
  CHECK (status <> 'resolved' OR (disposition IS NOT NULL AND resolved_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_conflicts_pair
  ON memory_conflicts (workspace_id, entry_a_id, entry_b_id)
  WHERE status = 'open';
```

The partial unique index permits one open conflict per Entry pair while allowing
historical resolved records. Resolution updates `status`/`disposition`; it never
deletes the conflict or either Entry.

## 6. Cross-cutting frozen rules

| Topic | Frozen rule |
|---|---|
| Candidate before promotion | An unverified Candidate is never canonical Memory. |
| Source | Automatic Candidates need ≥1 source row (service-enforced). |
| Dedup | Exact hash, then normalized hash, then same source, then FTS, then category/entity key. |
| Duplicate | Exact duplicate adds evidence to the existing Entry; no new active row. |
| Conflict | Conflicted Entries remain stored with `status = 'conflicted'`; resolution is explicit. |
| Supersession | Supersession is a status change plus a link, never deletion. |
| Secrets | `contains_secret = 1` rejects promotion; no secret value column. |
| Scope | Scope/owner CHECK mirrors MF-0 and MF-1. |
| Compatibility | Baseline `memory_candidates` unchanged and readable. |

## 7. Operational boundary

| Topic | Frozen rule |
|---|---|
| Migration file | Not created by this package. |
| Registry entry | Not created; `019` reserved here only. |
| Wiring | No repository/service/route/UI is authorized by this package. |
| Backfill | None. |

## 8. Future implementation allowlist (MF-2 only)

- `apps/server/src/migrations/migrations/019-mf2-memory-candidate-conflict.ts`;
- one registry entry and registry-sequence assertion updates;
- `MemoryCandidateRepository` (create/read/review, dedup lookup, conflict
  create/resolve);
- a candidate pipeline service consuming the MF-0 promotion gate;
- focused schema and service tests.

MF-2 must not add events, API, UI, Inspector, or Provider injection wiring.

## 9. Future acceptance matrix (MF-2)

| Gate | Requirement |
|---|---|
| MF2-A1 | Fresh DB applies 001–019 in order. |
| MF2-A2 | Upgrade from 018 applies 019 additively with no data loss. |
| MF2-A3 | Prerequisite failure fails closed with no 019 record. |
| MF2-A4 | Scope/owner CHECK rejects invalid bindings. |
| MF2-A5 | Exact duplicate converges on the existing Entry without a new active row. |
| MF2-A6 | Near-duplicate (normalized hash) is detected. |
| MF2-A7 | Conflict persists both Entries and requires explicit resolution. |
| MF2-A8 | Resolution records disposition and never deletes. |
| MF2-A9 | `contains_secret` rejects promotion. |
| MF2-A10 | Automatic Candidate without a source is rejected. |
| MF2-A11 | Global/security/inferred/Scope-promotion/unresolved-conflict route to review. |
| MF2-A12 | Baseline `memory_candidates` rows remain readable and untouched. |
| MF2-A13 | No secret value is stored. |
| MF2-A14 | Migration 019 is idempotent and self-guarding. |

## 10. Explicit prohibitions

- No edit to migrations `001`–`018` or their checksums.
- No destructive rebuild, no backfill, no legacy-row reinterpretation.
- No secret value storage.
- No event emission, API, UI, or Inspector work in MF-2.
- No Provider injection wiring.
