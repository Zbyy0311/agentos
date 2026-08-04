# AgentOS M3 P2C-0 Transition/Event Matrix

Status: P2C-0/P2C-1 CONTRACT COMPLETE — P2C-2 LOCAL FORMAL GATE PASSED — PENDING INDEPENDENT REVIEW.

This matrix is the normative P2C-0 record for the Task-domain Run and Stage
state machines. It preserves M3-TD-21 and the four frozen startup mappings:

- Run `queued → starting` → `run.dequeued`;
- Run `starting → running` → `run.started`;
- Stage `ready → starting` → `stage.starting`;
- Stage `starting → running` → `stage.started`.

The matrix is the frozen contract consumed by the P2C-2 implementation. It
does not claim Remote Checks, authorize P3, authorize Production Cutover, or
claim production readiness. Migration and Registry evidence are recorded in
the separate final verification document.

## 1. Matrix conventions

- A Run row uses the Run aggregate version. A Stage row uses the Stage
  aggregate version. A multi-aggregate transaction increments each affected
  aggregate exactly once.
- `N` means every affected non-terminal Stage in deterministic order
  `stage.sequence ASC`, then `stage.id ASC`; for `run-graph-creation`, it
  means every materialized Stage in that same order.
- Every Durable Runtime Event receives one contiguous Run `sequence` value and
  one independent Outbox record. Multiple Events in one transaction are
  ordered exactly as shown and commit with all affected Current State rows.
- `timestamp` and every time-valued payload field use
  `YYYY-MM-DDTHH:mm:ss.sssZ`.
- `RunEnv` means `workspaceId, runId, sequence, correlationId`.
- `StageEnv` means `workspaceId, runId, stageId, sequence, correlationId`.
- `ApprovalRunEnv` means `workspaceId, runId, approvalRequestId, sequence,
  correlationId`.
- `ApprovalStageEnv` means
  `workspaceId, runId, stageId, approvalRequestId, sequence, correlationId`.
- Future method names are design names for a later P2C-2 implementation only.

## 1.1 M3 P2C-2C-1 Run Graph Creation Contract

The M3 P2C-2C-1 Run Graph Creation contract is one atomic transaction with
this exact order:

1. Persist Run with `status = queued`, `version = 1`, and
   `next_event_sequence = 1`.
2. Persist the V2 Run Snapshot.
3. Persist Stage Records with `status = pending` and `version = 1`.
4. Validate that the Run, V2 Snapshot, V2 Workflow, and Stage Records form one
   complete consistent graph.
5. Append `run.created`.
6. Append `stage.created × N` in `stage.sequence ASC`, then `stage.id ASC` order.
7. Immediately after each Event, insert its own independent Outbox record.
8. Write Idempotency Success.
9. Commit.

The Event order is `run.created` → `stage.created × N`. `run.created` receives
sequence `1`; `stage.created` receives sequences `2..N+1`; the final
`next_event_sequence` is `N+2`. `N = 0` is valid and produces only
`run.created`. No `run.queued` Event is produced. Every Creation Event uses the
same timestamp. Run and Stage versions remain `1`; Creation Events do not
increment them.

Creation correlation and causation are frozen: `correlationId` is exactly the
persisted `run.id`; `CreateV2RunInput` does not add `correlationId`, and callers
cannot override it. `run.created` has no `causationId` or `parentEventId`. Every
`stage.created` uses `correlationId = run.id`, with both `causationId` and
`parentEventId` equal to the `run.created` Event ID. Stage Events directly
belong to `run.created`; they do not form a Stage Event chain.

`run.created` payload fields are derived from persisted Run state and the V2
Snapshot: `reason`, `parentRunId` when present, `rootRunId`,
`workflowDefinitionId`, `worktreeMode`, and `createdBy`. Each `stage.created`
payload is derived from its persisted Stage and matching V2 Snapshot Stage:
`workflowStageKey`, `name`, `sequence`, and `dependsOn`. Callers cannot
override Event type, source, sequence, timestamp, correlation, causation,
parent-event, or payload fields. Any failure rolls back the whole transaction.

Run and Stage creation are one `run-graph-creation` composite transaction.
The Run and every created Stage remain at version `1`; the transaction emits
one independent Outbox record immediately after each Event.

## 1.2 M3 P3B-2A Startup Failure Contract Alignment

Status: IMPLEMENTED — PENDING INDEPENDENT REVIEW.

This is a narrow Shared/specification alignment. It does not implement a
failure transaction, Workflow Executor, Stage Executor, Operation terminal
transition, or any Server Runtime behavior.

### Branch A — one startup Stage already entered `starting`

For an unrecoverable pre-start startup error where exactly one startup Stage
has entered `starting`:

- Stage transition: `starting → failed`, Primary Event `stage.failed`;
- Run transition: `starting → failed`, Primary Event `run.failed`;
- both Current State transitions belong to one caller-owned transaction;
- Stage Event source is `stage-executor`; Run Event source is `run-engine`;
- Stage Event envelope is `StageEnv`; Run Event envelope is `RunEnv`;
- payloads are `StageFailedPayload` and `RunFailedPayload`;
- Stage and Run versions each increase by one;
- startup Stage and Run both become terminal `failed`;
- Event order is exactly:

  ```text
  stage.failed → run.failed
  ```

- both Events receive contiguous Run sequence values and each receives an
  independent Outbox record;
- all Current State, Event, Outbox, and version writes commit or roll back
  together;
- ordering name is `startup-failure` with
  `stageMultiplicity=single`, `stageOrdering=none`,
  `contiguousRunSequence=true`, `independentOutboxPerEvent=true`, and
  `atomicCurrentStateEventOutbox=true`.

### Branch B — no Stage entered `starting`

For an unrecoverable pre-start startup error where no Stage has entered
`starting`:

- Run transition: `starting → failed`, Primary Event `run.failed`;
- Additional Event: `None`;
- only the Run version increases by one;
- no `stage.failed` is generated or fabricated;
- the Event order is `run.failed only`;
- every not-started Stage remains in its prior valid state.

This single-Event branch is not a `startup-failure` multi-Event instance.
Operation `running → failed` may join a caller-owned transaction in later
P3B-2B, but Operation does not emit a Runtime Event and does not change the
`stage.failed → run.failed` order. User cancellation remains governed by
M3-TD-27 and uses `stage.cancelled` / `run.cancelled`, never failure Events.

## 2. Run transition matrix

The Run matrix contains 17 allowed transitions, including the initial
`∅ → queued` creation edge.

| # | Aggregate | From | To | Trigger | Primary Event | Additional Event | Event source | Required Envelope references | Payload interface / exact required fields | Timestamp writes | Version increment | Terminal behavior | Multi-Event ordering | Future P2C-2 method name |
|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Run | `∅` | `queued` | Run creation | `run.created` | None; Stage creation is represented by its own Stage rows | `run-engine` | `RunEnv` | `RunCreatedPayload`: `reason`, `rootRunId`, `worktreeMode`, `createdBy`; optional `parentRunId`, `workflowDefinitionId` | First write `runs.created_at`; Event `timestamp`; no `started_at` | Initialize Run `version = 1` | Non-terminal Queue Record | `run.created` is the only Run creation Primary Event | `createRun` |
| 2 | Run | `queued` | `starting` | Scheduler acquired the Run | `run.dequeued` | None | `scheduler` | `RunEnv` | `RunDequeuedPayload`: `dequeuedAt` only | Event `timestamp` and `dequeuedAt`; no `started_at` | Run `version + 1` | Non-terminal startup state | `run.dequeued` | `dequeueRun` |
| 3 | Run | `queued` | `cancelled` | User cancellation before startup | `run.cancelled` | `stage.cancelled × N` for affected Stages | `run-engine`; `stage-executor` for additional Events | Run: `RunEnv`; each Stage: `StageEnv` | `RunCancelledPayload`: `requestedBy`, `terminatedProcessIds`, `worktreePreserved`; optional `reason`. Each additional Event uses `StageCancelledPayload`: `reason` | First write `cancellation_requested_at`; Event `timestamp`; update `updated_at`; no `started_at` | Run `version + 1`; each affected Stage `version + 1` | Run and all affected Stages terminal | `stage.cancelled` in `N` order → `run.cancelled` | `cancelRun` |
| 4 | Run | `starting` | `running` | Startup complete and first eligible Stage active | `run.started` | `stage.started` for the first eligible Stage | `run-engine`; `stage-executor` for additional Event | Run: `RunEnv`; Stage: `StageEnv` | `RunStartedPayload`: `startedAt`; optional `workflowSnapshotVersion`, `policySnapshotVersion`, `baseCommit`. Additional Event uses `StageStartedPayload`: `workflowStageKey`, `name`, `attempt`, `agentSnapshot`, `providerSnapshot` | First write `runs.started_at`; Stage first writes `run_stages.started_at`; Event timestamps | Run `version + 1`; first active Stage `version + 1` | Run remains non-terminal | `stage.started` → `run.started` | `completeRunStartup` |
| 5 | Run | `starting` | `failed` | Unrecoverable pre-start startup failure; Branch A: exactly one startup Stage has entered `starting`; Branch B: no Stage has entered `starting` | `run.failed` | Branch A: conditional `stage.failed`; Branch B: None | Branch A: Stage=`stage-executor`, Run=`run-engine`; Branch B: `run-engine` | Branch A: Stage=`StageEnv`, Run=`RunEnv`; Branch B: `RunEnv` | Branch A: `StageFailedPayload` and `RunFailedPayload`; Branch B: `RunFailedPayload` | Event `timestamp`; terminal `updated_at`; no `started_at` unless previously written | Branch A: Stage `version + 1`, Run `version + 1`; Branch B: Run `version + 1` | Branch A: startup Stage and Run failed; Branch B: Run failed and Stage states unchanged | Branch A: `stage.failed → run.failed`, ordering `startup-failure`; Branch B: `run.failed only` | `failRunStartup` |
| 6 | Run | `starting` | `cancelled` | User cancellation during startup | `run.cancelled` | `stage.cancelled × N` for affected Stages | `run-engine`; `stage-executor` for additional Events | Run: `RunEnv`; each Stage: `StageEnv` | `RunCancelledPayload`: `requestedBy`, `terminatedProcessIds`, `worktreePreserved`; optional `reason`. Additional Events use `StageCancelledPayload`: `reason` | First write `cancellation_requested_at`; Event `timestamp`; update terminal `updated_at` | Run `version + 1`; each affected Stage `version + 1` | Run and all affected Stages terminal | `stage.cancelled` in `N` order → `run.cancelled` | `cancelRun` |
| 7 | Run | `running` | `waiting_approval` | Policy requires approval | `approval.required` | None; the same Event is evidence for the paired Stage transition | `approval-service` | `ApprovalStageEnv` for Stage-specific approval; `ApprovalRunEnv` for Run-only approval | `ApprovalRequiredPayload`: `category`, `riskLevel`, `title`, `description`, `requestSummary`; optional `expiresAt`; Stage-specific approval requires `runId`, `stageId`, and `approvalRequestId` envelope references | Event `timestamp`; optional payload `expiresAt`; no `started_at` rewrite | Run `version + 1`; paired Stage `version + 1` | Non-terminal approval wait | One `approval.required` | `requestApproval` |
| 8 | Run | `running` | `paused` | User/System/Policy pause | `run.paused` | None | `run-engine` | `RunEnv` | `RunPausedPayload`: `reason`, `resumable`; optional `requestedBy` | Event `timestamp`; update `updated_at` | Run `version + 1` | Non-terminal paused state | `run.paused` | `pauseRun` |
| 9 | Run | `running` | `completed` | Completion rule satisfied | `run.completed` | `stage.completed` for the last required Stage when that completion is the trigger | `run-engine`; `stage-executor` for additional Event | Run: `RunEnv`; Stage: `StageEnv` | `RunCompletedPayload`: `durationMs`, `completedStageIds`, `artifactIds`; optional `worktreeStatus`, `summaryArtifactId`. Additional Event uses `StageCompletedPayload`: `attempt`, `durationMs`, `artifactIds`, `outputContractSatisfied`; optional `summaryArtifactId` | Last Stage writes terminal timestamp; first write Run terminal `completed_at`; Event timestamps | Run `version + 1`; last Stage `version + 1` | Run terminal | `stage.completed` → `run.completed` | `completeRun` |
| 10 | Run | `running` | `failed` | Unrecoverable failure | `run.failed` | None | `run-engine` | `RunEnv` | `RunFailedPayload`: `errorCode`, `message`, `phase`, `retryable`; optional `stageId`, `providerType`, `suggestedAction`, `debugArtifactId` | Event `timestamp`; update terminal `updated_at` | Run `version + 1` | Run terminal | `run.failed` | `failRun` |
| 11 | Run | `running` | `cancelled` | User cancellation | `run.cancelled` | `stage.cancelled × N` for all affected non-terminal Stages | `run-engine`; `stage-executor` for additional Events | Run: `RunEnv`; each Stage: `StageEnv` | `RunCancelledPayload`: `requestedBy`, `terminatedProcessIds`, `worktreePreserved`; optional `reason`. Additional Events use `StageCancelledPayload`: `reason` | First write `cancellation_requested_at`; Event `timestamp`; update terminal `updated_at` | Run `version + 1`; each affected Stage `version + 1` | Run and all affected Stages terminal | `stage.cancelled` in `N` order → `run.cancelled` | `cancelRun` |
| 12 | Run | `waiting_approval` | `running` | Approved decision | `approval.resolved` | None; the same Event is evidence for the paired Stage transition | `approval-service` | `ApprovalStageEnv` for Stage-specific approval; `ApprovalRunEnv` for Run-only approval | `ApprovalResolvedPayload`: `decision`, `decidedBy`, `decidedAt`; optional `modifiedRequest`; allowed running decisions are `approve_once`, `approve_run`, `approve_workspace` | Event `timestamp`; payload `decidedAt`; no rewrite of `started_at` | Run `version + 1`; paired Stage `version + 1` | Non-terminal running state | One `approval.resolved` | `resolveApprovalToRunning` |
| 13 | Run | `waiting_approval` | `failed` | Rejected approval with fatal result | `run.failed` | `approval.resolved`; `stage.failed` for the affected Stage | `run-engine`; `approval-service`; `stage-executor` | Run: `RunEnv`; approval: `ApprovalStageEnv`; Stage: `StageEnv` | `RunFailedPayload`: `errorCode`, `message`, `phase`, `retryable`; `ApprovalResolvedPayload`: `decision`, `decidedBy`, `decidedAt`; `StageFailedPayload`: `attempt`, `errorCode`, `message`, `retryable`, `retryScheduled` | Approval `decidedAt`; Event timestamps; terminal `updated_at` for Run and Stage | Run `version + 1`; affected Stage `version + 1` | Run and affected Stage terminal | `approval.resolved` → `stage.failed` → `run.failed` | `resolveApprovalToFailure` |
| 14 | Run | `waiting_approval` | `cancelled` | Approval cancellation decision | `run.cancelled` | `approval.resolved`; `stage.cancelled × N` | `run-engine`; `approval-service`; `stage-executor` | Run: `RunEnv`; approval: `ApprovalStageEnv`; each Stage: `StageEnv` | `RunCancelledPayload`: `requestedBy`, `terminatedProcessIds`, `worktreePreserved`; `ApprovalResolvedPayload`: `decision`, `decidedBy`, `decidedAt`; additional Events use `StageCancelledPayload`: `reason` | Approval `decidedAt`; Event timestamps; first write `cancellation_requested_at`; terminal `updated_at` | Run `version + 1`; each affected Stage `version + 1` | Run and all affected Stages terminal | `approval.resolved` → `stage.cancelled` in `N` order → `run.cancelled` | `resolveApprovalToCancellation` |
| 15 | Run | `paused` | `running` | Resume | `run.resumed` | None | `run-engine` | `RunEnv` | `RunResumedPayload`: `resumeMode`; optional `requestedBy` | Event `timestamp`; update `updated_at`; no new `started_at` | Run `version + 1` | Non-terminal running state | `run.resumed` | `resumeRun` |
| 16 | Run | `paused` | `failed` | Recovery failure | `run.failed` | None | `run-engine` | `RunEnv` | `RunFailedPayload`: `errorCode`, `message`, `phase`, `retryable`; optional `stageId`, `providerType`, `suggestedAction`, `debugArtifactId` | Event `timestamp`; terminal `updated_at` | Run `version + 1` | Run terminal | `run.failed` | `failRunRecovery` |
| 17 | Run | `paused` | `cancelled` | User cancellation | `run.cancelled` | `stage.cancelled × N` for affected Stages | `run-engine`; `stage-executor` for additional Events | Run: `RunEnv`; each Stage: `StageEnv` | `RunCancelledPayload`: `requestedBy`, `terminatedProcessIds`, `worktreePreserved`; optional `reason`. Additional Events use `StageCancelledPayload`: `reason` | First write `cancellation_requested_at`; Event `timestamp`; terminal `updated_at` | Run `version + 1`; each affected Stage `version + 1` | Run and all affected Stages terminal | `stage.cancelled` in `N` order → `run.cancelled` | `cancelRun` |

`run.queued` is not a Run transition row. It is optional queue telemetry and
must never replace the `run.created` Primary Event for `∅ → queued`.

## 3. Stage transition matrix

The Stage matrix contains 19 allowed transitions, including the initial
`∅ → pending` creation edge and all four non-terminal cancellation edges.

| # | Aggregate | From | To | Trigger | Primary Event | Additional Event | Event source | Required Envelope references | Payload interface / exact required fields | Timestamp writes | Version increment | Terminal behavior | Multi-Event ordering | Future P2C-2 method name |
|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Stage | `∅` | `pending` | Stage creation | `stage.created` | None | `stage-executor` | `StageEnv` | `StageCreatedPayload`: `workflowStageKey`, `name`, `sequence`, `dependsOn` | First write `run_stages.created_at`; Event `timestamp` | Initialize Stage `version = 1` | Non-terminal pending state | `stage.created` | `createStage` |
| 2 | Stage | `pending` | `ready` | Dependencies satisfied | `stage.ready` | None | `stage-executor` | `StageEnv` | `StageReadyPayload`: `dependenciesCompleted` | Event `timestamp`; update `updated_at` | Stage `version + 1` | Non-terminal ready state | `stage.ready` | `markStageReady` |
| 3 | Stage | `pending` | `skipped` | Condition false | `stage.skipped` | None | `stage-executor` | `StageEnv` | `StageSkippedPayload`: `condition`, `reason` | Terminal `completed_at`/`updated_at`; Event `timestamp` | Stage `version + 1` | Terminal skipped state | `stage.skipped` | `skipStage` |
| 4 | Stage | `pending` | `cancelled` | Run cancellation | `stage.cancelled` | None | `stage-executor` | `StageEnv` | `StageCancelledPayload`: `reason` | Terminal `updated_at`; Event `timestamp` | Stage `version + 1` | Terminal cancelled state | `stage.cancelled` | `cancelStage` |
| 5 | Stage | `ready` | `starting` | Scheduler acquired Stage rights | `stage.starting` | None | `stage-executor` | `StageEnv` | `StageStartingPayload`: `workflowStageKey`, `name`, `attempt`, `startingAt` | Event `timestamp` and `startingAt`; no `run_stages.started_at` | Stage `version + 1` | Non-terminal starting state | `stage.starting` | `startStagePreparation` |
| 6 | Stage | `ready` | `cancelled` | Run cancellation | `stage.cancelled` | None | `stage-executor` | `StageEnv` | `StageCancelledPayload`: `reason` | Terminal `updated_at`; Event `timestamp` | Stage `version + 1` | Terminal cancelled state | `stage.cancelled` | `cancelStage` |
| 7 | Stage | `starting` | `running` | Provider active and snapshots frozen | `stage.started` | None; Run startup completion has its own Run row | `stage-executor` | `StageEnv` | `StageStartedPayload`: `workflowStageKey`, `name`, `attempt`, `agentSnapshot`, `providerSnapshot` | First write `run_stages.started_at`; Event `timestamp` | Stage `version + 1` | Non-terminal running state | `stage.started` precedes `run.started` when it completes Run startup | `startStage` |
| 8 | Stage | `starting` | `failed` | Startup error | `stage.failed` | None; the paired Run failure is defined by Run row 5 | `stage-executor` | `StageEnv` | `StageFailedPayload`: `attempt`, `errorCode`, `message`, `retryable`, `retryScheduled` | Terminal `updated_at`; Event `timestamp` | Stage `version + 1` | Terminal failed state | `stage.failed`; in Branch A, this Event participates in `startup-failure` before `run.failed` | `failStageStartup` |
| 9 | Stage | `starting` | `cancelled` | Run cancellation | `stage.cancelled` | None | `stage-executor` | `StageEnv` | `StageCancelledPayload`: `reason` | Terminal `updated_at`; Event `timestamp` | Stage `version + 1` | Terminal cancelled state | `stage.cancelled` | `cancelStage` |
| 10 | Stage | `running` | `waiting_approval` | Policy requires approval | `approval.required` | None; the same Event is evidence for the paired Run transition | `approval-service` | `ApprovalStageEnv` | `ApprovalRequiredPayload`: `category`, `riskLevel`, `title`, `description`, `requestSummary`; optional `expiresAt`; `runId`, `stageId`, `approvalRequestId` required | Event `timestamp`; optional `expiresAt`; no `started_at` rewrite | Stage `version + 1`; paired Run `version + 1` | Non-terminal approval wait | One `approval.required` | `requestStageApproval` |
| 11 | Stage | `running` | `paused` | Pause | `stage.paused` | None | `stage-executor` | `StageEnv` | `StagePausedPayload`: `reason`, `resumable` | Event `timestamp`; update `updated_at` | Stage `version + 1` | Non-terminal paused state | `stage.paused` | `pauseStage` |
| 12 | Stage | `running` | `completed` | Contract satisfied | `stage.completed` | None; Run completion has its own Run row | `stage-executor` | `StageEnv` | `StageCompletedPayload`: `attempt`, `durationMs`, `artifactIds`, `outputContractSatisfied`; optional `summaryArtifactId` | Terminal `completed_at`/`updated_at`; Event `timestamp` | Stage `version + 1` | Terminal completed state | `stage.completed` precedes `run.completed` when it completes Run | `completeStage` |
| 13 | Stage | `running` | `failed` | Error | `stage.failed` | None; Run failure has its own Run row | `stage-executor` | `StageEnv` | `StageFailedPayload`: `attempt`, `errorCode`, `message`, `retryable`, `retryScheduled` | Terminal `updated_at`; Event `timestamp` | Stage `version + 1` | Terminal failed state | `stage.failed` | `failStage` |
| 14 | Stage | `running` | `cancelled` | Run cancellation | `stage.cancelled` | None; Run cancellation has its own Run row | `stage-executor` | `StageEnv` | `StageCancelledPayload`: `reason` | Terminal `updated_at`; Event `timestamp` | Stage `version + 1` | Terminal cancelled state | `stage.cancelled` precedes `run.cancelled` | `cancelStage` |
| 15 | Stage | `waiting_approval` | `running` | Approved decision | `approval.resolved` | None; the same Event is evidence for the paired Run transition | `approval-service` | `ApprovalStageEnv` | `ApprovalResolvedPayload`: `decision`, `decidedBy`, `decidedAt`; optional `modifiedRequest`; allowed running decisions are `approve_once`, `approve_run`, `approve_workspace` | Event `timestamp`; payload `decidedAt`; no rewrite of `started_at` | Stage `version + 1`; paired Run `version + 1` | Non-terminal running state | One `approval.resolved` | `resolveStageApprovalToRunning` |
| 16 | Stage | `waiting_approval` | `failed` | Rejected approval with fatal result | `stage.failed` | `approval.resolved` | `stage-executor`; `approval-service` for additional Event | Stage: `StageEnv`; approval: `ApprovalStageEnv` | `StageFailedPayload`: `attempt`, `errorCode`, `message`, `retryable`, `retryScheduled`; `ApprovalResolvedPayload`: `decision`, `decidedBy`, `decidedAt` | Approval `decidedAt`; terminal Stage `updated_at`; Event timestamps | Stage `version + 1`; paired Run `version + 1` when Run also fails | Stage and paired Run terminal when fatal | `approval.resolved` → `stage.failed` → `run.failed` | `resolveStageApprovalToFailure` |
| 17 | Stage | `waiting_approval` | `cancelled` | Approval cancellation decision | `stage.cancelled` | `approval.resolved` | `stage-executor`; `approval-service` for additional Event | Stage: `StageEnv`; approval: `ApprovalStageEnv` | `StageCancelledPayload`: `reason`; `ApprovalResolvedPayload`: `decision`, `decidedBy`, `decidedAt` | Approval `decidedAt`; terminal Stage `updated_at`; Event timestamps | Stage `version + 1`; paired Run `version + 1` when Run also cancels | Stage terminal; paired Run terminal after all affected Stages cancel | `approval.resolved` → `stage.cancelled` → `run.cancelled` | `resolveStageApprovalToCancellation` |
| 18 | Stage | `paused` | `running` | Resume | `stage.resumed` | None | `stage-executor` | `StageEnv` | `StageResumedPayload`: `resumeMode` | Event `timestamp`; update `updated_at`; no new `started_at` | Stage `version + 1` | Non-terminal running state | `stage.resumed` | `resumeStage` |
| 19 | Stage | `paused` | `cancelled` | Run cancellation | `stage.cancelled` | None; Run cancellation has its own Run row | `stage-executor` | `StageEnv` | `StageCancelledPayload`: `reason` | Terminal `updated_at`; Event `timestamp` | Stage `version + 1` | Terminal cancelled state | `stage.cancelled` precedes `run.cancelled` | `cancelStage` |

## 4. Invalid transitions and terminal closure

Every `(aggregate, from, to)` pair not listed in the Run or Stage matrix is
invalid and has no Event mapping. An invalid transition must produce no
Current State write, no Runtime Event, no Outbox record, no timestamp write,
and no version increment.

The following states are terminal and have no outgoing transition rows:

- Run: `completed`, `failed`, `cancelled`;
- Stage: `completed`, `failed`, `cancelled`, `skipped`.

Run cancellation must leave no non-terminal Stage. Stage cancellation does not
terminate a process, cancel an Approval, or perform database logic in this
specification; those are later implementation concerns.

## 5. Approval and multi-Event transaction rules

### 5.1 Approval entry

For `running → waiting_approval`, one Stage-specific `approval.required`
Event may be the Primary Event and the shared lifecycle evidence for both the
Run and Stage transitions. No `run.waiting` or `stage.waiting` Event exists.
The Event must carry `runId`, `stageId`, and `approvalRequestId` references.

### 5.2 Approval resolution

Only `approve_once`, `approve_run`, and `approve_workspace` may produce the
`waiting_approval → running` mapping. `approval.resolved` is the shared
evidence for the Run and Stage restoration and must not be followed by
`run.resumed` or `stage.resumed`.

Rejection and cancellation use the ordered sequences recorded in the matrix:

```text
approval.resolved → stage.failed → run.failed
approval.resolved → stage.cancelled × N → run.cancelled
```

### 5.3 Atomicity

All Current State writes, every listed Runtime Event, every independent
Outbox record, and every affected version increment commit together or roll
back together. Event sequence values remain contiguous within the Run.

## 6. Coverage proof

| Aggregate | Allowed transition rows | Primary Event rows | Invalid transition rule |
|---|---:|---:|---|
| Run | 17/17 | 17/17 | Every unlisted pair has no mapping |
| Stage | 19/19 | 19/19 | Every unlisted pair has no mapping |

This file is normative specification evidence. P2C-2 implementation and local
test evidence are recorded in the final verification document.
