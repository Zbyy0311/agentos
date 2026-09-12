## Requirements / bounded exit

LITE-07-104 and LITE-07-108, S0 matrix v6. This slice implements the actual
Artifact producers and atomic completion/candidate/event/review-source path.
Full requirement remains GAP pending live model invocation and remaining
failure/recovery acceptance; this PR does not close Lite.

## Change boundary

- Preserve original uncommitted draft; additive authorized027 only,001-026 unchanged.
- Explicit complete command+exit proof for conservative typed test finalization;
  ambiguous package/wrapper/tool-success observations remain reports.
- Canonical bounded structured final-result seam; no inferred review approval.
- Atomic immutable completion, source-proven pending Candidate, Workspace Event
  or real canonical Event+Outbox; replay/concurrency/rollback protection.
- Reuse review API and add encoded Artifact source link. No Memory framework,
  Policy product, workflow editor, provider adapter rewrite, or scope expansion.

## Evidence / merge gates

27 focused S2 tests,66 affected regressions,2 new Dispatcher checks,6 parser
tests,4 component tests and server/web typechecks pass. Migration acceptance:
305 pass,1 explicitly environment-skipped,0 fail. Actual Node subprocess and
real page->source popup->accept->persisted review validated using isolated data.
Seeded execution/provider observations are not claimed as live model evidence.

Full suites/build and exact-head CI must be reviewed before merge. Preserve
first failures/skips, no repeated CI reruns to obtain green. S2-artifact-evidence.md
contains counterexamples, corrections and open runtime gates. Dependencies:
#143 merged50255d83; #144 must merge first. No automatic merge.
