# Conversation Runtime CR-2 Schema Authorization Package — Frozen Design

Status: FROZEN DESIGN — RETROACTIVE RECORD — MIGRATION 021 IMPLEMENTED ON runtime/cr2-agent-turn

## 1. Authorization basis and scope

| Field | Value |
|---|---|
| Authoritative base | origin-https/main @ 1af40ebe (Merge PR #103, Workflow instantiation) |
| Entry audit | docs/implementation/milestones/CR-entry-audit.md |
| Contract source | packages/shared/src/types/cr0-conversation-contracts.ts (AGENT_TURN_STATUSES, isAgentTurnTerminal, MessageStreamCheckpointV1) |
| Product authority | docs/Runtime-Specification lite/09-Conversation-Runtime.md section 4.4 and 8 |
| Package kind | Schema authorization package: exact design freeze for the CR-2 additive migration |

> Honesty note: the migration was implemented on branch runtime/cr2-agent-turn before
> this package was written. This document retroactively records the frozen design that
> the implementation follows, matching the CR-1/MF-1/MF-2/MF-4 precedent. It does not
> expand scope beyond what is implemented.

## 2. Design constraints (frozen)

1. **Additive only.** Migrations 001-020 are immutable.
2. **No destructive rebuild.** destructive: false.
3. **No backfill.** Baseline conversation rows are never reinterpreted.
4. **Prerequisite fail-closed.** 021 requires the 020 schema; MIGRATION_PREREQUISITE_MISSING otherwise.
5. **Optimistic version.** Turn transitions require the exact expected version.
6. **Terminal one-way.** final/failed/cancelled set completed_at and never transition again.
7. **Checkpoint ordering.** (message_id, ordinal) and (turn_id, ordinal) are unique; ordinal starts at 1.
8. **Cursor resume.** cursor is monotonic per message; clients resume with cursor > last.
9. **No secret values.**
10. **Registry id rule.** 021 is the next and only valid id after 020.

## 3. Migration number

```text
Proposed migration number: 021
File name: 021-cr2-agent-turn-persistence.ts
Migration name: cr2-agent-turn-persistence
destructive: false
```

## 4. Resource inventory (exactly two resources)

| # | Resource | Purpose |
|---|---|---|
| 1 | cr_agent_turns (new table) | Bounded Agent response attempt with status/version/terminal fields. |
| 2 | cr_message_checkpoints (new table) | Ordered durable streaming deltas for resume. |

Plus supporting indexes. No other table, column, trigger, or object is created.

## 5. Exact schema

### 5.1 cr_agent_turns

```sql
CREATE TABLE IF NOT EXISTS cr_agent_turns (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL CHECK (length(agent_id) > 0),
  source_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN
    ('created','streaming','final','failed','cancelled')),
  failure_code TEXT,
  failure_message TEXT,
  context_snapshot_id TEXT,
  provider_session_id TEXT,
  task_id TEXT,
  run_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (source_message_id) REFERENCES cr_messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS cr_agent_turns_conversation
  ON cr_agent_turns (conversation_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS cr_agent_turns_workspace_agent
  ON cr_agent_turns (workspace_id, agent_id, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cr_agent_turns_id_workspace
  ON cr_agent_turns (id, workspace_id);
```

### 5.2 cr_message_checkpoints

```sql
CREATE TABLE IF NOT EXISTS cr_message_checkpoints (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  message_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  delta TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (message_id, ordinal),
  UNIQUE (turn_id, ordinal),
  FOREIGN KEY (message_id) REFERENCES cr_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES cr_agent_turns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cr_message_checkpoints_message
  ON cr_message_checkpoints (message_id, ordinal ASC);
CREATE INDEX IF NOT EXISTS cr_message_checkpoints_turn
  ON cr_message_checkpoints (turn_id, ordinal ASC);
```

### 5.3 Prerequisite guard

021 requires the 020 schema (cr_conversations, cr_messages). apply fails closed with a
stable MIGRATION_PREREQUISITE_MISSING error when either is absent, so a 021 success record
can never be written against an incomplete parent schema.

## 6. Cross-cutting frozen rules

| Topic | Frozen rule |
|---|---|
| Status | created -> streaming -> final/failed/cancelled; terminal is one-way. |
| Version | Optimistic; every transition increments. |
| Failure | failure_code/failure_message recorded with terminal failure. |
| Binding | context_snapshot_id/provider_session_id/task_id/run_id attach via COALESCE on transition. |
| Checkpoints | Append-only; unique ordinal per message and per turn; cursor monotonic. |
| Cascade | Conversation delete cascades turns/checkpoints; source message SET NULL. |
| Secrets | No secret value column. |
| Compatibility | Baseline 001-020 tables unchanged and readable. |

## 7. Operational boundary

| Topic | Frozen rule |
|---|---|
| Registry entry | 021 reserved here only. |
| Wiring | No service/route/UI authorized by this package. |
| Backfill | None. |

## 8. Future implementation allowlist (CR-2 only)

- apps/server/src/migrations/migrations/021-cr2-agent-turn-persistence.ts;
- one registry entry and registry-sequence assertion updates;
- AgentTurnRepository (create/find/list/transition with optimistic version; checkpoint append/list by message cursor and by turn);
- focused schema and repository tests.

CR-2 must not add streaming transport, Event projection, Task/Run bridge creation, group
orchestration, API routes, or UI.

## 9. Acceptance matrix (CR-2)

| Gate | Requirement |
|---|---|
| CR2-A1 | Fresh DB applies 001-021 in order. |
| CR2-A2 | Upgrade from 020 applies 021 additively with no data loss. |
| CR2-A3 | Prerequisite failure fails closed with no 021 record. |
| CR2-A4 | Status vocabulary enforced; invalid status rejected. |
| CR2-A5 | Optimistic version rejects stale transitions. |
| CR2-A6 | Terminal statuses set completed_at and are not transitionable. |
| CR2-A7 | Checkpoint ordinal unique per message and per turn. |
| CR2-A8 | Cursor resume returns checkpoints after a cursor with no gaps. |
| CR2-A9 | Migration 021 is idempotent and self-guarding. |
| CR2-A10 | No secret value is stored. |

## 10. Explicit prohibitions

- No edit to migrations 001-020 or their checksums.
- No destructive rebuild, no backfill, no legacy-row reinterpretation.
- No secret value storage.
- No streaming transport, Event projection, Task/Run bridge creation, group orchestration, API, or UI in CR-2.
