# S5 LITE-09-101 implementation evidence

Requirement: LITE-09-101 (execution-before-context). Authorization:
S5-execution-authorization.md. Base: merged main `948b8008`. No migration: the
existing CR-5 `cr_turn_context_snapshots` and CR-2 `cr_agent_turns` contracts
carry every field the exit needs.

## Implemented boundary

- `ConversationTurnDriver` resolves a bounded, deterministic history window
  (`MAX_FROZEN_HISTORY_MESSAGES = 12`) and a `TurnContextSelectionPort`
  selection, persists the snapshot, and only then invokes the Provider.
- The snapshot id is chosen before the reservation, so the durable Turn
  (`cr_agent_turns.context_snapshot_id`) references the exact selection the
  Provider received; the reply record can no longer be linked to a
  post-hoc snapshot.
- A snapshot persistence failure finalizes the Turn/Message as failed with
  `CONTEXT_SNAPSHOT_FAILED` and never calls the Provider; it never falls back
  to unbounded history.
- `createDurableTurnContextSnapshotPort` owns the transaction over the
  existing CR-5 store. Production wiring: the direct runtime route and
  `GroupTurnDriver` (per speaker Turn) both supply it.
- No Message editing, no versioning subsystem, no SSE semantic change.

## Evidence

| Evidence | Result |
|---|---|
| `ConversationTurnDriver.test.ts` | 8 pass / 0 fail |
| `GroupTurnDriver.test.ts` + `conversationRuntime.test.ts` | 14 pass / 0 fail |
| Server typecheck | exit 0 |

Proven behaviours:

- TD-07: with 13 history messages, the Provider receives exactly the newest
  12 ids (`msg_hist_02..13`); the snapshot records the budget
  (contextTokenBudget 321, window limit and frozen ids) and the selection
  (mem_direct, 7 tokens, truncated); the Turn references that snapshot.
- TD-08: a failing snapshot port leaves the Turn failed with
  `CONTEXT_SNAPSHOT_FAILED`, produces no Provider call, no checkpoint, and no
  snapshot row.
- Route test: a real `POST /messages/stream` over HTTP produces exactly one
  durable snapshot for that conversation/agent and at least one Turn row
  whose `context_snapshot_id` is set - the production path is wired, not dead
  code.

## Remaining for this row

LITE-09-101 stays GAP. The frozen window and the selection contract are now
enforced before invocation, but no production Memory selector is yet supplied
for Direct chat, so the selection is currently the empty selector (recorded as
such). The exit also asks for Scope-budgeted selection; that arrives with the
S6/S5 remaining work. Group speakers use the same driver-level freeze; their
own post-reply CR-5 selection snapshot is unchanged.
