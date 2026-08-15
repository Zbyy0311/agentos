# AgentOS M4-P5 Cancellation, Process Tree, Timeout and Transport — Acceptance Test Matrix

Status: M4-P5 PRE-IMPLEMENTATION PLANNING — REMEDIATED PER INDEPENDENT PLAN REVIEW (DOCS ONLY) — TEST ARCHITECTURE FROZEN — NO TEST OR PRODUCTION IMPLEMENTATION AUTHORIZED

## 1. Traceability

`D` = deterministic automated evidence required. `R` = separately authorized
real-provider gate required. `N/A` allowed only with the reason shown.

| Exit gate | Unit | Contract | Integration | Platform | Recovery | Negative/mutation | Real Provider | Required proof |
|---|---|---|---|---|---|---|---|---|
| E04 Cancel covers owned Process Tree | D: stop ticket/state/race model | D: driver cleanup-result/survivor vocabulary | D: explicit Run cancel reaches Adapter graceful + Process tree once | D: Windows fallback owned-tree proof (required); POSIX group proof (POSIX host required, else PLATFORM_GATE_BLOCKED) | N/A: restart classification is P6-owned evidence, deferred to P6; P5 proves stopping/survivor facts pre-restart | D: root exits while grandchild survives; cancel must fail closed | R: bounded Kimi cancel + descendant check where safe | successful cancel requires verified no known/unknown survivor |
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
| CAN-06 | cancel during M3 `waiting_approval` | UNIT/INTEGRATION | routed through the frozen approval-cancellation composite: `approval.resolved` -> `stage.cancelled` -> `run.cancelled` via `resolveApprovalToCancellation` (OD-M4-P5-19); the ordering is asserted, not merely final status; paired Process joins the single stop pipeline with cancel causation; the generic cancel seam still rejects approval states |
| CAN-07 | cancel while output streams drain | INTEGRATION | finalization before terminal fact; artifacts finalized; bounded backpressure |
| CAN-08 | cancel vs natural exit | UNIT | first terminal observation wins; cancel causation retained (OD-M4-P5-07) |
| CAN-09 | cancel after Process exited, before Provider finalize | INTEGRATION | terminal Process fact committed; Provider finalize sees stop ticket; exactly one Session terminal |
| CAN-10 | cancel during Provider finalize | INTEGRATION | cancelled/failed finalization; one `provider.session_*` fact |
| CAN-11 | duplicate cancel (same key) | UNIT | joins first ticket; same result; one cleanup |
| CAN-12 | concurrent duplicate cancel | UNIT | CAS winner owns ticket; losers join; one terminal fact |
| CAN-13 | cancel after terminal completion | UNIT | existing result returned; no mutation; no duplicate Event |
| CAN-14 | cancellation failure (graceful fails) | UNIT | force still runs; result from tree verification |
| CAN-15 | survivor detected | UNIT/INTEGRATION | `orphaned` + `SURVIVORS`; cancel NOT successful; Run uncertainty preserved |
| CAN-16 | unknown tree ownership | UNIT | `orphaned` + `UNKNOWN_PLATFORM_UNAVAILABLE`; fail closed |
| CAN-17 | graceful-stop failure | UNIT | bounded progression to force |
| CAN-18 | force-kill failure | UNIT | `UNKNOWN_PLATFORM_UNAVAILABLE`/`PROCESS_TREE_TERMINATION_FAILED`; uncertainty |
| CAN-19 | P4 active-CAS-after-spawn closure (phase-split, OD-M4-P5-16) | INTEGRATION | coordination/state half (P5A, MockDriver): spawn succeeds -> activation CAS fails -> stop pipeline runs once -> Process `exited`/`orphaned`, Session `failed`, one terminal fact, no second spawn; full production tree-cleanup proof completes in P5B (real owned-tree termination + survivor verification against this schedule) |

## 3. Tree cases

| ID | Case | Class | Required assertions |
|---|---|---|---|
| TREE-01 | child process terminated | REAL OS CHILD | root+child absent after force; `complete` |
| TREE-02 | grandchild terminated | REAL OS CHILD | 3-level tree absent; `complete` |
| TREE-03 | no survivors | REAL OS CHILD | `verifySurvivors` = `complete`, empty list |
| TREE-04 | known survivor failure | REAL OS CHILD / UNIT | survivor PID reported (restricted); `SURVIVORS`; cancel fails closed |
| TREE-05 | already exited | REAL OS CHILD | `ALREADY_EXITED`; no signal attempted |
| TREE-06 | partial cleanup | REAL OS CHILD / UNIT | some members remain; `SURVIVORS` |
| TREE-07 | inaccessible process | ENV-GATED / UNIT | inspection `unknown`; no signal; fail closed |
| TREE-08 | identity mismatch (PID reuse) | UNIT / REAL OS CHILD | start-time/executable differs; `IDENTITY_MISMATCH`; no signal (OD-M4-P5-05) |
| TREE-09 | root exits while grandchild survives | UNIT mutation | cancel must NOT report success |

## 4. Windows cases

The REQUIRED Windows gate is the observable fallback owned-tree proof
(WIN-06). Job Object is an OPTIONAL FUTURE CAPABILITY SLOT (OD-M4-P5-04/05):
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

## 5. POSIX cases

Group creation mechanism is frozen in OD-M4-P5-05 / implementation plan §6.2:
the driver internally uses `detached: true` on POSIX only as the Node
group/session creation mechanism, with stdio piped, handle retained, no
`unref()`, PGID in `NativeIdentity.groupId`, and PGID/start revalidation
before every `-pgid` signal. Required POSIX real-OS evidence needs an actual
POSIX host/capability: if no such environment exists during P5 verification,
return `PLATFORM_GATE_BLOCKED` with evidence — do not silently skip and do
not claim full cross-platform P5 acceptance (OD/plan L-3).

| ID | Case | Class | Required assertions |
|---|---|---|---|
| POSIX-01 | process group TERM | POSIX-SPECIFIC | group created via driver-internal mechanism with OD-M4-P5-05 invariants; `-pgid` SIGTERM; group members receive it |
| POSIX-02 | grace interval | POSIX-SPECIFIC | injected clock; deadline honored |
| POSIX-03 | group KILL | POSIX-SPECIFIC | `-pgid` SIGKILL after grace; PGID/start evidence revalidated first |
| POSIX-04 | survivor verification | POSIX-SPECIFIC | group membership + descendants; complete/survivors/unknown |
| POSIX-05 | group escape attempt | POSIX-SPECIFIC | escaped member detected or `unknown`; fail closed |
| POSIX-06 | natural-exit race | POSIX-SPECIFIC | exit before signal -> `ALREADY_EXITED` |

## 6. Timeout cases

| ID | Case | Class | Required assertions |
|---|---|---|---|
| TO-01 | startup timeout | UNIT (fake clock) | `PROCESS_STARTUP_TIMEOUT`; stop pipeline; Process timeout reason; Provider `PROVIDER_START_FAILED`; Stage failed |
| TO-02 | idle timeout | UNIT | `PROCESS_IDLE_TIMEOUT` after no activity |
| TO-03 | activity resets idle | UNIT | each `notifyActivity` restarts full budget |
| TO-04 | total timeout | UNIT | `PROCESS_TOTAL_TIMEOUT` from native start |
| TO-05 | timeout vs exit | UNIT | first terminal observation wins; one terminal fact |
| TO-06 | timeout vs cancel | UNIT | first accepted stop reason owns; correlated diagnostics |
| TO-07 | approval-wait idle suspension | UNIT | `waiting` entered only from M3 `waiting_approval`; idle pauses; remaining budget resumes; total unaffected (OD-M4-P5-14) |
| TO-08 | simultaneous timeout/exit/cancel | UNIT | single `process.stopping` reason; single terminal fact |
| TO-09 | policy propagation | INTEGRATION | snapshot `startupTimeoutMs/idleTimeoutMs/totalTimeoutMs` reach the durable Process (audit CS-14 closure) |

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
| DUR-02 | Session state | INTEGRATION | starting/active -> cancelled/failed per OD-M4-P5-10; durability proven via `provider_sessions.status` + existing registered facts; `provider.session_cancelled` is NOT required (stays Registry-gated, OD-M4-P5-18) |
| DUR-03 | cleanup result | INTEGRATION | one of the five frozen values persisted |
| DUR-04 | termination reason | INTEGRATION | cancel/timeout/non-zero-exit etc. persisted |
| DUR-05 | survivor list | INTEGRATION | restricted redacted JSON; count only in public projection |
| DUR-06 | Event/Outbox parity | INTEGRATION | stop/terminal facts 1:1; atomic rollback |
| DUR-07 | replay/idempotency | INTEGRATION | replay returns prior evidence; no second stop/spawn |
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

Boundary guarantees after remediation: no P5 acceptance depends on
`provider.session_cancelled`; no P5 acceptance depends on server-shutdown
integration (P6-owned, OD-M4-P5-17); no P5 acceptance requires P6 restart
classification (P6-owned evidence); E04 still requires verified survivor
evidence everywhere.

## 11. No-rerun-until-green rule

Acceptance uses the first clean execution from the declared immutable P5 head.
Timing/race/platform tests use deterministic barriers, injected clocks, bounded
deadlines and failure artifacts. A flaky or irreproducible pass is a failure
and a stop condition. Every E04/E08 assertion must pass on one head with the
P4/M3 regression sets green.
