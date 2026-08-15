# AgentOS M4-P5 Cancellation, Process Tree, Timeout and Transport — Owner Decision Register

Status: M4-P5 PRE-IMPLEMENTATION PLANNING — ALL P5 DECISIONS RESOLVED AS TECHNICAL DECISIONS — 0 USER OWNER DECISIONS — NO PRODUCTION AUTHORIZATION

## 1. Classification rule (inherited from M4 register §2)

A `USER OWNER DECISION` is raised only for irreversible schema/data behavior,
user-visible product semantics with genuine alternatives, compatibility removal,
security/auth policy beyond a fail-closed technical default, external cost, or
production cutover/default switch.

Every M4-P5 decision below is resolved from repository evidence, the frozen P0
contracts and safety invariants, so each is a **TECHNICAL DECISION** frozen by
this planning package. The Owner is not asked to choose class names, platform
libraries, signal order or retry mechanics. If implementation evidence later
surfaces an irreversible schema choice, a destructive cleanup policy, or a
user-visible semantic alternative, the phase must STOP and raise a new
`OD-M4-XX` per M4 register §7.

```text
USER OWNER DECISIONS REQUIRED BEFORE M4-P5 IMPLEMENTATION = 0
TECHNICAL DECISIONS FROZEN IN THIS PACKAGE               = 18
```

## 2. Decision register

### OD-M4-P5-01 — Cancel authority owner

| Field | Value |
|---|---|
| Decision | A new `ProcessCancelCoordinator` (package `process-runtime`, orchestrated by the Stage execution seam) owns the single cancel pipeline: correlate active Session/Process -> accept durable stop ticket -> Adapter-native graceful (ticket-gated) -> bounded platform graceful -> grace deadline -> force tree termination -> survivor verification -> Process facts -> Provider finalize -> hand a typed cleanup result to `LifecycleTransactionService`. The existing `TaskRunService`/`OperationService` command boundary accepts the command; it does not own the tree. |
| Evidence | P0 §13 chain; M4 plan §12; current `StageExecutionCoordinator` has no cancel entry and `LifecycleTransactionService.cancelRunWithinTransaction` already carries `terminatedProcessIds` (the intended hand-off seam). |
| Alternatives rejected | (a) route-owned tree kill — violates E01/E02 and the frozen authority chain; (b) Adapter-owned tree stop — Adapter cannot force/kill (P0 §10); (c) `TaskRunService`-owned pipeline — would place OS process logic outside the Process Runtime boundary. |
| Contract consequence | One cancel command -> one accepted stop ticket -> one terminal Process fact -> one `LifecycleTransactionService` terminal transition. No second Run state machine. |
| Tests required | Cancel propagation spy (route -> coordinator -> stop ticket -> driver call count 1); duplicate/parallel cancel convergence; approval-wait cancellation. |

### OD-M4-P5-02 — Graceful-stop owner

| Field | Value |
|---|---|
| Decision | `ProcessManager`/durable coordinator owns bounded platform graceful stop; `RuntimeProviderAdapter.cancel` may request a Provider-native interrupt only through the accepted stop ticket (P0 §10 `ProviderProcessPort.requestGraceful`). Adapter absence, crash or failure never blocks platform graceful/force progression. |
| Evidence | P0 §13: "The coordinator waits for the Adapter-native request only within the already persisted stop ticket's grace deadline… ProcessManager never invokes Provider code." |
| Alternatives rejected | Adapter-native graceful as the sole stop — P0 requires platform force to always proceed. |
| Contract consequence | Graceful is best-effort; force is guaranteed-progression. |
| Tests required | Adapter graceful fails/never-returns -> force still runs; graceful succeeds before deadline -> no force. |

### OD-M4-P5-03 — Grace interval policy source

| Field | Value |
|---|---|
| Decision | The frozen grace deadline is the Provider Configuration snapshot `timeoutPolicy.cancelGracePeriodMs`, already propagated as the Process `timeoutPolicy.graceMs` (`StageExecutionCoordinator.ts:224`). No second grace source exists. |
| Evidence | Snapshot freezes timeout policy (`SnapshotService`); coordinator already maps `cancelGracePeriodMs -> graceMs`. |
| Alternatives rejected | A server-wide constant grace — would ignore per-config policy; a provider-negotiated deadline — Adapter must not extend the frozen deadline (P0 §13). |
| Contract consequence | Grace is per-Process, durably recorded with `process.stopping` (deadline), observable via injected clock. |
| Tests required | Grace deadline honored with fake clock; snapshot policy change changes the deadline. |

### OD-M4-P5-04 — Process-tree platform ownership strategy

| Field | Value |
|---|---|
| Decision | Windows: one Job Object per managed root with kill-on-close, assigned at spawn; assignment/nested-job failure emits a warning, marks reduced cancellation reliability, and switches to the bounded fallback (`taskkill /PID <pid> /T /F`) — never silent `child.kill()`. POSIX: create an owned process group/session; TERM the group; grace; KILL the group. Survivor verification runs after force on both platforms. |
| Evidence | P0 §9 (Windows prefers Job Object, POSIX creates owned group); spec §§40–42. |
| Alternatives rejected | `child.kill()` only (CS-08 — guessed success); `taskkill` only (no kill-on-close, weaker race handling). |
| Contract consequence | `terminateTree` returns method, attempted members and errors; `verifySurvivors` returns complete/survivors/unknown; `cleanupResultFrom` maps to the frozen five-value vocabulary. |
| Tests required | Windows `.exe`, `.cmd`, path spaces/Unicode, Job Object path, fallback path, nested-job; POSIX group TERM/KILL, group escape. |

### OD-M4-P5-05 — Windows Job Object assignment and fallback

| Field | Value |
|---|---|
| Decision | Assignment occurs in `Driver.spawn` before the child runs application code (Windows `CREATE_SUSPENDED` -> assign -> resume) when the platform capability is available. Assignment failure (nested job, access denied, API unavailable) is observable (`treeMode: 'job' | 'fallback'`), records a warning, and the fallback path handles force/survivor verification. |
| Evidence | Spec §40.3 (assignment failure -> warning + fallback + reduced reliability marker), §40.4 (nested-job detection). |
| Alternatives rejected | Assign-after-spawn (child may escape the tree before assignment); fallback-only (loses kill-on-close). |
| Contract consequence | `NativeIdentity` gains `treeMode`/`jobHandleId` restricted metadata; no native handle is ever persisted. |
| Tests required | Assignment success/failure/denied/nested; kill-on-close proof; fallback parity where feasible. |

### OD-M4-P5-06 — Survivor verification definition

| Field | Value |
|---|---|
| Decision | `verifySurvivors` enumerates the owned tree (Job members / process group membership plus known descendants) and classifies `complete` (root and all known + newly discovered members absent), `survivors` (any member alive), or `unknown` (inspection unavailable/insufficient). A root exit alone is never `complete`. |
| Evidence | P0 §9 survivor verification capability; CS-09 currently returns `complete` on root exit — the contract violation P5 closes. |
| Alternatives rejected | Root-exit-as-tree-proof (P0 explicitly forbids: "Child exit is not tree proof"); PID liveness as tree proof. |
| Contract consequence | A successful cancel requires `complete`; `survivors`/`unknown` -> `SURVIVORS`/`UNKNOWN_PLATFORM_UNAVAILABLE` cleanup result and `orphaned` Process state, never a successful-cancel terminal. |
| Tests required | No-survivor, known survivor, disappearing survivor on recheck, inaccessible process, unknown inspection. |

### OD-M4-P5-07 — Natural-exit vs cancel precedence

| Field | Value |
|---|---|
| Decision | Observed native exit wins the terminal CAS if it commits first; otherwise the accepted stop reason is retained while exit/tree evidence finalizes the Process. Duplicate close/exit observations return the existing terminal result. |
| Evidence | P0 §7 race rules ("exit vs cancel or timeout: observed exit wins terminal CAS if first; otherwise stop reason is retained"). |
| Alternatives rejected | Cancel always overriding exit (would mislabel naturally-finished work); exit always overriding cancel (would drop cancel causation). |
| Contract consequence | One terminal fact; `terminationReason`/`cancelCausation` recorded; no duplicate terminal Event. |
| Tests required | exit-vs-cancel race at every boundary (RACE schedule reuse). |

### OD-M4-P5-08 — Timeout vs cancel precedence

| Field | Value |
|---|---|
| Decision | First accepted stop reason owns the `stopping` transition; later reasons are correlated diagnostics, never terminal overwrites. |
| Evidence | P0 §7 ("timeout vs cancel: first accepted stop reason owns the transition"). |
| Alternatives rejected | Timeout overriding cancel and vice versa. |
| Contract consequence | One `process.stopping` fact with one reason; one terminal fact. |
| Tests required | timeout-vs-cancel deterministic race with injected clock. |

### OD-M4-P5-09 — Timeout vs natural exit precedence

| Field | Value |
|---|---|
| Decision | Same single-terminal-CAS rule: whichever observation commits first wins; the other becomes retained evidence. |
| Evidence | P0 §7 race rules; CS-11 durable CAS. |
| Contract consequence | Exactly one terminal Process fact per Process. |
| Tests required | exit-vs-startup/idle/total timeout races. |

### OD-M4-P5-10 — Session state during cancellation

| Field | Value |
|---|---|
| Decision | A Session stays `starting`/`active` while its Process stop is accepted and running; it finalizes as `cancelled` only after the Process cleanup result proves termination with no survivors (or `failed` when finalization/cancellation fails). `provider.session_cancelled` is emitted only after the P3 event/spec reconciliation gate closes (P0 event-error contract marks it `SPEC_RECONCILIATION_REQUIRED`). |
| Evidence | P0 §5 Session identity; event-error contract §2 (`provider.session_cancelled` exactly-once successful cancellation finalization); CS-04 no production path today. |
| Alternatives rejected | Marking Session `cancelled` before Process tree proof (violates frozen causal chain: `process.stopping -> process.exited|cleanup_required -> provider.session_cancelled`). |
| Contract consequence | Session terminal always follows the Process cleanup fact; `provider.session_failed` is used when cancellation/finalization fails. |
| Tests required | Session stays non-terminal during stop; terminal mapping after complete/survivor outcomes. |

### OD-M4-P5-11 — Process state during cancellation

| Field | Value |
|---|---|
| Decision | The Process is `stopping` from the accepted stop through cleanup; it terminalizes `exited` only when tree verification is `complete` (with `TERMINATED`/`ALREADY_EXITED` cleanup result), and `orphaned` on `SURVIVORS`/`IDENTITY_MISMATCH`/`UNKNOWN_PLATFORM_UNAVAILABLE`. `failed` remains reserved for pre-managed-running failure (including cancellation-before-spawn and late spawn failure). |
| Evidence | P0 §7 state machine and terminal rules; M4 plan §7 P5 "no owned survivors after successful cancel". |
| Alternatives rejected | Terminalizing `exited` from a live/unknown tree; treating `orphaned` as successful cancel. |
| Contract consequence | Cancellation is successful only when the frozen contract result is met. |
| Tests required | stopping -> exited (verified), stopping -> orphaned (survivor/unknown), cancelled-before-spawn -> failed. |

### OD-M4-P5-12 — Failure classification when survivors remain

| Field | Value |
|---|---|
| Decision | Survivors or unverifiable cleanup -> Process `orphaned` with `cleanup_required` evidence and `SURVIVORS`/`UNKNOWN_PLATFORM_UNAVAILABLE`; `runs.recovery_required` is set/preserved through the existing M3 seam because lifecycle outcome cannot be proven. Cancellation is not reported successful. |
| Evidence | P0 §13 ("Known or unknown survivors mean cancellation is not successful, produce cleanup-required evidence, and preserve Run uncertainty"); P0 §15 minimum recovery contract. |
| Alternatives rejected | Declaring cancel success despite survivors (forbidden by P0); silent uncertainty without evidence. |
| Contract consequence | Survivor list/count and classification are durable restricted facts; canonical Run terminal waits on P6 recovery classification when cleanup is unproven. |
| Tests required | known-survivor failure; unknown-inspection failure; no false successful-cancel assertion. |

### OD-M4-P5-13 — Duplicate cancellation convergence

| Field | Value |
|---|---|
| Decision | Duplicate and simultaneous cancel commands join the first accepted stop ticket (single `idempotencyKey`/reason winner); no second ticket, no duplicate terminal Event, no second spawn. |
| Evidence | P0 §13 ("Repeated cancel joins the first stop and emits no duplicate terminal Event"); `ProcessManager.stop` ticket registry (CS-05). |
| Alternatives rejected | Last-writer-wins cancel; per-request independent stops. |
| Contract consequence | One accepted stop, one cleanup, one terminal fact per Process. |
| Tests required | Same-key duplicate, different-key duplicate, concurrent duplicate, cancel-after-terminal. |

### OD-M4-P5-14 — Approval-wait idle suspension

| Field | Value |
|---|---|
| Decision | Idle-timer suspension during `waiting` is allowed only when the canonical M3 Stage/Run is in `waiting_approval` (proven by `m3-lifecycle-transition-contracts.ts:72` and the `waiting` Process state + `pauseIdle`). The durable path calls `enterWaiting` only on the M3 `waiting_approval` transition; no idle suspension is invented for any other state. |
| Evidence | M3 transition contracts (`stage running -> waiting_approval`); spec §31.1 (waiting_approval excludes idle); M4 plan P5 scope wording "approval-wait idle suspension only where existing M3 state proves it". |
| Alternatives rejected | Suspending idle on any `waiting`-like state without M3 evidence; inventing a second approval state. |
| Contract consequence | Idle deadline pauses only during proven M3 approval wait; total and startup deadlines are unaffected. |
| Tests required | waiting_approval pauses idle; non-approval waiting cannot be entered from the durable path; resume restores remaining budget. |

### OD-M4-P5-15 — Transport disconnect ownership

| Field | Value |
|---|---|
| Decision | HTTP/SSE disconnect releases subscriber resources and cursors only. The Conversation initial-message `res.close` handler stops calling `abortController.abort()`; the AbortController is retained only for an explicit cancel command. Explicit `POST /runs/:runId/cancel` (canonical) and the Conversation cancel route (legacy projection) are the only termination commands. |
| Evidence | E08 frozen gate; `02-Runtime-Lifecycle.md:2382-2428` (subscription only) and `2670` (SSE disconnect does not cancel); CS-18 is the one FAIL path. |
| Alternatives rejected | Keeping abort-on-close and adding an exception (would keep transport ownership of execution); making disconnect trigger a delayed cancel. |
| Contract consequence | Browser owns subscription only; disconnect never mutates Run/Operation/Process; explicit cancel is demonstrably a different command. |
| Tests required | HTTP disconnect continues execution; SSE disconnect continues execution; explicit cancel terminates tree; reconnect resumes cursor. |

### OD-M4-P5-16 — P4 active-CAS-after-spawn cleanup disposition

| Field | Value |
|---|---|
| Decision | **REQUIRED_P5_CLOSURE.** When Session activation CAS fails after a successful spawn, the spawned Process is not left orphaned-active: the coordinator issues the P5 stop pipeline (graceful -> grace -> force tree -> survivor verification) with a startup/activation stop reason, the Process terminalizes `exited` (verified clean, cleanup result recorded) or `orphaned` (unverified), the Session terminalizes `failed` with `PROVIDER_SESSION_FAILED`/`PROVIDER_START_FAILED`, and the caller outcome remains fail-closed. Cleanup runs once via the idempotent stop ticket; duplicate cleanup is prevented by the single-ticket rule. If cleanup is uncertain, the Process stays non-terminal with cleanup evidence for P6 classification. |
| Evidence | Section 4 of `M4-p5-current-state-audit.md` reproduces the residual; P5's own contract (cancel while Session starting, survivor-before-terminal) naturally owns a spawned-but-unactivated Process. The residual is not a P4 bug; it is P5 startup compensation scope. |
| Alternatives rejected | (a) Treating it as a P4 contract violation (no violation exists — caller fails closed); (b) P6_RECOVERY_OWNED (the process is not a restart case; it is an in-flight start that P5's own tree contract governs); (c) silent omission (forbidden). |
| Contract consequence | Every successfully spawned root receives an explicit tree-cleanup result before the Stage attempt terminal; no spawned child survives a failed activation. |
| Tests required | Active-CAS-failure schedule: spawn succeeds -> activation CAS fails -> graceful/force/verify runs once -> Process exited/orphaned, Session failed, exactly one terminal Process fact, no second spawn. |

### OD-M4-P5-17 — Shutdown interaction

| Field | Value |
|---|---|
| Decision | P5 defines the stop side only: server shutdown enumerates active Process records and issues the stop pipeline with a stable shutdown reason (reusing the frozen stop pipeline and `process.stopping`/terminal facts); it never kills silently and never guesses. Shutdown-mode recording, startup classification and `recovery_required` folds are P6 scope (M4 plan §7 P6 "shutdown mode recording as technically necessary"). |
| Evidence | CS-22 (current shutdown does not enumerate provider processes); M4 plan §7 P6 owns shutdown-mode recording; spec §72 shutdown modes. |
| Alternatives rejected | No shutdown stop (active processes would leak); P5 owning recovery classification (P6 owns it). |
| Contract consequence | On shutdown each active Process gets a durable stop reason + terminal/uncertainty fact; P6 classifies afterwards. |
| Tests required | Shutdown with active/stopping/starting Process; stop count 1 each; facts durable; no guessed success. |

### OD-M4-P5-18 — Event/fact vocabulary reuse

| Field | Value |
|---|---|
| Decision | P5 reuses the frozen Process fact vocabulary (`process.launch_requested`, `process.started`, `process.stopping`, `process.exited`, `process.failed`) and the frozen cleanup-result vocabulary. `process.cleanup_required`, `process.orphaned`, `process.recovered` and `provider.session_cancelled` may be emitted only after the owning reconciliation gates (P0 event-error contract `SPEC_RECONCILIATION_REQUIRED` list; `process.cleanup_required`/`process.orphaned` also require Registry expansion review). No new P5-specific Event type is proposed. |
| Evidence | P0 event-error contract §1/§2 lists each draft and its reconciliation marker; M4 plan §7 P5 "M3 status vocabulary remains". |
| Alternatives rejected | New ad-hoc cancel Event types; reusing `process.exited` for survivors. |
| Contract consequence | Every P5 fact rides the accepted M3 Event/Outbox envelope; unknown-Event handling stays forward-compatible. |
| Tests required | Event/Outbox 1:1 for stop/terminal facts; replay idempotency; no duplicate terminal Event. |

## 3. Decision conclusion

```text
CURRENT M4-P5 OWNER DECISION COUNT            = 0 (USER)
CURRENT M4-P5 TECHNICAL DECISION COUNT        = 18 (ALL RESOLVED)

BLOCKING UNRESOLVED DECISIONS                 = 0

P4 LOW RESIDUAL DISPOSITION                   = REQUIRED_P5_CLOSURE (OD-M4-P5-16)

REQUIRED BEFORE M4-P5 IMPLEMENTATION ENTRY    = separate explicit P5 authorization
                                                naming exact base/files/owner/tests,
                                                plus independent plan review BLOCKER/HIGH 0

M4-P5 PRODUCTION IMPLEMENTATION               = NOT AUTHORIZED
P6                                              = MUST NOT START
M4 MILESTONE                                    = NOT COMPLETE (P5-P11 remain)
```
