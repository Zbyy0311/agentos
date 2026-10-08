## Requirements / bounded exit

LITE-04-001 and LITE-04-101, S0 matrix v9. Registers canonical Codex and
OpenCode Provider adapters in the real production chain next to the existing
Kimi adapter, without rewriting the legacy adapters or adding a second
framework. Rows stay GAP/RUNTIME-VERIFY until the final-head real gate can run
and OpenCode can produce more than unavailable evidence.

## Change boundary

- New `builtin.codex@1.0.0` canonical adapter: ProcessProbePort validation,
  `exec --json --skip-git-repo-check` plan with separated prompt and
  secret-free allowlisted environment, shared JSONL parser, stable
  finalize/cancel/error contracts.
- New `builtin.opencode@1.0.0` conservative adapter: documented low-level
  capability only; validation fails closed with stable unsupported evidence
  because no OpenCode event schema/version/auth/cancel protocol is proven in
  the repository. No fabricated structured-event contract.
- `adapters/codexParser.ts` extracted as a child-process-free shared module so
  the Provider-only entrypoint keeps its no-native-subprocess boundary.
- Built-in compatibility identities for Codex/OpenCode; production execution
  chain and provider-config validation register all three adapters.
- No Policy DSL/UI, provider comparison, workflow editor or migration changes.

## Evidence / merge gates

- Agent Core: 28 files / 171 tests pass (includes the architecture boundary
  test). Canonical adapter unit tests: 12 pass.
- Post-rebase Server focused regression: 81 pass, 0 fail, 2 env-gated skips
  (registry, provider routes, coordinator, dispatcher).
- Real canonical gates on the content-equivalent pre-rebase head `8cd7859a`:
  Kimi PASS 197s; Codex PASS 592s, full Run/Stage/Event/Outbox each.
- OpenCode: current machine has no executable; discovery returns found=false.
  Unavailable evidence only, never a Mock PASS.
- The rebased-head gate re-run is blocked by external kimi.com weekly quota
  exhaustion (Codex stderr 403 "You've reached your weekly (7-day) usage
  limit"; Kimi auth required). This is an external limit, preserved as such;
  the final-head real invocation stays RUNTIME-VERIFY.

First failures and corrections are listed in S4-provider-evidence.md. CI must
be green on the exact head before merge; no product code was changed to mask
any failure.
