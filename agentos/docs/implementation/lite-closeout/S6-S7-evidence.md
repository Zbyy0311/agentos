# S6 compaction and S7 import implementation evidence

Requirements: LITE-07-105, LITE-07-106, LITE-07-108, LITE-09-104..110.
Authority: S6-compaction-authorization.md, S7-import-authorization.md. Base:
S5 head `7aedc907`. Migrations 029 (S6) and 030 (S7) are additive; 001–028 stay
unchanged.

## S6 — automatic bounded compaction

Persisted: `conversation_compaction_policies` (immutable `lite-v1` version with
0.70/0.50/8/2048/120000/1 and the 16384 fallback application budget) and
`conversation_compactions` (task lifecycle pending → running → published |
failed | retry-pending, durable lease, one running task per Conversation,
immutable identity, immutable published summary, immutable published Candidate
link).

Engine (`ConversationCompactionService`): threshold and budget evaluation over a
frozen history; provider-bound cap when known, otherwise the labelled lite-v1
fallback; budget composition, estimator version, source range/hash, prior
summary, provider snapshot identity, attempts and status are all persisted. The
summary call is a narrow injected port; a missing or failing channel fails
closed. Publish writes the summary, the review-required Candidate, the
`memory.compaction` Workspace Event and the task mutation in ONE transaction.
Retries stop at the frozen `maxAutomaticRetries`.

Context application (`applyCompactionSummary` + Turn driver): a published
summary replaces exactly the Messages it covers; the uncompressed tail keeps its
order and content; summary + tail beyond the hard budget fail closed with
`TURN_DRIVER_COMPACTION_BUDGET_EXCEEDED` before any Provider call and without
touching the Messages. The applied summary id is recorded in the Turn's frozen
context snapshot.

Inspector: `GET /conversations/:id/compactions` returns each task with its
budget composition, source range, provider identity, attempts, failures and the
published summary, plus the effective policy. Read-only.

## S7 — explicit Markdown import

Preview is read-only: UTF-8 only (a lossy decode is refused), ≤1 MiB, non-empty,
split by Markdown heading with oversized sections split further, bounded at 200
fragments / 8000 characters each. Confirm writes bounded review-required
Candidates (workspace scope, knowledge category, `imported-verified` authority,
`import` source = fragment hash), one immutable `memory_import_records` row per
fragment and one `memory.import` Workspace Event per fragment — all in one
transaction. The idempotency tuple is
`(workspace_id, source_hash, fragment_index, parser_version)`: a re-import
converges with no second Candidate or Event, while a changed source is a new
traceable version. The source file on disk is never touched.

Routes: `POST /memory/import/preview`, `POST /memory/import/confirm`,
`GET /memory/imports` under the existing workspace mount.

## Evidence

| Evidence | Result |
|---|---|
| S6 engine tests | 7 pass / 0 fail |
| S6 context-application tests | 4 pass / 0 fail |
| S6 repository tests | 3 pass / 0 fail |
| S6 Inspector route test | 1 pass / 0 fail |
| S7 service tests | 7 pass / 0 fail |
| S7 route test (preview → confirm → review queue → accept → Entry) | 2 pass / 0 fail |
| Migration 029/030 + registry regression | 154 pass / 1 skip / 0 fail |
| Identity/Workspace-event regression | 34 + 22 pass |
| Server typecheck | exit 0 |

Proven: above-trigger plans never touch the newest 8 Messages; the fallback
budget is labelled when no provider bound exists; publish is atomic (Event
failure rolls back Candidate and record); retries stop at the frozen limit;
oversized summaries are refused; re-import converges; source files keep their
bytes.

## Remaining (rows stay GAP)

- No production Provider summary invocation is wired yet: the engine takes an
  injected summarizer port, and the runtime composition does not yet supply a
  tool-free/write-denied Provider summary call. LITE-09-106/107 stay open.
- The automatic trigger is not yet scheduled on the Turn loop; today compaction
  runs when a caller (or a later slice) invokes the engine at a Turn boundary.
- S6/S7 rows keep their GAP state; no matrix state changes were made here.

