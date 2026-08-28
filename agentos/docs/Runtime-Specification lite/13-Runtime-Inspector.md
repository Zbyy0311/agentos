# AgentOS Runtime Specification Lite

## 13 — Runtime Inspector

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs remain authoritative for frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical Runtime Specification remains reference architecture where it exceeds Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

The Lite Runtime Inspector is a focused read/query projection for understanding one engineering execution.

It combines durable Run and Stage state, immutable snapshots, ordered Runtime Events, Process evidence, bounded output references, Memory Context, Artifacts, and Git observations.

It is never a source of truth or execution authority.

ACTIVE LITE is direction; this document does not claim a merged Inspector surface.

## 2. Lite Scope

### 2.1 ACTIVE LITE

- Run, Stage, and retry lineage;
- Agent and Provider snapshots;
- Process identity and tree evidence;
- duration and timing;
- ordered Event query, replay, and live stream;
- bounded stdout/stderr and restricted raw Artifacts;
- Memory Context and selection explanations;
- Artifact and Git observation;
- error, cancel, retry, approval, and recovery evidence;
- typed API controls through Policy/runtime;
- progressive disclosure and redaction.

### 2.2 COMPATIBILITY

- merged Runtime, Event, SSE, Snapshot, Process, Artifact, and API contracts;
- existing diagnostic routes and projections where present;
- legacy status, Stage text, and output references clearly labeled as compatibility.

### 2.3 DEFERRED FULL-SCOPE

- IDE, editor, or debugger replacement;
- Git client, merge tool, conflict UI, or Worktree manager;
- process reattach, adoption, transfer, or takeover;
- deep Provider-internal debugging;
- full Policy administration;
- advanced Memory graph/vector inspection;
- Provider Comparison UI;
- workflow DAG editor;
- Tauri/native host.

## 3. Invariants

| Invariant | Contract |
|---|---|
| Inspector != Runtime | It renders state and never decides outcomes. |
| Projection != truth | Every fact references a canonical record. |
| Run != Task | Run is one attempt. |
| Run != Process | Process evidence cannot determine Run outcome alone. |
| Process ID != PID | AgentOS Process ID is durable; PID is reusable evidence. |
| Event != log | Timeline uses registered Events, not stdout. |
| Event != Message | Runtime facts remain distinct from communication. |
| Agent != Provider | Identity and capability are separate. |
| Snapshot != current config | Historical Runs show execution-time values. |
| Disconnect != cancel | Observation loss does not stop execution. |
| Reconnect != retry | Cursor resume has no execution side effect. |
| Replay != re-execution | Replay performs no external action. |
| UNKNOWN != success | Recovery is fail closed. |
| No reattach | Inspector offers no adoption/takeover control. |
| Windows only | Active engineering targets Windows runtime facts. |
| Single writer remains authoritative | Inspector cannot bypass admission. |

## 4. Projection Architecture

~~~text
canonical SQLite state
+ immutable Snapshots
+ ordered Events
+ restricted Artifacts
+ recovery evidence
  -> query service
  -> bounded redacted DTO
  -> progressive Inspector UI
~~~

Forbidden:

- direct child_process;
- direct Git;
- direct SQLite;
- direct filesystem mutation;
- forced Run status;
- inferred unavailable facts.

## 5. Data Flow

~~~text
select Run
  -> GET Inspector summary
  -> render Run/Stage/Provider/Process
  -> load sections on demand
  -> query Events after durable cursor
  -> attach SSE
  -> apply Event deltas idempotently
~~~

Sequence rules:

- duplicate Event ID is ignored;
- a gap pauses incremental projection;
- missing Events are fetched in order;
- stale cursor triggers full resync;
- no Event is fabricated.

A section failure degrades that section only.

## 6. Run Overview

Overview shows:

- Task and Run identity;
- status, reason, attempt, parent/root lineage;
- Workflow Template and version;
- Agent and Provider Configuration snapshots;
- requested mutation intent, effective read-only or modifying classification, and admission reason;
- `enforcedWorkspaceReadOnly` value and tested Adapter/platform evidence source;
- started, finished, and duration;
- active Stage;
- last Event sequence;
- pending approval;
- Policy enforcement boundary and unavailable-enforcement reason for Provider-native actions;
- error and recovery warning;
- safe next action.

Duration comes from canonical timestamps.

## 7. Stage Inspection

Each optional Stage shows:

- key, name, state, attempt;
- Agent and Provider used;
- dependencies and duration;
- Memory Context;
- output contract and failure summary.

Stage graph comes from the frozen Workflow Snapshot and Run Stage records. Keys are template data, not hard-coded Provider roles.

## 8. Process and Output

Process view shows:

- AgentOS Process ID;
- native PID labeled evidence-only;
- parent/root references;
- executable and redacted arguments;
- cwd;
- status and timestamps;
- exit and termination reason;
- Windows native identity evidence;
- recovery classification.

stdout and stderr are independent, bounded, and redacted. Tail/range views use durable offsets. Large or sensitive content is a restricted Artifact.

Process exit never proves Stage or Run success.

## 9. Event Timeline

Timeline is a readable Runtime Event projection, not raw log or Message history.

- strict per-Run sequence;
- summary, detail, and advanced raw modes;
- filters by Stage, type, severity, domain, source, and range;
- live tail only while user remains at bottom;
- redacted payload and causal references;
- unknown future types preserved with compatibility warning.

Never aggregate away:

- terminal Run/Stage facts;
- approvals;
- Policy denials;
- errors;
- recovery;
- Artifact finalization.

## 10. Memory Context

Memory view presents exactly what the Run or Stage received:

- query and strategy version;
- Entry IDs and versions;
- rank, score, and reasons;
- Scope, Authority, Confidence, Importance, Source;
- token cost and budget;
- truncation and exclusion reasons;
- immutable Context Snapshot ID.

It answers: why did this Run receive this Memory?

## 11. Artifacts

Artifact view shows:

- type, producer, source Run/Stage;
- size, checksum, sensitivity, retention;
- controlled preview/download;
- Event, Memory, Git, and Conversation references.

Local absolute paths and storage URIs are not resource contracts.

## 12. Git Observation

The Inspector may show:

- Git root and Process cwd;
- base/final SHA when observable;
- status snapshot;
- changed files;
- diff summary and Artifact;
- dirty-state evidence;
- not-git result.

Wording never implies AgentOS created a branch, owned a Worktree, or performed a merge.

## 13. Errors and Recovery

Errors show stable code, phase, retryability, safe detail, and suggested action. Sensitive detail stays in a restricted Artifact.

Recovery view shows evidence and one classification:

| Result | Inspector meaning |
|---|---|
| MISSING | canonical failure/reconciliation, never resumption |
| MISMATCH | PID reuse/evidence mismatch, never adoption |
| UNKNOWN | recovery required, never success |
| SAME | identity evidence only, no continuation authority |

No reattach, adoption, transfer, or takeover control exists.

## 14. Cancel, Retry, and Approval

~~~text
Inspector action
  -> typed API
  -> auth
  -> Policy ALLOW / DENY / ASK_USER
  -> Runtime service
  -> state + Event + audit
  -> Inspector update
~~~

Cancel is explicit and idempotent. It terminates the owned Windows Process tree and releases modifying authority only through committed state.

Retry creates a child Run and preserves lineage. It never resets a terminal Run.

Approval controls render only from trusted Approval resources. Agent output cannot fabricate them.

No direct process-kill control exists.

## 15. Progressive Disclosure

~~~text
summary
  -> domain detail
  -> Runtime Event
  -> permission-gated raw payload or Artifact
~~~

Server redacts before persistence and response. Client sanitizes all untrusted content.

Never expose:

- credentials, tokens, cookies, private keys;
- full environment or unredacted arguments;
- private Provider reasoning;
- unrestricted paths;
- full sensitive file content.

Search/export excludes the same classes.

## 16. Windows and Workspace Boundary

Active views target Windows Job Object ownership, Process tree, native identity, bounded output, cancellation, and fail-closed recovery.

Modifying admission is shown as acquired, queued, or rejected. Read-only Runs are shown as concurrent only when tested `enforcedWorkspaceReadOnly` evidence proves Workspace writes are technically denied. Unknown or unavailable enforcement is shown as modifying, never as prompt-based read-only.

Provider-internal Git/worktrees never appear as AgentOS isolation state.

## 17. Failure and Safety

- never infer terminal state from output, prose, or Event absence;
- label stale projections with sequence and last-updated facts;
- disconnect changes UI subscription only;
- replay performs zero Provider, Process, Policy, Memory, or Git side effects;
- redaction failure blocks the affected response;
- UNKNOWN is never success;
- Inspector cannot admit a second modifying Run;
- partial section failure does not break the page.

## 18. Compatibility Policy

The Inspector consumes existing canonical contracts and creates no second Event Store, query authority, or execution authority.

Legacy projections may appear with legacy/partial/unverified labels. They never own Run state or cancellation.

## 19. Acceptance Expectations

Independent verification must prove:

- view facts match canonical records;
- Run, Stage, Provider, Process, and duration are distinct;
- Process ID is never confused with PID;
- strict Event order, gap recovery, and deduplication;
- bounded output without unbounded client state;
- Memory view reproduces Snapshot and explanations;
- Git wording never implies ownership;
- recovery never guesses success;
- no reattach/takeover/direct-kill control;
- Cancel/Retry route through API, Policy, Runtime, and committed Event;
- no two modifying Runs in one Workspace;
- concurrent read-only display requires effective write-denial evidence and cannot be derived from Provider-native worktrees;
- no secrets in DTOs;
- browser disconnect leaves execution active;
- replay has zero external side effects.

## 20. Deferred / Non-Goals

- IDE/editor/debugger replacement;
- Git/merge/conflict/Worktree client;
- process reattach/adoption/takeover;
- Provider Comparison;
- full Worktree Runtime;
- full Policy Runtime;
- advanced Memory graph/vector UI;
- workflow DAG editor;
- Tauri host.

## Lite Implementation Priority

~~~text
CURRENT P6 / Windows recovery correctness
-> Minimal Git Observation + Workspace single-writer rule
-> Recovery closeout
-> Memory Foundation
-> Conversation Runtime
-> Polished UI Foundation
-> Direct Conversation UX
-> Lite Runtime Inspector
-> Controlled Group Conversation
-> Workflow Templates
-> Agent History + Search
~~~

Provider Comparison, full Worktree Runtime, full Policy Runtime, advanced Memory, and the full Workflow Editor are deferred. They are not Inspector prerequisites.

Each step requires evidence-based entry and exit gates. The Inspector gate is a focused projection of durable facts through the API with no second authority.

## 21. Cross-Document References

- [00 — Vision](./00-Vision.md) defines authority and Fast Track.
- [01 — Core Concepts](./01-Core-Concepts.md) defines identities.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines controls/recovery.
- [03 — Event Model](./03-Event-Model.md) defines replay.
- [04 — Provider Specification](./04-Provider-Specification.md) defines Provider fidelity.
- [05 — Process Runtime](./05-Process-Runtime.md) defines Process evidence.
- [06 — Worktree Runtime](./06-Worktree-Runtime.md) defines Git observation.
- [07 — Memory Runtime](./07-Memory-Runtime.md) defines Context Snapshot.
- [08 — Policy Runtime](./08-Policy-Runtime.md) defines approval.
- [09 — Conversation Runtime](./09-Conversation-Runtime.md) defines trusted projections.
- [10 — Data Model](./10-Data-Model.md) defines storage.
- [11 — API Specification](./11-API-Specification.md) defines queries/controls.
- [12 — UI Architecture](./12-UI-Architecture.md) defines placement and behavior.
