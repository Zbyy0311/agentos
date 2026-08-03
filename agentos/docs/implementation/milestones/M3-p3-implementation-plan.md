# M3 P3 Implementation Plan — Run Engine, Workflow Executor and Operation

Status: PREPLANNING ONLY — P3 IMPLEMENTATION NOT AUTHORIZED — P3A IMPLEMENTATION NOT AUTHORIZED — PREPLANNING PR #21 MERGED — REMOTE CHECKS UNAVAILABLE — NOT PASS — PRODUCTION CUTOVER NOT AUTHORIZED / NOT STARTED

This plan decomposes M3 P3 into stages P3A, P3B-1, P3B-2, P3C-0A, P3C-0B,
P3C-1, P3D, and P3E. It is a planning artifact only: no stage below is
authorized, and no file allowlist below is an authorization to edit. Each
stage becomes executable only when explicitly authorized in a future
instruction, after the preceding stage's independent review gate is
accepted.

Companion document: `docs/implementation/milestones/M3-p3-current-state-audit.md`
(baseline `3728d670ce0f5c16d07819e65cddbc0bb4c6c5b2`).

Remediation 1 (Start Authorization and Transaction Composition) added the
frozen atomic claim transaction (section 2), the caller-owned transaction
seam (section 3), the P3B-1/P3B-2 split, the failure transaction classes,
and the nine required claim/eligibility tests.

Remediation 2 (Operation Idempotency and Seam Ownership) corrected the seam
stage ownership (sections 3–5), narrowed the P3A failure-injection scope to
Operation-only evidence, split P3C into P3C-0/P3C-1, and extended
OD-P3-05.

Remediation 3 (Retry Idempotency Ownership and Start Operation Completion
Gate) split P3C-0 into P3C-0A (Start Operation Idempotency Replay) and
P3C-0B (Retry Operation Idempotency Closure), made P3C-1 a two-portion
stage with directed dependencies, extended OD-P3-04 into a five-question
package that gates P3B-2, froze the P3B-1 claim boundary, and split failure
class C into C1 (pre-start command failure) and C2 (post-start execution
outcome).

Owner Decision Freeze (2026-08-04): the five P3 Owner Decision candidates
OD-P3-01 through OD-P3-05 are resolved as approved technical directions
M3-TD-26 through M3-TD-30 in
`docs/implementation/milestones/M3-owner-decisions.md`. All stage
dependencies below reference the frozen M3-TD decisions; no Owner Decision
candidate remains undecided. This approval is technical direction only —
P3 and P3A implementation remain NOT AUTHORIZED.

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

Frozen contracts (restated; P3 must not redefine them):

- Queue Record = `runs(status='queued')`.
- A queued Run is necessary but not sufficient for Engine execution; Engine
  claim requires a queued, binding-valid authorization Operation — type
  `run.start`, or type `run.retry` per M3-TD-30 — with exactly one valid
  non-terminal authorization Operation per Run (Start authorization, Gap
  Matrix item 20).
- `run.create` and `run.cancel` Operations never authorize an Engine claim;
  `run.retry` is an Engine claim authorization marker per M3-TD-30.
- Operation tracks only Task-domain Run commands; types exactly
  `run.create`, `run.start`, `run.cancel`, `run.retry`; statuses exactly
  `queued`, `running`, `waiting_approval`, `paused`, `completed`, `failed`,
  `cancelled`.
- Operation != Run; `correlationId` unique and immutable per operation.
- Create != Start; Start is asynchronous: HTTP 202 + Operation.
- Retry creates a child Run and never resets the old Run.
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
P3D), M3-TD-29 (Start Operation completion package, binds P3B-2 terminal
mapping and P3C-1), M3-TD-30 (retry activation package, binds P3C-0B and
the P3C-1 retry portion). No Owner Decision candidate remains undecided.

## 2. Frozen Atomic Claim Transaction (Cross-Stage Constraint)

Engine claim MUST be completed inside one caller-owned outer transaction:

1. Re-read the queued run.
2. Re-read the queued authorization Operation (`run.start`, or `run.retry` per M3-TD-30).
3. Validate workspace/run/aggregate/correlation binding.
4. Conditionally transition Operation `queued -> running`.
5. Transition Run `queued -> starting` through `LifecycleTransactionService`.
6. Append `run.dequeued` with the Operation correlationId.
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
  (P3B-2).

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
Recording `failed` on an already-accepted Operation is a separate, explicit
failure-record transaction (class C1); it is never folded into a rolled-back
transaction, and evidence is worded as "no partial lifecycle state; an
accepted Operation may persist as durable failure evidence" — never as "all
Operation behavior rolls back to zero".

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

## 5. Stage P3B-1 — Start-Authorized Claim and Transaction Composition

Goal: the Start-authorization eligibility selector, the atomic
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

P3B-1 claim boundary (frozen): the claim performs only Operation
`queued -> running`, Run `queued -> starting`, `run.dequeued`, and the
Outbox row — atomically. P3B-1 must not transition the claimed
Operation to `completed`, `failed`, or `cancelled`.

Authorized scope (when authorized):

- Minimal additive caller-owned Run transition entry point on
  `LifecycleTransactionService` (e.g. `transitionRunWithinTransaction`;
  section 3).
- Eligibility selector: queued run + queued, binding-valid authorization
  Operation (`run.start`, or `run.retry` per M3-TD-30); fail closed on
  duplicates or coexisting start/retry authorizations.
- `RunEngine` claim path composing the frozen atomic claim transaction
  (section 2); explicit test-controlled ticks only.
- Competing-claim and no-start-operation no-op tests.

Forbidden scope: Workflow/Stage execution (P3B-2); background timers,
server startup loops, auto-scan; ProcessManager, ProviderAdapter, CLI
execution, Worktree runtime, Policy, Approval implementation; HTTP routes;
`recovery_required` writes; any scheduler table; any direct repository
writes bypassing events/outbox; nested transactions; two-transaction claim
simulation; any Start Operation terminal transition.

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/services/LifecycleTransactionService.ts` (minimal
  additive modification only)
- `apps/server/src/services/m3-p3b1-start-authorized-claim.test.ts` (new;
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

1. Created run without a Start Operation: repeated Engine ticks leave it
   `queued`; no `run.dequeued`; no new Outbox row.
2. A `run.create` Operation does not authorize claim.
3. Queued run + queued `run.start` Operation: the run can be claimed;
   Operation and Run change in the same transaction; the `run.dequeued`
   event carries the Operation correlationId.
4. Competing Engine claims: exactly one winner; the loser leaves zero
   partial writes.
5. Duplicate or coexisting active (non-terminal) authorization Operations
   for one run (`run.start` and/or `run.retry`): fail closed, no arbitrary
   choice.
6. Operation transition failure during claim: Run/Event/Outbox writes all
   roll back.
7. Run/Event/Outbox failure during claim: the Operation transition rolls
   back.
8. Queued run + queued `run.retry` Operation: the run can be claimed
   identically per M3-TD-30; Operation and Run change in the same
   transaction; the `run.dequeued` event carries the retry Operation
   correlationId.
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
arbitrary Operation selected; a background loop, timer, or scheduler table
requested; claim simulated by two transactions; nested transactions;
executor scope requested; a Start Operation terminal transition requested.

Rollback boundary: revert the seam modification and the run-engine package
as one package; runs, Operations, events, and outbox rows are preserved
(no data reset).

Independent review gate: single-writer ownership of Start-authorized queued
runs; transaction core exclusivity; the seam reuses existing lifecycle
rules (no second implementation); all nine GREEN proofs; no timers; the
claim boundary (no terminal Operation transition) upheld.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 start-authorized claim and transaction composition`.

## 6. Stage P3B-2 — Deterministic Workflow and Stage Execution

Goal: deterministic workflow graph traversal, stage orchestration, and the
deterministic mock Stage Executor with completion/failure/skip behavior.

Authorized scope (when authorized):

- `WorkflowExecutor` (deterministic `dependsOn` traversal from the
  persisted run snapshot V2).
- `StageExecutor` (mock stage runner seam; stage lifecycle via
  `transitionStage`; `skipped` propagation on failure/cancel per spec).
- Engine dispatch integration on top of the P3B-1 claim.
- Start Operation terminal mapping strictly per M3-TD-29.
- Unit/integration tests with an injected transaction core.

Forbidden scope: everything forbidden in P3B-1; additionally any change to
the claim transaction or eligibility selector (owned by P3B-1), and any
Start Operation terminal mapping deviating from M3-TD-29.

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/services/run-engine/WorkflowExecutor.ts` (new)
- `apps/server/src/services/run-engine/StageExecutor.ts` (new)
- `apps/server/src/services/run-engine/RunEngine.ts` (additive dispatch
  integration only)
- `apps/server/src/services/run-engine/*.test.ts` (new, additive)

Dependencies: P3B-1 independent review accepted; Start Operation terminal
mapping follows M3-TD-29.

RED tests: no executor exists; a claimed run has no stage progress.

GREEN tests: executor honors `dependsOn` order exactly; failure marks
downstream stages `skipped` per spec; cancel during execution resolves
through `cancelRunWithinTransaction`; completion drives
`completeRunStartup`/`completeRun` through the transaction core; every
transition emits event + outbox in the same transaction.

Start Operation terminal mapping tests (single approved direction per
M3-TD-29):

- The Start Operation completes when the Run commits `run.started`; a later
  Run failure or cancellation does not rewrite the completed Operation.
- REJECTED alternative: "Start Operation tracks the Run to terminal" — a
  later terminal outcome updating the Operation is not implemented.

Related regressions: LifecycleTransactionService suites, P2C-2A/P2C-2B
suites, P3B-1 claim tests, migration suites.

Failure injection: inject at each event-call position in stage transition
and completion paths; assert zero partial commits, run left in a consistent
claimable or terminal state, integrity checks clean; pre-start failures
follow class C1 (separate explicit failure-record transaction); post-start
execution outcomes follow class C2 per M3-TD-29 — post-start outcomes never
rewrite the completed Start Operation.

Concurrency race evidence: cancel-during-dispatch; stale-version dispatch
loss. Losers fail cleanly with no state corruption.

Stop conditions: executor needs any M4 surface; engine bypasses the
transaction core; claim logic modified; engine writes `recovery_required`;
any deviation from the M3-TD-29 terminal mapping when a Start Operation terminal mapping is reached.

Rollback boundary: revert the executor package; claim composition (P3B-1)
stays; runs, events, and outbox rows are preserved (no data reset).

Independent review gate: determinism proof; skip propagation; no M4
imports; P3B-1 boundary respected; terminal mapping matches M3-TD-29
exactly.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 deterministic workflow and stage execution`.

P3B requirements (binding for P3B-1 and P3B-2):

- The engine claims only `runs(status='queued')` that are Start-authorized.
- Every state write goes through `LifecycleTransactionService`.
- The executor is deterministic and mock-driven; no CLI, no ProcessManager.
- Tick-driven: work advances on explicit ticks (test-controlled), not on
  wall-clock timers inside tests.
- Claim, dispatch, and outcome recording each carry injection points and
  concurrency guards.

## 7. Stage P3C-0A — Start Operation Idempotency Replay

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

## 8. Stage P3C-0B — Retry Operation Idempotency Closure

Goal: close the `run.retry` idempotency contract exactly per M3-TD-30, as
its own commit and independent review boundary.

Authorized scope (when authorized):

- Register `run.retry` as a TypeScript idempotency operation.
- Establish the M3-TD-30 HTTP status mapping: `run.retry -> HTTP 202`.
- Establish the M3-TD-30 Operation-only immutable replay envelope: the
  acceptance-time queued Retry Operation snapshot; the Operation's `runId`
  already carries the Child Run ID; no combined Child Run + Operation
  envelope is defined.
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

GREEN tests: `run.retry` round-trip at the M3-TD-30-frozen HTTP 202 status; same key + same hash returns the original 202; same key + different hash returns 409;
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
+ Operation envelope is introduced; any route or Operation-implementation
change is requested.

Rollback boundary: revert the additive retry registration as one package;
stored rows preserved.

Independent review gate: exact match to the M3-TD-30 shape; fail-closed
parser; immutable snapshot; legacy compatibility; no DB change.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 retry operation idempotency closure`.

## 9. Stage P3C-1 — Async Start, Cancel Race, Child Retry

Goal: the asynchronous Start contract, Operation-level cancel/complete race
resolution, and retry-as-child-run, all idempotent. P3C-1 has two
independently enterable dependent portions:

- Start portion: depends on P3C-0A (not on P3C-0B).
- Retry portion: depends on M3-TD-30 and P3C-0B, and must not modify the
  idempotency core files itself.

Authorized scope (when authorized):

- Start route returning HTTP 202 + Operation (additive; v2/Legacy
  untouched). The route runs the command acceptance transaction (class A):
  it atomically commits the queued `run.start` Operation and the
  Idempotency success/replay response, using the P3C-0A `run.start` + 202 +
  immutable Operation replay envelope. It does not start the run and does
  not write `run.dequeued`; Engine eligibility begins only after this
  commit.
- `run.start` consumer wired through `IdempotencyService` (Start portion);
  `run.retry` consumer wired only in the Retry portion after P3C-0B, per
  M3-TD-30.
- Retry service path creating child runs via `RunRepository.insert`
  lineage. Per M3-TD-30 the retry acceptance transaction atomically
  creates the Child Run and lineage, the Child Run graph/stages, the
  queued `run.retry` Operation, the Idempotency success/replay record, and
  the Run-creation Event/Outbox; the queued `run.retry` Operation
  immediately authorizes Engine execution — no separate Start command is
  required, and the Parent Run is never reset or modified.
- Route and race tests.

Forbidden scope: synchronous start execution in the route handler;
resetting/mutating the parent run on retry; replacing v2 or Legacy
collections; Web changes; Operation cancel route (P3D); event query route
(P3D); granting Engine eligibility to `run.create`/`run.cancel`
Operations; any change to the idempotency core files
(`apps/server/src/idempotency/types.ts`,
`apps/server/src/services/IdempotencyService.ts`,
`apps/server/src/store/IdempotencyRepository.ts` and their tests), which
are owned by P3C-0A/P3C-0B.

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/routes/runLifecycle.ts` (new, or equivalent additive
  route module; final naming at implementation time)
- `apps/server/src/routes/runLifecycle.test.ts` (new)
- `apps/server/src/services/TaskRunService.ts` (minimal additive wiring
  only, if required; no behavioral change to existing methods)
- `apps/server/src/services/TaskRunService.test.ts` (additive cases only)
- `apps/server/src/index.ts` (one additive mount line)

Dependencies: P3A accepted; P3B-1 accepted; Start portion: P3C-0A accepted,
M3-TD-26 and M3-TD-29 applied; Retry portion: additionally P3C-0B accepted,
per M3-TD-30.

RED tests: no start route; no `run.start`/`run.retry` idempotency consumer;
no retry caller.

GREEN tests: start returns 202 with an Operation; the acceptance
transaction commits Operation + idempotency success atomically via the
P3C-0A envelope; the run remains queued until the engine claims it; same
idempotency key replays the original Operation (original 202 and original
snapshot); different key on an already-started run is rejected per
contract; retry creates a child run with correct
`root_run_id`/`parent_run_id` and the old run untouched; the retry child is
immediately Engine-eligible via its queued `run.retry` Operation per
M3-TD-30 — no separate Start command.

Related regressions: v2 route suites, idempotency suites, TaskRunService
suites, P3B-1 claim tests, P3C-0A replay tests, full server suite.

Failure injection (distinct transaction classes):

- Class A (command acceptance): throw between the Operation insert and the
  idempotency success write — no Operation row, no idempotency success row,
  run stays queued.
- Class B (engine claim): inherited from P3B-1 — any failure rolls back
  Operation/Run/Event/Outbox together.
- Class C1 (pre-start command failure): the Operation was durably accepted
  via A, but the claim/start transaction fails before the Run enters
  `starting` — first roll back the failed lifecycle transaction in full,
  then mark the Operation `failed` with the serialized ApiProblem in a
  separate, explicit failure-record transaction. C1 holds unchanged under
  M3-TD-29.
- Class C2 (post-start execution outcome): after the Run has entered
  `starting` or `running` — Stage failure, Run failure, Run cancellation,
  or Run completion — per M3-TD-29 the Start Operation is `completed` when
  the Run commits `run.started`, and post-start Stage/Run failure,
  cancellation, or completion never rewrites it. Never write
  unconditionally that a later execution failure marks the accepted Start
  Operation failed.
- Evidence wording: no partial lifecycle state; an accepted Operation may
  persist as durable failure evidence. Never worded as "all Operation
  behavior rolls back to zero".

Concurrency race evidence (race matrix, all required):

| Race | Expected outcome |
|------|------------------|
| Start vs start (same idempotency key) | Replay of the original Operation; no second transition |
| Start vs start (different key, run already started) | Contract rejection (409-class), no state change |
| Claim vs cancel on a queued run | Exactly one wins; loser fails cleanly |
| Cancel vs complete | Exactly one terminal state; single terminal event |
| Stale version dispatch | Conditional update loses; no overwrite |
| Retry vs terminal parent state | Rejected per contract; parent untouched |
| Task active slot vs concurrent accept/cancel | Existing task invariants hold |
| Terminal immutability | Any transition out of a terminal state fails |
| Partial commit | None observed under injection at any position |

Stop conditions: any synchronous execution in the route; any parent-run
mutation on retry; any deviation from M3-TD-26, M3-TD-29, or M3-TD-30 when
the dependent code is reached; acceptance transaction writing lifecycle
events;
any edit to the idempotency core files owned by P3C-0A/P3C-0B; enabling the
`run.retry` consumer without P3C-0B.

Rollback boundary: revert route + wiring as one package; operations, runs,
events preserved (no data reset).

Independent review gate: Create != Start; 202 contract; acceptance/claim/
failure-record transaction separation; idempotent replay via the P3C-0A
envelope; race matrix evidence; retry lineage; Start/Retry portion
dependencies and the M3-TD-30 retry activation contract respected.

Commit boundary: ordinary commits per portion, only allowlisted files, e.g.
`feat: add M3 async start operation acceptance` (Start portion) and
`feat: add M3 cancel race and child retry` (Retry portion); the Retry
portion commit requires P3C-0B accepted (M3-TD-30 applied).

## 10. Stage P3D — Operation Routes and Event Query

Goal: the canonical top-level Operation endpoints, additive to existing
collections.

Authorized scope (when authorized):

- `GET /api/operations/:operationId`
- `GET /api/operations/:operationId/events` — authorize the Operation first,
  then query `runtime_events` by its `runId` + `correlationId`, ascending
  `sequence`; no `operation_events` store.
- `POST /api/operations/:operationId/cancel`
- Route tests.

Forbidden scope: replacing v2/Legacy collections; SSE/Replay; OpenAPI
completion; Web changes; non-Run operations (Post-M3).

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/routes/operations.ts` (new)
- `apps/server/src/routes/operations.test.ts` (new)
- `apps/server/src/index.ts` (one additive mount line)

Dependencies: P3A and P3C-1 accepted; cancel semantics follow M3-TD-27;
`GET` responses omit progress per M3-TD-28.

RED tests: no `/api/operations/*` routes exist.

GREEN tests: unified `operationId` parameter across the three endpoints;
get-by-id shape matches `ApiOperation` and omits progress per M3-TD-28;
events endpoint returns ascending sequence and 404/authorization failure
modes; cancel endpoint enforces M3-TD-27 semantics — atomic cancel of the
target non-terminal Operation and its bound Task-domain Run, cancellable
statuses exactly `queued`/`running`/`waiting_approval`/`paused`,
already-cancelled returns the current Operation, completed/failed returns
409-class `OPERATION_NOT_CANCELLABLE` — and terminal-state rejection.

Related regressions: v2 route suites, full server suite, shared contract
tests.

Failure injection: cancel route mid-transition injection; no partial
commit; operation left in a consistent state; an already-accepted cancel
Operation follows class C1 failure recording.

Concurrency race evidence: cancel vs terminal transition on the same
operation — exactly one wins.

Stop conditions: an `operation_events` store is requested; any deviation
from M3-TD-27 cancel semantics; any progress persistence or population
(M3-TD-28 forbids it).

Rollback boundary: revert the route module and mount line; data preserved.

Independent review gate: Operation != Run in API shape; events query uses
correlationId binding only; cancel semantics match M3-TD-27; progress
omitted per M3-TD-28.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 operation routes and event query`.

## 11. Stage P3E — Integrated Verification and Closeout

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

Dependencies: P3A, P3B-1, P3B-2, P3C-0A, P3C-0B, P3C-1, and P3D all
accepted (P3B-1 and P3B-2 each with their own independent review).

Required integrated evidence: queued-run lifecycle end to end (create ->
202 start acceptance -> engine claim of the Start-authorized run ->
deterministic stage walk -> terminal state -> Operation terminal state ->
events query), the full race matrix under integrated conditions, idempotent
replay of the original 202 Operation snapshot after later state changes,
and the failure classes demonstrated end to end (acceptance failure leaves
nothing; claim failure rolls back together; pre-start failure recording via
C1 in a separate explicit transaction; post-start outcomes mapped exactly
per M3-TD-29 via C2 — post-start outcomes never rewrite the completed
Start Operation; no partial lifecycle state).

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

Independent review gate: cross-stage consistency, evidence completeness,
and boundary discipline reviewed before any P3 closeout claim.

Commit boundary: ordinary commits, docs/tests only, e.g.
`test: add M3 P3 integrated verification` and
`docs: close out M3 P3`.

## 12. Cross-Stage Standing Rules

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
- The frozen atomic claim transaction (section 2) and the caller-owned
  transaction seam (section 3) bind every stage that touches claim,
  lifecycle transitions, or Operation writes.
- Stage dependencies are directed gates, not a mechanical serial order:
  P3C-0A may start once P3A is accepted; P3B-1 depends on P3A + M3-TD-26;
  P3B-2 depends on P3B-1 + M3-TD-29; P3C-0B depends on M3-TD-30; the P3C-1
  Start portion depends on P3C-0A + P3B-1 + M3-TD-26/M3-TD-29; the P3C-1
  Retry portion additionally depends on P3C-0B + M3-TD-30. This freezes the
  dependency graph only; it does not authorize parallel implementation.

Schema conclusion: SCHEMA BLOCKER: NONE.
Migration 014 is not required or authorized.

This plan authorizes nothing. P3 implementation remains NOT AUTHORIZED.
P3A implementation remains NOT AUTHORIZED. The preplanning PR (PR #21) is
MERGED.
