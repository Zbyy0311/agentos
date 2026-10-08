# AgentOS Runtime Specification Lite

## 04 — Provider Specification

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs retain authority for already-frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical `Runtime-Specification` remains reference architecture where it is broader than Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

This document defines the Lite boundary between AgentOS and external AI coding providers: Codex, Kimi Code, and OpenCode.

AgentOS does not reimplement provider intelligence.

AgentOS provides a persistent, provider-independent control and collaboration layer. Providers supply execution capability.

The Adapter is the only protocol boundary between AgentOS canonical state and a provider's native runtime. Provider-native tools, planning, subagents, sessions, Git, worktrees, sandboxing, context handling, and execution strategy remain provider implementation details.

AgentOS owns cross-provider facts and control boundaries:

- Agent identity;
- Provider selection;
- Provider Configuration and capability declarations;
- durable Run, Process, Runtime Event, cancellation, and recovery classification;
- unified history and search.

## 2. Lite Scope

### 2.1 ACTIVE LITE

- Provider Adapter protocol for Codex, Kimi Code, and OpenCode;
- truthful capability declaration;
- Provider Configuration as data and Adapter as code;
- discovery, validation, launch-plan, start, streaming, cancel, finalize, and normalized errors;
- safe argument-array process launch through the Process runtime;
- secret isolation;
- raw output fallback without fabricated facts;
- Provider Session references as noncanonical execution references.

### 2.2 COMPATIBILITY

- merged Provider abstraction, Registry, and M4 provider foundations;
- direct Kimi Code CLI invocation already merged for production runtime;
- existing Codex, Kimi, and OpenCode output parsers retained where callers depend on them;
- legacy v1-style configuration mapping.

### 2.3 DEFERRED FULL-SCOPE

- reimplementing provider-native planning, tools, subagents, sandboxing, context strategy, or execution strategy;
- AgentOS-owned Git or Worktree lifecycle (see [06 — Worktree Runtime](./06-Worktree-Runtime.md));
- provider comparison and benchmarking product;
- plugin marketplace;
- process reattach, session adoption, or arbitrary provider process takeover;
- remote/container provider expansion beyond retained compatibility interfaces.

## 3. Core Principles and Invariants

| Invariant | Meaning |
|---|---|
| Agent != Provider | A persistent Agent identity may use different providers over time. |
| Provider Type != Provider Configuration | Type names a runtime class; Configuration is one executable instance. |
| Configuration is data, Adapter is code | Data declares what to run; code implements how to run it. |
| Runtime Core has no provider branches | Provider-specific behavior lives in the Registry and Adapter. |
| Capability absence remains absence | AgentOS never invents telemetry or claims unsupported capability. |
| Provider internals are noncanonical | Native tools, subagents, sessions, Git, worktrees, and planning are not AgentOS state. |
| AgentOS Process ID != native PID | The durable Process identity is not a reusable OS number. |
| Provider Session != Agent identity | A native session is a scoped reference, never canonical identity. |
| Secrets are references | Provider Configuration, Events, and Snapshots never carry secret values. |
| Browser disconnect != Run cancellation | Transport lifetime never owns execution lifetime. |

## 4. Provider Boundary

### 4.1 What Providers Own

Codex, Kimi Code, and OpenCode may internally handle:

- reasoning and planning;
- provider-native tools and tool selection;
- native subagents;
- provider sessions and resume mechanics;
- Git and branch operations;
- internal worktrees;
- sandboxing;
- context-window management;
- provider execution strategy;
- native telemetry and usage.

These mechanisms are provider implementation details.

AgentOS may record a redacted reference or a justified observation.

It must not infer facts the provider did not reliably expose.

### 4.2 What AgentOS Owns

AgentOS canonically owns:

- Agent Profile and Agent identity;
- Provider Configuration lifecycle and selection;
- Workspace admission and mutation classification;
- durable Run and Stage state;
- Process ownership through the Process runtime;
- ordered Runtime Events;
- cancellation control;
- fail-closed recovery classification;
- Memory and Context Snapshot;
- Artifact references;
- history and search.

## 5. Provider Types and Configuration

### 5.1 Provider Types

The Lite baseline provider types are:

```text
codex
kimicode
opencode
```

`custom-cli` and `remote` remain **COMPATIBILITY** surfaces for existing code and callers; they are not active Lite engineering targets.

### 5.2 Provider Configuration Is Data

A Provider Configuration is an executable configuration instance:

- providerType and adapterId;
- runtimeMode (`cli` baseline; API/SSH/container remain compatibility);
- executable and argsTemplate;
- model/profile selection;
- environmentProfileId and secretProfileId references;
- working directory mode;
- declared capabilities;
- timeout policy;
- approval mode;
- output mode;
- enabled state and version.

Configuration invariants:

- providerType must match the Adapter's supported type;
- adapterId must exist in the Registry;
- CLI mode must resolve a validated executable;
- secrets are references, never configuration values;
- disabled configurations are not used for new Runs;
- changes increment version;
- deletion prefers archive;
- every Run freezes a Provider Snapshot without secrets.

## 6. Provider Adapter Boundary

### 6.1 Adapter Responsibilities

The Adapter is the single code boundary between the Run Engine and the provider runtime:

```text
Run Engine
  -> Provider Registry
  -> Provider Adapter
  -> Provider Native Runtime
```

Adapter responsibilities:

- discovery and validation;
- capability detection;
- launch-plan construction;
- session creation;
- output parsing and canonical Event mapping;
- native approval bridging where declared;
- cancellation through the Process port;
- error normalization;
- finalization.

### 6.2 Adapter Rules

- Adapter does not update the Run database directly; it emits Event drafts through the Event Sink.
- Adapter does not create Tasks or decide Task completion.
- Adapter does not own Git, worktrees, branches, or merges.
- Adapter cannot bypass policy enforcement.
- Adapter never persists secrets into ordinary Events.
- Adapter never calls `child_process.spawn` directly; all OS processes go through the Process port.
- Adapter must support reliable cancellation, even when the provider lacks a native cancel.
- Adapter must return stable normalized errors.
- Adapter must be replaceable by a Mock for deterministic tests.

### 6.3 Registry

- Adapter IDs are unique.
- One Provider Type may have multiple Adapters.
- Adapter version enters the Run Provider Snapshot.
- The Registry is never replaced mid-Run.

## 7. Truthful Capability Declaration

### 7.1 Canonical Capabilities

The canonical capability set includes:

```text
sessionResume
structuredEvents
nativeApprovals
subagents
toolEvents
fileEvents
usageEvents
reasoningStream
interactiveInput
pause
cancellation
modelSelection
workspaceAwareness
nativeSandbox
enforcedWorkspaceReadOnly
outputContracts
```

### 7.2 Capability Sources

Capabilities may come from:

- Adapter static defaults;
- CLI version detection;
- provider validation;
- runtime negotiation.

Effective capabilities record a source per capability.

Users may only disable capability; they must not force an unsupported capability to `true`.

### 7.3 Enforceable Capability Semantics

`enforcedWorkspaceReadOnly` is an execution capability, not a prompt promise. It is effective only when the Adapter/platform technically denies filesystem writes to the admitted Workspace for the complete Provider execution boundary and contract tests prove attempted Workspace mutation fails.

The effective value is captured in the Run Provider Snapshot with its Adapter/platform evidence. Unknown or unavailable evidence means `false` for admission. A Provider-native worktree, sandbox label, read-only declaration, or `nativeSandbox` capability does not imply `enforcedWorkspaceReadOnly`.

`nativeApprovals` is effective for Policy enforcement only when a trustworthy Provider-native hook exposes the action before execution and the Adapter can return AgentOS ALLOW, DENY, or ASK_USER control to that same pre-action boundary. A Provider approval UI without enforceable pre-action interception is not this capability.

### 7.4 Fidelity

Provider output fidelity is declared per Run:

```text
native structured   -> validated canonical mapping
adapter parsed      -> conservative parsed mapping with provenance
raw fallback        -> user-visible stream summary + redacted raw Artifact
```

An Adapter must not declare a capability it does not implement and test.

## 8. Launch and Execution

### 8.1 Launch Plan

The Adapter returns a Launch Plan:

- executable;
- argument array;
- cwd;
- environment with redacted key names;
- stdin mode and prompt delivery;
- structured output mode;
- cleanup files;
- effective Workspace write-denial configuration and evidence when read-only admission is requested.

### 8.2 Safe Argument-Array Launch

- Default `shell = false`.
- User text is never concatenated into an unescaped shell string.
- Prompts and large payloads go through stdin, a prompt file, or an API body.
- Redacted arguments are persisted; raw arguments live only in short-lived memory.
- Prompt delivery is audited in redacted form.

### 8.3 Working Directory

- Effectively read-only Runs use the admitted Workspace with `enforcedWorkspaceReadOnly` active for the complete execution boundary.
- Modifying Runs use the admitted Workspace or an explicitly validated provider-selected directory.
- AgentOS never depends on an AgentOS-owned Worktree; see [06 — Worktree Runtime](./06-Worktree-Runtime.md).
- The provider cannot override cwd to bypass Workspace admission.

### 8.4 Environment and Secret Isolation

Environment construction:

```text
safe base environment
  -> Workspace profile
  -> Provider profile
  -> Run override
  -> ephemeral secret injection
```

Rules:

- each process receives only explicitly declared secret references;
- unrelated Provider tokens, admin credentials, cloud credentials, private-key paths, and session cookies are not inherited;
- ephemeral secrets are released immediately after spawn and never enter Events, Artifacts, snapshots, or debug bundles;
- Events record environment key names and sources, never values.

## 9. Provider-Native Noncanonical Details

The following remain provider implementation details:

- native Git commands and branches;
- provider-created worktrees;
- native subagents;
- provider tool calls;
- internal plans and reasoning;
- context-window management;
- sandbox mechanics;
- native session state;
- native telemetry.

Provider-native subagents never automatically become Agent Profiles.

A native session ID may be stored as a scoped reference.

It is not canonical Agent or Conversation identity.

## 10. Output, Events, and Raw Fallback

### 10.1 Mapping Fidelity

Provider output is handled in descending order of fidelity:

```text
stable native structured event
  -> validated canonical mapping

stable documented text format
  -> conservative parsed mapping with provenance

unreliable or unknown output
  -> user-visible stream summary + redacted raw Artifact
```

### 10.2 No Fabricated Facts

AgentOS never invents:

- tool calls;
- file modifications;
- subagents;
- reasoning;
- usage or cost;
- native session success;
- Git operations;
- process identity.

Missing telemetry means unavailable telemetry.

Provider-private chain of thought is not requested, inferred, or persisted.

### 10.3 Raw Output

- Raw provider output is retained as a restricted Artifact by default.
- Raw output is scanned for secrets.
- Raw output is never canonical Runtime Event data by itself.
- Finalize generates checksums and references.

## 11. Error Normalization

Provider failures map to stable normalized errors:

```text
PROVIDER_AUTH_REQUIRED
PROVIDER_AUTH_EXPIRED
PROVIDER_EXECUTABLE_NOT_ACCESSIBLE
PROVIDER_VERSION_UNSUPPORTED
PROVIDER_RATE_LIMITED
PROVIDER_QUOTA_EXCEEDED
PROVIDER_START_FAILED
PROVIDER_SESSION_FAILED
PROVIDER_OUTPUT_PARSE_FAILED
PROVIDER_CANCEL_FAILED
PROVIDER_INTERNAL_ERROR
PROVIDER_UNKNOWN_ERROR
```

Each normalized error records:

- stable code;
- phase;
- retryability;
- suggested action;
- redacted native detail when available.

Authentication errors are distinct from ordinary runtime failures.

AgentOS does not store user passwords, simulate login, or bypass OAuth.

## 12. Identity, Selection, and History Boundaries

- Agent identity is canonical AgentOS state; Provider identity is execution capability.
- Provider selection resolution:

```text
Run Stage override
  > Run override
  > Workflow Stage Provider
  > Agent default Provider
  > Workspace default Provider
```

- Provider Session is a reference inside Run history.
- Agent History remains unified when an Agent changes Provider.

Example:

```text
Agent: Backend Engineer
Yesterday: provider = Kimi Code
Today:    provider = Codex
History:  Backend Engineer History (not Kimi History + Codex History)
```

## 13. AgentOS-Owned Execution Boundary

Provider execution always occurs inside an AgentOS-owned Run:

- the Run owns lifecycle state and Event sequence;
- the Process runtime owns OS execution and tree control;
- cancellation is an explicit control path, never a transport event;
- recovery classification is fail closed;
- Process exit does not prove Run success;
- Provider success does not automatically complete a Stage.

## 14. Included Capabilities

- Adapter contract and Registry.
- Discovery and validation that do not mutate user configuration.
- Provider Snapshot freezing without secrets.
- Mock Provider for deterministic contract tests.
- Kimi Code direct invocation preserved (merged M4-P3 direction).
- Codex, Kimi Code, and OpenCode adapters as the active Lite provider set.

## 15. Implementation Status Snapshot

This section is a non-authoritative status snapshot dated 2026-08-28. Implementation labels are evidence-based, not aspirational, and architecture semantics do not depend on a temporary branch head or commit SHA.

### 15.1 Durable Merged Baseline

- M4-P3/M4-P4 provider and Run Engine integration: Kimi Code is the only merged production runtime Provider Adapter (direct `kimi.exe` invocation).
- Existing `codexAdapter`, `kimiAdapter`, and `plainTextAdapter` remain output parsers in the legacy adapter registry under **COMPATIBILITY**.
- Provider cancellation, timeout, and durable Process integration are merged through the M4-P5 series.
- The merged P6-M3a contract confirms `sessionResume: false` for the Kimi Code adapter; no production provider currently supports durable session resume.

### 15.2 Unmerged or Forward

- Codex and OpenCode runtime adapters are forward **ACTIVE LITE** direction, not merged functionality.
- Provider comparison and benchmarking product functionality remains **DEFERRED FULL-SCOPE**.

## 16. Deferred / Non-Goals

- reimplementation of provider intelligence;
- provider comparison product;
- plugin marketplace;
- process reattach, session adoption, or arbitrary process takeover;
- mandatory remote/container provider expansion;
- unsafe flags enabled by default;
- treating provider-native mechanisms as canonical state.

## 17. Compatibility with the Existing Runtime

- Merged Provider abstraction, Registry, Launch Plan, validation, and error contracts remain authoritative under **COMPATIBILITY**.
- Existing configurations migrate through compatibility mapping without a clean-sheet rewrite.
- Legacy output parsers remain available to current callers.
- No second Provider abstraction is introduced.
- Lite does not delete or rewrite the merged M4 provider code.

## 18. Failure and Safety Rules

- Capability absence is not evidence that an action did or did not occur.
- Unknown provider output degrades to stream and Artifact evidence.
- Secret values never enter ordinary Events, logs, snapshots, Memory, or search indexes.
- All adapters must support cancellation through the Process runtime.
- Provider claims never override canonical lifecycle state.
- A missing Provider Session reference is reported as absent, never invented.
- Raw fallback never becomes a fabricated structured fact.

## 19. Acceptance Expectations

Independent verification must cover:

- Adapter contract tests pass for discovery, validation, start, stream, cancel, finalize, redaction, and raw output;
- Mock Provider covers success, auth, rate-limit, non-zero exit, cancel, and process-crash scenarios;
- Kimi Code invocation does not route through OpenCode;
- Provider switching preserves Agent identity and history;
- browser disconnect does not cancel Provider execution;
- errors normalize to stable codes with retryability;
- capability declarations match tested behavior;
- concurrent read-only admission is available only when attempted Workspace writes are technically denied and tested;
- unknown capability, prompt-only intent, user-forced values, `nativeSandbox`, and Provider-native worktrees never imply `enforcedWorkspaceReadOnly`;
- `nativeApprovals` proves an enforceable pre-action bridge rather than a Provider prompt or post-action notification;
- secrets are absent from Events, Snapshots, and debug bundles;
- no invented provider telemetry appears in canonical Events.

## 20. Cross-Document References

- [00 — Vision](./00-Vision.md) defines provider delegation and product boundary.
- [01 — Core Concepts](./01-Core-Concepts.md) defines Agent, Provider Configuration, Session, and ownership.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines Provider execution inside durable Runs.
- [03 — Event Model](./03-Event-Model.md) defines Event families and the Provider evidence boundary.
- [05 — Process Runtime](./05-Process-Runtime.md) defines the Process port, cancellation, and recovery.
- [06 — Worktree Runtime](./06-Worktree-Runtime.md) defines Git observation and the Workspace mutation boundary.
- `07-Memory-Runtime.md`, `09-Conversation-Runtime.md`, `10-Data-Model.md`, and `11-API-Specification.md` will elaborate Memory, Conversation, persistence, and API surfaces.
