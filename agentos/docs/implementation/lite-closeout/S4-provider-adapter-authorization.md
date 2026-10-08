# S4 Provider adapter authorization (frozen v1)

Requirements: LITE-04-001 and LITE-04-101. Authority: user-approved tightened
plan plus S4-provider-production-audit.md. Base: merged main `48bb4321`; no
migration is added. This is adapter/composition remediation, not a Provider
framework rewrite.

## Fixed boundaries

- Kimi remains the existing direct `KimiCodeProviderAdapter`; no rewrite.
- Codex may reuse the existing legacy Codex JSON parser/probe evidence only
  through a narrow canonical `RuntimeProviderAdapter` wrapper with a fixed
  manifest identity, exact version, safe CLI Launch Plan, cancel and stable
  errors. A legacy Conversation runner call is not canonical proof.
- OpenCode may expose only capabilities proven by the current source and the
  official CLI contract (`opencode run`, `--format json`, bounded non-
  interactive execution). Authentication state, version support, cancellation
  and structured events must fail closed when not verified. An unavailable
  local executable is visible unavailable evidence, never a Mock PASS.
- Register all three canonical adapters in the production execution chain and
  provider-config validation composition. Existing stored adapter ids without
  adapterVersion receive only their documented built-in compatibility identity;
  unknown ids/versions fail closed.
- Actual invocation evidence remains a separate gate. Tests must cover
  discovery, validation, launch plan, parse, cancel, finalize, error
  normalization, and no secret/environment leakage. A skipped real gate cannot
  become PASS.

No Policy UI/DSL, provider comparison, workflow editor, or replacement Runtime
is authorized. If an adapter cannot support the canonical interface safely,
record the unavailable boundary instead of adding a prompt-only fallback to the
production registry.
