# AgentOS Schema Inventory

> Date: 2026-07-21  
> Scope: All current SQLite tables, JSON stores, and persistence layer  
> Repository: `Zbyy0311/agentos`  
> Source: `apps/server/src/store/SqliteStore.ts`, `JsonFileStore.ts`, `Store.ts`

---

## 1. SQLite Tables

### 1.1 `agent_profiles`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| workspace_id | TEXT | PK | Composite PK with id |
| id | TEXT | PK | Agent identifier |
| name | TEXT | NOT NULL | Display name |
| agent_role | TEXT | NOT NULL | `codex`, `kimi`, `opencode`, `mimo` |
| provider | TEXT | NULLABLE | `codex`, `kimi`, `opencode`, `mimo`, `custom` |
| role_title | TEXT | NOT NULL | Human-readable role |
| system_prompt | TEXT | NOT NULL | System instructions |
| permissions_json | TEXT | NOT NULL | JSON array of `read`, `write`, `review` |
| enabled | INTEGER | NOT NULL | Boolean |
| cli_command | TEXT | NOT NULL | CLI executable name/path |
| cli_args_json | TEXT | NOT NULL | JSON array of CLI arguments |
| model | TEXT | NULLABLE | Model identifier |
| thinking_effort | TEXT | NOT NULL DEFAULT 'auto' | `auto`, `low`, `medium`, `high` |
| created_at | TEXT | NOT NULL | ISO 8601 |
| updated_at | TEXT | NOT NULL | ISO 8601 |

**Foreign Keys:** None  
**Indexes:** None (PK serves as lookup)  
**Writer:** `SqliteStore.updateAgentProfile()`  
**Reader:** `SqliteStore.listAgentProfiles()`, `getAgentProfile()`  
**Current Purpose:** Persistent agent identity configuration  
**Target v2 Entity:** Agent Profile (01-Core-Concepts §6)  
**Decision:** refactor — add capabilities, memoryScopes, avatar; cliCommand/cliArgs belong in Provider Configuration  
**Migration Risk:** Medium — need to split into Agent Profile + Provider Configuration

---

### 1.2 `conversations`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL | |
| conversation_type | TEXT | NOT NULL CHECK | `direct`, `group` |
| title | TEXT | NOT NULL | |
| agent_id | TEXT | NULLABLE | Primary agent for direct conversations |
| model | TEXT | NULLABLE | Added via ensureColumn |
| thinking_effort | TEXT | NULLABLE | Added via ensureColumn |
| dispatch_mode | TEXT | NULLABLE | `leader_route`, `full_pipeline`, `mentioned_only` |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

**Indexes:** `conversations_workspace_updated` (workspace_id, updated_at DESC)  
**Writer:** `SqliteStore.createConversation()`, `updateConversation()`  
**Reader:** `SqliteStore.listConversations()`, `getConversation()`  
**Current Purpose:** Persistent conversation records for chat  
**Target v2 Entity:** Conversation (01-Core-Concepts §10)  
**Decision:** refactor — add `type` values, member fixed, immutable invariants  
**Migration Risk:** Low

---

### 1.3 `conversation_members`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| conversation_id | TEXT | PK | FK → conversations(id) ON DELETE CASCADE |
| agent_id | TEXT | PK | |
| role_title | TEXT | NOT NULL | |
| is_leader | INTEGER | NOT NULL DEFAULT 0 | Legacy, being replaced by role_kind |
| role_kind | TEXT | NOT NULL DEFAULT 'worker' | `leader`, `worker`, `reviewer`, `specialist` |
| sequence | INTEGER | NOT NULL DEFAULT 0 | Order/priority |
| created_at | TEXT | NOT NULL | |

**Indexes:** `conversation_members_conversation_sequence` UNIQUE (conversation_id, sequence)  
**Writer:** `SqliteStore.updateConversationMembers()`  
**Reader:** `SqliteStore.listConversationMembers()`  
**Current Purpose:** Track which agents belong to a conversation  
**Target v2 Entity:** Conversation Member (01-Core-Concepts §11)  
**Decision:** keep — already close to v2 specification  
**Migration Risk:** Low

---

### 1.4 `messages`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| conversation_id | TEXT | NOT NULL | FK → conversations(id) ON DELETE CASCADE |
| workspace_id | TEXT | NOT NULL | |
| sender_type | TEXT | NOT NULL CHECK | `user`, `agent`, `system` |
| sender_agent_id | TEXT | NULLABLE | |
| run_id | TEXT | NULLABLE | Added via ensureColumn |
| content | TEXT | NOT NULL | |
| created_at | TEXT | NOT NULL | |

**Indexes:** `messages_conversation_created` (conversation_id, created_at DESC)  
**Writer:** `SqliteStore.saveMessage()`  
**Reader:** `SqliteStore.listMessages()`, `getMessage()`  
**Current Purpose:** Persistent chat message records  
**Target v2 Entity:** Message (01-Core-Concepts §12)  
**Decision:** refactor — add senderSnapshot, type, replyToMessageId, artifact/approval references  
**Migration Risk:** Low

---

### 1.5 `message_attachments`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| message_id | TEXT | NOT NULL | FK → messages(id) ON DELETE CASCADE |
| conversation_id | TEXT | NOT NULL | FK → conversations(id) ON DELETE CASCADE |
| workspace_id | TEXT | NOT NULL | |
| name | TEXT | NOT NULL | |
| mime_type | TEXT | NOT NULL | |
| size | INTEGER | NOT NULL | |
| relative_path | TEXT | NOT NULL | |

**Indexes:** `message_attachments_conversation` (conversation_id, id), `message_attachments_workspace` (workspace_id, id)  
**Writer:** `SqliteStore.saveMessageAttachment()`  
**Reader:** `SqliteStore.listMessageAttachments()`  
**Current Purpose:** Track file attachments on messages  
**Target v2 Entity:** Artifact / Message Attachment  
**Decision:** keep — close to v2; could become part of v2 Artifact  
**Migration Risk:** Low

---

### 1.6 `executions`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| run_id | TEXT | NULLABLE | FK → agent_runs(id) ON DELETE CASCADE (added later) |
| conversation_id | TEXT | NOT NULL | FK → conversations(id) ON DELETE CASCADE |
| workspace_id | TEXT | NOT NULL | |
| source_message_id | TEXT | NOT NULL | FK → messages(id) ON DELETE RESTRICT |
| agent_id | TEXT | NOT NULL | |
| status | TEXT | NOT NULL | `queued`, `preparing_context`, `running_cli`, `streaming_response`, `waiting_user`, `completed`, `failed`, `cancelled` |
| mode | TEXT | NOT NULL CHECK | `real`, `mock` |
| error | TEXT | NULLABLE | |
| started_at | TEXT | NULLABLE | |
| completed_at | TEXT | NULLABLE | |
| waiting_question | TEXT | NULLABLE | |
| waiting_execution_id | TEXT | NULLABLE | |
| waiting_agent_id | TEXT | NULLABLE | |
| intent | TEXT | NOT NULL DEFAULT 'execute' | `ask`, `execute`, `review` |
| runtime_policy_json | TEXT | NULLABLE | |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

**Indexes:** `executions_conversation_updated` (conversation_id, updated_at DESC)  
**Writer:** `SqliteStore.createExecution()`, `updateExecutionStatus()`, etc.  
**Reader:** `SqliteStore.listExecutions()`, `getExecution()`  
**Current Purpose:** Track one agent's execution within a run  
**Target v2 Entity:** Provider Session / Run Stage (partial)  
**Decision:** refactor — overlaps with Run; need to clarify lifecycle boundary  
**Migration Risk:** Medium — may consolidate into Run Stage

---

### 1.7 `agent_runs`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL | |
| conversation_id | TEXT | NOT NULL | FK → conversations(id) ON DELETE CASCADE |
| source_message_id | TEXT | NOT NULL | FK → messages(id) ON DELETE RESTRICT |
| objective | TEXT | NOT NULL | Task description |
| status | TEXT | NOT NULL | `queued`, `running`, `waiting_user`, `completed`, `failed`, `cancelled` |
| result_summary | TEXT | NULLABLE | |
| failure_reason | TEXT | NULLABLE | |
| started_at | TEXT | NULLABLE | |
| completed_at | TEXT | NULLABLE | |
| waiting_question | TEXT | NULLABLE | Added via ensureColumn |
| waiting_execution_id | TEXT | NULLABLE | Added via ensureColumn |
| waiting_agent_id | TEXT | NULLABLE | Added via ensureColumn |
| intent | TEXT | NOT NULL DEFAULT 'execute' | Added via ensureColumn |
| runtime_policy_json | TEXT | NULLABLE | Added via ensureColumn |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

**Indexes:** `agent_runs_conversation_updated` (conversation_id, updated_at DESC)  
**Writer:** `SqliteStore.createRun()`, `updateRunStatus()`, `failRun()`  
**Reader:** `SqliteStore.listRuns()`, `getRun()`  
**Current Purpose:** Tracks one execution attempt within a conversation  
**Target v2 Entity:** Run (01-Core-Concepts §14)  
**Decision:** refactor — missing parentRunId, rootRunId, errorCode, errorMessage, version; already close  
**Migration Risk:** Medium — missing fields must be added

---

### 1.8 `run_steps`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| stable_step_key | TEXT | NOT NULL | |
| workspace_id | TEXT | NOT NULL | |
| run_id | TEXT | NOT NULL | FK → agent_runs(id) ON DELETE CASCADE |
| parent_step_id | TEXT | NULLABLE | |
| execution_id | TEXT | NULLABLE | |
| agent_id | TEXT | NULLABLE | |
| kind | TEXT | NOT NULL | `context`, `agent`, `review`, `artifact`, `summary` |
| title | TEXT | NOT NULL | |
| status | TEXT | NOT NULL | `pending`, `running`, `waiting`, `completed`, `failed`, `cancelled`, `skipped` |
| sequence | INTEGER | NOT NULL | |
| attempt | INTEGER | NOT NULL DEFAULT 1 | |
| created_event_sequence | INTEGER | NOT NULL | |
| updated_event_sequence | INTEGER | NOT NULL | |
| started_at | TEXT | NULLABLE | |
| completed_at | TEXT | NULLABLE | |
| summary | TEXT | NULLABLE | |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

**Indexes:** `run_steps_stable_key` UNIQUE (run_id, stable_step_key), `run_steps_sibling_sequence` UNIQUE (run_id, IFNULL(parent_step_id, ''), sequence)  
**Writer:** `SqliteStore.persistRunStepMutation()`  
**Reader:** `SqliteStore.listRunSteps()`  
**Current Purpose:** Track individual steps within a run  
**Target v2 Entity:** Run Stage (01-Core-Concepts §15)  
**Decision:** refactor — rename `kind` to align with Workflow Stage Key; add providerSnapshot, agentSnapshot  
**Migration Risk:** Medium — good foundation, rename/addition needed

---

### 1.9 `execution_events`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| execution_id | TEXT | NOT NULL | FK → executions(id) ON DELETE CASCADE |
| status | TEXT | NOT NULL | |
| activity | TEXT | NOT NULL | |
| content | TEXT | NULLABLE | |
| created_at | TEXT | NOT NULL | |

**Indexes:** `execution_events_execution_created` (execution_id, created_at ASC)  
**Writer:** `SqliteStore.saveExecutionEvent()`  
**Reader:** `SqliteStore.listExecutionEvents()`  
**Current Purpose:** Track status changes within an execution  
**Target v2 Entity:** Runtime Event (01-Core-Concepts §19)  
**Decision:** migrate — this is a simpler event model; v2 Runtime Event is richer with sequence, causation, correlation  
**Migration Risk:** Medium

---

### 1.10 `agent_events`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| event_id | TEXT | PK | |
| schema_version | INTEGER | NOT NULL | Currently 2 |
| event_type | TEXT | NOT NULL | See AgentEventType union in shared |
| workspace_id | TEXT | NOT NULL | |
| conversation_id | TEXT | NOT NULL | |
| run_id | TEXT | NOT NULL | |
| execution_id | TEXT | NULLABLE | |
| agent_id | TEXT | NULLABLE | |
| sequence | INTEGER | NULLABLE | Backfilled, now required |
| timestamp | TEXT | NOT NULL | |
| payload_json | TEXT | NOT NULL | |

**Indexes:** `agent_events_workspace_run_timestamp` (workspace_id, run_id, timestamp ASC), `agent_events_run_sequence` UNIQUE (run_id, sequence)  
**Writer:** `SqliteStore.persistAgentEvent()`, `appendAgentEvent()`  
**Reader:** `SqliteStore.listAgentEvents()`, `getAgentEventBySequence()`  
**Current Purpose:** Unified event store for runtime events  
**Target v2 Entity:** Runtime Event (01-Core-Concepts §19, 03-Event-Model)  
**Decision:** refactor — already close to v2; need to add causationId, correlationId, severity, visibility, durability, source, parentEventId  
**Migration Risk:** Low — good foundation

---

### 1.11 `run_event_sequences`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| run_id | TEXT | PK | |
| next_sequence | INTEGER | NOT NULL | |

**Writer:** `SqliteStore.nextRunEventSequence()`  
**Current Purpose:** Monotonic sequence counter per run  
**Target v2 Entity:** Runtime Event sequence allocation (03-Event-Model §46)  
**Decision:** keep — matches v2 design exactly  
**Migration Risk:** None

---

### 1.12 `run_cli_invocations`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| run_id | TEXT | NOT NULL | FK → agent_runs(id) ON DELETE CASCADE |
| execution_id | TEXT | NOT NULL | |
| agent_id | TEXT | NOT NULL | |
| cli_kind | TEXT | NOT NULL | `kimi`, `opencode`, `codex`, `unknown` |
| command_label | TEXT | NOT NULL | |
| configured_provider | TEXT | NULLABLE | Added via ensureColumn |
| detected_provider | TEXT | NULLABLE | Added via ensureColumn |
| provider_mismatch | INTEGER | NOT NULL DEFAULT 0 | Added via ensureColumn |
| model | TEXT | NULLABLE | |
| thinking_effort | TEXT | NULLABLE | |
| exit_code | INTEGER | NULLABLE | |
| duration_ms | INTEGER | NOT NULL | |
| started_at | TEXT | NOT NULL | |
| completed_at | TEXT | NOT NULL | |

**Indexes:** `run_cli_invocations_run_started` (run_id, started_at ASC)  
**Writer:** `SqliteStore.saveRunCliInvocation()`  
**Reader:** `SqliteStore.listRunCliInvocations()`  
**Current Purpose:** Record each CLI invocation detail  
**Target v2 Entity:** Provider Session detail / Runtime Process (partial)  
**Decision:** refactor — split into Provider Session + Runtime Process records  
**Migration Risk:** Medium

---

### 1.13 `run_file_changes`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| run_id | TEXT | PK | FK → agent_runs(id) ON DELETE CASCADE |
| path | TEXT | PK | |
| change_type | TEXT | PK | `created`, `modified`, `deleted`, `renamed` |

**Writer:** `SqliteStore.saveRunFileChanges()`  
**Reader:** `SqliteStore.listRunFileChanges()`  
**Current Purpose:** Track file changes during a run  
**Target v2 Entity:** File Change Event (03-Event-Model §26)  
**Decision:** keep — store as Event projection, keep table for compatibility  
**Migration Risk:** Low

---

### 1.14 `run_decisions`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL | |
| run_id | TEXT | NOT NULL | FK → agent_runs(id) ON DELETE CASCADE |
| execution_id | TEXT | NOT NULL | FK → executions(id) ON DELETE CASCADE |
| kind | TEXT | NOT NULL | `partial_write_failure` |
| file_changes_json | TEXT | NOT NULL | |
| allowed_decisions_json | TEXT | NOT NULL | |
| resolved_decision | TEXT | NULLABLE | `keep_and_continue`, `retry_current`, `abort` |
| created_at | TEXT | NOT NULL | |
| resolved_at | TEXT | NULLABLE | |

**Unique:** (run_id, execution_id, kind)  
**Indexes:** `run_decisions_workspace_run` (workspace_id, run_id, created_at DESC)  
**Writer:** `SqliteStore.saveRunDecision()`, `resolveRunDecision()`  
**Reader:** `SqliteStore.listRunDecisions()`  
**Current Purpose:** Track pending user decisions in runs  
**Target v2 Entity:** Approval Request / Policy Decision  
**Decision:** refactor — generalize to Approval Request model  
**Migration Risk:** Low

---

### 1.15 `runtime_artifacts`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL | |
| run_id | TEXT | NOT NULL | FK → agent_runs(id) ON DELETE CASCADE |
| source_execution_id | TEXT | NOT NULL | FK → executions(id) ON DELETE CASCADE |
| agent_id | TEXT | NOT NULL | |
| artifact_type | TEXT | NOT NULL | `file`, `diff`, `report`, `image`, `log`, `archive`, `manifest` |
| title | TEXT | NOT NULL | |
| summary | TEXT | NULLABLE | |
| original_path | TEXT | NULLABLE | |
| storage_key | TEXT | NULLABLE | File system path |
| mime_type | TEXT | NULLABLE | |
| size_bytes | INTEGER | NOT NULL | |
| sha256 | TEXT | NULLABLE | |
| content_available | INTEGER | NOT NULL | Boolean |
| created_at | TEXT | NOT NULL | |

**Indexes:** `runtime_artifacts_run_created` (workspace_id, run_id, created_at, id)  
**Writer:** `SqliteStore.saveRuntimeArtifact()`, `finalizeRuntimeArtifact()`  
**Reader:** `SqliteStore.listRuntimeArtifacts()`, `getRuntimeArtifact()`  
**Current Purpose:** Track artifacts produced during runs  
**Target v2 Entity:** Artifact (01-Core-Concepts §20)  
**Decision:** refactor — add checksum, mimeType improvements, retention fields  
**Migration Risk:** Low

---

### 1.16 `memories`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL | |
| memory_type | TEXT | NOT NULL | `overview`, `convention`, `decision`, `experience` |
| status | TEXT | NOT NULL | `active`, `archived` |
| title | TEXT | NOT NULL | |
| summary | TEXT | NOT NULL | |
| content_path | TEXT | NOT NULL | File path to content |
| tags_json | TEXT | NOT NULL | JSON array |
| related_files_json | TEXT | NOT NULL | JSON array |
| importance | INTEGER | NOT NULL | |
| confidence | INTEGER | NOT NULL | |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |
| last_accessed_at | TEXT | NULLABLE | |

**Indexes:** `memories_workspace_updated` (workspace_id, status, updated_at DESC)  
**Writer:** `SqliteStore.saveMemory()`, `updateMemory()`  
**Reader:** `SqliteStore.listMemories()`, `searchMemories()`, `getMemory()`  
**Current Purpose:** Long-term knowledge storage  
**Target v2 Entity:** Memory Entry (01-Core-Concepts §22)  
**Decision:** refactor — add scope, category, sourceType, sourceId; content stored in content_path (file-based), should be DB column  
**Migration Risk:** Medium — content stored on filesystem via content_path

---

### 1.17 `memory_sources`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| memory_id | TEXT | PK | FK → memories(id) ON DELETE CASCADE |
| run_id | TEXT | PK | |

**Writer:** `SqliteStore.saveMemory()`  
**Reader:** `SqliteStore.listMemorySources()`  
**Current Purpose:** Track which runs contributed to a memory  
**Target v2 Entity:** Memory source tracking  
**Decision:** keep — useful provenance data  
**Migration Risk:** Low

---

### 1.18 `memory_fts` (FTS5 virtual table)

| Field | Type | Notes |
|---|---|---|
| memory_id | UNINDEXED | FK reference |
| title | Indexed | Full-text indexed |
| summary | Indexed | Full-text indexed |
| content | Indexed | Full-text indexed |
| tags | Indexed | Full-text indexed |

**Writer:** `SqliteStore.saveMemory()` triggers FTS insert  
**Reader:** `SqliteStore.searchMemories()`  
**Current Purpose:** Full-text search across memories  
**Target v2 Entity:** Memory retrieval index  
**Decision:** keep — matches v2 spec's FTS5 recommendation  
**Migration Risk:** None

---

### 1.19 `run_memory_usage`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| run_id | TEXT | PK | FK → agent_runs(id) ON DELETE CASCADE |
| memory_id | TEXT | PK | FK → memories(id) ON DELETE CASCADE |
| rank | INTEGER | NOT NULL | |
| injected_characters | INTEGER | NOT NULL | |
| used_at | TEXT | NOT NULL | |

**Writer:** `SqliteStore.saveMemoryUsage()`  
**Reader:** `SqliteStore.listMemoryUsage()`  
**Current Purpose:** Track which memories were used in which runs  
**Target v2 Entity:** Memory Context (01-Core-Concepts §22.7)  
**Decision:** keep — directly maps to Memory Context entries  
**Migration Risk:** Low

---

### 1.20 `memory_candidates`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| workspace_id | TEXT | NOT NULL | |
| run_id | TEXT | NOT NULL | FK → agent_runs(id) ON DELETE CASCADE |
| memory_type | TEXT | NOT NULL | |
| title | TEXT | NOT NULL | |
| summary | TEXT | NOT NULL | |
| content | TEXT | NOT NULL | |
| confidence | INTEGER | NOT NULL | |
| operation | TEXT | NOT NULL | `create`, `update`, `merge`, `ignore` |
| conflicting_memory_ids_json | TEXT | NOT NULL | |
| status | TEXT | NOT NULL | `pending`, `accepted`, `rejected` |
| created_at | TEXT | NOT NULL | |
| reviewed_at | TEXT | NULLABLE | |

**Indexes:** `memory_candidates_workspace_status_created` (workspace_id, status, created_at DESC)  
**Writer:** `SqliteStore.saveMemoryCandidate()`, `acceptMemoryCandidate()`, `rejectMemoryCandidate()`  
**Reader:** `SqliteStore.listMemoryCandidates()`  
**Current Purpose:** Queue of proposed memory entries for user review  
**Target v2 Entity:** Memory Candidate (memory extraction pipeline)  
**Decision:** keep — matches v2 extraction lifecycle  
**Migration Risk:** Low

---

### 1.21 `user_profiles`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | `'default'` |
| display_name | TEXT | NOT NULL | |
| learning_enabled | INTEGER | NOT NULL DEFAULT 1 | |
| created_at | TEXT | NOT NULL | |
| updated_at | TEXT | NOT NULL | |

**Writer:** `SqliteStore` constructor (INSERT OR IGNORE)  
**Reader:** `SqliteStore.getUserProfile()`  
**Current Purpose:** Single-user profile for preference learning  
**Target v2 Entity:** User (01-Core-Concepts §4)  
**Decision:** keep — matches v2 User concept  
**Migration Risk:** Low

---

### 1.22 `preference_evidence`

| Field | Type | Constraints | Notes |
|---|---|---|---|
| id | TEXT | PK | |
| profile_id | TEXT | NOT NULL | FK → user_profiles(id) ON DELETE CASCADE |
| workspace_id | TEXT | NULLABLE | |
| conversation_id | TEXT | NOT NULL | FK → conversations(id) ON DELETE CASCADE |
| run_id | TEXT | NOT NULL | FK → agent_runs(id) ON DELETE CASCADE |
| source_event_id | TEXT | NOT NULL | |
| dimension | TEXT | NOT NULL | |
| context_kind | TEXT | NOT NULL | |
| candidate_value | TEXT | NOT NULL | |
| signal_type | TEXT | NOT NULL | |
| polarity | TEXT | NOT NULL | |
| weight | INTEGER | NOT NULL | |
| summary | TEXT | NOT NULL | |
| status | TEXT | NOT NULL | |
| observed_at | TEXT | NOT NULL | |
| created_at | TEXT | NOT NULL | |

**Unique:** (profile_id, source_event_id, dimension, context_kind, candidate_value, signal_type, polarity)  
**Indexes:** `preference_evidence_profile_scope_time` (profile_id, workspace_id, observed_at ASC)  
**Target v2 Entity:** Not directly mapped — preference system is a v2 enhancement  
**Decision:** keep — independent feature orthogonal to core runtime  
**Migration Risk:** None

---

### 1.23 `preference_projections`

| Field | Type | Constraints |
|---|---|---|
| id | TEXT | PK |
| profile_id | TEXT | NOT NULL |
| scope | TEXT | NOT NULL |
| workspace_id | TEXT | NULLABLE |
| dimension | TEXT | NOT NULL |
| context_kind | TEXT | NOT NULL |
| preferred_value | TEXT | NOT NULL |
| confidence | INTEGER | NOT NULL |
| score | INTEGER | NOT NULL |
| evidence_count | INTEGER | NOT NULL |
| independent_run_count | INTEGER | NOT NULL |
| status | TEXT | NOT NULL |
| last_supported_at | TEXT | NOT NULL |
| last_conflicted_at | TEXT | NULLABLE |
| created_at | TEXT | NOT NULL |
| updated_at | TEXT | NOT NULL |

**Unique:** (profile_id, scope, workspace_id, dimension, context_kind)  

---

### 1.24 `preference_projection_evidence`

| Field | Type | Constraints |
|---|---|---|
| projection_id | TEXT | PK |
| evidence_id | TEXT | PK |
| contribution | INTEGER | NOT NULL |

---

### 1.25 `preference_applications`

| Field | Type | Constraints |
|---|---|---|
| run_id | TEXT | PK |
| projection_id | TEXT | PK |
| resolved_value | TEXT | NOT NULL |
| rank | INTEGER | NOT NULL |
| injected_characters | INTEGER | NOT NULL |
| applied_at | TEXT | NOT NULL |

**Index:** `preference_applications_run_rank` (run_id, rank ASC)

---

## 2. JSON File Stores

### 2.1 `workspace/workspaces.json`

| Field | Type | Notes |
|---|---|---|
| workspaces | Workspace[] | Array of workspace objects |

**Writer:** No active SQLite Workspace/Agent/Provider path writes this file. `JsonFileStore.saveWorkspaces()` remains available only to the standalone legacy store.
**Reader:** `JsonFileStore.loadWorkspaces()` for legacy fallback and one-time migration input
**Current Purpose:** Legacy import/fallback source; SQLite is authoritative once migrated
**Target:** retire — migrate to SQLite  
**Migration Risk:** Medium — workspace data must be migrated, agents moved to agent_profiles

### 2.2 `workspace/{workspaceId}/.agentos/tasks.json`

| Field | Type | Notes |
|---|---|---|
| tasks | TaskItem[] | Array of pipeline task objects |

**Writer:** `JsonFileStore.saveTasks()`, `saveTask()`  
**Reader:** `JsonFileStore.loadTasks()`  
**Current Purpose:** Primary store for legacy pipeline tasks  
**Target:** retire — migrate to SQLite `tasks`/`agent_runs`  
**Migration Risk:** Medium — tasks contain TaskLog[] with CLI output content

---

## 3. Store Interface

**File:** `apps/server/src/store/Store.ts`

```typescript
interface Store {
  loadWorkspaces(): Workspace[];
  saveWorkspaces(workspaces: Workspace[]): void;
  deleteWorkspace?(workspaceId: string): void;
  loadTasks(workspaceId: string): TaskItem[];
  saveTasks(workspaceId: string, tasks: TaskItem[]): void;
  saveTask(workspaceId: string, task: TaskItem): void;
}
```

**Key issues:**
1. Workspace methods delegate to JSON file store (`this.legacy`)
2. Task methods delegate to JSON file store (`this.legacy`)
3. No full-CRUD lifecycle methods on Store interface
4. SqliteStore adds 50+ methods outside the Store interface

---

## 4. Existing Migration Logic

| Migration | Trigger | Description |
|---|---|---|
| `MigrationRunner` | Constructor/reopening | Applies registered, versioned migrations and records checksums |
| `ensureColumn()` | Constructor | Adds columns that didn't exist in original schema |
| `migrateLegacyWorkspaceAggregates()` | Constructor | Imports each legacy Workspace, its Provider Configurations, and Agent Profiles in one transaction without JSON write-back; skips only known canonical-path conflicts |
| `migrateLegacyAgentsWithinTransaction()` | Within each Workspace migration transaction | Creates and binds Provider Configurations for legacy agents; unknown database errors fail closed |
| `migrateAgentEventSequences()` | Constructor | Backfills sequence numbers and creates run_event_sequences |
| `migrateLegacyExecutionRuns()` | Constructor | Creates agent_runs for executions without run_id |
| `migrateConversationCollaboration()` | Constructor | Normalizes role_kind and sequence in conversation_members |

M2.3 correction: Workspace migration and Agent Profile projection are SQLite-first. Legacy JSON is read as migration/fallback input; Kimi normalization operates on an in-memory deep copy, and no active SqliteStore Workspace/Agent/Provider path writes `workspace/workspaces.json`. Tombstones are created by registered Migration 004.

**Key issues with current migrations:**
1. No version detection — all migrations run on every `migrateSchema()` call
2. No rollback support
3. No migration recording table
4. Data migrations are interleaved with schema creation
5. No integrity checks after migrations
