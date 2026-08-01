# AgentOS M3 Owner Decision Register

Status: DRAFT — PENDING OWNER REVIEW — no decision in this register authorizes implementation, production data change, restore, cutover, deletion, or M3 P1.

Baseline: `origin/main` at `80e398d5074ca8e0d6367d95a1aba3951b9a8843`

This register contains questions that code facts cannot approve. The recommendations are planning proposals only. Any row marked `OWNER APPROVAL REQUIRED` must remain unresolved until the named Owner records an explicit decision and evidence boundary.

## 1. Decision rules

- M2 remains sealed at `VERIFIED & MERGED / FULLY COMPLETE`; this register does not reopen or extend M2.
- Production Cutover, Production Restore, real data deletion, irreversible schema changes, external infrastructure or paid services, and material user-visible behavior changes require `OWNER APPROVAL REQUIRED`.
- A technical recommendation is not an approval and does not authorize code, migration, rollout, or deletion.
- A decision must name its scope, owner, evidence, stop condition, rollback boundary, and expiry/review date.
- Unknown records, data mismatches, active or interrupted Runs, and unavailable Remote Checks must fail closed rather than become implicit success.

## 2. Decisions

| ID | Decision topic | Current fact | Options to decide | Planning recommendation (not approved) | Approval boundary |
| --- | --- | --- | --- | --- | --- |
| M3-OD-01 | Production Cutover definition and completion standard | No M3 production transition has started | Domain-by-domain; cohort-by-cohort; or one global transition | Define Cutover as an explicitly authorized change of read/write/default authority with recorded start, end, evidence, and rollback window | `OWNER APPROVAL REQUIRED` because it authorizes production behavior |
| M3-OD-02 | Workspace JSON fallback retirement | Workspace reads SQLite first and still read JSON for missing, non-tombstoned records | Stop reads by cohort; stop reads globally; retain indefinitely | Cohort stop-read only after parity, conflict/quarantine, source-hash, and rollback gates | `OWNER APPROVAL REQUIRED` for irreversible source retirement |
| M3-OD-03 | Workspace JSON physical handling | Source file remains retained | Keep in place; archive; delete after retention | Keep through observation and rollback window; deletion is a separate later gate | `OWNER APPROVAL REQUIRED` for deletion |
| M3-OD-04 | Legacy Task JSON migration or retention | `tasks.json` remains the read/write authority for Legacy TaskItem | Keep; import as compatibility evidence; map to canonical Task; retire by cohort | Keep source and compatibility rows until per-cohort mapping and history policy are approved; prohibit bulk history synthesis | `OWNER APPROVAL REQUIRED` because mapping changes data meaning |
| M3-OD-05 | Legacy Task JSON stop-write/stop-read order | Legacy route and recovery still write JSON | Stop writes first; dual-write temporarily; stop reads first; retain both | Avoid new dual-write; use an explicit stop-write then observation then stop-read sequence only if reconciliation is proven | `OWNER APPROVAL REQUIRED` for source-authority change |
| M3-OD-06 | Legacy API retirement | Legacy Task routes are mounted and Web still calls them | Deprecate and measure; alias to v2; remove after consumers migrate | Deprecation plus caller telemetry, then removal only after no-caller evidence and replacement contract | `OWNER APPROVAL REQUIRED` for user-visible API removal |
| M3-OD-07 | Web default path switch | `useTask` uses the Legacy Task API; Conversation UI is separate | Feature flag; test workspace; global switch | Test-workspace flag first, then staged default switch with instant rollback | `OWNER APPROVAL REQUIRED` for material user-visible behavior |
| M3-OD-08 | Rollback window and downgrade policy | Backup verifier exists; production Restore/downgrade workflow is not evidenced | Fixed time window; cohort rollback; version rollback; forward repair only | Require a tested cohort rollback boundary and define when downgrade is forbidden | `OWNER APPROVAL REQUIRED` because rollback may alter real data |
| M3-OD-09 | Backup retention period | M2 requires verified SQLite and exact-byte JSON backup evidence | Time-based; until observation end; until explicit deletion approval | Retain through full rollback window plus the post-cutover observation period; specify access and deletion owner | `OWNER APPROVAL REQUIRED` for retention/deletion policy |
| M3-OD-10 | Source quiescence proof | Lock services exist, but production quiescence and process ownership are not current evidence | Maintenance window; admission gate; operator-held lease | Require no-new-work admission proof, active-run inventory, owner-held process lease, and explicit release record | `OWNER APPROVAL REQUIRED` for production quiescence |
| M3-OD-11 | Partial Cutover | Different domains currently have different authorities | Allow independent domain/cohort cutover; require all-at-once; prohibit partial state | Allow only explicitly named cohort/domain boundaries with an invariant matrix; never leave an unowned mixed state | `OWNER APPROVAL REQUIRED` because partial state changes failure scope |
| M3-OD-12 | Failed Cutover handling | There is no production Cutover controller | Abort and rollback; freeze and investigate; forward repair | Fail closed, preserve source and evidence, stop new writes, and use only the pre-approved rollback boundary | `OWNER APPROVAL REQUIRED` |
| M3-OD-13 | Data mismatch handling | M2 compatibility code classifies conflicts/quarantine, but production disposition is unset | Block cohort; quarantine per record; owner override; source wins; canonical wins | Block the affected cohort, retain both source hashes/payload references, and require per-record disposition | `OWNER APPROVAL REQUIRED` for any overwrite or exception |
| M3-OD-14 | Unknown Legacy record handling | Legacy sources can contain records not represented canonically | Quarantine; retain read-only; reject; manual mapping | Quarantine and keep source bytes; do not drop or synthesize records | `OWNER APPROVAL REQUIRED` if any record is deleted or rewritten |
| M3-OD-15 | Active/interrupted Run handling | Legacy Task recovery and Conversation recovery have different aggregates and restart rules | Drain; fail closed; resume; reattach; cancel | Inventory by aggregate, mark uncertain work explicitly, and never infer success from a process or stream state | `OWNER APPROVAL REQUIRED` for live-work policy |
| M3-OD-16 | v2 realtime / Durable Events scope | v2 Task/Run routes are REST-only; Conversation has separate persisted events and a process-local stream buffer | Include in M3; defer to a separate event milestone; implement only read replay | Defer broad v2 realtime until its event authority, replay, retention, and consumer contract are frozen; do not call Conversation stream a substitute | `OWNER APPROVAL REQUIRED` for scope and user-visible stream change |
| M3-OD-17 | `runs` versus `agent_runs` boundary | The current code keeps Task-domain and Conversation aggregates separate | Continue separation; introduce a shared projection; unify data model | Continue separation through M3; any unification is a separate milestone with a separate design | `OWNER APPROVAL REQUIRED` for data-model unification |
| M3-OD-18 | Migration 012 trigger | Registry `001`–`011` is present; no M3 schema contract is frozen | Create now; never create; create only after a schema diff | Create only if a reviewed M3 contract proves a real missing table/column/index/invariant; attach schema diff and rollback plan | `OWNER APPROVAL REQUIRED` for any schema migration |
| M3-OD-19 | Production Restore authority | Current backup verifier does not restore | Owner-only restore; L3 operator; two-person approval; no production restore in M3 | Require named production owner, two-person confirmation, audit transcript, and tested non-production rehearsal | `OWNER APPROVAL REQUIRED` |
| M3-OD-20 | Telemetry and audit evidence | Current code has diagnostics and persisted migration/event evidence, but no final M3 metric contract | Logs only; metrics; audit table; external telemetry | Define counts for legacy reads/writes, mismatch/quarantine, stream failures, active Runs, rollback, and operator actions; redact payloads and credentials | `OWNER APPROVAL REQUIRED` where external infrastructure or sensitive data is involved |
| M3-OD-21 | Branch, PR, and merge policy | This P0 task is docs-only and forbids a PR | Draft PR; ordinary Merge Commit; squash; push-only | Use a Draft PR for implementation phases that change code, require independent review, and use an ordinary merge commit unless Owner changes the policy | `OWNER APPROVAL REQUIRED` for merge/release policy; current task explicitly forbids PR |
| M3-OD-22 | Remote Checks unavailable | M2 documents say `UNAVAILABLE — NOT PASS` | Wait; local substitute; owner exception | Use exact local L3 output plus independent review, disclose missing remote evidence, and never label Remote Checks passed | Owner acknowledgment required for any release gate using a substitute |
| M3-OD-23 | Post-Cutover observation period | No M3 transition has occurred, so no observation window exists | Fixed duration; N successful cohorts; metrics-based | Define a minimum fixed window plus metric thresholds and incident response before Legacy retirement | `OWNER APPROVAL REQUIRED` |
| M3-OD-24 | Legacy data deletion permission | M2 retains Legacy JSON and compatibility evidence; no deletion is authorized | Never delete; archive; delete after observation; delete per cohort | No automatic deletion. Require separate destructive-operation approval, verified restore, retention expiry, and a deletion manifest | `OWNER APPROVAL REQUIRED` |
| M3-OD-25 | Backup/copy sanitization and access | M2 real-copy evidence is isolated; future production copies need an owner policy | Raw copy; sanitized copy; representative cohort; no copy | Prefer least-data representative copies, document provenance and access, and prohibit untracked local copies | `OWNER APPROVAL REQUIRED` for real user data |
| M3-OD-26 | Provider and Agent conflict disposition | SQLite profile/provider rows can be compared with legacy nested agent values | Canonical wins; source wins; quarantine; manual mapping | Quarantine conflicts and require explicit provider/executable/model binding review; never silently switch a provider | `OWNER APPROVAL REQUIRED` for execution behavior |

## 3. Decision closure requirements

An Owner Decision is closed only when the record contains:

1. decision text and selected option;
2. owner identity and timestamp;
3. affected domain/cohort and user-visible impact;
4. required evidence and thresholds;
5. stop/no-go condition;
6. rollback boundary and backup retention;
7. whether independent review and L3 validation are required;
8. whether a Draft PR and ordinary Merge Commit are required;
9. expiry or re-review trigger.

Until these fields are populated and independently reviewed, the decision remains `PENDING OWNER` and must not be used as implementation authorization.

## 4. Current closure status

- M3 Owner Decisions: `DRAFT / PENDING OWNER REVIEW`
- M3 P1: `NOT AUTHORIZED`
- Production Cutover: `NOT AUTHORIZED / NOT STARTED`
- Production Restore: `OWNER APPROVAL REQUIRED`
- Legacy data deletion: `OWNER APPROVAL REQUIRED / NOT AUTHORIZED`
- Migration 012: `NOT AUTHORIZED; trigger unresolved pending a real schema-gap proof`
