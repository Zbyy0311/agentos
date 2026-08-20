# AgentOS M4-P5 Cancellation, Process Tree, Timeout and Transport — Owner Decision Register

Status: M4-P5 PRE-IMPLEMENTATION PLANNING — SECOND DOCS-ONLY REMEDIATION (FRESH REVIEW PENDING) — ALL P5 DECISIONS RESOLVED AS TECHNICAL DECISIONS — 0 USER OWNER DECISIONS — NO PRODUCTION AUTHORIZATION

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
TECHNICAL DECISIONS FROZEN IN THIS PACKAGE               = 20
```

## 2. Decision register

### OD-M4-P5-01 — Cancel authority owner (two-layer)

| Field | Value |
|---|---|
| Decision | Cancellation is owned by TWO distinct layers with one frozen hand-off. **A. SERVER / STAGE ORCHESTRATION** (apps/server; P5A owner: the existing `StageExecutionCoordinator` cancel entry — no additional server service is introduced): accept/correlate cancellation for the Stage attempt; resolve the Provider Session + paired root Process; ensure the durable Process stop ticket is accepted by the Process Runtime; request `RuntimeProviderAdapter.cancel` / the Provider-native graceful request ONLY through the constrained `ProviderProcessPort` and ONLY after the stop ticket is accepted (within its grace window); invoke Provider finalization after Process cleanup evidence; invoke `LifecycleTransactionService` with the typed cleanup outcome; own no OS tree mechanics. The existing `TaskRunService`/`OperationService` command boundary accepts the command; it does not own the tree. **B. PROCESS RUNTIME** (packages/process-runtime; P5A owner: a new `ProcessCancelCoordinator` at `packages/process-runtime/src/process-cancel-coordinator.ts`, defined PROCESS-SIDE ONLY): durable/idempotent Process stop ticket (`process.stopping` + deadlines); Process state transitions; platform graceful operation; grace deadline; force tree termination; survivor verification; Process cleanup/termination facts; returns a Provider-neutral typed cleanup result upward. It MUST NOT import agent-core/provider adapters, call `RuntimeProviderAdapter`, parse Provider semantics, Provider-finalize a Session, call `LifecycleTransactionService`, or mutate Run/Stage lifecycle. |
| Evidence | P0 §2/§3/§8/§13 (the §8 stop row closes with "ProcessManager receives no Provider callback/parser and Provider-native graceful coordination remains outside it"; §13 sequences the Adapter-native request at the Stage coordinator); M4 plan §12; workspace dependency direction `@agentos/agent-core -> @agentos/process-runtime` (a reverse import would be circular and is architecture-negative); `LifecycleTransactionService.cancelRunWithinTransaction` already carries `terminatedProcessIds` (the hand-off seam). |
| Alternatives rejected | (a) `ProcessCancelCoordinator` in process-runtime owning Adapter graceful/finalize/LifecycleTransactionService hand-off — violates P0 §8's final clause, P0 §6 ("RunEngine invokes LifecycleTransactionService") and frozen rule 7 (Process Runtime remains Provider-agnostic); (b) route-owned tree kill — violates E01/E02 and the frozen authority chain; (c) Adapter-owned tree stop — Adapter cannot force/kill (P0 §10); (d) `TaskRunService`-owned platform pipeline — would place OS process logic outside the Process Runtime boundary. |
| Contract consequence | One cancel command -> one accepted stop ticket -> one terminal Process fact -> one `LifecycleTransactionService` terminal transition. The Process Runtime component returns facts/outcomes only and never crosses upward. No second Run state machine. |
| Tests required | Cancel propagation spy (route -> server orchestration -> stop ticket -> driver call count 1); duplicate/parallel cancel convergence; approval-wait cancellation via the M3 composite (OD-M4-P5-19); architecture-negative: `packages/process-runtime` imports no agent-core/provider module. |

### OD-M4-P5-02 — Graceful-stop owner

| Field | Value |
|---|---|
| Decision | The Process Runtime (`ProcessCancelCoordinator`, PROCESS-SIDE ONLY per OD-M4-P5-01) owns bounded platform graceful stop; the SERVER/STAGE orchestration calls `RuntimeProviderAdapter.cancel` for the Provider-native graceful request only through the constrained `ProviderProcessPort` and only after the durable stop ticket is accepted (P0 §10 `requestGraceful`). Adapter absence, crash or failure never blocks platform graceful/force progression. |
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
| Decision | **Windows:** Job Object support becomes an OPTIONAL FUTURE CAPABILITY SLOT, not a mandatory P5 implementation requirement. The currently authorized Windows implementation is the observable bounded fallback: `shell=false` launch; retained root native identity; bounded descendant enumeration via a CIM-equivalent inspection mechanism selected during P5B from already authorized OS facilities (separated arguments, no shell string concatenation, no frozen raw command string in this document); identity fencing of root and descendants using available start-time/executable evidence before any destructive signal; safely parameterized `taskkill /PID <owned-root-pid> /T /F` constrained to the owned root subtree; re-enumeration/survivor verification after force; classification `complete`/`survivors`/`unknown`; success is NEVER inferred from `taskkill` exit status alone; observable `treeMode='fallback'` with a reduced-reliability internal diagnostic that leaks no secrets. Real Job Object integration (`CREATE_SUSPENDED` -> assign -> resume -> `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` -> job-membership survivor proof) requires a future separate technical/dependency authorization (native addon, FFI or helper mechanism); P5 introduces none. **POSIX:** the driver creates one owned process group/session per root (mechanism frozen in OD-M4-P5-05), signals TERM to the group, waits the frozen grace deadline, then KILLs the group; survivor verification enumerates group membership plus known/newly discovered descendants; group identity/start evidence is revalidated before every `-PGID` signal; insufficient identity -> no signal, fail closed. On both platforms a root exit alone is never `complete` (OD-M4-P5-06). |
| Evidence | P0 §9 ("Windows prefers one Job Object ... when feasible. Assignment failure ... is observable and switches to a bounded fallback ... it never silently degrades to `child.kill()`"; "POSIX creates an owned process group/session and signals that group"); spec §40.1/§40.3/§42.2 (Job best-effort, fallback `taskkill /PID <pid> /T /F`) and §45 (owned group); Independent Plan Review HIGH-2: standard Node `child_process` exposes no creation flags, Job APIs or job-member enumeration; the repository contains no native addon/FFI/helper capability and P5B's allowlist has no dependency slot. |
| Alternatives rejected | `child.kill()` only (CS-08 — guessed success); `taskkill` without enumeration/fencing (cannot prove survivors or fence PID reuse); adding a native/FFI dependency inside P5 (unauthorized — a new dependency/infrastructure commitment would require its own authorization, and none is introduced by this remediation); keeping Job Object as a mandatory Windows gate (not implementable in the authorized scope). |
| Contract consequence | `terminateTree` returns method, attempted members and errors; `verifySurvivors` returns `complete`/`survivors`/`unknown`; `cleanupResultFrom` maps to the frozen five-value vocabulary. The REQUIRED Windows acceptance gate is the fallback owned-tree proof (WIN-06); the Job path (WIN-05) is OPTIONAL_CAPABILITY/ENV-GATED evidence only and is not required for base P5 acceptance as long as the fallback proves E04 completely. Job Object remains recorded as the future preferred capability; it is not deleted. |
| Tests required | Windows fallback proof: `.exe`, `.cmd` validated wrapper, path spaces/Unicode, child/grandchild, survivor, access-denied, already-exited, PID-reuse mismatch, taskkill-exit-not-proof, observable `treeMode='fallback'`; POSIX: group TERM/grace/KILL, group escape, survivor verification, zombie reap; Job capability recording (WIN-05, optional). |

### OD-M4-P5-05 — Windows Job capability slot, fallback and POSIX group mechanism

| Field | Value |
|---|---|
| Decision | **Windows capability:** `NodeProcessDriver` determines Job Object capability through a bounded capability check. With the current Node/package authorization the native Job APIs (`CREATE_SUSPENDED`, `CreateJobObject`/`SetInformationJobObject`/`AssignProcessToJobObject`/`ResumeThread`, job-member enumeration) are unavailable, so the driver records the capability as unavailable, emits the observable `treeMode='fallback'`, a warning and a reduced-reliability marker, and runs the frozen bounded fallback (OD-M4-P5-04). If a separately authorized Job implementation is ever introduced, assignment occurs in `Driver.spawn` before the child runs application code (suspend -> assign -> resume), assignment failure (nested job, access denied, API unavailable) stays observable, and nested-job detection adopts a compatible strategy or falls back. `NativeIdentity` carries `treeMode`/`jobHandleId` as restricted metadata only when that capability exists; no native handle is ever persisted. **POSIX mechanism freeze:** `NodeProcessDriver` may internally pass `detached: true` to `node:child_process.spawn` on POSIX ONLY, solely as the Node mechanism for creating a new owned process group/session (spec §45 recommends `detached = true` or equivalent `setsid()`). Invariants: caller-facing `LaunchRequest.detached` remains forbidden (launch validation denies it); stdio remains piped/owned; the `ChildProcess` handle remains retained; `child.unref()` is NEVER called; execution remains AgentOS-owned; the fresh PGID is stored in `NativeIdentity.groupId`; group identity/start evidence is revalidated before `-PGID` TERM/KILL (Linux via `/proc` evidence; macOS/BSD via a bounded ps-equivalent evidence adapter); insufficient identity -> no signal, fail closed. **Why this is compatible with P0 §9 + §16.12:** P0 §9 mandates an owned POSIX process group/session with group-signaled termination; P0 §16.12 denies detached/daemon behavior, i.e. user-requestable, unowned, parent-decoupled execution. The driver-internal flag here only selects the OS group-creation mechanism while every ownership invariant (piped stdio, retained handle, no unref, fenced identity, P6 shutdown stop, recovery classification) remains enforced, and no caller can request detached execution — so no daemon policy is authorized. |
| Evidence | Spec §40.3/§40.4 (assignment failure observable; nested-job detection), §45/§45.1/§45.2 (group creation and group signaling); `packages/process-runtime/src/validation.ts` detached denial; spec §45 explicitly recommending the `detached = true` mechanism; Independent Plan Review HIGH-2 and MEDIUM-1. |
| Alternatives rejected | Assign-after-spawn for a future Job path (child may escape before assignment); caller-facing `detached` (denied by policy); no POSIX group at all (violates P0 §9 — root-PID-only signals); a second native/helper mechanism for group creation (unauthorized; unnecessary — Node's mechanism suffices). |
| Contract consequence | `treeMode` is observable on every managed root; identity/PGID fencing precedes every destructive signal; mismatches block signaling (`IDENTITY_MISMATCH`); no native handle is persisted. |
| Tests required | Assignment/capability recording success/unavailable/nested (as capability evidence); kill-on-close proof only under an authorized Job implementation; fallback parity; POSIX group creation, invariants (stdio piped, handle retained, no unref), PGID capture and reuse fencing. |

### OD-M4-P5-06 — Survivor verification definition

| Field | Value |
|---|---|
| Decision | `verifySurvivors` enumerates the owned tree (Job members / process group membership plus known descendants) and classifies `complete` (root and all known + newly discovered members absent), `survivors` (any member alive), or `unknown` (inspection unavailable/insufficient). A root exit alone is never `complete`. A successful cleanup result requires BOTH `classification='complete'` and an explicit optional proof marker whose semantic meaning is `OWNED_TREE_ENUMERATION_VERIFIED` (represented by the repository-neutral kind `owned-tree-enumeration`); the proof means the platform implementation enumerated the owned root/tree, covered required known/new descendants, and performed post-force verification. Bare `complete` with no proof is `unknown`/unproven and cannot authorize successful cancellation. |
| Evidence | P0 §9 survivor verification capability; CS-09 currently returns `complete` on root exit — the contract violation P5 closes; P5A/P5B phase split requires an explicit proof provenance marker. |
| Alternatives rejected | Root-exit-as-tree-proof (P0 explicitly forbids: "Child exit is not tree proof"); PID liveness as tree proof. |
| Contract consequence | A successful cancel requires `complete`; `survivors`/`unknown` -> `SURVIVORS`/`UNKNOWN_PLATFORM_UNAVAILABLE` cleanup result and `orphaned` Process state, never a successful-cancel terminal. |
| Tests required | No-survivor with valid proof; bare `complete`/empty `knownPids` with no proof -> `UNKNOWN`/unproven and no successful cancel; known survivor, disappearing survivor on recheck, inaccessible process, unknown inspection. |

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
| Decision | A Session stays `starting`/`active` while its Process stop is accepted and running; it finalizes as `cancelled` only after the Process cleanup result proves termination with no survivors (or `failed` when finalization/cancellation fails). `provider.session_cancelled` remains reconciliation-gated and absent from the current Registry (OD-M4-P5-18); no P5 acceptance may depend on it. Successful cancelled-Session durability is proven through `provider_sessions.status='cancelled'` plus the already-authorized existing Session/Process fact vocabulary (`process.session_state_changed` and Process terminal facts). |
| Evidence | P0 §5 Session identity; event-error contract §2 (`provider.session_cancelled` exactly-once successful cancellation finalization); CS-04 no production path today. |
| Alternatives rejected | Marking Session `cancelled` before Process tree proof (violates the frozen causal chain: `process.stopping` -> `process.exited`/`process.cleanup_required` -> durable Session terminal; the gated `provider.session_cancelled` would follow only after its reconciliation gate). |
| Contract consequence | Session terminal always follows the Process cleanup fact; a failed Session is proven by `provider_sessions.status='failed'` plus the existing Session/Process facts when cancellation/finalization fails. |
| Tests required | Session stays non-terminal during stop; terminal mapping after complete/survivor outcomes. |

### OD-M4-P5-11 — Process state during cancellation

| Field | Value |
|---|---|
| Decision | The Process is `stopping` from the accepted stop through cleanup; it terminalizes `exited` only when tree verification is `complete` **with** `owned-tree-enumeration` proof (with `TERMINATED`/`ALREADY_EXITED` cleanup result), and `orphaned` on `SURVIVORS`/`IDENTITY_MISMATCH`/`UNKNOWN_PLATFORM_UNAVAILABLE` or missing proof. `failed` remains reserved for pre-managed-running failure (including cancellation-before-spawn and late spawn failure). |
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

### OD-M4-P5-14 — Approval-wait idle suspension and the P5C integration seam

| Field | Value |
|---|---|
| Decision | Idle-timer suspension during `waiting` is allowed only when the canonical M3 Stage/Run is in `waiting_approval` (proven by `m3-lifecycle-transition-contracts.ts:72` and the `waiting` Process state + `pauseIdle`). P5C owns exactly one narrow server-internal `CanonicalRunEventObservationPort` dependency on `StageExecutionCoordinator`, subscribed by the existing durable-verified `RunStreamService`; `createProviderExecutionChain(...)` is the production composition root and adapts `store.runStreamService()` into that port. The port is repository-convention equivalent to `subscribe({workspaceId, runId, afterSequence, onEvent, onOverflow}) -> unsubscribe()`, where `onEvent` receives `RuntimeEventRecord` and `onOverflow` receives the last safe cursor. The exact observations are durable `approval.required` (`running -> waiting_approval`) and `approval.resolved` for the same `approvalRequestId`; only `approve_once`/`approve_run`/`approve_workspace` resumes, while `reject` and `cancel_run` do not. The port starts after a known sequence, verifies workspace/run/stage/stageAttempt, deduplicates replay, and fails/overflows closed. The paired Process transitions `running -> waiting`/`pauseIdle()` and `waiting -> running`/`resumeIdle()` only while still active; cancellation wins over any later resolution. The seam MUST NOT create another approval state, another Run/Stage state machine, HTTP/SSE dependency, or polling. Total timeout remains active during waiting; the startup deadline is already finished after readiness; only idle pauses. |
| Evidence | M3 transition contracts (`stage running -> waiting_approval`); event registry `approval.required`/`approval.resolved`; `LifecycleTransactionService.resolveApprovalToCancellation` emits the `cancel_run` resolution before `stage.cancelled`/`run.cancelled`; spec §31.1 (waiting_approval excludes idle); `RunStreamService` already provides durable catch-up + notifier delivery + overflow; `SqliteStore.runStreamService()` is the existing backing surface; `ProcessTimers.pauseIdle/resumeIdle` and `ProcessManager.enterWaiting/exitWaiting` already exist with no durable-path caller. |
| Alternatives rejected | Suspending idle on any `waiting`-like state without M3 evidence; inventing a second approval state; polling-based inferred approval state. |
| Contract consequence | Idle deadline pauses only during proven M3 approval wait; total and startup deadlines are unaffected; one seam, no second state machine. |
| Tests required | `approval.required` pauses idle once; duplicate/replayed event does not double-pause; normal `approval.resolved` resumes remaining budget; stale stageAttempt and wrong run/stage are ignored; `cancel_run` wins with no resume; terminal Process ignores resolution; observation overflow/failure fails closed; total timeout remains active; startup is already disarmed; no HTTP/SSE object participates. |

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
| Decision | **REQUIRED_P5_CLOSURE.** When Session activation CAS fails after a successful spawn, the spawned Process is not left orphaned-active: the SERVER/STAGE orchestration invokes the PROCESS-SIDE P5 stop pipeline (graceful -> grace -> force tree -> survivor verification) with a startup/activation stop reason, the Process terminalizes `exited` only with `complete` **and** `owned-tree-enumeration` proof (otherwise `orphaned`/unknown), the Session terminalizes `failed` with `PROVIDER_SESSION_FAILED`/`PROVIDER_START_FAILED`, and the caller outcome remains fail-closed. Cleanup runs once via the idempotent stop ticket; duplicate cleanup is prevented by the single-ticket rule. If the unchanged P4 NodeProcessDriver returns bare `complete` without proof, P5A treats it as `UNKNOWN`/unproven, does not report successful cancellation, and does not invoke a successful lifecycle hand-off. Phase split per implementation plan §5.3: the coordination/state half is proven in P5A on the controllable MockDriver (both no-proof negative and valid-proof positive); full production tree-cleanup proof completes in P5B. |
| Evidence | Section 4 of `M4-p5-current-state-audit.md` reproduces the residual; P5's own contract (cancel while Session starting, survivor-before-terminal) naturally owns a spawned-but-unactivated Process. The residual is not a P4 bug; it is P5 startup compensation scope. |
| Alternatives rejected | (a) Treating it as a P4 contract violation (no violation exists — caller fails closed); (b) P6_RECOVERY_OWNED (the process is not a restart case; it is an in-flight start that P5's own tree contract governs); (c) silent omission (forbidden). |
| Contract consequence | Every successfully spawned root receives an explicit tree-cleanup result before the Stage attempt terminal; no spawned child survives a failed activation. |
| Tests required | Active-CAS-failure schedule: spawn succeeds -> activation CAS fails -> graceful/force/verify runs once -> Process exited/orphaned, Session failed, exactly one terminal Process fact, no second spawn. |

### OD-M4-P5-17 — Shutdown interaction (P6-owned server shutdown stop)

| Field | Value |
|---|---|
| Decision | **SERVER SHUTDOWN STOP IS P6-OWNED.** P5's responsibility is limited to exposing a reusable, idempotent, typed stop pipeline that P6 may invoke later: `stop(processId, reason='shutdown')` is a supported stop reason on the same Process-side pipeline (durable `process.stopping`/terminal facts), proven at package level. P6 owns: enumerating active Processes during server shutdown; ordering the stop relative to HTTP/publisher/store teardown (including any `index.ts`/shutdown wiring changes); the shutdown deadline; shutdown-mode recording; post-restart classification; and `recovery_required` folding (M4 plan §7 P6 "shutdown mode recording as technically necessary"; §15 assigns server startup/shutdown file ownership to P6). P5 implementation does NOT modify `index.ts` or any server shutdown wiring, does not perform shutdown enumeration, and no P5 acceptance criterion depends on a server-shutdown integration test. |
| Evidence | CS-22 (current shutdown does not enumerate provider processes); M4 plan §7 P6 owns shutdown-mode recording and §15 assigns "TaskRunRecoveryService/server startup/shutdown" to P6; spec §72 shutdown modes; Independent Plan Review HIGH-3 (no P5 slice allowlist contained shutdown wiring; adding it would contradict the master plan's P6 file ownership). |
| Alternatives rejected | P5 owning shutdown enumeration/ordering (requires files no P5 slice may edit and contradicts M4 plan §15); no shutdown stop at all (active processes would leak — P6 closes this by invoking the reusable pipeline). |
| Contract consequence | The Process-side stop pipeline is invocation-neutral: cancel, timeout and (future) P6 shutdown callers reuse the same durable ticket/fact machinery. P5 ships the capability; P6 owns the server integration. |
| Tests required | Package-level proof that `stop(processId, reason='shutdown')` is accepted and produces the frozen durable facts; NO server shutdown E2E in P5. |

### OD-M4-P5-18 — Event/fact vocabulary reuse

| Field | Value |
|---|---|
| Decision | P5 reuses the frozen Process fact vocabulary. The following facts are ALREADY registered (P2B `M4_PROCESS_RUNTIME_EVENT_TYPES` in `packages/shared/src/types/m3-runtime.ts`) and ALREADY have durable fact writers in `ProcessRepository`/`ProviderSessionRepository`; P5 may emit them and does NOT require Event Registry expansion for them: `process.launch_requested`, `process.starting`, `process.started`, `process.stopping`, `process.exited`, `process.failed`, `process.cleanup_required`, `process.orphaned`, plus the existing Session/state-change facts (`process.session_claimed`, `process.session_state_changed`, `process.claim_transferred`, `process.state_changed`, `process.output_reference_advanced`) as applicable. There is no registered `provider.*` Event family in current P5 scope. `provider.session_cancelled` remains reconciliation-gated and ABSENT from the current Registry; no P5 acceptance may depend on it, and successful cancelled-Session durability is proven through `provider_sessions.status='cancelled'` plus the already-authorized vocabulary (OD-M4-P5-10). A failed Session is proven by `provider_sessions.status='failed'` plus the same existing Session/Process facts, not by an unregistered provider Event. No new P5-specific Event type is proposed and no P5 slice may silently expand the shared Registry/spec. |
| Evidence | P0 event-error contract §1/§2 and the SPEC_RECONCILIATION_REQUIRED list (which does NOT contain `process.cleanup_required`/`process.orphaned` — they reuse Runtime Specification names); the P2B registry expansion already landed them with repository fact writers (`ProcessRepository.ts` orphaned/cleanup_required writers); Independent Plan Review MEDIUM-2 (the prior wording claiming they "require Registry expansion review" was stale). |
| Alternatives rejected | New ad-hoc cancel Event types; reusing `process.exited` for survivors; treating registered Process facts as still-gated (would block the evidence OD-M4-P5-06/11/12 require). |
| Contract consequence | Every P5 fact rides the accepted M3 Event/Outbox envelope; unknown-Event handling stays forward-compatible; the only still-gated P5-adjacent vocabulary is `provider.session_cancelled` (and P6-owned recovery vocabulary), and it is never an acceptance dependency. |
| Tests required | Event/Outbox 1:1 for stop/terminal facts; replay idempotency; no duplicate terminal Event; no P5 assertion requires an unregistered Event type. |

### OD-M4-P5-19 — Approval-wait cancellation routing

| Field | Value |
|---|---|
| Decision | Cancelling a Run/Stage in M3 `waiting_approval` uses the EXISTING canonical approval-cancellation composite: `approval cancellation -> approval.resolved -> stage.cancelled -> run.cancelled`, through the existing `LifecycleTransactionService.resolveApprovalToCancellation` seam and its frozen ordering. P5 MUST NOT implement this by adding `waiting_approval` to the generic `cancelRunWithinTransaction` state list — that would emit `stage.cancelled`/`run.cancelled` without the preceding `approval.resolved` and violate the frozen M3 multi-event ordering contract (`approval-cancellation`: `['approval.resolved','stage.cancelled','run.cancelled']`). The paired Process enters the same single P5 stop pipeline with cancel causation. This is a TECHNICAL decision: the frozen M3 transition contracts already authorize `waiting_approval -> cancelled` for Run and Stage, so no product semantic changes and no USER owner decision is required. |
| Evidence | `packages/shared/src/types/m3-lifecycle-transition-contracts.ts` (run `waiting_approval -> cancelled`; stage `waiting_approval -> cancelled`; the `approval-cancellation` ordering contract); `LifecycleTransactionService.resolveApprovalToCancellation` exists and implements the ordering; `cancelRunWithinTransactionBody` deliberately excludes approval states ("expected a cancellable non-approval state"); Independent Plan Review MEDIUM-3. |
| Alternatives rejected | Extending the generic cancel state list (violates the frozen event ordering); denying waiting_approval cancellation (contradicts the frozen M3 transitions); a new approval-cancel state machine (second state machine forbidden). |
| Contract consequence | User-visible semantics unchanged; the cancel window table gains an explicit approval-wait row; the generic cancel seam keeps rejecting approval states. |
| Tests required | Cancel during `waiting_approval` asserts the frozen event ORDER (`approval.resolved` before `stage.cancelled` before `run.cancelled`), not merely final status; the paired Process stop joins the single ticket; duplicate cancel converges. |

### OD-M4-P5-20 — POSIX platform-gate blocking semantics

| Field | Value |
|---|---|
| Decision | POSIX real-OS evidence is a REQUIRED P5B acceptance gate under the authoritative P0/M4 contract. If no valid POSIX environment/capability is available, record `PLATFORM_GATE_BLOCKED` with the host and missing-capability evidence; this is not PASS, not a substitute result, and not a silent skip. P5B acceptance is incomplete, overall P5 acceptance is incomplete, and M4-P5 MUST NOT be declared COMPLETE. Windows-only evidence cannot close the POSIX gate. |
| Evidence | P0 §9/§13 owned-group and survivor requirements; M4-P5 plan §6.2 and acceptance matrix §5 require POSIX group proof; the platform gate is a required cross-platform contract, not an optional label. |
| Alternatives rejected | Treating `PLATFORM_GATE_BLOCKED` as an acceptable substitute; silently skipping POSIX fixtures; declaring P5 complete from Windows-only evidence. No CI infrastructure change is authorized by this decision. |
| Contract consequence | A blocked POSIX environment honestly preserves an incomplete P5B/P5 status and blocks any later slice whose dependency requires accepted P5B evidence. |
| Tests required | Real POSIX group TERM/grace/KILL and survivor fixtures when available; otherwise a deterministic gate record showing `PLATFORM_GATE_BLOCKED`, `POSIX gate NOT PASS`, `P5B INCOMPLETE`, and `P5 INCOMPLETE`. |

### OD-M4-P5-21 — Windows inspection evidence fidelity

| Field | Value |
|---|---|
| Decision | P5B Windows evidence records the exact selected existing inspection facility (for example PowerShell `Get-CimInstance`), its host/tool version and capability, and uses that facility consistently for one evidence run; no silent facility switch is allowed. CIM `CreationDate` serialization is parsed and normalized deterministically to the identity comparison representation; malformed, missing or unparseable values are `UNKNOWN`. `ExecutablePath` null, access-denied or otherwise incomplete identity is `UNKNOWN` and fails closed; the driver never guesses executable identity. |
| Evidence | P0 §9 identity fencing; M4-P5 Windows fallback requires start-time/executable evidence before signaling and re-enumeration after force; this decision makes the evidence source and normalization auditable without adding a dependency. |
| Alternatives rejected | Switching inspection tools mid-run; treating a `taskkill` result or PID liveness as identity evidence; guessing an executable path when CIM access is unavailable. |
| Contract consequence | A P5B Windows run is reproducible and auditable: facility/version/capability, normalized start time and executable identity are recorded; any unavailable or incomplete identity maps to `UNKNOWN`/fail closed and cannot emit owned-tree proof. |
| Tests required | Selected-facility/version evidence; deterministic CIM `CreationDate` parsing/normalization (including malformed input); null/access-denied/incomplete `ExecutablePath` -> `UNKNOWN`; no silent fallback or guessed identity. |

## 3. Decision conclusion

```text
CURRENT M4-P5 OWNER DECISION COUNT            = 0 (USER)
CURRENT M4-P5 TECHNICAL DECISION COUNT        = 21 (ALL RESOLVED)

BLOCKING UNRESOLVED DECISIONS                 = 0

P4 LOW RESIDUAL DISPOSITION                   = REQUIRED_P5_CLOSURE (OD-M4-P5-16)
                                               coordination/state half in P5A (MockDriver);
                                               no-proof P5A path fails closed;
                                               full production tree proof in P5B

P5A/P5B TREE-PROOF BOUNDARY                   = bare `complete` is unproven;
                                               `owned-tree-enumeration` proof is
                                               required for successful cleanup

PHASE STATEMENT                                = P5A COMPLETE != PRODUCTION TREE
                                               CANCELLATION PROVEN; P5A is
                                               authority/state safety + fail-closed
                                               exposure, P5B owns real proof

POSIX PLATFORM GATE                            = REQUIRED P5B evidence;
                                               `PLATFORM_GATE_BLOCKED` means
                                               P5B/P5 INCOMPLETE, never PASS

WINDOWS EVIDENCE FIDELITY                      = selected facility/version/capability
                                               recorded per run; CreationDate normalized;
                                               missing ExecutablePath/identity = UNKNOWN

WINDOWS JOB OBJECT                            = OPTIONAL FUTURE CAPABILITY SLOT (OD-M4-P5-04/05);
                                               authorized P5 implementation is the observable
                                               bounded fallback; no new dependency authorized

SERVER SHUTDOWN STOP                          = P6-OWNED (OD-M4-P5-17); P5 exposes the
                                               reusable idempotent stop pipeline only

REQUIRED BEFORE M4-P5 IMPLEMENTATION ENTRY    = separate explicit P5 authorization
                                                naming exact base/files/owner/tests,
                                                plus second independent plan review BLOCKER/HIGH 0

M4-P5 PRODUCTION IMPLEMENTATION               = NOT AUTHORIZED
P6                                              = MUST NOT START
M4 MILESTONE                                    = NOT COMPLETE (P5-P11 remain)
```
