# Direct Conversation UX — Frozen Design and Boundary Audit

Status: IMPLEMENTED (option A frozen) — ConversationTurnDriver + SSE stream route — PENDING REVIEW/MERGE

## 1. Basis

| Field | Value |
|---|---|
| Base | PR #110 (`runtime/direct-conversation-ux`, forward routes) stacked on the CR chain |
| Product authority | docs/Runtime-Specification lite/09-Conversation-Runtime.md sections 6 and 12; docs/Runtime-Specification lite/12-UI-Architecture.md section 10 |
| Existing seams | CR-3 ConversationStreamService (PR #106); legacy ConversationService + ConversationAgentRunner |
| Package kind | design record + boundary audit; no source change |

## 2. What exists today (read-only audit, exact lines)

| Fact | Evidence |
|---|---|
| The legacy send path persists a legacy `messages` row and creates a legacy `agent_run` + `execution` | `apps/server/src/services/ConversationService.ts:161-220` |
| Provider text deltas come from `CLIExecutor.execute` → `onChunk`, surfaced as `streaming_response` execution events | `packages/agent-core/src/conversationRunner.ts:71-106` |
| Those deltas reach the client through the in-memory `RunStreamService` + SSE route | `apps/server/src/services/RunStreamService.ts:107-126`, `routes/conversations.ts:348` |
| The CR-3 durable streaming seam exists and is tested (reserve/append/replay/finalize) | `apps/server/src/services/ConversationStreamService.ts` |
| The forward send route persists a user Message but creates no reply | `apps/server/src/routes/conversationRuntime.ts` POST /messages |
| A chat-only Turn may have no Task/Run/Process | Lite 09 section 4.4 |
| The CR entry audit forbids silently rewriting the legacy `agent_runs` aggregate boundary | `docs/implementation/milestones/CR-entry-audit.md` section 5.2 |

## 3. The boundary decision (REQUIRES OWNER AUTHORIZATION)

The forward Turn needs Provider text. The only Provider-text producer today is the legacy
`ConversationAgentRunner`, which drives a legacy `agent_runs` + `executions` pair.

Two options:

- **(A) Drive the legacy runner as the execution mechanism, recording the Turn/Message/
  checkpoints as the canonical conversation record.** The legacy run/execution stays a
  COMPATIBILITY execution mechanism; the forward Turn never fabricates it and the
  boundary stays exactly as the CR-entry-audit froze it. Minimal new surface: one
  `ConversationTurnDriver` that maps `streaming_response` chunks onto
  `ConversationStreamService.appendStreamDelta` and finalizes via `finalizeStream`.
- **(B) A forward Provider invocation independent of the legacy runner.** Larger, and it
  duplicates the execution admission/process ownership that M4/P6 built.

Recommendation: **(A)** — it is additive, keeps the frozen aggregate boundary intact, and
makes the durable checkpoint the canonical stream while the legacy execution stays a
mechanism. Section 8 records this as the frozen choice under the standing instruction.

## 4. Frozen reply-stream design

```text
send user Message (persist-before-route, already shipped)
  -> resolve the direct Conversation's primary Agent member
  -> ConversationTurnDriver:
       beginAgentTurnStream (streaming Message + Turn, ONE transaction)
       run the legacy ConversationAgentRunner (COMPATIBILITY execution)
       each streaming_response delta -> appendStreamDelta (durable checkpoint)
       completed -> finalizeStream(final); failed -> finalizeStream(failed, code)
       browser disconnect -> close only the SSE subscription (Run/Turn unaffected)
```

Frozen rules:

- the durable checkpoint is the canonical stream; the client SSE stream carries each
  delta with its cursor, and a reconnect replays from the durable cursor;
- an unfinished stream after a Server restart is finalized as failed on the next read
  (never resumed by guessing);
- streaming ends in final, failed, or deleted (Message) and final/failed/cancelled
  (Turn), matching CR-3's finalize semantics;
- no Task/Run is created for a chat reply (boundary rule unchanged);
- secrets never enter Messages, checkpoints, or the stream.

## 5. SSE surface (extends the forward router)

```text
POST /runtime/conversations/:id/messages/stream   (send + reply stream, SSE)
GET  /runtime/conversations/:id/messages/:messageId/checkpoints?afterCursor=  (already shipped)
```

The SSE stream reuses the app's SSE conventions and never cancels the Turn on
`res.close`.

## Evidence (implemented)

| Suite | Result |
|---|---|
| ConversationTurnDriver (delta mapping, finalize, failure/cancel/crash/waiting paths) | 6/6 PASS |
| Route slice incl. `messages/stream` SSE | 7/7 PASS |

## 6. Acceptance matrix (Direct Conversation UX reply stream)

| Gate | Requirement |
|---|---|
| DCUX-A1 | A sent user Message produces one durable streaming reply Turn. |
| DCUX-A2 | Every Provider delta becomes one durable checkpoint, in order, with a monotonic cursor. |
| DCUX-A3 | Reconnect replays from the last durable cursor with no gap or duplicate. |
| DCUX-A4 | A Provider failure finalizes the Turn failed and preserves the checkpoints. |
| DCUX-A5 | Browser disconnect closes the subscription only; the Turn and its checkpoints survive. |
| DCUX-A6 | A chat reply creates no Task and no Run. |
| DCUX-A7 | The legacy execution mechanism is not rewritten; the boundary audit holds. |

## 7. What this slice does NOT do

No UI Composer yet (the shell is PR #109; the Composer is a separate UI step), no group
routing (CR-5 is the budget/loop foundation), no provider-switch mid-stream.

## 8. Decision record

Under the standing "continue per the documents" instruction and given that nothing is
committed, option (A) is frozen for the reply-stream implementation. If the owner
prefers option (B), only the ConversationTurnDriver's execution source changes; the
CR-3 seam, the checkpoint contract, and the SSE surface are unchanged.
