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

## Main integration and final source freeze

- Before-main implementation checkpoint:
  `0dbb68241720c82c2909051eaac2c9b80aa34393`, also retained on local branch
  `codex/pr232-pre-main-20261022`.
- Rebased implementation checkpoint:
  `4778aaa674ab623503ff0a85cc8f770f404dd24c`, with main
  `ed09913b5d723b7bbe87750a038cc45307f9a3c5` as an ancestor.
- Integration resolutions retain 066 and 068 together in the exact migration
  registry, retain both Provider validation and concurrency metrics, and leave
  Identity implementation and contracts identical to main.
- At the rebased checkpoint, the expanded focused gate passed 78 tests with
  5 explicit skips; the related gate plus main's cache/metrics regressions
  passed 645/645. The agent-core validation-cache suite passed 5/5.
- One final Stage-finalization regression then proved that capacity must remain
  reserved across asynchronous Artifact capture until the lifecycle commit.
  The real-coordinator duplicate-drive regression passes. This repair is
  included in the final source freeze.

The final committed source is checked again with the combined 30-file server
gate, recorded in `apps/server/concurrency-frozen.log`, and server TypeScript
build, recorded in `apps/server/concurrency-frozen-tsc.log`. These final receipts
supersede the earlier checkpoint runs. The server gate includes the six focused
files and all 24 related files above, including 065/066/068 fresh/upgrade
registration, Identity, cache metrics and persistent cache tests.

Known validation limits: five external model CLI gates require explicit local
environment opt-in and are skipped. This task provides local runtime/SQLite and
local Custom CLI execution evidence, without a new remote CI run or publication.

## Exact-head CI follow-up

The first remote CI on `5594cfec` failed shard 7 in the source-structure
MaintenanceBarrier assertion: it required the collaboration queue to be the
first statement inside the dispatch permit. Reservation reconciliation and the
new global queue now correctly run first, inside that same permit. Both startup
and maintenance-resume assertions were updated to require the new ordering and
retain the permit boundary. No production fencing or ownership guard changed.

Shard 3 also exposed an outdated production-startup fixture missing the new
reservation-recovery/global-pump methods. The fixture now uses the real
scheduler, Admission authorization and required-Child preparation; it asserts a
single canonical dequeue rather than substituting no-op queue methods.

The follow-up also owns asynchronous queue/terminal jobs until SQLite can close.
Shutdown first stops new queue starts. It continues accepting cleanup from
already-owned HTTP/dispatcher mutations, then performs a final queue seal/drain
after those owners settle and before database close. A regression commits a
terminal fact after the early drain and proves SQLite remains open until its
delayed cleanup completes.

Parent verification of the final follow-up: 16-file affected gate **185 passed,
5 opt-in Provider tests skipped, 0 failed**; it includes both previously failed
CI files, actual required-Child Custom CLI execution, queue shutdown, maintenance,
fallback and scheduling. No `database is not open` diagnostic remained. Server
TypeScript build passed. The earlier 724-test receipt remains tied to `5594cfec`;
the new follow-up requires a new complete remote CI run.

The `cc33c47e` CI shard 8 additionally exposed Node 22's deferred SQLite
experimental warning entering the test's `console.error` mock. The capture now
excludes only that exact two-line runtime warning; all application diagnostics
and the real SQLite-close/late-terminal assertions remain enforced. The full
16-file affected gate again passed **185 tests, 5 configured Provider skips,
0 failures**. This test-only correction requires a fresh exact-head CI run.

The next Windows run passed the warning assertion but timed out the first queue
test after a 13.1-second cold fixture bootstrap under its 10-second whole-test
deadline. The bootstrap budget is now 30 seconds; the production shutdown grace
stays 5 seconds and every deferred-cleanup/closed-store assertion is retained.
That same run also hit the unchanged P2 restart fixture's request timeout, which
is tracked separately from the queue ownership implementation.
