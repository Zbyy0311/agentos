# AgentOS v1 Current State Audit

> Date: 2026-07-21  
> Scope: Repository Audit and Test Baseline (M1)  
> Repository: `Zbyy0311/agentos`  
> Branch: HEAD (detached / no active branch changes)  
> Status: Clean working tree

---

## 1. Repository Structure

### Git Root
`E:\workspace\Multi-Agent\agentos`

### Project Root
`E:\workspace\Multi-Agent\agentos`

### Monorepo Workspace
- **Package Manager:** pnpm (v9+ inferred from pnpm-lock.yaml)
- **Workspace Config:** `pnpm-workspace.yaml`
  - packages: `apps/*`, `packages/*`
  - allowBuilds: esbuild

### Top-Level Layout
```
├── apps/
│   ├── server/     @agentos/server    Express HTTP server + SQLite persistence
│   └── web/        @agentos/web       Next.js 14 frontend
├── packages/
│   ├── agent-core/ @agentos/agent-core Agent runner, CLI executors, adapters
│   └── shared/     @agentos/shared     Type definitions and DTOs
├── scripts/        E2E and integration test scripts (fixtures, smoke tests)
├── docs/
│   ├── Runtime-Specification/   v2 architecture specs (00–14)
│   └── implementation/          (newly created in M1)
├── .agentos/        Local runtime data directory (excluded from git)
├── agent-memory/    Memory files (Markdown-based, kept under git)
├── workspace/       Demo project workspace (partially excluded)
├── .claude/         Claude Code agent configurations
├── .agents/         Agent definitions
├── .codex/.mimocode/.reasonix/.superpowers/.playwright-cli  CLI provider config dirs
├── start-dev.ps1    Windows dev startup script
└── README.md        Project documentation
```

### Current Branch
- HEAD (no active feature branch, detached state)

### Staged/Unstaged/Untracked
- Clean — no staged, unstaged, or untracked changes outside `/docs/implementation/`

---

## 2. Build and Runtime Entrypoints

### Package Manager
- **pnpm** — all scripts use `pnpm` commands

### Node Version
- Required: `>=22.5` (from root `package.json`)

### Key Package Scripts

| Script | Command | Purpose |
|---|---|---|
| `dev` | `pnpm --parallel -r run dev` | Run all packages in dev mode |
| `dev:stable` | `pnpm --filter @agentos/server run dev:stable` | Server without file-watch |
| `build` | `pnpm -r run build` | Full monorepo build |
| `test:smoke` | `pnpm --filter @agentos/agent-core run test:smoke` | Smoke test for agent-core |

### Server Entry
- **File:** `apps/server/src/index.ts`
- **Runtime:** Express on port 3000 (configurable via `PORT` env, default 3000)
- **Dev Command:** `tsx watch --exclude "workspace/**" --exclude ".agentos/**" --exclude "agent-memory/**" src/index.ts`
- **Stable Dev:** `tsx src/index.ts` (no watch)
- **Production:** `node dist/index.js`

### Frontend Entry
- **File:** `apps/web/src/app/page.tsx`
- **Runtime:** Next.js 14 App Router on port 3001
- **Dev Command:** `next dev --port 3001`

### Server Restart Behavior
- Development: `tsx watch` restarts on file changes (excluded dirs: workspace/, .agentos/, agent-memory/)
- Stable: no file watch; manual restart required
- On start: recovers interrupted tasks and runs (marks them as failed)
- WorktreeManager.reconcile() runs on startup

### Ports
| Service | Default Port | Notes |
|---|---|---|
| Server (Express) | 3000 | API backend |
| Web (Next.js) | 3001 | Frontend dev server |

### Environment Variables
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Server port |
| `AGENTOS_SERVER_HOST` | 127.0.0.1 | Server bind host |
| `AGENTOS_WEB_ORIGINS` | http://localhost:3001 | CORS allowed origins |
| `AGENTOS_ALLOW_REMOTE` | false | Allow non-loopback bind |
| `AGENTOS_FORCE_MOCK` | (unset) | Force mock mode for all CLI |
| `AGENTOS_CODEX_CLI` | codex | Codex CLI command |
| `AGENTOS_KIMI_CLI` | kimi | Kimi CLI command |
| `AGENTOS_OPENCODE_CLI` | opencode | OpenCode CLI command |
| `AGENTOS_KIMI_MODEL` | kimi-code/kimi-for-coding | Default Kimi model |
| `AGENTOS_OPENCODE_MODEL` | (varies) | Default OpenCode model |
| `AGENTOS_KIMI_API_KEY` | (unset) | Kimi API key (bypasses OAuth) |
| `AGENTOS_MAX_EXECUTION_MS` | 1800000 (30 min) | Max execution timeout |
| `AGENTOS_AGENT_TIMEOUT` | (unset) | Inactivity timeout |
| `AGENTOS_KIMI_CODE_HOME` | .agentos/kimi-code | Kimi sandbox home |
| `AGENTOS_WORKTREE_ROOT` | .agentos/worktrees | Worktree storage root |

### Windows Startup Script
- **File:** `start-dev.ps1`
- Steps:
  1. Loads `.env` if present
  2. Sets `AGENTOS_FORCE_MOCK=true` if `-Mock` flag
  3. Configures host/origins defaults
  4. Kills any existing process on ports 3000/3001
  5. Starts server via `pnpm --filter @agentos/server run dev` (or dev:stable if `-Stable`)
  6. Starts web via `pnpm --filter @agentos/web run dev`
- Browser close does NOT affect Run execution (server continues independently)

---

## 3. Current Runtime Implementation

### Task Model
- **Type:** `TaskItem` (packages/shared/src/types/index.ts)
- **Fields:** id, workspaceId, title, status, currentAgent, outputs (TaskLog[]), error, reviewDecision, reviewBlocked, timestamps
- **Statuses:** pending, running, reviewing, completed, failed, cancelled
- **Storage:** JSON in `SqliteStore.sqlite` (tasks table)
- **Key Problem:** Task stores outputs directly — Task == execution, no separation between Task and Run

### Agent Model
- **Type:** `WorkspaceAgent` / `AgentProfile`
- **Agent Config:** name, role, provider, cliCommand, cliArgs, model, thinkingEffort
- **Role-Provider Mixing:** `STAGE_ROLE_MAP` maps `codex_manager` → `codex`, `kimi_worker` → `kimi`, etc.
- **Default Agents:** `DEFAULT_WORKSPACE_AGENTS` (codex, kimi, opencode) with hardcoded CLI args
- **Agent Profile:** Stored in `agent_profiles` SQLite table with permissions and role title

### Provider Model
- **Provider Resolution:** `resolveConfiguredProvider()` infers from role or CLI command
- **CLI Adapters:** CodexAdapter, KimiAdapter, PlainTextAdapter, AgentCliAdapterRegistry
- **Key Issue:** KimiCode is configured with `kimi` CLI but `AGENT_CONFIGS.kimi_worker` uses `-m kimi-code/kimi-for-coding` — the `kimi` CLI may be a Kimi adapter NOT OpenCode, but the role-based config doesn't enforce this
- **Key Issue:** When `AGENTOS_OPENCODE_CLI === AGENTOS_CODEX_CLI`, OpenCode acts as Codex fallback with identical CLI args

### AgentRunner
- **File:** `packages/agent-core/src/runner.ts`
- **Method:** `runFullPipeline()` — executes four fixed stages sequentially
- **Stage Order:**
  1. `codex_manager`
  2. `kimi_worker`
  3. `opencode_reviewer`
  4. `codex_final_review`
- **Memory Injection:** Reads Markdown files from `workspaceRoot/agent-memory/` per stage
- **Pipeline Decision Logic:** In `taskPipeline.ts` — parses structured output from each stage

### CLIExecutor
- **File:** `packages/agent-core/src/executor.ts`
- **Method:** `CLIExecutor.execute()`
- **Process Spawn:** Uses `child_process.spawn()` directly
- **Abort Handling:** AbortController from HTTP request
- **Timeout:** Inactivity timeout (configurable) + max execution timeout (30 min default)
- **Output:** stdout → chunk callback + runtime event + TaskLog
- **Windows Handling:** Special batch script wrapper for `.cmd`/`.bat` files
- **KimiCode Home:** Copies config from `~/.kimi-code` to workspace-local sandbox

### Process Spawning
- **Direct spawn:** `child_process.spawn()` in CLIExecutor
- **No Process Manager layer** — Process records are NOT persisted as `RuntimeProcess` entities
- **Process Tree:** Windows uses `child.kill()` only (no Job Object); POSIX sends SIGTERM then SIGKILL fallback
- **Cancel semantics:** AbortSignal from incoming HTTP request → process kill — **browser disconnect cancels the process**

### Idle Timeout
- Tracks `lastActivityAt` from stdout/stderr
- Polls at min(25ms, inactivityTimeout/1000) intervals
- Kills process and marks as inactivity_timeout
- **Problem:** No exclusion for approval-waiting state

### SSE Implementation
- **File:** `apps/server/src/routes/sse.ts`
- **Legacy format:** `event: status`, `event: stage`, `event: thinking`, `event: done`
- **Newer events:** `runtime-event` type with AgentEvent envelope
- **Dual system:** Both legacy SSE events and new RuntimeEvent events coexist
- **Heartbeat:** `startSseHeartbeat()` sends periodic comments
- **Reconnection:** `streamReconnect.ts` with exponential backoff

### Browser AbortController
- **File:** `apps/server/src/routes/tasks.ts:236-240`
- `res.on('close', () => abortController.abort())` — **browser disconnect cancels execution**
- This is explicitly listed as a v1 anti-pattern in the v2 spec

### Fixed Pipeline Stages
- **Type:** `AgentStage` = `'codex_manager' | 'kimi_worker' | 'opencode_reviewer' | 'codex_final_review'`
- Hardcoded in `AGENT_CONFIGS`, `STAGE_ROLE_MAP`
- Pipeline logic in `tasks.ts` orchestrates exactly this sequence
- **Anti-pattern per v2 spec:** stages should be data defined by Workflow Definition

### Provider Authentication
- Codex: checks `AGENTOS_CODEX_CLI` env var, probes via `codex --version`
- KimiCode: detects between API key mode and OAuth mode
- OpenCode: reads usage snapshots from config
- **No unified provider authentication model**

### CODEX_HOME Resolution
- In `resolveAgentEnvironment()`: sets `CODEX_HOME` to `~/.codex` when Codex CLI is used
- Adds `.sandbox-bin` to PATH

### KimiCode Executable Resolution
- Priority: env var `AGENTOS_KIMI_CLI` → PATH `kimi` → `kimi` command
- Default CLI command: `kimi`
- API key bypass: sets env vars `KIMI_MODEL_NAME`, `KIMI_MODEL_API_KEY`, etc.

### Git Operations
- **Routes:** `routes/git.ts` — git status, diff, commit operations
- **Worktree Manager:** `services/WorktreeManager.ts` — worktree lease lifecycle
- **Git Client:** Direct git command execution (not through Process Manager)
- **Diff:** `workspaceChanges.ts` captures and diffs workspace state

### JSON / File Persistence
- **Primary Store:** `SqliteStore` (SQLite via `node:sqlite`)
- **Legacy Fallback:** `JsonFileStore` (JSON file-based storage)
- **Store Interface:** Minimal CRUD interface in `Store.ts`
- **Workspace Data:** Workspaces stored in JSON file (`~/.agentos/workspaces.json` inferred)
- **Task Data:** Tasks table in SQLite
- **Run, Event, Execution, Artifact, Memory, Preference Data:** All in SQLite

### Memory Handling
- **v1 Memory Files:** Markdown files in `agent-memory/` directory
- **Memory Types:** PROJECT.md, TASKS.md, DECISIONS.md, KNOWLEDGE.md, REVIEW.md, TEST.md
- **Memory Injection:** `AgentRunner.readMemory()` reads files and injects into prompt per stage
- **Memory Service (v2-like):** `MemoryService`, `MemoryRetriever`, `MemoryExtractor` — SQLite-based
- **Memory Candidates:** Generated from runs, reviewed by user
- **Memory Budget:** Configurable `maxCharacters` per retrieval

### Policy / Approval Handling
- **RuntimePolicy:** Resolved from run intent; includes `workspaceWrite`, `networkPolicy`, `toolPolicy`
- **ToolRiskClassifier:** Classifies tool call risk levels
- **ApprovalRegistry:** Stores tool approval grants
- **ToolApprovalCard UI:** Frontend component for approval requests
- **Approval Routes:** `routes/approvals.ts`
- **Policy (v2 spec):** Not yet implemented as a Policy Engine; current policy is config-driven

### Conversation / Chat Implementation
- **Conversation Types:** direct, group
- **ConversationService:** CRUD for conversations, messages, execution streaming
- **GroupOrchestrator:** Multi-agent group conversation dispatch
- **Streaming:** SSE-based real-time conversation streaming
- **Message Types:** text, with system/agent/user senders
- **Agent Presence:** `AgentPresenceService` tracks agent state

### Artifacts and Logs
- **RuntimeArtifactService:** Manages artifact CRUD and file storage
- **Artifact Types:** file, diff, report, image, log, archive, manifest
- **Task Logs:** Written to `.agentos/logs/{taskId}/{stage}.log` (metadata only, no CLI output content)
- **Diagnostic Logs:** Written to `.agentos/logs/diagnostics/server-{instanceId}.log`

---

## 4. Current UI

### Framework
- **Next.js 14.2.4** with App Router
- **React 18.3.1**
- **Tailwind CSS 3.4.4**

### App Router Usage
- `app/layout.tsx` — Root layout with theme provider
- `app/page.tsx` — Home/workspace selection (Client Component)
- `app/workspace/[id]/page.tsx` — Main workspace UI (Client Component)

### Server Components Usage
- Minimal — most pages are `'use client'`
- Layout is a server component wrapping ThemeProvider

### Next API Routes
- No Next.js API routes used for runtime logic (all API goes to Express server)

### Server Actions
- Not used

### SSR Dependency
- Low — core pages are client-side with static generation
- Build output confirms: Home is static (`○`), workspace is dynamic (`ƒ`)

### Client-Side API
- `useApi` hook with configurable `API_BASE`
- `useWorkspace` hook for workspace CRUD
- `useTask` hook for legacy pipeline tasks
- Direct fetch calls to Express server at port 3000

### State Management
- React hooks (useState, useEffect) — no external state management library
- Custom hooks for domain state (conversations, runs, memories)

### SSE Client
- `lib/sse.ts` — SSE consumption utilities
- `lib/streamReconnect.ts` — Exponential backoff reconnection
- `lib/streamDoneExecution.ts` — Detect run completion from stream
- `lib/typewriterQueue.ts` — Character-by-character streaming render

### Current Workspace UI
- `/workspace/[id]` page with:
  - Agent sidebar list with presence indicators
  - Conversation history panel
  - Chat panel with message composer
  - Execution Inspector (right sidebar)
  - Agent Editor modal
  - Group Creator/Editor modals
  - Memory panel
  - Preference panel
  - Run Details panel
  - Artifact shelf
  - Tool Approval Card

### Task Creation Flow
1. User types message in chat composer
2. Selects run intent (ask/execute/review)
3. Message creates a Run via SSE stream
4. Run executes agent and streams events back
5. Legacy path: POST `/tasks` → POST `/tasks/:id/run` creates SSE connection

### Task Output View
- Legacy: Task page shows TaskLog[]
- Run-based: AgentRunDetails with executions, events, CLI invocations, artifacts

### Components to Retain (per v2 spec)
- WorkspaceLayout, WorkspaceList, NewWorkspaceModal
- ChatPanel, ConversationHistory, VirtualMessageList, MarkdownMessage
- AgentList, AgentEditor
- MemoryPanel, MemoryList, MemoryEditor, MemoryCandidateQueue
- PreferencePanel
- ArtifactShelf, ArtifactPreviewDialog
- RunDetails, ExecutionInspector, RunTaskTree
- ToolApprovalCard, ApprovalGrantPanel
- ThemeProvider, ThemeToggle

### Components That Conflict with v2 Spec
- `useTask.ts` — ties to legacy TaskItem model
- `tasks.ts` route — has SSE coupled with HTTP request lifecycle
- Task model in shared types — `TaskItem.outputs: TaskLog[]` violates v2 Task/Run separation
- `AGENT_CONFIGS` fixed pipeline — violates v2 Workflow Definition model
- SSE `status/stage/thinking/done` events — should be `runtime-event` based
- Browser disconnect cancels Run — violates v2 lifecycle invariant

---

## 5. Current Execution Flow (v1 Pipeline)

```
User Message
    ↓
POST /tasks/:taskId/run
    ↓
HTTP 200 with SSE response
    ↓
AgentRunner.runFullPipeline()
    ↓
  Stage 1: codex_manager
    CLIExecutor.execute() → Codex CLI → TaskLog
    ↓
  Stage 2: kimi_worker
    CLIExecutor.execute() → Kimi CLI → TaskLog
    ↓
  Stage 3: opencode_reviewer
    CLIExecutor.execute() → OpenCode CLI → TaskLog
    ↓
  Stage 4: codex_final_review
    CLIExecutor.execute() → Codex CLI → TaskLog
    ↓
applyFinalReviewDecision()
    ↓
Task outputs stored, SSE done event sent
```

### Conversation-Based Execution Flow (v2-like)

```
User sends message in conversation
    ↓
POST /conversations/:id/messages
    ↓
Run created (agent_runs table)
    ↓
ConversationAgentRunner runs single agent
    ↓
Execution created (executions table)
    ↓
CLIExecutor.execute() with conversation prompt
    ↓
Runtime Events emitted and persisted
    ↓
Run completes, message persisted
```

---

## 6. Current Persistence

### SQLite Database
- Location: `.agentos/agentos.sqlite` (inferred)
- Tables:
  - agent_profiles, conversations, conversation_members, messages, message_attachments
  - executions, agent_runs, run_steps, execution_events, agent_events, run_event_sequences
  - run_cli_invocations, run_file_changes, run_decisions
  - runtime_artifacts, memories, memory_sources, run_memory_usage, memory_candidates
  - user_profiles, preference_evidence, preference_projections, preference_projection_evidence, preference_applications

### JSON File (Legacy)
- Workspace metadata stored in JSON files
- `JsonFileStore.ts` implements Store interface

### Markdown Files
- `agent-memory/*.md` — memory files (read by AgentRunner for prompt injection)
- `.agentos/logs/*` — task logs

---

## 7. Current Process Handling

### Spawn
- `child_process.spawn()` with shell=false by default
- No unified Process Manager
- No process tree management
- Windows Job Object NOT used

### Cancel
- AbortController from HTTP `res.on('close')`
- `child.kill()` on Windows; `child.kill('SIGTERM')` then `child.kill('SIGKILL')` on POSIX
- **Problem:** Cancel == browser disconnect (no explicit Cancel API)

### Timeout
- Inactivity timeout: poll-based, configurable
- Max execution timeout: 30 min default, configurable
- **Problem:** No approval timeout distinction

### stdout/stderr
- TextDecoder streaming
- Runtime event parsing (adapter patterns)
- Raw output NOT persisted as artifact

---

## 8. Current Git Handling

### Git Status
- Basic git status/diff routes exist
- WorkspaceManager tracks gitEnabled flag

### Worktree
- `WorktreeManager` — manages worktree leases
- `WorktreeManager.reconcile()` — startup reconciliation
- Worktree leases in SQLite (worktree_leases table — legacy naming)
- Routes for worktree operations (create, inspect, commit, clean)

### Diff
- `workspaceChanges.ts` — snapshot-based diff
- `diffWorkspaceSnapshots()` — compares before/after file states
- Not using git diff for this

---

## 9. Current Provider Handling

### CLI Providers
| Provider | CLI Command | Adapter | Config |
|---|---|---|---|
| Codex | codex | CodexAdapter | AGENT_CONFIGS.codex_manager |
| Kimi | kimi | KimiAdapter | AGENT_CONFIGS.kimi_worker |
| OpenCode | opencode | PlainTextAdapter/CodexAdapter | AGENT_CONFIGS.opencode_reviewer |

### Key Issues
1. **KimiCode via Kimi CLI:** The `kimi_worker` uses `kimi` command; v2 spec requires direct `kimi.exe` call
2. **OpenCode as Codex fallback:** When `AGENTOS_OPENCODE_CLI === AGENTOS_CODEX_CLI`, OpenCode uses Codex args
3. **Agent = Role = Provider:** `STAGE_ROLE_MAP` conflates agent role with provider
4. **No Provider Snapshot:** Run history does not freeze provider configuration
5. **No Provider Validation API:** No dedicated validate endpoint
6. **No Provider Registry:** Adapter resolution is done inline
7. **Process vs Provider:** Process logic and provider logic are mixed in CLIExecutor

---

## 10. Current Tests

### Test Results

| Suite | Command | Result | Passed | Failed | Skipped | Duration | Environment Dependency | Notes |
|---|---|---|---|---|---|---|---|---|
| agent-core smoke | `vitest run smoke` | ✅ PASS | 2 | 0 | 0 | 389ms | None | Mock mode forced |
| agent-core full | `vitest run` | ✅ PASS | 123 | 0 | 0 | 8.11s | None | All tests in-memory |
| server | `node --import tsx --test` | ❌ 4 FAIL | 176 | 4 | 0 | 16.7s | Git, tar | See failure details below |
| web build | `next build` | ✅ PASS | — | — | — | ~60s | None | |

### Server Test Failures
1. **`worktrees.test.ts:1`** — `ENOTEMPTY` cleanup race in temp directory (Windows-specific)
2. **`worktrees.test.ts:2`** — `ENOTEMPTY` cleanup race (same cause)
3. **`ConversationService.test.ts`** — `ENOTEMPTY` in temp directory cleanup
4. **`WorktreeArtifactService.test.ts`** — `tar` command fails on Windows (path separator issue)

All 4 failures are **Windows environment issues** (temp dir cleanup race / tar cmd), not runtime logic bugs.

---

## 11. Known Risks

1. **Browser disconnect cancels execution** — Most critical v1 issue. Loss of HTTP connection kills the running agent process.
2. **Task == Run** — TaskItem stores outputs directly. Cannot distinguish intent from execution attempt.
3. **No durable Run** — Run is tied to HTTP request lifecycle, not persisted as independent entity.
4. **Fixed four-stage pipeline** — Cannot be configured or extended. All executions follow same pattern.
5. **Stdout as UI protocol** — UI renders 'thinking' events directly; no structured event model for Timeline.
6. **No Process Manager** — Spawn, cancel, timeout, and cleanup are ad-hoc in CLIExecutor.
7. **No Provider Session** — No native session tracking per provider invocation.
8. **No Worktree isolation** — All agents execute in workspace root (except experimental WorktreeManager).
9. **KimiCode/OpenCode ambiguity** — Provider identity depends on CLI command config, not explicit type.
10. **Memory as Markdown injection** — All memory files read into every prompt, no retrieval ranking.
11. **No Server recovery for active processes** — Active processes are lost on server restart.
12. **Windows process tree management** — `child.kill()` only kills parent; children may survive.
13. **Provider auth not unified** — Each provider handles auth differently; no unified `PROVIDER_AUTH_REQUIRED`.
14. **No Policy Engine** — Current policy is configuration + prompt guidance, not runtime enforcement.

---

## 12. Unknowns

1. **Real CLI state on this machine** — No attestation that Codex/Kimi/OpenCode CLIs are installed or authenticated
2. **SQLite file size and content volume** — Not inspected; may contain accumulated data
3. **.agentos/ directory contents** — May contain stale worktrees, artifacts, or state files
4. **agent-memory/ content quality** — Memory files exist but content quality/accuracy not assessed
5. **Workspace git state** — Individual workspace git repos may have their own states
6. **External service dependencies** — Network access for provider CLIs, API endpoints
7. **Load/crash recovery behavior** — Not tested beyond startup recovery
8. **Multi-user concurrency** — System tested single-user only
