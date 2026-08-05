# M3 P3 Current-State Audit

Status: POST-MERGE REMEDIATION 1 — M3-TD-30 OPTION A ALIGNMENT IN PROGRESS — P3C-1 AND LATER NOT AUTHORIZED — REMOTE CHECKS UNAVAILABLE — NOT PASS — PRODUCTION CUTOVER NOT AUTHORIZED / NOT STARTED

This document is the current-state audit of the post-P2/P3C-0B codebase against the M3 P3
scope (Run Engine, Workflow Executor and Operation) defined in
`docs/implementation/milestones/M3-lifecycle-event-api-implementation-plan.md`.
It records what exists, what is missing, and where each gap belongs. This
remediation authorizes only the six-file Option A alignment package; it does
not authorize P3C-1 production routes, Child creation, Migration 014, or
Production Cutover.

Remediation 1 (Execution Authorization and Transaction Composition) updates
items 3.1/3.4, expands the Gap Matrix from 19 to 20 items, tightens section
5 wording, expands the Owner Decision candidates from 4 to 5, and reflects
the P3B-1/P3B-2A/P3B-2B review-boundary split in the stage preview.

Remediation 2 (Operation Idempotency and Seam Ownership) corrects item 3.9,
re-scopes Gap Matrix item 15, splits P3C into P3C-0/P3C-1 across the matrix
and the stage preview, and extends OD-P3-05. Audit item statuses and counts
are unchanged.

Remediation 3 (Retry Idempotency Ownership and Start Operation Completion
Gate) splits P3C-0 into P3C-0A/P3C-0B, extends OD-P3-04, and splits failure
class C into C1a (before claim commit), C1b (after claim and before
`run.started`), and C2. Audit item statuses and counts remain unchanged.

Post-Merge Remediation 1 aligns the current RunEngine authorization selector,
Owner Decision, audit, and implementation plan to Option A. Retry creates a
queued Child, does not authorize Engine execution, returns HTTP 201, and
requires a separate `run.start`. P3C-1 and later implementation remain NOT
AUTHORIZED.

Owner Decision Freeze (2026-08-04): the five P3 Owner Decision candidates
OD-P3-01 through OD-P3-05 are resolved as approved technical directions
M3-TD-26 through M3-TD-30 in
`docs/implementation/milestones/M3-owner-decisions.md`. Section 6 is now a
resolved-decision record; unresolved candidates: 0; approved P3 decisions:
SUPERSEDED / HISTORICAL - NOT CURRENT CONTRACT: the pre-remediation
authorization wording below is retained only as audit history.
5. Audit item statuses and counts remain unchanged. This approval is
APPROVED TECHNICAL DIRECTION — IMPLEMENTATION STILL NOT AUTHORIZED. P3 and
P3A implementation remain NOT AUTHORIZED.

## 1. Baseline

- Audited baseline (main / origin/main): `82bee50416caff28caf5511be68420cf0ebb0805`
- P2/P3C-0B implementation merge (PR #28): `82bee50416caff28caf5511be68420cf0ebb0805`
- P2 implementation source head: `14b722614c947c920915dccc5807e7469e604096`
- Pre-P2 main: `417f5f9c329d32cf75d0ea5a7d797fdb355d3593`
- PR state at audit time: PR #28 MERGED; source branch remains available for
  this remediation's frozen base.
- Migration registry: exactly 001–013 in
  `apps/server/src/migrations/default-registry.ts`; no Migration 014 exists and
  none is proposed by this audit.
- Governing documents:
  - `docs/implementation/milestones/M3-owner-decisions.md` (M3-TD-01 through M3-TD-30)
  - `docs/implementation/milestones/M3-lifecycle-event-api-implementation-plan.md` (P0–P7; P3 authorized scope)
  - `docs/implementation/milestones/M3-p2-post-merge-closeout.md`
  - Runtime Specifications 02, 03, 10, 11, 14 under `docs/Runtime-Specification/`

## 2. Method

Inspection of the frozen base tree and the remediation worktree: schema
migrations, services, repositories, routes, shared contracts, and existing
tests. No database was migrated. Only the allowlisted RunEngine, test, and
M3 planning/decision files may change in this remediation.

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
  non-terminal queued `run.start` Operation. A queued or completed
  `run.retry` is not an Engine authorization and produces no-op/no-
  authorization with no claim writes.

### 3.2 P2 Transaction Core — IMPLEMENTED

`apps/server/src/services/LifecycleTransactionService.ts` provides the P2
transaction foundation:

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

The remaining P3 seams are not part of this IMPLEMENTED P2 audit item:

- The P3B-1 caller-owned claim seam is still missing.
- P3B-2B success/failure composite seams are still missing.
- The `startup-failure` multi-event contract is still pending P3B-2A
  specification/shared alignment. The current P2C transition/event matrix
  defines Run `starting -> failed` as a single `run.failed`, and the current
  `M3MultiEventOrderingContract` does not contain `startup-failure`.

This is a P3B-2A Contract Alignment Gate, not a Schema Blocker. P3B-2B
Runtime implementation must not infer or bypass the missing contract.

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
binding-valid `run.start` Operation associated with the run. A queued or
completed `run.retry` is never eligible and is a tick no-op with no writes.
Multiple or coexisting Start Operations fail closed. The frozen rule set is
Gap Matrix item 20. `run.create`, `run.cancel`, and `run.retry` never
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

Current Option A override for the retry and authorization cells below:

- `run.retry` is never an Engine claim marker. Retry-only and completed-Retry
  cases are `noop/no-authorization` with zero Run/Event/Outbox/sequence
  changes.
- A queued Child becomes eligible only through one binding-valid queued
  `run.start` Operation. A Child with completed v3 Retry Operation plus Start
  is claimed by Start, and all execution Event correlation uses the Start
  Operation ID.
- P3C-0B is merged as HTTP 201 with the dedicated schemaVersion 1 envelope
  containing the queued Child snapshot and completed Retry Operation v3
  snapshot. Any pre-remediation wording in the matrix that says Retry is an
  Engine authorization, returns 202, or uses an Operation-only envelope is
  SUPERSEDED / HISTORICAL - NOT CURRENT CONTRACT.

Each row: current evidence, required target, proposed implementation
category, dependency, test evidence, stop condition, and rollback boundary.
Categories reference the stage split proposed in
`docs/implementation/milestones/M3-p3-implementation-plan.md`
(P3A, P3B-1, P3B-2A, P3B-2B, P3C-0A, P3C-0B, P3C-1, P3D, P3E). Nothing here is
authorized work.

| # | Gap | Current evidence | Required target | Category | Depends on | Test evidence | Stop condition | Rollback boundary |
|---|-----|------------------|-----------------|----------|------------|---------------|----------------|-------------------|
| 1 | Persistent queue ownership | `runs(status='queued')` exists; no owner | Exactly one component (Run Engine) may claim queued runs, and only execution-authorized ones (item 20); queued alone never suffices. An execution-authorized Run has exactly one valid, non-terminal queued `run.start` Operation with all bindings consistent | P3B-1 | P3A, #20 | Ownership unit test: only the engine mutates claimed runs; a tick without an eligible authorization Operation is a no-op; multiple/coexisting Start authorizations fail closed | Any second writer to queued runs appears; the engine claims a run with no eligible authorization Operation, with inconsistent binding, or with more than one valid authorization | Revert engine as one package; queue rows untouched |
| 2 | Run claim/dequeue | No claim path | Atomic claim in one caller-owned outer transaction: re-read queued Run and exactly one queued `run.start` Operation, validate workspace/run/aggregate/correlation binding, conditional Operation `queued -> running`, Run `queued -> starting` via `LifecycleTransactionService`, `run.dequeued` with the Start Operation correlationId, Outbox row; commit all or roll back all. A queued `run.retry` is ignored and cannot claim | P3B-1 | #1, #6, #20 | Two competing Start claims, exactly one succeeds; Retry-only and zero authorization are repeatable no-ops; duplicate Start authorizations fail closed; the loser leaves zero partial Operation/Run/Event/Outbox writes | Claim requires a new table, two independent transactions, or nested transactions, or bypasses the transaction core; selector accepts `run.retry`; a generic Operation is chosen | Revert claim path; no data reset |
| 3 | Run Engine | RunEngine implementation exists in the remediation worktree | Tick-driven engine advances only a queued Run with exactly one binding-valid queued `run.start`; queued or completed `run.retry` returns `noop/no-authorization` with no Run/Event/Outbox/sequence change; explicit test-controlled ticks only, no background timer, server startup loop, or auto-scan | P3B-1 | #2 | Engine unit tests cover Retry-only no-op, completed Retry immutability, independent Start claim, binding failures, rollback, and competition | Engine calls repositories directly, bypasses events/outbox, selects Retry, or a background loop or wall-clock timer is requested | Revert engine package |
| 4 | Startup failure Event contract and deterministic Workflow Executor | Absent (3.5); current P2C matrix has no `startup-failure` multi-event ordering | P3B-2A first aligns Shared/Runtime Specification/Transition Matrix with `startup-failure` = `stage.failed -> run.failed` and its exact ordering attributes; P3B-2B then consumes that contract for deterministic snapshot graph traversal and mock execution; no provider runtime | P3B-2A/P3B-2B | P3B-1; P3B-2A before P3B-2B | Contract alignment tests for Branch A/Branch B; then snapshot-graph traversal and deterministic ordering tests | P3B-2B implements `stage.failed -> run.failed` before P3B-2A acceptance; executor needs ProcessManager/ProviderAdapter/CLI; a schema change is requested | Revert the alignment or executor package; no runtime data reset |
| 5 | Stage orchestration | Absent (3.6) | P3B-2B drives Stage lifecycle through `transitionStage`; `skipped` propagation on failure/cancel per the accepted contract; P3B-2A owns only specification/shared alignment | P3B-2B | P3B-1 + P3B-2A | Contract-consistent Stage transition and skip-propagation tests | Stage writes bypass Event/Outbox; P3B-2B modifies Shared/Specification/Event Matrix; Stage failure ordering is inferred rather than consumed | Revert orchestration; stage rows preserved |
| 6 | Operation persistence/lifecycle | Schema complete; repo/service absent (3.7) | `OperationRepository` + `OperationService` writing/reading `operations` with version optimistic locking | P3A | P2 core | Repository CRUD, identity-immutability trigger, version conflict tests | Operation status vocabulary diverges from the frozen 7 | Revert repo/service; table and rows preserved |
| 7 | HTTP 202 Start | Absent (3.8) | Start route returns 202 + Operation; the A1 acceptance transaction atomically commits the queued `run.start` Operation and the idempotency success/replay response using the P3C-0A `run.start` + 202 + immutable Operation replay envelope; the Run stays queued and gains execution eligibility only after that commit; the acceptance transaction never starts the Run and never writes `run.dequeued` | P3C-1 | #6, #15, #20, P3B-1, P3C-0A | Route contract test: 202 shape, Operation body; A1 failure leaves no Operation, no idempotency success, Run stays queued | Synchronous start execution in the route handler; acceptance transaction writes lifecycle events | Revert route; runs/operations untouched |
| 8 | Duplicate Start | `run.start` idempotency schema-accepted, no consumer (3.9) | Same idempotency key replays the original Operation; different key on an already-started run is rejected per contract; multiple non-terminal `run.start` Operations for the same run fail closed with no arbitrary choice | P3C-1 | #7 | Same-key replay test; different-key rejection test; duplicate-active-Operation fail-closed test | Duplicate start mutates the run twice; an arbitrary Operation is selected | Revert start idempotency wiring |
| 9 | Start failure rollback | Failure-injection harness exists (3.15) | Contract alignment comes first in P3B-2A: Branch A registers `startup-failure` = `stage.failed -> run.failed` with single stage, no stage ordering, contiguous Run sequence, independent Outbox per Event, and atomic Current State/Event/Outbox; Branch B retains single `run.failed` with no Additional Event when no Stage has entered `starting`. Only after that gate does P3B-2B implement A1/A2/B/C1a/C1b/C2: A1 leaves no Operation or Idempotency Success and Run queued; A2 leaves no Child artifacts and Parent unchanged; B/C1a roll back or classify correctly; C1b atomically fails Stage/Run/Operation or, before Stage `starting`, fails Run/Operation without fabricating `stage.failed`; C2 never rewrites a completed Start/Retry Operation | P3B-2A/P3B-2B | #7, P3B-1, M3-TD-29 | P3B-2A Branch A/Branch B contract tests; P3B-2B injection at every A1/A2/B/C1b Stage/Run/Event/Outbox/Operation position; C1a no-auto-failed proof; failure-vs-cancel evidence belongs to P3D; C2 non-rewrite and integrity checks | Runtime implements startup-failure before alignment; transaction rollback misclassified as business failure; automatic failed marking after claim-attempt rollback; split Run/Operation failure closure; fabricated Stage Event; post-start rewrite | Revert alignment/runtime package; preserve durable evidence, no data reset |
| 10 | Cancel/complete race | Atomic transitions + version guard exist (3.10) | P3D Operation cancel ownership resolves claim-vs-cancel, startup-completion-vs-cancel, startup-failure-closure-vs-cancel, and cancel-vs-terminal races to exactly one caller-owned winner with no partial Stage/Run/Operation/Event/Outbox writes | P3D | #6, M3-TD-27, P3B-2B, P3C-1 | P3D race matrix: Claim vs cancel; startup completion vs cancel; startup failure closure vs cancel; cancel vs already-terminal Operation; duplicate cancel; loser zero-partial-write proof | Any Cancel race assigned to P3C-1; cancellation is incorrectly routed through C1a/C1b; two terminal outcomes or silent overwrite | Revert P3D cancel handling; events preserved |
| 11 | Retry child Run | Lineage computation exists; no caller (3.11) | Per M3-TD-30 Option A: Retry is accepted only when the Parent Run is `failed` at the expected version; all other Parent statuses return stable 409 `RUN_NOT_RETRYABLE`; a valid request creates a queued Child Run (new id, correct parentRunId/rootRunId lineage), never resets or modifies the Parent, and the A2 acceptance transaction atomically creates the child graph, Snapshot, completed v3 `run.retry` Operation, idempotency record, and creation Event/Outbox. Retry returns HTTP 201 with the dedicated schemaVersion 1 Child + Retry Operation envelope. The Child becomes execution-eligible only after a separate queued `run.start`; execution Events use the Start Operation ID. | P3C-1 | #6, M3-TD-30, P3C-0B | A2 injection at Child/Snapshot/Stage/Creation Event/Outbox/Retry Operation/Idempotency Success leaves no Child Run, Snapshot, Stage, creation Event, Outbox, Retry Operation, or Idempotency Success and leaves the Parent unchanged; valid failed Parent creates one queued Child; stale/non-failed Parent has zero side effects; Retry-only Engine tick is a no-op and Start-driven Child execution uses Start correlation | Retry mutates or resets the Parent; accepts a non-failed Parent; creation Event uses operation.id; Retry claims or dispatches the Child; a combined or Operation-only envelope; P3C-1 modifies idempotency core files | Revert retry path |
| 12 | Operation events query | `runtime_events` index `(run_id, correlation_id, sequence)` exists | `GET /api/operations/:operationId/events` authorizes the Operation, then reads Events by runId + correlationId ascending sequence; `run.start` execution results are correlated to the Start Operation, while `run.retry` does not authorize or produce execution-correlated Events before a separate Start; no `operation_events` store | P3D | #6 | Query test: ordering, authorization failure, empty set, Start correlation, and no Retry-execution correlation | An `operation_events` table or store appears; the query treats Retry metadata as an execution authorization or includes Child creation Events as Retry execution | Revert route |
| 13 | Operation cancel | `cancelRunWithinTransaction` exists; no operation binding | Per M3-TD-27: `POST /api/operations/:operationId/cancel` directly operates on the target non-terminal Operation (statuses `queued`/`running`/`waiting_approval`/`paused`) and its bound Task-domain Run in one caller-owned transaction through the P2 core; it has no Class A and creates/accepts no second Cancel Operation; already-`cancelled` returns the current Operation with zero new side effects; `completed`/`failed` returns 409-class `OPERATION_NOT_CANCELLABLE`; incompatible Run state fails closed; before/during startup cancellation produces Operation/Run cancelled, `stage.cancelled` × N for affected non-terminal Stages, and `run.cancelled`, never Operation/Run/Stage failed; any failure rolls back target Operation, Run/Stage, Event, and Outbox changes to their transaction-before state and never uses C1 to record another Operation. No second cancel Operation exists | P3D | #10, M3-TD-27 | P3D cancel tests include the terminal matrix, Claim vs cancel, startup completion vs cancel, startup failure closure vs cancel, duplicate cancel, no-second-Operation, and failure injection with no partial Event/Outbox writes | A second Cancel Operation; an Operation-row-only cancel; a Class A or C1 failure record for cancel; bypassing the transaction core; split rollback | Revert route |
| 14 | Task reconciliation | Tasks hold active run linkage via accept/cancel/reopen | Engine/executor outcomes reconcile task active-slot state through existing v2 paths | P3C-1 | #5 | Task slot reconciliation test on run terminal states | Reconciliation bypasses existing task invariants | Revert reconciliation |
| 15 | Idempotency coverage | 6 consumers wired; the DB accepts `run.start`/`run.retry` and 200–299, but the TypeScript contract (6-operation list, 200/201-only statuses, Task/Run-only envelope, exact-shape parser) cannot store or replay an Operation command response (3.9) | Backward-compatible schemaVersion 1 extension with no DB change and no result schema version 2, split into two review boundaries: P3C-0A — `run.start` TypeScript operation registration, 202 HTTP status support, immutable Operation replay snapshot DTO and envelope variant, canonical JSON/hash/parser support over the full envelope, exact original HTTP status replay, Operation envelope corruption rejection, legacy 6 operations keep their exact status and envelope behavior; P3C-0B — `run.retry` registration per M3-TD-30 Option A: HTTP status fixed at 201, dedicated immutable `body.run` queued Child + `body.operation` completed v3 Retry Operation envelope, same-key replay of the original status and acceptance-time snapshots | P3C-0A (start), P3C-0B (retry closure) | P3A; P3C-0B additionally M3-TD-30 | 12 required tests for P3C-0A: `run.start` 202 Operation envelope round-trip; repository persists and returns the original 202; replay returns the original Operation snapshot; later Operation state changes do not affect the saved replay; canonical JSON/hash stable; tampered result JSON/hash rejected; wrong operation/envelope pair rejected; wrong operation/http-status pair rejected; legacy 6 statuses unchanged; legacy Task/Run envelopes still parse; unknown envelope variant fails closed; repository/service join a caller-owned transaction. P3C-0B mirrors these for the 201 queued Child + completed v3 Retry Operation dual snapshot, including replay stability and exact-shape rejection | A route, Operation creation, or run start is added; the DB is changed; replay re-reads the current Operation or Child Run; a legacy envelope or status changes; the retry envelope deviates from M3-TD-30 | Revert the idempotency extension; stored rows preserved |
| 16 | `recovery_required` interaction | Column and setting paths exist from P2 | P3 transitions leave the flag semantics unchanged; startup recovery continues to own it | P3B-1/P3C-1 | P2 core | Regression: flag set/clear paths unchanged | P3 code writes the flag directly | Revert offending path |
| 17 | Legacy/v2 compatibility | Both paths green at baseline (3.13) | All P3 additions are additive; Legacy bridge and v2 collections keep passing | All stages | None (standing constraint) | Full server suite green each stage | Any Legacy/v2 regression | Revert the offending stage package |
| 18 | M4 boundary | No provider runtime in scope | No ProcessManager, ProviderAdapter, CLI execution, Worktree runtime, Policy, or Approval implementation enters P3 | All stages | None (standing constraint) | Dependency scan: no imports of M4 surfaces | Any M4 surface is touched | Revert the offending change |
| 19 | correlationId generation for non-create operations | Mechanism exists; rule frozen by M3-TD-26 (3.14) | M3-TD-26: `correlationId = operation.id` for every newly created non-create Operation, generated and persisted in the creation transaction, UNIQUE and immutable; the claim `run.dequeued` event carries the claimed Operation's correlationId; the historical `run.create` rule (`correlationId = run.id`) is preserved | P3A (apply), P3B-1/P3C-1 (use) | M3-TD-26 | Uniqueness and association tests; claim event correlationId equals the claimed Operation's; replay stability; a duplicate command never creates a second Operation/correlationId | A second correlationId for one Operation; a mutable or derived correlationId | Revert generation wiring |
| 20 | Execution authorization and Engine claim eligibility | Queued runs are enumerable via `listByWorkspace({status:'queued'})`; no marker distinguishes created-only from execution-authorized runs (3.4) | Frozen rules: (1) a `run.create` Operation never authorizes Engine execution; (2) the Engine claims only a Run with status `queued` that has exactly one associated queued, binding-valid `run.start` Operation with consistent workspaceId/runId/aggregateId/correlationId bindings and a unique immutable correlationId; (3) with no eligible Start authorization, including queued or completed `run.retry`, the Engine tick returns repeatable no-op with no writes; (4) multiple valid Start authorizations fail closed, never an arbitrary choice; (5) P3B implements explicit, test-controlled ticks only — no background timer, server startup loop, or auto-scan; (6) a Run gains eligibility only after an acceptance transaction commits the queued Start Operation; (7) `run.cancel`, `run.create`, and `run.retry` Operations are never claim markers | P3B-1 (selector/claim), P3C-1 (grant) | P3A, M3-TD-26 | Required tests: Run without an eligible authorization Operation stays queued across repeated ticks with no `run.dequeued` and no new Outbox; `run.create` does not authorize claim; queued Run + queued `run.start` is claimed with Operation and Run changed in one transaction and the Event carrying the Start Operation correlationId; queued or completed `run.retry` is a no-op with zero claim writes; competing Engine claims produce exactly one winner; a Run with multiple Start authorizations fails closed; Operation-transition failure during claim rolls back Run/Event/Outbox; Run/Event/Outbox failure during claim rolls back the Operation transition; P3B-1 registers no background loop or wall-clock timer | Eligibility reads Runs without Operation binding; an arbitrary Operation is chosen; a selector accepts `run.retry`; a scheduler table, background loop, or auto-scan appears | Revert selector/claim package; Runs, Operations, and Events preserved |

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
schema permits both `run.start` and `run.retry` as Operation values, while
the current Engine selector authorizes only `run.start`; binding consistency
and the exactly-one Start rule remain runtime contracts.

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
Current M3-TD-30 / P3C-0B alignment: Option A is current. Retry returns
HTTP 201, persists a queued Child plus completed v3 Retry Operation in the
dedicated schemaVersion 1 envelope, and requires a separate queued
`run.start` for Engine execution. The historical Option B wording below is
SUPERSEDED / HISTORICAL - NOT CURRENT CONTRACT.
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
- P3B-2A — Startup Failure Event Contract Alignment
- P3B-2B — Deterministic Workflow and Atomic Startup Outcomes
- P3C-0A — Start Operation Idempotency Replay
- P3C-0B — Retry Operation Idempotency Closure
- P3C-1 — Async Start and Child Retry
- P3D — Operation Routes, Atomic Cancel and Event Query
- P3E — Integrated Verification and Closeout

These dependencies are directed gates, not a mechanical serial order:

- P3C-0A may start once P3A is accepted.
- P3B-1 depends on P3A + M3-TD-26.
- P3B-2A depends on P3B-1 and is a specification/shared contract alignment
  gate only.
- P3B-2B depends on P3B-1 + P3B-2A + M3-TD-29 and consumes the accepted
  `startup-failure` contract; it does not modify Shared/Specification/Event
  Matrix files.
- P3C-0B depends on M3-TD-30.
- P3C-1 Start portion depends on P3C-0A + P3B-1 + M3-TD-26/M3-TD-29.
- P3C-1 Retry portion additionally depends on P3C-0B + M3-TD-30.
- P3D depends on P3A + P3B-1 + P3B-2B + P3C-1 and owns all Operation
  Cancel races.
- P3E depends on P3B-2A + P3B-2B + P3D in addition to the other accepted
  stages.

This freezes the dependency graph only; it does not authorize parallel
implementation.

## 8. Standing Constraints (restated for P3)

- Queue Record = `runs(status='queued')`; Operation tracks only Task-domain
  Run commands; Operation != Run; correlationId unique and immutable;
  Create != Start; Retry creates a child Run and never resets the old Run.
- All transitions go through the P2 transaction core; State/Event/Outbox in
  one transaction; no `operation_events` store.
- Current Option A authorization rule: only a binding-valid queued
  `run.start` can claim a queued Run. A queued or completed `run.retry` is
  never a claim marker and produces no-op/no-authorization with no writes.
  A Child requires a separate Start command.
SUPERSEDED / HISTORICAL - NOT CURRENT CONTRACT: the legacy mixed
`run.start`/`run.retry` selector wording in the following bullet is retained
only for audit traceability.
- A queued Run is necessary but not sufficient for Engine execution; Engine
  claim requires exactly one queued, binding-valid authorization Operation —
  type `run.start` or `run.retry` — with consistent workspaceId, runId,
  aggregateId, and correlationId bindings. Zero eligible authorization is a
  tick no-op; coexisting or multiple authorizations fail closed;
  `run.create`/`run.cancel` never authorize claim.
- Failure semantics: Start acceptance A1, Retry acceptance A2, Engine claim
  (B), C1a before claim commit, C1b after claim and before `run.started`,
  and post-start execution outcome mapping (C2, per M3-TD-29) are distinct
  transaction classes; transaction-attempt rollback is not business
  failure; user cancellation always follows M3-TD-27 in P3D and never
  becomes C1a/C1b; no partial lifecycle state; an accepted Operation may
  persist as durable failure evidence.
- P3B-2A CONTRACT ALIGNMENT: PLANNED — NOT AUTHORIZED. The current
  P2C transition/event matrix still has the single `run.failed` Branch B
  contract; P3B-2A must register the Branch A `startup-failure` ordering
  before P3B-2B Runtime implementation. P3B-2B must not infer it.
- v2 and Legacy remain usable; Web default is not switched; no Migration 014;
  no ProcessManager/ProviderAdapter/CLI execution/Worktree runtime/Policy/
  Approval implementation; no SSE/Replay; no OpenAPI completion; no Web
  cutover; no Legacy retirement; no production migration, restore, or cutover.
- Remote Checks: UNAVAILABLE — NOT PASS (standing wording for this
  environment).

This audit records the completed Option A authorization alignment only. P3C-1
and later implementation remain NOT AUTHORIZED. The preplanning PR (PR #21)
and P3C-0B merge (PR #28) are MERGED.
