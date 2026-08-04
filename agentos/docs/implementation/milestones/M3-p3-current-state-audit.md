# M3 P3 Current-State Audit

Status: PREPLANNING ONLY — P3 IMPLEMENTATION NOT AUTHORIZED — P3A IMPLEMENTATION NOT AUTHORIZED — PREPLANNING PR #21 MERGED — REMOTE CHECKS UNAVAILABLE — NOT PASS — PRODUCTION CUTOVER NOT AUTHORIZED / NOT STARTED

This document is a read-only audit of the post-P2 codebase against the M3 P3
scope (Run Engine, Workflow Executor and Operation) defined in
`docs/implementation/milestones/M3-lifecycle-event-api-implementation-plan.md`.
It records what exists, what is missing, and where each gap belongs. It does
not authorize, start, or design any production implementation beyond the
planning level, and it does not change any code, test, migration, or registry
file.

Remediation 1 (Execution Authorization and Transaction Composition) updates
items 3.1/3.4, expands the Gap Matrix from 19 to 20 items, tightens section
5 wording, expands the Owner Decision candidates from 4 to 5, and reflects
the P3B-1/P3B-2 review-boundary split in the stage preview.

Remediation 2 (Operation Idempotency and Seam Ownership) corrects item 3.9,
re-scopes Gap Matrix item 15, splits P3C into P3C-0/P3C-1 across the matrix
and the stage preview, and extends OD-P3-05. Audit item statuses and counts
are unchanged.

Remediation 3 (Retry Idempotency Ownership and Start Operation Completion
Gate) splits P3C-0 into P3C-0A/P3C-0B, extends OD-P3-04, and splits failure
class C into C1a (before claim commit), C1b (after claim and before
`run.started`), and C2. Audit item statuses and counts remain unchanged.

Owner Decision Freeze (2026-08-04): the five P3 Owner Decision candidates
OD-P3-01 through OD-P3-05 are resolved as approved technical directions
M3-TD-26 through M3-TD-30 in
`docs/implementation/milestones/M3-owner-decisions.md`. Section 6 is now a
resolved-decision record; unresolved candidates: 0; approved P3 decisions:
5. Audit item statuses and counts remain unchanged. This approval is
APPROVED TECHNICAL DIRECTION — IMPLEMENTATION STILL NOT AUTHORIZED. P3 and
P3A implementation remain NOT AUTHORIZED.

## 1. Baseline

- Audited baseline (main / origin/main): `3728d670ce0f5c16d07819e65cddbc0bb4c6c5b2`
- P2 implementation merge (PR #19): `7a6c41710af5d4c58ef9acd6a9484b9deb341c6b`
- P2 implementation source head: `14b722614c947c920915dccc5807e7469e604096`
- Pre-P2 main: `417f5f9c329d32cf75d0ea5a7d797fdb355d3593`
- PR state at audit time: PR #19 MERGED, PR #20 (P2 post-merge closeout) MERGED.
- Migration registry: exactly 001–013 in
  `apps/server/src/migrations/default-registry.ts`; no Migration 014 exists and
  none is proposed by this audit.
- Governing documents:
  - `docs/implementation/milestones/M3-owner-decisions.md` (M3-TD-01 through M3-TD-30)
  - `docs/implementation/milestones/M3-lifecycle-event-api-implementation-plan.md` (P0–P7; P3 authorized scope)
  - `docs/implementation/milestones/M3-p2-post-merge-closeout.md`
  - Runtime Specifications 02, 03, 10, 11, 14 under `docs/Runtime-Specification/`

## 2. Method

Read-only inspection of the baseline tree: schema migrations, services,
repositories, routes, shared contracts, and existing tests. No file was
created, modified, or deleted in production or test code. No database was
migrated. No test suite was executed for this audit; test evidence cited
below refers to test files as they exist at the baseline.

## 3. Current-State Audit (15 items)

Statuses: IMPLEMENTED (exists and matches the P3 contract), PARTIAL (some
foundation exists, a defined remainder is missing), MISSING (nothing exists),
CONTRACT ONLY (type/spec exists with no runtime), OUT OF SCOPE (belongs to M4+
or excluded scope).

### 3.1 Queue Record — IMPLEMENTED

The persistent Queue Record is `runs(status='queued')`. The `runs` table
carries the full M3 status vocabulary, a `version` column for optimistic
concurrency, and `recovery_required` (added by Migration 012,
`apps/server/src/migrations/migrations/012-m3-runtime-schema.ts`).
`RunRepository.insert` in `apps/server/src/store/RunRepository.ts` persists
queued runs inside the creation transaction. Queue ownership (claim/dequeue)
is a separate concern and is audited as item 3.4.

Note (Remediation 1): `queued` is necessary but not sufficient for Engine
execution. The execution-authorization eligibility rule is recorded in item
3.4 and Gap Matrix item 20: a queued Run requires exactly one valid,
non-terminal queued authorization Operation of type `run.start` or
`run.retry`.

### 3.2 P2 Transaction Core — IMPLEMENTED

`apps/server/src/services/LifecycleTransactionService.ts` exposes the
complete transition surface required by P3:

- `createRunGraphEventsWithinTransaction` (line 361)
- `transitionRun` (line 413)
- `transitionStage` (line 468)
- `completeRunStartup` (line 527)
- `requestApproval` (line 598)
- `resolveApprovalToRunning` (line 660), `resolveApprovalToFailure` (line 721), `resolveApprovalToCancellation` (line 830)
- `cancelRun` (line 930), `cancelRunWithinTransaction` (line 942)
- `completeRun` (line 1021)

Every transition writes state, runtime event, and outbox row in one SQLite
transaction; `correlationId` is supplied by the caller, which is the hook
point P3 Operations attach to. Optimistic concurrency is enforced by
conditional `UPDATE ... WHERE status = expectedFrom AND version =
expectedVersion` in
`RunRepository.transitionLifecycleWithinTransaction`.

### 3.3 Run Engine — MISSING

No `RunEngine` class, service, or module exists anywhere under `apps/` or
`packages/`. There is no component that owns, claims, or advances queued
runs.

### 3.4 Scheduler / Claim Ownership — MISSING

No scheduler, claim, or dequeue mechanism exists. The `scheduler_jobs` table
is explicitly asserted absent by
`apps/server/src/migrations/__tests__/m3-p2a-migration-012.test.ts`
(lines 561, 576). Per the P3 authorized scope, scheduler ownership must be
implemented over `runs(status='queued')` without introducing a scheduler
table.

Finding 1 (Remediation 1) — Execution authorization / Engine eligibility gap:

**A Run being queued is necessary but not sufficient for Engine execution.**

- Run creation persists `status='queued'` immediately
  (`RunRepository.insert`, `apps/server/src/store/RunRepository.ts`,
  line 169).
- `RunRepository.listByWorkspace(workspaceId, { status: 'queued' })`
  (line 368) can enumerate every queued run in a workspace.
- No claim selector currently distinguishes a run that was only created
  from a run that has received an execution authorization command.
- Scanning queued runs alone would therefore execute created-but-never-
  started runs and break the frozen `Create Run != Start Run` contract.

Engine eligibility must additionally require exactly one queued,
binding-valid authorization Operation associated with the run, whose type is
`run.start` or `run.retry`. Zero eligible authorization Operations is a tick
no-op; multiple or coexisting valid authorizations fail closed. The frozen
rule set is Gap Matrix item 20. `run.create` and `run.cancel` never
authorize execution, and workspace/run/aggregate/correlation bindings must
all agree.

### 3.5 Workflow Executor — MISSING

No `WorkflowExecutor` exists. Workflow definitions (V1/V2, including
`dependsOn` stage graphs from Migration 013) are stored and resolvable via
`apps/server/src/services/WorkflowDefinitionResolver.ts`, and run snapshots
capture the resolved graph, but nothing executes stages from a snapshot.

### 3.6 Stage Executor — MISSING

No `StageExecutor` exists. `transitionStage` in the P2 transaction core can
persist stage transitions, but no component decides which stage starts next,
drives `pending -> running -> completed/failed`, or marks stages `skipped`.

### 3.7 Operation Persistence — PARTIAL

Schema: complete. Migration 012 creates `operations` with:

- `type` restricted to exactly `run.create`, `run.start`, `run.cancel`, `run.retry`
- `status` restricted to exactly the 7 M3 operation statuses (`queued`, `running`, `waiting_approval`, `paused`, `completed`, `failed`, `cancelled`)
- `workspace_id`, `aggregate_type = 'run'`, `CHECK (aggregate_id = run_id)`
- `correlation_id UNIQUE`
- `result_json`, `error_json`, `version >= 1`, timestamps
- identity-immutable trigger and index `(run_id, correlation_id)`

Runtime: missing. No `OperationRepository` or `OperationService` exists; the
`operations` table has no writer or reader in server code. The shared
contract `ApiOperation` in `packages/shared/src/types/m3-runtime.ts`
(line 271) is CONTRACT ONLY at the API layer — no route serves it.

### 3.8 Asynchronous Start Route (HTTP 202 + Operation) — MISSING

No start endpoint exists. v2 run routes
(`apps/server/src/routes/v2Runs.ts`) expose only `GET /runs/:runId` and
`POST /runs/:runId/cancel`; v2 task routes
(`apps/server/src/routes/v2Tasks.ts`) cover task CRUD, run creation, and
accept/cancel/reopen. Nothing returns HTTP 202 with an Operation resource.

### 3.9 Start Idempotency — PARTIAL

Database contract ready; TypeScript idempotency contract and Operation
replay envelope missing.

SQL schema (verified against Migrations 010/012):

- `idempotency_records.operation` CHECK accepts `run.start` and `run.retry`
  (Migration 012, line 62).
- `http_status` is constrained to `BETWEEN 200 AND 299` (Migration 010,
  line 52; carried forward by Migration 012, line 71), so HTTP 202 needs no
  schema change; no Migration 014 is required.

TypeScript contract (verified against
`apps/server/src/idempotency/types.ts`,
`apps/server/src/services/IdempotencyService.ts`, and
`apps/server/src/store/IdempotencyRepository.ts`):

- `IDEMPOTENCY_OPERATIONS` contains exactly `task.create`, `run.create`,
  `run.cancel`, `task.accept`, `task.cancel`, `task.reopen`; it does not
  include `run.start` or `run.retry` (types.ts, line 11).
- `IdempotencyResultEnvelopeV1` is only `TaskResultEnvelopeV1 |
  RunResultEnvelopeV1`; it carries Task/Run DTOs and no Operation snapshot
  (types.ts, line 95).
- `IdempotencyRecord.httpStatus` is typed `200 | 201` (types.ts,
  lines 106/117); `IdempotencyService.storeSuccess()` rejects any status
  other than 200/201 (IdempotencyService.ts, line 103);
  `IdempotencyRepository.OPERATION_HTTP_STATUS` is a fixed map of the six
  legacy operations (IdempotencyRepository.ts, lines 14–20).
- The replay parser `parseIdempotencyResultEnvelopeV1` is exact-shape for
  Task/Run envelopes and cannot parse `{ operation: ApiOperation }`
  (types.ts, line 341).

The only wired consumers remain the six legacy operations in
`apps/server/src/services/TaskRunService.ts`. An earlier draft of this item
claimed the service accepted arbitrary operation names at the TypeScript
layer; that was inaccurate and is corrected here.

### 3.10 Cancel/Complete Race Guard — PARTIAL

`cancelRunWithinTransaction` and `completeRun` exist and are atomic per
transition, and optimistic version checks make a losing concurrent writer
fail rather than corrupt state. What is missing is the Operation-facing race
contract: an Operation observing cancel-vs-complete must resolve to exactly
one terminal outcome with evidence. That mapping does not exist because
Operations do not exist yet (item 3.7).

### 3.11 Retry Lineage — PARTIAL

Schema and repository support exist: `RunRepository.insert` computes
`root_run_id` lineage (initial/manual runs are their own root; retry and
other child runs inherit `parent.root_run_id`, raising
`ParentRunNotFoundError` when the parent is absent). What is missing is any
caller that creates a retry child run: no retry route, no retry service
method, and no `run.retry` operation consumer.

### 3.12 Canonical Top-Level Run/Operation Routes — MISSING

No `/api/operations/:operationId`, `/api/operations/:operationId/events`, or
`/api/operations/:operationId/cancel` routes exist. No canonical top-level
run lifecycle route exists outside the v2 workspace collections. The P3
scope requires these as additive routes without replacing Legacy or current
v2 collections.

### 3.13 v2 + Legacy Compatibility — IMPLEMENTED

v2 routes are mounted additively at `/api/workspaces/:workspaceId/v2`
(`apps/server/src/index.ts`, lines 184–185). Legacy paths continue through
the state-only `transitionStatus` bridge in `TaskRunService`
(`startRunForBridge`), intentionally separate from the M3 event-sourced path.
M3-TD decisions keep Legacy behavior frozen; P3 must not regress it.

### 3.14 correlationId Association — PARTIAL

The mechanism exists end to end: every P2 transition accepts a caller
`correlationId`; `runtime_events` has a `(run_id, correlation_id, sequence)`
index; `operations.correlation_id` is UNIQUE. The generation rule is now
frozen by M3-TD-26: for every newly created non-create Operation,
`correlationId = operation.id`, generated and persisted in the same
creation transaction; the historical `run.create` rule
(`correlationId = run.id`) is preserved without migrating old records. What
remains missing is the implementation (the Operation writer does not exist
yet; see item 3.7).

### 3.15 Tests, Fixtures and Failure Injection — PARTIAL

Present: 21 frozen M3 runtime event types in
`packages/shared/src/types/m3-runtime.ts` (`M3_RUNTIME_EVENT_TYPES`, line 64;
no `run.cancellation_requested`, no `run.recovery_*`); shared fixtures
including `operationCorrelationEvent`; the failure-injection harness pattern
(`eventCalls === failurePosition` throw) proven by the P2C-2B transaction
tests; migration-level integrity and append-only trigger tests. Missing:
Operation lifecycle tests, Run Engine/executor tests, async Start tests,
duplicate-Start tests, cancel/complete race tests at the Operation level, and
retry lineage tests.

### Summary counts

- IMPLEMENTED: 3 (items 3.1, 3.2, 3.13)
- PARTIAL: 6 (items 3.7, 3.9, 3.10, 3.11, 3.14, 3.15)
- MISSING: 6 (items 3.3, 3.4, 3.5, 3.6, 3.8, 3.12)
- CONTRACT ONLY: 0 (the `ApiOperation` contract is counted inside item 3.7)
- OUT OF SCOPE: 0

## 4. Gap Matrix (20 items)

Each row: current evidence, required target, proposed implementation
category, dependency, test evidence, stop condition, and rollback boundary.
Categories reference the stage split proposed in
`docs/implementation/milestones/M3-p3-implementation-plan.md`
(P3A, P3B-1, P3B-2, P3C-0A, P3C-0B, P3C-1, P3D, P3E). Nothing here is
authorized work.

| # | Gap | Current evidence | Required target | Category | Depends on | Test evidence | Stop condition | Rollback boundary |
|---|-----|------------------|-----------------|----------|------------|---------------|----------------|-------------------|
| 1 | Persistent queue ownership | `runs(status='queued')` exists; no owner | Exactly one component (Run Engine) may claim queued runs, and only execution-authorized ones (item 20); queued alone never suffices. An execution-authorized Run has exactly one valid, non-terminal queued authorization Operation of type `run.start` or `run.retry`, with all bindings consistent | P3B-1 | P3A, #20 | Ownership unit test: only the engine mutates claimed runs; a tick without an eligible authorization Operation is a no-op; multiple/coexisting authorizations fail closed | Any second writer to queued runs appears; the engine claims a run with no eligible authorization Operation, with inconsistent binding, or with more than one valid authorization | Revert engine as one package; queue rows untouched |
| 2 | Run claim/dequeue | No claim path | Atomic claim in one caller-owned outer transaction: re-read queued Run and exactly one queued authorization Operation (`run.start` or `run.retry`), validate workspace/run/aggregate/correlation binding, conditional Operation `queued -> running`, Run `queued -> starting` via `LifecycleTransactionService`, `run.dequeued` with the Operation correlationId, Outbox row; commit all or roll back all | P3B-1 | #1, #6, #20 | Two competing claims, exactly one succeeds; zero eligible authorization is a no-op; duplicate/coexisting authorization fails closed; the loser leaves zero partial Operation/Run/Event/Outbox writes | Claim requires a new table, two independent transactions, or nested transactions, or bypasses the transaction core; selector is restricted to one authorization type | Revert claim path; no data reset |
| 3 | Run Engine | Absent (3.3) | Tick-driven engine advancing execution-authorized claimed runs via `LifecycleTransactionService` only; explicit test-controlled ticks, no background timer, server startup loop, or auto-scan | P3B-1 | #2 | Engine unit tests with an injected transaction core; no-timer/no-loop proof; no-eligible-authorization no-op proof | Engine calls repositories directly, bypasses events/outbox, selects an arbitrary authorization, or a background loop or wall-clock timer is requested | Revert engine package |
| 4 | Deterministic Workflow Executor | Absent (3.5) | Executor reading the run snapshot V2 stage graph (`dependsOn`) deterministically; mock stage runner, no provider runtime | P3B-2 | P3B-1 independent review | Snapshot-graph traversal tests; deterministic ordering proof | Executor needs ProcessManager/ProviderAdapter/CLI | Revert executor package |
| 5 | Stage orchestration | Absent (3.6) | Stage lifecycle driven through `transitionStage`; `skipped` propagation on failure/cancel per spec | P3B-2 | #4 | Stage transition and skip-propagation tests | Stage writes bypass Event/Outbox | Revert orchestration; stage rows preserved |
| 6 | Operation persistence/lifecycle | Schema complete; repo/service absent (3.7) | `OperationRepository` + `OperationService` writing/reading `operations` with version optimistic locking | P3A | P2 core | Repository CRUD, identity-immutability trigger, version conflict tests | Operation status vocabulary diverges from the frozen 7 | Revert repo/service; table and rows preserved |
| 7 | HTTP 202 Start | Absent (3.8) | Start route returns 202 + Operation; the A1 acceptance transaction atomically commits the queued `run.start` Operation and the idempotency success/replay response using the P3C-0A `run.start` + 202 + immutable Operation replay envelope; the Run stays queued and gains execution eligibility only after that commit; the acceptance transaction never starts the Run and never writes `run.dequeued` | P3C-1 | #6, #15, #20, P3B-1, P3C-0A | Route contract test: 202 shape, Operation body; A1 failure leaves no Operation, no idempotency success, Run stays queued | Synchronous start execution in the route handler; acceptance transaction writes lifecycle events | Revert route; runs/operations untouched |
| 8 | Duplicate Start | `run.start` idempotency schema-accepted, no consumer (3.9) | Same idempotency key replays the original Operation; different key on an already-started run is rejected per contract; multiple non-terminal `run.start` Operations for the same run fail closed with no arbitrary choice | P3C-1 | #7 | Same-key replay test; different-key rejection test; duplicate-active-Operation fail-closed test | Duplicate start mutates the run twice; an arbitrary Operation is selected | Revert start idempotency wiring |
| 9 | Start failure rollback | Failure-injection harness exists (3.15) | Distinct transaction classes: A1 Start acceptance leaves no Operation or Idempotency Success and the existing Run stays queued; A2 Retry acceptance leaves no Child Run, Snapshot, Stage, Creation Event, Outbox, Retry Operation, or Idempotency Success and leaves the Parent unchanged; B claim-attempt failure rolls back Operation/Run/Event/Outbox, leaves Run/Operation queued, and does not automatically mark the Operation failed; C1a covers failure before claim commit with full Class B rollback; C1b covers accepted-and-claimed `Operation=running` + `Run=starting` before the atomic `run.started` completion commits, atomically failing Stage/Run/Operation with complete failure Events/Outbox or, before Stage `starting`, failing Run/Operation without fabricating `stage.failed`; C2 per M3-TD-29 never rewrites a completed Start/Retry Operation | P3C-1 | #7, P3B-1, M3-TD-29 | Injection at every A1/A2/B/C1b Stage/Run/Event/Outbox/Operation position; C1a no-auto-failed proof; C1b Stage-starting and pre-Stage-starting proofs; failure-vs-cancel race; C2 tests prove later Run failure/cancellation/completion never rewrites the completed Operation; post-failure integrity checks | Any partial lifecycle commit; transaction rollback misclassified as business failure; automatic failed marking after claim-attempt rollback; split Run/Operation failure closure; fabricated Stage Event; post-start rewrite | Revert start path; preserve durable evidence, no data reset |
| 10 | Cancel/complete race | Atomic transitions + version guard exist (3.10) | Operation-level race resolves to exactly one terminal state with evidence; startup failure vs cancel also has exactly one caller-owned winner | P3C-1 | #6 | Concurrent cancel vs complete and startup-failure-vs-cancel tests; loser fails cleanly; no partial Stage/Run/Operation/Event/Outbox writes | Race produces two terminal events, silent overwrite, or a split startup-failure closure | Revert race handling; events preserved |
| 11 | Retry child Run | Lineage computation exists; no caller (3.11) | Per M3-TD-30: Retry is accepted only when the Parent Run is `failed` at the expected version; all other Parent statuses return stable 409 `RUN_NOT_RETRYABLE`; a valid request creates a child run (new id, correct parentRunId/rootRunId lineage), never resets or modifies the Parent, and the A2 acceptance transaction atomically creates the child graph, Snapshot, queued `run.retry` Operation (aggregateId = runId = childRun.id, correlationId = operation.id), idempotency record, and creation Event/Outbox. Creation Events use `correlationId = childRun.id`; execution Events after `run.dequeued` use `operation.id`; the child is immediately execution-authorized — no separate Start command; the `run.retry` idempotency closure is owned by P3C-0B | P3C-1 | #6, M3-TD-30, P3C-0B | A2 injection at Child/Snapshot/Stage/Creation Event/Outbox/Retry Operation/Idempotency Success leaves no Child Run, Snapshot, Stage, creation Event, Outbox, Retry Operation, or Idempotency Success and leaves the Parent unchanged; valid failed Parent creates one child; stale/non-failed Parent has zero side effects | Retry mutates or resets the Parent; accepts a non-failed Parent; creation Event uses operation.id; execution Event after `run.dequeued` uses childRun.id; a combined Child Run + Operation envelope; P3C-1 modifies idempotency core files | Revert retry path |
| 12 | Operation events query | `runtime_events` index `(run_id, correlation_id, sequence)` exists | `GET /api/operations/:operationId/events` authorizes the Operation, then reads Events by runId + correlationId ascending sequence; for `run.retry`, the result does not include Child Run creation Events and begins with Retry-Operation-correlated Events such as `run.dequeued`; no `operation_events` store | P3D | #6 | Query test: ordering, authorization failure, empty set, and Retry creation-Event exclusion | An `operation_events` table or store appears; the query includes Child Run creation Events for `run.retry` | Revert route |
| 13 | Operation cancel | `cancelRunWithinTransaction` exists; no operation binding | Per M3-TD-27: `POST /api/operations/:operationId/cancel` directly operates on the target non-terminal Operation (statuses `queued`/`running`/`waiting_approval`/`paused`) and its bound Task-domain Run in one caller-owned transaction through the P2 core; it has no Class A and creates/accepts no second Cancel Operation; already-`cancelled` returns the current Operation with zero new side effects; `completed`/`failed` returns 409-class `OPERATION_NOT_CANCELLABLE`; incompatible Run state fails closed; any failure rolls back target Operation, Run/Stage, Event, and Outbox changes to their transaction-before state and never uses C1 to record another Operation. No second cancel Operation exists | P3D | #10, M3-TD-27 | Cancel route tests include the terminal-behavior matrix, cancel-vs-complete and startup-failure-vs-cancel races, no-second-Operation proof, and failure injection with no partial Event/Outbox writes | A second Cancel Operation; an Operation-row-only cancel; a Class A or C1 failure record for cancel; bypassing the transaction core; split rollback | Revert route |
| 14 | Task reconciliation | Tasks hold active run linkage via accept/cancel/reopen | Engine/executor outcomes reconcile task active-slot state through existing v2 paths | P3C-1 | #5 | Task slot reconciliation test on run terminal states | Reconciliation bypasses existing task invariants | Revert reconciliation |
| 15 | Idempotency coverage | 6 consumers wired; the DB accepts `run.start`/`run.retry` and 200–299, but the TypeScript contract (6-operation list, 200/201-only statuses, Task/Run-only envelope, exact-shape parser) cannot store or replay an Operation command response (3.9) | Backward-compatible schemaVersion 1 extension with no DB change and no result schema version 2, split into two review boundaries: P3C-0A — `run.start` TypeScript operation registration, 202 HTTP status support, immutable Operation replay snapshot DTO and envelope variant, canonical JSON/hash/parser support over the full envelope, exact original HTTP status replay, Operation envelope corruption rejection, legacy 6 operations keep their exact status and envelope behavior; P3C-0B — `run.retry` registration per M3-TD-30: HTTP status fixed at 202, the Operation-only immutable replay envelope (no combined Child Run + Operation envelope), same-key replay of the original status and acceptance-time snapshot | P3C-0A (start), P3C-0B (retry closure) | P3A; P3C-0B additionally M3-TD-30 | 12 required tests for P3C-0A: `run.start` 202 Operation envelope round-trip; repository persists and returns the original 202; replay returns the original Operation snapshot; later Operation state changes do not affect the saved replay; canonical JSON/hash stable; tampered result JSON/hash rejected; wrong operation/envelope pair rejected; wrong operation/http-status pair rejected; legacy 6 statuses unchanged; legacy Task/Run envelopes still parse; unknown envelope variant fails closed; repository/service join a caller-owned transaction. P3C-0B mirrors these for `run.retry` per the M3-TD-30 shape | A route, Operation creation, or run start is added; the DB is changed; replay re-reads the current Operation or Child Run; a legacy envelope or status changes; the retry envelope deviates from M3-TD-30 | Revert the idempotency extension; stored rows preserved |
| 16 | `recovery_required` interaction | Column and setting paths exist from P2 | P3 transitions leave the flag semantics unchanged; startup recovery continues to own it | P3B-1/P3C-1 | P2 core | Regression: flag set/clear paths unchanged | P3 code writes the flag directly | Revert offending path |
| 17 | Legacy/v2 compatibility | Both paths green at baseline (3.13) | All P3 additions are additive; Legacy bridge and v2 collections keep passing | All stages | None (standing constraint) | Full server suite green each stage | Any Legacy/v2 regression | Revert the offending stage package |
| 18 | M4 boundary | No provider runtime in scope | No ProcessManager, ProviderAdapter, CLI execution, Worktree runtime, Policy, or Approval implementation enters P3 | All stages | None (standing constraint) | Dependency scan: no imports of M4 surfaces | Any M4 surface is touched | Revert the offending change |
| 19 | correlationId generation for non-create operations | Mechanism exists; rule frozen by M3-TD-26 (3.14) | M3-TD-26: `correlationId = operation.id` for every newly created non-create Operation, generated and persisted in the creation transaction, UNIQUE and immutable; the claim `run.dequeued` event carries the claimed Operation's correlationId; the historical `run.create` rule (`correlationId = run.id`) is preserved | P3A (apply), P3B-1/P3C-1 (use) | M3-TD-26 | Uniqueness and association tests; claim event correlationId equals the claimed Operation's; replay stability; a duplicate command never creates a second Operation/correlationId | A second correlationId for one Operation; a mutable or derived correlationId | Revert generation wiring |
| 20 | Execution authorization and Engine claim eligibility | Queued runs are enumerable via `listByWorkspace({status:'queued'})`; no marker distinguishes created-only from execution-authorized runs (3.4) | Frozen rules: (1) a `run.create` Operation never authorizes Engine execution; (2) the Engine claims only a Run with status `queued` that has exactly one associated queued authorization Operation — type `run.start` or `run.retry` — with consistent workspaceId/runId/aggregateId/correlationId bindings and a unique immutable correlationId; (3) with no eligible authorization Operation the Engine tick returns no-op; (4) coexisting or multiple valid authorization Operations fail closed, never an arbitrary choice; (5) P3B implements explicit, test-controlled ticks only — no background timer, server startup loop, or auto-scan; (6) a Run gains eligibility only after an acceptance transaction commits the queued authorization Operation; (7) `run.cancel` and `run.create` Operations are never claim markers; (8) a queued `run.retry` is a claim marker per M3-TD-30 | P3B-1 (selector/claim), P3C-1 (grant) | P3A, M3-TD-26 | Required tests: Run without an eligible authorization Operation stays queued across repeated ticks with no `run.dequeued` and no new Outbox; `run.create` does not authorize claim; queued Run + queued `run.start` is claimed with Operation and Run changed in one transaction and the Event carrying the Operation correlationId; queued Run + queued `run.retry` is claimed identically (M3-TD-30); zero authorization is a no-op; competing Engine claims produce exactly one winner; a Run with both Start and Retry (or multiple) authorizations fails closed; Operation-transition failure during claim rolls back Run/Event/Outbox; Run/Event/Outbox failure during claim rolls back the Operation transition; P3B-1 registers no background loop or wall-clock timer | Eligibility reads Runs without Operation binding; an arbitrary Operation is chosen; a generic selector accepts only one authorization type; a scheduler table, background loop, or auto-scan appears | Revert selector/claim package; Runs, Operations, and Events preserved |

## 5. Schema Verification

The P3 scope was checked against the live schema (Migrations 001–013):

- `operations` fully supports the frozen Operation contract (item 3.7): exact
  4-type vocabulary, exact 7-status vocabulary, workspace scoping,
  aggregate binding, unique immutable correlation id, result/ApiProblem
  storage, versioning, and identity immutability.
- `runtime_events` supports the Operation events query via
  `(run_id, correlation_id, sequence)`.
- `runs` and `run_stages` carry the full M3 status vocabularies and version
  columns required for engine claim and orchestration.
- `idempotency_records` already accepts `run.start` and `run.retry`.

Conclusion: Migration 012 (with 001–011 and 013) is sufficient for the
entire P3 scope, including the `operations` table required for execution
authorization and Engine claim eligibility (Gap Matrix item 20). The
schema permits only `run.start` and `run.retry` as authorization types for
this selector; binding consistency and the exactly-one rule remain runtime
contracts.

SCHEMA BLOCKER: NONE. Migration 014 is not required or authorized. (Had any
insufficiency been found, this audit would have recorded
`SCHEMA BLOCKER — OWNER DECISION REQUIRED` and stopped.)

## 6. Resolved P3 Owner Decisions

The five P3 Owner Decision candidates surfaced by this audit and its
remediations are resolved. Unresolved candidates: 0. Approved P3
decisions: 5. The approved technical directions are frozen as M3-TD-26
through M3-TD-30 in
`docs/implementation/milestones/M3-owner-decisions.md`. This approval is
technical direction only — P3 and P3A implementation remain NOT
AUTHORIZED.

- OD-P3-01 -> M3-TD-26 — correlationId generation rule for non-create
  operations: for every newly created non-create Operation,
  `correlationId = operation.id`, generated and persisted in the creation
  transaction, UNIQUE and immutable. The historical `run.create` rule
  (`correlationId = run.id`) is preserved.
- OD-P3-02 -> M3-TD-27 — Cancel Operation semantics:
  `POST /api/operations/:operationId/cancel` cancels the target
  non-terminal Operation and its bound Task-domain Run atomically in one
  caller-owned transaction; terminal Operations fail closed.
- OD-P3-03 -> M3-TD-28 — Operation progress: P3 does not persist or
  populate `ApiOperation.progress`; `GET /api/operations/:operationId`
  omits progress; progress design is deferred to Post-M3 with its own
  contract and data-source decision.
- OD-P3-04 -> M3-TD-29 — Start Operation completion package: the
  `run.start` Operation is a Start command tracker, not a Run lifetime
  projection. Its `running -> completed` transition commits in the same
  caller-owned twelve-step startup-completion transaction as Stage
  `starting -> running`, `stage.started`, Run `starting -> running`,
  `run.started`, and both Outbox rows; post-start Stage/Run outcomes never
  rewrite it. C1a covers failure before claim commit with full rollback and
  no automatic failed marking; C1b covers accepted-and-claimed failure
  before `run.started` with the same atomic Stage/Run/Operation failure
  closure. The result is `resourceType = "run"`, `resourceId = runId`,
  data omitted; idempotency replay always returns the acceptance-time
  immutable queued Operation snapshot. The alternative "Start Operation
  tracks the Run to terminal" is REJECTED.
- OD-P3-05 -> M3-TD-30 — Retry Child Run Activation (Option B approved):
  Retry is accepted only for a Parent Run in `failed` at the expected
  version; all other Parent statuses return stable 409
  `RUN_NOT_RETRYABLE`. It creates a Child Run and immediately authorizes it
  for Engine execution; a separate Start command is not required. The
  endpoint returns HTTP 202 with the queued `run.retry` Operation bound to
  the Child Run. Creation Events use `correlationId = childRun.id`, while
  execution Events after `run.dequeued` use `operation.id`; creation Events
  are excluded from the Operation Events query. The same twelve-step
  startup-completion transaction closes the Retry Operation; A2 failure
  rollback leaves no child artifacts and leaves the Parent unchanged.
  Idempotency replay uses the Operation-only immutable acceptance-time
  snapshot envelope. Option A (separate Start command required) is
  REJECTED.

## 7. Recommended Stage Split (preview)

Detailed in `docs/implementation/milestones/M3-p3-implementation-plan.md`:

- P3A — Operation Persistence and Lifecycle Foundation
- P3B-1 — Execution-Authorized Claim and Transaction Composition
- P3B-2 — Deterministic Workflow and Stage Execution
- P3C-0A — Start Operation Idempotency Replay
- P3C-0B — Retry Operation Idempotency Closure
- P3C-1 — Async Start, Cancel Race, Child Retry
- P3D — Operation Routes and Event Query
- P3E — Integrated Verification and Closeout

These dependencies are directed gates, not a mechanical serial order:

- P3C-0A may start once P3A is accepted.
- P3B-1 depends on P3A + M3-TD-26.
- P3B-2 depends on P3B-1 + M3-TD-29.
- P3C-0B depends on M3-TD-30.
- P3C-1 Start portion depends on P3C-0A + P3B-1 + M3-TD-26/M3-TD-29.
- P3C-1 Retry portion additionally depends on P3C-0B + M3-TD-30.

This freezes the dependency graph only; it does not authorize parallel
implementation.

## 8. Standing Constraints (restated for P3)

- Queue Record = `runs(status='queued')`; Operation tracks only Task-domain
  Run commands; Operation != Run; correlationId unique and immutable;
  Create != Start; Retry creates a child Run and never resets the old Run.
- All transitions go through the P2 transaction core; State/Event/Outbox in
  one transaction; no `operation_events` store.
- A queued Run is necessary but not sufficient for Engine execution; Engine
  claim requires exactly one queued, binding-valid authorization Operation —
  type `run.start` or `run.retry` — with consistent workspaceId, runId,
  aggregateId, and correlationId bindings. Zero eligible authorization is a
  tick no-op; coexisting or multiple authorizations fail closed;
  `run.create`/`run.cancel` never authorize claim.
- Failure semantics: Start acceptance A1, Retry acceptance A2, Engine claim
  (B), pre-start failure recording (C1), and post-start execution outcome
  mapping (C2, per M3-TD-29) are distinct transaction classes; no partial
  lifecycle state; an accepted Operation may persist as durable failure
  evidence.
- v2 and Legacy remain usable; Web default is not switched; no Migration 014;
  no ProcessManager/ProviderAdapter/CLI execution/Worktree runtime/Policy/
  Approval implementation; no SSE/Replay; no OpenAPI completion; no Web
  cutover; no Legacy retirement; no production migration, restore, or cutover.
- Remote Checks: UNAVAILABLE — NOT PASS (standing wording for this
  environment).

This audit changes nothing and authorizes nothing. P3 implementation remains
NOT AUTHORIZED. P3A implementation remains NOT AUTHORIZED. The preplanning PR (PR #21) is MERGED.
