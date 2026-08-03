# M3 P3 Implementation Plan — Run Engine, Workflow Executor and Operation

Status: PREPLANNING ONLY — P3 IMPLEMENTATION NOT AUTHORIZED — P3A IMPLEMENTATION NOT AUTHORIZED — PREPLANNING PR NOT YET AUTHORIZED — REMOTE CHECKS UNAVAILABLE — NOT PASS — PRODUCTION CUTOVER NOT AUTHORIZED / NOT STARTED

This plan decomposes M3 P3 into stages P3A, P3B-1, P3B-2, P3C, P3D, and
P3E. It is a planning artifact only: no stage below is authorized, and no
file allowlist below is an authorization to edit. Each stage becomes
executable only when explicitly authorized in a future instruction, after
the preceding stage's independent review gate is accepted.

Companion document: `docs/implementation/milestones/M3-p3-current-state-audit.md`
(baseline `3728d670ce0f5c16d07819e65cddbc0bb4c6c5b2`).

Remediation 1 (Start Authorization and Transaction Composition) adds the
frozen atomic claim transaction (section 2), the caller-owned transaction
seam (section 3), the P3B-1/P3B-2 split, the three-class failure
transaction semantics, and the nine required claim/eligibility tests.

## 1. Preconditions and Frozen Contracts

Preconditions (verified at baseline):

- P2 transaction core merged (`7a6c41710af5d4c58ef9acd6a9484b9deb341c6b`)
  and locally gated; `LifecycleTransactionService` exposes the full
  transition surface.
- Schema Migrations 001–013 are sufficient for the entire P3 scope; no
  Migration 014 is planned. Any discovery that the schema is insufficient
  must stop the stage and record `SCHEMA BLOCKER — OWNER DECISION REQUIRED`.

Frozen contracts (restated; P3 must not redefine them):

- Queue Record = `runs(status='queued')`.
- A queued Run is necessary but not sufficient for Engine execution; Engine
  claim requires a queued, binding-valid `run.start` Operation (Start
  authorization, Gap Matrix item 20).
- `run.create` and `run.cancel` Operations never authorize an Engine claim;
  `run.retry` claim authorization is gated by OD-P3-05 and is forbidden
  until that decision is approved.
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

Owner Decision candidates that gate specific stages (from the audit,
section 6): OD-P3-01 (correlationId generation, gates P3C), OD-P3-02
(cancel semantics, gates P3D), OD-P3-03 (progress usage, gates P3D),
OD-P3-04 (start completion timing, gates P3C), OD-P3-05 (retry child
activation semantics, gates P3C retry activation wiring). A stage that
depends on an undecided candidate must not start its dependent portion.

## 2. Frozen Atomic Claim Transaction (Cross-Stage Constraint)

Engine claim MUST be completed inside one caller-owned outer transaction:

1. Re-read the queued run.
2. Re-read the queued `run.start` Operation.
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

## 3. Caller-Owned Transaction Seam (Cross-Stage Constraint)

P3A ships the seam; P3B-1 consumes it.

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
- `LifecycleTransactionService` gains a minimal additive caller-owned Run
  transition entry point, e.g. `transitionRunWithinTransaction`, or an
  equivalent design. This entry point must reuse the existing transition
  validation, timestamp, Event, sequence, and Outbox rules; a second
  lifecycle implementation must not be created.

## 4. Stage P3A — Operation Persistence and Lifecycle Foundation

Goal: a durable Operation aggregate on the existing Migration 012
`operations` table, with repository, service, the caller-owned transaction
seam (section 3), and lifecycle tests. No routes, no engine.

Authorized scope (when authorized):

- `OperationRepository` (insert, get by id, get by correlation id, list by
  run, non-terminal-by-run-and-type query, conditional status/version
  update; all writes transaction-scoped).
- `OperationService` (create-for-command, transition with optimistic
  locking, terminal-state enforcement, result/ApiProblem persistence;
  caller-owned-transaction-composable entry points).
- Unit tests for both.

Forbidden scope: routes, engine/executor, idempotency route wiring, any
change to migrations, registries, shared runtime event types, Legacy or v2
code paths.

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/store/OperationRepository.ts` (new)
- `apps/server/src/services/OperationService.ts` (new)
- `apps/server/src/store/OperationRepository.test.ts` (new)
- `apps/server/src/services/OperationService.test.ts` (new)

Dependencies: P2 core (merged); no Owner Decision required for the
persistence layer itself.

RED tests: repository/service absent — importing them fails; no writer for
`operations` exists.

GREEN tests: insert/read round-trip; identity-immutability trigger rejects
identity-field update; `correlation_id` uniqueness enforced; conditional
update loses cleanly on stale version; terminal states reject further
transitions; `error_json` round-trips a serialized ApiProblem; invalid
status/type rejected by CHECK; repository writes join a caller-owned
transaction and commit/roll back with it; non-terminal-by-run-and-type
query returns exactly the matching rows.

Related regressions: migration 012 suite, store-level suites, server suite.

Failure injection (aligned with the three transaction classes in Gap Matrix
item 9): throw between operation insert and companion state write inside
one transaction; assert zero partial rows (operations, runs, events,
outbox, idempotency) and `integrity_check`/`foreign_key_check` clean.
Recording `failed` on an already-accepted Operation is a separate, explicit
failure-record transaction (class C); it is never folded into the
rolled-back transaction, and evidence is worded as "no partial lifecycle
state; an accepted Operation may persist as durable failure evidence" —
never as "all Operation behavior rolls back to zero".

Concurrency race evidence: two conditional updates at the same expected
version — exactly one succeeds.

Stop conditions: any need for a schema change; status/type vocabulary
pressure beyond the frozen sets; any route or engine code requested; a
repository write that cannot join a caller-owned transaction.

Rollback boundary: delete the four new files as one package; the
`operations` table and any rows are preserved (no data reset).

Independent review gate: Operation != Run upheld; identity immutability;
version discipline; no transaction-core bypass; ApiProblem shape in
`error_json`; caller-owned transaction composability demonstrated.

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
- Cancel semantics (OD-P3-02), progress usage (OD-P3-03), correlationId
  generation for non-create operations (OD-P3-01), start completion timing
  (OD-P3-04), and retry activation semantics (OD-P3-05) are explicitly OUT
  of P3A.

## 5. Stage P3B-1 — Start-Authorized Claim and Transaction Composition

Goal: the Start-authorization eligibility selector, the atomic
Operation/Run claim, and the caller-owned lifecycle seam. The transaction
seam, claim, Workflow Executor, and Stage Executor must not be delivered as
one giant commit; P3B-1 is its own independent review boundary.

Authorized scope (when authorized):

- Minimal additive caller-owned Run transition entry point on
  `LifecycleTransactionService` (e.g. `transitionRunWithinTransaction`;
  section 3).
- Eligibility selector: queued run + queued, binding-valid `run.start`
  Operation; fail closed on duplicates.
- `RunEngine` claim path composing the frozen atomic claim transaction
  (section 2); explicit test-controlled ticks only.
- Competing-claim and no-start-operation no-op tests.

Forbidden scope: Workflow/Stage execution (P3B-2); background timers,
server startup loops, auto-scan; ProcessManager, ProviderAdapter, CLI
execution, Worktree runtime, Policy, Approval implementation; HTTP routes;
`recovery_required` writes; any scheduler table; any direct repository
writes bypassing events/outbox; nested transactions; two-transaction claim
simulation.

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
- `apps/server/src/store/OperationRepository.ts` (minimal claim-support
  additions only if P3A has not already delivered them)
- `apps/server/src/store/OperationRepository.test.ts` (additive cases only)
- `apps/server/src/services/OperationService.ts` (minimal claim-support
  additions only if P3A has not already delivered them)
- `apps/server/src/services/OperationService.test.ts` (additive cases only)
- `apps/server/src/services/run-engine/RunEngine.ts` (new)
- `apps/server/src/services/run-engine/RunEngine.test.ts` (new)

Dependencies: P3A accepted; OD-P3-01 (correlationId generation for
`run.start`) decided before the claim event is emitted.

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
5. Duplicate active (non-terminal) `run.start` Operations for one run:
   fail closed, no arbitrary choice.
6. Operation transition failure during claim: Run/Event/Outbox writes all
   roll back.
7. Run/Event/Outbox failure during claim: the Operation transition rolls
   back.
8. A `run.retry` Operation does not authorize claim while OD-P3-05 is
   unapproved.
9. P3B-1 registers no background loop and no wall-clock timer.

Related regressions: LifecycleTransactionService suites, P2C-2A/P2C-2B
suites, RunRepository/RunStageRepository suites, Operation suites,
migration suites.

Failure injection: class B (claim) semantics — inject at each step of the
frozen claim transaction (section 2); every injection rolls back all of
Operation/Run/Event/Outbox; integrity checks clean; no partial lifecycle
state.

Concurrency race evidence: competing claims with identical expected
status/version — exactly one commits; duplicate active Start Operation
detection under concurrency fails closed.

Stop conditions: eligibility evaluated without Operation binding; an
arbitrary Operation selected; a background loop, timer, or scheduler table
requested; claim simulated by two transactions; nested transactions;
executor scope requested.

Rollback boundary: revert the seam modification and the run-engine package
as one package; runs, Operations, events, and outbox rows are preserved
(no data reset).

Independent review gate: single-writer ownership of Start-authorized queued
runs; transaction core exclusivity; seam reuses existing lifecycle rules
(no second implementation); all nine GREEN proofs; no timers.

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
- Unit/integration tests with an injected transaction core.

Forbidden scope: everything forbidden in P3B-1; additionally any change to
the claim transaction or eligibility selector (owned by P3B-1).

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/services/run-engine/WorkflowExecutor.ts` (new)
- `apps/server/src/services/run-engine/StageExecutor.ts` (new)
- `apps/server/src/services/run-engine/RunEngine.ts` (additive dispatch
  integration only)
- `apps/server/src/services/run-engine/*.test.ts` (new, additive)

Dependencies: P3B-1 independent review accepted; no Owner Decision required
for deterministic traversal itself.

RED tests: no executor exists; a claimed run has no stage progress.

GREEN tests: executor honors `dependsOn` order exactly; failure marks
downstream stages `skipped` per spec; cancel during execution resolves
through `cancelRunWithinTransaction`; completion drives
`completeRunStartup`/`completeRun` through the transaction core; every
transition emits event + outbox in the same transaction.

Related regressions: LifecycleTransactionService suites, P2C-2A/P2C-2B
suites, P3B-1 claim tests, migration suites.

Failure injection: inject at each event-call position in stage transition
and completion paths; assert zero partial commits, run left in a consistent
claimable or terminal state, integrity checks clean; accepted-command
failure recording follows class C (separate explicit transaction).

Concurrency race evidence: cancel-during-dispatch; stale-version dispatch
loss. Losers fail cleanly with no state corruption.

Stop conditions: executor needs any M4 surface; engine bypasses the
transaction core; claim logic modified; engine writes `recovery_required`.

Rollback boundary: revert the executor package; claim composition (P3B-1)
stays; runs, events, and outbox rows are preserved (no data reset).

Independent review gate: determinism proof; skip propagation; no M4
imports; P3B-1 boundary respected.

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

## 7. Stage P3C — Async Start, Cancel Race, Child Retry

Goal: the asynchronous Start contract, Operation-level cancel/complete race
resolution, and retry-as-child-run, all idempotent.

Authorized scope (when authorized):

- Start route returning HTTP 202 + Operation (additive; v2/Legacy
  untouched). The route runs the command acceptance transaction (class A):
  it atomically commits the queued `run.start` Operation and the
  Idempotency success/replay response. It does not start the run and does
  not write `run.dequeued`; Engine eligibility begins only after this
  commit.
- `run.start` and `run.retry` consumers wired through `IdempotencyService`.
- Retry service path creating child runs via `RunRepository.insert`
  lineage. Retry activation wiring is blocked by OD-P3-05: until approved,
  the retry child stays queued and non-executable and `run.retry` is not a
  claim marker.
- Route and race tests.

Forbidden scope: synchronous start execution in the route handler;
resetting/mutating the parent run on retry; replacing v2 or Legacy
collections; Web changes; Operation cancel route (P3D); event query route
(P3D); granting Engine eligibility to `run.create`/`run.cancel`/`run.retry`
Operations.

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/routes/runLifecycle.ts` (new, or equivalent additive
  route module; final naming at implementation time)
- `apps/server/src/routes/runLifecycle.test.ts` (new)
- `apps/server/src/services/TaskRunService.ts` (minimal additive wiring
  only, if required; no behavioral change to existing methods)
- `apps/server/src/services/TaskRunService.test.ts` (additive cases only)
- `apps/server/src/index.ts` (one additive mount line)

Dependencies: P3A and P3B-1 accepted; OD-P3-01 (correlationId generation
for `run.start`/`run.cancel`/`run.retry`) decided; OD-P3-04 (start
completion timing) decided; OD-P3-05 decided before any retry activation
wiring.

RED tests: no start route; no `run.start`/`run.retry` idempotency consumer;
no retry caller.

GREEN tests: start returns 202 with an Operation; the acceptance
transaction commits Operation + idempotency success atomically; the run
remains queued until the engine claims it; same idempotency key replays the
original Operation; different key on an already-started run is rejected per
contract; retry creates a child run with correct
`root_run_id`/`parent_run_id` and the old run untouched; retry child is
not Engine-eligible while OD-P3-05 is undecided.

Related regressions: v2 route suites, idempotency suites, TaskRunService
suites, P3B-1 claim tests, full server suite.

Failure injection (three transaction classes):

- Class A (command acceptance): throw between the Operation insert and the
  idempotency success write — no Operation row, no idempotency success row,
  run stays queued.
- Class B (engine claim): inherited from P3B-1 — any failure rolls back
  Operation/Run/Event/Outbox together.
- Class C (accepted command failure recording): when an Operation was
  durably accepted via A but a later claim or execution fails, first roll
  back the failed lifecycle transaction, then mark the Operation `failed`
  with the serialized ApiProblem in a separate, explicit failure-record
  transaction. Evidence wording: no partial lifecycle state; an accepted
  Operation may persist as durable failure evidence. Never worded as "all
  Operation behavior rolls back to zero".

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
mutation on retry; OD-P3-01, OD-P3-04, or OD-P3-05 still undecided when the
dependent code is reached; acceptance transaction writing lifecycle events.

Rollback boundary: revert route + wiring as one package; operations, runs,
events preserved (no data reset).

Independent review gate: Create != Start; 202 contract; acceptance/claim/
failure-record transaction separation; idempotent replay; race matrix
evidence; retry lineage; OD-P3-05 boundary respected.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 async start cancel race and child retry`.

## 8. Stage P3D — Operation Routes and Event Query

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

Dependencies: P3A and P3C accepted; OD-P3-02 (cancel semantics) decided;
OD-P3-03 (progress usage) decided before any `GET` response includes
progress.

RED tests: no `/api/operations/*` routes exist.

GREEN tests: unified `operationId` parameter across the three endpoints;
get-by-id shape matches `ApiOperation`; events endpoint returns ascending
sequence and 404/authorization failure modes; cancel endpoint enforces
decided semantics and terminal-state rejection.

Related regressions: v2 route suites, full server suite, shared contract
tests.

Failure injection: cancel route mid-transition injection; no partial
commit; operation left in a consistent state; an already-accepted cancel
Operation follows class C failure recording.

Concurrency race evidence: cancel vs terminal transition on the same
operation — exactly one wins.

Stop conditions: an `operation_events` store is requested; OD-P3-02 or
OD-P3-03 undecided when the dependent code is reached.

Rollback boundary: revert the route module and mount line; data preserved.

Independent review gate: Operation != Run in API shape; events query uses
correlationId binding only; cancel semantics match the Owner Decision.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 operation routes and event query`.

## 9. Stage P3E — Integrated Verification and Closeout

Goal: integrated evidence across P3A–P3D and a closeout record.

Authorized scope (when authorized): test-harness additions required for
integrated scenarios; docs (plan/closeout records). No new production
behavior.

Forbidden scope: any production behavior change; performance work; Web
cutover; production migration/restore/cutover rehearsal.

Exact proposed file allowlist (proposal, not authorization):

- Integrated test file(s) under `apps/server/src/services/` or
  `apps/server/src/routes/` (new, additive)
- `docs/implementation/milestones/M3-p3-*-closeout.md` (new, docs only)

Dependencies: P3A–P3D all accepted (P3B-1 and P3B-2 each with their own
independent review).

Required integrated evidence: queued-run lifecycle end to end (create ->
202 start acceptance -> engine claim of the Start-authorized run ->
deterministic stage walk -> terminal state -> Operation terminal state ->
events query), the full race matrix under integrated conditions, and the
three-class failure semantics demonstrated end to end (acceptance failure
leaves nothing; claim failure rolls back together; accepted-command
failure is recorded in a separate explicit transaction with no partial
lifecycle state).

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

## 10. Cross-Stage Standing Rules

- Every stage: ordinary commits only; no amend, rebase, reset, or
  force-push; no PR unless separately authorized; main stays clean.
- Every stage: `git diff --check`, changed-file allowlist verification,
  absolute-path and secret scans before commit.
- Remote Checks wording is always `UNAVAILABLE — NOT PASS` in this
  environment; Web explicit `tsc` baseline errors are recorded as
  `BASELINE REPRODUCED — NOT PASS`, never as PASS, while the Next
  production build must still pass.
- No stage touches Migration 007, 012, or 013; checksums of existing
  migrations must remain identical.
- Real `.agentos` databases are never read, copied, or modified by any
  stage; tests use file-backed temporary databases only.
- The frozen atomic claim transaction (section 2) and the caller-owned
  transaction seam (section 3) bind every stage that touches claim,
  lifecycle transitions, or Operation writes.

This plan authorizes nothing. P3 implementation remains NOT AUTHORIZED.
P3A implementation remains NOT AUTHORIZED. The preplanning PR is NOT YET
AUTHORIZED.
