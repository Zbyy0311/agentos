# AgentOS M3 Cutover Implementation Plan

Status: DRAFT — PLANNING ONLY — PENDING INDEPENDENT REVIEW — M3 P1 NOT AUTHORIZED — PRODUCTION CUTOVER NOT AUTHORIZED

Baseline: `origin/main` at `80e398d5074ca8e0d6367d95a1aba3951b9a8843`

This is a future implementation plan. It does not claim that any M3 stage has executed or passed. It separates Planning, Rehearsal, Authorization, Execution, Observation, and Legacy Retirement. The current branch is authorized only to add the three M3 planning Markdown files and create one docs-only commit.

## 1. Contract and stage rules

- M2 is sealed at `VERIFIED & MERGED / FULLY COMPLETE` and is not reopened by this plan.
- No stage may treat a missing Remote Check as a pass. A local substitute must disclose the missing remote evidence.
- Production Cutover cannot share a stage with Planning or Rehearsal.
- Data deletion is not automatically coupled to Cutover and is not part of the default exit gate.
- Legacy Retirement occurs only after the full observation window and a separate approval.
- `runs` and `agent_runs` remain separate unless a separate owner-approved design changes that boundary.
- Migration 012 is not a planned deliverable. It can enter a later stage only after a real schema-gap diff and Owner Approval.
- Every “pass” below means a future gate condition, not a current status.

## 2. Stage plan

### P0 — Contract and Owner Decision Closure

**Goal**

Freeze the M3 scope, authority vocabulary, Owner Decision Register, evidence contract, and no-go rules.

**Authorized scope**

- Read-only source, Git, document, route, writer, consumer, and registry inventory.
- The three planning Markdown files in this branch.
- Local document validation and independent review preparation.

**Forbidden scope**

- Production code, tests, migrations, registry, API, Web, database, package, or Runtime Specification changes.
- Real migration/restore, production server/Web, source quiescence, process termination, PR creation, and M3 P1 execution.

**Required evidence**

- Current-State Audit based on the actual fetched baseline.
- Numbered Owner Decisions with approval boundaries.
- Stage plan with stop conditions and rollback boundaries.
- Explicit local-main/origin-main mismatch record where applicable.

**Test/gate matrix**

| Check | Required result |
| --- | --- |
| Git baseline and worktree | fetched baseline recorded; main untouched; planning branch isolated |
| File scope | exactly the three allowed new Markdown files |
| Markdown/links | structure and all relative links valid |
| Secret/path scan | no credential, secret, payload, or unnecessary complete local path |
| Independent review | required before P0 contract closure |

**Stop conditions**

- Baseline cannot be established from Git.
- Any required decision is silently treated as approved.
- A proposed change needs production data, irreversible schema, or code implementation.

**Rollback boundary**

Only the unmerged documentation branch and its single docs-only commit. No production rollback is involved.

**Exit gate**

Future P0 exit requires Owner Decisions recorded as approved or explicitly deferred, independent review completed, and written authorization to begin P1. This task ends with P0 documents `PENDING INDEPENDENT REVIEW`; P1 remains unauthorized.

### P1 — Readiness and Inventory Refresh

**Goal**

Refresh the exact reader, writer, route, Web consumer, data-shape, process-ownership, and cohort inventory against the implementation selected for M3.

**Authorized scope**

- Read-only code/config scans and isolated test-fixture inventory.
- Non-production caller/writer metrics design.
- Owner-approved sanitized fixture manifest.

**Forbidden scope**

- Switching any default, stopping any legacy writer/reader, modifying production data, or creating a new migration.

**Required evidence**

- Per-domain authority matrix and caller inventory.
- JSON source hash and canonical row/field comparison design.
- Unknown/mismatch/quarantine taxonomy.
- Active/interrupted Run inventory rules.
- Process ownership and source-quiescence evidence contract.

**Test/gate matrix**

- Static reader/writer and route scan.
- Contract tests for Legacy, v2 REST, Conversation, and Web current behavior.
- Independent review of authority and cohort boundaries.
- L3 validation of inventory completeness.

**Stop conditions**

- Any unowned writer or caller is found.
- Canonical mapping would synthesize history or discard unknown records.
- `runs`/`agent_runs` ownership is ambiguous.

**Rollback boundary**

No runtime state change; discard only non-production inventory artifacts according to their approved retention policy.

**Exit gate**

Owner-approved inventory, independent review, L3 sign-off, and explicit authorization for P2. No P1 execution is authorized by this planning branch.

### P2 — Backup and Production Copy Validation

**Goal**

Prove that the selected backup and representative copy can be bound, checked, retained, and recovered without touching production.

**Authorized scope**

- Owner-approved sanitized or representative copy.
- Verified SQLite backup and exact-byte JSON backup in an isolated location.
- Integrity, foreign-key, count, digest, and manifest checks.

**Forbidden scope**

- Production Restore, source modification, Legacy deletion, untracked raw copies, or external paid infrastructure.

**Required evidence**

- Copy provenance, scope manifest, source hashes, backup hashes, binding evidence, retention owner, integrity/FK output, and access record.
- Restore rehearsal authorization and cleanup/retention decision.

**Test/gate matrix**

- SQLite `integrity_check` and foreign-key check.
- Exact-byte JSON comparison.
- Schema/registry compatibility and row/digest preservation.
- Independent review plus L3 backup/restore validation.

**Stop conditions**

- Backup hash or binding mismatch.
- Any source write or unexpected data change.
- Copy contains data outside the approved cohort or lacks an access/retention owner.

**Rollback boundary**

The isolated copy and its verified backup only. Production remains untouched and no production downgrade is implied.

**Exit gate**

Owner approval of copy scope/retention, independent review, L3 validation, and a recorded no-production-write result.

### P3 — Cutover Rehearsal

**Goal**

Rehearse the proposed authority transition and rollback sequence against an isolated copy, including normal, malformed, duplicate, conflict, unknown, active, and interrupted cases.

**Authorized scope**

- Isolated copy only.
- Dry-run/apply/repeat/no-op behavior of already-authorized services.
- Simulated source quiescence and process ownership in the rehearsal harness.

**Forbidden scope**

- Production migration/restore, real user-data mutation, default switch, Legacy deletion, and treating a rehearsal as production authorization.

**Required evidence**

- Step transcript, source-hash preservation, per-record classification, quarantine disposition, active/interrupted Run result, backup/restore result, and rollback result.
- Proof that retries are idempotent and that unknown data is not silently dropped.

**Test/gate matrix**

- Malformed, duplicate, tombstone, canonical conflict, changed-source, and unknown-record cases.
- Task-domain bridge and Conversation aggregate isolation.
- Restart/recovery and stream-disconnect behavior.
- No-op rerun and source-byte preservation.
- Independent review and L3 rehearsal validation.

**Stop conditions**

- Any source hash changes unexpectedly.
- Rollback cannot restore the pre-rehearsal state.
- A mismatch is overwritten, history is fabricated, or an aggregate boundary is crossed.

**Rollback boundary**

Rehearsal copy and its backup. Rehearsal success never authorizes production rollback or production Restore.

**Exit gate**

Owner-signed rehearsal disposition, independent review, L3 validation, and an explicit authorization request for P4 or P5 according to the selected scope. No production action is included.

### P4 — Runtime/API/Web Transition

**Goal**

Implement and validate the approved runtime, API, Web, and compatibility changes for the named cohort while preserving a reversible boundary.

**Authorized scope**

- Only the code, tests, migration, and docs files named in an approved implementation PR.
- Feature flag or cohort routing, v2 client migration, contract adapters, and approved durable-event work if M3-OD-16 includes it.
- Keep Legacy and Conversation contracts independent until their separate gates pass.

**Forbidden scope**

- Global switch without authorization, unapproved user-visible behavior, Task/Conversation data-model unification, speculative Migration 012, or deletion of Legacy data.

**Required evidence**

- Unit/repository/service tests, API contract tests, Web/browser flow, SSE/reconnect/cancel/resume behavior, mismatch telemetry, and rollback drill.
- If v2 realtime is included, durable event persistence, sequence/replay/retention, process restart, and route/client contract evidence.

**Test/gate matrix**

- Legacy compatibility and v2 REST contract.
- Feature-flag cohort and default-off behavior.
- Task-domain `runs` and Conversation `agent_runs` isolation.
- Browser refresh/disconnect and server restart recovery.
- Security, redaction, path, credential, and error-envelope scan.
- Independent review, L3 validation, and Owner Approval for user-visible changes.

**Stop conditions**

- Critical regression, telemetry mismatch, unknown caller, missing rollback, or a need for unapproved schema/data change.

**Rollback boundary**

Feature flag/cohort routing and the approved code version. Any data rollback requires the separate P5/P6 authorization and verified backup.

**Exit gate**

Draft PR reviewed independently, L3 validation recorded, Owner Approval for the selected behavior, and a normal merge commit only after the PR gate. This stage does not authorize Production Cutover by itself.

### P5 — Production Cutover Authorization

**Goal**

Make a separate, explicit go/no-go decision for the exact production cohort, window, authority change, operator, backup, and rollback boundary.

**Authorized scope**

- Assemble evidence, review checklists, operator runbook, and signed authorization.
- Confirm that P1–P4 evidence matches the exact artifact and baseline intended for execution.

**Forbidden scope**

- Changing production authority, starting a migration, restoring data, deleting Legacy files, or silently broadening the cohort.

**Required evidence**

- Owner Decisions closed for affected domains.
- Verified backup and representative rehearsal.
- Source-quiescence and process-ownership plan.
- No-go thresholds, incident contact, rollback steps, retention, telemetry, and audit evidence contract.

**Test/gate matrix**

- Independent review of the full gate packet.
- L3 validation of runtime, backup, and recovery evidence.
- Owner-signed Production Cutover Authorization.
- Draft PR and merge metadata tied to the exact execution artifact.

**Stop conditions**

- Any critical evidence is missing, stale, or based on a different baseline.
- Remote Checks are absent without a disclosed approved substitute.
- Rollback, Restore authority, or source quiescence is not proven.

**Rollback boundary**

Authorization can be revoked before execution. After execution begins, only the explicitly approved rollback window applies.

**Exit gate**

An explicit signed authorization naming cohort, time window, operator, backup, rollback, and stop thresholds. Without it, P6 is forbidden.

### P6 — Production Cutover Execution

**Goal**

Execute only the approved authority transition against the approved production cohort and record every operator and data-boundary event.

**Authorized scope**

- Approved feature flag/default route or source-authority change.
- Approved backup, quiescence, migration/import, and verification steps.
- Immediate rollback within the approved boundary.

**Forbidden scope**

- Unapproved cohort expansion, data deletion, irreversible schema change without separate approval, Task/Conversation unification, or unlogged manual repair.

**Required evidence**

- Operator transcript, timestamps, source and backup hashes, active-work inventory, migration result, telemetry, mismatch/quarantine result, and rollback decision.
- Evidence that the production data changed only within the authorized scope.

**Test/gate matrix**

- Preflight backup and quiescence gate.
- Per-cohort read/write authority check.
- Post-change smoke and contract checks.
- Mismatch/error/active-run threshold check.
- Independent observer and L3 validation during or immediately after execution.

**Stop conditions**

- Any threshold breach, hash mismatch, unexpected writer/caller, uncertain active Run, telemetry outage, or operator disagreement.

**Rollback boundary**

The signed P5 rollback window and only the approved recovery mechanism. Production Restore requires the separately named Owner authority.

**Exit gate**

Execution record is complete, the cohort is within thresholds, no stop condition remains, and P7 observation is explicitly opened. This is not Legacy Retirement.

### P7 — Post-Cutover Verification and Observation

**Goal**

Observe the new authority under real workload, verify data and behavior, and prove that rollback thresholds have not been crossed.

**Authorized scope**

- Read-only comparison, telemetry, contract smoke tests, recovery inspection, and incident triage within the approved boundary.
- Corrective action only through a separately approved change.

**Forbidden scope**

- Legacy deletion, silent mismatch repair, unrelated refactor, new authority change, or declaring success before the observation window ends.

**Required evidence**

- Minimum observation duration, legacy read/write/error counts, mismatch/quarantine counts, stream/reconnect metrics, active/interrupted Run outcomes, and incident log.

**Test/gate matrix**

- Periodic read comparison and data integrity check.
- API/Web contract and user-visible regression checks.
- Recovery/rollback readiness check.
- Independent review and L3 observation report.

**Stop conditions**

- Critical regression, unbounded mismatch, unexpected Legacy caller, failed recovery, or missing telemetry.

**Rollback boundary**

The P5-approved rollback window if still open; after expiry, only a new Owner-approved incident/change procedure.

**Exit gate**

Owner-approved observation report with stable thresholds and a separate decision on whether P8 may begin. No deletion is implied.

### P8 — Legacy Retirement

**Goal**

Retire only the named Legacy path after stable observation and explicit approval, with data retention handled separately.

**Authorized scope**

- Deprecation/removal of the specific Legacy route, reader, or writer named in the decision.
- Removal tests/docs/telemetry and a reviewed implementation commit.

**Forbidden scope**

- Automatic deletion of Legacy JSON, compatibility rows, backups, Memory, Artifacts, or audit evidence.
- Removing a path with active callers or merging Task and Conversation runtimes.

**Required evidence**

- No-active-caller evidence, near-zero compatibility metrics, migrated/cohort disposition, stable observation report, updated docs, release note, and removal plan.

**Test/gate matrix**

- Negative tests prove the retired path is not used accidentally.
- Replacement API/Web/runtime tests pass.
- Independent review, L3 validation, and Owner Approval.
- Draft PR and ordinary merge commit with exact scope.

**Stop conditions**

- Any active caller, unknown record, unresolved mismatch, missing backup/audit evidence, or deletion coupling.

**Rollback boundary**

Revert the removal commit or re-enable the approved compatibility route while retained data/evidence remains available. Physical deletion has a separate boundary.

**Exit gate**

Owner-approved removal for the named path, independent review, L3 validation, merged exact-scope PR, and explicit retention status. No Legacy data deletion unless M3-OD-24 is separately approved.

### P9 — Final Closeout

**Goal**

Publish an evidence-bound final status for the approved M3 scope without overstating unexecuted work.

**Authorized scope**

- Final audit, status, runbook, evidence index, merge metadata, retention record, and observation summary.

**Forbidden scope**

- Calling pending evidence “verified”, reopening M2, deleting evidence, or bundling unrelated cleanup.

**Required evidence**

- Exact baseline and merge hashes, stage decisions, production data/change boundary, backup/rollback/observation evidence, remaining Legacy paths, and Owner sign-off.

**Test/gate matrix**

- `git diff --check`, file-scope, Markdown/link, secret/path, and status consistency checks.
- Independent review and Owner closeout.
- L3 validation where the final report contains runtime or production claims.

**Stop conditions**

- Any status lacks evidence, any required approval is missing, or any unapproved data/behavior change is found.

**Rollback boundary**

Documentation and release metadata only; operational rollback remains governed by the approved production runbook.

**Exit gate**

Final closeout is published only with an evidence index, explicit unresolved items, Owner sign-off, and no false completion language.

## 3. Review and authorization matrix

Legend: `Required` means a future gate must obtain it; `Not by default` means this planning task does not create or imply it.

| Stage | Independent review | L3 validation | User/Owner approval | Draft PR | Ordinary Merge Commit |
| --- | --- | --- | --- | --- | --- |
| P0 Planning | Required before closure | Required for baseline/evidence contract | Required for decisions marked so | Current task: forbidden | Current task: one docs-only commit only |
| P1 Inventory | Required | Required | Required for readiness exit | Only if implementation artifacts are added later | Only after an approved PR |
| P2 Backup/Copy | Required | Required | Required for real-data copy and retention | If harness/docs/code changes are authorized | After review and exact-scope checks |
| P3 Rehearsal | Required | Required | Required for disposition and next-stage authorization | If rehearsal implementation is authorized | After review and exact-scope checks |
| P4 Transition | Required | Required | Required for user-visible or authority changes | Required | Required before execution authorization |
| P5 Authorization | Required | Required | Required; signed Production Cutover Authorization | Required for the execution artifact | Required before P6 |
| P6 Execution | Required observer | Required during/after execution | Required and named in runbook | Must already be approved | Must already be merged |
| P7 Observation | Required | Required | Required for P8 decision | If corrective implementation is separately approved | Only for approved corrective scope |
| P8 Retirement | Required | Required | Required, especially deletion | Required | Required with exact removal scope |
| P9 Closeout | Required | Required for runtime/production claims | Required for final status | As separately authorized | As separately authorized |

## 4. Current plan status and handoff

- P0 documents: prepared in this branch; `PENDING INDEPENDENT REVIEW`.
- P1–P9 implementation/execution: planned only; `NOT AUTHORIZED`.
- Production Cutover: `NOT AUTHORIZED / NOT STARTED`.
- Production Restore: `OWNER APPROVAL REQUIRED` and not implemented.
- Legacy data deletion: not part of any automatic exit gate.
- Production data: unchanged by this docs-only planning task.
