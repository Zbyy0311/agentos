# AgentOS M3 Owner Decision Register

Status: TECHNICAL CONTRACT DECISIONS PENDING INDEPENDENT TECHNICAL REVIEW — DEFERRED POST-M3 DECISIONS PRESERVED — M3 P1 NOT AUTHORIZED

Baseline: origin/main at 80e398d5074ca8e0d6367d95a1aba3951b9a8843

This register separates decisions needed to implement the M3 Lifecycle, Event and API Foundation from historical Production Cutover and Legacy Retirement decisions. A recommendation is not an approval and does not authorize code, DDL, production behavior, restore, deletion, Web default changes, or M3 P1.

## 1. Decision rules

- M2 remains sealed at VERIFIED & MERGED / FULLY COMPLETE. This register does not reopen or extend M2.
- M3 is governed by Runtime Specification 14, Roadmap §§47–53, with lifecycle/event/API details from Runtime Specification 02, 03, 10, and 11.
- Technical contract decisions are recommendations pending independent technical review. They are not user Owner Approvals unless they deviate from the Runtime Specification, create irreversible schema or data risk, incur external cost, or materially change user-visible behavior.
- Production Cutover, Production Restore, real data deletion, irreversible schema changes, external infrastructure or paid services, and material user-visible behavior changes require USER OWNER APPROVAL REQUIRED.
- Unknown records, data mismatches, active or interrupted Runs, missing Remote Checks, and unavailable evidence fail closed rather than becoming implicit success.
- Every future implementation phase must record evidence, stop conditions, rollback boundary, reviewer, and authorization before execution.

## 2. M3 Technical Contract Decisions

These rows are M3 technical-contract closure items. Their current status is PENDING INDEPENDENT TECHNICAL REVIEW. They do not authorize M3 P1.

| ID | Contract decision | Current fact | Technical recommendation | Status and approval boundary |
| --- | --- | --- | --- | --- |
| M3-TD-01 | Task-domain Event scope versus Conversation agent_runs | Task-domain runs and Conversation agent_runs are separate aggregates. Conversation agent_events is persisted through EventBus under Conversation context. | M3 Runtime Events, Event Store, Outbox, sequence, replay, and Run Stream apply to Task-domain runs only. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required only for a later aggregate-unification deviation. |
| M3-TD-02 | runs versus agent_runs boundary | runs belongs to Task/Run REST and the Legacy Bridge; agent_runs belongs to Conversation execution and recovery. | Preserve separation through M3. Any shared projection or unification is a later design. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required for a data-model unification or material behavior change. |
| M3-TD-03 | Run state machine and transition owner | RunRepository has a partial transition graph and persists version, but no complete Run Engine owns transitions. | Task-domain Run Engine owns the Roadmap transition table; repository enforces legal transition and optimistic version checks; terminal Runs never reset. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required for any Runtime Specification deviation. |
| M3-TD-04 | Persist-then-publish path | Current Run updates do not atomically write a Task-domain Runtime Event and Outbox message. | A transition transaction writes Current State, Runtime Event, and Outbox; commit precedes EventBus/SSE publication. | PENDING INDEPENDENT TECHNICAL REVIEW. Any DDL or irreversible transaction change requires USER OWNER APPROVAL REQUIRED. |
| M3-TD-05 | Event aggregate key | Conversation events use conversation_id and may carry run_id; that does not establish Task-domain ownership. | Task-domain Event Store keys the event to run_id, with workspace_id and task_id context as required by the canonical envelope. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required for a cross-aggregate schema deviation. |
| M3-TD-06 | Per-Run sequence allocator | runs.next_event_sequence exists; run_event_sequences is Conversation infrastructure and cannot be reused by Task-domain Runs. | Allocate sequence in the same transaction as the Run and Event, with unique run_id plus sequence enforcement. | PENDING INDEPENDENT TECHNICAL REVIEW. Future schema implementation remains separately authorized. |
| M3-TD-07 | Outbox delivery contract | No Task-domain outbox table, repository, publisher, or dead-letter path exists in migrations 001–011. | Persist Outbox before publication; publisher is at-least-once, retryable, observable, and idempotent at the consumer boundary. | PENDING INDEPENDENT TECHNICAL REVIEW. External broker or paid infrastructure requires USER OWNER APPROVAL REQUIRED; local foundation does not. |
| M3-TD-08 | Publisher retry and idempotency | EventBus provides Conversation publication behavior but not the M3 Task-domain Outbox contract. | Retry by durable message identity, preserve event identity, prevent duplicate externally visible effects, and retain failure evidence. | PENDING INDEPENDENT TECHNICAL REVIEW. Any externally charged service requires USER OWNER APPROVAL REQUIRED. |
| M3-TD-09 | SSE cursor, reconnect, and replay | Legacy SSE is request-bound; RunStreamRegistry is a process-local Conversation buffer. | Task-domain Run Stream first replays persisted Events after afterSequence or Last-Event-ID, then subscribes to new publication; expired cursors map to a stable error. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required for a material client-visible behavior deviation. |
| M3-TD-10 | Client disconnect and server restart | Some current request-bound paths abort on close; no Task-domain durable recovery stream exists. | Client disconnect ends only the subscription. Restart scans persisted Run/Stage/Event state, resumes or marks uncertainty explicitly, and never guesses success. | PENDING INDEPENDENT TECHNICAL REVIEW. Production recovery or restore is deferred and requires USER OWNER APPROVAL REQUIRED. |
| M3-TD-11 | Operation Resource lifecycle | No Operation resource table or route exists; a Run is not an Operation. | Async Start and long commands return a durable Operation with pending/running/succeeded/failed/cancelled state, result reference, and ApiProblem error. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required for a new material product workflow. |
| M3-TD-12 | API Problem and stable error mapping | respondV2 exposes partial error/code mapping. | Implement the Runtime Specification ApiProblem shape and stable mappings for validation, not found, conflict, precondition, rate, and internal failures. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required only for a user-visible contract deviation. |
| M3-TD-13 | ETag, If-Match, and version | Selected routes accept expectedVersion in the body; ETag and If-Match are not implemented. | Emit ETag from resource version; accept If-Match and return 412 for stale mutation, with expectedVersion as a documented compatibility fallback where needed. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required for a materially incompatible client behavior. |
| M3-TD-14 | Idempotency command set | Migration 010 and IdempotencyService cover a partial set of Task commands. | Preserve M2 replay/key-reuse semantics and extend middleware to M3 Start, Cancel, Retry, and applicable Create commands so state/event/outbox effects occur once. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required for destructive or irreversible commands outside M3. |
| M3-TD-15 | Retry child Run | parentRunId and rootRunId are persisted, but no complete Retry command and event path exists. | Failed or cancelled Run is immutable; Retry creates a new child Run with parent/root lineage and its own idempotency result. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required only if the behavior deviates from the Runtime Specification. |
| M3-TD-16 | Legacy SSE compatibility mapping | Legacy route emits status, stage, thinking, done, and error frames and has partial Run bridging. | Preserve the Legacy endpoint and project legacy frames from the Task-domain Event contract: status/stage to lifecycle events, thinking to stream.text_delta, done to terminal event, error to stable failure event. | PENDING INDEPENDENT TECHNICAL REVIEW. Legacy API retirement or material UX change requires USER OWNER APPROVAL REQUIRED and is not M3 scope. |
| M3-TD-17 | Basic OpenAPI boundary | No concrete OpenAPI artifact is present in the current implementation. | Document only the M3 Task/Run/Operation/Event/Stream contract, headers, errors, and status codes; validate it as a contract artifact. | PENDING INDEPENDENT TECHNICAL REVIEW. Later domains are not silently added. |
| M3-TD-18 | Migration 012 schema conclusion | Registry 001–011 has runs.next_event_sequence and version, but no Task-domain runtime_events, outbox_messages, or Operation persistence. | Migration 012 REQUIRED — PLANNING ONLY. Record the exact schema gap; do not create DDL in P0. | PENDING INDEPENDENT TECHNICAL REVIEW. Any future irreversible DDL requires USER OWNER APPROVAL REQUIRED, independent review, and a separate implementation authorization. |
| M3-TD-19 | Async Run Start result | Current v2 routes have no Start Run route or Operation response. | Create Run remains distinct from Start Run; Start returns an asynchronous Operation/202 result and later advances the persisted Run. | PENDING INDEPENDENT TECHNICAL REVIEW. User approval is required for a material API or UX deviation. |
| M3-TD-20 | Roadmap deliverable closure | Create Task and partial Create/Get/Cancel Run routes exist; Events, Stream, Replay, Operation, and OpenAPI are absent. | Close deliverables by evidence, not by route-name presence: each API must have contract fixtures and lifecycle integration coverage. | PENDING INDEPENDENT TECHNICAL REVIEW. No deliverable is marked passed in this planning register. |

## 3. Deferred Post-M3 Decisions

The following historical decision content remains recorded, but it is not required to implement the M3 Lifecycle, Event and API Foundation. Every row is NOT AN M3 P1 BLOCKER and NOT AUTHORIZED IN M3.

| ID | Deferred decision | Historical/current fact and preserved planning recommendation | Status in M3 |
| --- | --- | --- | --- |
| M3-POST-01 | Production Cutover definition and completion standard | No production transition has started. A future Cutover must name read/write/default authority, start/end evidence, operator, stop condition, and rollback window. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-02 | Workspace JSON stop-read, stop-write, archive, and deletion | Workspace remains SQLite-first with JSON fallback; retain source through parity, conflict/quarantine, backup, and rollback gates before any retirement. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for source retirement or deletion. |
| M3-POST-03 | Legacy Task JSON migration, retention, and history policy | tasks.json remains active compatibility authority. Preserve source and do not synthesize history; future mapping requires per-record disposition. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for data meaning changes or deletion. |
| M3-POST-04 | Legacy API retirement | Legacy routes remain mounted and used by current Web code. Future removal needs caller inventory, deprecation, replacement contract, and no-caller evidence. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-05 | Web global default switch | apps/web/src/lib/useTask.ts still calls Legacy Task endpoints. Future switch needs a feature flag, user-visible acceptance, staged rollout, and instant rollback. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-06 | Production Restore and downgrade authority | Backup verification exists, but production Restore and downgrade workflow is not evidenced. Any restore needs named owner, two-person confirmation, audit transcript, and rehearsal. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-07 | Rollback window and failed Cutover handling | Future transition must fail closed, preserve source and evidence, stop new writes, and use only a pre-approved reversible boundary. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-08 | Backup retention and production-copy access | Retain verified backups through rollback and observation; define least-data copies, provenance, access, and deletion owner. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for real data retention or deletion policy. |
| M3-POST-09 | Source quiescence and process ownership | Existing locks are not production quiescence proof. Future cutover needs no-new-work admission, active/interrupted inventory, process lease, and release record. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-10 | Partial Cutover and data mismatch | Future cohorts may not be left in an unowned mixed state; mismatches and unknown records must be quarantined with source references, never silently overwritten or dropped. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for cohort policy or data disposition. |
| M3-POST-11 | Active/interrupted Run treatment | Future production transition must inventory each aggregate, mark uncertainty explicitly, and never infer success from a process or stream state. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for live-work policy. |
| M3-POST-12 | Post-Cutover observation and telemetry | No transition has occurred, so no observation window exists. Future metrics must cover legacy reads/writes, mismatches, stream failures, active Runs, rollback, and operator actions. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED where external telemetry or sensitive data is involved. |
| M3-POST-13 | Legacy data deletion | M2 retains Legacy JSON and compatibility evidence; no deletion is implied by M3 event/API work. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for any destructive operation. |
| M3-POST-14 | Branch, PR, merge, and release policy | This remediation is one docs-only commit with no PR. Future implementation may use Draft PR, independent review, and ordinary merge commit if separately authorized. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; current remediation has no PR. |
| M3-POST-15 | Remote Checks unavailable | Existing M2 status is UNAVAILABLE — NOT PASS. Future gates may disclose exact local L3 evidence but must not relabel missing remote evidence as passed. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; independent review or Owner acknowledgment is required for any substitute release gate. |

## 4. P0 closure status

### Technical contract

- M3 contract: RESTORED to Lifecycle, Event and API Foundation.
- Technical decisions: PENDING INDEPENDENT TECHNICAL REVIEW.
- Migration 012: REQUIRED — PLANNING ONLY; no DDL created.
- M3 P1: NOT AUTHORIZED.

### Deferred post-M3 work

- Production Cutover: NOT AUTHORIZED.
- Production Restore: NOT AUTHORIZED.
- Web global default switch: NOT AUTHORIZED.
- Legacy API and Legacy JSON retirement/deletion: NOT AUTHORIZED.
- Post-cutover observation: NOT AN M3 P1 BLOCKER and NOT AUTHORIZED IN M3.

An Owner Decision is closed only when it includes the selected option, owner identity and timestamp, affected scope, evidence thresholds, stop/no-go condition, rollback boundary, review requirement, and re-review trigger. Until then, the decision remains pending and cannot authorize implementation.
