# Conversation Runtime — Entry Audit and Scope Boundary

Status: ENTRY AUDIT — EVIDENCE-BASED — CONVERSATION RUNTIME NOT STARTED — NO SCHEMA, MIGRATION, API, OR BEHAVIOR CHANGE AUTHORIZED BY THIS DOCUMENT

## 1. Metadata / exact baseline

| Field | Evidence |
|---|---|
| Repository | `Zbyy0311/agentos` |
| Audit base | `origin-https/main @ c34c2a9c` (Merge PR #93) |
| Migration ledger | `001`–`019` present; `020` absent |
| Prior gates | Workspace single-writer COMPLETE; Recovery closeout COMPLETE; Memory Foundation MF-0..MF-4 + MF-5 events/emission/Run-injection MERGED |
| Product authority | `docs/Runtime-Specification lite/09-Conversation-Runtime.md` |
| Method | Read-only inspection of the exact base tree; Lite contract reconciled against current code; no source, schema, API, UI, or test change |

This document is an audit and scope boundary. It changes no production code,
no schema, no migration registry, no API, and no behavior.

## 2. Authority

Per `00-Vision.md` §13 and `13-Runtime-Inspector.md`, **Conversation Runtime**
is the next ACTIVE LITE Fast-Track step after Memory Foundation. The Lite
contract is authoritative for forward scope; existing conversation code remains
**COMPATIBILITY** where callers depend on it.

`09-Conversation-Runtime.md` §2.2 states:

> existing Conversation routes, services, runners, UI paths, fields, and
> projections remain where callers depend on them ... This document does not
> claim those compatibility paths satisfy the forward Lite contract without
> independent evidence.

## 3. Current-State Inventory

Status vocabulary: IMPLEMENTED / PARTIAL / LEGACY / MISSING / CONFLICTING.

### 3.1 Persistence (baseline compatibility)

Migration `001` creates:

- `conversations` (`conversation_type IN ('direct','group')`, `agent_id`,
  `model`, `thinking_effort`, `dispatch_mode`);
- `conversation_members` (`agent_id`, `role_title`, `is_leader`, `role_kind`,
  `sequence`);
- `messages` (`sender_type IN ('user','agent','system')`, `sender_agent_id`,
  `run_id`, `content`);
- `message_attachments`.

Missing vs Lite §4:

- **Conversation**: `status` (active/archived), `reply_policy`,
  `last_message_id`/`last_message_at`, `version`, and a `system` type
  (baseline allows only `direct`/`group`).
- **Member**: immutable membership ID, `user` type, display-name snapshot,
  `owner`/`participant`/`observer`/`orchestrator`/`reviewer` roles,
  reply modes, `muted`/`removed` status, join/remove timestamps, `version`.
- **Message**: unique increasing Conversation `sequence`, `client_message_id`
  idempotency, `draft`/`streaming`/`final`/`failed`/`edited`/`deleted` status,
  revisions, `source_event_id`, `task_id`, sanitized Markdown flag, `version`.
- **Agent Turn** and streaming checkpoint records: **MISSING**.
- **Revisions**: **MISSING**.
- **Idempotent Event projection rows**: **MISSING** (no `sourceEventId`
  dedup table).

### 3.2 Services

- **LEGACY/PARTIAL**: `ConversationService` implements direct and group
  send/resume over legacy `agent_runs`/`executions`, with SSE streaming and
  run-step projection.
- **LEGACY**: `packages/agent-core/src/conversationRunner.ts`.
- **MISSING**: durable Agent Turn records; ordered streaming checkpoints with a
  durable cursor; client idempotency (`clientMessageId`); Message revisions;
  bounded Group budgets/loop guard as first-class durable state; per-Agent
  isolated Memory Context (the MF-4 resolver is wired to canonical Runs, not
  to Conversation Turns).

### 3.3 API

- **PARTIAL/LEGACY**: `routes/conversations.ts` exposes list/create/patch,
  members, messages, stream, resume-stream, cancel, decisions. It is
  conversation- and `agent_run`-oriented.
- **MISSING** vs Lite §10: `POST /api/conversations/:id/archive`,
  `POST /api/conversations/:id/restore`, `GET /api/conversations/:id/turns`,
  `POST /api/messages/:messageId/create-task`,
  `POST /api/messages/:messageId/start-run`.

### 3.4 Events

- **PARTIAL**: legacy `agent_events` include `conversation.message.created`.
- **MISSING**: canonical Runtime Event projection with `sourceEventId`
  deduplication; the Lite Conversation bridge family (`09` §10, `03` §11.4).

### 3.5 UI

- **LEGACY**: `apps/web/src/components/chat/` history/context-menu,
  `lib/conversationActions.ts`, `lib/conversationSelection.ts`.
- **MISSING**: the four-column workbench, Composer Chat/Task/Run modes,
  bounded Group controls, Memory explanation — these belong to later
  UI/Conversation slices.

### 3.6 Tests

- Existing conversation tests target legacy behavior.
- **MISSING**: every Lite §18 acceptance expectation that depends on the
  forward model (sequence allocation, client idempotency, revision history,
  durable streaming finalization, Event projection dedup, archive
  non-cascade, bounded group budgets/stop/loop guard).

## 4. Gap Summary

| Lite requirement (`09-Conversation-Runtime.md`) | Current state |
|---|---|
| Durable Conversation with status/reply policy/version | MISSING (legacy shape) |
| Member with identity, roles, reply mode, status | PARTIAL (agent-only) |
| Ordered Message with unique sequence + client idempotency | MISSING |
| Message revisions | MISSING |
| Agent Turn records | MISSING |
| Streaming checkpoints + durable reconnect cursor | PARTIAL (in-memory/legacy) |
| Explicit Task/Run bridge endpoints | MISSING |
| Idempotent Runtime Event projection | MISSING |
| Bounded Group budgets/stop/loop guard as durable state | PARTIAL |
| Archive/restore without cascade | MISSING |
| Unified Agent History references | MISSING |

## 5. Risks and Constraints

1. **No destructive simplification.** Baseline conversation tables and their
   consumers must remain readable; evolution must be additive.
2. **Legacy aggregate boundary.** `ConversationService` operates on
   `agent_runs`, not canonical `runs`. The forward Conversation Runtime must
   not silently rewrite that boundary; canonical bridging is a separate,
   reviewed decision.
3. **Sequence allocation** must be transactional and never reused.
4. **Idempotency** must converge a repeated client send on one Message.
5. **Archive never cascades** to Tasks, Runs, Memory, or Artifacts.
6. **Secrets** never enter Messages, cards, Events, or search.
7. **Migration authorization.** A new migration number is not authorized by
   this audit; it requires a separate reviewed schema-authorization package.

## 6. Proposed Entry Slices (not authorized by this document)

```text
CR-0  Contracts + schema authorization  (shared types, migration design, review)
CR-1  Forward Conversation/Member/Message persistence (additive, sequence + idempotency)
CR-2  Message revisions + Agent Turn records
CR-3  Durable streaming checkpoints + reconnect cursor
CR-4  Explicit Task/Run bridge + idempotent Event projection
CR-5  Bounded Group budgets/stop/loop guard + per-Agent context
CR-6  Archive/restore + history references
```

Each slice requires its own acceptance evidence and independent review.

## 7. Entry Gate (exit criteria for this audit)

- Current state established from the exact base SHA, not the specification.
- Gap inventory mapped to the Lite Conversation contract.
- Risks and compatibility constraints recorded.
- No production, schema, API, UI, or test change made.
- Next action is a separately reviewed contracts + schema-authorization package.

## 8. Evidence Index

| Finding | File |
|---|---|
| Baseline conversation tables | `apps/server/src/migrations/migrations/001-baseline-schema.ts:35-83` |
| Legacy Conversation/Member/Message types | `packages/shared/src/types/index.ts:168-218` |
| Legacy ConversationService | `apps/server/src/services/ConversationService.ts` |
| Legacy conversation routes | `apps/server/src/routes/conversations.ts` |
| Legacy runner | `packages/agent-core/src/conversationRunner.ts` |
| Web conversation components | `apps/web/src/components/chat/`, `apps/web/src/lib/conversationActions.ts` |
| Migration ledger 001–019, 020 absent | `apps/server/src/migrations/default-registry.ts` |
| MF-4 resolver wired to canonical Runs | `apps/server/src/services/MemoryContextResolver.ts`, `services/run-engine/providerExecutionChain.ts` |
