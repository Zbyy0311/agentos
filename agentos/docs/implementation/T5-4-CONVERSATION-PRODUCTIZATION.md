# T5-4 Conversation Productization — local delivery

Date: 2026-10-22. Worktree: `E:\workspace\Multi-Agent-worktrees\agentos-t5-conversation-product\agentos`.
Branch: `codex/conversation-productization`. Starting checkpoint: `fe02402ad967f5e39483b6b1729fbe5b2600c116`, based on `ae97eaf85ad569a50944b1e33e7fbb081c1e5cbc`.

## Scope and production coverage

| Contract | Delivered behavior | Production write/read path and acceptance |
| --- | --- | --- |
| 09 §64–66; 10 §68; 11 §135 | Deterministic Summary, manual or 50 uncovered nondeleted messages; immutable supersedes chain; list/latest | `ConversationRepository` append/finalization → `ConversationSummaryService`; real stream finalization, source references, deletion gaps, restart and HTTP tests |
| 09 §73–74 | `mention`, `agent-reply`, `run-completed`, `approval`; per workspace/user/conversation/type/source deduplication; list/read/dismiss | Message append/finalization, `RuntimeEventRepository` registered event projection, and `RuntimeApprovalRepository` creation; all four sources verified through HTTP and SSE |
| 09 §71; 10 §69; 11 §133 | Server-authoritative pending approvalCount | Read-state single/batch/mark-read routes; live pending/unexpired requests, old NULL bindings, Run Message/Turn/Task source/Task references, unresolved and expired cases |
| 09 §84/89/119; 11 §157 (T5-4 subset) | Durable product events and workspace compatibility SSE | Source fact + `conversation_events` commit together; cursor replay, live polling, user/workspace isolation and injected event-failure rollback |

Summary uses literal extraction and bounded excerpts without an LLM. It stores decisions, constraints, openQuestions, Task/Run references, sourceMessageIds and generatedAt. Each version covers the next uncovered message range; the full history remains navigable through supersedesSummaryId. No new uncovered messages yields an idempotent no-op. An active streaming Message blocks manual publication (409) and defers the automatic trigger. Summary storage is separate from existing Compaction storage and its context-adoption semantics.

Both committed final appends and status transitions to final invoke productization. This covers ordinary messages, projected cards, and `ConversationStreamService` completion through one repository seam. An unfinished/failed stream produces no Agent reply notification; a system card is not an Agent reply. Payloads and Summary text are redacted before persistence.

An approval creation immediately persists its notification in the same transaction, before `approval.required` needs to be linked. Approval decisions/expiry append read-state invalidation events. Notification read/dismiss does not resolve an approval. Status changes are monotone (`unread → read → dismissed`, or `unread → dismissed`), repeated requests converge and preserve readAt.

Run associations are re-read from durable forward Messages, Turns, Runtime Events, Task source and Task-referencing Messages, with Workspace joins. The optional approval conversation_id is an additional binding, not the sole source of truth. This permits real counts for pre-067 NULL bindings; only genuinely unresolved or nonpending/expired requests contribute zero. Multiple associations count a request once per represented Conversation.

## HTTP surface

All paths below mount under `/api/workspaces/:workspaceId/runtime` using the existing Conversation router.

| Method | Path |
| --- | --- |
| GET | `/conversations/:conversationId/summaries` |
| GET | `/conversations/:conversationId/summaries/latest` |
| POST | `/conversations/:conversationId/summaries` |
| GET | `/conversations/notifications?conversationId=&status=&userId=` |
| POST | `/conversations/notifications/:notificationId/read` |
| POST | `/conversations/notifications/:notificationId/dismiss` |
| GET | `/conversations/:conversationId/read-state` and `/conversations/read-state` |
| POST | `/conversations/:conversationId/read` |
| GET | `/conversations/:conversationId/stream` |

The local user defaults to the existing `default` profile; explicit userId retains the router's existing local profile-selection contract. Filtering by user is not a new authentication system.

## Event and parent integration contract

067 owns `conversation_events`: public canonical `evt_` id, monotonically increasing `sequence`, workspace_id, conversation_id, nullable user_id, type, dedupe_key, payload_json, timestamp. Rows are immutable on UPDATE. A shared event has NULL user_id; notifications and read-state updates retain their user_id. The durable ID, owner and source row must remain available to the parent's reference-only projection.

Product types:

```text
conversation.summary_created
conversation.summary_superseded
conversation.notification_created
conversation.notification_updated
conversation.read_state_updated
```

Compatibility SSE maps Summary events to `conversation-updated`, notification events to `notification`, and read-state events to `read-state-updated`. Data carries `{id, sequence, workspaceId, conversationId, userId, type, payload, timestamp}`. Replay accepts Last-Event-ID or afterCursor (also afterRuntimeEventSequence as a compatibility alias); its cursor belongs to this Conversation product journal, independently of canonical Run sequences. Reads use committed SQLite pages of 100, poll at 250 ms, honor write backpressure, heartbeat at 15 s, and remove timers on disconnect.

The parent T5-11 task owns migration 073, global `/api/conversations/:id/stream`, WS, common projection/cursors and the complete 157 transport contract. This branch supplies canonical product facts and its workspace compatibility endpoint only. Parent integration should route that endpoint through the common projection while retaining 067 event identities and user metadata. No 073 file or parent-tree file was edited here.

## Migrations and integration limits

067 remains `conversation-summaries-notifications`; no migration number was reassigned. It adds Summary/Notification/product-event tables and nullable approval conversation_id. Chain triggers reject missing/cross-Conversation/skipped predecessor links and UPDATEs. Fresh install, supported full-registry upgrade, direct 065→067 upgrade preserving Messages/read positions/approvals, repeat apply, prerequisites, foreign keys and integrity are covered.

The parent rebased this implementation onto main `ed09913b5d723b7bbe87750a038cc45307f9a3c5` on 2026-10-23. The registry retains 001–067, including 065 system tables, 066 validation cache and 067 productization; Identity retains all 42 kinds, including the cache identity and `conversationSummary: csum` / `conversationNotification: cnot`. The 068 scheduling branch is independent and will be integrated after its own verified merge.

067 is still an unpublished branch migration, and its final schema/checksum differs from the interrupted checkpoint. Supported upgrade evidence starts before 067. A disposable database that recorded the old draft 067 checksum requires explicit reconciliation; this work does not bypass MigrationRunner checksum validation or rewrite an existing migration ledger.

## Verification receipts

- Before repairs: existing ConversationProductization and all seven Conversation route files, 42 tests passed, 0 failed/skipped.
- Final focused product service/routes: 11 tests passed, 0 failed/skipped.
- Workspace dependency build: `pnpm --filter @agentos/server run build:workspace-deps`, exit 0.
- Server TypeScript: `pnpm --filter @agentos/server exec tsc --noEmit --incremental false`, exit 0.
- Expanded final regression: 25 files, 260 tests total; 259 passed, 0 failed, 1 opt-in real Provider gate skipped, 0 cancelled (123764.5026 ms). Includes the legacy/unresolved Conversation hint regression protecting canonical Run event persistence.

The expanded manifest contains 25 test files: registry and 063/067 migration checks; Identity/SqliteStore/Conversation/approval/event repositories and event redaction; Conversation productization/stream/projection/bridge/Compaction/Turn driver; all Conversation routes; approval routes and approval-gate audit/live-gate files. It runs from `apps/server`:

```powershell
$env:TEMP = (Resolve-Path ../../logs/t5-4/tmp).Path
$env:TMP = $env:TEMP
$taskTests = Get-Content ../../logs/t5-4/final-test-manifest.txt
node --import tsx --test --test-concurrency=1 @taskTests
```

Local receipts live under `logs/t5-4/` (Git-ignored): final-test-manifest.txt, tested-source-hashes.json, product-final-focused.log, final-regression.log, final-tsc.log and verification-summary.json. Earlier unsuccessful command/fixture runs remain distinguishable in separate logs. The opt-in real Provider approval gate requires `M4_P4_REAL_APPROVAL_GATE=1` and provider configuration; its skip must not be reported as real Provider success. Some existing negative-path tests deliberately print COMPACTION_SUMMARIZER_UNAVAILABLE; their pass/fail status is determined by the test assertions.

After main integration, the parent aligned migration/Identity contracts with
066+067 and retained the Summary safety contract's User/Agent source labels.
Windows on this host allocates ephemeral TCP ports in 1024–15000; a route fixture
hit a Fetch-restricted service port. Conversation/approval HTTP fixtures now use
the repository's existing `listenFetchSafe` helper without changing OS settings
or weakening any response assertion.

The final rebased 25-file gate passed **261 tests, 1 explicitly opt-in real
Provider test skipped, 0 failed** (262 total). Workspace dependencies and server
TypeScript build passed. Receipts are `conversation-final-verified.log` in the
parent task evidence directory. No GitHub merge or parent realtime/index
integration is implied by these local receipts.

After concurrency PR #232 merged as `653f8cfe`, this branch was rebased again,
retaining 065/066/067/068 in order and the exact registry/Identity assertions.
The combined Conversation gate plus owned-queue shutdown and concurrency
scheduler tests passed **280 tests, 1 configured Provider skip, 0 failures**
(281 total). Workspace dependencies and server TypeScript build passed again.
Receipts: `conversation-rebase653-tests.log` and
`conversation-rebase653-build.log`. The prior 20 successful PR checks belong to
`2776859a` before this integration; the new candidate requires new full CI.
