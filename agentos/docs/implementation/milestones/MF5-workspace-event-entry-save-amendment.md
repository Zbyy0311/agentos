# MF-5 Workspace Event Stream — Entry-Save Origin Amendment

Status: AMENDMENT PROPOSED — awaits owner merge; no implementation authorized
by this document.

Base: `origin-https/main @ 803c4ac0` (post PR #134). Amends
`MF5-workspace-event-schema-authorization.md` (PR #127). Motivated by the MF-2
remaining-trigger audit (`MF2-triggers-audit.md`, PR #135).

## 1. What this amends and why

The frozen package's section 8.1 declares exactly two provable origins
(`memory.candidate_review`, `memory.conflict_resolution`) and deliberately leaves
a `candidate_acceptance`-style origin undefined, because at that revision the only
accept route wrote the legacy `memories` table (§2.1) and a forward accept route
did not exist.

The MF-2 audit then proposed an "explicit user save" slice that would create a
Memory Entry through a forward route. Two constraints collide with that
proposal:

1. section 8.1's two-origin freeze means the writer refuses a user-save origin
   (`WORKSPACE_EVENT_ORIGIN_UNPROVEN`);
2. the section 7.3 allowlist does not include `memory.candidate_created`, and a
   user save produces no Candidate review the review origin could prove.

So the proposal as written is not implementable against the frozen
authorization. This amendment makes it implementable by defining the one origin
it needs, additively, without touching the two existing origins or the
allowlist.

## 2. The new origin

`WorkspaceEventOriginV1` gains exactly one member:

```text
memory.entry_save  { entryId, entryVersion }
```

Proof required in the same Workspace (mirrors section 8.1's claim-then-proof):
the `memory_entries` row exists with that id and version. The derived
correlation is `memory-entry:<entryId>:v<version>`; the causation is the Entry
id. The caller's claim must equal the derived value, and a foreign-Workspace or
unproven claim fails closed with `ORIGIN_UNPROVEN` with zero writes.

The only type it may emit is `memory.entry_created` — already on the section 7.3
allowlist, so the allowlist is untouched. A user save creates one Entry and emits
exactly one `memory.entry_created` Event for it.

## 3. What this amendment does NOT change

- The two existing origins and their proofs are byte-for-byte unchanged.
- The section 7.3 allowlist is untouched (no new type is added).
- The migration ledger is untouched (`025` already created `workspace_events`).
- The legacy `memories` / `memory_candidates` surface stays out of scope (§15.6).

## 4. The slice this enables (not authorized by this document)

With the origin defined, the explicit-user-save slice becomes: a forward route
`POST /memory/entries` that, in one transaction, creates the Entry through
`MemoryEntryRepository.createEntry` and appends `memory.entry_created` through
`store.workspaceEventWriter()` with origin `memory.entry_save`. The fact and its
Event commit together; a failed append rolls back the Entry and the consumed
sequence. That route and its tests are a separate implementation slice that
follows this amendment's merge.

## 5. Gates this amendment must satisfy

| Gate | Requirement |
|---|---|
| MF5W-E1 | The writer accepts `memory.entry_save` and proves it against the `memory_entries` row in the same Workspace |
| MF5W-E2 | A user-save emit appends exactly one `memory.entry_created` Event in the Entry's transaction |
| MF5W-E3 | A foreign-Workspace or unproven claim fails closed with `ORIGIN_UNPROVEN` and zero writes |
| MF5W-E4 | The two existing origins and the allowlist are unchanged; every existing MF-5 suite stays green |
| MF5W-E5 | A rolled-back save consumes no sequence and leaves no Event |

## 6. Prohibitions (unchanged from the frozen package)

- No edit to migrations `001`-`025` or their checksums.
- No Outbox, publication, SSE, Inspector, or UI work.
- No new Memory event type, Memory table, or Memory lifecycle rule.
- No change to the legacy `memories` / `memory_candidates` surface.
