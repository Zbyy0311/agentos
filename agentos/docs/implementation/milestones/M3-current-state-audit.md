# AgentOS M3 Lifecycle, Event and API Current-State Audit

Status: PREPARED FOR INDEPENDENT TECHNICAL REVIEW — DOCS-ONLY — M3 P1 NOT AUTHORIZED — PRODUCTION CUTOVER NOT AUTHORIZED

Audit date: 2026-08-01

This is a read-only current-state audit for M3 P0 scope alignment. It does not implement M3, create Migration 012, run a migration or restore, change production data, change API or Web behavior, switch a default, remove a compatibility path, or authorize M3 P1.

## 1. Baseline and evidence boundary

### 1.1 Git baseline

- Repository: Zbyy0311/agentos.
- Planning branch: docs/m3-cutover-preplanning.
- Pre-remediation planning branch HEAD: 020091cd558a9a87cae1fced9f51f1e4661ce7c9.
- Intended M3 planning baseline: origin/main at 80e398d5074ca8e0d6367d95a1aba3951b9a8843.
- Local main is clean at b61aedf6f2aaacd846324d5abd452a8875579840 and is an ancestor of origin/main.
- local main != origin/main. This remediation does not reset, merge, fast-forward, or otherwise modify local main.
- The application source is the agentos child directory of the independent Windows worktree.

The current branch was fetched from origin and is being audited against the fetched origin/main reference. The local-main mismatch is recorded as a release-process gate, not treated as evidence of a current main checkout.

### 1.2 M2 boundary

The merged M2 documents carry M2 as VERIFIED & MERGED / FULLY COMPLETE, with Production Cutover NOT STARTED and Remote Checks UNAVAILABLE — NOT PASS. M2 remains sealed. This audit does not reopen, extend, or re-verify M2.

Relevant carried contracts:

- M2.8 Owner Decisions keeps Legacy JSON and Legacy API compatibility active, keeps the Web default unchanged, keeps runs and agent_runs separate, and defers broad v2 realtime.
- M2.8 Verification and Cutover Readiness Plan keeps Production Cutover and physical Legacy retirement outside M2.
- M2.8 P5 Post-Merge Closeout records no production restore or cutover as part of M2 closeout.

### 1.3 Evidence rules

- OBSERVED means supported by the current source tree or Git state.
- CARRIED means retained from a merged M2 document and not newly verified here.
- GAP means the current code does not provide the M3 invariant.
- PLANNED means future work only; it is not an implementation result.
- PENDING INDEPENDENT TECHNICAL REVIEW means a contract recommendation is not approved.
- NOT EVIDENCED means this audit found no acceptable proof for the claimed capability.

No production code, test, migration, database, server, Web, browser, restore, or user-data operation was run for this docs-only remediation.

## 2. Authoritative M3 contract

The authoritative contract is Runtime Specification 14, Roadmap §§47–53, read with Runtime Specification 02 Runtime Lifecycle, 03 Event Model, 10 Data Model, and 11 API Specification.

### 2.1 Objective

M3 is Lifecycle, Event and API Foundation:

1. Run is a persistent state machine.
2. State transition uses the Persist-then-publish Event Path.
3. Browser refresh or disconnect does not cancel the Run.
4. Event sequence is strictly increasing per Run.
5. State, Runtime Event, and Outbox are written transactionally before publication.
6. Run Start returns an asynchronous result.
7. Retry creates a new child Run.
8. Compatibility routes remain usable at M3 end.

### 2.2 In scope

- Run Engine.
- Workflow Executor Foundation.
- Stage Transition.
- Canonical Runtime Event Envelope.
- Task-domain Sequence Allocator.
- Task-domain Event Store.
- Outbox table, repository, publisher, retry, and idempotency.
- Run Events API.
- Durable Run Stream, SSE reconnect, cursor, and Last-Event-ID.
- Replay Foundation.
- API Problem and stable error mapping.
- Operation Resource.
- ETag and If-Match.
- Idempotency Middleware.
- Basic OpenAPI.
- Create Task, Create Run, Start Run, Get Run, Cancel Run, Run Events, Run Stream, Operation, Error Mapping, Event Fixture, and Replay Foundation deliverables.

### 2.3 Explicitly out of scope

- Production Cutover.
- Production Restore.
- Web global v2 default switch.
- Legacy API retirement.
- Legacy JSON physical retirement, deletion, or broad data migration.
- Post-cutover production observation.
- Task/Conversation aggregate unification.
- ProcessManager and ProviderAdapter work reserved for M4.
- Worktree, Policy, Approval, and other later-milestone runtime domains.

## 3. Current authority and compatibility inventory

| Domain or surface | Current implementation | Current assessment |
| --- | --- | --- |
| Workspace | SQLite workspaces and tombstones are primary for current writes; Workspace JSON fallback remains for missing non-tombstoned records. | OBSERVED: SQLite-first with compatibility fallback; retirement is post-M3 and not authorized. |
| Agent/Profile | SQLite agent_profiles and provider_configurations are current canonical records; legacy nested values remain adoption input. | OBSERVED: separate profile/provider authority; no M3 rewrite is authorized. |
| Provider Configuration | SQLite provider_configurations joined through agent profiles and used by current repositories. | OBSERVED: current execution configuration authority. |
| Legacy Task | workspace-scoped tasks.json remains readable and writable through JsonFileStore-backed paths and recovery. | OBSERVED: active compatibility authority; M3 must not delete or retire it. |
| Canonical Task | SQLite tasks are used by v2 Task routes and TaskRunService, with legacy_task_id compatibility. | OBSERVED: Task-domain v2 authority for the current REST surface. |
| Conversation | SQLite conversations, messages, attachments, and collaboration records. | OBSERVED: separate Conversation aggregate. |
| Task-domain Run | SQLite runs, run_snapshots, and run_stages; RunRepository and v2 routes provide partial persistence. | OBSERVED: Task-domain Run authority, but not yet a persistent executable state machine. |
| Conversation Agent Run | SQLite agent_runs, run_steps, executions, and Conversation AgentEvents. | OBSERVED: separate Conversation runtime; never substitute it for Task-domain Runtime Events. |
| Execution | SQLite executions and execution_events under Conversation runtime. | OBSERVED: Conversation child execution evidence, not Task-domain Run execution. |
| Event | Conversation agent_events and run_event_sequences, Legacy SSE frames, and process-local RunStreamRegistry buffers. | GAP: no canonical Task-domain Runtime Event Store and no durable Task-domain stream. |
| Memory | SQLite metadata and FTS with recorded Markdown payloads. | OBSERVED: hybrid Memory authority, outside M3 lifecycle event implementation. |
| Artifact | SQLite runtime_artifacts metadata with artifact content under the workspace artifact store. | OBSERVED: hybrid Artifact authority, outside M3 lifecycle event implementation. |

The current code intentionally keeps Task → runs and Conversation → agent_runs separate. Conversation agent_events and RunStreamRegistry are not a Task-domain Event Store or a durable Run Stream.

| Compatibility path | Current implementation | M3 boundary |
| --- | --- | --- |
| Workspace JSON fallback | SqliteStore loads SQLite first, then non-tombstoned JSON records absent from SQLite. | Remains usable; no stop-read, deletion, or cutover in M3. |
| Legacy Task tasks.json | Legacy Task load/save and recovery continue to use JsonFileStore-backed tasks.json. | Remains usable; no physical retirement or deletion in M3. |
| Legacy API | Legacy Task routes remain mounted for task list/create/run/status/logs behavior. | Must remain usable at M3 end; only compatibility mapping is in scope. |
| Web Legacy default | apps/web/src/lib/useTask.ts still uses Legacy Task endpoints. | No global v2 default switch in M3. |
| v2 Task/Run REST | v2 Task routes create tasks/runs and expose partial Get/Cancel behavior. | M3 adds the missing lifecycle/API foundation without changing the Web default. |
| Legacy Task SSE | POST task run emits status, stage, thinking, done, and error frames; request close aborts the request-bound pipeline. | Preserve endpoint and map frames to v2 events only where the compatibility contract is proven. |
| Conversation stream | Conversation routes use persisted Conversation events plus process-local RunStreamRegistry transport. | Keep separate; do not count it as Task-domain durable replay. |

## 4. Authoritative M3 Gap Matrix

Every row below has the required fields: Current implementation, Existing partial capability, Exact missing invariant, M3 required work, Out of scope boundary, and Evidence source.

| # Area | Current implementation | Existing partial capability | Exact missing invariant | M3 required work | Out of scope boundary | Evidence source |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Run Engine | No Task-domain RunEngine or Start scheduler exists; TaskRunService creates records and RunRepository persists rows. | Create Run and Legacy Bridge reconciliation exist. | HTTP request lifetime must not be the Run execution lifetime; a persisted Run must advance independently. | Define a minimal Task-domain Run Engine and asynchronous Start path with durable ownership. | No ProcessManager, ProviderAdapter, provider execution redesign, or M4 runtime. | apps/server/src/services/TaskRunService.ts; apps/server/src/store/RunRepository.ts; Runtime-Specification/02-Runtime-Lifecycle.md §§2, 57 |
| 2 Run state machine and allowed transitions | RunRepository allows only a partial queued/running/terminal graph; starting, waiting_approval, and paused have no complete transitions. | Status, version, parentRunId, and rootRunId are persisted. | Only specified transitions are legal, terminal states cannot reset, and every transition is version-safe and event-producing. | Implement the M3 transition table and transition owner with cancel/complete conflict handling. | No Policy or Approval runtime; later domains remain deferred. | apps/server/src/store/RunRepository.ts; Runtime-Specification/02-Runtime-Lifecycle.md §56 |
| 3 Workflow Executor Foundation | Workflow definitions, snapshots, and stages exist, but no Task-domain executor schedules a persisted Run. | run_snapshots and run_stages are created during v2 Run creation. | A Run must execute a resolved workflow snapshot through an owned minimal stage executor. | Add only the foundation needed for a deterministic mock or built-in stage and Run completion. | No ProviderAdapter or real provider runtime; M4 owns that boundary. | apps/server/src/services/TaskRunService.ts; apps/server/src/migrations/migrations/007-workflow-definitions.ts; Runtime-Specification/02-Runtime-Lifecycle.md §§5, 57 |
| 4 Stage Transition | Initial run_stages rows are persisted, but there is no Task-domain stage transition engine. | Stage definitions, ordering, and snapshot persistence exist. | Stage transitions must be persisted, ordered, legal, and reflected in Run events. | Implement stage transition ownership and the minimal stage lifecycle used by the Run Engine. | No Worktree, Policy, Approval, or provider-specific stage behavior. | apps/server/src/migrations/migrations/009-run-stages.ts; apps/server/src/store/RunRepository.ts; Runtime-Specification/02-Runtime-Lifecycle.md §§6, 57 |
| 5 Event Envelope | Conversation AgentEvent records and Legacy SSE frames use different shapes; no canonical Task-domain RuntimeEvent writer exists. | EventBus persists Conversation AgentEvents after Conversation execution changes. | Each Task-domain event must have the canonical envelope, identity, run reference, sequence, durability, visibility, and validated payload. | Add envelope types, factory, validation, redaction, and Task-domain event fixtures. | Conversation AgentEvents are not converted into the Task-domain Event Store by assumption. | apps/server/src/events/EventBus.ts; apps/server/src/store/SqliteStore.ts; Runtime-Specification/03-Event-Model.md §§4, 5 |
| 6 Task-domain Sequence Allocator | runs has next_event_sequence, but RunRepository has no allocator; run_event_sequences allocates Conversation sequences. | A persisted counter and Conversation sequence mechanism exist. | Task-domain allocation is transactional with the target Run and yields strict per-Run monotonic sequence. | Add a Run-bound allocator using the runs row and a concurrency-safe transaction. | No reuse of Conversation run_event_sequences for Task-domain Runs. | apps/server/src/migrations/migrations/006-runs-table.ts; apps/server/src/store/SqliteStore.ts; Runtime-Specification/03-Event-Model.md §16 |
| 7 Task-domain Event Store | No runtime_events table or Task-domain event repository exists. agent_events requires Conversation context and serves agent_runs. | Conversation event persistence provides a pattern for append-only records. | Task-domain Runtime Events are append-only, queryable by Run, and uniquely constrained by run_id plus sequence. | Plan and later implement the Task-domain Event Store and query/replay repository. | Do not relabel agent_events as runtime_events or merge Conversation and Task histories. | apps/server/src/migrations/migrations/001-baseline-schema.ts; apps/server/src/migrations/migrations/006-runs-table.ts; Runtime-Specification/03-Event-Model.md §§5, 16 |
| 8 Outbox table, repository, publisher | Registry 001–011 has no outbox_messages table, repository, publisher, retry, or dead-letter path. | Migration and EventBus infrastructure shows transaction and publication patterns in other domains. | State/Event commit must enqueue a durable Outbox message before any broadcast; publication is at-least-once and retryable. | Plan a Task-domain Outbox schema, repository, publisher, retry/idempotency, and failure fixtures. | No external broker or paid infrastructure; local durable publisher foundation only. | apps/server/src/migrations/default-registry.ts; Runtime-Specification/10-Data-Model.md §§78, 111 |
| 9 State plus Event plus Outbox transaction boundary | RunRepository updates runs without a Runtime Event and Outbox write in the same transaction. | Run row version updates and idempotency records are transaction-capable in selected callers. | A state transition commits Current State + Runtime Event + Outbox atomically, or none of them commit. | Define and implement the aggregate transaction boundary with rollback tests. | No speculative migration or runtime implementation in this P0 remediation. | apps/server/src/store/RunRepository.ts; apps/server/src/services/IdempotencyService.ts; Runtime-Specification/10-Data-Model.md §§111, 121 |
| 10 Run Events API | v2Runs exposes Get Run and Cancel only; no v2 GET /runs/:runId/events route exists. | Get Run and cancel routes have workspace/run authorization and stable partial errors. | Clients can query persisted Task-domain events by Run and cursor without relying on a stream buffer. | Add Run Events route, cursor validation, authorization, and stable ApiProblem responses. | No Legacy route removal or Web global migration. | apps/server/src/routes/v2Runs.ts; Runtime-Specification/11-API-Specification.md §§57, 215 |
| 11 Durable Run Stream | RunStreamRegistry is a process-local session Map with a short retention window and is used by Conversation routes. | Conversation stream has live subscribers and a local cursor. | Task-domain Run Stream replays from persisted Events and remains recoverable after process loss. | Add the Task-domain SSE stream backed by Event Store history followed by Outbox/EventBus delivery. | RunStreamRegistry is not upgraded by relabeling; Conversation stream remains separate. | apps/server/src/services/RunStreamRegistry.ts; apps/server/src/routes/conversations.ts; Runtime-Specification/03-Event-Model.md §§17, 18 |
| 12 SSE reconnect, cursor, and Last-Event-ID | Legacy SSE has no v2 cursor contract; Conversation stream cursor is process-local. | RunStreamRegistry tracks an in-memory sequence/cursor for a live session. | afterSequence and Last-Event-ID must resume persisted history, reject expired cursors predictably, and never cancel the Run. | Implement cursor parsing, historical replay, live handoff, keepalive, disconnect semantics, and cursor error mapping. | No Web default switch and no removal of Legacy SSE. | apps/server/src/routes/tasks.ts; apps/server/src/routes/conversations.ts; Runtime-Specification/11-API-Specification.md §§87, 131 |
| 13 Replay Foundation | No v2 Run replay route or persisted Task-domain replay reader exists. | Conversation history can be read from its own aggregate. | Replay reads persisted events, detects gaps/unknown schemas, and never re-executes a provider or Run. | Add Task-domain replay foundation and fixtures for ordered, duplicate, gap, and unknown-event cases. | No Conversation history unification or provider re-run. | apps/server/src/services/ConversationService.ts; Runtime-Specification/03-Event-Model.md §§26, 27 |
| 14 Operation Resource | No Operation table, repository, or v2 operation route is present. | Start-like work can be represented by a Run row, but there is no separate command lifecycle. | Long or asynchronous commands return an Operation resource that is distinct from Run and has durable status/result/error. | Add the minimal Operation resource and route needed for async Start and command polling. | Do not use Operation to authorize cutover or production work. | apps/server/src/routes/v2Runs.ts; Runtime-Specification/11-API-Specification.md §§31, 32 |
| 15 API Problem and Error Mapping | respondV2 returns a partial error/code shape; it is not the full ApiProblem contract. | Stable code mapping exists for current v2 Task/Run errors. | All M3 API failures map to stable type/title/status/code/detail/request/field data without leaking internals. | Define ApiProblem mapping, middleware, and contract fixtures for 400, 404, 409, 412, 422, 429, and 500 classes. | No broad API rewrite outside M3 deliverables. | apps/server/src/routes/v2Tasks.ts; Runtime-Specification/11-API-Specification.md §§12, 214 |
| 16 ETag and If-Match | v2 routes accept body expectedVersion in selected paths; ETag and If-Match headers are absent. | Run version is persisted and optimistic conflicts are detectable. | Reads emit ETag and mutations enforce If-Match or an explicitly mapped expected-version rule with 412 semantics. | Add version header behavior, If-Match parsing, 412 mapping, and tests. | No unrelated resource-wide concurrency redesign. | apps/server/src/store/RunRepository.ts; apps/server/src/routes/v2Tasks.ts; Runtime-Specification/11-API-Specification.md §§22, 23 |
| 17 Idempotency Middleware | Migration 010 and IdempotencyService cover a partial set of six operations; callers own transactions. | task.create, run.create, run.cancel, task.accept, task.cancel, and task.reopen have replay/key-reuse behavior. | M3 high-side-effect lifecycle commands replay the original result and never duplicate state/event/outbox effects. | Extend the middleware and records for M3 Start, Cancel, Retry, and applicable Create commands while preserving M2 behavior. | No destructive Legacy deletion or production cutover command. | apps/server/src/migrations/migrations/010-idempotency-records.ts; apps/server/src/services/IdempotencyService.ts; Runtime-Specification/11-API-Specification.md §23 |
| 18 Basic OpenAPI | No concrete v2 OpenAPI artifact or generator is present in the current implementation search. | Route files and tests provide partial executable contract evidence. | M3 deliverables have a reviewable OpenAPI description for schemas, headers, status codes, events, and stream endpoints. | Add the minimal documented contract and validation/check step. | No API documentation for later Worktree, Policy, Approval, or Provider domains. | apps/server/src/routes/v2Tasks.ts; apps/server/src/routes/v2Runs.ts; Runtime-Specification/11-API-Specification.md §§2, 57 |
| 19 Retry creates child Run | RunRepository has parentRunId/rootRunId fields and child creation rules, but no complete Retry command lifecycle. | New Run creation can record parent/root identity and reason. | Retry never resets a failed/cancelled Run; it creates a new child Run with explicit lineage and idempotent command behavior. | Add Retry command, lineage events, child Run creation, and conflict/idempotency tests. | No provider retry policy or production retry automation. | apps/server/src/store/RunRepository.ts; apps/server/src/services/TaskRunService.ts; Runtime-Specification/02-Runtime-Lifecycle.md §38 |
| 20 Browser disconnect and server restart | Request-bound Legacy execution aborts on close; v2 Task Run stream/recovery is absent. Conversation GET subscription close unsubscribes, while message execution close can abort its controller. | Legacy queued recovery and Conversation recovery exist in separate aggregates. | Browser disconnect ends only the subscription; server restart recovers from persisted Run/Stage/Event state and never guesses success. | Implement disconnect-safe Run execution, startup recovery scan, persisted replay, and uncertain-state handling. | No production restore, operator cutover, or runs/agent_runs unification. | apps/server/src/routes/tasks.ts; apps/server/src/routes/conversations.ts; apps/server/src/taskRecovery.ts; Runtime-Specification/02-Runtime-Lifecycle.md §§52, 54 |
| 21 Legacy execute-task and Legacy SSE to v2 compatibility mapping | Legacy task run emits status/stage/thinking/done/error and bridges selected Run rows, but frames are not reconstructed from a v2 Event Store. | TaskRunService has createLegacyRunForBridge and terminal bridge calls. | Legacy POST maps internally to Create Run then Start Run, and legacy frames are projections of persisted v2 Events without a second execution model. | Define and test status/stage/thinking/done/error projection while keeping the Legacy endpoint usable. | No Legacy API retirement, Legacy JSON deletion, or Web default switch. | apps/server/src/routes/tasks.ts; apps/server/src/services/TaskRunService.ts; Runtime-Specification/11-API-Specification.md §§181, 182 |
| 22 Tests, fixtures, and recovery gaps | Existing tests cover M2 repositories/routes/Conversation behavior, not the complete Task-domain Event/Outbox/replay/API vertical chain. | Route, repository, idempotency, and Conversation tests provide regression baselines. | RED/GREEN evidence must cover transitions, duplicate Start, cancel/complete race, child retry, ordering, duplicates, reconnect, disconnect, Outbox recovery, ApiProblem, ETag, Idempotency, and contract shape. | Add a minimal Event Fixture and the M3 vertical acceptance suite with recovery and regression coverage. | No claim of passed tests in this planning branch; no production or browser execution. | apps/server/src/**/__tests__; Runtime-Specification/14-Roadmap.md §52 |

## 5. Migration 012 schema-gap conclusion

### 5.1 Decision

Migration 012 REQUIRED — PLANNING ONLY.

This is a schema-gap conclusion for future planning, not authorization to create or execute a migration. No DDL was created in this remediation. Any future DDL requires an independent technical review, explicit owner authorization for the irreversible schema risk, a checksum/rollback plan, and a separate implementation change.

### 5.2 Exact missing schema and proof

Registry migrations 001–011 provide runs.next_event_sequence and runs.version, but they do not provide:

1. A Task-domain runtime_events table with the canonical envelope fields and a foreign-key relationship to Task-domain runs.
2. A unique run_id plus sequence invariant for append-only Task-domain events.
3. A durable outbox_messages table with message identity, event reference, delivery status, attempt count, availability, published time, error/dead-letter state, and retry ownership.
4. An atomic schema path that writes Run state, Runtime Event, and Outbox in one transaction.
5. A durable Operation resource needed to track asynchronous commands independently from a Run.

The existing agent_events and run_event_sequences structures do not satisfy this gap: agent_events requires conversation_id and belongs to the Conversation agent_runs/EventBus path; run_event_sequences allocates Conversation event sequence and is not a sequence allocator for Task-domain runs. Conversation events must not be counted as a Task-domain Event Store.

Therefore conclusion B, Migration 012 NOT REQUIRED, is not supportable from 001–011. The correct conclusion is A, with implementation explicitly deferred until the contract and schema are independently reviewed.

## 6. M3 boundary and pre-P1 gate

### 6.1 M3 end-state boundary

At the end of M3, the Legacy route remains usable, the Web global default remains unchanged, Legacy JSON and Legacy API are not deleted, Production Cutover has not started, runs and agent_runs remain separate, and M4 ProcessManager/ProviderAdapter work has not begun.

M3 P1 is not authorized by this audit. The P0 contract and technical decisions must be independently reviewed before any implementation branch is opened.

### 6.2 Hard Pre-P1 Gate

Before any future M3 implementation branch:

1. Fetch origin.
2. Confirm the main worktree is clean.
3. Fast-forward local main only to origin/main.
4. Confirm local main equals origin/main.
5. Do not use reset --hard, force-push, or an implicit merge to hide divergence.
6. If fast-forward-only synchronization is impossible, stop and obtain independent review.

The current remediation does not modify local main, because local main is currently b61aedf6f2aaacd846324d5abd452a8875579840 while origin/main is 80e398d5074ca8e0d6367d95a1aba3951b9a8843.

## 7. Evidence index

### Runtime contracts

- docs/Runtime-Specification/02-Runtime-Lifecycle.md
- docs/Runtime-Specification/03-Event-Model.md
- docs/Runtime-Specification/10-Data-Model.md
- docs/Runtime-Specification/11-API-Specification.md
- docs/Runtime-Specification/14-Roadmap.md

### Carried M2 contracts

- docs/implementation/milestones/M2.8-owner-decisions.md
- docs/implementation/milestones/M2.8-verification-cutover-readiness-plan.md
- docs/implementation/milestones/M2.8-p5-post-merge-closeout.md
- docs/implementation/migration-register.md

### Current implementation evidence

- apps/server/src/migrations/default-registry.ts
- apps/server/src/migrations/migrations/001-baseline-schema.ts
- apps/server/src/migrations/migrations/006-runs-table.ts
- apps/server/src/migrations/migrations/010-idempotency-records.ts
- apps/server/src/store/SqliteStore.ts
- apps/server/src/store/RunRepository.ts
- apps/server/src/services/TaskRunService.ts
- apps/server/src/services/IdempotencyService.ts
- apps/server/src/services/RunStreamRegistry.ts
- apps/server/src/events/EventBus.ts
- apps/server/src/routes/tasks.ts
- apps/server/src/routes/v2Tasks.ts
- apps/server/src/routes/v2Runs.ts
- apps/server/src/routes/conversations.ts
- apps/web/src/lib/useTask.ts

## 8. Audit conclusion

The current checkout is prepared for independent M3 technical review, not implementation. M3 must be planned as Lifecycle, Event and API Foundation. The authoritative gap is the missing Task-domain persistent state machine plus Persist-then-publish chain, not Production Cutover.

M3 P1 NOT AUTHORIZED.

PRODUCTION CUTOVER NOT AUTHORIZED.

PRODUCTION DATA UNCHANGED.
