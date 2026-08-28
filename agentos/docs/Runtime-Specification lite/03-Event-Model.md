# AgentOS Runtime Specification Lite

## 03 — Event Model

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs retain authority for already-frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical `Runtime-Specification` remains reference architecture where it is broader than Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

This document defines the Lite protocol for durable, ordered Runtime Events.

Runtime Events connect lifecycle, Provider execution, Windows Process ownership, Conversation projections, Memory, Artifacts, Git observation, policy decisions, recovery, control, UI, Inspector, and history; the taxonomy is intentionally smaller than the historical full specification, while merged Event envelope, registry, ordering, lifecycle, sequence, Outbox, and reconnect contracts remain authoritative for frozen correctness.

## 2. Core Principles

> A Runtime Event is an immutable, registered, structured fact that AgentOS can justify.

- Event != current state.
- Event != log.
- Event != provider stdout.
- Event != Conversation Message.
- Event != inferred provider behavior.
- Durable Events are persisted before publication.
- Events are strictly ordered within one Run by sequence.
- Different Runs have no global ordering guarantee.
- Delivery is at least once; consumers are idempotent.
- Large or sensitive content is referenced as an Artifact.
- Browser disconnect does not stop Event production or cancel the Run.

## 3. Event Architecture

```text
Canonical command or observed fact
  -> Event draft
  -> registry and payload validation
  -> secret redaction
  -> payload size enforcement
  -> per-Run sequence allocation
  -> current state + Event + independent Outbox transaction
  -> commit
  -> Outbox publication
  -> SSE / projections / Inspector / consumers
```

The Event Store owns durable history.

The Outbox owns delivery intent.

The publisher provides at-least-once delivery hints.

Projections own read views, not domain authority.

## 4. Canonical Envelope

The conceptual Lite envelope is:

```ts
interface RuntimeEvent<TPayload = unknown> {
  id: string;
  schemaVersion: number;
  type: string;

  workspaceId: string;
  runId: string;
  sequence: number;
  timestamp: string;

  taskId?: string;
  stageId?: string;
  agentId?: string;
  providerConfigId?: string;
  providerSessionId?: string;
  processId?: string;
  conversationId?: string;
  messageId?: string;
  memoryEntryId?: string;
  artifactId?: string;
  approvalRequestId?: string;

  source: string;
  correlationId: string;
  causationId?: string;
  parentEventId?: string;

  severity: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';
  visibility: 'public' | 'internal' | 'restricted';
  durability: 'durable' | 'ephemeral';

  payload: TPayload;
  metadata?: Record<string, unknown>;
}
```

Merged fields and compatibility references remain valid even when their historical domain is no longer active Lite scope.

For example, a compatibility `worktreeId` may remain in existing schemas without making Worktree a canonical Lite requirement.

## 5. Envelope Rules

- `id` is globally unique and immutable.
- `schemaVersion` selects envelope and payload compatibility behavior.
- `workspaceId`, `runId`, `sequence`, and `timestamp` are required for Run-scoped Events.
- `sequence` is a positive integer unique within one Run.
- timestamps use UTC ISO 8601 with millisecond precision where frozen contracts require it.
- reference fields are present only when the referenced canonical object exists.
- provider-native subagent IDs never populate `agentId` unless a real Agent Profile exists.
- native PID never populates `processId`.
- `correlationId` groups one logical Run or operation chain.
- `causationId` and `parentEventId` preserve justified causal structure.
- payload fields are type-specific and registry validated.
- metadata cannot be used to bypass payload contracts or redaction.

System facts with no Run belong in a separate System Event stream or audit store; they do not use a fabricated `runId`.

## 6. Naming and Registry

Canonical Event names use:

```text
<domain>.<past-tense-or-explicit-action>
```

Examples:

- `run.created`;
- `run.dequeued`;
- `stage.started`;
- `process.exited`;
- `memory.retrieved`;
- `artifact.created`;
- `policy.evaluated`;
- `recovery.process_checked`.

Names are lowercase, provider-neutral, UI-neutral, and stable after publication.

Core Events must be registered with:

- type and schema version;
- domain and description;
- payload schema;
- required reference fields;
- default severity, visibility, and durability;
- retention class.

Unknown future Events are preserved and surfaced with a compatibility warning rather than crashing consumers.

## 7. Ordering and Atomicity

### 7.1 Per-Run Sequence

The Event Store guarantees strict order by:

```text
runId + sequence
```

The allocator is transaction-safe and restart-safe.

Sequence gaps caused by a rolled-back or reserved write may be tolerated only where merged contracts permit them.

Duplicate or descending sequences are invalid.

### 7.2 Multi-Event Transactions

When one command produces multiple durable Events:

- sequence values are contiguous where the frozen ordering contract requires it;
- each Event receives an independent Outbox row;
- current state, aggregate versions, Events, and Outbox rows commit or roll back together;
- publication begins only after commit.

Frozen orders include:

```text
run.created -> stage.created x N
stage.started -> run.started
stage.failed -> run.failed                  (startup branch with a started Stage)
approval.resolved -> stage.failed -> run.failed
approval.resolved -> stage.cancelled x N -> run.cancelled
stage.completed -> run.completed
```

Where no Stage entered `starting`, startup failure emits only `run.failed`.

No Event is invented to make a sequence appear visually complete.

### 7.3 Canonical Transition Ownership

| Transition | Event |
|---|---|
| Run `empty -> queued` | `run.created` |
| Run `queued -> starting` | `run.dequeued` |
| Run `starting -> running` | `run.started` |
| Stage `ready -> starting` | `stage.starting` |
| Stage `starting -> running` | `stage.started` |

`run.queued` remains optional telemetry and does not establish queued state.

## 8. Persist Then Publish

Durable Events are not broadcast before commit.

If publication fails:

- the Event remains committed;
- current state remains committed;
- the Outbox remains retryable or reaches dead letter under the frozen delivery contract;
- the same Event ID, sequence, and payload are retried;
- no second domain transition is executed;
- clients recover through replay.

Each durable Event maps to exactly one Outbox row where required by merged contracts.

Outbox lease expiry, classified failure, retry budget, deterministic backoff, and dead-letter state are delivery facts and do not mutate Run lifecycle state unless a separate canonical command does so.

## 9. Delivery and Idempotent Consumers

Delivery semantics are at least once.

Consumers store or enforce a key such as:

```text
consumerId + eventId
```

An idempotent consumer:

- ignores a repeated Event after completing its effect;
- does not create duplicate Message, Memory candidate, Artifact registration, notification, or search row;
- preserves Event order per Run;
- detects sequence gaps;
- does not execute Provider or Process work during replay;
- records retry/dead-letter evidence instead of silently dropping failures.

Subscriber and transport failure do not change delivery truth or cancel a Run.

## 10. SSE Replay and Reconnect

The Run stream accepts a durable cursor such as `afterSequence` or a validated `Last-Event-ID`.

The race-free sequence is:

1. Validate Run, authorization, and cursor.
2. Subscribe to live delivery hints and buffer arrivals.
3. Capture the durable high-watermark.
4. Replay persisted Events from `cursor + 1` through the high-watermark.
5. Drain buffered Events above the high-watermark.
6. Deduplicate by Event ID and `runId + sequence`.
7. Continue live delivery.

Keepalive frames are ephemeral transport messages and do not enter the Event Store.

Disconnect closes only the subscription.

It never cancels the Run or terminates its Process.

## 11. Lite Event Families

The following families are sufficient for the Lite product.

They are semantic families, not a requirement to emit every listed Event for every Provider.

### 11.1 Run

- creation and queue acquisition;
- start, completion, failure, and cancellation;
- retry lineage reference;
- recovery attempted, classified, recovered where safe, or failed/required.

Representative existing names:

```text
run.created
run.dequeued
run.started
run.cancellation_requested
run.cancelled
run.completed
run.failed
run.recovery_attempted
run.recovery_failed
```

### 11.2 Stage

- created, ready, starting, started;
- completed, failed, cancelled, skipped;
- bounded retry scheduling.

Stage Events are omitted only when the chosen Run representation and merged contract genuinely have no Stage.

### 11.3 Provider and Process

- Provider validation and session reference lifecycle when exposed;
- Process started, stopping, exited, cancellation/cleanup result;
- bounded stream summary or Artifact reference;
- capability fidelity.

AgentOS does not fabricate Provider Session, tool, usage, reasoning, subagent, or file telemetry.

### 11.4 Conversation Bridge

- link a Message or turn to a Task or Run;
- project trusted Run status, approval, error, Memory explanation, or Artifact references into Conversation;
- post an Agent response that was actually persisted by the Conversation service.

Message remains a Conversation object.

A Runtime Event may trigger an idempotent Message projection but is not the Message itself.

### 11.5 Memory

- retrieval started/completed/failed;
- candidate created;
- entry created/updated/conflicted/deduplicated;
- Context Snapshot created;
- selection explanation recorded.

Payloads carry IDs, scores, reasons, budget facts, and source references rather than full sensitive Memory content.

### 11.6 Artifact

- created, finalized, failed, retention changed, deleted;
- immutable checksum and source references;
- sensitivity class.

Large payloads, raw logs, diffs, reports, and binary content are Artifact data, not Event payloads.

### 11.7 Git Observation

Lite Git Events report observable facts such as:

- Git root and cwd observed;
- base commit observed;
- status snapshot observed;
- changed files observed;
- final commit observed when available;
- diff Artifact registered.

They do not claim AgentOS created a branch, owned a Worktree, performed a merge, or controlled provider-native Git actions.

Historical Worktree and merge Events may remain under **COMPATIBILITY** but are not active Lite workflow requirements.

### 11.8 Policy Decision and Control

The Lite decision set is:

```text
ALLOW
DENY
ASK_USER
```

Events record normalized action, decision, reason, relevant resource reference, and resulting control state.

Representative existing compatibility names include `policy.evaluated`, `policy.allowed`, `policy.denied`, `approval.required`, and `approval.resolved`.

Control Events cover explicit start, cancel, retry, timeout, and Operation outcomes without treating UI actions as trusted facts.

### 11.9 Recovery

Recovery Events record:

- startup scan boundaries;
- Process evidence checked;
- `MISSING`, `MISMATCH`, `UNKNOWN`, or technically justified `SAME` classification;
- reconciliation or recovery-required outcome;
- queue and Outbox restoration;
- stable failure reason.

`SAME` records identity evidence only and preserves the **NON-GOAL** of reattachment/adoption; it never implies control ownership, output continuity, or Run success.

### 11.10 History and Search

History/Search projections consume canonical Events and domain records.

They do not require a new high-volume Event family when existing Events contain sufficient references.

Index updates are idempotent, Workspace-scoped, permission-aware, and secret-filtered.

## 12. Provider Evidence Boundary

Provider-native output is handled in descending order of fidelity:

```text
stable native structured event
  -> validated canonical mapping

stable documented text format
  -> conservative parsed mapping with provenance

unreliable or unknown output
  -> user-visible stream summary + redacted raw Artifact
```

AgentOS never promotes raw Provider logs into canonical facts merely to enrich the Timeline.

It must not invent:

- tool calls;
- file modifications;
- subagents;
- reasoning;
- usage or cost;
- native session success;
- Git operations;
- process identity.

Missing telemetry means unavailable telemetry, not evidence that an action did or did not occur.

Provider-private chain of thought is not requested, inferred, or persisted.

## 13. Redaction and Sensitive Data

Redaction occurs before persistence.

The pipeline is:

```text
Event draft
  -> sensitive-field detection
  -> secret redaction
  -> path and reference normalization
  -> payload validation
  -> size check
  -> sequence allocation and persistence
```

Ordinary Events never contain:

- API keys, tokens, passwords, cookies, or private keys;
- complete environment maps;
- unrestricted command arguments containing secrets;
- full sensitive file content;
- raw credentials or provider authentication material;
- unredacted Memory content not needed for the Event fact.

Restricted metadata and Artifacts require explicit access checks.

Search indexes never index secrets.

## 14. Bounded Payloads and Artifacts

Durable Event payloads are bounded to 64 KiB unless a merged registry contract sets a stricter limit.

Payloads contain structured facts, summaries, counts, hashes, and references.

They do not contain binary data or unbounded stdout/stderr.

When content exceeds the limit:

1. redact and classify it;
2. store it as an Artifact;
3. emit a bounded summary and Artifact ID;
4. preserve source and checksum metadata.

High-volume text deltas may be aggregated without changing text order.

Terminal, approval, policy denial, recovery, and critical error facts are never discarded as backpressure relief.

## 15. Durability and Retention

The following are durable:

- Run and Stage lifecycle;
- Process start/exit and cancellation facts;
- policy and approval decisions;
- Artifact and Memory facts;
- Git observations used for traceability;
- recovery classifications and outcomes;
- errors that affect canonical state.

Ephemeral events are limited to UI presence, keepalive, cursor hints, and sampled progress that does not change canonical meaning.

Compaction may replace high-volume stream detail with an Artifact and sequence-range record.

It must not delete terminal facts or break replay semantics.

## 16. Corrections and Compatibility

Persisted Events are immutable.

If a factual correction is required, append a correction Event or other frozen compatibility mechanism that references the original Event.

Breaking payload or semantic changes require a schema version change.

Consumers:

- ignore unknown optional fields;
- preserve unknown Event types;
- warn on unsupported future schemas;
- do not reinterpret an existing Event name with a new meaning.

Existing full-scope Event types may remain under **COMPATIBILITY** while current consumers depend on them.

New Lite flows should use the smallest family that records a justified canonical fact.

## 17. Failure Rules

- A critical Event validation or persistence failure blocks its state transition.
- Publication failure leaves the committed Event recoverable through Outbox replay.
- Consumer failure is recorded and retried; it is not silent.
- Sequence gaps are detected and never filled with fabricated Events.
- Unknown Provider output degrades to stream/Artifact evidence.
- Redaction failure blocks persistence of sensitive payloads.
- Oversize payloads are converted to Artifact references before persistence.
- Replay never executes Provider, Process, policy action, approval, Memory write, or Git operation.
- Runtime Event absence never authorizes completion or recovery success.

## 18. Deferred / Non-Goals

- exhaustive Provider-native telemetry normalization;
- raw log mirroring as canonical Events;
- full Worktree, branch, merge, and conflict Event workflow;
- full Policy DSL trace taxonomy;
- cross-platform process telemetry parity;
- process reattach/adoption Events as active requirements;
- Provider Comparison benchmark Event families;
- mandatory OpenTelemetry replacement for Event IDs and Run sequence;
- Event-sourced reconstruction as the only current-state store.

## 19. Compatibility with the Existing Runtime

Lite preserves the merged Runtime Event envelope, central registry, schema validation, strict per-Run sequence, state/Event/Outbox atomicity, lifecycle ordering, Outbox delivery, reconnect cursor, unknown-event handling, and legacy projection boundaries.

No second Event Store or Event Bus is introduced.

Legacy SSE names may remain as projections sourced from persisted Runtime Events.

Compatibility projection cannot own execution or cancellation.

Historical fields and Event names remain readable even when their full-scope feature is deferred.

## 20. Acceptance Expectations

Independent verification must cover:

- envelope and payload schema validation;
- immutable Event records;
- strict unique per-Run ordering;
- atomic current state, Event, version, and Outbox writes;
- exact multi-Event lifecycle ordering;
- one Outbox row per durable Event;
- reclaim, retry, and dead letter without duplicate domain transition;
- at-least-once delivery with idempotent consumers;
- reconnect from a real cursor with replay, drain, live continuation, no gaps, and no duplicates;
- browser disconnect without Run cancellation;
- unknown Event and future schema compatibility;
- provider mapping fidelity and no invented telemetry;
- redaction before persistence;
- payload limit and Artifact fallback;
- Conversation bridge deduplication;
- Memory selection explanation Events;
- Git observation wording that does not imply Git ownership;
- recovery classification preserves the **NON-GOAL** of reattach and never guesses success;
- replay with zero external side effects.

## 21. Cross-Document References

- [00 — Vision](./00-Vision.md) defines authority, provider delegation, and deferred scope.
- [01 — Core Concepts](./01-Core-Concepts.md) defines Runtime Event, Message, Process, Memory, and Artifact distinctions.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines the state transitions and ordering that Events prove.
- `05-Process-Runtime.md` will define Windows Process evidence sources.
- `07-Memory-Runtime.md` will define Context Snapshot and explanation payloads.
- `09-Conversation-Runtime.md` will define Message projections and turn bridges.
- `11-API-Specification.md` will define Event query and stream endpoints.
- `13-Runtime-Inspector.md` will define Event inspection and replay views.
