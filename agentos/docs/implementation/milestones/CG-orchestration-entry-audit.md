# Controlled Group — Speaker Orchestration Entry Audit

Status: ENTRY AUDIT COMPLETE — slice design frozen; implementation awaits the
owner decisions D1/D2 in `CG-orchestration-owner-decisions.md`.

Base: `origin-https/main @ d58c998c` (Merge PR #127). Every seam claim below was
re-read against that revision, not recalled from the planning documents.

## 1. Purpose

`Lite-FastTrack-progress.md` section 5 leaves one Lite step open: Controlled
Group Conversation. Its bounded routes, budgets, stop control, loop guard, and
per-Agent context snapshots are merged (PR #116); what is missing is the
`orchestrated` reply mode of `09-Conversation-Runtime.md` section 11.2:
"orchestrator or template selects speakers and order".

This audit establishes, from source, what a speaker-selection slice can be
built on today, what has no seam yet, and which candidate designs are therefore
not implementable without creating new durable surface.

## 2. Verified current state (forward CR surfaces)

| Capability | Verified state | Evidence |
|---|---|---|
| Group interaction persistence | `cr_group_interactions`, `cr_group_interaction_replies`, `cr_turn_context_snapshots` | `migrations/023-cr5-bounded-group-persistence.ts:43,73,95` |
| Bounded service | `createInteraction`, `recordReply` (loop guard -> budgets -> append), `stopInteraction`, `budgetStatus` | `services/BoundedGroupService.ts:131,172,182,289` |
| Bounded routes | create interaction, read interaction, record reply, stop | `routes/conversationRuntime.ts:307,322,334,353` |
| Per-Agent context | `TurnContextSelector` seam + snapshot persisted inside the reply transaction | `services/BoundedGroupService.ts:96`, `store/TurnContextSnapshotRepository.ts` |
| Reply-mode vocabulary | `CONVERSATION_REPLY_MODES` (sequential, parallel-read-only, orchestrated, manual, mention-only) and `MEMBER_REPLY_MODES` (always, mentioned, orchestrated, manual, never) | `packages/shared/src/types/cr0-conversation-contracts.ts:33,63` |
| Reply mode persisted | `cr_conversations.reply_mode`, `cr_conversation_members.reply_mode` with CHECK lists | `migrations/020-cr1-conversation-runtime-persistence.ts:51,59,78` |
| Chat reply execution channel | `ConversationTurnDriver.replyWithTurn` (CR-3 durable checkpoints) | `services/ConversationTurnDriver.ts:19-46` |
| Read-only evidence contract | `enforcedWorkspaceReadOnly` evidence with supported/verified variants | `packages/shared/src/types/p6-l1a-admission.ts:134,164` |
| Templated Stage order | `WORKFLOW_TEMPLATES_V1` with per-Stage `mutation` and `maxParallelReadOnlyStages` | `packages/shared/src/types/wf-templates.ts:35,55,71` |

## 3. Verified gap

No production path selects a speaker set for a forward group interaction, and
none executes one:

| Missing behavior | Verified evidence |
|---|---|
| The reply route is caller-driven only: the caller supplies `agentId`, `messageId`, and `content`; the runtime never chooses who speaks | `routes/conversationRuntime.ts:334-352` |
| A group Conversation uses the DIRECT reply path: the stream route picks the FIRST active Agent member with no eligibility, mention, or reply-mode resolution and no Conversation-kind check | `routes/conversationRuntime.ts:374,384` |
| `CONVERSATION_REPLY_MODES` is used only as request validation when a Conversation is created; nothing reads the stored mode to order or gate replies | `routes/conversationRuntime.ts:49,107-108` |
| No conversation or interaction path consults `enforcedWorkspaceReadOnly`, so `parallel-read-only` has no enforcement seam today | zero non-test hits under `apps/server/src` outside the Admission authority itself |
| No template binds a speaker to a group interaction: `WorkflowTemplateStageV1.roleLabel` resolves to an Agent/Run Stage, not to a Conversation member | `packages/shared/src/types/wf-templates.ts:35-45` |

## 4. Legacy substrate (deliberately not the forward path)

The v1 group surface already contains a leader-routing design. It is NOT a
seam for this slice, because it writes the legacy aggregates
(`agent_runs`, `executions`, `memories`) and carries no CR-5 budget, stop, or
loop-guard enforcement:

| Legacy piece | Evidence | Why it is not the seam |
|---|---|---|
| `ConversationService.sendGroupMessage` | `services/ConversationService.ts:448` | Builds a legacy Run/Execution per message; not the CR-3/CR-5 path |
| `resolveDispatchDecision` / `buildGroupTurns` | `services/GroupDispatchService.ts:33,70` | `buildGroupTurns` selects by legacy `CollaborationRole` and `member.sequence`, and its `full_pipeline` branch selects EVERY member with no CR-5 budget interaction |
| `GroupOrchestrator` | `services/GroupOrchestrator.ts:15-25` | Thin wrapper over the two functions above; no production caller in the forward path |
| Nonce envelope routing | `services/GroupDispatchService.ts:47-68` | In-band Provider output parsed for a decision; needs abuse guards before it may drive a bounded interaction (decision D1 option A) |

Reuse is therefore limited to vocabulary and tests: the forward slice must
resolve speakers from CR-0 membership and feed CR-5 `recordReply`, never the
legacy stores.

## 5. Slice design (frozen, parameterized on D1/D2)

The slice is a pure resolver plus one bounded execution driver. It adds no new
table: every artifact it needs already exists (interaction, replies, per-Agent
context snapshot), so this slice needs NO schema authorization.

### 5.1 `GroupSpeakerResolver` (pure, no I/O)

Input: the CR-0 Conversation, its active members, the interaction budget, and
the durable reply history. Output: an ordered `GroupSpeakerPlan`:

```text
speakers        ordered [{agentId, role, source, expectedMutationClass}]
skipped         [{agentId, reason}]   every non-selected eligible member, with a stable reason
terminalReason  optional stable reason when the plan is empty
```

Rules, in order:

1. **Eligibility** first (09 section 11.2): `member.status === 'active'` and the
   member reply mode allows replying for this trigger (`always`; `mentioned`
   only when mentioned; `orchestrated` only when the plan names it; `manual`
   only when the caller names it; `never` never). An `always` member inside a
   `sequential` Conversation is still serialized, never a bypass.
2. **Mention precedence**: explicit mentions of active members win over the
   Conversation mode; an unknown or removed mention produces an explicit
   `skipped` entry with a stable reason, never silence.
3. **Order** by the Conversation reply mode: `sequential` = member `sequence`;
   `mention-only` = mention order; `manual` = caller order; `orchestrated` =
   the order named by decision D1; `parallel-read-only` = membership order with
   `expectedMutationClass: 'read-only'` and an enforcement precondition (§5.3).
4. **Budget pre-check** against the CR-5 fields (`maxAgentsPerTurn`,
   `maxRepliesPerAgent`, `maxTotalReplies`, `maxAgentHops`, `timeoutMs`) so the
   plan itself can terminate with the SAME stable reason `recordReply` would
   produce, instead of spending a Provider call to discover a budget end.

The resolver never mutates state and never calls a Provider, so it is directly
testable as a pure function.

### 5.2 Bounded execution driver

`GroupTurnDriver` walks the plan one speaker at a time and, per speaker:

1. re-checks the interaction status (a `stop` between speakers ends the walk);
2. acquires the Workspace authority required by the speaker's mutation class;
3. runs ONE Agent Turn through the merged CR-3 channel
   (`ConversationTurnDriver.replyWithTurn`), streaming the same durable
   checkpoints the direct path already streams;
4. records the reply through `BoundedGroupService.recordReply`, which is the
   ONLY writer of interaction state and therefore the only place budgets and
   the loop guard can terminate an interaction;
5. stops the walk when `recordReply` returns a terminal interaction
   (`exhausted`/`stopped`) or reports a loop-guard reason.

Failure of one speaker's Provider attempt is reported as that speaker's failed
turn and never rewrites the interaction; the walk ends with a stable reason.

### 5.3 `parallel-read-only` stays out until evidence exists

09 section 11.2/11.6 allow concurrency ONLY with tested
`enforcedWorkspaceReadOnly = true` evidence for that execution. No such evidence
is produced anywhere on the conversation path today (§3), so this slice must
treat every speaker as modifying and serialize it. A later slice may enable
concurrency for speakers whose Adapter/platform proves the evidence; the
resolver already carries `expectedMutationClass` so that change stays additive.

### 5.4 Interface

One additive route, `POST /conversations/:conversationId/interactions/:interactionId/respond`,
which resolves the plan (or accepts an explicit `agentIds` list for `manual`),
executes it through the CR-3 stream, and streams the same `turn.start` /
`checkpoint` / `turn.final` events the direct route already sends. The merged
`/replies` route stays as the manual recording surface and is not modified.

## 6. Acceptance gates (proposed)

| Gate | Requirement |
|---|---|
| CG-S1 | Eligibility: `never`/`muted`/inactive members are never selected; each exclusion carries a stable reason |
| CG-S2 | Order: `sequential` follows member sequence; mentions always precede mode-driven selection; `manual` follows caller order |
| CG-S3 | A group Conversation with reply mode `orchestrated` resolves the D1 order deterministically for the same durable input |
| CG-S4 | The resolver terminates with the same stable reason `recordReply` would return, without a Provider call, for every exhausted budget |
| CG-S5 | `stop` between speakers ends the walk and records no further reply |
| CG-S6 | Loop guard still terminates the interaction on a repeated-content or same-agent-cycle reply produced by the driver |
| CG-S7 | A failed Provider turn adds no interaction reply and does not mutate the interaction version |
| CG-S8 | Per-Agent context is resolved per speaker inside `recordReply` (one snapshot per reply), and no speaker receives the full raw transcript |
| CG-S9 | No concurrency: two speakers of one interaction never overlap, and the driver never runs a second Provider turn while one is active |
| CG-S10 | Existing CR-5 suites and the direct reply stream stay green (no regression) |

## 7. Non-goals and prohibitions

- No new table, column, migration, or change to migrations `001`-`025`.
- No change to the legacy `ConversationService.sendGroupMessage` path or to its
  routes; it stays the COMPATIBILITY surface.
- No parallel execution of modifying speakers; no bypass of Workspace admission.
- No autonomous multi-round group chat: one interaction, one bounded walk.
- No change to `BoundedGroupService` semantics: budgets, stop, and the loop
  guard remain the only terminators, and the resolver may not override them.

## 8. What this audit does not decide

Three questions belong to the owner, not to source evidence, and are recorded in
`CG-orchestration-owner-decisions.md`:

| Id | Question | Options |
|---|---|---|
| D1 | Who names the next speaker in `orchestrated` mode | A: orchestrator-role member via in-band directive; B: template-declared deterministic order (RECOMMENDED); C: pure policy function |
| D2 | Execution channel for an orchestrated reply | A: reuse the CR-3 conversation reply stream (RECOMMENDED); B: bridge each reply to a Task/Run via CR-4a |
| D3 | Whether `parallel-read-only` may be enabled in this slice | NOT RECOMMENDED until an Adapter/platform can prove `enforcedWorkspaceReadOnly` per execution (section 5.3) |

Only D1 changes section 5.1's order rule; only D2 changes section 5.2's
execution step. Sections 2, 3, 4, 5.3, 5.4, 6, and 7 hold under every option.
