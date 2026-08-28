# AgentOS Runtime Specification Lite

## 06 — Worktree Runtime

> **Lite Title:** Git Observation / Workspace Mutation Boundary
> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs retain authority for already-frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical `Runtime-Specification` remains reference architecture where it is broader than Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

This document reframes the historical Worktree Runtime for Lite.

AgentOS Lite does not own a Git workflow engine.

It observes Git for traceability and enforces one simple mutation boundary per Workspace.

> AgentOS observes Git. AgentOS does not own Git workflow execution.

The historical filename is preserved for reference compatibility; the Lite title is `Git Observation / Workspace Mutation Boundary`.

## 2. Lite Scope

### 2.1 ACTIVE LITE

- Workspace Git root discovery;
- Process cwd observation;
- base commit and final commit observation when observable;
- Git status snapshot;
- changed files;
- diff and diff Artifact reference;
- repository dirty-state awareness;
- read-only / modifying Run classification;
- one modifying Run per Workspace with queued or rejected admission.

### 2.2 COMPATIBILITY

- historical Worktree fields and Events remain stored and readable; tables remain compatible where present;
- merged Run snapshot fields that reference historical Worktree state;
- existing Git-related compatibility code that supports merged correctness.

### 2.3 DEFERRED FULL-SCOPE

- AgentOS-owned Worktree Manager;
- Branch Manager;
- Merge Manager;
- Conflict Manager;
- Integration Worktree;
- Worktree Recovery system;
- automatic Git workflow engine;
- automatic cleanup or destructive Git behavior.

## 3. Core Principles and Invariants

| Invariant | Meaning |
|---|---|
| Git observation != Git ownership | AgentOS records traceability facts; it does not run the workflow. |
| Provider Git internals are noncanonical | Native branches and worktrees are provider implementation details. |
| Workspace != Worktree | A Workspace is a project boundary; a Worktree is a provider detail. |
| Modifying Run admission != Worktree creation | A modifying Run needs admission, not an AgentOS Worktree. |
| One modifying Run per Workspace | At most one AgentOS modifying Run executes at a time. |
| Read-only Runs may overlap | Concurrency applies only when writes are denied. |
| Unknown classification is modifying | Admission defaults to the safer classification. |
| No silent destructive Git | AgentOS never stashes, resets, deletes, or force-merges automatically. |
| Observation never invents facts | Unavailable Git facts are recorded as unavailable. |

## 4. AgentOS Observes Git

### 4.1 Observed Facts

For a Workspace with an observable Git root, AgentOS records:

- Git root (`rev-parse --show-toplevel` equivalent);
- Process cwd;
- base commit when observable;
- final commit when observable;
- status snapshot (staged, modified, deleted, renamed, untracked, conflicted, clean);
- changed file list;
- diff summary and diff Artifact reference;
- dirty-state awareness.

These are observation records.

They are not AgentOS-owned branch, worktree, merge, or conflict state.

### 4.2 Observation Triggers

Observations may be captured:

- at admission or Run start;
- at key lifecycle milestones;
- at Run terminal state;
- on demand through the Inspector.

### 4.3 Non-Git Workspace

A directory Workspace without a Git root is recorded as `not-git`.

There is no silent copy, snapshot, or reflink fallback in Lite.

Missing Git observability is reported as unavailable, never fabricated.

## 5. Workspace Mutation Boundary

### 5.1 Run Classification

Every Run Request is classified before admission:

```text
read-only
  -> cannot intentionally mutate Workspace content or external state

modifying
  -> may change Workspace content or perform a declared modifying action
```

Unknown or ambiguous classification is treated as modifying for admission safety.

### 5.2 Single-Writer Rule

Within one Workspace:

```text
read-only Runs
  -> may execute concurrently within configured limits

modifying Runs
  -> at most one AgentOS modifying Run at a time

additional modifying Runs
  -> queued or rejected by the runtime contract
```

Rules:

- admission is atomic with the authoritative queue/operation contract;
- a rejected request returns a stable reason and a durable Operation outcome;
- admission is never delegated to a Prompt;
- provider-internal worktrees never permit a second modifying Run;
- the modifying authority is released only by a committed terminal, cancellation, or fail-closed recovery transition.

### 5.3 No Worktree Dependency

A modifying Run does not require:

- AgentOS Worktree creation;
- branch reservation;
- merge planning;
- Integration Worktree;
- Worktree recovery.

Provider-internal worktrees remain allowed and noncanonical.

## 6. Process cwd

The Process cwd is:

- the admitted Workspace; or
- an explicitly validated provider-selected directory.

The recorded cwd is an observation fact.

Providers may internally use Git and worktrees.

Those internal mechanics are not canonical AgentOS isolation state and do not change Workspace admission.

## 7. Diff and Artifact

### 7.1 Diff Bases

Diff observation states its bases explicitly, for example:

- working tree vs HEAD;
- HEAD vs observed base commit;
- final observable commit vs base commit.

### 7.2 Diff Artifact

A diff observation may produce:

- unified diff reference;
- changed-file list;
- binary-file index;
- status snapshot;
- base and final commit references.

The diff Artifact is immutable once created, checksummed, and source-linked.

Large or sensitive content lives in the Artifact, never in ordinary Event payloads.

## 8. Events

Lite Git observation Events report observable facts:

- Git root and cwd observed;
- base commit observed;
- status snapshot observed;
- changed files observed;
- final commit observed when available;
- diff Artifact registered.

They never claim AgentOS created a branch, owned a Worktree, performed a merge, or controlled provider-native Git actions.

Historical `worktree.*` and merge Events remain under **COMPATIBILITY**; they are not active Lite workflow requirements.

## 9. Included Capabilities

- Git root discovery and dirty-state awareness;
- base and final commit observation when observable;
- status snapshot and changed-file list;
- diff summary and diff Artifact reference;
- read-only / modifying classification;
- Workspace single-writer admission with queued or rejected outcomes;
- non-Git `not-git` reporting without silent fallback;
- Inspector view of Git observation facts.

## 10. Deferred / Non-Goals

The following are **DEFERRED FULL-SCOPE**:

- AgentOS-owned Worktree lifecycle;
- AgentOS-owned branch management;
- merge execution;
- conflict resolution;
- Integration Worktree;
- Worktree recovery and orphan cleanup;
- automatic `git stash`, reset, rebase, merge, push, or force operations;
- automatic cleanup of provider-created worktrees;
- using an AgentOS-managed Worktree as a modifying-Run prerequisite;
- parallel modifying Runs in one Workspace.

Lite never executes destructive Git behavior on a Workspace.

## 11. Compatibility with the Existing Runtime

- Historical Worktree tables, fields, migrations, and Events may remain stored under **COMPATIBILITY**.
- Merged Run snapshot fields referencing historical Worktree state remain valid.
- No destructive schema simplification is implied.
- Lite does not delete or rewrite the merged Git-related compatibility code.
- Compatibility records are not promoted to active Lite workflow requirements.

## 12. Failure and Safety Rules

- Admission failure returns queued or rejected with a stable reason; it never silently downgrades a modifying Run to the Workspace root.
- Observation failure records unavailable rather than guessing.
- A missing Git observation never authorizes completion or claims no changes occurred.
- AgentOS never auto-creates a Worktree or runs Git mutation commands to satisfy a Run.
- Read-only concurrency must actually deny writes; classification is enforced in code, not prompts.
- Provider-internal worktrees cannot bypass the Workspace single-writer rule.
- No automatic cleanup, stash, reset, merge, or push is performed.

## 13. Acceptance Expectations

Independent verification must cover:

- one Workspace never admits two AgentOS modifying Runs concurrently;
- read-only Runs execute concurrently only when writes are denied;
- unknown classification is admitted as modifying;
- Git root, cwd, base/final commit, status, changed files, and diff Artifact are recorded without ownership claims;
- non-Git Workspaces report `not-git` without silent fallback;
- diff Artifacts are immutable and checksummed;
- historical Worktree fields and Events remain readable;
- a modifying Run completes without any AgentOS-owned Worktree;
- no automatic or destructive Git command is executed by observation;
- Git observation wording never implies AgentOS-owned Git workflow.

## 14. Cross-Document References

- [00 — Vision](./00-Vision.md) defines the Git/Worktree scope reduction and Fast Track.
- [01 — Core Concepts](./01-Core-Concepts.md) defines the Workspace and the single-writer rule.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines Workspace admission and mutation serialization.
- [03 — Event Model](./03-Event-Model.md) defines Git Observation Event families.
- [04 — Provider Specification](./04-Provider-Specification.md) keeps provider-native Git and worktrees noncanonical.
- [05 — Process Runtime](./05-Process-Runtime.md) defines the Process cwd boundary.
- `07-Memory-Runtime.md`, `10-Data-Model.md`, `11-API-Specification.md`, and `13-Runtime-Inspector.md` will elaborate persistence, API, and inspection surfaces.
