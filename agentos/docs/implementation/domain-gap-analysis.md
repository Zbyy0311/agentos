# AgentOS Domain Gap Analysis

> Date: 2026-07-21  
> Scope: 12-question analysis comparing current v1 implementation against v2 Canonical Data Model  
> Reference: docs/Runtime-Specification/10-Data-Model.md, 01-Core-Concepts.md, 02-Runtime-Lifecycle.md

---

## Q1: Current Task — Does It Simultaneously Represent Intent and Execution?

**Yes — this is the single largest domain violation.**

### Current Implementation
```typescript
interface TaskItem {
  id: string;
  workspaceId: string;
  title: string;
  status: TaskStatus;        // 'pending' | 'running' | 'reviewing' | 'completed' | 'failed' | 'cancelled'
  currentAgent: AgentStage | null;
  outputs: TaskLog[];         // ← execution results embedded in task
  reviewDecision: ...;
  reviewBlocked: boolean;
  error?: string;
}
```

### Evidence
- `TaskItem.outputs: TaskLog[]` stores execution results directly on the task
- `TaskItem.status` includes `running` which is an execution status, not a task status
- The legacy pipeline `POST /tasks/:id/run` executes the task inline and writes outputs to the task
- There is no separate Run entity in the legacy pipeline path
- The conversation-based path does create an `AgentRun` via `agent_runs` table, but the legacy pipeline bypasses it

### v2 Required
```typescript
interface Task {
  // Describes intent only
  status: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  // No outputs, no currentAgent, no logs
}
interface Run {
  // One execution attempt
  status: 'queued' | 'starting' | 'running' | ...;
  parentRunId?: string;
  rootRunId: string;
}
```

### Migration Required
1. Create Task table with v2 fields (no outputs)
2. Link existing tasks to agent_runs via taskId column
3. Add `parentRunId`, `rootRunId` to agent_runs
4. Remove `outputs` from TaskItem after all consumers migrated

### Gap Severity: **CRITICAL**

---

## Q2: Current Run — Does It Conform to Non-Resetable Execution Attempt?

**Partially — but missing key fields.**

### Current `agent_runs` Implementation
- Has: `id`, `status`, `conversationId`, `objective`, `createdAt`, `updatedAt`, `startedAt`, `completedAt`
- Has (added later): `intent`, `runtimePolicyJson`, `waitingQuestion`, `waitingExecutionId`, `waitingAgentId`
- Missing: `parentRunId`, `rootRunId`, `errorCode`, `errorMessage`, `version`
- Missing: `taskId` — no link back to v2 Task
- Missing: `worktreeId`, `workflowDefinitionId`, `workflowSnapshotVersion`, `policySnapshotVersion`

### v2 Run Definition (01-Core-Concepts §14)
```typescript
interface Run {
  id: string;
  workspaceId: string;
  taskId: string;                    // ← missing
  workflowDefinitionId?: string;     // ← missing
  parentRunId?: string;              // ← missing
  rootRunId: string;                 // ← missing
  status: RunStatus;                 // more granular than current
  errorCode?: string;                // ← missing
  errorMessage?: string;             // ← missing
  version: number;                   // ← missing
}
```

### Migration Required
1. Add `taskId` column → FK linking to Task
2. Add `parentRunId`, `rootRunId`
3. Add `errorCode`, `errorMessage` (currently on execution.level)
4. Add `version` for optimistic concurrency
5. Expand status enum to include v2 states

### Gap Severity: **HIGH**

---

## Q3: Current Execution — Does It Overlap with Run?

**Yes — `executions` and `agent_runs` have significant overlap.**

### Current Relationship
- One `agent_run` has many `executions`
- Each `execution` represents one agent's execution within a run
- Both store: `status`, `startedAt`, `completedAt`, `error`/`failureReason`, `createdAt`, `updatedAt`
- `executions` duplicates much of the run lifecycle at a finer granularity

### v2 Design
- v2 does NOT have an `Execution` entity
- Instead: Run → Run Stages, each Stage has a Provider Session
- Run Stage replaces Execution as the unit of agent execution
- Provider Session tracks the native provider interaction

### Migration
1. Map each `execution` to a `RunStage`
2. Execution fields: `mode` → Stage metadata; `waiting*` → Approval workflow
3. Eventually retire `executions` table after full migration

### Gap Severity: **MEDIUM**

---

## Q4: Current Stage — Does It Still Depend on Fixed AgentStage Union?

**Yes — `AgentStage` is a fixed type-level union, not data-driven.**

### Current
```typescript
type AgentStage = 'codex_manager' | 'kimi_worker' | 'opencode_reviewer' | 'codex_final_review';
```

### v2 Required
```
Stage is data defined by Workflow Definition.
Run stage is a database record with workflowStageKey as a string (not a union type).
```

### Migration
1. `run_steps.kind` already uses open-ended strings like `'context'`, `'agent'`, `'review'`, `'artifact'`, `'summary'`
2. The `stable_step_key` field on `run_steps` is already a string key
3. The problem is in `TaskItem.currentAgent: AgentStage` and `TaskLog.stage: AgentStage`
4. `run_steps` is already closer to v2 than the legacy types

### Gap Severity: **MEDIUM** (legacy path only; run_steps is already close)

---

## Q5: Current Snapshot — Is It Immutable and Traceable?

**No — there is NO snapshot implementation at all.**

### Current State
- Agent and provider configuration are read at execution time
- No agent snapshot (name, role, capability frozen at run creation)
- No provider configuration snapshot (executable, args, model frozen)
- No workflow snapshot
- No policy snapshot
- If an agent profile or provider config changes, historical runs become uninterpretable

### v2 Required
All runs must freeze:
- Agent Snapshot (name, role, systemPrompt, capabilities, providerConfigId)
- Provider Configuration Snapshot (executable, argsTemplate, model, capabilities)
- Workflow Definition Snapshot (version, stages)
- Policy Profile Snapshot (version, rules)

### Migration
1. Add `agent_snapshot_json` to agent_runs
2. Add `provider_snapshot_json` to agent_runs
3. Add `workflow_snapshot_json` to agent_runs
4. Add `policy_snapshot_json` to agent_runs
5. Create new `run_snapshots` table or use JSON columns
6. Populate at Run creation time (before execution starts)

### Gap Severity: **CRITICAL** — without snapshots, history is unreliable

---

## Q6: Current Workspace — Why Dual JSON + SQLite Storage?

**Because SqliteStore wraps JsonFileStore for backward compatibility.**

### Current Flow
```
SqliteStore.loadWorkspaces()
  → delegates to this.legacy.loadWorkspaces()  // JSON file
  → returns Workspace[]

SqliteStore.saveWorkspaces(workspaces)
  → migrates legacy agents
  → delegates to this.legacy.saveWorkspaces()   // JSON file
  → then migrates to agent_profiles in SQLite
```

### Why Dual Path
1. Workspace metadata (name, rootPath, agents list) was originally stored in JSON
2. SQLite agent_profiles table was added later as a secondary store
3. `saveWorkspaces()` writes to JSON AND syncs to SQLite agent_profiles
4. Tasks are also stored in JSON (workspace/{id}/.agentos/tasks.json)

### Migration Required
1. Move workspace table into SQLite
2. Single write path (SQLite only)
3. Retire JsonFileStore entirely
4. Add migration from JSON to SQLite

### Gap Severity: **HIGH** — dual write path is a consistency risk

---

## Q7: Current Repository — Does It Support Transactions and Concurrent Version?

**Partially — transactions exist but version-based concurrency does not.**

### Current Transaction Support
- SqliteStore uses `BEGIN`/`COMMIT`/`ROLLBACK` in several methods
- Examples: `deleteWorkspace()`, `persistAgentEvent()`, migration methods
- But NOT used consistently across all write operations
- No transaction helper/utility for consistent usage

### Current Version Support
- NO `version` column on any table
- NO optimistic concurrency checks
- Exception: `run_event_sequences` has `next_sequence` which provides ordering but not versioning
- `ON CONFLICT ... DO UPDATE` is used for idempotency but not version conflict detection

### v2 Required
- `version: number` on all mutable aggregates (Task, Run, Approval, Worktree, Provider Configuration, Workflow Definition, Policy Profile)
- All state transitions must verify version
- Transaction wrapping for aggregate operations

### Migration Required
1. Add `version INTEGER NOT NULL DEFAULT 1` to: agent_runs, agent_profiles, conversations
2. Add transaction utility function in SqliteStore
3. Update write methods to use `UPDATE ... WHERE version = ?`
4. Increment version on each update

### Gap Severity: **HIGH** — no concurrency safety on mutable aggregates

---

## Q8: Current ID — Does It Follow Stable Opaque ID Requirements?

**Partially — IDs exist but lack consistent prefix convention.**

### Current State
- Conversations: random short IDs (`randomUUID().slice(0, 8)`)
- agent_runs: random UUID
- agent_profiles: workspace-defined IDs (`'codex'`, `'kimi'`, `'opencode'`)
- Tasks: `randomUUID().slice(0, 8)`
- events: `event_id` from `randomUUID()`
- artifacts: UUID
- memories: UUID

### v2 Required (01-Core-Concepts §3.3)
```text
ws_        Workspace
agent_     Agent Profile
provider_  Provider Configuration
conv_      Conversation
msg_       Message
task_      Task
run_       Run
stage_     Run Stage
evt_       Runtime Event
session_   Provider Session
proc_      Runtime Process
wt_        Worktree
art_       Artifact
mem_       Memory Entry
policy_    Policy Profile
approval_  Approval Request
workflow_  Workflow Definition
usage_     Usage Record
ext_       Extension
```

### Migration Required
1. Adopt prefix convention for new entities
2. Existing records do NOT need immediate re-ID — prefix rule applies forward
3. Document the convention and apply to all new domain types
4. Consider migration of existing IDs only if needed for consistency

### Gap Severity: **LOW** — forward-only convention, no breaking change needed

---

## Q9: Current Soft Delete and Retention — Is There a Unified Implementation?

**No — soft delete and retention are ad-hoc.**

### Current Soft Delete
- NO soft delete columns on any table
- `deleteWorkspace()` uses hard CASCADE delete
- Memories have `status: 'active' | 'archived'` — partial soft delete
- Memory candidates have `status: 'pending' | 'accepted' | 'rejected'`

### Current Retention
- `RetentionService` — periodic cleanup of memory candidates
- No retention policy for: runs, artifacts, events, logs
- No automatic cleanup of completed runs
- No deferred worktree cleanup

### v2 Required (01-Core-Concepts §31)
- Soft delete preferred for: Workspace, Agent Profile, Provider Configuration, Conversation, Task, Workflow Definition, Policy Profile
- Immutable: Runtime Event, Approval Decision, Run Snapshot, Usage Record, Artifact Metadata, Message
- Cleanup objects: Worktree directory, temp Process records, Raw Log, Cache

### Migration Required
1. Add `archived_at` column to mutable aggregates
2. Add `deleted_at` column for explicit deletion tracking
3. Create Retention Policy configuration
4. Update queries to filter by archived/deleted status

### Gap Severity: **MEDIUM** — no immediate data loss risk but cleanup is manual

---

## Q10: Current Idempotency — Is There an Idempotency Record Implementation?

**No — there is no explicit idempotency key infrastructure.**

### Current State
- `agent_events` uses `event_id` as PK — duplicate events with same ID are rejected naturally
- `INSERT ... ON CONFLICT DO UPDATE` provides upsert semantics for `run_cli_invocations`
- `run_event_sequences` has `ON CONFLICT(run_id) DO UPDATE` — idempotent sequence reservation
- BUT: no idempotency key column on Task creation, Run creation, Approval decision, or Worktree creation
- No idempotency record table
- No idempotency middleware or utility

### v2 Required (02-Runtime-Lifecycle §44)
Operations requiring idempotency key:
- Create Task
- Create Run
- Cancel Run
- Approve Request
- Retry Run
- Merge Worktree
- Create Artifact from external callback

### Migration Required
1. Add `idempotency_key` table or column to relevant aggregates
2. Add idempotency check in Create Run, Create Task, Cancel Run, Approve Request
3. Return existing result on duplicate key, don't re-execute

### Gap Severity: **HIGH** — duplicate creation possible on network retry

---

## Q11: Current Optimistic Concurrency — Is It Implemented?

**No — no version-based concurrency control on any aggregate.**

### Current State
- No `version` column on any mutable table
- No `WHERE version = ?` pattern in any UPDATE statement
- No transition lock on Run status changes
- Risk: simultaneous Cancel + Complete can race, simultaneous Retry can create duplicates
- The `agent_events` table has `UNIQUE(run_id, sequence)` — but this is ordering, not concurrency

### v2 Required (02-Runtime-Lifecycle §45)
- `version: number` on: Task, Run, Approval, Worktree, Provider Configuration, Workflow Definition, Policy Profile
- State migration uses `version` in WHERE clause
- Database transaction for atomic transitions
- Transition lock for Run state changes

### Migration Required
1. Add `version` column to mutable aggregates
2. Add transition utility (`updateIfVersion(ownerId, expectedVersion, update)`)
3. Update all state-mutation methods to use version checks
4. Add tests for concurrent state transitions

### Gap Severity: **HIGH** — silent state corruption possible under concurrency

---

## Q12: Current Migration — Does It Support Rollback, Backup, and Integrity Check?

**No — current migrations are append-only and not reversible.**

### Current Implementation
- `migrateSchema()` uses `CREATE TABLE IF NOT EXISTS` — safe for initial creation
- `ensureColumn()` uses `ALTER TABLE ... ADD COLUMN` with `PRAGMA table_info` check — safe for column addition
- Data migrations (sequence backfill, execution-run linking) use `BEGIN`/`COMMIT` with `ROLLBACK` on error — but no rollback intention
- **No migration version tracking** — all migrations run every startup
- **No rollback capability** — data migrations are one-way
- **No backup before migration**
- **No integrity check after migration**
- **No test for migration correctness**

### v2 Required (10-Data-Model)
- Migration system with version tracking
- Rollback support for each migration step
- Backup before schema-changing migrations
- Integrity check after migration completion
- Tests that verify migration from v1 to v2 schemas

### Migration Required
1. Create `_schema_migrations` table to track applied migrations
2. Convert schema creation to versioned migrations
3. Add rollback scripts for each migration
4. Add pre-migration backup step
5. Add post-migration integrity checks
6. Test migration on copy of production data

### Gap Severity: **HIGH** — current migration approach will cause problems as schema evolves

---

## Gap Summary

| # | Question | Severity | Effort | Priority |
|---|---|---|---|---|
| 1 | Task = Intent + Execution | CRITICAL | High | M2.4 |
| 2 | Run missing key fields | HIGH | Medium | M2.4 |
| 3 | Execution overlaps Run | MEDIUM | Medium | M2.5 |
| 4 | Fixed AgentStage union | MEDIUM | Low | M2.5 |
| 5 | No snapshot | CRITICAL | High | M2.5 |
| 6 | Dual JSON+SQLite storage | HIGH | Medium | M2.3 |
| 7 | No transaction consistency | HIGH | Medium | M2.2 |
| 8 | ID prefix convention | LOW | Low | M2.2 |
| 9 | No unified soft delete | MEDIUM | Medium | M2.6 |
| 10 | No idempotency | HIGH | Medium | M2.6 |
| 11 | No optimistic concurrency | HIGH | Medium | M2.6 |
| 12 | No structured migration | HIGH | High | M2.1 |

### Critical Path
```
M2.0 (inventory) → M2.1 (migration foundation) → M2.2 (identity/version/repository)
  → M2.3 (workspace/agent/provider) → M2.4 (task/run separation)
  → M2.5 (stage/snapshot) → M2.6 (idempotency/concurrency)
  → M2.7 (v1 compatibility) → M2.8 (verification)
```
