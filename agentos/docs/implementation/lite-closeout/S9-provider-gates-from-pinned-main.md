# Real Provider gates from the pinned clean SHA

This records final-verification step 3 of `PASS-EVIDENCE-AUDIT.md`: run the real
Provider gates from a pinned clean revision, with explicit executable and model
selection, and preserve the raw receipts. It does not change any matrix state, and
nothing here promotes a row.

## Fixed boundaries

- Pinned revision: `0df73d7544f8c1d98feba83bbcca9e34ec28d91b` (merge of #155; the
  tip of `origin-https/main` when the run started).
- Dedicated worktree, `git status --short` empty before the run.
- The product code under test is that revision's; the only additions on this branch
  are the receipt directory and this record.
- Model selection is explicit and stated per gate below. Per the standing model
  caveat, these gates prove the AgentOS Provider/Runtime canonical chain under the
  named routed model; they do not prove the machine default model or any
  quota-restricted model is available.

## Results

Raw `stdout`, `stderr` and exit code for every gate are under
`evidence/gates-20260914/<gate>/`, with byte counts and SHA-256 in that directory's
`manifest.json`.

| Gate | Command switch | Executable / model | Raw exit | Observed result |
| --- | --- | --- | ---: | --- |
| OpenCode canonical chain | `M4_P4_REAL_OPENCODE_GATE=1` | `opencode.exe` 1.17.11 / `deepseek/deepseek-v4-flash` | 0 | 1 pass / 0 fail / 0 skipped, 31.6 s |
| Kimi routed canonical chain | `M4_P4_REAL_KIMI_ROUTED_GATE=1` | `.kimi-code/bin/kimi.exe` / `opencodex/deepseek/deepseek-flash` | 0 | 0 fail / 0 skipped, 29.0 s |
| Codex canonical chain | `M4_P4_REAL_CODEX_GATE=1` | `.codex/.sandbox-bin/codex.exe` | 0 | 0 fail / 0 skipped, 191.5 s |
| Artifact chain (real review work to accepted Entry) | `M4_P4_REAL_ARTIFACT_GATE=1` | `opencode.exe` / `deepseek/deepseek-v4-flash` | 0 | 1 pass / 0 fail / 0 skipped, 62.3 s |

All four gates were invoked exactly as
`node --import tsx --test [--test-name-pattern <gate name>] src/services/run-engine/<file>.test.ts`
from `apps/server`, with the switch in the environment.

## What is not covered here

- The approval gate (`M4_P4_REAL_APPROVAL_GATE=1`) lives in #157 and is not on this
  revision, so it was not run from it. It must be re-run from the final SHA once
  merged.
- The Kimi default-model gate (`M4_P4_REAL_GATE=1`) was not run; the routed variant
  was, because the account backing the default model is quota-blocked. The audit is
  explicit that quota exhaustion is not an exception to a successful gate, so if the
  default model is required for acceptance it must be run when quota allows and its
  failure recorded as observed.
- The end-to-end product harness is not part of this run.
- Receipt text is captured through PowerShell file redirection: it is the raw process
  output as observed, not a re-serialization of a parsed result.

## Final-verification step 4: the closure check, run and preserved as-is

`PASS-EVIDENCE-AUDIT.md` asks for `verify-lite-scope.mjs --require-closed` to be run only after
the gates, and for its actual nonzero result to be preserved rather than made to pass. From this
same pinned revision:

```
node scripts/verify-lite-scope.mjs --require-closed
exit 1
AssertionError [ERR_ASSERTION]: required Lite acceptance remains open
231 !== 0
```

Raw `stdout`, `stderr` and the exit code are under
`evidence/gates-20260914/require-closed/`. The ordinary scope verifier still exits 0 at
matrixVersion 15 (`PASS 0 / GAP 26 / RUNTIME-VERIFY 205 / DEFERRED 164`), so the failure is
specifically the closure condition rather than a malformed matrix. No row was promoted to
change this result.

## Final-verification step 2: the CI run for this revision

The CI run for `0df73d75` itself is `34827184549` on workflow `CI`; its result has to be
preserved once terminal. It is listed here so the run id is not lost.

| Revision | CI run | Workflow |
| --- | ---: | --- |
| `0df73d7544f8c1d98feba83bbcca9e34ec28d91b` | `34827184549` | CI |

Earlier main revisions for context: `31020c9b` -> run `34810883168` (success), `f9cfbd00` ->
run `34764895472` (success).
