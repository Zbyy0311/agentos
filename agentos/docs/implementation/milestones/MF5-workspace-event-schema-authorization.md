# Memory Foundation MF-5 Workspace Event Stream — Schema Authorization Package

Status: FROZEN DESIGN — DOCS ONLY — NO MIGRATION FILE — NO REGISTRY ENTRY — NO CHECKSUM — IMPLEMENTATION NOT AUTHORIZED

## 1. Authorization basis and scope

| Field | Value |
|---|---|
| Authoritative base | `origin-https/main @ 800d6dd2` (Merge PR #125) plus the PR #126 branch head `ec594187` for the Run-scoped emission seams |
| Gap record | `MF-event-integration-audit.md` item 5; `MF-progress.md` §6 "Known contract gap"; `Lite-FastTrack-progress.md` §5 |
| Prior packages | `MF1-schema-authorization.md` (017), `MF2-schema-authorization.md` (019), `MF4-schema-authorization.md` (018) |
| Contract source | `packages/shared/src/types/mf5-memory-events.ts`, `packages/shared/src/types/m3-runtime.ts` |
| Product authority | `docs/Runtime-Specification lite/03-Event-Model.md` §5, §7, §8, §15, §16, §17; `07-Memory-Runtime.md` §7, §15, §16 |
| Package kind | Schema authorization package: exact design freeze for a future additive migration 025 plus the shared contract additions it requires |

This package prepares **only** the Workspace Event stream design. It does not
authorize a migration file, a registry entry, a checksum, a repository, a
service, a route change, or any production behavior. Implementation requires a
separate entry authorization plus independent schema/security review.

## 2. Problem statement (source evidence)

The Lite Memory event family is emitted only where a Run exists. Two
Workspace-only **Memory Foundation** write paths commit facts with **no**
canonical Event:

| Path | Location | Fact written |
|---|---|---|
| Candidate review | `apps/server/src/routes/memoryRuntime.ts:242` | `memory_candidate_entries` outcome/version/reviewed_at |
| Conflict resolution | `apps/server/src/routes/memoryRuntime.ts:266` | `memory_conflicts` disposition/resolution plus Entry status effects |

Both routes construct the store-level repository without a
`MemoryRuntimeEventEmitter` (`apps/server/src/routes/memoryRuntime.ts:143`),
because the Run-scoped writer cannot describe them. The canonical Event
persistence path structurally requires a Run:

| Frozen constraint | Evidence |
|---|---|
| `runtime_events.run_id TEXT NOT NULL` | `apps/server/src/migrations/migrations/012-m3-runtime-schema.ts:94,100` |
| `runtime_events UNIQUE(run_id, sequence)` | `012-m3-runtime-schema.ts:123` |
| `runtime_events.workspace_id` → `workspaces(id) ON DELETE RESTRICT` | `012-m3-runtime-schema.ts:124` |
| `operations.run_id TEXT NOT NULL` | `012-m3-runtime-schema.ts:160` |
| `operations.aggregate_type = 'run'`, type whitelist, `CHECK (aggregate_id = run_id)` | `012-m3-runtime-schema.ts:154,158,169` |
| `outbox_messages.aggregate_type = 'run'`, FK `aggregate_id` → `runs(id)` | `012-m3-runtime-schema.ts:194,209` |
| Run sequence allocation mutates `runs.next_event_sequence` | `apps/server/src/store/RunSequenceAllocator.ts:39,41`; column from `006-runs-table.ts:21` |

Product authority for the separation:

- `03-Event-Model.md:105` — `workspaceId`, `runId`, `sequence`, and
  `timestamp` are required for Run-scoped Events.
- `03-Event-Model.md:116` — "System facts with no Run belong in a separate
  System Event stream or audit store; they do not use a fabricated `runId`."

### 2.1 The legacy candidate surface is a different table family (out of scope)

The two `memory-candidates` routes are **not** part of this problem, and are
explicitly out of scope for this package and for migration 025:

| Route | Real path | Tables actually written |
|---|---|---|
| Accept | `memoryCandidates.ts:41` -> `MemoryCandidateService.accept` (`MemoryCandidateService.ts:85`) | `memories` via `MemoryService.create` (`MemoryService.ts:64`) -> `SqliteStore.createMemory` (`SqliteStore.ts:2021`), then `updateMemoryCandidateStatus` (`SqliteStore.ts:2412`) |
| Reject | `memoryCandidates.ts:58` -> `MemoryCandidateService.reject` (`MemoryCandidateService.ts:103`) | `updateMemoryCandidateStatus` (`SqliteStore.ts:2412`) |

These are the **legacy** `memories` / `memory_candidates` tables, not the
Memory Foundation tables `memory_entries` (017) and
`memory_candidate_entries` (019). Consequences:

- They write no Memory Foundation row, so they are not Migration-025 facts;
- Wiring them to this stream would require a separate rewrite authorization;
- `routes/memories.ts:21,40,52` -> `MemoryService.ts:64,92,110` also write the
  legacy tables directly and are equally out of scope.

### 2.2 Precedent for refusing to fabricate a Run

Git Observation MODE A
(`WORKSPACE_ONLY`) persists the observation and returns
`eventsCreated: 0, outboxRowsCreated: 0`
(`apps/server/src/services/GitObservationPersistenceService.ts:201,211`).

Reusing an unrelated Run as the actor of a later user review is forbidden by
`MF-event-integration-audit.md` item 5; reusing `operations` is impossible
because of the frozen CHECKs above.

## 3. Design constraints (frozen)

1. **Additive only.** Migrations `001`–`024` are immutable.
2. **No destructive rebuild.** `destructive: false`; `runtime_events`,
   `operations`, `outbox_messages`, and `workspaces` are never rebuilt.
3. **No weakening of Run checks.** The Run path keeps `RuntimeEventRepository`
   and its authority unchanged. The Workspace stream has no column able to hold
   `runId`, `taskId`, `stageId`, `processId`, `providerSessionId`, or
   `approvalRequestId`, so a Run-bound fact cannot be written into it.
4. **No fabricated actor.** v1 carries no `agentId`: no durable Memory row
   records who reviewed or resolved (`memory_candidate_entries` has no
   `reviewed_by`; `MemoryCandidateRepository.ts:304,329`). Actor attribution
   requires a durable actor column first and is a separate authorization.
5. **Stream allowlist.** Only registered types listed in the frozen v1 set of
   §7.3 may be appended; anything else fails closed.
6. **Atomicity.** A Memory fact and every Event derived from it commit in one
   transaction or not at all.
7. **Append-only history.** Updates and deletes are rejected by trigger;
   corrections append new Events (`03-Event-Model.md` §16).
8. **No Outbox and no publication in v1.** No Workspace-scoped consumer or
   topic exists, so a permanently pending Outbox row would be dead weight and a
   fake `aggregate_type` is impossible. This stream is durable history only;
   streaming/SSE/Inspector projection is deferred (§15).
9. **Registry id rule.** `025` is the next and only valid id after `024`.

## 4. Proposed migration number

```text
Proposed migration number: 025
Proposed file name (future): 025-mf5-workspace-event-stream.ts
Proposed migration name (future): mf5-workspace-event-stream
Proposed destructive flag: false
```

## 5. Resource inventory (exactly one column and one table)

| # | Resource | Purpose |
|---|---|---|
| 1 | `workspaces.next_event_sequence` (new column) | Transaction-safe per-Workspace sequence allocator. |
| 2 | `workspace_events` (new table) | Run-less canonical Event history for user-initiated Workspace facts. |

Plus two indexes and two append-only triggers. No other table, column, or
object is created; no existing DDL text is edited.

## 6. Exact schema

### 6.1 `workspaces.next_event_sequence` and the allocation rule

```sql
ALTER TABLE workspaces ADD COLUMN next_event_sequence INTEGER NOT NULL DEFAULT 1
```

Allocation mirrors the canonical Run allocator and must run inside the caller's
transaction:

```sql
UPDATE workspaces
SET next_event_sequence = next_event_sequence + 1
WHERE id = ?
RETURNING next_event_sequence - 1 AS sequence
```

The Workspace allocator must reproduce **every** semantic
`RunSequenceAllocator.allocateWithinTransaction` carries, not only the
statement:

| Run allocator semantic | Location | Workspace mirror |
|---|---|---|
| `workspaceId`/`runId` non-blank input validation, `RUN_SEQUENCE_VALIDATION_FAILED` | `RunSequenceAllocator.ts:30-35` | same, for `workspaceId` |
| Row-not-found branch: `if (!row) throw new RunNotFoundError(runId)` | `RunSequenceAllocator.ts:43` | `WorkspaceNotFoundError`/equivalent |
| bigint normalization plus `Number.isSafeInteger(sequence) && sequence >= 1`, `RUN_SEQUENCE_INVALID` | `RunSequenceAllocator.ts:45-51` | same guard, Workspace error code |

Notes:

- The column lives on the owning aggregate row, exactly like
  `runs.next_event_sequence` (`006-runs-table.ts:21`,
  `RunSequenceAllocator.ts:39`). The rejected alternative — a dedicated
  `workspace_event_sequences` table — would reintroduce the legacy M2 shape
  (`001-baseline-schema.ts:193`) and would add a second row to keep in sync;
  the Run allocator's row-not-found branch (`RunSequenceAllocator.ts:43`) is
  preserved as the Workspace equivalent above.
- The statement must not touch `workspaces.version`, so Workspace optimistic
  concurrency (`WorkspaceRepository.ts:147-165`) is unaffected.
- Sequences are allocated only when an Event is actually appended; a rolled
  back transaction returns the counter, so no gap is fabricated
  (`03-Event-Model.md` §7.1, §17).

### 6.2 `workspace_events`

```sql
CREATE TABLE IF NOT EXISTS workspace_events (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  type TEXT NOT NULL CHECK (type <> ''),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source <> ''),
  correlation_id TEXT NOT NULL CHECK (correlation_id <> ''),
  causation_id TEXT NOT NULL CHECK (causation_id <> ''),
  parent_event_id TEXT,
  severity TEXT NOT NULL CHECK (severity <> ''),
  visibility TEXT NOT NULL CHECK (visibility <> ''),
  durability TEXT NOT NULL CHECK (durability <> ''),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, sequence),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);
```

Notes:

- The column **names** follow `runtime_events` so both streams read the same
  way, but this table is deliberately **stricter**, and it is not a byte-level
  mirror: `runtime_events.id` and `.workspace_id` carry no length CHECK
  (`012-m3-runtime-schema.ts:95,98`) and `runtime_events.causation_id` is
  nullable (`012-m3-runtime-schema.ts:115`), whereas all three are constrained
  here. The Run-bound reference columns are deliberately absent.
- `runtime_events` cannot read this table even for the shared columns: the Run
  reader requires a non-empty `runId` (`m3-runtime-registry.ts:503`;
  `RuntimeEventRepository.ts:465,684`). A Workspace-side reader is therefore
  required and is covered by §12; no existing Run reader is claimed to work.
- `causation_id` is `NOT NULL` here: a Workspace Event always has a proven
  durable cause (§8), whereas the Run stream allows a NULL causation.
- The Workspace FK is `RESTRICT`, matching `runtime_events`
  (`012-m3-runtime-schema.ts:124`) and the P6-L1B "frozen safety FKs remain
  restrictive" rule; the explicit delete path is frozen in §6.5.

### 6.3 Indexes and append-only triggers

```sql
CREATE INDEX IF NOT EXISTS workspace_events_workspace_sequence
  ON workspace_events (workspace_id, sequence);

CREATE INDEX IF NOT EXISTS workspace_events_correlation
  ON workspace_events (workspace_id, correlation_id, sequence);

CREATE TRIGGER IF NOT EXISTS workspace_events_reject_update
BEFORE UPDATE ON workspace_events
BEGIN
  SELECT RAISE(ABORT, 'WORKSPACE_EVENT_APPEND_ONLY');
END;
```

**Exactly one trigger.** Unlike `runtime_events`, this stream deliberately does
**not** carry a `BEFORE DELETE` abort trigger. That is a measured decision, not
an omission: a delete guard and the required Workspace hard-delete (§6.5) are
mutually exclusive under both FK modes.

| Configuration | `DELETE FROM workspace_events` | `DELETE FROM workspaces` |
|---|---|---|
| `RESTRICT` + abort trigger | blocked by trigger | blocked by trigger |
| `CASCADE` + abort trigger | blocked by trigger | **blocked by trigger** |
| `CASCADE`, no trigger | allowed | allowed (events removed by cascade) |
| `RESTRICT`, no trigger (chosen) | allowed | allowed once events are removed first (§6.5) |

Measured with `node:sqlite` on 2026-09-11: a `BEFORE DELETE` abort trigger on
a child table fires for FK cascade deletes as well, so the `runtime_events`
shape (RESTRICT FK + reject-delete trigger) can never satisfy a delete path that
is required to succeed. Immutability is therefore enforced by the update
trigger plus the single sanctioned delete path; delete protection is a
construction property (`§10`), not a trigger property.

### 6.4 Idempotency and prerequisite guard

- `apply` fails closed with a stable `MIGRATION_PREREQUISITE_MISSING: 025
  requires workspaces` when the `workspaces` table is absent, so an `025`
  success record can never be written against an incomplete parent schema.
- The `ALTER TABLE` must be guarded by a `PRAGMA table_info(workspaces)`
  column check, matching the existing precedent
  (`015-p6-m3b-windows-native-birth-identity.ts:58-59,81-89`), so that a
  re-run cannot fail with `duplicate column name`; every other statement uses
  `IF NOT EXISTS`.
- Justification, stated precisely: `MigrationRunner` already skips an applied
  migration and verifies its checksum before doing anything
  (`MigrationRunner.ts:114-124`), writes the record inside the same
  `BEGIN IMMEDIATE` (`:165-174`), and rolls back on failure (`:192-193`), so
  a recorded-but-half-applied `025` is not a state the runner can produce.
  The column check is therefore **defense in depth against direct/manual
  `apply` invocation**, which the migration's own tests do
  (`memory-migration-024.test.ts:27-31`), not a runner requirement.

### 6.5 Delete path (frozen rule)

Because the Workspace FK is `RESTRICT`, both hard-delete paths must delete the
Workspace's Events inside the same transaction, before the Workspace row, in the
same style as the existing `agent_events` cleanup:

| Path | Location | Current behavior |
|---|---|---|
| `SqliteStore.deleteWorkspace` | `SqliteStore.ts:812`, reached from `WorkspaceManager.remove` | deletes every child table in one transaction (`:815-843`) and writes `_workspace_tombstones` (`:843`) |
| `WorkspaceRepository.deleteById` | `WorkspaceRepository.ts:167` | deletes only `agent_profiles` and `workspaces` (`:169-170`) inside `inTransaction`; writes **no** tombstone |

Deleting an entire Workspace with its history is an explicit administrative
action that already removes dependent records in one transaction; the stream
itself stays append-only while the Workspace exists. Adding the
`workspace_events` delete line must not change either path's existing
tombstone or ordering behavior.

The line must be placed with the other child deletes and **before** the
`DELETE FROM workspaces` statement (`SqliteStore.ts:842`), because the
`RESTRICT` FK requires the events to be gone first; the same ordering applies
inside `WorkspaceRepository.deleteById` (`WorkspaceRepository.ts:169-170`,
alongside the existing `agent_profiles` delete).

## 7. Shared contract additions (frozen)

### 7.1 Envelope

A new module `packages/shared/src/types/mf5-workspace-events.ts` exports
`WorkspaceEventDraft` and `WorkspaceEventEnvelope`, mirroring the Run
envelope minus every Run-bound reference:

```text
id, schemaVersion, type, workspaceId, sequence, timestamp, source,
correlationId, causationId, parentEventId?, severity, visibility, durability,
payload, metadata?
```

### 7.2 Registry entry point

`CentralRuntimeEventRegistry` gains `publishWorkspace(draft)`
(`packages/shared/src/types/m3-runtime-registry.ts:231`) that:

- applies the same envelope checks as `validateEnvelopeShape`
  (`m3-runtime-registry.ts:491`) except that a non-empty `workspaceId` is
  required and `runId` must be **absent**;
- reuses the existing definition lookup and `validateKnownDraft` payload
  validation unchanged;
- rejects any type outside the frozen allowlist of §7.3.

The Run `publish` path and every existing definition stay unchanged, so no Run
consumer can observe a behavior change.

### 7.3 Workspace stream allowlist v1 (frozen)

| Type | Emitted when |
|---|---|
| `memory.candidate_reviewed` | a review outcome is committed for a Candidate |
| `memory.conflict_opened` | the same transaction inserted a Conflict row |
| `memory.conflict_resolved` | the same transaction recorded a resolution disposition |
| `memory.entry_created` | the same transaction inserted a Memory Entry |
| `memory.entry_updated` | the same transaction mutated a stored Entry (including evidence merge) |
| `memory.entry_rejected` | the disposition rejected an Entry without deleting it |
| `memory.entry_superseded` | the disposition superseded an Entry without deleting it |
| `memory.entry_deduplicated` | an actual dedup convergence onto an existing Entry was applied |

Every listed type already exists as a registered definition with source
`memory-engine` (`packages/shared/src/types/mf5-memory-events.ts`); no new
event type is introduced by this package. Types outside this table — including
every `run.*`, `stage.*`, `process.*`, `artifact.*`, and `workspace.*`
type — are not appendable to this stream.

## 8. Authority, writer, and failure semantics (frozen)

### 8.1 Claim-then-proof context

`WorkspaceEventContextV1`:

```text
correlationId  required, must equal the authority-derived value for the subject
causationId    required, must equal the id of the durable subject row
parentEventId  optional, must be an existing workspace_events id in the same Workspace
```

`DurableWorkspaceEventContextAuthority` accepts only these origins and proves
each one against the durable row re-read inside the caller's transaction:

| Origin claim | Proof required in the same Workspace |
|---|---|
| `memory.candidate_review` `{candidateId, candidateVersion}` | `memory_candidate_entries` row exists with that id and version and a committed outcome |
| `memory.conflict_resolution` `{conflictId, conflictVersion}` | `memory_conflicts` row exists with that id/version and a non-null disposition |

- v1 has **exactly these two origins**. A `candidate_acceptance` origin is
  deliberately **not** defined: it would have to prove a `memory_entries` row,
  and the only accept route in this tree writes the legacy `memories` table
  instead (§2.1), so such an origin could never be proven and would be dead
  code. Legacy-surface acceptance is a separate authorization (§15.6).

- Derived correlation: a deterministic, subject-derived string (for example
  `memory-candidate:<candidateId>:v<version>`); a caller-supplied correlation
  that does not equal the derived value fails closed with `ORIGIN_UNPROVEN`.
- `canonical_command`-style origins and any Run-derived origin are refused:
  they belong to the Run stream.
- Unproven claims fail closed with `ORIGIN_UNPROVEN`; malformed input fails
  with `INPUT_INVALID`. No Event is written on either path.

### 8.2 Writer

`WorkspaceEventWriter.appendWithinTransaction(input)`:

1. requires an active transaction and a provable origin (§8.1);
2. requires a canonical UTC-millisecond timestamp
   (`apps/server/src/store/CanonicalTimestamp.ts`) and an `evt_` ULID id
   (`apps/server/src/store/Identity.ts`);
3. validates the draft through `publishWorkspace` (§7.2), including the
   allowlist;
4. allocates the sequence (§6.1) and inserts one row; it writes **no** Outbox
   row, no `runtime_events` row, and no `operations` row;
5. asserts, inside the transaction, that the authority record exists in this
   Workspace before appending — the Workspace mirror of
   `assertAuthorityOriginProven`
   (`apps/server/src/services/MemoryRuntimeEventEmitter.ts:320,356`).

The writer must be constructed over the store's single SQLite connection and
must fail construction (`WRITER_NOT_BOUND`) when its collaborators are bound
to a different connection, exactly like `RuntimeEventOutboxWriter`
(`apps/server/src/store/RuntimeEventRepository.ts:124-160`).

### 8.3 Frozen ordering

Within one transaction, Events are appended in this order with contiguous
sequences:

```text
memory.candidate_reviewed -> memory.conflict_opened -> Entry Events
memory.conflict_resolved -> Entry Events
```

An Entry Event is appended only for an Entry the transaction actually changed,
and it carries the persisted Entry version — never a placeholder.

### 8.4 Failure and idempotency

- Any Event validation, sequence, or persistence failure rolls back the Memory
  fact and every Event/version bump of that transaction
  (`03-Event-Model.md` §17). A durable fact is never left without its Event
  when emission is wired.
- Replay safety relies on the fact layer's concurrency guard, and the two
  origins do **not** carry the same strength today:

  | Origin | Fact-layer guard (verified) | Verdict |
  |---|---|---|
  | `memory.candidate_review` | version predicate in SQL **and** `changes !== 1` -> `CANDIDATE_NOT_REVIEWABLE` (`MemoryCandidateRepository.ts:457,462,469-471`) | sufficient: one committed review yields exactly one Event set |
  | `memory.conflict_resolution` | version predicate in the SQL (`MemoryCandidateRepository.ts:551`) but **no** `changes` count assertion after it | **not sufficient as-is** |

  The conflict path must therefore gain the same `changes === 1` assertion as
  part of this slice before it may append Events; until then it may not claim
  replay safety. This is a prerequisite, not a follow-up.

## 9. Wiring (frozen list of seams)

| Seam | Change |
|---|---|
| `MemoryCandidateRepository.reviewCandidate` | optional writer; emits review + any conflict/Entry effects |
| `MemoryCandidateRepository.resolveConflict` | optional writer; emits resolution + Entry effects |
| Memory route composition | constructs ONE `WorkspaceEventWriter` and passes it to the repositories used by the two Workspace-only Memory Foundation routes (`memoryRuntime.ts:242,266`); the legacy `memory-candidates` routes stay unwired (§2.1) |
| `MemoryCandidateRepository.resolveConflictWithinTransaction` | prerequisite: add the `changes === 1` assertion of §8.4 before wiring |
| `SqliteStore` | build the allocator/writer over the existing connection and expose one binding accessor |

The writer stays optional in every signature so existing doubles, Run-scoped
call sites, and tests keep compiling; when it is absent the routes behave
exactly as they do today.

## 10. Cross-cutting frozen rules

| Topic | Frozen rule |
|---|---|
| Scope | One sequence space per Workspace; Events never cross Workspaces. |
| Run binding | Structurally impossible in this table; Run facts still require `runtime_events`. |
| Actor | Not recorded in v1 (§3.4). |
| Payloads | Reuse registered `memory.` payload guards; no new payload shape. |
| Redaction | Payloads carry ids/versions/outcomes only, never Entry content or secrets. |
| Publication | None in v1; no Outbox row, no SSE, no notifier registration. |
| Retention | History while the Workspace exists; removed only with an explicit Workspace delete (§6.5). Because the stream intentionally has no delete trigger (§6.3), any other `DELETE FROM workspace_events` is a code-review violation, not a runtime-enforced one. |
| Compatibility | Baseline, M3, MF-1..MF-5 tables and routes keep their current contracts. |

## 11. Operational boundary

| Topic | Frozen rule |
|---|---|
| Migration file | Not created by this package. |
| Registry entry | Not created; `025` is reserved here only. |
| Checksum | Not computed. |
| Shared contracts | §7 is frozen text, not yet implemented. |
| Wiring | No repository, service, route, UI, or Inspector change is authorized by this package. |
| Backfill | None; Workspace Events before `025` do not exist and are never fabricated. |

## 12. Future implementation allowlist (MF-5 Workspace stream only)

- `apps/server/src/migrations/migrations/025-mf5-workspace-event-stream.ts`;
- registry wiring: the import and array entry in
  `apps/server/src/migrations/default-registry.ts` (array at `:55`, last
  entry `migration024` at `:79`) plus that file's header comment;
- registry-order assertion update: `EXPECTED_MIGRATION_IDS` in
  `apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts:7`
  (currently ends at `'024'`), and any other test that enumerates the full
  migration id set;
- `packages/shared/src/types/mf5-workspace-events.ts` and the
  `publishWorkspace` addition of §7.2, plus its re-export in
  `packages/shared/src/types/index.ts` (next to `:980`);
- `WorkspaceSequenceAllocator`, `WorkspaceEventRepository`,
  `WorkspaceEventWriter`, `DurableWorkspaceEventContextAuthority`;
- a Workspace-side Event reader (the Run reader cannot serve this table, §6.2);
- the `changes === 1` assertion of §8.4 in
  `MemoryCandidateRepository.resolveConflictWithinTransaction`;
- the `SqliteStore` binding accessor and the two delete-path lines of §6.5;
- the optional writer parameters of §9 and the route composition;
- focused schema, repository, authority, and route emission tests.

MF-5 Workspace stream work must not add: Outbox rows, publication, SSE,
Inspector projection, UI, Run-scoped behavior changes, new Memory event types,
new Memory tables, or any edit to migrations `001`–`024`. The legacy
`memories` / `memory_candidates` surface (§2.1), including
`MemoryCandidateService.ts`, is explicitly **not** in this allowlist.

## 13. Future acceptance matrix

| Gate | Requirement |
|---|---|
| MF5W-A1 | Fresh DB applies `001`–`025` in order. |
| MF5W-A2 | Upgrade from `024` applies `025` additively with no data loss; `workspaces` rows keep `version` and `next_event_sequence = 1`. |
| MF5W-A3 | Re-running `025` is idempotent; a missing `workspaces` table fails closed with no `025` record. |
| MF5W-A4 | Update of `workspace_events` is rejected by trigger; a direct `DELETE` outside the sanctioned workspace-delete path is a review finding (§6.3, §10). |
| MF5W-A5 | Sequences are unique per Workspace, contiguous per transaction, and not consumed by a rolled-back write. |
| MF5W-A6 | Same-Workspace `correlation_id`/`causation_id` proven; foreign-Workspace or unproven claims fail closed with zero writes. |
| MF5W-A7 | A type outside the §7.3 allowlist is refused. |
| MF5W-A8 | A draft carrying Run-bound references cannot be represented or persisted. |
| MF5W-A9 | No Outbox, `runtime_events`, or `operations` row is created by any Workspace emission. |
| MF5W-A10 | Candidate review and conflict resolution each commit their fact and their Events in one transaction. |
| MF5W-A11 | An injected failure on the second Event rolls back the fact, the first Event, and the sequence allocation. |
| MF5W-A12 | A repeated review request and a repeated conflict-resolution request each append no second Event (requires the §8.4 assertion). |
| MF5W-A13 | Event payload identity/version equal the persisted row values for every emitted Entry Event. |
| MF5W-A14 | Run-scoped memory emission, Run lifecycle, and every existing Memory suite stay green (no regression). |
| MF5W-A15 | Workspace delete with Events succeeds, removes exactly that Workspace's rows, and leaves no orphans. |
| MF5W-A16 | No secret or Entry content is stored in any Workspace Event payload. |
| MF5W-A17 | The legacy `memories` / `memory_candidates` routes produce no `workspace_events` row and remain byte-for-byte unchanged. |
| MF5W-A18 | `resolveConflictWithinTransaction` rejects a lost race with `changes === 1`, asserted directly. |

## 14. Explicit prohibitions

- No edit to migrations `001`–`024` or their checksums.
- No destructive rebuild, no backfill, no fabricated `runId`.
- No weakening or rerouting of the Run-scoped authority, writer, or checks.
- No secret value storage; no Entry content in payloads.
- No Outbox, publication, SSE, Inspector, or UI work in this slice.
- No new Memory event type, Memory table, or Memory lifecycle rule.

## 15. Deferred follow-ups (recorded, not authorized)

1. Workspace Event publication (Outbox or equivalent) once a consumer contract
   exists;
2. Inspector projection and read API for `workspace_events`;
3. durable actor attribution (`reviewed_by`-style column) so the envelope can
   carry a proven `agentId`;
4. the remaining MF-2 candidate triggers and dedup evidence convergence, which
   the Run and Workspace streams both still depend on;
5. composite Workspace queries (search/history) over both streams.

Recorded explicitly because the independent design review raised them:

6. The legacy `memories` / `memory_candidates` surface (§2.1, including
   `routes/memories.ts:21,40,52` and `MemoryCandidateService.accept/.reject`).
   Whether it should gain canonical Events requires a **separate** rewrite
   authorization: it is a different table family with no version column
   (`SqliteStore.ts:2412` updates on `workspace_id` + `id` only) and a
   non-atomic `await create` then `mark accepted` order
   (`MemoryCandidateService.ts:90-99`), so it cannot be wired by adding an
   optional writer.
7. An Outbox-equivalent for the Workspace stream once a consumer exists — the
   Run path emits one Outbox row per durable Event
   (`03-Event-Model.md:215`), and this package deliberately breaks that
   symmetry; recording it keeps the asymmetry auditable.
