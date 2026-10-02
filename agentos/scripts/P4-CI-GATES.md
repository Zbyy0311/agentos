# P4 CI gates

The CI workflow keeps the existing Lite receipt writer and its `logs/pass-audit/` tree intact. New P4 gate logs and receipts go under `logs/p4-ci-gates/<commit-sha>/<run-id>/<gate>/` and are uploaded as separate artifacts.

Core tests run with simulated provider fixtures. The Process Runtime suite runs on the Windows CI worker and exercises real Windows child-process ownership, process-tree, and birth-identity behavior using controlled test helpers. The `real-windows-process` receipt mode describes OS process evidence; it does not mean that a real AgentOS Provider or model was called. Browser regression tests use the repository's locked Playwright package, one desktop project, and fixed API fixtures; those browser API interactions are mocked. The P4 runner refuses to launch a gate if common provider credential variables are populated; its receipt records variable names only and never values.

These CI gates do not make a real Windows Provider acceptance claim or produce a real Windows Provider receipt. The existing-project manifest below is a future receipt contract. A qualifying acceptance must run separately on Windows with a real Provider/model and operator-managed credentials outside CI. A `simulated-provider` receipt and a `real-windows-process` receipt are distinct evidence and cannot substitute for that acceptance.

The Windows Process Runtime inventory currently includes:

| Source | Windows-native coverage in the full suite |
| --- | --- |
| `packages/process-runtime/src/node-driver.test.ts` | Child-first-instruction Job ownership, multi-level process tree termination, suspended create, exact stdout/stderr and argv, unrelated PowerShell owner, and survivor audit. |
| `packages/process-runtime/src/platform-process-tree.test.ts` | Fail-closed helper startup and W8 owned-spawn helper failure. |
| `packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts` | W1 kill-on-close reaping, W2 real-process FILETIME capture/probe, and W3 invalid or unreadable PID handling. W4 remains deterministic classifier coverage. |
| `packages/process-runtime/src/p6-l1c-win32-spawn-error.test.ts` | Win32 spawn-error identity translation. |
| `packages/process-runtime/src/native-birth-identity.test.ts` | Platform-independent canonical identity validation. |

## Existing-project acceptance evidence

`p4-existing-project-acceptance.manifest.json` is a contract only. No existing-project acceptance run, real Provider call, or real Windows acceptance is claimed by these CI gates.

The receipt contract keeps two modes separate:

- `simulated-provider`: fixture model, no credentials, platform-neutral.
- `real-windows-acceptance`: real provider/model, Windows `win32`, operator-managed credentials outside CI.

The contract requires a full repository commit and tree SHA, provider/model ID, project/task/run/candidate IDs, every command and its expected/raw exit codes, both top-level zero exit codes, and the SHA-256 of the exact candidate artifact bytes. CI test receipts do not satisfy these existing-project acceptance requirements.
