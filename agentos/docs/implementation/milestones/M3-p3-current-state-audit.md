# M3 P3 Current-State Audit

Status: POST-MERGE REMEDIATION 2 — OPTION A ENGINE AUTHORIZATION ALIGNMENT IMPLEMENTED — P3C-1 START BLOCKER CLOSURE (DOCS-ONLY) — P3C-1 AND LATER NOT AUTHORIZED — REMOTE CHECKS UNAVAILABLE — NOT PASS — PRODUCTION CUTOVER NOT AUTHORIZED / NOT STARTED

This document is the current-state audit of the AgentOS M3 P3 implementation
at the Option A implementation boundary. It describes the checkout containing
the merged P3C-0A/P3C-0B foundations and the a578982dc31cd8184ac5d7b1ba07454b4600cc70 RunEngine authorization
alignment. It does not authorize P3C-1, P3D, P3E, Production Cutover, or any
production route or data operation.

## 1. Baseline and audit boundary

- Repository: Zbyy0311/agentos.
- Merged main baseline: 8477e1f077c86948c9ab872b319365a4ca534b3e.
- Option A implementation: a578982dc31cd8184ac5d7b1ba07454b4600cc70.
- Expected parent of the Option A implementation: 82bee50416caff28caf5511be68420cf0ebb0805.
- Audit remediation commit: intentionally not prefilled before commit; the final report records its SHA.
- Current docs closure branch: docs/m3-p3c1-start-blocker-closure.
- PR #29 is merged into main with merge commit 8477e1f077c86948c9ab872b319365a4ca534b3e.
- Migration Registry contains exactly 001-013. Migration 014 is absent and is
  neither required nor authorized.
- Remote Checks: UNAVAILABLE — NOT PASS.
- Production Cutover: NOT AUTHORIZED / NOT STARTED.
- This docs-only closure changes only the allowlisted Markdown files. No
  database was migrated, restored, copied, or modified.

The current evidence is taken from the implementation commit and its local
targeted evidence. Production code, tests, migrations, registries, Shared,
Web, and Idempotency Core remain frozen inputs to this docs-only closure.

## 2. Current-state method

The audit inspects the current migration schema, shared contracts, repositories,
services, RunEngine, WorkflowExecutor, StageExecutor, routes, and tests. A
component is IMPLEMENTED when its current code and targeted evidence establish
the required M3 boundary. A component is PARTIAL when the foundation exists but
a separately owned route, race, or integration boundary remains. A component is
MISSING only when the required current production surface is not present.
Real user databases and production processes are outside this audit.

## 3. Current-State Audit (15 items)

### 3.1 Queue Record — IMPLEMENTED

The persistent Queue Record is runs.status = queued. Runs carry the M3 status
vocabulary, optimistic versioning, recovery_required, and next-event sequencing.
RunRepository.insert persists queued Runs inside the creation transaction. A
queued Run is necessary but not sufficient for execution: only one binding-valid
queued run.start Operation can authorize the RunEngine. A queued or completed
run.retry is not an Engine authorization and produces no-authorization without
claim writes.

### 3.2 P2 Transaction Core — IMPLEMENTED

LifecycleTransactionService and RunRepository provide the caller-owned Run
transition seam, startup completion seam, startup failure seam, approval and
cancellation composite transitions, and completion transitions. The
startup-failure Shared contract is aligned with the stage.failed then run.failed
ordering where a Stage has entered starting; the no-Stage-started branch retains
the single run.failed contract. State, Runtime Event, sequence, and Outbox
writes remain atomic and guarded by expected status and version. Migration 014
is not needed.

### 3.3 Run Engine — IMPLEMENTED

RunEngine exists at apps/server/src/services/run-engine/RunEngine.ts. Its tick()
and dispatch() methods are explicit synchronous calls; no background loop,
wall-clock timer, scheduler table, or automatic scan is registered. Claim
selection accepts only one queued, binding-valid run.start Operation. Queued or
completed run.retry is a repeatable noop/no-authorization. Multiple Start
Operations fail closed. A successful claim atomically transitions the Start
Operation and Run and appends the correlated Runtime Event and Outbox row.

### 3.4 Claim Ownership — IMPLEMENTED

P3B-1 claim ownership is implemented by RunEngine. Queue enumeration alone never
authorizes execution. Exactly one binding-valid queued run.start is the claim
marker; Retry Operations do not enter the authorization count. Run, Operation,
workspace, aggregate, and correlation bindings are checked before mutation.
There is no scheduler_jobs table and no background auto-scan. The absence of an
automatic scheduler is a current frozen boundary, not a missing implementation.

### 3.5 Workflow Executor — IMPLEMENTED

WorkflowExecutor exists at apps/server/src/services/run-engine/WorkflowExecutor.ts.
It validates a bound Snapshot V2 and its RunStage records, traverses persisted
dependsOn metadata deterministically by sequence and stable id ordering,
supports active, ready, pending, descendant, skip, and completion decisions,
and fails closed on malformed bindings, duplicate keys, forward dependencies,
missing dependencies, self-dependencies, or dependency cycles. The real provider
runtime is outside this M3 boundary.

### 3.6 Stage Executor — IMPLEMENTED

StageExecutor exists at apps/server/src/services/run-engine/StageExecutor.ts.
Its explicit test-controlled resolver returns only active, completed, or failed
results. Completed results validate duration, artifact ids, output-contract
satisfaction, and optional summary artifact; failed results validate ApiProblem,
phase, and retryScheduled = false. Provider, Process, and CLI execution remain
M4 boundaries and are not a P3 deficiency.

### 3.7 Operation Persistence — IMPLEMENTED

OperationRepository and OperationService exist and persist the four Operation
types run.create, run.start, run.cancel, and run.retry. The seven statuses are
queued, running, waiting_approval, paused, completed, failed, and cancelled.
The implementation enforces workspace and Run aggregate binding, immutable
identity and terminal state, optimistic concurrency, caller-owned transaction
composition, result and ApiProblem persistence, and correlationId =
operation.id for non-create Operations. Operation tests cover repository,
service, identity, transition, transaction, and concurrency behavior.

### 3.8 Asynchronous Start Route — MISSING

There is no production canonical Start Route and no P3C-1 Start consumer. The
Start acceptance transaction that would commit the queued run.start Operation
and its idempotency success response is not implemented. This remediation does
not implement or imply that route.

### 3.9 Start/Retry Idempotency Core — IMPLEMENTED

The Idempotency core contains eight operations: the six legacy operations plus
run.start and run.retry. The current contract is:

- run.start returns HTTP 202 and stores an immutable queued Operation replay.
- run.retry returns HTTP 201 and stores an immutable queued Child plus completed
  v3 Retry Operation replay.
- Both use result schemaVersion 1, canonical JSON, canonical hash verification,
  exact-shape parsing, tamper rejection, binding checks, and deep-detached reads.
- Repository and service operations compose with caller-owned transactions and
  include same-key concurrency protection.
- P3C-0A and P3C-0B are merged foundations; production route consumers remain
  P3C-1 scope and do not reduce this core item to PARTIAL.

### 3.10 Cancel/Complete Operation Race Closure — PARTIAL

Optimistic locking, version guards, and part of the lifecycle cancel/complete
foundation exist. The P3D Operation Cancel orchestration and the complete
claim-versus-cancel, startup-completion-versus-cancel, startup-failure-versus-
cancel, duplicate-cancel, and terminal-race matrix are not implemented.

### 3.11 Retry Lineage and Acceptance — PARTIAL

RunRepository provides parent and root lineage computation, and the failed
Parent foundation plus the P3C-0B Retry idempotency contract exist. Option A
keeps Retry metadata outside Engine authorization. The following remain
unimplemented: the production Retry Route; failed-Parent expected-version
validation in the route; the Child, Snapshot, Stage, Retry Operation, and
Idempotency acceptance transaction; concurrent Child-creation fencing; and the
production independent Start call chain.

### 3.12 Canonical Top-Level Run/Operation Routes — MISSING

Canonical Start and Retry routes, Operation GET, Operation events, and Operation
cancel routes are absent. Existing workspace-scoped v2 and Legacy routes do not
satisfy the canonical top-level Run/Operation route contract. SSE and Replay
routes are outside this remediation and remain separately gated.

### 3.13 v2 + Legacy Compatibility — IMPLEMENTED

Legacy and v2 paths continue to exist and remain covered by the server suite.
The Web default is not switched. This remediation made no route, API, Web, or
Legacy behavior change. The P3 additions remain additive to the existing
compatibility paths.

### 3.14 correlationId Association — IMPLEMENTED

New non-create Operations use operation.id as their immutable correlationId.
The Start claim Event and later execution Events use the Start Operation ID.
The Retry acceptance Operation uses its own Operation ID. The Option A contract
keeps future Retry creation Events associated with the Child Run ID and future
Child execution Events associated with an independent Start Operation ID. The
runtime_events index (run_id, correlation_id, sequence) exists.

### 3.15 Tests, Fixtures and Failure Injection — PARTIAL

Implemented evidence includes Operation persistence, RunEngine claim,
WorkflowExecutor, StageExecutor, startup completion and failure, C1a/C1b/C2,
Idempotency, rollback, integrity, foreign-key, file-backed competition, and
Option A Retry exclusion with independent Start tests. The remaining evidence
belongs to unimplemented P3C-1 Start/Retry route acceptance, P3D Operation
route and cancel-race orchestration, and P3E final integrated closeout.

### Summary Counts

- IMPLEMENTED: 10
- PARTIAL: 3
- MISSING: 2
- CONTRACT ONLY: 0
- OUT OF SCOPE: 0
- TOTAL: 15

## 4. Gap Matrix (20 items)

Each row records current evidence, required target, implementation category,
dependency, test evidence, stop condition, and rollback boundary. The matrix
records stage ownership; it does not authorize P3C-1, P3D, P3E, or Cutover.

| # | Gap | Current evidence | Required target | Category | Depends on | Test evidence | Stop condition | Rollback boundary |
|---|---|---|---|---|---|---|---|---|
| 1 | Persistent queue ownership | RunEngine is the single current claim owner; queued alone never authorizes execution; only one binding-valid queued run.start qualifies | Preserve single-writer ownership and fail-closed Start selection | P3B-1 implemented | P3A, M3-TD-26 | RunEngine 18/18; P3B-1 4/4 | Any second queued-Run writer or non-Start authorization is introduced | Revert RunEngine package |
| 2 | Run claim/dequeue | Atomic caller-owned Operation, Run, Event, and Outbox claim path exists | Preserve one-transaction claim and binding checks | P3B-1 implemented | 1, P2 core | Claim rollback and competition evidence | Any split claim transaction or arbitrary Operation selection | Preserve durable rows; revert claim seam |
| 3 | Run Engine | tick(), dispatch(), explicit sync execution, no timer or scheduler, Retry-only noop | Preserve explicit Engine lifecycle and Option A selector | P3B-1/P3B-2B implemented | 1, P2 core | RunEngine and P3B-2B targeted suites | Background loop, scheduler table, or Retry-driven dispatch appears | Revert RunEngine package |
| 4 | Workflow Executor | WorkflowExecutor validates Snapshot V2, RunStage bindings, deterministic dependency traversal, and cycles | Preserve deterministic snapshot graph execution and fail-closed validation | P3B-2B implemented | P3B-1, P3B-2A | WorkflowExecutor targeted suite | Provider runtime or unvalidated graph traversal enters this boundary | Revert executor package |
| 5 | Stage orchestration | StageExecutor and lifecycle transitions provide explicit active/completed/failed outcomes and skipped propagation | Preserve deterministic Stage transitions; keep real provider execution in M4 | P3B-2B implemented | 3, 4, P2 core | StageExecutor and P3B-2B suites | Direct state writes, real Provider/Process/CLI runtime, or Event/Outbox bypass | Revert orchestration package |
| 6 | Operation persistence/lifecycle | OperationRepository and OperationService implement four types, seven statuses, identity immutability, optimistic locking, result/error storage, and caller-owned transactions | Preserve the Operation aggregate and expose it only through separately authorized routes | P3A implemented | P2 core, M3-TD-26 | Operation 34/34 | Identity, status, correlation, or transaction rules diverge | Revert repository/service package |
| 7 | HTTP 202 Start | No production Start route or P3C-1 consumer exists; Idempotency core supports the Start response shape | Add the A1 Start acceptance transaction and canonical route only in P3C-1 | P3C-1 not authorized | 6, 15, 20, P3C-0A | Future route and A1 failure matrix | This audit or P3C-0B is used to imply route implementation | Preserve queued Runs and replay rows |
| 8 | Duplicate Start | Start replay parser and persistence are implemented; route consumer and duplicate active Operation policy are not exposed in production | Add same-key replay and different-key/active-Operation rejection in Start route | P3C-1 not authorized | 7, 20 | Future route replay and duplicate tests | Duplicate route mutates a Run twice or bypasses idempotency | Preserve existing idempotency rows |
| 9 | Start failure rollback | Startup completion/failure seams and injection rollback evidence exist for Engine-driven Start execution | Add A1 acceptance rollback while retaining B/C1a/C1b/C2 atomicity | P3C-1 plus P3B-2B | 2, 7, M3-TD-29 | P3B-2B 33/33; future A1 tests | Route acceptance creates partial Operation or lifecycle state | Revert route seam; preserve evidence |
| 10 | Cancel/complete race | Version guards and lifecycle cancellation foundations exist; Operation-facing race ownership is absent | Implement the P3D Operation Cancel race matrix with one caller-owned winner | P3D not authorized | 6, M3-TD-27, 9 | Existing P2C-2A/2B; future P3D matrix | Two terminal outcomes, split rollback, or Cancel assigned to the wrong class | Preserve Events and state; revert P3D package |
| 11 | Retry Child | Lineage and P3C-0B immutable Retry metadata exist; no production Retry acceptance route or Child creation transaction exists | Add failed-Parent expected-version acceptance, Child graph transaction, concurrency fencing, and independent Start call | P3C-1 not authorized | 6, M3-TD-30, P3C-0B | Idempotency 108/108; Option A Engine evidence; future A2 tests | Retry metadata drives execution, Parent mutation, or partial Child acceptance | Preserve Parent and immutable replay rows |
| 12 | Operation events query | Runtime Event lookup index and Operation correlation fields exist; canonical query route is absent | Add authorized Operation events query with Start correlation and creation-event exclusion | P3D not authorized | 6, 19 | Future route query matrix | New operation_events store or unauthorized Event exposure | Preserve Runtime Events |
| 13 | Operation cancel | P2 cancelRunWithinTransaction exists; Operation Cancel route and ownership do not | Add M3-TD-27 Operation Cancel route and transaction orchestration | P3D not authorized | 6, 10 | Existing lifecycle cancellation suite; future P3D suite | Operation-row-only cancellation or second Cancel Operation | Preserve Operation, Run, Stage, Event, and Outbox rows |
| 14 | Task reconciliation | Existing v2 Task/Run linkage and compatibility paths remain present; this remediation adds no route consumer | Preserve Task active-slot invariants when future P3C-1 execution is authorized | P3C-1 not authorized | 5, 7, 11 | Full server compatibility evidence | Reconciliation bypasses existing Task invariants | Revert future wiring; preserve Task state |
| 15 | Idempotency coverage | Eight operations, Start 202, Retry 201, schemaVersion 1, immutable envelopes, canonical hash, tamper rejection, and transaction/concurrency evidence are implemented | Keep core immutable and add route consumers only in their authorized stages | P3C-0A/P3C-0B implemented; P3C-1 consumers not authorized | P3A, M3-TD-30 | Idempotency 108/108; full server suite | DB change, result schema v2, replay reread, or legacy behavior change | Preserve stored idempotency rows |
| 16 | recovery_required interaction | Migration 012 column and recovery paths exist; Engine does not write the flag directly | Preserve startup recovery ownership and flag semantics | P3B-1/P3C-1 boundary | P2 core | Full server and migration evidence | P3 code mutates recovery_required directly | Revert offending path |
| 17 | Legacy/v2 compatibility | Legacy and v2 paths remain present and full server compatibility tests pass | Keep all P3 additions additive | Standing constraint | None | Full server suite | Legacy/v2 regression or Web default switch | Revert offending package |
| 18 | M4 boundary | No production Provider, ProcessManager, CLI, Worktree, Policy, or Approval runtime is part of this implementation | Keep M4 runtime outside P3 | Standing constraint | None | Dependency scan and build | Any M4 runtime is introduced | Revert offending change |
| 19 | correlationId generation | Operation IDs and non-create correlation binding are implemented; Start execution uses Start ID; Retry metadata remains separate | Preserve immutable identity and query index semantics | P3A/P3B-1/P3C-0 implemented | M3-TD-26 | Operation and Engine suites | Second or mutable correlation identity appears | Preserve existing rows |
| 20 | Execution authorization selector | Current selector counts only one binding-valid queued run.start; queued/completed Retry is noop and multiple Start fails closed | Preserve Option A Engine authorization and require independent Start in P3C-1 | P3B-1 implemented; P3C-1 grant not authorized | 1, 3, M3-TD-30 | RunEngine 18/18 and P3B-2B 33/33 | Any non-Start Operation is used to drive execution or any implicit scheduler appears | Revert selector/claim package |

## 5. Schema and contract verification

- Migration Registry remains exactly 001-013.
- Migration 014 does not exist and is not required by the current schema.
- Operations, runtime_events, outbox_messages, dead_letters, run_stages,
  idempotency_records, Workflow V2, and Snapshot V2 schema contracts are
  present at the implementation boundary.
- The runtime_events index (run_id, correlation_id, sequence) is present.
- The current Engine selector is a runtime contract: only run.start authorizes
  execution; run.retry remains immutable Retry metadata.
- No production Start or Retry route is inferred from the Idempotency core.

## 6. Current P3 Owner Decisions

Unresolved P3 Owner Decisions: 0
Approved P3 Owner Decisions: 5
M3-TD-30 Current Contract: Option A

The current decisions are recorded in M3-owner-decisions.md:

- M3-TD-26: non-create correlationId = operation.id.
- M3-TD-27: Operation Cancel is a caller-owned atomic transaction.
- M3-TD-28: P3 does not persist or populate Operation progress.
- M3-TD-29: Start Operation completion is committed with startup completion and
  does not track the Run to terminal state.
- M3-TD-30: Retry returns HTTP 201, persists queued Child metadata and a
  completed v3 Retry Operation snapshot, and requires an independent queued
  run.start for Engine execution.

These are technical contract records. They do not authorize P3C-1, P3D, P3E,
Production Cutover, production restore, or Legacy retirement.

## 7. Current stage boundaries

- P3A Operation persistence and lifecycle: implemented in the current tree.
- P3B-1 execution-authorized claim: implemented in the current tree.
- P3B-2A startup-failure contract alignment: implemented in the current tree.
- P3B-2B Workflow, Stage, and atomic startup outcomes: implemented in the
  current tree.
- P3C-0A Start idempotency replay: merged in the current tree.
- P3C-0B Retry idempotency closure: merged in the current tree.
- P3C-1 Start and Child Retry production routes: NOT AUTHORIZED.
- P3D Operation routes, query, and Cancel races: NOT AUTHORIZED.
- P3E integrated verification and Production Cutover: NOT AUTHORIZED.

This dependency record documents current state and future gates. It does not
authorize parallel implementation.

## 8. Retained verification evidence

The local evidence retained from a578982dc31cd8184ac5d7b1ba07454b4600cc70 is:

- RunEngine: 18/18.
- P3B-2B: 33/33.
- P3B-1: 4/4.
- Operation: 34/34.
- Idempotency: 108/108.
- P2C-2A: 30/30.
- P2C-2B: 15/15.
- Full Server: 1279 pass, 0 fail, 2 skip.
- Agent-core: 123/123.
- Web: 86/86.
- Production Build: PASS.
- Web tsc: BASELINE REPRODUCED — NOT PASS.
- Two full-server skips remain environment-only: the Windows Unix socket
  informational test and the unconfigured AGENTOS_P3_SOURCE_ROOT real-copy
  rehearsal.

## 9. Standing constraints

- Queue Record = runs.status = queued; Queue scanning is not authorization.
- Only one binding-valid queued run.start can claim a queued Run.
- Queued or completed run.retry never authorizes, claims, or dispatches.
- All lifecycle state, Runtime Event, sequence, and Outbox writes use the P2
  transaction core.
- No scheduler_jobs table, background Engine loop, automatic scan, or wall-clock
  execution loop exists.
- Legacy and v2 paths remain usable; Web default is not switched.
- Provider, Process, CLI, Worktree, Policy, Approval runtime is M4 scope.
- No Migration 014, production data operation, restore, deletion, or Cutover is
  authorized.
- Remote Checks: UNAVAILABLE — NOT PASS.

## 10. P3C-1 Start pre-implementation blocker closure (docs-only)

This section records the contract closure performed from the merged
`main`/`origin/main` baseline `8477e1f077c86948c9ab872b319365a4ca534b3e`.
The production canonical Start Route remains MISSING and P3C-1 Start
implementation remains NOT AUTHORIZED. No code, test, schema, or runtime
behavior is implied by this closure.

### HIGH-1 — canonical Run workspace resolution

The only future Start path is:

```text
POST /api/runs/:runId/start
```

It has no workspace path, query, or body field. Run IDs are global opaque
routing identifiers. Future implementation adds only the read-only method
`RunRepository.findWorkspaceIdByOpaqueId(runId): string | undefined`; it returns
only workspaceId, performs no status/version check, and mutates nothing. A
missing Run is `404 RUN_NOT_FOUND`, never `WORKSPACE_NOT_FOUND`. Once resolved,
the workspaceId is included in the Idempotency fingerprint and all Run,
Operation, and Idempotency access remains workspace-scoped. Local API Write
Guard and Server Ownership remain the current security boundary.

### HIGH-2 — SQLite busy/contention contract

Production `SqliteStore` must execute `PRAGMA busy_timeout = 5000` after
`DatabaseSync` creation and before migrations, while retaining
`PRAGMA foreign_keys = ON`. Normal same-key, different-key, and no-key Start
races converge to live 202, replay 202, or a stable 409 conflict. Raw
`SQLITE_BUSY`, SQLite text, SQL, paths, and lock details never reach clients.
Human-held write-lock timeout is the only 503 case and is frozen as:

```text
RUN_START_BUSY / 503 / Run start is temporarily unavailable / retryable=true
```

`Transaction.ts` is unchanged and existing v2 mutation behavior is preserved.

### HIGH-3 — complete Start Operation history

Future acceptance reads `OperationService.listByRun(workspaceId, runId)` and
filters `type === 'run.start'`; the non-terminal-only query cannot replace the
full history. No history or all `failed`/`cancelled` history permits creation.
One queued Start replays the original 202 for the same key and returns
`409 RUN_START_ALREADY_ACTIVE` for a different or absent key. Multiple
non-terminal Starts fail closed with `500 RUN_START_AUTHORIZATION_AMBIGUOUS`.
A queued Run with `running`, `waiting_approval`, or `paused` Start history, or
with any completed Start history, fails closed with
`500 RUN_START_STATE_INCONSISTENT`. Failed/cancelled history is terminal and
does not authorize execution; no Start row may be selected arbitrarily.

### A1 ordering, side effects, rollback, and composition

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

The future route creates IdempotencyService through
`createOptionalIdempotencyService(store)`, creates a route-local TaskRunService
with it, and is mounted once under `/api` by `index.ts`. It does not reuse the
no-Idempotency TaskRunService used by Legacy recovery. Run deletion and
workspace migration require a new replay/locator review and are outside M3.

### Revised future Start allowlist

The proposal, not authorization, is exactly:

- `apps/server/src/routes/runLifecycle.ts` (new);
- `apps/server/src/routes/runLifecycle.test.ts` (new);
- `apps/server/src/services/TaskRunService.ts`;
- `apps/server/src/services/TaskRunService.test.ts`;
- `apps/server/src/store/SqliteStore.ts`;
- `apps/server/src/store/RunRepository.ts`;
- `apps/server/src/store/__tests__/RunRepository.test.ts`;
- `apps/server/src/index.ts`.

`routes/v2Idempotency.ts`, OperationService, OperationRepository, Idempotency
Core, and Shared may be imported but not modified. Retry production code,
Operation Cancel, Event Query/SSE, RunEngine, LifecycleTransactionService,
RunStageRepository, Migration/Registry, Web, package/lockfiles, Legacy/v2
routes, Conversation EventBus, and Production Cutover remain forbidden.

## Appendix — Historical Pre-P3 Baseline

### Historical Baseline — Superseded

SUPERSEDED / HISTORICAL — NOT CURRENT STATE

Before P3A, P3B, and P3C-0 implementation was merged, the audit described the
RunEngine, WorkflowExecutor, StageExecutor, OperationRepository,
OperationService, and Operation idempotency extensions as missing or partial.
Its historical summary was IMPLEMENTED 3, PARTIAL 6, MISSING 6, CONTRACT ONLY 0,
and OUT OF SCOPE 0. That count is retained only for traceability and is not the
current Summary Counts.

The pre-Option-A record also contained an Option B Retry proposal in which Retry
returned HTTP 202, immediately authorized Engine execution, required no
separate Start, and used an Operation-only replay envelope. That proposal is
superseded. The current contract is the Option A record in section 6:
Retry returns HTTP 201, remains outside Engine authorization, and requires an
independent Start Operation.

No sentence in this appendix is current evidence, a current dependency, a
current frozen contract, or a current stop condition.
