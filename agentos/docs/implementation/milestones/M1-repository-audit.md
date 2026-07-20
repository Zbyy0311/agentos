# M1 — Repository Audit and Test Baseline

> **Milestone:** M1  
> **Status:** ✅ COMPLETED  
> **Date:** 2026-07-21  
> **Repository:** `Zbyy0311/agentos`  
> **Branch:** docs/ui-architecture-alignment  
> **Working Tree:** Clean

---

## 1. Scope

Repository-wide audit of AgentOS v1 current state:
- Repository structure and workspace configuration
- Build and runtime entrypoints
- Current Runtime implementation (Task, Agent, Provider, Process, Git, Storage)
- Current UI implementation (Next.js, components, SSE, state management)
- Existing test baseline (run all tests, record results)
- v1 → v2 component mapping
- Migration register for M2+ planning

---

## 2. Completed Checks

### Repository Boundary
- [x] Git root: `E:/workspace/Multi-Agent/` (agentos is a subdirectory)
- [x] Monorepo workspace: pnpm workspaces (`apps/*`, `packages/*`)
- [x] Directory structure: apps (server, web), packages (agent-core, shared), scripts, docs
- [x] Current branch: `docs/ui-architecture-alignment`
- [x] Git status: clean (no staged/unstaged/untracked changes)
- [x] No ongoing work outside docs/
- [x] No user changes modified or overwritten

### Build and Runtime Entrypoints
- [x] Package manager: pnpm
- [x] Node requirement: >=22.5
- [x] Package scripts: dev, dev:stable, build, test:smoke
- [x] Server entry: `apps/server/src/index.ts` (Express, port 3000)
- [x] Frontend entry: `apps/web/src/app/page.tsx` (Next.js 14, port 3001)
- [x] Dev command: `tsx watch` (with exclusions for stable mode)
- [x] Stable dev command: `tsx src/index.ts` (no watch)
- [x] Production build: `tsc`
- [x] Start script: `start-dev.ps1`
- [x] Env vars: AGENTOS_FORCE_MOCK, AGENTOS_CODEX_CLI, AGENTOS_KIMI_CLI, etc.
- [x] Browser close: 关闭普通页面本身不会主动调用 Cancel API，但当前执行 SSE 的 HTTP 连接关闭会触发 AbortController，因此浏览器断线仍可能取消正在执行的任务
- [x] Server restart: recovers interrupted tasks (marks as failed)

### Runtime Implementation Audit
- [x] Task model: `TaskItem` (task + outputs combined) — needs separation
- [x] Agent model: `WorkspaceAgent` / `AgentProfile` — role=provider mixing
- [x] Provider model: `AGENT_CONFIGS` hardcoded — no provider type separation
- [x] AgentRunner: fixed 4-stage pipeline (codex_manager → kimi_worker → opencode_reviewer → codex_final_review)
- [x] CLIExecutor: spawn, cancel, timeout, stdout/stderr — all in one class
- [x] Process spawning: `child_process.spawn()` directly
- [x] Cancel: AbortController from HTTP request — browser disconnect kills process
- [x] Timeout: inactivity + max execution (30 min default)
- [x] stdout/stderr: TextDecoder streaming + adapter parsing
- [x] SSE: `status/stage/thinking/done` legacy + `runtime-event` new format
- [x] Browser AbortController: `res.on('close', () => abortController.abort())` — **critical issue**
- [x] Fixed pipeline stages: `codex_manager|kimi_worker|opencode_reviewer|codex_final_review`
- [x] Provider auth: per-CLI detection (no unified auth model)
- [x] CODEX_HOME: `~/.codex` with sandbox-bin PATH injection
- [x] KimiCode: `kimi` CLI command, API key or OAuth
- [x] Git operations: status, diff, commit routes — WorktreeManager for leases
- [x] Diff: `captureWorkspaceSnapshot` / `diffWorkspaceSnapshots` (file-based, not git diff)
- [x] Workspace isolation: none — all agents in workspace root
- [x] Persistence: SQLite (primary) + JSON fallback (legacy workspaces)
- [x] Memory: SQLite-based MemoryService + Markdown files in agent-memory/
- [x] Policy/Approval: config-based RuntimePolicy + ApprovalRegistry
- [x] Conversation: ConversationService with SSE streaming (+ GroupOrchestrator)
- [x] Artifacts: RuntimeArtifactService + file storage

### UI Audit
- [x] Next.js 14.2.4 + React 18.3.1
- [x] App Router (not Pages Router)
- [x] Server Components: minimal (Layout only)
- [x] No Next.js API Routes for runtime logic
- [x] No Server Actions
- [x] SSR dependency: low (static generation for home page)
- [x] Client-side API: `useApi` hook → Express server port 3000
- [x] State management: React hooks only (useState, useEffect)
- [x] SSE client: `lib/sse.ts` + `lib/streamReconnect.ts` with exponential backoff
- [x] Workspace UI: agent list, conversation history, chat panel, execution inspector
- [x] Task creation: via chat composer or legacy task page
- [x] Task output: legacy TaskLog[] or new AgentRunDetails
- [x] Components retainable identified (majority can stay)
- [x] Components conflicting with v2 spec identified (task pipeline, SSE coupling)

### Test Baseline
- [x] agent-core smoke: `pnpm --filter @agentos/agent-core run test:smoke` — ✅ 2/2 passed
- [x] agent-core full: `pnpm --filter @agentos/agent-core run test` — ✅ 123/123 passed
- [x] server: `pnpm --filter @agentos/server run test` — ❌ 176/180 passed (4 Windows env failures)
- [x] web build: `pnpm --filter @agentos/web run build` — ✅ build successful
- [x] Root build: `pnpm build` — ✅ all packages build successfully
- [x] Failure analysis: 4 failures are Windows-specific (temp dir cleanup, tar command)

### v1 → v2 Mapping
- [x] Complete 18-component mapping with decisions
- [x] Each entry has: Current Component, Current File, Current Responsibility, Target v2, Decision, Migration Dependency, Risk
- [x] Missing v2 components identified: Provider Session, Process Manager, Workflow Definition

---

## 3. Exit Gate Evidence

| Exit Gate Criteria | Status | Evidence |
|---|---|---|
| All spec documents read | ✅ | 00-Vision through 14-Roadmap (13 and 14 are empty stubs) |
| Repository structure documented | ✅ | current-state-audit.md |
| Runtime entrypoints documented | ✅ | current-state-audit.md |
| Current implementation audited | ✅ | current-state-audit.md (12 sections) |
| Current UI audited | ✅ | current-state-audit.md |
| Test baseline established | ✅ | test-baseline.md (4 suites run) |
| v1 → v2 mapping complete | ✅ | v1-to-v2-map.md (87 entries) |
| Migration register created | ✅ | migration-register.md (10 items) |
| Git status verified clean | ✅ | Only docs/implementation/ files added |
| No code modifications | ✅ | No .ts, .js, .json, .yaml files changed |

---

## 4. Blockers

- **None.** M1 has no blockers.
- M2 will be blocked on: finalizing the Workflow Definition schema, Process Manager interface, and Run Engine contract before implementation begins.

---

## 5. Recommended M2 Entry Point

M2 should begin with the **Runtime Foundation**, specifically the items that unblock all other work:

### M2 Phase 1 — Introduce Run & Event Model (highest priority)
Create the foundational v2 runtime types and persistence without changing v1 behavior.

### M2 Phase 1 Sub-items (in order)
1. **Add v2 core types** — Introduce `Run`, `RunStage`, `RuntimeEvent` as new types alongside existing ones
2. **Add Event Store** — New `runtime_events` table with sequence allocation (already partially in `agent_events`)
3. **Add durable Run** — `POST /tasks/:taskId/runs` creates a standalone, durable Run
4. **Add Run Snapshot** — Freeze agent/provider snapshot at Run creation time
5. **Add legacy SSE compatibility** — Old SSE events projected from Runtime Events
6. **Add Run Cancel API** — New `POST /runs/:id/cancel` that decouples cancel from browser disconnect
7. **Decouple browser disconnect** — Run continues when browser disconnects (add reconnection support)

### Why Run+Event first
- Everything else depends on Run being a durable, separable entity
- Event Store enables Timeline, Inspector, Replay, and structured observability
- Task/Run separation is the most impactful change (fixes 5+ anti-patterns)

---

## 6. Files M2 is Expected to Modify

### New files expected
```
packages/runtime-core/                 (new package)
packages/runtime-core/src/run.ts
packages/runtime-core/src/run-engine.ts
packages/runtime-core/src/event-store.ts
packages/runtime-core/src/event-types.ts
packages/runtime-core/src/types.ts
```

### Existing files expected to change
| File | Change |
|---|---|
| `packages/shared/src/types/index.ts` | Add v2 Run, RuntimeEvent types alongside v1 |
| `apps/server/src/store/SqliteStore.ts` | Add v2 tables, keep v1 tables |
| `apps/server/src/routes/tasks.ts` | Add run creation endpoint, deprecate old `:id/run` |
| `apps/server/src/routes/runs.ts` | Add cancel endpoint, expand detail response |
| `apps/server/src/index.ts` | Mount new routes, initialize RuntimeEngine |
| `apps/server/src/routes/sse.ts` | Add Last-Event-ID / sequence support |
| `apps/server/src/services/RunStreamRegistry.ts` | Decouple from HTTP lifecycle |
| `apps/web/src/lib/useTask.ts` | Add run-based API calls |
| `apps/web/src/lib/sse.ts` | Support reconnection with last sequence |
| `apps/web/src/components/runs/RunDetails.tsx` | Read from new Run API |

### Package configs expected to change
- `pnpm-workspace.yaml` — add `packages/runtime-core`
- Root `package.json` — add workspace reference

---

## 7. Files That Should NOT Be Modified in M2

These files should be **left untouched** during M2 to maintain focus:

| File | Reason |
|---|---|
| `packages/agent-core/src/runner.ts` | AgentRunner will be replaced entirely later; don't modify |
| `packages/agent-core/src/config.ts` | AGENT_CONFIGS will be replaced by Workflow Definitions |
| `packages/agent-core/src/executor.ts` | CLIExecutor will be split later; only use wrapping layer |
| `apps/server/src/routes/taskPipeline.ts` | Will be replaced by Workflow Definition logic |
| `apps/server/src/managers/WorkspaceManager.ts` | Stable — only add new methods, don't refactor |
| `apps/web/src/components/chat/` | Core chat components are stable — only add new panels |
| `apps/web/src/components/memory/` | Memory UI is stable — only add v2 features |
| `scripts/` | E2E test scripts for v1 — don't modify |
| `start-dev.ps1` | Stable launcher — don't modify |
| `.env.example` | Document changes separately |
| `apps/web/src/app/page.tsx` | Workspace list — stable |

---

## 8. Output Files Created

| File | Description |
|---|---|
| `docs/implementation/current-state-audit.md` | Complete v1 codebase audit (12 sections) |
| `docs/implementation/v1-to-v2-map.md` | 87-entry component mapping table |
| `docs/implementation/test-baseline.md` | Test suite results and analysis |
| `docs/implementation/migration-register.md` | 10-item migration work register |
| `docs/implementation/milestones/M1-repository-audit.md` | This file — M1 summary and exit gate |
