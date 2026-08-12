# AgentOS M4-P0 Process & Provider Runtime Contract

Status: P0 CONTRACT FREEZE — DOCS ONLY — P1 AND PRODUCTION NOT AUTHORIZED

## 1. Metadata / exact base

| Field | Frozen value |
|---|---|
| Repository | `Zbyy0311/agentos` |
| Authoritative main | `af3c684a0585d654d785ace9666620ee46f37728` |
| Accepted preplanning HEAD / P0 previous HEAD | `8ce2dda39dd499ac8b31d2a11f80f5b8a768794f` |
| Branch | `docs/m4-process-provider-preplanning` |
| Accepted input | `M4-current-state-audit.md`, `M4-owner-decisions.md`, `M4-process-provider-runtime-implementation-plan.md` |
| Migration registry | `001`–`013` |
| Migration 014 | NOT CREATED / NOT AUTHORIZED / NOT RESERVED |
| Scope | Contract and current-state closure only; no code, tests, schema, migration, package, cutover, Ready or Merge |
| Freeze date | 2026-08-13 (Asia/Shanghai) |

Authority for this contract is, in order: the exact accepted repository state,
the merged M3 lifecycle/Event/Outbox/idempotency contract, the accepted M4
preplanning package, and the Runtime Specification target. Where target
vocabulary is not yet implemented, this document freezes the M4 proposal; it
does not claim implementation.

## 2. Authority chain

Exactly one canonical Provider execution path is allowed:

```text
Command/API acceptance
  -> existing M3 command + Operation/idempotency boundary
  -> scheduler/dispatch authority
  -> RunEngine
  -> StageExecutionCoordinator
  -> ProviderRegistry
  -> RuntimeProviderAdapter
  -> ProviderProcessPort
  -> ProcessManager
  -> PlatformProcessDriver
  -> owned OS process tree

facts return upward
  -> Runtime Event Factory / Event Store + Outbox
  -> LifecycleTransactionService
  -> canonical Run/Stage transition
```

No browser, route, Adapter, Process component, compatibility facade, or replay
consumer may create a parallel authority path. `LifecycleTransactionService`
remains the only canonical Run/Stage transition authority; Process and Provider
components report facts and outcomes only.

Forbidden target edges:

- route or `TaskRunService` -> Provider spawn;
- `RunEngine` -> `child_process` or platform driver;
- Adapter -> `child_process`, raw native handle, direct PID kill, or Process
  repository;
- ProcessManager -> KimiCode, Codex, OpenCode, or Provider parsing;
- Adapter -> Run/Stage repository or lifecycle transition;
- Event replay, HTTP/SSE close, or read projection -> Provider start/stop.

## 3. Responsibility table

| Layer | Sole responsibility | Must not own |
|---|---|---|
| Command/API + `TaskRunService` | validate and accept commands; enforce M3 Operation/idempotency/version contracts; return accepted resource/Operation | scheduling, spawn, Process state, Provider parsing |
| Scheduler/dispatcher | select accepted executable work; acquire one dispatch opportunity; call RunEngine | a second Run lifecycle, replay execution, Provider selection details |
| RunEngine | canonical Run/Stage orchestration and calls into the Stage execution seam | native Process creation, Provider protocol parsing, raw output storage |
| `StageExecutionCoordinator` | exactly-one authority for one Stage attempt; reserve the root Provider Session/Process chain; coordinate Provider facts with lifecycle outcomes | direct OS spawn, independent Run state machine |
| `ProviderRegistry` | resolve the exact frozen adapter identity/version compatible with the Provider Configuration Snapshot | fallback execution, Process control, Run mutation |
| `RuntimeProviderAdapter` | validation, launch-plan construction, Provider Session semantics, stream interpretation, finalization, normalized Provider errors | spawn/tree kill, sequence allocation, Run/Stage transition |
| `ProviderProcessPort` | narrow Provider-neutral access to validated launch, observation, graceful request, and Process facts | raw handles/PIDs, repository access, lifecycle mutation |
| `ProcessManager` | AgentOS Process identity, reservation, managed handles, bytes, timers, platform stop, Process facts, recovery classification | Provider semantics or final Run/Stage success |
| `PlatformProcessDriver` | OS creation, native identity/liveness evidence, tree ownership, bounded graceful/force termination and survivor verification | Provider behavior, persistence, Event sequence, Run state |
| Runtime Event Factory / Event Store / Outbox | validate drafts, allocate canonical per-Run sequence/ID/time, persist durable Event and Outbox atomically | Process or Provider interpretation |
| `LifecycleTransactionService` | decide and atomically persist canonical Run/Stage/Operation transition plus Event/Outbox | OS or Provider execution |
| Browser/transport | subscribe, reconnect, read projection, submit explicit commands | Process ownership or implicit cancellation |

## 4. Exactly-once execution claim

### Claim identity

The conceptual claim key is:

```text
(workspaceId, runId, stageId, stageAttempt, authorityRole)
authorityRole = primary-provider
```

The unique `provider_sessions` row is the durable Stage-attempt authority claim;
P0 introduces no second claim table or Run state machine.
`StageExecutionCoordinator`, through one application transaction/unit of work,
first asks the Registry-selected Adapter to perform side-effect-light validation
and build a launch plan. It then creates the Session claim and, for a process-
backed Adapter such as the initial Kimi CLI, invokes the Process reservation
port with that frozen plan for the root Process in the same transaction. The
root `runtime_processes` uniqueness is the process-backed enforcement companion,
not another authority. ProcessManager owns only the Process reservation; it
never creates or interprets a Provider Session. API/remote Sessions that need
no OS Process still use the same unique Session claim and do not fabricate a
Process.

The frozen order is:

```text
Registry resolves exact Adapter
  -> Adapter validate + buildLaunchPlan (side-effect-light; no start/spawn)
  -> atomic Session claim + optional root Process reservation + Event/Outbox
  -> CAS adapterStartRequestedAt
  -> Adapter start consumes preallocated Session
  -> bound ProviderProcessPort starts the preallocated Process when applicable
```

### Claim and fencing rules

1. A dispatcher may call Adapter start only after it creates/acquires the unique
   Session claim and CAS-persists its one-way `adapterStartRequestedAt` marker
   with the current Session claim epoch/owner. A process-backed dispatcher may
   spawn only after the paired root Process reservation CAS-transitions from
   `created` to `starting` with the current Process claim epoch/owner.
2. A duplicate dispatcher that loses Session uniqueness reads the same Session
   and paired Process when present. It observes/joins that authority evidence
   and never calls Adapter start.
3. Event or command replay reads existing evidence and never acquires a spawn
   right.
4. Concurrent ticks converge through uniqueness plus CAS; only the winning
   epoch may enter `starting`.
5. Ownership transfer is allowed only in one transaction when Session status is
   `starting`, `adapterStartRequestedAt` is absent, the recorded lease deadline
   is expired under the injected canonical clock, and expected Session
   version/epoch/owner all match. The winner increments epoch and installs a new
   owner/lease. In process-backed mode, paired root Process status must also be
   `created` with no PID/native-start evidence, and its expected version/epoch/
   owner must CAS in that same transaction. Elapsed wall time or lease expiry
   without these persisted conditions is insufficient.
6. Once `adapterStartRequestedAt` is durable, automatic takeover cannot call
   Adapter start again. Once Process `starting` is durable, takeover cannot spawn
   another root. A crash in either external-call window becomes uncertainty for
   the same Session/Process chain; at-most-once is preferred over guessed retry.
7. A stale owner must revalidate its epoch in the same transition that grants
   Adapter start or Process spawn. A failed CAS prohibits the external call.
8. Spawn failure terminalizes the reservation as `failed`. Spawn success
   followed by registration failure triggers immediate tree termination,
   durable failure evidence, and no second spawn.
9. A terminal claim is immutable. Retry or Provider fallback requires a new
   Stage attempt, never reuse of the old claim.
10. Restart scans the same Session claim and any paired Process reservation. It
    may classify evidence but may not infer success or create a replacement
    Session/Process chain for the same attempt.

Invariant:

```text
one accepted Stage attempt
  -> at most one authoritative active Provider Process chain
```

## 5. Identity glossary

No identity below may be inferred from a command name. All durable IDs use the
existing canonical allocator/prefix contract where one exists.

| Identity | Canonical owner | Durable? / creation point | User-visible? | Recovery-safe? | Equality rule |
|---|---|---|---|---|---|
| Workspace ID | Workspace aggregate | durable; workspace creation | yes | yes | may equal no other identity |
| Task ID | Task aggregate | durable; task creation | yes | context only, not Process proof | distinct |
| Run ID | M3 Run aggregate | durable; Run creation | yes | context only | distinct |
| Stage ID | M3 Stage aggregate | durable; Stage materialization | yes | context only | distinct |
| Stage Attempt | Stage aggregate | durable positive integer on Stage row; retry creates next attempt | yes | part of execution claim, not native proof | may repeat across different Stage IDs only |
| Agent ID | Agent Profile | durable; Agent creation | yes | context only | distinct |
| Provider Configuration ID | Provider Configuration | durable; config creation; version frozen in Run snapshot | yes | configuration evidence only | distinct |
| Provider Adapter ID | Provider Registry | durable in snapshot/manifest; adapter registration then snapshot | normally diagnostic | safe only with exact version | never Provider Type or config ID |
| Provider Session ID | Provider runtime | durable `psess_*`; reserved before Adapter start and atomically with the root Process when process-backed | yes/inspectable later | one recovery reference, not native proof alone | never Process ID or native session ID |
| AgentOS Process ID | ProcessManager | durable `proc_*`; reservation before spawn | yes/inspectable later | canonical Process key, but native identity still needs evidence | **never OS PID** |
| OS PID | Platform driver / OS | transient native attribute after spawn | restricted diagnostic | **never safe alone** | numeric value may be reused and cannot equal an AgentOS ID |
| Operation ID | M3 Operation aggregate | durable; command acceptance | yes | causation/idempotency only | distinct |
| Runtime Event ID | M3 Event Store | durable `evt_*`; Event Factory at append | yes according to visibility | historical fact only | distinct |
| Artifact ID | artifact/output sink | durable `artifact_*`; first output artifact reservation | restricted/public by classification | integrity evidence only | distinct |
| Legacy Execution ID | Conversation compatibility aggregate | durable only in old aggregate; legacy execution creation | compatibility-only | not valid M4 Process/Session proof | must never become Process or Session ID |

Provider-native Session ID is optional Provider metadata. It is not the
AgentOS Provider Session ID and cannot replace it.

Hard invariant: **AgentOS Process ID != OS PID**. Provider Session ID !=
AgentOS Process ID. Legacy Execution ID != either one.

## 6. `kimicode` / `kimi` mapping

The boundary is frozen as follows:

| Surface | Frozen value / rule |
|---|---|
| Canonical persisted/public Provider Type | `kimicode` |
| Canonical built-in Adapter ID | `builtin.kimicode` |
| Legacy `agent-core` compatibility token | `kimi` |
| Canonical executable override | `AGENTOS_KIMICODE_CLI` |
| Legacy executable override | `AGENTOS_KIMI_CLI` |
| Default executable name | `kimi` |

Future reconciliation occurs at the compatibility repository/DTO boundary and
the extracted Kimi Adapter registration boundary. Canonical snapshots,
Registry lookup, Events, APIs, and new persistence use `kimicode`; only legacy
inputs/outputs that already require `AgentProvider = 'kimi'` use `kimi`.

Executable precedence is Provider Configuration snapshot, canonical
`AGENTOS_KIMICODE_CLI`, legacy `AGENTOS_KIMI_CLI`, PATH `kimi`, then validated
known install path. If canonical and legacy overrides both exist and differ,
the canonical variable wins and a redacted internal diagnostic is required.
Command-name inference may assist discovery validation but never assigns
canonical Provider identity. P0 changes no shared type or specification.

## 7. Process state machine

P0 adopts the Runtime Specification vocabulary exactly:

| State | Entry and allowed next states | Terminal? | Required durable evidence | PID / live handle | Stop / restart rule |
|---|---|---:|---|---|---|
| `created` | unique reservation transaction; -> `starting`, `failed`, `unknown` | no | claim key, claim epoch/owner, launch snapshot, version, created time | PID absent; handle absent | stop may CAS to `failed` with cancelled-before-spawn reason; restart may reacquire only with fencing evidence |
| `starting` | winning fenced CAS before spawn; -> `running`, `stopping` only after PID exists, `failed`, `unknown` | no | start intent, claim epoch, timestamps, redacted launch facts | PID may be absent/present; handle may appear only after spawn | cancel before native spawn CAS-terminalizes `failed`; after spawn it enters `stopping`; restart never respawns automatically |
| `running` | registered native identity + stream/exit wiring; -> `waiting`, `stopping`, `exited`, `orphaned`, `unknown` | no | PID, native start identity, started fact, Process Event | PID required; controllable handle expected in current server | idempotent stop accepted; restart classifies identity |
| `waiting` | Provider/approval wait from running; -> `running`, `stopping`, `exited`, `orphaned`, `unknown` | no | wait reason and activity/timer checkpoint | PID normally present; handle expected in current server | idle timer pauses only for an approved reason; stop remains allowed |
| `stopping` | accepted stop/timeout/shutdown from any spawned active state; -> `exited`, `orphaned`, `unknown` | no | stop reason/key, deadline, version, stopping Event | PID may disappear; handle optional after restart | repeat stop joins same result; restart verifies before signaling |
| `exited` | authoritative close/exit/tree result after native start | yes | exit/signal, termination reason, times, output finalization and cleanup result | PID historical only; no live handle | returns prior result; immutable except archival metadata |
| `failed` | pre-running validation/spawn/registration failure or successful pre-spawn cancel | yes | stable error, phase, time, no live native ownership | PID absent, except registration-failure evidence after verified cleanup; no handle | immutable; no spawn/retry under same attempt |
| `orphaned` | native process/survivor is or may be alive but control/ownership is insufficient; -> `exited` after verified cleanup, `unknown` if evidence becomes insufficient | no | classification, known PIDs, cleanup requirement, identity evidence | PID may exist; trusted handle absent/insufficient | never report successful cancel; only verified no-survivor cleanup may terminalize |
| `unknown` | recovery cannot prove alive/missing/identity/terminal fact; -> `orphaned` on proven alive-but-uncontrolled/mismatch, `failed` when no managed running Process ever existed and missing/no-spawn is proven, `exited` when prior native start plus terminal/tree facts are proven; otherwise remains `unknown` | no | evidence inspected, missing evidence, classifier version/time | PID/handle may be unknown | no signal, spawn, success, or return to `running` under the M4 minimum; any terminalization uses recovery/unknown reason, never Provider success |

A Process that reached `running` terminalizes as `exited` even for non-zero,
signal, cancellation, or timeout; those meanings belong to
`terminationReason`. `failed` is reserved for failure before a managed running
Process exists (including registration failure after verified cleanup).

Every transition is CAS on expected version and allowed source state. The
winner writes the Process update and its durable Process fact atomically with
the M3 Event/Outbox chain where a Run Event is required. Race rules:

- spawn-success vs cancel: accepted cancel moves to `stopping`; a late running
  observation cannot overwrite it and termination proceeds;
- spawn-failure vs cancel: one CAS terminal winner; the loser returns the same
  terminal fact;
- exit vs cancel or timeout: observed exit wins terminal CAS if first; otherwise
  stop reason is retained while exit/tree evidence finalizes it;
- timeout vs cancel: first accepted stop reason owns the transition; later
  reasons are correlated diagnostics, not terminal overwrites;
- shutdown vs exit: same single terminal CAS rule;
- duplicate close/exit observations return the existing terminal result and do
  not emit another terminal Event.

## 8. ProcessManager conceptual contract

| Operation | Input -> output | Preconditions / side effects / durability | Idempotency / errors / races |
|---|---|---|---|
| `reserve` | frozen claim identity + preallocated Provider Session reference when applicable + validated redacted launch facts + timeout/security policy -> Process reservation | Run/Stage/snapshot/Session binding exists in the coordinator's transaction; creates only the `created` Process row; no Provider Session mutation and no OS action | unique claim returns existing reservation to duplicates; binding/claim conflict is explicit; no spawn on conflict |
| `start` | Process ID + claim epoch/owner + executable/args/cwd/safe env -> observation handle/facts | exact `created` CAS to `starting`; validate `shell=false` default, separated args, cwd, environment and policy; call Driver once; register identity/streams/timers; persist `running` or compensate to `failed` | repeated call observes existing state; stale epoch rejected; spawn/registration errors stable; cancel/start race follows section 7 |
| `observe` | Process ID + subscriber cursor -> bounded byte/fact subscription | workspace/Run ownership required; observation never owns Process; no lifecycle mutation; durable output checkpoints are sink-owned | reconnect resumes from durable reference/cursor; slow subscriber cannot grow Process memory or stop it |
| `stop` | Process ID + reason + idempotency key + bounded graceful/force policy -> opaque stop operation with durable `accepted` ticket and final result | logically two-phase: terminal returns prior result; `created` CAS-terminalizes `failed` with cancelled-before-spawn evidence; spawned active states verify native identity and persist `stopping` before `accepted`; only then may the coordinator request Adapter-native graceful behavior, while Manager executes bounded platform graceful/force/tree and finalizes output/facts; `unknown`/unverified identity permits classification but no signal | duplicate key/request joins the same accepted ticket/result; stale/invalid transitions cannot overwrite; mismatch/survivor/unknown fails closed; ProcessManager receives no Provider callback/parser and Provider-native graceful coordination remains outside it |
| `get/query` | scoped ID or Run filters -> immutable snapshot(s) | enforce workspace/authz and visibility; read only | repeatable; not found and forbidden remain distinct internally without leaking existence |
| `terminalize` | expected version + authoritative exit/spawn/cleanup evidence -> terminal snapshot | only allowed state transition; finalize each stream; append one terminal fact; remove live handle after durable commit | first CAS wins; duplicate observation returns winner; conflicting evidence retained internally but cannot overwrite |
| `recover/classify` | active Process facts + platform evidence + classifier version -> classification | no spawn; inspect PID/start/executable/token/group evidence; persist classification Event and preserve Run uncertainty | repeat classification is safe; identity mismatch prohibits signal; unknown remains unknown; recovery errors never imply success |

ProcessManager accepts no Run lifecycle callback, Provider parser, arbitrary
shell string, raw global environment, or Provider-specific package. Original
arguments and resolved secrets are ephemeral; durable diagnostics contain only
redacted arguments and environment key/source/classification.

## 9. PlatformProcessDriver contract

The Driver is an injected Provider-neutral port with these conceptual
capabilities:

| Capability | Contract |
|---|---|
| spawn | create one native root with explicit executable, argument array, cwd, safe environment, stdio and tree-ownership request; return opaque handle, PID, start identity, byte streams and close/exit observation |
| native identity | inspect PID plus start time, executable identity/path, parent/group and platform metadata without treating PID alone as ownership |
| liveness/tree | inspect the root and owned group/job, report completeness and known members |
| graceful stop | bounded platform signal/console/stdin capability selected by runtime policy; no Provider parsing |
| force tree stop | terminate the owned Job/process group or bounded fallback and return method, attempted members and errors |
| survivor verification | inspect root, known descendants and newly discovered descendants after force; classify complete/survivors/unknown |
| exit/close | distinguish native exit, stream close, handle disposal and tree cleanup; normalize signed/unsigned/hex Windows exit evidence internally |

No dependency/library is selected by P0. A future implementation must prove
capabilities with contract tests before adoption.

Windows prefers one Job Object per managed root with kill-on-close semantics
when feasible. Assignment failure/nested-job restriction is observable and
switches to a bounded fallback such as safely parameterized tree termination;
it never silently degrades to `child.kill()`. POSIX creates an owned process
group/session and signals that group, not just the root PID.

## 10. ProviderProcessPort contract

The Adapter receives only this narrow semantic surface:

| Request | Allowed result |
|---|---|
| validated launch | for process-backed Session, submit the frozen plan against the port-bound preallocated root Process ID; CAS-start that reservation and return the same AgentOS Process ID plus bounded observation surface; allocation of another root is forbidden |
| observe | subscribe to independent stdout/stderr chunks and Process facts with bounded queues/cursors |
| graceful request | request a Provider-neutral interrupt/close-stdin/graceful capability; runtime policy chooses allowed mechanism/deadline |
| Process facts | read immutable Process status, activity, exit, output references and cleanup result scoped to its Session |

The port never exposes native `child_process`, direct PID kill, Process or Run
repository, LifecycleTransactionService, Event sequence allocation, unrestricted
artifact access, or arbitrary command strings. It validates Session/Process
binding on every request. A process-backed port instance is bound to the
preallocated root reservation and rejects a different/missing Process identity,
Session binding, plan digest or claim epoch. Provider-native cancellation may use
this port only after the matching Process stop ticket is durably accepted; a
graceful request cannot create an independent stop authority. Force/tree
termination remains ProcessManager/Driver-owned.

## 11. RuntimeProviderAdapter contract

| Operation | Frozen responsibility |
|---|---|
| manifest/identity | declare Adapter ID/version, Provider Types, runtime modes, capabilities and compatible configuration schema versions |
| validate | side-effect-light schema, discovery, version, auth, capability, cwd and output-mode validation; never create Session or long-running Process |
| build launch plan | convert frozen configuration/snapshot into executable, separated args, cwd, environment references, protocol/framing and safe timeout suggestions |
| start Session | consume the preallocated Session, initialize/interpret Provider Session semantics and, when process-backed, request launch only through ProviderProcessPort |
| parse/normalize | incrementally interpret bounded chunks; emit canonical Event drafts or safe raw-event reference; never invent unsupported semantics |
| finalize | combine Process termination, parsed Provider facts and output contract; exit code zero alone is insufficient |
| normalize error | produce stable Provider code, phase, retryability, safe public guidance and redacted internal evidence |
| optional graceful request | request native protocol/interrupt behavior through constrained ports; it cannot force/kill the tree |

The Adapter cannot spawn, kill a tree, mutate Run/Stage, allocate Event ID/run
sequence/timestamp, write lifecycle tables, or persist secrets. It may emit
validated Event drafts through a sink; the M3 Event factory/store owns the
envelope and durability transaction.

Provider Configuration Snapshot freezes Provider Type, config version, Adapter
ID, Adapter version and compatible schema version. Replay resolves that exact
identity. Missing exact version returns a stable error; it never binds silently
to a newer incompatible Adapter.

## 12. ProviderRegistry contract

Registry key is `(adapterId, adapterVersion)`. A manifest contains Provider
Types, runtime modes, capabilities, built-in flag and compatible config schema
range.

- registration requires non-empty stable identity and unique key;
- duplicate key is a startup/configuration conflict, not last-writer-wins;
- built-in identities cannot be overwritten by extensions;
- pre-snapshot selection may list compatible adapters deterministically, but
  execution lookup uses the exact frozen key;
- missing key -> `PROVIDER_ADAPTER_NOT_FOUND`;
- incompatible snapshot/config version -> `PROVIDER_VERSION_UNSUPPORTED`;
- disabled/archived Provider Configuration is rejected before Adapter start;
- Registry mutation cannot replace an Adapter already bound to a Run;
- explicitly configured structured Providers have no silent PlainText fallback
  in canonical M4 execution.

Legacy PlainText fallback remains compatibility-only until its owning migration
phase and cannot count as M4 Provider success.

## 13. Cancellation/tree contract

Cancellation is coordinated once per accepted Process/Run command:

```text
explicit cancel accepted by M3 command boundary
  -> stop scheduling new Stage work
  -> StageExecutionCoordinator correlates active Session/Process
  -> ProcessManager validates identity, persists stopping, returns accepted ticket
  -> Adapter optional native graceful request through constrained ports/ticket
  -> bounded platform graceful request
  -> grace deadline
  -> Driver owned-tree force termination
  -> bounded terminal wait
  -> survivor verification
  -> output finalization + durable Process facts
  -> LifecycleTransactionService maps outcome to Stage/Run
```

Allowed cleanup results are `TERMINATED`, `ALREADY_EXITED`, `SURVIVORS`,
`IDENTITY_MISMATCH`, and `UNKNOWN_PLATFORM_UNAVAILABLE`.

All waits use observable deadlines and injected clock/timer seams; arbitrary
sleep is not a correctness primitive. PID reuse is checked before every signal.
Child exit is not tree proof. Known or unknown survivors mean cancellation is
not successful, produce cleanup-required evidence, and preserve Run uncertainty
where lifecycle outcome cannot be proven. Repeated cancel joins the first stop
and emits no duplicate terminal Event.

The coordinator waits for the Adapter-native request only within the already
persisted stop ticket's grace deadline. Adapter absence, crash, timeout or
failure does not prevent platform graceful/force progression. ProcessManager
never invokes Provider code and Adapter never extends the frozen deadline.

## 14. Transport ownership

HTTP, SSE and future WebSocket connections own subscriptions only.

- client disconnect releases subscriber resources and cursors; it never calls
  Adapter cancel, Process stop, Stage cancel, or Run cancel;
- reconnect reads persisted Events/output references and may resume an
  observation cursor;
- only an explicit authenticated cancel command may start section 13;
- server shutdown follows the Process shutdown/recovery policy, not a client
  disconnect callback;
- transport backpressure drops/coalesces only permitted ephemeral projection
  updates; it cannot drop durable terminal facts or grow Process queues without
  bound;
- Conversation compatibility must route to this boundary in its owning phase,
  but P0 changes no route behavior.

## 15. Minimum recovery contract

M4 recovery classifies the same durable Process; it does not implement M7
reattach/resume hardening.

Required evidence beyond PID is a sufficient combination of native process
start time, normalized executable identity/path, recovery-token hash/ownership
token, parent/group/job metadata and platform-specific identity. Recovery tokens
never appear in command arguments, ordinary Events, logs, or public APIs.

Allowed startup classifications:

| Classification | Minimum meaning / action |
|---|---|
| same process proven alive | identity evidence matches; record classification; M4 may monitor only through proven capability, not infer Provider outcome |
| process proven missing | identity lookup proves no matching process; record missing; lifecycle remains evidence-driven and never assumes Provider success |
| identity mismatch | PID exists but identity differs; never signal or attach; record mismatch/orphan risk |
| unknown | evidence is incomplete/contradictory/platform unavailable; preserve uncertainty and perform no destructive action |

Every active/uncertain Process classification is correlated with its Run. If
the Process or Provider result cannot be proven, `runs.recovery_required`
remains/set true through the existing M3 recovery seam. PID present/absent,
exit code alone, missing handle, or Provider session files never prove success.

P0/M4 minimum authorizes no automatic Provider restart, generalized reattach,
native resume, orphan destruction, or stream restoration.

## 16. Security invariants

1. Launch defaults to `shell=false`; executable and arguments remain separated.
2. Shell wrappers require explicit validated platform need and policy; no
   unescaped user string or PowerShell `-Command` concatenation.
3. cwd is resolved to a real workspace/worktree-owned path; traversal and
   unsafe symlink changes fail closed.
4. Environment starts from an allowlisted safe base. Only declared profile,
   Run override and ephemeral secret references are added.
5. Secret values and original sensitive arguments are ephemeral and never enter
   Process rows, Events, ordinary logs, ApiProblem, output references or debug
   bundles.
6. Raw stdout/stderr is restricted, bounded, scanned before persistence and
   referenced from ordinary Events; hidden reasoning is never copied to public
   Events.
7. Process/Session/output reads enforce workspace and Run binding; authorization
   failures do not leak cross-workspace existence.
8. Adapter cannot access global secret storage, Process repository, native
   handles, Run repository or lifecycle service.
9. Cancellation never signals a native identity that failed ownership checks.
10. Error details are stable/sanitized; raw stderr remains restricted evidence.
11. Native handle references are memory-only and never persisted as reusable
    handles.
12. Detached/daemon behavior is denied unless an explicit future policy and
    ownership contract authorizes it.

## 17. Compatibility boundary

- Existing M3 Run/Stage/Operation/Event/Outbox/idempotency/recovery semantics
  remain canonical and are not redefined.
- Existing Legacy and Conversation surfaces remain available until their owning
  authorized phase. Before a canonical Stage claim they may translate requests;
  after claim they cannot spawn, cancel, or finalize independently.
- Old `executions`, `run_cli_invocations`, old runtime artifacts and legacy
  diagnostic execution IDs remain compatibility data, never canonical Process
  or Provider Session truth.
- Existing direct-spawn paths remain inventoried and noncompliant until their
  owning phase; P0 neither accepts nor deletes them.
- P0 does not change Runtime Specification, shared types, routes, defaults,
  Provider implementation, migration registry, PR #45, or production behavior.
- KimiCode-first is sequencing only:
  `KIMI VERTICAL SLICE COMPLETE != M4 MILESTONE COMPLETE`.

## 18. P1 entry requirements

P1 may be declared **ELIGIBLE FOR A SEPARATE ENTRY DECISION** only after an
independent P0 review has `BLOCKER = 0` and `HIGH = 0`, all four P0 documents
are internally consistent, and an exact P1 base/files/owner are authorized.

The sole proposed P1 production package is the new
`packages/process-runtime/`, matching Process Runtime §104. The existing
`packages/*` workspace glob already covers it. P1 ownership is limited to the
package manifest/exports, Provider-neutral Process domain/ports,
ProcessManager foundation, launch validation/environment redaction, managed
handle registry, bounded stream/timer machinery, stable Process errors,
deterministic Mock Driver/test utilities and package-local tests.

P1 does not own schema/repository implementation, migrations, real Windows or
POSIX tree completion, startup recovery wiring, Provider core/adapters,
RunEngine/Stage integration, routes, `packages/agent-core`, or
`packages/shared`. Those remain injected ports/fakes or later-phase work.
Root/lockfile changes require explicit P1 evidence and authorization.

No Owner Decision is currently required before P1. P1 implementation remains
NOT AUTHORIZED by P0.

## 19. Stop/no-go conditions

Stop the active future phase and require re-entry if any occurs:

- base or accepted contract drifts without authorization;
- more than one authority can spawn for one Stage attempt;
- replay or duplicate dispatch can start Provider execution;
- Process ID is PID-derived or recovery relies on PID alone;
- Adapter can spawn/kill/mutate lifecycle or ProcessManager parses Provider
  semantics;
- tree ownership/survivor verification cannot fail closed;
- output buffering, frame size, queue, retention, or secret handling is
  unbounded/undefined;
- browser disconnect can stop canonical execution;
- recovery guesses success, restarts Provider, or signals mismatched identity;
- M3 Event sequence, Event/Outbox atomicity, lifecycle, Operation or idempotency
  semantics regress;
- schema/migration work lacks separate authorization;
- a Roadmap §§55/59 deliverable is removed/deferred without authorized
  reconciliation;
- P0/P1 is presented as production cutover, Ready, Merge, or M4 completion;
- an independent `BLOCKER` or `HIGH` remains open.

P0 completion authorizes no implementation action.
