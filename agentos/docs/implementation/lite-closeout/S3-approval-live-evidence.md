# S3 runtime authorization: live Provider evidence

Requirements: LITE-08-005, LITE-08-006, LITE-08-007 and LITE-07-103. Their earlier
evidence was in-process with a fake driver; the rows stayed GAP because each exit also
asks for a real invocation and real decision records.

## The gate

`apps/server/src/services/run-engine/RuntimeApprovalGate.liveGate.test.ts`, gated on
`M4_P4_REAL_APPROVAL_GATE=1`:

```
cd apps/server
M4_P4_REAL_APPROVAL_GATE=1
AGENTOS_OPENCODE_CLI=<opencode executable>
AGENTOS_OPENCODE_MODEL=deepseek/deepseek-v4-flash
  node --import tsx --test src/services/run-engine/RuntimeApprovalGate.liveGate.test.ts

  LITE-08-005/006/007 + LITE-07-103 ... (23845.3891ms)   1 pass / 0 fail
```

It drives `createProviderExecutionChain` - the production composition root, including the
production `RuntimeApprovalGate` with its `continueRun` continuation - against a real
OpenCode CLI. The Agent holds `read` **and `write`**, which is what makes the gate require
a user decision; a read-only Agent is allowed straight through and is covered by the
artifact gate.

## What it asserts

1. **LITE-08-005 - ASK_USER persists and pauses before any spawn.** After one `drive()`,
   the Run and its Stage are `waiting_approval`, exactly one request is persisted for that
   Run, the request names that Stage, its expiry is in the future, and
   `action_fingerprint`, `agent_snapshot_hash`, `provider_snapshot_hash` and
   `launch_plan_hash` are all 64-hex frozen identities with a persisted request snapshot.
   `runtime_processes` for the Run is **0**: the pause happens before any provider process
   exists.
2. **Per-action authorization.** Because every write-capable Stage needs its own decision,
   the approved Run pauses again for its next Stage. The gate approves each request as it
   appears and then asserts the Run produced exactly **two** requests, both `approved`,
   naming the two Stages it authorized, and exactly **two** provider processes - one
   execution per approved action.
3. **LITE-08-006 - a replayed decision is idempotent, a conflicting one is refused.**
   Replaying the same `approve_once` with the same expected version returns
   `replayed: true` with the same candidate id, leaves exactly one decision record, and a
   `reject` on the resolved request raises `RUNTIME_APPROVAL_CONFLICT` without changing the
   committed resolution.
4. **LITE-08-007 - version and expiry are enforced.** A decision carrying
   `expectedVersion + 1` is refused and leaves the request pending with zero processes.
   Expiry is produced the way the gate itself produces it - the production
   `RuntimeApprovalRepository.markExpiredWithinTransaction`, called with a clock past the
   persisted `expiresAt` (the row is identity-immutable, so this is what time passing does
   to a real request) - after which a decision is refused, no decision row is recorded,
   the persisted deadline is unchanged, and `runtime_processes` stays 0.
5. **LITE-07-103 - the accepted decision triggers its fact.** Accepting produced a
   `user-explicit`, `decision`-category Candidate whose sources are the Run and the
   resolution Event, plus its canonical `memory.candidate_created` Runtime Event naming
   the candidate.

## Findings

- The #154 defect is reproduced here independently. On a tree without that fix the gate
  fails at the first Stage with
  `MemoryContextResolverError: MEMORY_CONTEXT_RESOLVER_SNAPSHOT_FAILED` (the memory Event
  envelope rejecting a `stageId`), so this branch is stacked on #154.
- The #150 work is required too: on plain `main` the same attempt fails with
  `PROVIDER_VERSION_UNSUPPORTED`, because main's OpenCode adapter still refuses every
  production configuration. The gate is therefore based on the S8 acceptance head.
- **Residual behaviour, recorded rather than asserted away:** expiry is observed lazily -
  on a decision attempt, or on a new launch attempt via `assertSameAction` - and there is
  no sweeper. An expired request therefore leaves its Run in `waiting_approval` with the
  attempt unconsumed, and the operator cancels it or asks for a fresh decision. That
  satisfies "expired approvals cannot execute" (nothing executes, no decision is
  recorded) but not a stronger claim that the Run self-terminates; a follow-up slice could
  add an expiry sweep that fails the Run with `RUNTIME_APPROVAL_EXPIRED`. It is noted here
  so the row is not read as covering it.

## Boundary

Real-invocation evidence produced on the operator machine: CI has no provider CLI, so the
gate skips there (`# SKIP`, asserted) and the matrix row should carry a local executed
result, not a claim that CI re-runs it. The branch is stacked on #150 and #154 and touches
only the new gate plus this document; no matrix edit is included, so the four rows keep
their GAP state until the closeout PR promotes them with this evidence.
