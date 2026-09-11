# Lite Fast Track — Progress Summary

Status: MERGED — P6/L1 + RECOVERY + MEMORY FOUNDATION + CONVERSATION RUNTIME (CR-0..CR-6) + UI FOUNDATION + DIRECT CONVERSATION UX + RUNTIME INSPECTOR + CONTROLLED GROUP UX + WORKFLOW TEMPLATES + AGENT HISTORY & SEARCH ALL MERGED (main @ b9da96b2) — DEFERRED NON-GOALS REMAIN DEFERRED

## 1. Purpose

One index of the Lite Fast-Track sequence from
`docs/Runtime-Specification lite/00-Vision.md` §13, its current evidence-backed
state, and the per-step tracking records. It does not claim implementation
beyond the merged evidence it cites.

## 2. Baseline

| Field | Value |
|---|---|
| Baseline | `origin-https/main @ 88c79869` (Merge PR #123) |
| Migration ledger | `001`–`023` present |
| Main CI | `e8f64b15` PR CI run `34560421871` conclusion `success` |

## 3. Fast-Track status

| Step | State | Evidence / tracking |
|---|---|---|
| P6 / Windows recovery correctness | **COMPLETE** | PR #63–#66; `P6-recovery-closeout.md` (PR #77) |
| Minimal Git Observation + Workspace single-writer rule | **COMPLETE** | PR #68–#76 (L1A–L1E) |
| Recovery closeout | **COMPLETE** | PR #77 |
| Memory Foundation | **PARTIAL (MF-0..MF-5 MERGED; MF-2 remainder open)** | MF-0..MF-4 (PR #79–#87), MF-5 events/emission/Run-injection/API/UI/Inspector (PR #89/#91/#92/#120/#122/#123); `MF-progress.md` |
| Conversation Runtime | **MERGED (CR-0..CR-6 complete)** | PR #95–#97, #105–#108; `CR-progress.md` |
| Polished UI Foundation | **MERGED (tokens + four-column shell)** | PR #100, #109; `WorkbenchShell.tsx` |
| Direct Conversation UX | **MERGED (routes, reply stream, client, view, controller, page)** | PR #110–#114 |
| Lite Runtime Inspector | **MERGED (projection + route + UI)** | PR #101, #115; `runtimeInspector.ts`, `RuntimeInspectorView.tsx` |
| Controlled Group Conversation | **PARTIAL (bounded routes + budget/stop/loop-guard view MERGED; speaker orchestration open)** | PR #116; `BoundedGroupView.tsx` |
| Workflow Templates | **MERGED (catalog + instantiation + durable Task/Run/Stage wiring)** | PR #99, #103, #117; `WF-templates-durable-wiring.md` |
| Agent History + Search | **MERGED (CR-6 read surface + search UI)** | PR #108, #118; `HistorySearchView.tsx` |

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
| MF-5 API routes + listForRun | 5/5 + 9/9 PASS |
| Full Server run (MF-5 API head) | 2590 total, 2583 passed, 4 failed (pre-existing Windows ENOTEMPTY teardowns), 3 skipped |
| MF-5 Candidate API + Inspector wiring | 21/21 focused PASS; full Server 2593/2586/4/3 |
| MF-5 UI | web 162/162 PASS; `next build` clean |

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

- **Memory Foundation**: MF-2 remainder — candidate generation triggers bound
  to meaningful transitions and near-duplicate FTS-similarity detection.
  Recorded gap: user-initiated conflict resolution and Candidate review do not
  emit canonical Memory Events because emission is Run-scoped; a
  Workspace-scoped memory Event context contract is not yet authorized.
- **Controlled Group Conversation**: speaker orchestration remains open; the
  bounded routes and the budget/stop/loop-guard view are merged (PR #116).

All other Fast-Track steps are MERGED per section 3; this section lists only
genuinely open work.

## 6. Non-goals (unchanged)

Provider Comparison, full Worktree Runtime, full Policy Runtime, advanced
Memory, and the full Workflow Editor remain **DEFERRED FULL-SCOPE**.
