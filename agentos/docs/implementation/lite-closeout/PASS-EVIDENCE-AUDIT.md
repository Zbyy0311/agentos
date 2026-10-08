# PASS evidence integrity audit — 2026-09-13

Acceptance remains open. PASS promotion is frozen by the user's instruction.

Audited remote main: `3ac02ceb54b701e3143c9ffdda7b782aac396ace`, matrix v14.
All 395 requirement identities and normative scope remain unchanged. The audit
withdraws 196 PASS claims: v15 has **0 PASS / 26 GAP / 205 RUNTIME-VERIFY /
164 DEFERRED**. This is an evidence classification, not a finding that all 196
behaviors fail. No PASS may be added or restored during this freeze.

`pass-freeze.json` preserves every original state and the original PASS set.
`pass-evidence-audit.json` has one record for each of the 196 PASS rows, with all
five checks: baseline SHA, command, raw exit code, actual pass/fail/skip, and
assertion coverage. Its seven proof records preserve the original declarations.
`evidence.json` remains historical and has not been rewritten to look successful.
The audit is reproducible with `node scripts/audit-lite-pass-evidence.mjs`.

| Historical evidence | PASS rows citing it | Finding |
| --- | ---: | --- |
| S0-V01 / V02 / V03 | 2 / 7 / 3 | Commit and literal command exist, but no preserved raw process exit or complete output bound to that invocation; no per-clause executed assertion map. |
| S8-VERIFY-BATCH-10 | 164 | 16 is a batch count, not a test count. Runner disregarded child exit/error/signal. Promotion used keyword matches or default-true coverage. Report was overwritten (now 26 batches and zero requirement mappings). |
| S8-VERIFY-BATCH-11 | 17 | Command contains `<re-pointed files>`; hard-coded counts total 275, contradicting the recorded 254. Raw exit and assertion provenance are absent. |
| S8-E2E-RUN2 | 4 | Declared harness exit is 1, but wrapper records 9/0/0 by allowing external failures. Referenced raw log is not tracked on main. |
| S8-PROVIDER-CONTRACT-SUITE | 1 | Declared 171/0/0 has no raw invocation receipt or full clause-to-executed-assertion map. |

Counts overlap: two rows cite both the batch and E2E records. There are 196
unique rows, not 198. All referenced commit objects exist; this alone does not
prove the command ran against those commits.

Source findings are inspectable in the historical versions of
`scripts/run-lite-verification-batches.mjs`, `scripts/verify-lite-s8-gates.ps1`,
and `apply-s8-{acceptance,matrix,repoint}.mjs` at the audited SHA. A suite/file
passing and a source keyword appearing are insufficient assertion coverage.
Missing evidence is reported as unknown, never reconstructed as exit zero.

## Final verification order

1. Commit the freeze, audit, and strict verifier repairs; require the revision's
   CI to finish before merging.
2. Pin the resulting new remote main SHA. Preserve the complete final CI run,
   commands, raw exits and runner results for this SHA.
3. Run the real Provider gates from that same clean SHA with explicit executable
   and model selection. Record failures/skips as observed; external quota or
   unavailable CLI is not an exception to a successful gate.
4. Only after those runs finish, execute `node scripts/verify-lite-scope.mjs
   --require-closed` and preserve its actual nonzero result if acceptance remains
   open. Do not promote rows to make this check pass.

Open promotion PRs (#156 and #158 at audit time) are not acceptance authority
and must not bypass the freeze. Historical closeout notes claiming PASS counts
are superseded by this audit; they are retained as history.

## Local validation history

Workspace build completed with exit 0. The new capture regression's first two
runs failed in temporary Git fixture cleanup (Windows `ENOTEMPTY`); a diagnostic
cleanup attempt failed with `ENOENT` on Git's dangling symlink probe. Its raw
receipts already showed exit 7 preserved, missing executable `ENOENT` preserved,
and unparsed counts left null. The fixture now initializes Git with the local
command option `-c core.symlinks=false` (it contains no symlinks). With that
fixture correction the regression completes 1 pass / 0 fail / 0 skip, exit 0.
These initial failures were not product passes or erased suite failures.

The interrupted verifier patches initially produced 17/22 passing regression
tests (five failures), then 18/22 (four failures), due to an incomplete
PowerShell expression and test-fixture assumptions. After repairing the
expression and reading a log's hash before cleanup, restoring permanent-scope
regressions, and adding zero-exit/skip and unknown-count controls, the integrated
regression set completed **25 pass / 0 fail / 0 skip**, raw exit 0. The ordinary
scope verifier also exits 0 with the v15 counts above. `--require-closed` has
not been run at this stage.
