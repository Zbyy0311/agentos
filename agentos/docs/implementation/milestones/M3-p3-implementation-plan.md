# M3 P3 Implementation Plan — Run Engine, Workflow Executor and Operation

Status: PREPLANNING ONLY — P3 IMPLEMENTATION NOT AUTHORIZED — REMOTE CHECKS UNAVAILABLE — NOT PASS — PRODUCTION CUTOVER NOT AUTHORIZED / NOT STARTED

This plan decomposes M3 P3 into stages P3A–P3E. It is a planning artifact
only: no stage below is authorized, and no file allowlist below is an
authorization to edit. Each stage becomes executable only when explicitly
authorized in a future instruction, after the preceding stage's independent
review gate is accepted.

Companion document: `docs/implementation/milestones/M3-p3-current-state-audit.md`
(baseline `3728d670ce0f5c16d07819e65cddbc0bb4c6c5b2`).

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
OD-P3-04 (start completion timing, gates P3C). A stage that depends on an
undecided candidate must not start its dependent portion.

## 2. Stage P3A — Operation Persistence and Lifecycle Foundation

Goal: a durable Operation aggregate on the existing Migration 012
`operations` table, with repository, service, and lifecycle tests. No
routes, no engine.

Authorized scope (when authorized):

- `OperationRepository` (insert, get by id, get by correlation id, list by
  run, conditional status/version update).
- `OperationService` (create-for-command, transition with optimistic
  locking, terminal-state enforcement, result/ApiProblem persistence).
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
status/type rejected by CHECK.

Related regressions: migration 012 suite, store-level suites, server suite.

Failure injection: throw between operation insert and companion state write
inside one transaction; assert zero partial rows (operations, runs, events,
outbox) and `integrity_check`/`foreign_key_check` clean.

Concurrency race evidence: two conditional updates at the same expected
version — exactly one succeeds.

Stop conditions: any need for a schema change; status/type vocabulary
pressure beyond the frozen sets; any route or engine code requested.

Rollback boundary: delete the four new files as one package; the
`operations` table and any rows are preserved (no data reset).

Independent review gate: Operation != Run upheld; identity immutability;
version discipline; no transaction-core bypass; ApiProblem shape in
`error_json`.

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
  generation for non-create operations (OD-P3-01), and start completion
  timing (OD-P3-04) are explicitly OUT of P3A.

## 3. Stage P3B — Run Engine and Deterministic Workflow Executor

Goal: a tick-driven Run Engine that claims queued runs and a deterministic,
mock Workflow Executor that walks the snapshot V2 stage graph, driving all
transitions exclusively through the P2 transaction core.

Authorized scope (when authorized):

- `RunEngine` (claim one queued run atomically; dispatch to executor;
  observe outcomes).
- `WorkflowExecutor` + `StageExecutor` (deterministic `dependsOn` traversal
  from the persisted run snapshot; mock stage runner seam).
- Unit/integration tests with an injected transaction core.

Forbidden scope: ProcessManager, ProviderAdapter, CLI execution, real
provider runtime, Worktree runtime, Policy, Approval implementation, HTTP
routes, `recovery_required` writes, any scheduler table, any direct
repository writes bypassing events/outbox.

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/services/run-engine/RunEngine.ts` (new)
- `apps/server/src/services/run-engine/WorkflowExecutor.ts` (new)
- `apps/server/src/services/run-engine/StageExecutor.ts` (new)
- `apps/server/src/services/run-engine/*.test.ts` (new)

Dependencies: P3A accepted (engine records command outcomes on Operations);
no Owner Decision required for deterministic traversal itself.

RED tests: no engine/executor exists; a queued run is never advanced without
one.

GREEN tests: claim is atomic (two competing claims, one winner); engine
advances a claimed run through `transitionRun`/`completeRunStartup`;
executor honors `dependsOn` order exactly; failure marks downstream stages
`skipped` per spec; cancel during execution resolves through
`cancelRunWithinTransaction`; every transition emits event + outbox in the
same transaction.

Related regressions: LifecycleTransactionService suites, P2C-2A/P2C-2B
suites, RunRepository/RunStageRepository suites, migration suites.

Failure injection: inject at each event-call position in startup, stage
transition, and completion paths; assert zero partial commits, run left in a
consistent claimable or terminal state, integrity checks clean.

Concurrency race evidence: competing claims; cancel-during-dispatch;
stale-version dispatch loss. Losers fail cleanly with no state corruption.

Stop conditions: executor needs any M4 surface; engine bypasses the
transaction core; a scheduler table or queue table is requested; engine
writes `recovery_required`.

Rollback boundary: revert the `run-engine` package as a whole; runs, events,
and outbox rows are preserved (no data reset).

Independent review gate: single-writer ownership of queued runs; transaction
core exclusivity; determinism proof; no M4 imports.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 run engine and deterministic workflow executor`.

P3B requirements (binding):

- The engine claims only `runs(status='queued')`.
- Every state write goes through `LifecycleTransactionService`.
- The executor is deterministic and mock-driven; no CLI, no ProcessManager.
- Tick-driven: work advances on explicit ticks (test-controlled), not on
  wall-clock timers inside tests.
- Claim, dispatch, and outcome recording each carry injection points and
  concurrency guards.

## 4. Stage P3C — Async Start, Cancel Race, Child Retry

Goal: the asynchronous Start contract, Operation-level cancel/complete race
resolution, and retry-as-child-run, all idempotent.

Authorized scope (when authorized):

- Start route returning HTTP 202 + Operation (additive; v2/Legacy
  untouched).
- `run.start` and `run.retry` consumers wired through `IdempotencyService`.
- Retry service path creating child runs via `RunRepository.insert`
  lineage.
- Route and race tests.

Forbidden scope: synchronous start execution in the route handler;
resetting/mutating the parent run on retry; replacing v2 or Legacy
collections; Web changes; Operation cancel route (P3D); event query route
(P3D).

Exact proposed file allowlist (proposal, not authorization):

- `apps/server/src/routes/runLifecycle.ts` (new, or equivalent additive
  route module; final naming at implementation time)
- `apps/server/src/routes/runLifecycle.test.ts` (new)
- `apps/server/src/services/TaskRunService.ts` (minimal additive wiring
  only, if required; no behavioral change to existing methods)
- `apps/server/src/services/TaskRunService.test.ts` (additive cases only)
- `apps/server/src/index.ts` (one additive mount line)

Dependencies: P3A and P3B accepted; OD-P3-01 (correlationId generation for
`run.start`/`run.cancel`/`run.retry`) decided; OD-P3-04 (start completion
timing) decided.

RED tests: no start route; no `run.start`/`run.retry` idempotency consumer;
no retry caller.

GREEN tests: start returns 202 with an Operation; run remains queued until
the engine claims it; same idempotency key replays the original Operation;
different key on an already-started run is rejected per contract; retry
creates a child run with correct `root_run_id`/`parent_run_id` and the old
run untouched.

Related regressions: v2 route suites, idempotency suites, TaskRunService
suites, full server suite.

Failure injection: throw at each event-call position during start and during
retry creation; assert no partial commit, failed Operation carries
`error_json`, integrity checks clean.

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
mutation on retry; OD-P3-01 or OD-P3-04 still undecided when the dependent
code is reached.

Rollback boundary: revert route + wiring as one package; operations, runs,
events preserved (no data reset).

Independent review gate: Create != Start; 202 contract; idempotent replay;
race matrix evidence; retry lineage.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 async start cancel race and child retry`.

## 5. Stage P3D — Operation Routes and Event Query

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
commit; operation left in a consistent state.

Concurrency race evidence: cancel vs terminal transition on the same
operation — exactly one wins.

Stop conditions: an `operation_events` store is requested; OD-P3-02 or
OD-P3-03 undecided when the dependent code is reached.

Rollback boundary: revert the route module and mount line; data preserved.

Independent review gate: Operation != Run in API shape; events query uses
correlationId binding only; cancel semantics match the Owner Decision.

Commit boundary: one ordinary commit, only allowlisted files, e.g.
`feat: add M3 operation routes and event query`.

## 6. Stage P3E — Integrated Verification and Closeout

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

Dependencies: P3A–P3D all accepted.

Required integrated evidence: queued-run lifecycle end to end (create ->
202 start -> engine claim -> deterministic stage walk -> terminal state ->
Operation terminal state -> events query), plus the full race matrix under
integrated conditions.

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

## 7. Cross-Stage Standing Rules

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

This plan authorizes nothing. P3 implementation remains NOT AUTHORIZED.
