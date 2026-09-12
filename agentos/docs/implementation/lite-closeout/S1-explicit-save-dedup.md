# S1-D: explicit save validation and provenance

Requirements: `LITE-07-003`, `LITE-07-107`. Parent: PR #143 / `f82821c7`.
Status: implemented; local focused checks pass, independent review/full
regression and exact-head CI remain gates. Isolated from the in-flight #143
head. No migration or new event type.

## Counterexample

POST /memory/entries searches hashes before the Entry repository validates
scope/category/sources. A body with an invalid scope and existing content can
return 200 and an unrelated Entry; another category or archived row can also
swallow a valid save. New provenance on an exact duplicate is discarded.

## Boundary and exits

- Reuse the existing Entry input validator before ANY duplicate response.
  Do not expand supported owner-specific saves or invent owner data.
- Put validation, active same-scope/category/owner matching, source merge and
  event emission inside one transaction. Preserve existing no-source exact
  replay behavior (200, no version/Event increment).
- Exact matching uses S1-A source merge; emit existing Workspace
  `memory.entry_deduplicated` under existing entry-save origin when sources change.
  No Run/Operation/Outbox is fabricated.
- Normalized matching must also remain within boundary; do not silently attach
  changed source content to an existing Entry. Keep its current no-source
  convergence for compatibility and record provenance-bearing near-duplicate
  behavior separately if implementation requires review-contract changes.
- Source/Event failure rolls back; invalid input returns 400 even when a hash
  matches; category/scope/inactive targets cannot cross-converge.

No secret-detection framework, review engine redesign, new owner UI or Provider
work is part of this narrow repair. Remaining acceptance stays open.

## Local evidence and remaining scope

- Windows, Node v24.18.0, base `f82821c734ad95daf3580bb37ddad905ed1c4e10`
  plus this S1-D diff. `pnpm exec tsc --noEmit` in `apps/server`: exit 0.
- `node --import tsx --test --test-concurrency=1 src/routes/memoryRuntime.test.ts
  src/store/MemoryEntryRepository.test.ts src/store/WorkspaceEventWriter.test.ts
  src/services/WorkspaceEventContextAuthority.test.ts` in `apps/server`:
  46 pass, 0 fail, 0 skip. The authority file contributes no standalone tests;
  its production behavior is exercised by the Workspace Event writer tests.
- Added API checks cover malformed sources/tags/owners before lookup,
  category/Scope and archived matches, exact provenance replay, source-write
  and Event-write rollback, and four concurrent HTTP save requests. The latter
  proves the current single-server route, not independent multi-process writes.
- `node scripts/verify-lite-scope.mjs --implement LITE-07-003 LITE-07-107`
  and `git diff --check`: exit 0. Matrix IDs remain GAP.

The normalized-text branch now observes the same boundary but still retains
the old response contract. A source-bearing near duplicate currently returns
the existing Entry without recording the new source; this is NOT accepted as
completion. Preserve it under `LITE-07-003/107` for the review-contract slice,
along with review-promotion convergence. Source identity truthfulness and
Global/security review gates are not proved by input-shape validation here.
No product/Provider/browser completion is inferred from these focused tests.
