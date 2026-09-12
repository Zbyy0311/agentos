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

`M4_P4_REAL_OPENCODE_GATE=1` used to run that refusal as a contract: the Run
reached `failed`, the failure code was `PROVIDER_VERSION_UNSUPPORTED`, and zero
provider processes were spawned. A refused provider must never half-run. That
contract is superseded by section 3.1: the three conditions are now cleared
against the real CLI instead of removed.

## 3.1 Resolution — the canonical OpenCode chain completes (LITE-04-101)

| Condition from §3 | How it was cleared |
|---|---|
| an adapter-supported CLI version range | `OPENCODE_SUPPORTED_CLI_VERSION = '1.17.11'` — the exact build the gate exercised. `validate` still refuses every other version, so a silent CLI upgrade cannot change launch semantics. |
| verified non-interactive safe launch flags | the probe now runs `opencode run --help`. The top-level `--help` never lists `run` subcommand flags (`--pure`, `--dir`, `--model`, `--format`), so the old probe could not pass whatever the CLI answered. The admitted plan is `--pure run --format default --dir <cwd> [--model <m>] -- <prompt>`. |
| a verified cancellation protocol | cancellation is the AgentOS-owned Process Runtime stop path (atomic suspended spawn, Windows Job Object, `gracefulStop` → `terminateTree` → `verifySurvivors`), which is the same mechanism Codex and Kimi rely on. The adapter now requires an accepted stop ticket and delegates the graceful request to that port. |

Two harness defects had to be fixed as well, because together they made the
refusal unfalsifiable:

- `validate()` pushed `PROVIDER_VERSION_UNSUPPORTED` and
  `PROVIDER_CAPABILITY_UNAVAILABLE` **unconditionally**, after a probe that had
  succeeded, so `buildLaunchPlan` was unreachable for every configuration. The
  version error is now conditional on the observed version.
- `@agentos/agent-core` resolves through `dist/`. Without
  `pnpm --filter @agentos/agent-core build` the gate keeps loading the previous
  adapter, which showed up as a one-second `PROVIDER_VERSION_UNSUPPORTED`
  failure that no source edit could clear.

### Staged real verification

Launch-only, through the adapter's own launch plan and the real CLI, with
cancellation deliberately untouched (two runs, `--pure run --format default
--dir <tmp> --model deepseek/deepseek-v4-flash -- <prompt>`):

```
prompt 'Reply with exactly: READY'      -> exit 0, completed, stdout 'READY', 4405 ms
prompt '-x Reply with exactly: READY'   -> exit 0, completed, stdout 'READY', 4344 ms
```

The second run is the evidence for the `--` separator: without it a prompt that
starts with `-` is parsed as a flag instead of the message positional.

Cancellation-only, limited to the provider process tree the check spawned (no
other process was signalled):

```
spawn      owned spawn, pid 91908, windows Job Object, native birth
           identity win32:filetime:134337071867408619
stop ticket not accepted -> accepted false, PROVIDER_CANCEL_FAILED
stop ticket accepted     -> accepted true, graceful stop delivered
outcome    exit observed inside the grace window, no terminateTree escalation
survivors  classification 'complete', knownPids []
pid        gone (process.kill(pid, 0) -> ESRCH)
```

Canonical gate:

```
command: M4_P4_REAL_OPENCODE_GATE=1
         AGENTOS_OPENCODE_CLI=E:\software\opencode\node_modules\opencode-ai\bin\opencode.exe
         AGENTOS_OPENCODE_MODEL=deepseek/deepseek-v4-flash
         node --import tsx --test --test-name-pattern='real OpenCode completes'
         src/services/run-engine/RunEngineProviderDispatcher.test.ts
result:  PASS (22301 ms)
         run.status completed, all 4 stages completed, 4 runtime_processes,
         runtime_events > 0, outbox_messages == runtime_events,
         durable sink contains the provider's assistant text AGENTOS_PROVIDER_GATE_OK
```

### Finding: a vague stage prompt made the gate measure the model, not the chain

With the original fixture prompt `Execute the requested task.` the first real
OpenCode run wandered the temp directory, hit an auto-rejected
`external_directory` permission, and exited 0 **without ever emitting a final
assistant message**; stdout was 0 bytes while stderr held 60 KB of transcript.
The adapter correctly reported `PROVIDER_OUTPUT_INVALID`, so the failure was in
the gate's input, not in the chain. Real gates now seed a deterministic prompt
and assert that the provider's text reached the durable output sink, so the gate
measures AgentOS rather than how one model improvises around an underspecified
task.

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

## 7. Correction: the local real invocations cannot carry LITE-04-101 to PASS

The CI step `Lite scope and evidence gates` rejected matrix v12, and it was right
to. Its rule for a PASS row is that every cited evidence entry must carry an
EXECUTED result (`result.failed === 0`, plus `passed > 0` and `skipped === 0` for a
`local-tests` entry, or a successful Actions run for a CI entry) and must match the
row's baseline and requirement mapping. A `source-audit` entry has no result at
all, so citing `S4-PROVIDER-SOURCE` — and the older `S4-ADAPTERS` /
`S4-REAL-GATES` / `S4-CODEX-LUNA-GATE` entries from other baselines — as PASS
proof was invalid.

What changed:

- `LITE-04-001` now cites only `S8-PROVIDER-CONTRACT-SUITE` (agent-core, 28 files,
  171 passed, 0 failed, 0 skipped, same baseline).
- `LITE-04-101` goes back to `RUNTIME-VERIFY`. The three real invocations and the
  OpenCode cancellation proof above are genuine, but they depend on CLIs that exist
  only on this machine (`E:\software\opencode\...`, the local `.codex` and
  `.kimi-code` binaries), so they are machine-specific evidence: CI cannot recompute
  them, and a PASS claim has to survive recomputation. The implementation work
  itself is unchanged and is still described in the row.
- `scripts/verify-lite-scope.test.mjs` case 4 cloned the first matrix row to build
  its out-of-lock synthetic row. That only worked while the first row was
  `RUNTIME-VERIFY`; once it is legitimately PASS, the evidence-mapping check fires
  first and the scope-lock assertion is never reached. The synthetic row is now
  explicitly neutral (`state: 'GAP'`, no evidence) so the case tests the scope lock
  rather than row order. The assertion itself is unchanged.

What would close `LITE-04-101` honestly: a CI-executable real invocation (a provider
CLI available on the runner, or a CI-triggered gate), or a user-approved
reclassification of the row. It is not closed by local runs, by renaming the
evidence, or by relaxing the gate.

Matrix v13 is the corrected revision. Both gate commands pass at this head:

```
node --test scripts/verify-lite-scope.test.mjs   8 pass / 0 fail
node scripts/verify-lite-scope.mjs              {"matrixVersion":13,"status":"frozen",
                                                 "PASS":196,"GAP":26,
                                                 "RUNTIME-VERIFY":9,"DEFERRED":164}
```
