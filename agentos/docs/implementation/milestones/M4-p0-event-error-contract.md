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
| `process.started` | native identity registered and streams/exit watcher wired; PID, native-start time, platform/tree mode, started time; may be a late spawn-success fact while Process remains `stopping` and never implies a `running` transition | `process-manager`; internal; durable | Run, Stage, Process, Session; caused by launch request; fact only |
| `process.failed` **(P0 addition)** | reservation ends before managed running state; outcome `spawn-failure`, `spawn-failure-after-cancel`, `registration-failure`, or `cancelled-before-spawn`; the after-cancel outcome retains both original cancel causation/stop reason and `PROCESS_SPAWN_FAILED` evidence in one terminal fact | `process-manager`; internal/restricted; durable | Run, Stage, Process, optional Session; caused by launch request and, when present, the accepted cancel; LifecycleTransactionService decides Stage/Run outcome; exactly one terminal fact and no second spawn |
| `process.output_reference_advanced` **(P0 addition)** | first retained bytes, each checkpoint and finalization; stream, artifact ID, prior/next source offsets, retained bytes, truncated/finalized flags | `process-manager`; restricted; durable | Run, Stage, Process, Session, Artifact; caused by started/prior checkpoint; no lifecycle transition |
| `process.stopping` | first accepted stop/timeout/shutdown request from `starting`, `running`, or `waiting`; reason, graceful requested, grace/force deadlines, idempotency-key hash and whether native identity is still pending | `process-manager`; internal; durable | Run, Stage, Process, Session; caused by explicit Cancel/timeout/shutdown; PID may be null after spawn-right consumption; lifecycle service may consume only as non-terminal evidence |
| `process.exited` | one terminal native/cleanup observation; exit code/signal, termination reason, duration, graceful/force flags, cleanup result and output refs | `process-manager`; internal, safe projection may be public; durable | Run, Stage, Process, Session and output Artifacts; one per Process; LifecycleTransactionService decides Stage/Run outcome |
| `process.cleanup_required` | tree stop cannot prove complete; result `SURVIVORS`, `IDENTITY_MISMATCH`, or `UNKNOWN_PLATFORM_UNAVAILABLE`, restricted known-PID count and safe reason | `process-manager`; restricted; durable | Run, Stage, Process, Session; caused by stopping/recovery; lifecycle service preserves uncertainty/failure as contract dictates |
| `process.orphaned` | same/mismatched native process is alive but not safely controlled, or known survivor exists; classification and cleanup-required flag | `recovery-manager` or `process-manager`; restricted; durable | Run, Stage, Process, Session; cannot itself claim successful cancellation |
| `process.recovery_classified` **(P0 addition)** | one recovery scan result: `same`, `missing`, `mismatch`, or `unknown`; evidence checks, classifier version/time, action `monitor-none`/`preserve-uncertainty` | `recovery-manager`; restricted; durable | Run, Stage, Process, optional Session; caused by recovery scan; lifecycle service alone updates `recovery_required`/Run state |
| `process.recovered` | optional compatibility projection only when `same` is proven and an allowed monitor capability is established | `recovery-manager`; internal; durable | same refs; caused by recovery-classified; never means Provider success |
| `process.recovery_failed` | classifier operation itself fails or required evidence is unreadable; stable Process error and retryability | `recovery-manager`; restricted; durable | same refs; preserves uncertainty; never terminal success |

`process.failed`, `process.output_reference_advanced` and
`process.recovery_classified` require future P2 Registry/schema review. They
must not be emitted as unknown production events before that gate.
`process.exited` is emitted for every Process with an authoritative native-start
identity after verified terminal/cleanup observation, including late spawn
success while already `stopping`, non-zero, signal, cancel and timeout; those
meanings are payload facts, not separate terminal states. A proved spawn failure
or other pre-native-start failure uses `process.failed`, so every transition has
a durable fact without pretending a native Process exited. Only `created`
admits `cancelled-before-spawn`; `starting` has already consumed the spawn right
and cancellation must first produce `process.stopping` even when PID is null.

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
  -> process.exited | process.failed (late spawn failure) | process.cleanup_required
  -> provider.session_cancelled when cleanup proves successful cancellation
     | provider.session_failed when cancellation/finalization fails
  -> LifecycleTransactionService terminal/uncertainty Event
```

For late spawn success, `process.started` is appended between
`process.stopping` and `process.exited`; it records the returned native identity
but does not authorize a `running` transition.

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

The authoritative set is the exact 30-member `ProcessErrorCode` union in
`05-Process-Runtime.md` section 81. Every member has a disposition below.
`HTTP` applies only to a synchronous API response; asynchronous execution
stores the same code in Operation/Event evidence. `P1 REQUIRED` freezes the
code now for the schema-light foundation; a later phase label means the code
remains authoritative but does not expand P1 scope.

| Authoritative code | Disposition / owner phase | Frozen trigger and phase | HTTP | Retryable | Required outcome/evidence |
|---|---|---|---:|---|---|
| `PROCESS_REQUEST_INVALID` | ADOPT EXACT — P1 REQUIRED | malformed or semantically invalid launch request; `validation` | 400 | no until request changes | field-safe detail; no reservation or spawn |
| `PROCESS_POLICY_DENIED` | ADOPT EXACT — P1 REQUIRED | executable, cwd, shell or security policy rejects launch; `validation` | 403 | no until policy/request changes | policy reference only; no secret or spawn |
| `PROCESS_EXECUTABLE_NOT_FOUND` | ADOPT EXACT — P1 REQUIRED | resolved executable/command absent, including `ENOENT`; `validation` | 422 | no until install/config changes | safe guidance; search paths restricted; no spawn |
| `PROCESS_EXECUTABLE_NOT_ACCESSIBLE` | ADOPT EXACT — P1 REQUIRED | executable exists but access, type or permission fails, including `EACCES`/`EPERM`; `validation` | 422 | no until permission/config changes | native code restricted; no spawn |
| `PROCESS_CWD_INVALID` | ADOPT EXACT — P1 REQUIRED | cwd missing, inaccessible, escaped or outside worktree boundary; `validation` | 422 | no until cwd/request changes | normalized path evidence restricted; no spawn |
| `PROCESS_ENVIRONMENT_INVALID` | ADOPT EXACT — P1 REQUIRED | environment merge, size, encoding, denylist or secret-reference validation fails; `validation` | 422 | no until env/config changes | key/source only; never persist values; no spawn |
| `PROCESS_REGISTRATION_FAILED` | ADOPT EXACT — P1 REQUIRED; durability lands P2 | spawn succeeded but native identity, handle, stream or started fact cannot be registered; `reservation`/`spawn` | 500 | no automatic same-attempt retry | bind returned identity to the same Process, terminate and verify tree, retain cleanup evidence, never respawn |
| `PROCESS_SPAWN_FAILED` | ADOPT EXACT — P1 REQUIRED | the one consumed Driver spawn call proves no native root was created; `spawn` | 503 | only explicit transient classification; never same-attempt spawn retry | after cancel, one failed fact retains cancel causation plus spawn evidence; no `process.exited` or second spawn |
| `PROCESS_STDIN_CLOSED` | ADOPT EXACT — P1 REQUIRED | write/close targets closed stdin or native `EPIPE`; `stdio` | 409 | no for same write unless protocol explicitly permits | preserve Process state; safe operation detail only |
| `PROCESS_STDIN_WRITE_FAILED` | ADOPT EXACT — P1 REQUIRED | non-closed stdin write or flush fails; `stdio` | 500 | only when Driver classifies a retry-safe same input | no duplicate approval/input; native evidence restricted |
| `PROCESS_OUTPUT_DECODE_FAILED` | ADOPT EXACT — P1 REQUIRED | required text/protocol decode cannot continue safely; `stdio` | N/A async | no by default | binary classification alone is not this error; preserve bounded offsets/reference evidence |
| `PROCESS_OUTPUT_LIMIT_EXCEEDED` | ADOPT EXACT — P1 REQUIRED | frame, queue or retained-stream hard contract exceeded; `stdio`/`runtime` | 409 | no automatic attempt retry | fail-closed stop; retain truncation/source counts and terminal facts |
| `PROCESS_STARTUP_TIMEOUT` | ADOPT EXACT — P1 REQUIRED | spawned Process misses the frozen Provider-readiness deadline; `timeout` | 503 | new attempt only when policy/evidence allows | same Process stop; never a second spawn under the attempt |
| `PROCESS_IDLE_TIMEOUT` | ADOPT EXACT — P1 REQUIRED | eligible activity deadline expires after lock-time recheck; `timeout` | 409 | no automatic same-attempt retry | first stop reason wins; approved waiting pauses idle only |
| `PROCESS_TOTAL_TIMEOUT` | ADOPT EXACT — P1 REQUIRED | total deadline from native start expires after recheck; `timeout` | 409 | no automatic same-attempt retry | first stop reason wins; waiting does not silently reset it |
| `PROCESS_TOOL_TIMEOUT` | ADOPT EXACT — P5/later Tool runtime | child Tool deadline expires; `timeout` | 409 | policy or new Tool attempt only | stop the owned Tool tree; Provider root outcome remains lifecycle-owned |
| `PROCESS_PAUSE_UNSUPPORTED` | ADOPT EXACT — deferred pause scope | platform/Process cannot safely pause; `pause` | 409 | no without capability change | truthful capability result; no fabricated pause |
| `PROCESS_PAUSE_FAILED` | ADOPT EXACT — deferred pause scope | supported pause attempt fails; `pause` | 409 | only bounded same-Process retry when classified | preserve actual state and restricted native evidence |
| `PROCESS_RESUME_FAILED` | ADOPT EXACT — deferred resume scope | paused Process cannot safely resume; `resume` | 409 | only explicit transient classification | no inferred activity/success; preserve uncertainty |
| `PROCESS_CANCEL_FAILED` | ADOPT EXACT — P1 REQUIRED idempotency; P5 tree | stop coordination fails independently of a more precise tree code; `cancel` | 409 | same Process/key cleanup retry only | never report cancelled success; no second spawn |
| `PROCESS_TREE_TERMINATION_FAILED` | ADOPT EXACT — P5 | force-tree action fails; `tree-cleanup` | 503 | bounded cleanup re-entry only | cleanup-required/uncertainty; native errors restricted |
| `PROCESS_SURVIVORS_DETECTED` | ADOPT EXACT — P5 | post-stop verification proves a root or descendant survivor; `tree-cleanup` | 409 | cleanup may re-enter under policy | survivor identities restricted; cancellation not successful |
| `PROCESS_EXIT_UNKNOWN` | ADOPT EXACT — P1 REQUIRED | a native Process existed but terminal exit/signal fact is missing; `runtime` | 500 | no without stronger evidence | not a recovery-unknown alias; lifecycle cannot infer success |
| `PROCESS_PID_REUSED` | ADOPT EXACT — P6 | PID identifies a different start, executable, token or group; `recovery` | 409 | no | never signal/reattach; identity evidence restricted |
| `PROCESS_RECOVERY_FAILED` | ADOPT EXACT — P6 | recovery/classifier operation fails, not merely an `unknown` result; `recovery` | 503 | normally yes on a later scan | preserve M3 uncertainty; never infer exit/success |
| `PROCESS_ORPHANED` | ADOPT EXACT — P5/P6 | owned native Process/survivor is alive but control is insufficient; `tree-cleanup`/`recovery` | 409 | policy-governed cleanup only | state remains `orphaned`; no successful cancel claim |
| `PROCESS_RESOURCE_LIMIT` | ADOPT EXACT — later resource enforcement | CPU, memory, process-count or disk policy terminates; `runtime` | 409 | no automatic retry | exact safe limit/action; usage evidence restricted |
| `PROCESS_ARTIFACT_WRITE_FAILED` | ADOPT EXACT — P2 | output append, checkpoint, finalize or hash fails; `artifact` | 500 | bounded sink retry before fail-closed stop | execution cannot claim traceable success; path/error restricted |
| `PROCESS_MANAGER_SHUTTING_DOWN` | ADOPT EXACT — P1 REQUIRED | launch rejected before spawn after shutdown gate closes; `shutdown` | 503 | later dispatch under existing claim rules | no reservation takeover or spawn; mode restricted |
| `PROCESS_UNKNOWN_ERROR` | ADOPT EXACT — P1 REQUIRED catch-all | sanitized unclassified Process failure after precise mappings are exhausted | 500 | no by default | restricted native fingerprint; lifecycle owner maps outcome |

The 19-code P1 freeze is complete for request/policy/executable/cwd/environment,
registration/spawn, stdin/output, startup/idle/total timers, idempotent cancel,
exit uncertainty, shutdown and catch-all behavior. It does not grant P1 durable
Artifact/schema, full tree, pause/resume, recovery, resource or Tool scope.
Within that set, the complete launch/environment/spawn surface is the first
eight rows through `PROCESS_SPAWN_FAILED`; the complete P1 output surface is
`PROCESS_OUTPUT_DECODE_FAILED` and `PROCESS_OUTPUT_LIMIT_EXCEEDED`; and the
complete P1 timer surface is `PROCESS_STARTUP_TIMEOUT`,
`PROCESS_IDLE_TIMEOUT`, and `PROCESS_TOTAL_TIMEOUT`.

Non-authoritative candidate aliases are closed as follows and must never enter
new persistence, API or Event payloads:

| Candidate alias | Exact disposition |
|---|---|
| `PROCESS_START_FAILED` | map to `PROCESS_SPAWN_FAILED` for Driver spawn failure; use `PROCESS_REGISTRATION_FAILED` after a returned native identity |
| `PROCESS_START_TIMEOUT` | map to `PROCESS_STARTUP_TIMEOUT` |
| `PROCESS_STOP_FAILED` | map to `PROCESS_CANCEL_FAILED`, or the more precise `PROCESS_TREE_TERMINATION_FAILED`/`PROCESS_SURVIVORS_DETECTED` |
| `PROCESS_TREE_SURVIVORS` | map to `PROCESS_SURVIVORS_DETECTED` |

Two P0 proposed codes are not in the authoritative union and cannot be emitted
until specification reconciliation:

| P0 code | Disposition |
|---|---|
| `PROCESS_IDENTITY_MISMATCH` | `SPEC_RECONCILIATION_REQUIRED`; retain as the proposed broader ownership-mismatch code. PID reuse maps to authoritative `PROCESS_PID_REUSED`; other mismatch classifications remain restricted facts until reconciliation. |
| `PROCESS_RECOVERY_UNKNOWN` | `SPEC_RECONCILIATION_REQUIRED`; `unknown` is an evidence classification, not `PROCESS_RECOVERY_FAILED`. Preserve uncertainty without inventing an authoritative error until reconciliation. |

Process reconciliation count: authoritative `30/30` dispositioned; P1-required
`19/19` frozen; candidate aliases `4/4` mapped; P0 proposed codes `2/2` marked
`SPEC_RECONCILIATION_REQUIRED`.

## 8. Stable Provider errors

The authoritative set is the exact 23-member `ProviderErrorCode` union in
`04-Provider-Specification.md` section 31. Every member is adopted exactly; raw
stderr is never public and only `LifecycleTransactionService` maps Provider
facts to Run/Stage state.

| Authoritative code | Disposition / owner phase | Frozen trigger and phase | HTTP | Retryable | Required outcome/evidence |
|---|---|---|---:|---|---|
| `PROVIDER_ADAPTER_NOT_FOUND` | ADOPT EXACT — P3 | frozen Adapter ID absent from Registry; `validation` | 409 | no until install/config changes | safe ID/version; Registry inventory restricted; no start |
| `PROVIDER_CONFIG_INVALID` | ADOPT EXACT — P3 | schema, disabled/archive, runtime-mode or snapshot binding invalid; `validation` | 422 | no until config changes | field-safe errors; no secret values |
| `PROVIDER_NOT_FOUND` | ADOPT EXACT — P3 | discovery finds no Provider runtime candidate; `discovery` | 404 | no until install/config changes | safe install/path guidance; search evidence restricted |
| `PROVIDER_EXECUTABLE_NOT_ACCESSIBLE` | ADOPT EXACT — P3 | configured/discovered runtime cannot execute or be read; `discovery`/`validation` | 422 | no until permission/config changes | native code restricted; distinct from Process launch-time code |
| `PROVIDER_VERSION_UNSUPPORTED` | ADOPT EXACT — P3 | CLI, Adapter or config snapshot version is incompatible; `validation` | 422 | no until version/config changes | safe supported range; raw probe output restricted |
| `PROVIDER_AUTH_REQUIRED` | ADOPT EXACT — P3 | login/credential absent or native response requires auth; `authentication` | 409 | no until user action | official login/revalidate guidance; no credential/stderr |
| `PROVIDER_AUTH_EXPIRED` | ADOPT EXACT — P3 | explicit expiry evidence; `authentication` | 409 | no until user action | reauthentication guidance; no token/OAuth state |
| `PROVIDER_RATE_LIMITED` | ADOPT EXACT — P3+ runtime | Provider throttles request/session; `startup`/`runtime` | 429 | yes with validated backoff | bounded `retryAfterMs`; retry requires new authorized attempt/policy |
| `PROVIDER_QUOTA_EXCEEDED` | ADOPT EXACT — P3+ runtime | account/workspace quota exhausted; `startup`/`runtime` | 429 | no unless reset evidence exists | safe quota class/reset only; account evidence restricted |
| `PROVIDER_MODEL_UNAVAILABLE` | ADOPT EXACT — P3+ selection | requested model unavailable for frozen config; `validation`/`startup` | 409; 503 only when explicitly transient | evidence-classified only | no silent model/Provider fallback; new attempt required |
| `PROVIDER_CAPABILITY_UNAVAILABLE` | ADOPT EXACT — P3 | required capability absent from effective manifest; `validation` | 409 | no until config/version changes | exact safe capability/source; no fabricated behavior |
| `PROVIDER_START_FAILED` | ADOPT EXACT — P3/P4 | Adapter/Provider Session cannot start or become ready; `startup` | 503 | only explicit transient classification | OS spawn root cause remains `PROCESS_SPAWN_FAILED`; preserve both layer facts |
| `PROVIDER_SESSION_FAILED` | ADOPT EXACT — P3/P4 | terminal Provider-native failure with no more precise code; `runtime`/`finalize` | N/A async; 500/503 synchronously by classification | Provider-evidence classified | exactly one failed Session finalization; Process exit alone is insufficient |
| `PROVIDER_SESSION_NOT_RESUMABLE` | ADOPT EXACT — P6/later resume | native Session/config/worktree/capability cannot resume; `resume` | 409 | no unless incompatibility is explicitly transient | no same-attempt guessed restart; Runtime decides a new attempt/Run |
| `PROVIDER_OUTPUT_PARSE_FAILED` | ADOPT EXACT — P3 | native framing/syntax cannot be parsed; `output-parse` | 422 synchronous; N/A async | no by default | retain restricted raw reference/offset; no semantic fabrication |
| `PROVIDER_OUTPUT_INVALID` | ADOPT EXACT — P3/P4 | parsed final output violates required contract/artifact/final message; `finalize` | 422 synchronous; N/A async | no by default | exit zero cannot override; restricted output references only |
| `PROVIDER_APPROVAL_FAILED` | ADOPT EXACT — deferred approval bridge | native approval request/response bridge fails; `approval` | 409 | only if the same decision is idempotently replayable | no automatic approval; preserve decision identity without content leak |
| `PROVIDER_CANCEL_FAILED` | ADOPT EXACT — P3/P5 | native graceful Provider cancel fails; `cancel` | 409 | same Session/stop ticket may continue | Process tree termination still proceeds; code alone never decides outcome |
| `PROVIDER_PAUSE_UNSUPPORTED` | ADOPT EXACT — deferred pause scope | capability/Adapter cannot pause; `pause` | 409 | no without capability change | truthful capability result; no fabricated pause |
| `PROVIDER_RESUME_FAILED` | ADOPT EXACT — P6/later resume | supported native resume operation fails; `resume` | 409; 503 only when explicitly transient | evidence-classified only | no automatic Provider start or success inference |
| `PROVIDER_NETWORK_ERROR` | ADOPT EXACT — API/remote or networked runtime | DNS, connect, TLS or transport failure; `startup`/`runtime` | 503 | yes only when classified transient | endpoint/stack restricted; no credential leak |
| `PROVIDER_INTERNAL_ERROR` | ADOPT EXACT — P3 internal catch-all | Provider crash/assertion or Adapter invariant failure; matching phase | 500 | explicit temporary evidence only | safe fingerprint/restricted diagnostic; Provider identity retained |
| `PROVIDER_UNKNOWN_ERROR` | ADOPT EXACT — P3 final catch-all | sanitized native failure after precise mappings are exhausted | 500 | no by default | native fingerprint restricted; never only exit code |

Four P0 proposed codes are absent from the authoritative union. They remain
draft vocabulary and require reconciliation before Registry, API or Event use:

| P0 code | Disposition |
|---|---|
| `PROVIDER_AUTH_FAILED` | `SPEC_RECONCILIATION_REQUIRED`; keep distinct only if rejected-credential semantics cannot safely map to `PROVIDER_AUTH_REQUIRED` or `PROVIDER_AUTH_EXPIRED`. |
| `PROVIDER_VALIDATION_FAILED` | `SPEC_RECONCILIATION_REQUIRED`; deterministic causes use precise authoritative validation codes; machinery failure may map to `PROVIDER_INTERNAL_ERROR` only after accepting that loss of specificity. |
| `PROVIDER_PROTOCOL_ERROR` | `SPEC_RECONCILIATION_REQUIRED`; output syntax maps to `PROVIDER_OUTPUT_PARSE_FAILED`, while a broader Session protocol violation needs an explicit spec decision. |
| `PROVIDER_FINALIZATION_FAILED` | `SPEC_RECONCILIATION_REQUIRED`; it may map to `PROVIDER_INTERNAL_ERROR` with phase `finalize` only after review of the lost dedicated code. |

`PROVIDER_SNAPSHOT_INCOMPATIBLE` appears in Provider Specification section 71
but is absent from its authoritative section 31 union. It is a specification-
internal conflict, not a 24th authoritative code, and is
`SPEC_RECONCILIATION_REQUIRED` before use.

Provider reconciliation count: authoritative `23/23` dispositioned; P0
proposed codes `4/4` marked `SPEC_RECONCILIATION_REQUIRED`; specification-
internal extra-union code `1/1` marked `SPEC_RECONCILIATION_REQUIRED`.

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
the specification/Registry, every proposed code below is reconciled or mapped
to an authoritative code, Kimi fixtures prove normalization/redaction, and
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
PROCESS_IDENTITY_MISMATCH
PROCESS_RECOVERY_UNKNOWN
PROVIDER_AUTH_FAILED
PROVIDER_VALIDATION_FAILED
PROVIDER_PROTOCOL_ERROR
PROVIDER_FINALIZATION_FAILED
PROVIDER_SNAPSHOT_INCOMPATIBLE
```

This marker records draft vocabulary absent from the authoritative error unions
or current specification/M3 Registry. It is not permission to edit any of them
under P0.
