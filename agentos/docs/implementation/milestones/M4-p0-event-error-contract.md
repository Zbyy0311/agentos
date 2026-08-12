# AgentOS M4-P0 Process & Provider Event and Error Contract

Status: P0 CONTRACT DRAFT — M3 REGISTRY UNCHANGED — NO IMPLEMENTATION AUTHORIZATION

## 1. Process fact/event vocabulary

All entries are Event drafts until their owning future phase extends the
accepted M3 Registry. `process.launch_requested`, `process.started`,
`process.stopping`, `process.exited`, `process.orphaned`,
`process.cleanup_required`, `process.recovered` and
`process.recovery_failed` reuse Runtime Specification names. Three P0 additions
are explicitly marked.

| Event / fact | Trigger and payload | Source / visibility / durability | Required refs / lifecycle authority |
|---|---|---|---|
| `process.launch_requested` | durable reservation committed; `processType`, redacted executable/args/cwd, claim epoch/role, shell, timeout-policy digest | `process-manager`; internal; durable | Run, Stage, Process, Session for Provider root; causation is accepted command/dispatch claim; cannot transition Run/Stage |
| `process.started` | native identity registered and streams/exit watcher wired; PID, native-start time, platform/tree mode, started time | `process-manager`; internal; durable | Run, Stage, Process, Session; caused by launch request; fact only |
| `process.failed` **(P0 addition)** | reservation ends before managed running state; outcome `spawn-failure`, `registration-failure`, or `cancelled-before-spawn`; stable Process code only for failure outcomes, phase and cleanup result when native spawn partially occurred | `process-manager`; internal/restricted; durable | Run, Stage, Process, optional Session; caused by launch request or pre-spawn cancel; LifecycleTransactionService decides Stage/Run outcome |
| `process.output_reference_advanced` **(P0 addition)** | first retained bytes, each checkpoint and finalization; stream, artifact ID, prior/next source offsets, retained bytes, truncated/finalized flags | `process-manager`; restricted; durable | Run, Stage, Process, Session, Artifact; caused by started/prior checkpoint; no lifecycle transition |
| `process.stopping` | first accepted stop/timeout/shutdown request; reason, graceful requested, grace/force deadlines, idempotency-key hash | `process-manager`; internal; durable | Run, Stage, Process, Session; caused by explicit Cancel/timeout/shutdown; lifecycle service may consume only as non-terminal evidence |
| `process.exited` | one terminal native/cleanup observation; exit code/signal, termination reason, duration, graceful/force flags, cleanup result and output refs | `process-manager`; internal, safe projection may be public; durable | Run, Stage, Process, Session and output Artifacts; one per Process; LifecycleTransactionService decides Stage/Run outcome |
| `process.cleanup_required` | tree stop cannot prove complete; result `SURVIVORS`, `IDENTITY_MISMATCH`, or `UNKNOWN_PLATFORM_UNAVAILABLE`, restricted known-PID count and safe reason | `process-manager`; restricted; durable | Run, Stage, Process, Session; caused by stopping/recovery; lifecycle service preserves uncertainty/failure as contract dictates |
| `process.orphaned` | same/mismatched native process is alive but not safely controlled, or known survivor exists; classification and cleanup-required flag | `recovery-manager` or `process-manager`; restricted; durable | Run, Stage, Process, Session; cannot itself claim successful cancellation |
| `process.recovery_classified` **(P0 addition)** | one recovery scan result: `same`, `missing`, `mismatch`, or `unknown`; evidence checks, classifier version/time, action `monitor-none`/`preserve-uncertainty` | `recovery-manager`; restricted; durable | Run, Stage, Process, optional Session; caused by recovery scan; lifecycle service alone updates `recovery_required`/Run state |
| `process.recovered` | optional compatibility projection only when `same` is proven and an allowed monitor capability is established | `recovery-manager`; internal; durable | same refs; caused by recovery-classified; never means Provider success |
| `process.recovery_failed` | classifier operation itself fails or required evidence is unreadable; stable Process error and retryability | `recovery-manager`; restricted; durable | same refs; preserves uncertainty; never terminal success |

`process.failed`, `process.output_reference_advanced` and
`process.recovery_classified` require future P2 Registry/schema review. They
must not be emitted as unknown production events before that gate.
`process.exited` is emitted for every Process that reached running, including
non-zero, signal, cancel and timeout; those meanings are payload facts, not
separate terminal states. Pre-running failure uses `process.failed`, so every
state transition still has a durable fact without pretending a native Process
exited.

Secret rule for every Process row above: payloads contain only redacted launch
facts, safe stable codes, bounded counters/classifications and restricted
references. No original argument/environment value, recovery token, raw output,
raw stderr, native handle or hidden reasoning is allowed.

## 2. Provider fact/event vocabulary

| Event / fact | Trigger and payload | Source / visibility / durability | Required refs / lifecycle authority |
|---|---|---|---|
| `provider.validation_started` | Run-bound validation begins; Provider Type, config ID/version, Adapter ID/version, cache-use flag | `provider-adapter`; internal; durable | Run and Provider Config; Session/Process absent; causation is start validation command |
| `provider.validation_completed` | valid or invalid typed result; Provider Type, valid, resolved executable fingerprint, CLI version, auth state, capabilities, warnings, checked time | `provider-adapter`; internal; durable | Run/Provider Config; no Session/Process; may block start, but lifecycle service maps outcome |
| `provider.validation_failed` | validation infrastructure/protocol cannot produce a result; stable code, phase, retryable, safe message | `provider-adapter`; internal; durable | Run/Provider Config; no raw stderr; lifecycle service maps outcome |
| `provider.session_started` | Session enters specification state `active`; Provider Type, Adapter ID/version, runtime mode, native Session ID presence, capabilities | `provider-adapter`; internal, safe projection may be public; durable | Run, Stage, Provider Config, Session, root Process when CLI-backed; caused by Process started/readiness |
| `provider.diagnostic` **(P0 addition)** | normalized non-terminal Provider diagnostic/error; severity, stable code, phase, retryable, safe summary, optional restricted evidence Artifact | `provider-adapter`; internal or restricted; durable for errors/security, ephemeral only for safely droppable progress | Run, Stage, Config, Session and Process when CLI-backed; cannot transition lifecycle directly |
| `provider.raw_event` | unsupported native structured event reference; native type, raw Artifact ID and bounded safe summary, fidelity marker | `provider-adapter`; restricted; durable only when needed for audit | Run, Stage, Config, Session, optional Process/Artifact; compatibility diagnostic, not primary UI protocol |
| `provider.session_completed` | exactly one successful finalization; duration, Provider-reported success, output-contract satisfied, safe summary and Artifact IDs | `provider-adapter`; internal, projection may be public; durable | Run, Stage, Config, Session, optional Process/Artifacts; LifecycleTransactionService decides Stage success |
| `provider.session_failed` | exactly one failed finalization; stable code, phase, retryable, native code, safe summary, partial Artifact IDs | `provider-adapter`; internal/restricted; durable | same refs; LifecycleTransactionService decides failed mapping |
| `provider.session_cancelled` **(P0 addition)** | exactly one successful cancellation finalization; cancellation reason, native-cancel attempted/succeeded, partial Artifact IDs, duration | `provider-adapter`; internal, safe projection may be public; durable | same refs; caused by explicit cancel and final Process cleanup fact; LifecycleTransactionService alone decides cancelled mapping |

There is no generic `provider.finalized` alias. Exactly one of
`provider.session_completed`, `provider.session_failed`, or the P0 draft
`provider.session_cancelled` finalizes a Session. The addition reconciles the
specified cancelled Session state/Cancel sequence with the current Event Model,
which lacks a cancelled terminal Event. P3 must complete explicit
spec/Event-registry reconciliation before emitting it; successful cancellation
must not be mislabeled as Provider failure.

Standalone Provider Validation has no Run and therefore cannot enter the M3
Runtime Event Store, whose envelope requires a real Run. It returns the typed
result and may use a bounded non-authoritative cache. A future System Event
Store or durable validation-history product requires separate evidence; no fake
Run is permitted.

Secret rule for every Provider row above: payloads contain no credential,
secret-profile value, full environment, raw prompt/output/stderr, OAuth state or
unredacted native message. Such evidence is omitted or represented by an
authorized restricted Artifact reference and a bounded safe summary.

## 3. Event envelope/reference mapping

Every M4 durable fact uses the accepted `RuntimeEventEnvelope` unchanged:

- Event Factory allocates canonical `evt_*`, schema version, persisted UTC
  timestamp and strictly increasing `sequence` from the Run;
- `workspaceId` and `runId` are always required;
- Process events require `processId`; Provider Session events require
  `providerSessionId`; CLI Session events normally carry both;
- Stage execution facts require `stageId`; validation before Session carries no
  Session/Process reference;
- Provider facts carry `providerConfigId`; Session-start/terminal facts also
  carry `agentId` when bound to a frozen Agent;
- output checkpoint carries `artifactId` for exactly one stream artifact;
- `correlationId` is inherited from the accepted Operation/Run execution chain;
- `causationId` points to the command or immediately causal Event ID;
- `parentEventId` expresses nested Event hierarchy only and never substitutes
  for causation;
- payload schema version starts at 1 and unknown optional fields are
  forward-compatible; required semantic changes require a version change.

M4 resources and envelope references must share Workspace/Run/Stage. Future
write paths validate this in the same transaction even though the accepted M3
Event table does not yet have physical Session/Process/Artifact FKs.

## 4. Durability / visibility / source

| Class | Durability | Visibility | Source rule |
|---|---|---|---|
| reservation, started, stop request, exit, cleanup/survivor, recovery classification | always durable | internal or restricted; public projection is separately sanitized | OS facts from `process-manager`; restart facts from `recovery-manager` |
| validation outcome used by a Run, Session start/terminal, normalized Provider error | always durable | internal/restricted; safe user projection allowed | `provider-adapter` draft, canonical envelope from Event Factory |
| raw output/reference/hash/truncation | reference/checkpoint durable, bytes in restricted sink | restricted | `process-manager` owns bytes and reference facts |
| heartbeat/high-frequency progress | ephemeral unless selected recovery checkpoint | internal | source component; may be dropped/coalesced |
| Run/Stage transition | durable | existing M3 contract | `run-engine`/lifecycle transaction, never Process/Adapter |

Durable M4 Events are appended only through the accepted Event Store and one-to-
one Outbox path. Direct DB insert, direct SSE publication, or stdout-only
publication is forbidden.

## 5. Ordering / correlation / causation

Per-Run `sequence` is the only canonical total order. stdout and stderr retain
independent local stream sequence/byte offset; cross-stream arrival order is not
claimed. Native Provider sequence is metadata only.

Minimum causal chains:

```text
accepted command/dispatch claim
  -> process.launch_requested
  -> process.started
  -> provider.session_started
  -> process.output_reference_advanced (zero or more)
  -> process.exited
  -> provider.session_completed | provider.session_failed
  -> LifecycleTransactionService Run/Stage Event
```

```text
explicit cancel | timeout | shutdown
  -> process.stopping
  -> process.exited | process.cleanup_required
  -> provider.session_cancelled when cleanup proves successful cancellation
     | provider.session_failed when cancellation/finalization fails
  -> LifecycleTransactionService terminal/uncertainty Event
```

Concurrent producers do not pre-assign sequence outside the Event transaction.
Out-of-order native facts are timestamped/offset internally but appended in the
order observed by the canonical transaction. Duplicate native observations are
deduplicated by Process/Session terminal CAS, not by rewriting Event history.

## 6. Lifecycle ownership

ProcessManager and Adapter return facts/outcomes. They may propose Event drafts
but cannot update Run/Stage status or allocate canonical Event identity/order.

`StageExecutionCoordinator` correlates the unique Stage attempt, Process and
Session facts and returns a typed Stage execution outcome. RunEngine invokes
`LifecycleTransactionService`, which alone validates the current Run/Stage/
Operation version and atomically writes the transition, Event and Outbox.

Process exit does not equal Stage success. Provider exit code zero does not
equal Provider success. Adapter finalization additionally considers Provider
terminal messages, parse errors, output contract, artifacts, cancellation and
normalized errors. A diagnostic Event severity never directly decides Run
state.

## 7. Stable Process errors

P0 uses Runtime Specification names when they are more precise. Requested
candidate aliases are explicitly reconciled below. `HTTP` applies only when the
error is returned synchronously by an API; asynchronous execution stores the
same stable code in Operation/Event evidence.

| Frozen code | Candidate reconciliation / phase | HTTP | Retryable | Public detail / internal evidence | Run/Stage mapping owner / stderr |
|---|---|---:|---|---|---|
| `PROCESS_EXECUTABLE_NOT_FOUND` | unchanged; validation/start | 422 | no without config change | safe executable/config guidance; resolved search paths restricted | LifecycleTransactionService maps pre-start failure; raw stderr never public |
| `PROCESS_EXECUTABLE_NOT_ACCESSIBLE` | spec addition; validation/start | 422 | no without permission change | safe permission guidance; native EACCES/EPERM internal | lifecycle owner; no raw stderr |
| `PROCESS_SPAWN_FAILED` | replaces candidate `PROCESS_START_FAILED`; spawn | 503 | yes only for classified transient resource/race, otherwise no | safe start failure; native code/redacted message/platform evidence internal | lifecycle owner maps Stage failure; no raw stderr |
| `PROCESS_REGISTRATION_FAILED` | spec addition; post-spawn registration | 500 | no automatic retry | generic public detail; cleanup/tree/persistence evidence restricted | lifecycle owner preserves failure/uncertainty; no raw stderr |
| `PROCESS_STARTUP_TIMEOUT` | replaces `PROCESS_START_TIMEOUT`; readiness | 503 | phase/policy dependent, never same attempt auto-spawn | limit and suggested action; activity/readiness evidence internal | lifecycle owner; no raw stderr |
| `PROCESS_IDLE_TIMEOUT` | unchanged; runtime | 409 | no automatic same-attempt retry | safe timeout reason/limit; activity checkpoints internal | lifecycle owner maps timeout |
| `PROCESS_TOTAL_TIMEOUT` | unchanged; runtime | 409 | no automatic same-attempt retry | safe timeout reason/limit; timer evidence internal | lifecycle owner maps timeout |
| `PROCESS_CANCEL_FAILED` | replaces broad `PROCESS_STOP_FAILED`; cancellation coordinator | 409 | retry stop may be safe under same idempotency key | generic incomplete cancellation; method/errors restricted | lifecycle owner must not report cancelled success; no raw stderr |
| `PROCESS_TREE_TERMINATION_FAILED` | precise force-tree failure | 503 | yes for bounded cleanup re-entry only | generic cleanup failure; platform method/native errors restricted | lifecycle owner preserves uncertainty |
| `PROCESS_SURVIVORS_DETECTED` | replaces `PROCESS_TREE_SURVIVORS`; verification | 409 | cleanup may be retried under policy | safe “cleanup incomplete”; survivor identities restricted | lifecycle owner cannot mark cancel complete |
| `PROCESS_IDENTITY_MISMATCH` | retained P0 code for any ownership mismatch before signal/recovery | 409 | no until fresh evidence | safe mismatch; compared PID/start/executable/token/group evidence restricted | lifecycle/recovery owner preserves uncertainty; no stderr |
| `PROCESS_PID_REUSED` | spec-compatible specialized identity mismatch | 409 | no | same public policy; old/new identity evidence restricted | recovery/lifecycle owner |
| `PROCESS_RECOVERY_UNKNOWN` | retained P0 classification code when evidence cannot decide | 503 | yes only by later scan with stronger evidence | safe “state cannot be verified”; missing checks internal | recovery supplies fact; LifecycleTransactionService owns Run uncertainty |
| `PROCESS_RECOVERY_FAILED` | classifier operation failed, distinct from unknown result | 503 | normally yes | generic recovery failure; native/repository error internal | same owner split |
| `PROCESS_OUTPUT_LIMIT_EXCEEDED` | unchanged; output | 409 | no automatic retry | limit/truncation safe; byte counts and policy internal | lifecycle owner only if policy terminates; stderr never public |
| `PROCESS_ARTIFACT_WRITE_FAILED` | spec addition; output sink | 500 | bounded retry before fail-closed stop | generic traceability failure; sink error/path restricted | lifecycle owner; execution cannot claim fully evidenced success |
| `PROCESS_MANAGER_SHUTTING_DOWN` | spec addition; pre-start | 503 | yes via later dispatch, same claim evidence | safe retry guidance; shutdown mode internal | scheduler/lifecycle owner; no spawn |

`PROCESS_EXIT_UNKNOWN` remains available when native terminal facts are missing
after an otherwise terminal observation; it is not an alias for recovery
classification. Unknown Process codes map to `PROCESS_UNKNOWN_ERROR`, 500,
non-retryable by default, with restricted evidence.

## 8. Stable Provider errors

| Frozen code | Phase / candidate reconciliation | HTTP | Retryable | Public detail / internal evidence | Run/Stage mapping owner / stderr |
|---|---|---:|---|---|---|
| `PROVIDER_NOT_FOUND` | discovery; unchanged | 404 | no without configuration/install change | safe Provider missing guidance; search evidence restricted | LifecycleTransactionService maps pre-start failure; no raw stderr |
| `PROVIDER_CONFIG_INVALID` | validation; unchanged | 422 | no without config change | field-safe errors; no secret values | lifecycle owner |
| `PROVIDER_ADAPTER_NOT_FOUND` | Registry; unchanged | 409 | no without install/version change | Adapter ID/version safe; Registry inventory internal | lifecycle owner |
| `PROVIDER_VERSION_UNSUPPORTED` | validation/Registry; unchanged | 422 | no without version/config change | safe supported-version guidance; raw probe output restricted | lifecycle owner |
| `PROVIDER_AUTH_REQUIRED` | authentication; unchanged | 409 | no without user action | login/validation guidance; no token/cookie/env | lifecycle owner; stderr never public |
| `PROVIDER_AUTH_EXPIRED` | spec addition; authentication | 409 | no without user action | reauthentication guidance; credential evidence never persisted | lifecycle owner |
| `PROVIDER_AUTH_FAILED` | retained for explicit credential rejection not equivalent to missing/expired auth | 409 | no without user action | generic auth failure; native code/redacted message internal | lifecycle owner |
| `PROVIDER_VALIDATION_FAILED` | infrastructure/protocol validation failure; unchanged from Event contract | 503 | only if classified transient | safe validation failure; phase/probe evidence restricted | lifecycle owner |
| `PROVIDER_PROTOCOL_ERROR` | retained umbrella for framing/state-machine protocol violation not merely output syntax | 422 when returned synchronously | usually no; transient only by Adapter classification | safe protocol mismatch; raw frame Artifact restricted | lifecycle owner |
| `PROVIDER_OUTPUT_PARSE_FAILED` | spec precise parse failure | 422 when synchronous, otherwise N/A | no by default | safe parse failure; raw output reference/internal parser evidence | lifecycle owner after finalization |
| `PROVIDER_OUTPUT_INVALID` | parsed output violates required contract; unchanged | 422 | no by default | safe missing/invalid contract detail; restricted output reference | lifecycle owner |
| `PROVIDER_FINALIZATION_FAILED` | retained P0 code for Adapter finalization exception | 500 | no automatic same-attempt retry | generic finalization failure; redacted stack/context internal | lifecycle owner; never expose stderr |
| `PROVIDER_START_FAILED` | spec addition; Provider startup/readiness semantics after Process starts | 503 | Adapter-classified only | safe start guidance; Process/diagnostic refs internal | lifecycle owner |
| `PROVIDER_SESSION_FAILED` | spec terminal Provider failure with no more precise code | N/A for asynchronous Run; 503 if a synchronous transient start fails, otherwise 500 | Provider-classified | safe summary; native code/redacted message/references internal | lifecycle owner |
| `PROVIDER_CANCEL_FAILED` | native graceful cancel failed; Process tree stop still proceeds | 409 | stop may continue/retry under same key | safe native cancel warning; internal native evidence | lifecycle owner uses final tree result, not this error alone |
| `PROVIDER_RATE_LIMITED` | runtime | 429 | yes with validated `retryAfterMs` | safe limit detail/action; headers/native evidence internal | lifecycle owner; retry requires new attempt/policy |
| `PROVIDER_NETWORK_ERROR` | runtime | 503 | yes when transient | generic network guidance; endpoint/stack restricted | lifecycle owner |

Unknown native failures map to `PROVIDER_UNKNOWN_ERROR`, 500, non-retryable by
default. Adapter may upgrade retryability only from explicit Provider evidence.
Raw stderr is never public for any Provider error.

## 9. ApiProblem mapping

The existing exact envelope remains:

```text
type, title, status, code, detail, instance, requestId, retryable,
optional retryAfterMs, suggestedAction, errors, context
```

Mapping rules:

- malformed request/body -> 400 `VALIDATION_FAILED`;
- missing scoped resource -> 404 with stable resource error;
- semantically invalid Process/Provider configuration or unsupported version ->
  422;
- already claimed/terminal, identity/fence/version/cancel conflict, timeout or
  auth action required -> 409;
- rate limit -> 429 with validated non-negative `retryAfterMs` when known;
- transient spawn/network/platform/validation/recovery unavailability -> 503;
- deterministic Provider protocol/output incompatibility -> 422;
- internal persistence/finalization/sink/invariant failure -> 500 with generic
  detail.

Provider Validation may return HTTP 200 with `valid=false` when the published
response contract treats validation failures as data; malformed request and
infrastructure failure still use ApiProblem. `context` contains only authorized
Workspace/Run/Stage/Operation/Session/Process IDs. `detail`, field errors and
suggested action are bounded and sanitized; internal/native evidence goes to
restricted Events/Artifacts/logs keyed by request/Event ID.

## 10. Retryability

Retryability describes whether a new authorized attempt may plausibly succeed;
it never authorizes an automatic spawn or reuse of a terminal Stage attempt.

- config, executable missing/inaccessible, unsupported version, auth required/
  expired/failed, identity mismatch, output invalid and policy denial are false
  until external/user/config state changes;
- rate limit and validated temporary network/provider/platform unavailability
  may be true, with bounded backoff/retry-after evidence;
- cancellation/cleanup may be retried only against the same Process and
  idempotency key under survivor policy; it never starts another Process;
- recovery unknown may be rescanned when stronger evidence becomes available;
- internal/invariant/data-integrity errors default false;
- retry/fallback creates a new Stage attempt under existing M3 lifecycle rules
  and preserves the failed Process/Session/Event chain.

## 11. Public/internal diagnostic boundary

Public/API/Event projections may expose stable code, bounded safe detail,
retryability, suggested action, authorized IDs, timeout limit, safe Provider
Type/version and output-reference availability. They never expose:

- raw stdout/stderr, raw native message/frame, hidden reasoning or prompt;
- original command arguments, full executable search paths, cwd outside safe
  projection, environment values or secret-profile contents;
- token/cookie/key/OAuth state, recovery token/hash, raw stack/SQL/native handle;
- unrestricted PID/survivor lists or cross-workspace resource existence.

Internal evidence is still redacted and bounded. Restricted evidence may hold
native code, normalized executable identity, PID/start/group checks, parser
offset, safe stack fingerprint and Artifact reference. Full raw bytes stay only
in the restricted managed output sink.

## 12. Secret/redaction and raw-output rules

stdout and stderr have independent identities, local sequence, original byte
offsets, decoder/framer state and artifact references. Cross-stream order is not
asserted.

Frozen restrictive technical limits for the first M4 implementation proposal:

| Limit / behavior | Frozen value |
|---|---|
| native read/work chunk | at most 64 KiB |
| incremental UTF-8 carry | at most 4 bytes; invalid/binary classification is explicit |
| maximum text/JSONL frame | 1 MiB; oversize frame is not held unbounded and produces protocol/output evidence |
| secret scanner token limit/cross-chunk carry | declared secret UTF-8 byte patterns at most 4096 bytes; retain at most 4095 bytes overlap; larger values require strict-mode rejection before launch |
| pending memory per stream | 4 MiB hard limit; high watermark 3 MiB pauses native read, low watermark 1 MiB resumes |
| pending memory per Process | 8 MiB total hard limit across stdout/stderr |
| artifact segment | 8 MiB retained bytes per immutable rolling segment |
| retained technical cap | 64 MiB per stream per Process before truncation/roll-limit marker; source byte count continues |
| output-reference checkpoint | first retained bytes, then each 256 KiB source advance or 1 second, and always truncation/finalization |
| ordinary safe summary | at most 2 KiB UTF-8 after redaction/control filtering |

The bounded native-byte queue fans out without copying into unbounded strings:

```text
native bytes
  -> byte-pattern secret scanner + redacted retained branch
     -> decoder/binary classification -> control filtering
     -> append-only restricted sink + safe summaries
  -> short-lived original parser branch
     -> Adapter incremental parser
     -> Event-draft secret/control scanner
```

The retained branch scans declared UTF-8 secret byte patterns before any write,
including binary output and cross-chunk matches. In strict mode, binary data or
an unscannable secret condition fails closed before persistence. The original
parser branch exists only for the current bounded chunk/carry required by the
protocol, is never logged/artifacted, and is released after parsing. Adapter
drafts are scanned again before Event validation. ANSI clipboard/title/hidden-
text controls are removed from ordinary projections. Original bytes are never
reconstructed into an unbounded string.

The byte scanner delays its trailing overlap (at most 4095 bytes) rather than
persisting it until the next chunk or final flush proves no cross-boundary
secret. Final flush applies the same scan before append.

At a queue high watermark, pause the readable stream and drain the sink/parser;
all waits are observable and bounded. At hard queue limit, sink failure, or a
Provider that cannot be backpressured, stop accepting additional bytes, record
`PROCESS_OUTPUT_LIMIT_EXCEEDED`/artifact failure, initiate fail-closed Process
stop, and preserve truncation/offset evidence. Only explicitly ephemeral
progress may be dropped; terminal Events, raw-output metadata and errors never
are.

At the first 64 MiB retained-stream cap, finalize the last segment, mark
truncated with source/retained counts, stop ordinary deltas and initiate the
canonical fail-closed Process stop. The first M4 slice never continues Provider
execution while discarding unretained raw bytes, because that would violate E05
traceability. P0 does not set user-visible long-term retention duration or raw-
output access UX. All first-slice raw output is `restricted`; any later cap,
retention or access expansion requires new evidence and may require an Owner
Decision.

## 13. M3 Event/Outbox preservation

M4 must preserve all accepted M3 invariants:

1. Runtime Event envelope and canonical source/visibility/durability semantics
   are unchanged.
2. Per-Run sequence allocation, Event append and one Outbox insert occur in one
   SQLite transaction and roll back together.
3. Event rows are append-only; recovery/diagnostics append, never edit history.
4. Outbox delivery state is fenced and cannot mutate canonical Event payload.
5. Process/Provider drafts do not allocate ID, sequence or persisted timestamp.
6. LifecycleTransactionService remains the sole canonical Run/Stage/Operation
   transition writer.
7. Operation/idempotency replay returns prior evidence and cannot start a
   Provider.
8. Unknown/future Event handling remains forward-compatible; production cannot
   emit new M4 types until Registry expansion is reviewed.
9. `runs.recovery_required` remains M3 Run uncertainty; Process classification
   supplies evidence but does not replace it.
10. SSE/realtime publishes persisted Events/projections, never raw stdout as the
    only source.

## 14. P2/P3 implementation gates

P2 may implement Process/output facts only after separate schema/migration and
P2 entry authorization, exact Registry additions, payload schemas, Event/
Outbox atomic tests, CAS/race tests, raw-output security/backpressure tests and
independent schema/Event/security review. Migration 014 remains absent and
unallocated in P0.

P3 may implement Provider facts/errors only after P1/P2 ports are accepted as
needed, exact Adapter/Registry/version contracts are frozen in code,
`provider.diagnostic` and `provider.session_cancelled` are reconciled against
the specification/Registry, Kimi fixtures prove normalization/redaction, and
Provider contract/API/security review has BLOCKER/HIGH zero.

Neither gate authorizes RunEngine wiring, production cutover, P4, Ready, Merge,
or a silent Runtime Specification edit. Every new Event/error must be added
through separately reviewed shared/runtime registry changes in its owning
phase.

```text
SPEC_RECONCILIATION_REQUIRED:
process.failed
process.output_reference_advanced
process.recovery_classified
provider.diagnostic
provider.session_cancelled
```

This marker records draft vocabulary absent from the current specification/
M3 Registry. It is not permission to edit either under P0.
