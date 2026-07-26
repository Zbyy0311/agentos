# R39 Ownership Concurrency Test Contract Remediation

## 1. Baseline

- Main SHA: `a1514d6eb765df1dff36c073625c8404da24613a`
- Branch: `test/baseline-r39-ownership-contract`
- Worktree: `E:\workspace\Multi-Agent-worktrees\agentos-r39\agentos`
- Node: `v24.18.0`
- pnpm: `11.11.0`
- `pnpm install --frozen-lockfile`: PASS, exit `0`
- `build:workspace-deps`: PASS, exit `0`

M2.5 was not modified.

## 2. Formal Baseline Failure

Formal Final Baseline Attempt 2 on `a1514d6e` failed before Agent Core and Root Build:

- Server total: `478`
- Passed: `476`
- Failed: `1`
- Skipped: `1`
- Cancelled: `0`
- Unique failure: R39
- Server exit: `1`
- Duration: approximately `60.07s`
- Actual owner count: `0`
- Expected owner count in the old test: `1`
- All three concurrent outcomes were `FAILED SERVER_OWNERSHIP_UNAVAILABLE`.

Historical Attempt 1 and the Final-Main Attempt 1 remain retained and are not rewritten.

## 3. Contract Mismatch

The old R39 title promised that concurrent same-root subprocesses never produce two owners, but its assertion required exactly one winner.

The production post-bind contract deliberately permits every contender to fail closed when concurrent same-root ownership is detected. Safety forbids two owners; it does not promise that one contender must win every race.

## 4. Owner Decision

The test contract now enforces:

- at most one successful owner;
- no two-owner outcome;
- every child reports exactly one recognized outcome;
- every loser reports `SERVER_ALREADY_RUNNING` or `SERVER_OWNERSHIP_UNAVAILABLE`;
- after all contenders exit, a fresh acquire on the same root succeeds and can release;
- no production ownership change.

## 5. Resolution

Only R39 in `apps/server/src/serverOwnership.test.ts` was changed:

- the title now states the at-most-one and post-contention contract;
- `acquired.length <= 1` replaces the exact-one assertion;
- child outcome classification is explicit;
- loser count is checked against the number of children;
- all children are killed/awaited before the re-acquire;
- the re-acquire is released before the temporary root is removed;
- ROUNDS remains `5` and CHILDREN remains `3`.

`apps/server/src/serverOwnership.ts` was not modified.

## 6. Verification

### Targeted R39

- Run 1: PASS, `1/1`, exit `0`, approximately `3.67s`.
- Run 2: PASS, `1/1`, exit `0`, approximately `2.65s`.
- Run 3: PASS, `1/1`, exit `0`, approximately `2.36s`.
- The test output did not print per-round winner counts; exact zero-versus-one distribution is therefore not claimed. The at-most-one assertion passed in all three runs, no 2+ owner outcome was observed, and post-contention re-acquire passed.

### Ownership test file

- `25` total
- `24` passed
- `0` failed
- `1` skipped (`R34` Unix-only)
- Exit `0`

### Full Server Stability

- Run 1: `478/477/0/1`, exit `0`, approximately `101.97s`.
- Run 2: `478/477/0/1`, exit `0`, approximately `89.75s`.
- Run 3: `478/477/0/1`, exit `0`, approximately `81.26s`.
- R39 passed in all three runs.
- No bad-port, teardown rejection, or unhandled rejection was observed.

### Regression

- Agent Core: `21` files, `123 passed / 0 failed`, exit `0`, approximately `11.94s`.
- Root Build: PASS, shared/agent-core/web/server builds completed, exit `0`, approximately `53.39s`.
- `git diff --check`: PASS.
- No residual test process or listener; only the pre-existing MCP Node process remained.

## 7. Scope

- No production TypeScript change.
- One test file changed.
- One remediation report added.
- No migrations.
- No package manifest or lockfile changes.
- No Runtime Specification changes.
- No M2.5 implementation changes.

## 8. Remaining Status

- Remediation is ready for review.
- PR is not merged.
- M2.5 remains blocked until this remediation merges.
- Formal M2.5 baseline must be revalidated after merge.
- Remote CI is not asserted unless real GitHub checks exist.
