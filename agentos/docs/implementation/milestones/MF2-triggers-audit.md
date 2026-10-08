# MF-2 — Remaining Candidate-Generation Triggers: Current-State Audit

Status: AUDIT COMPLETE — slice design frozen; implementation awaits owner decision.

Base: `origin-https/main @ 774c5802` (Merge PR #133). Every seam claim below was
re-read against that revision, not recalled from the earlier
`MF2-remainder-audit.md` (whose seam matrix is re-verified here).

## 1. Purpose

Memory Foundation (Lite Fast-Track, `00-Vision.md` section 13) is the one
Fast-Track step still PARTIAL. Its remaining item, per `MF-progress.md` section
6, is the candidate-generation triggers beyond the terminal-outcome trigger
merged in PR #125. `07-Memory-Runtime.md` section 7 defines six triggers. This
audit establishes, from current source, which of them have a durable seam today
and which need a new one, so the next slice can be authorized precisely.

## 2. Trigger seam matrix (re-verified)

| Spec trigger (07 section 7) | Durable seam today | Verified evidence |
|---|---|---|
| Explicit user save | NO forward seam — only the legacy `MemoryService.create`, non-transactional, no Event | `services/MemoryService.ts:36,64`; the forward routes have no entry-save path (`routes/memoryRuntime.ts:158-266` lists retrieve/context/candidates/conflicts only) |
| Task/Run/Stage terminal outcome | YES — canonical, transactional, evented | `RunEngineProviderDispatcher.ts:72-82` (terminal trigger after `completeRun` commits); `MemoryCandidateGenerationService.generateForRunTerminal` |
| Accepted approval decision | NO durable production seam — `ApprovalRegistry` keeps requests/decisions/grants in in-memory Maps | `services/ApprovalRegistry.ts:4-6` (Map only); `routes/approvals.ts:10` (in-memory default) |
| Completed review/test Artifact | NO — no review or test Artifact type exists | no `review`/`test` artifact kind anywhere in the shared types |
| Conversation compaction | NO — no compaction implementation exists | zero `compaction` hits under `apps/server/src` outside comments |
| Explicit import | NO memory import — Workspace import forces `memory: false` | `managers/WorkspaceManager.ts:110` |

So the earlier MF-2R conclusion still holds: only the terminal-outcome trigger
has a seam that satisfies the MF transaction/evidence bar. Binding the other
five requires creating new durable seams — separate authorized work.

## 3. What changed since the MF-2R audit

The MF-2R audit predated the Conversation Runtime, the MF-5 Workspace Event
stream, and the Workspace admission persistence. Those now exist and change the
seam cost of two triggers:

- The MF-5 Workspace Event stream (`workspace_events`, migration `025`) means a
  forward entry-save fact can emit a canonical Event without a Run.
- The forward `MemoryEntryRepository` (`apps/server/src/store/MemoryEntryRepository.ts`)`
  already owns transactional entry persistence with source/hash lookups.

The other three triggers' seams are still absent.

## 4. Slice design — the cheapest real trigger first

### 4.1 Candidate slice: explicit user save (forward entry save)

This is the one trigger whose seam already exists and needs no new schema:

- A new route `POST /memory/entries` (forward surface, alongside
  `routes/memoryRuntime.ts`) that calls `MemoryEntryRepository.createEntry`
  inside a transaction and emits `memory.entry_created` through the merged
  `WorkspaceEventWriter` (PR #127/#128), because a user save is a
  Workspace-scoped Memory fact with no Run.
- No new table, no migration, no change to the legacy `routes/memories.ts`
  (COMPATIBILITY), no change to the MF-0 promotion gate. A user save is
  authority `user-explicit`, so it bypasses the review queue by design and
  lands as an active Entry.

### 4.2 Deferred (each needs its own authorization)

| Trigger | Required new seam | Why deferred |
|---|---|---|
| Accepted approval decision | Durable approval records (a new table) | New schema; out of this slice |
| Completed review/test Artifact | New review/test Artifact types | New schema; out of this slice |
| Conversation compaction | A compaction implementation itself | A feature, not just a seam; out of this slice |
| Explicit import | A memory import path (Workspace import currently forces `memory: false`) | New surface; out of this slice |

## 5. Acceptance gates for the candidate slice (proposed)

| Gate | Requirement |
|---|---|
| MF2T-01 | `POST /memory/entries` creates an active Entry transactionally and emits one `memory.entry_created` Workspace Event in the same transaction |
| MF2T-02 | The saved Entry is retrievable through the MF-3 retrieval path with `authority = 'user-explicit'` |
| MF2T-03 | A duplicate exact/normalized-hash save converges (no second Entry) and emits no second Event |
| MF2T-04 | The legacy `POST /memories` surface is byte-for-byte unchanged and writes no `workspace_events` row |
| MF2T-05 | The new route stays out of the Run stream: no `runtime_events`, no Outbox, no `operations` row |
| MF2T-06 | A failed write rolls back the Entry, the Event, and the consumed sequence together |

## 6. Prohibitions for the candidate slice

- No new table or migration; no edit to migrations `001`-`025`.
- No change to the MF-0 promotion gate or the review queue contract.
- No change to the legacy `memories` surface.
- No Run-scoped behavior change.
- No approval / Artifact / compaction / import work (each deferred, §4.2).
