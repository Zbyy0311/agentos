# Lite Fast Track — Progress Summary

Status: TRACKED — P6/L1 + RECOVERY + MEMORY FOUNDATION + CR-0..CR-2 + WORKFLOW TEMPLATES + UI FOUNDATION + RUNTIME INSPECTOR MERGED — CR-3 + CR-4 COMMITTED (1218a23b, PENDING REVIEW/MERGE) — REMAINING STEPS LISTED

## 1. Purpose

One index of the Lite Fast-Track sequence from
`docs/Runtime-Specification lite/00-Vision.md` §13, its current evidence-backed
state, and the per-step tracking records. It does not claim implementation
beyond the merged evidence it cites.

## 2. Baseline

| Field | Value |
|---|---|
| Baseline | `origin-https/main @ b9c38aa4` (Merge PR #105) |
| Migration ledger | `001`–`021` present |
| Main CI | Post-merge runs through `6e42ce4e` conclusion `success`; `1af40ebe` in progress at record time |

## 3. Fast-Track status

| Step | State | Evidence / tracking |
|---|---|---|
| P6 / Windows recovery correctness | **COMPLETE** | PR #63–#66; `P6-recovery-closeout.md` (PR #77) |
| Minimal Git Observation + Workspace single-writer rule | **COMPLETE** | PR #68–#76 (L1A–L1E) |
| Recovery closeout | **COMPLETE** | PR #77 |
| Memory Foundation | **PARTIAL (core MERGED)** | MF-0..MF-4 (PR #79–#87), MF-5 events/emission/Run-injection (PR #89/#91/#92); `MF-progress.md` |
| Conversation Runtime | **CR-0..CR-2 MERGED; CR-3..CR-6 IN PRs #106–#108 (stacked)** | PR #95–#97, #105–#108; `CR-progress.md` |
| Polished UI Foundation | **PARTIAL (tokens MERGED; four-column shell IMPLEMENTED)** | PR #100; `WorkbenchShell.tsx` |
| Direct Conversation UX | **NOT STARTED** | — |
| Lite Runtime Inspector | **PARTIAL (projection MERGED)** | PR #101; UI surface still open |
| Controlled Group Conversation | **NOT STARTED** | — |
| Workflow Templates | **PARTIAL (catalog + instantiation MERGED)** | PR #99, PR #103; durable Task/Run/Stage wiring still open |
| Agent History + Search | **NOT STARTED** | — |

## 4. Merged evidence (this workstream)

| Suite | Result |
|---|---|
| MF-5 emitter | 10/10 PASS |
| MF-4 Run-startup resolver | 10/10 PASS |
| Dispatcher MF-4 integration gates | 3/3 PASS |
| CR-0 contracts | 10/10 PASS |
| CR-1 migration + repository | 11/11 + 15/15 PASS |
| Workflow Templates | 13/13 PASS |
| Workflow Template instantiation | 10/10 PASS |
| UI Foundation tokens | 13/13 PASS (includes 4.5:1 contrast gate) |
| Runtime Inspector | 11/11 PASS |
| UI shell (foundation + component) | 15/15 + 9/9 PASS (110/110 full web suite) |
| Full Server first run (Inspector head) | 2457 total, 2452 passed, 2 failed, 3 skipped |
| Full web test suite (UI Foundation head) | 99/99 PASS |

The 2 server failures are pre-existing Windows `tar` environment issues in
`WorktreeArtifactService`, unrelated to the Lite work. First runs were
preserved; no rerun-to-green was used.

CR-3/CR-4a evidence (commit 1218a23b, not merged): streaming seam 20/20, bridge 14/14, ConversationRepository
15/15, AgentTurnRepository 14/14, CR-0 contracts 11/11 (including CR0-11), Identity
prefixes 34/34. See `CR3-streaming-contract.md`.

CR-4a (explicit Task/Run bridge) adds 14/14 and the frozen full Server run now reads
2512 total, 2505 passed, 4 failed (same pre-existing Windows ENOTEMPTY teardowns),
3 skipped. See `CR4-schema-authorization.md`.

CR-4b adds migration 022 with 8/8 schema-acceptance tests and 10/10 projection tests;
the full Server suite for that revision is recorded in `CR4-schema-authorization.md`.

## 5. Remaining work

- **Memory Foundation**: MF-5 Memory/Context Snapshot APIs, UI Memory
  explanation, Inspector memory view.
- **Conversation Runtime**: CR-3 streaming checkpoints, CR-4a explicit Task/Run
  bridge, and CR-4b idempotent Event projection (migration 022) are committed on
  `runtime/cr3-cr4-conversation-runtime` (`1218a23b`) and await review/merge; CR-5
  bounded Group (budgets/stop/loop guard + per-Agent context, migration 023) is
  committed on `runtime/cr5-bounded-group` (PR #107, stacked); CR-6 history is
  implemented on `runtime/cr6-history` (PR #108, stacked) — a read surface over
  existing durable tables, no migration. Conversation Runtime is complete pending
  review/merge of PRs #106–#108.
- **Polished UI Foundation**: the four-column shell consuming the token system is
  implemented (`WorkbenchShell.tsx` + `uiCssVariables`/`columnWidthPx`), with adaptive
  collapse, reduced-motion, and client-only panel state; data wiring stays with the
  Direct Conversation UX step.
- **Direct Conversation UX**, **Controlled Group Conversation**,
  **Agent History + Search**: not started.
- **Workflow Templates**: wire the compiled definition into durable Task/Run/Stage creation.
- **Runtime Inspector**: API route and UI surface over the merged projection.

## 6. Non-goals (unchanged)

Provider Comparison, full Worktree Runtime, full Policy Runtime, advanced
Memory, and the full Workflow Editor remain **DEFERRED FULL-SCOPE**.
