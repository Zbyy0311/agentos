# AgentOS Runtime Specification Lite

## 09 — Conversation Runtime

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs remain authoritative for frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical Runtime Specification remains reference architecture where it exceeds Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

The Lite Conversation Runtime is the persistent, provider-independent collaboration layer for users and long-lived Agents.

It owns:

- Conversation identity and membership;
- durable ordered Messages;
- Agent Turns;
- direct-first interaction;
- streaming and reconnect;
- explicit Task and Run bridges;
- bounded Group Conversation;
- unified Agent history references.

Conversation is canonical AgentOS state. It is not a Provider transcript, CLI session, HTTP request, or frontend cache.

## 2. Lite Scope

### 2.1 ACTIVE LITE

- durable Conversation, Member, Message, and Turn records;
- direct Conversation with one primary Agent;
- ordered streaming checkpoints and reconnect;
- explicit Task and Run intents;
- idempotent Runtime Event projection;
- bounded Group Conversation;
- mentions and mention-all;
- sequential and bounded parallel read-only replies;
- reply budgets, stop, loop guard, and per-Agent context;
- template-backed collaboration;
- unified Agent History and Search references;
- archive, restore, and history read.

### 2.2 COMPATIBILITY

- existing Conversation routes, services, runners, UI paths, fields, and projections remain where callers depend on them;
- Provider-native session and history references remain scoped compatibility data;
- historical Task/Run conversation-type projections may remain readable.

This document does not claim those compatibility paths satisfy the forward Lite contract without independent evidence.

### 2.3 DEFERRED FULL-SCOPE

- infinite autonomous group chat;
- unbounded agent-to-agent loops;
- parallel modifying Runs in one Workspace;
- Provider-native history as canonical history;
- visual workflow DAG editor;
- exhaustive notification, presence, retention, and export product surfaces;
- mobile-first and cross-platform parity design.

## 3. Core Invariants

| Invariant | Contract |
|---|---|
| Conversation is durable | It survives browser refresh, disconnect, Server restart, and Provider switch. |
| Direct-first | Direct Conversation is the primary product path. |
| Message != Task | Communication does not formalize work intent by itself. |
| Message != Run | Sending a Message never implicitly starts a modifying Run. |
| Message != Runtime Event | Communication and runtime facts are distinct durable objects. |
| Agent Turn != Run | A chat response attempt is not execution authority. |
| Provider Session != Agent identity | Native session IDs are scoped references. |
| Provider history != Agent History | History remains unified by Agent Profile. |
| Browser disconnect != cancellation | Transport lifetime never owns Run lifetime. |
| Persist before route | A Message is durable before routing or side effects. |
| Projection is idempotent | One Event never creates duplicate cards. |
| Group is bounded | Replies, hops, time, and Agents have limits. |
| Modifying work is serialized | All Conversation paths obey one modifying Run per Workspace. |
| Archive != delete | Archiving never cascades to runtime records. |

## 4. Canonical Model

### 4.1 Conversation

Required fields:

- immutable Conversation ID;
- Workspace ID;
- direct, group, or system type;
- title;
- active or archived status;
- Reply Policy;
- last Message reference and timestamp;
- version and timestamps.

Types:

- **direct** — one user and one primary Agent Profile;
- **group** — user plus two or more Agent Profiles;
- **system** — durable approval, recovery, policy, or runtime notices.

Historical Task and Run Conversation kinds are **COMPATIBILITY** projections. Lite represents discussion in direct or group Conversations with explicit Task/Run references.

Archiving blocks new Turns but never cancels a Run or deletes Messages, Tasks, Runs, Memory, Artifacts, or Events.

Restore changes an archived Conversation back to active through optimistic concurrency; it does not replay, resume, or recreate prior Turns or Runs.

### 4.2 Member

A Member contains:

- immutable membership ID;
- Conversation ID;
- user or Agent type and canonical ID;
- display-name snapshot;
- owner, participant, observer, orchestrator, or reviewer role;
- always, mentioned, orchestrated, manual, or never reply mode;
- active, muted, or removed status;
- join/remove timestamps and version.

Membership binds Agent Profile, not Provider. Removing an Agent preserves history and linked work.

### 4.3 Message

A Message contains:

- immutable Message ID;
- Conversation and Workspace IDs;
- sender type, canonical sender ID, and display-name snapshot;
- text, Task reference, Run reference, status, approval, Artifact, error, or system-notice type;
- draft, streaming, final, failed, edited, or deleted status;
- unique increasing Conversation sequence;
- optional reply, source Event, Task, Run, and clientMessageId references;
- timestamps and version.

Rules:

- sequence allocation is transactional and never reused;
- client retry with the same clientMessageId converges on one Message;
- edits create Revisions rather than rewriting history;
- streaming ends in final, failed, or deleted;
- Agent Messages identify Agent Profile, never only Provider;
- secret values are prohibited;
- attachments are Artifact references;
- Markdown is sanitized;
- mentions bind durable Agent IDs, not display names alone.

### 4.4 Agent Turn

An Agent Turn is one bounded response attempt:

~~~text
routing decision
  -> Turn created
  -> bounded context assembled
  -> Provider response, optionally Run-backed
  -> streaming Message
  -> final | failed | cancelled
~~~

A chat-only Turn may have no Task, Run, or Process. Cancelling a reply and cancelling a Run are separate controls.

## 5. Message, Task, Run, and Event Boundary

| Object | Meaning | Authority |
|---|---|---|
| Message | durable communication | Conversation Runtime |
| Task | durable work intent | explicit create-Task action |
| Run | one execution attempt | explicit start authority |
| Runtime Event | structured runtime fact | domain runtime |
| Agent Turn | one response attempt | Conversation routing |
| Provider Session | native execution reference | Provider Adapter |

Frozen rules:

- normal chat does not create a Task or Run;
- Task creation is idempotent and does not start execution;
- Run creation requires an explicit request, workflow step, or approved action;
- Event projection may create a Message card, but does not turn the Message into an Event;
- approval decisions bind approvalRequestId; ambiguous text never approves;
- Run cancellation reaches the Process Runtime, not a chat-only control.

## 6. Direct Conversation Flow

~~~text
Select Agent
  -> open persistent Conversation
  -> send Message
  -> persist Message and sequence
  -> resolve explicit intent
  -> create chat Turn OR Task OR Run Request
  -> stream Provider response
  -> persist checkpoints and final Message
  -> show optional Task, Run, Memory, Artifact, and error references
~~~

The Composer exposes chat, create Task, and start Run as distinct actions.

Provider may change between Turns or Runs. Conversation and Agent identity remain unchanged.

Provider Session continuity is optional, noncanonical, and referenced by ID only.

## 7. Submission and Routing

~~~text
validate Conversation and membership
  -> validate blocks, attachments, mentions, and policy
  -> secret scan
  -> allocate sequence
  -> persist Message
  -> emit message.created
  -> update Conversation summary fields
  -> route explicit intent
~~~

Persist-before-route is mandatory. Routing failure leaves a durable failed Turn or error Message rather than losing communication.

Routing outcomes remain distinct:

- chat reply;
- create Task;
- start Run;
- decide Approval Request;
- Conversation command;
- no response.

## 8. Streaming and Reconnect

Streaming text uses ordered durable deltas or checkpoints.

~~~text
reserve streaming Message
  -> append retry-safe Provider deltas
  -> checkpoint
  -> finalize Message or mark failed
~~~

Reconnect uses the client's last durable cursor:

~~~text
replay persisted Messages/checkpoints after cursor
  -> attach to live stream
~~~

Duplicate deltas are deduplicated. Out-of-order deltas are rejected or buffered under the frozen streaming contract.

Browser disconnect closes only the subscription. It never cancels the Turn's Run or Process.

After Server restart, an unfinished stream is failed or resumed only when a merged contract proves resumption is safe. AgentOS never guesses completion.

## 9. Task and Run Bridge

~~~text
explicit task-create
  -> idempotent Task
  -> Conversation + Message references
  -> Task card

explicit run-start
  -> Run Request
  -> mutation classification
  -> Workspace admission
  -> durable Run
  -> Event-projected Run card
~~~

Modifying Run admission follows [06 — Worktree Runtime](./06-Worktree-Runtime.md): one per Workspace; additional requests queue or reject.

Run terminal state is read from canonical Run data, not inferred from Provider prose or Message content.

## 10. Event Projection

~~~text
Runtime Event committed
  -> projector consumes Event
  -> deduplicate by sourceEventId
  -> create or update Message card
  -> card references live canonical state
~~~

Projection failure does not fail the Run. High-frequency progress can aggregate, but approval, terminal, failure, cancel, and recovery facts are retained.

## 11. Bounded Group Conversation

Group Conversation is **ACTIVE LITE**.

### 11.1 Mentions

- @Agent targets one durable Agent ID;
- @all targets active reply-capable members;
- unknown or removed mentions return an explicit result;
- @all never authorizes parallel modifying Runs.

### 11.2 Reply Modes

| Mode | Behavior |
|---|---|
| sequential | selected Agents reply in deterministic order |
| parallel-read-only | multiple read-only Agent Turns may run concurrently |
| orchestrated | orchestrator or template selects speakers and order |
| manual | user selects each responder |
| mention-only | only mentioned Agents reply |

Member reply mode first determines eligibility; the Conversation reply mode then determines the order and concurrency of eligible Agents. An always member is still serialized by a sequential Conversation and cannot bypass read-only restrictions.

### 11.3 Budgets

Each group interaction declares:

- maximum Agents per Turn;
- maximum replies per Agent;
- maximum total replies;
- maximum Agent-to-Agent hops;
- timeout where applicable;
- optional context token budget.

Budget exhaustion ends the interaction with a stable reason.

### 11.4 Stop and Loop Guard

Stop prevents new replies and cancels pending read-only Turns. It does not cancel an active Run without a separate Run cancel request.

The Loop Guard blocks:

- same-Agent cycles;
- repeated-content replies;
- repeated mentions with no new information;
- hops beyond the configured limit.

No infinite autonomous group chat exists in Lite.

### 11.5 Per-Agent Context

Each Agent receives bounded recent Messages, role, mentions, Task/Run references, and an independently selected Memory Context.

Parallel drafts are isolated until committed. No Agent automatically receives the full raw transcript.

### 11.6 Mutation Serialization

Analysis, planning, review, and other read-only work may run in parallel. Any modifying step obtains the sole Workspace modifying authority.

Group fan-out never bypasses admission, even when Providers use internal worktrees.

## 12. Workflow Templates

Workflow Templates are **ACTIVE LITE**:

~~~text
Single Agent

Plan -> Implement -> Review

Parallel Analysis
  -> Agent A read-only
  -> Agent B read-only
  -> Agent C read-only
  -> Final Synthesis

Optional Security Review
~~~

Templates instantiate durable Task, Run, and optional Stage primitives. They enforce reply budgets, loop guards, and the single-writer rule.

A full visual workflow DAG editor is deferred.

## 13. History and Search

Agent History is unified by Agent Profile across Provider changes.

It links:

- direct and group Conversations;
- membership and Messages;
- Tasks and Runs;
- Provider Session references;
- Memory and Context Snapshots;
- Artifacts, failures, and usage where available.

Search filters include Agent, Workspace, Conversation, Task, Run, Provider, time, status, and content/type. Secrets are never indexed.

Provider-native history is reference-only and is not imported as canonical Messages by default.

## 14. Failure and Safety Rules

- Persist Message before routing.
- Finalize stream failure explicitly and preserve durable checkpoints.
- Projection failure never fails the Run.
- Browser disconnect never cancels execution.
- Ambiguous text never approves high-impact actions.
- Secret values never enter Messages, cards, Events, or search.
- Group interactions always terminate through budgets, stop, and loop guard.
- Additional modifying Runs queue or reject.
- Archive never cascades deletes.
- Provider history never becomes Agent identity or canonical History.

## 15. Compatibility with Existing Runtime

Existing Conversation services, routes, runners, SSE projections, UI paths, schemas, migrations, and Provider reference fields remain under **COMPATIBILITY** where present.

Lite introduces no second Conversation authority and requires no destructive simplification. Future implementation evolves existing surfaces toward these contracts.

## 16. Included Capabilities

- direct persistent chat;
- ordered Messages and Revisions;
- streaming and reconnect;
- idempotent client retry;
- Artifact attachments;
- explicit Task and Run bridge;
- idempotent Event projection;
- bounded group mentions and replies;
- stop, budgets, and loop guard;
- per-Agent context;
- Workflow Templates;
- archive, history, and search references.

## 17. Deferred / Non-Goals

- autonomous infinite group chat;
- unbounded reply chains;
- parallel modifying Runs in one Workspace;
- Provider-native history as canonical History;
- full workflow DAG editor;
- exhaustive notification, presence, retention, and export products;
- cross-platform parity design.

## 18. Acceptance Expectations

Independent verification must prove:

- Message-only Turns create no Task and no Run;
- Task creation and Run creation are distinct and idempotent;
- Run start passes Workspace admission;
- Messages survive reconnect and Provider switch;
- client retry creates exactly one Message;
- streams finalize durably;
- browser disconnect leaves Run and Process active;
- Event projection never duplicates cards;
- Agent identity survives Provider changes;
- mention, @all, sequential, and parallel-read-only behavior follows policy;
- budgets, stop, and loop guard terminate every group interaction;
- per-Agent contexts remain isolated;
- no Workspace has two AgentOS modifying Runs;
- @all never launches parallel modification;
- archive preserves linked records;
- templates use durable Task, Run, and Stage primitives;
- search excludes secrets.

## 19. Cross-Document References

- [00 — Vision](./00-Vision.md) defines Conversation as a Fast-Track pillar.
- [01 — Core Concepts](./01-Core-Concepts.md) separates Message, Task, and Run.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines admission, cancel, retry, and recovery.
- [03 — Event Model](./03-Event-Model.md) defines ordered projection.
- [04 — Provider Specification](./04-Provider-Specification.md) keeps native sessions noncanonical.
- [05 — Process Runtime](./05-Process-Runtime.md) owns Process cancellation.
- [06 — Worktree Runtime](./06-Worktree-Runtime.md) defines mutation admission.
- [07 — Memory Runtime](./07-Memory-Runtime.md) supplies per-Agent Context Snapshots.
- [08 — Policy Runtime](./08-Policy-Runtime.md) defines approval routing.
- [10 — Data Model](./10-Data-Model.md) preserves Conversation persistence.
- [11 — API Specification](./11-API-Specification.md) exposes Message and stream APIs.
- [12 — UI Architecture](./12-UI-Architecture.md) defines direct and group UX.
- [13 — Runtime Inspector](./13-Runtime-Inspector.md) links Run facts to Conversation.
