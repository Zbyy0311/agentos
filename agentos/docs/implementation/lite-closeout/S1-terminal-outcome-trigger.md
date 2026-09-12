# S1 terminal-outcome trigger: every terminal status, and restart convergence

Requirements: LITE-07-102 (`Task/Run/Stage terminal outcome 触发及故障后收敛`).
Base: `origin-https/main` at the time of writing. This record is evidence, not a
matrix edit: several in-flight branches edit `matrix.json`, so the row keeps its
GAP state until the closeout matrix unions the promoted evidence.

## What was wrong

Three gaps, all in the MF-2R trigger:

| # | Gap | Consequence |
|---|---|---|
| 1 | `generateForRunTerminal` returned `not-completed` for anything but a completed Run. | A failed or cancelled Run produced no memory at all, even though a failure fingerprint is exactly the fact that stops the same failure being repeated. |
| 2 | The dispatcher fired the trigger only inside the `completed` branch of the final Stage. | A Run folded into a canonical failure by the dispatch containment path owed a fact nobody wrote. |
| 3 | Nothing reconciled the window between the terminal commit and the trigger. | A crash there left a terminal Run with no Candidate until someone noticed; `重启不遗漏` was unimplemented. |

## What changed

- The trigger accepts every terminal status (`completed`, `failed`, `cancelled`)
  and returns `not-terminal` otherwise. A non-success Run produces a bounded,
  record-only bundle: status, `failureCode`, `failureMessage` and Stage
  outcomes — never raw Provider output or hidden reasoning — under category
  `failure`, authority `agent-derived`, `confidence` 0.5. The completion summary
  keeps its existing title byte-for-byte, because that exact text feeds the FTS
  near-duplicate signal; only a non-success outcome adds the status marker.
  Idempotency is unchanged: one deterministic id `mcand_terminal_<runId>` per
  Run, with find-before-create, so a Run has exactly one terminal fact.
- `RunEngineProviderDispatcher` fires the trigger for a non-success terminal Run
  at the end of a drive and after each containment fold that made the Run
  terminal. It reads the Run back from durable state, so it is a no-op while the
  Run is live, it uses the Run's own `run.start` Operation as authority, and it
  never mutates the Run.
- `TerminalMemoryCandidateReconciler` (new) repairs the crash window: it sweeps
  terminal Runs whose Candidate is missing, in bounded batches per Workspace,
  and generates each through the same service instance the dispatcher uses — so
  the same Run can never receive two different facts. Causation comes from the
  Run's own persisted terminal Runtime Event (`run.completed` / `run.failed` /
  `run.cancelled`) via the `persisted_event` authority origin; a terminal Run
  with no such Event is reported and skipped rather than fabricated.
- `providerExecutionChain` publishes that single generator, and the server
  invokes the sweep once at startup, after recovery and after the L1E admission
  reconciliation, contained so it can never block startup.

## Evidence

```
node --import tsx --test src/services/MemoryCandidateGenerationService.test.ts
  15 pass / 0 fail
    MF2R-G6 a failed Run creates one review-required category=failure Candidate
             carrying PROVIDER_SESSION_FAILED and the message, and a replay
             converges on the same row ('existing', still 1 row)
    MF2R-G7 a cancelled Run creates one such Candidate without a failure code
    MF2R-G5 a still-running Run generates nothing ('not-terminal')

node --import tsx --test src/services/TerminalMemoryCandidateReconciler.test.ts
  5 pass / 0 fail
    the sweep repairs a terminal Run through the REAL generator once, and a
    second sweep reports existing with no second row
    the authority is the Run's own terminal Event (eventId, correlation and
    causation asserted exactly) and a running Run is never considered
    a terminal Run without a terminal Event is reported and skipped, with no
    Candidate written and no generator call
    a throwing generator is contained and the sweep still repairs the next Run
    the startup sweep covers each Workspace in id order, scoped per Workspace

node --import tsx --test src/services/run-engine/RunEngineProviderDispatcher.test.ts
  32 pass / 0 fail / 2 env-gated real-Provider skips
    the contained post-claim failure now fires exactly one terminal trigger for
    the failed Run; the MF-2R completion test still observes exactly one call
```

## Deliberately not changed

- No new Event type, no new exclusion reason, no schema change: the sweep reuses
  the existing `memory.candidate_created` path and the existing
  `persisted_event` authority origin, which already proves a correlation against
  a durable `runtime_events` row.
- The Stage terminal status alone does not create a fact. The specification ties
  this trigger to Task/Run/Stage terminal outcomes that constitute a Run result;
  a Stage that fails inside a Run which then continues is not a Run outcome, and
  the Run-level terminal status is what the trigger keys on.
- In-process acceptance of an explicit user cancellation still relies on the
  startup sweep: the cancellation transition lands outside the dispatcher (in
  the operation layer), so covering it immediately would need a hook in that
  route rather than a fabrication inside the dispatcher.
