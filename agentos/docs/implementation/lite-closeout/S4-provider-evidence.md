# S4 Provider production-chain implementation and evidence

Requirements: LITE-04-001 and LITE-04-101. Authority:
S4-provider-adapter-authorization.md plus the user-approved tightened plan.
Base: merged main `948b8008` (PR146). Current head after rebase:
`c783e928`; the earlier pre-rebase implementation head was `8cd7859a`.
No migration is added. Original checkout remains untouched.

## Implemented path

- Canonical `CodexProviderAdapter` (`builtin.codex@1.0.0`): fixed manifest,
  ProcessProbePort validation, `exec --json --skip-git-repo-check` launch plan
  with separated prompt and secret-free allowlisted environment, shared
  JSONL parser, assistant-output finalize, stop-ticket-fenced cancel, stable
  error normalization.
- Canonical `OpenCodeProviderAdapter` (`builtin.opencode@1.0.0`): conservative
  manifest that advertises only documented low-level capability; validation
  fails closed with stable unsupported evidence because the repository has no
  proven OpenCode event schema, version range, authentication probe or
  cancellation protocol. Launch plans are admitted only after successful
  validation; parser output is bounded and redacted.
- The Codex JSONL parser moved to the child-process-free
  `adapters/codexParser.ts`, shared by the legacy adapter and the canonical
  adapter, restoring the Provider-only import boundary.
- Built-in compatibility identities added for `builtin.codex` and
  `builtin.opencode`; unknown ids/versions still fail closed.
- Production composition and provider-config validation now register all
  three canonical adapters.

## Executed evidence

Windows / Node 24.18.0 / pnpm 11.11.0.

| Evidence | Result | Limit |
|---|---|---|
| Agent Core suite (28 files) | 171 pass, 0 fail | Includes architecture boundary test |
| Canonical adapter unit tests | 12 pass (5 Codex + 7 OpenCode) | Deterministic probes/fixtures only |
| Server focused regression (post-rebase) | 81 pass, 0 fail, 2 env-gated skips | Registry, provider routes, coordinator, dispatcher |
| Real Kimi canonical gate (head 8cd7859a) | PASS, 197s | Full Run/Stage/Event/Outbox through the real CLI |
| Real Codex canonical gate (head 8cd7859a) | PASS, 592s | Full canonical chain through the real codex.exe |
| OpenCode current-machine discovery | found=false, no candidate | External executable absent; unavailable evidence only |

### Final-head re-run is externally blocked

Re-running both real gates on the rebased head `c783e928` failed with external
quota exhaustion, not a product regression:

- Codex stderr: `unexpected status 403 Forbidden: Provider error 403: You've
  reached your weekly (7-day) usage limit.`
- Kimi gate: `PROVIDER_AUTH_REQUIRED` from the same Kimi-backed subscription
  path.

Both real gates passed on the content-equivalent pre-rebase head; the rebase
delta is the merged S3 approval-gate composition, which the focused suite
covers. Because the final-head real invocation cannot run until the external
quota resets, LITE-04-001/101 keep their GAP/RUNTIME-VERIFY states. OpenCode
is not installed on this machine, so its canonical chain has unavailable
evidence only; no Mock was substituted for a real call.

## First failures retained

- Codex gate iteration 1: `PROVIDER_CAPABILITY_UNAVAILABLE` because the test
  snapshot still declared Kimi's `modelSelection: true`; the adapter correctly
  failed closed. Fixture capability corrected.
- Iteration 2: `PROVIDER_VERSION_UNSUPPORTED` because `buildLaunchPlan` read a
  raw `configuration.adapterVersion` that the snapshot omits; switched to the
  frozen-identity resolver.
- Iteration 3: real CLI rejected a bare `--json` invocation
  (`structured output is unavailable`); adapter now always materializes
  `exec`. Iteration 4 revealed the CLI's trusted-directory requirement via
  persisted stderr; `--skip-git-repo-check` added without the dangerous
  bypass flags. Iteration 5 passed.
- Agent Core architecture test caught the canonical adapter pulling
  `node:child_process` through the legacy adapter; resolved by extracting the
  child-process-free parser module.
- The final-head real-gate re-run failed on external quota exhaustion (above).
