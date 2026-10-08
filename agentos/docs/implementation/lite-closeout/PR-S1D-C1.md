# S1-D/C1: explicit-save provenance and retrieval eligibility

Requires PR #143 (S0/S1-A). Requirements: LITE-07-003, LITE-07-107, LITE-07-109.
Exit checks and fixed boundaries: S1-explicit-save-dedup.md and
S1-retrieval-eligibility.md. No schema, new event, Policy product or Memory rewrite.

Changes: validate explicit saves before duplicate lookup; same active
Scope/category/owner only; exact new provenance and existing Workspace Event
commit together. Replays are no-ops. Retrieval filters persisted validity and
restricted content before FTS/ranking/limit, using one server-owned clock.

Validation: independent Luna max source reviews found no verified blocker in
the named boundaries. 46 S1-D tests, 53 C1 tests, and 115 integrated affected
tests pass; server typecheck and workspace build pass. C1 first RED is retained
(15 pass/3 deterministic fail). S1-D first full server run: 2713 pass/4 fail/3
skip, exit 1; the four ENOTEMPTY teardown failures are recorded in evidence.json,
not silently ignored or retried. Exact-head required CI must pass before merge.

Remaining gaps stay OPEN: normalized near-duplicate review/provenance,
review-promotion convergence, source truthfulness, Global/security review gates,
FTS degradation, context budget/explanations and real product/Provider evidence.
These slices do not claim S1 or Lite completion.
