# M3 P3 Current-State Audit

Status: PREPLANNING ONLY — P3 IMPLEMENTATION NOT AUTHORIZED — P3A IMPLEMENTATION NOT AUTHORIZED — PREPLANNING PR NOT YET AUTHORIZED — REMOTE CHECKS UNAVAILABLE — NOT PASS — PRODUCTION CUTOVER NOT AUTHORIZED / NOT STARTED

This document is a read-only audit of the post-P2 codebase against the M3 P3
scope (Run Engine, Workflow Executor and Operation) defined in
`docs/implementation/milestones/M3-lifecycle-event-api-implementation-plan.md`.
It records what exists, what is missing, and where each gap belongs. It does
not authorize, start, or design any production implementation beyond the
planning level, and it does not change any code, test, migration, or registry
file.

Remediation 1 (Start Authorization and Transaction Composition) updates
items 3.1/3.4, expands the Gap Matrix from 19 to 20 items, tightens section
5 wording, expands the Owner Decision candidates from 4 to 5, and reflects
the P3B-1/P3B-2 review-boundary split in the stage preview.

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
  - `docs/implementation/milestones/M3-owner-decisions.md` (M3-TD-01 through M3-TD-25)
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
execution. The Start-authorization eligibility rule is recorded in item
3.4 and Gap Matrix item 20.

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

Finding 1 (Remediation 1) — Start authorization / Engine eligibility gap:

**A Run being queued is necessary but not sufficient for Engine execution.**

- Run creation persists `status='queued'` immediately
  (`RunRepository.insert`, `apps/server/src/store/RunRepository.ts`,
  line 169).
- `RunRepository.listByWorkspace(workspaceId, { status: 'queued' })`
  (line 368) can enumerate every queued run in a workspace.
- No claim selector currently distinguishes a run that was only created
  from a run that has received a Start command.
- Scanning queued runs alone would therefore execute created-but-never-
  started runs and break the frozen `Create Run != Start Run` contract.

Engine eligibility must additionally require a queued, binding-valid
`run.start` Operation associated with the run; the frozen rule set is Gap
Matrix item 20.

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

The generic `IdempotencyService` (`apps/server/src/services/IdempotencyService.ts`,
`prepare`/`resolve`/`storeSuccess`) supports any operation name, and the
`idempotency_records.operation` CHECK accepts `run.start` and `run.retry`.
However, the only wired consumers are `task.create`, `run.create`,
`run.cancel`, `task.accept`, `task.cancel`, `task.reopen` (all in
`apps/server/src/services/TaskRunService.ts`). `run.start` and `run.retry`
are schema-accepted but have no consumer.

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
index; `operations.correlation_id` is UNIQUE. The missing piece is the
generation rule for non-create operations: P2 established that
`run.create` uses `correlationId = run.id`, but the rule for `run.start`,
`run.cancel`, and `run.retry` is not yet decided. Recorded as Owner Decision
candidate OD-P3-01 (section 6).

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
(P3A, P3B-1, P3B-2, P3C, P3D, P3E). Nothing here is authorized work.

| # | Gap | Current evidence | Required target | Category | Depends on | Test evidence | Stop condition | Rollback boundary |
|---|-----|------------------|-----------------|----------|------------|---------------|----------------|-------------------|
| 1 | Persistent queue ownership | `runs(status='queued')` exists; no owner | Exactly one component (Run Engine) may claim queued runs, and only Start-authorized ones (item 20); queued alone never suffices | P3B-1 | P3A, #20 | Ownership unit test: only the engine mutates claimed runs; tick without an eligible Start Operation is a no-op | Any second writer to queued runs appears; the engine claims a run with no queued `run.start` Operation | Revert engine as one package; queue rows untouched |
| 2 | Run claim/dequeue | No claim path | Atomic claim in one caller-owned outer transaction: re-read queued run and queued `run.start` Operation, validate workspace/run/aggregate/correlation binding, conditional Operation `queued -> running`, Run `queued -> starting` via `LifecycleTransactionService`, `run.dequeued` with the Operation correlationId, Outbox row; commit all or roll back all | P3B-1 | #1, #6, #20 | Two competing claims, exactly one succeeds; the loser leaves zero partial Operation/Run/Event/Outbox writes | Claim requires a new table, two independent transactions, or nested transactions, or bypasses the transaction core | Revert claim path; no data reset |
| 3 | Run Engine | Absent (3.3) | Tick-driven engine advancing Start-authorized claimed runs via `LifecycleTransactionService` only; explicit test-controlled ticks, no background timer, server startup loop, or auto-scan | P3B-1 | #2 | Engine unit tests with an injected transaction core; no-timer/no-loop proof | Engine calls repositories directly, bypassing events/outbox; a background loop or wall-clock timer is requested | Revert engine package |
| 4 | Deterministic Workflow Executor | Absent (3.5) | Executor reading the run snapshot V2 stage graph (`dependsOn`) deterministically; mock stage runner, no provider runtime | P3B-2 | P3B-1 independent review | Snapshot-graph traversal tests; deterministic ordering proof | Executor needs ProcessManager/ProviderAdapter/CLI | Revert executor package |
| 5 | Stage orchestration | Absent (3.6) | Stage lifecycle driven through `transitionStage`; `skipped` propagation on failure/cancel per spec | P3B-2 | #4 | Stage transition and skip-propagation tests | Stage writes bypass Event/Outbox | Revert orchestration; stage rows preserved |
| 6 | Operation persistence/lifecycle | Schema complete; repo/service absent (3.7) | `OperationRepository` + `OperationService` writing/reading `operations` with version optimistic locking | P3A | P2 core | Repository CRUD, identity-immutability trigger, version conflict tests | Operation status vocabulary diverges from the frozen 7 | Revert repo/service; table and rows preserved |
| 7 | HTTP 202 Start | Absent (3.8) | Start route returns 202 + Operation; the acceptance transaction atomically commits the queued `run.start` Operation and the idempotency success/replay response; the run stays queued and gains Engine eligibility only after that commit; the acceptance transaction never starts the run and never writes `run.dequeued` | P3C | #6, #20, P3B-1 | Route contract test: 202 shape, Operation body; acceptance failure leaves no Operation, no idempotency success, run stays queued | Synchronous start execution in the route handler; acceptance transaction writes lifecycle events | Revert route; runs/operations untouched |
| 8 | Duplicate Start | `run.start` idempotency schema-accepted, no consumer (3.9) | Same idempotency key replays the original Operation; different key on an already-started run is rejected per contract; multiple non-terminal `run.start` Operations for the same run fail closed with no arbitrary choice | P3C | #7 | Same-key replay test; different-key rejection test; duplicate-active-Operation fail-closed test | Duplicate start mutates the run twice; an arbitrary Operation is selected | Revert start idempotency wiring |
| 9 | Start failure rollback | Failure-injection harness exists (3.15) | Three distinct transaction classes: (A) acceptance failure leaves no Operation, no idempotency success, run stays queued; (B) claim failure rolls back Operation/Run/Event/Outbox together; (C) an already-accepted Operation is marked `failed` with the serialized ApiProblem in a separate, explicit failure-record transaction after the lifecycle rollback; wording: no partial lifecycle state — an accepted Operation may persist as durable failure evidence | P3C | #7, P3B-1 | Injection at each event call position in A and B; failure-record transaction test for C; post-failure integrity checks | Any partial lifecycle commit observed; failure recording folded into the rolled-back transaction | Revert start path; preserve durable evidence, no data reset |
| 10 | Cancel/complete race | Atomic transitions + version guard exist (3.10) | Operation-level race resolves to exactly one terminal state with evidence | P3C | #6 | Concurrent cancel vs complete test; loser fails cleanly | Race produces two terminal events or silent overwrite | Revert race handling; events preserved |
| 11 | Retry child Run | Lineage computation exists; no caller (3.11) | Retry creates a child run (new id, parent lineage), never resets the old run; `run.retry` Operation recorded; activation semantics (separate Start command vs. self-authorizing) are decided by OD-P3-05; until approved, the retry child stays queued and non-executable and `run.retry` is not a claim marker | P3C | #6, OD-P3-05 | Lineage test: root id, parent id, old run untouched; `run.retry` does not authorize claim while OD-P3-05 is undecided | Retry mutates or resets the parent run; a retry child becomes executable without OD-P3-05 | Revert retry path |
| 12 | Operation events query | `runtime_events` index `(run_id, correlation_id, sequence)` exists | `GET /api/operations/:operationId/events` authorizes the operation, then reads events by runId + correlationId ascending sequence; no `operation_events` store | P3D | #6 | Query test: ordering, authorization failure, empty set | An `operation_events` table or store appears | Revert route |
| 13 | Operation cancel | `cancelRunWithinTransaction` exists; no operation binding | `POST /api/operations/:operationId/cancel` maps to run cancellation per Owner Decision on cancel semantics (OD-P3-02) | P3D | #10, OD-P3-02 | Cancel route test incl. terminal-state rejection | Semantics decided silently without Owner Decision | Revert route |
| 14 | Task reconciliation | Tasks hold active run linkage via accept/cancel/reopen | Engine/executor outcomes reconcile task active-slot state through existing v2 paths | P3C | #5 | Task slot reconciliation test on run terminal states | Reconciliation bypasses existing task invariants | Revert reconciliation |
| 15 | Idempotency coverage | 6 consumers wired; `run.start`/`run.retry` unwired (3.9) | All P3 mutating routes use `IdempotencyService` consistently; the start acceptance transaction commits the queued Operation and the idempotency success/replay response atomically | P3C | #7, #11 | Per-route idempotency tests; acceptance failure leaves no idempotency success row | A P3 route skips the idempotency service | Revert wiring |
| 16 | `recovery_required` interaction | Column and setting paths exist from P2 | P3 transitions leave the flag semantics unchanged; startup recovery continues to own it | P3B-1/P3C | P2 core | Regression: flag set/clear paths unchanged | P3 code writes the flag directly | Revert offending path |
| 17 | Legacy/v2 compatibility | Both paths green at baseline (3.13) | All P3 additions are additive; Legacy bridge and v2 collections keep passing | All stages | None (standing constraint) | Full server suite green each stage | Any Legacy/v2 regression | Revert the offending stage package |
| 18 | M4 boundary | No provider runtime in scope | No ProcessManager, ProviderAdapter, CLI execution, Worktree runtime, Policy, or Approval implementation enters P3 | All stages | None (standing constraint) | Dependency scan: no imports of M4 surfaces | Any M4 surface is touched | Revert the offending change |
| 19 | correlationId generation for non-create operations | Mechanism exists; rule undecided (3.14) | Owner-approved deterministic rule for `run.start`/`run.cancel`/`run.retry` correlation ids, UNIQUE per operation; the claim `run.dequeued` event carries the claimed Operation's correlationId | P3A (decision), P3B-1/P3C (use) | OD-P3-01 | Uniqueness and association tests per decided rule; claim event correlationId equals the claimed Operation's | Implemented without Owner Decision | Revert generation wiring |
| 20 | Start authorization and Engine claim eligibility | Queued runs are enumerable via `listByWorkspace({status:'queued'})`; no marker distinguishes created-only from start-commanded runs (3.4) | Frozen rules: (1) a `run.create` Operation never authorizes Engine execution; (2) the Engine claims only a run with status `queued` that has an associated Operation of type `run.start` and status `queued`, with consistent workspaceId/runId/aggregateId and a unique immutable correlationId; (3) with no eligible Start Operation the Engine tick returns no-op; (4) multiple non-terminal `run.start` Operations for one run fail closed, never an arbitrary choice; (5) P3B implements explicit, test-controlled ticks only — no background timer, server startup loop, or auto-scan; (6) a run gains eligibility only after the P3C start command commits the queued Operation; (7) `run.cancel` and `run.create` Operations are never claim markers; (8) whether `run.retry` becomes a claim marker is decided by OD-P3-05 | P3B-1 (selector/claim), P3C (grant) | P3A, OD-P3-01 | Nine required tests: created run without Start Operation stays queued across repeated ticks with no `run.dequeued` and no new Outbox; `run.create` does not authorize claim; queued run + queued `run.start` is claimed with Operation and Run changed in one transaction and the event carrying the Operation correlationId; competing Engine claims produce exactly one winner; duplicate active Start Operations fail closed; Operation-transition failure during claim rolls back Run/Event/Outbox; Run/Event/Outbox failure during claim rolls back the Operation transition; `run.retry` does not authorize claim before OD-P3-05; P3B-1 registers no background loop or wall-clock timer | Eligibility reads runs without Operation binding; an arbitrary Operation is chosen; a scheduler table, background loop, or auto-scan appears | Revert selector/claim package; runs, Operations, and events preserved |

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
entire P3 scope, including the `operations` table required for Start
authorization and Engine claim eligibility (Gap Matrix item 20).

SCHEMA BLOCKER: NONE. Migration 014 is not required or authorized. (Had any
insufficiency been found, this audit would have recorded
`SCHEMA BLOCKER — OWNER DECISION REQUIRED` and stopped.)

## 6. Owner Decision Candidates

The following five are decision candidates surfaced by this audit and its
first remediation. They are NOT approved decisions. P3 implementation must
not resolve them silently.

- OD-P3-01 — correlationId generation rule for non-create operations
  (`run.start`, `run.cancel`, `run.retry`). Constraint: deterministic,
  unique per operation, stable across idempotent replays.
- OD-P3-02 — Cancel Operation semantics: whether
  `POST /api/operations/:operationId/cancel` cancels the underlying run
  (task-domain binding) or only transitions the Operation record, and the
  allowed preconditions.
- OD-P3-03 — `progress` field usage on Operation: whether P3 populates
  progress at all, and if so from which source (stage counts vs. explicit
  updates), given no `operation_events` store exists.
- OD-P3-04 — Start Operation completion timing: whether the `run.start`
  Operation completes when the start transition is committed, or tracks the
  run until a later terminal signal, and how that maps to the frozen 7
  statuses.
- OD-P3-05 — Retry Child Run Activation Semantics. Options:
  A. Retry only creates a queued Child Run; a separate Start command is
     required.
  B. Retry creates the Child Run and also authorizes Engine execution.
  Boundaries: this remediation approves neither A nor B; until OD-P3-05 is
  approved, a `run.retry` Operation must not authorize an Engine claim and
  the retry child stays queued and non-executable; the generic
  Operation/claim infrastructure (P3A, P3B-1) may still be planned; P3C
  retry activation wiring is blocked by OD-P3-05.

## 7. Recommended Stage Split (preview)

Detailed in `docs/implementation/milestones/M3-p3-implementation-plan.md`:

- P3A — Operation Persistence and Lifecycle Foundation
- P3B-1 — Start-Authorized Claim and Transaction Composition
- P3B-2 — Deterministic Workflow and Stage Execution
- P3C — Async Start, Cancel Race, Child Retry
- P3D — Operation Routes and Event Query
- P3E — Integrated Verification and Closeout

The default order is accepted on code evidence: Operations are the dependency
of Start/Cancel/Retry routes (P3C/P3D), the Start-authorized claim (P3B-1)
is the dependency of any execution, and deterministic workflow/stage
execution (P3B-2) depends on the P3B-1 independent review.

## 8. Standing Constraints (restated for P3)

- Queue Record = `runs(status='queued')`; Operation tracks only Task-domain
  Run commands; Operation != Run; correlationId unique and immutable;
  Create != Start; Retry creates a child Run and never resets the old Run.
- All transitions go through the P2 transaction core; State/Event/Outbox in
  one transaction; no `operation_events` store.
- A queued Run is necessary but not sufficient for Engine execution; Engine
  claim requires a queued, binding-valid `run.start` Operation;
  `run.create`/`run.cancel` never authorize claim; `run.retry` claim
  authorization is gated by OD-P3-05.
- Failure semantics: command acceptance (A), Engine claim (B), and
  accepted-command failure recording (C) are three distinct transactions;
  no partial lifecycle state; an accepted Operation may persist as durable
  failure evidence.
- v2 and Legacy remain usable; Web default is not switched; no Migration 014;
  no ProcessManager/ProviderAdapter/CLI execution/Worktree runtime/Policy/
  Approval implementation; no SSE/Replay; no OpenAPI completion; no Web
  cutover; no Legacy retirement; no production migration, restore, or cutover.
- Remote Checks: UNAVAILABLE — NOT PASS (standing wording for this
  environment).

This audit changes nothing and authorizes nothing. P3 implementation remains
NOT AUTHORIZED. P3A implementation remains NOT AUTHORIZED. The preplanning
PR is NOT YET AUTHORIZED.
