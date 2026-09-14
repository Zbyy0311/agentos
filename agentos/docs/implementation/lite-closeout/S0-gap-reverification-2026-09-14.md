# GAP re-verification on main 07c1773a — 2026-09-14

Read-only audit. It changes no matrix state and claims no PASS: the PASS freeze is
still in force, so every row below keeps the state the matrix already holds.
Purpose: determine which of the 26 GAP rows still describe a real defect on current
main and which are pre-implementation classifications that later slices fixed.

Baseline: main `07c1773ad108c066262753492ba2767bb3fc62d8`, matrix v15
(PASS 0 / GAP 26 / RUNTIME-VERIFY 205 / DEFERRED 164).

## Why this audit was needed

`LITE-13-101`'s recorded finding ("no compaction projection") had been written before the
S6 code landed but turned out to be a real, if narrower, defect. The opposite is true for
other rows: their findings name symbols and line numbers that no longer exist, because the
S1/S5/S6/S7 slices rewritten them. Implementing a row whose defect is already fixed would
be wasted work and would misreport the closeout state, so each row is checked against the
code that main actually ships.

## Verdicts

| Row | Recorded defect | Current main | Verdict |
|---|---|---|---|
| LITE-07-003 | hash lookup ignores Scope/owner/status; an exact terminal hit returns early and drops the new source | `MemoryCandidateGenerationService` dedups inside a `{scope, ownerTaskId, category}` boundary and calls `mergeExactSourcesWithinTransaction` on an exact hit | STALE - fixed |
| LITE-07-007 | `applyBudget` ignores `requireDiversity`; scope exclusion mislabelled `category-budget`; token cost excludes the heading | `injectedEntryText`/`estimateInjectedTokens` price the injected text; two-pass diversity; `scope-excluded` reason | STALE - fixed |
| LITE-07-013 | selector calls `retrieve`, dropping `retrieveWithStatus().degraded` | `ChatMemorySelectionPort` reads `degraded`; `retrieval_degraded` is persisted on the snapshot | STALE - fixed |
| LITE-07-102 | only the successful final Run triggers generation; non-success, standalone Stages and the crash window are uncovered | the service treats failed/cancelled Runs as terminal too (category `failure`) with a find-before-create guard | STALE - fixed |
| LITE-07-103 | accepted approval decision is an independent entry point | `runtimeApprovals` route + `RuntimeApprovalGate` + `approval.resolved` candidate event | code present - acceptance pending |
| LITE-07-104 | only merge authorization; no real source or event | `ArtifactCompletionService`, `CanonicalArtifactResultService`, `RuntimeArtifactCollector` and the completion route | code present - acceptance pending |
| LITE-07-105 | no canonical compaction task, summary, policy or production chain | migration 029 tables, trigger, engine and publish path | STALE - fixed |
| LITE-07-106 | import forces `memory:false`; no forward Memory import entry | `MemoryImportService` plus `/memory/import/preview|confirm` and `/memory/imports` | STALE - fixed |
| LITE-07-107 | dedup not isolated by Scope/owner/category/active; no source merge, version, Event or Outbox on an exact hit | same dedup boundary plus `mergeExactSourcesWithinTransaction` and the emitter path | STALE - fixed |
| LITE-07-108 | the allowlist has no `candidate_created` origin | `WorkspaceEventWriter` accepts `memory.artifact_completion`, `memory.compaction`, `memory.import`, `memory.candidate_review`, `memory.conflict_resolution`, `memory.entry_save` | STALE - fixed |
| LITE-07-109 | no `validFrom`/`validUntil`/`expiresAt`/`sensitivity` filtering | `MemoryRetrievalService` filters sensitivity and both validity windows | STALE - fixed |
| LITE-08-005 | ASK_USER persistence/continuation pending live acceptance | pre-spawn durable gate and original-Run continuation present | code present - acceptance pending |
| LITE-08-006 | concurrent approve/reject pending live evidence | version CAS replay and route retry convergence tested | code present - acceptance pending |
| LITE-08-007 | stale/expired approval pending live acceptance | durable expiry plus launch-plan/agent/provider snapshot hash drift refusal | code present - acceptance pending |
| LITE-09-010 | mention, @all, sequential and parallel-read-only follow admission/Policy unproven | `GroupSpeakerResolver` implements eligibility, mention precedence, mode and read-only intent | partly stale - needs executed acceptance |
| LITE-09-013 | per-agent snapshots are recorded only after the Provider reply | every speaker goes through `ConversationTurnDriver.replyWithTurn`, whose snapshot write precedes Provider work, and the group driver keys each speaker by its own `agentId`/`turnId` | STALE - fixed |
| LITE-09-101 | snapshot created at `recordReply`, after the Provider was already called | the driver persists the frozen selection before any Provider work and injects that same selection | STALE - fixed |
| LITE-09-102 | one interaction's serial execution does not prove Workspace authority | the driver refuses with `CONVERSATION_WORKSPACE_MODIFYING_BUSY` via the Workspace modifying holder | STALE - fixed |
| LITE-09-104 | no persistent policy or budget evaluation | immutable `lite-v1` policy row and frozen `budget_json` per task | STALE - fixed |
| LITE-09-105 | no canonical summary or source range | published summary with source start/end ids, count and hash | STALE - fixed |
| LITE-09-106 | no tool-free/write-denied summary execution evidence | `ProviderCompactionSummarizer` refuses any profile without the CLI-level read-only pair; abort on first tool/approval event | STALE - fixed |
| LITE-09-107 | no compaction recovery state | durable lease, one-running partial unique index, `retry-pending` and bounded attempts | STALE - fixed |
| LITE-09-108 | no hard-budget gate | `applyCompactionSummary` returns `over-budget`, the driver blocks the Provider call and the retry route is explicit | STALE - fixed |
| LITE-09-109 | no source revision validation for the summary | the covered range is validated against count and content hash before the summary may stand in | STALE - fixed |
| LITE-09-110 | the provider-native boundary must be stated | no assertion or artifact enforces or demonstrates it; only the S6 authorization prose mentions it | OPEN - real remaining gap |
| LITE-13-101 | no compaction projection | closed by the companion slice (PR #171): shared read model, Run-scoped projection, web section | FIXED by #171 |

## What this changes about the remaining work

1. The GAP set is mostly a classification lag, not 25 open implementations. Only
   `LITE-09-110` still needs an implementation or evidence artifact, and
   `LITE-09-010` needs executed acceptance rather than new code here.
2. The rest of the GAP rows are blocked on **executed acceptance** (live Provider and
   browser paths), not on product code. That acceptance is what a promotion review has to
   read, so it should be produced as its own evidence packs rather than inferred from
   source.
3. Because the freeze forbids state changes, these verdicts are recorded as audit tracing
   only. Reclassifying any row requires the user to unfreeze promotion first.

## Method and limits

Each verdict cites a symbol that exists on the audited baseline and was read directly
(grep plus file read). This is source reading, not execution: it can show that a defect is
gone and that a test or route exists, but it cannot show that the behaviour holds at
runtime. No verdict here is PASS evidence, and none of the S2/S3/S4/S5 rows are promoted on
the strength of this audit.

