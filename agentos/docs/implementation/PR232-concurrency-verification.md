# PR232 concurrency repair verification

Scope: `02-Runtime-Lifecycle` sections 8.3, 8.4 and 9.1. The interrupted
implementation at `fffaeca33eea82dd3bac25dd208d401c83c150a3` and its ten modified
files were retained and completed in `agentos-t5-concurrency/agentos`.

## Correctness changes

| Confirmed blocker | Repair and regression evidence |
| --- | --- |
| Authorization crosses an await before claim | RunEngine executes the capacity check, persistent reservation, queued-to-starting CAS, Operation and dequeue Event in one SQLite BEGIN IMMEDIATE transaction. Concurrent dispatcher starts cannot both consume global=1. |
| Global release only scans the terminating Workspace | Terminal notifications schedule the entire durable queue by priority descending, creation time ascending and ID. Scheduling waits for each admission/claim, rather than Provider completion, and fills every available slot. |
| Cancellation and startup leave queued Runs stranded | All canonical completed/failed/cancelled Events register an after-commit hook. Caller-owned cancellation transactions and rollback are covered. Startup and maintenance resume reconcile reservations before pumping globally. Recovery-required Runs are excluded. |
| First-Stage dimensions miss later Stages and fallback | Every actual coordinator attempt atomically reserves its own Provider, Configuration and Agent dimensions. Active and approval-paused attempts keep reservations. Lifecycle Stage attempt and fallback Provider attempt are stored separately; reconciliation preserves both. A replay cannot relaunch the primary while its fallback owns capacity. |
| Full Worktree creation capacity fails accepted Runs | SQLite reservations wait across manager instances. Live requests survive another manager's reconciliation; only demonstrably dead process owners are reclaimed. Git creation releases capacity in finally. Required-worktree Children retain their preparation/Admission protocol through the global pump. |

Starting, running, waiting_approval and paused Runs occupy Run capacity. A Stage
reservation remains occupied while its Provider attempt reports active or waits
for approval. Locks created by this repair use the canonical runtimeLock identity.
No new schema was needed beyond the existing 068 scheduling migration.

## Test boundaries

- Dispatcher regressions use two independent connections to a file SQLite
  database, the real RunEngine, lifecycle transactions, durable Process/Session
  repositories and the real StageExecutionCoordinator. Native process handles
  are deterministic test drivers in the concurrent-start tests.
- The required-Child integration also uses the production
  createProviderExecutionChain and an actual local Node Custom CLI process in a
  real Git worktree. No external model account is required.
- The fallback-specific regression scripts coordinator outcomes, while using the
  real dispatcher, SQLite locks, fallback projection and lifecycle. It proves
  target-Configuration waiting and reservation retention independently of native
  process scheduling.
- Environment-gated model CLI tests remain explicitly skipped; they are not
  counted as passed live Provider acceptance.

## Local checkpoint before main integration

- Dependency TypeScript build: passed.
- Server `pnpm exec tsc -b --pretty false`: passed.
- Core repair gate (scheduler, dispatcher, fallback, Worktree concurrency):
  76 tests, 71 passed, 5 environment-gated skips, 0 failures.
- Expanded focused gate including real required-Child integration: 83 tests,
  78 passed, 5 skips, 0 failures.
- Related lifecycle/Admission/Worktree/route/migration/Identity gate: 633 tests,
  633 passed, 0 skips, 0 failures (`concurrency-related.log`).

Main fetched for integration: `ed09913b5d723b7bbe87750a038cc45307f9a3c5`
(PR235, migration 066). The final verification must preserve 065, 066, 068 and
the full Registry/Identity contracts. No push, PR creation or GitHub merge is
authorized for this task.
