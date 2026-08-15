# AgentOS M4-P5 Cancellation, Process Tree, Timeout and Transport — Current-State Audit

Status: M4-P5 PRE-IMPLEMENTATION PLANNING — DOCS ONLY — M4-P5 PRODUCTION IMPLEMENTATION NOT AUTHORIZED

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
   `apps/server/src/services/LifecycleTransactionService.ts`,
   `apps/server/src/services/TaskRunService.ts`,
   `apps/server/src/routes/{canonicalRuns,v2Runs,operations,conversations,canonicalRunEvents}.ts`,
   `apps/server/src/index.ts`, `packages/agent-core/src/executor.ts`,
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
| CS-01 | Explicit Run cancel (canonical) | `routes/canonicalRuns.ts:116`; `routes/v2Runs.ts:40`; `TaskRunService.cancelQueuedRunForV2` | Only `queued` Run is cancellable; `RUN_NOT_CANCELLABLE` otherwise; `LifecycleTransactionService.cancelRunWithinTransaction` accepts `queued|starting|running|paused` and rejects `waiting_approval` | explicit cancel must propagate once through Session/Process tree to canonical terminal | no active-Process tree propagation; approval-waiting Run not cancellable via this seam | PARTIAL / CONFLICTING | P5A cancel coordinator + route seam |
| CS-02 | Operation cancel | `routes/operations.ts:152-202`; `OperationService.cancel` | M3 authorization revocation; no OS/Process side effect | Operation cancel is M3 semantics; P5 coordinates, never reinterprets | cancel authority does not correlate an active execution | IMPLEMENTED (M3), needs P5 coordination | P5A |
| CS-03 | Execution/Stage-attempt cancel | `StageExecutionCoordinator.execute` | no canonical attempt-cancel command exists | exactly-one authority; Run cancel revokes the Stage attempt | MISSING | P5A |
| CS-04 | Provider Session cancel | `repository-port.ts` `DurableSessionStatus` includes `cancelled`; `provider.sessions` migration 014 | status exists; no production transition path to `cancelled`; `provider.session_cancelled` is `SPEC_RECONCILIATION_REQUIRED` (P0 event-error contract) | successful cancellation finalizes Session as `cancelled` only after proven cleanup | MISSING | P5A (finalize) / P3-reconciliation gate |
| CS-05 | Process stop pipeline (in-memory) | `process-runtime/src/manager.ts` `ProcessManager.stop` + `#runCleanup` | idempotent stop ticket; `created->failed` cancelled-before-spawn; `starting->stopping` with null PID; grace -> terminateTree -> verifySurvivors -> exited/orphaned | P0 §7/§13 race rules | pipeline exists but tree driver is stubbed | PARTIAL | P5A/P5B |
| CS-06 | Durable Process stop | `durable-coordinator.ts` | retains native handles in `#handles`; no stop/cancel entry point; handles are deleted only on spawn-failure compensation and late-success cleanup; a normal `running` process keeps its handle for the whole run and is never cleaned by a stop request | durable stop ticket must accept and coordinate tree cleanup | MISSING — durable coordinator needs an explicit stop/cancel surface | PARTIAL | P5A |
| CS-07 | gracefulStop | `node-driver.ts:65-72` | `child.kill(SIGTERM)`; on Windows Node maps to `TerminateProcess` | bounded platform graceful capability; Provider-native interrupt first on Windows | single-root signal; no console-group Ctrl handling; no stdin-close option | PARTIAL | P5B |
| CS-08 | terminateTree | `node-driver.ts:74-86` | `child.kill(SIGKILL)`; returns `complete` when the kill call returned `true` | force tree termination; parent-PID kill alone MUST NOT be treated as successful tree cleanup | kills only the root PID; `complete` is guessed success | CONFLICTING | P5B |
| CS-09 | verifySurvivors | `node-driver.ts:88-97` | root exited -> `complete`; root alive -> `unknown` | survivor verification must classify root + known + newly discovered descendants | no tree enumeration; `complete` without evidence | CONFLICTING | P5B |
| CS-10 | inspectIdentity | `node-driver.ts:99-108` | `process.kill(pid, 0)` liveness only | PID reuse checked before every signal; identity beyond PID (start time/executable/token) | no start-time/executable comparison; PID-reuse not fenced | PARTIAL | P5B |
| CS-11 | Process state transitions (durable) | `ProcessRepository.ts:47-50`; migration 014 | full frozen state machine + CAS + `stopping_at`/`termination_reason`/`cleanup_result` columns | P0 §7 exactly | durable CAS present | IMPLEMENTED | reuse |
| CS-12 | LifecycleTransactionService | `LifecycleTransactionService.ts:1366-1440` | sole canonical Run/Stage terminal writer; `cancelRunWithinTransaction` with `terminatedProcessIds`; rejects `waiting_approval` | LifecycleTransactionService remains canonical terminal authority | no coordination with Process stop result; approval-waiting exclusion | PARTIAL | P5A/P5C |
| CS-13 | Timeout machinery | `process-runtime/src/timeouts.ts` `ProcessTimers` | startup/idle/total with injected clock; idle resets on activity, pauses on `waiting` | P0 §TD-09; spec §§29-33 | implemented at package level | IMPLEMENTED | P5C wiring |
| CS-14 | Timeout policy wiring (durable path) | `StageExecutionCoordinator.ts:224` | only `graceMs` is passed from snapshot (`cancelGracePeriodMs`); `startupMs/idleMs/totalMs` from snapshot policy are NOT consumed | startup/idle/total terminal reasons on the durable path | durable execution has no startup/idle/total enforcement | CONFLICTING | P5C |
| CS-15 | Legacy timeout | `agent-core/src/executor.ts:461-542` | idle + total timers; AbortSignal; kill single child | Legacy compatibility surface; not the canonical authority | legacy only; not P5 primary | PARTIAL | OUTSIDE_P5 (compat) |
| CS-16 | HTTP disconnect (canonical SSE) | `routes/canonicalRunEvents.ts:118-140` | close/error -> unsubscribe only | E08 | satisfies | IMPLEMENTED | P5D regression |
| CS-17 | HTTP disconnect (Legacy task SSE) | `routes/tasks.ts:296-369` | `res.close -> cleanup(false)` unsubscribe only; fire-and-forget | E08 | satisfies | IMPLEMENTED | P5D regression |
| CS-18 | SSE disconnect (Conversation initial) | `routes/conversations.ts:410-456` | `res.on('close')` calls `abortController.abort()`; signal reaches `CLIExecutor` and kills the provider child | browser owns subscription only; disconnect must not terminate Process/Run | CONFLICTING — disconnect can kill provider execution | CONFLICTING | P5D |
| CS-19 | SSE disconnect (Conversation resume) | `routes/conversations.ts:540-567` | close -> unsubscribe only | E08 | satisfies | IMPLEMENTED | P5D regression |
| CS-20 | Conversation explicit cancel | `routes/conversations.ts:510-518`; `RunStreamRegistry.cancel` | aborts the stored controller (reaches legacy CLI child, not tree) | explicit cancel is the only termination command, through canonical authority | legacy controller abort only; no tree | PARTIAL / LEGACY | P5D/P5A |
| CS-21 | Conversation transport ownership | `RunStreamRegistry.ts:80-84` | `cancel()` aborts controller; disconnect triggers abort in initial path | transport owns subscription; explicit cancel owns termination | conflation of transport close and cancel | CONFLICTING | P5D |
| CS-22 | Server shutdown | `index.ts:300-324` | closes HTTP, publishers, SQLite; does not enumerate/stop provider processes | shutdown interaction defined; active processes receive stable shutdown treatment and facts | no active-Process stop/recording | CONFLICTING | P5A (stop) / P6 (recovery) |
| CS-23 | Legacy route ownership | `LegacyCanonicalExecutionService.ts:81-164` -> `AgentRunner` -> `CLIExecutor` | production task execution still runs through legacy spawn path | Legacy routes stay compatibility-only; no second authority | outside P5 core; transport/parity only | OUTSIDE_P5 | P4/P7 |
| CS-24 | Provider adapter cancel | `kimiCodeAdapter.ts:394-409` | `cancel()` requires accepted stop ticket, then `processPort.requestGraceful` | Adapter-native graceful only after durable stop ticket accepted | interface present; not wired to any coordinator | PARTIAL | P5A |
| CS-25 | Process tree platform impl | search: no `taskkill`, no Job Object, no process-group, no `detached` production use (`validation.ts:85-86` denies `detached`) | P1 explicitly deferred tree to P5 | MISSING | P5B |
| CS-26 | Approval-wait idle suspension | `timeouts.ts:85-99` `pauseIdle`/`resumeIdle`; M3 `waiting_approval` evidence in `m3-lifecycle-transition-contracts.ts:72` (stage running->waiting_approval) | idle pauses only during Process `waiting`; no production caller enters `waiting` on the durable path | approval-wait idle suspension only where M3 state proves it | `enterWaiting` exists but no durable-path caller | PARTIAL | P5C |

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

## 5. Cancellation authority chain — current wiring gaps

Target (P0 §13, M4 plan §12) versus current at `750a780c`:

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

## 7. Transport current wiring

| Path | Close handler | Effect | E08 verdict |
|---|---|---|---|
| Canonical Run SSE (`canonicalRunEvents.ts`) | unsubscribe only | Process/Event/Run continue | PASS |
| Legacy task SSE (`tasks.ts`) | unsubscribe only | execution continues | PASS |
| Conversation initial (`conversations.ts:410-456`) | `abortController.abort()` | kills legacy CLI child | FAIL |
| Conversation resume (`conversations.ts:540-567`) | unsubscribe only | continues | PASS |
| Conversation explicit cancel (`conversations.ts:510-518`) | registry abort | legacy child killed, no tree | PARTIAL |

## 8. Gap summary

Three rows carry a primary plus a secondary status: CS-01 is
`PARTIAL / CONFLICTING` (queued-only cancel, and `waiting_approval` rejection);
CS-15 is `PARTIAL` in the legacy layer and `OUTSIDE_P5` for the canonical P5
authority; CS-23 is `OUTSIDE_P5` with a `PARTIAL` compatibility classification.

```text
IMPLEMENTED : CS-11 (durable state machine), CS-13 (timer machinery),
              CS-16/17/19 (canonical + legacy disconnect)                     = 5
PARTIAL     : CS-01, CS-02, CS-05, CS-06, CS-07, CS-10, CS-12, CS-15,
              CS-20, CS-23, CS-24, CS-26                                      = 12
MISSING     : CS-03, CS-04, CS-25                                             = 3
CONFLICTING : CS-01 (approval-wait), CS-08, CS-09, CS-14, CS-18,
              CS-21, CS-22                                                    = 7
OUTSIDE_P5  : CS-15, CS-23 (compatibility-only; regression-guarded)           = 2
```

No P5 acceptance criterion may be claimed from the current tree: E04 (tree
cancel) and E08 (disconnect independence) both fail today on the Conversation
initial path and the Node driver tree surface.
