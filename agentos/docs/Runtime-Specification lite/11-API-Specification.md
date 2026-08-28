# AgentOS Runtime Specification Lite

## 11 — API Specification

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs remain authoritative for frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical Runtime Specification remains reference architecture where it exceeds Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

This document defines the stable /api surface for AgentOS Lite on Windows.

It exposes durable resources, commands, Operations, ordered Events, and reconnectable SSE. HTTP or browser lifetime never owns Run lifetime.

Endpoints described as forward contracts are not claimed implemented. Existing compatible routes remain until deliberately migrated.

## 2. Lite Scope

### 2.1 ACTIVE LITE

- Workspace, Agent, Provider Configuration;
- Conversation and Message;
- Task, Run, optional Stage;
- Event query/replay/SSE;
- Operations and runtime control;
- Memory and Context Snapshot;
- Artifact references;
- Agent History and Search;
- diagnostics and Inspector projections;
- problem details, idempotency, versions, pagination, redaction.

### 2.2 COMPATIBILITY

- merged Start/Retry, Operation Cancel, Event/replay/stream contracts;
- current workspace-scoped legacy and v2 routes;
- existing conversation, memory, approval, Artifact, Git observation, preference, storage, and lease routes;
- deprecated routes with explicit migration guidance.

### 2.3 DEFERRED FULL-SCOPE

- Worktree, Branch, Merge, Conflict, and cleanup product APIs;
- full Policy DSL, grant, exception, simulation, and RBAC APIs;
- workflow DAG editor APIs;
- Provider Comparison and benchmark APIs;
- extension marketplace, native host, mobile, cloud, and distributed worker APIs;
- mandatory WebSocket transport.

## 3. Invariants

| Invariant | Contract |
|---|---|
| Agent != Provider | Agent Profile is identity; Provider Configuration is capability. |
| Message != Task | Posting communication does not formalize work. |
| Message != Run | Normal Send never starts modification. |
| Task != Run | Retry creates another Run. |
| Run != Process | Process ID is not native PID. |
| HTTP request != execution | Commands return durable resources or Operations. |
| Disconnect != cancellation | Only explicit cancel controls execution. |
| REST is query authority | SSE is incremental delivery. |
| Persist then publish | State, Event, and Outbox commit before delivery. |
| Admission before spawn | Modifying execution obtains sole Workspace authority. |
| Secrets are references | Values never enter ordinary DTOs. |
| Paths are not resource contracts | Artifact content uses controlled endpoints. |

## 4. Architecture

~~~text
Web / CLI / Inspector
  -> REST + SSE under /api
  -> request ID, auth, validation, problem mapping
  -> application services
  -> admission, Provider Adapter, Policy, Process, recovery
  -> SQLite + Event Store + Outbox
~~~

Route handlers validate and map DTOs. They never spawn Processes, execute Git, write tables directly, or force Run status.

## 5. Global HTTP Contract

- base path /api;
- plural kebab-case resources;
- camelCase JSON;
- UTC ISO 8601 times;
- opaque typed IDs;
- 200, 201, 202, 204 success semantics;
- X-Request-ID on every response;
- ETag and If-Match for mutable resources;
- Idempotency-Key for side effects;
- Cache-Control no-store for sensitive responses;
- application/problem+json errors;
- unknown API routes return JSON, never HTML or stack text.

List response:

~~~text
data
page.limit
page.hasMore
page.nextCursor
~~~

No endpoint requires an expensive total count.

## 6. Errors

Problem fields:

- type, title, status, stable code;
- safe detail and instance;
- requestId;
- retryable and optional retryAfterMs;
- optional suggestedAction;
- bounded field errors;
- safe Workspace/Task/Run/Operation references.

Core mappings:

| HTTP | Class |
|---|---|
| 400 | validation or cursor error |
| 404 | resource not found |
| 409 | version, idempotency, active Run, retry, or admission conflict |
| 410 | retained cursor/resource gone |
| 412 | ETag precondition failed |
| 423 | approval wait or modifying authority held |
| 429 | bounded rate/concurrency |
| 500 | fail-closed state ambiguity |
| 502 | Provider dependency failure |
| 503 | retryable runtime busy/unavailable |

Errors exclude SQL, SQLite text, filesystem paths, credentials, stack traces, and secret-bearing Provider output.

## 7. Idempotency and Versions

Required for create Task, create/start/retry/cancel Run, Send Message, and approval decisions where the frozen contract requires it.

- same key and request returns or converges on the original response;
- replay performs no Provider, Process, Policy, or Git side effect;
- same key with a different fingerprint returns conflict;
- result remains stable through terminal state and a safety window.

Expected version or If-Match arbitrates start, cancel/completion, approve/reject, retry creation, and admission races.

## 8. Pagination, Events, and Search

- opaque cursor pagination defaults to 50 and caps at 200;
- ordered Messages and Events use sequence cursors;
- filters are explicit and sorting is whitelisted;
- include expansions are bounded;
- Search combines q with Workspace- and permission-scoped filters;
- secrets are never indexed.

## 9. Workspace, Agent, Provider

~~~text
GET/POST /api/workspaces
GET/PATCH/DELETE /api/workspaces/:workspaceId
POST /api/workspaces/:workspaceId/validate

GET/POST /api/workspaces/:workspaceId/agents
GET/PATCH /api/agents/:agentId
POST /api/agents/:agentId/enable
POST /api/agents/:agentId/disable
GET /api/agents/:agentId/history

GET/POST /api/provider-configs
GET/PUT/DELETE /api/provider-configs/:providerConfigId
POST /api/provider-configs/:providerConfigId/validate
~~~

Workspace paths are normalized and boundary checked. Agent Profile remains identity across Provider changes. Provider secrets are references.

Some Workspace and Provider Configuration routes exist as compatibility surfaces; unified Agent CRUD/History is forward ACTIVE LITE unless independently verified.

## 10. Conversation and Message

~~~text
GET/POST /api/conversations
GET/PATCH /api/conversations/:conversationId
POST /api/conversations/:conversationId/archive
POST /api/conversations/:conversationId/restore
GET /api/conversations/:conversationId/members
GET /api/conversations/:conversationId/turns

POST /api/conversations/:conversationId/messages
POST /api/messages/:messageId/create-task
POST /api/messages/:messageId/start-run
~~~

Send Message persists communication and may route a chat Turn; it creates no Task or Run.

Create-task idempotently creates Task intent and starts nothing.

Start-run explicitly creates a Run Request and applies admission.

Send retry uses Idempotency-Key plus clientMessageId to converge on one Message.

## 11. Task and Run

~~~text
GET/POST /api/workspaces/:workspaceId/tasks
GET/PATCH /api/tasks/:taskId
POST /api/tasks/:taskId/accept
POST /api/tasks/:taskId/cancel
POST /api/tasks/:taskId/reopen

POST /api/tasks/:taskId/runs
GET /api/runs/:runId
POST /api/runs/:runId/start
POST /api/runs/:runId/retry
POST /api/runs/:runId/cancel
POST /api/runs/:runId/pause
POST /api/runs/:runId/resume
~~~

Run transition authority belongs to the Engine.

Start returns a durable accepted Operation; it does not hold the HTTP connection.

Retry creates a child Run and preserves parent/root lineage.

Cancel is explicit, idempotent, terminates the owned Windows Process tree, and releases modifying authority only with committed state.

## 12. Operations and Approval

~~~text
GET /api/operations/:operationId
GET /api/operations/:operationId/events
POST /api/operations/:operationId/cancel

POST /api/runs/:runId/approvals
POST /api/approvals/:approvalRequestId/resolve
~~~

Operation tracks a command and never becomes Run authority.

Approval is a typed resource. Ambiguous Message text never approves. Resolve is versioned and idempotent, and stale/expired approval fails.

## 13. Runtime Events and SSE

~~~text
GET /api/runs/:runId/events?afterSequence
GET /api/runs/:runId/replay?fromSequence&toSequence
GET /api/runs/:runId/stream?afterSequence
~~~

Event DTO preserves canonical envelope, sequence, references, severity, visibility, and redacted payload.

Reconnect:

1. validate access and cursor;
2. resolve Last-Event-ID and afterSequence monotonically;
3. capture high-watermark;
4. replay committed Events;
5. drain buffered arrivals;
6. deduplicate by Event ID;
7. continue live.

Keepalive is ephemeral. Disconnect closes only the subscription.

## 14. Memory

~~~text
GET/POST /api/workspaces/:workspaceId/memories
GET/PATCH /api/memories/:memoryId
POST /api/memories/:memoryId/pin
POST /api/memories/:memoryId/archive
GET /api/memory-candidates
POST /api/memory-candidates/:candidateId/accept
POST /api/memory-candidates/:candidateId/reject
POST /api/memory/retrieve
GET /api/runs/:runId/memory-context
GET /api/memory-contexts/:memoryContextId
POST /api/memory-conflicts/:conflictId/resolve
~~~

Forward retrieval is Scope-filtered, FTS5-ranked, budgeted, and frozen as a Context Snapshot with selection/exclusion reasons.

Compatibility Memory routes do not prove the complete forward model.

## 15. Artifacts

~~~text
GET /api/artifacts
GET /api/artifacts/:artifactId
GET /api/artifacts/:artifactId/content
GET /api/artifacts/:artifactId/download
GET /api/artifacts/:artifactId/references
~~~

Content supports controlled access and optional ranges. Storage URI and local absolute path are never response contracts.

## 16. History and Search

~~~text
GET /api/agents/:agentId/history
GET /api/history
GET /api/search
~~~

Filters include Agent, Workspace, Conversation, Task, Run, Provider Configuration, time, status, and type.

History is unified by Agent Profile, not Provider transcript. These are forward ACTIVE LITE endpoints unless separately verified.

## 17. Diagnostics and Inspector

~~~text
GET /api/health
GET /api/ready
GET /api/meta
GET /api/capabilities
GET /api/runs/:runId/inspector
GET /api/runs/:runId/snapshot
GET /api/processes/:processId
GET /api/processes/:processId/output
~~~

Only GET /api/health is a verified merged top-level route at the cited baseline. The remaining readiness, metadata, capability, Inspector, Snapshot, and Process routes in this block are forward **ACTIVE LITE** contracts unless independently verified.

Diagnostics expose bounded, redacted Run, Stage, Provider, Process, Event, Memory, Artifact, Git observation, error, retry, cancellation, and recovery facts.

Git endpoints observe status/diff/log only. They do not establish AgentOS Git ownership.

## 18. Failure and Safety

- request/SSE loss never cancels Run;
- Cancel is the canonical cancellation path;
- modifying Run cannot start without sole Workspace authority;
- retry never resets a terminal Run;
- UNKNOWN recovery is never success;
- secret values never enter DTOs, Events, logs, Memory, snapshots, or Search;
- local paths never become Artifact contracts;
- invalid cursor, unknown field, or stale version fails explicitly;
- native Provider session and internal Git/worktree remain noncanonical.

## 19. Compatibility Policy

Compatible routes remain mounted and callable. No route is removed solely to shorten Lite.

Legacy task execution maps to Task plus Run. Worktree lease and full-scope policy endpoints may remain compatibility-only without becoming Lite requirements.

## 20. Acceptance Expectations

Independent verification must prove:

- Message post creates no Task or Run;
- create-task and start-run are separate and idempotent;
- Start returns durable acceptance;
- browser disconnect leaves execution active;
- frozen start/retry/cancel semantics and errors remain exact;
- Event query/replay/SSE has no gaps or duplicates;
- bad cursor returns stable validation error;
- one Workspace never admits two modifying Runs;
- optimistic races have one winner;
- History is Agent-unified and Search is secret-free;
- Artifact DTOs leak no storage path;
- deferred API families are not active requirements.

## 21. Deferred / Non-Goals

- Worktree/Branch/Merge/Conflict product APIs;
- full Policy administration;
- workflow DAG editor;
- Provider Comparison;
- extension marketplace;
- unsafe-mode product API;
- native/mobile/cloud/distributed APIs;
- mandatory WebSocket.

## 22. Cross-Document References

- [00 — Vision](./00-Vision.md) defines scope.
- [01 — Core Concepts](./01-Core-Concepts.md) defines resource identity.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines controls.
- [03 — Event Model](./03-Event-Model.md) defines SSE.
- [04 — Provider Specification](./04-Provider-Specification.md) defines Provider DTO boundaries.
- [05 — Process Runtime](./05-Process-Runtime.md) defines cancel and output.
- [06 — Worktree Runtime](./06-Worktree-Runtime.md) defines admission and Git observation.
- [07 — Memory Runtime](./07-Memory-Runtime.md) defines Memory APIs.
- [08 — Policy Runtime](./08-Policy-Runtime.md) defines approvals.
- [09 — Conversation Runtime](./09-Conversation-Runtime.md) defines explicit intents.
- [10 — Data Model](./10-Data-Model.md) maps persistence.
- [12 — UI Architecture](./12-UI-Architecture.md) consumes the API.
- [13 — Runtime Inspector](./13-Runtime-Inspector.md) defines query projections.
