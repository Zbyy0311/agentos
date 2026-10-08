# AgentOS M4-P0 Pre-Implementation Acceptance Matrix

Status: TEST ARCHITECTURE FROZEN — NO TEST OR PRODUCTION IMPLEMENTATION AUTHORIZED

## 1. E01–E10 traceability

`D` means deterministic automated evidence is required. `R` means a separately
authorized real-provider gate is required. `N/A` is permitted only with the
reason shown; it is not missing evidence.

| Exit gate | Unit | Contract | Integration | Platform | Recovery | Negative/mutation | Real Provider | Required proof |
|---|---|---|---|---|---|---|---|---|
| E01 Run does not directly spawn | D: coordinator/RunEngine port spies | D: dependency/import contract | D: accepted Run -> one coordinator claim | N/A: authority is platform-neutral | D: replay/restart no spawn | D: forbidden-import and duplicate-dispatch mutation | R: Kimi path trace has no direct Run spawn | one Run/Stage attempt produces one root reservation through the full authority chain |
| E02 Adapter does not bypass Process Runtime | D: Adapter uses fake ProviderProcessPort only | D: Adapter package has no native handle/spawn import | D: Kimi launch observed at ProcessManager once | D: same Driver contract receives launch on Windows/POSIX | D: recovery never asks Adapter to spawn | D: replace Process port with rejecting spy; no fallback spawn | R: direct Kimi invocation still traverses port | no Adapter can spawn, PID-kill, write Process/Run DB or allocate Event sequence |
| E03 AgentOS Process ID != PID | D: allocator/PID reuse cases | D: identity/resource schema | D: Event/API carry `proc_*` plus numeric PID separately | D: native identity evidence differs per platform | D: same PID/wrong start identity rejected | D: substitute PID as Process ID and require rejection | R: Kimi evidence records distinct IDs | PID alone never allocates, queries, signals or recovers a Process |
| E04 Cancel covers owned Process Tree | D: idempotent stop state/races | D: Driver cleanup result/survivor vocabulary | D: explicit Run cancel reaches Adapter graceful + Process tree once | D: Windows Job/fallback and POSIX group fixtures | D: restart stopping/survivor classifications | D: root exits while grandchild survives; cancel must fail closed | R: bounded Kimi cancel plus descendant check where safe | successful cancel requires verified no known/unknown survivor |
| E05 raw output traceable | D: offsets/UTF-8/redaction/checkpoints | D: independent stream/reference schema | D: bytes -> restricted artifact refs -> Events/projection | D: CRLF/code page/binary/path cases | D: partial artifact/restart checkpoint integrity | D: sink failure, queue/frame/retention overflow and secret canaries | R: Kimi structured output has refs/hash and safe projection | no unbounded strings; source/retained offsets and truncation/finalization are durable |
| E06 selected Provider works end to end | D: Kimi parser/launch fixtures | D: Registry/Snapshot/Adapter version contract | D: fake Kimi canonical Run to Stage outcome | D: executable discovery/path wrapper contracts | D: interrupted Kimi remains uncertain, no restart | D: PlainText/OpenCode fallback prohibited | R: installed Kimi direct validation + bounded task | direct KimiCode through canonical chain; not OpenCode and not M4 final completion |
| E07 auth failure is stable | D: native auth strings/codes normalize | D: Provider error + ApiProblem contract | D: validation/start error -> Event/Operation/Stage via lifecycle owner | D: env/home/path values remain redacted | D: auth uncertainty never equals completion | D: inject token/stderr canaries and unknown auth text | R: safe unauthenticated fixture/account only when expressly authorized | stable `PROVIDER_AUTH_REQUIRED`/expired mapping, no credential/raw stderr leak |
| E08 disconnect does not terminate | D: subscriber dispose has no stop call | D: transport ownership contract | D: close socket, Process/Event/Run continue; explicit cancel works | D: Windows/POSIX Process remains alive after transport close | D: reconnect resumes persisted cursor/reference | D: mutate close handler to call stop and require architecture/E2E failure | R: Kimi task survives client close and reconnect | browser owns subscription only |
| E09 restart contract explicit | D: classifier matrix | D: recovery identity/classification schema | D: crash/restart scans active Process and updates uncertainty through M3 seam | D: same/missing/mismatch/unknown evidence per OS | D: full restart matrix and repeated scan | D: PID-only/success inference/automatic restart mutations rejected | R: optional controlled Kimi crash gate after deterministic proof | no guessed Provider success, automatic restart, destructive orphan cleanup or stream restore |
| E10 M3 contracts preserved | D: existing lifecycle/Event/idempotency units | D: envelope/Registry/ApiProblem compatibility | D: full M3 Run/Operation/Event/Outbox/SSE/Legacy regression | N/A: M3 semantics are platform-independent; platform suites still run integration | D: `recovery_required`/uncertainty regressions | D: duplicate Event/Outbox, sequence rollback and replay-spawn mutations | R: Kimi evidence bound to same M3 Events/Operation | no second lifecycle; Event/Outbox and transitions remain atomic and replay-safe |

Every row must pass on one immutable reviewed head. A narrower suite cannot
claim a broader exit gate.

## 2. Process unit cases

Future package-local deterministic tests must cover:

- canonical `proc_*` allocation distinct from PID; reservation before spawn;
- executable exists, missing, inaccessible and wrong type;
- explicit args/cwd/safe environment, shell false, command/arg/redaction limits;
- spawn success/failure, registration failure compensation, exit 0/non-zero,
  signal/native Windows exit evidence and stream-close-before-exit;
- every Process state/source transition, invalid transition, CAS conflict, stale
  claim epoch and terminal immutability;
- duplicate dispatcher/replay/concurrent tick and ownership loss before/after
  starting;
- startup, idle and total timers with injected clock; approved waiting pauses
  idle only; total continues according to frozen policy;
- repeated stop, `created` cancel before spawn-right consumption, `starting`
  cancel with null/present PID, running/waiting stop and stop after terminal;
- spawn/cancel, spawn-failure/cancel, exit/cancel, exit/timeout,
  timeout/cancel, shutdown/exit and duplicate-terminal races;
- independent stdout/stderr sequences; UTF-8 split/BOM/CRLF/lone CR/invalid
  bytes/binary; ANSI control filtering; JSONL split and oversize frame;
- backpressure high/low/hard watermarks, sink delays/errors, output cap,
  truncation, rolling segments, checkpoint idempotency and final hash;
- secret values split across chunks, at maximum supported size, strict-mode
  rejection and absence from all Events/errors/logs/artifacts after redaction;
- handle registration/removal and proof that missing handle is not Process exit.

All timer and race tests use barriers, fake clocks, explicit process fixtures or
observable events. They do not use unbounded waits or sleep as correctness.

## 3. Platform cases

One shared Driver contract suite runs against deterministic Mock, Windows and
POSIX implementations as applicable.

| Area | Windows evidence | POSIX evidence |
|---|---|---|
| launch | `.exe`; path/cwd with spaces and Unicode; separated args; hidden window; explicit `.cmd`/PowerShell wrapper policy | direct executable; spaces/Unicode; separated args; `shell=false`; owned process group/session |
| native identity | PID + creation/start time + executable identity + Job/group metadata | PID + `/proc`/platform start identity + executable + PGID/session metadata |
| tree fixture | parent -> child -> grandchild plus detached/escape attempt; Job assignment/nested Job behavior | parent -> child -> grandchild plus process-group escape attempt |
| graceful | Provider-neutral interrupt/console group/stdin capability with bounded deadline | SIGINT/SIGTERM to owned group with bounded deadline |
| force | Job Object preferred; bounded safely parameterized tree fallback when unavailable | SIGKILL to owned group |
| verification | root, known descendants, newly discovered descendants, survivor/unknown result | group membership plus known/escaped descendants, zombie reap, survivor/unknown result |
| failure | assignment denied, native assertion, handle close, `taskkill` unavailable/error, PID reuse, platform inspection unavailable | permission denied, group missing/reused, signal error, inspection unavailable |

`child.kill()` success, root exit or command exit status alone never proves tree
termination. Platform-unavailable and incomplete inspection return fail-closed
results.

## 4. Provider contract cases

Run the same contract harness for Kimi first, then each later Adapter:

- manifest identity, unique Adapter ID/version, Provider Types/runtime modes,
  capabilities and compatible config schema range;
- Registry duplicate/built-in overwrite/missing Adapter/incompatible version/
  disabled/archived config and deterministic lookup;
- exact Snapshot binding; replay cannot bind newer Adapter;
- Session authority uniqueness/fencing with no Process (API/remote mode) and
  paired Session + root Process fencing for CLI/process-backed mode;
- crash before and after Session `adapter_start_requested_at` persistence and
  before/after external Adapter start; marker is one-way and no takeover calls
  Adapter start twice;
- schema validation, executable discovery order, version supported/unsupported,
  auth authenticated/required/expired/failed/unknown, capabilities, cwd and
  output mode;
- validation is side-effect-light: no Session, config write, install or long-
  running Process; standalone validation does not invent Run/Event;
- canonical `kimicode` and Adapter `builtin.kimicode`; legacy `kimi` mapping and
  canonical-over-legacy environment precedence/conflict diagnostic;
- launch-plan command/args/cwd/env references and direct Kimi executable;
- Adapter can use only fake ProviderProcessPort/Event/Artifact/Secret ports;
- chunk framing/parser incomplete input, malformed/unknown events, binary,
  warnings, raw-event fallback and no semantic fabrication;
- specification Session states (`starting`, `active`, `waiting`, `paused`,
  `completed`, `failed`, `cancelled`) and terminal finalization exactly once;
  exit zero insufficient;
- stable Process/Provider error mapping, retryability, safe guidance,
  ApiProblem context and raw stderr/secret absence;
- native graceful cancel may fail while Process tree termination still proceeds.

## 5. Integration cases

Minimum deterministic integration scenarios:

1. Accept Start through M3 idempotency -> dispatcher -> RunEngine -> one Stage
   claim -> Session/root Process reservation -> Adapter/port/Manager/Driver.
2. Duplicate Start/dispatch/concurrent tick/replay converge on the same Process
   and Session IDs and call Driver spawn once.
3. Process reservation and launch Event exist before spawn; success registers
   native identity; failure compensates without an orphan active row.
4. stdout/stderr append independently to restricted sink; checkpoint Events
   carry correct references/offsets; normalized Provider Events preserve
   causation and Event order.
5. Process exit plus Adapter finalization returns typed outcome; only
   LifecycleTransactionService transitions Stage/Run and writes Event/Outbox.
6. exit zero with invalid/missing Provider final output fails; non-zero with a
   normalized Provider error preserves both Process and Provider facts.
7. explicit cancel routes once through M3 command, Adapter graceful request,
   Manager/Driver tree termination, output finalization and lifecycle mapping.
8. Legacy request translation cannot retain a competing CLIExecutor spawn after
   the canonical Stage claim; old status/log responses remain compatible
   projections.
9. Event/Outbox/repository/output failure injection rolls back or compensates
   exactly as the saga contract requires.
10. workspace/Run/Stage/Session/Process cross-binding is rejected without
    leaking foreign resource existence.

## 6. Cancellation/race cases

Each case records the first accepted stop reason, Process versions, Driver call
count, terminal Event count, output finalization count, tree result and final M3
outcome:

- cancel before reservation, after reservation while still `created`, during
  fenced `starting` with unresolved spawn, immediately after spawn, running,
  waiting, stopping and after terminal;
- two callers with same key, different keys/reasons and concurrent Run/Stage
  cancel; all join one Process stop;
- graceful Provider exit before deadline, at deadline and after force begins;
- root exits while child/grandchild remains; detached escape attempt;
- timeout vs explicit cancel, normal exit vs cancel, normal exit vs each timeout,
  server shutdown vs exit and recovery cleanup vs exit;
- PID reused between observation and signal; ownership epoch becomes stale;
- Driver graceful/force/inspection failure and platform unavailable;
- survivor disappears on bounded recheck versus remains/unknown;
- repeated native close/exit/error callbacks after terminal CAS.

Acceptance requires one terminal winner, no overwrite, no duplicate terminal
Event, no second spawn, no signal on mismatch, and no successful cancellation
when survivors are known or cannot be excluded.

The HIGH-1 `starting` x cancel remediation adds these five mandatory
deterministic schedules. A controllable fake Driver exposes `spawn-entered`,
`spawn-settle`, `tree-terminate-entered` and `survivor-result` barriers; the
repository exposes committed-version barriers. Tests advance only those
barriers and an injected clock, never sleeps or probability loops.

| ID | Forced schedule | Required assertions |
|---|---|---|
| RACE-S1 | Reserve `created`; hold start before its CAS; commit cancel first; then release start. | `created -> failed` with `cancelled-before-spawn`; spawn right is revoked; Driver spawn count 0; later/duplicate start returns the same terminal snapshot; exactly one terminal fact. |
| RACE-S2 | Commit `created -> starting`; block the entered Driver spawn before it settles, so PID remains null; commit cancel and inspect before releasing Driver. | `starting -> stopping`; null PID is not treated as unspawned; spawn count remains exactly 1; no `failed/cancelled-before-spawn`, no `running`, no second spawn; the stop ticket retains cancel causation while awaiting the single spawn result. |
| RACE-S3 | Continue RACE-S2 by releasing a successful spawn with a fixed PID/start/tree identity; make tree termination succeed and survivor verification return no survivors, while holding verification until state/evidence is inspected. | Late success binds native identity to the original Process ID and persists factual start evidence without a `running` transition; the existing stop ticket immediately invokes tree termination and survivor verification once; the Process reaches `exited` with one `process.exited` terminal fact carrying cancel causation; spawn count 1 and terminal fact count 1. |
| RACE-S4 | Continue RACE-S2 by releasing `PROCESS_SPAWN_FAILED` with deterministic redacted native evidence. | One `process.failed` terminal fact contains both the accepted cancel causation/stop reason and spawn-failure code/evidence; no `process.exited`, tree signal or replacement Process; spawn count 1 and no retry/takeover spawn. |
| RACE-S5 | At each RACE-S3/S4 terminal boundary, release duplicate start callers, duplicate cancel keys, a stale owner, recovery scan and duplicate late Driver callbacks in a fixed barrier order. | All callers join the original Process/stop result; state never returns to `running`; native identity cannot rebind to another Process; spawn count 1, cleanup/finalization at most once as applicable, exactly one terminal fact/Event, and conflicting late evidence is restricted diagnostic only. |

RACE-S1 proves that only `created` owns an unconsumed spawn right. RACE-S2--S5
prove that `starting` has consumed it regardless of PID visibility and that
cancel cannot convert that uncertainty into a second spawn.

## 7. Recovery cases

Start from each non-terminal Process state and crash at each persistence/native
boundary: before spawn, after spawn/before PID commit, after PID commit, after
stream checkpoint, during waiting, stopping, force, output finalization and
terminal Event transaction.

For each, test:

- same PID/start/executable/token/group evidence;
- process proven missing;
- same PID with different start/executable/token (PID reuse/mismatch);
- insufficient permissions/platform inspection/evidence (unknown);
- native process alive but no controllable handle;
- partial/truncated/unfinalized output artifact and checksum recovery scan;
- repeated recovery scan and two recovery workers with CAS conflict;
- Run already terminal versus active with `recovery_required` false/true;
- Provider native Session file present/absent/malformed;
- no automatic Provider start, generalized reattach, native resume, orphan kill,
  stream restoration or inferred completion.

Expected result is an evidence-backed Process classification Event and existing
M3 uncertainty behavior. PID present/absent, exit code, missing handle or native
Session file never proves Provider success.

## 8. Browser disconnect cases

- close HTTP request before Operation acceptance completes: command semantics
  follow the accepted API transaction, not Process ownership;
- close SSE immediately after accepted Start, during reservation/start/output/
  waiting/stop and before terminal projection;
- abort one of multiple subscribers; other subscriber and Process continue;
- disconnect/reconnect with Last-Event-ID/cursor and output-reference offset;
- slow subscriber triggers transport backpressure without Process queue growth
  or Process stop;
- client process crashes without sending cancel; execution continues;
- explicit Cancel while no subscriber exists still terminates through the
  canonical chain;
- server shutdown with connected/disconnected clients follows shutdown/recovery
  policy, not transport close;
- Conversation compatibility path eventually passes the same suite before it
  is considered migrated.

Tests spy on Adapter cancel and Process stop; disconnect alone must call neither.

## 9. Architecture-negative gates

Future static/dependency tests and runtime spies must fail when any forbidden
edge appears:

- `RunEngine`, `TaskRunService`, route modules and canonical Stage coordinator
  import `node:child_process` or a Platform Driver implementation;
- RuntimeProviderAdapter imports `node:child_process`, receives raw handle/PID
  kill, or imports Process/Run repositories or LifecycleTransactionService;
- ProcessManager/Driver imports Provider-specific package, Kimi/Codex/OpenCode
  parser, or maps Provider success;
- canonical M4 execution calls legacy `CLIExecutor.execute` spawn seam;
- replay/Event consumption/GET/SSE-close/browser-close invokes Adapter start or
  Process stop;
- Process ID derives from PID, Legacy Execution ID or command name;
- Registry silently selects PlainText for configured structured Provider;
- Process/Provider component allocates Run Event sequence or mutates Run/Stage;
- raw stdout is published directly as the only durable source;
- a new Runtime Event bypasses the reviewed Registry/Event/Outbox transaction.

Runtime mutation spies additionally replace each prohibited dependency with a
throwing sentinel; the supported path must still work through its allowed port.

## 10. Security/output gates

Required assertions:

- shell false and separated arguments by default; malformed executable, unsafe
  shell/wrapper, metacharacter injection and path traversal fail closed;
- cwd realpath/workspace/worktree ownership and symlink-race revalidation;
- safe environment allowlist/precedence; only requested secret references are
  resolved ephemerally; complete environment is never logged/persisted;
- secret canaries in args/env/stdout/stderr/native error/JSON split/ANSI/binary
  do not appear in rows, Events, ApiProblem, ordinary logs or public Artifacts;
- independent stream byte offsets survive UTF-8 splits and invalid/binary data;
- exact 64 KiB read, 1 MiB frame, 4 MiB per-stream, 8 MiB Process queue,
  64 MiB retained-stream, checkpoint and 2 KiB summary boundaries have tests at
  below/equal/above limits;
- high/low watermark pauses/resumes deterministically; hard overflow and sink
  failure stop fail-closed without dropping terminal facts;
- output rows/artifacts are restricted, opaque-path, append-only, hash-verified
  and workspace-authorized; finalized data cannot append;
- hidden reasoning/raw Provider data never becomes ordinary public Event;
- native PID/tree/recovery evidence and raw stderr are restricted;
- cross-workspace query/mutation returns non-leaking error behavior.

P0 defines no user-visible long-term retention/access policy. A later expansion
requires evidence and potentially an Owner Decision.

## 11. Schema gates

Before any future migration acceptance:

- exact DDL matches the three-resource P0 proposal or returns for contract
  reconciliation; no unreviewed fourth/fifth table;
- fresh DB and every supported migrations 001–013 upgrade produce identical
  schema/constraints/indexes/checksum state;
- no old Conversation rows/artifacts are backfilled or repurposed;
- ID/check/state/time/JSON/secret/terminal/output constraints reject invalid
  rows at database and repository boundaries;
- composite Workspace/Run/Stage/Session/Process relationships and `RESTRICT`
  behavior pass `foreign_key_check` and deletion tests;
- one primary Session/root Process claim per Stage attempt survives concurrent
  connections in process-backed mode; API/remote mode has one Session claim and
  no fabricated Process; stale Session or Process version/epoch cannot start,
  mutate or spawn;
- Session + Process reservation and Event/Outbox initial fact are atomic;
- output offsets/version/checkpoint/finalization races are monotonic and
  immutable;
- Event logical reference validation is transactionally enforced without
  rewriting accepted M3 history;
- backup/restore, failed migration, minimum app version and forward-only
  rollback are documented/tested;
- Migration number/file/registry remains absent until a separately authorized
  schema package names them exactly.

## 12. Kimi deterministic fixture gate

The required fake `kimi` executable is hermetic, non-networked and parameterized
to produce:

- valid structured stream split at every byte/UTF-8/JSONL boundary;
- stdout/stderr interleaving with independent sequence/offsets;
- native Session ID and final success/failure message;
- auth required/expired/failed strings and codes;
- malformed JSON, unknown event, binary/ANSI control, no final event and
  contradictory exit-zero/failure combinations;
- slow start, idle with heartbeat/no heartbeat, chatty/oversized output;
- graceful native interrupt success/failure and ignored interrupt;
- parent -> child -> grandchild plus controlled escape attempt;
- exit zero/non-zero/signal and race at cancel/timeout boundaries;
- secret canaries split across chunks and native diagnostics.

Fixture records its received executable/args/cwd/environment-key names and
invocation count, but never echoes secret values. Assertions prove canonical
`kimicode`, `builtin.kimicode`, direct Kimi invocation, Process port traversal,
one spawn, stable errors, safe output/Event mapping and no PlainText/OpenCode
fallback.

## 13. Kimi real gate requirements

The real gate is separate from deterministic CI and needs explicit phase
authorization. It records exact immutable code SHA, OS/architecture, Kimi
executable resolved path/fingerprint/version, Adapter/config versions, safe auth
state, fixture/task definition, timestamps, Process/Session/Event/Artifact IDs,
exit/tree/output hashes and relevant test logs.

Required scenarios are side-effect-light validation and one bounded disposable
task through the canonical Run chain; then explicit cancel/disconnect evidence
when safe and authorized. It must prove direct KimiCode CLI rather than OpenCode,
no secret/raw stderr leak, Process ID != PID, traceable output, one authority and
M3 terminal mapping.

No credential/login/install/config mutation is implicit. If the executable,
auth, network or provider service is unavailable, report `REAL_GATE_BLOCKED`
with evidence; deterministic gates cannot be replaced by retries and a blocked
real gate cannot be called PASS. Real Kimi success establishes only the P7
Core/Kimi gate, never M4 completion.

## 14. M3 regression set

Run the complete relevant existing M3 suite plus explicit M4 integration cases:

- Run/Stage allowed transitions, version/CAS and LifecycleTransactionService
  atomic mutations;
- Operation Start/Retry/Cancel states, ApiProblem binding and idempotency exact
  replay/mismatch/concurrency;
- per-Run Event sequence, Event append-only validation, unknown Event behavior,
  Event/Outbox 1:1 atomic rollback and Outbox fenced delivery/reclaim;
- Start acceptance, RunEngine claims, StageExecutor outcome validation and no
  duplicate execution;
- SSE query/visibility/replay/cursor/backpressure and persisted-only publication;
- TaskRunRecoveryService uncertainty, repeated recovery, terminal protection
  and `processFound`/`providerSessionFound` evidence compatibility;
- Legacy task route/status/log and Conversation compatibility without default
  switch, retirement or double authority;
- provider configuration/snapshot version/secret-reference semantics;
- fresh/upgrade migration registry/checksum tests when a schema phase is later
  authorized.

Any M3 failure is an M4 stop condition. M4 cannot weaken, skip or replace an M3
assertion to obtain green.

## 15. Mutation/failure injection

At minimum inject and prove detection/compensation for:

- uniqueness/CAS fence removed -> duplicate dispatcher test must spawn twice and
  mutation suite must fail;
- replay guard removed -> Provider start spy must fail;
- Event, sequence or Outbox insert fails at each boundary -> all roll back;
- OS spawn succeeds then PID/started/Event persistence fails -> tree cleanup and
  durable uncertainty/failure evidence, no second spawn;
- output sink append/checkpoint/finalize/hash/rename fails -> no evidenced
  success, queues remain bounded and Process stops according to contract;
- Adapter parser/finalize/normalize-error throws -> stable sanitized terminal
  failure through lifecycle owner;
- Driver graceful/force/inspect/dispose fails or hangs -> bounded timeout and
  survivor/unknown result;
- PID identity changes between checks -> no signal/reattach;
- terminal Event/native callback duplicates or arrives out of order -> one CAS
  winner and immutable result;
- secret redactor intentionally misses boundary-spanning value -> canary gate
  fails;
- browser close is wired to Abort/stop -> disconnect gate fails;
- ProcessManager imports Provider semantics or Adapter imports spawn -> static
  architecture gate fails.

Failure artifacts include exact seed/schedule, observed barriers, IDs/versions,
safe logs and platform capability result so the failure is reproducible.

## 16. Evidence required per future phase

| Phase | Minimum immutable evidence before independent acceptance |
|---|---|
| P0 | four required docs, exact accepted base, internal consistency checks, BLOCKER/HIGH zero author self-review, no implementation/migration, independent contract review pending |
| P1 | Process package diff/exports, deterministic unit/Mock Driver/stream/timer/race results, architecture negatives, old production path unchanged, no schema |
| P2 | separately authorized schema identity, fresh/upgrade/checksum/backup tests, repository CAS/concurrency, Event/Outbox atomicity, restricted output/security/failure injection |
| P3 | Registry/Adapter/version/config/validation contracts, fake Kimi fixtures, auth/error/redaction/API evidence, no Adapter spawn or Run mutation |
| P4 | one accepted Run/Stage -> one claim/Session/Process trace, duplicate/replay concurrency, LifecycleTransactionService/M3 regressions, compatibility routing without cutover |
| P5 | Windows/POSIX full tree fixtures, bounded graceful/force/survivor evidence, all cancellation races, disconnect/reconnect E2E |
| P6 | crash-point matrix, same/missing/mismatch/unknown classifications, PID reuse/no-guess/no-auto-restart, M3 `recovery_required` regressions |
| P7 | complete E01–E10 deterministic suite, separately authorized real Kimi evidence, Core/Kimi-only status, BLOCKER/HIGH zero |
| P8 | Codex through identical Process port, deterministic + authorized real evidence, Kimi/M3 regressions, no Provider-specific Process branch |
| P9 | evidence-backed OpenCode and bounded Custom CLI security/contracts, cross-Provider regressions; unavailable evidence leaves M4 open |
| P10 | Provider Session/Process Inspector/Recovery Record API authz/redaction/pagination/state contracts and any separately authorized schema evidence; no UI/M7 expansion |
| P11 | every Roadmap §§55/59 matrix row accepted or formally reconciled, all providers/APIs/recovery/E01–E10/M3/platform suites on one immutable head, final independent review |

Each phase records exact base/head, changed files, environment/tool versions,
commands/results, test counts/skips/retries, artifacts and unresolved findings.
No phase automatically authorizes the next.

Final-scope status is frozen exactly:

```text
P7  = CORE_KIMI_VERIFICATION_ONLY
P8  = CODEX_SECOND_PROVIDER_PROOF
P9  = OPENCODE_AND_BOUNDED_CUSTOM_CLI_FOUNDATION
P10 = PROVIDER_SESSION_API + PROCESS_INSPECTOR_API + RECOVERY_RECORD_BREADTH
P11 = ONLY_FINAL_M4_CLOSEOUT_GATE
```

Every explicit Roadmap §§55/59 deliverable remains
`REQUIRED_BEFORE_M4_CLOSEOUT` unless a separately authorized scope/spec
reconciliation says otherwise. P0 does not defer or remove any row.

## 17. No-rerun-until-green rule

Acceptance uses the first clean execution from a declared immutable head and
environment. A failure is investigated and classified; any remediation creates
a new head/evidence run and retains the failed evidence. The following are
forbidden as acceptance:

- rerunning unchanged flaky tests until one passes;
- increasing sleeps/timeouts without a demonstrated contract reason;
- weakening/removing assertions, scenarios, platform members or mutation;
- hiding skips/quarantine/expected failures;
- changing external Provider state without recording it;
- selecting only passing logs from multiple attempts.

Timing/race/platform tests use deterministic barriers, injected clocks, bounded
deadlines and failure diagnostics. A flaky or irreproducible pass is a failure
and stop condition.

## 18. P1 entry acceptance checklist

P0 author completion does not authorize P1. The checklist state before the
required independent P0 review is:

| Requirement | Author evidence | Independent gate |
|---|---|---|
| four exact P0 documents and no unauthorized files | COMPLETE | PENDING |
| single authority and exactly-once claim frozen | COMPLETE | PENDING |
| identity / `kimicode` mapping / state machine frozen | COMPLETE | PENDING |
| Manager/Driver/ProcessPort/Adapter/Registry boundaries frozen | COMPLETE | PENDING |
| Windows/POSIX tree, transport and recovery fail-closed contracts frozen | COMPLETE | PENDING |
| Process/Provider Events, errors, ApiProblem and M3 ownership frozen | COMPLETE | PENDING |
| raw output limits/backpressure/redaction/security frozen | COMPLETE | PENDING |
| exact schema proposal/verdict and Migration 014 prohibition | COMPLETE | PENDING |
| complete test/mutation/real-provider architecture | COMPLETE | PENDING |
| Roadmap final scope and P7/P11 distinction preserved | COMPLETE | PENDING |
| Owner Decision required before P1 | 0 | PENDING CONFIRMATION |
| Owner Decision required before P2 schema | 1 (`OD-M4-01`, UNDECIDED) | PENDING CONFIRMATION |
| author self-review BLOCKER/HIGH | 0 / 0 after final validation | PENDING |

Only an independent review with `BLOCKER = 0` and `HIGH = 0` may recommend:

```text
M4-P1 ELIGIBLE FOR SEPARATE ENTRY DECISION
```

Even then, a new explicit P1 authorization must name exact base, files/packages,
owner, tests and stop conditions. P1 implementation, M4 production, Migration
014, cutover, Ready and Merge remain NOT AUTHORIZED.
