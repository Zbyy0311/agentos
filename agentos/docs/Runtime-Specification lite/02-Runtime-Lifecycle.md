# AgentOS Runtime Specification Lite

## 02 — Runtime Lifecycle

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs retain authority for already-frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical `Runtime-Specification` remains reference architecture where it is broader than Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

This document defines the durable Lite execution lifecycle from a Conversation turn through optional Task creation, Run execution, terminal handling, cancellation, retry, and Windows restart recovery.

It preserves merged lifecycle, idempotency, Runtime Event, Outbox, Operation, Process, and recovery contracts.

It removes the future dependency on an AgentOS-owned Worktree lifecycle.

## 2. Lite Lifecycle Scope

The canonical path is:

```text
Conversation Turn
  -> optional Task
  -> Run Request
  -> Workspace admission
  -> durable Run graph
  -> Provider selection
  -> Process ownership
  -> ordered Runtime Events
  -> terminal / cancel / retry / recovery
  -> Conversation, Memory, Artifact, History projections
```

A Conversation turn may remain communication only.

Creating a Task does not start a Run by default.

Starting a Run requires explicit execution authority through the API, workflow, or other declared control path.

## 3. Lifecycle Invariants

- Agent != Provider.
- Message != Task or Run.
- Task != Run.
- Run != Process.
- AgentOS Process ID != native PID.
- Retry creates a new Run.
- Terminal Runs are not reset for another attempt.
- Browser disconnect does not cancel a Run.
- Durable state and Events use merged transaction and concurrency contracts.
- Every durable Event has exactly one independent Outbox record where frozen by the merged contract.
- Provider-native Git, worktrees, subagents, tools, and planning are noncanonical implementation details.
- A modifying Run does not depend on an AgentOS-managed Worktree.
- At most one AgentOS modifying Run executes per Workspace.
- Recovery never guesses success.

## 4. Conversation Turn to Run

### 4.1 Communication-Only Turn

```text
User Message
  -> persist Message
  -> select Agent and Provider for conversational response
  -> stream and persist response
  -> no Task or Run unless explicitly requested
```

Provider-native session continuity may support the response, but the Conversation and Agent identity remain canonical AgentOS state.

### 4.2 Optional Task Bridge

```text
Message
  -> explicit create-Task action
  -> idempotent Task creation
  -> link source Conversation and Message
  -> Task remains open until accepted or cancelled
```

Task creation and Run creation are separate operations.

### 4.3 Run Request

A Run Request identifies:

- Task and Workspace;
- reason such as initial, retry, review-fix, or manual;
- Agent selection or override;
- Provider Configuration selection or override;
- workflow template and optional Stage graph;
- read-only or modifying classification;
- timeout and control inputs;
- Memory budget;
- parent/root lineage where applicable;
- idempotency key and caller.

Unknown mutation classification is handled as modifying.

## 5. Workspace Admission and Serialization

Admission occurs before Provider execution authority or Process spawn.

### 5.1 Read-Only Run

A read-only Run may be admitted concurrently when global, Provider, Agent, and resource limits permit.

It must not intentionally mutate Workspace files or declared external state.

### 5.2 Modifying Run

A modifying Run must acquire the Workspace's sole modifying execution authority.

The admission decision is atomic with the runtime's authoritative queue/operation contract.

If another modifying Run owns that authority, the new request is:

- queued; or
- rejected with a stable error and durable Operation outcome.

Provider-internal worktrees do not permit a second modifying Run.

The authority is released only by a committed terminal, cancellation, or fail-closed recovery transition.

### 5.3 No Worktree Dependency

The following are **DEFERRED FULL-SCOPE**; Lite does not require:

- AgentOS Worktree creation before startup;
- branch reservation;
- merge planning;
- **DEFERRED FULL-SCOPE:** Integration Worktree;
- Worktree recovery.

The Process cwd is the admitted Workspace or an explicitly validated provider-selected directory.

Minimal Git observation records base state, final observable state, status, changed files, diff reference, and cwd without owning Git execution.

## 6. Durable Run Graph Creation

Merged low-level creation contracts remain authoritative under **COMPATIBILITY**.

The durable graph is created in one transaction:

1. Persist the Run in `queued` state with initial version and event-sequence state.
2. Persist the immutable Run snapshot required by the merged schema.
3. Persist zero or more Stage records in deterministic order.
4. Validate the complete Run, snapshot, workflow, and Stage graph.
5. Append `run.created`.
6. Append `stage.created` for each Stage in `stage.sequence ASC`, then `stage.id ASC` order.
7. Insert one independent Outbox record immediately for each Event.
8. Write idempotency success.
9. Commit all writes or roll back all writes.

The frozen creation order is:

```text
run.created -> stage.created x N
```

`N = 0` remains valid where the merged schema and chosen execution path permit it.

`run.created` is the mandatory fact for `empty -> queued`.

`run.queued` is optional queue telemetry and never replaces `run.created`.

Existing compatibility fields, including historical worktree-related snapshot fields, may remain stored without making Worktree an active Lite dependency.

## 7. Run and Stage State

### 7.1 Run State

The retained durable Run states are:

```text
queued
  -> starting
  -> running
  -> waiting_approval / paused
  -> completed / failed / cancelled
```

Condensed primary path shown — not exhaustive; the full transition matrix per merged contracts governs.

Only legal transitions defined by merged contracts are permitted.

### 7.2 Optional Stage State

When Stages are used:

```text
pending -> ready -> starting -> running
running -> waiting_approval / paused
running / waiting_approval / paused -> completed / failed / cancelled
pending -> skipped / cancelled
```

Condensed primary path shown — not exhaustive; the full transition matrix per merged contracts governs.

Workflow templates define Stage keys and dependencies.

The Run Engine does not hard-code Agent or Provider names as Stage types.

### 7.3 Canonical Transition Events

The merged mappings remain frozen:

| Transition | Canonical Event |
|---|---|
| Run `queued -> starting` | `run.dequeued` |
| Run `starting -> running` | `run.started` |
| Stage `ready -> starting` | `stage.starting` |
| Stage `starting -> running` | `stage.started` |

One Event must not represent two of these transitions.

## 8. Startup

### 8.1 Startup Sequence

```text
Scheduler selects queued Run
  -> atomically acquire execution right
  -> queued -> starting + run.dequeued
  -> validate snapshots and workflow
  -> validate Provider Configuration
  -> retrieve and freeze Memory Context
  -> validate cwd and Git observation inputs
  -> prepare first eligible Stage if used
  -> start Provider through Adapter
  -> register owned Process
  -> confirm Provider active
  -> starting -> running
  -> stage.started before run.started when both occur
```

The startup transaction must not report `running` before Provider activity and required snapshots are confirmed.

### 8.2 Startup Failure

If one startup Stage has entered `starting`, the frozen order is:

```text
stage.failed -> run.failed
```

If no Stage entered `starting`, only `run.failed` is emitted.

Current state, versions, contiguous Run Event sequences, Events, and independent Outbox rows commit atomically.

No synthetic `stage.failed` is invented for a Stage that never started.

## 9. Provider and Process Execution

The Provider Adapter translates canonical execution input into Provider-specific invocation.

The Provider retains reasoning, native tools, subagents, Git mechanics, and planning strategy.

AgentOS retains:

- Provider Configuration snapshot/reference;
- capability declarations;
- Provider Session reference when exposed;
- Process ownership;
- cancellation and timeout control;
- normalized Events that can be justified by evidence;
- raw output Artifact reference when needed.

The Process runtime owns OS process creation and tree control.

On Windows, the active direction preserves Job Object ownership, process-tree cancellation, bounded output, and native identity evidence.

Process exit code zero does not by itself complete a Stage or Run.

## 10. Event and Outbox Path

For every durable lifecycle transition:

```text
validate command and expected version
  -> update current state
  -> allocate per-Run sequence
  -> append registered Runtime Event
  -> append that Event's Outbox record
  -> commit
  -> publish
```

Publication failure never rolls back a committed Event.

Outbox reclaim, retry, deterministic backoff, and dead-letter behavior preserve the same Event ID and sequence and do not repeat domain transitions.

Consumers and projections are idempotent.

## 11. Operations, Idempotency, and Concurrency

Long-running or controlled commands use durable Operation resources as required by merged API contracts.

Start, retry, and cancel preserve their frozen acceptance windows and history semantics.

Idempotency keys are required where merged contracts require them, including creation and control requests.

A repeated accepted request returns or converges on the original result rather than creating duplicate Run, Process, Event, or execution authority.

Optimistic concurrency and expected-version checks prevent:

- duplicate start;
- cancel versus completion races;
- repeated retry creation;
- double approval decisions;
- duplicate Workspace mutation admission.

## 12. Cancellation

Cancel is an explicit user or authorized system control request.

It is not equivalent to browser close, SSE disconnect, UI navigation, or provider silence.

The control flow is:

```text
Cancel request
  -> validate idempotency and transition right
  -> stop new Stage scheduling
  -> cancel pending approvals as required
  -> request Provider cancellation when supported
  -> terminate the AgentOS-owned Windows process tree
  -> finalize bounded output references
  -> cancel every nonterminal Stage in deterministic order
  -> commit final run.cancelled
  -> release Workspace modifying authority
```

For Stage-backed Runs, `stage.cancelled` Events precede `run.cancelled` in `stage.sequence ASC`, then `stage.id ASC` order.

A Stage cancellation Event does not itself terminate a Process; Process control remains owned by the Process runtime.

Repeated Cancel is safe.

## 13. Completion and Acceptance

Run completion requires:

- required Stages terminal and successful under the workflow contract;
- no active owned Process;
- required Events and Outbox records committed;
- required Artifact references finalized;
- final observable Git state recorded where available;
- completion rule satisfied.

The terminal sequence preserves merged event ordering, including `stage.completed -> run.completed` when both apply.

Run completion means the execution attempt completed successfully.

It does not mean:

- Task accepted;
- changes committed;
- changes merged;
- Provider claim automatically trusted.

Task acceptance is a separate durable decision.

## 14. Failure

Failures are classified by phase:

- validation;
- Workspace admission;
- startup;
- Provider;
- Process;
- control or approval;
- output/finalization;
- persistence/Event/Outbox;
- recovery.

A failure records a stable error code, phase, retryability, affected references, and safe suggested action.

Raw sensitive error detail belongs in a restricted Artifact.

Critical Event persistence failure blocks the associated state transition.

Failure does not delete prior Events, output references, Memory Context, or observable Git state.

## 15. Retry

Retry creates a new Run.

```text
Run 1 terminal
  -> Retry Operation
  -> Run 2 queued
  -> Run 2.parentRunId = Run 1.id
  -> Run 2.rootRunId = Run 1.rootRunId
```

The new Run may change Agent, Provider, workflow template, timeout, Memory budget, or user instructions.

It does not rewrite Run 1.

Previous summaries, errors, Artifacts, and Git observations are referenced selectively, not injected as an unbounded raw log dump.

## 16. Browser Disconnect and Reconnect

```text
browser disconnect
  -> subscription ends
  -> Run and Process continue
  -> Events continue to persist
  -> client reconnects with cursor
  -> replay cursor+1 through high-watermark
  -> drain buffered Events
  -> continue live
```

Client subscription state is not Run state.

Multiple clients may observe the same Run.

Only the explicit Cancel control path can cancel it.

## 17. Windows Restart Recovery

Recovery is **ACTIVE LITE**, Windows-only, and fail closed.

### 17.1 Startup Scan

The Server scans durable queued and active Runs, Stages, Operations, Processes, approvals, Event sequences, and Outbox state.

OS process inspection occurs before a SQLite write transaction.

The transaction consumes a precomputed classification so it never holds a database write lock across asynchronous OS probing.

### 17.2 Process Identity Classifications

The Lite vocabulary is:

| Classification | Meaning | Safe default disposition |
|---|---|---|
| `MISSING` | Positive OS evidence proves the PID is absent. | Canonical failure/reconciliation; never resume. |
| `MISMATCH` | PID exists but lossless native creation identity differs. | Treat as PID reuse; never signal or adopt the foreign process. |
| `UNKNOWN` | Evidence is absent, ambiguous, inaccessible, or inconsistent. | Preserve uncertainty / recovery required; never guess success. |
| `SAME` | PID and lossless native creation identity positively match where technically possible. | Identity fact only; no automatic continuation authority. |

PID alone never proves `SAME`.

The current merged P6-M2 production verifier can positively prove `MISSING` and otherwise remains `UNKNOWN`.

The merged P6-M3a contract freezes lossless Windows creation FILETIME as the required direction for safe `MISMATCH` and technically justified `SAME` classification; process reattachment remains **DEFERRED FULL-SCOPE**.

The normal AgentOS-owned Windows Job Object path uses kill-on-close, so after ownership-chain loss the expected clean result is commonly `MISSING`.

`SAME` is identity evidence only; under the **DEFERRED FULL-SCOPE** continuation model it is not equivalent to reattachable, controllable, or output-continuous.

### 17.3 Recovery Non-Goals

Lite recovery does not require:

- provider process reattachment;
- provider session adoption;
- surviving-process ownership transfer;
- arbitrary process continuation;
- orphan takeover;
- automatic respawn;
- non-Windows recovery expansion.

When continuation cannot be proven safe, the user may create a new retry Run.

Recovery never constructs a second execution authority for the interrupted Run.

## 18. Bounded Workflow Lifecycle

Workflow templates instantiate a finite Stage graph or sequence.

They must declare:

- bounded Stage count;
- dependencies and deterministic ordering;
- Agent and Provider selection rules;
- read-only or modifying classification;
- reply/attempt budget where collaborative;
- completion and failure rule;
- output references.

Parallel Stage execution is limited to read-only work unless modification is serialized under the Workspace's sole modifying authority.

The visual workflow editor and arbitrary distributed scheduler are **DEFERRED FULL-SCOPE**.

## 19. Compatibility with the Existing Runtime

Lite retains merged M3 lifecycle, Event, Outbox, Operation, SSE, recovery, and legacy projection contracts.

It retains merged M4 Process and Provider foundations where they support Windows ownership, cancellation, durable output, Provider abstraction, and observability.

Compatibility routes and historical Event fields may remain while callers depend on them.

No second Runtime, Event Store, recovery authority, or execution authority is introduced.

Existing Worktree-related fields may remain under **COMPATIBILITY** without creating an active Worktree startup requirement.

## 20. Deferred / Non-Goals

- AgentOS Worktree creation, lifecycle, and recovery;
- automatic branch, merge, conflict, or integration management;
- full Policy Runtime and grants;
- POSIX/macOS lifecycle parity;
- process reattach, adoption, or takeover;
- Provider Comparison execution flow;
- unbounded autonomous workflows;
- distributed workers.

## 21. Acceptance Expectations

Independent verification must cover:

- Message-only turns do not create modifying Runs;
- Task creation is idempotent and separate from Run creation;
- modifying admission never permits two active modifying Runs in one Workspace;
- Run graph creation is atomic and ordered;
- transition-to-Event mappings remain exact;
- every durable Event has the required independent Outbox row;
- publication retry does not repeat a domain transition;
- browser disconnect leaves Run and Process active;
- reconnect provides gap-free, duplicate-free replay plus live delivery;
- Cancel terminates the owned Windows process tree and orders terminal Events;
- retry creates a new Run with preserved lineage;
- Process exit does not falsely complete a Run;
- recovery handles `MISSING`, `MISMATCH`, `UNKNOWN`, and technically justified `SAME` without guessing continuation;
- recovery preserves the **NON-GOAL** of reattach/adoption/respawn and creates no duplicate authority;
- Worktree absence does not block a modifying Run after Workspace admission;
- failures preserve evidence and release authority only through committed transitions.

## 22. Cross-Document References

- [00 — Vision](./00-Vision.md) defines product authority and Fast Track.
- [01 — Core Concepts](./01-Core-Concepts.md) defines Task, Run, Stage, Process, and ownership.
- [03 — Event Model](./03-Event-Model.md) defines Event ordering, Outbox delivery, SSE, and projections.
- `04-Provider-Specification.md` will define Adapter and capability behavior.
- `05-Process-Runtime.md` will define Windows Job Object and native identity contracts.
- `06-Worktree-Runtime.md` will define Git Observation / Workspace Mutation Boundary without a Worktree dependency.
- `09-Conversation-Runtime.md` will define turn, Message, and Run bridges.
