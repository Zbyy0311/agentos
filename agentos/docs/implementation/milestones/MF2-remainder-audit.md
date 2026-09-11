# MF-2 Remainder — Current-State Audit and Slice Design

Status: AUDIT COMPLETE — SLICE MF-2R (terminal-outcome trigger + dedup completion) IMPLEMENTED ON THIS BASIS

Base: `origin-https/main @ b4e7a0a0` (Merge PR #124). Read-only seam inventory
verified against source at that revision.

## 1. Purpose

MF-progress.md section 6 leaves two MF-2 items open: candidate generation
triggers bound to meaningful transitions, and near-duplicate FTS-similarity
detection beyond the exact/normalized hashes. This audit establishes which of
the six spec triggers (07-Memory-Runtime.md section 7) have a durable seam to
bind to, and freezes the smallest honest slice.

## 2. Trigger seam matrix (verified)

| Spec trigger | Durable seam today | Evidence |
|---|---|---|
| Explicit user save | Legacy only (`MemoryService.create`, no transaction, no event); no forward entry-save API | `routes/memories.ts:21`, `services/MemoryService.ts:51` |
| Task/Run/Stage terminal outcome | YES — canonical, transactional, evented | `LifecycleTransactionService.completeRun` (:1499) via `RunEngineProviderDispatcher.executeProviderStage` (:442) |
| Accepted approval decision | NO durable production seam (registry in-memory; transactional `resolveApprovalTo*` is test-wired only) | `ApprovalRegistry.ts:18`, `LifecycleTransactionService.ts:1036` |
| Completed review/test Artifact | NO — no review/test artifact type exists | `packages/shared/src/types/index.ts:362` |
| Conversation compaction | NO — no compaction implementation at all | zero `compaction` hits in `apps/server/src` |
| Explicit import | Workspace import (transactional) but forces `memory:false`; no memory import endpoint | `WorkspaceManager.ts:102`, `routes/workspaces.ts:33` |

Only the terminal-outcome trigger has a seam that satisfies the MF
transaction/evidence bar. Binding the other five requires creating new durable
seams (approval durability, artifact typing, compaction itself) — separate
authorized work, recorded here as NOT this slice.

## 3. Merged substrate this slice composes

- `MemoryCandidateRepository` (MF-2): gate, versioned review, exact-hash
  lookup, conflict open/resolve. Missing: normalized-hash lookup.
- `MemoryEntryRepository` (MF-1): entries + FTS5 `memory_entries_fts`.
- `toSafeFtsQuery` (MF-3): neutralized FTS5 expressions.
- Canonical terminal seam with full ids + artifact ids (dispatcher to
  `completeRun`).

## 4. Frozen slice design (MF-2R)

1. `MemoryCandidateRepository.findEntryByNormalizedHash` — additive read;
   completes dedup order step 2 (exact, then normalized).
2. `MemoryCandidateGenerationService.generateForRunTerminal` — for a
   `completed` canonical Run, builds a bounded Evidence Bundle from durable
   records only (task title, stage outcomes, artifact ids, duration; never raw
   Provider output), then:
   - exact-hash hit — converge: no new candidate (`converged`);
   - normalized-hash or FTS near-duplicate hit — candidate created with
     `duplicateResolved: false`, which the MF-0 gate forces to
     `review-required` (dedup order steps 2 and 4);
   - otherwise candidate created; gate decides (agent-derived plus
     conservative confidence means `review-required`, landing in the MF-5
     review queue).
   Idempotent per (Run, trigger) via a deterministic candidate id
   (`mcand_terminal_<runId>`) with a find-before-create guard.
3. Dispatcher binding: optional `memoryCandidateGenerator` dependency called
   AFTER `completeRun` commits. Generation failure never fails or mutates the
   already-terminal Run; it is caught and reported. Wired in
   `providerExecutionChain`.

## 5. Boundary (unchanged contracts honored)

- No schema or migration change.
- No canonical Memory Event emission: the only production event-authority
  posture for non-lifecycle writes is deny-all
  (`WorkspaceGitObservationService.ts:65` precedent); a Run-scoped memory
  emission authority is not authorized. Same recorded gap class as the MF-5
  user-initiated writes (MF-progress.md section 6).
- Failure-terminal Runs, Stage-level triggers, and the four seam-less triggers
  are follow-ups, each requiring their own seam work first.
- Legacy candidate pipeline (`MemoryCandidateService`, legacy routes) remains
  COMPATIBILITY and untouched.

## 6. Acceptance gates

| Gate | Requirement |
|---|---|
| MF2R-G1 | Completed Run generates a review-required Candidate with bounded evidence and a Run source ref. |
| MF2R-G2 | Replay/re-dispatch of the same Run converges (no duplicate Candidate). |
| MF2R-G3 | Exact duplicate content converges without a new Candidate. |
| MF2R-G4 | Normalized-hash or FTS near-duplicate forces `duplicateResolved=false`, so `review-required`. |
| MF2R-G5 | Non-completed Run generates nothing. |
| MF2R-G6 | Generation failure after Run completion does not change Run state. |
| MF2R-G7 | Focused suites + tsc green; full Server run preserves first-run evidence. |
