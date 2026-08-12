# AgentOS M3 Owner Decision Register

Technical direction status: M3-TD-01 through M3-TD-30 retain their prior independent technical review status. M3-TD-31 and M3-TD-32 are OWNER APPROVED / IMPLEMENTED AND MERGED through P3D. M3-TD-33 through M3-TD-36 required no new user Owner Decision and were subsequently implemented and accepted through P6A/P6B/P6C/P6D. The earlier P6A0 HIGH-1 is preserved below as historical review evidence; its forward remediation passed re-review without a new Owner decision, schema change, or Migration 014. M3 implementation is complete; formal closeout becomes COMPLETE when PR #43 merges. M4 Entry is PENDING A SEPARATE ENTRY DECISION; M4 preplanning is NOT AUTHORIZED BY THIS CLOSEOUT, and M4 production implementation remains NOT AUTHORIZED.

M3 current decision and contract status:
P3C-0B: MERGED
Option A Alignment: MERGED via PR #29
P3C-1 Start Portion: IMPLEMENTED AND MERGED via PR #31
P3C-1 Retry contract: IMPLEMENTED CONTRACT / CURRENT
P3C-1 Retry production: IMPLEMENTED AND MERGED via PR #33
P3C-1: COMPLETE
P3D-0 Preplanning: COMPLETE
P3D Contract Closure: OWNER APPROVED / DOCUMENTED
M3-TD-31: OWNER APPROVED / IMPLEMENTED AND MERGED via PR #37
M3-TD-32: OWNER APPROVED / IMPLEMENTED AND MERGED via PR #37
M3-TD-33 through M3-TD-36: IMPLEMENTED / ACCEPTED through P6A/P6B/P6C/P6D
P6-0 independent review: PASS WITH CONTRACT RECLASSIFICATION
P6A0 initial independent remote review: CHANGES REQUIRED — HIGH-1 (HISTORICAL)
P6A0 HIGH-1 remediation: ACCEPTED / RE-REVIEW PASS
New P6 user Owner Decision: NONE
P6A/P6B/P6C/P6D: COMPLETE / ACCEPTED / CLOSED
P3D-1: IMPLEMENTED AND MERGED via PR #36
P3D-2: IMPLEMENTED AND MERGED via PR #37
P3D-3: COMPLETE AND MERGED via PR #38
P3E integrated verification evidence: COMPLETE (test/docs only, commit `400a3b29697b7185d29df2cb9da0417260549913`)
Migration 014: NOT REQUIRED BY M3 / NOT CREATED / NOT AUTHORIZED
Production Cutover: NOT PERFORMED / NOT AUTHORIZED
Repository CI: PASS — current pre-PR #43 authoritative main `e17a4bffdf12a033a0587ec2431cefe51a97bc49` (PR #44 R39 remediation merge), post-PR #44 run `31565915572`; PR #42 baseline `859d8c73657741c03a3241402a9ab4c2e2f173ce` / run `31513943821` is historical and superseded as the current-main baseline
M3: IMPLEMENTATION COMPLETE; FORMAL CLOSEOUT COMPLETE UPON PR #43 MERGE
M4 Entry: PENDING SEPARATE ENTRY DECISION; M4 preplanning is NOT AUTHORIZED BY THIS CLOSEOUT

Final P0 documentation merge gate: COMPLETE (historical; superseded by the merged P1, P2, and P3 preplanning records).

P3E entry production baseline: main at `7efecc67a8f8cb8abe64a4ceefe7f144d22ec17e` (ordinary Merge Commit of PR #38). P3E integrated verification evidence `400a3b29697b7185d29df2cb9da0417260549913` is test/docs-only and adds zero production behavior; P3 package merge state is authoritative Git history / PR record.

This register separates the approved M3 technical contract from deferred Production Cutover and Legacy Retirement decisions. A technical approval is not authorization to modify code, create DDL, migrate data, change production behavior, restore, delete, change the Web default, or start any M3 implementation phase without explicit authorization.

## 1. Decision rules

- M2 remains sealed at VERIFIED & MERGED / FULLY COMPLETE. This register does not reopen or extend M2.
- M3 is the Lifecycle, Event and API Foundation defined by Runtime Specification 14, Roadmap §§47–53.
- The technical rows below are approved as contract direction by independent technical review. Already merged stages are current evidence; unimplemented stages and portions remain unauthorized unless a later instruction explicitly authorizes them. The P0 docs-only merge gate is historical and complete.
- USER OWNER APPROVAL REQUIRED remains mandatory for deviations from the Runtime Specification, irreversible schema or data changes, external cost or infrastructure, major user-visible behavior changes, Production Restore, and unrollbackable Cutover.
- Migration 012 was implemented and merged as part of M3 P2. No further migration was required by M3; this M3 register does not authorize Migration 014 or any M4 migration. If M4 preplanning is separately authorized, it must audit schema needs separately.
- Unknown records, data mismatch, active/interrupted Runs, missing Remote Checks, and incomplete evidence fail closed.

## 2. Approved M3 technical contract

| ID | Technical decision | Approved direction | Implementation boundary |
| --- | --- | --- | --- |
| M3-TD-01 | Event, Outbox, and Stream aggregate | M3 Runtime Events, Event Store, Outbox, and Run Stream belong only to Task-domain runs. Conversation agent_events and RunStreamRegistry are not substitutes. | APPROVED BY INDEPENDENT TECHNICAL REVIEW — IMPLEMENTATION STILL NOT AUTHORIZED. |
| M3-TD-02 | runs and agent_runs | Keep runs and agent_runs separate through M3. Any aggregate unification is a later design. | Same status. User approval is required for a data-model unification or material behavior change. |
| M3-TD-03 | Run state machine | Use the Runtime Lifecycle Transition Table as the authoritative Run state machine. Terminal Runs are immutable; Retry creates a child Run. | Same status. Any deviation from the Runtime Specification requires USER OWNER APPROVAL REQUIRED. |
| M3-TD-04 | Stage lifecycle schema prerequisite | Migration 009 already provides run_stages.version. Migration 012 must preserve that column and provide the Stage lifecycle fields and status vocabulary required by M3; current status limited to pending is not sufficient. | Same status. Add no duplicate version column. Persistent Run/Stage migration cannot begin in P1; it starts in P2. |
| M3-TD-05 | State, Event, and Outbox atomicity | Every persisted Run or Stage transition writes Current State + Runtime Event + Outbox in one transaction, or none of them commit. | Same status. Irreversible DDL requires USER OWNER APPROVAL REQUIRED and separate review. |
| M3-TD-06 | Event Store organization | Event Store is organized by Task-domain Run and uses a strict per-Run increasing sequence allocated from runs.next_event_sequence. | Same status. No use of Conversation run_event_sequences for Task-domain Runs. |
| M3-TD-07 | Outbox delivery and mutability | Outbox delivery is durable, at-least-once, retryable, and deduplicated by durable message identity. Immutable fields are id, event_id or equivalent Event reference, topic, aggregate_type/aggregate_id, payload, and created_at. Controlled mutable fields are status, attempts, available_at, published_at, last_error, and optional lease/fencing/version. | Same status. Do not prohibit all UPDATE on outbox_messages. Delivery updates require a state machine, conditional UPDATE, and concurrency protection. Dead letters use an independent table or reviewed equivalent; no external broker or paid infrastructure is authorized. |
| M3-TD-08 | Central Runtime Event Registry | packages/shared owns shared Run/Stage status types, RuntimeEvent envelope, payload schema/version, ApiProblem, ApiOperation, DTOs, and SSE contract; a central registry validates registration, defaults, payloads, and unknown future events. | Same status. An unregistered Core Event cannot publish. |
| M3-TD-09 | Persistent Queue Record | Use runs(status=queued) as the M3 persistent Queue Record. Do not add scheduler_jobs unless later evidence proves the M3 invariant cannot be satisfied. | Same status. Queue implementation must not bypass State/Event/Outbox atomicity. |
| M3-TD-10 | Operation scope, association, and statuses | M3 Operation tracks only Task-domain Run commands. It stores workspaceId, aggregateType=run, aggregateId/runId, and a correlationId that is unique and immutable. Status is exactly queued, running, waiting_approval, paused, completed, failed, or cancelled. | Same status. Operation is distinct from Run and includes result, ApiProblem, timestamps, and version. Non-Run Operations are Post-M3; no production operation or cutover command is implied. |
| M3-TD-11 | Async Start | Start Run returns HTTP 202 with an Operation resource; Create Run and Start Run remain separate commands. | Same status. No Start implementation before P2 transactional core. |
| M3-TD-12 | Operation API and Event association | M3 covers GET /api/operations/:operationId, GET /api/operations/:operationId/events, and POST /api/operations/:operationId/cancel. The Events handler authorizes the Operation, uses its runId and correlationId, queries runtime_events, and returns ascending sequence. | Same status. No independent operation_events Event Store; the exact API path is recorded in OpenAPI before route implementation. |
| M3-TD-13 | Retry | Retry creates a new Child Run and never resets the old Run. Parent/root lineage and idempotency are required. | Same status. No provider retry policy or production retry automation. |
| M3-TD-14 | Legacy and Web compatibility | Preserve Legacy API and behavior and keep the Web default unchanged through M3. | Same status. Legacy retirement and Web switch are deferred Post-M3 Owner decisions. |
| M3-TD-15 | Task Event and runId conflict | runtime_events remains Run-scoped. Create Task does not fabricate a Run ID for task.created. Create Task is evidenced through Task state, Idempotency, and Audit. | Same status. Independent Task Aggregate Event design is Deferred Specification Alignment and does not block M3. Do not make run_id nullable for this purpose. |
| M3-TD-16 | API path conflict | Preserve Legacy /api/workspaces/:workspaceId/tasks and current /api/workspaces/:workspaceId/v2. Add canonical top-level Run and Operation paths. Defer canonical Task Collection replacement to Post-M3. | Same status. OpenAPI must document Legacy, current v2, and canonical paths separately; it must not claim a completed Task Collection switch. |
| M3-TD-17 | Race-free SSE handoff | Subscribe and buffer, capture durable high-watermark, replay through it, drain buffered events above it, deduplicate by runId plus sequence, then enter Live mode. | Same status. Replay-then-subscribe is not an accepted algorithm. |
| M3-TD-18 | Recovery representation | Before P6, choose either runs.recovery_required or a separate Recovery Record. P6 must not reference a schema state that does not exist. | Same status. Production Restore remains a deferred Owner decision. |
| M3-TD-19 | Migration 012 planning | Migration 012 is REQUIRED — PLANNING ONLY for runtime_events, UNIQUE(run_id, sequence), query indexes including runtime_events(run_id, correlation_id, sequence), outbox_messages, dead letters, durable operations with run_id/equivalent aggregate reference and correlation_id, run_stages expansion preserving existing version, idempotency operation values, recovery representation, sequence allocation, append-only/controlled-update constraints, and Queue decision. | Same status. No DDL in this remediation; future DDL needs independent schema review, checksum, fresh/legacy DB, rollback/forward, L3, and USER OWNER APPROVAL REQUIRED. |
| M3-TD-20 | Phase dependency | P1 is Schema and Shared Contract Foundation only. Persistent Run/Stage status migration and atomic transitions begin in P2. Run Engine and Start route integration begin only after the P2 transaction core. | Same status. No unreviewed P1 branch may start from this unmerged docs branch. |
| M3-TD-21 | Lifecycle transition Event ownership | The four unique mappings are Run `queued → starting` → `run.dequeued`, Run `starting → running` → `run.started`, Stage `ready → starting` → `stage.starting`, and Stage `starting → running` → `stage.started`. `runs.started_at` and `run_stages.started_at` are first written only when the corresponding entity enters `running`; one Event cannot represent two transitions. | Specification alignment only. Shared contract closure must precede P2C-2 transactional lifecycle work. No Production Cutover or implementation authorization changes. |
| M3-TD-22 | Run creation and queue telemetry ownership | Run `∅ → queued` has exactly one mandatory Primary Event, `run.created`. `run.queued` is optional Queue Telemetry for queueName, priority, or position and never replaces `run.created`; creation does not require both Events. | P2C-0 specification closure only. No Shared, Registry, Server, Migration, database, or implementation authorization. |
| M3-TD-23 | Approval multi-aggregate lifecycle evidence | A Stage-specific `approval.required` may evidence Run and Stage `running → waiting_approval` together. `approval.resolved` may evidence both `waiting_approval → running` transitions only for approve_once, approve_run, or approve_workspace. Rejection/cancellation uses the ordered multi-Event sequences and required runId/stageId/approvalRequestId references. | P2C-0 specification closure only. No approval implementation, API, process cancellation, or database authorization. |
| M3-TD-24 | Non-terminal Stage cancellation closure | `pending`, `ready`, `starting`, `waiting_approval`, and `running` all map to `stage.cancelled` on Run cancellation. Stage order is `stage.sequence ASC`, then `stage.id ASC`; final `run.cancelled` follows all Stage Events. Terminal Stages have no outgoing edge. | P2C-0 specification closure only. No Process termination, Approval cancellation implementation, or database logic authorization. |
| M3-TD-25 | Multiple ordered Events in one atomic lifecycle transaction | Multiple Durable Events may share one transaction only with contiguous Run sequence values, one Outbox record per Event, deterministic ordering, and all Current State/Event/Outbox/version writes committed or rolled back together. Frozen sequences include startup completion, Approval failure/cancellation, Run cancellation, and Run completion. | P2C-0 specification closure only. P2C-2 transactional implementation remains NOT AUTHORIZED. |
| M3-TD-26 | Operation correlation identity | For every newly created non-create Operation, correlationId = operation.id. The Operation ID and correlationId are generated and persisted in the same creation transaction; correlationId is unique and immutable; idempotent replay returns the original Operation, so the correlationId never changes. The historical run.create rule (correlationId = run.id) is preserved without migrating old records. | IMPLEMENTED AND MERGED as part of the P3A Operation package. The immutable correlation contract remains current. No new Operation type or correlation change is authorized. |
| M3-TD-27 | Operation cancel semantics | POST /api/operations/:operationId/cancel cancels the target non-terminal Operation and its bound Task-domain Run atomically in one caller-owned transaction. Cancellable statuses are exactly queued, running, waiting_approval, and paused; terminal conflicts fail closed. | TECHNICAL DIRECTION APPROVED / IMPLEMENTED AND MERGED via PR #37 (P3D-2); race closure evidence via PR #38 (P3D-3). |
| M3-TD-28 | Operation progress in M3 | P3 does not persist or populate ApiOperation.progress. GET /api/operations/:operationId omits progress; no derived, estimated, or fake value is returned. Progress is a Post-M3 contract and data-source decision. | Core absence of persisted/populated progress is implemented. The P3D GET Operation route is IMPLEMENTED AND MERGED via PR #36 (P3D-1) and omits progress. No progress field or projection is authorized. |
| M3-TD-29 | Start Operation completion package | The run.start Operation is a Start command tracker, not a Run lifetime projection. Its `running -> completed` transition must commit in the same caller-owned transaction as the first startup Stage `starting -> running`, `stage.started`, the Run `starting -> running`, `run.started`, and both Outbox rows; `completedAt` uses the transaction timestamp and no independent Operation Event is written. Pre-start closure is split into C1a (claim commit not achieved: full Class B rollback, no automatic failure terminal) and C1b (after claim, before `run.started`: atomic Stage/Run/Operation failure closure). | IMPLEMENTED AND MERGED through P3B-2A/P3B-2B and the merged Start path. The Start Operation completion contract remains current. No additional Start completion behavior is authorized. |
| M3-TD-30 | Retry child run activation package | Option A: Retry is accepted only for a Parent Run in `failed` at the expected version; it creates one queued Child Run and never authorizes Engine execution. The Child requires a separate `run.start`; `run.retry -> HTTP 201` with the dedicated schemaVersion 1 Child Run + completed v3 Retry Operation replay envelope. The Parent is never reset or modified. | Option A alignment MERGED via PR #29. P3C-0B idempotency closure MERGED. P3C-1 Start Portion MERGED via PR #31. P3C-1 Retry contract IMPLEMENTED / CURRENT. Retry production implementation IMPLEMENTED AND MERGED via PR #33. |
| M3-TD-31 | P3D Operation Cancel HTTP Request and Replay Contract | `POST /api/operations/:operationId/cancel` accepts only URL `operationId`, an empty query, and the exact body `{ "expectedVersion": <positive safe integer> }`. The router is locator-first and mounts before global `express.json()`. Already-cancelled is HTTP 200 with zero side effects even when the supplied version is stale; other stale requests are `409 VERSION_CONFLICT`; matching-version completed/failed are `409 OPERATION_NOT_CANCELLABLE`. Server metadata is `operation_api` / empty process IDs / Worktree preserved / no reason. | APPROVED TECHNICAL DIRECTION. OWNER APPROVED / IMPLEMENTED AND MERGED via PR #37 (P3D-2); race closure evidence via PR #38 (P3D-3). |
| M3-TD-32 | P3D Guarded Operation Cancel and Approval-aware Run Cancellation | Option C is approved: a dedicated Operation guarded-cancel seam plus an approval-aware Lifecycle cancellation seam. The ordinary Operation transition table is unchanged. Waiting-approval cancellation discovers exactly one unresolved Approval and preserves `approval.resolved -> stage.cancelled* -> run.cancelled` in the same outer transaction. | APPROVED TECHNICAL DIRECTION. OWNER APPROVED / IMPLEMENTED AND MERGED via PR #37 (P3D-2). |
| M3-TD-33 | P6 Task-domain Outbox delivery sink | `OutboxPublisher -> RuntimeEventDeliverySink -> RuntimeEventNotifier` is the P6 durable live-distribution wake-up path. The sink accepts only exact persisted Outbox/Event identity and emits `{ runId, sequence, eventId }`; it is not an Event Store, Conversation EventBus, HTTP/SSE client, or external broker. `published` means synchronous sink acceptance, not browser consumption or Run completion. | IMPLEMENTED / ACCEPTED through P6A and P6D. NO NEW USER OWNER DECISION. |
| M3-TD-34 | P6 Task-domain restart and uncertainty contract | `runs.recovery_required` is the only M3 recovery representation. Recovery classifies Run, Run Stage, `run.start` Operation, Approval where applicable, and Runtime Event evidence together. Terminal Runs remain immutable; queued authorization may be restored; post-claim/pre-start uses the existing M3-TD-29 C1b failure closure; uncertain active execution stays `running` with `recovery_required = 1`; coherent approvals/paused state remain waiting/paused; impossible combinations fail closed. | IMPLEMENTED / ACCEPTED through P6B and P6D. No Recovery Record or Migration 014. Never guess success or blindly restart provider execution. |
| M3-TD-35 | P6 Outbox crash, retry, and dead-letter policy | An expired `publishing` lease is conditionally reclaimed to `retry` while preserving immutable identity/payload and attempts. `attempts` is total delivery claims, not completed failures. Canonical `OutboxFailureStateV1` in existing mutable `last_error` durably records completed classified failures, immutable first failure time, and latest classified/lease-expired outcome. Completed failures alone drive the five-failure budget and deterministic backoff. Outbox dead-letter transition and DeadLetter insert share one outer transaction with exact stable evidence mapping. | P6A0 HIGH-1 forward remediation ACCEPTED; IMPLEMENTED / ACCEPTED through P6A and P6D. NO NEW USER OWNER DECISION, SCHEMA CHANGE, OR MIGRATION 014. |
| M3-TD-36 | Legacy canonical mapping execution ownership | One Legacy request creates one canonical Run, one `run.start` Operation, and one execution authority. `LegacyCanonicalExecutionService` is the sole AgentRunner owner for `legacy_pipeline`; `tasks.ts` owns validation, command initiation, persisted-event projection subscription, and transport cleanup only. Thinking is persisted as `stream.text_delta` before pure Legacy projection. Disconnect unsubscribes without aborting execution or cancelling Run/Operation. | IMPLEMENTED / ACCEPTED through P6C and P6D. No second executor, M4 ProcessManager/ProviderAdapter, Web switch, Legacy retirement, or route-owned lifecycle state machine. |

> **SUPERSEDED / HISTORICAL — NOT CURRENT STATUS.** Implementation-boundary
> text that describes an earlier authorization gate is historical when the
> corresponding stage has subsequently merged. The current status of
> M3-TD-26 through M3-TD-36 is recorded individually in their table rows and
> in section 5. Historical wording must not override those current statuses.

M3-TD-26 through M3-TD-32 are approved technical direction with the
individual current implementation statuses recorded above and in section 5.
M3-TD-26 through M3-TD-30 resolve the five P3 Owner Decision candidates
(formerly OD-P3-01 through OD-P3-05). M3-TD-31 and M3-TD-32 close the missing
P3D HTTP and approval-aware cancellation details; they do not authorize code.
M3-TD-33 through M3-TD-36 are the P6A0 bounded technical closure, required no
new user Owner Decision, and are implemented and accepted through
P6A/P6B/P6C/P6D.

M3-TD-01 through M3-TD-25 retain their historical contract wording. Any P1/P2
implementation boundary recorded in those rows is a historical phase
boundary; the current governance status is recorded in section 5 below.

### M3-TD-21 Lifecycle transition Event ownership

- **Owner and record time:** M3 technical owner; 2026-08-02.
- **Selected contract:** the four unique transition/Event mappings in the
  table above are canonical and exhaustive for the Run/Stage startup edges
  covered by this alignment.
- **Affected scope:** Runtime Lifecycle §9, Stage Startup §14, the Run and
  Stage transition tables, and the four Event definitions in Event Model §§16
  and 18.
- **Evidence threshold:** the Lifecycle and Event Model documents must agree
  on payload, metadata, ownership, timestamp format, and transaction timing;
  the successful lifecycle sequence must place `run.started` after the first
  eligible Stage enters `running`.
- **Stop/no-go:** any remaining mapping of `run.started` to
  `queued → starting`, `stage.started` to `ready → starting`, a duplicate
  Event owner, or an early `started_at` write blocks P2C-2 review. Code,
  Registry, Migration, database, Server, Web, and Production Cutover changes
  are outside this decision.
- **Rollback boundary:** revert the single specification-alignment commit;
  no runtime state, schema, or production data is changed by this decision.
- **Review and re-review:** independent specification review is required
  before Shared Event Contract Closure. Re-review is required if any payload,
  Registry metadata, state-transition owner, or Production boundary changes.

### M3-TD-22 Run creation and queue telemetry ownership

- **Owner and record time:** M3 technical owner; 2026-08-02.
- **Selected contract:** `run.created` is the only mandatory Primary Event for
  `∅ → queued`; `run.queued` is optional telemetry only.
- **Evidence threshold:** Lifecycle §6.4, Event Model Run Events, and the
  P2C-0 matrix must contain no second Primary Event for Run creation.
- **Stop/no-go:** any creation path that requires `run.queued`, omits
  `run.created`, or treats telemetry as state establishment blocks review.
- **Rollback/review:** revert the docs-only commit; independent P2C-0 review
  is required before Shared contract work.

### M3-TD-23 Approval multi-aggregate lifecycle evidence

- **Owner and record time:** M3 technical owner; 2026-08-02.
- **Selected contract:** one Stage-specific `approval.required` may evidence
  paired Run/Stage entry into `waiting_approval`; one `approval.resolved` may
  evidence paired recovery to `running` for the three approved decisions.
- **Evidence threshold:** stage-specific Events retain `runId`, `stageId`, and
  `approvalRequestId`; rejection and cancellation sequences are ordered and
  have separate Outbox records.
- **Stop/no-go:** any `run.waiting`, `stage.waiting`, extra resume Event, or
  missing reference blocks review.
- **Rollback/review:** docs-only revert; no approval implementation is
  authorized; independent specification review is required.

### M3-TD-24 Non-terminal Stage cancellation closure

- **Owner and record time:** M3 technical owner; 2026-08-02.
- **Selected contract:** every non-terminal Stage status can transition to
  `cancelled` on Run cancellation; terminal Stage statuses cannot transition.
- **Evidence threshold:** the Lifecycle table and matrix cover all five
  non-terminal cancellation edges and deterministic Stage ordering.
- **Stop/no-go:** a cancelled Run with a remaining non-terminal Stage, an
  unordered Stage Event, or an implicit Process/Approval/database action
  blocks review.
- **Rollback/review:** docs-only revert; independent specification review is
  required before implementation authorization.

### M3-TD-25 Multiple ordered Events in one atomic lifecycle transaction

- **Owner and record time:** M3 technical owner; 2026-08-02.
- **Selected contract:** the matrix order is authoritative for startup,
  Approval failure/cancellation, Run cancellation, and Run completion.
- **Evidence threshold:** every Durable Event has a contiguous Run sequence
  value and independent Outbox record; all State/Event/Outbox/version writes
  share one commit boundary.
- **Stop/no-go:** partial commit, shared Outbox record, sequence gap, or
  reordered Event blocks P2C-2 review.
- **Rollback/review:** docs-only revert; P2C-2 transactional implementation
  remains NOT AUTHORIZED and independent review is required.

### M3-TD-26 Operation correlation identity

- **Current implementation status:** IMPLEMENTED AND MERGED as part of the P3A
  Operation package. The immutable correlation contract remains current. No
  new Operation type or correlation change is authorized.
- **Owner and record time:** M3 technical owner; 2026-08-04.
- **Selected contract:** For every newly created non-create Operation,
  correlationId = operation.id. This applies to `run.start`, `run.cancel`,
  and `run.retry` Operations. The Operation ID and correlationId are
  generated and persisted in the same creation transaction. correlationId
  is unique and immutable. Idempotent replay returns the original
  Operation, so the correlationId never changes. Request IDs, Idempotency
  Keys, Run IDs, random secondary values, and mutable business fields are
  not used. The existing `run.create` path keeps correlationId = run.id for
  historical compatibility; old records are not migrated. A new
  implementation must never generate a second correlationId for the same
  Operation.
- **Rationale:** one durable identity per command makes Event association
  exact (Events carry the Operation's correlationId), keeps replay stable,
  and removes generation ambiguity at the Engine claim boundary.
- **Affected stages:** P3A (persistence), P3B-1 (claim event), P3C-0A and
  P3C-0B (replay), P3C-1 (acceptance), P3D (event query).
- **Evidence threshold:** uniqueness enforced by
  `operations.correlation_id UNIQUE`; replay stability; the immutable
  trigger rejects any correlationId change; the Runtime Event
  correlationId equals the owning Operation's correlationId; a duplicate
  command never creates a second Operation or correlationId.
- **Stop/no-go:** any second correlationId for one Operation; any mutable
  or derived correlationId; any migration rewriting historical `run.create`
  records.
- **Rollback boundary:** docs-only decision record; an implementation
  revert removes the generation wiring without touching stored rows.
- **Re-review trigger:** any proposal to change the identity rule, to
  unify it with the `run.create` run.id rule, or to migrate historical
  records.

### M3-TD-27 Operation cancel semantics

- **Current implementation status:** TECHNICAL DIRECTION APPROVED /
  IMPLEMENTED AND MERGED via PR #37 (P3D-2); race closure evidence via
  PR #38 (P3D-3).
- **Owner and record time:** M3 technical owner; 2026-08-04.
- **Selected contract:** POST /api/operations/:operationId/cancel cancels
  the target non-terminal Operation and its bound Task-domain Run
  atomically. No second Operation is created, and Cancel is not an
  Operation-row-only update. The target Operation must belong to a
  Task-domain Run. Cancellable Operation statuses are exactly `queued`,
  `running`, `waiting_approval`, and `paused`. Cancellation executes in one
  caller-owned transaction: re-read and validate the Operation; re-read and
  validate the bound Run; conditionally transition the Operation to
  `cancelled` by expected status/version; cancel the Run and all
  non-terminal Stages through the P2 transaction core; write the Runtime
  Events and Outbox rows; commit all or roll back all.
  M3-TD-31 freezes the HTTP request, locator/parser, response-precedence,
  trusted-metadata, idempotency, and safe-error details. M3-TD-32 freezes
  Option C, including the dedicated Operation guard and approval-aware
  waiting-state Lifecycle seam. Those decisions close missing P3D details
  without reopening this four-status rule. For cancellation before or during
  startup, the result is Operation `cancelled`, bound Run
  `cancelled`, every affected non-terminal Stage `cancelled`, one
  `stage.cancelled` per affected Stage, and `run.cancelled`; cancellation
  does not produce Operation/Run/Stage `failed` or `stage.failed`.
  `cancelRunWithinTransaction` must not be bypassed and Stage cancellation
  logic must not be copied. Terminal behavior: a target already `cancelled`
  returns the current cancelled Operation with zero new side effects; a
  `completed` or `failed` target returns 409-class
  `OPERATION_NOT_CANCELLABLE`; a non-terminal Operation whose bound Run is
  in an incompatible terminal state fails closed, rolls back, is sanitized
  under the M3-TD-31 safe-error boundary, and receives no silent repair.
  The exact body `expectedVersion` prevents
  cancel-vs-complete overwrite. No `operation.cancel` idempotency
  operation is added; the existing `run.cancel` idempotency envelope is
  unchanged; natural idempotency comes from the target's terminal state
  and version conditions. A completed Start Operation is not cancellable
  through this endpoint; the retained current-v2 Run cancel path continues
  to serve post-start Run cancellation; this decision does not authorize
  Legacy/Web path switching.
- **Rationale:** cancel is a command against the Run aggregate, so the
  Operation and its bound Run must resolve in one transaction; anything
  weaker either strands the Run or falsifies the command record.
- **Affected stages:** P3D (route, caller-owned composition, and all
  Operation cancel races). P3C-1 does not own Operation Cancel.
- **Evidence threshold:** atomic cancel transaction tests; the terminal
  behavior matrix (already-cancelled, completed, failed, incompatible Run
  state); cancel-vs-complete race proof; no partial Event/Outbox writes.
- **Stop/no-go:** a second Operation created by cancel; an
  Operation-row-only cancel; bypassing the transaction core; silently
  repairing an inconsistent Run state.
- **Rollback boundary:** docs-only decision record; an implementation
  revert removes the route and wiring; stored rows are preserved.
- **Re-review trigger:** any new cancellable status, any non-Run
  aggregate, or a proposal for a separate cancel Operation type.

### M3-TD-28 Operation progress in M3

- **Current implementation status:** Core absence of persisted/populated
  progress is implemented. The P3D GET Operation route is IMPLEMENTED AND
  MERGED via PR #36 (P3D-1) and omits progress. No progress field or
  projection is authorized.
- **Owner and record time:** M3 technical owner; 2026-08-04.
- **Selected contract:** P3 does not persist or populate
  ApiOperation.progress. The Repository/Service creates no progress
  storage; progress is not derived from Stage counts, Event counts, or Run
  state; GET /api/operations/:operationId omits progress in P3; no fake 0,
  100, or estimated percent is returned. When the Runtime Inspector needs
  progress it reads Run/Stage/Event projections. Progress design is
  deferred to Post-M3 and requires an independent contract and data-source
  decision. For progress, P3 must not create: Migration 014; a new table
  or column; `operation_events`; a background aggregator; or an implicit
  JSON field convention.
- **Rationale:** a persisted progress field without a defined data source
  would be either wrong or a second event model; both are worse than an
  honest omission.
- **Affected stages:** P3D (GET contract), P3E (integrated evidence).
- **Evidence threshold:** GET Operation contract tests show no progress
  field; no storage, derivation, or background aggregation exists.
- **Stop/no-go:** any persisted or derived progress value; any of the
  prohibited constructions above.
- **Rollback boundary:** docs-only decision record; nothing is built, so
  nothing needs reverting.
- **Re-review trigger:** a Post-M3 progress contract proposal with a
  defined data source.

### M3-TD-29 Start Operation completion package

- **Current implementation status:** IMPLEMENTED AND MERGED through
  P3B-2A/P3B-2B and the merged Start path. The Start Operation completion
  contract remains current. No additional Start completion behavior is
  authorized.
- **Owner and record time:** M3 technical owner; 2026-08-04.
- **Selected contract:** the `run.start` Operation is a Start command
  tracker, not a Run lifetime projection. The caller-owned atomic
  startup-completion seam applies to a claimed `run.start` Operation;
  M3-TD-29 freezes the Start mapping, while M3-TD-30 keeps the completed
  Retry Operation outside Engine authorization and startup completion. The
  Start Operation is `queued` after acceptance, `running` after Engine claim,
  and `completed` only in the transaction that commits startup completion.
  The frozen twelve-step sequence is:
   1. Re-read and validate the claimed Operation: type `run.start`, status
      `running`, expected version, and valid bindings.
  2. Re-read and validate the Run at status `starting` and its expected
     version.
  3. Re-read and validate the first startup Stage at status `starting` and
     its expected version.
  4. Transition the Stage `starting -> running`.
  5. Append `stage.started`.
  6. Insert the Stage Outbox row.
  7. Transition the Run `starting -> running`.
  8. Append `run.started`.
  9. Insert the Run Outbox row.
  10. Transition the Operation `running -> completed`.
  11. Write `resourceType = "run"`, `resourceId = runId`, omit `data`, and
      set `completedAt` from the same transaction timestamp.
  12. Commit all writes together; any failure rolls back all twelve-step
      state, Event, Outbox, and Operation writes. Operation completion does
      not create an independent Runtime Event or `operation_events` row.
  A transaction-attempt failure (injection error, SQLite error, version
  conflict, or concurrent loss) rolls back the entire transaction to its
  starting state; it does not automatically mark the Operation `failed` and
  is not a business terminal outcome. The caller classifies the stable
  error as retryable, a competition loss, or an unrecoverable business
  failure.
  C1a — failure before claim commit: Class B rolls back completely; the Run
  remains `queued`, the Operation remains `queued`, and no `run.dequeued`,
  Runtime Event, or Outbox partial write remains. A version conflict or
  competition loss never marks the Operation failed. Only when the caller
  classifies an irrecoverable command failure may a separate transaction
  mark the still-queued Operation `failed`; that record must persist the
  serialized ApiProblem, leave `result` absent, set `completedAt` from the
  same transaction timestamp, guard the expected status and version, leave
  the Run unchanged, and create no Runtime Event or Outbox row.
  C1b Stage-starting closure depends on the independently accepted P3B-2A
  `startup-failure` contract. Until P3B-2A is accepted, P3B-2B must not
  implement this Stage/Run Event combination. This is a specific supplement
  to the historical M3-TD-25 ordering contract; M3-TD-01 through M3-TD-25
  are not rewritten.
  When the Operation is
  `running`, the Run is `starting`, and the first startup Stage is
  `starting`, the caller-owned failure closure is:
   1. Re-read and validate the Operation: type `run.start`, status `running`,
      expected version, and valid bindings.
  2. Re-read and validate the Run at `starting` and its expected version.
  3. Re-read and validate the startup Stage at `starting` and its expected
     version.
  4. Transition the Stage `starting -> failed`.
  5. Append `stage.failed`.
  6. Insert the Stage Outbox row.
  7. Transition the Run `starting -> failed`.
  8. Append `run.failed`.
  9. Insert the Run Outbox row.
  10. Transition the Operation `running -> failed`.
  11. Write the serialized ApiProblem, use the same transaction timestamp
      for `completedAt`, and leave `result` absent.
  12. Commit all writes together; any failure rolls back all Stage, Run,
      Event, Outbox, and Operation writes. Operation failure creates no
      independent Runtime Event or `operation_events` row.
  The Stage-starting branch uses the P3B-2A multi-event ordering name
  `startup-failure` with exactly `stage.failed -> run.failed`,
  `stageMultiplicity=single`, `stageOrdering=none`,
  `contiguousRunSequence=true`, `independentOutboxPerEvent=true`, and
  `atomicCurrentStateEventOutbox=true`. If no Stage has entered `starting`,
  the existing single-event contract remains: Run `starting -> failed`,
  Primary Event `run.failed`, Additional Event none; `stage.failed` is not
  fabricated.
  If the failure occurs before the first Stage enters `starting`, the same
  caller-owned transaction discipline transitions the Run
  `starting -> failed`, appends `run.failed`, inserts the Run Outbox row,
  and transitions the Operation `running -> failed` together; it does not
  fabricate `stage.failed`, leaves not-yet-started Stages in their valid
  lifecycle states, and emits no Stage Event without a legal transition
  owner. C1b never commits `run.failed` before Operation failure, updates
  only the Operation, or updates only the Run. Start uses this failure
  closure; a completed Retry Operation is not rewritten, and ApiProblem
  `runId`/`operationId` bindings must agree.
  C2 post-start Stage/Run failure, cancellation, or completion never
  rewrites a completed Operation. Idempotency replay always returns the
  immutable queued Operation snapshot saved at HTTP 202 acceptance; it
  never re-reads the current Operation or varies with current state. GET
  Operation returns current state while replay returns the original
  response. The "Start Operation tracks the Run to its terminal state"
  option is REJECTED and no dual-option implementation gate remains.
- **Rationale:** the acceptance-time 202 already returned the queued
  command record; tracking the whole Run would duplicate the Run
  projection, break replay immutability, and couple command lifecycle to
  execution length.
- **Affected stages:** P3B-1 (claim boundary), P3B-2A (contract alignment),
  P3B-2B (execution), P3C-0A (replay), P3C-1 (acceptance), and P3E
  (integrated evidence).
- **Evidence threshold:** the exact twelve-step success and C1b failure
  caller-owned transactions with Stage/Run/Operation expected-version
  guards, both Runtime Events and both Outbox rows; C1a full-rollback proof;
  failure rollback at every position; no automatic failed marking on
  transaction-attempt failure; Start composition and Retry immutability tests;
  pre-start startup-failure mapping; cancellation remains owned by M3-TD-27
  in P3D; post-start non-rewrite proofs;
  result shape; acceptance-time replay stability; no committed
  `Run=running` + `Operation=running`, `Run=failed` + `Operation=running`,
  or `Run=starting` + `Operation=failed` intermediate state.
- **Stop/no-go:** any split commit between `run.started` and Operation
  completion or between `run.failed` and Operation failure; any post-start
  rewrite of a completed Start Operation or completed Retry Operation;
  automatic failed marking
  from transaction rollback; a mutable Run snapshot in the result; an
  independent Operation Event; or replay that varies with current state.
- **Rollback boundary:** docs-only decision record; an implementation
  revert removes the mapping wiring; stored rows are preserved.
- **Re-review trigger:** any proposal to track Run lifetime in the Start
  Operation or to change the replay snapshot semantics.

### M3-TD-30 Retry child run activation package

- **Current implementation status:** Option A alignment MERGED via PR #29.
  P3C-0B idempotency closure MERGED. P3C-1 Start Portion MERGED via PR #31.
  P3C-1 Retry technical contract is IMPLEMENTED CONTRACT / CURRENT.
  Retry production implementation is IMPLEMENTED AND MERGED via PR #33.
  P3C-1 is COMPLETE.
- **Owner and record time:** M3 technical owner; 2026-08-04.
- **Selected contract:** Option A is approved. Retry is accepted only when
  the Parent Run status is `failed` at the expected Parent version. Parent
  `queued`, `starting`, `running`, `waiting_approval`, `paused`,
  `completed`, and `cancelled` return stable 409 `RUN_NOT_RETRYABLE`; the
  Parent is never modified. A matching failed Parent creates one queued
  Child; a stale version or non-failed Parent creates no side effects.
  Retry does not authorize Engine execution and does not claim, dispatch,
  or complete the Child. A separate queued `run.start` Operation is the
  only Engine authorization.
  The acceptance response is HTTP 201. The Retry Operation is completed at
  version 3 in the acceptance transaction, and the dedicated schemaVersion
  1 replay envelope contains the original queued Child Run snapshot and the
  original completed Retry Operation snapshot. Same-key replay returns that
  immutable response; later Child or Operation state changes do not alter it.
  The Parent remains unchanged and no automatic provider retry policy is
  introduced.
- **Rationale:** the Retry command creates durable Child metadata while a
  separate Start command explicitly grants execution authorization. This
  keeps creation and execution boundaries distinct and prevents a completed
  Retry Operation from becoming an Engine claim marker.
- **Affected stages:** P3B-1 (selector), P3B-2B (Start-driven Child
  startup), P3C-0B (replay closure), and the implemented P3C-1 Retry
  acceptance.
- **Evidence threshold:** failed-Parent and expected-version guards;
  non-failed Parent 409 matrix; concurrent Retry race; A2 failure injection
  at every Child/Snapshot/Stage/Event/Outbox/Operation/Idempotency write;
  Retry-only Engine no-op with zero writes; completed Retry Operation
  immutability; independent Start claim and Start correlation; replay
  stability; Parent immutability; operation-event query exclusion.
- **Stop/no-go:** retry accepted for a non-failed or stale Parent; any
  Parent mutation; a combined or Operation-only replay envelope; Retry
  returning 202; Retry authorizing or dispatching the Child; execution
  Events using the Retry Operation ID; or a second implicit Start path.
- **Rollback boundary:** docs-only decision record; an implementation
  revert removes the retry path as one package; stored rows are preserved.
- **Re-review trigger:** any proposal removing the separate Start command,
  changing HTTP 201, changing the dual-snapshot replay shape, or adding a
  provider retry policy.

### M3-TD-31 P3D Operation Cancel HTTP Request and Replay Contract

- **Current implementation status:** APPROVED TECHNICAL DIRECTION. OWNER
  APPROVED / IMPLEMENTED AND MERGED via PR #37 (P3D-2); race closure
  evidence via PR #38 (P3D-3).
- **Owner and record time:** M3 technical owner; 2026-08-07.
- **Selected endpoint:** `POST /api/operations/:operationId/cancel`. The URL
  accepts only `operationId`. The query must be empty. The exact JSON body is
  `{ "expectedVersion": <positive safe integer> }`, where
  `expectedVersion` is required and identifies the Operation version. Empty
  objects, extra fields, zero, negative, non-integer, and unsafe-integer values
  return `400 VALIDATION_FAILED`. ETag and `If-Match` are not M3 P3D version
  transports; adding them is a Post-M3 API decision.
- **Forbidden client metadata:** HTTP input must not accept `workspaceId`,
  `runId`, `correlationId`, `requestedBy`, `terminatedProcessIds`,
  `worktreePreserved`, or `reason`. The server supplies
  `requestedBy = "operation_api"`, `terminatedProcessIds = []`,
  `worktreePreserved = true`, and no reason. Empty process IDs mean P3D does
  not claim M4 Process termination. Worktree preservation means no Worktree
  delete, reset, clean, or mutation. Existing v2 values and behavior remain
  unchanged.
- **Locator/parser order:** the Operation router mounts before global
  `express.json()`. The fixed order is opaque Operation locator, workspace
  resolution/authorization, route-scoped JSON parser for Cancel, exact
  query/body validation, then `OperationService`. GET Operation routes use no
  JSON parser. Unknown Operation returns `404 OPERATION_NOT_FOUND` before
  malformed JSON, invalid query, invalid version, or extra fields.
- **Caller-owned transaction precedence:** after locator completion, exactly
  one `BEGIN IMMEDIATE` transaction re-reads the workspace-scoped Operation,
  validates aggregate/Run/correlation binding, and then:
  1. `cancelled` returns HTTP 200 with the current `ApiOperation` and zero
     lifecycle/Event/Outbox side effects, even when `expectedVersion` is stale;
  2. every other status compares `expectedVersion`;
  3. a stale non-cancelled Operation returns `409 VERSION_CONFLICT`;
  4. matching-version `completed` or `failed` returns
     `409 OPERATION_NOT_CANCELLABLE`;
  5. `queued`, `running`, `waiting_approval`, or `paused` enters the dedicated
     guarded update and approval-aware bound-Run cancellation.
- **Idempotency/replay:** Cancel creates no second Operation, no
  `operation.cancel` Operation, and no Idempotency Record. It does not require
  or consume `Idempotency-Key` and must not imply that the header participates
  in replay. Existing `run.cancel` vocabulary and v2 idempotency remain
  unchanged.
- **Stable public errors:** only `VALIDATION_FAILED`,
  `OPERATION_NOT_FOUND`, `VERSION_CONFLICT`,
  `OPERATION_NOT_CANCELLABLE`, and `INTERNAL_ERROR` are frozen for this
  endpoint. Internal Approval inconsistency fails closed, rolls back, and is
  sanitized to `INTERNAL_ERROR` without SQL, SQLite, filesystem paths, Event
  payload internals, or stacks.
- **Affected stages:** P3D-1 provides the locator/router dependency but does
  not implement Cancel. P3D-2 implements the contract (subsequently
  authorized and merged via PR #37). P3D-3 proves race/failure closure
  without adding behavior (merged via PR #38).
- **Evidence threshold:** exact body/query matrices; locator-before-parser
  precedence; already-cancelled stale-version no-op; stale non-cancelled and
  terminal conflict matrices; no Idempotency Record or second Operation;
  trusted metadata and sanitization proofs.
- **Stop/no-go:** accepting any client lifecycle metadata, query fields,
  optional/missing version, ETag transport, parser-before-locator ordering,
  second Operation, or Idempotency side effect.
- **Rollback boundary:** docs-only contract closure. A future implementation
  revert removes only the P3D route/service wiring and preserves stored rows.
- **Re-review trigger:** any new client field/header, new public error code,
  new Operation type, new Idempotency behavior, or change to response
  precedence.

### M3-TD-32 P3D Guarded Operation Cancel and Approval-aware Run Cancellation

- **Current implementation status:** APPROVED TECHNICAL DIRECTION. OWNER
  APPROVED / IMPLEMENTED AND MERGED via PR #37 (P3D-2).
- **Owner and record time:** M3 technical owner; 2026-08-07.
- **Option classification:**
  - **Option A — REJECTED.** Expanding
    `OperationService.ALLOWED_TRANSITIONS` so waiting/paused can use ordinary
    transition-to-cancelled would expand every normal transition caller,
    weaken the Cancel-specific guard, and risk adjacent/Engine behavior.
  - **Option B — REJECTED AS INCOMPLETE.** A dedicated Operation guard followed
    by ordinary `cancelRunWithinTransaction()` cannot handle
    `waiting_approval`; widening that ordinary seam would bypass the frozen
    Approval Event sequence.
  - **Option C — APPROVED / IMPLEMENTED AND MERGED via PR #37.** Use a dedicated Operation
    guarded-cancel seam plus an approval-aware Lifecycle cancellation seam.
- **Operation guard:** ordinary `OperationService.ALLOWED_TRANSITIONS` remains
  unchanged. A future dedicated seam, named `cancelWithinTransaction` or an
  equivalent implementation name, is callable only from canonical
  `POST /api/operations/:operationId/cancel`. Its cancellable statuses are
  exactly `queued`, `running`, `waiting_approval`, and `paused`.
  `cancelled` is the M3-TD-31 idempotent no-op read; `completed` and `failed`
  are matching-version `OPERATION_NOT_CANCELLABLE` conflicts.
- **Outer transaction ownership:** `OperationService` owns exactly one outer
  `BEGIN IMMEDIATE` transaction. It re-reads and guards Operation, performs the
  conditional Operation update, then invokes Lifecycle cancellation on the
  same database handle. Stage updates, Runtime Events, Outbox rows, Run
  cancellation, versions, and Run sequences commit together or all roll back.
  A separate Operation transaction, nested lifecycle transaction, or second
  database connection is forbidden.
- **Run version:** HTTP carries only Operation `expectedVersion`. The outer
  transaction freshly reads the bound Run and passes that persisted
  `Run.version` as `expectedRunVersion` to the lifecycle seam. HTTP must not
  add `expectedRunVersion`.
- **Approval-aware waiting state:** for a bound Run at `waiting_approval`, the
  future Lifecycle seam discovers persisted `approval.required` and
  `approval.resolved` history and requires exactly one unresolved Approval.
  The original `runId`, optional `stageId`, and `approvalRequestId` binding
  must match. Zero, multiple, or inconsistent unresolved approvals fail
  closed, roll back the outer transaction, and sanitize to
  `500 INTERNAL_ERROR`; no new public inconsistency code is authorized.
- **Waiting-approval Event order:** the same outer transaction writes
  `approval.resolved` with `decision = "cancel_run"` and
  `decidedBy = "operation_api"`, then `stage.cancelled` for every affected
  Stage in `stage.sequence ASC, stage.id ASC` order, then `run.cancelled`.
  Event sequences are contiguous; every Event has exactly one Outbox row.
  The Run payload uses `requestedBy = "operation_api"`,
  `terminatedProcessIds = []`, `worktreePreserved = true`, and no reason.
  `run.cancellation_requested` is not required.
- **Non-approval Run states:** for `queued`, `starting`, `running`, and
  `paused`, the approval-aware seam may reuse the existing caller-owned
  `cancelRunWithinTransaction()` core without changing current v2 behavior.
- **Future narrow file scope:** `LifecycleTransactionService.ts` is FORBIDDEN
  in P3D-1 and OWNER-APPROVED NARROW REQUIRED SCOPE in P3D-2 only for the
  approval-aware Operation cancellation seam. The required lifecycle test is
  `m3-p2c2b-composite-lifecycle.test.ts` because it owns Approval resolution,
  cancellation ordering, rollback, and concurrency evidence.
  `m3-p2c2a-lifecycle-transaction.test.ts` is REGRESSION ONLY because no
  single-transition behavior changes.
- **Composition root:** `SqliteStore.ts` is allowed in P3D-2 only to share the
  existing database handle and transaction ownership between OperationService
  and LifecycleTransactionService. A new OperationControlService, second
  database, singleton, or background worker is forbidden.
- **Affected stages:** P3D-2 implements the guarded Operation and
  approval-aware lifecycle package (subsequently authorized and merged via
  PR #37). P3D-3
  proves claim/completion/startup-failure/duplicate/terminal races and failure
  rollback without adding product behavior.
- **Evidence threshold:** four-status Operation matrix; exactly-one unresolved
  Approval discovery; binding failure; frozen Event order and payloads;
  contiguous sequences/one Outbox per Event; full rollback at every position;
  two-connection races; existing v2 behavior unchanged.
- **Stop/no-go:** expanding the ordinary Operation transition table; direct
  waiting-approval use of ordinary Run cancel; missing/ambiguous Approval
  repair; split transactions; second connection; new public inconsistency
  code; Process/Worktree claims; or adjacent lifecycle refactoring.
- **Rollback boundary:** docs-only contract closure. A future implementation
  revert removes the narrow P3D seam/composition while preserving existing v2
  and stored lifecycle history.
- **Re-review trigger:** any additional status, changed Approval order,
  ProcessManager entry, Worktree mutation, lifecycle-wide refactor, or public
  error expansion.

### M3-TD-33 P6 Task-domain Outbox delivery sink

- **Classification and record time:** BOUNDED TECHNICAL CONTRACT CLOSURE after
  P6-0 independent review; 2026-08-10. The review reclassifies the earlier
  `NEW OWNER DECISION REQUIRED` finding as `NO NEW USER OWNER DECISION` because
  M3-TD-01, M3-TD-07, the P6 authorized scope, and Event Model §§48–50 already
  approve Task-domain Event/Outbox/Stream ownership and durable at-least-once
  delivery. P6 production implementation remains NOT AUTHORIZED until this
  P6A0 docs package passes independent remote review.
- **Selected sink boundary:** the only P6 `runtime-events` delivery chain is
  `OutboxPublisher -> RuntimeEventDeliverySink -> RuntimeEventNotifier`.
  `RuntimeEventDeliverySink` is a new adapter boundary. It is not a new Event
  Store, Conversation EventBus, HTTP/SSE client, external broker, or second
  source of Runtime Events.
- **Trusted input:** the publisher supplies the exact durable Outbox message
  identity together with the persisted Runtime Event identity. The sink must
  resolve or validate against persisted Outbox/Event evidence and must not
  trust an arbitrary caller-provided event payload. Its live-distribution hint
  is exactly `{ runId, sequence, eventId }`.
- **P5/P6 separation:** P5 direct post-commit `RuntimeEventNotifier`
  publication remains the low-latency path. P6 publisher-to-sink notification
  is the durable at-least-once wake-up path. Both may emit the same hint.
  `RunStreamService` continues to deduplicate by `runId + sequence`, so duplicate
  hints are harmless. Event Store truth, replay, Last-Event-ID, and the P5
  subscribe/buffer/high-watermark/replay/drain/live handoff remain unchanged.
  Request and SSE handlers do not read Outbox rows.
- **Meaning of `published`:** `outbox.status = published` means only that
  `RuntimeEventDeliverySink` synchronously accepted the exact durable message
  for live-distribution dispatch. It does not mean a browser consumed it, a
  Legacy client received it, all future subscribers observed it, or the Run
  completed. Client delivery remains an Event Store + replay + Last-Event-ID
  responsibility.
- **Subscriber failure boundary:** current `RuntimeEventNotifier` subscriber
  isolation remains authoritative. An individual subscriber/client handler
  failure cannot fail a Run, mutate an Event, or retry a lifecycle transition.
  P6 Outbox retry/dead-letter applies only to publisher/sink delivery failure,
  never to browser disconnect.
- **At-least-once identity:** delivery identity is `outbox.id`; domain Event
  identity is `event.id`; ordering and stream dedup identity is
  `runId + sequence`. Sink success followed by process crash before
  `markPublished` legally redelivers the same Outbox/Event identities. It must
  not create a second Runtime Event, second Run transition, or second domain
  Event identity.
- **Evidence threshold:** trusted persisted-evidence validation; duplicate-hint
  proof through `RunStreamService`; crash-after-sink-before-publish redelivery;
  subscriber isolation; no Outbox reads in request/SSE paths; and exact
  `published` semantics.
- **Stop/no-go:** Conversation EventBus reuse, external broker, caller payload
  trust, browser-delivery acknowledgment, marking published after read alone,
  second Event append, or any Run-state retry caused by subscriber failure.
- **Rollback boundary:** revert only P6 publisher/sink composition while
  preserving Event Store, Outbox rows, P5 direct notifier behavior, replay, and
  durable history.
- **Re-review trigger:** a different sink, external infrastructure, changed
  `published` meaning, removal of P5 low-latency notification, changed dedup
  identity, or any client acknowledgment entering Outbox state.

### M3-TD-34 P6 Task-domain restart and uncertainty contract

- **Classification and representation:** BOUNDED TECHNICAL CONTRACT CLOSURE;
  no new user Owner Decision. `runs.recovery_required` is the only M3 recovery
  representation. P6 does not create a Recovery Record or Migration 014.
- **Evidence set:** P6B recovery classification examines the Run, Run Stage,
  bound `run.start` Operation, Approval where applicable, and persisted Runtime
  Event evidence together. Run status alone is insufficient. Process,
  provider-session, or worktree booleans may be recorded only when backed by
  evidence actually inspectable in M3; they are never fabricated.
- **Terminal matrix:** `completed`, `failed`, and `cancelled` are immutable.
  Recovery does not reopen, retry, or execute them.
- **Queued without authorization:** `Run = queued` with no non-terminal
  `run.start` Operation remains an ordinary queued Run. It stays queued and is
  not automatically executed, completed, or failed.
- **Queued with authorization:** `Run = queued` with exactly one queued
  `run.start` Operation is `queue-restore`. Persistent Start authorization may
  be reclaimed by the future execution worker. P6B itself must not blindly
  invoke Provider or AgentRunner.
- **Starting with claimed Start:** `Run = starting` with a running `run.start`
  Operation is the M3-TD-29 C1b post-claim/pre-`run.started` failure window.
  P6B reuses the existing startup failure closure so Stage, Run, Start
  Operation, Runtime Event, and Outbox failure evidence commit atomically. It
  does not leave the Run starting or infer success.
- **Running:** `Run = running` with completed `run.start` remains running when
  M3 cannot prove external execution outcome; recovery atomically sets
  `recovery_required = 1` with recovery evidence. It does not complete, fail,
  resume, or restart provider execution.
- **Waiting approval:** a waiting Run with exactly one persisted unresolved
  Approval and coherent Run/Stage/Approval evidence is `approval-restore` and
  remains `waiting_approval`. Recovery never auto-approves or rejects. Missing,
  multiple, mismatched, or contradictory evidence sets
  `recovery_required = 1` and fails closed.
- **Paused:** coherent persisted paused state remains paused and is not
  auto-resumed. Cross-aggregate inconsistency sets `recovery_required = 1`.
- **Impossible combinations:** multiple non-terminal Start Operations, queued
  Run with completed Start, starting Run without a compatible active Start,
  or foreign/mismatched Operation binding fail closed. Recovery does not
  synthesize completed state or create a second Start Operation.
- **Recovery Events:** Runtime Specification events
  `run.recovery_attempted`, `run.recovered`, and `run.recovery_failed` are
  implemented in the Shared Registry by P6B; they are not a new Event design.
  Successful queue restore writes attempted then recovered with
  `queue-restore`; successful approval restore writes attempted then recovered
  with `approval-restore`; uncertain active execution writes attempted, sets
  `recovery_required = 1`, and writes recovery failed. Required
  State/flag/Event/Outbox changes commit in the same outer transaction.
- **Evidence threshold:** deterministic fixtures for every Run/Start Operation
  combination; exactly-one approval proof; M3-TD-29 C1b reuse; terminal
  immutability; full rollback injection; no guessed external evidence; and
  Conversation `agent_runs` recovery unchanged.
- **Stop/no-go:** status-only classification, guessed success, blind provider
  resume/restart, second Start, Recovery Record, Migration 014, direct
  repository state writes without Event/Outbox, or reuse of Conversation
  `runRecovery.ts`.
- **Rollback boundary:** revert P6 Task-domain recovery wiring and shared
  recovery-event implementation while preserving stored Run/Event/Outbox
  evidence and the separate Conversation recovery aggregate.
- **Re-review trigger:** ProcessManager/ProviderAdapter entry, a new recovery
  representation, new automatic resume behavior, changed Start Operation
  semantics, or any terminal reopening policy.

### M3-TD-35 P6 Outbox crash, retry, and dead-letter policy

- **Classification and review finding:** BOUNDED TECHNICAL IMPLEMENTATION
  CONTRACT under M3-TD-07; no new user Owner Decision. Independent review of
  P6A0 commit `67e06e12088c6f369763bc5241ea10cc35876da8`
  found one HIGH issue: current durable `outbox_messages.attempts` increments
  on every `pending/retry -> publishing` claim, so it cannot distinguish a
  completed classified sink failure from a claim followed by process crash and
  expired lease. It therefore cannot reconstruct the completed-failure budget
  or DeadLetter `firstFailedAt`.
- **No-schema closure:** P6A adds no column, table, Entity ID kind, or Migration
  014. Migration registry remains exactly 001–013. Existing mutable
  `outbox_messages.last_error TEXT` stores a P6-internal versioned failure-state
  envelope. This envelope is not a public API.
- **Durable envelope:** canonical JSON serialization in `last_error` has this
  semantic shape:

  ```ts
  interface OutboxFailureStateV1 {
    readonly schemaVersion: 1;
    readonly completedFailures: number;
    readonly firstFailedAt?: string;
    readonly lastOutcome: 'classified_failure' | 'lease_expired';
    readonly lastCode: string;
    readonly lastMessage: string;
    readonly lastObservedAt: string;
  }
  ```

  `schemaVersion` is exactly 1. `completedFailures` is a non-negative safe
  integer. `firstFailedAt` is present iff `completedFailures > 0` and remains
  immutable after the first classified failure. All timestamps are canonical
  UTC ISO 8601 with milliseconds. `lastCode` is stable, non-empty, and
  sanitized; `lastMessage` is sanitized bounded diagnostic text. Stack traces,
  SQL, database paths, secrets, and arbitrary sink objects are forbidden.
- **NULL and parser semantics:** `last_error IS NULL` means exactly
  `completedFailures = 0` with no `firstFailedAt` and no prior observed failure
  state. P6A parses and validates schema version, exact fields, integer range,
  conditional timestamp presence, canonical timestamps, code, message, and
  outcome before mutation. A malformed persisted state fails closed; it is never
  reset, guessed, discarded, marked published, or exposed raw. The durable
  message remains for manual or future reviewed remediation. A stable internal
  error code may be defined in the bounded P6A implementation.
- **Claim semantics:** claim continues to perform `attempts = attempts + 1`.
  `attempts` is formally TOTAL DELIVERY CLAIM ATTEMPTS and includes claims that
  later publish successfully, end in classified failure, or have unknown crash
  outcomes. It never directly drives completed-failure exhaustion.
- **Classified delivery failure:** only a sink invocation that returns or raises
  a classified failure while the publisher still owns a valid lease increments
  `completedFailures`. The first such failure sets `firstFailedAt = now`;
  later failures preserve it. Every classified failure writes
  `lastOutcome = 'classified_failure'`, the stable classified `lastCode`,
  sanitized `lastMessage`, and `lastObservedAt = now`. Retryable failure with
  `completedFailures < 5` transitions to retry; non-retryable failure or
  `completedFailures = 5` transitions to dead letter.
- **Expired lease transition:** a row at `publishing` with
  `lease_expires_at <= now` is conditionally reclaimed to `retry`. Reclaim
  preserves `completedFailures`, `firstFailedAt`, and `attempts`; writes
  `lastOutcome = 'lease_expired'`, `lastCode = 'OUTBOX_LEASE_EXPIRED'`, a stable
  sanitized lease-expired message, and `lastObservedAt = now`; sets
  `available_at = now`; clears lease owner/expiry; and increments version. The
  fenced update checks identity, current status, expected version, and expiry.
  It never takes over a live lease or rewrites message/domain identity.
- **Unknown outcome:** lease expiry is neither a classified failure nor proof
  of successful delivery. When `completedFailures = 0`, reclaim leaves
  `firstFailedAt` absent. Repeated lease crashes may make `attempts > 5` without
  exhausting the five completed-failure budget and never directly dead-letter.
- **Retry budget and backoff:** `MAX_COMPLETED_FAILURE_ATTEMPTS = 5` is evaluated
  only from `OutboxFailureStateV1.completedFailures`, never `attempts`. Retry
  delay is `min(1000 * 2^(completedFailures - 1), 300000)` milliseconds. The
  first through fourth completed retryable failures schedule 1s, 2s, 4s, and
  8s; the fifth is exhausted and dead-letters. M3 uses no random jitter. Clock
  is injectable and correctness tests use no sleeps. Lease-expired reclaim is
  immediately available and applies no classified-failure backoff.
- **DeadLetter evidence mapping:** terminal delivery failure inserts exactly:
  `sourceType = 'outbox'`, `sourceId = outbox.id`, and
  `target = 'runtime-events'`. Safe canonical payload metadata is
  `{ outboxId: outbox.id, eventId: outbox.eventId,
  runId: outbox.aggregateId, topic: outbox.topic }`; arbitrary caller or Event
  payload is not copied and no new Runtime Event is created.
- **DeadLetter timestamps and attempts:** `firstFailedAt` is the immutable
  envelope `firstFailedAt`; `lastFailedAt` is the current classified terminal
  failure time; `attempts = outbox.attempts` and therefore means total claim
  attempts. Dead-letter entry requires `completedFailures >= 1` and a valid
  `firstFailedAt`; otherwise it fails closed. Outbox creation, claim, lease
  expiry, or restart time must not be substituted for first failure time.
- **DeadLetter retryability and error:** an explicitly non-retryable sink
  failure writes `retryable = false`. A retryable failure exhausted at five
  completed failures writes `retryable = true`; this field describes the
  underlying failure classification, not whether automatic retries remain.
  `errorCode` and `errorMessage` are the final classified stable code and
  sanitized message. `OUTBOX_LEASE_EXPIRED` never becomes the final DeadLetter
  error; lease expiry only reclaims to retry.
- **DeadLetter identity:** no stricter production identity convention exists in
  the current repository, so P6A freezes deterministic internal ID
  `deadletter:<outbox.id>`. This provides one terminal DeadLetter record per
  Outbox message and fences transaction replay without modifying `Identity.ts`.
- **Dead-letter atomicity:** `markDeadLetterWithinTransaction` and
  `DeadLetterRepository.insertWithinTransaction` execute inside one
  `store.runInTransaction(...)` on the same database handle. Both commit or
  both roll back. An Outbox dead-letter state without its DeadLetter row, or a
  duplicate terminal record, is forbidden.
- **Publisher startup boundary:** construct and validate publisher dependencies
  after ownership, store open/migration, and synchronous Task-domain recovery.
  Routes are composed and HTTP listen must succeed before reclaiming expired
  leases and starting the publisher loop. Background delivery never begins
  before listen success. Ordinary delivery failure follows retry/dead-letter
  policy and is not a Run failure.
- **Evidence threshold:** P6A-F01 claim increments `attempts` but not completed
  failures; P6A-F02 first classified failure freezes `firstFailedAt`; P6A-F03
  later classified failure preserves it; P6A-F04 claim crash/reclaim preserves
  completed failures; P6A-F05 five lease crashes do not exhaust the budget;
  P6A-F06 completed failure count drives backoff; P6A-F07 fifth retryable
  completed failure dead-letters; P6A-F08 first non-retryable failure
  dead-letters; P6A-F09 DeadLetter first failure time is exact; P6A-F10 malformed
  persisted state fails closed; P6A-F11 Outbox/DeadLetter writes roll back
  together. All use injected clocks/barriers and no sleeps. Fencing/version
  races, sink classification, listen-success startup barrier, and clean loop
  shutdown remain required.
- **Stop/no-go:** reclaiming unexpired lease, resetting attempts, changing
  immutable fields, using `attempts` as the completed-failure count, losing or
  guessing `firstFailedAt`, accepting malformed state, copying arbitrary
  payload, random/sleep-based correctness, split dead-letter writes, marking
  published without sink acceptance, delivery before listen, or converting
  delivery failure into Run failure.
- **Rollback boundary:** stop/revert publisher and reclaim wiring while
  preserving Outbox/DeadLetter rows, immutable identity, Event Store, and P5
  live/replay behavior.
- **Re-review trigger:** envelope schema change, retry budget or jitter changes,
  new delivery outcome classes, different DeadLetter identity/evidence mapping,
  concurrent publisher topology, external broker, schema change, or a different
  startup side-effect boundary.

### M3-TD-36 Legacy canonical mapping execution ownership

- **Classification:** BOUNDED TECHNICAL CONTRACT CLOSURE under the already
  approved P6 Legacy mapping and single-execution invariant; no new user Owner
  Decision. P6C remains NOT AUTHORIZED until sequential P6 package gates allow
  it.
- **Single authority:** one Legacy request creates one canonical Run, one
  `run.start` Operation, and one execution authority.
  `LegacyCanonicalExecutionService` is the only AgentRunner owner for a
  `legacy_pipeline` Run. It is an adapter for the existing AgentRunner, not a
  second execution model.
- **Route boundary:** `tasks.ts` performs Legacy request validation, canonical
  command initiation, Legacy projection subscription, heartbeat/transport
  cleanup, and response framing. It does not construct AgentRunner, own an
  execution AbortController, drive Stages, or directly set canonical terminal
  Run state.
- **Canonical truth:** the Legacy bridge advances from a Run mirror to
  canonical Run + Start Operation + Stage lifecycle + Runtime Events + Outbox.
  Every execution state change is supported by canonical lifecycle evidence.
  Route-owned Legacy state machine and canonical execution worker may never
  execute together.
- **Thinking and projection:** the existing AgentRunner public text callback
  first persists `stream.text_delta`; only then may pure
  `LegacyRuntimeEventAdapter` project the persisted `RuntimeEventRecord` to the
  existing Legacy `thinking` frame. The same pure adapter projects persisted
  Events to the existing `status`, `stage`, `done`, and `error` frame shapes.
  It owns no second Run state machine and never sends first/persists later.
- **Disconnect:** client disconnect unsubscribes the persisted-event projection,
  stops heartbeat, and closes Legacy transport. It does not abort AgentRunner,
  cancel Run/Operation, or kill a process. Only an explicit Cancel command may
  change Run execution state.
- **Scope boundary:** no M4 ProcessManager/ProviderAdapter, Web default switch,
  Legacy API/JSON retirement, production Cutover, or second replay/live
  algorithm. P6C reuses the accepted P5 `RunStreamService` handoff.
- **Evidence threshold:** exact existing HTTP/SSE compatibility; one execution
  counter under concurrent requests; canonical Start/Stage/Event/Outbox
  evidence; thinking persist-before-project; disconnect without abort/cancel;
  replay/live no-gap/no-duplicate proof; and Legacy JSON/Web behavior retained.
- **Stop/no-go:** route-owned AgentRunner, request-owned execution abort,
  direct bridge terminal mutation, direct thinking-before-persist, second
  executor, M4 component, second stream handoff, or Legacy/Web retirement.
- **Rollback boundary:** revert P6C mapping/projection/execution adapter while
  preserving the callable Legacy route, Legacy source JSON, canonical durable
  history, and P5 stream/replay implementation.
- **Re-review trigger:** another execution owner, ProviderAdapter/ProcessManager
  entry, Legacy frame shape change, new public cancellation semantics, Web
  default change, or retirement/data-migration scope.

## 3. API compatibility record

The approved M3 route strategy is:

- Legacy Task path remains /api/workspaces/:workspaceId/tasks.
- Current v2 Task/Run collection remains /api/workspaces/:workspaceId/v2.
- Canonical top-level paths are /api/runs/:runId, /api/runs/:runId/start, /api/runs/:runId/retry, /api/runs/:runId/events, /api/runs/:runId/replay, /api/runs/:runId/stream, /api/operations/:operationId, /api/operations/:operationId/events, and /api/operations/:operationId/cancel.
- Canonical Task Collection replacement is Post-M3 Web/Legacy Cutover work.
- OpenAPI must show all three route families and their compatibility status.

Operation Event association is frozen to the Task-domain Run:

1. Read and authorize Operation by operationId.
2. Use its runId and immutable correlationId.
3. Query runtime_events.
4. Return events in ascending sequence order.

M3 does not create operation_events. Non-Run Operation types are deferred to Post-M3.

This decision does not authorize route code, Web changes, Legacy retirement, or a production default switch.

## 3.1 P3C-1 Start pre-implementation blocker closure (docs-only)

> **SUPERSEDED / HISTORICAL — NOT CURRENT STATUS.** PR #31
> subsequently implemented and merged the Start Route. This section preserves
> the earlier contract closure; the current Retry contract is §3.2.

Record status: the three P3C-1 Start pre-implementation HIGH blockers are
CLOSED as a contract-only remediation on 2026-08-06. This record does not add
a new M3-TD decision, does not change the M3-TD-30 sequence, and does not
authorize the Start route, Retry portion, P3D, or Production Cutover.

### HIGH-1 — canonical Run workspace resolution

The canonical Start route remains exactly:

```text
POST /api/runs/:runId/start
```

The route does not add `workspaceId` to its path, query, or body. Run IDs are
global opaque routing identifiers. The future Start implementation adds only
this read-only locator to `RunRepository`:

```ts
findWorkspaceIdByOpaqueId(runId: string): string | undefined
```

The locator returns only the owning `workspaceId`; it does not return Run or
Workspace data, inspect status or version, or mutate state. It is routing
resolution, not a Run domain guard. A missing Run returns `404 RUN_NOT_FOUND`;
the canonical Start route never returns `WORKSPACE_NOT_FOUND` for this lookup.

After resolution, the resolved workspace ID is part of the Idempotency
fingerprint, and every Run, Operation, and Idempotency query and mutation
remains workspace-scoped. No global unscoped mutation is permitted. The
current Local API Write Guard and Server Ownership remain the security
boundary; introducing multi-user, remote, or workspace-principal access
requires a new opaque-lookup review.

### HIGH-2 — SQLite busy and contention contract

The future production `SqliteStore` construction must execute
`PRAGMA busy_timeout = 5000` immediately after creating `DatabaseSync` and
before migrations. `PRAGMA foreign_keys = ON` remains enabled. Normal Start
contention must converge to `202` live, `202` replay, or a stable `409` Start
conflict. Raw `SQLITE_BUSY`, SQLite text, SQL, database paths, and lock details
must never reach a client.

When a human-held write lock exceeds the timeout, the stable response is:

```text
code: RUN_START_BUSY
status: 503
message: Run start is temporarily unavailable
retryable: true
```

Normal same-key, different-key, and no-key races must not use 503 as the
expected winner or loser. The generic `Transaction.ts` contract and existing
v2 mutation behavior are unchanged.

### HIGH-3 — complete Start Operation history

Start acceptance must read the complete history through
`OperationService.listByRun(workspaceId, runId)` and then filter
`type === 'run.start'`. `listNonTerminalByRunAndType()` is insufficient for the
full decision.

The frozen matrix is:

- no Start history: create is allowed;
- all historical Start Operations are `failed` or `cancelled`: create is allowed;
- exactly one `queued` Start: same-key Idempotency replay returns the original
  `202`; a different key or no key returns `409 RUN_START_ALREADY_ACTIVE`;
- more than one non-terminal Start: fail closed with
  `500 RUN_START_AUTHORIZATION_AMBIGUOUS`;
- a queued Run with `running`, `waiting_approval`, or `paused` Start history,
  or with any `completed` Start history, fails closed with
  `500 RUN_START_STATE_INCONSISTENT`;
- `failed` and `cancelled` are terminal history and never active authorization;
- no implementation may arbitrarily choose one of multiple Start Operations.

### A1 ordering, side effects, rollback, and route composition

The keyed A1 acceptance order is frozen without omitted or implicit steps:

1. Read the opaque `runId` from the canonical path.
2. Call the read-only `RunRepository.findWorkspaceIdByOpaqueId(runId)` locator.
3. If the locator finds no Run, return `404 RUN_NOT_FOUND`.
4. Validate that the request body is a plain JSON object.
5. Reject every unknown body field.
6. Validate optional `expectedVersion`: it may be absent; when present it must
   be a positive safe integer; `null`, zero, negative, fractional, string,
   `NaN`, and values outside the safe-integer range return the stable
   `400 VALIDATION_FAILED`.
7. Parse and normalize the optional `Idempotency-Key`.
8. Construct the fingerprint with `operation = run.start`, the locator's
   `workspaceId`, `pathParams = { runId }`, `domainInput = {}`, and
   `expectedVersion` supplied or `null`.
9. Call `IdempotencyService.prepare()` outside the transaction.
10. Begin the caller-owned `BEGIN IMMEDIATE` transaction.
11. Make `IdempotencyService.resolve()` the first Run/Operation domain action
    inside the transaction.
12. If resolve returns replay, do not read the current Run or Operation, do not
    execute version/status/Start-history guards, and immediately return the
    saved original HTTP 202 queued Operation snapshot.
13. On a miss, read the workspace-scoped Run.
14. If the Run is absent, return `404 RUN_NOT_FOUND`.
15. If supplied, execute the exact `expectedVersion` guard.
16. Require the Run status to be `queued`.
17. Read complete history with
    `OperationService.listByRun(workspaceId, runId)`.
18. Filter the history to `type === 'run.start'`.
19. Apply the complete frozen Start-history matrix.
20. Call `OperationService.createWithinTransaction()` to create the unique
    queued `run.start` Operation.
21. Validate the new Operation: `type = run.start`, `status = queued`, the
    resolved workspace, `aggregateType = run`, `aggregateId = runId`, the
    correct `runId`, `correlationId = operation.id`, and `version = 1`.
22. Construct the schemaVersion 1 Operation replay envelope.
23. Call `IdempotencyService.storeSuccess()` with HTTP status 202 and the
    acceptance-time original queued Operation snapshot.
24. Commit.
25. Only after a successful commit return HTTP 202 with top-level
    `{ "operation": ... }`; the internal result is `replayed = false`.

The no-key order is separately frozen:

1. Read the opaque `runId` from the canonical path.
2. Resolve the workspace with the read-only locator.
3. If the locator finds no Run, return `404 RUN_NOT_FOUND`.
4. Validate the body, reject unknown fields, and validate optional
   `expectedVersion`.
5. Begin the caller-owned `BEGIN IMMEDIATE` transaction.
6. Read the workspace-scoped Run.
7. Apply the optional `expectedVersion` guard.
8. Require the Run status to be `queued`.
9. Read complete history through `OperationService.listByRun()`.
10. Apply the complete frozen Start-history matrix.
11. Create the queued Start Operation with
    `OperationService.createWithinTransaction()`.
12. Commit.
13. Return HTTP 202 with `{ "operation": ... }`.

The no-key path creates no Idempotency Record and does not set
`Idempotency-Replayed`.

No Run/Operation domain guard may run between `prepare()` and `BEGIN IMMEDIATE`.
The locator is routing resolution only; it is not a Run status/version guard.

A1 Acceptance never mutates Run status or version, mutates Task, writes
`run.dequeued`, writes any Runtime Event, writes Outbox or Dead Letter rows,
calls `RunEngine.tick()` or `RunEngine.dispatch()`, calls WorkflowExecutor or
StageExecutor, starts a Provider or subprocess, waits synchronously for
`starting`/`running`, changes the Start Operation to `running`/`completed`,
triggers Retry, or creates Migration 014. After successful acceptance the Run
is still `queued` at the same version, the Start Operation is `queued` at
version 1, Task is unchanged, and no Runtime Event or Outbox row is added.

Any failure after Operation insert and before Commit rolls back the new Start
Operation and Idempotency Success Record, leaving the Run queued at the same
version, Task unchanged, and with no new Runtime Event or Outbox row.

The future `runLifecycle.ts` route creates its IdempotencyService through the
existing `createOptionalIdempotencyService(store)` pattern and creates a
route-local TaskRunService with that service. `index.ts` adds only one `/api`
mount; it does not reuse the bootstrap TaskRunService instance used by Legacy
recovery. Run deletion and workspace migration are outside the M3 contract and
require a new replay/locator review if introduced.

### Revised future Start implementation allowlist

This is a proposal, not authorization:

- `apps/server/src/routes/runLifecycle.ts` (new);
- `apps/server/src/routes/runLifecycle.test.ts` (new);
- `apps/server/src/services/TaskRunService.ts`;
- `apps/server/src/services/TaskRunService.test.ts`;
- `apps/server/src/store/SqliteStore.ts`;
- `apps/server/src/store/RunRepository.ts`;
- `apps/server/src/store/__tests__/RunRepository.test.ts`;
- `apps/server/src/index.ts`.

Existing `routes/v2Idempotency.ts`, `OperationService.ts`,
`OperationRepository.ts`, Idempotency Core, and Shared may be imported but are
not modified. Retry production code, Operation Cancel, Event Query/SSE,
RunEngine, LifecycleTransactionService, RunStageRepository, Migration/
Registry, Web, package or lockfiles, Legacy/v2 routes, Conversation EventBus,
and Production Cutover remain forbidden.

## 3.2 P3C-1 Retry implemented contract and merge evidence

Record status: IMPLEMENTED AND MERGED via PR #33 at main baseline
`de0b88fb0bed4a27cc38318481a0c7ccd47732a9`. This section freezes the twelve
Retry contract boundaries and records the implementation evidence. PR #33
changed exactly six production/test paths; this closeout changes only the five
allowlisted Markdown documents. That closeout did not authorize P3D, P3E,
Migration 014, or Production Cutover; P3D has since COMPLETED via
PR #36/#37/#38 and P3E integrated verification evidence is complete
(test/docs only). Migration 014 and Production Cutover remain NOT AUTHORIZED.

The existing M3-TD-30 Option A decision is the governing technical choice.
The current Retry contract below is the only current P3C-1 Retry contract.
Earlier generic Retry DTOs and implementation-time alternatives are
`SUPERSEDED / HISTORICAL — NOT CURRENT CONTRACT` where they occur in the
Runtime Specification and plan.

### B1 — Canonical route and workspace resolution

The one canonical endpoint is:

```text
POST /api/runs/:runId/retry
```

`runId` is the opaque Parent Run ID. The route does not accept `workspaceId`
in path, query, or body. It calls the existing read-only
`RunRepository.findWorkspaceIdByOpaqueId(runId)` locator before query parsing,
body parsing, header normalization, or business validation. A locator miss is
`404 RUN_NOT_FOUND`. The locator returns only `workspaceId`; it is not a Run
status/version guard and performs no mutation. Every later Parent, Child,
Operation, Snapshot, Stage, and Idempotency access is scoped by the resolved
workspace ID. No second global Run lookup is permitted.

### B2 — Header and request DTO

`Idempotency-Key` is required exactly once. The existing parser is reused:
header names are case-insensitive, the value is trimmed, duplicate or
comma-joined values are rejected, and the raw key is never logged or exposed.
Missing, duplicate, empty, or invalid values return `400 VALIDATION_FAILED`.
There is no no-key A2 path in the current contract.

`expectedVersion` is required and must be a positive safe integer representing
the Parent Run version. The only accepted JSON body is:

```json
{ "expectedVersion": 3 }
```

The body must be a non-empty plain JSON object with `Content-Type:
application/json`. Empty payloads, malformed JSON, `null`, primitives, arrays,
unknown fields, and any query parameter return `400 VALIDATION_FAILED`.
The following are not accepted in this M3 DTO: `mode`, `stageId`,
`providerOverrides`, `reuseTaskMemory`, `reuseWorktree`, `reason`,
`createdBy`, `requestedBy`, `workspaceId`, `parentRunId`, `operationId`, and
`correlationId`. The current generic Retry DTO is historical and does not
coexist with this contract.

### B3 — Child Run lineage and server-owned fields

The Parent must be `failed` at the supplied expected version. The Child is
created with exactly these values:

| Field | Frozen value |
| --- | --- |
| `workspaceId` | Parent `workspaceId` |
| `taskId` | Parent `taskId` |
| `parentRunId` | Parent `id` |
| `rootRunId` | Parent `rootRunId` |
| `status` | `queued` |
| `reason` | `retry` |
| `origin` | `v2_api`, server-owned by this canonical route |
| `objective` | Parent `objective`, inherited and not client supplied |
| `createdBy` | Parent `createdBy`, inherited from persisted server-owned data |
| `nextEventSequence` | `1` |
| `version` | `1` |

Child ID and all Child timestamps are newly generated by the server. Child
failure, cancellation, started, completed, and runtime output fields start
empty. The Parent status, version, failure data, timestamps, and all other
data remain unchanged. Task status, version, `acceptedRunId`, and
`pendingResultRunId` remain unchanged. The client cannot provide or override
any lineage, origin, objective, or creator field.

### B4 — Snapshot and Stage Graph source

Retry uses Option A: it clones the Parent's persisted Snapshot V2 and its
persisted RunStage graph. It never re-resolves current Workspace, Workflow,
Agent, Provider, Worktree, or other defaults. A missing Parent Snapshot, a V1
Parent Snapshot, malformed Snapshot, or a Snapshot/Stage binding mismatch is
`500 RUN_RETRY_STATE_INCONSISTENT` and has zero side effects; V1 is not
silently upgraded.

The Child receives a new Snapshot row and a newly computed canonical JSON and
hash. The cloned payload preserves the V2 workflow definition identity and
hash, `worktreeMode`, stage `dependsOn`, agent snapshots, provider snapshots,
and security redaction result. Only the run metadata is remapped to the Child
and `capturedAt` is newly generated. Parent Snapshot ID, runtime state,
outputs, errors, stage IDs, and timestamps are never copied.

The Parent graph must match the Snapshot V2 stage keys and sequences. Each
Child Stage is inserted with a new ID, Child Run ID, Child Snapshot ID,
matching `workflowStageKey` and `sequence`, `attempt = 1`, `status = pending`,
fresh server timestamps, and `version = 1`. Stage `dependsOn` remains frozen
in Snapshot V2; no mutable dependency row or Parent Stage state is copied.

The current code provides Snapshot V2 validation/canonical hashing,
`RunStageRepository.insertInitial`, and the V2 creation graph validator. The
implemented Retry path uses one minimal additive
`SnapshotService.clonePersistedRun(run, parentSnapshot, parentStages)` seam
that accepts V2 only, remaps run metadata, refreshes `capturedAt`, inserts the
new Snapshot, and inserts fresh initial Stages. It must not call a resolver or
read current configuration.

### B5 — Retry Operation v1 to v3

The Retry Operation is bound to the Parent, not the Child:

```text
type = run.retry
aggregateType = run
aggregateId = Parent.id
runId = Parent.id
correlationId = operation.id
```

Within the same caller-owned A2 transaction it moves exactly:

```text
queued / version 1
→ running / version 2
→ completed / version 3
```

`OperationService.createWithinTransaction()` creates v1,
`transitionWithinTransactionAt()` performs each transition with canonical
server timestamps, and the completed transition writes exactly
`result = { resourceType: "run", resourceId: Child.id }`. No client timestamp,
result, status, or correlation value is accepted. The operation is completed
before `storeSuccess()` and cannot later be rewritten by Engine, Start,
failure, cancellation, or Child terminal state. Retry creates no
Operation Event and M3 does not create an `operation_events` table.

### B6 — Complete keyed A2 order

The required and only A2 order is:

1. Read the Parent `runId` path parameter.
2. Resolve `workspaceId` with the opaque locator.
3. Return `404 RUN_NOT_FOUND` on locator miss.
4. Reject query parameters and validate Content-Type, body shape, and the
   required `expectedVersion`.
5. Normalize and validate the required `Idempotency-Key`.
6. Build the fingerprint with `operation = run.retry`, resolved workspace,
   `pathParams = { runId }`, `domainInput = {}`, and the required version.
7. Call `IdempotencyService.prepare()` outside the transaction.
8. Begin caller-owned `BEGIN IMMEDIATE`.
9. Make `IdempotencyService.resolve()` the first Parent/Child/Operation
   domain action inside the transaction.
10. On replay, immediately return the stored original HTTP 201 dual snapshot
    and do not read current Parent, Child, Operation, Snapshot, or Stage.
11. On a miss, read the workspace-scoped Parent.
12. Apply the exact Parent version guard.
13. Require Parent status `failed`.
14. Apply structural ambiguity, structural inconsistency, the valid completed
    Retry/direct Child duplicate check, and the Task active-slot check in that
    exact order.
15. Read the Parent Snapshot V2 and Stage graph and validate their binding.
16. Create the Parent-bound queued `run.retry` Operation at version 1.
17. Transition it to `running` at version 2.
18. Insert the queued Child Run with the frozen lineage.
19. Clone and insert the Child Snapshot V2.
20. Insert all Child initial Stages in Snapshot sequence order.
21. Append Child `run.created` through the existing graph-event seam.
22. Append Child `stage.created` Events in the same frozen sequence order.
23. Insert the matching Outbox row for every creation Event.
24. Transition Retry Operation to `completed` at version 3.
25. Write the Child result binding on that completed Operation.
26. Construct the schemaVersion 1 Retry replay envelope from the acceptance-time
    Child and completed Operation snapshots.
27. Call `IdempotencyService.storeSuccess()` with HTTP 201 and that envelope.
28. Commit.
29. Return top-level `{ "run": ..., "operation": ... }` only after commit.

No nested transaction, transaction-external Parent guard, replay reread,
automatic Start, Engine tick, Engine dispatch, or Child dispatch is allowed.

### B7 — Retry history and duplicate Child fencing

After a replay miss, the domain decision order is Parent read, exact
`expectedVersion`, Parent status `failed`, structural ambiguity, structural
inconsistency, the valid completed Retry/direct Child duplicate, Task active
slot, Snapshot/Stage validation, and then A2 creation writes.

The deterministic history matrix is:

| State observed after replay miss | Result |
| --- | --- |
| Zero direct Child, zero completed Retry, zero non-terminal Retry; any number of failed/cancelled Retry history | Eligible to create one Child |
| Exactly one completed Retry and exactly one valid direct Child with all bindings | `409 RUN_RETRY_ALREADY_CREATED` |
| More than one non-terminal Retry | `500 RUN_RETRY_STATE_AMBIGUOUS` |
| More than one completed Retry | `500 RUN_RETRY_STATE_AMBIGUOUS` |
| More than one direct Child | `500 RUN_RETRY_STATE_AMBIGUOUS` |
| Retry Operation exists but Child is missing | `500 RUN_RETRY_STATE_INCONSISTENT` |
| Child exists but completed Retry is missing | `500 RUN_RETRY_STATE_INCONSISTENT` |
| Operation/result/Parent/Child binding mismatch | `500 RUN_RETRY_STATE_INCONSISTENT` |
| Queued/running Retry with a Child | `500 RUN_RETRY_STATE_INCONSISTENT` |
| Completed Retry is not version 3 or lacks the exact result | `500 RUN_RETRY_STATE_INCONSISTENT` |
| Direct Child workspace/task/root/lineage binding is invalid | `500 RUN_RETRY_STATE_INCONSISTENT` |
| Same key with a committed success record | Original HTTP 201 replay, before current-state reads |
| Different key after a valid completed Retry/Child pair | `409 RUN_RETRY_ALREADY_CREATED` |
| Stale `expectedVersion` | `409 VERSION_CONFLICT`, zero side effects |
| Parent status other than `failed` | `409 RUN_NOT_RETRYABLE`, zero side effects |

For a valid completed duplicate, Operation and Child workspace equal Parent
workspace; Operation `aggregateId` and `runId` equal Parent ID; Child
`parentRunId`, `taskId`, and `rootRunId` equal the Parent bindings; Child
`reason = retry`; Child status is `queued` or later legal lifecycle status;
Operation result is `{ resourceType: run, resourceId: Child.id }`; and the
Operation is `completed` at version 3. Same-key replay occurs before all
current-state reads.

Task active statuses are `queued`, `starting`, `running`,
`waiting_approval`, and `paused`. If the active Run is the valid direct Child
from the completed Retry duplicate, return `409 RUN_RETRY_ALREADY_CREATED`.
If the Task has another active Run, return `409 RUN_ACTIVE_EXISTS` with safe
message `Task already has an active run` and `retryable: false`. A second
active Run is forbidden. A `RunRepository.insert` uniqueness race maps to the
same `409 RUN_ACTIVE_EXISTS` and rolls back all preceding A2 writes.

A committed A2 transaction cannot expose a partially created Retry Operation,
Child, Snapshot, Stage, or Event; any such combination is therefore
state-inconsistent and fails closed.

### B8 — HTTP 201 response and replay

The live and replay response is HTTP 201 with no internal discriminator:

```json
{
  "run": {
    "id": "run_child_...",
    "workspaceId": "workspace_...",
    "taskId": "task_...",
    "parentRunId": "run_parent_...",
    "rootRunId": "run_root_...",
    "status": "queued",
    "reason": "retry",
    "origin": "v2_api",
    "nextEventSequence": 1,
    "createdBy": "server-owned-parent-value",
    "createdAt": "...",
    "updatedAt": "...",
    "version": 1
  },
  "operation": {
    "id": "op_...",
    "type": "run.retry",
    "status": "completed",
    "workspaceId": "workspace_...",
    "aggregateType": "run",
    "aggregateId": "run_parent_...",
    "runId": "run_parent_...",
    "correlationId": "op_...",
    "result": { "resourceType": "run", "resourceId": "run_child_..." },
    "createdAt": "...",
    "startedAt": "...",
    "completedAt": "...",
    "version": 3
  }
}
```

The persisted Idempotency envelope is schemaVersion 1, but that discriminator
is internal and is never exposed in the HTTP body. A replay sets
`Idempotency-Replayed: true` and returns the original acceptance-time queued
Child and completed v3 Operation forever; later Child Start, Engine, or
terminal state cannot change it.

### B9 — Event and correlation boundary

The completed Retry Operation uses `correlationId = retryOperation.id`. Child
`run.created` and every Child `stage.created` use `correlationId = childRun.id`.
Each `stage.created` has `causationId` and `parentEventId` equal to the Child
`run.created` Event ID. Future Child execution Events use the independent
`run.start` Operation ID. The completed `run.retry` Operation does not
authorize execution, does not own `run.dequeued`, and creates no independent
Operation Event. `GET /api/operations/:operationId/events` for `run.retry`
queries by the Retry Operation's `runId + correlationId` and therefore
normally returns an empty collection in P3. It must never return Child
creation Events or independent Start execution Events as Retry Operation
Events.

### B10 — Error and SQLite busy contract

The route exposes only this stable error matrix:

| Condition | HTTP | Code | Retryable |
| --- | ---: | --- | --- |
| Request/header/query/body validation | 400 | `VALIDATION_FAILED` | false |
| Parent locator/read miss | 404 | `RUN_NOT_FOUND` | false |
| Stale Parent version | 409 | `VERSION_CONFLICT` | false |
| Parent is not failed | 409 | `RUN_NOT_RETRYABLE` | false |
| Key reused with another fingerprint | 409 | `IDEMPOTENCY_KEY_REUSED` | false |
| Valid Retry already created | 409 | `RUN_RETRY_ALREADY_CREATED` | false |
| Multiple non-terminal/completed Retry Operations or direct Children | 500 | `RUN_RETRY_STATE_AMBIGUOUS` | false |
| Invalid or incomplete persisted Retry state | 500 | `RUN_RETRY_STATE_INCONSISTENT` | false |
| Task already has another active Run | 409 | `RUN_ACTIVE_EXISTS` | false |
| Invalid Idempotency record | 500 | `IDEMPOTENCY_RECORD_INVALID` | false |
| Human-held SQLite lock exceeds timeout | 503 | `RUN_RETRY_BUSY` | true |
| Unknown failure | 500 | `INTERNAL_ERROR` | false |

The busy response message is exactly `Run retry is temporarily unavailable`.
No response may expose SQLite text, SQL, a database path, lock owner, raw
Idempotency-Key, stack, Parent, Child, or internal payload data.

### B11 — A2 rollback and concurrency proof obligations

Failure injection must cover Retry Operation insert, queued-to-running,
Child insert, Snapshot insert, every Stage insert, `run.created`, every
`stage.created`, every Outbox insert, running-to-completed, result binding, and
Idempotency `storeSuccess`. Every failure before Commit must leave no Child,
Child Snapshot, Child Stage, creation Event, Outbox, Retry Operation, or
Idempotency Success record; Parent and Task must be byte-for-byte unchanged.

The required concurrency matrix is: same key produces exactly one live HTTP
201 and one replay HTTP 201; different keys for one valid completed Retry/Child
pair produce one live HTTP 201 and one stable `409 RUN_RETRY_ALREADY_CREATED`;
two different failed Parents belonging to the same Task and using different
Idempotency keys produce exactly one HTTP 201, exactly one `409 RUN_ACTIVE_EXISTS`,
exactly one active Child, and no Operation/Snapshot/Stage/Event/Outbox/
Idempotency row for the loser; stale version produces zero side effects;
Parent failure transition versus Retry has one optimistic winner; existing
Child retry is fenced; human-held SQLite lock returns 503; and a normal race
never converges through 503. Because the header is required, no-key race
behavior is explicitly rejected at request validation and is not an A2 variant.

### B12 — Implemented Retry scope and retained boundaries

PR #33 implemented the Retry acceptance path in exactly these six existing
production/test files:

- `agentos/apps/server/src/routes/runLifecycle.ts` — canonical Retry route,
  request validation, safe error mapping, and replay header; keep Start path
  behavior unchanged.
- `agentos/apps/server/src/routes/runLifecycle.test.ts` — route, replay, error,
  rollback, and concurrency coverage.
- `agentos/apps/server/src/services/TaskRunService.ts` — caller-owned A2
  orchestration and history/Parent fencing; do not change the Idempotency Core.
- `agentos/apps/server/src/services/TaskRunService.test.ts` — service-level A2,
  lineage, failure-injection, and race coverage.
- `agentos/apps/server/src/services/SnapshotService.ts` —
  `clonePersistedRun(run, parentSnapshot, parentStages)` as the V2-only
  frozen-snapshot clone seam described in B4.
- `agentos/apps/server/src/services/SnapshotService.test.ts` — clone identity,
  fresh Child metadata, fresh IDs/timestamps, and no current-config read.

`OperationService`, `OperationRepository`, `RunRepository`,
`RunSnapshotRepository`, `RunStageRepository`,
`LifecycleTransactionService.createRunGraphEventsWithinTransaction()`, and
the existing Idempotency types/service/repository are reusable as-is. No
changes are authorized to Shared, Idempotency Core, Migration/Registry,
Operation implementation, LifecycleTransactionService, RunEngine,
WorkflowExecutor, StageExecutor, Web, package files, lockfiles, or real
`.agentos` data. PR #33 left those boundaries unchanged. The current closeout
may modify only the five Markdown files named by this task.

### Retry closure non-goals and governance boundary

This closeout records the already merged Retry production implementation; it
did not authorize P3D, P3E, Migration 014, or Production Cutover. P3D has
since COMPLETED via PR #36/#37/#38 and P3E integrated verification evidence
is complete (test/docs only). Provider / Process / CLI runtime and any
database operation remain unauthorized; Migration 014 and Production Cutover
remain NOT AUTHORIZED.

## 4. Deferred Post-M3 Decisions

The following historical decisions remain recorded but do not block the M3 Lifecycle, Event and API Foundation. Every row is NOT AN M3 P1 BLOCKER and NOT AUTHORIZED IN M3.

| ID | Deferred decision and preserved historical boundary | Status in M3 |
| --- | --- | --- |
| M3-POST-01 | Production Cutover definition, completion standard, and partial-cutover policy must name authority, cohort, evidence, stop condition, and rollback window. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-02 | Workspace JSON stop-read, stop-write, archive, and physical deletion remain deferred until parity, conflict/quarantine, backup, observation, and rollback gates are approved. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-03 | Legacy Task tasks.json migration, retention, unknown-record handling, and history policy remain deferred; preserve source and do not synthesize history. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for data meaning changes or deletion. |
| M3-POST-04 | Legacy API retirement remains deferred until caller inventory, deprecation, replacement contract, and no-caller evidence exist. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-05 | Web global default switch remains deferred; any future switch requires feature flag, user acceptance, staged rollout, and instant rollback. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-06 | Production Restore and downgrade authority remain deferred; any restore requires named owner, two-person confirmation, audit transcript, and rehearsal. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-07 | Failed Cutover handling and rollback window remain deferred; fail closed, preserve evidence, stop writes, and use only a pre-approved boundary. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-08 | Backup retention, production-copy provenance, access, sanitization, and deletion owner remain deferred. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for real data policy. |
| M3-POST-09 | Source quiescence and process ownership remain deferred; locks are not production quiescence proof. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED. |
| M3-POST-10 | Data mismatch, unknown Legacy record, and provider/agent conflict disposition remain deferred; quarantine rather than silent overwrite or drop. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for disposition. |
| M3-POST-11 | Active/interrupted Run treatment during a future production transition remains deferred; never infer success from process or stream state. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for live-work policy. |
| M3-POST-12 | Post-Cutover observation duration, telemetry, incident thresholds, and audit evidence remain deferred because no Cutover has occurred. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED where external telemetry or sensitive data is involved. |
| M3-POST-13 | Legacy data deletion remains separate from M3 and is never automatic after a technical gate. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; USER OWNER APPROVAL REQUIRED for any destructive operation. |
| M3-POST-14 | Branch, PR, merge, and release policy for future implementation remains deferred. This remediation creates no PR; the future P0 merge gate requires Draft PR, independent review, and ordinary Merge Commit. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3. |
| M3-POST-15 | At the original P0 gate, Remote Checks were UNAVAILABLE — NOT PASS. That historical absence was not relabeled. PR #42 later established the historical CI baseline at `859d8c73657741c03a3241402a9ab4c2e2f173ce`, and post-PR #42 main run `31513943821` passed. PR #44 at `e17a4bffdf12a033a0587ec2431cefe51a97bc49` superseded it as the current-main baseline, with post-PR #44 main run `31565915572` passing. | HISTORICAL M3 EVIDENCE GAP — SUPERSEDED BY CURRENT CI BASELINE; NOT A CUTOVER OR M4 AUTHORIZATION. |

## 5. P0 closure and current authorization status

- Technical direction: M3-TD-01 through M3-TD-30 retain their prior independent
  technical review status. M3-TD-31/32 are OWNER APPROVED / IMPLEMENTED AND
  MERGED via PR #37; race closure evidence via PR #38. M3-TD-33 through
  M3-TD-36 are the P6A0 BOUNDED TECHNICAL CONTRACT CLOSURE documented after
  P6-0 independent review reclassified the remaining questions as requiring no
  new user Owner Decision. They were subsequently implemented and accepted
  through P6A/P6B/P6C/P6D.
- P3C-0B Post-Merge Remediation 1: historical six-file Option A alignment
  prerequisite; PR #33 contains the six-file Retry production implementation.
- Final independent P0 review: COMPLETE (historical).
- P0 docs-only merge gate: COMPLETE (historical; P1, P2, and the P3 preplanning package have since merged).
- M3 P1: IMPLEMENTED AND MERGED.
- M3 P2: IMPLEMENTED AND MERGED.
- M3 P3 preplanning: MERGED via PR #21.
- M3-TD-26: IMPLEMENTED AND MERGED as part of the P3A Operation package; the
  immutable correlation contract remains current and no new Operation type or
  correlation change is authorized.
- M3-TD-27: TECHNICAL DIRECTION APPROVED; P3D Operation Cancel production
  implementation is IMPLEMENTED AND MERGED via PR #37; race closure evidence
  via PR #38.
- M3-TD-28: Core absence of persisted/populated progress is implemented; the
  P3D GET Operation route is IMPLEMENTED AND MERGED via PR #36 and omits
  progress; no progress field or projection is authorized.
- M3-TD-29: IMPLEMENTED AND MERGED through P3B-2A/P3B-2B and the merged Start
  path; the Start Operation completion contract remains current, with no
  additional Start completion behavior authorized.
- M3-TD-30: Option A alignment MERGED via PR #29; P3C-0B idempotency closure
  MERGED; P3C-1 Start Portion MERGED via PR #31; P3C-1 Retry production
  IMPLEMENTED AND MERGED via PR #33 at
  `de0b88fb0bed4a27cc38318481a0c7ccd47732a9`; the Retry contract is current.
- M3 P3D-0 Preplanning: COMPLETE.
- M3 P3D Contract Closure: OWNER APPROVED / DOCUMENTED.
- M3-TD-31: OWNER APPROVED / IMPLEMENTED AND MERGED via PR #37. The P3D Operation Cancel HTTP
  request, locator/parser, response precedence, trusted metadata,
  idempotency, and safe-error contract is frozen and implemented; race closure
  evidence via PR #38.
- M3-TD-32: OWNER APPROVED / IMPLEMENTED AND MERGED via PR #37. Option C, the dedicated guarded
  Operation cancel plus approval-aware Lifecycle cancellation seam, is frozen.
  Production implementation is merged.
- M3 P3D-1 production implementation: IMPLEMENTED AND MERGED via PR #36.
- M3 P3D-2 production implementation: IMPLEMENTED AND MERGED via PR #37.
- M3 P3D-3 production implementation: COMPLETE AND MERGED via PR #38.
- M3 P3E integrated verification evidence: COMPLETE (test/docs only, commit
  `400a3b29697b7185d29df2cb9da0417260549913`; zero production behavior
  change; P3 package merge state is authoritative Git history / PR record).
- M3 P3C-1: COMPLETE.
- M3 P3C-1 Start production acceptance: IMPLEMENTED AND MERGED via PR #31;
  the merged Start route remains current state.
- M3 P3C-1 Retry contract: IMPLEMENTED CONTRACT / CURRENT.
- M3 P5: COMPLETE / ACCEPTED through P5C at
  `a1cbb2868f9da215fab058b4176d70a3b382831d`.
- M3 P6-0 independent review: PASS WITH CONTRACT RECLASSIFICATION.
- M3 P6A0 initial independent remote review: CHANGES REQUIRED — HIGH-1 on commit
  `67e06e12088c6f369763bc5241ea10cc35876da8`.
- M3 P6A0 HIGH-1 durable failure evidence remediation: ACCEPTED / independent
  remote re-review PASS.
- New P6 user Owner Decision: NONE.
- P6A/P6B/P6C/P6D: COMPLETE / ACCEPTED / CLOSED.
- P3B-2A CONTRACT ALIGNMENT: COMPLETED AND MERGED via PR #25; this historical
  completion does not alter the merged Retry implementation. P3D has since
  COMPLETED via PR #36/#37/#38.
- Unresolved P3 Owner Decision candidates: 0.
- Approved P3 decisions: 7.
- M3-TD sequence ends at M3-TD-36. M3-TD-33 through M3-TD-36 are implemented
  and accepted M3 technical directions; they do not authorize M4 production
  implementation or production cutover.
- Migration 012: IMPLEMENTED AND MERGED as part of M3 P2.
- Migration 014: NOT REQUIRED BY M3 / NOT CREATED / NOT AUTHORIZED.
- Production Cutover: NOT AUTHORIZED / NOT STARTED.
- Production Restore: NOT AUTHORIZED.
- Legacy API/JSON retirement or deletion: NOT AUTHORIZED.
- M3 implementation: COMPLETE after PR #40 implementation merge and the
  accepted P6/P7 evidence.
- M3 formal closeout: COMPLETE upon PR #43 merge. Before that merge, the
  authoritative main is the PR #44 R39 remediation merge at
  `e17a4bffdf12a033a0587ec2431cefe51a97bc49`,
  and post-PR #44 main CI run `31565915572` passes. The resulting PR #43 merge
  commit becomes authoritative and requires its own post-merge main CI.
- The PR #42 baseline `859d8c73657741c03a3241402a9ab4c2e2f173ce`
  and run `31513943821` remain historical evidence, superseded as the
  current-main baseline by PR #44.
- M4 Entry: PENDING SEPARATE ENTRY DECISION. M4 preplanning is NOT AUTHORIZED BY
  THIS CLOSEOUT. M4 production implementation, Migration 014 creation, and
  production cutover remain NOT AUTHORIZED.

An Owner Decision is closed only when it records the selected option, owner identity and timestamp, affected scope, evidence thresholds, stop/no-go condition, rollback boundary, review requirement, and re-review trigger. These technical approvals do not authorize M4 production implementation, schema mutation, or production cutover.
