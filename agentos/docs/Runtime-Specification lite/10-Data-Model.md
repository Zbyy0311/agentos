# AgentOS Runtime Specification Lite

## 10 — Data Model

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs remain authoritative for frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical Runtime Specification remains reference architecture where it exceeds Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

This document maps Lite onto the real AgentOS SQLite model. It is not a clean-sheet schema.

Existing migrations, identities, versions, idempotency, Task/Run separation, snapshots, Events, Outbox, Operations, Provider Sessions, Processes, and output references are engineering assets.

ACTIVE LITE means forward product scope, not proof that every corresponding table or feature exists.

## 2. Scope Classification

### 2.1 ACTIVE LITE

- SQLite canonical persistence and Migration Runner;
- Workspace, Agent Profile, Provider Configuration;
- Task, Run, optional Stage, Workflow Definition, Run Snapshot;
- Runtime Event, Outbox, Dead Letter, Operation, Idempotency Record;
- Provider Session reference, Runtime Process, Process output reference;
- Artifact references;
- additive forward models for Conversation, Memory, History, and Search;
- versioned aggregates and optimistic concurrency;
- single-writer admission support.

### 2.2 COMPATIBILITY

- migration 001 baseline Conversation, Message, execution, Agent Run, Memory, preference, and Artifact tables;
- legacy JSON import and migration ledgers;
- legacy task and conversation pipelines;
- historical worktree-related snapshot fields and routes;
- existing policy decision and approval projections;
- existing non-Windows source retained without new investment.

### 2.3 DEFERRED FULL-SCOPE

- dedicated Worktree, Branch, Merge, Conflict, and Worktree Recovery schemas;
- full Policy DSL, rule, grant, exception, simulation, and RBAC schemas;
- generic extension, scheduler, marketplace, and distributed-worker schemas;
- mandatory Vector Database or embedding persistence;
- cloud multi-tenancy, mobile, Tauri, and PostgreSQL expansion.

## 3. Core Invariants

| Invariant | Contract |
|---|---|
| SQLite is canonical | Runtime state and control facts survive process and browser lifetime. |
| No destructive simplification | Published tables and migrations remain compatible. |
| Migration is additive | Drift is corrected by a new migration, never by editing history. |
| IDs are AgentOS identities | Native PID, Provider Session, and Git SHA are evidence or references. |
| Mutable aggregates are versioned | Writes require expected-version checks. |
| Snapshot is immutable | Historical execution inputs never follow current configuration. |
| Event is append-only | Corrections append new facts. |
| Persist then publish | State, Event, and Outbox commit atomically. |
| Projection is rebuildable | UI, Conversation cards, History, and Inspector are not execution authority. |
| Secret values are excluded | References and redacted evidence replace credentials. |

## 4. Store and Migration Architecture

The Server uses a Workspace-local SQLite database.

Startup:

~~~text
open connection
  -> foreign_keys ON
  -> busy timeout
  -> compose repositories
  -> run checksummed migrations
  -> integrity and foreign-key checks
  -> compatibility reconciliation
~~~

The merged ledger is migrations 001 through 014. A future migration number is not authorized by this architecture document.

Migration rules:

- each version and checksum is immutable;
- pending migrations run transactionally;
- checksum mismatch fails startup;
- incompatible legacy schema fails closed;
- destructive migration on non-empty data is backup-gated;
- integrity_check and foreign_key_check must pass;
- rollback never leaves a partially published schema.

## 5. Merged Schema Evolution

| Migration | Durable contribution | Classification |
|---|---|---|
| 001 | baseline Agent, Conversation, Message, execution, Event, Memory, preference, Artifact surfaces | COMPATIBILITY |
| 002 | aggregate versions | ACTIVE foundation |
| 003 | Workspaces, Provider Configurations, Agent binding | ACTIVE LITE |
| 004 | Workspace tombstones | ACTIVE LITE |
| 005 | Tasks | ACTIVE LITE |
| 006 | Runs and lineage | ACTIVE LITE |
| 007 | Workflow Definitions | ACTIVE LITE |
| 008 | immutable Run Snapshots | ACTIVE LITE |
| 009 | Run Stages | ACTIVE LITE |
| 010 | Idempotency Records | ACTIVE LITE |
| 011 | legacy migration ledger/items | COMPATIBILITY |
| 012 | Runtime Events, Operations, Outbox, Dead Letters, expanded Stages | ACTIVE LITE |
| 013 | Workflow creation metadata v2 | ACTIVE LITE |
| 014 | Provider Sessions, Runtime Processes, output references | ACTIVE LITE |

## 6. Identity and Common Fields

Application-generated opaque IDs use stable type prefixes. Native PID is never a Process ID; Provider-native Session ID is never Agent or Conversation identity.

Common contracts:

- UTC ISO 8601 timestamps;
- version starts at 1;
- status uses stable enum text;
- optimistic writes compare version;
- soft archive/delete where retention allows;
- foreign keys make ownership explicit;
- JSON holds bounded extensibility, not core relational identity;
- secret values never enter canonical rows.

## 7. Workspace, Agent, and Provider

Workspace identifies the durable project boundary and filesystem root reference.

Agent Profile is persistent identity and history owner.

Provider Configuration is versioned data with secret references.

Agent Provider binding may change while Agent identity and History remain stable.

Provider Session records freeze Adapter/configuration references for one Run/Stage attempt. Native session IDs remain noncanonical.

## 8. Task, Run, Snapshot, and Stage

Task stores durable intent and may exist with zero or many Runs.

Run stores one execution attempt:

- queued, starting, running, waiting_approval, paused, completed, failed, or cancelled;
- parent/root retry lineage;
- origin and reason;
- per-Run Event sequence;
- recovery-required evidence;
- immutable terminal outcome.

Retry creates a new child Run. A terminal Run is never reset.

Run Snapshot is one write-once, content-hashed, redacted record per Run. Retry creates a child-specific Snapshot without copying runtime output, failure, Stage IDs, or timestamps.

Run Stage records optional bounded workflow steps:

- pending, ready, starting, running, waiting_approval, paused;
- completed, failed, cancelled, or skipped;
- Workflow Stage key, sequence, attempt, failure, timestamps, version.

The complete merged lifecycle matrix remains authoritative.

## 9. Events, Outbox, and Operations

Runtime Event:

- immutable ID and schema version;
- Workspace, Task, Run, optional Stage and source references;
- unique increasing sequence per Run;
- timestamp, severity, visibility, type;
- bounded redacted payload;
- correlation and causation references;
- append-only triggers.

Outbox:

- one independent row per durable Event;
- pending, publishing, published, retry, or dead-letter status;
- leases, attempts, availability, and error evidence;
- publication failure never rolls back the Event.

Operation:

- durable command record for create/start/cancel/retry and future controls;
- queued, running, waiting_approval, paused, completed, failed, or cancelled;
- result/error and correlation;
- never a second Run authority.

## 10. Idempotency and Concurrency

An Idempotency Record binds Workspace, operation, key hash, request hash, result hash, result, and HTTP status.

Same key and request converge on the stored result with zero repeated side effects. Same key and different request fails.

Expected-version checks arbitrate:

- duplicate start;
- cancel versus completion;
- concurrent approval decisions;
- duplicate retry children;
- repeated admission.

The schema preserves the merged one-active-Run-per-Task invariant. The Lite one-modifying-Run-per-Workspace rule is an admission contract and may use additive persistence without requiring Worktrees.

## 11. Process Runtime Data

Runtime Process is a durable AgentOS OS-execution record:

- Process ID distinct from native PID;
- reserve-before-spawn created state;
- Windows platform and creation identity evidence;
- Provider Session and Run/Stage ownership;
- parent/root Process tree references;
- redacted arguments and cwd reference;
- stream modes and timeout;
- running and terminal timestamps;
- exit, cleanup, and recovery classification.

Recovery classification is MISSING, MISMATCH, UNKNOWN, or technically justified SAME. SAME is evidence only, never continuation authority.

Process output references bind stdout/stderr to restricted, checksummed Artifacts with monotonic offsets, retained bytes, truncation, redaction, and finalization.

No reattach or adoption state is required.

## 12. Artifacts and Git Observation

Artifacts are immutable, typed, checksummed references with source, sensitivity, storage reference, size, retention, and redaction metadata.

Raw output, large diffs, and sensitive diagnostics belong behind restricted Artifact references rather than Event payloads.

Git observation records:

- base and final SHA when observable;
- status snapshot;
- changed files;
- diff Artifact;
- cwd and dirty-state evidence.

It does not create canonical Worktree, branch, merge, or conflict ownership.

## 13. Forward Conversation Model

The baseline migration contains compatibility Conversation and Message tables. They do not by themselves prove the forward contract.

Forward additive model:

- direct, group, and system Conversation;
- Member with Agent identity and reply policy;
- ordered Message with client idempotency and revisions;
- Agent Turn and streaming checkpoints;
- Task/Run/Artifact/Event references;
- idempotent Event projection.

Message != Task, Message != Run, and Message != Runtime Event.

## 14. Forward Memory Model

The baseline contains Memory and FTS compatibility surfaces. Forward Lite requires:

- Memory Entry, Candidate, conflict, and immutable Context Snapshot;
- Scope, Category, Authority, Confidence, Importance, Source;
- exact and near deduplication;
- SQLite FTS5 retrieval;
- ranking and context budgets;
- selection/exclusion explanation.

A Vector Database is not required. New schema must be additive and must not falsely present baseline tables as complete implementation.

## 15. Forward History and Search

History is a projection unified by Agent Profile across Provider changes.

It links Conversation, Message, Task, Run, Provider Session reference, Memory, Context Snapshot, Artifact, failure, recovery, and available usage.

Search uses structured filters and FTS where appropriate. It never indexes secrets.

No dedicated History/Search table is assumed to exist today.

## 16. Failure and Safety Rules

- migration checksum or integrity failure blocks startup;
- critical Event failure blocks its state transition;
- Outbox publication failure remains replayable;
- stale version loses without duplicate side effects;
- Snapshot update is rejected;
- Event update/delete is rejected;
- PID alone never proves Process identity;
- UNKNOWN never proves success;
- canonical runtime history is not cascade-deleted;
- browser disconnect changes no Run or Process row;
- secrets remain absent from snapshots, Events, processes, output, and search.

## 17. Compatibility Policy

Migrations 001–014 and merged contracts remain authoritative.

Legacy JSON and baseline tables remain readable through idempotent compatibility paths. Historical worktree fields may remain stored without creating an active Worktree requirement.

Full Policy tables are not required; existing decision projections may support Lite ALLOW/DENY/ASK_USER.

No production deletion campaign follows from Lite scope reduction.

## 18. Acceptance Expectations

Independent verification must prove:

- fresh and supported upgrade migrations;
- checksum, backup, integrity, and foreign-key gates;
- opaque IDs and Process ID/PID distinction;
- Task zero/many Runs and retry child lineage;
- Snapshot immutability and child remapping;
- Event append-only and per-Run ordering;
- Event/Outbox atomicity and replay;
- idempotency convergence;
- optimistic race winner;
- Process reserve-before-spawn;
- fail-closed recovery evidence;
- bounded finalized output references;
- Workspace tombstones and non-cascading history;
- compatibility reads without data loss;
- no secret persistence;
- no clean-sheet schema replacement.

## 19. Deferred / Non-Goals

- destructive database simplification;
- full Worktree/Branch/Merge/Conflict schema;
- full Policy DSL/grants/RBAC schema;
- mandatory Vector Database;
- generic marketplace, scheduler, distributed, cloud, mobile, or Tauri schema;
- treating native sessions, PID, Provider history, or internal worktrees as canonical identity.

## 20. Cross-Document References

- [00 — Vision](./00-Vision.md) defines authority and Fast Track.
- [01 — Core Concepts](./01-Core-Concepts.md) defines canonical identities.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines Run state.
- [03 — Event Model](./03-Event-Model.md) defines Event and Outbox contracts.
- [04 — Provider Specification](./04-Provider-Specification.md) defines Provider references.
- [05 — Process Runtime](./05-Process-Runtime.md) defines Process evidence.
- [06 — Worktree Runtime](./06-Worktree-Runtime.md) defines Git observation.
- [07 — Memory Runtime](./07-Memory-Runtime.md) defines Memory forward state.
- [08 — Policy Runtime](./08-Policy-Runtime.md) defines minimal approval persistence.
- [09 — Conversation Runtime](./09-Conversation-Runtime.md) defines communication state.
- [11 — API Specification](./11-API-Specification.md) maps endpoints.
- [12 — UI Architecture](./12-UI-Architecture.md) consumes projections.
- [13 — Runtime Inspector](./13-Runtime-Inspector.md) queries evidence.
