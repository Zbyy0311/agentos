# S9 closeout plan (working record)

Scope: the merge order, the matrix/evidence union rule, and the exact list of
rows still open at the moment this plan was written. It is a working record and is
updated with real SHAs as the merges land; the final report supersedes it.

## Branches in flight

| PR | Branch | Work package | Note |
|---|---|---|---|
| #148 | `codex/lite-s5-execution` | S5 | bounded context frozen before the Provider call, chat has no implicit modifying authority |
| #149 | `codex/lite-s6-compaction` | S6 | automatic compaction with real Provider summaries |
| #150 | `codex/lite-s8-acceptance` | S8 | OpenCode canonical chain, Inspector Provider surface, matrix v12 |
| #151 | `codex/lite-s1-retrieval` | S1 | temporal/sensitivity eligibility before ranking (LITE-07-109) |
| #152 | `codex/lite-s1-budget` | S1 | injected-text pricing, Scope attribution, diversity (LITE-07-007) |
| #153 | `codex/lite-s1-terminal` | S1 | every terminal Run outcome plus restart convergence (LITE-07-102) |
| (held) | `codex/lite-s8-verification` | S8 | promotion script + record for the last eight RUNTIME-VERIFY rows; waits for #150 |
| (held) | `codex/lite-s7-import` | S7 | explicit Markdown import; waits for #149 because it is stacked on S6-C |

## Merge order

1. **#148** (S5) — smallest, and #149 is stacked on S5's commits.
2. **#150** (S8 acceptance) — independent of S5/S6 code; brings the OpenCode chain and the Inspector surface.
3. **#149** (S6) — merge `main` into it first; it must take the union of both matrices.
4. **#151 / #152 / #153** (S1) — disjoint files, merge in any order after the union exists.
5. **`codex/lite-s8-verification`** — rebase onto the new main, run `apply-s8-final-rv.mjs <main-sha>`, then PR.
6. **`codex/lite-s7-import`** — rebase onto the new main (its S6-A/B/C commits are already ancestors), then PR with migration 030.

## Union rule for the shared closeout files

`matrix.json` and `evidence.json` are shared contracts, so a merge must never take
one side wholesale. Resolution is mechanical, not editorial:

- a row keeps the more advanced state (`PASS` > `RUNTIME-VERIFY` / `DEFERRED` > `GAP`);
- `tests`, `evidence` and `implementation` are the union of both sides;
- `changes` keeps both entries, deduplicated by version+reason, and a new entry
  records the merge with the resolved `matrixVersion`;
- `evidence.json` is unioned by id; a duplicate id keeps the version that carries a
  `result`.

`union-closeout.mjs` implements exactly this, so the resolution is reproducible and
reviewable rather than hand-edited inside conflict markers. Dry run against the
three in-flight matrices produced PASS 205 / RUNTIME-VERIFY 8 / GAP 18 / DEFERRED
164, which is the expected union of S8's 185 promotions and S6's 8.

## Rows open at this point (18 GAP + 8 RUNTIME-VERIFY)

Promotion-only once the branches above merge (work already exists, needs the
evidence pointer and executed counts):

| Row | Closed by |
|---|---|
| LITE-07-003, LITE-07-107 | executed tests already in main: exact/near-duplicate convergence, cross-Task/Scope/category/archived/deleted boundaries, dedup Event + Outbox, replay no-op, cross-Run refusal |
| LITE-07-007 | #152 |
| LITE-07-102 | #153 |
| LITE-07-106 | S7 branch |
| the eight RUNTIME-VERIFY rows | `codex/lite-s8-verification` |
| S6's nine rows | #149's own matrix promotions (union) |

Still needs implementation or live evidence:

| Row | What is missing |
|---|---|
| LITE-07-013, and the FTS half of LITE-07-109 | the selector still calls `retrieve`, which discards `retrieveWithStatus().degraded`, and the snapshot payload has no place to persist it: needs migration 031 (only free once 029/030 land) or a contract decision |
| LITE-07-108 | canonical `candidate_created` causality for the approval origin (compaction and import arrive with S6/S7); the Workspace event allowlist is a shared file |
| LITE-07-104 | live Provider invocation through the artifact chain. Prototype already proved a real OpenCode + DeepSeek run returns the canonical `agentosArtifact` review conclusion after actually executing node on the reviewed file |
| LITE-08-005, LITE-08-006, LITE-08-007, LITE-07-103 | live Provider approval evidence (the in-process ask/approve/reject behaviour is already asserted) |
| LITE-09-101 | a production Memory selection port for the direct chat path (today the selection is the empty selector) |
| LITE-09-010, LITE-09-102 | a durable conversation-turn admission subject, so two simultaneous chat Turns in one Workspace are mutually serialized; needs an authorized schema slice |
| LITE-09-013 | per-Agent isolation is frozen per Turn; needs the executed evidence re-checked against the clause |
| LITE-09-109 | compaction summary source validation against the existing Message revision/visibility rules |

## Closing conditions

Every row ends as PASS with evidence or as DEFERRED with an explicit, user-visible
reason; nothing is promoted on proximity, and no row is re-run until green. The
final report states the main SHA, the merged PRs, the CI runs, the environment and
the remaining limits.
