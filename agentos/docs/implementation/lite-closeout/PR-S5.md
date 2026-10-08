## Requirements / bounded exit

LITE-09-101 (execution-before-context), S0 matrix v10. This slice freezes the
Direct/Group chat context BEFORE the Provider is invoked and links the reply
record to that frozen snapshot. Matrix row stays GAP: Direct-chat Memory
selection is still the empty selector, so Scope-budgeted selection remains open.

## Change boundary

- `ConversationTurnDriver` resolves a bounded deterministic window
  (`MAX_FROZEN_HISTORY_MESSAGES = 12`) plus an injected
  `TurnContextSelectionPort`, persists the snapshot, and only then invokes the
  Provider with exactly that window.
- The snapshot id is chosen before the reservation so
  `cr_agent_turns.context_snapshot_id` references the selection the Provider
  actually received; the previous post-reply-only snapshot can no longer be
  mistaken for execution evidence.
- Snapshot persistence failure finalizes the Turn/Message as failed with
  `CONTEXT_SNAPSHOT_FAILED` and never calls the Provider (no silent fallback to
  unbounded history).
- `createDurableTurnContextSnapshotPort` reuses the existing CR-5 store inside
  its own transaction; the direct runtime route and `GroupTurnDriver` both wire
  it, so the feature is live rather than dead code.
- No Message editing/versioning, no SSE semantic change, no migration.

## Evidence / merge gates

- `ConversationTurnDriver.test.ts`: 8 pass / 0 fail (TD-01..06 unchanged,
  LITE-09-101 TD-07/TD-08 new).
- `GroupTurnDriver.test.ts` + `conversationRuntime.test.ts`: 14 pass / 0 fail.
- Server typecheck exit 0.
- Route test proves the production path: a real `POST /messages/stream` writes
  exactly one snapshot for that conversation/agent and the Turn row carries its
  id.
- Details and first-failure log: S5-101-evidence.md.

Exact-head CI must be green before merge. Rows LITE-09-010/013/102 remain GAP;
their authorization is frozen in S5-execution-authorization.md and their
implementation is the next slice.

