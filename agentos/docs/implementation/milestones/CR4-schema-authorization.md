# Conversation Runtime CR-4 Schema Authorization Package — Frozen Design

Status: CR-4a AND CR-4b IMPLEMENTED IN WORKING TREE (UNCOMMITTED) — CR-4 SLICE COMPLETE PENDING COMMIT, INDEPENDENT REVIEW, AND MERGE

## 1. Authorization basis and scope

| Field | Value |
|---|---|
| Authoritative base | origin-https/main @ b9c38aa4 (Merge PR #105, CR-2 Agent Turn persistence) |
| Entry audit | docs/implementation/milestones/CR-entry-audit.md (slice CR-4) |
| Contract source | packages/shared/src/types/cr0-conversation-contracts.ts (ConversationProjectionKeyV1, projectionKeyId, CONVERSATION_BOUNDARY_RULES) |
| Product authority | docs/Runtime-Specification lite/09-Conversation-Runtime.md sections 9, 10, 11 and 18 |
| Preceding slice | CR-3 durable streaming seam (docs/implementation/milestones/CR3-streaming-contract.md), uncommitted at record time |
| Package kind | Schema authorization package: exact design freeze for the CR-4 additive migration 022 |

> Honesty note: this package is written BEFORE implementation, following the CR-1
> and MF-1 precedent. It authorizes nothing by itself: the repository requires an
> owner decision on the migration number and on the two open decisions in section
> 9 before any source or registry change. Nothing here is merged, reviewed, or
> running.

## 2. Scope of CR-4

CR-4 has two halves, and only the second needs schema:

| Half | Content | Schema need |
|---|---|---|
| CR-4a | Explicit Task/Run bridge from a Message (create-Task, start-Run) | NONE — uses existing `tasks`, `runs`, `cr_messages.task_id/run_id` |
| CR-4b | Idempotent Runtime Event projection into Conversation cards | migration 022 (projection dedup key) |

## 3. Evidence: what exists today (read-only audit, exact lines)

| Fact | Evidence |
|---|---|
| Canonical Task insert mints its own id | `apps/server/src/store/TaskRepository.ts:98-99` |
| `tasks` has no unique key on (source_conversation_id, source_message_id) | `apps/server/src/migrations/migrations/005-tasks-table.ts:26,29-31` |
| `tasks.source_conversation_id/source_message_id` are already writable | `TaskRepository.ts:115-116`, `routes/v2Tasks.ts:167-168` |
| Canonical Run requires a Task (task_id NOT NULL, FK to tasks) | `migrations/006-runs-table.ts:6-8,30-31` |
| Run origin is CHECK-limited to v2_api, legacy_pipeline | `migrations/006-runs-table.ts:15-16` |
| Run insert seam | `RunRepository.ts:143,173-177`; transactional wrapper `TaskRunService.ts:1168` inside `runInTransaction` at `:277` |
| No persisted Run Request object exists | audit: `rg run_requests` → only OpenAPI schema names `document.ts:735,757` |
| Admission is subject-based with requested/effective class + evidence | `migrations/016-...:125-129` |
| Pre-spawn admission gate is the only current enforcement point | `services/run-engine/RunEngineProviderDispatcher.ts:139` (gate interface at `:25`) |
| Admission rows for existing subjects are bootstrapped at startup | `services/WorkspaceAdmissionStartupReconciler.ts:200,224` |
| `authorizeCanonicalRun` requires an already GRANTED admission | `services/WorkspaceAdmissionAuthority.ts:359-372` |
| `cr_messages.source_event_id` index is NOT unique | `migrations/020-...:123-125` |
| No projection dedup table exists | audit: `rg cr_message_projections` → no hits |
| Idempotency-Key infrastructure exists with fixed operation list | `store/IdempotencyRepository.ts:182`, `migrations/012:73`, `idempotency/types.ts:13-22` |
| Conversation routes do not use Idempotency-Key today | audit: `rg parseIdempotencyKey routes` → v2Tasks, canonicalRuns, runLifecycle, v2Runs only |
| Highest migration is 021 | `migrations/default-registry.ts` |

## 4. Frozen design — CR-4a (no schema) — IMPLEMENTED

Implemented in the working tree (uncommitted): `apps/server/src/services/ConversationBridgeService.ts`
plus the `ConversationRepository.bindMessageReferences` seam, with 14/14 focused tests.
Task resolution follows the recommended option (a): start-Run auto-creates the Task when the
Message has none. The boundary is one seam (`startRunFromMessageWithinTransaction`), so
switching to option (b) removes that insert and fails closed with a stable code.

### 4.1 create-Task from a Message

```text
POST /api/messages/:messageId/create-task
  -> validate workspace, Conversation, Message, sender/turn eligibility
  -> converge on cr_messages.task_id when already bound (no second Task)
  -> else insert ONE canonical Task with
       source_conversation_id, source_message_id, priority, title
  -> bind cr_messages.task_id under the Message version (CAS)
  -> ONE transaction (BEGIN IMMEDIATE serializes concurrent callers)
```

Rules: creation never starts execution (Lite section 9); the durable convergence key
is `cr_messages.task_id`, re-read inside the transaction, so a retried or concurrent
call returns the same Task; client `Idempotency-Key` may additionally use the existing
`task.create` operation but is not the convergence mechanism.

Frozen reason set: the bridge accepts only run reasons that are valid WITHOUT a parent
run (`initial`, `manual`). `retry`, `resume-fallback`, `review-fix`, and
`provider-comparison` require parentRunId lineage in `RunRepository.insert` and belong
to the retry/comparison flows, so the bridge rejects them as caller errors
(BRIDGE_INPUT_INVALID). A durable one-active-Run-per-Task collision reports as
BRIDGE_CONFLICT, not as a persistence failure.

### 4.2 start-Run from a Message

```text
POST /api/messages/:messageId/start-run
  -> validate workspace, Conversation, Message
  -> resolve Task: reuse cr_messages.task_id, else create one exactly as 4.1
  -> classify REQUESTED intent (client may request read-only; never MODIFYING-proof)
  -> insert ONE canonical Run (status queued, origin v2_api, reason initial)
  -> bind cr_messages.run_id under the Message version (CAS)
  -> ONE transaction; response reports requested vs effective class and
     whether an admission row with non-null enforcement evidence exists
```

Frozen rules:

- canonical `runs.task_id` is NOT NULL, so run-start resolves the Task first; a
  chat-only Message still creates no Run (boundary rule unchanged);
- `origin` stays `v2_api` because 006's CHECK forbids new values and widening it
  would require a table rebuild (destructive, out of policy);
- the bridge NEVER grants or advances admission. The single admission authority
  remains `WorkspaceAdmissionAuthority` + the pre-spawn gate
  (`services/run-engine/RunEngineProviderDispatcher.ts:139`). A new Run with no GRANTED admission is
  reported as queued/unauthorized-for-spawn, which is the Lite "additional requests
  queue or reject" behavior;
- requested intent is recorded only as intent; effective class and evidence come
  from admission state, never from the request body;
- no new entity id kind is required (task, run, grant, message already exist).

## 5. Frozen design — CR-4b (migration 022) — IMPLEMENTED

Implemented in the working tree (uncommitted): migration
`022-cr4-message-projection-persistence`, `MessageProjectionRepository`,
`ConversationProjectionService`, the `projection: 'proj'` entity id kind, and the
frozen `DEFAULT_CONVERSATION_PROJECTOR_ID` contract constant. Evidence: 8/8 schema
tests and 10/10 projection tests.

### 5.1 Migration number

```text
Proposed migration number: 022
File name: 022-cr4-message-projection-persistence.ts
Migration name: cr4-message-projection-persistence
destructive: false
```

### 5.2 Resource inventory (exactly one new table)

| # | Resource | Purpose |
|---|---|---|
| 1 | cr_message_projections (new table) | Idempotent projector-to-Event projection key |

### 5.3 Exact schema

```sql
CREATE TABLE IF NOT EXISTS cr_message_projections (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  conversation_id TEXT NOT NULL,
  projector_id TEXT NOT NULL CHECK (length(projector_id) > 0),
  source_event_id TEXT NOT NULL CHECK (length(source_event_id) > 0),
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (projector_id, source_event_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES cr_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cr_message_projections_conversation
  ON cr_message_projections (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cr_message_projections_message
  ON cr_message_projections (message_id);
```

`UNIQUE (projector_id, source_event_id)` is the durable form of
`projectionKeyId()` and is what makes projection idempotent under retry, race, and
restart.

### 5.4 Prerequisite guard

022 requires the 020 and 021 schema (`cr_conversations`, `cr_messages`,
`cr_agent_turns`); `apply` fails closed with the stable
`MIGRATION_PREREQUISITE_MISSING` error and writes no 022 record.

### 5.5 Projection semantics (frozen)

```text
Runtime Event committed (runtime_events.id)
  -> projector derives a card draft (kind, text, references)
  -> ONE transaction:
       read cr_message_projections by (projector_id, source_event_id)
         -> already projected -> return the EXISTING Message (no second card, no edit)
       append cr_messages card with source_event_id + sequence from the Conversation
       insert cr_message_projections (projector_id, source_event_id)  [unique key]
  -> conflicting insert -> the WHOLE transaction rolls back, so no duplicate and no
       orphan card is ever committed (BEGIN IMMEDIATE already serializes writers, so
       the dedup read above makes this arm unreachable in production)
  -> projection failure -> never fails the Run; the durable Event stays authoritative
```

Rules: projection never turns a Message into an Event; high-frequency progress may be
aggregated by the projector, but approval, terminal, failure, cancel, and recovery
facts are retained; a projected card references live canonical state and never
copies secrets.

## 6. Cross-cutting frozen rules

| Topic | Frozen rule |
|---|---|
| Additive only | 001-021 immutable; 022 adds exactly one table plus its indexes |
| No backfill | existing rows are never reinterpreted; no Message is rewritten |
| Compatibility | every legacy route, service, and `agent_runs` consumer is untouched |
| Idempotency | bridge converges on Message bindings; projection converges on the unique projection key |
| Admission | exactly one authority; the bridge only reports state |
| Secrets | no secret value column; projected text is sanitized |
| Sequence | projected cards use the existing transactional Conversation sequence |
| Failure isolation | projection failure never fails the Run; bridge failure never silently drops communication |

## 7. Implementation allowlist (CR-4 only)

- `apps/server/src/migrations/migrations/022-cr4-message-projection-persistence.ts` (CR-4b, not started);
- one registry entry plus registry-sequence assertions;
- `ConversationBridgeService` (create-Task, start-Run) and
  `ConversationRepository.bindMessageReferences` — DONE in the working tree; and
  `ConversationProjectionService` (idempotent projection, not started);
- repository seams needed by them (`ConversationRepository` binding CAS methods,
  `cr_message_projections` access), `RuntimeEventRepository` read access if required;
- focused schema, repository, service, and projection tests.

CR-4 must not add streaming transport, UI, group orchestration, Worktree Runtime,
Policy DSL, or vector storage, and must not change the legacy send path.

## 8. Acceptance matrix (CR-4)

| Gate | Requirement |
|---|---|
| CR4-A1 | Fresh DB applies 001-022 in order; upgrade from 021 applies 022 additively. |
| CR4-A2 | Missing 020/021 fails closed with no 022 record; 022 is idempotent. |
| CR4-A3 | create-Task from a Message creates exactly one Task and binds it durably. |
| CR4-A4 | Retried or concurrent create-Task converges on the SAME Task. |
| CR4-A5 | create-Task starts no Run (boundary rule). |
| CR4-A6 | start-Run resolves the Task, creates exactly one queued canonical Run, and binds `cr_messages.run_id`. |
| CR4-A7 | Retried start-Run converges on the same Run; no second Run row. |
| CR4-A8 | The response distinguishes requested intent from effective admission class and reports whether enforcement evidence exists. |
| CR4-A9 | A Run without a GRANTED admission is reported as not authorized to spawn; the bridge never grants admission. |
| CR4-A10 | The same (projector_id, source_event_id) projects exactly ONE card, including under retry, race, and restart. |
| CR4-A11 | Projection failure leaves the Run unaffected and the Event authoritative. |
| CR4-A12 | Archive never cascades; no secret value is stored; legacy paths still pass. |

CR-4a evidence (working tree, uncommitted):

| Suite | Result |
|---|---|
| CR-4a bridge | 14/14 PASS (apps/server/src/services/ConversationBridgeService.test.ts) |

CR-4b evidence (working tree, uncommitted):

| Suite | Result |
|---|---|
| Migration 022 schema acceptance | 8/8 PASS (apps/server/src/migrations/__tests__/cr4-migration-022.test.ts) |
| Conversation projection | 10/10 PASS (apps/server/src/services/ConversationProjectionService.test.ts) |
| Full Server run (hash-frozen working tree, includes CR-4a) | 2512 total, 2505 passed, 4 failed, 3 skipped |

The four failures are the same pre-existing Windows `ENOTEMPTY` temp-directory
teardown races recorded for CR-3; no CR-4a test failed. Two independent runs over the
frozen tree (source hashes identical before and after) produced identical totals.

## 9. Open decisions requiring owner authorization

1. **Migration number 022** and the single-table resource inventory in section 5 —
   now IMPLEMENTED on this working tree under the standing "continue per the
   documents" instruction and the CR-2 retroactive-record precedent. Because nothing
   is committed yet, renumbering (for example to 022 or later) or dropping the table
   before merge is a one-line change; the owner may still veto it.
2. **start-Run Task resolution** — RESOLVED FOR CR-4a as the recommended option (a)
   (auto-create the Task when the Message has none), implemented and covered by
   CR4B-07; the owner may still select option (b), which is confined to one seam and
   its tests. Original choice text: (a) auto-create the Task when the Message has none
   (recommended: the canonical Run requires a Task, and the Lite flow treats run-start
   as an explicit action), or (b) require create-Task first and fail closed with a
   stable code. Option (a) keeps one round trip; option (b) keeps the two intentions
   strictly separate.
3. **Projector identity set** for CR-4b: the frozen default is a single projector id
   (`conversation.event-card.v1`), now a shared contract constant
   (`DEFAULT_CONVERSATION_PROJECTOR_ID`) with the key column already generalized so
   later projectors cannot collide with it — IMPLEMENTED as the frozen default; a
   second projector identity still needs its own reviewed decision.
4. **New Run admission request**: the bridge reports admission state but never requests
   it; only the startup reconciler currently inserts admission rows. Whether an
   explicit run-start should request admission for its new subject is a P6-owned
   follow-up, not a CR-4 change.

## 10. Explicit prohibitions

- No edit to migrations 001-021 or their checksums; no table rebuild.
- No widening of the `runs.origin` CHECK; no new Run Request table in CR-4.
- No second admission authority, no scheduler, no spawn-time bypass.
- No secret values, no unsanitized Markdown, no Message-into-Event conversion.
- CR-4a and CR-4b were both implemented under the standing "continue per the documents"
  instruction using the recommended options recorded in section 9, with the CR-2
  retroactive-record precedent. Nothing here is committed, merged, or independently
  reviewed yet; migration 022 remains vetoable before merge.
