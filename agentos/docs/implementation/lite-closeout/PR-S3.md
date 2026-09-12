## Requirements / bounded exit

LITE-08-005/006/007 and LITE-07-103, S0 matrix v7. Implements durable
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

Post-rebase exact head: 39 targeted tests = 38 pass,0 fail,1 env-gated Kimi
skip; server typecheck passes. Earlier integrated affected run: 101 tests =
100 pass,0 fail,1 same skip. See S3-LOCAL-39 and S3-028-authorization.md.
Proven: pending creates no Session/Process/spawn; approval resumes original
Run/Operation and consumes once; reject terminates without Candidate; snapshot
or launch drift cannot execute; expired decisions persist expired; candidate
Event failure rolls back the whole decision.

CI must be green on the exact head before merge. First route fixture failures
were test-only invalid snapshots/operation terminal timestamps and are retained
in conversation evidence; no product masking. Do not infer live Provider proof
from the fake-driver integration.
