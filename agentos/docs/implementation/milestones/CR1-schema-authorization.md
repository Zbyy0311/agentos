# Conversation Runtime CR-1 Schema Authorization Package — Frozen Design

Status: FROZEN DESIGN — DOCS ONLY — NO MIGRATION FILE — NO REGISTRY ENTRY — NO CHECKSUM — IMPLEMENTATION NOT AUTHORIZED

## 1. Authorization basis and scope

| Field | Value |
|---|---|
| Authoritative base | `origin-https/main @ ba417362` (Merge PR #95, CR-0 contracts) |
| Entry audit | `docs/implementation/milestones/CR-entry-audit.md` |
| Contract source | `packages/shared/src/types/cr0-conversation-contracts.ts` (CR-0, merged) |
| Product authority | `docs/Runtime-Specification lite/09-Conversation-Runtime.md` §4, §7 |
| Package kind | Schema authorization package: exact design freeze for a future additive migration |

This package prepares **only** the CR-1 schema design. It does not authorize a
migration file, a registry entry, a checksum, a repository, a service, an API,
or any production behavior.

## 2. Design constraints (frozen)

1. **Additive only.** Migrations `001`–`019` are immutable.
2. **No destructive rebuild.** `destructive: false`.
3. **No backfill.** Baseline `conversations`/`conversation_members`/`messages`
   rows are never reinterpreted.
4. **Baseline compatibility.** The 001 conversation tables remain readable and
   are **COMPATIBILITY**, not the forward model.
5. **Legacy boundary untouched.** The forward tables do not alter the legacy
   `agent_runs` conversation path.
6. **Transactional sequence.** Message `sequence` is allocated transactionally
   and never reused.
7. **Client idempotency.** A repeated `clientMessageId` converges on one row.
8. **No secret values.**
9. **Registry id rule.** `020` is the next and only valid id after `019`.

## 3. Proposed migration number

```text
Proposed migration number: 020
Proposed file name (future): 020-cr1-conversation-runtime-persistence.ts
Proposed migration name (future): cr1-conversation-runtime-persistence
Proposed destructive flag: false
```

## 4. Resource inventory (exactly four resources)

| # | Resource | Purpose |
|---|---|---|
| 1 | `cr_conversations` (new table) | Forward Conversation with status/reply policy/version. |
| 2 | `cr_conversation_members` (new table) | Forward Member with identity, role, reply mode, status. |
| 3 | `cr_messages` (new table) | Forward Message with unique sequence and client idempotency. |
| 4 | `cr_message_revisions` (new table) | Append-only Message edit history. |

Plus supporting indexes and a sequence-allocation guard. No other table,
column, or object is created.

**Rationale for new tables.** Baseline `conversations`/`messages` lack status,
reply policy, version, unique Conversation sequence, and client idempotency, and
are consumed by `ConversationService`, `routes/conversations.ts`, and the web
chat components. A separate `cr_` namespace keeps the forward model canonical
and additive without risking those callers.

## 5. Exact schema

### 5.1 `cr_conversations`

```sql
CREATE TABLE IF NOT EXISTS cr_conversations (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  kind TEXT NOT NULL CHECK (kind IN ('direct','group','system')),
  title TEXT NOT NULL CHECK (length(title) > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  reply_mode TEXT CHECK (reply_mode IN
    ('sequential','parallel-read-only','orchestrated','manual','mention-only')),
  last_message_id TEXT,
  last_message_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  -- direct requires no reply_mode; group/system may declare one.
  CHECK (kind <> 'direct' OR reply_mode IS NULL),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cr_conversations_workspace_status
  ON cr_conversations (workspace_id, status, updated_at DESC, id);

CREATE UNIQUE INDEX IF NOT EXISTS cr_conversations_id_workspace
  ON cr_conversations (id, workspace_id);
```

### 5.2 `cr_conversation_members`

```sql
CREATE TABLE IF NOT EXISTS cr_conversation_members (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('user','agent')),
  subject_id TEXT NOT NULL CHECK (length(subject_id) > 0),
  display_name_snapshot TEXT NOT NULL CHECK (length(display_name_snapshot) > 0),
  role TEXT NOT NULL CHECK (role IN
    ('owner','participant','observer','orchestrator','reviewer')),
  reply_mode TEXT NOT NULL CHECK (reply_mode IN
    ('always','mentioned','orchestrated','manual','never')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','muted','removed')),
  joined_at TEXT NOT NULL,
  removed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (conversation_id, subject_type, subject_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cr_conversation_members_conversation
  ON cr_conversation_members (conversation_id, status, role);
```

### 5.3 `cr_messages`

```sql
CREATE TABLE IF NOT EXISTS cr_messages (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user','agent','system')),
  sender_agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN
    ('text','task-reference','run-reference','status','approval','artifact','error','system-notice')),
  status TEXT NOT NULL CHECK (status IN
    ('draft','streaming','final','failed','edited','deleted')),
  content TEXT NOT NULL DEFAULT '',
  client_message_id TEXT,
  task_id TEXT,
  run_id TEXT,
  source_event_id TEXT,
  reply_to_message_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Agent messages identify an Agent Profile.
  CHECK (sender_type <> 'agent' OR sender_agent_id IS NOT NULL),
  -- client idempotency is scoped to the Conversation.
  UNIQUE (conversation_id, sequence),
  UNIQUE (conversation_id, client_message_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES cr_conversations(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (reply_to_message_id) REFERENCES cr_messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS cr_messages_conversation_sequence
  ON cr_messages (conversation_id, sequence ASC);

CREATE INDEX IF NOT EXISTS cr_messages_source_event
  ON cr_messages (source_event_id)
  WHERE source_event_id IS NOT NULL;
```

Notes:

- `sequence` is allocated per Conversation inside the writing transaction; the
  unique index is the last-resort fence.
- `UNIQUE (conversation_id, client_message_id)` makes a repeated client send
  converge on one row (`client_message_id` NULL rows are exempt in SQLite).
- `source_event_id` supports idempotent Event projection (one card per Event).
- `sender_agent_id` binds a durable Agent Profile, never a Provider name.

### 5.4 `cr_message_revisions`

```sql
CREATE TABLE IF NOT EXISTS cr_message_revisions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content TEXT NOT NULL,
  edited_at TEXT NOT NULL,
  UNIQUE (message_id, revision),
  FOREIGN KEY (message_id) REFERENCES cr_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cr_message_revisions_message
  ON cr_message_revisions (message_id, revision ASC);
```

Edits append a revision; the Message is never rewritten in place without a
revision record.

### 5.5 Immutability / guards

```sql
CREATE TRIGGER IF NOT EXISTS cr_messages_identity_immutable
BEFORE UPDATE ON cr_messages
WHEN NEW.id IS NOT OLD.id
  OR NEW.conversation_id IS NOT OLD.conversation_id
  OR NEW.sequence IS NOT OLD.sequence
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'CR_MESSAGE_IDENTITY_IMMUTABLE');
END;
```

- Message identity, Conversation, `sequence`, and `created_at` are immutable.
- No hard-delete trigger: `status = 'deleted'` is the soft delete, and archive
  never cascades.

### 5.6 Prerequisite guard

Migration 020 requires the 019 schema. `apply` fails closed with a stable
`MIGRATION_PREREQUISITE_MISSING` error when `workspaces` or `cr_conversations`'s
prerequisite set is absent, so a 020 success record can never be written
against an incomplete parent schema.

## 6. Cross-cutting frozen rules

| Topic | Frozen rule |
|---|---|
| Sequence | Per-Conversation, transactional, never reused. |
| Client idempotency | `(conversation_id, client_message_id)` converges on one Message. |
| Revisions | Edits append; history is preserved. |
| Identity | Message id/conversation/sequence/created_at immutable. |
| Archive | Sets status; never cascades to Tasks/Runs/Memory/Artifacts/Events. |
| Sender | Agent messages bind a durable Agent Profile ID. |
| Secrets | No secret value column. |
| Compatibility | Baseline conversation tables unchanged and readable. |
| Legacy path | `agent_runs` conversation behavior is untouched. |

## 7. Operational boundary

| Topic | Frozen rule |
|---|---|
| Migration file | Not created by this package. |
| Registry entry | Not created; `020` reserved here only. |
| Wiring | No repository/service/route/UI is authorized by this package. |
| Backfill | None. |

## 8. Future implementation allowlist (CR-1 only)

- `apps/server/src/migrations/migrations/020-cr1-conversation-runtime-persistence.ts`;
- one registry entry and registry-sequence assertion updates;
- `ConversationRepository` (create/read/archive/restore, member management,
  transactional Message sequence + client idempotency, revision append);
- focused schema and repository tests.

CR-1 must not add streaming, Event projection, Task/Run bridge, group
orchestration, API, or UI.

## 9. Future acceptance matrix (CR-1)

| Gate | Requirement |
|---|---|
| CR1-A1 | Fresh DB applies 001–020 in order. |
| CR1-A2 | Upgrade from 019 applies 020 additively with no data loss. |
| CR1-A3 | Prerequisite failure fails closed with no 020 record. |
| CR1-A4 | Kind/status/reply-mode vocabularies enforced. |
| CR1-A5 | Direct Conversation rejects a reply mode. |
| CR1-A6 | Member identity is unique per Conversation and binds subject type. |
| CR1-A7 | Message sequence is unique per Conversation and never reused. |
| CR1-A8 | Repeated `clientMessageId` converges on one Message. |
| CR1-A9 | Agent Message without `sender_agent_id` rejected. |
| CR1-A10 | Message identity/sequence/created_at immutable. |
| CR1-A11 | Revision append preserves history; unique `(message, revision)`. |
| CR1-A12 | Archive sets status without cascade; restore is one-way. |
| CR1-A13 | Baseline conversation tables remain readable and untouched. |
| CR1-A14 | No secret value is stored. |
| CR1-A15 | Migration 020 is idempotent and self-guarding. |

## 10. Explicit prohibitions

- No edit to migrations `001`–`019` or their checksums.
- No destructive rebuild, no backfill, no legacy-row reinterpretation.
- No change to the legacy `agent_runs` conversation path.
- No secret value storage.
- No streaming, projection, bridge, group orchestration, API, or UI in CR-1.
