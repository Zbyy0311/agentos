# Memory Foundation — Entry Audit and Scope Boundary

Status: ENTRY AUDIT — EVIDENCE-BASED — MEMORY FOUNDATION NOT STARTED — NO SCHEMA, MIGRATION, API, OR BEHAVIOR CHANGE AUTHORIZED BY THIS DOCUMENT

## 1. Metadata / exact baseline

| Field | Evidence |
|---|---|
| Repository | `Zbyy0311/agentos` |
| Audit base | `origin-https/main @ a52d69a2` (Merge PR #77, `docs/p6-recovery-closeout`) |
| Preceding merges | `165b9cd3` (PR #76, P6-L1E), `9af24569` (PR #75, P6-L1D) |
| Migration ledger | `001`–`016` present; `017` absent |
| Prior Fast-Track gates | Workspace single-writer rule COMPLETE (PR #70–#76); Recovery closeout COMPLETE (PR #77) |
| Audit date | 2026-09-09 (Asia/Shanghai) |
| Method | Read-only inspection of the exact base tree; Lite Memory Runtime contract reconciled against current code; no source, schema, API, UI, or test change |

This document is an audit and scope boundary. It changes no production code,
no schema, no migration registry, no API, and no behavior.

## 2. Authority

Per `docs/Runtime-Specification lite/00-Vision.md` §8 and §13 and
`07-Memory-Runtime.md`, Memory Foundation is the **next ACTIVE LITE Fast-Track
step** after Recovery closeout. The Lite contract is authoritative for forward
scope; existing baseline memory tables remain **COMPATIBILITY** and are
explicitly **not** claimed to satisfy the forward contract.

`07-Memory-Runtime.md` §2.2 states directly:

> This specification does not claim a merged forward Memory Runtime package or
> schema that satisfies this contract. Baseline Memory tables and FTS surfaces
> remain **COMPATIBILITY**; Memory Foundation is forward **ACTIVE LITE**
> direction and must evolve them additively.

## 3. Current-State Inventory

Status vocabulary: IMPLEMENTED / PARTIAL / LEGACY / MISSING / CONFLICTING.

### 3.1 Persistence

- **LEGACY (baseline compatibility)**: `memories`, `memory_sources`, `memory_fts`
  (FTS5), `run_memory_usage`, `memory_candidates` created by migration `001`
  (`apps/server/src/migrations/migrations/001-baseline-schema.ts:269-334`).
- **MISSING**: Memory Entry fields required by Lite §5 — `scope`, `category`,
  `authority`, `status` lifecycle beyond `active`/`archived`, `pinned`,
  `validity` (valid-from/valid-until/expiry), content hashes for exact and
  normalized deduplication, token estimate, conflict state, supersession links.
- **MISSING**: Immutable `Context Snapshot` persistence and any `mctx_`-prefixed
  record. `memoryContext: 'mctx'` exists only as an ID prefix constant
  (`apps/server/src/store/Identity.ts:20`); no repository, table, or writer
  uses it.
- **MISSING**: Conflict records and explicit resolution persistence.
- **MISSING**: Any Memory-specific migration `017`.

### 3.2 Domain model

- **LEGACY**: `MemoryRecord` / `MemoryType` (`overview|convention|decision|experience`)
  / `MemoryStatus` (`active|archived`) in `packages/shared/src/types/index.ts:485-506`.
  This is a 4-value type enum, not the Lite `Scope` × `Category` × `Authority`
  model.
- **LEGACY**: `MemoryCandidate` / `MemoryCandidateStatus`
  (`pending|accepted|rejected`) / `MemoryCandidateOperation`
  (`create|update|merge|ignore`).
- **MISSING**: Scope (`global|workspace|agent|conversation|task|run`), Category
  (14 Lite values), Authority (6 Lite values), independent Confidence and
  Importance semantics, Source typing.

### 3.3 Services

- **PARTIAL**: `MemoryService` (`apps/server/src/services/MemoryService.ts`) —
  CRUD over Markdown content files plus SQLite rows. Content is stored as
  files on disk (`contentPath`), which is the Lite **anti-pattern** (Memory must
  be SQLite canonical, FTS5-indexed, not a Markdown dump).
- **PARTIAL**: `MemoryRetriever` (`apps/server/src/services/MemoryRetriever.ts`) —
  FTS5 `bm25` ranking plus ad-hoc keyword/file/importance scoring; no Scope
  filter, no deterministic reason list, no Authority/Confidence signals.
- **PARTIAL**: `RunContextBuilder` (`apps/server/src/services/RunContextBuilder.ts`) —
  fixed budgets (`MAX_MEMORY_ITEMS=5`, `MAX_MEMORY_CHARACTERS=6000`,
  `MAX_SINGLE_MEMORY_CHARACTERS=1800`) and `run_memory_usage` writes. This is a
  usable budget primitive but is not a configurable budget policy and produces
  no immutable Context Snapshot or selection explanation.
- **PARTIAL**: `MemoryExtractor` (`explicit_marker|public_evidence`) and
  `MemoryCandidateService` (generate/accept/reject) — candidate pipeline exists
  but is bound to the legacy Conversation run lifecycle and lacks
  deduplication, conflict detection, and Authority gating.
- **MISSING**: Scope-filtered retrieval, deterministic ranking with reasons,
  selection/exclusion explanation, immutable Context Snapshot, conflict
  resolution, pin/expire/revalidate actions, conservative outcome writeback.

### 3.4 API

- **PARTIAL**: `apps/server/src/routes/memories.ts` exposes
  `GET/POST /memories`, `GET/PATCH /memories/:memoryId`,
  `POST /memories/:memoryId/archive` (5 endpoints).
- **PARTIAL**: `apps/server/src/routes/memoryCandidates.ts` exposes candidate
  list and generate; candidate accept/reject.
- **MISSING** (vs Lite §14 API spec): `pin`, `memory/retrieve`,
  `GET /runs/:runId/memory-context`, `GET /memory-contexts/:memoryContextId`,
  `POST /memory-conflicts/:conflictId/resolve`.

### 3.5 Events

- **PARTIAL**: `AgentEventType` includes only `memory.used` and
  `memory.candidate.created` (`packages/shared/src/types/index.ts:55-56`).
- **MISSING**: the Lite §15 family — `memory.candidate_created`,
  `memory.entry_created`, `memory.entry_updated`, `memory.entry_conflicted`,
  `memory.entry_deduplicated`, `memory.entry_superseded`,
  `memory.entry_expired`, `memory.entry_archived`, `memory.retrieval_completed`,
  `memory.retrieval_failed`, `memory.context_created`, `memory.injected`,
  `memory.revalidation_completed`.

### 3.6 UI

- **LEGACY**: `apps/web/src/components/memory/` (`MemoryPanel`, `MemoryList`,
  `MemoryEditor`, `MemoryCandidateQueue`, `MemoryMarkdownPreview`,
  `MemorySourceLinks`). No Scope/Authority/Confidence explanation, no Context
  Snapshot view, no conflict review.

### 3.7 Tests

- Existing: `MemoryService.test.ts` (2), `MemoryRetriever.test.ts` (2),
  `MemoryCandidateService.test.ts` (4), `MemoryExtractor.test.ts` (4),
  `memoryCandidates.test.ts`. All target legacy behavior.
- **MISSING**: every Lite §18 acceptance expectation (Scope/owner validity,
  source requirement, dedup convergence, conflict preservation, Scope-filtered
  FTS, deterministic ranking with reasons, budgets, snapshot immutability,
  explanations, no bulk transcript promotion, secret absence, degraded-mode
  visibility, Provider receives only selected Context).

## 4. Gap Summary

| Lite requirement (`07-Memory-Runtime.md`) | Current state |
|---|---|
| Memory Entry with Scope/Category/Authority/Confidence/Importance/Source | MISSING (legacy 4-type model) |
| Candidate review before durable promotion | PARTIAL (legacy lifecycle-bound) |
| Exact and near-duplicate handling | MISSING |
| Conflict detection/resolution without history loss | MISSING |
| SQLite canonical persistence + FTS5 indexing | PARTIAL (Markdown files + FTS5) |
| Scope-filtered retrieval + deterministic ranking | MISSING |
| Token/entry/scope/category/diversity budgets | PARTIAL (fixed constants) |
| Immutable Context Snapshot per Run/Stage | MISSING |
| Selection and exclusion explanations | MISSING |
| Manual create/edit/pin/archive/expire/reject/revalidate | PARTIAL (create/edit/archive only) |
| Conservative outcome writeback | PARTIAL |
| Memory Events/APIs/UI/Inspector surfaces | PARTIAL |
| Snapshot persistence blocks injection | MISSING (no snapshot) |

## 5. Risks and Constraints

1. **No destructive simplification.** Baseline tables and their consumers must
   remain readable; evolution must be additive (Lite §17, Data Model §14).
2. **Markdown content is compatibility, not canonical.** A forward model must
   not present the current file-backed content path as the Lite contract.
3. **Secret exclusion is a hard gate.** Any new Entry/FTS/Snapshot/search
   surface must exclude secrets and fail closed on redaction failure.
4. **Provider access is bounded to the selected Context**, never the Store.
5. **Snapshot immutability** must be enforced by the schema (update rejected),
   matching the Event/Snapshot precedent.
6. **Migration authorization.** A new migration number is not authorized by
   this audit; it requires a separate, reviewed schema authorization package,
   consistent with the M2/M3/M4 precedent.

## 6. Proposed Entry Slices (not authorized by this document)

The smallest additive sequence that reaches the Lite contract, each gated
separately:

```text
MF-0  Contracts + schema authorization   (shared types, migration design, review)
MF-1  Memory Entry persistence + FTS5    (additive columns/table, immutability)
MF-2  Candidate pipeline + dedup/conflict
MF-3  Scope-filtered retrieval + ranking + reasons
MF-4  Budget policy + immutable Context Snapshot + explanation
MF-5  Events, API, UI, Inspector surfaces
```

Each slice requires its own acceptance evidence and independent review before
merge. This document authorizes none of them.

## 7. Entry Gate (exit criteria for this audit)

- Current state established from the exact base SHA, not from the specification.
- Gap inventory mapped to the Lite Memory contract.
- Risks and compatibility constraints recorded.
- No production, schema, API, UI, or test change made.
- Next action is a separately reviewed schema-authorization package.

## 8. Evidence Index

| Finding | File |
|---|---|
| Baseline memory tables + FTS5 | `apps/server/src/migrations/migrations/001-baseline-schema.ts:269-334` |
| Legacy MemoryRecord/Type/Status | `packages/shared/src/types/index.ts:485-506` |
| File-backed MemoryService | `apps/server/src/services/MemoryService.ts` |
| Ad-hoc ranking retriever | `apps/server/src/services/MemoryRetriever.ts` |
| Fixed-budget context builder | `apps/server/src/services/RunContextBuilder.ts:4-6` |
| Candidate pipeline | `apps/server/src/services/MemoryCandidateService.ts`, `MemoryExtractor.ts` |
| Memory routes | `apps/server/src/routes/memories.ts`, `memoryCandidates.ts` |
| Only two memory Event types | `packages/shared/src/types/index.ts:55-56` |
| `mctx` prefix unused | `apps/server/src/store/Identity.ts:20` |
| Migration ledger 001–016, 017 absent | `apps/server/src/migrations/default-registry.ts` |
