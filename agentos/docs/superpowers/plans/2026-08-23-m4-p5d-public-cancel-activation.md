# M4-P5D Full Public Command Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the existing public Operation cancel command for active Runs using proven Process evidence and the accepted lifecycle transaction handoff.

**Architecture:** The Operation route keeps the frozen `{ expectedVersion }` HTTP contract and invokes an injected runtime cancellation port outside SQLite. The existing `RunEngineProviderDispatcher` delegates to `StageExecutionCoordinator.cancelAttempt`, converts only an explicit proven `processId` into evidence, and the existing `OperationService` passes that evidence to `LifecycleTransactionService.cancelRunForOperationWithEvidenceWithinTransaction` inside the one caller-owned transaction.

**Tech Stack:** TypeScript, Express, Node test runner, `node:sqlite`, pnpm workspace, `@agentos/process-runtime`, existing RunEngine/Operation/Lifecycle services.

**Spec:** `docs/superpowers/specs/2026-08-23-m4-p5d-public-cancel-activation-design.md`

## Global Constraints

- Do not modify Process Runtime ownership semantics.
- Do not introduce a second cancellation or finalizer path.
- Reuse `LifecycleTransactionService`, `ProcessCancelCoordinator`, `finalizeAttemptOnce`, and the existing cancellation body.
- Public cancel must flow through the lifecycle transaction seam.
- The internal caller must provide `expectedRunVersion` and `terminatedProcessIds` evidence.
- Do not fabricate PID/process identity or re-query repositories to discover native process IDs.
- Preserve `approval.resolved -> stage.cancelled* -> run.cancelled` and generic waiting rejection.
- Do not modify P5E/P6.
- Keep the HTTP cancel body exactly `{ expectedVersion }`; process evidence is never client supplied.
- Preserve the dirty original checkout; all implementation work occurs in the isolated worktree.

---

### Task 1: Add failing P5D contract tests

**Files:**
- Modify: `apps/server/src/services/OperationService.test.ts`
- Modify: `apps/server/src/routes/operations.test.ts`
- Modify: `apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts`

**Interfaces:**
- Consumes: existing `OperationService`, `createOperationRoutes`, and `RunEngineProviderDispatcher` fixtures.
- Produces: executable tests that require an internal `CancelOperationEvidence` value and a dispatcher `cancelRun` method.

- [ ] **Step 1: Write the failing dispatcher test**

Add a test that supplies a fake coordinator stopped outcome with
`stopOrigin: 'EXPLICIT_CANCEL'`, `proven: true`, and `processId: 'process-exact'`,
then asserts `dispatcher.cancelRun(...)` returns
`terminatedProcessIds: ['process-exact']` and the captured Run version. Add a
second test asserting an unproven stopped outcome rejects without returning
evidence.

- [ ] **Step 2: Write the failing service evidence tests**

Add tests for `OperationService.cancel({ ..., evidence })` that assert:

```ts
evidence = {
  expectedRunVersion: 1,
  terminatedProcessIds: ['process-exact'],
  processId: 'process-exact',
  worktreePreserved: true,
}
```

is passed unchanged to
`cancelRunForOperationWithEvidenceWithinTransaction`, while absent evidence
fails closed for an active runtime request and a mismatched `processId` versus
`terminatedProcessIds` is rejected without changing Operation, Run, Stage, or
Events.

- [ ] **Step 3: Write the failing route/integration tests**

Extend the route fixture with a fake active-cancel port and add tests for:

1. active running success;
2. stale Run version rejection and unchanged state;
3. repeated cancellation returning the same cancelled Operation with one
   lifecycle event set;
4. waiting approval preserving `approval.resolved`, `stage.cancelled`, and
   `run.cancelled` order;
5. missing evidence and process evidence mismatch returning sanitized failure;
6. terminal Run remaining unchanged;
7. two concurrent requests yielding one lifecycle winner and an idempotent
   loser.

Keep all requests body-valid with exactly `{ expectedVersion: 1 }` and assert
that no client process fields are accepted.

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
pnpm --filter @agentos/server exec node --import tsx --test --test-concurrency=1 src/services/run-engine/RunEngineProviderDispatcher.test.ts src/services/OperationService.test.ts src/routes/operations.test.ts
```

Expected: the new tests fail because the dispatcher and evidence activation
interfaces are not implemented; existing tests should remain otherwise
diagnostic.

### Task 2: Implement the existing dispatcher cancellation seam

**Files:**
- Modify: `apps/server/src/services/run-engine/RunEngineProviderDispatcher.ts`
- Modify: `apps/server/src/services/run-engine/providerExecutionChain.ts`

**Interfaces:**
- Consumes: `StageExecutionCoordinator.cancelAttempt` and the existing Run/Stage repositories.
- Produces: `RunEngineProviderDispatcher.cancelRun(input)` returning internal
  cancellation evidence with `expectedRunVersion`, exact `processId` when
  proven, `terminatedProcessIds`, and `worktreePreserved`.

- [ ] **Step 1: Implement only the proven evidence mapping**

Select the one non-terminal active Stage by persisted lifecycle status. For a
provider-backed attempt call the existing coordinator `cancelAttempt` with a
deterministic correlation/causation pair. Accept only a `stopped` outcome with
`stopOrigin === 'EXPLICIT_CANCEL'`, `proven === true`, and a non-blank
`processId`; return `[outcome.processId]` without reading native PID fields or
querying a repository for a replacement identity.

- [ ] **Step 2: Fail closed for unsupported outcomes**

Reject unproven, failed, ambiguous, unavailable, or terminal cancellation
requests. A queued or approval-waiting Run with no provider Process may return
an explicit empty `terminatedProcessIds` list; an active provider Stage without
proof must reject.

- [ ] **Step 3: Run dispatcher tests and verify GREEN**

Run the dispatcher test file and confirm the new evidence and fail-closed tests
pass without any Process Runtime source changes.

### Task 3: Wire evidence through Operation cancel and production routes

**Files:**
- Modify: `apps/server/src/services/OperationService.ts`
- Modify: `apps/server/src/routes/operations.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**
- Consumes: dispatcher `cancelRun` evidence and the existing lifecycle service.
- Produces: production `POST /api/operations/:operationId/cancel` active
  cancellation using the existing transaction guard and lifecycle body.

- [ ] **Step 1: Add internal evidence validation**

Validate positive safe `expectedRunVersion`, a string array of non-blank unique
Process IDs, and the boolean worktree flag. When a process identity is present,
require the evidence list to be exactly that identity; reject missing or
mismatched evidence before the Operation update.

- [ ] **Step 2: Reuse the single Operation guard and transaction**

Keep `cancel`/`cancelWithinTransaction` as the one Operation cancellation guard.
For runtime-backed requests, update the Operation and call
`cancelRunForOperationWithEvidenceWithinTransaction` in the same transaction;
do not copy Stage/Run/event mutation logic. Retain the existing fallback only
for pre-existing internal callers that do not activate the runtime port.

- [ ] **Step 3: Add the route runtime port without changing HTTP shape**

Preflight the persisted Operation version and terminal/idempotent cases before
process cleanup. Await the injected runtime cancellation port for cancellable
Operations, then pass its evidence to the service. Map Run version conflicts
to the existing `409 VERSION_CONFLICT`; sanitize evidence/runtime errors as
`500 INTERNAL_ERROR` and preserve existing Operation error mappings.

- [ ] **Step 4: Wire the existing provider chain at the composition root**

Create the existing `createProviderExecutionChain` once during server service
composition and pass `dispatcher.cancelRun` to `createOperationRoutes`. Do not
start a new dispatcher loop or alter Process Runtime construction/ownership.

- [ ] **Step 5: Run focused service/route tests and verify GREEN**

Run the focused server tests again. Confirm active success, stale conflict,
idempotency, approval ordering, evidence failures, terminal protection, and
concurrent behavior all pass.

### Task 4: Full verification and scope audit

**Files:**
- Inspect only: all changed files and existing test outputs.

**Interfaces:**
- Consumes: completed implementation and test evidence.
- Produces: exact changed-file report and a pushed branch with no PR.

- [ ] **Step 1: Run targeted P5D tests**

Run the new dispatcher, service, and route tests plus the accepted P5D-0/P5D-1
handoff/evidence tests.

- [ ] **Step 2: Run the required full suites**

Run the server full suite, process-runtime suite, M3 harness, and workspace
build. Do not modify or reinterpret the existing W12 evidence.

- [ ] **Step 3: Run final static checks**

Run `git diff --check`, inspect `git status --short`, and compare the changed
paths against the approved server route/service/composition/test scope. Stop if
any Process Runtime, P5E, P6, PID-discovery, or second-cancellation-path change
appears.

- [ ] **Step 4: Report scope before commit**

Report changed files, unexpected files, and scope boundaries. Only after the
report is internally consistent create one ordinary forward commit, push
`runtime/m4-p5d-public-cancel-activation`, and do not create a pull request.
