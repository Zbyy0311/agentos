# M4-P5D Full Public Command Activation Design

## Goal

Activate the existing public Operation cancel command for active provider-backed
Runs while preserving the M3 HTTP contract and routing the final state change
through the accepted P5D lifecycle evidence handoff.

## Scope and invariants

- Base is `9998098c938d16269bc352b16a00e6c78aafe7e6`.
- The implementation branch is `runtime/m4-p5d-public-cancel-activation`.
- `packages/process-runtime` is read-only for this work.
- `ProcessCancelCoordinator`, `StageExecutionCoordinator.cancelAttempt`,
  `finalizeAttemptOnce`, and the existing lifecycle cancellation body remain the
  only process-stop/finalization/lifecycle mutation authorities.
- The public HTTP request remains the frozen P3D shape: URL
  `operationId`, no query, and exactly `{ expectedVersion }`. Clients never
  provide process IDs, native PIDs, or lifecycle metadata.
- The current V2/canonical queued Run cancel routes remain unchanged. The
  Operation route is the public Operation-bound command that has the required
  Run/Operation correlation and lifecycle transaction seam.

## Architecture

The public Operation cancel route performs a read-only operation/version
preflight, then invokes one injected active-cancel port before opening the
Operation transaction. The production composition root wires that port to the
existing `RunEngineProviderDispatcher`, which selects the persisted active
Stage attempt and calls `StageExecutionCoordinator.cancelAttempt`. No process
identity is discovered from a repository after cleanup.

The dispatcher converts a stopped outcome into proof only when the outcome is
explicit cancellation, proven cleanup, and carries a non-blank `processId`.
That value comes directly from `ProcessStopResult.process.processId` through
the existing `StageExecutionCoordinator` outcome. A no-process state returns
an explicit empty evidence list; an unproven, failed, ambiguous, or terminal
state fails closed.

The route passes the resulting internal evidence to the existing
`OperationService.cancel` guard. The service updates Operation and invokes
`LifecycleTransactionService.cancelRunForOperationWithEvidenceWithinTransaction`
inside the same caller-owned SQLite transaction. The seam revalidates the
captured `expectedRunVersion`, preserves the existing cancellation body, and
uses the existing approval-aware composite for `waiting_approval`.

## Error and race behavior

- A stale Operation version is rejected before process cleanup when observable,
  and is rechecked inside the transaction for deterministic `409
  VERSION_CONFLICT` behavior.
- A stale Run version after cleanup is rejected by the lifecycle evidence seam
  and mapped to the existing `409 VERSION_CONFLICT` transport.
- An already-cancelled Operation returns its persisted value without invoking
  process cleanup or lifecycle mutation.
- Completed/failed Operations and terminal bound Runs cannot regress.
- Duplicate requests may join the same Process stop ticket. The first
  lifecycle transaction wins; later requests converge on the already-cancelled
  Operation without a second lifecycle mutation.
- Missing, malformed, mismatched, or unproven process evidence fails closed and
  rolls back the Operation/lifecycle transaction.
- Waiting approval retains the exact event order:
  `approval.resolved -> stage.cancelled* -> run.cancelled`.

## Files and responsibilities

- `apps/server/src/services/OperationService.ts`: validate internal evidence,
  preserve the existing Operation guard, and select the accepted evidence
  lifecycle seam without duplicating cancellation mutation logic.
- `apps/server/src/routes/operations.ts`: keep the frozen HTTP contract,
  preflight stale/terminal cases, await the injected runtime cancellation port,
  and sanitize evidence/runtime failures.
- `apps/server/src/services/run-engine/RunEngineProviderDispatcher.ts`: expose
  the application cancellation seam over the existing coordinator and map
  exact proven Process identity to lifecycle evidence.
- `apps/server/src/services/run-engine/providerExecutionChain.ts`: expose the
  existing dispatcher cancellation capability at the composition boundary.
- `apps/server/src/index.ts`: wire the production Operation route to the
  provider execution chain without enabling a new background dispatch mode.
- `apps/server/src/services/OperationService.test.ts`,
  `apps/server/src/routes/operations.test.ts`, and
  `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts`:
  cover active success, stale versions, idempotency, approval ordering,
  evidence failures, terminal protection, and concurrent winner/loser races.

## Verification

Run targeted P5D tests, the full server suite, the process-runtime suite, the
M3 harness, the workspace build, and `git diff --check`. Inspect the final
changed-file list before one ordinary forward commit and push. Do not create a
pull request or start P5E/P6.
