# Clean-Checkout Build-Order Remediation

## 1. Baseline

- Main SHA: `e02db3b00d321d245bbfd2941a11e3bc5396b864`
- Remediation branch: `runtime/baseline-build-order-remediation`
- Remediation worktree: `E:\workspace\Multi-Agent-worktrees\agentos-build-order\agentos`
- Node: `v24.18.0`
- pnpm: `11.11.0`
- `pnpm install --frozen-lockfile`: PASS, exit `0`, approximately `3.89s`
- Install left no tracked changes.

The M2.5 branch and worktree were not modified.

## 2. Original Failure

M2.5 Baseline Attempt 1 was retained and not overwritten.

- Command: `pnpm --filter @agentos/server test`
- Exit: `2`
- Duration: approximately `4.83s`
- First error: `TS2307 Cannot find module '@agentos/shared'`
- `packages/shared/dist` was unavailable to the dependent build.
- Server test collection did not start.
- Additional cascading error codes: `TS7006`, `TS2345`, `TS2366`, and `TS7053`.

Attempt 1 was retained and not overwritten.

## 3. Root Cause

- `@agentos/shared` publishes its local `main` and `types` entrypoints from `dist`.
- `@agentos/agent-core` depends on `@agentos/shared` through `workspace:*`.
- A fresh Worktree has no historical `packages/shared/dist` output.
- The original Server `dev`, `dev:stable`, `build`, and `test` scripts prebuilt only `@agentos/agent-core`.
- No Server script built `@agentos/shared` first.
- A historical Shared build was therefore an undocumented prerequisite for a clean checkout.

## 4. RED Reproduction

In this remediation Worktree, all three allowed dist directories were removed before the RED run:

- `packages/shared/dist`: `False`
- `packages/agent-core/dist`: `False`
- `apps/server/dist`: `False`

The original Server test command then reproduced the defect:

- Exit: `2`
- Duration: approximately `3.23s`
- First error: `src/adapters/registry.ts(1,36): error TS2307: Cannot find module '@agentos/shared'`
- The failure occurred in the Agent Core prebuild before Server tests.

The package clean scripts themselves rejected the Windows-incompatible `-rf` forwarding with `Unknown option: 'recursive'`; only the three explicitly allowed dist directories were removed with PowerShell before the RED run.

## 5. Resolution

`apps/server/package.json` now defines one centralized dependency bootstrap:

```json
"build:workspace-deps": "pnpm --filter @agentos/shared build && pnpm --filter @agentos/agent-core build"
```

The `dev`, `dev:stable`, `build`, and `test` scripts invoke `pnpm run build:workspace-deps` while preserving their existing runtime commands, watch exclusions, test glob, and `--test-concurrency=1`.

## 6. Verification

### Server test from clean dist

Before the command, all three dist directories were absent. The command output showed:

```text
shared build
agent-core build
Server tests
```

Result:

- `478` total
- `477` passed
- `0` failed
- `1` skipped (`R34 unix-only`)
- Exit `0`
- Duration: approximately `74.69s`
- No bad-port
- No teardown rejection
- No unhandled rejection
- No residual Server or test child process

### Server build from clean dist

Before the command, all three dist directories were absent. The command completed:

```text
shared build
agent-core build
server tsc
```

Result:

- Exit `0`
- Duration: approximately `5.15s`
- Shared JavaScript and declaration output exists.
- Agent Core JavaScript and declaration output exists.
- `apps/server/dist` exists.

### Regression verification

- Agent Core tests: `123 passed / 0 failed`.
- Root `pnpm build`: PASS.
- `git diff --check`: PASS.
- Final tracked scope contains only the allowlisted package script change and this report.

## 7. Compatibility

- No production TypeScript changes.
- No test changes.
- No migration changes.
- No dependency changes.
- No lockfile changes.
- No runtime API changes.
- No database changes.
- No M2.5 Snapshot implementation changes.

## 8. Remaining Status

- Remediation is ready for review.
- Remediation PR is not merged.
- M2.5 remains blocked until this remediation is merged and the baseline is revalidated on the resulting mainline.
- Docs PR #4 remains independent and was not modified or merged in this task.
- Remote CI status was not asserted because GitHub API/DNS was unavailable during final verification.
