# P4 CI gates

The CI workflow keeps the existing Lite receipt writer and its `logs/pass-audit/` tree intact. New P4 gate logs and receipts go under `logs/p4-ci-gates/<commit-sha>/<run-id>/<gate>/` and are uploaded as separate artifacts.

The Windows workflow keeps Server tests, Web tests, Lite, shared contracts, and the workspace build in the `server` job. Core, Process Runtime, and browser checks run as independent jobs so the long Runtime suite no longer waits behind server and Core tests. Their receipt modes remain distinct: Core uses `simulated-provider`, Process Runtime uses `real-windows-process`, and the browser gate uses `no-provider` with mocked API responses. Each P4 runner binds its receipt to the exact checkout SHA/tree and run attempt.

The P1 memory relevance/feedback regression gate is intentionally left to the separate P1 change because its focused tests are not in this P4 branch's base. The P1 PR must wire those paths as a required, unconditional gate; a missing-test conditional skip is not acceptable. This P4 workflow does not claim those P1 regressions have run.

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

The local runner first reproduces a declared defect and feature gap on an isolated workspace base. It then drives two independent tasks through the production AgentOS HTTP server, `CollaborationWorkflowService`, and native Provider execution chain. Each scenario must persist a `changes_requested` review, a changed candidate revision, an independent approval, a passing acceptance command, a read-only candidate preview, and an applied candidate. The deterministic mode uses a deliberately minimal fixture Git workspace plus a local Codex-protocol fixture process; it exercises production orchestration but does not test application source and does not call a remote model. Because both modes use disposable isolated workspaces, the runner resolves a pending `approve_once` request after checking the request's workspace, canonical Run, implementer identity, CLI executable, and isolated runtime worktree. It never creates a persistent approval grant or resolves another approval category. A simulation receipt remains labeled `simulated-provider` / `simulated-runtime-verified` and cannot be used as real project acceptance.

Run deterministic acceptance from a clean checkout whose tracked files match the supplied full commit SHA. Evidence is written outside the repository by default:

```powershell
$sha = (git rev-parse HEAD).Trim()
$evidence = Join-Path $env:TEMP "agentos-existing-project-acceptance-$sha"
node scripts/verify-existing-project-acceptance.mjs --mode simulated-provider --expected-sha $sha --evidence-dir $evidence
```

The runner builds and starts the production server with a fresh temporary data root, worktree root, and loopback port. It records the source commit/tree, task and role identities, candidate diff hashes, review history, acceptance command output/exit codes, Provider model and invocation count, native process PID/birth identity/executable/exit code, durable Run Events, and preview/apply responses. The copied SQLite database and hashed artifacts stay in the evidence directory. `validate-existing-project-acceptance.mjs` checks receipt structure and hashes only; use the runner's `--verify-receipt <path>` mode to reopen the local runtime database and verify persisted records before reporting runtime acceptance.

The `real-windows-acceptance` mode requires Windows, an explicit `--run-real-provider`, a two-scenario plan with a concrete `expectedBaselineFailure` for each scenario, a configured Codex CLI/model, the P2 readiness endpoint, and the collaboration preview route. Both scenarios must scope at least one existing frozen file under `agentos/apps/` or `agentos/packages/`; deterministic fixture paths/commands, traversal, and scopes with no existing source anchor are rejected. It runs against a disposable clone of the exact AgentOS source SHA and writes evidence under the user's Documents directory by default. It is blocked in CI. Do not run it until P2 preview/recovery integration has been confirmed. No external signer is required: structural validation remains `structurally-verified`, while only a successful local database/process verification is `simulated-runtime-verified` or `runtime-verified`.
