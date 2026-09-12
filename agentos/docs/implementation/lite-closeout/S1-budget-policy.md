# S1 budget policy: pricing, Scope attribution, and diversity

Requirements: LITE-07-007 (`token, count, Scope, category, and diversity
budgets`). Base: `origin-https/main` at the time of writing. This record is
evidence, not a matrix edit: the row stays GAP until the closeout matrix unions
the promoted evidence, because several in-flight branches edit that file.

## What was wrong

Three defects, all in `applyBudget`:

| # | Defect | Consequence |
|---|---|---|
| 1 | The token budget summed `entry.tokenEstimate`, the estimate of the Entry's `content` alone. | The assembler injects `### <title>\n<content>`, so every heading was injected for free and `total_tokens` understated what the Run received. A stale or understated stored estimate also bought extra capacity. |
| 2 | A `perScopeLimits` exclusion was recorded as `category-budget`. | The snapshot blamed a category limit that may not exist; the frozen vocabulary already has `scope-excluded`. |
| 3 | `requireDiversity` was never read. | The policy field, the `diversity-limit` reason code and spec §47 ("检索结果不能全部来自同一类") had no implementation, so one category could fill the whole context. |

## What changed

- `injectedEntryText` / `estimateInjectedTokens` are the single definition of an
  Entry's context cost, using the repository-wide chars/4 estimator that the
  candidate-to-Entry promotion path already uses. `plan` assembles the context
  with the same function, so pricing and injection cannot drift apart.
- `tokenCost`, `totalTokens` and the token gate all use that cost.
- A per-Scope limit reports `scope-excluded`; a per-category limit still reports
  `category-budget`.
- `requireDiversity` is implemented as a two-pass selection: the first pass
  admits at most one Entry per category, in rank order, and only while another
  category is still available further down the ranking; the second pass fills the
  remaining capacity from the deferred Entries, again in rank order. The persisted
  selection therefore stays in rank order, and capacity is never wasted when only
  one category exists.
- A deferred Entry that the fill pass cannot fit is reported as `diversity-limit`,
  because it fitted when the diversity pass deferred it and the budget only ran
  out because another category was preferred. Threshold gates keep their own
  reasons.
- Selections and exclusions are both recorded in rank order, so the snapshot reads
  deterministically regardless of the decision path.

## Evidence

```
node --import tsx --test src/services/MemoryContextBudgetSelector.test.ts
  13 pass / 0 fail
    MF4B-02 injected-text pricing: two rows with a stale `tokenEstimate: 1`
             price at 4 each, so only one fits maxTokens 5
    MF4B-11 per-scope limit reports exactly ['scope-excluded']
    MF4B-12 diversity selects ranks [1, 3] (decision, failure) and reports
             ['diversity-limit']; the same fixture without diversity selects
             ranks [1, 2] and reports ['entry-budget'], which is what proves
             the exclusion above is the diversity rule
    MF4B-13 with capacity 3 the deferred rank-2 Entry is admitted, the
             selection stays ['decision','decision','failure'] at ranks [1,2,3]
             and nothing is excluded
```

Regression surface, same worktree:

```
MemoryContextResolver(.emission), MemoryRuntimeEventEmitter, memoryRuntime route,
runtimeInspector route, MemoryCandidateGenerationService      73 pass / 0 fail
run-engine suite (includes the MF-4 context injection integration)  117 pass / 0 fail / 2 env-gated skips
```

## Deliberately not changed

- `MemoryContextSnapshotRepository` and the `memory_context_snapshots` DDL. The
  `truncated` flag keeps its tested meaning ("an Entry was dropped explicitly")
  rather than pretending the stored content was cut.
- No new exclusion reason code: the frozen vocabulary already carried
  `scope-excluded` and `diversity-limit` unused.
- LITE-07-013 (visible FTS degraded mode) is **not** closed here. The selector
  still calls `retrieve`, which discards `retrieveWithStatus().degraded`, and the
  snapshot payload has no place to persist it, so that row needs either a new
  column (migration) or a contract decision and is left for its own slice.
