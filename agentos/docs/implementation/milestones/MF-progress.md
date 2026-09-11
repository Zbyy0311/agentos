# Memory Foundation — Progress and Remaining Work

Status: MF-0..MF-4 MERGED — MF-5 EVENTS + EMISSION + RUN INJECTION + API MERGED, UI OPEN — MEMORY FOUNDATION IN PROGRESS

## 1. Purpose

This record tracks the Memory Foundation slices defined by
`docs/implementation/milestones/MF-entry-audit.md`, so the remaining work is
legible without re-auditing the repository.

## 2. Merged baseline

| Field | Value |
|---|---|
| Baseline | `origin-https/main @ e8f64b15` (Merge PR #120) |
| Migration ledger | `001`–`023` present; no MF-5 API migration (read/write composition over MF-1..MF-4 tables) |
| Main CI | `e8f64b15` PR CI run `34560421871` conclusion `success` |
| Preceding gates | Workspace single-writer rule COMPLETE; Recovery closeout COMPLETE |

## 3. Slice status

| Slice | Scope | State | PR |
|---|---|---|---|
| MF-0 | Shared contracts (Scope/Category/Authority, scope-owner validation, promotion gate, budget policy, snapshot identity, event family) | **MERGED** | #79 |
| MF-1 | Memory Entry persistence + FTS5 (migration 017, `MemoryEntryRepository`) | **MERGED** | #80 (auth), #81 (impl) |
| MF-2 | Candidate pipeline + dedup/conflict | **MERGED** | #86 (auth), #87 (impl) |
| MF-3 | Scope-filtered retrieval + deterministic ranking + reasons | **MERGED** | #82 |
| MF-4 | Budget policy + immutable Context Snapshot | **MERGED** | #83 (auth), #84 (impl) |
| MF-5 | Events + emission + Run injection + API MERGED; UI/Inspector NOT STARTED | **PARTIAL** | #89 (events), #91 (emission), #120 (API) |

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
| MF-5 memory events | 8/8 PASS |
| MF-5 emitter | 10/10 PASS |
| MF-4 Run-startup resolver | 10/10 PASS |
| Dispatcher MF-4 integration gates | 3/3 PASS |
| MF-5 API routes | 5/5 PASS |
| MF-4R-09 `listForRun` | 1/1 PASS (within 9/9 snapshot suite) |
| Full Server run (MF-5 API head) | 2590 total, 2583 passed, 4 failed, 3 skipped |

The 4 server failures are pre-existing Windows `ENOTEMPTY` temp-directory
teardown flakes in `worktrees.test.ts` (2), `ConversationService.test.ts`,
and `LegacyTaskItemImportService.test.ts`, unrelated to Memory Foundation.
Earlier runs recorded the same class as `tar` environment issues in
`WorktreeArtifactService`. Runs were preserved; no rerun-to-green was used.
Each slice also passed its PR CI and the post-merge `main` CI.

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

### MF-5 — Events, API, UI, Inspector surfaces (PARTIAL)

Merged:

- PR #89: canonical `memory` Runtime Event domain and the 13-definition family
  with payload guards on the existing registry;
- PR #91: emission wiring — within-transaction write seams on MF-1/MF-2/MF-4
  plus `MemoryRuntimeEventEmitter`, so a Memory fact and its canonical Event +
  Outbox row commit in one transaction.

Merged via PR #120 (API):

- `POST /api/workspaces/:workspaceId/memory/retrieve` — MF-3 retrieval as a
  read-only explanation surface with a visible `degraded` flag
  (`MemoryRetrievalService.retrieveWithStatus`); never persists a snapshot.
- `GET .../runs/:runId/memory-context` — every frozen Context Snapshot of a
  Run via the additive `MemoryContextSnapshotRepository.listForRun`;
- `GET .../memory-contexts/:memoryContextId` — one frozen snapshot with
  selection/exclusion reasons;
- `POST .../memory-conflicts/:conflictId/resolve` — transactional MF-2
  resolution with optimistic `expectedVersion`.

Known contract gap: canonical Memory Event emission is Run-scoped
(`MemoryRuntimeEventEmitter` requires a Run + L1C event context), so the
user-initiated conflict resolution above records the fact transactionally
without emitting a canonical Event. A Workspace-scoped memory Event context
contract is required to close this; not yet authorized.

Not started within MF-5:

- UI Memory explanation and Candidate review (consumes the merged API; the
  forward Candidate review endpoints are scoped with that UI slice);
- Inspector Context Snapshot view.

### Run startup integration (CLOSED)

Merged via PR #92: `MemoryContextResolver` composes MF-3 retrieval + MF-4
budget selection, persists the immutable Context Snapshot BEFORE injection, and
gates injection. `RunEngineProviderDispatcher` resolves and injects the
bounded context into the stage prompt when a resolver is configured; a blocked
injection or snapshot failure prevents the provider spawn. The production
`createProviderExecutionChain` supplies the resolver. Resolution is idempotent
per (Run, Stage).

## 7. Non-goals (unchanged)

- Vector Database or remote embeddings;
- semantic knowledge graph;
- autonomous global promotion;
- elaborate supersession graph or forgetting scheduler;
- highly autonomous extraction;
- sending the whole Memory Store to Providers.
