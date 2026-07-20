# AgentOS v1 → v2 Migration Map

> Date: 2026-07-21  
> Scope: Full v1-to-v2 component mapping for M1 audit  
> Repository: `Zbyy0311/agentos`

---

## Decision Key

| Decision | Meaning |
|---|---|
| **keep** | Can be retained with minimal or no changes |
| **wrap** | Add a compatibility layer around existing implementation |
| **refactor** | Restructure internally; external interface unchanged |
| **migrate** | Rewrite with new design; may coexist temporarily |
| **replace** | Remove current implementation and build new |
| **retire** | Remove entirely; no v2 equivalent needed |
| **missing** | v2 concept not yet present in v1 codebase |

---

## Core Domain Mapping

### Workspace

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| WorkspaceManager | apps/server/src/managers/WorkspaceManager.ts | Workspace CRUD, path resolution, agent config | Workspace (core entity) | **keep** | None | Low — already matches v2 scope |
| Workspace type | packages/shared/src/types/index.ts:610-620 | Workspace serialization | Workspace type | **refactor** | M2 storage migration | Low — add fields, retire agents array |
| Workspace routes | apps/server/src/routes/workspaces.ts | REST endpoints | Workspace API | **keep** | None | Low |
| WorkspaceLayout | apps/web/src/components/layout/WorkspaceLayout.tsx | UI shell | App Shell (v2) | **keep** | None | Low |

### Agent Profile

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| WorkspaceAgent | packages/shared/src/types/index.ts:84-95 | Agent config (role, CLI, model) | Agent Profile | **refactor** | M2 provider-config separation | Medium — agent/provider are mixed |
| AgentProfile | packages/shared/src/types/index.ts:144-153 | Extended agent with capability, permissions | Agent Profile (v2) | **refactor** | M2 storage | Medium — add snapshot fields |
| AgentEditor | apps/web/src/components/chat/AgentEditor.tsx | UI for editing agent | Agent Profile UI | **keep** | M2 provider settings refactor | Low |
| AgentList | apps/web/src/components/chat/AgentList.tsx | Agent sidebar list | Agent Profile UI | **keep** | None | Low |
| AgentPresenceService | apps/server/src/services/AgentPresenceService.ts | Agent online/working/idle state | Agent Profile (presence) | **keep** | None | Low |

### Provider Configuration

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| AGENT_CONFIGS | packages/agent-core/src/config.ts:42-69 | Hardcoded per-stage CLI config | Provider Configuration | **migrate** | M2 core refactor | High — removes hardcoded config |
| CLI command resolution | packages/agent-core/src/resolveCommand.ts | Find CLI in PATH | Provider Discovery | **refactor** | M2 adapter refactor | Medium |
| resolveAgentRuntimeConfig | packages/agent-core/src/executor.ts:104-136 | Resolve CLI args, env, model | Provider Configuration snapshot | **migrate** | M2 adapter refactor | High |
| AgentCliAdapterRegistry | packages/agent-core/src/adapters/registry.ts | Resolve adapter + provider | Provider Registry | **wrap** | M2 adapter refactor | Medium |
| CodexAdapter | packages/agent-core/src/adapters/codexAdapter.ts | Parse Codex output | CodexProviderAdapter | **refactor** | M2 adapter interface | Medium |
| KimiAdapter | packages/agent-core/src/adapters/kimiAdapter.ts | Parse Kimi output | KimiCodeProviderAdapter | **refactor** | M2 direct kimi.exe | High — must stop using opencode |
| PlainTextAdapter | packages/agent-core/src/adapters/plainTextAdapter.ts | Plain text fallback parser | Custom CLI Adapter | **refactor** | M2 adapter interface | Medium |

### Workflow Definition

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| AgentStage type | packages/shared/src/types/index.ts:78-82 | Fixed `codex_manager | kimi_worker | opencode_reviewer | codex_final_review` | Workflow Definition | **migrate** | M2 core | High — core type change |
| STAGE_ROLE_MAP | packages/agent-core/src/config.ts:35-40 | Stage → Role mapping | Workflow Stage config | **migrate** | M2 workflow definition | High — embedded in runner |
| taskPipeline.ts | apps/server/src/routes/taskPipeline.ts | Fixed pipeline decision logic | Workflow Definition | **refactor** | M2 run separation | Medium |
| runFullPipeline | packages/agent-core/src/runner.ts:48-60 | Four fixed stages | Workflow Template | **migrate** | M2 run engine | High |

### Task

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| TaskItem | packages/shared/src/types/index.ts:622-635 | Task with embedded outputs | Task (v2) | **refactor** | M2 run separation | High — must remove outputs |
| TaskLog | packages/shared/src/types/index.ts:637-646 | Per-stage execution output | Run / Artifact | **refactor** | M2 event model | High |
| TaskStatus | packages/shared/src/types/index.ts:1 | `pending | running | reviewing | completed | failed | cancelled` | TaskStatus (v2) | **refactor** | M2 run separation | Medium |
| Task routes | apps/server/src/routes/tasks.ts | CRUD + run pipeline | Task + Run API | **migrate** | M2 run engine | High — SSE/HTTP coupling |

### Run

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| AgentRun | packages/shared/src/types/index.ts:211-231 | Run in conversation context | Run (v2) | **refactor** | M2 core | Medium — close to v2 |
| AgentRunStatus | packages/shared/src/types/index.ts:23 | `queued | running | waiting_user | completed | failed | cancelled` | RunStatus (v2) | **refactor** | M2 lifecycle | Low — add missing states |
| RunStep | packages/shared/src/types/index.ts:528-548 | Step within a run | Run Stage | **keep** | M2 stage rename | Low |
| RunStepService | apps/server/src/services/RunStepService.ts | Step lifecycle | Stage Executor | **keep** | M2 event model | Low |
| ConversationAgentRunner | packages/agent-core/src/conversationRunner.ts | Single-agent conversational run | Run Engine | **refactor** | M2 run engine | Medium — split adapter |

### Stage

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| (implicit stage in AgentRunner) | packages/agent-core/src/runner.ts | Pipeline stage execution | Run Stage | **migrate** | M2 workflow | High — no stage entity |
| (execution steps in RunStep) | apps/server/src/services/RunStepService.ts | Step tracking within run | Run Stage | **wrap** | M2 stage model | Medium |

### Runtime Event

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| AgentEvent type | packages/shared/src/types/index.ts:25-48 | Unified event type union | RuntimeEvent (v2) | **refactor** | M2 event model | Medium — add event fields |
| AgentEventDraft/AgentEvent | packages/shared/src/types/index.ts:50-66 | Event envelope | RuntimeEvent (v2) | **refactor** | M2 event model | Medium — rename + add fields |
| EventBus | apps/server/src/events/EventBus.ts | In-memory pub/sub | Event Bus (v2) | **refactor** | M2 event store | Medium |
| event sequence | agent_events table | Monotonic sequence per run | Event Sequence (v2) | **keep** | None | Low |
| SSE 'status/stage/thinking/done' | apps/server/src/routes/sse.ts | Legacy SSE event format | RuntimeEvent stream | **refactor** | M2 event model | Medium |
| RuntimeEventBuffer | apps/server/src/services/RuntimeEventBuffer.ts | Buffer runtime events | Event Buffer (v2) | **keep** | None | Low |
| RuntimeEventProjector | apps/server/src/services/RuntimeEventProjector.ts | Project events to messages | Projection (v2) | **keep** | None | Low |

### Provider Session

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| (not present) | — | No native session tracking | Provider Session | **missing** | M2 provider architecture | High — new concept |
| CliInvocationObservation | packages/shared/src/types/index.ts:586-599 | CLI invocation record | Part of Provider Session | **wrap** | M2 session model | Medium |

### Runtime Process

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| child_process.spawn | packages/agent-core/src/executor.ts:431 | Direct process spawn | Process Manager | **replace** | M2 process runtime | High — core infrastructure |
| AbortController handling | packages/agent-core/src/executor.ts:492-508 | Cancel via abort signal | Process Manager cancel | **replace** | M2 process runtime | High |
| Timeout handling | packages/agent-core/src/executor.ts:510-530 | Inline timer logic | Process Manager timeout | **replace** | M2 process runtime | High |
| Diagnostic logging | packages/agent-core/src/executor.ts:138-147 | File-based diagnostic log | Process Event + Artifact | **refactor** | M2 event model | Medium |

### Worktree

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| WorktreeLease | packages/shared/src/types/index.ts:233-247 | Worktree lease record | Worktree (v2) | **refactor** | M2 worktree runtime | Medium — rename + add fields |
| WorktreeManager | apps/server/src/services/WorktreeManager.ts | Worktree lifecycle | Worktree Manager (v2) | **refactor** | M2 worktree runtime | Medium |
| Worktree routes | apps/server/src/routes/worktrees.ts | Worktree API | Worktree API (v2) | **keep** | None | Low |
| WorktreeArtifactService | apps/server/src/services/WorktreeArtifactService.ts | Bundle tracked+untracked | Worktree Artifact (v2) | **keep** | None | Low |
| workspaceChanges.ts | packages/agent-core/src/workspaceChanges.ts | Diff workspace state | Git Runtime diff | **refactor** | M2 git runtime | Medium |

### Artifact

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| RuntimeArtifact | packages/shared/src/types/index.ts:354-369 | Artifact record | Artifact (v2) | **refactor** | M2 artifact model | Low — close to v2 |
| RuntimeArtifactService | apps/server/src/services/RuntimeArtifactService.ts | Artifact CRUD | Artifact Manager (v2) | **keep** | None | Low |
| RuntimeArtifactCollector | apps/server/src/services/RuntimeArtifactCollector.ts | Collect run artifacts | Artifact Manager (v2) | **keep** | None | Low |
| Artifact routes | apps/server/src/routes/artifacts.ts | Artifact REST API | Artifact API (v2) | **keep** | None | Low |

### Memory

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| MemoryRecord | packages/shared/src/types/index.ts:475-491 | Memory entry | Memory Entry (v2) | **refactor** | M2 memory model | Medium — add v2 fields |
| MemoryService | apps/server/src/services/MemoryService.ts | Memory CRUD | Memory Engine (v2) | **refactor** | M2 memory model | Medium |
| MemoryRetriever | apps/server/src/services/MemoryRetriever.ts | FTS5 + tag-based retrieval | Memory Retrieval (v2) | **keep** | M2 scope | Low |
| MemoryExtractor | apps/server/src/services/MemoryExtractor.ts | Generate memory from runs | Memory Extraction (v2) | **keep** | None | Low |
| MemoryCandidateService | apps/server/src/services/MemoryCandidateService.ts | Candidate management | Memory Candidate (v2) | **keep** | None | Low |
| agent-memory/ Markdown files | workspace/agent-memory/*.md | v1 memory file injection | Compatibility layer | **retire** | M2 memory migration | Medium |
| MemoryFileReader/readMemory | packages/agent-core/src/runner.ts:9-28 | Read Markdown files for prompt | (removed in v2) | **retire** | M2 memory engine | Medium |

### Policy

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| RuntimePolicy | packages/shared/src/types/index.ts:251-258 | Config-level policy | Policy Profile (v2) | **refactor** | M2 policy engine | Medium |
| runtimePolicy.ts | packages/agent-core/src/runtimePolicy.ts | Resolve policy from intent | Policy Engine (v2) | **refactor** | M2 approval | Medium |
| ToolRiskClassifier | apps/server/src/services/ToolRiskClassifier.ts | Classify tool risk | Policy Rule (v2) | **keep** | None | Low |

### Approval

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| ApprovalRegistry | apps/server/src/services/ApprovalRegistry.ts | Tool approval grants | Approval (v2) | **refactor** | M2 policy engine | Medium |
| ToolApprovalRequest | packages/shared/src/types/index.ts:304-319 | Approval request | Approval Request (v2) | **refactor** | M2 policy engine | Medium |
| ApprovalGrant | packages/shared/src/types/index.ts:321-334 | Persistent grant | Approval Grant (v2) | **refactor** | M2 policy engine | Medium |
| Approval routes | apps/server/src/routes/approvals.ts | Approval API | Approval API (v2) | **keep** | None | Low |
| ToolApprovalCard | apps/web/src/components/runs/ToolApprovalCard.tsx | Approval UI | Approval UI (v2) | **keep** | None | Low |
| ApprovalGrantPanel | apps/web/src/components/runs/ApprovalGrantPanel.tsx | Grant management UI | Approval UI (v2) | **keep** | None | Low |

### Conversation

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| Conversation | packages/shared/src/types/index.ts:155-167 | Conversation model | Conversation (v2) | **refactor** | M2 conversation model | Low — close to v2 |
| ConversationMessage | packages/shared/src/types/index.ts:199-208 | Message model | Message (v2) | **refactor** | M2 conversation model | Low — close to v2 |
| ConversationService | apps/server/src/services/ConversationService.ts | CRUD + streaming | Conversation Runtime (v2) | **keep** | M2 event model | Medium |
| Conversation routes | apps/server/src/routes/conversations.ts | REST + SSE endpoints | Conversation API (v2) | **keep** | None | Low |
| ChatPanel | apps/web/src/components/chat/ChatPanel.tsx | Chat UI | Conversation UI (v2) | **keep** | None | Low |
| ComposerControls | apps/web/src/components/chat/ComposerControls.tsx | Message input | Message Composer UI (v2) | **keep** | None | Low |
| GroupOrchestrator | apps/server/src/services/GroupOrchestrator.ts | Group conversation routing | Group Conversation (v2) | **keep** | M2 workflow | Medium |
| GroupDispatchService | apps/server/src/services/GroupDispatchService.ts | Group dispatch logic | Workflow Stage routing | **keep** | M2 workflow | Medium |

### Runtime Inspector

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| ExecutionInspector | apps/web/src/components/chat/ExecutionInspector.tsx | Right sidebar event viewer | Runtime Inspector (v2) | **keep** | M2 event model | Low |
| RunDetails | apps/web/src/components/runs/RunDetails.tsx | Full run detail modal | Run Inspector (v2) | **keep** | M2 event model | Low |
| RunDecisionCard | apps/web/src/components/runs/RunDecisionCard.tsx | Pending decision UI | Approval/Action UI (v2) | **keep** | None | Low |

### Storage

| Current Component | Current File | Current Responsibility | Target v2 Component | Decision | Migration Dependency | Risk |
|---|---|---|---|---|---|---|
| SqliteStore | apps/server/src/store/SqliteStore.ts | SQLite persistence layer | Storage (v2) | **refactor** | M2 data model | High — schema migration |
| JsonFileStore | apps/server/src/store/JsonFileStore.ts | JSON fallback | (retire in v2) | **retire** | M2 storage | Low |
| Store interface | apps/server/src/store/Store.ts | Generic store contract | Repository interfaces (v2) | **refactor** | M2 storage | Medium |
| RuntimeStorageService | apps/server/src/services/RuntimeStorageService.ts | Workspace file access | Path Policy (v2) | **keep** | None | Low |

### UI Components

| Current Component | Current File | Target v2 Component | Decision | Risk |
|---|---|---|---|---|
| WorkspaceLayout | apps/web/src/components/layout/WorkspaceLayout.tsx | App Shell (v2) | **keep** | Low |
| WorkspaceList | apps/web/src/components/workspace/WorkspaceList.tsx | Workspace list UI | **keep** | Low |
| NewWorkspaceModal | apps/web/src/components/workspace/NewWorkspaceModal.tsx | Workspace creation UI | **keep** | Low |
| ConversationHistory | apps/web/src/components/chat/ConversationHistory.tsx | Conversation list UI | **keep** | Low |
| VirtualMessageList | apps/web/src/components/chat/VirtualMessageList.tsx | Message list UI | **keep** | Low |
| MarkdownMessage | apps/web/src/components/chat/MarkdownMessage.tsx | Markdown renderer | **keep** | Low |
| MemoryPanel | apps/web/src/components/memory/MemoryPanel.tsx | Memory UI | **keep** | Low |
| MemoryList | apps/web/src/components/memory/MemoryList.tsx | Memory list UI | **keep** | Low |
| MemoryEditor | apps/web/src/components/memory/MemoryEditor.tsx | Memory edit UI | **keep** | Low |
| MemoryCandidateQueue | apps/web/src/components/memory/MemoryCandidateQueue.tsx | Memory review UI | **keep** | Low |
| PreferencePanel | apps/web/src/components/preference/PreferencePanel.tsx | Preference UI | **keep** | Low |
| ArtifactShelf | apps/web/src/components/runs/ArtifactShelf.tsx | Artifact viewer | **keep** | Low |
| ArtifactPreviewDialog | apps/web/src/components/runs/ArtifactPreviewDialog.tsx | Artifact preview | **keep** | Low |
| RunTaskTree | apps/web/src/components/runs/RunTaskTree.tsx | Run step tree | **keep** | Low |
| ExecutionArchive | apps/web/src/components/runs/ExecutionArchive.tsx | Execution history | **keep** | Low |
| DiffBlock | apps/web/src/components/chat/DiffBlock.tsx | Inline diff viewer | **keep** | Low |
| ThemeProvider/ThemeToggle | apps/web/src/components/theme/* | Theme system | **keep** | Low |
| ToastStack | apps/web/src/components/feedback/ToastStack.tsx | Toast notifications | **keep** | Low |
| GroupCreator/GroupEditor | apps/web/src/components/chat/* | Group conversation UI | **keep** | Low |
| MentionPicker | apps/web/src/components/chat/MentionPicker.tsx | Agent mention | **keep** | Low |

### Client Libraries

| Current Component | Current File | Target v2 Component | Decision | Risk |
|---|---|---|---|---|
| useApi | apps/web/src/lib/useApi.ts | API Client (v2) | **keep** | Low |
| useWorkspace | apps/web/src/lib/useWorkspace.ts | Workspace hooks (v2) | **keep** | Low |
| useTask | apps/web/src/lib/useTask.ts | (retire in v2) | **retire** | Low — replaced by Run |
| SSE libs | apps/web/src/lib/sse.ts, streamReconnect.ts | SSE Client (v2) | **keep** | Low |
| conversationActions | apps/web/src/lib/conversationActions.ts | Conversation hooks (v2) | **keep** | Low |
| runSteps | apps/web/src/lib/runSteps.ts | Run step helpers (v2) | **keep** | Low |
| executionInspector | apps/web/src/lib/executionInspector.ts | Inspector helpers (v2) | **keep** | Low |
| executionTimeline | apps/web/src/lib/executionTimeline.ts | Timeline helpers (v2) | **refactor** | Medium — adapt to v2 event model |
| runDetails | apps/web/src/lib/runDetails.ts | Run detail helpers (v2) | **keep** | Low |
| memories | apps/web/src/lib/memories.ts | Memory API helpers (v2) | **keep** | Low |
| preferences | apps/web/src/lib/preferences.ts | Preference API helpers (v2) | **keep** | Low |
| artifacts | apps/web/src/lib/artifacts.ts | Artifact API helpers (v2) | **keep** | Low |
| typewriterQueue | apps/web/src/lib/typewriterQueue.ts | Streaming render (v2) | **keep** | Low |
| agentPresence | apps/web/src/lib/agentPresence.ts | Presence helpers (v2) | **keep** | Low |
