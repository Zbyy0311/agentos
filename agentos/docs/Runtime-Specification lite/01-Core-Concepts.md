# AgentOS Runtime Specification Lite

## 01 — Core Concepts

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs retain authority for already-frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical `Runtime-Specification` remains reference architecture where it is broader than Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

This document defines the canonical Lite vocabulary, first-class entities, ownership boundaries, identity rules, and system invariants.

It is the common language for persistence, APIs, lifecycle, events, providers, process runtime, Memory, Conversation, UI, and history.

The classifications **ACTIVE LITE**, **COMPATIBILITY**, and **DEFERRED FULL-SCOPE** describe product scope.

They do not by themselves claim implementation status.

## 2. Lite Domain at a Glance

```text
Workspace
├── Agent Profile
│   └── selects Provider Configuration per Run or Stage
├── Conversation
│   └── Message
│       └── may optionally create or reference Task / Run / Artifact
├── Task
│   └── Run
│       ├── optional Stage
│       ├── Provider Session reference
│       ├── Process
│       ├── Runtime Event
│       ├── Memory Context Snapshot
│       ├── Artifact reference
│       └── Git observation
├── Memory Entry
├── Workflow Template
└── Agent History / Search projection
```

The domain graph does not include Provider-native worktrees, subagents, tools, plans, or Git operations as canonical AgentOS entities.

Those details may be observed or referenced without becoming AgentOS-owned state.

## 3. Stable Identity Rules

Every durable first-class object has an immutable AgentOS ID.

Recommended prefixes remain descriptive:

| Entity | Prefix example |
|---|---|
| Workspace | `ws_` |
| Agent Profile | `agent_` |
| Provider Configuration | `provider_` |
| Conversation | `conv_` |
| Message | `msg_` |
| Task | `task_` |
| Run | `run_` |
| Stage | `stage_` |
| Process | `proc_` |
| Runtime Event | `evt_` |
| Memory Entry | `mem_` |
| Artifact | `art_` |

IDs must be globally unique, stable in URLs and Events, opaque, and free of secrets.

An AgentOS Process ID is not a native PID.

A native PID is mutable OS evidence that can be reused and must never be the durable identity or sole recovery proof.

## 4. First-Class Lite Concepts

### 4.1 Workspace

A Workspace is the long-lived project boundary for paths, Agents, Conversations, Tasks, Runs, Memory, Artifacts, history, and mutation admission.

It normally references a local directory and may observe a Git root.

It is not a Worktree.

Workspace invariants:

- every Task, Run, and Conversation belongs to exactly one Workspace;
- the root path is normalized and boundary checked;
- Runtime data is not owned by ad hoc Markdown files in the project directory;
- Runs may overlap as read-only only when the Adapter/platform technically denies Workspace writes for that execution;
- at most one AgentOS modifying Run executes in the Workspace at a time;
- provider-internal isolation does not replace AgentOS mutation admission.

### 4.2 Agent Profile

An Agent Profile is a persistent AI team-member identity.

It defines who is working, not which Provider is invoked.

An Agent Profile may include:

- stable ID and display name;
- role and description;
- capability labels;
- behavioral guidance;
- default Provider Configuration;
- Memory scopes;
- enabled state.

An Agent Profile may use Kimi Code yesterday and Codex today while retaining one Agent History.

Execution records preserve an Agent snapshot so later profile edits do not rewrite history.

### 4.3 Provider Configuration

A Provider Configuration is an executable configuration for a provider such as Codex, Kimi Code, or OpenCode.

It includes provider type, runtime mode, executable or endpoint references, model/profile selection, capability declarations, environment references, and enabled state.

Secrets are references, not ordinary configuration values or snapshots.

Provider Configuration is data.

Provider Adapter is code.

Provider Session is a native execution reference.

None is an Agent identity.

### 4.4 Conversation

A Conversation is a durable communication space within a Workspace.

Lite supports:

- direct Conversation with one primary Agent;
- bounded Group Conversation with explicit members and controls;
- system projections when a durable runtime fact should be shown to a user.

Conversation persists independently of a provider-native session.

Archiving a Conversation does not delete linked Tasks, Runs, Memory, or Artifacts.

### 4.5 Message

A Message is an ordered, durable communication record in a Conversation.

It may contain text, attachments, or trusted references to Task, Run, approval, Memory explanation, or Artifact resources.

A Message is not a Prompt.

A Prompt is a provider execution input assembled from selected domain data.

A normal Message does not implicitly create a Task and never implicitly starts a modifying Run.

### 4.6 Task

A Task is durable work intent: what should be accomplished.

A Task may exist without any Run and may own many Runs.

Task completion represents accepted intent, not merely the terminal state of the newest Run.

Failure or cancellation of one Run does not erase the Task or its other attempts.

### 4.7 Run

A Run is one durable execution attempt for a Task, or for an explicitly allowed Conversation turn that requires execution.

A Run freezes the execution-relevant Agent, Provider, workflow, policy, Memory, and Workspace inputs required by merged contracts.

A Run owns lifecycle state, Event sequence, operation/control history, Process references, Artifacts, and recovery outcome.

Retry always creates a new Run with parent/root lineage.

A completed Run does not automatically complete its Task.

### 4.8 Stage

A Stage is an optional bounded step within a Run.

Use Stage only when a workflow needs separately observable responsibilities, ordering, output contracts, or failure boundaries.

The Single Agent path may use one Stage or the minimum representation required by merged lifecycle contracts.

Stage keys are data from a workflow template, not hard-coded Provider or Agent roles.

Parallel Stage execution is allowed only when it preserves the Workspace mutation rule.

### 4.9 Process

A Process is AgentOS's durable record of OS execution.

It may reference:

- AgentOS Process ID;
- native PID as evidence;
- Process role and parent/root relationship;
- cwd;
- redacted executable and arguments;
- timestamps and exit data;
- Windows native identity evidence;
- ownership and cancellation metadata.

A Run may own multiple Processes.

A Process exit does not prove Run success.

### 4.10 Runtime Event

A Runtime Event is an immutable, structured fact about a Run or its controlled bridge to another domain.

Durable Events are ordered per Run, persisted before publication, versioned, redacted, and replayable.

Runtime Event is not mutable current state, a log line, provider stdout, or a Conversation Message.

### 4.11 Memory

Memory is structured, selected, source-linked knowledge intended for later retrieval.

The primary object is `MemoryEntry` with Scope, Category, Authority, Confidence, Importance, Source, conflict state, and lifecycle metadata.

Retrieval produces candidates, ranking, budget selection, and an immutable Context Snapshot with selection explanations.

Memory does not replace complete Conversation History.

### 4.12 Artifact

An Artifact is a managed immutable reference to produced or captured content.

Examples include a summary, diff, changed-file list, test report, screenshot, redacted raw output, or debug bundle.

Large or sensitive content belongs behind an Artifact reference, not inside ordinary Event payloads.

An Artifact is not every file in a Workspace.

### 4.13 History

History is a query and projection capability over canonical AgentOS records.

Agent History links:

- direct and group Conversations;
- Messages and turns;
- Tasks and Runs;
- Provider Session references;
- Memory and Context Snapshots;
- Artifacts and Git observations;
- failures and recovery;
- usage when genuinely available.

History is owned by AgentOS identity and remains unified across Provider changes.

Search is an active target and must support Agent, Workspace, Conversation, Task, Run, Provider, time, status, and content/type filters without indexing secrets.

## 5. Required Distinctions

| Concepts | Contract |
|---|---|
| Agent vs Provider | Agent is persistent identity; Provider supplies execution capability. |
| Task vs Run | Task is intent; Run is one attempt. |
| Message vs Task | Message communicates; Task formalizes optional work intent. |
| Message vs Run | Message never implies execution; Run is explicit durable authority. |
| Run vs Process | Run is a domain attempt; Process is OS execution. |
| Process ID vs PID | `proc_...` is durable; PID is reusable native evidence. |
| Provider Session vs Agent | Session is provider-scoped and transient; Agent is canonical and persistent. |
| Memory vs Conversation History | Memory is selected knowledge; history is complete durable record. |
| Runtime Event vs Message | Event records runtime fact; Message records communication. |
| Runtime Event vs log | Event has registered semantics; log is diagnostic text. |
| Artifact vs Workspace file | Artifact is managed and source-linked; a file is a path object. |
| Git observation vs Git ownership | Observation records facts; ownership performs workflow operations. |

## 6. Canonical Ownership Matrix

| Concern | Canonical AgentOS owner | External or noncanonical reference |
|---|---|---|
| long-lived team identity | Agent Profile | model name, Provider account, native subagent |
| execution configuration | Provider Configuration | provider defaults and native config |
| communication | Conversation / Message | provider-native transcript |
| work intent | Task | chat text alone |
| execution attempt | Run | HTTP request or browser session |
| bounded workflow step | Stage | provider's internal planner step |
| OS execution | Process | PID alone |
| runtime fact | Runtime Event | stdout or raw provider log |
| long-term knowledge | Memory Entry | full transcript dump |
| produced content | Artifact | arbitrary file path alone |
| historical identity view | Agent History | provider-native history |
| workspace mutation admission | Workspace runtime | provider-internal Worktree |
| Git traceability | Git observation | AgentOS-owned branch/merge workflow |

## 7. Provider-Native Noncanonical Details

The following remain Provider implementation details unless a cross-provider correctness contract explicitly promotes a bounded reference:

- native Git commands and branches;
- provider-created worktrees;
- native subagents;
- provider tool calls;
- internal plans and reasoning strategy;
- context-window management;
- sandbox mechanics;
- native session state;
- native telemetry.

AgentOS may record a redacted reference or observation.

It must not infer facts the Provider did not reliably expose.

Provider-native subagents never automatically become Agent Profiles.

## 8. Workspace Run Classification

Every Run Request is classified before admission as:

```text
requested read-only
  + no declared modifying or external action
  + tested enforcedWorkspaceReadOnly capability is effective for this execution
  -> read-only
  -> Workspace writes are technically denied

otherwise
  -> may change Workspace content or perform a declared modifying action
  -> modifying
```

Requested intent and effective admission class are distinct. Prompt wording such as "do not modify files" is intent only and cannot establish read-only eligibility.

Unknown or ambiguous classification, unavailable write-denial enforcement, or an unsupported `enforcedWorkspaceReadOnly` capability is treated as modifying for admission safety. A Provider-native worktree does not imply the capability.

Effectively read-only Runs may execute concurrently subject to global, Provider, Agent, and resource limits.

Only one AgentOS modifying Run may hold execution authority for a Workspace.

Additional modifying Runs are queued or rejected using a stable reason and durable Operation result.

Admission is not delegated to a Prompt.

Provider-internal worktrees do not permit AgentOS to admit a second modifying Run.

## 9. Workflow Templates

A Workflow Template is a built-in or JSON-defined bounded structure that instantiates optional Stages.

Lite requires useful templates rather than a general visual DAG editor.

Baseline templates:

```text
Single Agent

Plan -> Implement -> Review

Parallel Analysis
  ├── Agent A (effectively read-only; writes denied)
  ├── Agent B (effectively read-only; writes denied)
  └── Agent C (effectively read-only; writes denied)
       -> Final Synthesis

Security Review (optional)
```

Any modifying stage sequence is serialized by Workspace admission.

The workflow does not own Run durability, Process control, Events, or recovery.

## 10. Snapshots and References

Historical explainability requires immutable execution snapshots or references frozen by merged contracts.

At minimum, a Run must preserve the execution-relevant identity of:

- Agent Profile;
- Provider Configuration and capabilities;
- workflow template/version;
- minimal policy decision context;
- Memory Context Snapshot;
- Workspace cwd and mutation classification;
- observable Git base state when available.

Snapshots exclude secret values, cookies, private keys, raw credentials, and unrelated UI preferences.

Provider-native session IDs may be stored as scoped references.

They never become canonical Agent or Conversation identity.

## 11. Current State, Events, and Projections

Current aggregate state answers what is true now.

Runtime Events answer what durably happened.

Projections provide read-optimized UI, history, and search views.

No projection becomes a second execution authority.

Conversation cards derived from Runtime Events are idempotent projections and do not replace the source Event or target resource.

Raw Provider output may be retained as a restricted Artifact but is not current state or a canonical Event by itself.

## 12. Safety and Failure Invariants

- All durable state transitions use merged transaction, version, and idempotency contracts.
- Retry creates a new Run; no terminal Run is reset for another attempt.
- Browser disconnect changes only subscription state.
- Cancel is an explicit control request and terminates the owned process tree through the Process runtime.
- Native PID alone never proves identity, ownership, success, or safe cancellation.
- Recovery uncertainty remains fail closed.
- Secret values are excluded from ordinary Events, logs, snapshots, Memory, Artifacts without restriction controls, and search.
- Provider capability absence remains absence; AgentOS does not invent telemetry.
- A modifying Run cannot execute without holding the Workspace's sole modifying authority.
- Process completion, Run completion, Task acceptance, and Git integration are separate facts.

## 13. Scope Boundaries

### ACTIVE LITE

All first-class concepts in section 4, the single-writer rule, workflow templates, Memory Foundation, bounded collaboration, and Agent History/Search are active forward scope.

### COMPATIBILITY

Existing durable entities, schemas, fields, Event types, and APIs may remain when required by merged contracts or current callers.

Compatibility records outside the Lite critical path are not automatically first-class product surfaces.

### DEFERRED FULL-SCOPE

- canonical AgentOS Worktree, Branch, Merge, and Conflict management;
- full Policy profiles, grants, enterprise RBAC, and simulation;
- process reattach/adoption and ownership transfer;
- Provider Comparison product;
- visual workflow editor;
- Vector Database requirement;
- distributed, cloud, Tauri desktop, and mobile platform expansion.

## 14. Lite Fast-Track Concept Sequence

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

Provider Comparison, full Worktree Runtime, full Policy Runtime, advanced Memory, and the full Workflow Editor are deferred. [13 — Runtime Inspector](./13-Runtime-Inspector.md) defines the final implementation-priority gate.

## 15. Compatibility with the Existing Runtime

Lite preserves existing SQLite identities, migrations, version columns, idempotency records, lifecycle state, Runtime Events, Outbox rows, Operation resources, SSE cursors, Process records, Provider abstractions, and recovery evidence.

Lite does not require destructive schema simplification or a large deletion campaign.

Where a merged field reflects deferred full-scope behavior, it may remain under **COMPATIBILITY** until a separately authorized migration or ADR changes it.

The historical full specification remains useful for understanding those fields but does not expand Lite's forward critical path.

## 16. Acceptance Expectations

Independent checks must prove:

- each durable entity uses stable IDs and correct parent references;
- Agent identity remains stable across Provider changes;
- Message creation is distinct from Task and Run creation;
- Task supports zero or many Runs;
- retry creates a new Run lineage;
- Run and Process can be queried independently;
- Process ID and native PID cannot be confused by API or UI labels;
- one Workspace cannot admit two modifying Runs;
- read-only concurrency requires tested technical Workspace write denial and does not bypass Provider or resource limits;
- prompt-only or user-forced capability claims never create read-only eligibility;
- Stage remains optional and bounded;
- Memory Context Snapshot records why entries were selected;
- Agent History links canonical records rather than provider-native history;
- unknown Provider details do not become invented facts;
- archived or compatibility records do not disappear destructively.

## 17. Cross-Document References

- [00 — Vision](./00-Vision.md) defines authority, product boundary, and Fast Track.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) applies these entities to execution, control, and recovery.
- [03 — Event Model](./03-Event-Model.md) defines immutable facts and projections.
- `04-Provider-Specification.md` will define Adapter and capability boundaries.
- `05-Process-Runtime.md` will define Windows Process identity and ownership.
- `06-Worktree-Runtime.md` will define Git Observation / Workspace Mutation Boundary.
- `07-Memory-Runtime.md`, `09-Conversation-Runtime.md`, and `10-Data-Model.md` will elaborate Memory, communication, and persistence.
