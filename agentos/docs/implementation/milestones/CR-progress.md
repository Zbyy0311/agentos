# Conversation Runtime — Progress and Remaining Work

Status: CR-0/CR-1/CR-2 MERGED — CR-3..CR-6 NOT STARTED — CONVERSATION RUNTIME IN PROGRESS

## 1. Purpose

Tracks the Conversation Runtime slices defined by
`docs/implementation/milestones/CR-entry-audit.md`, so remaining work is legible
without re-auditing the repository.

## 2. Merged baseline

| Field | Value |
|---|---|
| Baseline | `origin-https/main @ d17cc777` (Merge PR #97) |
| Migration ledger | `001`–`020` present; `021` absent |
| Main CI | Post-merge runs through `3044f621` conclusion `success`; `d17cc777` in progress at record time |
| Prior gates | Workspace single-writer COMPLETE; Recovery closeout COMPLETE; Memory Foundation MF-0..MF-4 + MF-5 events/emission/Run-injection MERGED |

## 3. Slice status

| Slice | Scope | State | PR |
|---|---|---|---|
| CR-0 | Shared Conversation contracts | **MERGED** | #95 |
| CR-1 | Forward Conversation/Member/Message persistence (migration 020) | **MERGED** | #96 (auth), #97 (impl) |
| CR-2 | Message revisions + Agent Turn records (migration 021, AgentTurnRepository) | **MERGED** | (auth retro), (impl) |
| CR-3 | Durable streaming checkpoints + reconnect cursor | **NOT STARTED** | — |
| CR-4 | Explicit Task/Run bridge + idempotent Event projection | **NOT STARTED** | — |
| CR-5 | Bounded Group budgets/stop/loop guard + per-Agent context | **NOT STARTED** | — |
| CR-6 | Archive/restore + history references | **PARTIAL** (archive/restore merged; history NOT STARTED) | — |

## 4. Merged evidence

| Suite | Result |
|---|---|
| CR-0 contracts | 10/10 PASS |
| CR-1 migration 020 | 11/11 PASS |
| CR-1 ConversationRepository | 15/15 PASS |
| CR-2 migration 021 | 7/7 PASS |
| CR-2 AgentTurnRepository | 14/14 PASS |
| Full Server first run (CR-1 head) | 2446 total, 2441 passed, 2 failed, 3 skipped |

The 2 server failures are pre-existing Windows `tar` environment issues in
`WorktreeArtifactService`, unrelated to Conversation Runtime.

## 5. What the merged slices provide

- **Contracts**: forward Conversation kinds (`direct`/`group`/`system`), status,
  reply modes, member roles/reply modes/statuses, message kinds and finality,
  Agent Turn statuses, streaming/idempotency/projection keys, bounded group
  budgets with fail-closed validation, archive/restore transitions, mention
  targets, and frozen boundary rules.
- **Persistence**: `cr_conversations`, `cr_conversation_members`, `cr_messages`,
  `cr_message_revisions` with transactional per-Conversation sequence, client
  idempotency, agent-sender binding, immutable message identity, and
  revision-appending edits. `ConversationRepository` covers
  create/read/archive/restore, members, message append, edits, and source-event
  lookup.

## 6. Remaining work

### CR-2 — Agent Turn records (MERGED)

- durable Agent Turn records (`created`/`streaming`/`final`/`failed`/`cancelled`) 鈥?done via migration 021 `cr_agent_turns`;
- link a Turn to its Conversation, Message, and optional Run 鈥?done via `task_id`/`run_id`/`source_message_id`;
- per-Turn bounded context reference 鈥?done via `context_snapshot_id`.

### CR-3 — Streaming checkpoints (NOT STARTED)

- durable ordered Message checkpoints with a monotonic cursor;
- retry-safe delta append, deduplication, and gap detection;
- reconnect replay from a durable cursor.

### CR-4 — Task/Run bridge + Event projection (NOT STARTED)

- explicit `create-task` and `start-run` operations from a Message;
- idempotent Runtime Event projection using `source_event_id` dedup;
- Persist-before-route enforcement.

### CR-5 — Bounded Group (NOT STARTED)

- durable group interaction budgets, stop, and loop guard;
- per-Agent isolated Memory Context;
- `@all` never authorizes parallel modification.

### CR-6 — History references (NOT STARTED)

- unified Agent History links across Conversation/Message/Task/Run/Memory/
  Artifact;
- search filters that never index secrets.

## 7. Non-goals (unchanged)

- infinite autonomous group chat;
- unbounded reply chains;
- parallel modifying Runs in one Workspace;
- Provider-native history as canonical History;
- visual workflow DAG editor;
- mobile-first parity.
