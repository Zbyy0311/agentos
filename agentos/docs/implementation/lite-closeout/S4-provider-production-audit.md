# S4 Provider production-chain audit (before remediation)

Requirements: LITE-04-001 and LITE-04-101; related RUNTIME-VERIFY rows remain
open. Inspection base: merged main `48bb4321` after PR145. Status: source
counterevidence, not implementation or real invocation evidence. Original
checkout remains untouched.

## Chain inventory

### Canonical production chain

`createProviderExecutionChain` currently constructs exactly one
`KimiCodeProviderAdapter` and one `ProviderRegistry`, then wires
`StageExecutionCoordinator`, `RunEngineProviderDispatcher`, canonical Runtime
Events, and the Run stream. This is real production composition, but only for
`kimicode`.

Kimi path evidence:

- Adapter -> Registry: `KimiCodeProviderAdapter` manifest/provider type and
  exact adapter identity are consumed by `ProviderRegistry`.
- Process Runtime: coordinator validates, builds a Launch Plan, claims
  Session/Process, spawns through the durable coordinator, captures output,
  and finalizes adapter state.
- Run Engine: dispatcher resolves Memory before provider work, executes the
  Stage, persists lifecycle, Artifact result, and terminal Candidate seams.
- SSE/UI: canonical Run Event routes stream persisted events; browser
  disconnect remains subscription-only. No broad UI acceptance is claimed here.

The existing dispatcher test has a real Kimi gate, but it is env-gated. Current
local runs skipped it because `M4_P4_REAL_GATE=1`/credentials were not part of
the acceptance environment. That skip cannot be treated as PASS.

### Codex

Codex has a legacy `CodexAdapter`, JSON parser, capability probe, invocation
builder, and Conversation runner support. Those are compatibility execution
capabilities, not canonical Run Engine production wiring. No
`RuntimeProviderAdapter` manifest with canonical provider type/adapter identity
is registered by `createProviderExecutionChain`, and no current-baseline real
canonical Codex invocation evidence exists in the Lite matrix.

Historical milestone documents describe an older real Codex gate. They are
directional evidence only; the closeout rule requires current implementation
and actual invocation proof against the final chain.

### OpenCode

OpenCode has legacy CLI detection, parser/conversation support, model
discovery, and usage-delta helpers. There is no production
`RuntimeProviderAdapter`, no canonical Registry registration, and no current
real invocation evidence. A missing local executable or unavailable protocol
support is not DEFERRED; it remains RUNTIME-VERIFY/GAP until either a truthful
adapter chain exists or the user explicitly defers the requirement.

## Bounded gap

Do not rewrite the three legacy adapters or invent a second provider framework.
The S4 remediation should first determine whether existing Codex/OpenCode CLI
event contracts can support the canonical RuntimeProviderAdapter interface.
Where they can, add the narrow adapter/composition seam and deterministic tests.
Where authentication, structured output, cancellation, or version support
cannot be proven, the chain must fail with stable unavailable evidence instead
of claiming production support.

Required exit for LITE-04-101 remains: Codex, Kimi, and OpenCode each produce
actual current-chain invocation evidence or a proven, visible unavailable
result, with the exact capability limits reflected in the matrix. Mock tests
cover deterministic failures, but do not replace real invocation evidence.
