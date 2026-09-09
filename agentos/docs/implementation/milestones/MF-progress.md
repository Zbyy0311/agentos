# Memory Foundation — Progress and Remaining Work

Status: MF-0/MF-1/MF-2/MF-3/MF-4 MERGED — MF-5 NOT STARTED — MEMORY FOUNDATION IN PROGRESS

## 1. Purpose

This record tracks the Memory Foundation slices defined by
`docs/implementation/milestones/MF-entry-audit.md`, so the remaining work is
legible without re-auditing the repository.

## 2. Merged baseline

| Field | Value |
|---|---|
| Baseline | `origin-https/main @ cafaa969` (Merge PR #87) |
| Migration ledger | `001`–`019` present; `020` absent |
| Main CI | Post-merge runs through `3bda580b` conclusion `success`; `cafaa969` in progress at record time |
| Preceding gates | Workspace single-writer rule COMPLETE; Recovery closeout COMPLETE |

## 3. Slice status

| Slice | Scope | State | PR |
|---|---|---|---|
| MF-0 | Shared contracts (Scope/Category/Authority, scope-owner validation, promotion gate, budget policy, snapshot identity, event family) | **MERGED** | #79 |
| MF-1 | Memory Entry persistence + FTS5 (migration 017, `MemoryEntryRepository`) | **MERGED** | #80 (auth), #81 (impl) |
| MF-2 | Candidate pipeline + dedup/conflict | **MERGED** | #86 (auth), #87 (impl) |
| MF-3 | Scope-filtered retrieval + deterministic ranking + reasons | **MERGED** | #82 |
| MF-4 | Budget policy + immutable Context Snapshot | **MERGED** | #83 (auth), #84 (impl) |
| MF-5 | Events, API, UI, Inspector surfaces | **NOT STARTED** | — |

## 4. Merged evidence

| Suite | Result |
|---|---|
| MF-0 shared contracts | 20/20 PASS |
| MF-1 migration 017 | 16/16 PASS |
| MF-1 repository | 16/16 PASS |
| MF-3 retrieval | 15/15 PASS |
| MF-4 migration 018 | 10/10 PASS |
| MF-4 snapshot repository | 8/8 PASS |
| MF-4 budget selector | 10/10 PASS |
| MF-2 migration 019 | 10/10 PASS |
| MF-2 candidate/conflict repository | 11/11 PASS |
| Full Server first run (MF-2 head) | 2397 total, 2392 passed, 2 failed, 3 skipped |

The 2 server failures are pre-existing Windows `tar` environment issues in
`WorktreeArtifactService`, unrelated to Memory Foundation. First runs were
preserved; no rerun-to-green was used. Each slice also passed its PR CI and the
post-merge `main` CI.

## 5. What the merged slices provide

- **Entry model**: forward `memory_entries` with Scope/Category/Authority,
  Confidence/Importance, dedup hashes, validity/expiry, sensitivity class, and
  immutable identity with monotonic version.
- **Sources**: typed stable source references; automatic Entries require one.
- **Retrieval**: owner-bounded Scope reach, non-retrievable status exclusion,
  category/tag filters, neutralized FTS5 query, deterministic ranking with
  reason codes, visible FTS-degraded mode.
- **Snapshot**: write-once per-Run/Stage Context Snapshot with frozen query
  hash, strategy version, and budget; per-Entry selection and exclusion reasons;
  injection gate that fails closed.

## 6. Remaining work

### MF-2 — Candidate pipeline + dedup/conflict (MERGED)

Merged via PR #86 (schema authorization, migration 019) and PR #87
(implementation). Provides forward `memory_candidate_entries`,
`memory_candidate_sources`, and `memory_conflicts`, plus
`MemoryCandidateRepository` with the MF-0 promotion gate, versioned review,
`merge-with-existing` binding, exact-duplicate lookup, and conflict
open/resolve that never deletes.

Remaining within MF-2 scope (not yet done): candidate generation triggers
bound to meaningful transitions (user save, terminal outcome, accepted
approval, completed review/test Artifact, compaction, explicit import) and
near-duplicate FTS-similarity detection beyond the exact/normalized hashes.

### MF-5 — Events, API, UI, Inspector surfaces (NOT STARTED)

Needed for the Lite contract:

- the memory event family (`memory.entry_created`, `memory.entry_conflicted`,
  `memory.retrieval_completed`, `memory.context_created`, `memory.injected`,
  etc.) through the canonical Runtime Event + Outbox path;
- Memory and Context Snapshot APIs (`memory/retrieve`,
  `GET /runs/:runId/memory-context`, `GET /memory-contexts/:id`,
  conflict resolution);
- UI Memory explanation and Candidate review;
- Inspector Context Snapshot view.

### Integration gap (not a numbered slice)

- No production Run currently creates an Admission at start, and no production
  path yet calls the MF-4 selector or injects a Context Snapshot into a
  Provider. MF-5 (or a dedicated integration slice) must wire the selector into
  Run startup so the snapshot is persisted before injection, and must preserve
  the injection gate.

## 7. Non-goals (unchanged)

- Vector Database or remote embeddings;
- semantic knowledge graph;
- autonomous global promotion;
- elaborate supersession graph or forgetting scheduler;
- highly autonomous extraction;
- sending the whole Memory Store to Providers.
