# S1-C: retrieval verification narrowed to existing requirements

Scope: `LITE-07-007`, `LITE-07-013`, `LITE-07-109`.
Baseline: `8e4cc3ae81bf2a92337662d329a2a10647aecfdb`.
Status: source-audited GAP; implementation not included in PR #143.

## Concrete findings

- `MemoryRetrievalService.retrieveWithStatus` obtains rows by Scope/status,
  filters category/tags, and then ranks with `Date.now()`. Neither this method
  nor `MemoryEntryRepository.listRetrievalCandidates` applies persisted
  `validFrom`, `validUntil`, `expiresAt` or `sensitivity`. The existing fields
  should be used, not replaced by a new Memory schema.
- `MemoryContextBudgetSelector.plan` calls `retrieve`, discarding the
  `degraded` flag returned by `retrieveWithStatus`. A successful fallback can
  therefore become an ordinary Context without its warning/explanation.
- `applyBudget` never reads `requireDiversity`. It budgets `entry.tokenEstimate`
  while `plan` injects heading + content; heading/format costs are not counted.
  Its scope-limit exclusion is labelled `category-budget`, and its `truncated`
  branch actually excludes the whole Entry instead of truncating injected text.

## Bounded next checks and remediation

1. Write fixed-clock tests for not-yet-valid, expired, boundary timestamps and
   restricted sensitivity; inspect the existing authorization input before
   defining eligible sensitivity. No new policy product.
2. Drop/disable FTS in a test fixture and follow the real resolver→Snapshot→Event
   path. Preserve fallback reasons rather than silently resetting the flag.
3. Exercise current diversity policy and exact assembled context costs;
   never label excluded content as actual truncation. If a new explanation
   field/event payload is needed, freeze that minimal additive contract first.
4. Do not rewrite ranking, existing valid Snapshots, or change old migration
   checksums. Run the affected retrieval/resolver/Inspector tests only after
   concrete failures identify the narrow implementation boundary.

These findings map existing requirements; no additional product requirements
are created. No source-only claim changes a row to PASS.
