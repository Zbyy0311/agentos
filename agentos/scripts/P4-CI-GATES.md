# P4 CI gates

The CI workflow keeps the existing Lite receipt writer and its `logs/pass-audit/` tree intact. New P4 gate logs and receipts go under `logs/p4-ci-gates/<commit-sha>/<run-id>/<gate>/` and are uploaded as separate artifacts.

The Windows workflow keeps Server tests, Web tests, Lite, shared contracts, and the workspace build in the `server` job. Core, Process Runtime, and browser checks run as independent jobs so the long Runtime suite no longer waits behind server and Core tests. Their receipt modes remain distinct: Core uses `simulated-provider`, Process Runtime uses `real-windows-process`, and the browser gate uses `no-provider` with mocked API responses. Each P4 runner binds its receipt to the exact checkout SHA/tree and run attempt.

The separate, unconditional `Memory relevance and correction gate` runs the fixed 96-query corpus, exact-version feedback isolation, fault fallback, and snapshot replay checks. Its receipts are independent of the Core, Process Runtime, and browser receipts. A missing test must fail the gate rather than become a conditional skip.

The `p3-local-operations` job runs the diagnostic-redaction contract and the Windows launcher lifecycle against controlled local server fixtures. It verifies instance ownership, foreign-port preservation, readiness and safe stop behavior. Its `real-windows-process` receipt describes Windows process evidence; no remote Provider is called. The acceptance contract gate also runs the frozen-plan/source-probe binding tests unconditionally.

Server tests keep Node's five-minute timeout on each test execution and run each inventory file in its own child process with a 20-minute wall-clock watchdog. The watchdog includes module loading and all tests in that file; it is not the per-test timeout. This allows many individually bounded SQLite/Git cases to accumulate beyond five minutes without treating the whole file as hung. A file watchdog or test timeout is a failure, and per-file TAP counts must reconcile exactly with the shard receipt. Each complete shard still has the 60-minute CI job limit; serialized control/restart coverage can take about 40 minutes on a Windows worker. The runner terminates only its owned child process tree and never uses a forced successful exit to hide leaked resources.

The separate `p2-group-recovery-browser` job exercises the default workspace entry, recovery CAS retries, switching conversations during a pending request, cross-tab dispatch locking, reload after an uncertain respond, and unknown-owner refusal. API response fixtures record mock Provider starts separately from HTTP retries; the Web suite also calls the real recovery and respond routes with forced mock dispatch to verify their single durable owner. This is not remote Provider evidence. Only the fixed `.next-p2-group-recovery-e2e/` generated build directory is excluded from that gate's source hash, and a temporary TypeScript configuration keeps the tracked checkout unchanged.

Core tests run with simulated provider fixtures. The Process Runtime suite runs on the Windows CI worker and exercises real Windows child-process ownership, process-tree, and birth-identity behavior using controlled test helpers. The `real-windows-process` receipt mode describes OS process evidence; it does not mean that a real AgentOS Provider or model was called. Browser regression tests use the repository's locked Playwright package, one desktop project, and fixed API fixtures; those browser API interactions are mocked. The P4 runner refuses to launch a gate if common provider credential variables are populated; its receipt records variable names only and never values.

These CI gates do not make a real Windows Provider acceptance claim or produce a real Windows Provider receipt. The existing-project runner below supports a deterministic local Provider fixture and a separately gated real Windows mode. A `simulated-provider` receipt and a `real-windows-process` receipt are distinct evidence and cannot substitute for a real Provider acceptance.

The Windows Process Runtime inventory currently includes:

| Source | Windows-native coverage in the full suite |
| --- | --- |
| `packages/process-runtime/src/node-driver.test.ts` | Child-first-instruction Job ownership, multi-level process tree termination, suspended create, exact stdout/stderr and argv, unrelated PowerShell owner, and survivor audit. |
| `packages/process-runtime/src/platform-process-tree.test.ts` | Fail-closed helper startup and W8 owned-spawn helper failure. |
| `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | W1 kill-on-close reaping, W2 real-process FILETIME capture/probe, and W3 invalid or unreadable PID handling. W4 remains deterministic classifier coverage. |
| `packages/process-runtime/src/p6-l1c-win32-spawn-error.test.ts` | Win32 spawn-error identity translation. |
| `packages/process-runtime/src/native-birth-identity.test.ts` | Platform-independent canonical identity validation. |

## Existing-project acceptance evidence

`p4-existing-project-acceptance.manifest.json` defines the contract used by `verify-existing-project-acceptance.mjs`. CI jobs above do not invoke this existing-project runner and make no acceptance claim by themselves.

The receipt contract keeps two modes separate:

- `simulated-provider`: fixture model, no credentials, platform-neutral.
- `real-windows-acceptance`: real provider/model, Windows `win32`, operator-managed credentials outside CI.

The local runner first reproduces a declared defect and feature gap on an isolated workspace base. It then drives two independent tasks through the production AgentOS HTTP server, `CollaborationWorkflowService`, and native Provider execution chain. Each scenario must persist an independent approval, a passing acceptance command, a frozen candidate preview, and an applied candidate. At least one scenario must also persist a genuine `changes_requested` review, a changed candidate revision in a linked new Run, and retesting; a direct independent approval in the other scenario is preserved without inventing rework. The deterministic mode exercises rework in both scenarios using a deliberately minimal fixture Git workspace plus a local Codex-protocol fixture process; it exercises production orchestration but does not test application source and does not call a remote model. Because both modes use disposable isolated workspaces, the runner resolves a pending `approve_once` request after checking the request's workspace, canonical Run, implementer identity, CLI executable, and isolated runtime worktree. It never creates a persistent approval grant or resolves another approval category. A simulation receipt remains labeled `simulated-provider` / `simulated-runtime-verified` and cannot be used as real project acceptance.

Run deterministic acceptance from a clean checkout whose tracked files match the supplied full commit SHA. Evidence is written outside the repository by default:

```powershell
$sha = (git rev-parse HEAD).Trim()
$evidence = Join-Path $env:TEMP "agentos-existing-project-acceptance-$sha"
node scripts/capture-existing-project-acceptance.mjs --mode simulated-provider --expected-sha $sha --evidence-dir $evidence
```

The runner builds and starts the production server with a fresh temporary data root, worktree root, and loopback port. Both modes use the frozen-candidate preview route, bind its `candidateId`, `baseCommit`, `contentHash`, and `diffHash` to the persisted candidate, then submit the same candidate ID/base/content hash to apply. It records the source commit/tree, task and role identities, candidate diff hashes, review history, acceptance command output/exit codes, Provider model and invocation count, native process PID/birth identity/executable/exit code, durable Run Events, and preview/apply responses. The copied SQLite database and hashed artifacts stay in the evidence directory. `validate-existing-project-acceptance.mjs` checks receipt structure and hashes only; use the runner's `--verify-receipt <path>` mode to reopen the local runtime database and verify persisted records before reporting runtime acceptance.

The apply request has a bounded 180-second budget because full-source preflight and post-application verification both inspect the existing repository. Clean preflight normalizes frozen bytes in its private shadow, proves the live index still matches the baseline, and keeps its final full-content verification. A timeout is a failed acceptance run; it never substitutes for a persisted application result.

On Windows the runner requests graceful shutdown through a unique named pipe authenticated by its instance ID and nonce, then waits for its owned child to exit with code zero. A rejected control request, forced exit or deferred drain cannot satisfy the runtime receipt. A deferred stop preserves the process, SQLite ownership and recovery directory; it does not force termination. Older receipts without this shutdown evidence remain historical and do not pass the new gate.

The `real-windows-acceptance` mode requires Windows, an explicit `--run-real-provider`, a two-scenario plan with separate `baselineCommands` and `acceptanceCommands` plus a concrete `expectedBaselineFailure` for each scenario, a configured Codex CLI/model, the P2 readiness endpoint, and the collaboration preview route. Baseline probes run on the frozen source before any Agent task; candidate acceptance commands run through the collaboration workflow after revision. Both scenarios must scope at least one existing frozen file under `agentos/apps/` or `agentos/packages/`; deterministic fixture paths/commands, traversal, and scopes with no existing source anchor are rejected. It runs against a disposable clone of the exact AgentOS source SHA and writes evidence under the user's Documents directory by default. It is blocked in CI. Do not run it until P2 preview/recovery integration has been confirmed. No external signer is required: structural validation remains `structurally-verified`, while only a successful local database/process verification is `simulated-runtime-verified` or `runtime-verified`.
