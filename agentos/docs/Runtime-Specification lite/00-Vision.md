# AgentOS Runtime Specification Lite

## 00 — Vision

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs retain authority for already-frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical `Runtime-Specification` remains reference architecture where it is broader than Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

This document defines the product destination, engineering boundary, and decision rules for AgentOS Runtime Specification Lite.

AgentOS Lite is a persistent, provider-independent control and collaboration layer for multiple AI coding agents.

It is designed as an AI engineering workbench whose durable identity, execution, observability, memory, and history remain coherent when the selected provider changes.

This document defines direction, not implementation status.

No capability is considered implemented merely because it is marked **ACTIVE LITE**.

Implementation claims require code, tests, runtime evidence, and acceptance evidence.

## 2. Lite Architecture Authority

The precedence order is:

1. `Runtime-Specification lite` governs future product scope and implementation direction.
2. Merged implementation contracts and ADRs govern already-frozen low-level correctness.
3. Historical `Runtime-Specification` is full-scope reference and deferred architecture where it exceeds Lite.

When Lite and the historical full specification differ on future scope, Lite wins.

Lite does not retroactively weaken merged guarantees for:

- SQLite canonical persistence;
- migration compatibility;
- aggregate versioning;
- idempotency;
- Task and Run separation;
- lifecycle transitions;
- Runtime Event ordering;
- Event and Outbox atomicity;
- Operation resources;
- SSE replay and reconnect;
- Windows process ownership and process-tree cancellation;
- restart recovery and fail-closed uncertainty;
- PID-reuse protection;
- secret redaction;
- compatibility boundaries.

A future ADR is required to intentionally change a frozen correctness contract.

## 3. Product Definition

AgentOS Lite is:

> A persistent, provider-independent AI engineering workspace that gives long-lived Agents a unified place to converse, execute durable work, use structured Memory, collaborate under bounded controls, and retain searchable history across providers.

The primary experience is not a collection of CLI wrappers.

It is a coherent workbench for:

- persistent Agent identity;
- provider selection and delegation;
- direct and bounded group Conversation;
- durable Task and Run execution;
- Windows process ownership and recovery;
- ordered Runtime Events;
- structured Memory and explainable context selection;
- Artifact and Git observation;
- reusable workflow templates;
- polished streaming UI;
- focused Runtime inspection;
- unified Agent history and search.

## 4. Product Boundary

AgentOS Lite is not:

- another coding agent;
- another Provider-native agent runtime;
- another IDE;
- another Git client;
- a Worktree Manager;
- an automatic merge engine;
- an infinite autonomous-agent framework;
- a provider benchmark product.

AgentOS owns cross-provider facts and control boundaries.

Providers retain their own intelligence and mature engineering mechanics.

## 5. Provider Delegation Principle

> Do not reimplement mature provider-native capabilities unless AgentOS needs them for cross-provider correctness or observability.

Codex, Kimi Code, OpenCode, and future providers may internally own:

- reasoning and planning;
- Git and branch operations;
- internal worktrees;
- native subagents;
- sandboxing;
- native tools;
- provider context handling;
- provider execution strategies;
- native session mechanics.

Those mechanisms are provider implementation details.

They are not canonical AgentOS state merely because a provider exposes them.

AgentOS canonically owns:

- Workspace identity and mutation admission;
- Agent Profile;
- Provider Configuration and selection;
- Conversation and Message;
- Task and Run;
- optional bounded Stage;
- Process ownership records;
- Runtime Events and control operations;
- cancellation and recovery classification;
- Memory and Context Snapshot;
- Artifact references;
- history and search;
- orchestration boundaries.

## 6. Shared Foundation Invariants

All Lite documents and implementations must preserve these distinctions:

| Invariant | Meaning |
|---|---|
| Agent != Provider | A persistent Agent identity may use different providers over time. |
| Task != Run | A Task is durable intent; a Run is one execution attempt. |
| Message != Task or Run | Communication does not implicitly create or execute work. |
| Run != Process | A Run is a domain attempt; a Process is an OS execution record. |
| AgentOS Process ID != native PID | The durable Process identity is not a reusable OS number. |
| Provider Session != Agent identity | A native session is a reference scoped to provider execution. |
| Memory != Conversation History | Memory is selected, structured knowledge; history is the durable record. |
| Provider internals != canonical state | Native Git, worktrees, subagents, tools, and planning remain noncanonical details. |
| Git observation != Git ownership | AgentOS records traceability facts but does not own the Git workflow. |
| Browser disconnect != Run cancellation | Transport lifetime never owns execution lifetime. |
| Modifying Run concurrency = one per Workspace | Runs overlap as read-only only with tested technical Workspace write denial; every other Run is admitted as modifying. |

## 7. Windows-Only Platform Scope

AgentOS Lite is Windows-only.

Active engineering targets:

- Windows process creation and ownership;
- Windows Job Object process-tree containment;
- reliable cancellation and timeout;
- native process identity evidence;
- PID-reuse-safe recovery classification;
- Windows paths, junctions, file locks, shells, and encodings.

Existing non-Windows code may remain under **COMPATIBILITY** when it is already depended upon or inexpensive to retain.

**DEFERRED FULL-SCOPE:** Linux, POSIX, macOS, FreeBSD, `/proc`, `bootId`, `startTicks`, and cross-platform native process identity expansion are not Lite requirements.

## 8. Lite Scope Classification

### 8.1 ACTIVE LITE

- provider-independent Agent identity;
- multiple Provider Configurations;
- persistent Conversation and Message history;
- durable Task, Run, optional Stage, Process, and Runtime Event foundations;
- Windows process ownership, cancellation, and fail-closed recovery;
- SQLite persistence, migrations, idempotency, operations, and Outbox;
- Memory Foundation with SQLite FTS5, ranking, budget, snapshots, and explanation;
- minimal Git observation;
- one modifying Run per Workspace;
- minimal enforceable `ALLOW`, `DENY`, `ASK_USER` safety decisions;
- polished dark/light UI and the four-column workbench;
- direct Conversation;
- bounded Group Conversation;
- built-in or JSON-defined workflow templates;
- focused Runtime Inspector;
- unified Agent history and search.

### 8.2 COMPATIBILITY

- existing schemas and migrations outside the Lite critical path;
- compatible APIs and legacy projections;
- existing non-Windows source retained without new platform investment;
- historical Event types and fields retained where consumers depend on them;
- low-maintenance full-scope code that supports merged correctness.

Compatibility is not an instruction to delete working code.

It is also not authority to expand deferred scope.

### 8.3 DEFERRED FULL-SCOPE

- full AgentOS-owned Git runtime;
- full Worktree lifecycle and Integration Worktree;
- Branch, Merge, Conflict, and Worktree Recovery managers;
- full Policy DSL, rule-precedence engine, grants, simulation, and enterprise RBAC;
- process reattach, adoption, ownership transfer, or arbitrary process takeover;
- mandatory Vector Database or remote embeddings;
- autonomous infinite group chat;
- visual workflow DAG editor;
- Provider Comparison and benchmarking product;
- plugin marketplace;
- Tauri desktop;
- distributed workers;
- cloud multi-tenancy;
- mobile application.

## 9. Workspace Mutation Boundary

Without a full AgentOS Worktree Runtime, Lite uses a deliberately simple concurrency contract.

Within one Workspace:

```text
requested read-only
  + no declared modifying or external action
  + enforcedWorkspaceReadOnly = true from tested Adapter/platform evidence
  -> effective read-only
  -> may execute concurrently within configured limits

otherwise, including unknown capability
  -> effective modifying
  -> at most one AgentOS modifying Run at a time

additional modifying Runs
  -> queued or rejected by the runtime contract
```

`enforcedWorkspaceReadOnly` means filesystem writes to the admitted Workspace are technically denied for the execution boundary. Intent, prompt text, or a Provider-native worktree is not enforcement. Users may not force an unsupported capability to `true`.

Provider-internal worktrees are allowed.

They do not satisfy, replace, or become AgentOS canonical isolation state.

## 10. Controlled Collaboration

Direct Conversation is the primary interaction path.

Group Conversation is **ACTIVE LITE** but bounded by:

- explicit members and mentions;
- sequential reply mode;
- bounded parallel effectively-read-only reply mode with enforced Workspace write denial;
- reply budgets;
- stop controls;
- loop and hop guards;
- per-Agent context;
- Workspace mutation serialization.

Parallel analysis, planning, and review are allowed.

Parallel modification of one Workspace by AgentOS Runs is not required and is prohibited by the single-writer rule.

Workflow collaboration is template-first.

The baseline templates are:

- Single Agent;
- Plan -> Implement -> Review;
- Parallel Analysis -> Final Synthesis;
- optional Security Review.

## 11. Memory and History

Memory is a core differentiator, not an optional convenience.

The Lite foundation includes:

- `MemoryEntry`;
- Scope, Category, Authority, Confidence, Importance, and Source;
- Candidate generation;
- deduplication and conflict handling;
- SQLite FTS5 retrieval;
- ranking;
- context budgeting;
- immutable Context Snapshot;
- selection explanation.

Every Run must be able to answer:

> Why did this Run receive this memory?

Agent History is unified by Agent identity, not split by Provider.

A Provider Session remains a reference within that history.

Search must link Conversations, Messages, Tasks, Runs, Memory, Artifacts, failures, Provider references, and available usage without indexing secrets.

## 12. UI and Inspector Destination

The Lite UI is an active product requirement.

The primary workbench is approximately:

```text
+-------------+------------------+----------------------+----------------+
| Agents      | Conversations    | Main Canvas          | Inspector      |
|             |                  |                      |                |
| persistent  | direct/group     | Chat / Run /         | Runtime /      |
| identities  | history          | Artifact             | Events /       |
|             |                  |                      | Memory /       |
|             |                  |                      | Process        |
+-------------+------------------+----------------------+----------------+
```

It must provide polished typography, layout, dark/light themes, deliberate motion, reduced-motion basics, resilient streaming, and clear loading, empty, and error states.

The Inspector explains Run, Stage, Provider, Process, Events, Memory Context, Artifacts, Git observation, errors, cancellation, retry, and recovery.

It is not an IDE, Git client, or debugger replacement.

## 13. Fast-Track Product Destination

The forward order is:

```text
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
```

Provider Comparison, full Worktree Runtime, full Policy Runtime, advanced Memory, and the full Workflow Editor are deferred.

Each step must have evidence-based entry and exit gates.

No step is complete merely because it appears in this specification.

## 14. Portfolio and Engineering Strength

Lite intentionally preserves three forms of engineering depth.

### 14.1 Systems Engineering

- SQLite transactions and migrations;
- optimistic concurrency and idempotency;
- Event and Outbox durability;
- Windows Job Object ownership;
- process-tree cancellation;
- restart recovery;
- PID-reuse protection;
- native process identity.

### 14.2 AI Systems Engineering

- persistent Agent identity;
- structured Memory;
- FTS retrieval and ranking;
- context budgeting;
- reproducible Context Snapshot;
- explainable selection.

### 14.3 Product Engineering

- polished streaming UI;
- direct and bounded group interaction;
- Runtime Inspector;
- Memory explanation;
- reusable workflow templates;
- unified history and search.

Scope reduction removes duplicated infrastructure without reducing these strengths.

## 15. Safety and Failure Rules

- When recovery evidence is uncertain, do not guess success.
- A native PID alone never proves Process identity.
- Provider claims do not override canonical lifecycle state.
- Raw provider logs do not become canonical facts without safe normalization.
- Secret values do not enter ordinary Events, logs, Memory, snapshots, or search indexes.
- Browser or UI failure does not cancel a Run.
- A modifying Run must pass Workspace admission before execution authority is granted.
- High-impact actions at AgentOS-controlled or verified Provider pre-action boundaries are enforced in code through `ALLOW`, `DENY`, or `ASK_USER`; un-interceptable Provider-native actions are reported as unavailable enforcement rather than falsely claimed blocked.
- Retry creates a new Run and preserves the prior attempt.

## 16. Compatibility with the Existing Runtime

Lite is an incremental forward direction, not a Runtime Core replacement.

Already-merged schemas, migrations, lifecycle rules, Events, Outbox delivery, Operations, Process ownership, Provider abstractions, recovery evidence, APIs, and projections remain under **COMPATIBILITY** where current correctness or callers depend on them.

No large deletion, clean-sheet database redesign, or second Runtime is implied by this specification.

## 17. Acceptance Expectations

The Lite product direction is acceptable when independent evidence shows:

- a persistent Agent can change Provider without losing canonical identity or history;
- Conversation and Message records survive reconnect and restart;
- Task, Run, Process, and Event remain distinct and traceable;
- a Run survives browser disconnect;
- Runtime Events remain ordered, durable, replayable, and redacted;
- Windows cancellation handles the owned process tree;
- recovery classifies uncertainty without guessing completion;
- one Workspace never has two AgentOS modifying Runs executing concurrently;
- concurrent read-only Runs cannot mutate the Workspace because admission requires tested `enforcedWorkspaceReadOnly` evidence;
- Memory selection is reproducible and explainable;
- Git changes are observable without AgentOS owning Git workflow execution;
- the UI presents the four-column engineering workbench with a focused Inspector;
- Group Conversation and workflow templates remain bounded.

## 18. Cross-Document References

- [01 — Core Concepts](./01-Core-Concepts.md) defines canonical entities, ownership, and distinctions.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines durable execution, cancellation, retry, and recovery.
- [03 — Event Model](./03-Event-Model.md) defines ordered Runtime facts and delivery.
- `04-Provider-Specification.md` will define provider delegation and capability declarations.
- `05-Process-Runtime.md` will define Windows process ownership and native identity evidence.
- `06-Worktree-Runtime.md` will be reframed as Git Observation / Workspace Mutation Boundary.
- `07-Memory-Runtime.md`, `09-Conversation-Runtime.md`, `12-UI-Architecture.md`, and `13-Runtime-Inspector.md` will elaborate active product pillars.
