# Project knowledge and forward Memory integration

Date: 2026-10-01. Base: `7eb7fad379338a026c907c57d91e16e8662c70e0`.

The project knowledge editor previously wrote the compatibility `memories` table,
while canonical chat/Run selection read `memory_entries`. A successful UI save
therefore did not make that record eligible in the forward runtime. The user's
request to repair this concrete disconnect authorizes this bounded integration.
Historical Lite acceptance receipts and migration checksums remain unchanged.

## Management contract

Project knowledge now manages forward Entries through the existing Workspace
mount: `GET /memory/entries`, `GET /memory/entries/:entryId`, existing
`POST /memory/entries`, additive `PATCH /memory/entries/:entryId` and
`POST /memory/entries/:entryId/archive`. All reads stay in the addressed Workspace.
Management can display all scopes; runtime retrieval keeps its existing narrower
owner/validity/sensitivity/budget eligibility rules.

New UI saves use Workspace scope and user-explicit authority. Updates require
the actual `expectedVersion` and preserve Entry ID, scope, owners, authority,
source references and historical snapshots. Only active/archived Entries can be
edited; only active Entries can be archived. Edits recompute the content hashes,
token estimate and FTS projection, increment version once, and emit an Event.
Invalid/stale/foreign/secret inputs fail without mutating any sink. The write and
its Event/sequence commit on the existing store connection in one transaction.

## Narrow Workspace Event amendment

The existing `memory.entry_save` origin is retained. A new origin,
`memory.entry_edit { entryId, entryVersion }`, proves an existing Entry in the
same Workspace at the exact post-write version (at least 2). Derived correlation
is `memory-entry:<entryId>:v<version>` and causation is the Entry ID. The writer
rechecks the row and binds payload ID/version/scope/category/authority to it.
This origin permits only `memory.entry_updated` for active/archived state and
`memory.entry_archived` for archived state. The already registered
`memory.entry_archived` type is added to the Workspace allowlist and requires
this edit origin; existing review/conflict/save origins cannot borrow it.
The Workspace amendment adds no canonical Run Event, Outbox row, Operation,
schema, or second Event store.

## Compatibility and runtime boundaries

Legacy records stay visible through a separate read-only view. An explicit user
action sends one selected Markdown record to the existing import path as a
review-required knowledge Candidate. The UI explicitly imports title, summary
and body only; legacy category, scores, tags and Run links remain on the original
record rather than being presented as preserved canonical metadata. Unsupported
categories are visible read-only, never silently replaced to permit an edit.
No automatic backfill, dual-write, or file deletion
is introduced. Candidate acceptance creates the same forward Entry displayed
by project knowledge and read by chat/Run selection.

The default UI also uses the compatibility Workspace conversation SSE endpoint,
which previously read only legacy records. Its `RunContextBuilder` now reads
eligible canonical Entries first through the production MF-3 retrieval and chat
budget selector, then fills remaining capacity with legacy records. The assembled
memory section, including headings and attribution, shares the existing five-item,
6000-character ceiling and 1800-character per-item ceiling. Direct conversations
can reach the current Agent and Conversation scopes; group contexts reach only
Workspace/global and Conversation scopes, including group resume. Compatibility Run
UUIDs do not assert canonical Task/Run ownership.

Canonical usage is attributed by Entry ID and version in the compatibility Run's
existing `memory.used` Event stream, never inserted into legacy MemoryUsage foreign
keys. FTS degradation emits an explicit `execution.diagnostic` warning. This bridge
does not invent MF-4 snapshots for compatibility Runs or change their existing
resume semantics. Canonical Task/Run contexts still use their frozen MF-4 path.

New contexts use the updated eligible Entry. Already frozen Run contexts retain
their exact original payload after edits or archiving. A save is not a promise
that every future call selects the Entry: scope, confidence, validity, ranking
and budget still determine selection.

## Verification

`apps/server/src/routes/memoryEntries.integration.test.ts` exercises real HTTP
management, the production chat selector and Run resolver, candidate promotion,
FTS refresh, frozen replay, optimistic concurrency, rejected owner/authority/
source mutations, secret rejection, and transaction rollback on Event failure.
Existing Memory/retrieval/budget/import/event suites remain regression gates.
`projectKnowledgeConversation.integration.test.ts` exercises the default Workspace
SSE endpoint with a real local child process, captures its actual prompt, and checks
save/edit/archive, version attribution, no dual-write and observable FTS degradation.
The local executable is a capture fixture, not an external vendor/model invocation.
`RunContextBuilder.test.ts` verifies the shared budgets, eligibility, disabled path
and read-only retrieval; `ConversationService.memory.test.ts` guards group resume
against Agent-private scope leakage through the parent service.
Rendered browser verification uses a separate API data root and Web process;
no business database or user candidate is modified.

The frozen matrix remains a historical receipt. Its ordinary scope verifier
validates the recorded 230 PASS / 165 DEFERRED classification; `--require-closed`
also requires current HEAD to be a closeout-documents-only descendant of the
recorded final Main `90e2e5a1`. Current Main and this feature branch already contain
later production changes, so that strict historical command refuses them. The
current CI runs the ordinary scope verifier. This follow-up does not rewrite the
frozen baseline or treat its historical PASS counts as new-revision acceptance.
