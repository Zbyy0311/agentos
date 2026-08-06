# AgentOS M3 Owner Decision Register

Technical direction status: APPROVED BY INDEPENDENT TECHNICAL REVIEW — M3-TD-30 Option A alignment is authorized only by the current remediation.

P3 decision freeze status: P3C-0B Post-Merge Remediation 1 is authorized; P3C-1, P3D, and Production Cutover remain NOT AUTHORIZED / NOT STARTED — REMOTE CHECKS UNAVAILABLE — NOT PASS — SCHEMA BLOCKER: NONE — Migration 014 is not required or authorized.

Final P0 documentation merge gate: COMPLETE (historical; superseded by the merged P1, P2, and P3 preplanning records).

Baseline: origin/main at 8477e1f077c86948c9ab872b319365a4ca534b3e

This register separates the approved M3 technical contract from deferred Production Cutover and Legacy Retirement decisions. A technical approval is not authorization to modify code, create DDL, migrate data, change production behavior, restore, delete, change the Web default, or start any M3 implementation phase without explicit authorization.

## 1. Decision rules

- M2 remains sealed at VERIFIED & MERGED / FULLY COMPLETE. This register does not reopen or extend M2.
- M3 is the Lifecycle, Event and API Foundation defined by Runtime Specification 14, Roadmap §§47–53.
- The technical rows below are approved as contract direction by independent technical review, but implementation remains not authorized unless a later instruction explicitly authorizes it. The P0 docs-only merge gate is historical and complete.
- USER OWNER APPROVAL REQUIRED remains mandatory for deviations from the Runtime Specification, irreversible schema or data changes, external cost or infrastructure, major user-visible behavior changes, Production Restore, and unrollbackable Cutover.
- Migration 012 was implemented and merged as part of M3 P2. No further migration, including Migration 014, is required or authorized by this register.
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
| M3-TD-26 | Operation correlation identity | For every newly created non-create Operation, correlationId = operation.id. The Operation ID and correlationId are generated and persisted in the same creation transaction; correlationId is unique and immutable; idempotent replay returns the original Operation, so the correlationId never changes. The historical run.create rule (correlationId = run.id) is preserved without migrating old records. | APPROVED TECHNICAL DIRECTION — IMPLEMENTATION STILL NOT AUTHORIZED. |
| M3-TD-27 | Operation cancel semantics | POST /api/operations/:operationId/cancel cancels the target non-terminal Operation and its bound Task-domain Run atomically in one caller-owned transaction. Cancellable statuses are exactly queued, running, waiting_approval, and paused; terminal conflicts fail closed. | APPROVED TECHNICAL DIRECTION — IMPLEMENTATION STILL NOT AUTHORIZED. |
| M3-TD-28 | Operation progress in M3 | P3 does not persist or populate ApiOperation.progress. GET /api/operations/:operationId omits progress; no derived, estimated, or fake value is returned. Progress is a Post-M3 contract and data-source decision. | APPROVED TECHNICAL DIRECTION — IMPLEMENTATION STILL NOT AUTHORIZED. |
| M3-TD-29 | Start Operation completion package | The run.start Operation is a Start command tracker, not a Run lifetime projection. Its `running -> completed` transition must commit in the same caller-owned transaction as the first startup Stage `starting -> running`, `stage.started`, the Run `starting -> running`, `run.started`, and both Outbox rows; `completedAt` uses the transaction timestamp and no independent Operation Event is written. Pre-start closure is split into C1a (claim commit not achieved: full Class B rollback, no automatic failure terminal) and C1b (after claim, before `run.started`: atomic Stage/Run/Operation failure closure). | APPROVED TECHNICAL DIRECTION — IMPLEMENTATION STILL NOT AUTHORIZED. |
| M3-TD-30 | Retry child run activation package | Option A: Retry is accepted only for a Parent Run in `failed` at the expected version; it creates one queued Child Run and never authorizes Engine execution. The Child requires a separate `run.start`; `run.retry -> HTTP 201` with the dedicated schemaVersion 1 Child Run + completed v3 Retry Operation replay envelope. The Parent is never reset or modified. | APPROVED; Option A alignment is implemented only by the current remediation. |

M3-TD-26 through M3-TD-30 are approved technical direction. M3-TD-30 is now aligned to Option A by this remediation; P3C-1 remains separately unauthorized. They resolve the five P3 Owner Decision candidates (formerly OD-P3-01 through OD-P3-05) recorded in the P3 preplanning documents.

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
  Events and Outbox rows; commit all or roll back all. For cancellation
  before or during startup, the result is Operation `cancelled`, bound Run
  `cancelled`, every affected non-terminal Stage `cancelled`, one
  `stage.cancelled` per affected Stage, and `run.cancelled`; cancellation
  does not produce Operation/Run/Stage `failed` or `stage.failed`.
  `cancelRunWithinTransaction` must not be bypassed and Stage cancellation
  logic must not be copied. Terminal behavior: a target already `cancelled`
  returns the current cancelled Operation with zero new side effects; a
  `completed` or `failed` target returns 409-class
  `OPERATION_NOT_CANCELLABLE`; a non-terminal Operation whose bound Run is
  in an incompatible terminal state fails closed with a stable state
  conflict and no silent repair. expectedVersion/ETag prevents
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
  startup), P3C-0B (replay closure), and the future P3C-1 Retry portion.
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
| M3-POST-15 | Remote Checks remain UNAVAILABLE — NOT PASS. Exact local L3 evidence may substitute only where separately accepted; missing remote evidence must not be relabeled passed. | NOT AN M3 P1 BLOCKER; NOT AUTHORIZED IN M3; Owner acknowledgment is required for a substitute release gate. |

## 5. P0 closure and current authorization status

- Technical direction: APPROVED BY INDEPENDENT TECHNICAL REVIEW.
- P3C-0B Post-Merge Remediation 1: AUTHORIZED only for the six-file
  Option A alignment allowlist; no P3C-1 production flow is authorized.
- Final independent P0 review: COMPLETE (historical).
- P0 docs-only merge gate: COMPLETE (historical; P1, P2, and the P3 preplanning package have since merged).
- M3 P1: IMPLEMENTED AND MERGED.
- M3 P2: IMPLEMENTED AND MERGED.
- M3 P3 preplanning: MERGED via PR #21.
- M3 P3 owner decision freeze: M3-TD-30 is aligned to Option A; P3C-1 and
  later implementation remain NOT AUTHORIZED.
- M3 P3C-1 Start pre-implementation blockers: CLOSED (docs-only); Start
  production implementation remains NOT AUTHORIZED.
- P3B-2A CONTRACT ALIGNMENT: COMPLETED AND MERGED via PR #25; this historical
  completion does not authorize P3C-1 Start implementation.
- Unresolved P3 Owner Decision candidates: 0.
- Approved P3 decisions: 5.
- M3-TD sequence ends at M3-TD-30; no later decision exists or is authorized.
- Migration 012: IMPLEMENTED AND MERGED as part of M3 P2.
- Migration 014: NOT REQUIRED OR AUTHORIZED.
- Production Cutover: NOT AUTHORIZED.
- Production Restore: NOT AUTHORIZED.
- Legacy API/JSON retirement or deletion: NOT AUTHORIZED.

An Owner Decision is closed only when it records the selected option, owner identity and timestamp, affected scope, evidence thresholds, stop/no-go condition, rollback boundary, review requirement, and re-review trigger. These technical approvals close contract direction only; they do not satisfy the final P0 merge gate.
