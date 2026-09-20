# AgentOS Runtime Specification Lite

## 12 — UI Architecture

> **Lite Title:** AI Engineering Workbench — Four-Column Shell
> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs remain authoritative for frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical Runtime Specification remains reference architecture where it exceeds Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

AgentOS Lite UI is a polished AI engineering workbench, not an admin dashboard.

It makes persistent Agents, Conversations, execution, Memory, Artifacts, and History understandable across Provider changes.

The UI is an API client. It never spawns CLI processes, runs Git, reads SQLite, or accesses Provider credentials/native history.

ACTIVE LITE is direction, not an implementation claim.

## 2. Lite Scope

### 2.1 ACTIVE LITE

- four-column Agents / Conversations / Main Canvas / Inspector shell;
- desktop adaptive collapse;
- color, typography, spacing, radius, elevation, and motion tokens;
- high-quality dark and light themes;
- reduced-motion basics;
- polished loading, empty, stale, error, offline, and reconnecting states;
- direct Conversation UX;
- bounded Group Conversation UX;
- streaming and cursor reconnect;
- Memory explanation;
- Runtime Inspector integration;
- Agent History and Search;
- source-anchored interactions;
- keyboard and semantic basics;
- API-client-only data access.

### 2.2 COMPATIBILITY

- existing web and Server surfaces remain where callers depend on them;
- existing REST/SSE, error, idempotency, and lifecycle contracts remain authoritative;
- historical UI ideas remain reference where broader than Lite.

Existing screens do not prove this workbench is implemented.

### 2.3 DEFERRED FULL-SCOPE

- Tauri desktop and native host;
- mobile-first design and mobile app;
- exhaustive Storybook and visual regression;
- complete WCAG product certification;
- every responsive breakpoint;
- full low-end performance certification;
- massive generic UI abstraction;
- workflow DAG editor;
- Provider Comparison;
- Worktree/Branch/Merge manager;
- full Policy editor and simulation.

## 3. Core Invariants

| Invariant | Contract |
|---|---|
| UI is a Runtime client | It uses typed API and SSE only. |
| UI never owns Run lifetime | Unmount, refresh, navigation, and disconnect do not cancel. |
| View state != domain state | Selection, panel size, scroll, focus, and drafts are client-only. |
| Projection != fact | Cards reference canonical Server state. |
| Agent != Provider | Provider appears as execution metadata. |
| Message != Task/Run | Composer exposes explicit modes. |
| One modifying Run per Workspace | UI shows admission, queue, and rejection honestly. |
| Read-only label = enforced | UI shows concurrent read-only only when the Run has tested `enforcedWorkspaceReadOnly` evidence. |
| Git internals are noncanonical | No AgentOS-owned branch/worktree fiction. |
| Status is not color-only | Icon, text, and accessible name accompany color. |
| Secret values stay off client | Credentials never enter normal state, toast, search, or screenshot. |
| Reduced motion is respected | Necessary feedback remains without translation/spring. |

## 4. Product Character

The experience is:

~~~text
calm
controlled
continuous
precise
trustworthy
~~~

Agent identity is the navigation anchor. Runtime complexity is progressively disclosed.

Provider tools, internal worktrees, subagents, plans, and native sessions appear only when useful as diagnostics and are never promoted to canonical AgentOS state.

## 5. Four-Column Workbench

~~~text
+-------------+------------------+----------------------+----------------+
| Agents      | Conversations    | Main Canvas          | Inspector      |
| identities  | direct/group     | chat/run/artifact    | runtime facts  |
| status      | unread/mentions  | composer/diff        | events/memory  |
+-------------+------------------+----------------------+----------------+
~~~

### Agents

- persistent Agent Profile, role, default Provider;
- active Run and pending approval;
- Memory and History entry points;
- status independent of Provider session.

### Conversations

- direct/group type;
- last Message, unread, mention;
- active Run, approval, archive;
- search/filter and new Conversation.

### Main Canvas

- Message timeline and Composer;
- Run/Stage view;
- Artifact and diff views;
- workflow-template execution;
- polished stream/error/empty states.

### Inspector

- Run, Stage, Provider, Process, duration;
- Events and output references;
- Memory Context and explanations;
- Artifacts and Git observation;
- errors, cancellation, retry, recovery.

Inspector opens without replacing Canvas context.

## 6. App Shell and Adaptive Layout

Toolbar:

- Workspace breadcrumb;
- Search and Command Palette;
- connection and cursor state;
- active Run and approval counts;
- theme and density controls.

Width guidance:

~~~text
Agents         220–300 px
Conversations  240–320 px
Main Canvas    minimum 560 px
Inspector      300–400 px
~~~

Modes:

- wide: four columns;
- standard: Inspector overlay/collapse;
- compact: Agent rail plus Canvas, other panels as sheets;
- narrow mobile productization: deferred.

Panel preferences remain UI state, not Runtime Events.

## 7. Design Tokens

Flow:

~~~text
primitive -> semantic -> component -> state override
~~~

### Color

Semantic families:

- surface base/subtle/raised/overlay/selected;
- text primary/secondary/tertiary/disabled;
- border subtle/default/strong and focus ring;
- accent default/hover/pressed;
- neutral/running/waiting/success/warning/danger/paused statuses.

### Typography

- Windows-first system UI stack including Segoe UI;
- Cascadia Code or system monospace for code;
- Display, Title, Heading, Body, Dense, Caption, Micro, Code scale;
- Regular, Medium, Semibold weights.

### Space and Radius

- 4 px base spacing scale;
- compact and comfortable density without shrinking targets;
- small radii for inputs/rows, medium for cards/panels, larger only for overlays;
- no uniform oversized rounding.

### Elevation and Material

- content, raised card, floating toolbar, popover, modal levels;
- material reserved for functional chrome;
- code, logs, diff, Messages, and forms use readable solid surfaces;
- reduced transparency falls back to solid surfaces.

## 8. Dark and Light

Both themes derive from the same semantic tokens.

- body contrast targets 4.5:1;
- status never depends only on hue;
- focus remains visible;
- dark avoids pure-black void and neon overload;
- light avoids flat low-contrast gray;
- system, light, dark preferences persist;
- accent cannot override danger/status semantics.

## 9. Motion and Reduced Motion

Use short tokenized press, micro, crossfade, and panel transitions.

Rules:

- animate transform and opacity;
- interactions are interruptible;
- panels exit toward their origin;
- ordinary menus and toasts do not bounce;
- streaming does not cause layout jump.

Reduced motion:

- replaces springs/translation with crossfade;
- disables parallax, overshoot, and loops;
- preserves status and completion feedback.

## 10. Streaming and Reconnect

~~~text
Provider deltas
  -> batched client updates
  -> one streaming block
  -> final or failed Message
~~~

- no DOM node per token;
- scroll-up pauses auto-scroll;
- back-to-latest is explicit;
- finalize preserves anchor;
- stream cannot remain silently open.

Connection states:

~~~text
connecting -> connected -> reconnecting -> resyncing -> disconnected
~~~

Reconnect resumes from durable cursor, replays committed records, drains buffered arrivals, detects gaps, and REST-resyncs when needed.

Disconnect never marks a Run failed or cancels a Process.

## 11. Async States

Every async surface supports:

- idle;
- loading;
- empty;
- partial;
- stale;
- error;
- permission denied;
- recovery required;
- offline/reconnecting.

Skeletons preserve layout. Empty states name the absent object and a useful action. Errors show stable code, retryability, and suggested action; UI never parses prose.

Offline state says when the Run continues on the Server.

## 12. Direct Conversation UX

~~~text
Select Agent
  -> open Conversation
  -> Send Message
  -> stream and persist response
  -> optionally create Task or Run
  -> inspect execution
~~~

Visible concepts:

- Agent identity;
- Provider used;
- Run state;
- Memory used;
- Artifacts/changes;
- error state.

Composer modes are Chat, Task, and Run. Normal Send starts no modifying Run.

Messages remain visually light; runtime cards are semantic and progressively expandable.

## 13. Group Conversation UX

Group Conversation is **ACTIVE LITE** and visibly bounded:

- explicit Agents, roles, and reply modes;
- @Agent and @all bound to durable IDs;
- sequential, parallel-read-only, orchestrated, manual, mention-only modes;
- parallel-read-only is unavailable or shown as modifying/queued when technical Workspace write denial is unavailable or unknown;
- visible Agent/reply/hop/time budgets;
- Stop and Loop Guard feedback;
- isolated per-Agent context;
- queue/admission state for modifying steps.

@all never launches parallel modifying Runs.

## 14. Memory Explanation

The UI answers why each Memory was selected.

Context view shows:

- query and retrieval strategy;
- Entry rank and score;
- Scope, Importance, Confidence, Authority, Source;
- reason list;
- token cost and total budget;
- exclusions and truncation reasons;
- immutable Snapshot identity.

Candidate review supports accept, edit-and-accept, reject, and merge with duplicate/conflict evidence.

## 15. Inspector UX

Inspector is a query projection, never source of truth.

It shows:

- Run/Stage status and retry lineage;
- Provider and capability fidelity, including requested versus effective mutation class and `enforcedWorkspaceReadOnly` evidence;
- AgentOS Process ID distinct from PID;
- ordered redacted Events;
- bounded stdout/stderr or restricted Artifact;
- Memory Context;
- Artifact and Git observation;
- error, cancel, retry, and recovery classification.

Cancel, Retry, Approve, and Reject call typed APIs through Policy/runtime. UNKNOWN is never presented as success. No reattach control exists.

## 16. History and Search

History is unified by Agent Profile across Provider changes.

Search filters by Agent, Workspace, Conversation, Task, Run, Provider, time, status, and type. Results link to canonical source records.

Secrets and native Provider transcript content are not indexed.

## 17. Source Anchoring

- Run card opens the corresponding Inspector object;
- Artifact links use IDs and Workspace-relative paths;
- diff anchors to Artifact and source Run;
- full local paths appear only in restricted diagnostics;
- path text is never the resource contract.

## 18. API Client Boundary

~~~text
UI -> typed AgentOS API Client -> REST/SSE -> Server
~~~

Client owns query cache, view state, panel layout, drafts, focus, and scroll.

Server owns Agent, Conversation, Task, Run, Stage, Process, Event, Memory, Artifact, and Approval.

Idempotency keys are reused on retry. Component-level fetch, CLI, Git, SQLite, and Provider history access are anti-patterns.

## 19. Keyboard and Semantics

Keyboard covers navigation, Search, Send, Task/Run creation, Inspector, approvals, cancel, tabs, menus, and dialogs.

Focus:

- visible ring;
- logical order;
- restore after close;
- no streaming focus steal;
- modal trap only for blocking surfaces.

Semantics:

- landmarks and headings;
- list roles for Agents, Conversations, Messages, Events;
- restrained live regions;
- sanitized Markdown;
- Agent output cannot render trusted approval controls.

## 20. Failure and Safety

- UI never infers terminal state from stdout or prose;
- browser lifecycle never cancels execution;
- ambiguous text never approves;
- secret values never enter ordinary client state;
- destructive actions show exact target and minimal scope;
- UNKNOWN recovery is fail-closed;
- external links and Markdown are sanitized;
- every stream finalizes or fails.

## 21. Compatibility Policy

Existing web and Server surfaces remain under COMPATIBILITY. Lite creates no second UI authority and requires no destructive migration.

Current screens are not acceptance evidence for the token system, four-column shell, Memory explanation, or Inspector.

## 22. Acceptance Expectations

Independent verification must prove:

- four-column layout and adaptive collapse;
- shared semantic token coverage;
- dark/light contrast;
- reduced-motion behavior;
- batched streaming and stable scroll;
- cursor reconnect without gaps/duplicates;
- complete async states;
- explicit Chat/Task/Run actions;
- bounded Group controls;
- truthful parallel-read-only availability and modifying admission when write denial cannot be enforced;
- Memory selection explanation;
- Inspector parity with canonical data;
- Agent-unified History and secret-free Search;
- keyboard core flow and stable focus;
- API-client-only access;
- absence of active Worktree manager, full Policy editor, and Provider Comparison.

## 23. Deferred / Non-Goals

- Tauri and native host;
- mobile app/mobile-first design;
- exhaustive Storybook/visual regression;
- complete WCAG certification;
- every breakpoint and low-end certification;
- generic UI framework program;
- workflow DAG editor;
- Provider Comparison;
- Worktree/merge manager;
- full Policy administration UI.

## 24. Cross-Document References

- [00 — Vision](./00-Vision.md) defines product destination.
- [01 — Core Concepts](./01-Core-Concepts.md) defines visible identities.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines transport independence.
- [03 — Event Model](./03-Event-Model.md) defines streaming facts.
- [04 — Provider Specification](./04-Provider-Specification.md) defines Provider fidelity.
- [05 — Process Runtime](./05-Process-Runtime.md) defines Process diagnostics.
- [06 — Worktree Runtime](./06-Worktree-Runtime.md) defines Git observation.
- [07 — Memory Runtime](./07-Memory-Runtime.md) defines explanations.
- [08 — Policy Runtime](./08-Policy-Runtime.md) defines trusted approval.
- [09 — Conversation Runtime](./09-Conversation-Runtime.md) defines direct/group UX.
- [10 — Data Model](./10-Data-Model.md) defines persistence projections.
- [11 — API Specification](./11-API-Specification.md) defines client contracts.
- [13 — Runtime Inspector](./13-Runtime-Inspector.md) defines focused inspection.
