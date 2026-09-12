# S9 handoff: where the Lite closeout actually stands

Written when the session had to stop (VPN down, so no further push was possible).
Everything below is a statement about a specific commit or a specific command
result, not about intent. Read `S9-closeout-plan.md` in the same directory for the
merge order and the union rule.

## 1. Authoritative state

`origin-https/main` = `fa386ca2` (Merge PR #152). Its matrix is version 11:
PASS 12, GAP 28, RUNTIME-VERIFY 191, DEFERRED 164. The merged work is far ahead of
what main's matrix records - see section 3.

Merged PRs (in order): #142, #143, #144, #145, #146, #147, #148, #151, #152.

Open PRs:

| PR | Branch | State | Note |
|---|---|---|---|
| #150 | `codex/lite-s8-acceptance` | OPEN, DIRTY | only `matrix.json` conflicts with main; `evidence.json` auto-merges |
| #149 | `codex/lite-s6-compaction` | OPEN, UNSTABLE | CI run 34711361587 pending at handoff |
| #153 | `codex/lite-s1-terminal` | OPEN, UNSTABLE | CI run 34709439210 pending at handoff |
| #45 | `diag/r38-r39-crash-release-timing` | OPEN | diagnostic only, unrelated |

## 2. Branches that exist only locally (NOT pushed)

Push failed with `Failed to connect to github.com port 443`; the commits are safe
on disk and are the first thing to publish when the network returns.

| Worktree | Branch | Commit | What it is |
|---|---|---|---|
| `agentos-lite-mf4-stage-event` | `codex/lite-mf4-stage-event` | `f89e0296` | production defect fix (section 4) |
| `agentos-lite-s9-closeout` | `codex/lite-s9-closeout` | `0b2ac54c` | the S9 plan and this handoff |
| `agentos-lite-s2-live-artifact` | `codex/lite-s2-live-artifact` | `d59109da` plus untracked `apps/server/scripts/` | the LITE-07-104 live gate driver (section 5) |

Already pushed but unmerged: `codex/lite-s8-verification` `f4a54282` (the last
eight RUNTIME-VERIFY promotions and its script), and `codex/lite-s7-import`
`c2e6b38e` (the S7 implementation, stacked on S6).

## 3. Rows whose work is already in main and only need the matrix promoted

These are not new work. Each needs an `evidence.json` entry with an executed
result at the merge commit, then the row state changed to PASS. Verified present in
`origin-https/main`:

| Row | Proof already in main |
|---|---|
| LITE-07-007 | `MemoryContextBudgetSelector.ts` carries `estimateInjectedTokens`, `scope-excluded` and the diversity pass (from #152), and its test file is in main too |
| LITE-07-003, LITE-07-107 | `MemoryCandidateGenerationService.test.ts` carries the `LITE-07-003 LITE-07-107 terminal dedup ignores ...` cases plus the `LITE-07-107 exact terminal dedup ...` case |
| LITE-07-109 (partial) | `MemoryRetrievalService.ts` carries `isEligibleAt` (validity and sensitivity) from #151, but the row also covers FTS degradation, which is not done, so the row stays open (section 6) |
| LITE-09-101, LITE-09-102 (partial) | `ConversationTurnDriver.ts` carries `CONTEXT_SNAPSHOT_FAILED` and `CONVERSATION_WORKSPACE_MODIFYING_BUSY` from #148, but see section 6 for what their exits still demand |

## 4. The production defect fixed locally but not yet pushed

`f89e0296`: every MF-5 memory Event definition sets `forbidsStageId: true`, and
`MemoryRuntimeEventEmitter.resolveScope()` still forwarded the caller's `stageId`
into the Event envelope. The production dispatcher passes `stage.id` whenever it
resolves a Stage's memory context, so a stage-scoped memory resolve could never
emit its Event:

```
RuntimeEventRegistryError: Runtime Event does not allow an envelope stageId: memory.context_created
  -> MemoryRuntimeEventEmissionError MEMORY_EVENT_EMISSION_FAILED
  -> MemoryContextResolverError MEMORY_CONTEXT_RESOLVER_SNAPSHOT_FAILED
  -> the Stage is never dispatched
```

No existing test caught it: the dispatcher's MF-4 integration test injects a stub
resolver port, so the real resolver and the real emitter never met a real stageId.
The fix keeps `stageId` out of `RunScope` and out of the appended envelope (the
Stage association lives on `memory_context_snapshots.stage_id`, reachable from the
payload's `memoryContextId`), and adds regression test `MF5R-06`, which runs the
real resolver against the real emitter and the durable authority with a stage id
and asserts both halves. Verified there: `MemoryContextResolver.emission` 6/6,
plus emitter, resolver and dispatcher 67 pass / 0 fail / 2 env-gated skips.

## 5. LITE-07-104: the live gate driver works, and what it proved

`apps/server/scripts/live-artifact-gate.mjs` seeds a Workspace, Task, Run,
Operation, the frozen legacy-pipeline v2 snapshot and a Stage, then drives the
canonical production composition root (`createProviderExecutionChain`) with a real
CLI provider at a real file. Run it with:

```
cd apps/server
AGENTOS_OPENCODE_CLI=... AGENTOS_OPENCODE_MODEL=deepseek/deepseek-v4-flash \
  node --import tsx scripts/live-artifact-gate.mjs
```

What it already proved: a real model, given the production artifact-result
instruction, returns a valid contract payload after actually executing node on the
file under review - `{"agentosArtifact":{"version":1,"type":"review","conclusion":"changes_requested","summary":"..."}}`
- and `parseArtifactResult` accepts it. On a tree that also carries #150's adapter
fix it should drive Artifact to completion to Candidate end to end; on plain main
it stops at `PROVIDER_VERSION_UNSUPPORTED`, which is #150's work rather than a new
gap.

The script is deliberately untracked: it is a gate driver, not product code, and
it should be committed as a gate (or folded into the env-gated suite) once the
provider story is settled.

## 6. Rows that still need real work

| Row | What is genuinely missing |
|---|---|
| LITE-07-013 | the selector calls `retrieve`, which discards `retrieveWithStatus().degraded`, and the snapshot payload has nowhere to persist it: needs migration 031 (030 must land first from S7) or a contract decision |
| LITE-07-108 | canonical `candidate_created` causality for the approval origin (compaction and import arrive with S6 and S7); the Workspace event allowlist is a shared file |
| LITE-07-104 | the live gate above, run on a tree containing #150 |
| LITE-08-005/006/007, LITE-07-103 | live-Provider approval evidence; the in-process ask, approve and reject behaviour is asserted, but the exit asks for a real invocation |
| LITE-09-101 | a production Memory selection port for direct chat; today the selection is the empty selector |
| LITE-09-010, LITE-09-102 | a durable conversation-turn admission subject so two simultaneous chat Turns in one Workspace are mutually serialized: needs an authorized schema slice |
| LITE-09-013 | per-Agent isolation is frozen per Turn; the exit needs its evidence re-checked against the clause |
| LITE-09-109 | compaction summary source validation against the existing Message revision and visibility rules |
| LITE-04-101 | a CI-executable real invocation, or a user-approved reclassification. Local runs cannot carry it: the provider CLIs exist only on this machine, so CI cannot recompute them |

## 7. Projected end state with union resolution

Dry run of the union tool over main, #150, #149, #153 and the S8 verification
branch gives matrixVersion 18, PASS 204, RUNTIME-VERIFY 9, GAP 18, DEFERRED 164,
and passes the CI gate rules with 0 violations across all 204 PASS rows.
`node scripts/union-closeout.mjs <matrix|evidence> <ours> <theirs> <out> [reason]`
implements the resolution; in a conflicted merge ours is `git show :2:<path>` and
theirs is `:3:`. It deliberately does not union evidence across sides when the
winner is PASS, because the gate requires every cited entry to carry an executed
result mapped to that exact requirement.

## 8. Resume checklist

1. Restore the network, then push `codex/lite-mf4-stage-event` and
   `codex/lite-s9-closeout`; decide whether the S2 gate driver ships with
   `codex/lite-s2-live-artifact`.
2. Open a PR for the `f89e0296` fix first: it is a production defect.
3. Merge #150 after resolving its `matrix.json` conflict with the union tool, then
   #149 (its conflict is already resolved and pushed) and #153 once CI is green.
4. Rebase `codex/lite-s8-verification` on the new main, run
   `node docs/implementation/lite-closeout/apply-s8-final-rv.mjs <main-sha>`, then
   open its PR.
5. Promote the section 3 rows (evidence entry plus state) in one closeout PR.
6. Only then start section 6.

## 9. Housekeeping

- An earlier turn printed the value of the `AGENTOS_KIMI_API_KEY` environment
  variable into this session's transcript. Treat that key as exposed and rotate it.
- A diagnostic temp root was left behind and its deletion was blocked by policy:
  `C:\Users\Administrator\AppData\Local\Temp\agentos-m4-p4-real-78aQMu`.
- Several `agentos-live-artifact-*` temp roots remain from failed live-gate runs;
  the script only cleans its root on success and prints `keepRoot` on failure.
