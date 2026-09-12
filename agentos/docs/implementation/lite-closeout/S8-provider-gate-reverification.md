# S8 provider-gate re-verification and the OpenCode finding

Requirements touched: LITE-04-001, LITE-04-101, LITE-08-004, LITE-13-002.
Base: S8 worktree on `c5315708`. Nothing here changes a frozen guarantee; the
OpenCode refusal therefore stays a refusal and becomes testable instead.

## 1. KimiCode real gate — PASS with an explicitly routed model

The Kimi account backing the default model is quota-blocked (403 weekly,
reproduced by a direct CLI probe), but the CLI itself carries a second, working
provider. Read from the kimi-code config.toml:

```toml
[providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_key = "opencodex-loopback"

[models."opencodex/deepseek/deepseek-flash"]
provider = "opencodex"
model = "deepseek/deepseek-flash"
```

Direct probe: `kimi -m opencodex/deepseek/deepseek-flash -p 'Reply with exactly:
DSOK'` produced `DSOK`, exit 0. The quota is an account/model restriction, not a
CLI restriction.

The gate harness now reads each provider's model from the environment
(`AGENTOS_KIMI_MODEL`, `AGENTOS_CODEX_MODEL`, `AGENTOS_OPENCODE_MODEL`), so a
gate names the exact model it ran against instead of silently taking the machine
default. Result:

```
command: M4_P4_REAL_KIMI_ROUTED_GATE=1 AGENTOS_KIMI_MODEL=opencodex/deepseek/deepseek-flash
         node --import tsx --test --test-concurrency=1 src/services/run-engine/RunEngineProviderDispatcher.test.ts
result:  LITE-04-101 current-machine Kimi gate with an explicit routed model: PASS (170038 ms)
         32 pass / 0 fail / 2 skipped
```

That is a real kimi CLI process driving the canonical
Adapter -> Registry -> Process -> RunEngine chain to `completed`, with Runtime
Event and Outbox counts equal.

## 2. OpenCode was never absent — it was off PATH

`where.exe opencode` and `resolveCommand('opencode')` both return nothing, which is
why the S4 discovery record said the external executable was absent. The binary is
present, just not on PATH:

```
E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe
opencode --version -> 1.17.11   (exit 0)
```

AgentOS already runs it for real: the E2E fixture configures that absolute path,
so `REAL CLI opencode: available` and `REAL_DIRECT_OPENCODE: passed` in run 2 are
genuine real-CLI results through the Conversation path. The earlier unavailable
claim came from a PATH-only probe and is corrected here.

## 3. The canonical OpenCode chain refuses by construction

The RunEngine chain is a different path from the Conversation path, and the
canonical OpenCode adapter is deliberately fail-closed. Read directly:

| Method | Behaviour |
|---|---|
| `validate` | After successfully probing `--version` it still pushes `PROVIDER_VERSION_UNSUPPORTED: OpenCode CLI compatibility range is not established` unconditionally, plus `safe launch flags are not verified` and `cancellation protocol is not verified`. |
| `buildLaunchPlan` | Requires a successful supported validation, so it is unreachable. |
| `cancel` | Returns `accepted: false` — `OpenCode cancellation is not verified`. |

Exact conditions to clear for LITE-04-101 on this provider:

1. an adapter-supported OpenCode CLI version range,
2. verified non-interactive safe launch flags,
3. a verified cancellation protocol.

`M4_P4_REAL_OPENCODE_GATE=1` now runs that refusal as a contract: the Run reaches
`failed`, the failure code is `PROVIDER_VERSION_UNSUPPORTED`, and zero provider
processes are spawned. A refused provider must never half-run.

## 4. Defect found and fixed: the OpenCode identity check read a field production never sets

`configurationFromSnapshot()` (StageExecutionCoordinator) projects the frozen
provider snapshot into a `ProviderConfigurationInput`, and
`ProviderConfigurationSnapshotV1` has no `adapterVersion` field. The Kimi and Codex
adapters resolve the configured identity through `resolveFrozenProviderIdentity`,
which carries a built-in compatibility identity; the OpenCode adapter instead
compared `configuration.adapterVersion` directly, so it rejected every production
configuration — including the compatibility case its own registry entry was added
for.

Fix: `normalizeConfiguration` backfills the resolved version and `validate` checks
the resolved frozen identity, matching the other two adapters. After the fix the
version error became the intended, documented refusal above rather than a spurious
identity error.

## 5. Defect found and fixed: real gates leaked module state

`REAL_PROVIDER_TYPE` and `REAL_EXECUTABLE` are module-level and drive the provider
snapshot. A real gate that ran set them for every later test, so five unrelated
tests failed with `'failed' !== 'completed'` once more than one gate executed. The
fake fixture now declares its own identity (`kimicode` plus its fixture executable)
and `realFixture` returns a `restore()`. Full file with the OpenCode gate active:
32 pass / 0 fail / 3 skipped.

## 6. Inspector: the effective mutation class was not actually readable

`InspectorRunOverview.mutationClass` was declared but hardcoded to `null`, so
LITE-08-004's requirement that unavailable enforcement be visible had no read
surface. The projection now reports the durable admission row: `mutationClass`,
`requestedMutationClass`, and `readOnlyEnforcement` in
{proven, unavailable, not-applicable, unknown}. A Run with no admission row stays
explicitly `unknown` — a different statement from `unavailable`.

Covered by `apps/server/src/routes/runtimeInspector.test.ts` (4 pass).

