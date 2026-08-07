# M3 P3 Current-State Audit

Status: POST-MERGE MAIN BASELINE `de0b88fb0bed4a27cc38318481a0c7ccd47732a9`
P3C-0B: MERGED
Option A Alignment: MERGED via PR #29
P3C-1 Start Portion: IMPLEMENTED AND MERGED via PR #31
P3C-1 Retry contract: IMPLEMENTED CONTRACT / CURRENT
P3C-1 Retry production: IMPLEMENTED AND MERGED via PR #33
P3C-1: COMPLETE
P3D: NOT AUTHORIZED
P3E: NOT AUTHORIZED
Migration 014: NOT REQUIRED OR AUTHORIZED
Production Cutover: NOT AUTHORIZED / NOT STARTED
Remote Checks: UNAVAILABLE — NOT PASS

This document is the current-state audit of the AgentOS M3 P3 implementation
after PR #33 merged the P3C-1 Retry acceptance portion. It describes the
checkout at the post-merge main baseline and the implemented/current Retry
contract in this documentation set. It does not authorize P3D, P3E, Production
Cutover, or any production data operation.

## 1. Baseline and audit boundary

- Repository: Zbyy0311/agentos.
- Merged main baseline: `de0b88fb0bed4a27cc38318481a0c7ccd47732a9`.
- PR #33 merged the Retry acceptance portion with ordinary two-parent Merge
  Commit `de0b88fb0bed4a27cc38318481a0c7ccd47732a9`.
- Current docs closure branch: `docs/m3-p3c1-retry-closeout`.
- This documentation branch contains only the five allowlisted Markdown files;
  its commit is docs-only.
- Migration Registry contains exactly 001-013. Migration 014 is absent and is
  neither required nor authorized.
- Remote Checks: UNAVAILABLE — NOT PASS.
- Production Cutover: NOT AUTHORIZED / NOT STARTED.
- This docs-only closure changes only the allowlisted Markdown files. No
  database was migrated, restored, copied, or modified.

The current evidence is taken from merged main, PR #31's retained Start
evidence, and the read-only code seam audit for Retry. Production code, tests,
migrations, registries, Shared, Web, and Idempotency Core remain frozen inputs
to this docs-only closure.

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

### 3.8 Asynchronous Start Route — IMPLEMENTED

PR #31 merged the canonical `POST /api/runs/:runId/start` route and its A1
consumer. The route resolves the opaque Run locator before body parsing,
supports the frozen HTTP 202 keyed/no-key acceptance behavior, and composes
the caller-owned transaction with the existing Idempotency Core. Retained
evidence is Route 36/36, TaskRunService 83/83, combined 119/119, and the
full Server result recorded below. This Retry closure does not modify that
merged Start implementation.

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

### 3.11 Retry Lineage and Acceptance — IMPLEMENTED

RunRepository provides parent/root lineage computation and `listByTask`; the
P3C-0B Retry Idempotency Core provides the HTTP 201 schemaVersion 1 dual
snapshot and completed v3 Operation shape. PR #33 implements and merges the
production Retry Route, failed-Parent expected-version guard,
Child/Snapshot/Stage A2 transaction, fencing, creation Event/Outbox
composition, and independent Start call boundary. The five-doc closeout
records the merged evidence without changing those seams.

### 3.12 Canonical Top-Level Run/Operation Routes — PARTIAL

The canonical Start and Retry routes are implemented and merged. Operation
GET, Operation events, and Operation cancel routes remain absent. Existing
workspace-scoped v2 and Legacy routes do not replace those canonical surfaces.
SSE and Replay routes are outside this remediation and remain separately gated.

### 3.13 v2 + Legacy Compatibility — IMPLEMENTED

Legacy and v2 paths continue to exist and remain covered by the server suite.
The Web default is not switched. This remediation made no route, API, Web, or
Legacy behavior change. The P3 additions remain additive to the existing
compatibility paths.

### 3.14 correlationId Association — IMPLEMENTED

New non-create Operations use operation.id as their immutable correlationId.
The Start claim Event and later execution Events use the Start Operation ID.
The Retry acceptance Operation uses its own Operation ID. The Option A contract
keeps Retry creation Events associated with the Child Run ID and future Child
execution Events associated with an independent Start Operation ID. The
runtime_events index (run_id, correlation_id, sequence) exists.

### 3.15 Tests, Fixtures and Failure Injection — PARTIAL

Implemented evidence includes the merged Start and Retry routes, Operation
persistence, RunEngine claim, WorkflowExecutor, StageExecutor, startup
completion/failure, C1a/C1b/C2, Idempotency, rollback, integrity, foreign-key,
file-backed competition, Retry A2, Child clone, fencing, and Option A Engine
exclusion. P3D/P3E evidence remains a future gate. This docs-only closeout does
not run the full Server, Web, or Agent-core suites.

### Summary Counts

- IMPLEMENTED: 12
- PARTIAL: 3
- MISSING: 0
- CONTRACT ONLY: 0
- OUT OF SCOPE: 0
- TOTAL: 15

## 4. Gap Matrix (20 items)

Each row records current evidence, required target, implementation category,
dependency, test evidence, stop condition, and rollback boundary. The matrix
records stage ownership; P3C-1 Retry is merged/current, while P3D, P3E, and
Cutover remain unauthorized.

| # | Gap | Current evidence | Required target | Category | Depends on | Test evidence | Stop condition | Rollback boundary |
|---|---|---|---|---|---|---|---|---|
| 1 | Persistent queue ownership | RunEngine is the single current claim owner; queued alone never authorizes execution; only one binding-valid queued run.start qualifies | Preserve single-writer ownership and fail-closed Start selection | P3B-1 implemented | P3A, M3-TD-26 | RunEngine 18/18; P3B-1 4/4 | Any second queued-Run writer or non-Start authorization is introduced | Revert RunEngine package |
| 2 | Run claim/dequeue | Atomic caller-owned Operation, Run, Event, and Outbox claim path exists | Preserve one-transaction claim and binding checks | P3B-1 implemented | 1, P2 core | Claim rollback and competition evidence | Any split claim transaction or arbitrary Operation selection | Preserve durable rows; revert claim seam |
| 3 | Run Engine | tick(), dispatch(), explicit sync execution, no timer or scheduler, Retry-only noop | Preserve explicit Engine lifecycle and Option A selector | P3B-1/P3B-2B implemented | 1, P2 core | RunEngine and P3B-2B targeted suites | Background loop, scheduler table, or Retry-driven dispatch appears | Revert RunEngine package |
| 4 | Workflow Executor | WorkflowExecutor validates Snapshot V2, RunStage bindings, deterministic dependency traversal, and cycles | Preserve deterministic snapshot graph execution and fail-closed validation | P3B-2B implemented | P3B-1, P3B-2A | WorkflowExecutor targeted suite | Provider runtime or unvalidated graph traversal enters this boundary | Revert executor package |
| 5 | Stage orchestration | StageExecutor and lifecycle transitions provide explicit active/completed/failed outcomes and skipped propagation | Preserve deterministic Stage transitions; keep real provider execution in M4 | P3B-2B implemented | 3, 4, P2 core | StageExecutor and P3B-2B suites | Direct state writes, real Provider/Process/CLI runtime, or Event/Outbox bypass | Revert orchestration package |
| 6 | Operation persistence/lifecycle | OperationRepository and OperationService implement four types, seven statuses, identity immutability, optimistic locking, result/error storage, and caller-owned transactions | Preserve the Operation aggregate and expose it only through separately authorized routes | P3A implemented | P2 core, M3-TD-26 | Operation 34/34 | Identity, status, correlation, or transaction rules diverge | Revert repository/service package |
| 7 | HTTP 202 Start | PR #31 provides the production Start route, A1 consumer, and HTTP 202 acceptance at the current main baseline | Preserve the merged A1 route and its caller-owned transaction | P3C-1 Start implemented | 6, 15, 20, P3C-0A | Route 36/36; combined 119/119; full Server 1341/0/2 | Start route bypasses locator, replay, or atomicity contract | Revert Start package; preserve queued Runs and replay rows |
| 8 | Duplicate Start | Start route and immutable replay are implemented; the route rejects active different-key/no-key duplicates per the frozen matrix | Preserve same-key replay and fail-closed active Operation history | P3C-1 Start implemented | 7, 20 | Route and TaskRunService retained evidence | Duplicate route mutates a Run twice or bypasses idempotency | Preserve existing idempotency rows |
| 9 | Start failure rollback | A1 acceptance rollback and P3B-2B lifecycle rollback evidence are retained after PR #31 | Preserve one caller-owned transaction and zero partial acceptance state | P3C-1 Start implemented; P3B-2B | 2, 7, M3-TD-29 | Combined 119/119; full Server 1341/0/2 | Route acceptance creates partial Operation or lifecycle state | Revert Start package; preserve evidence |
| 10 | Cancel/complete race | Version guards and lifecycle cancellation foundations exist; Operation-facing race ownership is absent | Implement the P3D Operation Cancel race matrix with one caller-owned winner | P3D not authorized | 6, M3-TD-27, 9 | Existing P2C-2A/2B; future P3D matrix | Two terminal outcomes, split rollback, or Cancel assigned to the wrong class | Preserve Events and state; revert P3D package |
| 11 | Retry Child | PR #33 implements and merges the failed-Parent guard, V2 Snapshot clone, Child graph, history/active-slot fencing, Events/Outbox, and independent Start boundary | Preserve the merged B1-B12 behavior and Parent/Task immutability | P3C-1 Retry implemented and merged | 6, M3-TD-30, P3C-0B | Route 51/51; SnapshotService 12/12; TaskRunService 92/92; combined 155/155 | Retry metadata drives execution, Parent mutation, active-slot bypass, or partial Child acceptance | Preserve Parent and immutable replay rows |
| 12 | Operation events query | Runtime Event lookup index and Operation correlation fields exist; canonical query route is absent | Add authorized Operation events query with Start correlation and creation-event exclusion | P3D not authorized | 6, 19 | Future route query matrix | New operation_events store or unauthorized Event exposure | Preserve Runtime Events |
| 13 | Operation cancel | P2 cancelRunWithinTransaction exists; Operation Cancel route and ownership do not | Add M3-TD-27 Operation Cancel route and transaction orchestration | P3D not authorized | 6, 10 | Existing lifecycle cancellation suite; future P3D suite | Operation-row-only cancellation or second Cancel Operation | Preserve Operation, Run, Stage, Event, and Outbox rows |
| 14 | Task reconciliation | Existing v2 Task/Run linkage remains present; merged Start and Retry are additive and Retry active-slot fencing is evidenced | Preserve Task active-slot invariants and the merged Retry fencing | P3C-1 Retry implemented and merged | 5, 7, 11 | TaskRunService 92/92; combined 155/155 | Reconciliation bypasses existing Task invariants | Preserve Task state |
| 15 | Idempotency coverage | Eight operations, Start 202, Retry 201, schemaVersion 1, immutable envelopes, canonical hash, tamper rejection, and transaction/concurrency evidence are implemented | Keep core immutable while preserving the merged Start/Retry consumers | P3C-0A/P3C-0B implemented; Start and Retry consumers merged | P3A, M3-TD-30 | Idempotency Core unchanged; combined Retry evidence 155/155 | DB change, result schema v2, replay reread, or legacy behavior change | Preserve stored idempotency rows |
| 16 | recovery_required interaction | Migration 012 column and recovery paths exist; Engine does not write the flag directly | Preserve startup recovery ownership and flag semantics | P3B-1/P3C-1 boundary | P2 core | Full server and migration evidence | P3 code mutates recovery_required directly | Revert offending path |
| 17 | Legacy/v2 compatibility | Legacy and v2 paths remain present and full server compatibility tests pass | Keep all P3 additions additive | Standing constraint | None | Full server suite | Legacy/v2 regression or Web default switch | Revert offending package |
| 18 | M4 boundary | No production Provider, ProcessManager, CLI, Worktree, Policy, or Approval runtime is part of this implementation | Keep M4 runtime outside P3 | Standing constraint | None | Dependency scan and build | Any M4 runtime is introduced | Revert offending change |
| 19 | correlationId generation | Operation IDs and non-create correlation binding are implemented; Start execution uses Start ID; Retry metadata remains separate | Preserve immutable identity and query index semantics | P3A/P3B-1/P3C-0 implemented | M3-TD-26 | Operation and Engine suites | Second or mutable correlation identity appears | Preserve existing rows |
| 20 | Execution authorization selector | Current selector counts only one binding-valid queued run.start; queued/completed Retry is noop and multiple Start fails closed | Preserve Option A Engine authorization and require independent Start; Start and Retry acceptance routes are implemented | P3B-1 and P3C-1 implemented; Retry never authorizes Engine | 1, 3, M3-TD-30 | RunEngine 18/18; P3B-2B 33/33; Retry combined 155/155 | Any non-Start Operation is used to drive execution or any implicit scheduler appears | Revert selector/claim package |

## 5. Schema and contract verification

- Migration Registry remains exactly 001-013.
- Migration 014 does not exist and is not required by the current schema.
- Operations, runtime_events, outbox_messages, dead_letters, run_stages,
  idempotency_records, Workflow V2, and Snapshot V2 schema contracts are
  present at the implementation boundary.
- The runtime_events index (run_id, correlation_id, sequence) is present.
- The current Engine selector is a runtime contract: only run.start authorizes
  execution; run.retry remains immutable Retry metadata.
- The merged Start route is evidenced by PR #31 and the merged Retry route by
  PR #33; neither route is inferred from the Idempotency core.

## 6. Current P3 Owner Decisions

Unresolved P3 Owner Decisions: 0
Approved P3 Owner Decisions: 5
M3-TD-30 Current Contract: Option A, implemented through PR #33

The current decisions are recorded in M3-owner-decisions.md:

- M3-TD-26: non-create correlationId = operation.id.
- M3-TD-27: Operation Cancel is a caller-owned atomic transaction.
- M3-TD-28: P3 does not persist or populate Operation progress.
- M3-TD-29: Start Operation completion is committed with startup completion and
  does not track the Run to terminal state.
- M3-TD-30: Retry returns HTTP 201, persists queued Child metadata and a
  completed v3 Retry Operation snapshot, and requires an independent queued
  run.start for Engine execution.

These are technical contract records. The P3C-1 Retry Portion is implemented
and merged; they do not authorize P3D, P3E, or Production Cutover.

## 7. Current stage boundaries

- P3A Operation persistence and lifecycle: implemented in the current tree.
- P3B-1 execution-authorized claim: implemented in the current tree.
- P3B-2A startup-failure contract alignment: implemented in the current tree.
- P3B-2B Workflow, Stage, and atomic startup outcomes: implemented in the
  current tree.
- P3C-0A Start idempotency replay: merged in the current tree.
- P3C-0B Retry idempotency closure: merged in the current tree.
- P3C-1 Start production route: IMPLEMENTED AND MERGED via PR #31.
- P3C-1 Retry contract: IMPLEMENTED CONTRACT / CURRENT; production acceptance
  IMPLEMENTED AND MERGED via PR #33.
- P3C-1: COMPLETE.
- P3D Operation routes, query, and Cancel races: NOT AUTHORIZED.
- P3E integrated verification and Production Cutover: NOT AUTHORIZED.

This dependency record documents current state and future gates. It does not
authorize parallel implementation.

## 8. Retained verification evidence

The retained pre-merge evidence plus PR #31 and PR #33 evidence at main
`de0b88fb0bed4a27cc38318481a0c7ccd47732a9` is:

- RunEngine: 18/18.
- P3B-2B: 33/33.
- P3B-1: 4/4.
- Operation: 34/34.
- Idempotency: 108/108.
- P2C-2A: 30/30.
- P2C-2B: 15/15 (historical retained evidence).
- P3C-1 Start Route targeted: 36/36.
- P3C-1 TaskRunService targeted: 83/83.
- P3C-1 combined targeted: 119/119.
- P3C-1 Retry Route final: 51/51.
- P3C-1 Retry SnapshotService: 12/12.
- P3C-1 Retry TaskRunService: 92/92.
- P3C-1 Retry combined targeted: 155/155.
- P3C-1 Retry failure injection: 9/9.
- P3C-1 Retry real concurrency matrices: PASS.
- Full Server after PR #33: 1369 pass, 0 fail, 2 skips (1371 total).
- Agent-core: 123/123.
- Web: 86/86.
- Production Build: PASS.
- Web tsc: BASELINE REPRODUCED — NOT PASS.
- Two full-server skips remain environment-only: the Windows Unix socket
  informational test and the unconfigured AGENTOS_P3_SOURCE_ROOT real-copy
  rehearsal.

## 9. Standing constraints

- Queue Record = runs.status = queued; Queue scanning is not authorization.
- Start Route is implemented and merged; only one binding-valid queued
  `run.start` can claim a queued Run.
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

> **SUPERSEDED / HISTORICAL — NOT CURRENT STATUS.** This
> section records the earlier Start contract closure from baseline
> `8477e1f077c86948c9ab872b319365a4ca534b3e`. PR #31 subsequently merged the
> Start Route and A1 consumer. The current Retry contract closure is §11.

No code, test, schema, or runtime behavior is implied by the historical text.

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

## 11. P3C-1 Retry implemented contract and merge evidence

This current section records the Retry contract implemented and merged through
PR #33 at main baseline `de0b88fb0bed4a27cc38318481a0c7ccd47732a9`. The only
current contract is also recorded in the Owner Decision Register and
Runtime/API Specifications; all five documents must stay aligned. This
closeout changes documentation only.

Contract boundary count: 12 (`B1`–`B12`) documented in this contract record.
The Retry technical contract is IMPLEMENTED CONTRACT / CURRENT, and Retry
production acceptance is IMPLEMENTED AND MERGED via PR #33.

### Code seam audit and classification

| Seam | Current evidence | Classification for current/retained Retry |
| --- | --- | --- |
| `routes/runLifecycle.ts` | Canonical Start and Retry routes are implemented and merged through PR #31/#33 | IMPLEMENTED AND MERGED; this closeout FORBIDDEN TO MODIFY |
| `routes/runLifecycle.test.ts` | Start and Retry route, replay, error, rollback, and race evidence is merged | IMPLEMENTED AND MERGED; this closeout FORBIDDEN TO MODIFY |
| `TaskRunService.ts` | Start and caller-owned Retry A2 orchestration, lineage, fencing, and immutable replay are implemented | IMPLEMENTED AND MERGED; this closeout FORBIDDEN TO MODIFY |
| `TaskRunService.test.ts` | Start and Retry A1/A2, lineage, failure-injection, and race evidence is merged | IMPLEMENTED AND MERGED; this closeout FORBIDDEN TO MODIFY |
| `OperationService.ts` / `OperationRepository.ts` | `run.retry`, `createWithinTransaction`, `transitionWithinTransactionAt`, list-by-run, identity/result validation exist | REUSABLE AS-IS; FORBIDDEN TO MODIFY in Retry implementation unless a new review proves insufficiency |
| `RunRepository.ts` | Opaque locator, parent/root computation, `insert`, `findById`, `listByTask` exist; no Retry-specific fence | REUSABLE AS-IS; future service composes existing reads |
| `RunSnapshotRepository.ts` | V1/V2 exact validation, workflow binding, canonical JSON/hash, insert/read/integrity checks exist; no clone method | REUSABLE AS-IS; future SnapshotService seam must use it |
| `RunStageRepository.ts` | `insertInitial`, `listByRun`, and lifecycle transitions exist | REUSABLE AS-IS |
| `SnapshotService.ts` | Resolver-based V2 persistence and V2-only persisted Snapshot clone are implemented | IMPLEMENTED AND MERGED; this closeout FORBIDDEN TO MODIFY |
| `LifecycleTransactionService.ts` | `createRunGraphEventsWithinTransaction` validates V2 graph and writes ordered creation Events/Outbox | REUSABLE AS-IS |
| Idempotency types/service/repository | `run.retry`, HTTP 201, exact dual snapshot, canonical hash, replay and transaction seams are implemented | IMPLEMENTED / REUSABLE AS-IS; FORBIDDEN TO MODIFY |

### Current Retry contract

The canonical route is `POST /api/runs/:runId/retry`. The opaque locator runs
before parsing; miss is `404 RUN_NOT_FOUND`; all later access is workspace-
scoped. `Idempotency-Key` is required exactly once and normalized by the
existing parser. `expectedVersion` is required and must be a positive safe
integer. The only body is `{ "expectedVersion": 3 }`; query parameters,
unknown fields, malformed/empty JSON, non-plain objects, and extra Retry DTO
fields are rejected with `400 VALIDATION_FAILED`. There is no no-key path.

The Parent must be `failed` at the expected version. Stale is
`409 VERSION_CONFLICT`; non-failed is `409 RUN_NOT_RETRYABLE`. Parent and Task
are unchanged. The Child is queued with Parent workspace/task/objective,
`parentRunId = Parent.id`, `rootRunId = Parent.rootRunId`, `reason = retry`,
`origin = v2_api`, Parent `createdBy`, `nextEventSequence = 1`, and `version =
1`; all IDs/timestamps are fresh and client fields cannot override them.

Option A clones only the Parent persisted Snapshot V2 and RunStage graph. It
preserves workflow identity/hash, `worktreeMode`, ordered `dependsOn`, and
Agent/Provider snapshots, while remapping Child run metadata and refreshing
`capturedAt`, canonical JSON, hash, IDs, and timestamps. A V1/missing/malformed
Snapshot or graph mismatch is `500 RUN_RETRY_STATE_INCONSISTENT`. Child Stages
are fresh pending attempt-1/version-1 rows in Snapshot order.

The Parent-bound Retry Operation is `run.retry`, `aggregateType = run`,
`aggregateId = Parent.id`, `runId = Parent.id`, `correlationId = operation.id`,
and moves `queued/v1 -> running/v2 -> completed/v3` with result pointing to
the Child. The internal schemaVersion 1 envelope stores the original queued
Child and completed Operation snapshots; live and replay are HTTP 201 with
`{run, operation}`, and replay sets `Idempotency-Replayed: true` without
current-state rereads. Creation Events use Child Run correlation; future
execution Events use the independent `run.start` Operation ID. The completed
Retry Operation does not authorize execution, does not own `run.dequeued`, and
creates no independent Operation Event. `GET /api/operations/:operationId/events`
for `run.retry` queries the Retry Operation's `runId + correlationId` and
normally returns an empty collection in P3; it never returns Child creation or
independent Start execution Events.

### Frozen A2 order, errors, and evidence obligations

The exact caller-owned A2 order is: path read; opaque locator; locator miss;
query/body/header validation; key normalization; fingerprint; `prepare()`
outside transaction; `BEGIN IMMEDIATE`; `resolve()` first domain action;
immediate replay; scoped Parent read; expectedVersion; Parent status `failed`;
structural ambiguity; structural inconsistency; valid completed Retry/direct
Child duplicate; Task active-slot check; Snapshot V2 and Stage validation;
queued Operation v1; running v2; Child insert; Snapshot clone; Stage inserts;
Child `run.created`; ordered `stage.created`; matching Outboxes; completed
Operation v3; Child result binding; internal envelope; `storeSuccess()`;
Commit; top-level HTTP 201.
No nested transaction, automatic Start, Engine dispatch, or Operation Event
is permitted.

The stable errors are `VALIDATION_FAILED` 400, `RUN_NOT_FOUND` 404,
`VERSION_CONFLICT`/`RUN_NOT_RETRYABLE`/`IDEMPOTENCY_KEY_REUSED`/
`RUN_RETRY_ALREADY_CREATED`/`RUN_ACTIVE_EXISTS` 409,
`RUN_RETRY_STATE_AMBIGUOUS`/`RUN_RETRY_STATE_INCONSISTENT`/
`IDEMPOTENCY_RECORD_INVALID` 500,
`RUN_RETRY_BUSY` 503 with `retryable: true`, and sanitized `INTERNAL_ERROR`
500. No SQLite/SQL/path/key/stack/entity data leaks.

Injection at every Operation, Child, Snapshot, Stage, creation Event, Outbox,
completion/result, and `storeSuccess` point must roll back all Child,
Snapshot, Stage, Event, Outbox, Operation, and Idempotency rows while leaving
Parent and Task unchanged. Same key has one live 201 plus one replay 201;
different keys have one live 201 plus one duplicate 409; two different failed
Parents on one Task with different keys have exactly one live 201 and one
`409 RUN_ACTIVE_EXISTS`, exactly one active Child, and no loser
Operation/Snapshot/Stage/Event/Outbox/Idempotency row; stale versions are
zero-side-effect; Parent failure races have one optimistic winner; normal
races do not use 503. Creation correlation is Child ID, Stage creation
causation/parent is Child `run.created`, and future execution correlation is a
separate `run.start` Operation ID.

The exact history matrix is: creation is eligible only with zero direct Child,
zero completed Retry, and zero non-terminal Retry, while any number of failed
or cancelled Retry history rows may remain. Exactly one completed Retry plus
exactly one direct Child is a valid duplicate only when Operation and Child
workspace equal Parent workspace; Operation `aggregateId` and `runId` equal
Parent ID; Child `parentRunId`, `taskId`, and `rootRunId` equal Parent
bindings; Child `reason = retry`; Child status is queued or later legal
lifecycle state; Operation result is `{ resourceType: run, resourceId: Child.id }`;
and Operation is completed at version 3. Same-key replay precedes current
reads and a different key returns `409 RUN_RETRY_ALREADY_CREATED`.

More than one non-terminal Retry, more than one completed Retry, or more than
one direct Child returns `500 RUN_RETRY_STATE_AMBIGUOUS`. Missing Child,
missing completed Retry, any binding mismatch, queued/running Retry with a
Child, completed Retry not at version 3, missing exact result, or invalid Child
lineage returns `500 RUN_RETRY_STATE_INCONSISTENT`. Task active statuses are
queued, starting, running, waiting_approval, and paused. A valid direct Child
maps to `RUN_RETRY_ALREADY_CREATED`; any other active Task Run maps to
`409 RUN_ACTIVE_EXISTS` with safe message `Task already has an active run`.

### Implemented Retry scope and retained authorization boundary

PR #33 changed exactly these six existing production/test paths:

- `agentos/apps/server/src/routes/runLifecycle.ts`
- `agentos/apps/server/src/routes/runLifecycle.test.ts`
- `agentos/apps/server/src/services/TaskRunService.ts`
- `agentos/apps/server/src/services/TaskRunService.test.ts`
- `agentos/apps/server/src/services/SnapshotService.ts`
- `agentos/apps/server/src/services/SnapshotService.test.ts`

The SnapshotService change is limited to the V2-only `clonePersistedRun` seam.
Operation, Run, Snapshot, Stage, LifecycleTransaction, and Idempotency seams
are reused as-is. Shared, Migration/Registry, Idempotency Core, Operation
implementation, LifecycleTransactionService, RunEngine, WorkflowExecutor,
StageExecutor, Web, package/lockfiles, and real `.agentos` data are forbidden.

P3C-1 Retry production is IMPLEMENTED AND MERGED via PR #33. P3D, P3E,
Migration 014, and Production Cutover remain NOT AUTHORIZED. Draft PR, Ready,
and Merge are repository-governance actions and do not authorize P3D/P3E or
Production Cutover.

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
SUPERSEDED / HISTORICAL — NOT CURRENT CONTRACT. The current contract is the
Option A record in section 6:
Retry returns HTTP 201, remains outside Engine authorization, and requires an
independent Start Operation.

No sentence in this appendix is current evidence, a current dependency, a
current frozen contract, or a current stop condition.
