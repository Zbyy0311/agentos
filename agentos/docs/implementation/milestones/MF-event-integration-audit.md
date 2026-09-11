# Memory event integration: source audit before production wiring

Base: PR #126. Status: Candidate event corrections implemented on the next
branch; production wiring and conflict effects remain open.

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
3. Complete conflict Entry effects before claiming conflicted/superseded events;
   use persisted Entry metadata, never placeholder authority/scope/category.
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
