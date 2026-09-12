## Requirements / bounded exit

LITE-08-005/006/007 and LITE-07-103, S0 matrix v8. Implements durable
ASK_USER request state at the canonical Provider Stage pre-spawn boundary,
original Run continuation/rejection, replay/expiry/drift protection, restart
continuation of approved unconsumed requests, and the accepted-decision
Candidate Event. Matrix rows remain GAP until live Provider/browser acceptance
and full CI complete.

## Change boundary

- Additive migration028 after merged027; no 001-027 rewrite.
- Reuse existing canonical lifecycle and Runtime Event+Outbox; caller-owned
  seams compose request, decision, lifecycle, Candidate and Event atomically.
- Gate runs after Adapter Launch Plan creation and before Session/Process
  reservation/spawn. Read-only stages remain allowed only through the existing
  admission evidence path; modifying/unknown permission asks.
- Lite route supports only approve_once/reject with expected request version.
  No Policy DSL, grant engine, Policy editor UI, RBAC, replacement Run or
  Provider-native approval authority.

## Evidence / merge gates

Post-review exact head d76cce34: 13 targeted review-fix tests pass and server
typecheck passes. Final full Server run: 2753 pass,4 fail,3 skip; all four
failures are ENOTEMPTY teardown leftovers, not S3 assertions. Earlier evidence
is preserved in S3-LOCAL-39, S3-FULL-FIRST, S3-FIXED-FOCUSED, S3-REVIEW-FIX,
and S3-FULL-FINAL.
Proven: pending creates no Session/Process/spawn; approval resumes original
Run/Operation and consumes once; reject terminates without Candidate; snapshot
or launch drift cannot execute; expired decisions persist expired; candidate
Event failure rolls back the whole decision. Independent review findings were
fixed before PR: expiry is revalidated immediately before consuming spawn
right, contradictory approve/reject is 409, recovery-required Runs are not
auto-resumed, and environment values contribute to the Launch fingerprint
without being persisted.

CI must be green on the exact head before merge. First route fixture failures
were test-only invalid snapshots/operation terminal timestamps and are retained
in conversation evidence; no product masking. Do not infer live Provider proof
from the fake-driver integration.
