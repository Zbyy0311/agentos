# AgentOS M3 P1 Migration 012 Schema Design

Status: DESIGN PACKAGE ONLY — MIGRATION 012 REQUIRED — PLANNING ONLY — NO DDL CREATED — NOT REGISTERED — NOT EXECUTED

Base: main at 5e4f3bd1ac4da8e83c42008f0483b73a56fa9028

This document freezes the schema design boundary for M3 P1. It is not a TypeScript Migration, is not included in the migration registry, and must not be applied to a database. M3 P2 owns persistent Run/Stage migration and transaction implementation.

## 1. Contract and scope

M3 P1 provides shared types, Event Registry validation, fixtures, and this schema design package. It does not implement Event Store, Outbox Repository, Publisher, Run Engine, Operation Repository, API routes, Web behavior, Conversation EventBus behavior, or persistent lifecycle transitions.

The design preserves these boundaries:

- runtime_events are Task-domain Run-scoped.
- runs and agent_runs remain separate.
- Create Task does not fabricate a Run ID for task.created.
- M3 Operation tracks only Task-domain Run commands.
- runs(status=queued) is the default persistent Queue Record.
- scheduler_jobs is not added unless later evidence proves that runs(status=queued) cannot satisfy the M3 invariant.

## 2. Current schema evidence

Registry migrations 001 through 011 currently provide:

- runs.next_event_sequence and runs.version through Migration 006.
- run_stages.status constrained to pending and run_stages.version through Migration 009.
- idempotency_records with a restricted operation vocabulary and immutable-record trigger through Migration 010.
- no runtime_events table.
- no outbox_messages table.
- no independent dead_letters table for M3 publication failures.
- no durable operations table.
- no Run recovery_required column or separate Recovery Record.

Migration 009 already has the run_stages version column. Migration 012 must preserve and use it for optimistic, version-checked Stage updates; it must not add a duplicate version column.

## 3. Planned schema objects

### 3.1 runtime_events

Migration 012 must add a Task-domain runtime_events table containing the canonical Runtime Event envelope:

- id, schema_version, type.
- workspace_id, optional task_id, required run_id, optional stage_id.
- provider, process, worktree, artifact, approval, Conversation correlation references where applicable.
- sequence, timestamp, source, required correlation_id, causation_id, parent_event_id.
- severity, visibility, durability.
- payload_json and metadata_json.
- created_at.

Required constraints and indexes:

- Event ID is globally unique.
- UNIQUE(run_id, sequence).
- Append-only event history.
- runtime_events(run_id, sequence) query index.
- runtime_events(run_id, correlation_id, sequence) query index for Operation Event association.
- correlation_id query support.
- Event payload and envelope validation occurs before persistence.

The Event Store is Run-scoped. Conversation agent_events and run_event_sequences do not satisfy this object.

### 3.2 operations

Migration 012 must add durable Operation persistence for M3 Run commands only:

- id.
- type.
- status constrained to queued, running, waiting_approval, paused, completed, failed, or cancelled.
- workspace_id.
- aggregate_type constrained to run.
- aggregate_id or an equivalent Run aggregate reference.
- run_id if stored separately, otherwise an explicitly reviewed equivalent aggregate reference.
- correlation_id.
- result_json and error_json or equivalent result and ApiProblem fields.
- created_at, started_at, completed_at, updated_at.
- version.

Operation association rules:

- aggregateType is always run for M3.
- aggregateId and runId identify the Task-domain Run command.
- correlation_id is unique per Operation and immutable after creation.
- correlation_id has a unique constraint and a query index.
- GET /api/operations/:operationId/events authorizes the Operation, reads its run_id and correlation_id, queries runtime_events, and returns matching events ordered by sequence ascending.
- No independent operation_events Event Store is added.
- Non-Run Operation types are a Post-M3 design.

### 3.3 run_stages extension

Migration 012 must rebuild or extend run_stages without adding a second version column:

- Preserve the existing version field from Migration 009.
- Expand Stage status vocabulary to the approved M3 lifecycle: pending, ready, starting, running, waiting_approval, paused, completed, failed, cancelled, skipped.
- Add failure_code.
- Add failure_message.
- Add started_at.
- Add completed_at.
- Use the existing version field for optimistic, version-checked updates.
- Retain current Run/Stage identity and ordering constraints unless a separately reviewed compatibility change is required.

P1 only freezes this design. P2 begins the actual persistent status migration and transaction implementation.

### 3.4 outbox_messages

Migration 012 must add a durable Outbox record associated with the committed Runtime Event:

- id.
- event_id or equivalent Event reference.
- topic.
- aggregate_type.
- aggregate_id.
- payload_json.
- status.
- attempts.
- available_at.
- created_at.
- published_at.
- last_error.
- Optional lease, fencing, or version field if the final DDL adopts one.

Immutable fields:

- id.
- event_id or equivalent Event reference.
- topic.
- aggregate_type and aggregate_id.
- payload_json.
- created_at.

Controlled mutable delivery fields:

- status.
- attempts.
- available_at.
- published_at.
- last_error.
- lease, fencing, or version fields if adopted.

The table is not globally immutable and the design does not prohibit all UPDATE. Delivery updates must use an explicit state machine, conditional UPDATE, and concurrency protection. Payload and identity fields cannot be rewritten. Durable identity is used for deduplication.

### 3.5 dead_letters

Use an independent dead_letters table or a separately reviewed equivalent for failed publication/subscriber delivery:

- source type and source ID.
- subscriber or delivery target.
- payload or immutable failure reference.
- error code/message.
- attempts and first/last failure timestamps.
- retryable state.
- resolution timestamp and actor.

Dead Letter records are failure evidence. They are not a replacement for runtime_events or outbox_messages.

### 3.6 idempotency operation extension

Extend idempotency_records.operation only through the separately reviewed Migration 012 implementation:

- run.start.
- run.retry.
- Other M3 commands only after final contract approval.

Existing M2 operations and immutable-record behavior remain compatible. P1 does not change the existing Migration 010 file or registry.

### 3.7 Recovery representation

Before P2/P6 implementation, independently choose one representation:

- add recovery_required to the Run status/schema; or
- add a separate Recovery Record linked to Run, Stage, and recovery evidence.

P1 freezes the choice as a required decision point but does not add the column/table. P6 must not reference a schema state that does not exist.

### 3.8 Sequence allocation

Use runs.next_event_sequence as the Task-domain allocator:

1. Lock or otherwise serialize the Run row under the transaction.
2. Read next_event_sequence.
3. Increment the Run counter.
4. Persist the Runtime Event with the allocated sequence.
5. Insert the Outbox record in the same transaction.
6. Commit before publication.

The same Run sequence is unique, strictly increasing, concurrency-safe, and resumable after restart. Gaps are diagnosable and are not silently filled by guessing.

### 3.9 Queue decision

M3 uses runs(status=queued) as the durable Queue Record. Migration 012 does not add scheduler_jobs by default. A later design may propose scheduler_jobs only if evidence proves that the Run row cannot provide M3 queue, recovery, and ownership invariants.

## 4. Transaction boundary

P2 must implement the following atomic unit for every persistent Run or Stage transition:

Current State update

+ Runtime Event append

+ Outbox insert

All three commit together or none commit. Publication occurs only after commit. P1 does not implement this path.

## 5. SQLite rebuild and compatibility review

Migration 012 may require SQLite table rebuilds, especially for run_stages status constraints and idempotency operation constraints. Before DDL authorization, the implementation package must provide:

- exact DDL review.
- checksum calculation and registry placement review.
- fresh database fixture.
- legacy database fixture.
- foreign-key and index verification.
- rollback and forward-compatibility analysis.
- migration failure atomicity evidence.
- preservation of existing run_stages.version.
- L3 validation output.

No real database, Migration Runner, production copy, Restore, or registry update is authorized in P1.

## 6. P1 exit criteria

P1 can exit only when:

- Shared Run, Stage, Runtime Event, ApiProblem, ApiOperation, DTO, and SSE contracts compile.
- Central Runtime Event Registry tests cover registration, defaults, schemaVersion, payload validation, unknown future fallback, and rejection of unregistered Core Events.
- Event Fixture covers Run, Stage, invalid payload, unregistered Core Event, unknown future Event, and Operation correlationId.
- This planning package records all schema gaps and the P2 transaction boundary.
- No Migration 012 file exists.
- default-registry remains migrations 001 through 011.
- No persistent Run/Stage status changed.
- M3 P2 remains not authorized.

## 7. Explicit non-goals

- No Event Store repository.
- No Outbox repository or Publisher.
- No Run Engine or Workflow Executor.
- No Operation Repository.
- No API route, OpenAPI route registration, Web, Legacy, or Conversation behavior change.
- No Migration 012 DDL or Registry registration.
- No database execution.
- No PR creation.
- No Production Cutover, Restore, or Legacy deletion.
