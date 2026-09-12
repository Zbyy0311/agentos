# S1-C1: persisted validity and sensitivity eligibility

Requirement: `LITE-07-109`. Base: `f82821c734ad95daf3580bb37ddad905ed1c4e10`.
Authorization: user-approved tightened plan, existing S0 GAP and S1C-SOURCE
counterevidence; main-agent bounded contract frozen before implementation.

`MemoryRetrievalService.retrieveWithStatus` ignores persisted validity and
sensitivity fields, while MF1-schema-authorization explicitly requires expiry
filtering and explicit access checks for restricted content. The current
retrieval context has no verified restricted-content grant. Scope/owner reach
alone is not that grant.

## Narrow behavior

- Capture one server-owned clock value per retrieval; default remains Date.now.
  Optional constructor clock is a test seam, not an HTTP request parameter.
- Null validity means no constraint. `validFrom` is inclusive;
  `validUntil` and `expiresAt` are exclusive. Non-finite persisted dates fail
  closed. Invalid clock input fails the operation with the existing error.
- Exclude restricted Entries before FTS/ranking/limit in every current caller.
  Do not add an allowRestricted request flag or a Policy/access editor. A future
  explicit grant surface needs its own authorization contract.
- Reuse existing fields and retrieval service; no schema/row/status changes,
  ranking weights, owner reach, events or historical Snapshot rewrites.
- Excluded content never appears in retrieved results; no deletion occurs.

## Exit checks

Fixed-clock DB tests for before/start/end/expiry boundaries, combined windows,
malformed dates, restricted pinned content and query/limit ordering; eligible
rows and old retrieval ranking remain intact. Typecheck plus existing retrieval,
budget, resolver and API regression. This slice does not close `LITE-07-109`:
FTS fallback, budget/explanation and actual context evidence remain open.

## Evidence

- RED (unmodified service at base plus new tests):
  `node --import tsx --test --test-concurrency=1 src/services/MemoryRetrievalService.test.ts`
  in `apps/server`: 15 pass, 3 fail, 0 skip. Failures are deterministic missing
  filtering, not environment flakes. `tsx` permits the new constructor test
  seam at runtime before implementation; the old constructor ignores it.
- GREEN (base plus S1-C1 implementation):
  `node --import tsx --test --test-concurrency=1 src/services/MemoryRetrievalService.test.ts
  src/services/MemoryContextBudgetSelector.test.ts src/services/MemoryContextResolver.test.ts
  src/routes/memoryRuntime.test.ts`: 53 pass, 0 fail, 0 skip. The new resolver
  check follows selection through durable context text, verifies expiry in a
  later Stage snapshot and preserves the earlier snapshot and original Entry.
- `pnpm exec tsc --noEmit` in `apps/server`: exit 0.
- `node scripts/verify-lite-scope.mjs --implement LITE-07-109` and
  `git diff --check`: exit 0. Environment Windows, Node v24.18.0, pnpm 11.11.0.
- Independent review, merged integration and exact-head CI remain outstanding.
  This is not real Provider/browser evidence, nor full sensitive-data acceptance.
