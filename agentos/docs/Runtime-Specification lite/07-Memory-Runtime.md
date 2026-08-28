# AgentOS Runtime Specification Lite

## 07 — Memory Runtime

> **Status:** Primary Forward Engineering Specification
> **Authority:** **ACTIVE LITE** governs future product scope and implementation direction. **COMPATIBILITY** means merged low-level contracts and ADRs remain authoritative for frozen correctness behavior. **DEFERRED FULL-SCOPE** means the historical Runtime Specification remains reference architecture where it exceeds Lite.
> Scope may be reduced. Correctness is not reduced.

---

## 1. Purpose

The Lite Memory Runtime is a structured, source-linked, retrievable, budgeted, and explainable knowledge layer.

Memory is a required product capability. It is not a Conversation transcript, a Provider session, or a Markdown dump.

The foundation must answer:

> Why did this Run receive this Memory?

The baseline is SQLite plus FTS5. A Vector Database is not required.

## 2. Lite Scope

### 2.1 ACTIVE LITE

- Memory Entry with Scope, Category, Authority, Confidence, Importance, Source, status, and version;
- Memory Candidate review before durable promotion;
- exact and near-duplicate handling;
- conflict detection and resolution without history loss;
- SQLite canonical persistence and FTS5 indexing;
- scope-filtered retrieval and deterministic ranking;
- context token, entry, scope, category, and diversity budgets;
- immutable Context Snapshot per Run or Stage;
- selection and exclusion explanations;
- manual create, edit, pin, archive, expire, reject, and revalidate actions;
- conservative outcome writeback;
- Memory Events, APIs, UI, search, and Inspector surfaces.

### 2.2 COMPATIBILITY

- existing SQLite, Migration Runner, version, idempotency, Event, Outbox, Operation, Artifact, and redaction contracts;
- historical Memory concepts that do not conflict with Lite;
- additive migrations and preserved existing fields;
- Markdown import as a migration source, not canonical runtime state.

This specification does not claim a merged forward Memory Runtime package or schema that satisfies this contract. Baseline Memory tables and FTS surfaces remain **COMPATIBILITY**; Memory Foundation is forward **ACTIVE LITE** direction and must evolve them additively.

### 2.3 DEFERRED FULL-SCOPE

- mandatory Vector Database;
- mandatory remote embeddings;
- semantic knowledge graph;
- autonomous global promotion;
- elaborate supersession graph;
- complex forgetting scheduler;
- highly autonomous extraction;
- embeddings as a Foundation prerequisite.

Advanced retrieval may be added later without changing Run, Memory, or Context Snapshot identity.

## 3. Core Invariants

| Invariant | Contract |
|---|---|
| Memory != Conversation History | History records what happened; Memory is selected knowledge for future work. |
| Memory != Provider history | Provider-native sessions and transcripts are noncanonical references. |
| Source required | Automatically proposed Memory without a stable source cannot become active. |
| Scope controls reach | Pinning and ranking never bypass Scope. |
| Candidate before promotion | Unverified Provider output is not immediately canonical Memory. |
| Conflict != overwrite | Conflicting Entries survive until an explicit resolution. |
| Snapshot immutability | Later Entry changes never rewrite a Run's Context Snapshot. |
| Secret != Memory | Secret values never enter Entries, FTS, Snapshots, Events, or search. |
| Retrieve before inject | AgentOS never sends the whole Memory Store to a Provider. |
| Explain every selection | A selected Entry carries reasons and context cost. |
| FTS5 is sufficient | Embeddings are optional future ranking signals. |

## 4. Architecture and Data Flow

~~~text
User / Message / Task / Run / Stage / Event / Artifact
  -> Memory Candidate
  -> classify + scope + source + deduplicate + conflict check
  -> active Memory Entry in SQLite + FTS5
  -> structured scope filter
  -> FTS5 candidate retrieval
  -> deterministic ranking
  -> context budget selection
  -> immutable Context Snapshot + explanations
  -> Provider Context
  -> conservative outcome writeback as new Candidates
~~~

Persistence, Memory Events, and Outbox records share the merged transaction boundary. Providers receive only the selected Context Snapshot projection.

## 5. Memory Entry

A Memory Entry is one independently retrievable, versioned, and auditable knowledge unit.

Required fields:

| Field | Meaning |
|---|---|
| id | immutable AgentOS Memory ID |
| scope | global, Workspace, Agent, Conversation, Task, or Run reach |
| category | decision, knowledge, preference, constraint, failure, review, test, architecture, workflow, provider, environment, security, summary, or reference |
| authority | user-explicit, system-verified, imported-verified, agent-derived, user-inferred, or unknown |
| confidence | current truth estimate in the range 0..1 |
| importance | expected future influence in the range 0..1 |
| source | typed stable source references |
| title/content/tags | retrievable content |
| status | candidate, active, conflicted, superseded, expired, archived, rejected, or deleted |
| pinned | ranking boost inside the allowed Scope |
| validity | optional valid-from, valid-until, and expiry |
| content hashes | exact and normalized deduplication keys |
| token estimate | budget input |
| version/timestamps | optimistic concurrency and audit |

Rules:

- AgentOS IDs are immutable and never reused.
- Confidence and Importance are independent.
- Automatic Entries require at least one source reference.
- Memory content is untrusted data, not system instruction text.
- Delete is soft; normal retrieval excludes deleted rows.
- Every accepted change increments version and emits an Event.

## 6. Scope and Authority

Scopes:

~~~text
global
workspace
agent
conversation
task
run
~~~

Owner references must match Scope. A global Entry cannot carry a Task owner; a Run Entry must identify its Workspace, Task, and Run.

Default retrieval scope ordering is:

~~~text
run > task > conversation > agent > workspace > global
~~~

This is an eligibility and ranking hint, not authorization to cross Scope.

Promotion to a broader Scope requires explicit review and an auditable Event. Cross-Workspace propagation requires explicit global promotion or an explicit reference.

Authority default ordering is:

~~~text
user-explicit
  > system-verified runtime fact
  > imported verified source
  > agent-derived
  > user-inferred
  > unknown
~~~

Agent-derived and unknown claims remain Candidates unless evidence and acceptance rules permit promotion.

## 7. Candidate Pipeline

Candidate generation is bounded to meaningful transitions:

- explicit user save;
- Task, Run, or Stage terminal outcome;
- accepted approval decision;
- completed review or test Artifact;
- Conversation compaction;
- explicit import.

The Evidence Bundle is bounded: accepted summary, normalized error, review, test result, diff reference, selected Messages, and important Events. Raw Provider output and hidden reasoning are not bulk-saved.

Candidate outcomes:

~~~text
accept
edit-and-accept
reject
merge-with-existing
review-required
~~~

Automatic acceptance requires sufficient Authority and Confidence, allowed Scope, no secret, no unresolved conflict, bounded size, and completed duplicate handling.

Global Scope, security category, inferred preference, Scope promotion, and unresolved conflict always require review.

## 8. Deduplication and Conflict

Deduplication runs in this order:

1. exact content hash;
2. normalized text hash;
3. same stable source;
4. FTS similarity;
5. category plus entity-key rules;
6. optional embedding similarity only if later enabled.

An exact duplicate adds source evidence and validation metadata to the existing Entry. It does not create another active row.

A conflict is not a duplicate. Conflict types include contradiction, overlapping Scope, Authority disagreement, and temporal disagreement.

Conflicted Entries:

- remain stored;
- are penalized or flagged during ranking;
- expose all sources;
- require explicit resolution where material;
- use supersession links rather than hard deletion;
- never rewrite earlier Context Snapshots.

## 9. Retrieval and FTS5

The baseline FTS5 index covers title, content, summary, and tags.

~~~text
resolve allowed scopes
  -> apply status, owner, validity, category, tag, and sensitivity filters
  -> FTS5 MATCH over eligible rows
  -> bound candidate count
  -> rank
~~~

Expired, archived, rejected, superseded, and deleted Entries are excluded by default. Pinned Entries remain limited to their Scope.

If FTS5 is unavailable, retrieval degrades to structured filters, exact tags, pinned constraints, and active Task-scoped Entries ordered by validation time, while emitting a warning Event. Degraded retrieval does not guess semantic matches.

## 10. Ranking

Ranking is deterministic for the same Store, query, clock, Scope, and budget policy.

Signals:

- FTS relevance;
- Scope proximity;
- Importance;
- Confidence;
- Authority;
- validity and recency;
- pin boost;
- prior validated use;
- source and category diversity;
- conflict penalty.

Each result persists a score plus a reason list. Embedding similarity, if added later, is one signal and never the sole Authority.

## 11. Context Budget

Every retrieval request defines:

- maximum tokens;
- maximum Entries;
- per-Scope and per-category limits;
- minimum Confidence and Importance;
- diversity constraints;
- maximum truncation.

Selection:

1. filter by Scope and eligibility;
2. rank candidates;
3. reserve space for allowed pinned and high-Authority constraints;
4. fill remaining budget by score;
5. enforce Scope, category, and diversity ceilings;
6. truncate only with an explicit flag and cost;
7. record exclusion reasons.

Budget limits, usage, truncation, and per-Entry token costs are durable facts.

## 12. Immutable Context Snapshot

A Context Snapshot records exactly what one Run or Stage received:

- Context ID, Workspace, Agent, Task, Run, optional Stage, and Provider Configuration references;
- query hash and retrieval strategy version;
- Memory Entry IDs and versions;
- frozen content or content hash plus immutable reference;
- rank, score, reasons, Authority, Confidence, Importance, Source, and token cost;
- truncation flags;
- total budget and usage;
- generated timestamp;
- optional prompt Artifact reference;
- exclusions and reasons.

The Snapshot is persisted before Provider injection and is immutable. Snapshot persistence failure blocks injection because the Run would otherwise be unreproducible.

## 13. Selection Explanation

For every selected Entry, AgentOS exposes:

- matching Scope;
- relevant terms or FTS rank;
- Importance and Confidence;
- Authority;
- Source;
- pin, category, budget, or diversity reason;
- token/context cost.

The same explanation appears in the Snapshot, Memory Events, Runtime Inspector, and trusted UI projection.

## 14. Run and Provider Integration

~~~text
Run snapshot
  -> build Memory query
  -> retrieve and rank
  -> persist Context Snapshot
  -> assemble Provider Context
  -> start Provider execution
~~~

A retry may receive Task Memory, the previous normalized failure, accepted review findings, and prior diff Artifact reference. It never receives the entire prior raw output.

Agent Memory survives Provider switches. Provider-specific facts use category and tags rather than separate canonical Stores.

Terminal outcomes may create Candidates and validation signals, but never automatically widen Scope or persist secrets.

## 15. Events and Audit

Representative Events:

~~~text
memory.candidate_created
memory.entry_created
memory.entry_updated
memory.entry_conflicted
memory.entry_deduplicated
memory.entry_superseded
memory.entry_expired
memory.entry_archived
memory.retrieval_completed
memory.retrieval_failed
memory.context_created
memory.injected
memory.revalidation_completed
~~~

Payloads contain stable references, scores, reasons, and budget facts rather than sensitive full content.

## 16. Failure and Safety Rules

- Entry/index write failure rolls back the transaction.
- Secret detection or redaction failure blocks persistence.
- Snapshot write failure blocks Provider injection.
- Retrieval degradation is visible and never fabricates semantic matches.
- Provider access is limited to the selected Context, never the Store.
- Memory is treated as untrusted input during prompt assembly.
- Automatic Scope promotion is prohibited.
- Search and export exclude secret values.

## 17. Compatibility with Existing Runtime

Memory implementation must evolve the existing SQLite and Migration Runner additively. It must preserve version, idempotency, Event, Outbox, Operation, Artifact, and redaction contracts.

No destructive schema simplification is implied. Historical Markdown may be imported idempotently into Candidates while preserving the source files.

Historical full-scope concepts remain reference-only when they exceed Lite.

## 18. Acceptance Expectations

Independent verification must prove:

- valid and invalid Scope/owner combinations;
- source requirement for automatic Entries;
- exact and near-duplicate convergence;
- conflict preservation and explicit resolution;
- FTS5 retrieval only inside allowed Scope;
- deterministic ranking with reasons;
- token, count, Scope, category, and diversity budgets;
- immutable Context Snapshot after later Entry edits;
- explanation for selections and exclusions;
- no bulk transcript or Provider-history promotion;
- no automatic wider-Scope promotion;
- secret absence from Entries, FTS, Snapshots, Events, export, and search;
- visible FTS degraded mode;
- Provider receives only the selected Context.

## 19. Deferred / Non-Goals

- Vector Database requirement;
- remote embedding dependency;
- semantic knowledge graph;
- autonomous global Memory promotion;
- elaborate supersession graph;
- complex forgetting scheduler;
- highly autonomous extraction;
- treating Conversation History as Memory;
- sending the whole Memory Store to Providers.

## 20. Cross-Document References

- [00 — Vision](./00-Vision.md) defines Memory as a Fast-Track pillar.
- [01 — Core Concepts](./01-Core-Concepts.md) separates Memory from History.
- [02 — Runtime Lifecycle](./02-Runtime-Lifecycle.md) defines Run startup and retry.
- [03 — Event Model](./03-Event-Model.md) defines ordering, Outbox, and redaction.
- [04 — Provider Specification](./04-Provider-Specification.md) defines Provider Context.
- [08 — Policy Runtime](./08-Policy-Runtime.md) protects Memory actions.
- [09 — Conversation Runtime](./09-Conversation-Runtime.md) supplies bounded source context.
- [10 — Data Model](./10-Data-Model.md) maps Memory persistence.
- [11 — API Specification](./11-API-Specification.md) exposes Memory and explanation APIs.
- [12 — UI Architecture](./12-UI-Architecture.md) defines Memory explanation UX.
- [13 — Runtime Inspector](./13-Runtime-Inspector.md) presents the frozen Context Snapshot.
