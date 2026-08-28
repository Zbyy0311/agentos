# AgentOS Runtime Specification Lite

## 08 — Policy Runtime

> **Lite Title:** Minimal Safety Enforcement / Approval Boundary
> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs remain authoritative for frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical Runtime Specification remains reference architecture where it exceeds Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

The Lite Policy Runtime is a small, code-enforced safety layer for actions AgentOS controls.

Its complete decision set is:

~~~text
ALLOW
DENY
ASK_USER
~~~

Policy is not prompt guidance. It gates execution before a high-impact action starts when that action crosses an AgentOS-controlled or verified Provider pre-action boundary; otherwise it reports enforcement as unavailable rather than claiming control.

## 2. Lite Scope

### 2.1 ACTIVE LITE

- code-defined ALLOW, DENY, and ASK_USER decisions;
- pre-execution enforcement at real AgentOS boundaries;
- immutable redacted Request Snapshots;
- persistent Approval Requests;
- idempotent approve/reject handling;
- expiry and stale-decision prevention;
- fail-closed defaults;
- policy and approval Events;
- Run waiting_approval integration;
- verified Provider-native pre-action approval bridging without bypass;
- Workspace single-writer admission.

### 2.2 COMPATIBILITY

- existing policy-related fields, Events, and projections remain readable where present;
- merged contracts and ADRs retain frozen correctness authority;
- existing prompt safety text may remain guidance but is not enforcement;
- existing Provider approval surfaces may be normalized into ASK_USER only when they expose a trustworthy pre-action pause/control point; otherwise they remain non-enforcing compatibility UI.

### 2.3 DEFERRED FULL-SCOPE

- Policy DSL and compiler;
- rule-priority, specificity, and profile engines;
- grants and exception engine;
- policy simulation;
- enterprise RBAC;
- multi-tenant administration;
- elaborate extension permissions;
- product Unsafe Mode;
- policy template marketplace and large metrics surface.

## 3. Core Invariants

| Invariant | Contract |
|---|---|
| Policy != Prompt | A prompt cannot authorize execution. |
| Decide before execute | No high-impact action crossing an AgentOS-controlled or verified Provider pre-action boundary starts without a decision. |
| Enforce in code | Policy guarantees only what an AgentOS-controlled boundary or verified enforceable Provider pre-action bridge can intercept. |
| No interception != enforcement | AgentOS reports unavailable enforcement rather than claiming an un-interceptable Provider-native action was blocked. |
| Fail closed | Engine, normalization, or context uncertainty never auto-allows risk. |
| DENY wins | At an enforceable boundary, hard-deny classes cannot be re-enabled by a prompt or Provider. |
| ASK_USER is bounded | Approval is scoped, expiring, and re-evaluated. |
| Snapshot before decision | The evaluated request is frozen and redacted. |
| Stale approval is void | Action, resource, Run, policy, or expiry drift requires re-evaluation. |
| Secret values never persist | Records contain secret references only. |
| Browser disconnect != approval | Transport loss does not decide or cancel an Approval Request. |
| Single writer remains authoritative | Policy cannot bypass Workspace mutation admission. |

## 4. Decision Model

~~~text
ALLOW
  -> proceed with enforced constraints

DENY
  -> block with stable error and no execution

ASK_USER
  -> persist Approval Request
  -> Run waits
  -> user decision
  -> mandatory stale check and re-evaluation
~~~

Defaults:

- known low-risk read-only actions may ALLOW only when `enforcedWorkspaceReadOnly` technically denies Workspace writes inside the validated execution boundary;
- destructive, external, secret-sensitive, or unknown high-risk actions DENY or ASK_USER;
- an unknown mutation classification is treated as modifying;
- hard-deny actions cannot become ALLOW through configuration.

Lite uses small code-defined rule sets. Configuration may conservatively choose DENY versus ASK_USER for named boundaries; it is not a user-authored policy language.

## 5. Enforcement Boundaries

Policy has two enforceable paths:

```text
AgentOS-owned action
  -> AgentOS Policy returns ALLOW / DENY / ASK_USER
  -> the AgentOS action boundary enforces the result

Provider-native action
  + verified nativeApprovals pre-action capability
  -> Adapter bridges the action into AgentOS Policy before execution
  -> the same Provider-native boundary enforces the returned result
```

A Provider-native action without trustworthy pre-action interception is outside the guaranteed Policy enforcement boundary. AgentOS must not claim that it blocked such an action.

### 5.1 Workspace Admission

~~~text
requested read-only + tested enforcedWorkspaceReadOnly
  -> effective read-only -> concurrent within limits

otherwise, including unknown or unavailable enforcement
  -> modifying -> sole Workspace modifying authority required
~~~

Prompt wording and Provider declarations without tested technical write denial are not read-only evidence. Admission is atomic with the Run/operation contract. A modifying Run does not require an AgentOS-managed Worktree.

### 5.2 Process Spawn

Before spawn, Policy evaluates:

- executable identity and resolved path;
- argument array and redacted values;
- cwd and Workspace boundary;
- shell use, disabled by default;
- environment key names and secret references;
- timeout and resource controls.

Provider Adapters do not bypass the Process Manager.

### 5.3 Destructive Filesystem Actions

At an AgentOS-controlled or verified Provider pre-action boundary, delete, recursive delete, force flags, paths outside the Workspace, and AgentOS-managed data require an explicit decision. Unbounded recursive deletion and AgentOS canonical-data destruction are hard DENY.

### 5.4 Merge, Push, and External Effects

Merge and push are distinct actions. For AgentOS-initiated merge/push actions, or Provider-native merge/push exposed through a verified enforceable pre-action bridge, unknown or protected-state merge defaults to ASK_USER and force push or direct push to a protected branch defaults to DENY.

Provider-native Git remains a Provider implementation detail. Without an enforceable pre-action bridge, AgentOS does not claim to have blocked Provider-native merge or push. The Run is conservatively modifying, Workspace single-writer admission applies, unsafe capability or mode is disabled where the Adapter can do so, and enforcement availability is reported honestly.

At an enforceable boundary, upload, publish, credential export, and network egress of source or Artifact content default to DENY or ASK_USER. Redirects are evaluated at their final destination.

Lite observes Git and does not become a branch or merge manager. It does not reimplement a generic Git command interceptor.

### 5.5 Secrets and Provider Unsafe Flags

At an enforceable boundary, secret injection requires an explicit reference and a declared destination, and secret export is DENY by default.

Provider unsafe flags, elevation, and privilege escalation are DENY by default at enforceable boundaries. If a Provider-native unsafe mode cannot be intercepted, the Adapter disables it where possible, classifies the Run conservatively, and reports unavailable enforcement. Provider-native approval never becomes AgentOS authority.

## 6. Request Snapshot

Each evaluation freezes:

- policyRequestId;
- user, Agent, Run, Stage, and Workspace references;
- normalized action and risk category;
- normalized resource and canonical path or host;
- cwd and Provider Configuration reference;
- redacted executable and arguments;
- effect and reversibility classification;
- policy version;
- requestedAt and expiry policy;
- immutable snapshot hash.

Secret values are redacted before persistence. A redaction failure blocks the record and the action.

## 7. Evaluation

~~~text
validate caller and Run
  -> normalize action and resource
  -> classify risk and mutation
  -> freeze Request Snapshot
  -> apply built-in rules
  -> persist decision + Event
  -> return decision to enforcement point
~~~

Each request has a stable policyRequestId. Repeated evaluation converges on the original decision while the snapshot, Run, policy version, and expiry remain valid.

DENY includes a stable code, phase, reason, and safe alternative when known.

ALLOW may attach constraints such as:

- path boundary;
- no shell;
- no child process;
- no secret;
- timeout;
- expected commit.

The enforcement point must apply the constraints; logging them is insufficient.

## 8. ASK_USER and Approval

An Approval Request stores:

- Workspace, Run, and optional Stage references;
- Request Snapshot reference;
- category and risk;
- allowed scope, normally once;
- pending, approved, rejected, expired, or cancelled status;
- expiry;
- optimistic-concurrency version.

Creating the request moves the Run to waiting_approval or paused according to the lifecycle contract.

User choices:

~~~text
approve scoped action
reject action
cancel Run
~~~

Concurrent decisions use version checks. Exactly one committed result wins; retries return that result.

An approval expires:

- after its one-time use;
- at its TTL;
- when the Run becomes terminal;
- when the action is no longer meaningful.

Immediately before execution, AgentOS verifies:

- snapshot fingerprint unchanged;
- action and resource still match;
- Run remains active;
- Workspace modifying authority remains held when required;
- approval remains unexpired;
- relevant policy version remains valid.

Any mismatch voids the approval and requires a new decision.

## 9. Provider Approval Bridge

When `nativeApprovals` is verified as an enforceable pre-action capability, a Provider-native action is normalized by the Adapter into an AgentOS action before execution. AgentOS evaluates it through the same pipeline and returns ALLOW, DENY, or ASK_USER to the Provider boundary that is still able to stop execution.

Without that verified pre-action bridge, AgentOS records Policy enforcement as unavailable for the Provider-native action. It applies conservative mutation admission and disables unsafe capability or mode where possible, but it does not fabricate a DENY enforcement result.

Provider-native prompts, sessions, sandboxes, approvals, or after-the-fact notifications do not become AgentOS authority.

## 10. Events and Audit

Representative Events:

~~~text
policy.evaluated
policy.allowed
policy.denied
approval.required
approval.resolved
approval.expired
~~~

Audit links the caller, snapshot, decision, reason, enforcement result, Run, and Event. Browser disconnect never generates a policy decision.

## 11. Failure and Safety Rules

- Engine failure on mutation or high risk DENYs or pauses; never ALLOWs.
- Unknown high-risk actions DENY.
- Normalization uncertainty fails closed.
- Secret or redaction failure blocks persistence and execution.
- Stale or expired approval never executes.
- Bypass of an available AgentOS-controlled or verified pre-action enforcement point is a contract violation.
- Missing Provider pre-action interception is reported as unavailable enforcement, never as a successful block.
- Provider success does not prove policy compliance.
- Hard DENY cannot be overridden by ordinary configuration.
- An approval never outlives its request.

## 12. Compatibility with Existing Runtime

Existing policy fields, Events, and projections may remain for compatibility. No destructive schema or source deletion is implied.

Merged low-level contracts remain authoritative. Lite stops treating the historical DSL, grants, simulation, and RBAC machinery as forward critical path; it does not invalidate already-frozen behavior.

## 13. Included Capabilities

- ALLOW, DENY, ASK_USER;
- built-in safety rules;
- Workspace admission;
- spawn and filesystem boundaries;
- enforceable AgentOS-owned and verified Provider pre-action boundaries for merge, push, external effects, and secrets;
- Request Snapshots;
- persistent expiring approvals;
- stale-decision re-evaluation;
- Provider approval bridge;
- Events, audit, UI, and Inspector visibility.

## 14. Deferred / Non-Goals

- full Policy DSL;
- profiles, specificity, and precedence engine;
- grants, revocation, and exceptions engine;
- simulation framework;
- enterprise RBAC;
- multi-tenant administration;
- product Unsafe Mode;
- elaborate extension permission system;
- relying on prompts or Provider approval as authority.

## 15. Acceptance Expectations

Independent verification must prove:

- every high-impact action at an AgentOS-controlled or verified Provider pre-action boundary is decided before execution;
- DENY blocks AgentOS-owned spawn, destructive filesystem action, merge, push, and secret export;
- DENY blocks Provider-native merge or push only when a verified enforceable pre-action bridge exposes that action before execution;
- un-interceptable Provider-native actions are never reported as blocked; their Runs are modifying, single-writer admission applies, and unavailable enforcement is visible;
- ASK_USER persists and pauses the Run;
- concurrent approve/reject is idempotent;
- stale and expired approvals cannot execute;
- snapshot hashes detect changed actions;
- snapshots and Events contain no secret values;
- Provider-native approval cannot become AgentOS authority, and only a verified pre-action bridge creates an enforcement guarantee;
- engine failure fails closed;
- browser disconnect does not decide;
- no policy path bypasses single-writer admission;
- modifying execution succeeds without an AgentOS-owned Worktree;
- no full DSL, grants, simulation, or RBAC feature is active Lite scope.

## 16. Cross-Document References

- [00 — Vision](./00-Vision.md) sets the simplified Policy boundary.
- [01 — Core Concepts](./01-Core-Concepts.md) defines Workspace, Run, and mutation class.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines waiting_approval.
- [03 — Event Model](./03-Event-Model.md) defines Policy and Approval Events.
- [04 — Provider Specification](./04-Provider-Specification.md) defines native approval bridging.
- [05 — Process Runtime](./05-Process-Runtime.md) is the spawn enforcement point.
- [06 — Worktree Runtime](./06-Worktree-Runtime.md) defines single-writer admission.
- [09 — Conversation Runtime](./09-Conversation-Runtime.md) projects approvals to users.
- [10 — Data Model](./10-Data-Model.md) preserves compatible approval persistence.
- [11 — API Specification](./11-API-Specification.md) exposes decision endpoints.
- [12 — UI Architecture](./12-UI-Architecture.md) presents actionable approval UX.
- [13 — Runtime Inspector](./13-Runtime-Inspector.md) exposes audit evidence.
