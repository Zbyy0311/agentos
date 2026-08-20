# AgentOS M4-P5 — Cancellation, Process Tree, Timeout and Transport Independence — Implementation Plan / Objective

Status: M4-P5 PRE-IMPLEMENTATION PLANNING — FIFTH NARROW DOCS-ONLY REMEDIATION (FRESH PLAN REVIEW PENDING) — M4-P5 PRODUCTION IMPLEMENTATION NOT AUTHORIZED

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

Make owned-tree cancellation safe without activating a public command before
its application composition exists. The fifth narrow remediation freezes an
internal P5A attempt-cancellation core, a later P5D command/application seam,
one proof-aware Process Runtime normalization authority, one exact
Stage-attempt rendezvous lifecycle, a non-circular finalization/capture wait
protocol, reason-specific timeout outcomes, and one shared Stage-attempt
finalization authority:

```text
P5A INTERNAL ATTEMPT CANCEL
  -> StageExecutionCoordinator.cancelAttempt({workspaceId, runId, stageId,
       stageAttempt, correlationId, causationId})
  -> exact Session claim + exact root Process claim
  -> join instance-local live execution rendezvous
  -> accepted durable Process stop ticket
  -> optional ticket-gated Adapter graceful request
  -> ProcessCancelCoordinator
        -> platform graceful -> grace -> force tree -> verify
        -> cleanupVerdictFromVerification(verification, exitedBeforeCleanup)
        -> durable Process fact + Provider-neutral stop disposition
   -> StageExecutionCoordinator.finalizeAttemptOnce(...)
        -> one parser/output/Adapter/Session finalization body
        -> typed internal CancellationOutcome / { kind:'stopped' }

NATURAL EXIT / TIMEOUT / P4 ACTIVATION-CAS COMPENSATION
  -> the same finalizeAttemptOnce(...) arbiter for that live attempt
  -> first accepted durable Process stop/terminal evidence wins

P5D PUBLIC COMMAND ACTIVATION (only after P5A + P5B + P5C)
  -> TaskRunService / OperationService command validation
  -> injected internal StageExecutionCoordinator cancellation port
  -> proven terminatedProcessIds only
  -> LifecycleTransactionService canonical Run/Stage cancellation

P5A COMPLETE != PUBLIC ACTIVE CANCEL ACTIVATED
P5A COMPLETE != PRODUCTION TREE CANCELLATION PROVEN

If the driver returns `classification='complete'` without a valid proof, the
single shared normalizer returns `unknown` + `UNKNOWN_PLATFORM_UNAVAILABLE`.
The Process becomes `orphaned`, the Session becomes `failed`, no successful
LTS hand-off occurs, and no Run/Stage terminal event is emitted. P5B is the
only phase that may make the real NodeProcessDriver emit the proof.

TIMEOUT -> ProcessTimers -> the SAME ProcessCancelCoordinator stop authority
  -> the SAME Stage-attempt finalization arbiter
TRANSPORT DISCONNECT -> unsubscribe only; NEVER enters stop authority
P6 SHUTDOWN -> future caller with reason='shutdown'; P6 owns server ordering
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
13. Every production cleanup caller MUST consume the one shared
    `cleanupVerdictFromVerification(verification, exitedBeforeCleanup)` seam
    in `packages/process-runtime/src/driver.ts`. It consumes the complete
    `SurvivorVerification`, never only `classification`. Only
    `classification='complete'` with `proof.kind='owned-tree-enumeration'`
    normalizes to `complete` + `TERMINATED`/`ALREADY_EXITED` + `proven=true`.
    Bare `complete`, survivors, and unknown normalize to
    `UNKNOWN_PLATFORM_UNAVAILABLE`/`SURVIVORS` with `proven=false`; no direct
    `classification === 'complete'` terminal branch is permitted.
14. POSIX real-OS group/survivor evidence is a REQUIRED P5B gate. If no valid
     POSIX environment exists, record `PLATFORM_GATE_BLOCKED`; P5B and overall
     P5 remain INCOMPLETE, and Windows-only evidence cannot close P5.
15. `StageExecutionCoordinator` owns one `finalizeAttemptOnce(...)` arbiter per
    live attempt. Natural exit, accepted cancel, timeout, P4 activation-CAS
    compensation and Provider-finalize races MUST join it; no independent
    finalizer is permitted.
16. Durable claim lookup occurs before an instance-local rendezvous keyed by
    `workspaceId|runId|stageId|stageAttempt`. The rendezvous retains only live
    execution coordination state and is never module-global, persisted,
    identity authority, restart truth or a replacement-spawn source.
17. If durable Process terminal evidence commits before a stop ticket, natural
    finalization owns. If a stop ticket is accepted first, `runToFinal` MUST
    join the stop finalization and MUST NOT call `finalize(cancelled=false)`,
    complete the Session or resolve a completed Stage outcome.
18. A Session terminal CAS loser MUST read/join persisted terminal Session
    state, never resolve its own desired local result. Exactly one persisted
    terminal Session state is authoritative.
19. Internal accepted stop returns a non-lifecycle `{ kind:'stopped', cleanup,
    proven }` outcome. Dispatcher consumes it with zero canonical lifecycle
    mutation; P5D owns any later LTS cancellation after proven cleanup.
20. Uncertain cleanup uses the existing `DurableOutputWriter.abort()` method
    for each writer, bounds/ends capture without an unbounded survivor wait,
    persists Process/Session uncertainty, and performs no Provider completion or
    canonical LTS success. A durable claim without a live rendezvous fails
    closed for P5A; P6 owns restart/recovery classification.
21. `StageExecutionCoordinator.liveAttempts` is private instance state keyed by
    `workspaceId|runId|stageId|stageAttempt`; it is ephemeral and never a
    durable/restart/ownership authority or replacement-spawn source.
22. For a new claim, the exact registration order is claim reservation,
    adapter-start CAS, writer creation, exact Session/Process revalidation,
    synchronous map insertion, then `consumeSpawnRightAndSpawn`; no await may
    occur between insertion and spawn-right consumption. Created-before-spawn
    cancel needs no entry; `joinedExisting` creates/replaces no entry.
23. A starting/running/waiting/stopping claim without an exact same-process
    live entry fails closed as `LIVE_EXECUTION_UNAVAILABLE` /
    `RECOVERY_REQUIRED`; no PID, Event scan, respawn or new coordinator may
    reconstruct it. Entry removal occurs only after finalization Promise,
    writer actions, Adapter decision, Session reconciliation and final Deferred
    settlement, with identity-checked deletion.
24. Drain tasks use explicit AsyncIterators and race `iterator.next()` against
    one-shot `captureStop`; they never await ProcessCancelCoordinator,
    finalization or Stage outcome. `iterator.return?.()` is best effort and
    never correctness-critical. The finalizer waits for drain-task quiescence,
    not native EOF after stop; no new append starts after stop ownership.
25. Stop ownership resolves `captureStop` before Adapter graceful coordination,
    grace expiry, force cleanup or survivor verification. ProcessCancelCoordinator
    waits on none of the drain/finalization promises. `runToFinal` submits
    natural disposition only after native exit, natural drain completion and
    the durable natural Process CAS; otherwise it joins the stop Promise.
26. `StopOrigin` is `EXPLICIT_CANCEL`, `STARTUP_TIMEOUT`, `IDLE_TIMEOUT`,
    `TOTAL_TIMEOUT` or `P4_ACTIVATION_FAILURE`. Proven explicit cancellation is
    `stopped` with zero lifecycle mutation; proven startup timeout is Provider
    start failure/Stage failed; proven idle/total timeout is Provider runtime
    failure/Stage failed; every unproven timeout is `stopped/proven=false` with
    zero lifecycle mutation. Timeout never uses Adapter `cancelled=true` merely
    because the Process stopped; P4 activation failure is Stage failed.
27. `DurableProcessCoordinator.#terminateStray` is in the P5A proof audit. A
    compensation-only stray result cannot satisfy E04 or successful
    cancellation; where verification is consumed it follows
    `terminateTree -> verifySurvivors -> cleanupVerdictFromVerification`, and
    bare complete is never promoted to proof.

## 4. Scope

### 4.1 Included

- Internal Stage-attempt / Process cancel coordination (one authority).
- Public Run / Operation command activation is P5D-owned and remains
  fail-closed/unactivated during P5A.
- Provider graceful stop via the accepted ticket (OD-M4-P5-02).
- Grace deadline (OD-M4-P5-03).
- Windows Job Object / process-group / bounded fallback force tree termination.
- Survivor verification (OD-M4-P5-06).
- Startup timeout, idle timeout, total timeout with frozen terminal reasons.
- Approval-wait idle suspension only where M3 `waiting_approval` proves it.
- Initial Conversation disconnect decoupling (E08 closure).
- Explicit cancel API remains the termination command, but its public active
  route activation is deferred to P5D.
- P4 LOW residual closure: startup compensation for spawned-but-unactivated
  Processes (OD-M4-P5-16, REQUIRED_P5_CLOSURE) — the coordination/state half
  in P5A (MockDriver), full production tree proof in P5B.
- Reusable, idempotent, typed Process-side stop pipeline with a supported
  `shutdown` stop reason for later P6 invocation (OD-M4-P5-17). Server
  shutdown enumeration, teardown ordering, deadline handling, shutdown-mode
  recording and recovery classification are P6-owned; P5 modifies no server
  shutdown wiring (`index.ts`) and no P5 acceptance depends on a
  server-shutdown integration test.
- Additive tree-verification proof provenance and the P5A no-proof fail-closed
  exposure boundary; P5B owns the real NodeProcessDriver proof emitter.
- One instance-local Stage-attempt finalization arbiter shared by natural exit,
  explicit cancel, timeout and P4 activation-CAS compensation; one terminal
  Adapter/output/Session finalization body and explicit internal `stopped`
  outcome.
- One narrow canonical Run-event observation port for P5C approval-wait timer
  coordination, backed by the existing `RunStreamService` and wired at the
  existing `createProviderExecutionChain(...)` composition root.

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

### 5.1 Chain (internal P5A, public P5D)

```text
P5A INTERNAL:
StageExecutionCoordinator.cancelAttempt({workspaceId, runId, stageId,
  stageAttempt, correlationId, causationId})
  -> DurableSessionRepository.getSessionByClaimKey(...)
  -> DurableProcessRepository.getRootProcessByClaim(...)
   -> validate same workspace/run/stage/attempt
   -> join the instance-local live attempt rendezvous
   -> ProcessCancelCoordinator.acceptStop(processId, reason, idempotencyKey)
   -> optional RuntimeProviderAdapter.cancel through accepted ProviderProcessPort
   -> proof-aware Process cleanup + stop disposition
   -> StageExecutionCoordinator.finalizeAttemptOnce(...)
   -> typed Provider-neutral CancellationOutcome / internal `stopped`

P5D PUBLIC:
TaskRunService / OperationService validates API version and idempotency
  -> injects the SAME internal cancellation port from the accepted provider
     execution composition
  -> queued/no-Process may use existing M3 zero-Process cancellation
  -> active requires proven terminatedProcessIds
  -> LifecycleTransactionService performs the only Run/Stage terminal mutation
```

`ProcessCancelCoordinator` owns no Provider, command, or lifecycle semantics.
`StageExecutionCoordinator` owns exact attempt correlation, Adapter graceful
request, the live rendezvous and the one `finalizeAttemptOnce` arbiter. Natural
exit, cancel, timeout and P4 compensation all submit to that arbiter; no
second Provider/output/Session finalizer exists. The coordinator does not own
HTTP or idempotency storage. P5A never activates public active-cancel routes;
P5D owns that application seam after P5A/P5B/P5C. `RunEngine.ts` and `index.ts`
remain forbidden.

RunEngine scheduling remains emergent: while an internal cancellation leaves
the claim non-terminal, re-dispatch joins `joinedExisting` and never spawns a
second Process; after an LTS terminal mutation, `RunEngine.dispatch` returns
`run-terminal`. These are regression guards, not new P5 production gates.

### 5.2 Freeze per cancel window

| Window | Frozen behavior |
|---|---|
| cancel before spawn (created) | stop ticket accepted; `created -> failed` with `cancelled-before-spawn`; spawn right revoked; Driver spawn count stays 0 (RACE-S1). |
| cancel concurrently with spawn | `created -> starting` consumed the right; cancel CASes `starting -> stopping` even with null PID; the single in-flight spawn result is awaited (RACE-S2). |
| cancel immediately after spawn | late success binds native identity to the same Process, stays `stopping`, and immediately runs the cleanup pipeline (RACE-S3). |
| cancel while Session is starting | Session remains non-terminal until Process cleanup evidence; then Session `failed` (activation/start) or `cancelled` (verified clean with cancel causation). |
| cancel while Session is active | internal P5A stop transitions Process to `stopping`; only a proof-backed normalized `complete` reaches `exited`/`TERMINATED` and Session `cancelled`; bare complete/survivors/unknown becomes `orphaned` + `UNKNOWN_PLATFORM_UNAVAILABLE`, Session `failed`, and no LTS call. |
| cancel during M3 `waiting_approval` | P5A cleans the paired Process first. Only P5D, after proven cleanup, calls the EXISTING approval-cancellation composite: `approval.resolved -> stage.cancelled -> run.cancelled` via `resolveApprovalToCancellation`; the generic cancel seam still rejects approval states (OD-M4-P5-19). |
| cancel while output streams drain | the shared finalization arbiter owns parser/output closure; proven cleanup calls each writer `finalize()` once, while uncertain cleanup calls each writer `abort()` and never waits unboundedly; terminal facts follow the bounded result. |
| cancel while Process exits naturally | durable Process terminal evidence before the stop ticket gives natural finalization ownership; an accepted stop ticket first makes `runToFinal` join the stop finalization and prevents Provider completion (OD-M4-P5-07 / OD-M4-P5-30). |
| cancel after Process exited but before Provider finalize | the same arbiter reconciles the durable Process evidence and accepted stop ticket; only the owning finalization body calls Adapter finalize and the Session terminal CAS. `provider_sessions.status='cancelled'` requires proven cleanup (the gated `provider.session_cancelled` Event is not a P5 dependency). |
| cancel during Provider finalize | the Provider-finalize race joins `finalizeAttemptOnce`; Adapter.finalize, output finalization and the terminal Session result each occur at most once; CAS losers read/join persisted Session state. |
| timeout during runToFinal | ProcessTimers accepts the stop through ProcessCancelCoordinator and submits to the same attempt arbiter; exit code 0 cannot become Provider completion after the stop ticket. |
| P4 activation-CAS compensation | compensation accepts the same stop authority and joins the same attempt arbiter; the runToFinal loser receives the shared failed/proven/uncertain result and no live child remains without an uncertainty record. |
| duplicate cancel (same key) | joins the first ticket; same result returned; no new ticket. |
| simultaneous duplicate cancel | CAS winner owns the ticket; losers join; one cleanup, one terminal fact. |
| cancel after terminal completion | returns the existing terminal result; no mutation, no duplicate Event. |
| cancellation failure (graceful fails) | force still runs; result driven by tree verification. |
| survivor detected | `orphaned` + `SURVIVORS`; cancellation not successful; Run uncertainty preserved via M3 seam. |
| unknown tree ownership or missing proof | `stopping -> orphaned`; `cleanupResult=UNKNOWN_PLATFORM_UNAVAILABLE`; `terminationReason` retains cancel causation; `process.orphaned(cleanupRequired=true)` only; Session `failed`; Run/Stage remain non-terminal; no LTS call. |
| graceful-stop failure | bounded progression to force; no guessing. |
| force-kill failure | `UNKNOWN_PLATFORM_UNAVAILABLE`/`PROCESS_TREE_TERMINATION_FAILED` evidence; uncertainty preserved. |

### 5.3 P4 LOW residual closure (OD-M4-P5-16)

Spawn succeeded but `starting -> active` Session CAS failed: `execute` MUST
NOT directly resolve the final Deferred with `PROVIDER_SESSION_FAILED`.
Compensation accepts/joins the Process stop ticket, resolves `captureStop`
immediately, lets the same ProcessCancelCoordinator produce cleanup evidence,
and submits a `P4_ACTIVATION_FAILURE` disposition to the same finalization
arbiter. `runToFinal` observes the accepted stop and joins; writer terminal
action, Session terminal transition and final Deferred settlement each occur
once. The canonical Stage outcome is failed because Session activation failure
is independently proven; tree uncertainty is recorded separately and never
claimed as successful cancellation. A valid proof may produce Process
`exited`; bare complete/no proof produces `stopping -> orphaned`,
`UNKNOWN_PLATFORM_UNAVAILABLE`, `process.orphaned(cleanupRequired=true)`, and
Session `failed`. No second spawn or successful lifecycle hand-off occurs, and
P6—not P5—folds persistent orphan/unknown evidence into restart recovery.
P5A proves this on MockDriver; P5B proves the real tree-cleanup half.

### 5.4 Exact live Stage-attempt rendezvous lifecycle

`StageExecutionCoordinator` owns a private instance map named `liveAttempts`
(or the repository-conventional equivalent), keyed by:

```text
workspaceId | runId | stageId | stageAttempt
```

The exact new-claim order is:

```text
establishClaimAndReservation(joinedExisting=false)
  -> casSetAdapterStartRequested succeeds
  -> open stdout/stderr writers
  -> re-read and revalidate exact Session + root Process ownership
  -> construct complete LiveAttemptRendezvous
  -> synchronously liveAttempts.set(key, entry)
  -> consumeSpawnRightAndSpawn(...)
```

There is no await between `liveAttempts.set` and the call that can consume
`created -> starting`. A created-before-spawn cancellation needs no entry. If
pre-spawn revalidation finds the Process no longer startable, abort opened
writers, do not register an entry and do not call Driver.spawn. When
`established.joinedExisting === true`, create/replacement/spawn/runToFinal and
new Adapter-start behavior are all forbidden; the original authority retains
ownership and the existing active/join semantics remain.

The entry retains only the exact key and Session/Process IDs, the
`NativeProcessHandle` once available, both writers, parser/parsed-event state,
bounded stderr, the final Stage Deferred, one `captureStop` latch, stdout and
stderr drain tasks, one `finalizationPromise`, and accepted stop disposition.
It is ephemeral, instance-local and non-authoritative. A durable
starting/running/waiting/stopping claim without an exact same-process entry
returns `LIVE_EXECUTION_UNAVAILABLE` / `RECOVERY_REQUIRED`; P5A does not
reconstruct a handle from PID, scan Events, respawn, create a coordinator or
guess success.

The original entry is removed only after its finalization Promise has completed
writer terminal actions, Adapter finalization decision, Session reconciliation
and final Deferred settlement:

```text
finalizationPromise.finally(() => {
  if (liveAttempts.get(key) === thisEntry) liveAttempts.delete(key)
})
```

A loser or duplicate cannot remove another entry. P6 owns later restart and
recovery classification.

### 5.5 Non-circular finalization wait graph and stream interruption

`NativeProcessHandle` remains unchanged in P5A: stdout/stderr are generic
`AsyncIterable<Uint8Array>` values and the handle exposes `waitExit()` only.
StageExecutionCoordinator drain helpers refactor `for await` into explicit
AsyncIterator loops. Each loop races `iterator.next()` against the one-shot
`captureStop` latch:

```text
nextPromise = iterator.next()
winner = await Promise.race([nextPromise -> NEXT(result), captureStop -> STOP])
```

On STOP, `iterator.return?.()` is best-effort and is never awaited for
correctness. A pending `next()` cannot gate finalization after STOP wins. An
append already in progress may quiesce, but no new chunk is appended after
stop ownership. Both drain tasks must quiesce before any writer `finalize()` or
`abort()`, preventing append-after-close races. No custom Driver cancellation
API, `Readable.destroy()` or `node-driver.ts` change is authorized in P5A.

The wait graph is frozen as follows:

```text
drain task       -> iterator.next() OR captureStop only
runToFinal       -> stdout drain + stderr drain + handle.waitExit in parallel
stop producer    -> durable ticket -> captureStop.resolve immediately
                 -> Adapter graceful / ProcessCancelCoordinator cleanup
                 -> finalizeAttemptOnce
ProcessCancelCoordinator -> no drain/finalization/Stage Deferred wait
finalizer        -> quiesced drains only; never native EOF after accepted stop
```

`runToFinal` submits NATURAL only after native exit, natural drain completion
and the durable natural Process CAS. If a stop wins the Process evidence, it
submits no natural disposition and joins the stop Promise. Cancellation joins
the finalization Promise only after the stop ticket is accepted/joined and the
frozen cleanup disposition is available. No finalizer -> cancelAttempt ->
finalizer cycle and no finalizer -> runToFinal -> EOF cycle is permitted after
stop ownership.

### 5.6 Single Stage-attempt finalization authority

`StageExecutionCoordinator.finalizeAttemptOnce(...)` is the only Provider,
output and Session finalization seam. `LiveAttemptRendezvous.finalizationPromise`
starts undefined; the first contender with PROVEN durable authority installs
exactly one Promise:

```text
entry.finalizationPromise ??= performFinalization(entry, disposition)
```

All other contenders only join it. The owning disposition must match durable
Process truth: terminal Process evidence before a stop ticket gives natural
ownership; a stop ticket first gives stop ownership; later timeout/cancel/
compensation origins are diagnostics only. A Session terminal CAS loser reads
and joins persisted terminal Session truth and never resolves a local desired
result.

The contender protocol is explicit:

```text
NATURAL runToFinal:
  observe native exit and quiesced natural drains
  attempt durable natural Process terminal CAS
  applied/terminal natural evidence -> install NATURAL only if no stop won
  stopping/stop-owned evidence -> install nothing; join existing stop Promise

STOP cancel/timeout/compensation:
  accept or join durable stop ticket
  terminal natural evidence -> install nothing; read/join natural Promise
  stopping accepted -> resolve captureStop
                   -> ProcessCancelCoordinator cleanup disposition
                   -> install STOP/P4 disposition exactly once
```

No contender may install a local disposition before this durable evidence
check, and no JavaScript callback order may choose ownership.

Natural finalization drains and parses normally, finalizes both writers once,
calls `Adapter.finalize(cancelled=false)` once and reconciles one Session
terminal result. Proven explicit cancellation finalizes both writers once,
calls `Adapter.finalize(cancelled=true, parsedEvents=...)` once and may persist
Session `cancelled`. Uncertain explicit or timeout cleanup aborts both writers
at most once, persists Process orphan/unknown and Session failed, and emits no
Provider success or LTS success. Proven timeout uses the Provider failure path
with `Adapter.finalize(cancelled=false, providerError=<timeout>)`, never user
cancel success. P4 activation failure returns Stage failed because its
activation failure is independently proven; tree uncertainty remains recorded.

The internal Stage result is:

```text
{ kind: 'stopped', cleanup: <typed cleanup disposition>, proven: boolean,
  stopOrigin: EXPLICIT_CANCEL | STARTUP_TIMEOUT | IDLE_TIMEOUT | TOTAL_TIMEOUT }
```

P4 activation failure uses the existing failed outcome. Dispatcher consumes
stopped explicit cancellation and unproven timeout by returning with zero
canonical Stage/Run/LTS mutation. `RunEngine.ts` remains forbidden.

### 5.7 Stop-origin timeout mapping and stray cleanup

| Stop origin | Proven cleanup | Unproven cleanup |
|---|---|---|
| `EXPLICIT_CANCEL` | `stopped`, `proven=true`; Dispatcher zero lifecycle mutation; P5D later owns canonical cancellation | `stopped`, `proven=false`; Dispatcher zero lifecycle mutation; Run/Stage nonterminal |
| `STARTUP_TIMEOUT` | `PROVIDER_START_FAILED`, phase `startup`, Stage failed | Process orphan/unknown + Session failed; `stopped`, `proven=false`; Stage remains nonterminal |
| `IDLE_TIMEOUT` / `TOTAL_TIMEOUT` | `PROVIDER_SESSION_FAILED`, phase `runtime`, Stage failed | Process orphan/unknown + Session failed; `stopped`, `proven=false`; Stage remains nonterminal |
| `P4_ACTIVATION_FAILURE` | Stage failed; cleanup evidence recorded separately | Stage failed; cleanup uncertainty recorded separately |

Timeout never uses `Adapter.finalize(cancelled=true)` merely because the
Process was stopped. `#terminateStray` is explicitly audited: a compensation-
only result cannot satisfy E04, create successful cancellation evidence or
promote bare `terminateTree().classification === 'complete'` to proof. Where
verification is consumed it follows `terminateTree -> verifySurvivors ->
cleanupVerdictFromVerification`; otherwise it remains fail-closed diagnostic
cleanup only.

Dispatcher mapping is frozen as:

| Coordinator result | Dispatcher behavior |
|---|---|
| `completed` | existing completion lifecycle |
| `failed` | existing failure lifecycle |
| `active` | existing joined-authority behavior |
| `stopped` with `EXPLICIT_CANCEL` or unproven timeout | zero Stage/Run/LTS lifecycle mutation |
| P4 activation failure | existing failed Stage path |

## 6. Process tree contract

### 6.1 Windows

| Aspect | Frozen design |
|---|---|
| Job Object | OPTIONAL FUTURE CAPABILITY SLOT (OD-M4-P5-04/05), not a mandatory P5 requirement. Real Job integration (`CREATE_SUSPENDED` -> assign -> resume -> `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` -> job-membership survivor proof) requires a future separate technical/dependency authorization (native addon, FFI or helper mechanism); none is introduced or authorized by P5. The capability is not deleted: the driver records its availability, and a future authorized implementation slots into `Driver.spawn` before the child runs application code, with observable assignment failure and nested-job detection. |
| Authorized P5 implementation | Observable bounded fallback on every managed root: retained root native identity; bounded descendant enumeration via a CIM-equivalent inspection mechanism selected during P5B from already authorized OS facilities (separated arguments; no shell string concatenation); identity fencing (start time / executable) of root and descendants before any destructive signal; safely parameterized `taskkill /PID <owned-root-pid> /T /F` constrained to the owned root subtree; re-enumeration and survivor verification after force; `complete`/`survivors`/`unknown`; success NEVER inferred from `taskkill` exit status alone. |
| Observability | `treeMode='fallback'` recorded per managed root; warning + reduced-reliability internal diagnostic; never silent; diagnostics leak no secrets. |
| Acceptance gate | The REQUIRED Windows gate is the fallback owned-tree proof (WIN-06). `complete` is accepted only with the `owned-tree-enumeration` proof marker. WIN-05 (Job path) is OPTIONAL_CAPABILITY/ENV-GATED evidence only: PASS only if a separately authorized Job implementation exists, otherwise explicit UNSUPPORTED/BLOCKED capability evidence; not required for base P5 acceptance as long as the fallback proves E04 completely. |
| `.exe` / `.cmd` | `.exe` direct; `.cmd`/`.bat` only through explicit validated wrapper policy (`cmd /d /c` with separated args, never user-string concatenation) — P0 §16.2. |
| `shell=false` | enforced at launch validation; never bypassed for tree reasons. |
| Unicode / spaces | path/args preserved as array entries; no string re-quoting; covered by platform tests. |
| Child/grandchild ownership | the owned set is the fenced root subtree; the fallback enumerates root + descendants before and after force; `taskkill /T` output alone is not completion proof — re-enumeration is. |
| Survivor enumeration | after force, re-enumerate root, known and newly discovered descendants; classify complete/survivors/unknown. |
| Access-denied / already-exited races | identity re-check before each signal; already-exited -> `ALREADY_EXITED`; access-denied -> `unknown`. |
| PID reuse / identity fencing | `inspectIdentity` compares start time/executable/group/token in addition to PID; mismatch -> `IDENTITY_MISMATCH`; no signal on mismatch. |
| Inspection facility evidence | P5B records the exact selected existing Windows inspection facility (for example PowerShell `Get-CimInstance`), host/tool version and capability for each evidence run; one facility is used consistently and may not be silently swapped mid-run. |
| CIM `CreationDate` | serialized values are parsed and normalized deterministically to the identity comparison representation; missing, malformed or unparseable values -> `UNKNOWN` and fail closed. |
| `ExecutablePath` availability | null, access-denied or incomplete executable identity -> `UNKNOWN` and fail closed; never guess an executable path or infer identity from PID liveness/taskkill output. |

### 6.2 POSIX

| Aspect | Frozen design |
|---|---|
| Group/session creation mechanism | `NodeProcessDriver` internally passes `detached: true` to `node:child_process.spawn` on POSIX ONLY, solely as the Node mechanism for creating a new owned process group/session (spec §45 recommends `detached = true` or equivalent `setsid()`). Invariants (OD-M4-P5-05): caller-facing `LaunchRequest.detached` stays denied by launch validation; stdio remains piped/owned; the `ChildProcess` handle remains retained; `child.unref()` is NEVER called; execution remains AgentOS-owned; the fresh PGID is recorded in `NativeIdentity.groupId`. This authorizes no user-requestable detached/daemon behavior (P0 §16.12) and satisfies the P0 §9 owned-group requirement — the flag selects the OS group-creation mechanism only, while every ownership invariant stays enforced. |
| TERM | signal the group (`process.kill(-pgid, SIGTERM)`), not only the root. |
| Grace | snapshot `cancelGracePeriodMs` via injected clock. |
| KILL | signal the group (`SIGKILL`). |
| Group identity | PGID captured at spawn; group identity/start evidence revalidated before every `-pgid` signal — Linux via `/proc` evidence, macOS/BSD via a bounded ps-equivalent evidence adapter; reused-PGID or insufficient identity blocks signaling (fail closed). |
| Natural-exit races | exit observed before signal -> `ALREADY_EXITED`; during grace -> finalize with verification. |
| Survivor verification | group membership + known descendants; zombie reap; classify complete/survivors/unknown; `complete` is accepted only with the `owned-tree-enumeration` proof marker. |

A successful cancellation means the owned-tree cleanup result satisfies the
frozen contract (`TERMINATED`/`ALREADY_EXITED` with verified `complete`), not
merely that the parent PID disappeared.

### 6.3 Tree-verification proof provenance and the one normalizer

`packages/process-runtime/src/driver.ts` is the sole planned normalization
seam. The additive proof is intentionally minimal:

```text
SurvivorVerification {
  classification: 'complete' | 'survivors' | 'unknown'
  knownPids: readonly number[]
  proof?: { kind: 'owned-tree-enumeration' }
}

cleanupVerdictFromVerification(
  verification: SurvivorVerification,
  exitedBeforeCleanup: boolean,
): {
  classification: 'complete' | 'survivors' | 'unknown'
  cleanupResult: 'TERMINATED' | 'ALREADY_EXITED' | 'SURVIVORS' | 'IDENTITY_MISMATCH' | 'UNKNOWN_PLATFORM_UNAVAILABLE'
  proven: boolean
}
```

The function consumes the COMPLETE verification object and is the only
production mapping from tree evidence to cleanup vocabulary:

```text
complete + proof.kind='owned-tree-enumeration'
  -> { classification:'complete',
       cleanupResult: exitedBeforeCleanup ? 'ALREADY_EXITED' : 'TERMINATED',
       proven:true }

complete + missing/invalid proof
  -> { classification:'unknown', cleanupResult:'UNKNOWN_PLATFORM_UNAVAILABLE',
       proven:false }

survivors -> { classification:'survivors', cleanupResult:'SURVIVORS', proven:false }
unknown   -> { classification:'unknown',
               cleanupResult:'UNKNOWN_PLATFORM_UNAVAILABLE', proven:false }
```

Identity mismatch remains the separately fenced `IDENTITY_MISMATCH` path.
`manager.ts`, `durable-coordinator.ts`, `process-cancel-coordinator.ts`, and
all future timeout/compensation callers MUST consume this normalized verdict;
none may branch directly on `verification.classification === 'complete'` or
`terminateTree(...).classification === 'complete'`. The old
`cleanupResultFrom(classification, exitedBeforeCleanup)` helper is removed from
production use (or retained only as a non-cancellation compatibility helper).

P5A proves both bare-complete negative and valid-proof MockDriver positive
paths. P5B is the only phase that may make the real `NodeProcessDriver` emit
the marker, and only after platform enumeration, identity fencing, destructive
action, post-force verification, and no unknown survivor. Root exit,
`child.kill()`, taskkill exit status, or PID liveness alone can never emit it.

The phase statement is frozen:

```text
P5A COMPLETE
!=
PRODUCTION TREE CANCELLATION PROVEN
```

P5A establishes authority/state safety and fail-closed exposure. P5B is the
phase that converts the real `NodeProcessDriver` from no accepted owned-tree
proof to platform-proven owned-tree proof.

POSIX gate semantics are not optional: POSIX real-OS group and survivor
evidence is a REQUIRED P5B acceptance gate under the current P0/M4 contract.
If no valid POSIX host/capability exists, record `PLATFORM_GATE_BLOCKED` with
the evidence; POSIX is NOT PASS, P5B acceptance is INCOMPLETE, overall P5 is
INCOMPLETE, and M4-P5 MUST NOT be declared COMPLETE. This is not a silent skip
or an acceptable substitute, and no CI infrastructure work is authorized by
this planning remediation.

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
| Proven cleanup outcome | `PROVIDER_START_FAILED` / Stage failed | `PROVIDER_SESSION_FAILED` / Stage failed | `PROVIDER_SESSION_FAILED` / Stage failed |
| Unproven cleanup outcome | `stopped`, `proven=false`; Dispatcher zero lifecycle mutation; Stage remains nonterminal | `stopped`, `proven=false`; Dispatcher zero lifecycle mutation; Stage remains nonterminal | `stopped`, `proven=false`; Dispatcher zero lifecycle mutation; Stage remains nonterminal |
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
owns the transition. Timeout and explicit cancellation share Process evidence
but not canonical Stage semantics: proven timeout uses the Provider failure
path with `Adapter.finalize(cancelled=false, providerError=<timeout>)`, while
unproven timeout returns `stopped/proven=false` and leaves Stage/Run
nonterminal. P4 activation-CAS failure is independently proven and returns
Stage failed.

Approval-wait seam (OD-M4-P5-14): P5C owns exactly one narrow
`CanonicalRunEventObservationPort` dependency on `StageExecutionCoordinator`.
The production `createProviderExecutionChain(...)` composition root adapts
`store.runStreamService()` (one notifier, one durable repository, ordered
catch-up and dedupe) to that port; no HTTP/SSE object participates.

The correctness-first observation contract is frozen as:

```text
subscribe({workspaceId, runId, afterSequence: 0, onEvent, onFailure}) -> unsubscribe()
```

The observer starts DISARMED and scans ordered durable events until it sees:

```text
stage.started
  where event.stageId == input.stageId
    and payload.attempt == input.stageAttempt
```

Only that event arms the exact Stage-attempt observer. Before the anchor, all
approval events are ignored for timer side effects. After the anchor:

```text
approval.required
  -> same workspace/run/stage, sequence after anchor, non-empty request id
  -> record approvalRequestId once
  -> Process running -> waiting -> pauseIdle() once

approval.resolved
  -> same workspace/run/stage, sequence after required, same request id
  -> approve_once/approve_run/approve_workspace: waiting -> running/resumeIdle()
  -> reject/cancel_run: no resume
```

A newer `stage.started` for the same stage with a higher/different attempt
invalidates and closes the old observer. A stopping/orphaned/terminal Process
ignores resolution. Duplicate/replayed events are cursor-idempotent. The
initial cursor is always `0`; `RunStreamService` supplies bounded durable
catch-up and subscribe-before-catch-up ordering. Any overflow,
durability-mismatch, subscriber callback failure, or other observation close
calls `onFailure(reason, lastSafeSequence)`, performs no guessed waiting/running
transition, and leaves total-timeout truth untouched. P5C may add this optional
backward-compatible callback to `RunStreamService.ts`; notifier and repository
remain unchanged unless an unavoidable blocker is demonstrated and planning is
re-entered. No polling, inferred approval state, second repository, or second
state machine is allowed.

The `cancel_run` resolution remains the first event of the existing
approval-cancellation composite, but that public Run/Stage composite is P5D
owned and is invoked only after proven Process cleanup. Total timeout remains
active during waiting; startup is already disarmed after readiness; only idle
pauses.

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

### P5A — Internal cancel authority + proof/state safety

| Field | Value |
|---|---|
| Goal | Prove the internal Stage-attempt cancellation authority, one proof-aware Process Runtime normalizer, exact Session/Process claim correlation, one instance-local finalization arbiter shared by natural/cancel/timeout/compensation, durable stop-ticket races, Provider graceful/finalize behavior, P4 LOW compensation, and fail-closed behavior with the unchanged P4 driver. |
| Exact dependency | P4 accepted; P0/P2B durable Process/Session repositories; `ProcessManager`/`DurableProcessCoordinator` stop surfaces. |
| Allowed files/packages | `packages/process-runtime/src/driver.ts` (additive proof type + `cleanupVerdictFromVerification`), `manager.ts`, `durable-coordinator.ts`, NEW `process-cancel-coordinator.ts`, `repository-port.ts` (claim lookup ports), `testing/mock-driver.ts`, package exports/errors/tests; `apps/server/src/store/process-runtime-adapters.ts` (lookup adapters only), existing `ProviderSessionRepository.findByClaimKey` and `ProcessRepository.findByRootClaim` adapters/tests, `apps/server/src/services/run-engine/StageExecutionCoordinator.ts` internal `cancelAttempt`/`finalizeAttemptOnce`/Session finalization, `apps/server/src/services/run-engine/RunEngineProviderDispatcher.ts` stopped-outcome consumption only, server/package tests/fixtures. |
| Forbidden files | `TaskRunService.ts`, `canonicalRuns.ts`, `v2Runs.ts`, `OperationService.ts`, `routes/operations.ts`, `routes/conversations.ts`, `RunStreamRegistry.ts`, `index.ts`, public command activation, P5B `node-driver.ts` tree internals, P5C timeout/observation wiring, migrations/schema, package.json/lockfile, `RunEngine.ts`, agent-core adapter changes, LifecycleTransactionService implementation. |
| Production changes | Shared proof-aware normalization; Manager/DurableCoordinator enforcement; ProcessCancelCoordinator stop ticket; exact claim lookup ports; StageExecutionCoordinator live rendezvous with exact pre-spawn registration/removal; explicit AsyncIterator capture interruption using `captureStop` without changing the Driver API; non-circular single `finalizeAttemptOnce` arbiter; natural/cancel/timeout/P4 compensation convergence; ticket-gated Adapter graceful request; one Provider/output/Session finalization body; explicit internal `stopped` outcome; reason-specific timeout mapping; Session cancelled only with proven explicit cleanup or failed on uncertainty; P4 LOW compensation; explicit `#terminateStray` audit. |
| Test changes | RACE-S1..S5; FINAL-01..FINAL-26; TO-19..TO-25; STRAY-01; active-CAS-failure; duplicate/concurrent/after-terminal stop; proof mutation through Manager, registration failure, late success, `#terminateStray` and ProcessCancelCoordinator; valid MockDriver proof; claim workspace/run/stage/attempt mismatch; Session/Process facts; no second spawn; no LTS call on unproven/stopped result; terminal-CAS loser persisted-state join; architecture-negative Provider imports and Driver-API mutation. |
| Platform scope | MockDriver only; the unchanged P4 NodeProcessDriver is intentionally no-proof. |
| Stop conditions | any direct classification-only terminal branch; bare complete accepted; wrong claim joined; Session cancelled without proof; LTS/Run/Stage mutation; second spawn/ticket/fact; public active route activated. |
| Acceptance criteria | `P5A COMPLETE = INTERNAL CANCEL AUTHORITY + STATE SAFETY + PROOF GATE + SINGLE ATTEMPT FINALIZER`; exact normalized no-proof result; exact live-entry lifecycle; non-circular capture/finalization wait graph; P4 LOW coordination half; reason-specific timeout origin contract ready for P5C; stopped Dispatcher path makes zero canonical mutation; no public active cancel; no `RunEngine.ts`/`index.ts` change; unchanged P4 driver fails closed; `#terminateStray` cannot create proof. |
| Rollback boundary | revert internal cancel/proof/correlation additions; no public command or Process evidence is deleted. |
| Fresh regression suites | Process package, durable coordinator/repository, StageExecutionCoordinator and lifecycle regression suites. |
| Independent review gate | internal lifecycle-race + proof/state-machine review (BLOCKER/HIGH 0). |
| Real Kimi gate | not required. |

### P5B — Platform process-tree termination

| Field | Value |
|---|---|
| Goal | Implement and prove owned-tree termination + survivor verification on Windows via the authorized observable fallback and on POSIX via the owned process group, plus PID-reuse identity fencing. Job Object remains an OPTIONAL FUTURE CAPABILITY SLOT (OD-M4-P5-04/05); no new native/FFI/helper dependency is introduced. |
| Exact dependency | P5A stop pipeline/ticket semantics. |
| Allowed files/packages | `packages/process-runtime/src/node-driver.ts`, `driver.ts` contract additions (`treeMode`, group/job identity fields), `types.ts` `NativeIdentity` additions, real-OS child fixtures under package tests, platform contract tests. |
| Forbidden files | cancel coordinator behavior, timeout wiring, transport routes, migration/schema, agent-core adapters, package.json/lockfile or any new dependency. |
| Production changes | `NodeProcessDriver.spawn` (POSIX group creation via driver-internal `detached: true` with the OD-M4-P5-05 invariants; Windows retained identity + observable `treeMode='fallback'` + capability recording), `gracefulStop/terminateTree/verifySurvivors/inspectIdentity` tree implementations (Windows: CIM-equivalent descendant enumeration + fenced `taskkill /T /F`; POSIX: `/proc` or bounded ps-equivalent evidence + group signaling). |
| Test changes | Windows fallback (REQUIRED gate): `.exe`, `.cmd` (validated wrapper), path spaces/Unicode, child/grandchild, survivor, access-denied, already-exited, PID-reuse mismatch, taskkill-exit-not-proof, selected inspection facility/version/capability, deterministic CIM `CreationDate` parsing, null/access-denied/incomplete `ExecutablePath` -> `UNKNOWN`, no silent facility switch, observable `treeMode`; POSIX: group TERM/grace/KILL, group escape, survivor verification, zombie reap, PGID-reuse fencing, group-creation invariants (stdio piped, handle retained, no unref); Job capability recording (WIN-05, OPTIONAL_CAPABILITY/ENV-GATED). |
| Platform scope | Windows + POSIX real OS child fixtures (env-gated) + Mock parity. |
| Stop conditions | driver cannot prove tree ownership; `complete` without enumeration or without the proof marker; survivor list empty on known failure; signal on mismatched identity. |
| Acceptance criteria | E04 passes on real Windows via the fallback owned-tree proof; `complete` requires the `owned-tree-enumeration` proof marker; the evidence records the selected inspection facility/version/capability, deterministic `CreationDate` normalization and `ExecutablePath` unavailable -> `UNKNOWN` behavior; POSIX group proof is a REQUIRED P5B gate and must pass on an actual POSIX host/capability — otherwise record `PLATFORM_GATE_BLOCKED` with evidence and leave P5B and overall P5 INCOMPLETE (no silent skip, no substitute result, no full cross-platform acceptance claim); `terminateTree` returns method/members/errors; `verifySurvivors` classifies correctly; fallback parity proven. |
| Rollback boundary | revert driver tree internals; P5A cancel semantics unchanged. |
| Fresh regression suites | full P5A + prior platform contract tests. |
| Independent review gate | Windows/POSIX platform + security review. |
| Real Kimi gate | not required for the platform slice itself. |

### P5C — Timeout integration

| Field | Value |
|---|---|
| Goal | Wire frozen startup/idle/total policies from the Provider Configuration snapshot into the durable path; approval-wait idle suspension; timeout terminal reasons and races. |
| Exact dependency | P5A stop pipeline; P0 timer machinery already in `ProcessTimers`. |
| Allowed files/packages | `packages/process-runtime/src` (timeouts consumption), `StageExecutionCoordinator.ts` timeout-policy propagation plus the narrow `CanonicalRunEventObservationPort`, `apps/server/src/services/run-engine/providerExecutionChain.ts` (adapt `store.runStreamService()`), `apps/server/src/services/RunStreamService.ts` (optional additive failure callback only), `ProcessRepository`/`process-runtime-adapters.ts` policy persistence, `SnapshotService.ts` snapshot `timeoutPolicy`, tests. `RuntimeEventNotifier.ts` and `RuntimeEventRepository.ts` remain unchanged unless an unavoidable blocker is proven and planning is re-entered. |
| Forbidden files | platform driver tree internals, transport routes, `apps/server/src/index.ts` or other server-shutdown wiring, migration/schema. |
| Production changes | propagate `startupMs/idleMs/totalMs`; `markReady` on Session active; inject one `CanonicalRunEventObservationPort`; wire `createProviderExecutionChain(...)` to `store.runStreamService()`; start with `afterSequence=0`, arm only after matching `stage.started`/`payload.attempt`, fence approvalRequestId and newer attempts, and map every RunStream failure callback to fail-closed observer cleanup; `approval.required` -> paired Process `enterWaiting`/`pauseIdle`; normal `approval.resolved` -> `exitWaiting`/`resumeIdle`; `reject`/`cancel_run` -> no resume. Every timeout enters ProcessCancelCoordinator and the same Stage-attempt `finalizeAttemptOnce` arbiter; no separate timeout Session finalizer. Public Run/Operation/LTS activation remains P5D-owned. No HTTP/SSE dependency, polling, second Event repository or second state machine. |
| Test changes | fake-clock startup/idle/total; activity resets idle; stage.started anchor; pre-anchor approvals ignored; wrong attempt/newer attempt invalidates; approvalRequestId pair fencing; duplicate/replayed event no double pause; normal `approval.resolved` resumes remaining budget; overflow/durability-mismatch/callback-failure callback fails closed; total unaffected by waiting; startup disarmed; timeout-vs-exit/cancel; no flaky wall-clock tests; no second approval state machine, polling or HTTP/SSE. |
| Platform scope | none (injected clock). |
| Stop conditions | timeout marks success; idle suspension without exact M3 `approval.required`/`approval.resolved` evidence; missing cursor/stageAttempt fencing; observation overflow/failure guessed as a timer transition; HTTP/SSE enters the seam; flaky timing tests. |
| Acceptance criteria | every timeout produces the frozen Process/Provider/Stage mapping; approval-wait suspension only under M3 `waiting_approval`; the narrow port is wired at `providerExecutionChain.ts` from `store.runStreamService()` and no HTTP/SSE/polling path participates. |
| Rollback boundary | revert timeout policy propagation; P5A/B unchanged. |
| Fresh regression suites | P1 timer/race suites + P4 suites. |
| Independent review gate | timer/race review. |
| Real Kimi gate | not required. |

### P5D — Public command activation + transport independence

| Field | Value |
|---|---|
| Goal | After P5A/P5B/P5C, activate public canonical/v2/Operation explicit cancellation through the injected internal authority, preserve queued compatibility, close the Conversation disconnect path, and keep disconnect distinct from cancel. |
| Exact dependency | P5A internal authority + P5B proof + P5C accepted; no public active cancel before these dependencies. |
| Allowed files/packages | `apps/server/src/services/TaskRunService.ts` active cancel application seam; `apps/server/src/routes/canonicalRuns.ts`; `apps/server/src/routes/v2Runs.ts`; `apps/server/src/services/OperationService.ts`; `apps/server/src/routes/operations.ts`; `apps/server/src/routes/conversations.ts`; `RunStreamRegistry.ts` only if explicit cancel compatibility requires it; route/application tests and disconnect E2E fixtures. |
| Forbidden files | `index.ts` default Provider cutover unless a later review proves it strictly necessary and re-enters planning; Process Runtime/tree internals; migrations/schema; `RunEngine.ts`; unrelated route behavior; new singleton/second Process Runtime. |
| Production changes | inject the SAME StageExecutionCoordinator internal cancel port into canonical/v2/Operation composition; queued/no-Process retains existing M3 zero-ID path; active path performs runtime cleanup outside SQLite transactions, revalidates versions, invokes LTS only with proof-backed terminatedProcessIds; waiting_approval uses `resolveApprovalToCancellation` only after proof; Operation active cancel uses the same two-phase flow; Conversation initial close no longer aborts execution; explicit Conversation cancel remains distinct. Default/uninjected active cancellation returns `RUN_CANCEL_AUTHORITY_UNAVAILABLE` (or frozen equivalent) with no mutation. |
| Test changes | queued empty-ID legal path; active proven non-empty-ID path; active unproven LTS call count zero; route fail-closed without injection; same-ticket duplicate; waiting_approval event ordering; Operation cleanup outside transaction and final version revalidation; race/conflict no second stop; HTTP/SSE disconnect continues; explicit cancel terminates through canonical authority. |
| Platform scope | none; consumes P5B/P5C evidence. |
| Stop conditions | any public active route before P5B/P5C; empty-ID active success; OS wait inside SQLite transaction; second Process Runtime; disconnect cancellation; duplicate stop/fact. |
| Acceptance criteria | public active Run/Operation cancellation is activated only after P5A/P5B/P5C; every active success has proven terminatedProcessIds; uncertainty leaves Run/Stage nonterminal and returns stable failure; E08 remains independent. |
| Rollback boundary | revert public application/route activation; preserve internal Process evidence. |
| Fresh regression suites | full M3 command/idempotency/Operation/routes/Conversation suites plus P5A-C evidence. |
| Independent review gate | command authority + transaction/race + transport review. |
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
| Stop conditions | Kimi tree cannot produce enumeration-backed proof; a bare `complete` is accepted; disconnect terminates; cancel leaves survivors; POSIX proof is blocked but treated as pass; flaky/rerun acceptance. |
| Acceptance criteria | E04/E08 + E06 on the real chain; cancellation success includes `complete` + `owned-tree-enumeration` proof; POSIX gate status is PASS (not `PLATFORM_GATE_BLOCKED`); recorded immutable head/versions/IDs. |
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

Slice boundaries are serial: P5A owns the internal cancel/proof/state surface,
P5B the driver, P5C timeout/observation integration, P5D public command and
transport activation, P5E integrated evidence, and P5F review. No two agents
may concurrently mutate the coordinator, driver, command seam or
`RunStreamRegistry` without a new coordination boundary.

## 9.1 Code-level responsibility map (P5A)

| Responsibility | Existing symbol to extend / new symbol | Exact owner and boundary |
|---|---|---|
| proof type | `driver.ts` `SurvivorVerification` | additive `proof?: {kind:'owned-tree-enumeration'}`; P5B is the only emitter |
| proof normalizer | new `cleanupVerdictFromVerification` in `driver.ts` | sole mapping from complete verification to cleanup result; all callers use it |
| Manager stop cleanup | `manager.ts` `#runCleanup`/registration compensation | consumes normalized verdict; no direct classification branch |
| Durable cleanup | `durable-coordinator.ts` `#terminateAndVerify`/late-success paths | consumes normalized verdict for registration and late-success cleanup |
| ProcessCancelCoordinator | new `process-cancel-coordinator.ts` | process-side stop ticket, platform cleanup and Provider-neutral result only |
| Session claim lookup | new `DurableSessionRepository.getSessionByClaimKey` + adapter | backed by existing `ProviderSessionRepository.findByClaimKey` |
| Root Process lookup | new `DurableProcessRepository.getRootProcessByClaim` + adapter | backed by existing `ProcessRepository.findByRootClaim` |
| Live attempt rendezvous | `StageExecutionCoordinator` private `liveAttempts` instance state | key `workspaceId|runId|stageId|stageAttempt`; exact claim IDs, handle, parser, writers, bounded stderr, Deferred, captureStop, drain tasks, finalization Promise and stop disposition only; no module-global/persistence/recovery authority |
| Rendezvous registration | `StageExecutionCoordinator.execute` | after new-claim start-request CAS, writer creation and exact Session/Process revalidation; synchronous map insertion immediately before `consumeSpawnRightAndSpawn`, with no await between insertion and spawn-right consumption |
| Pre-spawn revalidation | `StageExecutionCoordinator.execute` | created-before-spawn cancel needs no entry; a no-longer-startable Process aborts opened writers, registers no entry and never spawns |
| Joined-existing behavior | `StageExecutionCoordinator.execute` | `joinedExisting` creates/replaces no entry, starts no `runToFinal` or Adapter start and remains the existing active/join path |
| Missing live entry | `StageExecutionCoordinator.cancelAttempt` | starting/running/waiting/stopping exact durable claim without same-instance entry returns `LIVE_EXECUTION_UNAVAILABLE`/`RECOVERY_REQUIRED`; no PID/Event reconstruction or respawn |
| Rendezvous removal | `StageExecutionCoordinator` finalization Promise | identity-checked `finally` deletion only after writers, Adapter decision, Session reconciliation and final Deferred settlement; loser cannot remove a replacement |
| Capture interruption latch | `LiveAttemptRendezvous.captureStop` | one-shot Stage-local latch; stop owner resolves it before Adapter graceful/Process cleanup; no Driver API or `node-driver.ts` change |
| Explicit stream iterator drain | `StageExecutionCoordinator` drain helpers | `iterator.next()` races `captureStop`; `iterator.return?.()` is best effort and never awaited; no pending `next()`/EOF gates stop finalization; one in-flight append may quiesce and no later append starts |
| Drain task ownership | `LiveAttemptRendezvous` stdout/stderr drain tasks | natural path runs both drains plus `waitExit` in parallel; finalizer awaits task quiescence, not native EOF after stop |
| Attempt finalization latch | `StageExecutionCoordinator.finalizeAttemptOnce` / `AttemptFinalizationGate` | first contender with durable authority installs `entry.finalizationPromise ??= performFinalization(entry, disposition)`; all other contenders join; durable stop/terminal evidence decides precedence |
| Finalization body | `StageExecutionCoordinator.performFinalization` private helper | exactly one body owns parser tail, writer terminal actions, Adapter finalization decision, Session terminal reconciliation and final Deferred settlement |
| Natural `runToFinal` | existing `runToFinal` refactored through the arbiter | submits natural only after native exit, natural drain completion and durable natural Process CAS; stop winner causes join, never `cancelled=false` completion |
| Stage internal cancel | `StageExecutionCoordinator.cancelAttempt` | exact workspace/run/stage/stageAttempt; no Run/Stage mutation |
| Timeout finalization | `ProcessTimers` -> `ProcessCancelCoordinator` | same attempt arbiter in P5C; first accepted stop reason prevents false Provider completion |
| P4 LOW compensation | `StageExecutionCoordinator.execute` activation-CAS failure path | same stop ticket and same attempt arbiter; runToFinal loser joins one result |
| Output finalize/abort | existing `DurableOutputWriter.finalize` / `abort` | proven/natural paths finalize once; uncertain path aborts each writer and never waits unboundedly |
| Adapter finalization | existing `RuntimeProviderAdapter.finalize` | exactly one arbiter-owned call with `cancelled=false` or `true` as evidence permits |
| Session finalization | existing `DurableSessionRepository.casSessionTransition` | exactly one arbiter-owned CAS/result reconciliation; terminal loser reads persisted Session; cancelled only with proven cleanup; failed on uncertainty |
| Stage stop outcome | `StageExecutionCoordinator` `StageExecutionOutcome` | explicit non-lifecycle `{kind:'stopped',cleanup,proven,stopOrigin}` for explicit cancel and unproven timeout; canonical lifecycle remains untouched |
| Dispatcher stop consumption | `RunEngineProviderDispatcher.ts` | P5A-only narrow consumer; `stopped` breaks/returns with zero Stage/Run/LTS mutation |
| MockDriver proof behavior | `testing/mock-driver.ts` | explicit valid-proof and bare-complete negative modes |
| Timeout origin mapping | `StageExecutionCoordinator` / P5C integration | explicit cancel, startup/idle/total timeout and P4 activation failure have distinct proven/unproven Stage outcomes; timeout uses Provider failure finalization, never user-cancel success |
| Stray proof audit | `durable-coordinator.ts` `#terminateStray` | compensation-only cleanup cannot satisfy E04 or create successful cancellation evidence; verification, when consumed, uses the shared normalizer |

No P5A row may be implemented through a module-global map, PID lookup, Event
history scan for ownership, public route, OperationService, `index.ts`, or a
second Process Runtime.

`apps/server/src/services/run-engine/RunEngineProviderDispatcher.ts` is an
explicitly allowed P5A server file only for consuming the internal `stopped`
outcome and returning without canonical lifecycle mutation. `RunEngine.ts`
remains forbidden and is not an alternate finalization owner.

## 9.2 Code-level responsibility map (P5D)

| Responsibility | Existing symbol to extend / new symbol | Exact owner and boundary |
|---|---|---|
| TaskRunService application seam | `TaskRunService` active cancel method | queued/no-Process keeps M3 path; active calls injected internal port outside DB transaction |
| canonical route injection | `canonicalRuns.ts` route factory option | inject accepted composition port; absent active authority returns stable fail-closed error |
| v2 route injection | `v2Runs.ts` route factory option | same port and same DurableProcessCoordinator; no singleton |
| Operation two-phase active cancel | `OperationService.cancelWithinTransaction` split into validation/runtime/revalidation | runtime stop outside SQLite transaction; final Operation/LTS commit only after proof |
| operations route | `routes/operations.ts` | delegates to OperationService; no direct lifecycle mutation |
| LTS successful hand-off | existing `cancelRunWithinTransaction` / `resolveApprovalToCancellation` call sites | active success requires proven non-empty terminatedProcessIds; queued zero-ID exception only |
| waiting_approval composite | existing `resolveApprovalToCancellation` | P5D invokes after Process proof; ordering is approval.resolved -> stage.cancelled -> run.cancelled |
| Conversation disconnect | `routes/conversations.ts` | close only unsubscribes; no abort on disconnect |
| explicit Conversation cancel | `RunStreamRegistry` only if required | explicit cancel remains distinct and routes to canonical authority |
| accepted composition | `createProviderExecutionChain` + route factory options | same StageExecutionCoordinator/DurableProcessCoordinator; `index.ts` default cutover forbidden |

No P5D row is UNKNOWN, TBD, or selected during implementation.

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
- any production caller maps `classification='complete'` without
  `cleanupVerdictFromVerification` proof validation;
- `manager.ts`, `durable-coordinator.ts`, or `process-cancel-coordinator.ts`
  contains a direct `classification === 'complete'` terminal branch;
- active cleanup returns an empty `terminatedProcessIds` as successful;
- OperationService uses the legacy active empty-ID LTS path;
- public active routes activate before P5D or without an injected authority;
- a second spawn, second Run state machine, or second terminal Event appears;
- `complete` tree result is produced without survivor enumeration;
- browser/SSE close can still terminate canonical execution;
- idle suspension is wired without M3 `waiting_approval` evidence;
- POSIX `PLATFORM_GATE_BLOCKED` is treated as PASS or a silent skip;
- P5B evidence silently changes the selected Windows inspection facility,
  parses `CreationDate` nondeterministically, or guesses identity when
  `ExecutablePath` is null/access-denied/incomplete;
- P5C observes approval through HTTP/SSE, polling, an unverified cursor, a
  missing `stage.started` attempt anchor, or a missing failure callback;
- timeout or cancel marks Provider success;
- natural exit, cancel, timeout or P4 compensation can execute more than one
  Provider/output/Session finalizer for one attempt;
- a spawned Process can exist after `created -> starting` without a same-instance
  live rendezvous, or a `joinedExisting` execution creates/replaces an entry;
- entry removal can occur before writer/Adapter/Session/Deferred terminal work
  settles, or a loser can delete a replacement entry;
- drain correctness depends on native EOF, an unresolved `iterator.next()` or
  an awaited `iterator.return()` after `captureStop` wins;
- a stop producer, ProcessCancelCoordinator or finalizer waits in a cycle on
  drain/finalization/Stage Deferred promises;
- a stop ticket accepted before natural terminal Process evidence is later
  reinterpreted as Provider completion from `exitCode=0`;
- a terminal Session CAS loser resolves its own desired local outcome instead
  of reading/joining the persisted terminal state;
- an internal `stopped` outcome is mapped by Dispatcher to Stage/Run failed,
  completed or cancelled, or `RunEngine.ts` becomes a second owner;
- proven timeout is represented as user-cancelled Provider success, or
  unproven timeout terminalizes the canonical Stage;
- uncertain cleanup waits unboundedly or calls writer `finalize()` instead of
  the existing safe `DurableOutputWriter.abort()` path;
- `#terminateStray` promotes a bare `terminateTree().classification` to E04,
  Process, Session or canonical cancellation proof;
- `LifecycleTransactionService` is bypassed for a canonical terminal;
- Adapter spawns/kills/mutates lifecycle;
- raw secret/stderr/env leaks into Events/logs/ApiProblem;
- M3 lifecycle/Event/Outbox/idempotency/replay/Legacy regression appears;
- a test passes only by rerun, sleep inflation or weakened assertion;
- BLOCKER/HIGH independent finding remains open;
- P5 expands into public active command activation before P5D, pause/resume,
  orphan destruction, M7 recovery, M5 process
  migration, Legacy retirement, cutover, P6 recovery classification, or
  P6-owned server shutdown wiring (`index.ts` shutdown enumeration/ordering).

## 14. Rollback boundaries

- P5A: revert internal cancel/proof/correlation additions; public command
  routes remain unchanged; Process facts preserved; no P5A-only deployment
  may report successful cancellation from a bare `complete`.
- P5B: revert driver tree internals; P5A semantics unchanged.
- P5C: revert timeout propagation; P5A/B unchanged.
- P5C observation composition: revert the narrow event-observation injection and `providerExecutionChain.ts` adapter; existing RunStreamService and transport ownership remain unchanged.
- P5D: revert public command/Operation/Conversation activation; no durable loss.
- P5E: evidence/tests only.
- P5F: closeout docs only.

Production Restore, data deletion, force cleanup and Legacy retirement are not
rollback mechanisms authorized here.

## 15. Authorization status

```text
M4-P5 PRE-IMPLEMENTATION PLANNING:
FIFTH NARROW DOCS-ONLY REMEDIATION / PENDING FRESH INDEPENDENT PLAN REVIEW

Independent Plan Review (latest):
NOT ACCEPTED — the prior review found HIGH-A..D, MEDIUM-A..B and LOW; the next
review found HIGH-E (dual finalizer race), HIGH-F1 (rendezvous lifecycle/wait
protocol), HIGH-F2 (stream interruption), MEDIUM-F1 (timeout outcome mapping)
and LOW-F1 (`#terminateStray` audit). This fifth narrow docs-only remediation
freezes one proof normalizer, exact no-proof durable semantics, the internal
P5A/public P5D split, claim-correlation ports, Operation two-phase
cancellation, the P5C attempt-anchor/failure-callback contract, exact live
entry registration/removal, a non-circular AsyncIterator capture protocol,
reason-specific timeout outcomes, and the shared Stage-attempt finalization
arbiter with an explicit internal stopped outcome. A fresh independent plan
review is still required.

M4-P5 PRODUCTION IMPLEMENTATION:
NOT AUTHORIZED

M4-P5 PLANNING COMMITS:
943b383b (original planning) -> d9ed0d0a (first remediation) -> a3a4c422
(second remediation) -> 501970c8 (third remediation) -> 0d46ab39 (fourth
remediation) -> THIS fifth narrow remediation commit (ordinary forward docs
commit on docs/m4-p5-planning; no amend/rebase/squash)

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
