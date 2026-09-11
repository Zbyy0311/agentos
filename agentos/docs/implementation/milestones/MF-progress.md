# Memory Foundation — Progress and Remaining Work

Status: PARTIAL — merged slices do not yet constitute an end-to-end Memory Foundation closeout

## 1. Purpose

This record tracks the Memory Foundation slices defined by
`docs/implementation/milestones/MF-entry-audit.md`, so the remaining work is
legible without re-auditing the repository.

## 2. Merged baseline

| Field | Value |
|---|---|
| Baseline | `origin-https/main @ 800d6dd2` (Merge PR #125) |
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
| MF-5 | Events, emission, Run injection, API, Candidate review API, UI, Inspector surfaces | **MERGED** | #89 (events), #91 (emission), #92 (Run injection), #120 (API), #122 (Candidate API + Inspector wiring), #123 (UI) |

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
| MF-5 Candidate queue API + review + Inspector wiring | 21/21 focused PASS (incl. MF2R-12) |
| MF-5 UI (explanation, review queue, Inspector detail) | web 162/162 PASS; `next build` clean |
| Full Server run (MF-5 API head) | 2590 total, 2583 passed, 4 failed, 3 skipped |
| Full Server run (MF-5 Candidate API head) | 2593 total, 2586 passed, 4 failed, 3 skipped |

The recorded 4 server failures were Windows `ENOTEMPTY` temp-directory
teardown failures in `worktrees.test.ts` (2), `ConversationService.test.ts`,
and `LegacyTaskItemImportService.test.ts`. Their recurrence alone does not
prove baseline equivalence or unrelatedness. Earlier `tar` failures in
`WorktreeArtifactService` are separate historical observations. The MF-5
full suite was also repeated to capture logs; do not interpret these records
as a single unrepeated run. CI evidence is revision-specific as listed above.

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

Completed after the API slice:

- PR #122: forward Candidate queue + version-guarded review endpoints
  (`GET /memory/candidates`, `POST /memory/candidates/:id/review`) and the
  production Inspector `memoryContextSnapshots` wiring (the projection
  previously always returned `null`).
- PR #123: Memory explanation view (12 §14), forward Candidate review queue
  UI, and the Inspector Memory detail section. `edit-and-accept` is not
  offered in the UI because the merged review contract records the outcome
  without applying edited fields.

MF-5 remains partial. A source audit after PR #125 found that Candidate review
updated its outcome without promoting an Entry. The local correction now
creates the Entry atomically for accept and automatic acceptance, applies
validated edit-and-accept fields, and merges source evidence only into an active
same-owner/same-scope Entry. Reviewed terminal candidates reject replay; old
auto-accepted rows without promotion metadata remain explicitly reviewable.
Candidate/generation/API tests passed 33/33. This does not close the remaining
trigger, duplicate-convergence, conflict-disposition or production Event gaps.

The Inspector projection now includes Scope, Category, Authority, Confidence,
Importance, sources and maximum token budget. Its production conversation
workbench panel selects a linked Run and supports refresh. Server Inspector
tests passed 14/14 and Playwright/Edge desktop fixture QA exercised conversation
selection, Run switching, and refresh with no console errors. The fixture test
is not a live Provider execution acceptance test.

PR #125 (`800d6dd2`) adds candidate generation after successful Run completion
in the provider dispatcher, with normalized-hash and title-FTS duplicate
signals. This is one trigger slice, not completion of all six triggers or
dedup evidence convergence.

An event-integration audit followed the promotion corrections
(`MF-event-integration-audit.md`). On this branch the Run-scoped production
seams are now wired: `createProviderExecutionChain` builds one
`MemoryRuntimeEventEmitter` over the store's bound Runtime Event + Outbox
writer and a `DurableMemoryRuntimeEventContextAuthority`, and hands it to the
Run-startup `MemoryContextResolver` and the terminal
`MemoryCandidateGenerationService`. Each Memory fact and its canonical Event
now commit in one transaction; the caller's causal context is a claim that the
durable `operations`/`runtime_events` row must prove, so an unproven origin
fails closed instead of fabricating causation. Replay stays a pure read and
appends no second Event; an Event or Outbox failure rolls the Memory write back.
Evidence: 161/162 across the affected suites plus the Operation and Memory
routes (1 environment-gated skip), `tsc --noEmit` exit 0, with dedicated
emission suites for the authority, the composition root, the snapshot seam and
the candidate seam. The Workspace-only Memory routes still record their fact
without a canonical Event; that contract gap is unchanged and not yet
authorized.

### Run startup integration (MERGED; replay integrity OPEN)

Merged via PR #92: `MemoryContextResolver` composes MF-3 retrieval + MF-4
budget selection, persists the immutable Context Snapshot BEFORE injection, and
gates injection. `RunEngineProviderDispatcher` resolves and injects the
bounded context into the stage prompt when a resolver is configured; a blocked
injection or snapshot failure prevents the provider spawn. The production
`createProviderExecutionChain` supplies the resolver. Resolution is idempotent
per (Run, Stage).

Reopened integrity gap at PR #125: replay read current Entry content. The local
correction stores the injected text and SHA-256 in additive migration 024,
atomically with the snapshot. Replay reads that frozen payload and rejects
missing/corrupt historical payloads. Exact Run/Stage lookup is also corrected.
Behavioral tests cover Entry edits/logical deletion, empty payload, corrupt
payload, historical metadata-only snapshots and rollback. Merge/CI closeout is
still pending; see `MF-snapshot-replay-design.md`.

## 7. Non-goals (unchanged)

- Vector Database or remote embeddings;
- semantic knowledge graph;
- autonomous global promotion;
- elaborate supersession graph or forgetting scheduler;
- highly autonomous extraction;
- sending the whole Memory Store to Providers.
