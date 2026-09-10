# Conversation Runtime CR-5 Schema Authorization Package — Frozen Design

Status: IMPLEMENTED IN WORKING TREE (UNCOMMITTED) — PENDING INDEPENDENT REVIEW AND MERGE

## Evidence

| Suite | Result |
|---|---|
| Migration 023 schema acceptance | 8/8 PASS (apps/server/src/migrations/__tests__/cr5-migration-023.test.ts) |
| Bounded group service | 17/17 PASS (apps/server/src/services/BoundedGroupService.test.ts) |

Both run over the working tree on top of commit `1218a23b`; the full Server suite
totals for this revision are recorded below after the frozen run completes.

## 1. Authorization basis and scope

| Field | Value |
|---|---|
| Authoritative base | origin-https/main @ b9c38aa4 + delivery commit 1218a23b (PR #106, CR-3 + CR-4) |
| Entry audit | docs/implementation/milestones/CR-entry-audit.md (slice CR-5) |
| Contract source | packages/shared/src/types/cr0-conversation-contracts.ts (GroupInteractionBudgetV1, validateGroupInteractionBudget, GROUP_STOP_REASONS, LOOP_GUARD_SIGNALS, MENTION_ALL, validateMentionTarget) |
| Product authority | docs/Runtime-Specification lite/09-Conversation-Runtime.md section 11 |
| Preceding slices | CR-3 + CR-4a + CR-4b (PR #106, pending review/merge) |
| Package kind | Schema authorization package: exact design freeze for the CR-5 additive migration 023 |

## 2. What exists today (read-only audit, exact lines)

| Fact | Evidence |
|---|---|
| Group budget contract exists as validation only (no durable state) | `cr0-conversation-contracts.ts:190-242` |
| Loop-guard signal vocabulary is frozen in contracts | `cr0-conversation-contracts.ts:257-263` |
| Stop reasons are frozen in contracts | `cr0-conversation-contracts.ts:244-251` |
| No group interaction table exists | audit: `rg group_interactions migrations` → no hits |
| The Agent Turn has a per-Turn context reference | `cr_agent_turns.context_snapshot_id` (migrations 021) |
| Memory Context Snapshots are Run-scoped (run_id NOT NULL) | `migrations/018:36` (`run_id TEXT NOT NULL`) |
| The selector already scopes retrieval by conversationId + agentId | `MemoryContextResolver.ts` ResolveRunMemoryContextInput; `MemoryRetrievalContext` |
| A chat-only Turn has no Run, so the Run-scoped snapshot cannot represent it | Lite section 4.4 (a chat Turn may have no Run) |
| Pre-spawn admission gate stays the only enforcement | `services/run-engine/RunEngineProviderDispatcher.ts:139` |
| Legacy group send has no budget or loop guard | audit: `rg budget ConversationService.ts` → no hits |

## 3. The one genuine design decision: per-Agent Memory Context

Lite section 11.5 requires an independently selected Memory Context per Agent in a
group Turn. The MF-4 snapshot store (migration 018) is keyed by Run
(`run_id NOT NULL`), and a chat-only group Turn has no Run. Widening 018 to make
`run_id` nullable requires a table rebuild (destructive — out of policy), so a
separate, additive, Turn-scoped snapshot is the only compliant path:

- 023 creates a Turn-scoped snapshot keyed by (conversation, interaction, agent,
  turn), NOT by Run. It records what one Agent Turn received, with budget and
  explainability, without touching 018.
- Selected Entry identities are stored as a JSON array in the snapshot header
  (explainability without a second detail table in this slice).

## 4. Migration number

```text
Proposed migration number: 023
File name: 023-cr5-bounded-group-persistence.ts
Migration name: cr5-bounded-group-persistence
destructive: false
```

## 5. Resource inventory (exactly three new tables)

| # | Resource | Purpose |
|---|---|---|
| 1 | cr_group_interactions | Frozen budget + live counters + stop/loop terminal state |
| 2 | cr_group_interaction_replies | Per-reply accounting, hop lineage, loop-guard evidence |
| 3 | cr_turn_context_snapshots | Turn-scoped per-Agent Memory Context selection header |

Prerequisite guard: 023 requires the 020 and 021 schema (`cr_conversations`,
`cr_messages`, `cr_agent_turns`); apply fails closed with
`MIGRATION_PREREQUISITE_MISSING` and records nothing on failure.

## 6. Exact schema

### 6.1 cr_group_interactions

```sql
CREATE TABLE IF NOT EXISTS cr_group_interactions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  max_agents_per_turn INTEGER NOT NULL CHECK (max_agents_per_turn >= 1),
  max_replies_per_agent INTEGER NOT NULL CHECK (max_replies_per_agent >= 1),
  max_total_replies INTEGER NOT NULL CHECK (max_total_replies >= 1),
  max_agent_hops INTEGER NOT NULL CHECK (max_agent_hops >= 0),
  timeout_ms INTEGER,
  context_token_budget INTEGER,
  reply_count INTEGER NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  hop_count INTEGER NOT NULL DEFAULT 0 CHECK (hop_count >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN
    ('active','stopped','exhausted','completed')),
  stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN
    ('budget-agents','budget-replies-per-agent','budget-total-replies','budget-hops',
     'budget-timeout','user-stop','loop-guard','completed')),
  loop_guard_signal TEXT CHECK (loop_guard_signal IS NULL OR loop_guard_signal IN
    ('same-agent-cycle','repeated-content','repeated-mention-no-new-information','hops-exceeded')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cr_group_interactions_conversation
  ON cr_group_interactions (conversation_id, status, created_at DESC);
```

### 6.2 cr_group_interaction_replies

```sql
CREATE TABLE IF NOT EXISTS cr_group_interaction_replies (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  interaction_id TEXT NOT NULL,
  agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
  message_id TEXT NOT NULL,
  turn_id TEXT,
  content_hash TEXT NOT NULL CHECK (length(content_hash) > 0),
  mention_targets_json TEXT CHECK (mention_targets_json IS NULL OR json_valid(mention_targets_json)),
  hop_from_agent_id TEXT,
  hop_order INTEGER NOT NULL DEFAULT 0 CHECK (hop_order >= 0),
  context_snapshot_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (interaction_id) REFERENCES cr_group_interactions(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES cr_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cr_group_interaction_replies_interaction_agent
  ON cr_group_interaction_replies (interaction_id, agent_id, created_at ASC);
CREATE INDEX IF NOT EXISTS cr_group_interaction_replies_interaction_hash
  ON cr_group_interaction_replies (interaction_id, content_hash);
```

### 6.3 cr_turn_context_snapshots

```sql
CREATE TABLE IF NOT EXISTS cr_turn_context_snapshots (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  conversation_id TEXT NOT NULL,
  interaction_id TEXT,
  agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
  turn_id TEXT,
  budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
  selected_entry_ids_json TEXT NOT NULL CHECK (json_valid(selected_entry_ids_json)),
  total_tokens INTEGER NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  query_hash TEXT,
  retrieval_strategy_version TEXT NOT NULL CHECK (length(retrieval_strategy_version) > 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (interaction_id) REFERENCES cr_group_interactions(id) ON DELETE SET NULL,
  FOREIGN KEY (turn_id) REFERENCES cr_agent_turns(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS cr_turn_context_snapshots_turn
  ON cr_turn_context_snapshots (conversation_id, agent_id, created_at DESC);
```

## 7. Frozen rules

| Topic | Frozen rule |
|---|---|
| Budget | Frozen at creation from a validated `GroupInteractionBudgetV1`; never editable. |
| Accounting | reply_count and hop_count increment transactionally with each recorded reply; a budget check that would be exceeded ends the interaction with a stable reason BEFORE the reply is recorded. |
| Stop | `stopped` blocks new replies; it never cancels a Run (a Run cancel is a separate request to the Process Runtime). |
| Loop guard | a recorded signal (same-agent-cycle, repeated-content, repeated-mention-no-new-information, hops-exceeded) terminates the interaction with `loop-guard` / the matched budget reason. Detection is over the durable reply history of the interaction. |
| Per-Agent context | each recorded reply resolves an isolated context via the selector with (conversationId, agentId) scope and records its own Turn-scoped snapshot; no Agent receives the raw transcript. |
| @all | never authorizes parallel modifying Runs (admission is unchanged and untouched). |
| No schema edits | 001-022 are immutable; 023 adds exactly three tables plus their indexes; no backfill. |
| Secrets | no secret value is stored; content_hash is a SHA-256 of the reply text. |

## 8. Implementation allowlist (CR-5 only)

- `apps/server/src/migrations/migrations/023-cr5-bounded-group-persistence.ts` + registry entry;
- `apps/server/src/store/GroupInteractionRepository.ts` (interaction + reply rows);
- `apps/server/src/services/BoundedGroupService.ts` (create, recordReply with budget and loop-guard checks, stop, per-Agent context resolution);
- focused schema, repository, and service tests.

CR-5 must not add routes, transport, UI, or admission changes, and must not change the
legacy group send path.

## 9. Acceptance matrix (CR-5)

| Gate | Requirement |
|---|---|
| CR5-A1 | Fresh DB applies 001-023 in order; upgrade from 022 is additive. |
| CR5-A2 | Missing prerequisites fail closed with no 023 record; 023 is idempotent. |
| CR5-A3 | A valid budget creates an active interaction; an invalid budget fails closed. |
| CR5-A4 | Recording replies increments counters transactionally. |
| CR5-A5 | Reaching a budget limit ends the interaction with the matching stable reason before recording. |
| CR5-A6 | Stop blocks new replies and never cancels a Run. |
| CR5-A7 | A same-Agent cycle terminates the interaction with `loop-guard`. |
| CR5-A8 | A repeated-content reply terminates the interaction. |
| CR5-A9 | Hops beyond the configured limit terminate the interaction. |
| CR5-A10 | Each reply records a distinct, Turn-scoped per-Agent context snapshot. |
| CR5-A11 | Per-Agent snapshots are isolated: one Agent's selected Entries never appear under another Agent's snapshot for the same interaction. |
| CR5-A12 | No secret value is stored; the content column never appears in the replies table (hash only). |

## 10. Open decisions requiring owner authorization

1. **Migration number 023** and the three-table resource inventory.
2. **Per-Agent snapshot shape**: header-only with `selected_entry_ids_json`
   (recommended for this slice) versus a full entries-detail table (mirroring 018) —
   deferred detail is a later additive migration.
3. **Repeated-mention detection threshold**: the frozen default counts a mention of the
   same Agent with a byte-identical normalized reply as `no new information`; a
   stricter semantic duplicate check is a follow-up.

## 11. Explicit prohibitions

- No edit to migrations 001-022 or their checksums; no table rebuild.
- No infinite autonomous group chat; every interaction must be bounded and terminable.
- No admission changes; @all never authorizes parallel modification.
- No secret values; reply content is stored as a hash only in the replies table.
- No route, transport, UI, or legacy-path change.
