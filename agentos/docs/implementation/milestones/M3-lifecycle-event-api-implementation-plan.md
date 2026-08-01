# AgentOS M3 Lifecycle, Event and API Foundation Implementation Plan

Status: DRAFT PLAN — PREPARED FOR INDEPENDENT TECHNICAL REVIEW — M3 P1 NOT AUTHORIZED — PRODUCTION CUTOVER NOT AUTHORIZED

This plan is a future implementation plan. No phase below is complete or passed. The current remediation changes documentation only and does not authorize M3 P1, Migration 012, production behavior, data deletion, restore, or a Web default switch.

## 1. Authoritative contract

M3 is defined by Runtime Specification 14, Roadmap §§47–53:

- Objective: run a persistent Run state machine and use the Persist-then-publish Event Path.
- Scope: Run Engine, Workflow Executor Foundation, Stage Transition, Event Envelope, Task-domain Sequence Allocator, Event Store, Outbox, SSE, reconnect, ApiProblem, Operation Resource, ETag, Idempotency Middleware, and Basic OpenAPI.
- Deliverables: Create Task, Create Run, Start Run, Get Run, Cancel Run, Run Events, Run Stream, Operation, Error Mapping, Event Fixture, and Replay Foundation.
- Compatibility: Legacy execute-task remains usable and maps to Create Run then Start Run; Legacy SSE remains usable and maps status, stage, thinking, done, and error frames to v2 events.
- Exit gate: Browser refresh does not cancel Run; client disconnect ends only the subscription; event sequence is strictly increasing; State/Event/Outbox is transactional; error codes are stable; Start Run is asynchronous; Retry creates a new Run.

The supporting contract sources are Runtime Specification 02 Runtime Lifecycle, 03 Event Model, 10 Data Model, and 11 API Specification.

## 2. Global boundaries and sequencing

### In scope for M3

- Task-domain Run lifecycle and legal transitions.
- Minimal Run Engine and Workflow Executor Foundation.
- Stage transition persistence.
- Canonical Task-domain Runtime Event envelope, allocator, Event Store, and replay.
- Outbox transaction, publisher, retry, and idempotency.
- Task/Run/Operation/Event/Stream API foundation.
- SSE reconnect and Last-Event-ID behavior.
- Legacy compatibility mapping while keeping the Legacy path usable.
- Recovery and browser-disconnect invariants.
- Tests, fixtures, OpenAPI, formal evidence, independent review, and ordinary merge closeout.

### Forbidden throughout M3

- Production Cutover or Production Restore.
- Web global v2 default switch.
- Legacy API removal.
- Legacy JSON physical retirement, deletion, or speculative bulk migration.
- Post-cutover production observation or cohort rollout.
- Task and Conversation aggregate unification.
- ProcessManager, ProviderAdapter, Worktree, Policy, Approval, or other later-milestone domains.
- Treating Conversation agent_events or RunStreamRegistry as the Task-domain Event Store or Durable Run Stream.

### M3 sequencing rules

1. P0 contract and technical decision closure precedes P1.
2. P1 is not authorized until P0 receives independent technical review and the Pre-P1 Gate is satisfied.
3. P2 schema work cannot start from a name-only assumption. Migration 012 is REQUIRED — PLANNING ONLY in the current audit; future DDL requires separate authorization and review.
4. P5 compatibility mapping must preserve the Legacy route at M3 end.
5. P7 formal gate is not Production Cutover authorization. Production Cutover and Legacy Retirement remain later gates.

## 3. Pre-P1 Gate

Before opening any future M3 implementation branch:

1. Fetch origin.
2. Confirm the main worktree is clean.
3. Fast-forward local main only to origin/main.
4. Confirm local main equals origin/main.
5. Do not use reset --hard, force-push, or an implicit merge to hide divergence.
6. If fast-forward-only synchronization is impossible, stop and obtain independent review.

Current recorded state is local main b61aedf6f2aaacd846324d5abd452a8875579840 versus origin/main 80e398d5074ca8e0d6367d95a1aba3951b9a8843. This docs-only remediation does not modify local main.

## 4. Implementation phases

### P0 — Contract and Technical Decision Closure

#### Goal

Restore the authoritative M3 Lifecycle, Event and API Foundation contract, reconcile current code facts with Roadmap §§47–53, and close technical decisions sufficiently for independent review.

#### Authorized scope

- Read-only inspection of Runtime Specification, M2 contracts, migration registry, and current implementation.
- Modification of the three M3 Markdown artifacts in this planning branch.
- The 22-entry M3 Gap Matrix.
- Technical Decision Register and Deferred Post-M3 Decision Register.
- Migration 012 schema-gap analysis and planning-only conclusion.

#### Forbidden scope

- Any production code, test, migration, registry, package, API, Web, database, or runtime edit.
- Migration 012 creation or DDL.
- M3 P1 implementation.
- Production Cutover, Restore, data copy, deletion, server/Web startup, process termination, or PR creation.

#### Exact files/categories

- Current remediation: docs/implementation/milestones/M3-current-state-audit.md.
- Current remediation: docs/implementation/milestones/M3-owner-decisions.md.
- Current remediation: docs/implementation/milestones/M3-lifecycle-event-api-implementation-plan.md.
- Read-only evidence: docs/Runtime-Specification/*.md, docs/implementation/milestones/M2.8-*.md, docs/implementation/migration-register.md, apps/server/src/**, and apps/web/src/lib/useTask.ts.

#### Required evidence

- Roadmap §§47–53 mapped to objective, scope, deliverables, compatibility, tests, and exit gate.
- Current code evidence for Run, Event, Outbox, API, SSE, recovery, compatibility, and separation.
- Exactly 22 Gap Matrix rows with every required field.
- Explicit proof that Conversation agent_events and RunStreamRegistry do not satisfy Task-domain Event Store/Stream.
- Explicit Migration 012 conclusion A, planning only, with exact missing schema.
- Explicit local main versus origin/main mismatch and Pre-P1 Gate.

#### RED/GREEN tests

- RED evidence: the prior plan framed M3 primarily as Production Cutover and left the Lifecycle/Event/API contract incomplete.
- GREEN evidence required for P0: the three docs contain the corrected title, contract, matrix, decision split, seven implementation phases, boundaries, and no completion claims.
- These are document acceptance checks; they are not implementation test results.

#### Related regression

- Preserve M2.8 authority, Legacy compatibility, Web Legacy default, and runs versus agent_runs separation.
- Do not rewrite Runtime Specification or M2 documents.

#### Full-gate trigger conditions

- Independent reviewer accepts the M3 contract and Gap Matrix.
- Technical Decision Register has a disposition or review owner for every M3 contract item.
- Migration 012 conclusion is accepted as planning-only.
- Pre-P1 Gate is satisfied on the implementation branch’s actual main baseline.

#### Stop conditions

- Runtime Specification conflict is unresolved.
- A proposed decision would change production behavior, delete data, or create irreversible schema without Owner Approval.
- Evidence requires running a migration, restore, server, Web, or production copy.
- Any request expands M3 into Cutover, Retirement, M4, or aggregate unification.

#### Rollback boundary

Only the docs commit may be reverted before implementation. No database, production, or user data state is touched.

#### Exit gate

P0 remains PLANNING READY / PENDING INDEPENDENT TECHNICAL REVIEW. It does not authorize P1.

#### Independent review requirements

Independent technical review is required for Runtime contract mapping, Task/Conversation boundary, Event/Outbox transaction semantics, API contract, and Migration 012 conclusion.

#### L3 requirements

Use exact Git, diff, file-scope, link, and secret-scan evidence from the actual worktree. Do not substitute a narrative count for command output and do not call missing Remote Checks passed.

### P1 — Run Lifecycle and Transition Foundation

#### Goal

Implement the minimal Task-domain Run Engine, legal Run state machine, Workflow Executor Foundation, and Stage Transition needed to create, asynchronously start, advance, complete, fail, cancel, and retry a persistent Run.

#### Authorized scope

- Task-domain Run Engine and Start command.
- Run transition ownership and version checks.
- Minimal workflow snapshot resolution and deterministic built-in/mock stage executor.
- Stage transition persistence.
- Run/Create/Start/Get/Cancel command integration.
- RED/GREEN tests for state transitions, duplicate Start, cancel versus complete, and child Retry.

#### Forbidden scope

- ProviderAdapter or ProcessManager implementation.
- Real provider execution redesign.
- Worktree, Policy, Approval, production execution, or Web default changes.
- Event Store or Outbox substitution with Conversation tables.
- Treating the Run row alone as proof of the M3 exit gate.

#### Exact files/categories

- Candidate server runtime: apps/server/src/services/TaskRunService.ts and a new Task-domain Run Engine/Scheduler category.
- Candidate repositories: apps/server/src/store/RunRepository.ts and stage/snapshot repositories.
- Candidate v2 routes: apps/server/src/routes/v2Tasks.ts and apps/server/src/routes/v2Runs.ts.
- Candidate tests: apps/server/src/**/__tests__/RunStateMachine.test.ts, RunEngine.test.ts, StageTransition.test.ts, StartRun.test.ts, and related existing v2/bridge tests.
- No migration file unless a separately reviewed schema gap is discovered and authorized.

#### Required evidence

- State transition table matches Runtime Specification: queued to starting/cancelled; starting to running/failed/cancelled; running to waiting_approval/paused/completed/failed/cancelled; waiting_approval to running/failed/cancelled; paused to running/cancelled/failed; terminal states do not reset.
- Start is asynchronous and is distinct from Create.
- Retry creates a new child Run with parent/root lineage.
- Run execution can outlive the initiating HTTP request at the foundation boundary.

#### RED/GREEN tests

- RED: illegal transition, duplicate Start, stale version, cancel/complete race, and retry reset behavior fail against the current partial graph.
- GREEN: legal transitions, duplicate Start idempotency, race resolution, terminal immutability, and child Run lineage pass in the future implementation suite.

#### Related regression

- Existing RunRepository, TaskRunService, v2Tasks, v2Runs, Legacy bridge, and task recovery tests must remain green.
- Legacy Task route remains usable and receives no global Web switch.

#### Full-gate trigger conditions

- P0 independent review is complete.
- Pre-P1 Gate is complete.
- State machine, command ownership, and async Start contract are accepted.
- RED/GREEN evidence covers the complete P1 transition table.

#### Stop conditions

- A transition needs Policy, Approval, ProcessManager, ProviderAdapter, or production authority.
- Run/Event/Outbox transaction design is required but P2 contract is not reviewed.
- HTTP disconnect still cancels the Task-domain Run.
- Existing M2 regression or Legacy compatibility breaks.

#### Rollback boundary

Revert the P1 code and test commit before P2 begins. If a schema change becomes necessary, stop before DDL and return to P0/P2 review.

#### Exit gate

P1 is complete only when the independent reviewer accepts the state machine and the P1 RED/GREEN suite, with no claim that M3 as a whole is complete.

#### Independent review requirements

Review Run state transitions, retry lineage, cancellation conflict behavior, async Start, and separation from agent_runs.

#### L3 requirements

Run the exact targeted suite plus related M2 regression suite, typecheck/build as applicable, and record command, commit, environment, and result. A local pass does not replace unavailable Remote Checks.

### P2 — Event Store, Sequence and Outbox Foundation

#### Goal

Implement the Task-domain canonical Runtime Event path: envelope, per-Run sequence, append-only Event Store, State/Event/Outbox transaction, durable Outbox publisher, retry, and duplicate prevention.

#### Authorized scope

- Task-domain Runtime Event envelope, factory, validation, redaction, and fixture.
- Transactional runs.next_event_sequence allocator.
- runtime_events repository and query foundation.
- outbox_messages repository, publisher, retry, idempotency, and dead-letter evidence.
- Atomic state plus Event plus Outbox writes.

#### Forbidden scope

- Relabeling Conversation agent_events or RunStreamRegistry as Task-domain infrastructure.
- Creating DDL without independent review and Owner authorization.
- External broker or paid infrastructure.
- Production migration, restore, cutover, or data backfill.

#### Exact files/categories

- Candidate schema: a future Migration 012 category only after the P0 schema-gap review; no migration is created in this remediation.
- Candidate repositories: apps/server/src/store/RuntimeEventRepository.ts, SequenceAllocator category, OutboxRepository category.
- Candidate services: EventFactory, EventValidator, OutboxPublisher, and transaction service categories.
- Candidate tests: EventEnvelope, SequenceAllocator, RuntimeEventRepository, OutboxPublisher, and transaction atomicity suites.

#### Required evidence

- Canonical envelope has identity, schemaVersion, type, workspace/task/run context, sequence, timestamp, source, causation/correlation, severity, visibility, durability, payload, and metadata.
- Unique run_id plus sequence is enforced for Task-domain events.
- State, Event, and Outbox commit together; publication happens after commit.
- Publisher retry is at-least-once and duplicate-safe.
- Event Store is the sole history source for replay.

#### RED/GREEN tests

- RED: current 001–011 schema cannot insert canonical Task-domain runtime_events or durable outbox_messages; current transition path cannot atomically write all three records.
- GREEN: envelope validation, monotonic sequence, duplicate rejection, rollback atomicity, post-commit publication, retry, and dead-letter tests pass after authorized implementation.

#### Related regression

- Existing migrations 001–011, EventBus, Conversation AgentEvent tests, TaskRunService, RunRepository, and idempotency tests remain green.
- Conversation event persistence remains separate and behaviorally unchanged.

#### Full-gate trigger conditions

- P0 independent technical review accepts Migration 012 REQUIRED — PLANNING ONLY.
- A separate schema implementation review authorizes exact DDL, checksum, rollback, and test strategy.
- P1 transition owner is stable and calls the transaction boundary.

#### Stop conditions

- The proposed DDL cannot prove the M3 invariants.
- Schema or data behavior is irreversible without Owner Approval.
- A reviewer proposes using Conversation event tables as a shortcut.
- Outbox failure cannot be made observable and retryable.

#### Rollback boundary

Before any authorized database deployment, revert code and test changes. A future Migration 012 must have its own reviewed rollback/forward-compatibility boundary; it is not rolled back by deleting a migration file.

#### Exit gate

P2 is complete only when independent review accepts Task-domain Event Store, transaction, sequence, and Outbox evidence. It does not authorize production migration.

#### Independent review requirements

Independent schema and transaction review is mandatory. Owner approval is mandatory for any irreversible DDL, data migration, external infrastructure, or cost.

#### L3 requirements

Use fresh and legacy database fixtures, migration checksum validation, targeted transaction tests, duplicate/retry tests, and related regression output. Do not run against production data.

### P3 — API Problem, Operation, ETag, Idempotency and OpenAPI Foundation

#### Goal

Complete the stable API contract for asynchronous Run commands and resource concurrency without changing the Web default or removing Legacy routes.

#### Authorized scope

- ApiProblem middleware and stable error mapping.
- Operation Resource persistence and polling route.
- ETag and If-Match behavior with version fallback where documented.
- Idempotency middleware for M3 high-side-effect commands.
- Basic OpenAPI artifact and contract validation.
- Create Task, Create Run, Start Run, Get Run, Cancel Run, and Operation contract closure.

#### Forbidden scope

- Global Web v2 switch.
- Legacy API removal or deprecation enforcement.
- Production operation endpoint.
- Unrelated later-domain API surfaces.
- Hiding missing implementation behind an OpenAPI document.

#### Exact files/categories

- Candidate routes: apps/server/src/routes/v2Tasks.ts, v2Runs.ts, and a new operation route.
- Candidate services/repositories: ApiProblem middleware, OperationRepository, IdempotencyService, and version/ETag middleware categories.
- Candidate contract: a Basic OpenAPI artifact under the server API documentation category.
- Candidate tests: ApiProblem, Operation, ETag, If-Match, Idempotency, and OpenAPI contract suites.

#### Required evidence

- Start returns 202 with an Operation/Location result where applicable.
- ETag is emitted and If-Match stale writes return 412.
- Same Idempotency-Key and request hash replays the original result without a duplicate effect; key reuse with a different hash fails.
- OpenAPI documents the exact M3 resources, headers, events, stream, errors, and status codes.

#### RED/GREEN tests

- RED: current v2 routes lack Start, Operation, ETag, If-Match, full ApiProblem, and complete M3 idempotency coverage.
- GREEN: API contract tests cover 202, 409, 412, 422, stable codes, ETag, replay, key reuse, and documented schemas.

#### Related regression

- Existing v2 Task/Run route tests, IdempotencyService tests, Legacy Task routes, and Web Legacy consumer behavior remain green.

#### Full-gate trigger conditions

- P1 state machine and P2 transaction contract are reviewed.
- API Problem, Operation, concurrency, and idempotency decisions are independently reviewed.
- Basic OpenAPI matches executable route behavior.

#### Stop conditions

- API contract requires a material UX change without Owner Approval.
- Idempotency cannot cover State/Event/Outbox as one effect.
- OpenAPI diverges from the Runtime Specification or current compatibility boundary.

#### Rollback boundary

Revert API/middleware/contract changes as one implementation unit. Legacy routes remain available throughout; no compatibility removal is a rollback step.

#### Exit gate

P3 is complete only when independent review accepts route behavior, headers, errors, operations, idempotency, and OpenAPI evidence.

#### Independent review requirements

Review API resource semantics, error stability, optimistic concurrency, idempotency replay, and compatibility impact.

#### L3 requirements

Run route contract, schema validation, targeted unit/integration, typecheck, and related regression commands. Report Remote Checks as unavailable if they remain unavailable.

### P4 — Run Events, SSE Replay and Reconnect

#### Goal

Expose durable Task-domain Run Events, Replay, and Run Stream endpoints that recover from persisted history and support cursor reconnect without cancelling the Run.

#### Authorized scope

- GET /api/runs/:runId/events.
- GET /api/runs/:runId/replay.
- GET /api/runs/:runId/stream.
- afterSequence and Last-Event-ID parsing, historical replay, live handoff, keepalive, and cursor errors.
- Stream authorization and Task-domain event projection.

#### Forbidden scope

- Treating Conversation streams as the Task-domain stream.
- Re-executing provider or Run work during replay.
- Removing Legacy SSE or switching the Web default.
- Persisting keepalive frames as Runtime Events.

#### Exact files/categories

- Candidate routes: apps/server/src/routes/v2Runs.ts and a new Task-domain events/stream route category.
- Candidate services: EventQueryService, ReplayService, RunStreamService, and EventBus subscription categories.
- Candidate tests: RunEvents, Replay, SSEReconnect, LastEventId, CursorExpired, and BrowserDisconnect suites.

#### Required evidence

- Historical Event Store query precedes live subscription without lost or duplicate events.
- Sequence is strictly increasing per Run.
- Last-Event-ID and afterSequence resume the persisted cursor.
- Client disconnect only removes the subscription; the Run continues.
- Replay detects gaps/unknown schemas and does not re-run execution.

#### RED/GREEN tests

- RED: current v2 route family has no events/replay/stream endpoint and RunStreamRegistry cannot survive process loss.
- GREEN: query ordering, replay, reconnect, duplicate handoff, cursor expiry, disconnect, keepalive, and authorization tests pass after implementation.

#### Related regression

- Legacy Task SSE and Conversation stream tests remain green and remain separate.
- Existing EventBus and RunStreamRegistry behavior is not silently reclassified.

#### Full-gate trigger conditions

- P2 Event Store and Outbox are complete and reviewed.
- P3 API headers/errors/operation contract is complete.
- Stream fixture proves history plus realtime handoff.

#### Stop conditions

- Stream correctness depends on process-local buffers.
- Disconnect cancels Run execution.
- Replay requires provider or Run re-execution.
- A cursor or event gap cannot be diagnosed.

#### Rollback boundary

Disable or revert new v2 Events/Replay/Stream routes while retaining the Legacy endpoint. Do not delete persisted event data as rollback.

#### Exit gate

P4 is complete only when independent review accepts durable query, replay, reconnect, cursor, and disconnect evidence.

#### Independent review requirements

Review Event Store truth, cursor semantics, duplicate handoff, authorization, reconnect guarantees, and no-cancel behavior.

#### L3 requirements

Run deterministic SSE integration tests, process-restart fixture tests, event ordering checks, browser-disconnect simulation in the test harness, and related regression. No production server/Web run.

### P5 — Legacy Compatibility Mapping

#### Goal

Keep the Legacy execute-task and Legacy SSE paths usable while making their behavior a projection of the M3 Task-domain Run/Event contract where the mapping is proven.

#### Authorized scope

- Map Legacy POST execute-task internally to Create Run then Start Run.
- Map status, stage, thinking, done, and error frames to v2 Runtime Events.
- Preserve Legacy response/frame shape and existing callers.
- Add compatibility and bridge fixtures.

#### Forbidden scope

- Legacy API retirement.
- Legacy JSON retirement or deletion.
- Web global default switch.
- A second execution model that bypasses the Task-domain Run/Event path.
- Bulk conversion or invented historical events.

#### Exact files/categories

- Candidate Legacy route: apps/server/src/routes/tasks.ts.
- Candidate bridge: apps/server/src/services/TaskRunService.ts and compatibility mapping category.
- Candidate tests: taskPipelineBridge, LegacySseMapping, LegacyReconnectBoundary, and v2 Event projection suites.
- Web files remain read-only for this phase; no default change.

#### Required evidence

- Legacy route remains callable through the M3 end-state.
- Compatibility response corresponds to the canonical Run/Operation result.
- Legacy frames are projected from persisted v2 events, not an independent timer or execution path.
- Errors and terminal state reconcile without duplicating state transitions.

#### RED/GREEN tests

- RED: current Legacy frames are emitted directly by the request-bound pipeline and are not durable v2 Event projections.
- GREEN: mapping, terminal reconciliation, error mapping, duplicate command, and Legacy usability tests pass.

#### Related regression

- Existing Legacy Task route, taskRecovery, v2 Task/Run, and Web consumer contract tests remain green.

#### Full-gate trigger conditions

- P3 and P4 contracts are complete.
- Independent review accepts the mapping and confirms no second execution model.
- Legacy route compatibility is demonstrated for create, start, progress, terminal, error, and refresh/disconnect boundaries.

#### Stop conditions

- Mapping requires deleting or changing Legacy JSON/API behavior.
- Web default change is requested.
- Legacy and v2 paths diverge into two execution authorities.

#### Rollback boundary

Revert the mapping layer while retaining the existing Legacy route and data. Do not delete compatibility evidence or source JSON.

#### Exit gate

P5 is complete only when the Legacy route remains usable and the mapping is independently reviewed. It is not a Legacy Retirement gate.

#### Independent review requirements

Review response/frame compatibility, event projection, no-double-execution, active-run behavior, and rollback safety.

#### L3 requirements

Run Legacy and v2 contract suites together, include refresh/disconnect and terminal race fixtures, and record exact results. No production consumers are switched.

### P6 — Recovery, Browser Disconnect and Outbox Failure Verification

#### Goal

Demonstrate the M3 resilience invariants across browser refresh/disconnect, process restart, durable replay, Outbox failure, retry, duplicate publication, and uncertain state.

#### Authorized scope

- Task-domain startup recovery scan.
- Persisted Run/Stage/Event recovery decisions.
- Browser subscription disconnect semantics.
- Outbox retry, backoff, duplicate, and dead-letter handling.
- Recovery and failure fixtures without production data.

#### Forbidden scope

- Production Restore or downgrade.
- Production Cutover or operator quiescence.
- Guessing success from process or stream state.
- Cross-domain Conversation recovery unification.
- Data deletion or user-data copy.

#### Exact files/categories

- Candidate recovery categories: apps/server/src/runRecovery.ts and a Task-domain Run recovery service.
- Candidate publisher categories: OutboxPublisher and failure/dead-letter repository.
- Candidate tests: BrowserDisconnect, ServerRestartRecovery, OutboxRecovery, DuplicatePublish, EventGap, and UncertainRun suites.
- No production migration/restore scripts.

#### Required evidence

- Browser refresh/disconnect leaves Run durable and continues execution.
- Server restart resumes or marks Run recovery_required based on persisted evidence.
- Outbox publisher retries without duplicate Run/Event effects.
- Event Store remains the sole source of replay truth.
- Failure and unknown state are visible through stable codes/events.

#### RED/GREEN tests

- RED: current request-bound Legacy path aborts on close and no Task-domain durable stream/recovery chain exists.
- GREEN: disconnect, restart, replay, outbox failure, retry, duplicate, gap, and uncertainty tests pass after implementation.

#### Related regression

- Existing taskRecovery, runRecovery, Conversation recovery, EventBus, Legacy bridge, and stream tests remain green without aggregate unification.

#### Full-gate trigger conditions

- P2 Event/Outbox and P4 Stream contracts are implemented and reviewed.
- Recovery owner and uncertainty policy are accepted.
- Failure fixtures are deterministic and contain no real user data.

#### Stop conditions

- Recovery needs production restore or an unapproved operator policy.
- The implementation infers success where persisted evidence is incomplete.
- Browser disconnect still cancels Task-domain execution.
- Outbox retry duplicates state transitions.

#### Rollback boundary

Revert recovery/publisher code and test fixtures before any production use. Preserve durable evidence; do not delete failed or dead-letter records as rollback.

#### Exit gate

P6 is complete only when independent review accepts resilience evidence. It does not authorize production observation or cutover.

#### Independent review requirements

Review restart semantics, uncertainty handling, disconnect behavior, retry idempotency, dead letters, and data safety.

#### L3 requirements

Run controlled local fresh/legacy DB fixtures, process restart harnesses, targeted failure suites, typecheck/build, and all related regressions. No restore or production data access.

### P7 — Consolidated Formal Gate, Draft PR, Ordinary Merge and Closeout

#### Goal

Assemble the complete M3 evidence package, obtain independent review, use the authorized Draft PR and ordinary merge process for a future implementation change, and close M3 without implying Production Cutover.

#### Authorized scope

- Consolidated contract-to-evidence matrix.
- Full M3 test and regression evidence.
- Independent technical review and remediation.
- Future Draft PR, ordinary merge commit, and post-merge closeout when implementation is actually authorized.
- M3 documentation update that records factual status.

#### Forbidden scope

- Production Cutover authorization or execution.
- Production Restore.
- Web global default switch.
- Legacy API/JSON deletion or retirement.
- Post-cutover observation or cohort rollout.
- Declaring any phase passed without exact evidence.

#### Exact files/categories

- M3 implementation commits and their tests, only after P0–P6 authorization.
- Draft PR description and review artifacts for the future implementation branch.
- Consolidated M3 closeout documentation category.
- No current remediation PR; current remediation is docs-only and push-only.

#### Required evidence

- M3 Scope, Deliverables, Compatibility, Tests, and Exit Gate each map to exact code/test evidence.
- All related regression suites, typecheck/build, schema checks, API contract checks, and L3 evidence are recorded.
- Independent review findings are resolved or explicitly blocking.
- Branch, parent, merge, and remote-check status are factual.
- Production Cutover and Legacy Retirement remain separate future gates.

#### RED/GREEN tests

- RED: any missing M3 deliverable, unreviewed boundary, unsupported completion claim, or regression failure blocks closeout.
- GREEN: the full M3 acceptance matrix passes with exact command output and independent review, while production gates remain explicitly not authorized.

#### Related regression

- M2 retained contracts, Legacy route usability, Web Legacy default behavior, Task/Conversation separation, migrations 001–011, and existing route/recovery tests.

#### Full-gate trigger conditions

- P0 through P6 each have an accepted exit gate.
- Full M3 Roadmap exit conditions are evidenced.
- Independent reviewer signs the technical gate.
- Any future Draft PR has required reviewers and no unresolved blocking comments.
- Ordinary Merge Commit is separately authorized by the project workflow.

#### Stop conditions

- Remote Checks are unavailable and no permitted substitute evidence is accepted.
- A required gate is inferred from documentation rather than command output.
- Review finds a production cutover, deletion, restore, default switch, or later-milestone scope leak.
- Any phase is described as complete without evidence.

#### Rollback boundary

Rollback is limited to the future implementation branch/merge boundary. Production rollback, downgrade, restore, and data deletion remain post-M3 Owner decisions.

#### Exit gate

M3 Lifecycle, Event and API Foundation may be proposed for ordinary merge only after formal review. Production Cutover remains NOT AUTHORIZED, Legacy Retirement remains later work, and M3 P1 is not authorized by this planning document.

#### Independent review requirements

Independent technical review, API/schema review, security/privacy review where payloads or credentials are involved, and L3 verification are required. Owner approval is required for any irreversible schema/data, production, external-cost, or material UX action.

#### L3 requirements

Provide exact commands, outputs, commit SHAs, changed-file scope, migration registry/checksum evidence, API/schema contract evidence, test evidence, and explicit Remote Checks status. Never label unavailable evidence as passed.

## 5. Contract-to-phase correspondence

| Roadmap contract | Primary phase(s) | Required evidence |
| --- | --- | --- |
| Run state machine and Run Engine | P0, P1, P6 | Transition matrix, async Start, version conflict, restart/disconnect evidence |
| Workflow Executor Foundation and Stage Transition | P1 | Snapshot/stage ownership and deterministic executor tests |
| Runtime Event envelope and sequence | P0, P2 | 22-row gap proof, canonical fixture, unique per-Run sequence |
| Event Store and Outbox | P2, P6 | Atomic transaction, post-commit publish, retry/dead-letter evidence |
| Create/Get/Cancel/Start Run and Operation | P1, P3 | Route contract, 202 Operation, stable errors, idempotency |
| Run Events, Replay, and Run Stream | P3, P4, P6 | Query, replay, Last-Event-ID, afterSequence, restart and disconnect evidence |
| Legacy compatibility | P5 | Usable Legacy route and event projection without second execution model |
| API Problem, ETag, If-Match, OpenAPI | P3 | Contract artifact and 400/409/412/422/500 fixtures |
| Retry child Run and exit invariants | P1, P2, P4, P6 | Child lineage, immutable terminal Run, ordering, recovery evidence |
| Formal M3 gate | P7 | Full evidence matrix and independent review; no Production Cutover claim |

## 6. M3 exit boundary

The M3 exit proposal must state all of the following:

- Browser Refresh does not cancel Run.
- Client disconnect ends only the subscription.
- Event sequence is strictly increasing per Run.
- State, Event, and Outbox are transactional.
- Error codes are stable.
- Run Start is asynchronous.
- Retry creates a new Run.
- Legacy route remains usable.
- Web global default remains unchanged.
- Legacy API and Legacy JSON are not deleted.
- runs and agent_runs remain separate.
- Production Cutover, Production Restore, and Legacy Retirement are not M3 exit claims.

Current status remains:

M3 P1 NOT AUTHORIZED.

PRODUCTION CUTOVER NOT AUTHORIZED.

This plan is a draft for independent technical review, not an implementation result.
