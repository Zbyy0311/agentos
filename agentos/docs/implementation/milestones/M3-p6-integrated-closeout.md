# M3 P6 Integrated Verification Closeout

Status: M3 P6D INTEGRATED VERIFICATION COMPLETE — P6 AWAITING INDEPENDENT INTEGRATED REMOTE REVIEW — REMOTE CHECKS UNAVAILABLE — NOT PASS — P7 NOT ENTERED / NOT AUTHORIZED — PRODUCTION CUTOVER NOT PERFORMED

## 1. Scope

P6D is TEST + EVIDENCE + DOC CLOSEOUT only. No production implementation change,
no migration, no runtime expansion, no PR, and no merge are included. P6D proves
the accepted P6A/P6B/P6C packages close as one system:

```text
canonical Run / Start / Stage
        ↓
transactional Runtime Event
        ↓
Outbox
        ↓
publisher / delivery hint
        ↓
RunStreamService
        ↓
replay / reconnect
        ↓
Legacy persisted-event projection
```

and that browser disconnect, server restart, Outbox crash/retry/reclaim, dead
letter, v2 recovery, and Legacy canonical recovery never produce double
execution authority, lost durable Events, duplicate semantic execution,
stranded active Runs, guessed success, or transport-owned cancellation.

P6D RED principle: P6A/P6B/P6C are individually tested, but no single P6
integrated verification package proved their cross-package invariants. The
GREEN is the new consolidated integration suite described below.

## 2. Accepted Baseline

- P6A: ACCEPTED. P6A implementation baseline
  `4efef838` / remediation `a0b6460e`; Outbox reclaim/retry/dead-letter
  contract M3-TD-35.
- P6B: ACCEPTED. P6B implementation baseline
  `52dac5cb` / accepted remediation
  `ff9a375f681d96fd91d07f3f237529adb46a12c8`; task-domain recovery contract
  M3-TD-34.
- P6C: ACCEPTED. Accepted P6C HEAD
  `2151ed57e774cd585337709f09169ded3d3e3304` (HIGH-1 Legacy canonical restart
  recovery remediation); P6C HIGH-1 independent remote re-review PASS.

P6D branch was created exactly from accepted P6C:
`2151ed57e774cd585337709f09169ded3d3e3304`.

## 3. Integrated Verification Matrix

`apps/server/src/services/m3-p6-integrated-verification.test.ts` (new) covers
23 integration cases on isolated temporary SqliteStore fixtures using the real
production services:

| Case | Verified invariant |
|---|---|
| P6D-A1 | One Legacy request → one canonical Task → one Run → one Snapshot V2 → four RunStages → one run.start; Start queued→running→completed; Run queued→starting→running→completed; Stages pending→ready→starting→running→completed; strict +1 Event sequence from 1; `Run.nextEventSequence = last + 1`; exactly one execution authority; no duplicate Run. |
| P6D-A2 | Every durable Runtime Event has exactly one Outbox with eventId/runId/aggregate/sequence/topic binding; no orphan Outbox. |
| P6D-A3 | OutboxPublisher claims, sink accepts, marks published; RunStream receives every sequence exactly once; no new Runtime Event; Run/Stage state and versions unchanged. |
| P6D-A4 | Legacy `thinking` projection is persisted-first: at projection time the Runtime Event and its Outbox are already queryable. |
| P6D-A5 | Controlled slow execution: transport unsubscribe does not cancel the Run/Start; execution, Runtime Events, Outbox, and terminal state continue; no `AbortController` execution cancellation. |
| P6D-A6 | Disconnect at a recorded cursor, reconnect via P5 replay: events after the cursor replay exactly once, then live continuation; no missing Event, no duplicate. |
| P6D-A7 | Outbox `publishing` + valid lease, process loss before markPublished: expired lease → reclaim → retry → same eventId/sequence/payload redelivered; no second Runtime Event, no second domain transition. |
| P6D-A8 | Lease expiry writes `lastOutcome = lease_expired`, preserves completedFailures=0/firstFailedAt/attempts semantics; does not consume the retry budget. |
| P6D-A9 | Classified retryable failure: completedFailures +1, firstFailedAt frozen, classified_failure envelope, retry status, deterministic backoff; no domain mutation. |
| P6D-A10 | Non-retryable classified failure: Outbox = dead_letter, DeadLetter exists exactly once, Outbox terminal mutation + DeadLetter insert commit together; repeat publisher iteration creates no duplicate DeadLetter. |
| P6D-A11 | Legacy/SSE subscriber throw and transport close stay isolated: no Outbox retry/dead-letter, no Run failure/cancellation; delivery truth unchanged. |
| P6D-B1 | v2 queued Run + queued Start: queue-restore; Run/Start stay queued; `run.recovery_attempted` + `run.recovered(queue-restore)` with one Outbox each; no AgentRunner/Provider. |
| P6D-B2 | v2 starting Run + running Start: startup-failed; Run failed, Start failed, Runtime Event + Outbox atomic; no guessed resume. |
| P6D-B3 | v2 running Run + completed Start: uncertainty-marked; Run stays running, `recovery_required=1`, `run.recovery_attempted` + `run.recovery_failed`; no completion/failure/restart. |
| P6D-C1 | Legacy canonical running Run + completed Start + active Stage: active Stage→failed, Run→failed, Start stays completed, `stage.failed` + `run.failed` with Outbox ×2, active slot released. |
| P6D-C2 | Legacy canonical starting Run + running Start + starting Stage: Stage/Run/Start failed, canonical Task reconciled, no execution. |
| P6D-C3 | Pre-P6C historical Legacy running Run with zero Start and zero canonical Event graph: preserved; no invented Start, no execution, no fabricated Event history. |
| P6D-C4 | Final-review crash window (Legacy JSON completed + reviewDecision approve + canonical Run running + Start completed + final Stage running): final Stage failed, Run failed, Start stays completed, Legacy JSON failed with reviewDecision/reviewBlocked/outputs preserved, no `run.completed`, no second runner. |
| P6D-C5 | After recovered interrupted Run: active slot empty; another Legacy POST creates one new retry Run (reason=retry, parentRunId=failed parent, rootRunId preserved), one new Start, one new execution authority; no permanent 409 RUN_ACTIVE_EXISTS. |
| P6D-C6 | Recovery-generated Events (`run.recovery_*`, `stage.failed`, `run.failed`) each carry one Outbox; OutboxPublisher delivers without any new domain mutation. |
| P6D-C7 | RunStream observes recovery Events in strict durable sequence; subscriber disconnect afterwards leaves recovery state committed. |
| P6D-D1 | Injected durable unknown future Event: P6B recovery fails closed with stable `TASK_RUN_RECOVERY_INTEGRITY_FAILED` and P6C recovery fails closed with `LEGACY_CANONICAL_RUN_INTEGRITY_FAILED`; zero mutation; Registry unchanged. |
| P6D-D2 | Deterministic sequence gap (reserved sequence never committed): recovery never certifies positive state; gap remains; no Event row deleted; zero mutation. |

## 4. Durable Event / Outbox Evidence

- Success execution Event graph: `run.created`, `stage.created ×4`,
  `run.dequeued`, per-stage `stage.ready`/`stage.starting`/`stage.started`,
  `run.started`, `stream.text_delta`/`stream.text_completed` per stage,
  `stage.completed ×4`, `run.completed`.
- Sequence starts at 1, strict +1 continuity, no duplicate sequence,
  `Run.nextEventSequence = lastSequence + 1` (P6D-A1).
- Every durable Event has exactly one Outbox; binding matches eventId, runId,
  aggregateId, sequence, topic `runtime-events` (P6D-A2).

## 5. Publisher / Retry / Dead-Letter Evidence

- Success: due → claimed → sink accepts → published; no new Runtime Event and
  no Run/Stage mutation (P6D-A3).
- Crash window: publishing + valid lease → expired lease → reclaim → retry →
  same Event redelivered (P6D-A7).
- Lease expiry is not a classified failure: completedFailures stays 0,
  firstFailedAt absent, `lastOutcome = lease_expired`, budget not consumed
  (P6D-A8).
- Classified retryable failure: completedFailures +1, firstFailedAt frozen,
  classified_failure envelope, retry status, deterministic backoff
  (P6D-A9).
- Dead letter: Outbox = dead_letter, DeadLetter exactly once, atomic Outbox
  mutation + DeadLetter insert, no duplicate on repeat iteration (P6D-A10).
- Subscriber/transport failure stays isolated from Outbox truth and Run state
  (P6D-A11).

## 6. Stream / Replay / Reconnect Evidence

`RunStreamService` subscribe/buffer → high-watermark → replay → drain → live
is exercised with the real `RuntimeEventNotifier`/`RuntimeEventDeliverySink`.
P6D-A3 proves delivery reaches the stream exactly once per durable Event;
P6D-C7 proves recovery Events stream in strict order.

P6D-A6 proves a real reconnect cursor end-to-end:

```text
first subscription records durable cursor

at least one post-cursor Event is committed while disconnected
  (kimi_worker lifecycle/text Events, then execution held at opencode_reviewer)

second RunStream subscription is created with
  afterSequence = cursor

cursor+1..preReconnectHighWatermark are obtained by replay

later Events (opencode_reviewer, codex_final_review, run.completed)
are received live by the same subscription

final observed sequence set is exactly
  cursor+1..finalHighWatermark
```

The reconnect subscriber records every delivered sequence with no client-side
filter; the assertions directly require the delivered set to equal
`cursor+1..finalHighWatermark` with no duplicate and no missing sequence, so a
regression in `RunStreamService.subscribe(afterSequence = cursor)` fails the
test. The same deterministic stage barriers prove both replay and live in one
test without timing reliance. Execution authority remains exactly one
construction and the Run/Start finish completed.

## 7. Disconnect Evidence

P6D-A5 executes a controlled slow Legacy run, receives the initial projected
Event, disconnects the subscriber, then proves execution authority remains
alive, Run/Start are not cancelled, remaining Stages complete, Runtime Events
and Outbox continue persisting, and the Run reaches its controlled terminal
state. No `AbortController` execution cancellation is present in the recovery
or stream path.

## 8. V2 Recovery Evidence

P6D-B1 (queued restore), P6D-B2 (starting fail-closed), P6D-B3 (running
uncertainty with `recovery_required=1`) prove P6B semantics end-to-end with
production `TaskRunRecoveryService`, lifecycle transactions, Events, and
Outbox rows. No AgentRunner/Provider execution is involved.

## 9. Legacy Canonical Recovery Evidence

P6D-C1 (running fail-closed with Start completed), P6D-C2 (starting fail-closed
with Start failed), P6D-C4 (final-review crash window), P6D-C5 (retry after
recovery), P6D-C6 (recovery Event/Outbox delivery), and P6D-C7 (recovery stream
order) prove P6C ownership stays distinct from P6B and releases the active slot
without guessing success.

## 10. Historical Legacy Compatibility

P6D-C3 proves a pre-P6C Legacy running Run with zero Start and zero canonical
Runtime Event graph is preserved: P6C recovery does not invent a Start, does
not execute, does not fabricate Event history, and the legacy JSON-running
compatibility behavior remains intact.

## 11. Single Execution Authority Evidence

Across the suite: Legacy execution authority is constructed only by
`LegacyCanonicalExecutionService`; v2 recovery, Legacy recovery, Outbox
delivery, and RunStream deliver zero execution authority. Source audit:

- `AgentRunner` production owner: `LegacyCanonicalExecutionService.ts` only.
- `TaskRunRecoveryService`, `TaskRunService` recovery, `taskRecovery`,
  `RunStreamService`, `OutboxPublisher`: no AgentRunner.
- No ProcessManager / ProviderAdapter / CLIExecutor / child_process abstraction
  introduced by P6; no `AbortController` execution cancellation in recovery or
  stream code.

## 12. Regression Results

All suites run on this P6D branch (test file added, production zero diff):

- P6D integrated suite: 23/23 pass.
- P6A regression (OutboxPublisher, RuntimeEventDeliverySink,
  m3-p6a-outbox-recovery, m3-p2b-persistence): 49/49 pass.
- P6B regression (TaskRunRecoveryService, taskRecovery): 85/85 pass.
- P6C regression (LegacyCanonicalExecutionService, LegacyRuntimeEventAdapter,
  taskPipelineBridge, TaskRunService suites): 138/138 pass.
- P5 regression (notifier/stream/replay/SSE suites): 103/103 pass.
- Lifecycle regression (P2/P3 lifecycle transaction, composite, run graph,
  authorized claim, atomic startup, P3E integrated, OperationService,
  runLifecycle, operations routes): 237/237 pass.
- Shared: `packages/shared` has no `test` script (build script only); the real
  harness `packages/shared/m3-runtime.test.ts` passes 31/31 and
  `pnpm --filter @agentos/shared build` exits 0. No Shared changes.
- Full server: `pnpm --filter @agentos/server test` 1704 tests,
  1702 pass, 0 fail, 2 pre-existing explicit skips. Build exit 0;
  `git diff --check` clean.

Full-server transparency: run 1 failed on environmental
`serverOwnership.test.ts R47` (loopback `SERVER_OWNERSHIP_UNAVAILABLE`);
run 2 failed on environmental `routes/operations.test.ts R02` (fetch `bad
port`); each failing test passed immediately in isolation; run 3 passed the
complete suite unchanged. Both environmental failures are unrelated to P6D
changes and are reported rather than silently rerun.

## 13. Migration Audit

Migration registry is exactly 001–013:

```text
001-baseline-schema.ts
002-add-aggregate-versions.ts
003-workspace-provider-config.ts
004-workspace-tombstones.ts
005-tasks-table.ts
006-runs-table.ts
007-workflow-definitions.ts
008-run-snapshots.ts
009-run-stages.ts
010-idempotency-records.ts
011-legacy-data-migration-foundation.ts
012-m3-runtime-schema.ts
013-workflow-creation-metadata-v2.ts
```

Migration 014: ABSENT. Schema changes: 0.

## 14. Production Diff Audit

Relative to accepted P6C `2151ed57e774cd585337709f09169ded3d3e3304`, the only
P6D change is the new test file
`apps/server/src/services/m3-p6-integrated-verification.test.ts`. Production
diff: ZERO.

## 15. Remote Checks

```text
REMOTE CHECKS:
UNAVAILABLE — NOT PASS
```

No claim of remote CI or remote integrated review PASS is made.

## 16. Remaining Boundaries

- P7: NOT ENTERED / NOT AUTHORIZED. P7 owns the consolidated Draft PR,
  ordinary merge, and closeout.
- DRAFT PR: NOT CREATED.
- New Owner Decision: NONE.
- Migration 014: NOT CREATED / NOT REQUIRED.
- Legacy retirement: NOT PERFORMED.
- Web default switch: NOT PERFORMED.
- Production cutover: NOT PERFORMED.
- M4 runtime expansion (ProcessManager/ProviderAdapter/CLIExecutor/new
  child_process abstraction/EventBus/queue/scheduler/new table): NOT ENTERED.

## 17. P6 Closure Verdict

M3 P6C HIGH-1 INDEPENDENT REMOTE RE-REVIEW: PASS. M3 P6C: ACCEPTED.
M3 P6D INTEGRATED VERIFICATION: COMPLETE AND PUSHED. P6: AWAITING
INDEPENDENT INTEGRATED REMOTE REVIEW. No production remediation was required by
the integrated verification; therefore no P6D PRODUCTION REMEDIATION package
was created.
