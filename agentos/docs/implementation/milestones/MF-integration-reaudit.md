# Memory Foundation integration re-audit

Audit base: PR #125 merged as `800d6dd21f8bb80c7d9fc2084c61c0f8e80c2611`.
Status: open findings; merged components are not end-to-end acceptance.

## Findings and implementation order

1. Candidate review: `MemoryCandidateRepository.reviewCandidateWithinTransaction`
   only updates outcome/version/link. Accept creates no Entry, edited fields
   are absent, merge adds no source evidence, and terminal outcomes can be
   reviewed again with their new version. First correction: atomic review,
   promotion or evidence merge with scope ownership preserved; prove retrieval,
   stale-write rejection and rollback. Existing tables suffice.
2. Snapshot replay: `MemoryContextResolver.assemble` re-reads live Entry title
   and content, silently omitting missing Entries. `MemoryContextBudgetSelector`
   records versions but does not populate the optional content hash. A selected
   ID/version is not an immutable content reference without versioned storage.
   Persist the actual injected content or an immutable artifact, and resolve
   snapshots by exact Run/Stage identity rather than only the latest Run row.
   Prove identical replay after edits/deletion and replay of an earlier Stage.
   If persistence requires schema additions, prepare the additive design before
   changing the migration ledger; never rewrite migration 018.
3. Runtime Events: no production construction of `MemoryRuntimeEventEmitter`
   was found under `apps/server/src` excluding tests. Transactional emitter
   primitives exist, but their existence does not prove emitted Memory events.
   Wire actual Run-scoped writes and define the user-review event context.
4. Inspector UI: `RuntimeInspectorView` has only its declaration and test
   references under `apps/web/src`. Mount it through a trusted production
   projection and verify real navigation and response shape in the browser.
5. Trigger coverage: PR #125 invokes generation after the successful final
   dispatcher Stage. It does not establish all terminal paths, crash recovery,
   explicit user save, approvals, review/test artifacts, compaction or import.
   Exact-hash convergence currently returns an Entry ID without adding evidence;
   duplicate hints are returned transiently. Track these as open pipeline work.

## Acceptance reporting

Current local corrections address findings 1, 2 and the production mounting in
4. Candidate/generation/API tests passed 33/33; snapshot/budget/migration024
tests passed 36/36; Inspector projection/routes passed 14/14. Migration suite:
351 passed, 1 skipped. Web suite: 162/162. Desktop Playwright/Edge fixture QA
verified the actual workbench route, Run switching and refresh without console
errors. Frozen payload design and historical replay behavior are documented in
`MF-snapshot-replay-design.md`. Full server first run: 2617 total, 2608 passed,
6 failed, 3 skipped. Two missed migration-order assertions outside the migration
test directory were corrected and passed targeted verification (2/2). Four
Windows ENOTEMPTY teardown failures remain recorded. All four reproduced in a
detached `800d6dd2` baseline checkout on the same Node 24 environment. Baseline
tests reused unchanged workspace dependency builds; the first Conversation
attempt lacked a shared dist link, then reproduced ENOTEMPTY once that setup
issue was corrected. No full-suite rerun was used. CI closeout is pending.

Record each fix with its commit, focused behavioral tests and CI result.
Do not treat a green component test or a merged PR as proof of the full Lite
07 contract. Historical suite failures remain historical observations until
baseline comparison establishes their cause; do not infer unrelatedness solely
from a repeated Windows teardown error name.
