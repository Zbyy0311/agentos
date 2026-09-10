# Conversation Runtime — Progress and Remaining Work

Status: CR-0/CR-1/CR-2 MERGED — CR-3 + CR-4 IN PR #106; CR-5 IN PR #107 (stacked); CR-6 IN PR #108 (stacked) — CONVERSATION RUNTIME COMPLETE PENDING REVIEW/MERGE

## 1. Purpose

Tracks the Conversation Runtime slices defined by
`docs/implementation/milestones/CR-entry-audit.md`, so remaining work is legible
without re-auditing the repository.

## 2. Merged baseline

| Field | Value |
|---|---|
| Baseline | `origin-https/main @ b9c38aa4` (Merge PR #105, CR-2 Agent Turn persistence) |
| Migration ledger | `001`–`021` present |
| Main CI | Post-merge runs through PR #105 recorded at merge time; earlier CR-1 records remain in history |
| CR-3/CR-4 delivery | commit `1218a23b` on `runtime/cr3-cr4-conversation-runtime` (pushed; branched from `b9c38aa4`) |
| Prior gates | Workspace single-writer COMPLETE; Recovery closeout COMPLETE; Memory Foundation MF-0..MF-4 + MF-5 events/emission/Run-injection MERGED |

## 3. Slice status

| Slice | Scope | State | PR |
|---|---|---|---|
| CR-0 | Shared Conversation contracts | **MERGED** | #95 |
| CR-1 | Forward Conversation/Member/Message persistence (migration 020) | **MERGED** | #96 (auth), #97 (impl) |
| CR-2 | Message revisions + Agent Turn records (migration 021, AgentTurnRepository) | **MERGED** | (auth retro), (impl) |
| CR-3 | Durable streaming checkpoints + reconnect cursor | **COMMITTED** (`1218a23b`, pending review/merge) | `ConversationStreamService.ts` + `CR3-streaming-contract.md` |
| CR-4a | Explicit Task/Run bridge from a Message | **COMMITTED** (`1218a23b`, pending review/merge) | `ConversationBridgeService.ts`, `CR4-schema-authorization.md` |
| CR-4b | Idempotent Runtime Event projection (migration 022) | **COMMITTED** (`1218a23b`, pending review/merge) | `cr4-migration-022.test.ts`, `ConversationProjectionService.ts` |
| CR-5 | Bounded Group budgets/stop/loop guard + per-Agent context | **IN PR #107** (stacked on #106; migration 023) | `BoundedGroupService.ts`, `CR5-schema-authorization.md` |
| CR-6 | Archive/restore + history references | **IN PR #108** (history read surface; archive/restore merged in CR-1) | `AgentHistoryService.ts` |

## 4. Merged evidence

| Suite | Result |
|---|---|
| CR-0 contracts | 10/10 PASS |
| CR-1 migration 020 | 11/11 PASS |
| CR-1 ConversationRepository | 15/15 PASS |
| CR-2 migration 021 | 7/7 PASS |
| CR-2 AgentTurnRepository | 14/14 PASS |
| Full Server first run (CR-1 head) | 2446 total, 2441 passed, 2 failed, 3 skipped |

CR-3/CR-4 evidence at commit `1218a23b` (not merged — `docs/implementation/milestones/CR3-streaming-contract.md`):

| Suite | Result |
|---|---|
| CR-3 streaming seam | 20/20 PASS |
| CR-4a Task/Run bridge | 14/14 PASS |
| Migration 022 schema | 8/8 PASS |
| Conversation projection | 10/10 PASS |
| CR-5 migration 023 schema | 8/8 PASS |
| CR-5 bounded group | 17/17 PASS |
| Full Server run (CR-5 tree, hash-frozen) | 2555 total, 2548 passed, 4 failed, 3 skipped |
| CR-6 history read surface | 7/7 PASS |
| Full Server run (CR-6 tree, hash-frozen) | 2562 total, 2555 passed, 4 failed, 3 skipped |

Forward HTTP surface (this workstream, on top of CR-6): the `conversationRuntime`
router is wired through `SqliteStore` and covers Lite 11 section 10 endpoints
(create/list/get/archive/restore, members, turns, messages, checkpoint replay,
create-task/start-run, history). Route tests 6/6 PASS.

Frozen full Server run over the route tree: 2568 total, 2561 passed, 4 failed
(same pre-existing Windows ENOTEMPTY teardowns), 3 skipped. PR #110.

Reply-stream revision (ConversationTurnDriver + messages/stream): frozen full Server
run 2575 total, 2568 passed, 4 failed (same ENOTEMPTY class), 3 skipped.

The four failures are the same pre-existing Windows `ENOTEMPTY` teardown races; no
CR test failed at any CR-3..CR-6 revision.
| CR-1 ConversationRepository (refactored seams) | 15/15 PASS |
| CR-2 AgentTurnRepository (refactored seams) | 14/14 PASS |
| CR-0 contracts including CR0-11 | 11/11 PASS |
| Identity prefixes including checkpoint | 34/34 PASS |
| Full Server run (CR-3 working tree, hash-frozen) | 2498 total, 2491 passed, 4 failed, 3 skipped |
| Full Server run (CR-4a working tree, hash-frozen) | 2512 total, 2505 passed, 4 failed, 3 skipped |
| Full Server run (CR-3 + CR-4 tree, hash-frozen) | 2530 total, 2523 passed, 4 failed, 3 skipped |

All four failures are the pre-existing Windows `ENOTEMPTY` temp-directory teardown
races (`routes/worktrees.test.ts` x2, `services/ConversationService.test.ts`
parallel_isolated, `services/LegacyTaskItemImportService.test.ts` M27-P3-T005); none
implicates CR-3 behavior. The code tree was hash-frozen across the run (HEAD
`b9c38aa4` unchanged, source hashes equal before and after). An earlier run taken
while the ownership fix was still being written additionally reported 2
environmental `fetch failed / bad port` failures in `routes/taskPipelineBridge.test.ts`
(an ephemeral port inside undici's blocked-port list); the frozen runs did not
reproduce that class. First-run failures are preserved; no rerun-to-green.

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

### CR-3 — Streaming checkpoints (IMPLEMENTED, commit 1218a23b, pending review/merge)

- durable ordered Message checkpoints with a monotonic cursor — done via
  `ConversationStreamService` (cursor === ordinal, contiguous per Message and per Turn);
- retry-safe delta append, deduplication, and gap detection — done via ordinal
  convergence, conflict, gap, and stale rules frozen in `CR3-streaming-contract.md`;
- reconnect replay from a durable cursor — done via `replayStream` (contiguous
  window, current Message/Turn state, fail-closed on durable loss);
- no schema change: migration 021 already provides `cr_message_checkpoints`.

### CR-4 — Task/Run bridge + Event projection (IMPLEMENTED, commit 1218a23b)

- explicit `create-task` and `start-run` operations from a Message;
- idempotent Runtime Event projection using `source_event_id` dedup;
- Persist-before-route enforcement.

The frozen design for this slice, with the read-only audit evidence behind it, is
`CR4-schema-authorization.md`. It splits the slice into a schema-free bridge
(CR-4a: the canonical `runs.task_id` is NOT NULL and `runs.origin` is CHECK-limited,
so start-Run resolves the Message's Task first and never invents a new origin value)
and migration 022 (CR-4b: `cr_message_projections` with `UNIQUE (projector_id,
source_event_id)` as the durable form of `projectionKeyId()`). Implementation does
not start until the owner authorizes the migration number, the start-Run Task
resolution, and the projector identity set.

### CR-5 — Bounded Group (NOT STARTED)

- durable group interaction budgets, stop, and loop guard;
- per-Agent isolated Memory Context;
- `@all` never authorizes parallel modification.

### CR-6 — History references (IMPLEMENTED — no migration; read surface over existing durable tables)

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
