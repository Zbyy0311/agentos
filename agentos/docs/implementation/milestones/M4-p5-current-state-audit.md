# AgentOS M4-P5 Cancellation, Process Tree, Timeout and Transport — Current-State Audit

Status: M4-P5 PRE-IMPLEMENTATION PLANNING — DOCS ONLY — M4-P5 PRODUCTION IMPLEMENTATION NOT AUTHORIZED

Remediation note (2026-08-20): after the first and second Independent Plan
Reviews, the four planning documents were remediated in two docs-only commits.
This third docs-only remediation closes HIGH-A..D, MEDIUM-A..B and LOW by
freezing one proof-aware normalization seam, exact no-proof durable outcome,
the internal P5A/public P5D split, exact claim lookup ports, Operation
two-phase cancellation, and the P5C stage-attempt/cursor failure contract.
This audit's production facts still describe the accepted M4-P4 base
`750a780c`; no production or test implementation is authorized by this
remediation.

## 1. Metadata / exact base

| Field | Value |
|---|---|
| Repository | `Zbyy0311/agentos` (planning tree: `E:\workspace\Multi-Agent-worktrees\agentos-m4-p3\agentos`) |
| Accepted M4-P4 HEAD | `750a780c7668aecbc52c661bee1bcadb7f6b188c` (`runtime/m4-p4-runengine-kimi`) |
| M4-P4 parent | `385f020883eb0cd83c385cd42a5ad1d08e0eb691` |
| M4-P4 status | COMPLETE / Second Independent Review ACCEPTED |
| M4-P5 planning branch | `docs/m4-p5-planning` created directly from `750a780c` |
| Authoritative main | `debb8aa0911b8feb12fb17ee89db913f0a313ec5` (origin/main at audit time) |
| Migration 014 | IMPLEMENTED (P2A) — `apps/server/src/migrations/migrations/014-m4-process-runtime-schema.ts` |
| Audit date | 2026-08-15 (Asia/Shanghai) |

Base-ownership conclusion: **unambiguous**. The P3/P4 worktree sits exactly at
the accepted M4-P4 HEAD `750a780c` with a clean tree; `origin/main` has not yet
merged P3/P4 (main = `debb8aa0`, the P2B durable-process merge). P5 planning
therefore proceeds from the accepted M4-P4 HEAD, not from `origin/main`.

## 2. Methodology

1. Read the authoritative M4 implementation plan (§7 P5 definition),
   M4-P0 runtime contract, event/error contract, acceptance matrix, current-state
   audit and owner-decision register in full.
2. Audited the actual production implementation at `750a780c` — not only docs:
   `packages/process-runtime/src/**`, `apps/server/src/services/run-engine/**`,
   `apps/server/src/store/ProcessRepository.ts`,
   `apps/server/src/store/ProviderSessionRepository.ts`,
   `apps/server/src/store/process-runtime-adapters.ts`,
   `apps/server/src/services/LifecycleTransactionService.ts`,
   `apps/server/src/services/TaskRunService.ts`,
   `apps/server/src/routes/{canonicalRuns,v2Runs,operations,conversations,canonicalRunEvents}.ts`,
   `apps/server/src/index.ts`, `apps/server/src/services/RunStreamService.ts`,
   `packages/agent-core/src/executor.ts`,
   `packages/agent-core/src/providers/kimiCodeAdapter.ts`,
   `apps/server/src/migrations/migrations/014-m4-process-runtime-schema.ts`.
3. Searched production code for `AbortController`, `abort`, `cancel`,
   `terminate`, `kill`, `taskkill`, `SIGTERM`, `SIGKILL`, `Job Object`,
   `process group`, `detached`, `res.close`, `req.close`, `socket.close`,
   `timeout`, `idle`, `startup`, `grace`, `survivor`, `gracefulStop`,
   `terminateTree`, `verifySurvivors`.
4. Cross-checked the frozen Runtime Specification sections 29–42 and the
   disconnect contract (`02-Runtime-Lifecycle.md:2382-2428`, `2670`).

Status vocabulary matches the M4 convention:

- `IMPLEMENTED`: production path satisfies the frozen contract slice.
- `PARTIAL`: a usable portion exists but the M4-P5 contract is incomplete.
- `MISSING`: the required capability does not exist.
- `CONFLICTING`: current behavior violates or competes with the target contract.
- `OUTSIDE_P5`: exists but is owned by another phase and must not be broadened.

## 3. Current-state matrix

| Row | Area | Source file / symbol | Existing behavior | Authoritative contract | Gap | Status | Proposed P5 owner |
|---|---|---|---|---|---|---|---|
| CS-01 | Explicit Run cancel (canonical) | `routes/canonicalRuns.ts:116`; `routes/v2Runs.ts:40`; `TaskRunService.cancelQueuedRunForV2` | Only `queued` Run is cancellable; `RUN_NOT_CANCELLABLE` otherwise; the existing M3 composite remains authoritative for approval cancellation | explicit cancel must propagate once through Session/Process tree to canonical terminal | public active route/application composition does not exist at P4 base | PARTIAL / CONFLICTING | P5A internal authority; P5D public command activation |
| CS-02 | Operation cancel | `routes/operations.ts:152-202`; `OperationService.cancel` | M3 authorization revocation; current active path marks Operation cancelled and calls LTS with `terminatedProcessIds: []` | active Operation cancellation must use the same proven internal authority | active empty-ID bypass can terminalize Run without Process evidence | CONFLICTING | P5D two-phase Operation seam |
| CS-03 | Execution/Stage-attempt cancel | `StageExecutionCoordinator.execute` | no canonical attempt-cancel command exists | exactly-one internal authority with exact claim correlation | MISSING | P5A internal `cancelAttempt` |
| CS-04 | Provider Session cancel | `repository-port.ts` `DurableSessionStatus` includes `cancelled`; `provider.sessions` migration 014 | status exists; no production transition path to `cancelled`; `provider.session_cancelled` is `SPEC_RECONCILIATION_REQUIRED` (P0 event-error contract) | successful cancellation finalizes Session as `cancelled` only after proven cleanup | MISSING | P5A (finalize) / P3-reconciliation gate |
| CS-05 | Process stop pipeline (in-memory) | `process-runtime/src/manager.ts` `ProcessManager.stop` + `#runCleanup` | idempotent stop ticket; `created->failed` cancelled-before-spawn; `starting->stopping` with null PID; grace -> terminateTree -> verifySurvivors -> exited/orphaned | P0 §7/§13 race rules | pipeline exists but tree driver is stubbed | PARTIAL | P5A/P5B |
| CS-06 | Durable Process stop | `durable-coordinator.ts` | retains native handles in `#handles`; no stop/cancel entry point; handles are deleted only on spawn-failure compensation and late-success cleanup; a normal `running` process keeps its handle for the whole run and is never cleaned by a stop request | durable stop ticket must accept and coordinate tree cleanup | MISSING — durable coordinator needs an explicit stop/cancel surface | PARTIAL | P5A |
| CS-07 | gracefulStop | `node-driver.ts:65-72` | `child.kill(SIGTERM)`; on Windows Node maps to `TerminateProcess` | bounded platform graceful capability; Provider-native interrupt first on Windows | single-root signal; no console-group Ctrl handling; no stdin-close option | PARTIAL | P5B |
| CS-08 | terminateTree | `node-driver.ts:74-86` | `child.kill(SIGKILL)`; returns `complete` when the kill call returned `true` | force tree termination; parent-PID kill alone MUST NOT be treated as successful tree cleanup | kills only the root PID; `complete` is guessed success | CONFLICTING | P5B |
| CS-09 | verifySurvivors | `node-driver.ts:88-97` | root exited -> `complete`; root alive -> `unknown` | survivor verification must classify root + known + newly discovered descendants | no tree enumeration; `complete` without evidence | CONFLICTING | P5B |
| CS-10 | inspectIdentity | `node-driver.ts:99-108` | `process.kill(pid, 0)` liveness only | PID reuse checked before every signal; identity beyond PID (start time/executable/token) | no start-time/executable comparison; PID-reuse not fenced | PARTIAL | P5B |
| CS-11 | Process state transitions (durable) | `ProcessRepository.ts:47-50`; migration 014 | full frozen state machine + CAS + `stopping_at`/`termination_reason`/`cleanup_result` columns | P0 §7 exactly | durable CAS present | IMPLEMENTED | reuse |
| CS-12 | LifecycleTransactionService | `LifecycleTransactionService.ts:1366-1440` | sole canonical Run/Stage terminal writer; accepts `terminatedProcessIds`; current command paths can supply an empty list | LifecycleTransactionService remains canonical terminal authority | P5D must call only after proven active Process cleanup; queued zero-ID is the sole exception | PARTIAL | P5D hand-off |
| CS-13 | Timeout machinery | `process-runtime/src/timeouts.ts` `ProcessTimers` | startup/idle/total with injected clock; idle resets on activity, pauses on `waiting` | P0 §TD-09; spec §§29-33 | implemented at package level | IMPLEMENTED | P5C wiring |
| CS-14 | Timeout policy wiring (durable path) | `StageExecutionCoordinator.ts:224` | only `graceMs` is passed from snapshot (`cancelGracePeriodMs`); `startupMs/idleMs/totalMs` from snapshot policy are NOT consumed | startup/idle/total terminal reasons on the durable path | durable execution has no startup/idle/total enforcement | CONFLICTING | P5C |
| CS-15 | Legacy timeout | `agent-core/src/executor.ts:461-542` | idle + total timers; AbortSignal; kill single child | Legacy compatibility surface; not the canonical authority | legacy only; not P5 primary | PARTIAL | OUTSIDE_P5 (compat) |
| CS-16 | HTTP disconnect (canonical SSE) | `routes/canonicalRunEvents.ts:118-140` | close/error -> unsubscribe only | E08 | satisfies | IMPLEMENTED | P5D regression |
| CS-17 | HTTP disconnect (Legacy task SSE) | `routes/tasks.ts:296-369` | `res.close -> cleanup(false)` unsubscribe only; fire-and-forget | E08 | satisfies | IMPLEMENTED | P5D regression |
| CS-18 | SSE disconnect (Conversation initial) | `routes/conversations.ts:410-456` | `res.on('close')` calls `abortController.abort()`; signal reaches `CLIExecutor` and kills the provider child | browser owns subscription only; disconnect must not terminate Process/Run | CONFLICTING — disconnect can kill provider execution | CONFLICTING | P5D |
| CS-19 | SSE disconnect (Conversation resume) | `routes/conversations.ts:540-567` | close -> unsubscribe only | E08 | satisfies | IMPLEMENTED | P5D regression |
| CS-20 | Conversation explicit cancel | `routes/conversations.ts:510-518`; `RunStreamRegistry.cancel` | aborts the stored controller (reaches legacy CLI child, not tree) | explicit cancel is the only termination command, through the P5D public seam | legacy compatibility path remains partial and must not activate before P5D | PARTIAL / LEGACY | P5D |
| CS-21 | Conversation transport ownership | `RunStreamRegistry.ts:80-84` | `cancel()` aborts controller; disconnect triggers abort in initial path | transport owns subscription; explicit cancel owns termination | conflation of transport close and cancel | CONFLICTING | P5D |
| CS-22 | Server shutdown | `index.ts:300-324` | closes HTTP, publishers, SQLite; does not enumerate/stop provider processes | shutdown interaction defined; active processes receive stable shutdown treatment and facts | no active-Process stop/recording | CONFLICTING | P6 owns the shutdown stop (enumeration/ordering/deadline/recording), invoking the P5 reusable stop pipeline — OD-M4-P5-17 as remediated; P5 ships the pipeline only |
| CS-23 | Legacy route ownership | `LegacyCanonicalExecutionService.ts:81-164` -> `AgentRunner` -> `CLIExecutor` | production task execution still runs through legacy spawn path | Legacy routes stay compatibility-only; no second authority | outside P5 core; transport/parity only | OUTSIDE_P5 | P4/P7 |
| CS-24 | Provider adapter cancel | `kimiCodeAdapter.ts:394-409` | `cancel()` requires accepted stop ticket, then `processPort.requestGraceful` | Adapter-native graceful only after durable stop ticket accepted | interface present; not wired to any coordinator | PARTIAL | P5A |
| CS-25 | Process tree platform impl | search: no `taskkill`, no Job Object, no process-group, no `detached` production use (`validation.ts:85-86` denies `detached`) | P1 explicitly deferred tree to P5 | MISSING | P5B |
| CS-26 | Approval-wait idle suspension | `timeouts.ts:85-99` `pauseIdle`/`resumeIdle`; M3 `waiting_approval` evidence in `m3-lifecycle-transition-contracts.ts:72` (stage running->waiting_approval) | idle pauses only during Process `waiting`; no production caller enters `waiting` on the durable path | approval-wait idle suspension only where M3 state proves it | `enterWaiting` exists but no durable-path caller | PARTIAL | P5C |
| CS-27 | Tree-cleanup proof provenance | `packages/process-runtime/src/driver.ts` / `types.ts` `TreeTerminationResult` + `SurvivorVerification` | current P4 driver surfaces a bare `classification='complete'` / `knownPids=[]` without owned-tree enumeration proof | every cleanup caller consumes one proof-aware normalizer; no proof is `UNKNOWN`/unproven | MISSING — P5A adds normalizer/enforcement; P5B emits proof only after enumeration | P5A/P5B |
| CS-28 | Canonical approval-event observation composition | `StageExecutionCoordinator.ts`; `run-engine/providerExecutionChain.ts`; `RunStreamService.ts`; `SqliteStore.runStreamService()` | `StageExecutionCoordinator` has no event-observation dependency; the existing production chain does not inject `RunStreamService` | P5C needs one narrow durable-verified Run-event observation port with cursor, replay, fencing and explicit failure callback | MISSING — P5C adds only the internal port and optional RunStream failure callback | P5C |
| CS-29 | Windows inspection evidence fidelity | `packages/process-runtime/src/node-driver.ts` identity inspection is currently liveness-only; no P5B evidence schema yet | the plan must identify the selected inspection facility/version, normalize CIM `CreationDate`, and define incomplete `ExecutablePath` behavior | one auditable facility per run; malformed/missing start time or null/access-denied/incomplete executable identity -> `UNKNOWN`/fail closed; no guessed identity | MISSING | P5B |
| CS-30 | Shared cleanup normalization | `driver.ts:cleanupResultFrom`; `manager.ts`; `durable-coordinator.ts` | `cleanupResultFrom` accepts classification only; Manager and DurableCoordinator branch directly on `complete` | one `cleanupVerdictFromVerification(verification, exitedBeforeCleanup)` consumes proof and returns `proven` | HIGH-A proof bypass exists in every current cleanup path | MISSING / BLOCKING | P5A |
| CS-31 | P5A public-command boundary | `TaskRunService.ts`; `canonicalRuns.ts`; `v2Runs.ts`; `index.ts`; `providerExecutionChain.ts` | routes are queued-only and create independent TaskRunServices; no default Stage coordinator injection | P5A internal only; P5D owns public activation with optional injection and fail-closed default | P5A cannot safely claim public active routing | PARTIAL / CONFLICTING | P5A internal; P5D public |
| CS-32 | Operation empty-ID bypass | `OperationService.ts:231-275`; `LifecycleTransactionService.ts:1307-1330` | active Operation cancellation marks Operation cancelled, then invokes LTS with `terminatedProcessIds: []` | active Operation cleanup runs outside SQLite and only proven IDs reach LTS | HIGH-C bypass remains until P5D | CONFLICTING | P5D |
| CS-33 | Exact no-proof durable consequence | ProcessRepository / ProviderSessionRepository existing state/fact writers | current code can terminalize bare complete; no single active-cancel consequence is implemented | no proof -> Process orphaned + UNKNOWN, Session failed, Run/Stage nonterminal, no LTS, P6 recovery folding | HIGH-D requires one frozen result and duplicate behavior | MISSING / BLOCKING | P5A |
| CS-34 | P5C Stage-attempt anchor | `RuntimeEventEnvelope`; approval events; `stage.started` payload | approval events have stageId/requestId but no stageAttempt | observer starts at cursor 0, arms only on matching `stage.started` payload.attempt, newer attempt invalidates | MEDIUM-A mechanism was previously unspecified | MISSING | P5C |
| CS-35 | P5C observation failure ownership | `RunStreamService.subscribe` | callback throw closes without an explicit internal failure reason | optional `onFailure(reason,lastSafeSequence)` maps every close to fail-closed observer cleanup | MEDIUM-B owner/cursor behavior was previously unspecified | MISSING | P5C |

## 4. P4 LOW residual — confirmed current behavior

The accepted P4 Second Independent Review LOW residual is reproduced exactly at
`StageExecutionCoordinator.ts:329-350`:

```text
spawn succeeds (consumeSpawnRightAndSpawn -> running, handle retained)
  -> bound.resolve(spawned.outcome.value)
  -> casSessionTransition starting -> active FAILS (kind !== 'applied')
  -> activeSession.reject('PROVIDER_SESSION_ACTIVE_FAILED')
  -> final.resolve(failed 'PROVIDER_SESSION_FAILED')
```

Consequences confirmed by code reading:

- the spawned native child is NOT explicitly terminated on this branch;
- the durable Process may remain `running` (its `casBindNativeIdentity` already
  committed `running`; no terminal transition is issued);
- `runToFinal` awaits `context.activeSession`, which rejects; the catch resolves
  `final` with a runtime failure — the drain/parser continuation still runs
  against the live child;
- the handle stays in `DurableProcessCoordinator.#handles` because no
  failure branch deletes it in this path;
- the caller fails closed with `PROVIDER_SESSION_FAILED` (no false completed,
  no duplicate spawn, no P4 contract violation).

The P5 planning boundary now freezes one required follow-up: P5A adds the
shared `cleanupVerdictFromVerification(verification, exitedBeforeCleanup)` in
`driver.ts`, and every cleanup caller consumes it. Only
`classification='complete'` with `proof.kind='owned-tree-enumeration'` has
semantic `OWNED_TREE_ENUMERATION_VERIFIED`; the unchanged P4 NodeProcessDriver's
bare `complete` normalizes to `unknown`/`UNKNOWN_PLATFORM_UNAVAILABLE` and
cannot successfully cancel a Run. No Manager, DurableCoordinator or new
ProcessCancelCoordinator branch may interpret complete independently. P5B
owns emitting that proof after platform-specific enumeration and post-force
verification. The P5C observation seam consumes the existing durable
`approval.required` and `approval.resolved` events through the frozen
`stage.started` attempt anchor and narrow Run-event port at
`providerExecutionChain.ts`.

## 5. Cancellation authority chain — current wiring gaps

Target (P0 §13, M4 plan §12) versus current at `750a780c`:

The third-remediation target deliberately stops at the internal
`StageExecutionCoordinator.cancelAttempt` authority in P5A. Public
TaskRunService/canonical/v2/Operation/Conversation command activation is P5D
and is not implied by the internal P5A rows below.

| Chain step | Current state |
|---|---|
| explicit Run Cancel command | `queued`-only; `waiting_approval` rejected |
| M3 command/idempotency validation | present (`TaskRunService`/`OperationService`) |
| durable cancellation request/fact | `process.stopping` fact machinery exists; no durable cancel command on active runs |
| Stage execution coordinator correlation | coordinator exposes no cancel entry point |
| ProviderAdapter.cancel | interface present; never invoked |
| ProcessManager.stop(processId) | in-memory pipeline present; durable coordinator lacks stop surface |
| PlatformDriver graceful tree stop | single-root signal only |
| grace deadline | `graceMs` wired (snapshot `cancelGracePeriodMs`) |
| force tree termination | single-root kill; `complete` guessed |
| survivor verification/report | root-exit -> `complete`; no enumeration |
| Process exited/cleanup facts | durable columns exist; stop path does not produce them |
| Provider finalize | only the natural-exit path finalizes (`runToFinal`) |
| LifecycleTransactionService terminal | present; not fed by a stop result |

## 6. Timeout current wiring

- Package level (`ProcessTimers`): startup/idle/total implemented with injected
  clock, idle pause/resume, first-fired-owner rule. This satisfies the
  deterministic-clock requirement.
- Durable execution: `StageExecutionCoordinator` passes only
  `{ graceMs: cancelGracePeriodMs }` into the reservation timeout policy
  (`StageExecutionCoordinator.ts:224`). `startupTimeoutMs`, `idleTimeoutMs` and
  `totalTimeoutMs` from the frozen Provider Configuration snapshot
  (`providerConfigs`/`ProviderConfigurationSnapshotV1.timeoutPolicy`) are not
  propagated, so the durable Kimi path has no startup/idle/total enforcement.
- Approval wait: Process `waiting` + `pauseIdle` exist; the durable path never
  calls `enterWaiting`, and the canonical Run/Stage `waiting_approval` state is
  proven by M3 transition contracts (`m3-lifecycle-transition-contracts.ts:72`).
- Exact approval observations: `approval.required` is the durable event for
  `running -> waiting_approval`; `approval.resolved` resolves the same
  `approvalRequestId`. Its decision is `approve_once`/`approve_run`/
  `approve_workspace` for resume, `reject` for failure, or `cancel_run` for
  the approval-cancellation composite; only the normal approval decisions may
  resume an active Process.

## 7. Transport current wiring

| Path | Close handler | Effect | E08 verdict |
|---|---|---|---|
| Canonical Run SSE (`canonicalRunEvents.ts`) | unsubscribe only | Process/Event/Run continue | PASS |
| Legacy task SSE (`tasks.ts`) | unsubscribe only | execution continues | PASS |
| Conversation initial (`conversations.ts:410-456`) | `abortController.abort()` | kills legacy CLI child | FAIL |
| Conversation resume (`conversations.ts:540-567`) | unsubscribe only | continues | PASS |
| Conversation explicit cancel (`conversations.ts:510-518`) | registry abort | legacy child killed, no tree | PARTIAL |

## 8. Gap summary

Rows with a primary plus a secondary status are CS-01 (`PARTIAL /
CONFLICTING`, queued-only public cancel), CS-15 (`PARTIAL` in the legacy layer
and `OUTSIDE_P5` for canonical P5), and CS-23 (`OUTSIDE_P5` with a `PARTIAL`
compatibility classification). CS-31 is intentionally public-command
`PARTIAL / CONFLICTING` until P5D.

```text
IMPLEMENTED : CS-11 (durable state machine), CS-13 (timer machinery),
              CS-16/17/19 (canonical + legacy disconnect)                     = 5
PARTIAL     : CS-01, CS-05, CS-06, CS-07, CS-10, CS-12, CS-15, CS-20,
              CS-23, CS-24, CS-26, CS-31, CS-35                                = 13
MISSING     : CS-03, CS-04, CS-25, CS-27, CS-28, CS-29, CS-30, CS-33,
              CS-34                                                                 = 9
CONFLICTING : CS-01, CS-02, CS-08, CS-09, CS-14, CS-18, CS-21, CS-22,
              CS-32                                                                = 9
OUTSIDE_P5  : CS-15, CS-23 (compatibility-only; regression-guarded)           = 2
```

No P5 acceptance criterion may be claimed from the current tree: E04 (tree
cancel) and E08 (disconnect independence) both fail today on the Conversation
initial path and the Node driver tree surface. POSIX real-OS evidence is a
required P5B acceptance gate: if no valid POSIX environment exists, the result
is recorded as `PLATFORM_GATE_BLOCKED`, P5B is incomplete, and overall P5 is
incomplete; it is not a pass or silent skip.

The Windows fallback remains an evidence contract, not a tool preference:
P5B records the selected inspection facility plus host/tool version and
capability for the run, parses and normalizes CIM `CreationDate` deterministically,
and maps null/access-denied/incomplete `ExecutablePath` or identity to
`UNKNOWN`/fail closed. No facility may be silently swapped and no executable
identity may be guessed.

## 9. Third-remediation closure contract

The following are frozen as planning requirements; they do not describe
implemented production behavior at the accepted P4 base.

### 9.1 One proof authority

`packages/process-runtime/src/driver.ts` owns the single
`cleanupVerdictFromVerification(verification, exitedBeforeCleanup)` seam.
Manager cleanup, DurableProcessCoordinator registration/late-success cleanup,
ProcessCancelCoordinator, timeout callers and P4 compensation all consume its
complete normalized verdict. No caller may branch directly on
`verification.classification === 'complete'` or
`terminateTree(...).classification === 'complete'`.

### 9.2 Exact no-proof outcome

For an explicit active cancellation whose verification is bare/invalid
`complete`:

```text
Process: stopping -> orphaned
cleanupResult: UNKNOWN_PLATFORM_UNAVAILABLE
terminationReason: cancel causation retained
facts: one process.orphaned(cleanupRequired=true); no process.exited success
Session: failed with sanitized PROCESS_TREE_TERMINATION_FAILED (or frozen equivalent)
Run/Stage: remain in their pre-cancel nonterminal state
LTS: not called for successful cancellation
terminatedProcessIds: no unproven Process ID
recovery_required: P5 does not invent a transition; P6 folds durable evidence
duplicate cancel: joins the same ticket and returns the same uncertain result
```

Queued-before-spawn is the only legal zero-Process exception. A failed
activation CAS uses the same Process path and reports Session failure without
claiming successful tree cleanup.

### 9.3 P5A/P5D boundary and claim correlation

P5A is internal only. `StageExecutionCoordinator.cancelAttempt` receives the
exact workspace/run/stage/stageAttempt and resolves Session/Process through
additive ports backed by existing `findByClaimKey` and `findByRootClaim`.
P5A never activates canonical/v2/Operation/Conversation public commands.
P5D owns route/application injection, Operation two-phase cancellation and the
LTS hand-off. An uninjected active public command fails closed without mutation.

### 9.4 P5C attempt/cursor/failure contract

P5C starts `RunStreamService` observation at `afterSequence=0`, remains
DISARMED until matching `stage.started.payload.attempt`, and invalidates on a
newer attempt. Approval events are then fenced by workspace/run/stage,
sequence and approvalRequestId. An additive RunStream failure callback maps
overflow, durability mismatch, callback failure and close to observer cleanup
with no guessed timer/state transition. No polling or HTTP/SSE object enters
the seam.

### 9.5 Current authorization consequence

This is a docs-only remediation. P5A, P5B and P6 remain unauthorized until a
fresh independent plan review returns BLOCKER/HIGH zero.
