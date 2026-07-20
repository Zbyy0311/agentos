# AgentOS v2 — UI Architecture Cross-Document Alignment Plan

> Status: Proposed Revision Plan  
> Updated: 2026-07-19  
> Trigger: `12-UI-Architecture.md`  
> Decision: Web-first, Tauri-ready, Apple Design Engineering

---

## 1. Executive Decision

`12-UI-Architecture.md` 不推翻 00–11 的 Runtime 设计。

现有文档的核心关系仍然成立：

```text
Agent ≠ Provider
Task ≠ Run
Run ≠ Process
Conversation ≠ Run
Message ≠ Runtime Event
Browser Disconnect ≠ Run Cancel
```

UI Architecture 新增的是客户端、信息架构和平台边界：

```text
UI Surface
Client Session
View State
Runtime Transport
Platform Adapter
Browser Adapter
Future Tauri Adapter
```

修改级别：

| File | Revision Level |
|---|---|
| 00 Vision | Minor recommended |
| 01 Core Concepts | Minor recommended |
| 02 Runtime Lifecycle | Optional cross-reference |
| 03 Event Model | Optional classification note |
| 04 Provider Specification | No structural change |
| 05 Process Runtime | No structural change |
| 06 Worktree Runtime | No structural change |
| 07 Memory Runtime | No structural change |
| 08 Policy Runtime | Optional future-native actions |
| 09 Conversation Runtime | Required alignment |
| 10 Data Model | Minor recommended |
| 11 API Specification | Minor recommended |

---

## 2. `00-Vision.md`

### Revision Level

```text
Minor recommended
```

### Add Section

```markdown
## Product Surface Strategy

AgentOS v2 is Web-first and Desktop-ready.

The first product surface is the Web UI. It communicates with the
independent AgentOS Server through REST, SSE and WebSocket.

A future Tauri desktop client reuses the same UI, API Client,
Runtime contracts and domain components. Tauri acts as a native host
and sidecar lifecycle layer; it does not replace the AgentOS Runtime.
```

### Clarify Existing Next.js Statement

Replace the broad statement:

```text
Next.js frontend can be retained
```

with:

```text
The existing Next.js frontend may be retained provided that
runtime-critical behavior remains in the AgentOS Server and the
frontend remains client/static-host compatible.
```

### Add Vision Principle

```text
The interface must make autonomous execution calm, continuous,
observable, reversible where possible and explicitly user-controlled.
```

---

## 3. `01-Core-Concepts.md`

### Revision Level

```text
Minor recommended
```

### Add Concepts

```markdown
### UI Surface

A human-facing representation of Runtime resources, events and projections.

### Client Session

A temporary browser or desktop connection. A Client Session does not own
a Run, Provider Session or Runtime Process.

### View State

Ephemeral UI state such as current selection, open inspector, panel size,
focus and scroll position.

### Runtime Transport

The REST, SSE and WebSocket contract shared by Web and future Tauri hosts.

### Platform Adapter

A frontend abstraction over browser or desktop-native capabilities.
```

### Add Invariants

```text
UI Surface ≠ Runtime
Client Session ≠ Provider Session
View State ≠ Domain State
Platform Adapter ≠ Provider Adapter
Platform Adapter ≠ Runtime Transport
```

---

## 4. `02-Runtime-Lifecycle.md`

### Revision Level

```text
Optional cross-reference
```

No Run or Stage lifecycle change is required.

The existing Browser Disconnect invariant already supports Web-first and Tauri-ready architecture.

### Optional Addition

```markdown
## Client Subscription Lifecycle

connecting
  → connected
  → reconnecting
  → resyncing
  → connected / disconnected

Client Subscription status is not part of Run status.
```

---

## 5. `03-Event-Model.md`

### Revision Level

```text
Optional classification note
```

No Event Envelope or Runtime Event type redesign is required.

### Add Note

```text
Durable Runtime Event:
  execution fact stored in the Event Store

Projection Event:
  rebuildable user-facing update

Ephemeral UI Event:
  focus, hover, gesture, local panel state, presence and typing
```

Ephemeral UI events must not pollute the durable Runtime Event Store.

---

## 6. `04-Provider-Specification.md`

### Revision Level

```text
No structural change
```

Optional cross-reference:

```text
Provider Settings UI must render from Provider Manifest,
Validation and Capability data rather than hard-coded provider branches.
```

KimiCode invariants remain unchanged.

---

## 7. `05-Process-Runtime.md`

### Revision Level

```text
No structural change
```

Current Process Runtime already provides:

- server-owned Process;
- browser-disconnect independence;
- stream output;
- recovery;
- process tree;
- cancellation.

Future Tauri may add:

```text
processType = desktop-sidecar
```

only when the desktop host is implemented.

Do not add Tauri-specific Process logic now.

---

## 8. `06-Worktree-Runtime.md`

### Revision Level

```text
No structural change
```

UI consumes existing Worktree resources:

- status;
- diff;
- review;
- merge;
- conflict;
- cleanup.

No domain modification is required.

---

## 9. `07-Memory-Runtime.md`

### Revision Level

```text
No structural change
```

The new UI exposes existing Memory concepts:

- Entry;
- Candidate;
- Context;
- Score;
- Rank;
- Reasons;
- Conflict;
- Supersession.

Optional cross-reference:

```text
Memory selection reasons and budget exclusions must be exposed
through the Memory Context Inspector defined by 12-UI-Architecture.md.
```

---

## 10. `08-Policy-Runtime.md`

### Revision Level

```text
Optional minor revision
```

Current Web phase needs no new Policy domain.

Future Tauri phase may introduce:

```text
platform.open_external
platform.open_native
platform.reveal_artifact
platform.select_directory
platform.notify
desktop.sidecar_restart
desktop.auto_update
```

Add these only with actual native implementation.

### UI Alignment Note

Approval presentation must:

- default to the smallest grant scope;
- display the actual resource and target;
- display risk;
- reject ambiguous textual approval;
- keep Unsafe Mode visibly active.

---

## 11. `09-Conversation-Runtime.md`

### Revision Level

```text
Required alignment
```

### Reason

`09` currently includes a Conversation-specific UI Contract.  
`12` now becomes the authoritative global UI architecture.

### Keep in `09`

- Conversation list requirements;
- Message types;
- Composer capabilities;
- Agent history data requirements;
- Group reply controls;
- Streaming representation requirements;
- Run / Approval / Artifact projection requirements.

### Move Authority to `12`

- App Shell;
- global navigation;
- layout and breakpoints;
- design tokens;
- typography;
- materials;
- motion;
- platform adapter;
- accessibility;
- client data architecture.

### Add Boundary Statement

```markdown
`09-Conversation-Runtime.md` defines what Conversation UI must represent.

`12-UI-Architecture.md` defines how the complete AgentOS product UI is
structured, styled, animated, adapted and connected to Runtime APIs.
```

### Recommended Heading Change

```text
Part XXI — Conversation UI Requirements
```

instead of:

```text
Part XXI — Conversation UI Contract
```

This avoids two competing authoritative UI contracts.

---

## 12. `10-Data-Model.md`

### Revision Level

```text
Minor recommended
```

Add only stable preferences to the main database.

### Add `user_ui_preferences`

```sql
CREATE TABLE user_ui_preferences (
  user_id TEXT PRIMARY KEY,

  appearance TEXT NOT NULL,
  accent TEXT,
  density TEXT NOT NULL,

  reduced_motion_override TEXT,
  reduced_transparency_override TEXT,
  contrast_override TEXT,

  notification_preferences_json TEXT NOT NULL,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL
);
```

### Add `workspace_ui_preferences`

```sql
CREATE TABLE workspace_ui_preferences (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,

  default_area TEXT,
  default_conversation_id TEXT,

  sidebar_width INTEGER,
  inspector_width INTEGER,

  sidebar_collapsed INTEGER NOT NULL,
  inspector_default_open INTEGER NOT NULL,

  saved_filters_json TEXT,

  updated_at TEXT NOT NULL,

  version INTEGER NOT NULL,

  PRIMARY KEY(workspace_id, user_id)
);
```

### Do Not Persist in Runtime Database

- hover;
- focus;
- scroll;
- active drag;
- transient selection;
- animation state;
- pointer velocity;
- open popover;
- temporary resize state.

Future Tauri window position can use host-local storage rather than canonical Runtime storage.

---

## 13. `11-API-Specification.md`

### Revision Level

```text
Minor recommended
```

The existing API already includes Web UI, Desktop Client, REST, SSE, WebSocket, Artifact access and capability metadata.

### Add UI Preference Endpoints

```text
GET   /api/preferences/ui
PATCH /api/preferences/ui

GET   /api/workspaces/:workspaceId/ui-preferences
PATCH /api/workspaces/:workspaceId/ui-preferences
```

### Optional Meta Addition

```json
{
  "ui": {
    "supportedHosts": ["web", "tauri"],
    "currentHost": "web"
  }
}
```

`currentHost` is informational and must not be used as authorization evidence.

### Add Platform Boundary Note

```text
Tauri native commands are host integration contracts, not replacements
for AgentOS Runtime REST, SSE or WebSocket APIs.
```

### Do Not Add Yet

- Tauri sidecar endpoints;
- native file reveal endpoints;
- native update endpoints;
- tray endpoints.

Those belong to the future desktop-host specification.

---

## 14. Recommended Revision Order

```text
1. 09 Conversation Runtime
2. 00 Vision
3. 01 Core Concepts
4. 10 Data Model
5. 11 API Specification
6. Optional notes in 02 / 03 / 08
```

---

## 15. Blocking Assessment

None of the prior Runtime specifications must be redesigned before UI work starts.

The only documentation conflict that should be resolved early is:

```text
09 Conversation UI Contract
vs
12 Global UI Architecture
```

Resolve this by making `12` globally authoritative and `09` Conversation-domain-specific.

---

## 16. Final Recommendation

Proceed with Web UI implementation after the five recommended documentation alignments:

```text
00
01
09
10
11
```

The following documents remain structurally valid without modification:

```text
02
03
04
05
06
07
08
```

Optional cross-references can be added during documentation cleanup rather than blocking implementation.
