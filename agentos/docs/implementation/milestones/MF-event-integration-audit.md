# Memory event integration: source audit before production wiring

Base: PR #126. Status: Candidate and conflict event corrections implemented on
the next branch; production wiring and the Workspace-scoped event context
remain open.

## Findings

`MemoryRuntimeEventEmitter` is not constructed in production. Its existence
does not establish the Lite 07 section 15 audit behavior. Wiring it unchanged
would produce incorrect facts:

- `emitCandidateReviewed` maps reject to `memory.entry_expired`, although no
  Entry expired or may even exist. It maps merge-with-existing and
  review-required to `memory.entry_created`, and uses the Candidate version
  where the payload contract requires the Entry version.
- Automatic acceptance now creates both Candidate and Entry in one
  transaction. `emitCandidateCreated` currently emits only the Candidate event.
- Conflict methods synthesize workspace/decision/system-verified Entry
  metadata. They do not derive payload identity/version from the actual Entry,
  and the repository currently records only conflict disposition, not the
  declared Entry status/supersession effects.
- `DurableRuntimeFactWriter` and its sequence allocator require a real Run.
  Workspace-only user actions cannot be given a fabricated Run to satisfy this
  requirement. A separate Workspace event context/sequence contract is needed.

## Required next changes

1. Define a truthful Candidate review event for every review outcome and keep
   Candidate and Entry identifiers/versions distinct. Rejection and continued
   review do not imply an Entry lifecycle change.
2. Emit Entry creation only when a row is actually created, and evidence merge
   only for the existing target with its actual resulting version. Automatic
   acceptance must record both facts in the same transaction/outbox boundary.
3. [done — see evidence below] Complete conflict Entry effects before claiming
   conflicted/superseded events; use persisted Entry metadata, never placeholder
   authority/scope/category.
4. Wire the real Run-startup snapshot and terminal Candidate seams with
   authorized causal context. Preserve snapshot replay idempotency and prove
   that Event or Outbox failure rolls back the associated Memory write.
5. Design Workspace-only review/save event sequencing additively; do not weaken
   existing canonical Run checks or reuse an unrelated source Run as the actor
   of a later user review.

Tests must assert the actual durable Memory row change alongside each emitted
event, not only registry payload validity. Cover rejection with zero Entry
events, merge with no Entry creation, automatic acceptance with both facts,
outbox rollback, correct versions, scope isolation and replay.

## Candidate correction evidence

An additive `memory.candidate_reviewed` event carries Candidate ID/version,
outcome and nullable resulting Entry ID. Entry mutation events follow it only
when applicable and use the persisted Entry version. Automatic acceptance emits
Candidate creation followed by Entry creation within the same transaction.
Tests prove that failure inserting the secondary Outbox row rolls back both
records, both events, both Outbox rows and sequence allocation.

Focused emitter tests: 14/14; shared M3/MF0/MF5 contracts: 62/62; server
TypeScript passed. No migration or production event wiring is included yet.

## Conflict correction evidence

`MemoryCandidateRepository` now applies the conflict to the stored Entries in
the same transaction as the conflict row and returns the effects it persisted
(`MemoryConflictMutationResult`):

- open moves each `active` Entry to `conflicted` with a version bump and leaves
  every other status untouched;
- `keep-both` and `promote-source` release `conflicted` Entries back to
  `active` unless another open conflict still references them;
- `supersede-earlier` / `supersede-later` supersede the addressed side
  (ordered by `createdAt`, then id) and release the other one;
- `reject-both` rejects both sides; a soft-deleted Entry refuses the mutation
  with `ENTRY_NOT_UPDATABLE` instead of being resurrected.

`MemoryRuntimeEventEmitter` emits `memory.conflict_opened` and
`memory.conflict_resolved` (carrying the declared disposition) followed by one
Entry Event per Entry the mutation actually changed, using the persisted
`memory_entries` version. An Entry the disposition left untouched — an archived
side, or one still held by another open conflict — produces no Entry Event, so
no fabricated `conflicted`/`superseded` fact is written, and
`memory.entry_rejected` covers the reject-both outcome.

Evidence on this branch: `MemoryCandidateRepository.test.ts` 24/24
(`MF2R-20`–`MF2R-24` added, `MF2R-09` updated);
`MemoryRuntimeEventEmitter.test.ts` 20/20 (`MF5E-08` rewritten, `MF5E-11`–
`MF5E-16` added); shared `mf0-memory-contracts.test.ts` 20/20 with `MF0-20`
asserting the Lite 07 section 15 family plus the four additive extensions
(`memory.candidate_reviewed`, `memory.conflict_opened`,
`memory.conflict_resolved`, `memory.entry_rejected`); shared
`mf5-memory-events.test.ts` 10/10; the remaining Memory suites 88/88; server
`tsc --noEmit` and the shared build pass. Injected failure of the secondary
Entry Outbox row rolls back the conflict row, both Entry statuses and every
Event/Outbox row (`MF5E-15`). Full local server run: 2625/2632, the four
failures being the known Windows `ENOTEMPTY` teardown class reproduced at the
baseline.

Still open on this branch: the emitter is not constructed in production, and a
Workspace-only user review or resolve action has no authorized causal context
yet.
