# AgentOS Runtime Specification Lite

## 05 — Process Runtime

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs retain authority for already-frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical `Runtime-Specification` remains reference architecture where it is broader than Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

This document defines the Lite Process Runtime: the Windows-only operating-system execution layer that owns provider and tool processes.

The Process Runtime provides:

- durable Process identity that is separate from the native PID;
- reserve-before-spawn process registration;
- Windows Job Object and process-tree ownership with verification;
- bounded, independent stdout and stderr handling;
- cancellation and timeout control;
- startup preflight;
- fail-closed restart recovery classification.

The Lite rule for recovery is:

> When certainty is unavailable, do not guess success.

## 2. Lite Platform Scope

AgentOS Lite is Windows-only.

Active engineering targets:

- Windows process creation and ownership;
- Windows Job Object process-tree containment;
- reliable cancellation and timeout;
- native process identity evidence;
- PID-reuse-safe recovery classification.

**DEFERRED FULL-SCOPE:** Linux, macOS, FreeBSD, POSIX process groups, `/proc`, `bootId`, `startTicks`, and cross-platform native process identity expansion.

Existing POSIX process-tree code may remain under **COMPATIBILITY** only to keep internal code compiling. It is not a Lite requirement and receives no new engineering investment.

## 3. Core Principles and Invariants

| Invariant | Meaning |
|---|---|
| Run != Process | A Run is a domain attempt; a Process is an OS execution record. |
| AgentOS Process ID != native PID | `proc_...` is durable; PID is reusable native evidence. |
| Run owns Process | The Run owns execution; the Process runtime owns OS control. |
| Browser disconnect != cancellation | Transport lifetime never terminates a Process. |
| Reserve before spawn | The durable record exists before the OS process is created. |
| All CLI through Process Manager | Runtime Core and Adapters never call `child_process` directly. |
| Shell disabled by default | `shell = false`; arguments are arrays, never unescaped strings. |
| Output is untrusted and bounded | stdout and stderr are independent, bounded, and redacted. |
| Cancel is idempotent and tree-wide | Repeated cancel is safe; survivors are verified. |
| PID alone never proves identity | PID reuse is real; native identity evidence is required. |
| Recovery fails closed | `UNKNOWN` is never treated as recoverable success. |
| No reattach or adoption | Lite never reattaches, adopts, transfers, or takes over processes. |

## 4. Durable Process and Identity

### 4.1 Runtime Process Record

A durable Process record captures:

- AgentOS Process ID;
- native PID as evidence only;
- Run and optional Stage and Provider Session references;
- executable and redacted arguments;
- cwd;
- environment key names;
- platform and tree-ownership mode;
- status and timestamps;
- exit code, signal, and termination reason;
- recovery evidence and classification;
- version and immutable creation metadata.

The native PID is written only after a successful spawn.

A Process record is never deleted after exit; it may be archived.

### 4.2 Durable Identity Separate from PID

The native PID is mutable OS evidence that can be reused.

It must never be:

- the durable identity;
- the sole recovery proof;
- the sole cancellation target.

The merged P6-M3a contract freezes this rule and the required direction for safe classification: a lossless Windows-native process creation identity.

The canonical durable form is the Windows creation FILETIME preserved losslessly as tagged text:

```text
win32:filetime:<unsigned-decimal>
```

This value is:

- platform-tagged and source-tagged text end to end;
- exact-equality comparable;
- independently re-observable after a Server restart;
- never routed through a JS Number, `Date.parse`, an ISO timestamp, or the wall clock.

The persisted wall-clock `nativeStartedAt` is the Server's clock at spawn moment, not OS creation time, and is never normalized into the identity proof.

## 5. Launch Lifecycle

### 5.1 Reserve-Before-Spawn

Every process is registered before it exists:

```text
validate launch request
  -> validate Run/Stage and policy
  -> normalize executable and cwd
  -> resolve environment
  -> persist Process reservation (created, nativePid null)
  -> emit process.launch_requested
  -> platform spawn
  -> bind PID and platform handle
  -> wire stdout / stderr / exit
  -> start timeout controllers
  -> mark running
  -> emit process.started
```

The reservation provides:

- auditability;
- spawn-error traceability;
- idempotency against duplicate launches.

If spawn succeeds but registration fails, the process is immediately terminated and a system audit is generated.

### 5.2 Launch Validation

Launch requests are validated before spawn:

- executable legitimacy and path boundary;
- cwd existence and Workspace boundary;
- environment allowlist and secret references;
- argument array and size limits;
- shell and detached flags;
- timeout and resource policy;
- idempotency key.

### 5.3 Working Directory

- Effectively read-only Runs use the admitted Workspace with tested technical Workspace write denial.
- Modifying Runs use the admitted Workspace or an explicitly validated provider-selected directory.
- AgentOS does not require an AgentOS-owned Worktree; see [06 — Worktree Runtime](./06-Worktree-Runtime.md).
- The recorded cwd is the initial cwd; provider-internal `cd` is not canonical state.

## 6. Windows Job Object and Process Tree

### 6.1 Ownership Model

The Windows owned-spawn path places the provider process tree in an unnamed Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.

Ownership is layered:

- the Node Server owns the helper process and its transport pipes;
- the PowerShell helper owns the native Job handle in memory;
- the Job owns the provider process tree.

The native Job handle is memory-only.

The stored `platformHandleId` is diagnostics-only and is never used to reopen the Job after restart.

### 6.2 Kill-on-Close Semantics

When the Server or helper ownership chain is lost, the helper exits, its Job handle closes, and kill-on-close intentionally reaps the owned provider tree.

The normal Windows production restart outcome is therefore `MISSING`, not a surviving provider process.

### 6.3 Tree Verification

Cancellation and cleanup verify:

- root PID;
- known child PIDs;
- newly discovered child PIDs;
- survivors.

If survivors remain, the Process is marked orphaned, cleanup-required is emitted, and cancellation is not reported as fully successful.

### 6.4 Job Assignment Failure

The production Windows owned-spawn path is atomic before provider execution:

```text
CreateProcessW(CREATE_SUSPENDED)
  -> create and configure kill-on-close Job
  -> AssignProcessToJobObject

assignment succeeds
  -> capture required native evidence
  -> ResumeThread
  -> provider may execute

assignment fails
  -> abort or terminate the still-suspended provider
  -> close process, thread, Job, and transport handles
  -> fail spawn closed
```

No provider-controlled instruction may execute before successful Job assignment. Assignment failure never enables a process-tree fallback, never resumes the provider with reduced cancellation reliability, and never permits the provider to execute outside the required Job.

Existing compatibility code that is not the production owned-spawn contract may remain under **COMPATIBILITY**. It is not an **ACTIVE LITE** fallback and cannot satisfy owned-spawn acceptance.

Named Jobs, broker lifetime changes, and cross-restart ownership redesign are **DEFERRED FULL-SCOPE** and require separate authorization.

## 7. Bounded Independent stdout and stderr

### 7.1 Independent Pipelines

stdout and stderr are processed independently.

No cross-stream ordering is assumed.

Each chunk records receive time and a local stream sequence.

### 7.2 Pipeline

```text
native stream
  -> byte buffer
  -> decoder
  -> ANSI processor
  -> framer
  -> secret scanner
  -> raw Artifact appender
  -> provider parser
  -> canonical Event
```

### 7.3 Bounds and Backpressure

- per-stream memory buffers are bounded (4-16 MB guidance);
- oversized frames fall back to raw Artifacts;
- high-frequency progress may be aggregated;
- terminal, approval, and error facts are never dropped;
- overflow emits an output-backpressure Event and retains the raw Artifact.

### 7.4 Raw Output

- stdout and stderr produce bounded raw Artifacts by default;
- Artifacts are scanned for secrets;
- raw output is never canonical Runtime Event data by itself.

## 8. Startup Preflight

### 8.1 Pre-Spawn Preflight

Before a provider process is spawned, the runtime validates executable, cwd, environment, policy, resource limits, and idempotency.

Startup readiness is confirmed before a Run reports `running`.

### 8.2 Recovery Preflight

Restart recovery classifies processes before any SQLite write transaction:

```text
Server startup scan
  -> load durable active Process rows
  -> inspect OS process state asynchronously
  -> precompute classification
  -> transaction consumes precomputed classification only
```

The transaction never holds a database write lock across asynchronous OS probing.

## 9. Cancellation and Timeout

### 9.1 Cancellation

Cancel is an explicit control request.

```text
validate ownership and state
  -> mark stopping
  -> stop accepting new stdin
  -> provider/native interrupt if supported
  -> platform graceful signal
  -> wait grace period
  -> if still alive: force-terminate process tree
  -> inspect survivors
  -> persist terminal state
```

Cancellation rules:

- idempotent; repeated Cancel returns current state;
- `ProcessCancelCoordinator` remains the sole cleanup authority;
- browser disconnect, SSE close, and UI navigation never cancel;
- a Stage cancellation Event never by itself terminates a Process.

### 9.2 Timeout

Timeouts are activity-based first:

- startup timeout;
- idle timeout (primary);
- total timeout (optional, frozen in the Run snapshot);
- tool timeout where bounded.

Approval waiting and paused states suspend the idle timer.

Timeout and normal exit race safety uses expected-version checks; only one terminal transition is allowed.

## 10. Recovery Classification

### 10.1 Lite Vocabulary

| Classification | Meaning | Safe default disposition |
|---|---|---|
| `MISSING` | Positive OS evidence proves the PID is absent. | Canonical failure/reconciliation; never resume. |
| `MISMATCH` | PID exists but lossless native creation identity differs. | Treat as PID reuse; never signal or adopt the foreign process. |
| `UNKNOWN` | Evidence is absent, ambiguous, inaccessible, or inconsistent. | Preserve uncertainty / recovery required; never guess success. |
| `SAME` | PID and lossless native creation identity positively match where technically possible. | Identity fact only; no automatic continuation authority. |

PID alone never proves `SAME`.

### 10.2 Fail-Closed Rules

- Absence proof is exact `ESRCH` only; every other probe outcome fails closed.
- `UNKNOWN` never drives terminal success and never authorizes continuation.
- Only `MISSING` reconciles a running Run to canonical terminal failure in the merged recovery path.
- Malformed or internally inconsistent evidence fails closed to `UNKNOWN` before the OS probe runs.

## 11. Implementation Status Snapshot

This section is a non-authoritative status snapshot dated 2026-08-28. Architecture semantics in this document are independent of branch heads and implementation commit SHAs; current merged status must be established from repository history and the merged contracts.

### 11.1 Durable Merged Baseline

- M4-P1 through M4-P5 series: durable Process schema, Process Manager, provider integration, tree proof, timeouts, and integrated cancellation are merged.
- P6-M2a: process recovery evidence classifier is merged.
- P6-M2b: production fail-closed Windows recovery probe is merged; only `MISSING` is positively provable, otherwise `UNKNOWN`.
- P6-M3a: the recovery identity contract is merged as documentation. It freezes:
  - Windows-only recovery scope;
  - lossless Windows creation FILETIME as the required identity direction;
  - `SAME` production-unreachable under kill-on-close ownership;
  - `MISMATCH` production-reachable after M3b only through PID reuse with differing FILETIME;
  - v1/v2 evidence compatibility with no backfill;
  - dedicated column canonical with evidence-JSON mirror failing closed;
  - classification only, with no control, reattach, or ownership changes.

### 11.2 P6-M3b Closeout Status

At the date of this snapshot, P6-M3b is in closeout and is not yet contained by merged `main`. Its implementation evidence includes:

- canonical `win32:filetime:<unsigned-decimal>` validator;
- Windows helper capture of the full 64-bit creation FILETIME at spawn;
- read-only `probe-identity` birth-identity probe (`OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` + `GetProcessTimes`);
- production verifier returning `alive` with canonical birth identity;
- dual-version v1/v2 classifier with column-vs-mirror consistency checks;
- additive migration 015 (`native_birth_identity` column, immutability trigger, partial index);
- server repository validation and binding of the birth identity.

Until merged `main` contains that work, Lite treats P6-M3b as closeout implementation evidence rather than shipped behavior. When it becomes merged, only this status label changes; the Windows identity, fail-closed classification, compatibility, and no-reattach architecture contracts do not.

## 12. No Reattach, Adoption, or Ownership Transfer

The following are **DEFERRED FULL-SCOPE** and are never Lite requirements:

- provider process reattachment;
- provider session adoption;
- surviving-process ownership transfer;
- arbitrary process continuation;
- orphan takeover;
- automatic respawn.

`SAME` is identity evidence only.

Even a technically proven `SAME` does not grant control authority, output continuity, or Run success.

When continuation cannot be proven safe, the user may create a new retry Run.

Recovery never constructs a second execution authority for the interrupted Run.

## 13. Compatibility with the Existing Runtime

- Merged Process schema, Process Manager, Platform Driver, Event, Artifact, timeout, and recovery contracts remain authoritative under **COMPATIBILITY**.
- Legacy `schemaVersion=1` recovery evidence remains readable: absent PID -> `MISSING`, live PID without native identity -> `UNKNOWN`.
- The P6-M3b additive migration is compatible with rollback: stop reading the new field and `missing`/`unknown` behavior is preserved.
- Existing POSIX process-tree code is retained for internal compatibility only and is not Lite scope.
- No second Process Runtime or cleanup authority is introduced.

## 14. Failure and Safety Rules

- A native PID alone never proves identity, ownership, success, or safe cancellation.
- Production owned-spawn Job assignment failure terminates the still-suspended provider and never reaches `ResumeThread`.
- Probe failure never becomes absence proof.
- `UNKNOWN` is never treated as recoverable and never drives terminal success by itself.
- Identity proof does not grant control; `ProcessCancelCoordinator` remains the sole cleanup authority.
- No reattach, adopt, resume, respawn, ownership transfer, or kill is introduced by classification.
- Raw output and errors never enter canonical state unredacted.
- A Process exit does not complete a Run or Stage by itself.
- High-frequency output cannot drop terminal facts.

## 15. Acceptance Expectations

Independent verification must cover:

- reserve-before-spawn ordering and idempotency;
- Windows Job assignment failure gate: provider instruction never executes, suspended provider is terminated, handles close, and spawn fails;
- Windows owned-spawn restart reaper gate: owned provider reaped, post-restart classification `MISSING`;
- Windows primitive identity gate: same creation identity -> `SAME`, different -> `MISMATCH`, unreadable -> `UNKNOWN`;
- production PID-reuse gate: persisted FILETIME A vs observed B, B != A -> `MISMATCH`, never `SAME`;
- evidence-version gates: v1 rows keep `MISSING`/`UNKNOWN`, v2 rows reach `SAME`/`MISMATCH`/`UNKNOWN`;
- cancel terminates the owned Windows process tree with survivor verification;
- browser disconnect leaves the Process running;
- timeout, approval-wait exclusion, and race-safe terminal transitions;
- bounded independent stdout/stderr with Artifact fallback;
- startup preflight never probes OS state inside a SQLite write transaction;
- classification never activates reattach, adoption, ownership transfer, or takeover.

## 16. Cross-Document References

- [00 — Vision](./00-Vision.md) defines Windows-only scope and the Fast Track.
- [01 — Core Concepts](./01-Core-Concepts.md) defines Process identity and ownership.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines cancel, retry, and restart recovery flows.
- [03 — Event Model](./03-Event-Model.md) defines Process Events and recovery classification Events.
- [04 — Provider Specification](./04-Provider-Specification.md) defines the Adapter Process port.
- [06 — Worktree Runtime](./06-Worktree-Runtime.md) defines the Workspace cwd boundary without Worktree dependency.
- `07-Memory-Runtime.md`, `10-Data-Model.md`, `11-API-Specification.md`, and `13-Runtime-Inspector.md` will elaborate persistence, API, and inspection surfaces.
