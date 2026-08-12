# AgentOS M3 Lifecycle, Event and API Foundation Implementation Plan

Status: M3 IMPLEMENTATION COMPLETE — FORMAL CLOSEOUT COMPLETE UPON PR #43 MERGE — CURRENT PRE-PR #43 MAIN PR #44 / CI PASS — M4 ENTRY PENDING SEPARATE ENTRY DECISION — M4 PREPLANNING NOT AUTHORIZED BY THIS CLOSEOUT — PRODUCTION CUTOVER NOT AUTHORIZED / NOT STARTED

This plan began as the integrated M3 P2 local closeout record and now carries the sequential M3 implementation contract through the accepted P5C baseline and the P6A0 docs-only technical closure. P6 production implementation is complete / accepted and merged as part of M3. Repository CI is now available and passing; Production Cutover and M4 production implementation remain outside the completed M3 Foundation authorization boundary.

## 1. Authoritative contract

M3 is the Lifecycle, Event and API Foundation defined by Runtime Specification 14, Roadmap §§47–53:

- Objective: run a persistent Run state machine through a Persist-then-publish Event Path.
- Scope: Run Engine, Workflow Executor Foundation, Stage Transition, Runtime Event Envelope, Task-domain Sequence Allocator, Event Store, Outbox, SSE, reconnect, ApiProblem, Operation Resource, ETag, Idempotency Middleware, Basic OpenAPI, and the shared contracts needed by those surfaces.
- Deliverables: Create Task, Create Run, Start Run, Get Run, Cancel Run, Run Events, Run Stream, Operation, Error Mapping, Event Fixture, and Replay Foundation.
- Compatibility: Legacy execute-task remains usable and maps to Create Run then Start Run; Legacy SSE remains usable and maps status, stage, thinking, done, and error frames to v2 Events.
- Exit invariants: Browser refresh does not cancel Run; client disconnect ends only the subscription; per-Run sequence is strictly increasing; State/Event/Outbox is transactional; error codes are stable; Start Run is asynchronous; Retry creates a new Run.

## 2. Frozen boundaries and dependency cycle

### 2.1 M3 in scope

- Task-domain Run and Stage lifecycle.
- Schema and Shared Contract Foundation.
- Central Runtime Event Registry.
- Task-domain Runtime Event Store, sequence allocator, Outbox, dead letters, and replay.
- Transactional Run/Stage state transitions.
- Run Engine, minimal Workflow Executor, and Operation.
- ApiProblem, ETag, If-Match, Idempotency, OpenAPI, and route compatibility.
- Durable Run Events, Replay, SSE, reconnect, cursor, and Last-Event-ID.
- Legacy mapping, recovery, Outbox failure verification, fixtures, regression, and L3 evidence.

### 2.2 M3 out of scope

- Production Cutover or Production Restore.
- Web global v2 default switch.
- Legacy API retirement.
- Legacy JSON physical retirement, deletion, or speculative bulk migration.
- Post-Cutover production observation or cohort rollout.
- Task and Conversation aggregate unification.
- ProcessManager and ProviderAdapter work reserved for M4.
- Worktree, Policy, Approval, and other later-milestone runtime domains.
- Treating Conversation agent_events or RunStreamRegistry as Task-domain Event Store or Durable Run Stream.

### 2.3 Hard dependency rules

1. P0 closes the technical contract and the final P0 docs merge gate.
2. P1 only completes Schema and Shared Contract Foundation.
3. No persistent Run/Stage status migration or real lifecycle transition occurs in P1.
4. All persistent Run/Stage status migration begins in P2.
5. Every P2 state transition atomically writes Current State + Runtime Event + Outbox. No real state transition may be implemented before that transaction core.
6. Run Engine, Workflow Executor execution, and Start route integration begin only after P2 transaction core.
7. P4 preserves Legacy and current v2 routes while adding canonical top-level Run/Operation paths; it does not replace the canonical Task Collection.
8. P5 uses the race-free subscribe/buffer/high-watermark/replay/drain/deduplicate/live handoff.
9. P6 production begins only after P6A0 freezes the delivery, recovery, retry/dead-letter, and Legacy single-execution contracts and that docs package passes independent remote review.
10. P7 can propose an ordinary merge for M3 Foundation only; it cannot authorize Production Cutover or Legacy Retirement.

## 3. Pre-P1 and P0 merge gate

Before any future M3 implementation branch:

1. Fetch origin.
2. Confirm the main worktree is clean.
3. Fast-forward local main only to origin/main.
4. Confirm local main equals origin/main.
5. Do not use reset --hard, force-push, or an implicit merge to hide divergence.
6. If fast-forward-only synchronization is impossible, stop and obtain independent review.

The P0 docs must not become an implicit parent contract for a P1 branch. After this remediation receives final independent P0 review:

1. Create a docs-only Draft PR.
2. Complete independent review.
3. Merge with an ordinary Merge Commit.
4. Fetch and confirm origin/main has the merge.
5. Synchronize local main with origin/main using fast-forward-only.
6. Confirm main equals origin/main.
7. Only then create the M3 P1 implementation branch.

This current remediation creates no PR and does not authorize P1.

## 4. Implementation phases

### P0 — Contract and Technical Decision Closure

#### Goal

Close the M3 technical contract, schema-gap scope, shared contract boundaries, API compatibility paths, Task Event/runId conflict, race-free SSE handoff, and phase dependency order.

#### Authorized scope

- Read-only inspection of Runtime Specification, M2 contracts, migration registry, and current code.
- Modification of the three existing M3 Markdown files only.
- The 22-entry Gap Matrix and exact Migration 012 planning scope.
- Technical decisions marked APPROVED BY INDEPENDENT TECHNICAL REVIEW — IMPLEMENTATION STILL NOT AUTHORIZED.

#### Forbidden scope

- Production code, tests, migrations, Registry, package, API, Web, database, runtime, restore, or data changes.
- Migration 012 DDL.
- Persistent Run/Stage migration.
- M3 P1 implementation.
- PR creation in this remediation.

#### Exact files/categories

- docs/implementation/milestones/M3-current-state-audit.md.
- docs/implementation/milestones/M3-owner-decisions.md.
- docs/implementation/milestones/M3-lifecycle-event-api-implementation-plan.md.
- Read-only evidence from docs/Runtime-Specification, migration registry, packages/shared, apps/server/src, and apps/web/src/lib/useTask.ts.

#### Required evidence

- Roadmap §§47–53 mapped to phases and exit invariants.
- Exact 12-part Migration 012 planning scope, including run_stages, recovery representation, idempotency operation values, dead letters, and Queue decision.
- Explicit Task Event/runId deferred alignment.
- Explicit Legacy/current-v2/canonical-top-level route strategy.
- Exact six-step race-free SSE handoff.
- Central Runtime Event Registry and packages/shared scope.
- P0 merge gate requiring Draft PR, independent review, ordinary Merge Commit, origin/main update, ff-only local main sync, and only then P1.

#### RED/GREEN tests

- RED: the prior plan placed Run Engine/Start too early, left schema/state dependencies unresolved, used a race-prone replay-then-subscribe shape, and left API/Event conflicts implicit.
- GREEN evidence required: all three docs state the corrected order, schema gaps, approved decisions, compatibility paths, handoff algorithm, and authorization boundaries.
- These are document acceptance checks, not implementation test results.

#### Related regression

- M2 remains sealed.
- Legacy JSON, Legacy API, Web default, current v2 compatibility, and runs versus agent_runs remain unchanged.

#### Full-gate trigger conditions

- Final independent P0 technical review accepts all contract decisions.
- Docs-only Draft PR and ordinary Merge Commit process is available for the future P0 merge.
- origin/main can be updated and local main can be synchronized ff-only.
- No P1 branch is created from an unmerged P0 docs branch.

#### Stop conditions

- Runtime Specification conflict remains unresolved.
- A decision requires DDL, data deletion, restore, production behavior, external cost, or major UX without Owner Approval.
- Evidence requires running migration, restore, server, Web, or production copy.
- Scope expands into Cutover, Retirement, M4, or aggregate unification.

#### Rollback boundary

Only this docs remediation commit may be reverted before implementation. No database, production, or user-data state is touched.

#### Exit gate

P0 remains TECHNICAL CONTRACT APPROVED BY INDEPENDENT REVIEW — IMPLEMENTATION STILL NOT AUTHORIZED until final P0 docs review and the docs-only merge gate complete.

#### Independent review requirements

Independent review must cover contract mapping, Migration 012 planning scope, Task/Conversation separation, API path compatibility, Event Registry, and SSE handoff.

#### L3 Gate requirements

Use exact Git, diff, scope, structure, link, encoding, and secret-scan evidence from the actual worktree. Missing Remote Checks remain UNAVAILABLE — NOT PASS.

### P1 — Schema and Shared Contract Foundation

#### Goal

Define and validate the shared types, event registry, schema contract, and Migration 012 implementation package without performing persistent Run/Stage status migration or real lifecycle transitions.

#### Authorized scope

- packages/shared Run/Stage status types.
- RuntimeEvent envelope, schemaVersion, payload schemas, unknown-event fallback, and SSE event DTOs.
- ApiProblem, ApiOperation, Request/Response DTOs, and shared identifiers.
- Central Runtime Event Registry with registration/default/payload validation.
- Exact Migration 012 schema design and review package.
- Queue decision: runs(status=queued), with no scheduler_jobs by default.

#### Forbidden scope

- Applying persistent Run/Stage status migration.
- Creating a real Run/Stage transition that lacks the State/Event/Outbox transaction.
- Run Engine, Workflow Executor execution, Start route, Operation route behavior, Replay, SSE live subscription, or recovery execution.
- Using Conversation event structures as Task-domain schema.
- Adding scheduler_jobs without evidence and review.

#### Exact files/categories

- packages/shared status, RuntimeEvent, ApiProblem, ApiOperation, DTO, and SSE contract categories.
- Candidate central Event Registry category and its schema/fixture definitions.
- Migration 012 design artifact and review category; no DDL is created in this remediation.
- Shared contract and Registry unit/fixture test categories only.

#### Required evidence

- Registry rejects unregistered Core Events.
- Registry validates schemaVersion, default severity, visibility, durability, payload schema, and unknown future-event behavior.
- Migration 012 package specifies runtime_events, UNIQUE(run_id, sequence) and query indexes including runtime_events(run_id, correlation_id, sequence), outbox_messages, dead_letters or reviewed equivalent, durable operations with operations.run_id or equivalent aggregate reference and operations.correlation_id, run_stages expansion preserving existing version, idempotency operation values, recovery representation, sequence allocator, append-only/controlled-update constraints, and Queue decision.
- Operation contract includes workspaceId, aggregateType=run, aggregateId/runId, immutable unique correlationId, exact lifecycle/result/ApiProblem fields, and no independent operation_events Event Store.
- SQLite table rebuild risk, checksum, fresh/legacy DB, rollback/forward-compatibility, and L3 review requirements are recorded.

#### RED/GREEN tests

- RED: current shared contract is fragmented, no central registry exists, and migrations 001–011 lack the M3 schema.
- GREEN: shared type, envelope, Registry, payload validation, unknown-event fallback, and schema-contract tests pass; no persistent lifecycle state has moved.

#### Related regression

- Existing packages/shared consumers, M2 migrations 001–011, Conversation AgentEvent/EventBus tests, and current v2 DTO consumers remain unchanged.

#### Full-gate trigger conditions

- P0 final review and docs-only merge gate are complete.
- Migration 012 schema package has independent schema review.
- Shared contract does not encode a state or route that later phases cannot transactionally support.

#### Stop conditions

- A proposed shared type requires an unapproved product behavior.
- Run/Stage migration is attempted in P1.
- Registry accepts unregistered Core Events or hides unknown-event incompatibility.
- Schema gap cannot be represented without changing the approved Task-domain boundary.

#### Rollback boundary

Revert shared types, Registry, contract fixtures, and schema design artifacts as one P1 package. No persistent data rollback is involved because no status migration occurs.

#### Exit gate

P1 is complete only when Schema and Shared Contract Foundation evidence is independently accepted and no real Run/Stage state has migrated.

#### Independent review requirements

Independent review covers shared type compatibility, Event Registry invariants, schema design, SQLite rebuild risk, and unknown-event behavior.

#### L3 Gate requirements

Run shared type/fixture tests, schema diff inspection, fresh/legacy fixture preparation checks, checksum design checks, and related regressions. Do not apply Migration 012.

### P2 — Transactional Run and Stage Lifecycle Core

#### Goal

Begin all persistent Run/Stage status migration and implement the transaction core that atomically writes Current State + Runtime Event + Outbox for every state transition.

#### Lifecycle/Event dependency

The P2 lifecycle sequence is:

```text
Specification Alignment → Shared Event Contract Closure → Transactional Lifecycle Core
```

P2C-1 must complete the Shared Event Contract Closure and receive independent
specification review before P2C-2 begins transactional lifecycle work. P2C-2
must use the frozen transition/Event ownership from M3-TD-21 and must not
redefine the four canonical startup mappings.

#### P2 phase status and authorization

- **P2A — Migration 012 Schema Foundation:** COMPLETE.
- **P2B — Event/Sequence/Outbox Persistence:** COMPLETE.
- **P2C-0 — Lifecycle Event Specification Closure:** COMPLETE.
- **P2C-1 — Shared Lifecycle Event Contract Implementation:** COMPLETE.
- **P2C-2 — Transactional Run/Stage Lifecycle Core:** LOCAL FORMAL GATE PASSED.
- **P2 overall:** LOCAL FORMAL GATE PASSED — PENDING INDEPENDENT REVIEW.
- **Remote Checks:** UNAVAILABLE — NOT PASS.
- **P3 — Run Engine, Workflow Executor and Operation:** NOT AUTHORIZED.
- **Production Cutover:** NOT AUTHORIZED / NOT STARTED.

The P2 phase status and P2C-0 authorization language in this section are the
historical P2 specification-gate record; they do not describe the repository's
current integrated state. The current state is recorded at the end of this
plan. The historical gate did not authorize P3, a merge, or Production Cutover.

#### P2C-0 — Lifecycle Event Specification Closure

##### Goal

Close the normative Transition/Event Matrix and the remaining Run creation,
Queue telemetry, Approval multi-aggregate, non-terminal Stage cancellation,
and ordered multi-Event transaction semantics.

##### Authorized scope

- `docs/Runtime-Specification/02-Runtime-Lifecycle.md`;
- `docs/Runtime-Specification/03-Event-Model.md`;
- `docs/implementation/milestones/M3-owner-decisions.md`;
- this implementation plan;
- `docs/implementation/milestones/M3-p2c-transition-event-matrix.md`.

##### Forbidden scope

- packages/shared, apps/server, Migration 012, Registry, tests, or database;
- P2C-1 Shared contract implementation;
- P2C-2 transactional lifecycle implementation;
- P3 Run Engine, API, Operation, Server, Web, or Production Cutover work.

##### Required evidence

- 17/17 allowed Run transitions and 19/19 allowed Stage transitions have a
  Primary Event;
- every unlisted transition has no Event mapping;
- M3-TD-21 through M3-TD-25 are present without duplicate IDs;
- Approval and cancellation sequences preserve contiguous ordering and one
  Outbox record per Durable Event;
- no implementation or Migration file changes are present.

##### Historical exit gate

P2C-0 exits only after independent specification review accepts the matrix,
the four existing startup mappings remain unchanged, and the exact docs-only
commit is pushed. This exit gate does not authorize P2C-1, P2C-2, P3, or
Production Cutover.

#### Authorized scope

- Authorized Migration 012 implementation and schema registration after P1 review.
- runtime_events, indexes, sequence allocator using runs.next_event_sequence.
- outbox_messages, dead_letters or reviewed equivalent, immutable/concurrency constraints.
- run_stages expansion for M3 lifecycle, failure_code/failure_message, and started_at/completed_at; preserve the existing Migration 009 version column and use it for optimistic version-checked updates, without adding a duplicate version column.
- Explicit runs.recovery_required or separate Recovery Record choice.
- idempotency_records.operation extension for run.start, run.retry, and approved M3 commands.
- Run/Stage transition repository and transaction service, without Run Engine orchestration.

#### Forbidden scope

- Any transition that writes Current State without Runtime Event and Outbox in the same transaction.
- Run Engine, Start route integration, Workflow Executor execution, Operation API, SSE, Replay, or Legacy mapping.
- Production migration, restore, data copy, or unreviewed DDL.
- Referencing recovery_required if the chosen schema representation does not exist.

#### Exact files/categories

- Migration 012 and migration registry categories, only after separate authorization.
- RuntimeEventRepository, SequenceAllocator, OutboxRepository, DeadLetter/Failure repository.
- RunStageRepository and transactional lifecycle core category.
- Idempotency schema/repository category.
- Transaction, sequence, duplicate, rollback, and migration tests.

#### Required evidence

- Every Run/Stage status transition uses the same transaction boundary.
- Runtime Event is append-only and unique by run_id plus sequence.
- Outbox immutable fields are id, event_id or equivalent Event reference, topic, aggregate_type/aggregate_id, payload, and created_at. Controlled mutable delivery fields are status, attempts, available_at, published_at, last_error, and optional lease/fencing/version. Delivery updates use a state machine, conditional UPDATE, and concurrency protection; the entire outbox_messages table is not UPDATE-prohibited.
- operations.run_id or equivalent aggregate reference and operations.correlation_id are present; correlationId is unique and immutable; runtime_events(run_id, correlation_id, sequence) supports query.
- Run Stage status fields support the approved M3 lifecycle.
- Queue uses runs(status=queued) unless later evidence proves otherwise.
- Recovery representation is present before any P6 implementation references it.

#### RED/GREEN tests

- RED: current RunRepository updates state without Runtime Event/Outbox; current run_stages is pending-only; migrations 001–011 lack the schema.
- GREEN: migration fresh/legacy, sequence monotonicity, duplicate rejection, atomic rollback, Run/Stage transition, Outbox immutability, and idempotency operation tests pass.

#### Related regression

- Migrations 001–011, MigrationRunner, RunRepository, TaskRunService, IdempotencyService, EventBus, and Conversation persistence tests remain green.

#### Full-gate trigger conditions

- P1 schema/shared contract exit is accepted.
- Migration 012 DDL receives independent schema review and required Owner Approval for irreversible change.
- Transaction core proves no un-evented real state path.

#### Stop conditions

- State transition path can commit without Event or Outbox.
- Migration 012 needs unapproved data destruction or cannot pass fresh/legacy/rollback review.
- Recovery state is referenced before schema representation exists.
- Conversation tables are proposed as Task-domain substitutes.

#### Rollback boundary

Future Migration 012 has its own reviewed rollback/forward-compatibility boundary; deleting a migration file is not rollback. Code/test changes may revert before P3.

#### Exit gate

P2 is complete only when the transactional Run/Stage lifecycle core and schema evidence are independently accepted. No Run Engine or Start route claim is included.

#### Independent review requirements

Independent schema, transaction, concurrency, and data migration review is mandatory. Owner Approval is mandatory for irreversible DDL or data movement.

#### L3 Gate requirements

Run fresh and legacy DB fixtures, checksum checks, transaction rollback/commit tests, concurrent sequence tests, duplicate Outbox tests, and related regressions. Do not use production data.

### P3 — Run Engine, Workflow Executor and Operation

#### Goal

Build the Task-domain Run Engine, minimal Workflow Executor Foundation, Stage orchestration, durable Operation lifecycle, and asynchronous Start only after P2 transaction core.

#### Authorized scope

- Run Engine and scheduler ownership over runs(status=queued).
- Minimal deterministic/mock Workflow Executor and Stage execution.
- Run transitions through P2 transaction core.
- Create Run, Start Run, Get Run, Cancel Run, Retry, and Operation integration.
- Operation statuses exactly queued, running, waiting_approval, paused, completed, failed, cancelled.
- M3 Operation tracks only Task-domain Run commands and stores workspaceId, aggregateType=run, aggregateId/runId, unique immutable correlationId, result, ApiProblem, timestamps, and version.
- HTTP 202 Start result and Operation APIs.

#### Forbidden scope

- Start integration before P2 exit.
- ProcessManager, ProviderAdapter, real provider runtime, Worktree, Policy, or Approval implementation.
- Run/Stage state writes bypassing Event/Outbox.
- Production execution or cutover behavior.

#### Exact files/categories

- Run Engine, Scheduler, Workflow Executor, and Stage Executor service categories.
- RunRepository, RunStageRepository, TaskRunService integration categories.
- OperationRepository and Operation service categories.
- Canonical top-level Run/Operation route categories, without replacing Legacy/current v2 collections.
- Operation endpoints use the unified parameter name operationId: GET /api/operations/:operationId, GET /api/operations/:operationId/events, and POST /api/operations/:operationId/cancel.
- Run lifecycle, Operation, duplicate Start, Cancel race, and Retry tests.

#### Required evidence

- queued Run is the persistent Queue Record.
- Start is asynchronous, returns 202 and Operation, and is idempotent.
- Run state machine follows Runtime Lifecycle Transition Table.
- Retry creates a child Run and never resets old Run.
- Operation is distinct from Run and exposes exact status/result/error/version fields.
- GET /api/operations/:operationId/events first reads and authorizes the Operation, then uses its runId and correlationId to query runtime_events and return ascending sequence. It does not use an operation_events store; non-Run Operations are Post-M3.
- Workflow Executor is deterministic and does not require M4 provider runtime.

#### RED/GREEN tests

- RED: no Run Engine/Start route/Operation resource exists and current transition graph is partial.
- GREEN: Run Engine, deterministic stage execution, async Start, duplicate Start, cancel/complete conflict, Operation lifecycle, and child Retry tests pass.

#### Related regression

- Existing v2 Task/Run, RunRepository, TaskRunService, task recovery, and Legacy bridge tests remain green.

#### Full-gate trigger conditions

- P2 transaction core is independently accepted.
- Operation status/API contract is accepted.
- Run Engine has no direct persistence path outside the transaction core.

#### Stop conditions

- Engine requires ProcessManager, ProviderAdapter, Policy, Approval, or production operator behavior.
- Start or Stage transition bypasses Event/Outbox.
- Operation status diverges from the approved exact vocabulary.

#### Rollback boundary

Revert Engine, executor, Operation, and route integration as one package before P4. Preserve durable evidence; do not reset or delete data to hide a failed transition.

#### Exit gate

P3 is complete only when Run Engine, minimal Workflow Executor, Operation, async Start, and Retry evidence are independently accepted.

#### Independent review requirements

Review Run ownership, transaction usage, Operation distinction, retry lineage, cancellation races, and M4 boundary.

#### L3 Gate requirements

Run targeted lifecycle/Operation tests, typecheck/build, route authorization checks, duplicate/race fixtures, and related M2 regression. Record exact outputs.

### P4 — API Problem, ETag, Idempotency, OpenAPI and Route Compatibility

#### Goal

Complete the stable API contract while preserving Legacy and current v2 paths and adding canonical top-level Run/Operation paths without switching the Web default.

#### Authorized scope

- ApiProblem middleware and stable error mapping.
- ETag and If-Match with 412 behavior and documented version fallback.
- Idempotency middleware for run.start, run.retry, and approved M3 commands.
- Basic OpenAPI for Legacy, current v2, and canonical top-level routes.
- Canonical Run and Operation route compatibility.

#### Forbidden scope

- Canonical Task Collection replacement.
- Legacy API removal.
- Web global default switch.
- Production operation or cutover command.
- OpenAPI claims that a route family has already been migrated.

#### Exact files/categories

- ApiProblem, ETag/If-Match, Idempotency middleware categories.
- Basic OpenAPI artifact and validation category.
- Current v2 route categories under /api/workspaces/:workspaceId/v2.
- Canonical routes /api/runs/:runId, /start, /retry, /events, /replay, /stream.
- Operation routes /api/operations/:operationId, /events, and /cancel.
- API contract, header, error, idempotency, and OpenAPI tests.

#### Required evidence

- ApiProblem is stable for validation, not-found, conflict, precondition, rate, and internal failures.
- ETag is emitted; stale If-Match returns 412.
- Same Idempotency-Key and hash replays original result without duplicate State/Event/Outbox effects.
- OpenAPI separately documents Legacy, current v2, and canonical top-level paths.
- Current Legacy path and Web behavior remain usable.

#### RED/GREEN tests

- RED: current v2 exposes partial error/code and expectedVersion behavior but no complete ApiProblem, ETag, If-Match, canonical paths, or M3 idempotency.
- GREEN: API contract covers 202, 400, 404, 409, 412, 422, stable codes, ETag, replay, key reuse, and all route families.

#### Related regression

- Existing v2 Task/Run, Legacy Task, IdempotencyService, and Web Legacy consumer tests remain green.

#### Full-gate trigger conditions

- P3 Operation and async Start are accepted.
- API path conflict and compatibility decision are independently reviewed.
- OpenAPI matches executable route behavior and does not claim Task Collection cutover.

#### Stop conditions

- A route implementation removes or changes Legacy behavior.
- OpenAPI masks a missing route or false migration state.
- Idempotency cannot encompass State/Event/Outbox effects.

#### Rollback boundary

Revert API/middleware/OpenAPI changes as one package; preserve Legacy and current v2 paths. No compatibility deletion is a rollback action.

#### Exit gate

P4 is complete only when route compatibility, ApiProblem, ETag, If-Match, Idempotency, and OpenAPI evidence is independently accepted.

#### Independent review requirements

Review API resource semantics, error stability, concurrency, idempotency replay, route conflicts, and user-visible compatibility.

#### L3 Gate requirements

Run route contract, header, schema/OpenAPI validation, idempotency integration, typecheck/build, and related regressions. Remote Checks remain factual.

### P5 — Run Events, Replay, SSE and Reconnect

#### Goal

Expose durable Task-domain Run Events, Replay, and SSE with race-free reconnect and strict sequence guarantees from Event Store truth.

#### Authorized scope

- GET /api/runs/:runId/events.
- GET /api/runs/:runId/replay.
- GET /api/runs/:runId/stream.
- afterSequence and Last-Event-ID.
- Durable Event Store query, replay, live subscription, cursor expiry, keepalive, and authorization.
- Six-step race-free handoff: subscribe/buffer, high-watermark, replay, drain above watermark, deduplicate by runId plus sequence, Live.

#### Forbidden scope

- Replay-then-subscribe race.
- Process-local RunStreamRegistry as durable truth.
- Re-running Run/provider during replay.
- Persisting keepalive as Runtime Event.
- Legacy SSE removal or Web default switch.

#### Exact files/categories

- Canonical Run Event/Replay/Stream route categories.
- EventQueryService, ReplayService, RunStreamService, and EventBus subscription categories.
- Cursor, Last-Event-ID, sequence deduplication, and stream fixture categories.
- Run Events, Replay, SSE handoff, reconnect, cursor expiry, and disconnect tests.

#### Required evidence

- Live subscription buffers before durable high-watermark capture.
- Replay reaches high-watermark, drains newer buffered events, deduplicates, then enters Live.
- An Event committed in the handoff window is neither lost nor duplicated.
- Per-Run sequence is strictly increasing.
- Last-Event-ID and afterSequence reconnect from Event Store.
- Client disconnect removes subscription only; Run continues.
- Process restart replays from Event Store.

#### RED/GREEN tests

- RED: current v2 route family lacks durable Events/Replay/Stream and current local cursor cannot survive process loss; replay-then-subscribe can race.
- GREEN: window commit, no-loss, no-duplicate, strict ordering, reconnect, cursor expiry, disconnect, keepalive, and restart recovery tests pass.

#### Related regression

- Legacy Task SSE and Conversation stream tests remain green and remain separate.
- EventBus and RunStreamRegistry are not silently reclassified.

#### Full-gate trigger conditions

- P2 Event Store/Outbox and P4 API contract are accepted.
- Handoff fixture proves replay/live switching under concurrent event commit.
- Cursor and authorization behavior are stable.

#### Stop conditions

- Stream depends on process-local buffer after replay.
- Any handoff window loses or duplicates an Event.
- Disconnect cancels the Run or replay re-executes work.

#### Rollback boundary

Disable or revert canonical Events/Replay/Stream routes while retaining persisted Event data and Legacy SSE. Do not delete durable history.

#### Exit gate

P5 is complete only when durable query, replay, race-free reconnect, cursor, sequence, and no-cancel evidence is independently accepted.

#### Independent review requirements

Review Event Store truth, handoff algorithm, duplicate prevention, cursor semantics, authorization, and process-restart behavior.

#### L3 Gate requirements

Run deterministic SSE integration, concurrent handoff, process-restart, event ordering, cursor, and related regression suites. No production server/Web run.

### P6 — Legacy Mapping, Recovery and Outbox Failure Verification

#### Goal

Keep Legacy behavior usable, map it to the canonical Task-domain path, and verify browser disconnect, server restart, Outbox failure, retry, dead letters, and uncertain state.

#### P6-0 independent review classification and P6A0 boundary

The P6-0 read-only assessment previously classified the Outbox sink and restart
matrix as requiring new Owner decisions. Independent remote review returned:

```text
M3 P6-0 INDEPENDENT REVIEW:
PASS WITH CONTRACT RECLASSIFICATION

NEW OWNER DECISION:
NONE
```

M3-TD-01, M3-TD-07, M3-TD-18, the authorized P6 uncertainty scope, Runtime
Lifecycle §42, and Event Model §§48–50 already contain the governing product
and architectural choices. M3-TD-33 through M3-TD-36 therefore record a
BOUNDED TECHNICAL CONTRACT CLOSURE rather than a new product/Owner choice.
P6A0 is docs-only. P6 production implementation remains NOT AUTHORIZED until
independent remote review accepts this exact docs package.

Independent remote review of P6A0 commit
`67e06e12088c6f369763bc5241ea10cc35876da8` subsequently returned CHANGES
REQUIRED with exactly one HIGH finding and no blocker/medium/low finding.
HIGH-1 found that total Outbox claim `attempts` cannot reconstruct completed
classified failures or DeadLetter `firstFailedAt` after unknown crash/lease
outcomes. The M3-TD-35 forward remediation below freezes a durable no-schema
failure envelope and exact DeadLetter evidence mapping. It introduces no new
Owner decision and does not authorize P6A production implementation.

#### Frozen package order

```text
P6A0  technical contract closure
  ↓
P6A   Outbox reclaim / delivery / retry / dead-letter
  ↓
P6B   Task-domain restart / recovery_required / Start Operation recovery
  ↓
P6C   Legacy canonical execution / durable projection / disconnect closure
  ↓
P6D   integrated verification
```

Packages execute sequentially to avoid uncontrolled Shared/Lifecycle overlap.
After P6A0 passes independent review, the next implementation authorization may
cover P6A only. P6B, P6C, and P6D are not implicitly authorized.

#### Authorized scope

- Legacy POST execute-task mapping to Create Run then Start Run.
- Legacy status/stage/thinking/done/error projection from persisted v2 Events.
- Task-domain recovery using the P2-implemented `runs.recovery_required`; no Recovery Record is created.
- Browser disconnect subscription-only behavior.
- Outbox at-least-once retry, durable identity deduplication, dead letters, and failure fixtures.

#### Forbidden scope

- Legacy API/JSON retirement or deletion.
- Web default switch.
- Production Restore, Cutover, quiescence, or data copy.
- A second execution model bypassing the Run/Event/Outbox path.
- Guessing success when persisted evidence is incomplete.

#### Exact files/categories

- Legacy route and bridge categories under apps/server/src/routes/tasks.ts and TaskRunService.
- Task-domain recovery category and startup recovery integration.
- OutboxPublisher, RuntimeEventDeliverySink, retry, dead-letter, and failure categories.
- Legacy mapping, browser disconnect, server restart, duplicate publish, gap, and uncertain-state tests.

#### Required evidence

- Legacy endpoint remains callable and its response/frames correspond to canonical Run/Operation/Event evidence.
- No double execution path exists.
- Browser refresh/disconnect leaves Run durable.
- Restart classifies Run, Stage, Start Operation, Approval where applicable, and Runtime Event evidence together; it restores only frozen cases or records explicit uncertainty in `runs.recovery_required`.
- Outbox retry is at-least-once and duplicate-safe; dead letters retain failure evidence.
- Completed classified delivery failures, immutable first failure time, unknown lease outcomes, and terminal DeadLetter evidence are durably reconstructible without using total claim `attempts` as the failure budget.
- Legacy JSON, Legacy API, and Web default remain unchanged.

#### RED/GREEN tests

- RED: current Legacy request-bound execution aborts on close and emits direct frames rather than durable v2 projections; current Task-domain restart/outbox chain is incomplete.
- GREEN: mapping, terminal reconciliation, disconnect, restart, retry, duplicate publish, dead letter, expired-lease reclaim, Start Operation matrix, gap, and uncertainty tests pass using injected clocks/barriers and no sleep-based correctness.

#### Related regression

- Legacy Task route, taskRecovery, runRecovery, v2 Task/Run, Conversation recovery, EventBus, and stream tests remain green without aggregate unification.

#### Full-gate trigger conditions

- P4 route compatibility and P5 durable stream/replay are accepted.
- P2 recovery representation and Outbox failure contract are available.
- Independent review confirms Legacy remains usable and no second execution model exists.
- The P6A0 docs package containing M3-TD-33 through M3-TD-36 is independently accepted before any P6 production branch begins.

#### Stop conditions

- Mapping changes Legacy JSON/API or Web behavior.
- Recovery references absent schema state or infers success.
- Outbox retry duplicates state transitions.
- Production Restore or Cutover is requested.

#### Rollback boundary

Revert mapping/recovery/publisher verification code while preserving Legacy route, source JSON, and durable Event/Outbox failure evidence.

#### Exit gate

P6 is complete only when compatibility, recovery, disconnect, retry, dead-letter, and no-double-execution evidence is independently accepted. It is not a Retirement or Cutover gate.

#### Independent review requirements

Review compatibility mapping, recovery uncertainty, Outbox retry/idempotency, data safety, and production boundary.

#### L3 Gate requirements

Run fresh/legacy local DB fixtures, controlled process restart, failure injection, targeted suites, typecheck/build, and related regression. No production restore or data access.

#### M3-TD-33 — P6 Task-domain Outbox delivery sink

The frozen durable live-distribution path is:

```text
OutboxPublisher
→ RuntimeEventDeliverySink
→ RuntimeEventNotifier
```

`RuntimeEventDeliverySink` is a P6 adapter boundary, not an Event Store,
Conversation EventBus, HTTP/SSE client, or external broker. Its input is the
exact durable Outbox identity plus persisted Runtime Event identity. It emits
only `{ runId, sequence, eventId }` after validating persisted evidence; it
does not trust arbitrary caller payload.

P5 direct post-commit notifier publication remains the low-latency path. P6
publisher publication is the durable at-least-once wake-up path. Duplicate
hints are allowed and harmless because `RunStreamService` deduplicates by
`runId + sequence`. P6 does not change Event Store truth or make request/SSE
paths read Outbox rows.

`outbox.status = published` means only that the sink synchronously accepted the
exact durable message for live-distribution dispatch. It does not assert
browser/Legacy receipt, observation by future subscribers, or Run completion.
Client delivery remains Event Store + replay + Last-Event-ID. Subscriber
handler isolation remains unchanged; browser disconnect cannot trigger Outbox
retry or a Run transition.

At-least-once identities are:

```text
delivery: outbox.id
domain Event: event.id
ordering / stream dedup: runId + sequence
```

Sink success followed by crash before `markPublished` redelivers the same
Outbox/Event identities and creates no second Event or Run transition.

#### M3-TD-34 — P6 Task-domain restart and uncertainty contract

`runs.recovery_required` is the only M3 recovery representation. P6B checks
Run, Run Stage, `run.start` Operation, Approval where applicable, and Runtime
Event evidence together; Run status alone is insufficient.

| Persisted evidence | Frozen recovery direction |
| --- | --- |
| `completed`, `failed`, or `cancelled` Run | Terminal immutable; do not reopen, retry, or execute. |
| queued Run with no non-terminal Start Operation | Keep queued; do not execute, complete, or fail. |
| queued Run with exactly one queued Start Operation | `queue-restore`; future worker may reclaim authorization, but P6B does not invoke Provider/AgentRunner. |
| starting Run with running Start Operation | Reuse M3-TD-29 C1b atomic startup failure closure; do not leave starting or infer success. |
| running Run with completed Start Operation and unprovable external outcome | Keep running, set `recovery_required = 1`, and do not complete/fail/resume/restart provider. |
| waiting Run with exactly one coherent unresolved Approval | `approval-restore`; keep waiting and never auto-approve/reject. |
| waiting Run with incomplete/contradictory Approval evidence | Set `recovery_required = 1`; fail closed. |
| coherent paused state | Keep paused; do not auto-resume. |
| paused cross-aggregate inconsistency | Set `recovery_required = 1`. |
| multiple active Starts, incompatible Start status, or foreign binding | Fail closed; never synthesize completion or create a second Start. |

P6B implements the already specified `run.recovery_attempted`,
`run.recovered`, and `run.recovery_failed` events in the Shared Registry.
Queue/approval restore records attempted then recovered with the corresponding
mode. Uncertain active execution records attempted, atomically sets
`recovery_required = 1`, and records recovery failed. State/flag/Event/Outbox
remain transactionally consistent. Process/session/worktree evidence is never
fabricated.

#### M3-TD-35 — P6 Outbox reclaim, retry, and dead letter

##### HIGH-1 root cause and no-schema storage

Current `outbox_messages.attempts` increments on every
`pending/retry -> publishing` claim. A claim followed by process crash and lease
expiry consumes one attempt without completing a classified sink failure.
Therefore:

```text
attempts = total delivery claim attempts
attempts != completed classified delivery failures
```

The completed-failure budget and first classified failure time require an
independent durable representation. P6A adds no column/table/Migration 014 and
uses existing mutable `outbox_messages.last_error TEXT` as a P6-internal
versioned envelope:

```ts
interface OutboxFailureStateV1 {
  readonly schemaVersion: 1;
  readonly completedFailures: number;
  readonly firstFailedAt?: string;
  readonly lastOutcome: 'classified_failure' | 'lease_expired';
  readonly lastCode: string;
  readonly lastMessage: string;
  readonly lastObservedAt: string;
}
```

`last_error` is the canonical JSON serialization of this exact semantic state.
NULL means zero completed failures and no first failure time. The parser
validates schema version, exact fields, a non-negative safe integer count,
`firstFailedAt` iff count is positive, canonical UTC millisecond timestamps,
stable non-empty sanitized code, bounded sanitized message, and known outcome.
Stack traces, SQL, database paths, secrets, and arbitrary sink objects are
forbidden. Malformed persisted state fails closed and remains durable; P6A does
not reset, guess, discard, publish, or expose raw content.

##### Claim, classified failure, and lease-expired semantics

Claim keeps `attempts = attempts + 1`; `attempts` includes successful claims,
classified failures, and unknown crash outcomes and never directly drives
failure exhaustion.

Only a classified sink failure observed while the publisher owns a valid lease
increments `completedFailures`. The first sets `firstFailedAt = now`; later
classified failures preserve it. Every classified failure records stable final
code, sanitized message, `lastOutcome = 'classified_failure'`, and
`lastObservedAt = now`.

Expired claim recovery is the fenced transition:

```text
publishing + lease_expires_at <= now
→ retry
```

It preserves `completedFailures`, `firstFailedAt`, and `attempts`; records
`lastOutcome = 'lease_expired'`, `lastCode = 'OUTBOX_LEASE_EXPIRED'`, stable
sanitized message, and observation time; clears lease; increments version; and
sets `available_at = now`. It is neither a classified failure nor proof of
delivery, never directly dead-letters, and applies no failure backoff.

##### Retry budget and backoff

```text
MAX_COMPLETED_FAILURE_ATTEMPTS = 5
delay_ms = min(1000 * 2^(completedFailures - 1), 300000)
random jitter = none
clock = injectable
```

The first through fourth retryable classified failures schedule 1s, 2s, 4s,
and 8s. The fifth is exhausted and dead-letters. A non-retryable classified
failure dead-letters immediately. Even when `attempts > 5`, unknown lease
outcomes do not consume this completed-failure budget. Correctness tests use no
sleeps.

##### Exact DeadLetter evidence mapping

Terminal delivery failure maps to:

```text
id = deadletter:<outbox.id>
sourceType = outbox
sourceId = outbox.id
target = runtime-events
attempts = outbox.attempts
firstFailedAt = OutboxFailureStateV1.firstFailedAt
lastFailedAt = current classified terminal failure timestamp
errorCode = final classified stable code
errorMessage = final sanitized classified message
```

Payload is only safe stable identity metadata:

```ts
{
  outboxId: outbox.id,
  eventId: outbox.eventId,
  runId: outbox.aggregateId,
  topic: outbox.topic,
}
```

No stricter repository identity convention exists, so deterministic
`deadletter:<outbox.id>` is frozen without modifying `Identity.ts`. It ensures
one terminal record per Outbox message. Arbitrary caller/Event payload is not
copied and no Runtime Event is created for dead-lettering.

Dead-letter entry requires `completedFailures >= 1` and valid persisted
`firstFailedAt`; otherwise fail closed. Creation, claim, lease expiry, and
restart timestamps cannot substitute for the first classified failure.
Explicit non-retryable failure writes `retryable = false`; retryable exhaustion
writes `retryable = true`, describing underlying classification rather than
remaining automatic retries. `OUTBOX_LEASE_EXPIRED` is never a terminal
DeadLetter error.

`markDeadLetterWithinTransaction` and
`DeadLetterRepository.insertWithinTransaction` execute in one
`store.runInTransaction(...)` on the same database handle. Both commit or both
roll back; partial or duplicate terminal evidence is forbidden.

##### P6A HIGH-1 RED/GREEN evidence

```text
P6A-F01 claim increments attempts but not completedFailures
P6A-F02 first classified failure freezes firstFailedAt
P6A-F03 second classified failure preserves firstFailedAt
P6A-F04 claim crash + lease reclaim preserves completedFailures
P6A-F05 five lease crashes do not exhaust the five-failure budget
P6A-F06 completedFailures drives backoff
P6A-F07 fifth classified retryable failure dead-letters
P6A-F08 first non-retryable failure dead-letters immediately
P6A-F09 DeadLetter.firstFailedAt equals the first classified failure exactly
P6A-F10 malformed persisted failure state fails closed
P6A-F11 Outbox dead-letter mutation and DeadLetter insert roll back together
```

All tests use injected clocks and deterministic barriers, with no sleeps.

##### Publisher startup boundary

Startup order is:

```text
ownership
→ open/migrate store
→ synchronous Task-domain recovery
→ construct and validate OutboxPublisher
→ compose routes
→ HTTP listen succeeds
→ reclaim expired Outbox leases
→ start OutboxPublisher loop
```

Background delivery starts only after listen success. Ordinary sink delivery
failure follows retry/dead-letter policy and never becomes a Run failure.

#### M3-TD-36 — Legacy single execution authority

One Legacy request maps to one canonical Run, one `run.start` Operation, and
one execution authority. Future `LegacyCanonicalExecutionService` is the sole
AgentRunner owner for `legacy_pipeline`. It adapts the existing AgentRunner and
does not introduce M4 ProcessManager/ProviderAdapter or a second executor.

`tasks.ts` retains Legacy validation, canonical command initiation, persisted-
event projection subscription, heartbeat, and transport cleanup. It no longer
constructs AgentRunner, owns execution AbortController, directly drives Stages,
or directly mutates canonical terminal Run state. Canonical Run, Start
Operation, Stage lifecycle, Runtime Events, and Outbox are execution truth.

The AgentRunner text callback first persists `stream.text_delta`. Pure
`LegacyRuntimeEventAdapter` then projects persisted `RuntimeEventRecord` values
to the existing `status`, `stage`, `thinking`, `done`, and `error` frame shapes.
It owns no state machine and cannot send thinking before persistence.

Legacy disconnect performs only:

```text
unsubscribe
→ stop heartbeat
→ close Legacy transport
```

It does not abort AgentRunner, cancel Run/Operation, or kill a process. Only an
explicit Cancel command may change execution state. P6C reuses the accepted P5
RunStreamService handoff and does not switch Web or retire Legacy JSON/API.

#### Candidate P6A scope

```text
apps/server/src/store/OutboxRepository.ts
apps/server/src/services/RuntimeEventDeliverySink.ts       [new]
apps/server/src/services/OutboxPublisher.ts                [new]
apps/server/src/store/SqliteStore.ts
apps/server/src/index.ts

apps/server/src/store/m3-p2b-persistence.test.ts
apps/server/src/services/RuntimeEventDeliverySink.test.ts   [new]
apps/server/src/services/OutboxPublisher.test.ts            [new]
apps/server/src/services/m3-p6a-outbox-recovery.test.ts     [new]
```

`RuntimeEventNotifier.ts` is zero-diff unless a future RED test proves its
accepted public seam is insufficient. `DeadLetterRepository.ts` is also
zero-diff unless RED proves the existing primitive insufficient; that requires
explicit `P6A ALLOWLIST EXPANSION REQUIRED` review and cannot be edited
silently. Registry remains exactly 001–013, Migration 014 remains absent, and
P6A makes no schema change.

#### Candidate P6B scope

```text
apps/server/src/store/RunRepository.ts
apps/server/src/services/LifecycleTransactionService.ts
apps/server/src/services/TaskRunRecoveryService.ts          [new]
apps/server/src/services/OperationService.ts                 [only if required]
apps/server/src/taskRecovery.ts
apps/server/src/index.ts

packages/shared/src/types/m3-runtime.ts
packages/shared/src/types/m3-runtime-registry.ts
packages/shared/src/types/m3-runtime-fixtures.ts
packages/shared/m3-runtime.test.ts

RunRepository recovery tests
TaskRunRecoveryService tests
taskRecovery tests
```

Conversation aggregate `runRecovery.ts` is forbidden.

#### Candidate P6C scope

```text
apps/server/src/routes/tasks.ts
apps/server/src/services/TaskRunService.ts
apps/server/src/services/LifecycleTransactionService.ts
apps/server/src/services/LegacyCanonicalExecutionService.ts   [new]
apps/server/src/services/LegacyRuntimeEventAdapter.ts          [new]
apps/server/src/index.ts

packages/shared/src/types/m3-runtime.ts
packages/shared/src/types/m3-runtime-registry.ts
packages/shared/src/types/m3-runtime-fixtures.ts
packages/shared/m3-runtime.test.ts

taskPipelineBridge tests
LegacyCanonicalExecutionService tests
LegacyRuntimeEventAdapter tests
Legacy disconnect tests
```

P6C includes no M4 ProcessManager/ProviderAdapter and no Web switch.

#### Candidate P6D scope

```text
apps/server/src/services/m3-p6-integrated-verification.test.ts [new]
docs/implementation/milestones/M3-p6-integrated-closeout.md    [new]
docs/implementation/milestones/M3-lifecycle-event-api-implementation-plan.md
```

P6D contains no production code unless a separately reviewed remediation is
authorized.

#### P6 production entry after P6A0

P6 production entry remains NO-GO until independent remote review verifies the
P6A0 docs package. A passing P6A0 review may authorize P6A only. It does not
authorize P6B, P6C, P6D, Migration 014, Production Cutover, Legacy retirement,
or a Web default switch.

### P7 — Consolidated Formal Gate, Draft PR, Ordinary Merge and Closeout

#### Goal

Assemble the complete M3 Foundation evidence package, obtain final independent P0/P7 review, and use Draft PR plus ordinary merge only for a future authorized implementation change.

#### Authorized scope

- Contract-to-evidence matrix for P0–P6.
- Full M3 test, schema, API, OpenAPI, recovery, and L3 evidence.
- Independent review findings and remediation.
- Future docs-only Draft PR, ordinary Merge Commit, origin/main update, ff-only local main sync, and factual closeout.

#### Forbidden scope

- Production Cutover, Restore, observation, cohort rollout, or Legacy Retirement.
- Web global default switch.
- Legacy API/JSON deletion.
- Claiming any phase passed without exact evidence.
- Creating the current remediation PR.

#### Exact files/categories

- Future implementation commits and tests only after P0–P6 authorization.
- Draft PR/review/merge/closeout artifacts for the future branch.
- No production migration or deployment artifacts in this docs remediation.

#### Required evidence

- Every Roadmap Scope, Deliverable, Compatibility, Test, and Exit invariant maps to exact code/test evidence.
- P0 merge gate has occurred before P1 branch creation.
- Full related regression, schema/checksum, OpenAPI, SSE, recovery, and L3 output is recorded.
- Branch, parent, merge, remote-check, and production status are factual.
- M3 Foundation closeout explicitly leaves Cutover, Restore, Retirement, and Web switch unauthorized.

#### RED/GREEN tests

- RED: missing deliverable, unsupported completion claim, unresolved independent-review blocker, regression failure, or unauthorized scope blocks closeout.
- GREEN: the complete M3 Foundation acceptance matrix passes with exact outputs and final independent review, while production gates remain not authorized.

#### Related regression

- M2 retained contracts, migrations 001–011, Legacy route usability, Web Legacy default, Task/Conversation separation, and all P1–P6 suites.

#### Full-gate trigger conditions

- P0 through P6 exit gates are accepted.
- Final independent P0/P7 review signs the technical contract and implementation evidence.
- A future Draft PR has required reviewers and no unresolved blocking comments.
- Ordinary Merge Commit is separately authorized and local main is synchronized ff-only afterward.

#### Stop conditions

- Remote Checks are unavailable and no accepted substitute exists.
- Evidence is inferred from docs rather than command output.
- Review finds Cutover, deletion, Restore, default switch, M4, or aggregate-unification scope.
- Any phase is represented as passed without its exit evidence.

#### Rollback boundary

Rollback is limited to the future implementation branch/merge boundary. Production rollback, downgrade, Restore, and deletion remain post-M3 Owner decisions.

#### Exit gate

M3 Lifecycle, Event and API Foundation may be proposed for ordinary merge only after formal review. Production Cutover remains NOT AUTHORIZED, Legacy Retirement remains later work, and M3 P1 is not authorized by this plan.

#### Independent review requirements

Independent technical, schema/API, security/privacy where applicable, and L3 review are required. Owner Approval is required for irreversible schema/data, production, external-cost, or material UX actions.

#### L3 Gate requirements

Provide exact commands, outputs, commit SHAs, changed-file scope, schema/checksum evidence, API/OpenAPI evidence, test evidence, and explicit Remote Checks status. Never relabel unavailable evidence as passed.

## 5. Migration 012 final Planning Scope

Migration 012 REQUIRED — PLANNING ONLY. No DDL is created in this remediation.

The future planning package must cover:

1. Task-domain runtime_events.
2. UNIQUE(run_id, sequence) and query indexes, including runtime_events(run_id, correlation_id, sequence).
3. outbox_messages.
4. Independent dead_letters or a reviewed equivalent.
5. Durable operations with operations.run_id or equivalent aggregate reference, operations.correlation_id, and immutable unique correlation_id.
6. run_stages rebuild/extension from pending-only to M3 lifecycle, including failure_code/failure_message and started_at/completed_at while preserving the existing version column for optimistic version-checked updates; no duplicate version column.
7. idempotency_records.operation values run.start, run.retry, and finally approved M3 commands.
8. Recovery representation: `runs.recovery_required`, selected and implemented before P6; no separate Recovery Record.
9. Task-domain sequence allocation through runs.next_event_sequence.
10. Event append-only and Outbox immutable/concurrency constraints, with immutable identity/payload fields and controlled delivery-field updates.
11. Operation lifecycle, result, ApiProblem, aggregate reference, workspaceId, aggregateType=run, aggregateId/runId, timestamps, and version fields.
12. Queue decision: runs(status=queued) is the M3 persistent Queue Record; do not add scheduler_jobs unless later evidence proves it necessary.

SQLite table rebuild risk requires separate DDL review, checksum review, fresh/legacy DB fixtures, rollback/forward-compatibility, and L3 validation. None of that authorizes production migration.

## 6. M3 exit boundary

The M3 exit proposal must state:

- Browser Refresh does not cancel Run.
- Client disconnect ends only the subscription.
- Per-Run Event sequence is strictly increasing.
- State, Runtime Event, and Outbox are transactional.
- Error codes are stable.
- Start Run is asynchronous with Operation.
- Retry creates a new Child Run.
- Legacy route and behavior remain usable.
- Current v2 compatibility remains available.
- Canonical Task Collection replacement is deferred.
- Web global default remains unchanged.
- Legacy API and Legacy JSON are not deleted.
- runs and agent_runs remain separate.
- Production Cutover, Restore, observation, and Legacy Retirement are not M3 exit claims.

Current status:

- P2A: COMPLETE.
- P2B: COMPLETE.
- P2C-0: COMPLETE.
- P2C-1: COMPLETE.
- P2C-2: COMPLETE / ACCEPTED.
- P2 overall: COMPLETE / ACCEPTED.
- P3: COMPLETE / MERGED.
- P4: COMPLETE / ACCEPTED.
- P5: COMPLETE / ACCEPTED through P5C at
  `a1cbb2868f9da215fab058b4176d70a3b382831d`.
- P6-0 independent review: PASS WITH CONTRACT RECLASSIFICATION.
- P6A0 independent remote review of commit
  `67e06e12088c6f369763bc5241ea10cc35876da8`: CHANGES REQUIRED — HIGH-1.
- P6A0 HIGH-1 durable failure evidence remediation: DOCUMENTED; awaiting
  independent remote re-review before any P6 production authorization.
- P6A: ACCEPTED. P6A implementation baseline `4efef838` with remediation
  `a0b6460e`; Outbox reclaim/retry/dead-letter evidence accepted.
- P6B: ACCEPTED at
  `ff9a375f681d96fd91d07f3f237529adb46a12c8`; v2 task-domain recovery
  semantics accepted.
- P6C: ACCEPTED at
  `2151ed57e774cd585337709f09169ded3d3e3304`; P6C HIGH-1 independent remote
  re-review PASS; Legacy canonical restart recovery accepted.
- P6D: INTEGRATED VERIFICATION COMPLETE. New consolidated suite
  `apps/server/src/services/m3-p6-integrated-verification.test.ts` passes
  23/23; P6A/P6B/P6C/P5/Lifecycle/Shared/full-server regressions green;
  closeout evidence in
  `docs/implementation/milestones/M3-p6-integrated-closeout.md`.
- P6D MEDIUM-1 real reconnect cursor evidence remediation at
  `35cb9d6afcde7c86457388fe99fb1c94cc7dbd7b`; independent remote re-review
  PASS.
- New P6 user Owner Decision: NONE.
- P6: COMPLETE / ACCEPTED / CLOSED.
- P7: COMPLETE.
- PR #40: MERGED (ordinary merge commit
  `312485568cb3f11437e11c301d91d4a80e6c62b9`, base `95e03ace...`, head
  `35cb9d6afcde7c86457388fe99fb1c94cc7dbd7b`).
- Accepted P6D: `35cb9d6afcde7c86457388fe99fb1c94cc7dbd7b`.
- M3 IMPLEMENTATION: MERGED INTO MAIN.
- M3: FOUNDATION COMPLETE.
- M3 FINAL CLOSEOUT PACKAGE: ACCEPTED / MERGED via PR #41 at
  `77add6a0dc1a860d9d054b0bc146b231c9cccb88`.
- Migration 014: NOT REQUIRED BY M3 / NOT CREATED / M4 CREATION NOT AUTHORIZED.
- Historical repository CI baseline: MERGED via PR #42 at
  `859d8c73657741c03a3241402a9ab4c2e2f173ce`.
- Historical post-PR #42 main CI: PASS (run `31513943821`); superseded as the
  current-main baseline by PR #44.
- Current authoritative main before PR #43: PR #44 R39 remediation merge at
  `e17a4bffdf12a033a0587ec2431cefe51a97bc49`.
- Current post-PR #44 main CI: PASS (run `31565915572`).
- M3 formal closeout: COMPLETE upon PR #43 merge; the resulting merge commit
  becomes authoritative and requires its own post-merge main CI.
- Production Cutover: NOT AUTHORIZED / NOT STARTED.
- Legacy Retirement: NOT PERFORMED.
- Web default switch: NOT PERFORMED.
- M4 Entry: PENDING SEPARATE ENTRY DECISION.
- M4 preplanning: NOT AUTHORIZED BY THIS CLOSEOUT.
- M4 production implementation: NOT AUTHORIZED.

This final closeout update records the accepted P6A/P6B/P6C/P6D state, the
completed P6 integrated verification, the completed P7 gate, the merged PR #40
implementation, the merged PR #41 closeout package, and the historical passing
PR #42 repository CI baseline. Formal closeout becomes complete only when PR #43
merges. It does not claim Production readiness, Production Cutover, Legacy
Retirement, a Web default switch, M4 preplanning, or M4 production implementation.

Supersedes, for current-status purposes only: the earlier P6A0/P6D-era
statements that P6 production implementation was not authorized, that
P6A/P6B/P6C/P6D were not entered, that P6 was awaiting independent integrated
remote review, and that P7/Draft PR were not entered/created. Those statements
remain intact as historical evidence of the sequential authorization state at
the time they were written. The accepted P6A (`4efef838` + `a0b6460e`), P6B
(`ff9a375f681d96fd91d07f3f237529adb46a12c8`), P6C
(`2151ed57e774cd585337709f09169ded3d3e3304`), P6D
(`35cb9d6afcde7c86457388fe99fb1c94cc7dbd7b`), PR #40 merge
(`312485568cb3f11437e11c301d91d4a80e6c62b9`), and the merged M3 implementation
are the current verified state.
