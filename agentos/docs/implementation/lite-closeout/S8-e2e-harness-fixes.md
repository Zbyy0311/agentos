# S8 E2E harness: two defects that made real-provider acceptance unreadable

This note covers harness and test scripts only. No matrix row changed state and
PASS remains frozen at 0, so nothing here is acceptance closure.

## Defect 1: an ambient Kimi API key silently replaced the configured provider

`resolveAgentEnvironment` treats an inherited `AGENTOS_KIMI_API_KEY` as a request
for AgentOS's own Kimi endpoint: it injects `KIMI_MODEL_API_KEY` plus
`KIMI_MODEL_BASE_URL=https://api.kimi.com/coding/v1`, and
`resolveAgentRuntimeConfig` then deletes the configured `-m` routing. A model
that only exists on the local loopback is sent to the official endpoint, the CLI
exits 1, and the failure reads exactly like an account problem.

Diagnostics from the real runs name the mode directly:

| Run | executor.log | Result |
| --- | --- | --- |
| 2026-09-13T16:30Z | `kimiAuth=api_key` | `REAL_DIRECT_KIMI: failed` |
| 2026-09-13T16:37Z | `kimiAuth=oauth` | `REAL_DIRECT_KIMI: passed` |
| 2026-09-14T04:33Z | `kimiAuth=oauth` | harness reached the routed CLI |

Controlled A/B on the same SHA (`f9cfbd00`), same routed models, only the ambient
keys differing: with the keys present the harness exited 1 with Kimi failing;
with them cleared both phases exited 0 and every gate passed.

Fix: the harness removes `AGENTOS_KIMI_API_KEY` / `KIMI_API_KEY` for its own run
and restores them afterwards, and it routes codex, kimi and opencode through the
reviewed loopback models (`AGENTOS_E2E_CODEX_MODEL`, `AGENTOS_E2E_KIMI_MODEL`,
`AGENTOS_E2E_OPENCODE_MODEL` override) while printing each effective model, so
the log names what actually answered. The model flag is replaced **in place**:
appending it broke kimi's `-p <prompt>` positional pairing and produced two
consecutive harness failures before the in-place version was used.

## Defect 2: phase-irrelevant gates printed as `failed`

`verify-agentos-e2e.mjs` initialised the three non-recovery gates to `false` in
every phase and printed them unconditionally, so the recovery phase always
emitted `failed` for gates it never ran. The strict wrapper preserves any
`failed` occurrence, which made it impossible for any run to pass: at `f9cfbd00`
a harness whose two phases both exited 0 still produced `S8_GATES: failed` with
three raw gate failures.

Fix: gates a phase does not execute are `null` and print `not_run`; the wrapper
tolerates `not_run` only for a gate that also recorded a `passed` occurrence, and
still retains every `failed` occurrence, so no gate can be treated as passed
without a real passed verdict.

## Quota probes behind the routing defaults

| CLI | Model | Observed |
| --- | --- | --- |
| Kimi | `kimi-code/k3` (machine default) | exit 1, 403 weekly limit |
| Kimi | `kimi-code/kimi-for-coding` (previous E2E default) | exit 1, 403 weekly limit |
| Kimi | `opencodex/deepseek/deepseek-flash` | exit 0 |
| Codex | `gpt-6-astra` (machine default) | exit 1, usage limit |
| Codex | `deepseek/deepseek-flash` | exit 0 |
| OpenCode | `deepseek/deepseek-v4-flash` | exit 0 |

## Verification

- Regression suite: 27 pass / 0 fail / 0 skip, including new cases that require
  `not_run` to be tolerated only for a gate that passed in its owning phase, and
  that a gate reporting only `not_run` is still rejected.
- Harness run at `3bc32044d5c9bbc3e5cbb9f9786f89708ac0322a`: raw exit 0, both
  phases exit 0, all gates passed; strict wrapper `S8_GATES: passed` (exit 0)
  against that log with `-RawExitCode 0`.
- The earlier harness commits in this branch failed for two implementation
  reasons (a missing `model` property on the codex profile, and the out-of-place
  `-m` append). Both are kept in the record; only the corrected version is green.

## Open product finding (not changed here)

Outside the harness, an ambient `AGENTOS_KIMI_API_KEY` still overrides an
explicitly configured routed Kimi model for ordinary runs, because the API-key
path removes `-m` and points the CLI at the official endpoint. The harness
sanitises this for acceptance; changing the product behaviour (honour the
explicit CLI model, or require the key path to name a hosted model) is a design
decision that needs its own authorization. No matrix row changes on account of
it.

## Boundaries

Matrix stays v15 with 0 PASS / 26 GAP / 205 RUNTIME-VERIFY / 164 DEFERRED, and
`--require-closed` is still expected to exit non-zero (231 open). A green E2E
means the harness measured the configured chain; it is not acceptance closure
and it adds no PASS.
