# S6 / LITE-13-101 authorization and evidence: the Run Inspector compaction explanation

Requirement: LITE-13-101 (13-Runtime-Inspector.md, user-approved compaction; section 10).
Exit: show the trigger value and threshold, the budget composition, the source range, the
policy, the summary, the failure/retry state and the actual Turn/Snapshot reference.

## Baseline and authorization

Audited baseline: main `07c1773ad108c066262753492ba2767bb3fc62d8` (matrix v15, PASS frozen).
Counterevidence `S6-COMPACTION-INSPECTOR-SOURCE` (evidence.json) records the read-only audit:
the Run-scoped Inspector had no compaction projection at all, and the Conversation-scoped
`GET /conversations/:conversationId/compactions` route already existed, so the gap was the
Run-scoped explanation, not the whole surface.

`node scripts/verify-lite-scope.mjs --implement LITE-13-101` exits 0; the plain scope verifier
also exits 0 with v15 frozen (PASS 0 / GAP 26 / RUNTIME-VERIFY 205 / DEFERRED 164). Raw
receipts: `implement.{stdout,stderr,exit}.txt`, `scope-verifier.{stdout,stderr,exit}.txt`.

Process deviation, disclosed: the read-only audit commands ran before any code was written,
but the evidence.json record and the `--implement` gate were executed after the change had
been drafted. Implementation was therefore not gated before editing in this slice.

## What was actually missing

| Surface | Before | After |
|---|---|---|
| Conversation | explained tasks, policy, adoptions | also reports refusals |
| Run Inspector | no compaction field at all | bounded explanation with thisTurn |
| Web Inspector | no compaction section | Compaction section, absent states named |

The Run side needed one more thing the Conversation side never had: a Run has no direct
Conversation column, so the explanation has to resolve and then disclose its own strength.
Three durable relations were verified in source before use: `cr_agent_turns.run_id` (also
carries `context_snapshot_id`, the only relation that names the frozen Snapshot),
`cr_messages.run_id` written by `ConversationBridgeService.startRunFromMessage` via
`bindMessageReferencesWithinTransaction`, and `tasks.source_conversation_id` written by
`createTaskFromMessage`. The projection reports which one it used as `linkVia`.

## Boundary of the change

- One shared read model (`ConversationCompactionInspector.ts`) for both surfaces; the
  Conversation route response keeps its existing fields and gains `conversationId` and
  `rejections`.
- `InspectorProjection.compaction` is new and bounded (newest 20 tasks, `tasksTruncated`).
- `thisTurn` is read from THIS Run own snapshot row, so a Run cannot borrow another Turn
  adoption; the Conversation-level lists stay Conversation-level.
- A Run that no relation places reports `compaction: null`, never an empty story.
- No migration, no new table, no new event type, no policy editing surface: the five
  existing cr_* / conversation_compactions tables are read as they are.

## Evidence

| Test | Proves |
|---|---|
| `apps/server/src/routes/conversationRuntime.compaction.test.ts` | real HTTP Turn path compacts, then the Run Inspector reads back the same task; `linkVia=task` and `linkVia=message` (via the real start-run entry) both explain it; cross-surface task sets are identical; an orphan Run is reported as not placed |
| `apps/server/src/routes/runtimeInspector.test.ts` | Turn-backed link names the adopting Snapshot, `thisTurn` reports adoption, a refusing Turn reports its durable reason, and the Conversation-level refusal of the OTHER Turn is listed separately |
| `apps/web/src/components/chat/RuntimeInspectorView.test.tsx` | the rendered explanation (trigger vs budget, ratios, policy version, source range, summary, adoption) and both absent states |

Local results on this revision: 46/46 server-focused tests, 16/16 runtime-route tests,
24/24 inspector tests, 176/176 web tests, both `tsc --noEmit` typechecks exit 0.

## Still open

Browser acceptance of the rendered Inspector page is not claimed here, and the PASS
promotion stays frozen, so LITE-13-101 remains GAP with this evidence recorded.

