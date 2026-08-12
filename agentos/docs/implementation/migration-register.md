# AgentOS v1 → v2 Migration Register

> Date: 2026-07-21  
> Scope: Concrete migration items from v1 to v2 architecture  
> Repository: `Zbyy0311/agentos`  
> Note: This register preserves the 2026-07-21 migration-planning baseline; its
> section-level "Current State" and priority labels are historical as of that
> date, not the repository's current completion state.
>
> Current reconciliation (2026-08-12): M3 implementation is complete through
> PR #40; formal closeout becomes COMPLETE when PR #43 merges. The PR #42 CI
> baseline at `859d8c73657741c03a3241402a9ab4c2e2f173ce` and run `31513943821`
> remain historical evidence but are superseded as the current-main baseline.
> Before PR #43 merges, authoritative main is the PR #44 R39 remediation merge at
> `e17a4bffdf12a033a0587ec2431cefe51a97bc49`; post-PR #44 main run
> `31565915572` passed. The authoritative migration registry is continuous from
> 001 through 013; Migration 014 was not required by M3 and is NOT CREATED / NOT
> AUTHORIZED. Task/Run separation and the M3 RunEngine/lifecycle foundation are
> complete. ProcessManager, ProviderAdapter, durable process/provider-session
> storage, Legacy retirement, and production cutover remain deferred post-M3
> topics. This historical register and this closeout do not authorize those
> changes. M4 ENTRY is PENDING A SEPARATE ENTRY DECISION; M4 PREPLANNING is NOT
> AUTHORIZED BY THIS CLOSEOUT.

---

## 1. JSON Data Migration

### Current State
- Workspace metadata stored in JSON files (via `JsonFileStore.ts`)
- Task data stored in SQLite via `SqliteStore`
- SQLite database at `.agentos/agentos.sqlite`

### Migration Required
1. **Migrate all JSON workspace data into SQLite** — `JsonFileStore` should be retired
2. **Verify SQLite schema completeness** against v2 Data Model (`10-Data-Model.md`)
3. **Add missing tables**: `runtime_processes`, `worktrees` (v2 schema), `provider_sessions`, `policy_profiles`, `approval_requests`, `usage_records`
4. **Retire legacy tables or columns**: `agent_runs.waiting_question`, `tasks` table merged into task/run model
5. **Add new columns to existing tables**: `run_event_sequences.next_event_sequence`, `agent_runs.parent_run_id`, `agent_runs.root_run_id`

### Risk
- Medium — SQLite schema changes may break existing data; need backward-compatible queries during transition
- Migration script needed for existing workspaces

---

## 2. Task to Task/Run Separation

### Current State
- `TaskItem` (shared types) embeds `outputs: TaskLog[]` — one task = one execution
- `TaskStatus` includes `running` which conflates task intent with execution state
- Task route `POST /tasks/:taskId/run` creates an SSE-bound execution

### Migration Steps
1. **Introduce Run as a separate entity** — `POST /tasks/:taskId/runs` creates a durable Run
2. **Add Run fields** — `parentRunId`, `rootRunId`, `reason`, snapshot support
3. **Remove `outputs` from TaskItem** — reads move to Run / Stage / Event
4. **Add Task `assignedAgentId`** — separate from execution
5. **Legacy compatibility** — old tasks API maps to new Task + latest Run

### Target
```
Task (describes intent)
└── Run 1 (first attempt)
    └── Stage
        └── Runtime Event
└── Run 2 (retry)
    └── Stage
        └── Runtime Event
```

### Risk
- High — changes core data model used by frontend, server, and storage
- Must maintain backward compatibility during transition

---

## 3. Fixed Stages to Workflow

### Current State
- `AgentStage` = `'codex_manager' | 'kimi_worker' | 'opencode_reviewer' | 'codex_final_review'`
- `AGENT_CONFIGS` hardcodes CLI args per stage
- `AgentRunner.runFullPipeline()` executes exactly these four stages sequentially
- `taskPipeline.ts` has stage-specific parsing logic

### Migration Steps
1. **Define WorkflowDefinition as a configurable template** (stages, order, agent selectors)
2. **Convert current four-stage pipeline to a built-in Workflow Template** named e.g. `"plan-implement-review"` or `"codex-kimi-review"`
3. **Remove hardcoded `AGENT_CONFIGS`** — move to Workflow stage configurations
4. **Remove `STAGE_ROLE_MAP`** — workflow defines agent/provider per stage
5. **Make RunEngine resolve workflow instead of calling fixed stages**

### Target
```
Workflow Definition:
  name: "codex-kimi-review"
  stages:
    - key: plan
      agentSelector: role=codex
    - key: implement
      agentSelector: role=kimi
    - key: review
      agentSelector: role=opencode
    - key: final-review
      agentSelector: role=codex
```

### Risk
- High — core execution logic change
- Old pipeline must continue working via compatibility layer during M2

---

## 4. stdout to Runtime Event

### Current State
- CLIExecutor collects stdout as string
- SSE emits `thinking` events with raw text chunks
- `PlainTextAdapter` creates basic events from text
- No structured event types for tool calls, file changes, commands

### Migration Steps
1. **Expand event registry** — add events for tool, file, command, subagent, usage
2. **Update adapters to emit structured events** — CodexAdapter, KimiAdapter parse JSONL into canonical events
3. **Add Event Store persistence** — persist all `runtime-event` SSE events to SQLite
4. **Remove `thinking` as core event type** — replace with `stream.text_delta`
5. **Frontend subscribes to `runtime-event` instead of `status/stage/thinking/done`**

### Target
```
provider.session_started → structured event
tool.started → structured event
file.modified → structured event
stream.text_delta → streaming text
```

### Risk
- Medium — adapters already partially parse structured output
- Raw fallback mode still uses `stream.text_delta`

---

## 5. CLIExecutor to ProcessManager / ProviderAdapter

### Current State
- `CLIExecutor.execute()` handles: command resolution, args, env, spawn, stdin, stdout, stderr, cancel, timeout, log persistence — **all in one class**
- Direct `child_process.spawn()` calls
- No Process Manager abstraction
- Process tree management is ad-hoc

### Migration Steps
1. **Extract Process Manager** — new `ProcessManager` class responsible for spawn, cancel, timeout, process tree, heartbeat
2. **Extract Launch Plan** — `ProviderLaunchPlan` describes how to start a provider
3. **Extract Stream Pipeline** — decoder, framer, artifact writer
4. **Reduce CLIExecutor to adapter logic** — validate, build launch plan, parse output
5. **Add durable RuntimeProcess records** — persist before spawn
6. **Add Windows Job Object support** — for reliable process tree cleanup

### Target
```
Provider Adapter → Process Port → Process Manager
     ↓                  ↓
  Launch Plan      Runtime Process Record
     ↓                  ↓
  Parse Output     Runtime Event
```

### Risk
- High — most critical infrastructure change
- Must refactor without breaking existing flow during transition

---

## 6. AgentRunner to RunEngine

### Current State
- `AgentRunner` orchestrates fixed 4-stage pipeline
- `ConversationAgentRunner` orchestrates single-agent conversational run
- Both use `CLIExecutor` for actual process execution

### Migration Steps
1. **Design RunEngine interface** — receives Task, resolves Workflow, schedules Stages
2. **Design StageExecutor** — launches Provider Session via Adapter, collects events
3. **Move AgentRunner pipeline to Workflow Template** — old pipeline becomes one of many workflows
4. **Move ConversationAgentRunner to Single Agent Workflow** — default workflow for conversational runs
5. **Add Run Snapshot lifecycle** — freeze agent, provider, workflow, policy snapshots
6. **Add Run Scheduler** — queue management, concurrency limits

### Target
```
RunEngine
  ├── WorkflowResolver → WorkflowDefinition
  ├── StageScheduler → StageExecutor
  ├── ProviderRegistry → ProviderAdapter
  ├── EventStore → persist
  └── ProcessManager → spawn/cancel
```

### Risk
- High — replaces core orchestration
- Old pipeline must work during transition

---

## 7. Shared Workspace to Worktree

### Current State
- All agents execute in `workspaceRoot` (shared directory)
- `WorktreeManager` exists but is experimental (worktree_leases table)
- No isolation for modifying runs
- No branch naming convention
- No merge/conflict lifecycle

### Migration Steps
1. **Make modifying Run default to Worktree isolation** — `worktreeMode = required`
2. **Retire shared workspace execution** — except for read-only runs
3. **Create isolation plan per Run** — based on workflow stage parallelism
4. **Integrate Process cwd = worktree path** — provider processes run in worktree
5. **Add branch naming convention** — `agentos/run/<runId>/<slug>`
6. **Add merge lifecycle** — review → approval → merge
7. **Add cleanup lifecycle** — worktree removal with safety checks

### Target
```
Modifying Run → Worktree created → Provider cwd=worktree → Diff → Merge
Read-only Run → Workspace root → read-only access
```

### Risk
- Medium — WorktreeManager exists but not integrated with Run lifecycle
- Changing cwd may break provider tools that assume workspace root

---

## 8. Old SSE Compatibility

### Current State
- Legacy SSE events: `status`, `stage`, `thinking`, `done`
- New runtime-event SSE: `runtime-event` with `AgentEvent` envelope
- Both coexist in `tasks.ts` (legacy) and `conversations.ts` (new)

### Migration Steps
1. **Add compatibility layer** — project legacy events to `run.*` and `stage.*` runtime events
2. **Frontend reads both formats** — during transition
3. **Retire legacy SSE events** — after all consumers are migrated
4. **Add `Last-Event-ID` / `afterSequence` support** — for reconnection

### Risk
- Low — dual system already works
- Frontend must handle both event formats

---

## 9. Current UI Compatibility

### Current State
- Next.js App Router frontend at port 3001
- Express backend at port 3000
- SSE-based real-time updates
- Multiple UI pages: workspace home, workspace detail

### Migration Steps
1. **Add v2 API client alongside v1** — configurable base URL
2. **Update component data sources** — from TaskItem to Run/Event model
3. **Add Runtime Inspector panel** — based on Runtime Events
4. **Add Run Workbench UI** — task creation, run management, timeline
5. **Add Workflow configuration UI** — for custom workflows
6. **Retire legacy task UI** — after Task/Run separation
7. **Ensure API_BASE is configurable** — for future Tauri Desktop

### Risk
- Low — most UI components can be retained
- Medium effort for data source migration

---

## 10. Legacy API Retirement

### Current State
| Endpoint | Purpose | Status |
|---|---|---|
| `POST /tasks` | Create task | Keep (v2 compatible) |
| `POST /tasks/:id/run` | Run pipeline (SSE) | **Retire** — use `POST /runs` |
| `GET /tasks/:id/status` | Legacy status | **Retire** — use `GET /runs/:id` |
| `GET /tasks/:id/logs` | File-based logs | **Retire** — use `/runs/:id/events` and `/artifacts` |
| `POST /conversations/:id/messages` | Send message (SSE) | Keep (v2 compatible) |
| `GET /runs/:runId` | Run details | Keep (v2 compatible) |
| `GET /api/workspaces` | Workspace list | Keep |
| `GET /api/agents` | Agent list | Keep |

### Retirement Schedule
1. **Phase 1 (M2)** — Add v2 endpoints alongside v1; mark v1 as deprecated
2. **Phase 2** — Migrate frontend to v2 endpoints
3. **Phase 3** — Remove v1 endpoints after all consumers migrated

### Risk
- Low — additive changes first, removal only after migration

---

## Migration Summary

| Item | Priority | Effort | Risk | Dependencies |
|---|---|---|---|---|
| JSON data → SQLite | M2 | Medium | Medium | None |
| Task → Task/Run | M2 | High | High | Store schema |
| Fixed stages → Workflow | M2 | High | High | RunEngine |
| stdout → Runtime Event | M2 | Medium | Medium | Adapter refactor |
| CLIExecutor → ProcessManager | M2 | High | High | Process Runtime |
| AgentRunner → RunEngine | M2 | High | High | Workflow + Process |
| Shared workspace → Worktree | M2-3 | Medium | Medium | Run lifecycle |
| Old SSE compatibility | M2 | Low | Low | Event Model |
| UI compatibility | Continuous | Medium | Low | API layer |
| Legacy API retirement | M3 | Low | Low | Frontend migration |
