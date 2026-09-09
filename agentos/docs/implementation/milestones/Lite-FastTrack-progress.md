# Lite Fast Track — Progress Summary

Status: TRACKED — P6/L1 + RECOVERY + MEMORY FOUNDATION + CR-0/CR-1 + WORKFLOW TEMPLATES + UI FOUNDATION + RUNTIME INSPECTOR MERGED — REMAINING STEPS LISTED

## 1. Purpose

One index of the Lite Fast-Track sequence from
`docs/Runtime-Specification lite/00-Vision.md` §13, its current evidence-backed
state, and the per-step tracking records. It does not claim implementation
beyond the merged evidence it cites.

## 2. Baseline

| Field | Value |
|---|---|
| Baseline | `origin-https/main @ 1af40ebe` (Merge PR #103) |
| Migration ledger | `001`–`020` present; `021` absent |
| Main CI | Post-merge runs through `6e42ce4e` conclusion `success`; `1af40ebe` in progress at record time |

## 3. Fast-Track status

| Step | State | Evidence / tracking |
|---|---|---|
| P6 / Windows recovery correctness | **COMPLETE** | PR #63–#66; `P6-recovery-closeout.md` (PR #77) |
| Minimal Git Observation + Workspace single-writer rule | **COMPLETE** | PR #68–#76 (L1A–L1E) |
| Recovery closeout | **COMPLETE** | PR #77 |
| Memory Foundation | **PARTIAL (core MERGED)** | MF-0..MF-4 (PR #79–#87), MF-5 events/emission/Run-injection (PR #89/#91/#92); `MF-progress.md` |
| Conversation Runtime | **PARTIAL (CR-0/CR-1 MERGED)** | PR #95–#97; `CR-progress.md` |
| Polished UI Foundation | **PARTIAL (tokens MERGED)** | PR #100; four-column shell still open |
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
| Full Server first run (Inspector head) | 2457 total, 2452 passed, 2 failed, 3 skipped |
| Full web test suite (UI Foundation head) | 99/99 PASS |

The 2 server failures are pre-existing Windows `tar` environment issues in
`WorktreeArtifactService`, unrelated to the Lite work. First runs were
preserved; no rerun-to-green was used.

## 5. Remaining work

- **Memory Foundation**: MF-5 Memory/Context Snapshot APIs, UI Memory
  explanation, Inspector memory view.
- **Conversation Runtime**: CR-2 Agent Turns, CR-3 streaming checkpoints,
  CR-4 Task/Run bridge + Event projection, CR-5 bounded Group, CR-6 history.
- **Polished UI Foundation**: the four-column shell consuming the token system.
- **Direct Conversation UX**, **Controlled Group Conversation**,
  **Agent History + Search**: not started.
- **Workflow Templates**: wire the compiled definition into durable Task/Run/Stage creation.
- **Runtime Inspector**: API route and UI surface over the merged projection.

## 6. Non-goals (unchanged)

Provider Comparison, full Worktree Runtime, full Policy Runtime, advanced
Memory, and the full Workflow Editor remain **DEFERRED FULL-SCOPE**.
