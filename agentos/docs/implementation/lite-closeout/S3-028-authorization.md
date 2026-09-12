# S3 / 028 runtime approval authorization (frozen v1)

Requirements: LITE-08-005/006/007 and LITE-07-103. Supporting scope:
LITE-07-108 remains open for no-Run triggers; this Run-bound approval path uses
Runtime Event + Outbox and does not close it. Authority: user-approved tightened
plan plus `S3-production-gap.md`. Base: S2 PR145 head `97b5b885`; local 016
test correction `419b7a13`. 001–027 remain unchanged. Assign 028 only after
checking the post-#145 main registry; do not renumber.

## Boundary and reuse

The first AgentOS-owned enforcement boundary is provider-backed canonical Stage
execution in `RunEngineProviderDispatcher`, before `StageExecutionCoordinator`
is invoked. A stage whose frozen Agent/Provider snapshots permit Workspace
mutation is ASK_USER; read-only is allowed only after the existing Workspace
admission gate proves enforced read-only. No Policy DSL, grants engine, UI
editor, RBAC, simulation, or Provider approval authority is added.

Reuse `LifecycleTransactionService.requestApproval`,
`resolveApprovalToRunning`, `resolveApprovalToFailure`, and
`resolveApprovalToCancellation`; add only caller-owned `WithinTransaction`
forms needed to compose durable rows with their existing lifecycle
Event/Outbox in one transaction. Reuse 026 `approval_decisions` as the
immutable user decision fact; 028 adds the pending/approved request, snapshot,
expiry, and consumption state that 026 deliberately does not own.

## Migration 028 contract

Add `runtime_approval_requests`; no backfill and no rewrite of 026/027:

- immutable identity: `id`, `workspace_id`, `run_id`, `stage_id`,
  `stage_attempt`, `operation_id`, `source_key`;
- immutable redacted action: category/risk/title/description, bounded
  `request_snapshot_json`, `snapshot_hash`, `action_fingerprint`,
  `policy_version`, `requested_at`, `expires_at`;
- decision state: `status` pending/approved/rejected/cancelled,
  `resolution`, nullable `decision_record_id`, `decided_by`, `decided_at`,
  nullable `consumed_at`, optimistic `version`, timestamps;
- FKs prove same-Workspace Run, optional same-Run Stage, original `run.start`
  Operation, and 026 decision record. The request stores IDs and redacted
  normalized facts only; never secret values, raw output, env values, or full
  prompts;
- `UNIQUE(workspace_id, source_key)` gives deterministic replay for the same
  Run/Stage/attempt/action; one partial unique pending request per Run;
- identity/snapshot/action/requested fields are immutable. Mutable fields are
  only status/resolution/decision linkage/decision metadata/consumption,
  version and updated_at;
- pending requests expire by timestamp and one-shot execution. A stale
  snapshot, changed Stage attempt, terminal Run, missing admission, or expired
  request cannot execute.

`source_key` is a bounded hash of Workspace, Run, Stage, attempt and canonical
action fingerprint. Caller text never becomes an unbounded key. Snapshot hash
uses canonical JSON of the redacted snapshot. Unknown classification is
modifying and therefore ASK_USER at this first boundary.

## Execution and continuation

1. Before coordinator invocation, the dispatcher validates the current Run,
   Stage attempt, original `run.start` Operation and frozen Provider/Agent
   snapshots, then evaluates the normalized action. Replay finds the same
   source key and returns the existing request.
2. ASK_USER writes 028 + approval.required + waiting Run/Stage in one
   transaction and returns without spawning. No replacement Run or Operation.
3. The resolve API requires expected request version. It revalidates pending
   status, expiry, original Run/Stage/attempt, snapshot hash and action
   fingerprint. Concurrent decisions use the request version and existing
   approval-history binding; exactly one committed decision wins and retries
   return it.
4. Accept writes the immutable 026 decision, approval.resolved, original
   Run/Stage back to running, and one review-required Candidate in the same
   transaction. Candidate sources are the Run plus the just-written
   approval.resolved Event; the Runtime Event + Outbox emission re-proves the
   028 request, 026 decision, Candidate and actual operation causation.
   Reject/cancel write the decision and use the existing failure/cancellation
   lifecycle; they never create the accepted-decision Candidate.
5. Approval resolution does not itself spawn. A registered continuation calls
   the existing dispatcher after commit. The dispatcher may continue a running
   original Run whose start Operation is already completed; it must not call
   the queued-start claim again. Before coordinator invocation it rechecks the
   approved unconsumed request, snapshot, current attempt, expiry and Workspace
   admission.
6. The request is marked consumed only after the durable coordinator proves
   the actual Process was spawned or an existing authority attempt was joined.
   Startup scans approved unconsumed requests after recovery/admission
   reconciliation and re-drives their original Runs, so a crash between
   decision commit and continuation cannot strand execution. A crash after
   spawn remains governed by existing Process recovery.

## Required proof

Fresh and 027 upgrade apply identical additive 028; checksum and FK/identity
tests; old migration replay remains intact. Prove request persistence and no
spawn, accept/reject/cancel concurrent CAS, retry convergence, expiry and
fingerprint/attempt drift refusal, original Run/Stage/Event causation,
candidate transaction rollback, no raw secrets in snapshots/events, restart
with pending request, and restart after approved-but-unconsumed decision. The
Dispatcher proof must show no replacement Run/Operation and no second spawn.
Live Provider proof remains RUNTIME-VERIFY; this slice does not claim that
uninterceptable Provider-native tool actions were blocked.

This authorization is not implementation evidence and does not mark any matrix
row PASS. If production audit finds an already durable equivalent request
registry, amend this record before changing the schema.
