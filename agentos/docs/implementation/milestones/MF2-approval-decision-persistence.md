# MF-2 — Approval-Decision Persistence: Audit and Schema Authorization Package

Status: AWAITING OWNER DECISION — no implementation authorized by this document.

Base: `origin-https/main @ 774c5802` (Merge PR #133). Read-only seam inventory
verified against source at that revision.

## 1. Authorization basis and scope

`MF2-triggers-audit.md` (PR #135) established that four of the remaining MF-2
candidate-generation triggers lack a durable seam. This package addresses the
one whose seam is also a general dependency elsewhere: the accepted approval
decision. It proposes a new additive migration `026` and nothing else. The other
three triggers (review/test Artifact, compaction, explicit import) are NOT in
scope.

## 2. Problem statement (source evidence)

The production approval path keeps every approval record in process memory:

- `ApprovalRegistry` (`apps/server/src/services/ApprovalRegistry.ts:4-6`) holds
  `requests`, `decisions`, and `grants` in three in-memory `Map`s. Nothing is
  persisted; a restart loses every decision.
- The legacy routes (`apps/server/src/routes/approvals.ts`) create requests and
  resolve decisions only against that registry.
- A transactional, evented approval resolution DOES exist —
  `LifecycleTransactionService.resolveApprovalToRunning` (and
  `/Failure`/`/Cancellation`) emits `approval.resolved` with the decision,
  decidedBy, and decidedAt inside a transaction — but it has **zero production
  callers** (verified: no non-test hit outside the service itself), so it is
  test-wired only.

Because the durable record is missing, the 07-Memory-Runtime section 7 trigger
"accepted approval decision" cannot generate a Candidate: there is nothing
durable to re-read as the evidence a candidate must cite.

## 3. Design constraints (frozen)

- Migrations are additive and immutable; `026` appends, never edits `001`–`025`.
- The legacy `ApprovalRegistry` routes are COMPATIBILITY and stay untouched for
  this slice; the new table is the forward record.
- A decision record is immutable once written (no update, no delete), like
  `runtime_events`.
- The record carries no secret value and no raw tool output — ids, the decision,
  the risk level, and the action fingerprint only.
- The record carries no secret value and no raw tool output — ids, the decision,
  the risk level, and the action fingerprint only.

## 4. Proposed migration number

`026`. `025` is the last registered migration
(`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts:7`).

## 5. Resource inventory (exactly one table)

`approval_decisions` — one row per accepted or rejected approval decision,
durable across restarts.

## 6. Exact schema

### 6.1 `approval_decisions`

```sql
CREATE TABLE IF NOT EXISTS approval_decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT,                       -- the Run the approval was about, if any
  approval_request_id TEXT,          -- the originating request id, if any
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  action_fingerprint TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  decision TEXT NOT NULL CHECK (decision IN ('allow_once','allow_run','allow_conversation','deny')),
  decided_by TEXT,                   -- the user who decided, when known
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
```

- Immutable: one trigger, `approval_decisions_reject_update` (`BEFORE UPDATE` ->
  `RAISE(ABORT,'APPROVAL_DECISION_IMMUTABLE')`). The append-only delete is not
  guarded by a trigger because the Workspace FK is CASCADE, so the row leaves
  with its Workspace.
- Indexes: `(workspace_id, decided_at)` and `(workspace_id, run_id)`.

## 7. Event and trigger contract

When a decision is accepted (`allow_once`/`allow_run`/`allow_conversation`), the
slice generates one Memory Candidate capturing the approval evidence (tool,
risk level, action fingerprint, decision) with authority `user-explicit`,
inside the same transaction that records the decision. A rejected (`deny`)
decision records the row but generates no Candidate.

## 8. Acceptance matrix (proposed)

| Gate | Requirement |
|---|---|
| AP-01 | Fresh DB applies `001`–`026` in order; upgrade from `025` is additive |
| AP-02 | A decision row is immutable (update rejected by trigger) |
| AP-03 | The row persists across a store restart (close + reopen) |
| AP-04 | An accepted decision generates exactly one review-required Candidate in the same transaction |
| AP-05 | A `deny` decision records the row and generates no Candidate |
| AP-06 | The record carries no secret value and no raw tool output |
| AP-07 | The legacy approval routes keep their current behavior (no behavior change in this slice) |

## 9. Explicit prohibitions

- No edit to migrations `001`–`025` or their checksums.
- No destructive rebuild, no backfill.
- No secret value storage; no raw tool output.
- No change to the legacy `ApprovalRegistry` routes' behavior.
- No change to the `resolveApprovalTo*` transactional path or the Run stream.

## 10. Deferred follow-ups (recorded, not authorized)

1. Wiring the production approval resolution through the transactional
   `resolveApprovalTo*` path (so the legacy routes also emit `approval.resolved`)
   is a separate authorization.
2. Durable approval GRANTS (the `ApprovalGrant` list is also in-memory) is a
   separate authorization.
3. The remaining three triggers (review/test Artifact, compaction, explicit
   import) are separate authorized work.
