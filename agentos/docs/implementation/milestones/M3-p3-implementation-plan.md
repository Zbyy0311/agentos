# M3 P3 Implementation Plan — Run Engine, Workflow Executor and Operation

Status: POST-MERGE BASELINE `53b5fc78d5834ed3a5fd5eb1226f2c4e79f30694` — P3C-1 START IMPLEMENTED AND MERGED — RETRY PRE-IMPLEMENTATION CONTRACT CLOSURE (DOCS-ONLY) — RETRY IMPLEMENTATION NOT AUTHORIZED — REMOTE CHECKS UNAVAILABLE — NOT PASS — PRODUCTION CUTOVER NOT AUTHORIZED / NOT STARTED

Current status override: main contains the merged P3C-1 Start portion from
PR #31. This docs-only candidate closes the Retry contract only; it does not
implement Retry. `run.retry` never authorizes Engine claim; Retry returns
HTTP 201 and requires a separate `run.start`. The legacy pre-remediation
status line above is SUPERSEDED / HISTORICAL - NOT CURRENT CONTRACT.

This plan decomposes M3 P3 into stages P3A, P3B-1, P3B-2A, P3B-2B,
P3C-0A, P3C-0B, P3C-1, P3D, and P3E. It is a planning artifact only: no stage below is
authorized, and no file allowlist below is an authorization to edit. Each
stage becomes executable only when explicitly authorized in a future
instruction, after the preceding stage's independent review gate is
accepted.

Companion document: `docs/implementation/milestones/M3-p3-current-state-audit.md`
(current merged main baseline `53b5fc78d5834ed3a5fd5eb1226f2c4e79f30694`).

Remediation 1 (Execution Authorization and Transaction Composition) added the
frozen atomic claim transaction (section 2), the caller-owned transaction
seam (section 3), the P3B-1/P3B-2A/P3B-2B split, the failure transaction classes,
and the nine required claim/eligibility tests.

Remediation 2 (Operation Idempotency and Seam Ownership) corrected the seam
stage ownership (sections 3–5), narrowed the P3A failure-injection scope to
Operation-only evidence, split P3C into P3C-0/P3C-1, and extended
OD-P3-05.

Remediation 3 (Retry Idempotency Ownership and Start Operation Completion
Gate) split P3C-0 into P3C-0A (Start Operation Idempotency Replay) and
P3C-0B (Retry Operation Idempotency Closure), made P3C-1 a two-portion
stage with directed dependencies, extended OD-P3-04 into a five-question
package that gates P3B-2B, froze the P3B-1 claim boundary, and split failure
class C into C1a (before claim commit), C1b (after claim and before
`run.started`), and C2 (post-start execution outcome).

Owner Decision Freeze (2026-08-04): the five P3 Owner Decision candidates
OD-P3-01 through OD-P3-05 are resolved as approved technical directions
M3-TD-26 through M3-TD-30 in
`docs/implementation/milestones/M3-owner-decisions.md`. All stage
dependencies below reference the frozen M3-TD decisions; no Owner Decision
candidate remains undecided. This approval is technical direction only —
APPROVED TECHNICAL DIRECTION — IMPLEMENTATION STILL NOT AUTHORIZED. P3 and
P3A implementation remain NOT AUTHORIZED.

Current implementation alignment: M3-TD-30 Option A is the current contract.
The present change is limited to the five Markdown files named by the Retry
pre-implementation closure. P3C-1 Retry production, P3D, and Production
Cutover remain NOT AUTHORIZED. The legacy approval wording above is
SUPERSEDED / HISTORICAL - NOT CURRENT CONTRACT.

## 1. Preconditions and Frozen Contracts

Preconditions (verified at baseline):

- P2 transaction core merged (`7a6c41710af5d4c58ef9acd6a9484b9deb341c6b`)
  and locally gated; `LifecycleTransactionService` exposes the full
  transition surface.
- Schema Migrations 001–013 are sufficient for the entire P3 scope,
  including `idempotency_records.operation` accepting `run.start`/
  `run.retry` and `http_status BETWEEN 200 AND 299`; no Migration 014 is
  planned. Any discovery that the schema is insufficient must stop the
  stage and record `SCHEMA BLOCKER — OWNER DECISION REQUIRED`.
- Current P2C transition/event alignment maps Run `starting -> failed` to a
  single `run.failed` Event, and the current `M3MultiEventOrderingContract`
  does not contain `startup-failure`. This is a P3B-2A Contract Alignment
  Gate, not a Schema Blocker. P3B-2B must not infer or implement the missing
  Stage/Run multi-event contract before P3B-2A is independently accepted.

Frozen contracts (restated; P3 must not redefine them):

- Queue Record = `runs(status='queued')`.
Current Option A execution contract: the Engine claims only a queued Run
with exactly one binding-valid queued `run.start` Operation. A queued or
completed `run.retry` never authorizes claim, never dispatches, and produces
no-op/no-authorization with no writes. A Retry Child requires a separate
Start command; Retry returns HTTP 201 and uses the dedicated schemaVersion 1
Child + completed Retry Operation replay envelope.
SUPERSEDED / HISTORICAL - NOT CURRENT CONTRACT:
- A queued Run is necessary but not sufficient for Engine execution; Engine
  claim requires a queued, binding-valid authorization Operation — type
  `run.start`, or type `run.retry` per M3-TD-30 — with exactly one valid
  non-terminal authorization Operation per Run (execution authorization, Gap
  Matrix item 20).
- `run.create` and `run.cancel` Operations never authorize an Engine claim;
  `run.retry` is never an Engine claim marker; it remains Retry metadata
  and requires a separate queued `run.start` for execution.
- Operation tracks only Task-domain Run commands; types exactly
  `run.create`, `run.start`, `run.cancel`, `run.retry`; statuses exactly
  `queued`, `running`, `waiting_approval`, `paused`, `completed`, `failed`,
  `cancelled`.
- Operation != Run; `correlationId` unique and immutable per operation.
- Create != Start; Start is asynchronous: HTTP 202 + Operation.
- Retry creates a child Run and never resets the old Run.
- Current Option A standing rule: Engine claim requires exactly one queued
  binding-valid `run.start`; `run.retry` never authorizes execution and a
  Retry Child requires a separate Start command.
- All transitions through the P2 transaction core; State/Event/Outbox in one
 transaction; no `operation_events` store.
- v2 and Legacy paths remain usable; Web default not switched; additive
  routes only.

Explicitly excluded from all P3 stages: ProcessManager, ProviderAdapter,
real CLI execution, Worktree runtime, Policy, Approval implementation,
SSE/Replay, OpenAPI completion, Web cutover, Legacy retirement, production
migration/restore/cutover, and anything M4+.

Resolved Owner Decisions that bind specific stages (frozen in
`docs/implementation/milestones/M3-owner-decisions.md`; audit section 6):
M3-TD-26 (correlationId identity, binds P3B-1 claim emission and P3C-1),
M3-TD-27 (cancel semantics, binds P3D), M3-TD-28 (progress omitted, binds
P3D), M3-TD-29 (Start Operation completion package, binds P3B-2A contract
alignment, P3B-2B terminal mapping, and P3C-1), M3-TD-30 (retry activation package, binds P3C-0B and
the P3C-1 retry portion). No Owner Decision candidate remains undecided.

## 2. Frozen Atomic Claim Transaction (Cross-Stage Constraint)

Engine claim MUST be completed inside one caller-owned outer transaction:

1. Re-read the queued run.
2. Re-read the queued, binding-valid `run.start` authorization Operation.
3. Validate workspace/run/aggregate/correlation binding.
4. Conditionally transition Operation `queued -> running`.
5. Transition Run `queued -> starting` through `LifecycleTransactionService`.
6. Append `run.dequeued` with the Start Operation correlationId.
7. Insert the corresponding Outbox row.
8. Commit all writes together, or roll back all writes.

Binding rules:

- Run and Operation are both guarded by expected status + expected version.
- Of two competing Engines, exactly one can succeed.
- The loser leaves zero partial Operation, Run, Event, or Outbox writes.
- The Engine must not copy Lifecycle Event/Outbox logic into itself; it
  composes the transaction core.
- Claim must not be simulated by two independent transactions.
- Nested transactions must not be used.
- Claim never transitions the Operation to `completed`, `failed`, or
  `cancelled`; terminal mapping is owned by the M3-TD-29-bound stages
  (P3B-2B, after the P3B-2A contract gate).

## 3. Caller-Owned Transaction Seam (Cross-Stage Constraint)

P3A delivers the Operation-side caller-owned transaction composability.
P3B-1 delivers the `LifecycleTransactionService` caller-owned transition
entry point and composes both sides into the atomic claim transaction.

Operation side (P3A):

- `OperationRepository` write methods must be transaction-scoped: they
  accept the caller's transaction handle and never open their own.
- The repository must provide a conditional status/version update (expected
  status + expected version) and a query for non-terminal Operations of a
  given run and type (used by the eligibility selector and the fail-closed
  duplicate check).
- `OperationService` must expose caller-owned-transaction-composable entry
  points; it must not force every method to open an independent
  transaction. Convenience wrappers that open a transaction are allowed,
  but the underlying operations must be able to join the caller's outer
  transaction.

Lifecycle side (P3B-1):

- `LifecycleTransactionService` gains a minimal additive caller-owned Run
  transition entry point, e.g. `transitionRunWithinTransaction`, or an
  equivalent design. This entry point must reuse the existing transition
  validation, timestamp, Event, sequence, and Outbox rules; a second
  lifecycle implementation must not be created.

## 4. Stage P3A — Operation Persistence and Lifecycle Foundation

Goal: a durable Operation aggregate on the existing Migration 012
`operations` table, with repository, service, the Operation-side
caller-owned transaction composability (section 3), and lifecycle tests.
No routes, no engine, no lifecycle-service change.

Authorized scope (when authorized):

- `OperationRepository` (insert, get by id, get by correlation id, list by
  run, non-terminal-by-run-and-type query, conditional status/version
  update; all writes transaction-scoped).
- `OperationService` (create-for-command, transition with optimistic
  locking, terminal-state enforcement, result/ApiProblem persistence;
  caller-owned-transaction-composable entry points and convenience
  transaction wrappers).
- Unit tests for both.

P3A is responsible for exactly: transaction-scoped `OperationRepository`
writes; the conditional status/version update; `OperationService`
caller-owned-transaction entry points; convenience transaction wrappers;
standalone Operation insert/update commit/rollback inside a caller's outer
transaction; stale-version concurrency.

P3A is NOT responsible for: modifying `LifecycleTransactionService`; Run
transitions; Event/Outbox append; Engine claim; any Run + Operation
cross-aggregate transaction; the Idempotency 202 contract.

Forbidden scope: routes, engine/executor, idempotency route wiring, any
change to migrations, registries, shared runtime event types, Legacy or v2
code paths, `LifecycleTransactionService`.

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/store/OperationRepository.ts` (new)
- `apps/server/src/services/OperationService.ts` (new)
- `apps/server/src/store/OperationRepository.test.ts` (new)
- `apps/server/src/services/OperationService.test.ts` (new)

Dependencies: P2 core (merged); the persistence layer applies the frozen
M3-TD-26 correlationId rule and has no undecided Owner Decision gate.

RED tests: repository/service absent — importing them fails; no writer for
`operations` exists.

GREEN tests: insert/read round-trip; identity-immutability trigger rejects
identity-field update; `correlation_id` uniqueness enforced; `correlationId = operation.id` for newly created non-create Operations (M3-TD-26); conditional
update loses cleanly on stale version; terminal states reject further
transitions; `error_json` round-trips a serialized ApiProblem; invalid
status/type rejected by CHECK; repository writes join a caller-owned
transaction and commit/roll back with it; non-terminal-by-run-and-type
query returns exactly the matching rows.

Related regressions: migration 012 suite, store-level suites, server suite.

Failure injection (Operation-only scope): throw during an Operation
insert/update inside a caller-owned outer transaction; prove that an outer
rollback rolls back the Operation write, that an outer commit commits it,
that the service never secretly opens an independent transaction, and that
`integrity_check`/`foreign_key_check` stay clean. Cross-aggregate
Operation/Run/Event/Outbox full-rollback evidence belongs only to P3B-1.
Recording `failed` on an already-accepted Operation is permitted only after
the caller classifies an irrecoverable C1a command failure and the Operation
is still queued; it is a separate, explicit failure-record transaction and
is never folded into a rolled-back transaction. C1b failure is owned by the
P3B-2B atomic failure seam, not by an Operation-only update. Evidence is
worded as "no partial lifecycle state; an accepted Operation may persist as
durable failure evidence" — never as "all Operation behavior rolls back to
zero".

Concurrency race evidence: two conditional updates at the same expected
version — exactly one succeeds.

Stop conditions: any need for a schema change; status/type vocabulary
pressure beyond the frozen sets; any route, engine, or lifecycle-service
code requested; a repository write that cannot join a caller-owned
transaction.

Rollback boundary: delete the four new files as one package; the
`operations` table and any rows are preserved (no data reset).

Independent review gate: Operation != Run upheld; identity immutability;
version discipline; no transaction-core bypass; ApiProblem shape in
`error_json`; caller-owned transaction composability demonstrated;
`LifecycleTransactionService` untouched.

Commit boundary: one ordinary commit containing only the allowlisted files,
e.g. `feat: add M3 operation persistence foundation`. Parent must be the
then-current authorized base; no amend/rebase/force-push; no PR unless
separately authorized.

P3A determinations (from the audit, binding for P3A):

- Schema is complete; only repository/service are missing — no migration
  work in P3A.
- Optimistic locking uses the existing `version` column with conditional
  UPDATE, mirroring `RunRepository.transitionLifecycleWithinTransaction`.
- `error_json` stores the serialized ApiProblem; `result_json` stores the
  `ApiOperationResult` payload.
- Operation <-> Run state mapping: the Operation is a command record; it
  does not mirror run status field-by-field. Mapping points are defined at
  the service layer only (create -> `queued`; dispatch acceptance ->
  `running`; terminal command outcome -> one of `completed`/`failed`/
  `cancelled`). `waiting_approval`/`paused` remain unused in P3A and are
  reserved.
- correlationId generation follows M3-TD-26 and is applied by P3A:
  `correlationId = operation.id` for every newly created non-create
  Operation, generated and persisted in the creation transaction. Cancel
  semantics (M3-TD-27), progress usage (M3-TD-28), start completion timing
  (M3-TD-29), and retry activation semantics (M3-TD-30) are consumed by
  later stages and remain OUT of P3A.

## 5. Stage P3B-1 — Execution-Authorized Claim and Transaction Composition

Goal: the execution-authorization eligibility selector, the atomic
Operation/Run claim, and the lifecycle-side caller-owned seam. The
transaction seam, claim, Workflow Executor, and Stage Executor must not be
delivered as one giant commit; P3B-1 is its own independent review
boundary.

P3B-1 owns the lifecycle-side seam: it delivers
`LifecycleTransactionService.transitionRunWithinTransaction` (or an
equivalent entry point), reuses the existing lifecycle validation,
timestamp, sequence, Event, and Outbox rules, composes the P3A Operation
transaction seam, completes the eight-step claim transaction (section 2),
and produces the cross-aggregate Operation/Run/Event/Outbox rollback and
competition evidence.

Option A authorization correction: the eligibility selector and all
RunEngine authorization lookups accept exactly `run.start`. A queued or
completed `run.retry` is never eligible, never transitions, and never
contributes to ambiguity; Retry-only ticks are no-op/no-authorization.

P3B-1 claim boundary (frozen): the claim performs only Operation
`queued -> running`, Run `queued -> starting`, `run.dequeued`, and the
Outbox row — atomically. P3B-1 must not transition the claimed
Operation to `completed`, `failed`, or `cancelled`.

Authorized scope (when authorized):

- Minimal additive caller-owned Run transition entry point on
  `LifecycleTransactionService` (e.g. `transitionRunWithinTransaction`;
  section 3).
- Eligibility selector: queued Run + exactly one queued, binding-valid
  `run.start` authorization Operation; zero eligible Start authorization is a
  tick no-op, and duplicate or coexisting Start authorizations fail closed.
  A queued or completed `run.retry` is ignored.
- `RunEngine` claim path composing the frozen atomic claim transaction
  (section 2); explicit test-controlled ticks only.
- Competing-claim, no-eligible-authorization no-op, and authorization
  binding tests.

Forbidden scope: Workflow/Stage execution (P3B-2B); background timers,
server startup loops, auto-scan; ProcessManager, ProviderAdapter, CLI
execution, Worktree runtime, Policy, Approval implementation; HTTP routes;
`recovery_required` writes; any scheduler table; any direct repository
writes bypassing events/outbox; nested transactions; two-transaction claim
simulation; any claimed authorization Operation terminal transition.

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/services/LifecycleTransactionService.ts` (minimal
  additive modification only)
- `apps/server/src/services/m3-p3b1-execution-authorized-claim.test.ts` (new;
  exact final proposal for the seam/claim targeted tests, following the
  phase-named convention evidenced by
  `apps/server/src/services/m3-p2c2a-lifecycle-transaction.test.ts` and
  `apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`; an
  equivalent evidence-backed targeted test path is acceptable only if the
  exact final path is stated in the stage execution record)
- `apps/server/src/store/OperationRepository.ts` (minimal additive
  claim-support only when evidence shows it is strictly necessary)
- `apps/server/src/store/OperationRepository.test.ts` (additive cases only)
- `apps/server/src/services/OperationService.ts` (minimal additive
  claim-support only when evidence shows it is strictly necessary)
- `apps/server/src/services/OperationService.test.ts` (additive cases only)
- `apps/server/src/services/run-engine/RunEngine.ts` (new)
- `apps/server/src/services/run-engine/RunEngine.test.ts` (new)

Dependencies: P3A accepted; M3-TD-26 applied (`correlationId = operation.id`)
before the claim event is emitted.

RED tests: no eligibility selector, no claim path, no caller-owned seam;
a queued run is never advanced.

GREEN tests (the nine required claim/eligibility proofs):

1. A queued Run without any eligible authorization Operation: repeated
   Engine ticks leave it `queued`; no `run.dequeued`; no new Outbox row.
2. A `run.create` Operation does not authorize claim.
3. Queued run + queued `run.start` Operation: the run can be claimed;
   Operation and Run change in the same transaction; the `run.dequeued`
   event carries the Operation correlationId.
4. Competing Engine claims: exactly one winner; the loser leaves zero
   partial writes.
5. Duplicate or coexisting active (non-terminal) `run.start` Operations for
   one run: fail closed, no arbitrary choice; Retry is not selected.
6. Operation transition failure during claim: Run/Event/Outbox writes all
   roll back.
7. Run/Event/Outbox failure during claim: the Operation transition rolls
   back.
8. Queued run + queued or completed `run.retry` Operation without Start:
   repeated ticks remain no-op with zero claim writes. With a separate
   queued `run.start`, only Start changes with the Run in the same
   transaction; `run.dequeued` carries the Start correlationId.
9. P3B-1 registers no background loop and no wall-clock timer.

Related regressions: LifecycleTransactionService suites, P2C-2A/P2C-2B
suites, RunRepository/RunStageRepository suites, Operation suites,
migration suites.

Failure injection: class B (claim) semantics — inject at each step of the
frozen claim transaction (section 2); every injection rolls back all of
Operation/Run/Event/Outbox; integrity checks clean; no partial lifecycle
state.

Concurrency race evidence: competing claims with identical expected
status/version — exactly one commits; duplicate or coexisting active
authorization Operation detection under concurrency fails closed.

Stop conditions: eligibility evaluated without Operation binding; an
arbitrary Operation selected; `run.retry` accepted as authorization; a
background loop, timer, or scheduler table requested;
claim simulated by two transactions; nested transactions; executor scope
requested; a claimed authorization Operation terminal transition requested.

Rollback boundary: revert the seam modification and the run-engine package
as one package; runs, Operations, events, and outbox rows are preserved
(no data reset).

Independent review gate: single-writer ownership of execution-authorized
queued Runs; transaction core exclusivity; the seam reuses existing
lifecycle rules (no second implementation); all nine GREEN proofs; no
timers; the claim boundary (no terminal Operation transition) upheld.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 execution-authorized claim and transaction composition`.

## 6. Stage P3B-2A — Startup Failure Event Contract Alignment

Goal: align and freeze the Shared, Runtime Specification, Transition/Event
Matrix, and multi-event ordering contract required by C1b. This stage is
specification/shared contract alignment only; it does not implement the
Engine, Workflow Executor, Stage Executor, Lifecycle transaction seam,
Operation terminal transition, Server Runtime, Migration, Registry, API, or
Web behavior.

Current contract facts:

- The current P2C Transition/Event Matrix defines Run `starting -> failed`
  with one Primary Event, `run.failed`, and no Additional Event.
- The current `M3MultiEventOrderingContract` does not contain the ordering
  name `startup-failure`.
- Consequently the C1b Stage-starting combination is not yet registered in
  the Shared/Specification layer. P3B-2B must not infer or bypass it.
- This is a Contract Alignment Gate, not a Schema Blocker; Migration 014 is
  neither required nor authorized.

Frozen contract to align and verify:

Branch A — Stage has entered `starting`:

- Multi-event ordering name: `startup-failure`.
- Exact Event order: `stage.failed -> run.failed`.
- `stageMultiplicity=single`.
- `stageOrdering=none`.
- `contiguousRunSequence=true`.
- `independentOutboxPerEvent=true`.
- `atomicCurrentStateEventOutbox=true`.

Branch B — no Stage has entered `starting`:

- Run `starting -> failed`.
- Primary Event: `run.failed`.
- Additional Event: none.
- `stage.failed` must not be fabricated.

Operation `running -> failed` may join the same caller-owned outer
transaction, but Operation produces no Runtime Event and therefore does not
alter the Runtime Event ordering. Both branches remain distinct from user
cancellation, which follows M3-TD-27 and is not C1a/C1b.

Future proposed allowlist (specification/shared alignment only):

```text
agentos/packages/shared/src/types/m3-lifecycle-transition-contracts.ts
agentos/packages/shared/m3-runtime.test.ts
agentos/docs/Runtime-Specification/02-Runtime-Lifecycle.md
agentos/docs/Runtime-Specification/03-Event-Model.md
agentos/docs/implementation/milestones/M3-p2c-transition-event-matrix.md
```

No Server Runtime, Migration, Registry, API, or Web file belongs to P3B-2A.

Dependencies: P3B-1 accepted. P3B-2A is independently reviewed before
P3B-2B can begin; this dependency graph does not authorize implementation
or parallel work.

RED/GREEN contract evidence: the current ordering registry rejects
`startup-failure`; the future alignment tests register and validate both
branches, exact order, multiplicity, ordering, contiguous sequence,
independent Outbox, and atomic Current State/Event/Outbox attributes; the
Branch B single `run.failed` contract remains unchanged.

Stop conditions: any request for Server Runtime, Engine/Executor,
Lifecycle/Operation implementation, Migration 014, Registry/API/Web work,
or any attempt to let P3B-2B implement the Branch A combination before
independent acceptance.

Rollback boundary: revert the five specification/shared alignment files as
one docs-and-contract package; no runtime data or production database is
changed.

Independent review gate: Shared types, Runtime Specifications, Transition/
Event Matrix, and `M3MultiEventOrderingContract` agree exactly; Branch A
and Branch B are both covered; no M3-TD-01..25 historical wording is
rewritten; no implementation authorization is implied.

Commit boundary: one ordinary docs/specification/shared-contract commit,
only the proposed allowlist, e.g. `feat: align M3 startup failure event
contract`.

## 7. Stage P3B-2B — Deterministic Workflow and Atomic Startup Outcomes

Goal: deterministic workflow graph traversal, stage orchestration, and the
deterministic mock Stage Executor with completion/failure/skip behavior,
including the atomic startup-completion transaction that closes a claimed
Start or Retry Operation.

Authorized scope (when authorized):

- `WorkflowExecutor` (deterministic `dependsOn` traversal from the
  persisted run snapshot V2).
- `StageExecutor` (mock stage runner seam; stage lifecycle via
  `transitionStage`; `skipped` propagation on failure/cancel per spec).
- Engine dispatch integration on top of the P3B-1 claim.
- Start Operation terminal mapping strictly per M3-TD-29.
- Minimal additive caller-owned completion seam on
  `LifecycleTransactionService`: `completeRunStartupWithinTransaction` or
  an equivalent seam. The existing `completeRunStartup()` convenience
  wrapper may remain, but it must reuse this seam.
- Minimal additive caller-owned failure seam on
  `LifecycleTransactionService`: `failRunStartupWithinTransaction` or an
  equivalent seam. It must reuse the same Stage/Run/Event/Outbox rules and
  must not copy a second lifecycle implementation.
- Minimal additive Operation transaction composition through the P3A
  `OperationService` and `OperationRepository` seams, only as required to
  complete or fail the Operation inside the same outer transaction.
- Unit/integration tests with an injected transaction core.

Forbidden scope: everything forbidden in P3B-1; additionally any change to
the claim transaction or eligibility selector (owned by P3B-1), any
Operation Cancel implementation or race (owned by P3D), and any
Start Operation terminal mapping deviating from M3-TD-29; any modification
to Shared Contract, Runtime Specification, or Transition/Event Matrix
files; or any runtime implementation before P3B-2A is accepted.

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/services/run-engine/WorkflowExecutor.ts` (new)
- `apps/server/src/services/run-engine/StageExecutor.ts` (new)
- `apps/server/src/services/run-engine/RunEngine.ts` (additive dispatch
  integration only)
- `apps/server/src/services/LifecycleTransactionService.ts` (minimal
  additive caller-owned completion seam only)
- `apps/server/src/services/OperationService.ts` (minimal additive
  transaction-composition support only)
- `apps/server/src/store/OperationRepository.ts` (minimal additive
  transaction-composition support only)
- `apps/server/src/services/m3-p3b2-atomic-startup-completion.test.ts` (new;
  exact targeted completion-atomicity proposal)
- `apps/server/src/services/run-engine/*.test.ts` (new, additive)

Option A test correction: P3B-2B startup completion is driven by an
independent queued `run.start`. A completed v3 `run.retry` remains immutable
and is not selected by claim or dispatch; Retry-only cases are covered by
RunEngine no-op tests.

Dependencies: P3B-1 and P3B-2A independent reviews accepted; the atomic
startup completion/failure mappings follow M3-TD-29 for `run.start`. A
completed v3 `run.retry` remains immutable and is not part of startup
completion or Engine dispatch.

RED tests: no executor exists; a claimed run has no stage progress.

GREEN tests: executor honors `dependsOn` order exactly; failure marks
downstream stages `skipped` per spec; ordinary transitions emit Event +
Outbox in the same transaction. Any cancellation boundary is consumed from
the P3D-owned M3-TD-27 path and is not implemented here. The
startup-completion targeted test
`m3-p3b2-atomic-startup-completion.test.ts` proves:

The successful path leaves Operation `completed`, Run `running`, and the
first startup Stage `running`, with no committed Run=`running` /
Operation=`running` intermediate state. The same targeted test proves:

1. Transaction-attempt injection failure rolls back completely and does not
   automatically mark the Operation `failed`.
2. C1b with a Stage already `starting` leaves Stage=`failed`, Run=`failed`,
   Operation=`failed`, with complete Events and Outbox rows in one
   transaction.
3. Failure before the Stage enters `starting` emits no fabricated Stage
   Event and fails Run and Operation together.
4. Operation failure write failure rolls back Stage/Run/Event/Outbox.
5. Stage/Run/Event/Outbox failure rolls back Operation failure.
6. Stale-version startup success/failure race has exactly one winner.
7. `run.start` uses the failure seam; a completed `run.retry` remains
   unchanged.
8. No committed state exists with Run=`failed` + Operation=`running` or
   Run=`starting` + Operation=`failed`.

The exact twelve-step startup-completion sequence is:

1. Re-read and validate the claimed Operation: type `run.start`, status
   `running`, expected version, and valid bindings.
2. Re-read and validate the Run at status `starting` and its expected
   version.
3. Re-read and validate the first startup Stage at status `starting` and
   its expected version.
4. Transition the Stage `starting -> running`.
5. Append `stage.started`.
6. Insert the Stage Outbox row.
7. Transition the Run `starting -> running`.
8. Append `run.started`.
9. Insert the Run Outbox row.
10. Transition the Operation `running -> completed`.
11. Write `resourceType = "run"`, `resourceId = runId`, omit `data`, and
    set `completedAt` from the same transaction timestamp.
12. Commit all writes together; any failure rolls back all state, Event,
    Outbox, and Operation writes. Operation completion creates no
    independent Runtime Event or `operation_events` row.

Start Operation terminal mapping tests (single approved direction per
M3-TD-29):

- The Start Operation completes when the Run commits `run.started`; a later
  Run failure or cancellation does not rewrite the completed Operation.
- REJECTED alternative: "Start Operation tracks the Run to terminal" — a
  later terminal outcome updating the Operation is not implemented.

Related regressions: LifecycleTransactionService suites, P2C-2A/P2C-2B
suites, P3B-1 claim tests, migration suites.

Failure injection covers both caller-owned seams. A transaction-attempt
failure (injection, SQLite error, version conflict, or concurrency loss)
rolls back to the transaction's starting state and does not automatically
mark an Operation `failed`; the caller classifies retry, competition loss,
or business failure. C1a covers failure before claim commit: Class B rolls
back Run/Operation/Event/Outbox and leaves Run/Operation queued with no
`run.dequeued` partial write. Only an explicitly classified irrecoverable
command failure may use a separate expected status/version-guarded
transaction to mark the still-queued Operation `failed`; it persists the
serialized ApiProblem, leaves `result` absent, uses the same transaction
timestamp for `completedAt`, leaves the Run unchanged, and writes no
Runtime Event or Outbox row. C1b covers failure after claim and before
`run.started`: with a starting Stage, Stage/Run/Operation failure and both
failure Events/Outbox rows commit atomically; before a Stage enters
`starting`, no `stage.failed` is fabricated and Run/Operation failure still
commits together. Inject at every Stage/Run/Event/Outbox/Operation position;
assert zero partial commits, integrity checks clean, and no committed
Run=`failed` + Operation=`running` or Run=`starting` + Operation=`failed`.
Post-start execution outcomes follow class C2 per M3-TD-29 — post-start
outcomes never rewrite the completed Start Operation; the completed Retry
Operation is likewise unchanged.

Concurrency evidence: stale-version startup success/failure dispatch loss;
losers fail cleanly with no state corruption, and transaction-attempt
rollback is not recorded as business failure. All cancel races belong to
P3D.

Stop conditions: executor needs any M4 surface; engine bypasses the
transaction core; claim logic modified; engine writes `recovery_required`;
the success or failure seam duplicates Stage/Run/Event/Outbox logic;
startup success/failure is split across transactions; transaction-attempt
rollback automatically marks an Operation failed; or any deviation from
the M3-TD-29 terminal mapping for a Start or Retry Operation.

Rollback boundary: revert the executor package and minimal completion seam
as one package; claim composition (P3B-1) stays; runs, events, Operations,
and Outbox rows are preserved (no data reset).

Independent review gate: determinism proof; skip propagation; no M4
imports; P3B-1 boundary respected; caller-owned success and failure seams
reuse the transaction core; twelve-step success and C1a/C1b rollback proofs
pass; Start and Retry composition match M3-TD-29/M3-TD-30 exactly; no
committed invalid intermediate state.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 deterministic workflow and stage execution`.

P3B requirements (binding for P3B-1 and P3B-2B; P3B-2A is the separate
contract gate):

- The engine claims only `runs(status='queued')` that have exactly one
  execution authorization: a queued, binding-valid `run.start` Operation.
- A queued or completed `run.retry` never authorizes or dispatches a Run;
  Retry execution requires a separate queued `run.start`.
- Every state write goes through `LifecycleTransactionService`.
- The executor is deterministic and mock-driven; no CLI, no ProcessManager.
- Tick-driven: work advances on explicit ticks (test-controlled), not on
  wall-clock timers inside tests.
- Claim, dispatch, and outcome recording each carry injection points and
  concurrency guards.

## 8. Stage P3C-0A — Start Operation Idempotency Replay

Goal: without adding routes, creating Operations, or starting runs, make
the existing Idempotency layer able to durably store and canonically replay
the `run.start` Operation command response.

Authorized scope (when authorized):

- Backward-compatible schemaVersion 1 extension of the idempotency
  contract: a stable Operation replay DTO and a new Operation Result
  Envelope variant.
- `run.start` registered as a TypeScript idempotency operation with HTTP
  202 support across prepare/resolve/storeSuccess, repository insert/read,
  and canonical replay.
- Unit tests for the contract, service, and repository.

Forbidden scope: any Migration, Registry, Route, `TaskRunService`, or Web
change; creating Operations; starting runs; a result schema version 2; any
database change; enabling a `run.retry` consumer; freezing the final
`run.retry` HTTP status.

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/idempotency/types.ts` (extend in place)
- `apps/server/src/services/IdempotencyService.ts` (extend in place)
- `apps/server/src/store/IdempotencyRepository.ts` (extend in place)
- `apps/server/src/services/IdempotencyService.test.ts` (additive cases)
- `apps/server/src/store/IdempotencyRepository.test.ts` (additive cases)

If implementation evidence shows an additional targeted test is required,
exactly one new file is permitted, with this exact path:
`apps/server/src/idempotency/types.test.ts`. No other addition is allowed.

Frozen design:

- Backward-compatible schemaVersion 1 extension; no result schema version
  2; no database change.
- New stable Operation replay DTO; new Operation Result Envelope variant.
- The replay snapshot must contain the stable fields required to
  reconstruct the original `ApiOperation` response.
- Replay must not re-read the current Operation and construct a new
  response.
- Replay must return the original saved HTTP status and the original
  Operation snapshot.
- The replay snapshot is the acceptance-time immutable queued Operation
  snapshot (M3-TD-29).
- Canonical JSON and the result hash continue to cover the complete
  envelope.
- The parser must be exact-shape and fail-closed.
- Legacy Task/Run envelopes continue to parse verbatim.

`run.start` is frozen as: `run.start -> HTTP 202 + Operation Result
Envelope`, supported across prepare, resolve, storeSuccess, repository
insert/read, and canonical replay.

Dependencies: P3A accepted (the idempotency layer joins caller-owned
transactions through the same seam discipline). P3C-0A does not depend on
M3-TD-30.

RED tests: `run.start` is not a registered idempotency operation; 202 is
rejected; no Operation envelope variant exists; replay of an Operation
response is impossible.

GREEN tests (the twelve required proofs):

1. `run.start` 202 Operation envelope round-trip.
2. Repository persists and returns the original 202.
3. Replay returns the original Operation snapshot.
4. Later Operation state changes do not affect the saved replay.
5. Canonical JSON/hash stable across save and replay.
6. Tampered result JSON/hash rejected.
7. Wrong operation/envelope pair rejected.
8. Wrong operation/http-status pair rejected.
9. Legacy 6 operations keep their original HTTP statuses.
10. All legacy Task/Run envelopes continue to parse.
11. Unknown envelope variant fails closed.
12. Repository/service can join a caller-owned transaction.

Related regressions: idempotency suites, v2 idempotency route suites,
migration suites, full server suite.

Failure injection: throw during a record insert/update inside a
caller-owned outer transaction; outer rollback rolls back the record write;
outer commit commits it; integrity checks clean.

Concurrency race evidence: concurrent `storeSuccess` for the same key —
exactly one insert wins; the loser resolves to the stored record.

Stop conditions: a route, Operation creation, or run start appears; a
database or schema-version change appears; replay re-reads the current
Operation; a legacy envelope or status changes; any `run.retry` work
appears (owned by P3C-0B).

Rollback boundary: revert the five modified files (plus the at-most-one new
test file) as one package; stored idempotency rows are preserved; legacy
envelopes unaffected.

Independent review gate: legacy verbatim compatibility; no DB change;
fail-closed parser; immutable snapshot; 202 support limited to `run.start`.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 start operation idempotency replay`.

## 9. Stage P3C-0B — Retry Operation Idempotency Closure

Goal: close the `run.retry` idempotency contract exactly per M3-TD-30, as
its own commit and independent review boundary.

Authorized scope (when authorized):

- Register `run.retry` as a TypeScript idempotency operation.
- Establish the M3-TD-30 Option A HTTP status mapping: `run.retry -> HTTP 201`.
- Establish the dedicated schemaVersion 1 immutable replay envelope:
  `body.run` is the acceptance-time queued Child Run snapshot and
  `body.operation` is the acceptance-time completed v3 Retry Operation
  snapshot. Replay never re-reads current state.
- Repository insert/read, service store/resolve, and canonical JSON/hash
  support; parser exact-shape and fail-closed; same-key replay returns the
  original status and the original snapshot without re-reading the current
  Child Run or Operation.
- Unit tests mirroring the P3C-0A proofs for the approved retry shape.

Forbidden scope: any Migration, Registry, Route, `TaskRunService`, or
Operation-implementation change; a result schema version 2; any database
change; any change to legacy operation/envelope behavior; any deviation
from the M3-TD-30 shape.

Exact proposed file allowlist (proposal, not authorization): the same
idempotency files as P3C-0A —

- `apps/server/src/idempotency/types.ts` (extend in place)
- `apps/server/src/services/IdempotencyService.ts` (extend in place)
- `apps/server/src/store/IdempotencyRepository.ts` (extend in place)
- `apps/server/src/services/IdempotencyService.test.ts` (additive cases)
- `apps/server/src/store/IdempotencyRepository.test.ts` (additive cases)
- plus, only if evidence requires it, the same single optional file
  `apps/server/src/idempotency/types.test.ts` (additive cases).

Dependencies: M3-TD-30 (approved); P3C-0A accepted (shared contract
discipline).

RED tests: `run.retry` is not a registered idempotency operation; no retry
replay envelope exists.

GREEN tests: `run.retry` round-trip at the Option A-frozen HTTP 201 status
with the dedicated queued Child + completed v3 Retry Operation envelope;
same key + same hash returns the original 201; same key + different hash returns 409;
repository persists and returns the original status; replay returns the
original snapshot; later Child Run or Operation state changes do not affect
the saved replay; canonical JSON/hash stable; tampered result rejected;
wrong operation/envelope and operation/status pairs rejected; legacy
behavior unchanged; caller-owned transaction join.

Related regressions: idempotency suites, P3C-0A replay tests, full server
suite.

Failure injection: same discipline as P3C-0A (caller-owned outer
transaction; rollback/commit fidelity; integrity checks clean).

Concurrency race evidence: same-key concurrent `storeSuccess` — exactly one
insert wins.

Stop conditions: the M3-TD-30 shape is deviated from; a combined Child Run
Operation envelope is introduced; any route or Operation-implementation
change is requested.

Rollback boundary: revert the additive retry registration as one package;
stored rows preserved.

Independent review gate: exact match to the Option A shape; fail-closed
parser; immutable dual snapshot; legacy compatibility; no DB change.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 retry operation idempotency closure`.

## 10. Stage P3C-1 — Async Start and Child Retry

Goal: the asynchronous Start contract and retry-as-child-run, all
idempotent. P3C-1 has two
independently enterable dependent portions:

- Start portion: depends on P3C-0A (not on P3C-0B).
- Retry portion: depends on M3-TD-30 and P3C-0B, and must not modify the
  idempotency core files itself.

### P3C-1 Start pre-implementation blocker closure (docs-only)

> **SUPERSEDED / HISTORICAL — NOT CURRENT IMPLEMENTATION STATUS.** This
> section records the earlier Start contract closure. The Start Route and A1
> consumer are now implemented and merged in PR #31. The current Retry
> contract is §10.1 below; Retry production remains unauthorized.

The following contract is frozen for the future Start portion. This closure
does not implement or authorize a Start route, a Retry route, or any other
P3C-1 production flow.

#### Canonical Run workspace resolution

The canonical route remains exactly `POST /api/runs/:runId/start`; no
`workspaceId` path, query, or body field is added. Run IDs are global opaque
routing identifiers. The future implementation adds only the following
read-only `RunRepository` locator:

```ts
findWorkspaceIdByOpaqueId(runId: string): string | undefined
```

The locator returns only the owning workspace ID. It does not return Run or
Workspace data, inspect status/version, or mutate state. It is routing
resolution, not a Run domain guard. A missing Run returns `404 RUN_NOT_FOUND`,
never `WORKSPACE_NOT_FOUND` from the canonical Start route. After resolution,
the workspace ID is included in the Idempotency fingerprint and all Run,
Operation, and Idempotency reads and writes remain workspace-scoped. No global
unscoped mutation is allowed. The current Local API Write Guard and Server
Ownership remain the security boundary; multi-user, remote, or workspace-
principal access requires a new opaque-lookup review.

#### SQLite contention

After production `DatabaseSync` creation and before migrations, `SqliteStore`
executes `PRAGMA busy_timeout = 5000`; `PRAGMA foreign_keys = ON` remains
enabled. Normal same-key, different-key, and no-key Start races must converge
to live `202`, replay `202`, or a stable `409` Start conflict. Raw
`SQLITE_BUSY`, SQLite messages, SQL, database paths, and lock details never
reach clients. Timeout exhaustion for a human-held write lock uses only:

```text
code: RUN_START_BUSY
status: 503
message: Run start is temporarily unavailable
retryable: true
```

Normal race tests must not use 503 as an expected winner/loser result. The
generic `Transaction.ts` contract and existing v2 mutation behavior remain
unchanged.

#### Complete Start Operation history

Start acceptance reads `OperationService.listByRun(workspaceId, runId)` and
filters `type === 'run.start'`; `listNonTerminalByRunAndType()` alone is not
enough. The exact matrix is:

- no Start history: create is allowed;
- all history is `failed`/`cancelled`: create is allowed;
- one `queued` Start: same-key replay wins and returns the original `202`;
  different-key or no-key requests return `409 RUN_START_ALREADY_ACTIVE`;
- multiple non-terminal Starts: `500 RUN_START_AUTHORIZATION_AMBIGUOUS`;
- queued Run plus `running`, `waiting_approval`, or `paused` Start history, or
  any `completed` Start history: `500 RUN_START_STATE_INCONSISTENT`;
- `failed`/`cancelled` history is terminal and is not active authorization;
- no arbitrary Start Operation selection is permitted.

#### A1 ordering, side effects, rollback, and route/service composition

The keyed A1 acceptance order is frozen without omitted or implicit steps:

1. Read the opaque `runId` from the canonical path.
2. Call the read-only `RunRepository.findWorkspaceIdByOpaqueId(runId)` locator.
3. If the locator finds no Run, return `404 RUN_NOT_FOUND`.
4. Validate that the request body is a plain JSON object.
5. Reject every unknown body field.
6. Validate optional `expectedVersion`: it may be absent; when present it must
   be a positive safe integer; `null`, zero, negative, fractional, string,
   `NaN`, and values outside the safe-integer range return the stable
   `400 VALIDATION_FAILED`.
7. Parse and normalize the optional `Idempotency-Key`.
8. Construct the fingerprint with `operation = run.start`, the locator's
   `workspaceId`, `pathParams = { runId }`, `domainInput = {}`, and
   `expectedVersion` supplied or `null`.
9. Call `IdempotencyService.prepare()` outside the transaction.
10. Begin the caller-owned `BEGIN IMMEDIATE` transaction.
11. Make `IdempotencyService.resolve()` the first Run/Operation domain action
    inside the transaction.
12. If resolve returns replay, do not read the current Run or Operation, do not
    execute version/status/Start-history guards, and immediately return the
    saved original HTTP 202 queued Operation snapshot.
13. On a miss, read the workspace-scoped Run.
14. If the Run is absent, return `404 RUN_NOT_FOUND`.
15. If supplied, execute the exact `expectedVersion` guard.
16. Require the Run status to be `queued`.
17. Read complete history with
    `OperationService.listByRun(workspaceId, runId)`.
18. Filter the history to `type === 'run.start'`.
19. Apply the complete frozen Start-history matrix.
20. Call `OperationService.createWithinTransaction()` to create the unique
    queued `run.start` Operation.
21. Validate the new Operation: `type = run.start`, `status = queued`, the
    resolved workspace, `aggregateType = run`, `aggregateId = runId`, the
    correct `runId`, `correlationId = operation.id`, and `version = 1`.
22. Construct the schemaVersion 1 Operation replay envelope.
23. Call `IdempotencyService.storeSuccess()` with HTTP status 202 and the
    acceptance-time original queued Operation snapshot.
24. Commit.
25. Only after a successful commit return HTTP 202 with top-level
    `{ "operation": ... }`; the internal result is `replayed = false`.

The no-key order is separately frozen:

1. Read the opaque `runId` from the canonical path.
2. Resolve the workspace with the read-only locator.
3. If the locator finds no Run, return `404 RUN_NOT_FOUND`.
4. Validate the body, reject unknown fields, and validate optional
   `expectedVersion`.
5. Begin the caller-owned `BEGIN IMMEDIATE` transaction.
6. Read the workspace-scoped Run.
7. Apply the optional `expectedVersion` guard.
8. Require the Run status to be `queued`.
9. Read complete history through `OperationService.listByRun()`.
10. Apply the complete frozen Start-history matrix.
11. Create the queued Start Operation with
    `OperationService.createWithinTransaction()`.
12. Commit.
13. Return HTTP 202 with `{ "operation": ... }`.

The no-key path creates no Idempotency Record and does not set
`Idempotency-Replayed`.

No Run/Operation domain guard may run between `prepare()` and `BEGIN IMMEDIATE`.
The locator is routing resolution only; it is not a Run status/version guard.

A1 Acceptance never mutates Run status or version, mutates Task, writes
`run.dequeued`, writes any Runtime Event, writes Outbox or Dead Letter rows,
calls `RunEngine.tick()` or `RunEngine.dispatch()`, calls WorkflowExecutor or
StageExecutor, starts a Provider or subprocess, waits synchronously for
`starting`/`running`, changes the Start Operation to `running`/`completed`,
triggers Retry, or creates Migration 014. After successful acceptance the Run
is still `queued` at the same version, the Start Operation is `queued` at
version 1, Task is unchanged, and no Runtime Event or Outbox row is added.

Any failure after Operation insert and before Commit rolls back the new Start
Operation and Idempotency Success Record, leaving the Run queued at the same
version, Task unchanged, and with no new Runtime Event or Outbox row.

`runLifecycle.ts` creates IdempotencyService through the existing
`createOptionalIdempotencyService(store)` pattern and creates a route-local
TaskRunService with that service. `index.ts` adds one `/api` mount only; it
does not reuse the no-Idempotency TaskRunService instance used by Legacy
recovery. Run deletion and workspace migration are outside M3 and require a
new replay/locator review if introduced.

Authorized scope (when authorized):

- Start route returning HTTP 202 + Operation (additive; v2/Legacy
  untouched). The route runs the Start acceptance transaction (class A1):
  it atomically commits the queued `run.start` Operation and the
  Idempotency success/replay response, using the P3C-0A `run.start` + 202 +
  immutable Operation replay envelope. It does not start the run and does
  not write `run.dequeued`; Engine eligibility begins only after this
  commit.
- `run.start` consumer wired through `IdempotencyService` (Start portion).
  The future Retry portion consumes the P3C-0B HTTP 201 dual snapshot and
  creates a queued Child; it does not grant Engine authorization.
- Retry service path creating child runs via `RunRepository.insert`
  lineage. Retry is accepted only when the Parent Run is `failed` at the
  expected Parent version. Parent `queued`, `starting`, `running`,
  `waiting_approval`, `paused`, `completed`, or `cancelled` returns stable
  409 `RUN_NOT_RETRYABLE`; stale expected version returns a stable conflict
  with zero side effects. Same-key replay returns the original response;
  concurrent different-key Retry requests can create only one valid Child.
  Per M3-TD-30 Option A the Retry acceptance transaction (class A2) atomically
 creates the Child Run and lineage, Snapshot, Child Run graph/stages,
  Current Option A behavior: the acceptance transaction completes the v3
  Retry Operation, keeps the Child queued, and requires a separate
  `run.start` for Engine execution. Retry never dispatches the Child.
  The pre-remediation authorization wording in the following lines is
  SUPERSEDED / HISTORICAL - NOT CURRENT CONTRACT.
  queued `run.retry` Operation, Idempotency success/replay record, and all
  creation Event/Outbox rows; the queued `run.retry` Operation immediately
  authorizes Engine execution — no separate Start command is required, and
  the Parent Run is never reset or modified.
- Creation Event correlation remains the P2C-2C-1 contract: the Retry
  Operation uses `correlationId = operation.id`; Child Run `run.created` and
  every `stage.created` use `correlationId = childRun.id`;
  `stage.created.causationId` and `parentEventId` continue to point to the
 `run.created` Event ID; callers cannot override Creation Event
  correlationId. Later Child execution Events use the independent Start
  Operation ID, never the completed Retry Operation ID.
- Route and race tests.

Forbidden scope: synchronous start execution in the route handler;
resetting/mutating the parent run on retry; replacing v2 or Legacy
collections; Web changes; Operation cancel route (P3D); event query route
(P3D); granting Engine eligibility to `run.create`/`run.cancel`
Operations; accepting Retry for a non-failed Parent; any change to the
idempotency core files
(`apps/server/src/idempotency/types.ts`,
`apps/server/src/services/IdempotencyService.ts`,
`apps/server/src/store/IdempotencyRepository.ts` and their tests), which
are owned by P3C-0A/P3C-0B.

Exact future Start implementation allowlist (proposal, not authorization):

- `apps/server/src/routes/runLifecycle.ts` (new)
- `apps/server/src/routes/runLifecycle.test.ts` (new)
- `apps/server/src/services/TaskRunService.ts`
- `apps/server/src/services/TaskRunService.test.ts`
- `apps/server/src/store/SqliteStore.ts`
- `apps/server/src/store/RunRepository.ts`
- `apps/server/src/store/__tests__/RunRepository.test.ts`
- `apps/server/src/index.ts` (one additive `/api` mount line)

Existing `routes/v2Idempotency.ts`, `OperationService.ts`,
`OperationRepository.ts`, Idempotency Core, and Shared may be imported but are
not modified. Retry production implementation, Operation Cancel, Event Query/
SSE, `RunEngine/**`, `LifecycleTransactionService.ts`,
`RunStageRepository.ts`, Migration/Registry, Web, package/lockfiles, Legacy or
v2 routes, Conversation EventBus, and Production Cutover remain forbidden.

Dependencies: P3A accepted; P3B-1 accepted; Start portion: P3C-0A accepted,
M3-TD-26 and M3-TD-29 applied; Retry portion: additionally P3C-0B accepted,
per M3-TD-30.

RED tests: no start route; no `run.start`/`run.retry` idempotency consumer;
no retry caller.

Option A Retry acceptance tests must instead prove HTTP 201, queued Child
metadata, completed v3 Retry Operation, immutable dedicated replay, and
no Engine eligibility until a separate queued `run.start`. Any historical
statement below that makes queued `run.retry` immediately eligible is
SUPERSEDED / HISTORICAL - NOT CURRENT CONTRACT.
GREEN tests: start returns 202 with an Operation; the acceptance
transaction commits Operation + idempotency success atomically via the
P3C-0A envelope; the run remains queued until the engine claims it; same
idempotency key replays the original Operation (original 202 and original
snapshot); different key on an already-started run is rejected per
contract; retry creates a child run with correct
`root_run_id`/`parent_run_id` and the old run untouched; the retry child remains
queued and requires a separate `run.start` for Engine authorization per
M3-TD-30. Retry never dispatches the Child. Retry tests also prove failed-Parent
eligibility, stable `RUN_NOT_RETRYABLE` for every non-failed Parent status,
stale-version zero side effects, one winner under concurrent Retry, exact
creation-versus-execution correlation, and exclusion of creation Events from
the Operation Events query.

Related regressions: v2 route suites, idempotency suites, TaskRunService
suites, P3B-1 claim tests, P3C-0A replay tests, full server suite. Operation
Cancel and all cancel-race regressions belong exclusively to P3D.

Failure injection (distinct transaction classes):

- Class A1 (Start acceptance): inject between the queued `run.start`
  Operation insert and the Idempotency success write — no Start Operation,
  no Idempotency Success, and the existing Run stays queued.
- Class A2 (Retry acceptance): inject at Child Run insert, Snapshot insert,
  Stage insert, `run.created`, any `stage.created`, any Outbox insert,
  Retry Operation insert, and Idempotency Success. Every injection leaves:
  no Child Run, no Snapshot, no Stage, no Creation Event, no Outbox, no
  Retry Operation, and no Idempotency Success; the Parent Run is unchanged.
Acceptance failure injection in P3C-1 is limited to A1 and A2. Claim,
startup success/failure, post-start C2, and all cancellation failure/race
semantics are owned by P3B-1, P3B-2B, and P3D respectively; P3C-1 does not
restate or implement those seams.

Concurrency race evidence (race matrix, all required):

| Race | Expected outcome |
|------|------------------|
| Start vs start (same idempotency key) | Replay of the original Operation; no second transition |
| Start vs start (different key, run already started) | Contract rejection (409-class), no state change |
| Retry vs Parent failure transition | A request observing expected `failed` + version can create one Child; a request observing non-`failed` or a stale version has zero side effects and returns the stable conflict |
| Stale version acceptance | Conditional idempotency/Parent-version update loses; no overwrite or second Child |
| Terminal immutability | Any transition out of a terminal state fails |
| Partial acceptance commit | None observed under A1/A2 injection at any acceptance position |

Stop conditions: any synchronous execution in the route; any parent-run
mutation on retry; any deviation from M3-TD-26, M3-TD-29, or M3-TD-30 when
the dependent code is reached; acceptance transaction writing lifecycle
events;
any edit to the idempotency core files owned by P3C-0A/P3C-0B; enabling the
`run.retry` consumer without P3C-0B.

Rollback boundary: revert route + wiring as one package; operations, runs,
events preserved (no data reset).

Independent review gate: Create != Start; 202 contract; A1/A2 acceptance
atomicity and rollback; idempotent replay via the P3C-0A/P3C-0B envelopes;
Start-vs-start and Retry/Parent race evidence; failed-Parent retry lineage;
creation-versus-execution correlation boundary; Operation Events exclusion;
Start/Retry portion dependencies and the M3-TD-30 retry activation contract
respected. Operation Cancel and every Cancel race remain P3D-owned.

Commit boundary: ordinary commits per portion, only allowlisted files, e.g.
`feat: add M3 async start operation acceptance` (Start portion) and
`feat: add M3 child retry acceptance` (Retry portion); the Retry
portion commit requires P3C-0B accepted (M3-TD-30 applied).

## 10.1 P3C-1 Retry pre-implementation contract closure (current)

This is the current Retry plan at the post-PR-#31 baseline. It is a
docs-only contract closure and is not production implementation authorization.
It supersedes any earlier generic Retry DTO, implementation-time choice, or
statement that a queued/completed Retry Operation authorizes execution.

### Canonical route and request

The only route is `POST /api/runs/:runId/retry`, where `runId` is the opaque
Parent Run ID. The existing `findWorkspaceIdByOpaqueId(runId)` locator runs
before body parsing and business validation; a miss is `404 RUN_NOT_FOUND`.
No workspace ID is accepted in path/query/body, and every subsequent access
is workspace-scoped.

`Idempotency-Key` is required exactly once. Its existing case-insensitive,
trimmed, duplicate-detecting parser is reused; missing, duplicate, empty, or
invalid values are `400 VALIDATION_FAILED`. There is no no-key A2 path.
The query must be empty. The only accepted body is a non-empty plain JSON
object with JSON Content-Type and one required field:

```json
{ "expectedVersion": 3 }
```

`expectedVersion` is a positive safe integer for the Parent. Malformed/empty
JSON, `null`, primitives, arrays, unknown fields, and `mode`, `stageId`,
`providerOverrides`, `reuseTaskMemory`, `reuseWorktree`, `reason`, `createdBy`,
`requestedBy`, `workspaceId`, `parentRunId`, `operationId`, or `correlationId`
are rejected with `400 VALIDATION_FAILED`.

### Parent, Child, Snapshot, and Stage contract

The Parent must be `failed` at the exact expected version. Stale version is
`409 VERSION_CONFLICT`; every other Parent status is `409 RUN_NOT_RETRYABLE`.
The Parent and Task are never modified.

The Child is server-created with `workspaceId`, `taskId`, and `objective` from
the Parent; `parentRunId = Parent.id`; `rootRunId = Parent.rootRunId`;
`status = queued`; `reason = retry`; `origin = v2_api`; `createdBy =
Parent.createdBy`; `nextEventSequence = 1`; and `version = 1`. Child IDs and
timestamps are fresh and client fields cannot override these values.

Option A clones the Parent's persisted Snapshot V2 and RunStage graph. It does
not resolve current Workspace, Workflow, Agent, Provider, or Worktree config.
Missing/V1/malformed Snapshot or graph mismatch is
`500 RUN_RETRY_STATE_INCONSISTENT` with zero side effects. The Child Snapshot
is a new canonical/hash-verified row with fresh `capturedAt`, Child run
metadata, and preserved workflow identity, hash, `worktreeMode`, ordered
`dependsOn`, Agent/Provider snapshots, and redaction. Parent Snapshot ID,
runtime state, output, errors, stage IDs, and timestamps are not copied.

Each Child Stage has a fresh ID, Child Run/Snapshot binding, the same workflow
key and sequence, `attempt = 1`, `status = pending`, fresh timestamps, and
`version = 1`. The current `RunStageRepository.insertInitial` is reused. The
only future Snapshot seam is the V2-only additive
`SnapshotService.clonePersistedRun(run, parentSnapshot, parentStages)` method;
it refreshes `capturedAt`, inserts the new Snapshot, and inserts fresh initial
Stages without invoking a resolver.

### Retry Operation and A2 order

The Retry Operation is Parent-bound with `aggregateType = run`,
`aggregateId = Parent.id`, `runId = Parent.id`, and
`correlationId = operation.id`. Its only lifecycle is:

```text
queued / v1 → running / v2 → completed / v3
```

The completed result is `{ resourceType: "run", resourceId: Child.id }`.
The caller-owned transaction order is frozen as:

1. Read path `runId`.
2. Resolve the workspace locator.
3. Fail closed with `404 RUN_NOT_FOUND` on a miss.
4. Validate query, Content-Type, body, and required version.
5. Normalize and validate the required Idempotency-Key.
6. Build the `run.retry` fingerprint from workspace, `{runId}`, empty domain
   input, and expected version.
7. Call `prepare()` outside the transaction.
8. Begin `BEGIN IMMEDIATE`.
9. Call `resolve()` as the first Parent/Child/Operation domain action.
10. On replay, immediately return the stored original HTTP 201 dual snapshot
    without current-state reads.
11. Read the workspace-scoped Parent.
12. Apply the exact Parent version guard.
13. Require Parent status `failed`.
14. Apply Retry-history, direct-Child, and active-slot fencing.
15. Read and validate Parent Snapshot V2 and Stage graph.
16. Create queued Parent-bound `run.retry` Operation v1.
17. Transition it to `running` v2.
18. Insert the queued Child Run.
19. Insert the cloned Child Snapshot.
20. Insert Child initial Stages in Snapshot sequence order.
21. Append Child `run.created`.
22. Append ordered Child `stage.created` Events.
23. Insert one Outbox per creation Event.
24. Transition Retry Operation to completed v3.
25. Write the Child result binding.
26. Build the internal schemaVersion 1 replay envelope.
27. Call `storeSuccess()` with HTTP 201 and the acceptance-time envelope.
28. Commit.
29. Return `{run, operation}` only after Commit.

`OperationService.createWithinTransaction()`,
`transitionWithinTransactionAt()`, and
`LifecycleTransactionService.createRunGraphEventsWithinTransaction()` are
reused as-is. No nested transaction, transaction-external guard, automatic
Start, Engine tick/dispatch, Child dispatch, or Operation Event is allowed.

### Fencing and response

After a replay miss, no Child plus no Retry history or only failed/cancelled
Retry history is eligible. A valid completed Retry plus one Child returns
`409 RUN_RETRY_ALREADY_CREATED` for a different key. Multiple non-terminal
Retry Operations or direct Children return
`500 RUN_RETRY_AUTHORIZATION_AMBIGUOUS`. A queued/running Retry with or
without a Child, a Child without its completed Retry, or a Retry without its
Child returns `500 RUN_RETRY_STATE_INCONSISTENT`. Same-key success replays
before these reads.

Live and replay are HTTP 201 with top-level `{ "run": ..., "operation": ... }`.
The internal schemaVersion 1 envelope contains the original queued Child DTO
and completed v3 Retry Operation DTO, but the discriminator is not exposed.
Replay sets `Idempotency-Replayed: true` and never changes with later Child or
Operation state.

Creation Event correlation is Child Run ID; Stage creation causation and
parent Event IDs point to Child `run.created`; later execution Events use an
independent `run.start` Operation ID. Retry Operation ID is never an execution
correlation.

### Errors, rollback, and concurrency

The stable error set is: `VALIDATION_FAILED` 400; `RUN_NOT_FOUND` 404;
`VERSION_CONFLICT`, `RUN_NOT_RETRYABLE`, `IDEMPOTENCY_KEY_REUSED`, and
`RUN_RETRY_ALREADY_CREATED` 409; `RUN_RETRY_AUTHORIZATION_AMBIGUOUS`,
`RUN_RETRY_STATE_INCONSISTENT`, and `IDEMPOTENCY_RECORD_INVALID` 500;
`RUN_RETRY_BUSY` 503 with message `Run retry is temporarily unavailable` and
`retryable: true`; and sanitized `INTERNAL_ERROR` 500. No SQLite text, SQL,
path, lock owner, raw key, stack, or internal entity data is exposed.

Failure injection covers Operation insert/transition, Child, Snapshot, every
Stage, every creation Event, every Outbox, completed transition/result, and
`storeSuccess`. Any failure before Commit leaves no Child, Snapshot, Stage,
Event, Outbox, Retry Operation, or Idempotency Success; Parent and Task are
unchanged. Same key yields exactly one live 201 and one replay 201; different
keys yield one live 201 and one duplicate 409; stale versions have zero side
effects; Parent-failure races have one optimistic winner; and normal races do
not use 503.

### Future implementation allowlist

When separately authorized, the future Retry implementation is limited to:

- `apps/server/src/routes/runLifecycle.ts` and its existing test file;
- `apps/server/src/services/TaskRunService.ts` and its existing test file;
- `apps/server/src/services/SnapshotService.ts` and its existing test file.

The existing Operation, Run, Snapshot repository, Stage repository,
LifecycleTransaction, and Idempotency Core seams are reused as-is. No Shared,
Migration/Registry, Idempotency Core, Operation implementation,
LifecycleTransactionService, RunEngine, WorkflowExecutor, StageExecutor, Web,
package/lockfile, or real `.agentos` data may be changed. This docs-only
candidate changes only the five Markdown files and creates no PR.

## 11. Stage P3D — Operation Routes, Atomic Cancel and Event Query

Goal: the canonical top-level Operation endpoints, additive to existing
collections.

Authorized scope (when authorized):

- `GET /api/operations/:operationId`
- `GET /api/operations/:operationId/events` — authorize the Operation first,
  then query `runtime_events` by its `runId` + `correlationId`, ascending
  `sequence`; no `operation_events` store. For `run.retry`, this result does
  not include Child Run creation Events; it begins with Events correlated to
  the Retry Operation, such as `run.dequeued`. Retry acceptance remains
  observable through the Operation resource and Idempotency record.
- `POST /api/operations/:operationId/cancel`
- `OperationService` caller-owned atomic cancel orchestration; the Route
  remains a thin adapter and does not compose the transaction directly.
- Route tests.

Forbidden scope: replacing v2/Legacy collections; SSE/Replay; OpenAPI
completion; Web changes; non-Run operations (Post-M3).

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/routes/operations.ts` (new)
- `apps/server/src/routes/operations.test.ts` (new)
- `apps/server/src/services/OperationService.ts` (minimal additive cancel
  orchestration only)
- `apps/server/src/services/OperationService.test.ts` (additive cases only)
- `apps/server/src/store/OperationRepository.ts` (only if exact evidence
  proves the existing conditional update is insufficient; minimal additive
  change)
- `apps/server/src/store/OperationRepository.test.ts` (additive cases only)
- `apps/server/src/index.ts` (one additive mount line)

Parent-worktree spelling of the same proposed allowlist:

```text
agentos/apps/server/src/routes/operations.ts
agentos/apps/server/src/routes/operations.test.ts
agentos/apps/server/src/services/OperationService.ts
agentos/apps/server/src/services/OperationService.test.ts
agentos/apps/server/src/store/OperationRepository.ts
agentos/apps/server/src/store/OperationRepository.test.ts
agentos/apps/server/src/index.ts
```

Dependencies: P3A accepted; P3B-1 accepted; P3B-2B accepted; P3C-1
accepted; cancel semantics follow M3-TD-27; `GET` responses omit progress
per M3-TD-28. P3D must not modify `LifecycleTransactionService`; P2 already
provides `cancelRunWithinTransaction`. If it is insufficient, stop and
re-open review instead of expanding scope.

RED tests: no `/api/operations/*` routes exist.

GREEN tests: unified `operationId` parameter across the three endpoints;
get-by-id shape matches `ApiOperation` and omits progress per M3-TD-28;
events endpoint returns ascending sequence and 404/authorization failure
modes; cancel endpoint enforces M3-TD-27 semantics — atomic cancel of the
target non-terminal Operation and its bound Task-domain Run, cancellable
statuses exactly `queued`/`running`/`waiting_approval`/`paused`,
already-cancelled returns the current Operation, completed/failed returns
409-class `OPERATION_NOT_CANCELLABLE` — and terminal-state rejection.
Before or during startup, cancellation leaves Operation/Run cancelled, emits one
`stage.cancelled` per affected non-terminal Stage followed by `run.cancelled`,
and never emits `stage.failed` or marks Operation/Run failed.

Related regressions: v2 route suites, full server suite, shared contract
tests.

Failure injection: inject at every cancel-transaction position; any failure
rolls back the target Operation transition, bound Run/Stage transitions,
Runtime Events, and Outbox rows together. After rollback the target
Operation and bound Run retain their transaction-before state. The endpoint
has no Class A, creates or accepts no Cancel Operation, and transaction
failure never uses C1 to record a second Operation. An already-cancelled
target returns the current resource per M3-TD-27; completed/failed targets
return `OPERATION_NOT_CANCELLABLE`.

P3D race evidence (all required):

1. Claim vs cancel — exactly one wins.
2. Startup completion vs cancel — exactly one wins.
3. Startup failure closure vs cancel — exactly one wins.
4. Cancel vs already-terminal Operation — stable terminal response.
5. Concurrent duplicate cancel — exactly one transition.
6. Already-cancelled returns the current Operation with zero new side
   effects.
7. Completed/failed returns `OPERATION_NOT_CANCELLABLE`.
8. Any loser leaves zero partial Stage/Run/Operation/Event/Outbox writes.

The Route remains thin. `OperationService` owns one outer transaction:

1. Open one caller-owned outer transaction.
2. Re-read the target Operation.
3. Validate cancellable status/version/binding.
4. Conditionally transition the target Operation to `cancelled`.
5. Call `cancelRunWithinTransaction`.
6. Write all affected Stage/Run Events and Outbox rows.
7. Commit all or roll back all. No second Cancel Operation exists.

Stop conditions: an `operation_events` store is requested; any deviation
from M3-TD-27 cancel semantics; any progress persistence or population
(M3-TD-28 forbids it).

Rollback boundary: revert the route module and mount line; data preserved.

Independent review gate: Operation != Run in API shape; events query uses
correlationId binding only; cancel semantics match M3-TD-27; no second
Cancel Operation exists. No second cancel Operation exists: cancel rollback
preserves target Operation and Run state; progress is omitted per M3-TD-28.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 operation routes and event query`.

## 12. Stage P3E — Integrated Verification and Closeout

Goal: integrated evidence across all prior stages and a closeout record.

Authorized scope (when authorized): test-harness additions required for
integrated scenarios; docs (plan/closeout records). No new production
behavior.

Forbidden scope: any production behavior change; performance work; Web
cutover; production migration/restore/cutover rehearsal.

Exact proposed file allowlist (proposal, not authorization):

- Integrated test file(s) under `apps/server/src/services/` or
  `apps/server/src/routes/` (new, additive)
- `docs/implementation/milestones/M3-p3-*-closeout.md` (new, docs only)

Dependencies: P3A, P3B-1, P3B-2A, P3B-2B, P3C-0A, P3C-0B, P3C-1, and
P3D all accepted (P3B-1, P3B-2A, and P3B-2B each have their own
independent review; P3D owns atomic cancel).

Required integrated evidence freezes the following order for Start:

Create Run
-> HTTP 202 Start acceptance
-> Engine execution-authorized claim
-> Atomic startup completion:
   Stage running
   Run running
   Start Operation completed
-> Remaining deterministic Stage execution
-> Run terminal outcome
-> Verify completed Start Operation unchanged
-> Operation Events query

Option A Retry flow is separate from execution:

Failed Parent
-> HTTP 201 Retry acceptance
-> queued Child graph + completed v3 Retry Operation + dedicated dual snapshot
-> no Engine claim from Retry
-> separate queued HTTP 202 `run.start` acceptance
-> Engine claim via `run.start` authorization
-> atomic startup completion driven by Start
-> execution Events use the Start Operation ID
-> completed Retry Operation remains unchanged

The full race matrix and idempotent replay of the original 201 Retry and
202 Start snapshots are demonstrated after later state changes. The
covers success startup completion, startup failure, C1a, C1b, A1, A2, Class
B, and C2 post-start non-rewrite. P3E also verifies M3-TD-27 atomic cancel,
all P3D cancel races, and that no second Cancel Operation exists. The
sequence never maps a Run terminal outcome to a later Operation terminal
transition.

Start Operation terminal mapping tests (single approved direction per
M3-TD-29):

- The Start Operation completes when the Run commits `run.started`; a later
  Run failure or cancellation does not rewrite the completed Operation.
- REJECTED alternative: "Start Operation tracks the Run to terminal" — a
  later terminal outcome updating the Operation is not implemented.

Related regressions: full server suite, agent-core suite, migration suites,
shared suites, web suite and builds per the standing gate list.

Stop conditions: any gap requiring new production behavior — record and
stop instead of expanding scope.

Rollback boundary: docs and tests revertible as one package; durable
evidence preserved.

Independent review gate: cross-stage consistency, the exact Start and Retry
ordering above, success/C1a/C1b/A1/A2/B/C2 evidence, cancel no-second-
Operation evidence, replay stability, and boundary discipline reviewed
before any P3 closeout claim.

Commit boundary: ordinary commits, docs/tests only, e.g.
`test: add M3 P3 integrated verification` and
`docs: close out M3 P3`.

## 13. Cross-Stage Standing Rules

- Every stage: ordinary commits only; no amend, rebase, reset, or
  force-push; no PR unless separately authorized; main stays clean.
- Every stage: `git diff --check`, changed-file allowlist verification,
  absolute-path and secret scans before commit.
- Remote Checks wording is always `UNAVAILABLE — NOT PASS` in this
  environment; Web explicit `tsc` baseline errors are recorded as
  `BASELINE REPRODUCED — NOT PASS`, never as PASS, while the Next
  production build must still pass.
- No stage touches Migration 007, 010, 012, or 013; checksums of existing
  migrations must remain identical.
- Real `.agentos` databases are never read, copied, or modified by any
  stage; tests use file-backed temporary databases only.
- P3B-2A is the sole owner of the `startup-failure` Shared/Specification/
  Transition Matrix alignment. P3B-2B may only consume its accepted
  contract and may not modify those files. P3B-2A is PLANNED — NOT
  AUTHORIZED.
- C1a/C1b describe unrecoverable startup failure only. User cancellation always
  follows M3-TD-27 in P3D and never enters C1a/C1b; P3C-1 owns no Operation
  Cancel route or Cancel race.
- The frozen atomic claim transaction (section 2) and the caller-owned
  transaction seam (section 3) bind every stage that touches claim,
  lifecycle transitions, or Operation writes.
- Stage dependencies are directed gates, not a mechanical serial order:
  P3C-0A may start once P3A is accepted; P3B-1 depends on P3A + M3-TD-26;
  P3B-2A depends on P3B-1; P3B-2B depends on P3B-1 + P3B-2A + M3-TD-29;
  P3C-0B depends on M3-TD-30; the P3C-1
  Start portion depends on P3C-0A + P3B-1 + M3-TD-26/M3-TD-29; the P3C-1
  Retry portion additionally depends on P3C-0B + M3-TD-30; P3D depends on
  P3A + P3B-1 + P3B-2B + P3C-1 and owns all Operation Cancel races; P3E
  depends on P3B-2A + P3B-2B + P3D. This freezes the dependency graph only;
  it does not authorize parallel implementation.

Schema conclusion: SCHEMA BLOCKER: NONE.
Migration 014 is not required or authorized.
P3B-2A CONTRACT ALIGNMENT: PLANNED — NOT AUTHORIZED.

This plan records the authorized six-file Option A remediation only. P3C-1,
P3D, P3E, and Production Cutover remain NOT AUTHORIZED. The preplanning PR
(PR #21) and P3C-0B merge (PR #28) are MERGED.
