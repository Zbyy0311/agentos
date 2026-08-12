# AgentOS M4 Process & Provider Runtime — Current-State Audit

Status: P0 CONTRACT CLOSURE COMPLETE — PENDING INDEPENDENT P0 REVIEW — DOCS ONLY — M4 PRODUCTION IMPLEMENTATION NOT AUTHORIZED

## 1. Metadata / exact baseline

| Field | Evidence |
|---|---|
| Repository | `Zbyy0311/agentos` |
| Authorized main / audit tree | `af3c684a0585d654d785ace9666620ee46f37728` |
| Source | PR #43 merge commit; PR #43 state `MERGED` |
| Post-merge CI | Run `31594803731`, event `push`, branch `main`, head `af3c684a0585d654d785ace9666620ee46f37728`, conclusion `success` |
| M3 | Formal closeout complete |
| Migration registry | `001`–`013` |
| Migration 014 | NOT CREATED / NOT AUTHORIZED |
| PR #45 | OPEN / DRAFT / head `60e5845d5db0a9164621cb23384686e9d8d2bb30`; forensic-only, frozen, not used as M4 evidence |
| Audit date | 2026-08-12; HIGH-1 remediation and P0 contract closure 2026-08-13 (Asia/Shanghai) |

The working tree was clean before branch creation. The branch
`docs/m4-process-provider-preplanning` was created directly from the exact
authorized main SHA. This audit changes no source, test, workflow, schema,
migration registry, Runtime Specification, M3 record, or PR #45.

## 2. Audit methodology

1. Verified local/remote SHA, PR #43, the exact post-merge CI run, and PR #45.
2. Read the required Runtime Specification sources and reconciled them against
   the current main tree rather than treating the July specification as
   implementation evidence.
3. Read the M3 implementation plan, Owner Decision register, final closeout,
   migration register, migrations `001`–`013`, repositories, services, routes,
   shared types, provider adapters, tests, and historical provider acceptance
   evidence.
4. Searched production code repository-wide for `child_process`, `spawn`,
   `execFile`, `execSync`, `kill`, `AbortController`, PID/process references,
   provider names, recovery, output, cancellation, timeout, and disconnect.
5. Traced every production subprocess creation wrapper to its caller and
   classified it. Test and script subprocesses were identified but excluded
   from the production inventory.
6. Performed a side-effect-light current-machine probe only: KimiCode resolved
   to `C:\Users\Administrator\.kimi-code\bin\kimi.exe` (`0.23.5`), Codex to
   `C:\Users\Administrator\AppData\Roaming\npm\codex.ps1` (`0.146.0`), and
   OpenCode was not found. No login, installation, config write, or provider
   Session was performed.

Status vocabulary is evidence-based:

- `IMPLEMENTED`: the current main production path implements the stated slice.
- `PARTIAL`: a usable portion exists but the M4 contract is incomplete.
- `LEGACY`: production behavior exists in a compatibility/old aggregate path.
- `MISSING`: the required production capability or resource does not exist.
- `CONFLICTING`: current behavior violates or competes with the target contract.
- `UNKNOWN`: evidence is insufficient; the audit does not guess.

## 3. Authoritative contract sources

The planning contract is derived from the following sources, in this order for
current-state interpretation:

1. exact main tree at `af3c684a...`;
2. M3 merged contract and closeout evidence;
3. Runtime Specification target contracts;
4. historical migration/acceptance records, used as context rather than as a
   substitute for current code.

Key target evidence:

- The complete required target set was reviewed: `00-Vision.md`,
  `01-Core-Concepts.md`, `02-Runtime-Lifecycle.md`, `03-Event-Model.md`,
  `04-Provider-Specification.md`, `05-Process-Runtime.md`, `10-Data-Model.md`,
  `11-API-Specification.md`, and `14-Roadmap.md`, together with
  `docs/implementation/migration-register.md`,
  `M3-lifecycle-event-api-implementation-plan.md`, `M3-owner-decisions.md`, and
  `M3-final-closeout.md`.
- Agent, Provider Configuration, Run, Provider Session, and Runtime Process are
  separate identities (`docs/Runtime-Specification/01-Core-Concepts.md:306-610`,
  `869-1198`, `2194-2219`).
- Provider Adapter is the provider protocol boundary; it must not mutate Run
  state and must use the Process port (`04-Provider-Specification.md:488-754`).
- Process Manager owns process bytes/tree/timeout/recovery, while Adapter owns
  provider semantics (`05-Process-Runtime.md:496-704`, `3591-3604`).
- Browser disconnect ends only a subscription and never cancels a Run
  (`02-Runtime-Lifecycle.md:2384-2428`).
- M4 should prove “Process + one Provider” first; the default is KimiCode
  Direct (`14-Roadmap.md:3630-3689`).
- M3 freezes canonical lifecycle/event/idempotency and uncertainty semantics;
  recovery never guesses success
  (`docs/implementation/milestones/M3-owner-decisions.md:688-743`,
  `M3-final-closeout.md:90-121`).

## 4. Current process architecture

### 4.1 Provider execution process path — PARTIAL / LEGACY

`CLIExecutor.execute()` currently owns executable resolution, Provider adapter
resolution, environment assembly, Kimi home copying, `spawn`, stdin, stdout and
stderr buffering, timeout timers, `AbortSignal`, child termination, provider
parsing, output strings, and file log persistence in one class
(`packages/agent-core/src/executor.ts:275-596`, `638-684`). It spawns with
`shell: false`, array arguments, an explicit cwd, piped output, and
`windowsHide: true` (`executor.ts:431-438`). These are useful implementation
assets, not a Process Runtime abstraction.

The generated `executionId` is a 12-character diagnostic correlation only; it
is not durable AgentOS Process identity (`executor.ts:275-307`). OS PID is
written only to best-effort diagnostic text (`executor.ts:439`). There is no
`ProcessManager`, `ProcessRepository`, handle registry, platform driver,
Process event producer, or durable process record in production code (complete
symbol search returned no implementation).

### 4.2 Termination and timeout — PARTIAL / CONFLICTING

The executor supports optional inactivity timeout, a default 30-minute total
timeout, and AbortSignal cancellation (`executor.ts:25-39`, `461-542`). It
updates activity on stdout/stderr. On POSIX it sends `SIGTERM`, then schedules
`SIGKILL`; on Windows it calls only `child.kill()` (`executor.ts:482-489`). It
settles its Promise immediately after requesting kill (`executor.ts:492-530`),
before process-tree survivor verification.

This does not satisfy owned-tree cancellation. No detached process group,
Windows Job Object, `taskkill /T` fallback, child/grandchild inspection, or
survivor report exists. A timeout and an explicit cancel also collapse to a
`null` exit code and generic CLI failure instead of stable process termination
semantics.

### 4.3 Output — PARTIAL / CONFLICTING

The executor uses independent UTF-8 `TextDecoder`s and Provider parsers
(`executor.ts:447-459`, `544-563`), but it accumulates stdout/stderr in
unbounded strings (`executor.ts:369-379`, `456-458`). Provider JSONL is parsed
and not written verbatim to the per-task log; the persisted log stores only
counts and explicitly omits output (`executor.ts:667-683`). Conversation
runtime may create public artifacts from normalized events, but there is no
per-Process raw stdout/stderr artifact, byte offset, access classification, or
backpressure-aware raw sink (`ConversationService.ts:855-889`,
`RuntimeArtifactCollector.ts:45-110`). Thus raw output is not reliably
traceable as required by E05.

### 4.4 Shutdown — CONFLICTING

Server shutdown stops publishers/retention, closes HTTP and SQLite, releases
server ownership, and exits (`apps/server/src/index.ts:300-324`). It does not
enumerate, stop, detach, or record active provider processes. Current child
handles are local to `CLIExecutor`; there is no server-wide handle registry.

## 5. Current provider architecture

### 5.1 Provider configuration — PARTIAL

Migration 003 and `ProviderConfigurationRepository` persist configuration data
with Provider Type, adapter ID, runtime mode, executable, argument template,
model, environment/secret references, cwd mode, capabilities, timeout policy,
approval/output mode, enabled/archive/version state
(`apps/server/src/migrations/migrations/003-workspace-provider-config.ts:31-63`,
`apps/server/src/store/ProviderConfigurationRepository.ts:6-99`, `118-247`).

The CRUD routes enforce workspace isolation, optimistic version updates,
archive constraints, enum/shape checks, and reject named raw secret fields in
favor of `secretProfileId` (`apps/server/src/routes/providerConfigs.ts:8-97`,
`127-301`). Snapshot creation freezes executable, arguments, model, references,
capabilities, timeout and other fields, scans sensitive arguments, and excludes
resolved secrets (`apps/server/src/services/SnapshotService.ts:152-190`).

Gaps: no Environment Profile or Secret Profile persistence/resolver exists;
references can be stored but not resolved through the specification port. The
route accepts arbitrary `adapterId`, partial capabilities and timeout objects,
and executable strings without Registry/executable/auth validation. There is
no validation status/history/cache table or Validation API.

### 5.2 Adapter registry — PARTIAL

`AgentCliAdapterRegistry` resolves a configured Provider, probes a command,
detects mismatch, selects a structured adapter when supported, and otherwise
falls back to plain text (`packages/agent-core/src/adapters/registry.ts:28-101`).
It constructs a new registry per execution and registers only Codex and Kimi
plus optional injected adapters (`registry.ts:28-37`). It is not the manifest,
versioned, installable `ProviderRegistry` contract, and Adapter version is not
frozen in current snapshots.

The adapter interface covers probe, invocation construction and chunk parsing
only (`packages/agent-core/src/adapters/types.ts:41-83`). It lacks the planned
start/resume/cancel/finalize/normalizeError/session contract and a constrained
Process port. Although adapters themselves do not call `spawn`, `CLIExecutor`
combines adapter and process responsibilities.

### 5.3 Provider configuration is not yet execution authority — CONFLICTING

M3 snapshots correctly freeze Provider Configuration, but the production
Legacy execution ultimately passes a `WorkspaceAgent` to `AgentRunner`, whose
configuration is still expressed as role/CLI fields. `SnapshotService.runnerAgent`
copies executable/args/model but does not copy explicit provider identity
(`SnapshotService.ts:230-245`); `AgentRunner` merges it with hard-coded
stage defaults (`packages/agent-core/src/runner.ts:30-99`). This preserves the
legacy four-stage path and leaves provider identity inference tied partly to
role/command.

## 6. Direct-spawn inventory

The inventory below is complete for production TypeScript under `apps/` and
`packages/` at the audited SHA. Tests, E2E scripts, web test runners, and fixture
CLIs are `TEST_ONLY` and are not listed as production paths. `execFile` is
included because it ultimately creates a process.

| ID | File / symbol / caller | Provider / ownership / Run relation | Cancel / timeout / output / persistence / restart / disconnect | Classification / M4 disposition |
|---|---|---|---|---|
| DS-01 | `packages/agent-core/src/executor.ts:275-596`, `CLIExecutor.execute`; called by `AgentRunner.executeAndRecord` and `ConversationAgentRunner.run` | Codex, KimiCode, OpenCode/custom CLI; owned by caller stack; Legacy path has canonical Task-domain Run/Stage, Conversation path has old `agent_runs`/`executions` | Abort + inactivity + total timeout; kills one child only on Windows; stdout parsed, stderr buffered; summary/file logs and old Conversation events/invocations, no durable Process; restart cannot reattach; Conversation request close can abort, Legacy close cannot | `MIGRATE`; first wrap behind Process Runtime, then remove direct provider spawn from agent-core |
| DS-02 | `packages/agent-core/src/resolveCommand.ts:9-63`, `resolveCommand`; called by CLIExecutor and `/api/agents/.../status` | Provider executable discovery helper; pre-Run or startup support | no explicit timeout/cancel; captures small stdout/stderr; no persistence/recovery; request-scoped status query may end independently | `KEEP_BEHIND_PROCESS_RUNTIME` for launch validation; side-effect-light discovery may use a bounded validation driver, not an owned long-running Provider Process |
| DS-03 | `packages/agent-core/src/adapters/capabilityProbe.ts:26-93`, `runProbeCommand`; called by Codex/Kimi adapters and Registry | Provider validation probe; no Provider Session/Run execution | `execFile` timeout 5s by default; buffered output; no durable validation result; restart/disconnect only loses probe | `KEEP_BEHIND_PROCESS_RUNTIME`; move to bounded validation execution seam, distinct from Provider Session execution |
| DS-04 | `apps/server/src/services/CliModelDiscovery.ts:207-233,367-380`, OpenCode `models` probe | OpenCode model discovery; request/cache owned; no Run | 3s timeout, bounded buffer; no cancel/persistence beyond in-memory cache; safe fallback; disconnect not wired to kill | `KEEP_BEHIND_PROCESS_RUNTIME` validation/discovery seam; not provider execution |
| DS-05 | `packages/agent-core/src/workspaceChanges.ts:24-39`, `captureWorkspaceSnapshot`; called before/after CLI execution | Git status observation associated with old execution, not Provider | no explicit timeout/cancel; stdout buffered; result folded into file-change callbacks; no restart meaning | `UNRELATED` to initial Provider slice; future all-local-process rule may route via Process Runtime, but M5 owns Git/Worktree semantics |
| DS-06 | `apps/server/src/routes/git.ts:9-31`, `executeGitFile/runGit`; called by read-only Git routes | Git CLI, route-owned, workspace-related, no Run | 10s timeout; response buffer only; no durable Process/restart; HTTP lifecycle owns result | `UNRELATED` / M5 conflict zone; do not fold into first Provider migration |
| DS-07 | `apps/server/src/services/RuntimeArtifactCollector.ts:184-209`, `execGit`; called during old Conversation artifact collection | Git status/diff support for an old Run | synchronous, buffered, no timeout/cancel/process identity; derived artifacts may persist; no recovery | `UNRELATED` / M5; record as technical debt, do not broaden initial M4 slice |
| DS-08 | `apps/server/src/services/WorktreeManager.ts:18-86`, `git`; called by lease create/preflight/reconcile/remove | Git Worktree support with a Run/execution lease | 10s timeout; buffered; lease JSON persisted; no Process identity/tree/restart attachment | `UNRELATED` / M5; preserve behavior and coordinate future process routing |
| DS-09 | `apps/server/src/services/WorktreeArtifactService.ts:16-167`, `git/tar/tarList/extract`; called by bundle create/verify | Git/tar artifact support tied to old Run/execution | 10s timeout, buffers output; artifacts persist; no process cancel/tree identity; cleanup guarded | `UNRELATED` / M5; no first-slice migration |
| DS-10 | `apps/server/src/managers/WorkspaceManager.ts:136-203`, `initializeWorkspaceDirectory` | `git init` system setup; no Run | synchronous, pipe buffer, no timeout/cancel/persistence/recovery; request blocks | `UNRELATED`; workspace lifecycle, not Provider/Run execution |

No production `fork`, `exec`, `spawnSync`, Deno/Bun/execa/cross-spawn path was
found outside the wrappers above. `scripts/**`, `*.test.ts`, fixtures, and the
web test runner remain `TEST_ONLY`.

## 7. Execution ownership graph

### 7.1 Current graph

```text
Legacy task POST /tasks/:taskId/run
  -> tasks.ts creates canonical Run + Start Operation, starts subscription
  -> LegacyCanonicalExecutionService                 [single Legacy authority]
  -> AgentRunner                                     [fixed stage orchestrator]
  -> CLIExecutor                                     [process + adapter mixture]
  -> child_process.spawn

Conversation POST .../messages/stream
  -> conversations.ts creates request AbortController
  -> ConversationService                             [old agent_runs state owner]
  -> ConversationAgentRunner                         [single-agent orchestrator]
  -> CLIExecutor                                     [process + adapter mixture]
  -> child_process.spawn

Canonical M3 Start API
  -> TaskRunService creates/guards Run Start Operation
  -> RunEngine / WorkflowExecutor / synchronous StageExecutor seam
  -X-> no production scheduler/bootstrap wiring to provider subprocess
```

Evidence: `LegacyCanonicalExecutionService` is the only production constructor
of `AgentRunner` (`apps/server/src/services/LegacyCanonicalExecutionService.ts:81-164`);
ConversationService constructs `ConversationAgentRunner`
(`ConversationService.ts:237-268`, `680-710`). A production search found no
`new RunEngine` outside tests. `RunEngine` uses a synchronous, injected
`StageExecutor` result seam and imports no Provider/Process/CLI implementation
(`apps/server/src/services/run-engine/RunEngine.ts:151-330`,
`StageExecutor.ts:116-124`).

### 7.2 Risks and required single authority

- Duplicate authority risk: high if M4 adds RunEngine execution while leaving
  Legacy/Conversation callers able to spawn the same accepted Run.
- Double execution risk: an accepted `run.start` Operation is not currently a
  background dispatch guarantee; replay must never call provider execution.
- Lifecycle authority: RunEngine/LifecycleTransactionService must remain the
  only canonical Run/Stage state authority.
- Execution authority target:

```text
Start Operation / scheduler claim
  -> RunEngine
  -> Stage execution coordinator (one authority lease per Stage attempt)
  -> ProviderRegistry -> selected ProviderAdapter
  -> ProviderProcessPort -> ProcessManager
  -> PlatformProcessDriver -> OS process tree
```

Provider Adapter may interpret output/finalize but may not transition Run
directly. ProcessManager may report process facts but may not invent provider
or Run success. Legacy routes must initiate/observe the same authority chain or
remain explicitly compatibility-only; they must not retain a second spawn path.

## 8. Process identity / persistence audit

| Identity / field | Current evidence | Classification |
|---|---|---|
| AgentOS Process ID | `runtime_events.process_id` exists as an unvalidated text reference (`migration 012:94-127`); no process entity/allocator/repository | MISSING |
| OS PID | only transient `child.pid` diagnostic text (`executor.ts:439`) | MISSING durable evidence |
| Run ID | canonical `runs.id`; old `agent_runs.id` remains separate | IMPLEMENTED, dual aggregate boundary preserved |
| Stage ID | canonical `run_stages.id` | IMPLEMENTED |
| Execution ID | old Conversation `executions.id`; CLI local diagnostic ID; no canonical M4 execution-attempt entity | PARTIAL / CONFLICTING nomenclature |
| Provider identity/config | `provider_configurations`, agent binding and immutable Run snapshot | IMPLEMENTED configuration slice |
| Provider Session ID | optional Runtime Event reference only; no entity | MISSING |
| startedAt / endedAt | available for Run/Stage and old invocation summary, not Process | PARTIAL |
| exitCode | old completed `run_cli_invocations.exit_code`, no active Process record | LEGACY / PARTIAL |
| signal / termination reason | not durable | MISSING |
| process state / tree | not durable | MISSING |
| recovery identity | no PID start time, executable fingerprint, token or ownership epoch | MISSING |
| raw output references | no Process stdout/stderr artifacts | MISSING |

Pre-P0 classification was **SCHEMA PARTIAL / SCHEMA CHANGE CANDIDATE**. Existing Run,
Stage, Runtime Event reference fields and Provider Configuration should be
reused. They are not sufficient to represent a durable AgentOS Process distinct
from PID, tree ownership, active state, termination, output references and
recovery identity. The old Conversation tables cannot be silently repurposed
because they bind to `agent_runs` and model completed CLI invocations, not the
canonical M3 Process contract.

P0 closes the design uncertainty, not migration authorization:

```text
SCHEMA_PROPOSAL_REQUIRES_FUTURE_MIGRATION
OD-M4-01 UNDECIDED
OWNER/ENTRY AUTHORIZATION REQUIRED BEFORE MIGRATION CREATION
```

Migration 014 remains NOT CREATED / NOT AUTHORIZED / NOT RESERVED. No number is
allocated and no SQL is proposed by this package.

## 9. Output / event path

### 9.1 Current paths

```text
provider stdout bytes
  -> TextDecoder
  -> AgentCliAdapter parser or PlainTextAdapter
  -> NormalizedCliEvent
  -> Legacy: onChunk -> M3 stream.text_delta transaction -> legacy SSE projection
  -> Conversation: old AgentEvent / RuntimeEventBuffer / EventBus + artifacts

provider stderr bytes
  -> unbounded string
  -> CLIError/public omission + count-only file log
```

Legacy canonical text is persisted before projection
(`LegacyCanonicalExecutionService.ts:122-170`, `434-452`). M3 canonical events,
Outbox, replay, and stream are durable. In contrast, the agent-core normalized
event vocabulary is an older protocol; shared M3 registry currently implements
the M3 lifecycle and `stream.text_*` subset but no Provider/Process event
definitions (search evidence in
`packages/shared/src/types/m3-runtime-registry.ts:1437-1464`).

### 9.2 Proposed responsibility boundary

```text
Process Runtime:
  raw bytes, stream identity, decoding/framing primitives, bounded buffering,
  activity, byte offsets, restricted raw artifacts, process facts

Provider Adapter:
  provider JSONL/text interpretation, redaction, Provider events, stable
  Provider errors, session/finalization semantics

M3 Runtime Event layer:
  canonical validation, sequence, persistence, Outbox, replay and subscriptions

RunEngine/LifecycleTransactionService:
  Run/Stage transitions and output-contract decision

Conversation/Legacy projections:
  read persisted Runtime Events; never own process lifetime
```

ProcessManager must not recognize Kimi/Codex/OpenCode semantics. Provider
Adapter must not write Run state or bypass ProcessManager. Raw bytes must be
traceable without exposing secrets or hidden reasoning.

## 10. Cancellation / process-tree audit

| Layer | Current behavior | Status / implication |
|---|---|---|
| Canonical Run cancel | `/api/runs/:id/cancel` currently calls `cancelQueuedRunForV2`; only queued Run is cancellable (`TaskRunService.ts:1217-1260`) | PARTIAL; no active Process propagation |
| Operation cancel | M3 Operation contract explicitly cancels authorization/Operation, not an OS process | IMPLEMENTED M3 semantics; M4 must not reinterpret it silently |
| Conversation Run cancel | `RunStreamRegistry.cancel()` aborts the stored controller (`RunStreamRegistry.ts:80-84`) | LEGACY; reaches CLI child but not tree |
| Execution cancel | `AbortSignal` reaches ConversationAgentRunner/AgentRunner -> CLIExecutor | PARTIAL |
| Process cancel | `child.kill()` / POSIX TERM+KILL | PARTIAL |
| Process-tree cancel | no Job Object/process group/tree enumeration/survivor proof | MISSING / E04 fails today |
| Timeout | inactivity + total timers, no startup/approval-aware state, generic null exit | PARTIAL |

Target ordering must be one coordinated command: validate Run/Operation
precondition -> persist cancellation request/event -> ask Provider Adapter for
graceful protocol stop when supported -> ProcessManager tree stop -> grace
deadline -> force tree termination -> survivor verification -> Process facts ->
Provider finalize -> canonical Stage/Run cancellation through existing M3
lifecycle transactions. Repeated cancel must converge and cannot create a
second Run state machine.

Windows must not equate `child.kill()` with tree cancellation. The plan requires
a platform driver capability contract, Job Object where available, a bounded
fallback, and survivor evidence. Exact native mechanism is a technical decision
to be proven in platform tests, not an Owner Decision.

## 11. Browser-disconnect audit

| Production path | Evidence | Classification |
|---|---|---|
| Canonical M3 Run SSE | `canonicalRunEvents.ts` cleanup only unsubscribes; test proves Run state/lifecycle continue (`canonicalRunStream.test.ts:504-577`) | IMPLEMENTED |
| Legacy canonical task SSE | `res.close -> cleanup(false)` only unsubscribes; execution is fire-and-forget (`tasks.ts:296-369`) | IMPLEMENTED |
| Conversation initial message SSE | `res.close` aborts active `AbortController`, signal reaches CLIExecutor (`conversations.ts:410-456`) | CONFLICTING: disconnect can kill provider execution |
| Conversation reconnect GET | close unsubscribes only (`conversations.ts:477-507`) | IMPLEMENTED transport boundary, but in-memory stream is not durable canonical Event Store |
| Conversation resume SSE | close unsubscribes only; explicit cancel still aborts via registry (`conversations.ts:540-567`) | PARTIAL / inconsistent with initial path |

M4 integration seam: all execution must be background authority keyed by Run
and Stage attempt. POST/stream handlers may submit a command and subscribe, but
their `close` handlers may only unsubscribe. Explicit Cancel API is the only
user transport-to-execution termination command.

## 12. Restart / recovery audit

### 12.1 What survives today

- Canonical M3 Run, Stage, Start Operation, Runtime Event/Outbox and
  `runs.recovery_required` survive.
- Provider Configuration and immutable V2 snapshots survive.
- Old Conversation Run/Execution/invocation summary and old events survive.
- Process handle, OS PID, start identity, tree membership, live stream and raw
  output position do not survive.

### 12.2 Current recovery behavior

Server startup runs Task-domain recovery before service/routes/listen, then old
Conversation recovery (`apps/server/src/index.ts:130-157`).

- M3 Task-domain recovery restores safe queued work, preserves coherent
  approval, fails startup windows closed, and marks uncertain running Runs with
  `recovery_required = 1`; it constructs no execution authority and never
  restarts Provider (`taskRecovery.ts:64-125`,
  `TaskRunRecoveryService.ts:405-423`).
- Legacy canonical interrupted starting/running Runs are failed closed with
  stable restart evidence (`TaskRunService.ts:586-630`, `1601-1738`).
- Old Conversation recovery marks all active runs/executions failed on restart
  (`runRecovery.ts:4-25`).

### 12.3 M4 minimum boundary versus M7

M4 minimum:

- durably record Process identity/ownership facts needed to distinguish
  AgentOS Process ID from OS PID;
- on startup classify each active Process record as provably missing,
  provably same externally-running process, or unknown;
- fold that evidence into the existing M3 recovery decision without starting a
  second Provider, guessing success, or changing terminal Runs;
- preserve output/ownership evidence and emit stable recovery/process facts;
- make provider-native resume explicitly deferred unless the chosen Kimi slice
  proves a safe, versioned native identity contract.

M7 deferred hardening:

- generalized reattach/stream restoration, orphan cleanup policy, PID reuse
  hardening across all platforms/providers, Provider-native resume matrix,
  repeated recovery chaos at every lifecycle boundary, Worktree/projection/
  artifact/lock recovery integration, recovery inspector and audit breadth.

The current main has no evidence that Kimi, Codex or OpenCode native resume is
safe for M4. M4 must record uncertainty; it must not infer success from PID,
exit code, missing handle, or provider-native files.

## 13. Provider comparison

| Provider | Implementation / discovery | Command/auth/output | Cancel / tests / integration / stability | Status |
|---|---|---|---|---|
| KimiCode Direct | `KimiAdapter` registered; direct command config defaults to `kimi`; probe checks `--version` and `--help` for `stream-json`; current machine `0.23.5` | Adapter injects `--output-format stream-json`; OAuth home copy or `AGENTOS_KIMI_API_KEY` environment mode; parser covers assistant/tool/usage/diagnostic | generic CLI child cancel only; adapter golden fixture/unit/integration tests (`kimiAdapter.test.ts`, `executor.test.ts:229-257`); historical Kimi Gate PASS (`docs/acceptance/kimi-runtime-final.md`) | PARTIAL, strongest initial slice |
| Codex | `CodexAdapter` registered; probe checks version and `exec --help`; current machine wrapper `0.146.0` | structured `--json` when supported; CODEX_HOME derivation; parser covers messages/tools/usage; no stable auth mapping | generic child cancel only; adapter/probe/executor tests; historical real Gate PASS (`codex-runtime-final.md`) | PARTIAL; stage as the separately authorized second adapter proof after Core/Kimi |
| OpenCode | config/capability/model discovery and usage DB delta exist; no `OpenCodeProviderAdapter` class and Registry does not register one; current machine not found | config uses `opencode run` when available but Registry probe/fallback is not a Provider-specific OpenCode protocol; auth path absent; output generally plain fallback | generic child cancel only; model/usage tests, no current dedicated adapter contract/golden native stream; historical documents conflict by date, current code wins | PARTIAL / MISSING adapter; later M4 phase requires evidence, otherwise final closeout is blocked pending formal disposition |

Recommendation: **KimiCode Direct** is the sole initial vertical slice. It is
the Roadmap default, is presently installed, has a direct dedicated adapter,
structured output probe, fixture/parser/integration coverage, and past real
smoke evidence. Codex should be the second adapter to prove the generic seam
after the Kimi slice passes. OpenCode requires executable/version/protocol and a
dedicated adapter before admission. The installed Kimi/Codex versions and paths
are current-machine supporting evidence only, not durable release contracts;
future acceptance requires separate real and deterministic Provider gates. None
of this authorizes implementation.

## 14. Schema / migration audit

Migrations `001`–`013` are continuously registered
(`apps/server/src/migrations/default-registry.ts:1-37`). Relevant current
objects are:

- `provider_configurations` and Agent binding from migration 003;
- canonical `runs`, snapshots and stages from migrations 006/008/009/012/013;
- `runtime_events` with optional Provider Session/Process reference columns,
  operations, Outbox and `runs.recovery_required` from migration 012;
- old Conversation `executions`, `agent_runs`, `execution_events`,
  `run_cli_invocations` from migration 001.

Missing target resources: durable Runtime Process, Provider Session, Provider
Validation, Environment Profile/Secret Profile resolver. The July data model
shows conceptual tables (`10-Data-Model.md:834-952`, `1692-1788`), but those are
not approval or current schema. `migration-register.md:19-39` also calls the
resources deferred and explicitly leaves Migration 014 unauthorized.

P0 verdict: **SCHEMA_PROPOSAL_REQUIRES_FUTURE_MIGRATION**. The exact conceptual
first schema has three resources: `runtime_processes`, `provider_sessions`, and
`process_output_references`. Provider Validation uses typed results, bounded
cache and Run-bound Events; Recovery Record uses Process facts, Runtime Events
and existing `runs.recovery_required`. `M4-p0-schema-proposal.md` freezes fields,
relationships, constraints, CAS, sensitivity and forward boundaries. P2 remains
blocked on `OD-M4-01`, independent schema review and separate entry
authorization.

## 15. Test coverage audit

Current positive assets:

- executable found/missing/absolute/custom PATH: `resolveCommand.test.ts`;
- provider successful/non-zero/not-found, stdout/parser, max/idle timeout,
  AbortSignal, environment and Windows batch wrapper: `executor.test.ts`;
- Codex/Kimi probe, Registry, JSONL parser, redaction and fixtures:
  `packages/agent-core/src/adapters/*.test.ts`;
- Provider CRUD secret-field rejection, version and isolation:
  `providerConfigs.test.ts`;
- Codex/Kimi/OpenCode model discovery: `CliModelDiscovery.test.ts`;
- M3 lifecycle, RunEngine seam, durable stream disconnect/replay and fail-closed
  recovery: `run-engine/*.test.ts`, `canonicalRunStream.test.ts`,
  `TaskRunRecoveryService.test.ts`, `m3-p6-integrated-verification.test.ts`.

Missing M4 acceptance evidence:

- Process Manager/Repository/identity/state transition tests;
- spawn error versus executable missing stable error mapping;
- OS signal and termination reason persistence;
- child/grandchild tree cancellation, Job Object/process group, survivor proof;
- bounded raw stdout/stderr artifacts and backpressure;
- auth-required normalization and Provider Validation API;
- Kimi end-to-end only through Process Runtime;
- active canonical Run cancel to process tree;
- server restart with durable Process identity / no guessed success;
- Conversation initial HTTP disconnect independence;
- negative architecture rule preventing direct Provider spawn;
- current platform contract tests for Windows paths, spaces, Unicode and
  provider child trees.

## 16. Gap matrix

Exactly 30 planning gaps are classified below. Post-P0 planning counts are
`IMPLEMENTED 2`, `PARTIAL 10`, `LEGACY 3`, `MISSING 13`, `CONFLICTING 2`,
`UNKNOWN 0`. P0 closes contract ambiguity only; it implements no runtime gap.

| ID | Area | Contract Requirement | Current Evidence | Current Status | Gap | Risk | Dependency | Owner Decision Required | Proposed M4 Phase | Acceptance Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| G01 | Process Manager | one launch/stop/timeout authority | `CLIExecutor` owns raw spawn (`executor.ts:275-596`) | MISSING | no ProcessManager/driver/handle registry | Critical | contract/types | No | P1 | mock + platform contract; architecture import rule |
| G02 | Process Identity | AgentOS ID distinct from PID | transient `child.pid`; event ref only | MISSING | no durable identity/recovery token | Critical | P1, schema gate | No | P2 | repository/identity/PID reuse tests |
| G03 | Process Repository | durable state and CAS terminal transition | no process table/repository; exact P0 proposal exists | MISSING | cannot recover/query Process | Critical | separate schema authorization | `OD-M4-01` before P2 schema | P2 | fresh/upgrade schema + repository tests |
| G04 | Process Tree | own child/grandchild tree | Windows `child.kill`, POSIX child signals | MISSING | escaped descendants/survivors | Critical | platform driver | No | P5 | Windows/POSIX child-tree tests |
| G05 | Cancellation | Run cancel propagates once through Provider to tree | canonical cancel is queued-only; old AbortSignal path | PARTIAL | no active canonical cancellation chain | Critical | P1-P4 | No | P5 | cancel race/idempotency/tree E2E |
| G06 | Timeout | startup/idle/total semantics and stable reason | idle + total timer in CLIExecutor | PARTIAL | no startup/approval pause/process fact | High | P1/P2 | No | P5 | timer/state/race tests |
| G07 | Raw Output | traceable restricted stdout/stderr | unbounded strings, count-only task log | MISSING | no raw Process artifact/offset | High | artifact sink, P2 | No | P2 | byte/UTF-8/redaction/backpressure tests |
| G08 | Process Events | canonical durable process facts | M3 registry has no Process events implemented | MISSING | cannot persist start/stop/exit/orphan | High | shared registry + M3 event store | No | P2 | Event/Outbox 1:1 and registry tests |
| G09 | Restart | classify active Process without guessing | M3 Run uncertainty only; no Process evidence | PARTIAL | cannot identify/reattach same OS process | Critical | P2/P4 | No | P6 | restart matrix, no guessed success |
| G10 | Recovery Identity | PID + start/executable/token evidence | none durable | MISSING | PID reuse / foreign process risk | Critical | schema/platform | No | P2/P6 | identity mismatch tests |
| G11 | Provider Registry | stable adapter ID/version/type manifest | per-execution Codex/Kimi registry | PARTIAL | no versioned manifest; no OpenCode adapter | High | provider contracts | No | P3 | duplicate/lookup/snapshot tests |
| G12 | Provider Config | canonical data, snapshots, secret refs | migration 003/repository/SnapshotService | IMPLEMENTED | execution/validation do not fully consume it | Medium | P3/P4 | No | P3 | snapshot-to-launch equivalence |
| G13 | Provider Validation | schema/discovery/version/auth/capability API | probes + model discovery; CRUD validation only | PARTIAL | no canonical result/cache/API/error | High | registry, validation driver | No | P3 | API/contract/auth tests |
| G14 | Provider Adapter | semantics only; uses Process port | adapter parser/build exists; CLIExecutor spawns | PARTIAL | interface lacks session/finalize/error/cancel port | Critical | P1/P3 | No | P3 | adapter contract + no child_process import |
| G15 | Kimi vertical slice | direct Kimi end-to-end through Process Runtime | dedicated Kimi adapter and Gate | PARTIAL | still goes through CLIExecutor raw spawn | High | P1-P4 | No | P4 | real/fake Kimi E2E with Process/Event IDs |
| G16 | Auth failures | stable `PROVIDER_AUTH_REQUIRED` | no auth validation/mapping | MISSING | CLI text/generic error leaks semantics | High | Provider Validation | No | P3/P4 | authenticated/expired/missing fixtures |
| G17 | RunEngine integration | exactly one accepted execution chain | RunEngine seam exists, no production provider wiring | PARTIAL | scheduler/authority lease missing | Critical | M3 contracts, P1-P3 | No | P4 | one Start -> one Process; replay no spawn |
| G18 | Browser disconnect | transport lifecycle != Process lifecycle | canonical/Legacy pass; initial Conversation aborts | CONFLICTING | one production path kills CLI on close | Critical | P4/P5 | No | P5 | socket-close E2E, Process continues |
| G19 | Legacy compatibility | old routes project same authority/events | `LegacyCanonicalExecutionService` sole old authority | LEGACY | migration must avoid second execution authority | High | P4 | No | P4/P7/P11 | parity + no-double-execution tests |
| G20 | Conversation compatibility | old conversation execution remains usable | ConversationService owns old Run/CLI state | LEGACY | browser-owned execution and second aggregate | High | P4/P5 | No | P5/P7/P11 | compatibility tests without cutover |
| G21 | Testing | unit/contract/platform/integration/recovery gates | strong CLI/M3 tests, no Process tests | MISSING | no evidence for E01-E09 or Roadmap breadth | Critical | all phases | No | P0-P11 | frozen matrix, no retry-until-green |
| G22 | Migration/schema | minimal durable model, authorized separately | P0 freezes the exact three-resource proposal and future-migration verdict; no migration exists | PARTIAL | Owner selection, independent schema review, exact DDL/number and P2 entry remain | Critical | P2 schema decision gate | `OD-M4-01` UNDECIDED | P2 | authorized schema package + fresh/upgrade/forward evidence |
| G23 | M3 lifecycle/events | preserve state/Event/Outbox/idempotency/recovery | M3 closeout and main CI pass | IMPLEMENTED | integration may regress if bypassed | Critical | frozen invariant | No | all | complete M3 regression matrix |
| G24 | Provider identity naming | `kimicode` canonical identity, no conflation | persistence `kimicode`; runtime `kimi`; runner inference | CONFLICTING | snapshot/adapter/type drift | High | spec reconciliation | No | P0/P3 | canonical mapping and mismatch tests |
| G25 | Codex second-provider proof | Codex adapter proves generic Process/Provider seam after Kimi | dedicated Codex adapter/tests and historical gate, but current launch still uses `CLIExecutor` | PARTIAL | no Codex execution through accepted Process port/authority | High | P7 Core/Kimi accepted | No | P8 | Codex E2E + Kimi/M3 regression + no Provider-specific Process branch |
| G26 | OpenCode adapter | dedicated evidence-backed `OpenCodeProviderAdapter` through Process Runtime | model discovery/usage delta only; no registered adapter; executable absent locally | MISSING | no protocol/auth/output/cancel contract or generic integration proof | High | P8; executable/protocol evidence | No | P9 | deterministic contract fixtures + authorized real evidence; otherwise final closeout blocked |
| G27 | Custom CLI Foundation | bounded explicit Custom CLI identity/config/allowlist/error contract | generic raw CLI/plain fallback exists | LEGACY | unrestricted/silent fallback is not the Roadmap Foundation | High | accepted Process/Provider ports; security contract | No | P9 | shell-injection negative tests + bounded launch/output contract |
| G28 | Provider Session API | canonical Session create/read/state/error contract over separate identity | optional event refs and old Conversation invocation/session concepts only | MISSING | no canonical Provider Session resource/API | High | P2 schema decision; P3 Provider contract | No now | P10 | API/authz/identity/pagination/state tests |
| G29 | Process Inspector API | bounded backend Process query/inspection contract | no Process resource/repository/API exists | MISSING | no authorized/redacted Process inspection surface | High | P2 Process repository | No | P10 | API/authz/redaction/raw-output-ref tests; UI excluded |
| G30 | Recovery Record | durable evidence/result record for minimum M4 Process recovery | M3 `runs.recovery_required` and recovery events exist, no Process Recovery Record | MISSING | final M4 deliverable is absent despite partial Run uncertainty semantics | Critical | P2/P6; M4/M7 boundary | No now | P6/P10 | same/missing/unknown/no-guess persistence and API tests |

Roadmap deliverable mapping is therefore explicit rather than implicit:
`ProcessEventNormalizer -> G08`, `Provider Validation API -> G13`, `Stable
Cancel -> G05`, and the six previously underrepresented deliverables map to
G25–G30. No Roadmap item is considered complete merely because a broader gap
or the Kimi slice passes.

## 17. Risks

1. **Double execution / authority split — Critical.** Adding background dispatch
   beside Legacy/Conversation direct spawn can execute one accepted request
   twice.
2. **Windows survivor risk — Critical.** `child.kill()` is not tree ownership;
   CLI tools may leave grandchildren mutating the workspace after cancellation.
3. **Schema overreach — Critical.** Process, Session, Validation and Recovery
   concepts could produce a broad migration before the minimum model is proven.
4. **Recovery overreach — Critical.** Reattach/native resume can expand M4 into
   M7 and can guess identity/success.
5. **Event dual truth — High.** old `agent_events` and canonical
   `runtime_events` must not both become authoritative for one M4 Run.
6. **Raw output security/memory — High.** current unbounded strings can exhaust
   memory; raw artifacts require secret scan and restricted access.
7. **Provider identity drift — High.** `kimi` versus `kimicode`, command-based
   detection, and configurable adapter IDs can silently misbind behavior.
8. **Provider CLI instability — High.** version/protocol/auth text changes must
   be isolated by adapters and golden/real gates.
9. **Shared-core conflicts — High.** RunEngine, shared registry/types, schema,
   package exports and server bootstrap require serial phase ownership.
10. **Scope multiplication — High.** implementing Kimi/Codex/OpenCode together
    would hide Process Runtime faults behind provider-specific variance.
11. **False milestone closeout — Critical.** E01–E10 plus Core/Kimi can pass
    while explicit Roadmap M4 Provider/API deliverables remain unresolved.
    Final status must be gated by the deliverable reconciliation matrix.

## 18. Unknowns

- Viable Windows Job Object implementation/dependency under this Node version;
  native capability must be proven, with an explicit fallback contract.
- Whether KimiCode `0.23.5` exposes a stable native Session/resume identity;
  current evidence is insufficient and M4 must not assume it.
- Required raw-output retention/maximum byte policy. Security defaults can be
  technical and restrictive; a future user-visible retention choice is deferred.
- Whether all Git/tar/system subprocesses must migrate within M4 or through
  their owning M5 packages later. The initial M4 Provider slice explicitly does
  not absorb M5 behavior.

Remaining unknowns do not invalidate the P0 conceptual contract; each is a stop
condition for the phase that would otherwise rely on implementation evidence.

## 19. Spec conflicts

1. **SPEC_RECONCILIATION_REQUIRED — Provider identity.** Runtime Specification
   names Provider Type `kimicode` and env `AGENTOS_KIMICODE_CLI`
   (`01-Core-Concepts.md:2225-2235`), while agent-core uses `AgentProvider =
   'kimi'` and `AGENTOS_KIMI_CLI` (`packages/shared/src/types/index.ts:14`,
   `packages/agent-core/src/config.ts:5-9`). Persistence maps between them
   (`WorkspaceCompatibilityRepository.ts:184-188`). M4 must freeze one mapping
   at the boundary without editing the specification under preplanning authority.
2. **SPEC_RECONCILIATION_REQUIRED — Roadmap breadth versus vertical slice.**
   M4 scope/deliverables list Codex/OpenCode/Process Inspector/Recovery Record
   (`14-Roadmap.md:1165-1249`), while the same Roadmap mandates Process + one
   Provider first and warns against a broad matrix (`14-Roadmap.md:3630-3689`).
   Staging Kimi first resolves implementation order only; it does not resolve or
   shrink final M4 scope. The final scope remains governed by Roadmap §§55/59:
   Codex follows as the second-provider proof, then OpenCode/Custom CLI and the
   remaining API/Recovery deliverables. Each must be accepted before M4 final
   closeout or formally moved by a separately authorized scope/spec
   reconciliation. The Process Inspector UI and generalized M7 recovery remain
   outside M4, but the Roadmap Process Inspector API and minimum Recovery Record
   do not silently disappear.
3. **SPEC_RECONCILIATION_REQUIRED — M4 recovery versus M7 hardening.** M4 exit
   needs explicit restart semantics; M7 owns generalized recovery hardening
   (`14-Roadmap.md:1550-1627`). M4 is limited to durable identity and safe
   classification integrated with M3 `recovery_required`; generalized reattach,
   resume and orphan cleanup remain M7.
4. **SPEC_RECONCILIATION_REQUIRED — all local processes versus milestone
   ownership.** Process Runtime final definition says all Provider/Tool/Git/Test
   processes use ProcessManager (`05-Process-Runtime.md:3610-3648`), but M5 owns
   Git/Worktree/Artifact behavior. M4 creates the generic port and migrates
   Provider execution first; unrelated Git/tar paths remain inventoried and
   must not be silently accepted as final architecture.

## 20. Entry recommendation after M4-P0 closure

P0 has closed the listed contracts in the four `M4-p0-*` documents and remains
pending independent P0 review. Recommendation: **M4-P1 ELIGIBLE FOR A SEPARATE
ENTRY DECISION only after that review has BLOCKER/HIGH zero. NO-GO for M4
production implementation from this document.**

P0 closure evidence:

1. freeze the single execution authority chain and compatibility routing;
2. freeze Process/Provider/Session identity terminology and `kimi`/`kimicode`
   mapping;
3. freeze ProcessManager/driver/Adapter ports and event/error ownership;
4. decide the minimal schema proposal and obtain separate entry/owner
   authorization before migration creation;
5. freeze Windows tree termination acceptance and fallback evidence;
6. freeze raw-output security/backpressure contract;
7. freeze Kimi as the initial slice without treating it as final M4 completion;
8. freeze the authoritative final-scope contract and Roadmap deliverable matrix:
   Codex second, OpenCode/Custom CLI and API/Recovery breadth later, each behind
   separate authorization; any removal/deferral requires formal reconciliation;
9. preserve all E01–E10 gates and M3 regression contracts.

M4-P0 must explicitly close HIGH-1 before implementation entry by proving:

```text
KIMI VERTICAL SLICE COMPLETE != M4 MILESTONE COMPLETE
```

P7 may verify Process Core and Kimi only. It cannot become the final milestone
closeout gate while any Roadmap §§55/59 disposition remains unresolved.

Current Owner Decision count is one: `OD-M4-01` is UNDECIDED and required only
before P2 schema/migration creation, not P1. Routine architecture choices above
remain technical decisions subject to independent review. Migration creation,
production cutover, Web default switch and legacy retirement remain separately
unauthorized.
