# M3 P2 Final Verification Correction

Status: REMEDIATION IMPLEMENTED - LOCAL GATES PASS - PENDING INDEPENDENT REVIEW

Remote Checks: UNAVAILABLE - NOT PASS

P3: NOT AUTHORIZED

Production Cutover: NOT AUTHORIZED / NOT STARTED

This is a forward-only correction to the historical M3 P2 closeout record.
The historical `M3-p2-final-verification.md` is intentionally retained
unchanged. This document supersedes its P2 status conclusion for review
purposes until the remediation receives an independent review.

## 1. Finding and remediation

The independent review of commit `295ddc42e17f69c07004527a2deba192e4baaab0`
found that the production V2 queued Run cancellation path still used the
state-only `RunRepository.transitionStatus(..., 'cancelled')` path. That path
did not append `stage.cancelled`, `run.cancelled`, Run sequence values, or
durable Outbox rows. The historical closeout statement that there was no
Current State-only lifecycle transition was therefore not valid for V2 Run
cancellation.

The production remediation is:

| Item | Evidence |
|---|---|
| Remediation commit | `fb9a1e8f65f47abbea04a652b90ba1be1cee1f42` |
| Parent | `295ddc42e17f69c07004527a2deba192e4baaab0` |
| Commit subject | `fix: route v2 run cancellation through lifecycle events` |
| Branch | `runtime/m3-p2-transactional-lifecycle-core` |
| Remote branch after Push | `fb9a1e8f65f47abbea04a652b90ba1be1cee1f42` |

The remediation commit changes only these four production/test files:

- `apps/server/src/services/LifecycleTransactionService.ts`
- `apps/server/src/services/TaskRunService.ts`
- `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`
- `apps/server/src/routes/v2Runs.test.ts`

## 2. Closed call chain and transaction ownership

The V2 path now resolves as:

```text
POST /api/workspaces/:workspaceId/v2/runs/:runId/cancel
  -> TaskRunService.cancelQueuedRunForV2()
  -> executeV2Mutation() caller-owned outer runInTransaction()
  -> cancelQueuedRunForV2InTransaction()
  -> LifecycleTransactionService.cancelRunWithinTransaction()
  -> Stage transition + stage.cancelled + Outbox per affected Stage
  -> Run queued -> cancelled + run.cancelled + Outbox
  -> existing Task reconciliation
  -> keyed Idempotency Success
  -> commit
```

`cancelRunWithinTransaction()` does not open a transaction. The public
`cancelRun()` continues to wrap the same shared body in exactly one
transaction for existing callers. V2 no longer calls the Legacy/M2
`cancelQueuedRunInTransaction()` state-only implementation. That compatibility
method remains for its existing non-V2 callers.

The shared cancellation body now sorts affected Stages by
`sequence ASC, id ASC`, uses one canonical timestamp, allocates contiguous Run
sequences, writes one Outbox immediately after each durable Event, and leaves
terminal Stages unchanged. N=0 emits only `run.cancelled` and its Outbox.

## 3. Remediation evidence

The new tests prove:

- V2 queued cancellation does not call `RunRepository.transitionStatus`.
- N=0 and N>0 cancellation preserve Event order, sequence, timestamp,
  Outbox cardinality, and per-aggregate version increments.
- Terminal Stages are not changed.
- Event, Outbox, Stage-transition, and Task-reconciliation failures roll back
  State, Events, Outboxes, and keyed Idempotency Success together.
- Keyed replay does not duplicate Events, Outboxes, or versions.
- A different key after cancellation preserves `RUN_NOT_CANCELLABLE`.
- Stale or invalid `expectedVersion` performs no State, Event, Outbox, or
  Idempotency write.
- Existing active-slot release and Legacy/M2 behavior remain covered.

## 4. Verification results

| Target | Result |
|---|---:|
| Shared lifecycle tests | 25/25 |
| RunSnapshotRepository | 23/23 |
| SnapshotService | 8/8 |
| WorkflowDefinitionResolver | 5/5 |
| P2B persistence | 12/12 |
| P2C-2A lifecycle | 30/30 |
| P2C-2B composite lifecycle | 15/15 |
| P2C-2C Run graph | 13/13 |
| V2 Run routes | 17/17 |
| V2 Idempotency | 16/16 |
| TaskRunService | 62/62 |
| Migration 012/013 targeted | 19/19 |
| Full Migration suite | 203 passed / 0 failed / 1 skipped / 204 total |
| Full Server suite | 1,154 passed / 0 failed / 2 skipped / 1,156 total |
| Agent-core | 21 files / 123 passed / 0 failed |
| Web tests | 86/86 |
| Shared, Server, Agent-core, Web production build | PASS |
| `git diff --check` and changed-file allowlist | PASS |

The two full-suite skips are the pre-existing Windows-only Unix behavior case
and the explicit `AGENTOS_P3_SOURCE_ROOT`-missing real-copy rehearsal. Web
explicit `tsc --noEmit` reproduced the seven existing baseline errors and is
recorded as `BASELINE REPRODUCED - NOT PASS`; the Next production build passed.

Migration checksums remain frozen:

| Migration | Checksum | destructive |
|---|---|---|
| 007 | `2bf9edb75204d05e` | unchanged |
| 012 | `7b87c3538e4b9e83` | `true` |
| 013 | `1929824c419baa20` | `false` |

No production database migration, copy, restore, or cutover was executed.
All migration and lifecycle checks used isolated temporary databases.

## 5. Corrected P2 status and boundaries

The corrected status is:

```text
M3 P2 REMEDIATION IMPLEMENTED
LOCAL VERIFICATION GATES PASS
PENDING INDEPENDENT P2 REVIEW
REMOTE CHECKS UNAVAILABLE - NOT PASS
P3 NOT AUTHORIZED
PR NOT CREATED
MAIN NOT MODIFIED
PRODUCTION CUTOVER NOT AUTHORIZED
```

This correction does not authorize P2B/P2C/P3 expansion, a PR, merge to
`main`, Legacy retirement, or Production Cutover.
