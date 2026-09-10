# Conversation Runtime CR-3 Streaming Contract — Frozen Design Record

Status: IMPLEMENTED IN WORKING TREE (UNCOMMITTED at b9c38aa4) — PENDING COMMIT, INDEPENDENT RE-VERIFICATION, AND MERGE — NO NEW MIGRATION

## 1. Authorization basis and scope

| Field | Value |
|---|---|
| Authoritative base | origin-https/main @ b9c38aa4 (Merge PR #105, CR-2 Agent Turn persistence) |
| Entry audit | docs/implementation/milestones/CR-entry-audit.md (slice CR-3) |
| Contract source | packages/shared/src/types/cr0-conversation-contracts.ts (MessageStreamCheckpointV1, MESSAGE_STATUS_TRANSITIONS, canTransitionMessage) |
| Product authority | docs/Runtime-Specification lite/09-Conversation-Runtime.md section 8 |
| Schema | NONE — migration 021 (CR-2) already provides cr_message_checkpoints |
| Package kind | Slice design record plus uncommitted implementation in the main worktree |
| Working-tree state | `main @ b9c38aa4` plus the CR-3 changes; no CR-3 branch or commit exists yet because git metadata (`E:\workspace\Multi-Agent\.git`) is outside the agent's writable roots and the escalation path was unavailable at record time |

> Honesty note: migration 021 already created the checkpoint table, so CR-3 adds no
> schema and no registry entry. This document records the streaming semantics the
> implementation follows. It claims no independent review and no merge that has not
> happened.

## 2. Frozen streaming rules

1. **Reserve.** One transaction creates the streaming agent Message (status
   streaming) and the Turn (created -> streaming). The reservation records the
   streaming Message as the Turn's `source_message_id` (the CR-2 forward
   Turn-to-Message link), so pair ownership is provable from durable state; a
   supplied triggering Message is recorded as the response Message's
   `reply_to_message_id`. An archived Conversation rejects a new reservation and
   writes nothing; restore reopens the Conversation. An idempotent reservation
   retry against an archived Conversation returns the archived error rather than
   converging; archive gates reservation only and deliberately never gates append,
   replay, or finalize.
2. **Retry-safe append.** A caller-supplied ordinal makes a retried delta converge
   on the durable checkpoint (appended: false). Appends without an ordinal are never
   deduplicated, because a repeated delta is legitimate stream content.
3. **Pair ownership.** One Turn is bound to exactly one Message. Append, replay,
   and finalize each prove ownership from durable state and fail closed with
   `STREAM_LINK_MISMATCH` when the Turn's `source_message_id` is not the Message
   being written. A foreign Turn in the same Conversation can never claim another
   stream's ordinals, note that this closes the pre-first-checkpoint hijack window.
4. **Contiguous ordinals.** Ordinals start at 1 and advance by exactly one per
   Message and per Turn. A gap is rejected and writes nothing. A reused ordinal with
   a different delta is a conflict. An ordinal behind the durable head whose row is
   missing fails closed as stale.
5. **Cursor.** The durable reconnect token. cursor === ordinal while one Turn
   streams one Message; a later aggregation slice may decouple them but the cursor
   stays monotonic per Message.
6. **Replay.** Returns checkpoints after the client's last cursor in ordinal order.
   The durable row set is validated from ordinal 1, so a hole anywhere fails
   closed with `STREAM_REPLAY_GAP` even when the requested window starts after it;
   the returned window is therefore always contiguous. The response carries the
   current Message and Turn state and never guesses completion.
7. **Finalize.** One-way under optimistic concurrency (expected Turn version and
   expected Message version). final -> Message final; failed and cancelled -> Message
   failed, with the Turn carrying failure code and message. A terminal retry
   converges only on the exact same outcome. Final Message content is assembled from
   the ordered durable deltas unless the caller supplies the provider's final text.
8. **No cancellation authority.** The seam never cancels a Run or a Process, and a
   browser disconnect closes only a subscription. CR-3 adds no transport.
9. **No secrets.** Only text deltas are stored; no secret value column exists.

## 3. Resource allowlist (exact)

- packages/shared/src/types/cr0-conversation-contracts.ts (MESSAGE_STATUS_TRANSITIONS, canTransitionMessage);
- packages/shared/cr0-conversation-contracts.test.ts (CR0-11);
- apps/server/src/store/Identity.ts and Identity.test.ts (checkpoint prefix cp);
- apps/server/src/store/ConversationRepository.ts (findMessageById, appendMessageWithinTransaction, transitionMessageStatus, transitionMessageStatusWithinTransaction);
- apps/server/src/store/AgentTurnRepository.ts (createTurnWithinTransaction, transitionTurnWithinTransaction, appendCheckpointWithinTransaction, findCheckpointByOrdinal, lastCheckpointForMessage, lastCheckpointForTurn);
- apps/server/src/services/ConversationStreamService.ts (new);
- apps/server/src/services/ConversationStreamService.test.ts (new);
- docs (this record, CR-progress.md, Lite-FastTrack-progress.md).

No migration, route, transport, UI, Event projection, Task/Run bridge, or group
orchestration change.

## 4. Acceptance matrix (CR-3)

| Gate | Requirement |
|---|---|
| CR3-A1 | Reservation writes the Message and the Turn in ONE transaction. |
| CR3-A2 | An archived Conversation rejects reservation and writes nothing; restore reopens. |
| CR3-A3 | Reservation retry with identical ids converges; conflicting reuse fails closed. |
| CR3-A4 | Append assigns contiguous ordinals from 1 with a monotonic cursor. |
| CR3-A5 | Retried append with the same ordinal and delta converges without duplication. |
| CR3-A6 | Reused ordinal with a different delta conflicts; a lost durable row is stale. |
| CR3-A7 | An ordinal gap is rejected with no write. |
| CR3-A8 | Replay is contiguous after the cursor and reports current state, never a completion guess. |
| CR3-A9 | Replay validates the whole durable row set from ordinal 1 and fails closed on any hole. |
| CR3-A13 | Append, replay, and finalize prove Turn-to-Message ownership from durable state. |
| CR3-A10 | Finalize is one-way under optimistic concurrency and assembles checkpoint content. |
| CR3-A11 | Terminal retries converge only on the exact outcome; appends after finalize fail closed. |
| CR3-A12 | Within-transaction variants compose and roll back atomically; no secret value column. |

## 5. Evidence

| Suite | Result |
|---|---|
| CR-3 streaming seam | 20/20 PASS (apps/server/src/services/ConversationStreamService.test.ts) |
| CR-1 ConversationRepository (refactored seams) | 15/15 PASS |
| CR-2 AgentTurnRepository (refactored seams) | 14/14 PASS |
| CR-0 contracts including CR0-11 | 11/11 PASS |
| Identity prefixes including checkpoint | 34/34 PASS |
| Full Server run (hash-frozen working tree) | 2498 total, 2491 passed, 4 failed, 3 skipped |

The four failures are pre-existing Windows `ENOTEMPTY` teardown races in
`routes/worktrees.test.ts`, `services/ConversationService.test.ts`, and
`services/LegacyTaskItemImportService.test.ts`; no CR-3 assertion failed. HEAD
`b9c38aa4` and the source hashes were identical before and after the run.

## 6. Explicit prohibitions

- No edit to migrations 001-021 or their checksums; no new migration in CR-3.
- No streaming transport route, SSE, API, UI, Event projection, Task/Run bridge, or
  group orchestration.
- No rewrite of the legacy ConversationService or agent_runs boundary.
- No rerun-to-green: first-run failures are preserved and reported.

## 7. Independent review outcome

An independent verifier reviewed the first implementation revision and returned
NOT ACCEPTED with two medium findings: Turn-to-Message ownership was not enforced
at append (a same-Conversation foreign Turn could claim another stream's ordinal 1
before its first checkpoint), and CR3-A9 as written contradicted the
window-scoped replay check. Both were remediated in the working tree (ownership proof
plus strict whole-set replay validation, new CR3S-19/CR3S-20 coverage) and the
findings it also raised were addressed: branch/state wording, archive-retry
ordering documentation, and Turn-not-transitionable error mapping symmetry.
An independent re-verification was requested after the remediation. The verifier's
first finding, that the documented branch reference did not exist, is resolved by
this status wording: the changes are uncommitted.

Re-verification returned ACCEPTED with no HIGH or MEDIUM findings. The residuals it
recorded stay open deliberately and are listed here so CR-4 inherits them:

- terminal-retry convergence compares the outcome status only, so a retry carrying a
  different failure code or text converges on the recorded one instead of conflicting;
- the idempotent reservation path returns an existing Turn/Message pair without
  re-proving the binding; an unbound pair fails closed later, at append/replay/finalize
  with `STREAM_LINK_MISMATCH` and no writes;
- re-using `cr_agent_turns.source_message_id` as the streaming-Message binding
  (rule 1) intentionally differs from the full-scope reference model, where
  `sourceMessageId` names the triggering Message. The Lite Fast-Track keeps the
  trigger on the response Message's `reply_to_message_id` and the binding on the
  Turn. CR-4 must either adopt this convention explicitly or migrate it under a
  reviewed schema decision before wiring the Task/Run bridge.
