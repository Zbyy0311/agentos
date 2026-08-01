# AgentOS M3 Owner Decision Register

Technical direction status: APPROVED BY INDEPENDENT TECHNICAL REVIEW — IMPLEMENTATION STILL NOT AUTHORIZED.

Final P0 documentation merge gate: PENDING FINAL INDEPENDENT P0 REVIEW.

Baseline: origin/main at 80e398d5074ca8e0d6367d95a1aba3951b9a8843

This register separates the approved M3 technical contract from deferred Production Cutover and Legacy Retirement decisions. A technical approval is not authorization to modify code, create DDL, migrate data, change production behavior, restore, delete, change the Web default, or start M3 P1.

## 1. Decision rules

- M2 remains sealed at VERIFIED & MERGED / FULLY COMPLETE. This register does not reopen or extend M2.
- M3 is the Lifecycle, Event and API Foundation defined by Runtime Specification 14, Roadmap §§47–53.
- The technical rows below are approved as contract direction by independent technical review, but implementation remains not authorized until the P0 docs-only merge gate completes.
- USER OWNER APPROVAL REQUIRED remains mandatory for deviations from the Runtime Specification, irreversible schema or data changes, external cost or infrastructure, major user-visible behavior changes, Production Restore, and unrollbackable Cutover.
- Migration 012 is REQUIRED — PLANNING ONLY. No DDL is authorized by this register.
- Unknown records, data mismatch, active/interrupted Runs, missing Remote Checks, and incomplete evidence fail closed.

## 2. Approved M3 technical contract

| ID | Technical decision | Approved direction | Implementation boundary |
| --- | --- | --- | --- |
| M3-TD-01 | Event, Outbox, and Stream aggregate | M3 Runtime Events, Event Store, Outbox, and Run Stream belong only to Task-domain runs. Conversation agent_events and RunStreamRegistry are not substitutes. | APPROVED BY INDEPENDENT TECHNICAL REVIEW — IMPLEMENTATION STILL NOT AUTHORIZED. |
| M3-TD-02 | runs and agent_runs | Keep runs and agent_runs separate through M3. Any aggregate unification is a later design. | Same status. User approval is required for a data-model unification or material behavior change. |
| M3-TD-03 | Run state machine | Use the Runtime Lifecycle Transition Table as the authoritative Run state machine. Terminal Runs are immutable; Retry creates a child Run. | Same status. Any deviation from the Runtime Specification requires USER OWNER APPROVAL REQUIRED. |
| M3-TD-04 | Stage lifecycle schema prerequisite | Migration 012 must first provide the Stage lifecycle fields and status vocabulary required by M3. Current run_stages status limited to pending is not sufficient. | Same status. Persistent Run/Stage migration cannot begin in P1; it starts in P2. |
| M3-TD-05 | State, Event, and Outbox atomicity | Every persisted Run or Stage transition writes Current State + Runtime Event + Outbox in one transaction, or none of them commit. | Same status. Irreversible DDL requires USER OWNER APPROVAL REQUIRED and separate review. |
| M3-TD-06 | Event Store organization | Event Store is organized by Task-domain Run and uses a strict per-Run increasing sequence allocated from runs.next_event_sequence. | Same status. No use of Conversation run_event_sequences for Task-domain Runs. |
| M3-TD-07 | Outbox delivery | Outbox delivery is durable, at-least-once, retryable, and deduplicated by durable message identity. Dead letters use an independent table or reviewed equivalent. | Same status. No external broker or paid infrastructure is authorized. |
| M3-TD-08 | Central Runtime Event Registry | packages/shared owns shared Run/Stage status types, RuntimeEvent envelope, payload schema/version, ApiProblem, ApiOperation, DTOs, and SSE contract; a central registry validates registration, defaults, payloads, and unknown future events. | Same status. An unregistered Core Event cannot publish. |
| M3-TD-09 | Persistent Queue Record | Use runs(status=queued) as the M3 persistent Queue Record. Do not add scheduler_jobs unless later evidence proves the M3 invariant cannot be satisfied. | Same status. Queue implementation must not bypass State/Event/Outbox atomicity. |
| M3-TD-10 | Operation statuses | Operation status is exactly queued, running, waiting_approval, paused, completed, failed, or cancelled. Operation is distinct from Run and includes result, ApiProblem, aggregate reference, timestamps, and version. | Same status. No production operation or cutover command is implied. |
| M3-TD-11 | Async Start | Start Run returns HTTP 202 with an Operation resource; Create Run and Start Run remain separate commands. | Same status. No Start implementation before P2 transactional core. |
| M3-TD-12 | Operation API | M3 covers GET /api/operations/:id, GET /api/operations/:id/events, and POST /api/operations/:id/cancel. | Same status. The exact API path is recorded in OpenAPI before route implementation. |
| M3-TD-13 | Retry | Retry creates a new Child Run and never resets the old Run. Parent/root lineage and idempotency are required. | Same status. No provider retry policy or production retry automation. |
| M3-TD-14 | Legacy and Web compatibility | Preserve Legacy API and behavior and keep the Web default unchanged through M3. | Same status. Legacy retirement and Web switch are deferred Post-M3 Owner decisions. |
| M3-TD-15 | Task Event and runId conflict | runtime_events remains Run-scoped. Create Task does not fabricate a Run ID for task.created. Create Task is evidenced through Task state, Idempotency, and Audit. | Same status. Independent Task Aggregate Event design is Deferred Specification Alignment and does not block M3. Do not make run_id nullable for this purpose. |
| M3-TD-16 | API path conflict | Preserve Legacy /api/workspaces/:workspaceId/tasks and current /api/workspaces/:workspaceId/v2. Add canonical top-level Run and Operation paths. Defer canonical Task Collection replacement to Post-M3. | Same status. OpenAPI must document Legacy, current v2, and canonical paths separately; it must not claim a completed Task Collection switch. |
| M3-TD-17 | Race-free SSE handoff | Subscribe and buffer, capture durable high-watermark, replay through it, drain buffered events above it, deduplicate by runId plus sequence, then enter Live mode. | Same status. Replay-then-subscribe is not an accepted algorithm. |
| M3-TD-18 | Recovery representation | Before P6, choose either runs.recovery_required or a separate Recovery Record. P6 must not reference a schema state that does not exist. | Same status. Production Restore remains a deferred Owner decision. |
| M3-TD-19 | Migration 012 planning | Migration 012 is REQUIRED — PLANNING ONLY for runtime_events, event indexes/unique sequence, outbox_messages, dead letters, durable operations, run_stages expansion, idempotency operation values, recovery representation, sequence allocation, append-only/immutable constraints, and Queue decision. | Same status. No DDL in this remediation; future DDL needs independent schema review, checksum, fresh/legacy DB, rollback/forward, L3, and USER OWNER APPROVAL REQUIRED. |
| M3-TD-20 | Phase dependency | P1 is Schema and Shared Contract Foundation only. Persistent Run/Stage status migration and atomic transitions begin in P2. Run Engine and Start route integration begin only after the P2 transaction core. | Same status. No unreviewed P1 branch may start from this unmerged docs branch. |

## 3. API compatibility record

The approved M3 route strategy is:

- Legacy Task path remains /api/workspaces/:workspaceId/tasks.
- Current v2 Task/Run collection remains /api/workspaces/:workspaceId/v2.
- Canonical top-level paths are /api/runs/:runId, /api/runs/:runId/start, /api/runs/:runId/retry, /api/runs/:runId/events, /api/runs/:runId/replay, /api/runs/:runId/stream, /api/operations/:operationId, /api/operations/:operationId/events, and /api/operations/:operationId/cancel.
- Canonical Task Collection replacement is Post-M3 Web/Legacy Cutover work.
- OpenAPI must show all three route families and their compatibility status.

This decision does not authorize route code, Web changes, Legacy retirement, or a production default switch.

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

## 5. P0 closure and authorization status

- Technical direction: APPROVED BY INDEPENDENT TECHNICAL REVIEW.
- Implementation: STILL NOT AUTHORIZED.
- Final independent P0 review: PENDING.
- P0 docs-only Draft PR and ordinary Merge Commit: required before P1 branch creation, but not created in this remediation.
- Migration 012: REQUIRED — PLANNING ONLY; no DDL created.
- M3 P1: NOT AUTHORIZED.
- Production Cutover: NOT AUTHORIZED.
- Production Restore: NOT AUTHORIZED.
- Legacy API/JSON retirement or deletion: NOT AUTHORIZED.

An Owner Decision is closed only when it records the selected option, owner identity and timestamp, affected scope, evidence thresholds, stop/no-go condition, rollback boundary, review requirement, and re-review trigger. These technical approvals close contract direction only; they do not satisfy the final P0 merge gate.
