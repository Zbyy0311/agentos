# AgentOS M4-P5 — Cancellation, Process Tree, Timeout and Transport Independence — Implementation Plan / Objective

Status: M4-P5 PRE-IMPLEMENTATION PLANNING — REMEDIATED PER INDEPENDENT PLAN REVIEW (DOCS ONLY) — M4-P5 PRODUCTION IMPLEMENTATION NOT AUTHORIZED — PENDING SECOND INDEPENDENT PLAN REVIEW

## 1. Metadata / exact base

| Field | Value |
|---|---|
| Repository | `Zbyy0311/agentos` |
| Planning tree | `E:\workspace\Multi-Agent-worktrees\agentos-m4-p3\agentos` |
| Planning branch | `docs/m4-p5-planning` |
| Accepted M4-P4 HEAD (base) | `750a780c7668aecbc52c661bee1bcadb7f6b188c` |
| M4-P4 parent | `385f020883eb0cd83c385cd42a5ad1d08e0eb691` |
| Accepted predecessor | M4-P4 = COMPLETE (Second Independent Review ACCEPTED) |
| Authoritative contracts | `M4-process-provider-runtime-implementation-plan.md` §7 (P5), `M4-p0-runtime-contract.md`, `M4-p0-event-error-contract.md`, `M4-p0-acceptance-matrix.md`, `M4-owner-decisions.md` |
| Migration 014 | IMPLEMENTED (P2A); P5 reuses its columns, no new migration |
| PR #45 | FROZEN / OUTSIDE M4 — not modified, merged or closed by this plan |
| Companion planning docs | `M4-p5-current-state-audit.md`, `M4-p5-owner-decisions.md`, `M4-p5-acceptance-matrix.md` |

Base-ownership: unambiguous (see audit §1). Any implementation authorization
must name this exact base; this plan does not silently transfer if `main` moves.

## 2. P5 objective

Make active Run cancellation reliable across the owned Process Tree and remove
HTTP/SSE ownership of execution, per M4 implementation plan §7. The frozen
architecture separates a SERVER/STAGE orchestration layer from a PROCESS-SIDE
Process Runtime stop pipeline (OD-M4-P5-01):

```text
USER CANCEL
  -> M3 command/Operation boundary
  -> server Stage cancellation orchestration (StageExecutionCoordinator)
       -> accept/correlate Session + Process
       -> ensure Process stop ticket (durable process.stopping)
       -> optional Adapter graceful request
            (RuntimeProviderAdapter.cancel through the constrained
             ProviderProcessPort, ticket-gated, within the grace window)
       -> Process Runtime cleanup (ProcessCancelCoordinator, PROCESS-SIDE ONLY)
            -> platform graceful
            -> grace deadline
            -> owned-tree force
            -> survivor verification
            -> durable Process facts
            -> Provider-neutral typed cleanup result returned upward
       -> Adapter finalize
       -> durable Session terminal (provider_sessions.status + registered facts)
       -> LifecycleTransactionService
  -> canonical Stage/Run cancellation

TIMEOUT
  -> ProcessTimers
  -> SAME Process stop authority (ProcessCancelCoordinator stop pipeline)
  -> same upward completion chain

TRANSPORT DISCONNECT
  -> unsubscribe only
  -> NEVER enters stop authority

P6 SHUTDOWN
  -> future caller of the reusable P5 stop pipeline (reason='shutdown')
  -> P6-owned server ordering/recovery classification (OD-M4-P5-17)
```

## 3. Frozen rules (authoritative; no renegotiation)

1. `res.close` / browser disconnect MUST NOT imply Process termination (E08).
2. Parent-PID kill alone MUST NOT be treated as successful tree cleanup.
3. Cancellation MUST NOT mark canonical Run terminal before required
   Process-tree termination / survivor evidence is known.
4. `LifecycleTransactionService` remains the canonical terminal lifecycle
   authority; Process/Provider components return facts and outcomes only.
5. M3 status vocabulary remains unchanged; no second Run state machine.
6. Adapter must not directly mutate canonical Run/Stage lifecycle.
7. Process Runtime remains Provider-agnostic; Adapter remains Process-tree-free.
8. Only `created` owns an unconsumed spawn right; `starting` has consumed it.
9. First accepted stop reason owns the `stopping` transition.
10. Survivors or unknown tree cleanup => cancellation is NOT successful.
11. Explicit cancel API remains a termination command; disconnect never is.
12. All waits use observable deadlines and the injected clock; no sleep-based
    correctness, no rerun-until-green acceptance.

## 4. Scope

### 4.1 Included

- Run / Operation / Execution / Process cancel coordination (one authority).
- Provider graceful stop via the accepted ticket (OD-M4-P5-02).
- Grace deadline (OD-M4-P5-03).
- Windows Job Object / process-group / bounded fallback force tree termination.
- Survivor verification (OD-M4-P5-06).
- Startup timeout, idle timeout, total timeout with frozen terminal reasons.
- Approval-wait idle suspension only where M3 `waiting_approval` proves it.
- Initial Conversation disconnect decoupling (E08 closure).
- Explicit cancel API remains the termination command.
- P4 LOW residual closure: startup compensation for spawned-but-unactivated
  Processes (OD-M4-P5-16, REQUIRED_P5_CLOSURE) — the coordination/state half
  in P5A (MockDriver), full production tree proof in P5B.
- Reusable, idempotent, typed Process-side stop pipeline with a supported
  `shutdown` stop reason for later P6 invocation (OD-M4-P5-17). Server
  shutdown enumeration, teardown ordering, deadline handling, shutdown-mode
  recording and recovery classification are P6-owned; P5 modifies no server
  shutdown wiring (`index.ts`) and no P5 acceptance depends on a
  server-shutdown integration test.

### 4.2 Excluded

- pause/resume product expansion.
- destructive orphan cleanup (generalized orphan destruction remains M7; P5
  only stops owned trees under an accepted stop reason).
- generalized M7 recovery, reattach, native resume, stream restoration.
- Legacy removal, Web default switch, production cutover.
- M5 Git/Worktree/Artifact process migration.
- New migrations or schema changes (Migration 014 columns are sufficient).
- Legacy `CLIExecutor` retirement (P7/P11 disposition; P5 only decouples its
  transport paths where the canonical authority is proven).

## 5. Cancel authority model

### 5.1 Chain (exactly one, two layers)

```text
Run Cancel Command (POST /api/runs/:runId/cancel, V2 idempotency)
  -> M3 command boundary: Operation/version/concurrency validation
  -> SERVER / STAGE ORCHESTRATION (apps/server, StageExecutionCoordinator.cancel):
       accept/correlate cancellation for the Stage attempt
       resolve active Provider Session + paired root Process (durable)
       ensure the durable Process stop ticket is accepted
         (process.stopping, grace deadline from snapshot cancelGracePeriodMs)
       -> optional Adapter-native graceful request
          (RuntimeProviderAdapter.cancel through the constrained
           ProviderProcessPort, ticket-gated, within the grace window)
       -> PROCESS RUNTIME CLEANUP (ProcessCancelCoordinator at
          packages/process-runtime/src/process-cancel-coordinator.ts,
          PROCESS-SIDE ONLY):
            PlatformDriver.gracefulStop (bounded)
            -> grace deadline (snapshot cancelGracePeriodMs)
            -> PlatformDriver.terminateTree (Windows fallback / POSIX group)
            -> PlatformDriver.verifySurvivors
            -> durable Process terminal/uncertainty fact
                 (exited + TERMINATED|ALREADY_EXITED, or orphaned +
                  SURVIVORS|IDENTITY_MISMATCH|UNKNOWN_PLATFORM_UNAVAILABLE)
            -> Provider-neutral typed cleanup result returned upward
       -> Adapter finalize (after Process cleanup evidence)
       -> durable Session terminal (provider_sessions.status
          'cancelled'|'failed' via existing registered facts;
          provider.session_cancelled stays gated — OD-M4-P5-10/18)
       -> LifecycleTransactionService.cancelRunWithinTransaction(terminatedProcessIds, ...)
            -> canonical Stage/Run cancelled (only after evidence known)
```

Mutations: the command boundary owns command acceptance; the SERVER/STAGE
orchestration owns correlation, the ticket-gated Adapter graceful request,
Provider finalize and the `LifecycleTransactionService` invocation; Process
Runtime owns the stop ticket, Process state transitions, tree mechanics and
Process facts, and returns facts/outcomes only; Adapter owns Provider facts;
`LifecycleTransactionService` owns canonical Run/Stage. No layer crosses.

RunEngine scheduling stop is EMERGENT, not a new gate: while the cancelled
Stage attempt's Session/Process claim remains active (non-terminal), any
re-dispatch joins the same durable claim (`joinedExisting`) and never spawns
a second Process; once `LifecycleTransactionService` terminalizes the Run as
cancelled, `RunEngine.dispatch` returns `run-terminal`. P5A proves both
guards with regression tests. `RunEngine.ts` is in no P5 allowlist and must
not be modified.

### 5.2 Freeze per cancel window

| Window | Frozen behavior |
|---|---|
| cancel before spawn (created) | stop ticket accepted; `created -> failed` with `cancelled-before-spawn`; spawn right revoked; Driver spawn count stays 0 (RACE-S1). |
| cancel concurrently with spawn | `created -> starting` consumed the right; cancel CASes `starting -> stopping` even with null PID; the single in-flight spawn result is awaited (RACE-S2). |
| cancel immediately after spawn | late success binds native identity to the same Process, stays `stopping`, and immediately runs the cleanup pipeline (RACE-S3). |
| cancel while Session is starting | Session remains non-terminal until Process cleanup evidence; then Session `failed` (activation/start) or `cancelled` (verified clean with cancel causation). |
| cancel while Session is active | normal stopping -> exited/TERMINATED (verified) -> Session `cancelled` (durable status + registered facts; `provider.session_cancelled` stays gated) -> LifecycleTransactionService cancelled. |
| cancel during M3 `waiting_approval` | routed through the EXISTING approval-cancellation composite: `approval.resolved -> stage.cancelled -> run.cancelled` via `resolveApprovalToCancellation` (frozen ordering); the paired Process enters the same single stop pipeline with cancel causation; the generic cancel seam keeps rejecting approval states (OD-M4-P5-19). |
| cancel while output streams drain | output finalization joins the stop pipeline; artifact references finalize before the terminal fact; bounded backpressure never blocks stop. |
| cancel while Process exits naturally | first terminal observation wins; natural exit with no survivors finalizes `exited` with the cancel reason correlated (OD-M4-P5-07). |
| cancel after Process exited but before Provider finalize | the terminal Process fact is already committed; the coordinator finalizes Provider with the cancel evidence; `session_cancelled` requires the cleanup result. |
| cancel during Provider finalize | finalize observes the accepted stop ticket and produces the cancelled/failed finalization; exactly one terminal Session fact. |
| duplicate cancel (same key) | joins the first ticket; same result returned; no new ticket. |
| simultaneous duplicate cancel | CAS winner owns the ticket; losers join; one cleanup, one terminal fact. |
| cancel after terminal completion | returns the existing terminal result; no mutation, no duplicate Event. |
| cancellation failure (graceful fails) | force still runs; result driven by tree verification. |
| survivor detected | `orphaned` + `SURVIVORS`; cancellation not successful; Run uncertainty preserved via M3 seam. |
| unknown tree ownership | `orphaned` + `UNKNOWN_PLATFORM_UNAVAILABLE`; fail closed; no signal on unverified identity. |
| graceful-stop failure | bounded progression to force; no guessing. |
| force-kill failure | `UNKNOWN_PLATFORM_UNAVAILABLE`/`PROCESS_TREE_TERMINATION_FAILED` evidence; uncertainty preserved. |

### 5.3 P4 LOW residual closure (OD-M4-P5-16)

Spawn succeeded but `starting -> active` Session CAS failed: the coordinator
issues the stop pipeline with a startup/activation stop reason against the
already-retained handle; the Process terminalizes `exited` (verified clean with
`TERMINATED` cleanup result) or `orphaned` (survivors/unknown); the Session
terminalizes `failed` with `PROVIDER_SESSION_FAILED`; the caller outcome stays
fail-closed. Duplicate cleanup is prevented by the single idempotent stop
ticket; uncertain cleanup stays non-terminal for P6. **Phase split:** the
coordination/state half of this closure lands in P5A and is proven on the
controllable MockDriver (single stop, terminal facts, no second spawn); the
full production tree-cleanup proof (real owned-tree termination and survivor
verification against this schedule) completes in P5B.

## 6. Process tree contract

### 6.1 Windows

| Aspect | Frozen design |
|---|---|
| Job Object | OPTIONAL FUTURE CAPABILITY SLOT (OD-M4-P5-04/05), not a mandatory P5 requirement. Real Job integration (`CREATE_SUSPENDED` -> assign -> resume -> `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` -> job-membership survivor proof) requires a future separate technical/dependency authorization (native addon, FFI or helper mechanism); none is introduced or authorized by P5. The capability is not deleted: the driver records its availability, and a future authorized implementation slots into `Driver.spawn` before the child runs application code, with observable assignment failure and nested-job detection. |
| Authorized P5 implementation | Observable bounded fallback on every managed root: retained root native identity; bounded descendant enumeration via a CIM-equivalent inspection mechanism selected during P5B from already authorized OS facilities (separated arguments; no shell string concatenation); identity fencing (start time / executable) of root and descendants before any destructive signal; safely parameterized `taskkill /PID <owned-root-pid> /T /F` constrained to the owned root subtree; re-enumeration and survivor verification after force; `complete`/`survivors`/`unknown`; success NEVER inferred from `taskkill` exit status alone. |
| Observability | `treeMode='fallback'` recorded per managed root; warning + reduced-reliability internal diagnostic; never silent; diagnostics leak no secrets. |
| Acceptance gate | The REQUIRED Windows gate is the fallback owned-tree proof (WIN-06). WIN-05 (Job path) is OPTIONAL_CAPABILITY/ENV-GATED evidence only: PASS only if a separately authorized Job implementation exists, otherwise explicit UNSUPPORTED/BLOCKED capability evidence; not required for base P5 acceptance as long as the fallback proves E04 completely. |
| `.exe` / `.cmd` | `.exe` direct; `.cmd`/`.bat` only through explicit validated wrapper policy (`cmd /d /c` with separated args, never user-string concatenation) — P0 §16.2. |
| `shell=false` | enforced at launch validation; never bypassed for tree reasons. |
| Unicode / spaces | path/args preserved as array entries; no string re-quoting; covered by platform tests. |
| Child/grandchild ownership | the owned set is the fenced root subtree; the fallback enumerates root + descendants before and after force; `taskkill /T` output alone is not completion proof — re-enumeration is. |
| Survivor enumeration | after force, re-enumerate root, known and newly discovered descendants; classify complete/survivors/unknown. |
| Access-denied / already-exited races | identity re-check before each signal; already-exited -> `ALREADY_EXITED`; access-denied -> `unknown`. |
| PID reuse / identity fencing | `inspectIdentity` compares start time/executable/group/token in addition to PID; mismatch -> `IDENTITY_MISMATCH`; no signal on mismatch. |

### 6.2 POSIX

| Aspect | Frozen design |
|---|---|
| Group/session creation mechanism | `NodeProcessDriver` internally passes `detached: true` to `node:child_process.spawn` on POSIX ONLY, solely as the Node mechanism for creating a new owned process group/session (spec §45 recommends `detached = true` or equivalent `setsid()`). Invariants (OD-M4-P5-05): caller-facing `LaunchRequest.detached` stays denied by launch validation; stdio remains piped/owned; the `ChildProcess` handle remains retained; `child.unref()` is NEVER called; execution remains AgentOS-owned; the fresh PGID is recorded in `NativeIdentity.groupId`. This authorizes no user-requestable detached/daemon behavior (P0 §16.12) and satisfies the P0 §9 owned-group requirement — the flag selects the OS group-creation mechanism only, while every ownership invariant stays enforced. |
| TERM | signal the group (`process.kill(-pgid, SIGTERM)`), not only the root. |
| Grace | snapshot `cancelGracePeriodMs` via injected clock. |
| KILL | signal the group (`SIGKILL`). |
| Group identity | PGID captured at spawn; group identity/start evidence revalidated before every `-pgid` signal — Linux via `/proc` evidence, macOS/BSD via a bounded ps-equivalent evidence adapter; reused-PGID or insufficient identity blocks signaling (fail closed). |
| Natural-exit races | exit observed before signal -> `ALREADY_EXITED`; during grace -> finalize with verification. |
| Survivor verification | group membership + known descendants; zombie reap; classify complete/survivors/unknown. |

A successful cancellation means the owned-tree cleanup result satisfies the
frozen contract (`TERMINATED`/`ALREADY_EXITED` with verified `complete`), not
merely that the parent PID disappeared.

## 7. Timeout model (frozen)

| Aspect | STARTUP TIMEOUT | IDLE TIMEOUT | TOTAL TIMEOUT |
|---|---|---|---|
| Start clock | native start observed (`armFromNativeStart`) | last activity checkpoint (native start initially) | native start observed |
| Stop clock | readiness mark (`markReady` / Session active) | next activity or approved-wait pause | native exit / terminal |
| Activity reset | n/a | `notifyActivity` restarts the full budget | none |
| Pause rules | n/a | pauses only during Process `waiting` entered from M3 `waiting_approval` (OD-M4-P5-14) | none (waiting does not reset) |
| Durable evidence | `PROCESS_STARTUP_TIMEOUT` stop reason + `process.stopping` + terminal fact | `PROCESS_IDLE_TIMEOUT` stop reason + facts | `PROCESS_TOTAL_TIMEOUT` stop reason + facts |
| Process termination reason | timeout (outcome `timeout`) | timeout | timeout |
| Provider error mapping | `PROVIDER_START_FAILED` (startup phase) | `PROVIDER_SESSION_FAILED` (runtime) | `PROVIDER_SESSION_FAILED` (runtime) |
| Run/Stage outcome | Stage failed (lifecycle owner) | Stage failed | Stage failed |
| vs user cancel | first accepted stop reason wins | first accepted stop reason wins | first accepted stop reason wins |
| vs natural exit | first terminal observation wins (CAS) | first wins | first wins |
| Simultaneous timeout/exit/cancel | single-terminal-CAS; one `process.stopping` reason; other causes correlated diagnostics | same | same |
| During approval wait | continues (startup is pre-ready; approval is post-ready) | pauses | continues |

Policy source: Provider Configuration snapshot `timeoutPolicy`
(`startupTimeoutMs`, `idleTimeoutMs`, `totalTimeoutMs`, `cancelGracePeriodMs`),
frozen into the snapshot by `SnapshotService`
(`apps/server/src/services/SnapshotService.ts`, `timeoutPolicy:
structuredClone(provider.timeoutPolicy)`), which the coordinator must now
fully propagate into the durable Process reservation (currently only `graceMs`
is wired — audit CS-14). Timer tests use the injected `Clock`; no wall-clock
only flaky tests. Every timeout routes through the SAME Process-side stop
authority as user cancel (`ProcessTimers.onFire -> ProcessCancelCoordinator
stop pipeline -> same upward completion chain`); first accepted stop reason
owns the transition.

Approval-wait seam (OD-M4-P5-14): P5C owns creating exactly one
observation/coordination hook from the existing canonical M3 approval
transition into the existing Process state/timer machinery —
`waiting_approval` entered -> coordinator receives the canonical
transition/fact -> paired Process `running -> waiting` -> `pauseIdle()`;
approval resolved -> paired Process `waiting -> running` (if execution
remains active) -> `resumeIdle()` with remaining budget; cancel during
`waiting_approval` -> the M3 approval-cancellation composite (OD-M4-P5-19) ->
the same single stop pipeline. No second approval state, no second Run/Stage
state machine, no polling-based inferred approval state. Total timeout
remains active during waiting; the startup deadline is already finished after
readiness; only idle pauses.

## 8. Transport independence (E08) design

Freeze these two command classes:

1. **Disconnect** (HTTP or SSE): release subscriber resources and cursors;
   never calls Adapter cancel, Process stop, Stage cancel or Run cancel.
2. **Explicit cancel** (`POST /api/runs/:runId/cancel`): the only user
   transport-to-execution termination command; enters §5.1.

P5D closes the one FAIL path (audit CS-18): the Conversation initial-message
`res.close` handler stops aborting; the `AbortController` remains only for the
explicit cancel route. Regression guards prove the canonical and Legacy task
SSE paths already satisfy E08. Reconnect resumes persisted Events /
output-reference cursors.

## 9. Implementation decomposition

Derived from dependency evidence, not blind slice names. P5A is the ownership
and race model (everything downstream depends on the stop pipeline and ticket
semantics); P5B is the platform tree proof; P5C the timeout integration; P5D
the transport decoupling; P5E the integrated real-Kimi/tree gate; P5F the
independent review/closeout.

### P5A — Cancel authority + state/race model

| Field | Value |
|---|---|
| Goal | Freeze and prove the two-layer cancel pipeline end-to-end on the in-memory + durable seams with a controllable driver: SERVER/STAGE orchestration (`StageExecutionCoordinator.cancel`) + PROCESS-SIDE `ProcessCancelCoordinator` stop pipeline, Run cancel route propagation, approval-wait composite routing, duplicate convergence, P4 LOW residual startup compensation (coordination half). |
| Exact dependency | P4 accepted; P0/P2B durable Process/Session repositories; `ProcessManager` stop pipeline. |
| Allowed files/packages | `packages/process-runtime/src` (manager, durable-coordinator, NEW `process-cancel-coordinator.ts` — PROCESS-SIDE ONLY per OD-M4-P5-01, driver ports, errors, testing/mock-driver, index exports), `apps/server/src/services/run-engine/StageExecutionCoordinator.ts` (the server-side cancel orchestration entry), `apps/server/src/services/TaskRunService.ts` cancel seam, `apps/server/src/routes/canonicalRuns.ts` + `v2Runs.ts` cancel routing, `LifecycleTransactionService.cancelRunWithinTransaction` / `resolveApprovalToCancellation` CALL SITES ONLY (evidence hand-off; the `LifecycleTransactionService.ts` file itself is not modified), package/server tests/fixtures. |
| Forbidden files | platform tree implementations (P5B), timeout wiring beyond grace (P5C), Conversation route changes (P5D), `node-driver.ts` tree internals, migration/schema files, agent-core adapters beyond the already-accepted `cancel()` interface, Legacy route behavior, `RunEngine.ts` (scheduling stop is emergent and regression-proven, not re-implemented), server shutdown wiring (`index.ts`; P6-owned per OD-M4-P5-17). |
| Production changes | server cancel orchestration entry + process-side `ProcessCancelCoordinator` + run-cancel propagation + approval-wait composite routing + activation-failure compensation + durable stop surface on `DurableProcessCoordinator`. |
| Test changes | RACE-S1..S5 reuse + active-CAS-failure schedule; duplicate/concurrent/after-terminal cancel; cancel-vs-exit; cancel-vs-finalize; approval-wait composite ordering (`approval.resolved` first, OD-M4-P5-19); Session/Process fact ordering; no-second-spawn; Event/Outbox 1:1; emergent scheduling guards (re-dispatch joins the claim; terminal Run refused); package-level `reason='shutdown'` stop support; architecture-negative: process-runtime imports no agent-core/provider module. |
| Platform scope | none (MockDriver only). |
| Stop conditions | cancellation can mark Run terminal before tree evidence; a second spawn appears; duplicate terminal fact; survivors treated as success; process-runtime grows a provider import or a LifecycleTransactionService call. |
| Acceptance criteria | E04 state-model half on mock driver; every §5.2 window has a deterministic test; P4 LOW coordination half has a regression; no production transport change; no `RunEngine.ts`/`index.ts` change. |
| Rollback boundary | revert cancel routing/coordinator additions; Process facts preserved. |
| Fresh regression suites | P4 dispatcher/coordinator suites, M3 lifecycle/cancel suites, architecture-negative imports. |
| Independent review gate | lifecycle-race + state-machine review (BLOCKER/HIGH 0). |
| Real Kimi gate | not required (mock-driver determinism is the gate). |

### P5B — Platform process-tree termination

| Field | Value |
|---|---|
| Goal | Implement and prove owned-tree termination + survivor verification on Windows via the authorized observable fallback and on POSIX via the owned process group, plus PID-reuse identity fencing. Job Object remains an OPTIONAL FUTURE CAPABILITY SLOT (OD-M4-P5-04/05); no new native/FFI/helper dependency is introduced. |
| Exact dependency | P5A stop pipeline/ticket semantics. |
| Allowed files/packages | `packages/process-runtime/src/node-driver.ts`, `driver.ts` contract additions (`treeMode`, group/job identity fields), `types.ts` `NativeIdentity` additions, real-OS child fixtures under package tests, platform contract tests. |
| Forbidden files | cancel coordinator behavior, timeout wiring, transport routes, migration/schema, agent-core adapters, package.json/lockfile or any new dependency. |
| Production changes | `NodeProcessDriver.spawn` (POSIX group creation via driver-internal `detached: true` with the OD-M4-P5-05 invariants; Windows retained identity + observable `treeMode='fallback'` + capability recording), `gracefulStop/terminateTree/verifySurvivors/inspectIdentity` tree implementations (Windows: CIM-equivalent descendant enumeration + fenced `taskkill /T /F`; POSIX: `/proc` or bounded ps-equivalent evidence + group signaling). |
| Test changes | Windows fallback (REQUIRED gate): `.exe`, `.cmd` (validated wrapper), path spaces/Unicode, child/grandchild, survivor, access-denied, already-exited, PID-reuse mismatch, taskkill-exit-not-proof, observable `treeMode`; POSIX: group TERM/grace/KILL, group escape, survivor verification, zombie reap, PGID-reuse fencing, group-creation invariants (stdio piped, handle retained, no unref); Job capability recording (WIN-05, OPTIONAL_CAPABILITY/ENV-GATED). |
| Platform scope | Windows + POSIX real OS child fixtures (env-gated) + Mock parity. |
| Stop conditions | driver cannot prove tree ownership; `complete` without enumeration; survivor list empty on known failure; signal on mismatched identity. |
| Acceptance criteria | E04 passes on real Windows via the fallback owned-tree proof; POSIX group proof passes where an actual POSIX host/capability exists — otherwise `PLATFORM_GATE_BLOCKED` with evidence (no silent skip, no full cross-platform acceptance claim); `terminateTree` returns method/members/errors; `verifySurvivors` classifies correctly; fallback parity proven. |
| Rollback boundary | revert driver tree internals; P5A cancel semantics unchanged. |
| Fresh regression suites | full P5A + prior platform contract tests. |
| Independent review gate | Windows/POSIX platform + security review. |
| Real Kimi gate | not required for the platform slice itself. |

### P5C — Timeout integration

| Field | Value |
|---|---|
| Goal | Wire frozen startup/idle/total policies from the Provider Configuration snapshot into the durable path; approval-wait idle suspension; timeout terminal reasons and races. |
| Exact dependency | P5A stop pipeline; P0 timer machinery already in `ProcessTimers`. |
| Allowed files/packages | `packages/process-runtime/src` (timeouts consumption), `StageExecutionCoordinator.ts` timeout-policy propagation, `ProcessRepository`/`process-runtime-adapters.ts` policy persistence, `apps/server/src/services/SnapshotService.ts` snapshot `timeoutPolicy` mapping (exact existing symbol: `timeoutPolicy: structuredClone(provider.timeoutPolicy)`), tests. |
| Forbidden files | platform driver tree internals, transport routes, migration/schema. |
| Production changes | propagate `startupMs/idleMs/totalMs`; `markReady` on Session active; the approval-wait observation/coordination seam (OD-M4-P5-14: canonical `waiting_approval` transition -> paired Process `enterWaiting`/`pauseIdle`; approval resolved -> `exitWaiting`/`resumeIdle`; cancel -> M3 approval-cancellation composite -> same stop pipeline); durable timeout reasons. |
| Test changes | fake-clock startup/idle/total; activity resets idle; approval wait pauses idle with remaining budget; total unaffected by waiting; startup already disarmed post-readiness; timeout-vs-exit/cancel; terminal reasons; no flaky wall-clock tests; no second approval state machine, no polling. |
| Platform scope | none (injected clock). |
| Stop conditions | timeout marks success; idle suspension without M3 evidence; flaky timing tests. |
| Acceptance criteria | every timeout produces the frozen Process/Provider/Stage mapping; approval-wait suspension only under M3 `waiting_approval`. |
| Rollback boundary | revert timeout policy propagation; P5A/B unchanged. |
| Fresh regression suites | P1 timer/race suites + P4 suites. |
| Independent review gate | timer/race review. |
| Real Kimi gate | not required. |

### P5D — Transport independence

| Field | Value |
|---|---|
| Goal | Close the Conversation initial-disconnect FAIL path; prove disconnect never terminates and explicit cancel does. |
| Exact dependency | P5A cancel authority (explicit cancel already terminates through the chain). |
| Allowed files/packages | `apps/server/src/routes/conversations.ts` (initial-message close handler), `RunStreamRegistry.ts` (only if required for explicit-cancel routing), transport tests, disconnect E2E fixtures. |
| Forbidden files | canonical Run/Stage lifecycle, Process Runtime, adapters, other route behavior. |
| Production changes | remove abort-on-close in the initial Conversation path; keep AbortController for explicit cancel. |
| Test changes | HTTP disconnect continues; SSE disconnect continues; explicit cancel terminates tree; reconnect resumes cursor; spy asserts close never calls stop/cancel. |
| Platform scope | none. |
| Stop conditions | any transport close can still terminate canonical execution; disconnect and cancel remain conflated. |
| Acceptance criteria | E08 passes for all four transport paths; explicit-cancel-vs-disconnect demonstrably different commands. |
| Rollback boundary | revert the close-handler change; no Process facts lost. |
| Fresh regression suites | canonicalRunStream, tasks SSE, conversations suites. |
| Independent review gate | transport + E08 review. |
| Real Kimi gate | optional inside P5E only. |

### P5E — Integrated real-Kimi / tree gate

| Field | Value |
|---|---|
| Goal | Prove the complete chain with the installed Kimi executable on the current machine, including explicit cancel tree termination and disconnect non-termination, without weakening deterministic gates. |
| Exact dependency | P5A–P5D accepted. |
| Allowed files/packages | verification tests/fixtures and the P5 evidence package only; production remediation requires STOP + re-entry. |
| Forbidden files | production code hidden inside verification; weakening deterministic fixtures. |
| Production changes | none (evidence only). |
| Test changes | real Kimi: start -> provider process tree -> explicit cancel -> graceful/force -> survivor verify -> Process facts -> Session facts -> LifecycleTransactionService terminal; browser/SSE disconnect does not terminate that execution. |
| Platform scope | current machine (Windows, per environment). |
| Stop conditions | Kimi tree cannot be proven; disconnect terminates; cancel leaves survivors; flaky/rerun acceptance. |
| Acceptance criteria | E04/E08 + E06 on the real chain; recorded immutable head/versions/IDs. |
| Rollback boundary | evidence/tests only. |
| Fresh regression suites | full P5 matrix + M3 regression + workspace build. |
| Independent review gate | cross-domain integrated review. |
| Real Kimi gate | REQUIRED (this is the P5 real gate; deterministic gates remain mandatory CI). |

### P5F — Independent review / closeout

| Field | Value |
|---|---|
| Goal | Independent review of the P5 evidence package, remediation closure, and closeout record. |
| Exact dependency | P5E evidence. |
| Allowed files/packages | closeout/evidence docs. |
| Forbidden files | production/test changes outside separately authorized remediation. |
| Production changes | none unless a finding requires STOP + re-entry. |
| Test changes | regression only per findings. |
| Platform scope | full. |
| Stop conditions | BLOCKER/HIGH open; E04/E08 fail. |
| Acceptance criteria | BLOCKER/HIGH 0 on the immutable P5 head; P5 scope fully owned. |
| Rollback boundary | docs only. |
| Fresh regression suites | final P5 matrix on one head. |
| Independent review gate | this gate is the review. |
| Real Kimi gate | evidence from P5E. |

Slice boundaries are serial: P5A owns the shared cancel/state surface, P5B the
driver, P5C the timeout policy, P5D the transport, P5E the integrated evidence,
P5F the review. No two agents may concurrently mutate the coordinator, driver,
run-cancel route or `RunStreamRegistry` without a new coordination boundary.

## 10. Test / acceptance matrix

See `M4-p5-acceptance-matrix.md` for the complete deterministic matrix. At
minimum it covers cancellation windows, tree cases, Windows/POSIX platform
cases, timeout cases, transport cases, durability (Process/Session/cleanup
result/termination reason/survivor list/Event-Outbox parity/replay/idempotency/
no duplicate Process), and the M3 + P1–P4 regression sets, each classified
UNIT / INTEGRATION / REAL OS CHILD / WINDOWS-SPECIFIC / POSIX-SPECIFIC /
REAL KIMI / ENV-GATED. No rerun-until-green acceptance.

## 11. Real Kimi P5 gate design

Executable candidate (current machine): `C:\Users\Administrator\.kimi-code\bin\kimi.exe`.

Chain to prove (P5E):

```text
Run start -> Dispatcher -> Coordinator -> NodeProcessDriver -> kimi.exe
  -> Process with owned child/tree where testable
  -> explicit cancel OR deterministic timeout
  -> graceful/forced termination contract
  -> survivor verification
  -> Process facts -> Session facts -> LifecycleTransactionService
  -> canonical Run/Stage result
```

Plus: browser/SSE disconnect does NOT terminate that execution. The real gate
records exact immutable SHA, OS/architecture, resolved executable
path/fingerprint/version, adapter/config versions, safe auth state, task
definition, timestamps, Process/Session/Event/Artifact IDs, exit/tree/output
hashes and logs. Unavailable executable/auth/network => `REAL_GATE_BLOCKED`
with evidence; deterministic gates are never replaced by retries. Real-Kimi
success establishes only the P5 gate, never M4 completion.

## 12. Security / compatibility review

| Topic | P5 requirement |
|---|---|
| command injection / shell=false | tree mechanisms never rebuild command strings; `taskkill`/`cmd` wrappers use separated parameters, never user-string concatenation (P0 §16.2). |
| process-tree overkill | force targets only the owned Job/group; fallback constrained to the owned root PID subtree. |
| PID reuse | identity fencing before every signal (start time/executable/group/token); mismatch blocks signal (OD-M4-P5-05/06). |
| terminating unrelated processes | owned-Job/owned-group membership only; `taskkill /T` limited to the owned root; survivor enumeration restricted. |
| secret leakage in termination diagnostics | stable codes + redacted counts only; never raw stderr/env/args (P0 §16, event-error contract §12). |
| raw stderr/stdout during cancellation | stays in restricted artifacts; bounded; finalization before terminal fact; no raw bytes in Events. |
| Windows handle lifetime | native Job/handle references (only if a future Job capability is authorized) stay memory-only and are never persisted (spec §40.2); the authorized fallback retains only root/descendant identity evidence; closed after cleanup. |
| Job Object inheritance | future-capability context only (OD-M4-P5-04/05): under a separately authorized Job implementation, root assignment controls inherited-handle rules and children join the Job automatically, with escape attempts covered by platform tests; in the authorized P5 fallback the owned set is the fenced root subtree proven by enumeration. |
| event redaction | P5 facts carry no original values (audit CS + event-error contract §1). |
| survivor PID disclosure | survivor PIDs restricted (`survivor_pids_redacted_json`), counts only in public projections. |
| Legacy compatibility | Conversation cancel route remains a legacy projection until its owning phase; canonical authority used for canonical runs; no default switch. |
| existing Conversation routes | only the initial-message close handler changes (P5D); resume/cancel routes regression-guarded. |
| shutdown semantics | P5 exposes a reusable idempotent stop pipeline with a supported `shutdown` reason (package-level proof only); server shutdown enumeration/teardown ordering/deadline, shutdown-mode recording and recovery classification are P6-owned (OD-M4-P5-17); no P5 acceptance depends on shutdown integration. |

## 13. Stop / no-go conditions for P5 implementation

Stop and require re-entry if any occurs:

- base or frozen contract drifts without authorization;
- cancellation can mark Run terminal before tree/survivor evidence is known;
- a second spawn, second Run state machine, or second terminal Event appears;
- `complete` tree result is produced without survivor enumeration;
- browser/SSE close can still terminate canonical execution;
- idle suspension is wired without M3 `waiting_approval` evidence;
- timeout or cancel marks Provider success;
- `LifecycleTransactionService` is bypassed for a canonical terminal;
- Adapter spawns/kills/mutates lifecycle;
- raw secret/stderr/env leaks into Events/logs/ApiProblem;
- M3 lifecycle/Event/Outbox/idempotency/replay/Legacy regression appears;
- a test passes only by rerun, sleep inflation or weakened assertion;
- BLOCKER/HIGH independent finding remains open;
- P5 expands into pause/resume, orphan destruction, M7 recovery, M5 process
  migration, Legacy retirement, cutover, P6 recovery classification, or
  P6-owned server shutdown wiring (`index.ts` shutdown enumeration/ordering).

## 14. Rollback boundaries

- P5A: revert cancel routing/coordinator; Process facts preserved.
- P5B: revert driver tree internals; P5A semantics unchanged.
- P5C: revert timeout propagation; P5A/B unchanged.
- P5D: revert the Conversation close-handler change; no durable loss.
- P5E: evidence/tests only.
- P5F: closeout docs only.

Production Restore, data deletion, force cleanup and Legacy retirement are not
rollback mechanisms authorized here.

## 15. Authorization status

```text
M4-P5 PRE-IMPLEMENTATION PLANNING:
REMEDIATED (docs only) / PENDING SECOND INDEPENDENT PLAN REVIEW

Independent Plan Review (first):
NOT ACCEPTED — 3 HIGH / 4 MEDIUM remediated in this commit
(H-1 cancel ownership two-layer split; H-2 Windows capability slot +
fallback as authorized implementation; H-3 shutdown stop moved to P6,
RunEngine gate proven emergent; M-1..M-4 and L-1..L-4 applied)

M4-P5 PRODUCTION IMPLEMENTATION:
NOT AUTHORIZED

M4-P5 PLANNING COMMITS:
943b383b (original planning) -> THIS remediation commit (ordinary forward
docs commits on docs/m4-p5-planning; no amend/rebase/squash)

M4-P4:
COMPLETE (unchanged)

M4 MILESTONE:
NOT COMPLETE (P5-P11 remain; P7/P11 gates required)

P6:
MUST NOT START

PR #45:
NOT MODIFIED / NOT MERGED / NOT CLOSED

Migration 014:
REUSED ONLY; NO NEW MIGRATION

New native/FFI/helper dependency:
NOT AUTHORIZED (Windows Job Object = optional future capability slot)

Production Cutover / Web Default Switch / Legacy Retirement / Ready / Merge:
NOT AUTHORIZED
```
