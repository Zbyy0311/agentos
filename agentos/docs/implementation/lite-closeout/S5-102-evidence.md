# S5 LITE-09-102/010/013 slice evidence

Requirements: LITE-09-010, LITE-09-013, LITE-09-102. Authorization:
S5-execution-authorization.md (D1=B, D2=A, D3=off). Authority for D-labels:
docs/implementation/milestones/CG-orchestration-entry-audit.md:172-176.

## Implemented boundary

- A chat Turn has no implicit modifying authority. Because no adapter proves
  `enforcedWorkspaceReadOnly` per execution on the conversation path
  (D3=off), the forward chat path is classified as modifying.
- `ConversationTurnDriver` now refuses the Turn when another subject holds the
  Workspace's single-writer (GRANTED, MODIFYING) authority:
  stable code `CONVERSATION_WORKSPACE_MODIFYING_BUSY` and a message directing
  the user to wait for the current work or start an explicit Run. The refusal
  happens before the context snapshot and before any Provider call, and leaves
  a durable failed Turn/Message for audit.
- Production wiring: the runtime route supplies a read-only
  `ChatWorkspaceAuthorityPort` over `WorkspaceAdmissionRepository`
  (GRANTED + MODIFYING rows). Both the Direct stream and every Group speaker
  Turn use it. No new table, no migration, no fabricated admission rows.
- READ_ONLY admissions never block chat; D3 stays off (no parallel modifying
  execution is enabled anywhere on the conversation path).

## Evidence

| Evidence | Result |
|---|---|
| `ConversationTurnDriver.test.ts` | 10 pass / 0 fail |
| `conversationRuntime.test.ts` + `GroupTurnDriver.test.ts` | 15 pass / 0 fail |
| Server typecheck | exit 0 |

Proven behaviours:

- Unit: a GRANTED MODIFYING canonical Run blocks the chat Turn - no Provider
  call, failed Turn with the stable code, message names the explicit Run path,
  zero checkpoints. A READ_ONLY holder does not block and the reply completes.
- Route: over real HTTP, a busy Workspace returns `turn.failed` containing
  `CONVERSATION_WORKSPACE_MODIFYING_BUSY` and writes no context snapshot.

## Remaining for these rows

Rows stay GAP. Chat does not yet register itself as a modifying subject, so two
simultaneous chat Turns in one Workspace are not mutually serialized (that needs
a durable conversation-turn admission subject and therefore a separate,
authorized schema slice). Group speaker Turns inherit the same gate through the
shared driver; their per-speaker concurrency remains strictly serial by CG-S9.

