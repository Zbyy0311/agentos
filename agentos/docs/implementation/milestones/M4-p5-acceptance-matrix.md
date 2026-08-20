# AgentOS M4-P5 Cancellation, Process Tree, Timeout and Transport — Acceptance Test Matrix

Status: M4-P5 PRE-IMPLEMENTATION PLANNING — FIFTH NARROW DOCS-ONLY REMEDIATION (FRESH REVIEW PENDING) — TEST ARCHITECTURE FROZEN — NO TEST OR PRODUCTION IMPLEMENTATION AUTHORIZED

## 1. Traceability

`D` = deterministic automated evidence required. `R` = separately authorized
real-provider gate required. `N/A` allowed only with the reason shown.

| Exit gate | Unit | Contract | Integration | Platform | Recovery | Negative/mutation | Real Provider | Required proof |
|---|---|---|---|---|---|---|---|---|
| E04 Cancel covers owned Process Tree | D: P5A internal stop ticket/state/race model; shared proof normalizer; bare `complete` rejection; exact live-entry lifecycle; AsyncIterator capture interruption; one attempt finalization arbiter and stopped outcome | D: driver cleanup-result/survivor vocabulary + `owned-tree-enumeration` proof provenance | D: P5A internal Stage cancel; P5D later activates public command and LTS hand-off | D: Windows fallback owned-tree proof (required); POSIX group proof REQUIRED (if unavailable, `PLATFORM_GATE_BLOCKED` means P5B/P5 incomplete) | N/A: restart classification is P6-owned evidence | D: every Manager/Durable/ProcessCancelCoordinator path rejects proof removal; finalizer races reject double Adapter/output/Session completion; stray cleanup cannot create proof | R: bounded Kimi gate only after P5D | successful active cancel requires normalized `proven=true`, no unknown survivor, valid proof and one finalization body |
| E08 disconnect does not terminate | D: subscriber dispose has no stop call | D: transport ownership contract | D: close socket, Process/Event/Run continue; explicit cancel works | D: Windows/POSIX Process remains alive after transport close | D: reconnect resumes persisted cursor/reference | D: mutate close handler to call stop and require failure | R: Kimi task survives client close and reconnect | browser owns subscription only; explicit cancel is the only termination command |
| E06 Kimi vertical slice (P5 real gate) | D: Kimi fixtures unchanged | D: Registry/Snapshot/Adapter version contract | D: fake Kimi canonical Run -> Stage outcome | D: Windows tree fixtures | D: interrupted Kimi stays uncertain | D: PlainText/OpenCode fallback prohibited | R: installed Kimi direct validation + bounded task + cancel/disconnect | direct KimiCode through canonical chain; not M4 final completion |
| E10 M3 contracts preserved | D: existing lifecycle/Event/idempotency units | D: envelope/Registry/ApiProblem compatibility | D: full M3 Run/Operation/Event/Outbox/SSE/Legacy regression | N/A: M3 semantics platform-independent; platform suites still run integration | D: `recovery_required`/uncertainty regressions | D: duplicate Event/Outbox, sequence rollback, replay-spawn mutations | R: Kimi evidence bound to same M3 Events/Operation | no second lifecycle; Event/Outbox and transitions atomic and replay-safe |

## 2. Cancellation cases

Each case records the first accepted stop reason, Process versions, Driver call
count, terminal Event count, output finalization count, tree result and final M3
outcome.

| ID | Case | Class | Required assertions |
|---|---|---|---|
| CAN-01 | cancel before reservation | UNIT/INTEGRATION | no stop ticket for unknown Process; stable error |
| CAN-02 | cancel after reservation while `created` | UNIT | `created -> failed` `cancelled-before-spawn`; spawn right revoked; Driver spawn count 0 (RACE-S1) |
| CAN-03 | cancel during fenced `starting` (unresolved spawn, null PID) | UNIT | `starting -> stopping`; null PID not unspawned; spawn count 1; no second spawn (RACE-S2) |
| CAN-04 | cancel immediately after spawn | UNIT | late success binds identity, stays `stopping`, cleanup runs once (RACE-S3) |
| CAN-05 | cancel while `running` | UNIT/INTEGRATION | graceful -> grace -> force -> verify -> `exited`/`TERMINATED`; one terminal fact |
| CAN-06 | cancel during M3 `waiting_approval` | UNIT/INTEGRATION | P5A cleans the paired Process internally; only P5D, after proof, calls the frozen composite `approval.resolved` -> `stage.cancelled` -> `run.cancelled` via `resolveApprovalToCancellation`; the generic plain cancel seam still rejects approval states |
| CAN-07 | cancel while output streams drain | INTEGRATION | finalization before terminal fact; artifacts finalized; bounded backpressure |
| CAN-08 | cancel vs natural exit | UNIT | first terminal observation wins; cancel causation retained (OD-M4-P5-07) |
| CAN-09 | cancel after Process exited, before Provider finalize | INTEGRATION | terminal Process fact committed; Provider finalize sees stop ticket; exactly one Session terminal |
| CAN-10 | cancel during Provider finalize | INTEGRATION | cancelled/failed finalization; exactly one durable `provider_sessions.status='cancelled'|'failed'` transition, corresponding existing `process.session_state_changed`/Process terminal fact evidence, and no duplicate Session terminal; no `provider.*` Event is required |
| CAN-11 | duplicate cancel (same key) | UNIT | joins first ticket; same result; one cleanup |
| CAN-12 | concurrent duplicate cancel | UNIT | CAS winner owns ticket; losers join; one terminal fact |
| CAN-13 | cancel after terminal completion | UNIT | existing result returned; no mutation; no duplicate Event |
| CAN-14 | cancellation failure (graceful fails) | UNIT | force still runs; result from tree verification |
| CAN-15 | survivor detected | UNIT/INTEGRATION | `orphaned` + `SURVIVORS`; cancel NOT successful; Run uncertainty preserved |
| CAN-16 | unknown tree ownership | UNIT | `orphaned` + `UNKNOWN_PLATFORM_UNAVAILABLE`; fail closed |
| CAN-17 | graceful-stop failure | UNIT | bounded progression to force |
| CAN-18 | force-kill failure | UNIT | `UNKNOWN_PLATFORM_UNAVAILABLE`/`PROCESS_TREE_TERMINATION_FAILED`; uncertainty |
| CAN-19 | P4 active-CAS-after-spawn closure (phase-split, OD-M4-P5-16) | INTEGRATION | P5A internal: spawn succeeds -> activation CAS fails -> one stop ticket -> shared normalizer; valid proof may exit, bare proof becomes orphaned/unknown, Session failed, one fact, no second spawn; P5B later proves the real tree |
| CAN-20 | bare complete cleanup result has no proof | UNIT/INTEGRATION | `classification='complete'`, `knownPids=[]`, no proof -> shared normalizer returns `unknown`/`UNKNOWN_PLATFORM_UNAVAILABLE`/`proven=false`; Process orphaned, Session failed, Run/Stage nonterminal, LTS call count 0, no false terminal Event, no second stop/spawn |
| CAN-21 | valid owned-tree proof | UNIT/INTEGRATION | MockDriver `classification='complete'` + `proof.kind='owned-tree-enumeration'` -> normalized `proven=true`; P5A internal cancellation may proceed once; Session/LTS hand-off is ordered and idempotent only at the owning later command seam |
| CAN-22 | Manager proof-bypass mutation | UNIT/MUTATION | remove proof from complete verification; Manager must never emit `process.exited` or `TERMINATED` |
| CAN-23 | Durable registration proof-bypass mutation | UNIT/INTEGRATION | bare complete in bind/registration cleanup -> `orphaned`/unknown; no `failed` successful-cleanup terminal |
| CAN-24 | Durable late-success proof-bypass mutation | UNIT/INTEGRATION | bare complete in starting-cancel late success -> `orphaned`; no `exited` |
| CAN-25 | ProcessCancelCoordinator proof-bypass mutation | UNIT | bare complete through new coordinator -> same shared normalized unknown result; no second authority |
| CAN-26 | P5A exact Session/Process claim correlation | UNIT/INTEGRATION | `cancelAttempt` resolves exact workspace/run/stage/stageAttempt/authority claims; mismatch or missing claim fails closed; no PID/Event/latest-process lookup |
| CAN-27 | P5A public route boundary | ARCHITECTURE/UNIT | canonical/v2/Operation active routes remain unactivated; internal P5A port works; absent injected authority returns stable failure with no mutation |
| CAN-28 | P5A active cleanup has no LTS hand-off | UNIT/INTEGRATION | bare complete/no proof -> Session failed, Run/Stage nonterminal, LTS successful call count 0, no terminatedProcessId |

### 2.1 Attempt-finalization race cases (P5A)

Each case must assert one exact live-attempt rendezvous, one finalization body
and the persisted Session state as the only terminal authority. Drain tasks use
the Stage-local `captureStop` interruption latch; `DurableOutputWriter` uses
`finalize()` for natural/proven completion and `abort()` for uncertain cleanup
only after both drain tasks quiesce.

| ID | Case | Class | Required assertions |
|---|---|---|---|
| FINAL-01 | natural exit wins before stop ticket | UNIT/INTEGRATION | durable Process terminal evidence commits first; exactly one natural finalization; later cancel joins persisted terminal evidence; no second Adapter/output/Session/Deferred finalization |
| FINAL-02 | stop ticket wins before exit | UNIT/INTEGRATION | accepted stop ticket precedes natural terminal evidence; `runToFinal` cannot call `finalize(cancelled=false)`, complete Session or resolve completed Stage; one internal `stopped` result |
| FINAL-03 | cancel vs `exitCode=0` | UNIT | accepted stop wins even with zero exit code; no Provider completed status, canonical completion or completed Stage outcome |
| FINAL-04 | cancel vs Provider finalize | UNIT/INTEGRATION | `finalizeAttemptOnce` invoked once; Adapter.finalize call count = 1; output finalization count = 1 per stream; Session terminal count = 1 |
| FINAL-05 | Session CAS loser observes persisted cancelled | UNIT/INTEGRATION | losing natural/timeout contender reads/joins persisted `cancelled`; it cannot resolve completed or failed from local desired state |
| FINAL-06 | Session CAS loser observes persisted failed | UNIT/INTEGRATION | losing cancel contender reads/joins persisted `failed`; it cannot resolve cancelled from local desired state |
| FINAL-07 | stdout/stderr draining during proven cancellation | INTEGRATION | bounded stream joins and parser tail finish once; both writers finalize once; no hanging drain or duplicate artifact reference |
| FINAL-08 | uncertain cleanup with live survivor | UNIT/INTEGRATION | Process orphan/unknown + Session failed; both writers call existing `abort()`; capture is bounded; no Provider completion, LTS success or unbounded finalizer wait |
| FINAL-09 | Dispatcher receives internal stopped outcome | UNIT/INTEGRATION | `RunEngineProviderDispatcher.ts` breaks/returns with LTS/Stage/Run complete/failed/cancel calls = 0; `RunEngine.ts` is untouched |
| FINAL-10 | P5D proven active cancel | INTEGRATION | internal `stopped` is followed only by the owning P5D command seam; one proven non-empty terminatedProcessIds hand-off and exactly one canonical terminal path |
| FINAL-11 | timeout vs runToFinal completion | UNIT | timeout stop enters the same arbiter; first accepted stop reason prevents false Provider completion even if native exit is 0 |
| FINAL-12 | P4 activation-CAS failure | INTEGRATION | accepted compensation stop, `runToFinal` and compensation converge on one finalization result; final Deferred resolves once; no live child continues without durable uncertainty |
| FINAL-13 | new-claim rendezvous registration | UNIT/INTEGRATION | new claim opens writers, revalidates exact Session/Process ownership, installs the same-instance live entry synchronously before `created -> starting`; no spawned Process lacks the entry |
| FINAL-14 | joinedExisting duplicate | UNIT/INTEGRATION | duplicate creates/replaces zero rendezvous entries, starts zero `runToFinal`/Adapter starts and invokes zero spawns |
| FINAL-15 | created cancel before rendezvous | UNIT/INTEGRATION | created-before-spawn cancel needs no live entry; racing writers are aborted after pre-spawn revalidation; Driver spawn count remains 0 |
| FINAL-16 | starting cancel capture ordering | UNIT/INTEGRATION | live entry exists; accepted/joined stop resolves `captureStop` before Adapter graceful, grace, force or survivor wait |
| FINAL-17 | stdout `next()` never resolves | UNIT/INTEGRATION | `captureStop` wins the Promise.race; finalization completes without native stdout EOF |
| FINAL-18 | stderr `next()` never resolves | UNIT/INTEGRATION | same bounded interruption semantics for stderr |
| FINAL-19 | iterator.return absent | UNIT | stop completes without requiring `iterator.return` |
| FINAL-20 | iterator.return never resolves | UNIT | `iterator.return()` is best-effort and never awaited for correctness; stop completes |
| FINAL-21 | stop wins while append is in progress | UNIT/INTEGRATION | the current append quiesces, no later append begins, and writer terminal action remains exactly once |
| FINAL-22 | natural drain interrupted by stop | UNIT/INTEGRATION | timeout/cancel interrupts both drains; natural contender observes stopping and joins the stop arbiter |
| FINAL-23 | natural terminal CAS wins | UNIT/INTEGRATION | later cancel cannot install stop finalization or change natural terminal truth |
| FINAL-24 | stop CAS wins | UNIT/INTEGRATION | natural contender cannot install natural finalization or Provider completion |
| FINAL-25 | finalization Promise mutation | UNIT/MUTATION | a losing contender cannot execute another Adapter/output/Session terminal body |
| FINAL-26 | live entry removal | UNIT/INTEGRATION | entry is removed only after finalization settles; a loser cannot remove a replacement/different entry |

### 2.2 Public command and Operation cases (P5D)

| ID | Case | Class | Required assertions |
|---|---|---|---|
| CMD-01 | queued/no-Process cancellation | INTEGRATION | existing M3 cancellation may use empty `terminatedProcessIds` only when no Process claim/spawn right exists |
| CMD-02 | active proven cancellation | INTEGRATION | runtime stop occurs outside SQLite; final version revalidation succeeds; non-empty proof-backed terminatedProcessIds reach the correct LTS seam |
| CMD-03 | active unproven cancellation | INTEGRATION | no LTS success, no Run/Stage terminal, stable cancellation-incomplete result, durable Process/Session uncertainty |
| CMD-04 | uninjected active route | INTEGRATION | canonical/v2 active cancel returns `RUN_CANCEL_AUTHORITY_UNAVAILABLE` (or frozen equivalent); no Run/Process mutation |
| CMD-05 | waiting_approval after proof | INTEGRATION | only after Process proof, `resolveApprovalToCancellation` emits `approval.resolved` -> `stage.cancelled` -> `run.cancelled`; generic plain cancel remains rejected |
| OP-01 | active Operation legacy bypass | INTEGRATION/MUTATION | `OperationService` never calls old empty-ID LTS path before runtime proof; active Operation remains nonterminal on uncertainty |
| OP-02 | Operation runtime outside transaction | INTEGRATION | OS wait/stop is outside SQLite transaction; final transaction revalidates Operation/Run versions and commits exactly once |
| OP-03 | Operation final version race | UNIT/INTEGRATION | lost revalidation returns conflict/evidence without second stop/spawn or duplicate terminal Event |
| OP-04 | duplicate active Operation cancel | UNIT/INTEGRATION | duplicates join the same Process stop ticket and return identical evidence |

## 3. Tree cases

| ID | Case | Class | Required assertions |
|---|---|---|---|
| TREE-01 | child process terminated | REAL OS CHILD | root+child absent after force; `complete` + `owned-tree-enumeration` proof |
| TREE-02 | grandchild terminated | REAL OS CHILD | 3-level tree absent; `complete` + `owned-tree-enumeration` proof |
| TREE-03 | no survivors | REAL OS CHILD | `verifySurvivors` = `complete` + proof, empty list |
| TREE-04 | known survivor failure | REAL OS CHILD / UNIT | survivor PID reported (restricted); `SURVIVORS`; cancel fails closed |
| TREE-05 | already exited | REAL OS CHILD | `ALREADY_EXITED`; no signal attempted |
| TREE-06 | partial cleanup | REAL OS CHILD / UNIT | some members remain; `SURVIVORS` |
| TREE-07 | inaccessible process | ENV-GATED / UNIT | inspection `unknown`; no signal; fail closed |
| TREE-08 | identity mismatch (PID reuse) | UNIT / REAL OS CHILD | start-time/executable differs; `IDENTITY_MISMATCH`; no signal (OD-M4-P5-05) |
| TREE-09 | root exits while grandchild survives | UNIT mutation | cancel must NOT report success |
| TREE-10 | complete without proof | UNIT mutation | `classification='complete'` + empty `knownPids` without `proof.kind='owned-tree-enumeration'` maps UNKNOWN/unproven; no successful cancellation |
| STRAY-01 | `terminateStray` bare complete | UNIT/MUTATION | stray compensation cannot satisfy proof, E04, Process/Session/canonical cancellation or a successful LTS hand-off |

## 4. Windows cases

The REQUIRED Windows gate is the observable fallback owned-tree proof
(WIN-06), and `complete` requires the explicit `owned-tree-enumeration` proof
marker. Job Object is an OPTIONAL FUTURE CAPABILITY SLOT (OD-M4-P5-04/05):
no new native/FFI/helper dependency is authorized by P5, and WIN-05/WIN-07
are capability evidence only, never a silent skip and never a condition for
base P5 acceptance.

| ID | Case | Class | Required assertions |
|---|---|---|---|
| WIN-01 | executable `.exe` | WINDOWS-SPECIFIC | fallback tree proof; tree gone; `complete` only from re-enumeration |
| WIN-02 | `.cmd` via validated wrapper | WINDOWS-SPECIFIC | wrapper policy; separated args; tree gone |
| WIN-03 | path containing spaces | WINDOWS-SPECIFIC | array args preserved; no re-quoting |
| WIN-04 | Unicode path | WINDOWS-SPECIFIC | Unicode preserved end-to-end |
| WIN-05 | Job Object capability (optional slot) | OPTIONAL_CAPABILITY / ENV-GATED | PASS only if a separately authorized Job implementation exists (`treeMode='job'`, kill-on-close, job-membership proof); otherwise explicit UNSUPPORTED/BLOCKED capability evidence; not required for base P5 acceptance while WIN-06 proves E04 |
| WIN-06 | fallback owned-tree proof (REQUIRED Windows gate) | WINDOWS-SPECIFIC | observable `treeMode='fallback'` + warning + reduced-reliability marker; bounded descendant enumeration; identity fence before signal; `taskkill /PID <owned-root> /T /F` separated args; survivor re-enumeration after force; success never inferred from taskkill exit alone |
| WIN-07 | nested Job restriction (future capability context) | OPTIONAL_CAPABILITY / ENV-GATED | relevant only under an authorized Job implementation: compatible strategy or observable fallback; never silent; with no Job capability, capability evidence records it as inapplicable |
| WIN-08 | access-denied / already-exited races | WINDOWS-SPECIFIC | identity re-check; fail closed |
| WIN-09 | selected inspection facility evidence | WINDOWS-SPECIFIC / EVIDENCE | record the exact existing facility (for example PowerShell `Get-CimInstance`), host/tool version and capability; one facility per run; no silent switch |
| WIN-10 | CIM `CreationDate` normalization | WINDOWS-SPECIFIC / UNIT | serialized `CreationDate` parses to the deterministic identity comparison representation; missing/malformed/unparseable -> `UNKNOWN` and fail closed |
| WIN-11 | incomplete executable identity | WINDOWS-SPECIFIC / UNIT | null/access-denied/incomplete `ExecutablePath` -> `UNKNOWN`; no guessed executable identity and no owned-tree proof |

## 5. POSIX cases

Group creation mechanism is frozen in OD-M4-P5-05 / implementation plan §6.2:
the driver internally uses `detached: true` on POSIX only as the Node
group/session creation mechanism, with stdio piped, handle retained, no
`unref()`, PGID in `NativeIdentity.groupId`, and PGID/start revalidation
before every `-pgid` signal. Required POSIX real-OS evidence needs an actual
POSIX host/capability. This is a REQUIRED P5B acceptance gate: if no such
environment exists during P5 verification, record `PLATFORM_GATE_BLOCKED`
with evidence; POSIX is NOT PASS, P5B acceptance is INCOMPLETE, overall P5
acceptance is INCOMPLETE, and M4-P5 MUST NOT be declared COMPLETE. Do not
silently skip, substitute Windows-only evidence, or treat the blocked result
as an optional cross-platform label.

| ID | Case | Class | Required assertions |
|---|---|---|---|
| POSIX-01 | process group TERM | POSIX-SPECIFIC | group created via driver-internal mechanism with OD-M4-P5-05 invariants; `-pgid` SIGTERM; group members receive it |
| POSIX-02 | grace interval | POSIX-SPECIFIC | injected clock; deadline honored |
| POSIX-03 | group KILL | POSIX-SPECIFIC | `-pgid` SIGKILL after grace; PGID/start evidence revalidated first |
| POSIX-04 | survivor verification | POSIX-SPECIFIC | group membership + descendants; complete/survivors/unknown |
| POSIX-05 | group escape attempt | POSIX-SPECIFIC | escaped member detected or `unknown`; fail closed |
| POSIX-06 | natural-exit race | POSIX-SPECIFIC | exit before signal -> `ALREADY_EXITED` |
| POSIX-07 | blocked POSIX gate | ENV-GATED | no valid POSIX host/capability -> evidence records `PLATFORM_GATE_BLOCKED`, POSIX NOT PASS, P5B INCOMPLETE, P5 INCOMPLETE |

## 6. Timeout cases

| ID | Case | Class | Required assertions |
|---|---|---|---|
| TO-01 | startup timeout | UNIT (fake clock) | `PROCESS_STARTUP_TIMEOUT`; proven cleanup maps to Provider `PROVIDER_START_FAILED`/Stage failed; unproven cleanup maps to stopped/unproven with Stage nonterminal |
| TO-02 | idle timeout | UNIT | `PROCESS_IDLE_TIMEOUT` after no activity; proven cleanup maps to runtime failure, unproven cleanup maps to stopped/unproven |
| TO-03 | activity resets idle | UNIT | each `notifyActivity` restarts full budget |
| TO-04 | total timeout | UNIT | `PROCESS_TOTAL_TIMEOUT` from native start; proven cleanup maps to runtime failure, unproven cleanup maps to stopped/unproven |
| TO-05 | timeout vs exit | UNIT | first terminal observation wins; one terminal fact |
| TO-06 | timeout vs cancel | UNIT | first accepted stop reason owns; correlated diagnostics |
| TO-07 | approval-wait idle suspension | UNIT | durable `approval.required` (`running -> waiting_approval`) enters paired Process `waiting`; idle pauses; remaining budget resumes only on normal `approval.resolved`; total unaffected (OD-M4-P5-14) |
| TO-08 | simultaneous timeout/exit/cancel | UNIT | single `process.stopping` reason; single terminal fact |
| TO-09 | policy propagation | INTEGRATION | snapshot `startupTimeoutMs/idleTimeoutMs/totalTimeoutMs` reach the durable Process (audit CS-14 closure) |
| TO-10 | duplicate/replayed approval.required | UNIT | observer starts at cursor 0, matching `stage.started` arms once, and replay pauses the paired Process at most once |
| TO-11 | stale/pre-anchor approval event | UNIT | events before matching `stage.started` anchor, prior attempt, or wrong workspace/run/stage are ignored; no timer mutation |
| TO-12 | normal approval.resolved | UNIT | later same attempt/sequence and same `approvalRequestId`, decision `approve_once`/`approve_run`/`approve_workspace` resumes only an active waiting Process with remaining idle budget |
| TO-13 | approval reject/cancel resolution | INTEGRATION | `reject` or `cancel_run` never resumes; the existing approval-cancellation composite/stop ticket wins |
| TO-14 | terminal Process resolution | UNIT | `approval.resolved` after `stopping`/terminal is ignored; no resume side effect |
| TO-15 | observation overflow/failure | UNIT/INTEGRATION | `RunStreamService` invokes `onFailure(reason,lastSafeSequence)`; narrow observation closes; no guessed waiting/running state and no timer side effect |
| TO-16 | total timeout during approval wait | UNIT | total deadline remains active while idle is paused |
| TO-17 | startup readiness before approval wait | UNIT | startup timer is disarmed at readiness before `approval.required` can pause idle |
| TO-18 | observation transport boundary | ARCHITECTURE/UNIT | fake narrow port only; no HTTP/SSE object, polling loop, or second Event repository participates |
| TO-19 | stage.started attempt anchor | UNIT/INTEGRATION | `afterSequence=0`; observer remains disarmed until exact `stageId` + `payload.attempt`; a newer attempt invalidates the old observer |
| TO-20 | observation failure ownership | UNIT/INTEGRATION | overflow, durability mismatch, subscriber callback failure and close produce explicit failure callback and observer cleanup only |
| TO-21 | startup timeout + proven cleanup | UNIT/INTEGRATION | Provider `PROVIDER_START_FAILED`, phase `startup`, and existing failed Stage path |
| TO-22 | startup timeout + unproven cleanup | UNIT/INTEGRATION | Process orphan/unknown + Session failed; stopped/unproven outcome; Dispatcher makes zero lifecycle mutation and Stage remains nonterminal |
| TO-23 | idle/total timeout + proven cleanup | UNIT/INTEGRATION | Provider `PROVIDER_SESSION_FAILED`, phase `runtime`, and existing failed Stage path |
| TO-24 | idle/total timeout + unproven cleanup | UNIT/INTEGRATION | Process orphan/unknown + Session failed; stopped/unproven outcome; Dispatcher makes zero lifecycle mutation and Stage remains nonterminal |
| TO-25 | timeout Adapter finalization | UNIT/MUTATION | timeout never invokes `Adapter.finalize(cancelled=true)` merely because the Process was stopped; proven timeout uses `cancelled=false` with normalized timeout error |

## 7. Transport cases

| ID | Case | Class | Required assertions |
|---|---|---|---|
| TR-01 | HTTP disconnect continues execution | INTEGRATION | start Run -> provider running -> disconnect HTTP -> Process/Event/Run continue |
| TR-02 | SSE disconnect continues execution | INTEGRATION | start Run -> provider running -> disconnect SSE -> Process/Event/Run continue |
| TR-03 | explicit cancel terminates execution | INTEGRATION | cancel command -> authority executes -> owned tree terminates -> survivor result recorded -> lifecycle terminal through canonical seam |
| TR-04 | Conversation initial disconnect | INTEGRATION | close handler no longer aborts; execution continues (CS-18 closure) |
| TR-05 | Conversation resume disconnect | INTEGRATION regression | unsubscribe only; continues |
| TR-06 | explicit cancel while no subscriber exists | INTEGRATION | terminates through canonical chain |
| TR-07 | reconnect resumes cursor | INTEGRATION | persisted Events/output refs; cursor resumes |
| TR-08 | close-handler mutation negative | MUTATION | wiring close to stop must fail the gate |

## 8. Durability cases

| ID | Case | Class | Required assertions |
|---|---|---|---|
| DUR-01 | Process state | INTEGRATION | stopping/exited/orphaned persisted with columns (audit CS-11) |
| DUR-02 | Session state | INTEGRATION | proven cleanup -> `provider_sessions.status='cancelled'`; no proof/survivor/unknown -> exactly one `failed` Session; durability uses existing `process.session_state_changed`/Process facts; no `provider.*` Event family is required; `provider.session_cancelled` remains Registry-gated and is NOT required |
| DUR-03 | cleanup result | INTEGRATION | one of the five frozen values persisted |
| DUR-04 | termination reason | INTEGRATION | cancel/timeout/non-zero-exit etc. persisted |
| DUR-05 | survivor list | INTEGRATION | restricted redacted JSON; count only in public projection |
| DUR-06 | Event/Outbox parity | INTEGRATION | stop/terminal facts 1:1; atomic rollback |
| DUR-07 | replay/idempotency | INTEGRATION | replay returns prior evidence; duplicate cancel joins one ticket; no second stop/spawn/fact |
| DUR-08 | no duplicate Process | INTEGRATION | one root reservation per Stage attempt |

## 9. Regression sets

| Suite | Required evidence |
|---|---|
| M3 lifecycle | full Run/Stage/Operation/Event/Outbox/idempotency/replay/SSE/recovery suites |
| M4 P1/P2/P3/P4 | Process package suites, durable coordinator/repository suites, dispatcher/coordinator/Kimi suites, P4 race schedules |
| apps/server full suite | all route/service/store tests on the P5 head |
| workspace build | `npm run build` (or repository canonical build) passes |
| git diff --check | no whitespace errors |

## 10. Test classification legend

`UNIT` = deterministic package-local, injected clock/driver. `INTEGRATION` =
durable repositories + coordinator + routes with MockDriver. `REAL OS CHILD` =
spawns real OS child/grandchild fixtures under platform gate. `WINDOWS-SPECIFIC`
/ `POSIX-SPECIFIC` = platform-gated real fixtures. `OPTIONAL_CAPABILITY /
ENV-GATED` = depends on a separately authorized capability or OS availability;
blocked capability returns `BLOCKED`/`UNSUPPORTED` with evidence, never silent
pass and never a base-acceptance condition (WIN-05/WIN-07). `REAL KIMI` = P5E
authorized real executable gate.

Boundary guarantees after the fifth remediation: no P5 acceptance depends on
any unregistered `provider.*` Event; `provider.session_cancelled` remains gated
and is not an acceptance dependency; no P5 acceptance depends on
server-shutdown integration (P6-owned, OD-M4-P5-17); no P5 acceptance requires
P6 restart classification; active public commands are not activated before
P5D; E04 requires the shared proof normalizer everywhere; `#terminateStray`
cannot create proof; and FINAL-01..FINAL-26 require one exact live-entry
lifecycle, one non-circular Stage-attempt finalization arbiter, one terminal
Session result, captureStop-bounded output and no Dispatcher lifecycle
mutation for internal `stopped` or unproven timeout.

Phase boundary:
`P5A COMPLETE = INTERNAL CANCEL AUTHORITY + STATE SAFETY + PROOF GATE`.
`P5A COMPLETE != PUBLIC ACTIVE CANCEL ACTIVATED`.
`P5A COMPLETE != PRODUCTION TREE CANCELLATION PROVEN`.
P5B emits accepted real-platform proof; P5C owns timeout/observation; P5D
activates public command surfaces.

## 11. No-rerun-until-green rule

Acceptance uses the first clean execution from the declared immutable P5 head.
Timing/race/platform tests use deterministic barriers, injected clocks, bounded
deadlines and failure artifacts. A flaky or irreproducible pass is a failure
and a stop condition. Every E04/E08 assertion must pass on one head with the
P4/M3 regression sets green.
