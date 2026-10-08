# MF-5 Workspace Event Stream — Implementation Record

Status: IMPLEMENTED on `runtime/mf5-workspace-event-stream`; gates
`MF5W-A1`..`MF5W-A18` evidenced below. Migration ledger `001`-`025`.

## 1. Authority and scope

Implements the frozen package
`docs/implementation/milestones/MF5-workspace-event-schema-authorization.md`
(PR #127, merge `d58c998c`): section 6 schema, 7 shared contracts, 8 authority
and writer, 9 wiring seams, 10 cross-cutting rules, 13 acceptance matrix.
Nothing in section 14 was touched: no Outbox row, no publication/SSE, no
Inspector projection, no UI, no Run-scoped behavior change, no new Memory event
type or table, no edit to migrations `001`-`024`, no change to the legacy
`memories` / `memory_candidates` surface.

This closes the contract gap recorded since PR #120: a Workspace-scoped Memory
fact (user-initiated Candidate review and conflict resolution, which carry no
Run) now commits its canonical Event without fabricating a Run.

## 2. Migration 025

`apps/server/src/migrations/migrations/025-mf5-workspace-event-stream.ts` adds:

- `workspaces.next_event_sequence INTEGER NOT NULL DEFAULT 1` (section 6.1);
- `workspace_events` with the exact section 6.2 column set, `UNIQUE
  (workspace_id, sequence)`, no Run-bound column, FK
  `workspaces(id) ON DELETE RESTRICT`;
- exactly ONE trigger, `workspace_events_reject_update` (`BEFORE UPDATE` ->
  `RAISE(ABORT,'WORKSPACE_EVENT_APPEND_ONLY')`) per the authoritative section
  6.3;
- two indexes; prerequisite guard fails closed with
  `MIGRATION_PREREQUISITE_MISSING: 025 requires workspaces` and records no
  migration state;
- registered in `default-registry.ts` / `EXPECTED_MIGRATION_IDS` (ends `'025'`)
  and in the integration acceptance list.

## 3. Shared contracts

`packages/shared/src/types/mf5-workspace-events.ts` owns the envelope and the
frozen appendable-type allowlist (section 7.3, eight Memory fact types) plus
`WORKSPACE_EVENT_FORBIDDEN_ENVELOPE_KEYS`, so a Run-bound reference cannot be
represented (A8). `CentralRuntimeEventRegistry.publishWorkspace` and
`validateWorkspaceEnvelopeShape` (section 7.2) reuse the existing payload and
envelope validation unchanged and refuse an allowlisted-but-unregistered type.
The Harness `Shared MF-5 Workspace event harness` step runs the new contract
suite in CI.

## 4. Store layer

- `WorkspaceSequenceAllocator.allocateWithinTransaction` - one statement,
  `next_event_sequence + 1` on the owning `workspaces` row, so a rolled-back
  append returns the counter and never leaves a gap. It never touches
  `workspaces.version`.
- `WorkspaceEventRepository` - the only writer of `workspace_events`: validates
  id/timestamp, publishes through the Workspace registry path, refuses a
  non-durable Event, canonicalizes payload JSON, inserts exactly one row, and
  writes no Outbox, `runtime_events`, or `operations` row. Readers
  `findById` / `findByWorkspaceAndSequence` / `listByWorkspaceAfterSequence` /
  `countForWorkspace` serve the Workspace Read Stream.
- `WorkspaceEventWriter` - the ONE append path (section 8.2): requires an
  active transaction, proves the caller's origin claim, re-proves the subject
  inside the same Workspace, then allocates and inserts. Construction fails
  closed (`WORKSPACE_EVENT_WRITER_NOT_BOUND`) if any collaborator is bound to a
  different connection.
- `DurableWorkspaceEventContextAuthority` (section 8.1) - claim-then-proof: the
  stored Candidate review / resolved Conflict owns the correlation, the claim
  must equal the derived chain, and an optional `parentEventId` must be an
  existing Event of the SAME Workspace. `canonical_command` and every
  Run-derived origin fail closed.
- Section 6.5 delete path: `SqliteStore.deleteWorkspace` and
  `WorkspaceRepository.deleteById` delete `workspace_events` inside the same
  transaction, before the `workspaces` row, and change neither the tombstone
  nor the existing ordering.

## 5. Fact-layer wiring (section 9 seams)

| Seam | Wiring |
|---|---|
| `MemoryCandidateRepository.reviewCandidate(input, emission?)` | fact + Events in ONE transaction; `emission === undefined` preserves the previous behavior exactly |
| `MemoryCandidateRepository.resolveConflict(input, emission?)` | same; plus the section 8.4 prerequisite |
| `POST .../memory/candidates/:id/review` | passes `{ writer: store.workspaceEventWriter() }` |
| `POST .../memory-conflicts/:id/resolve` | passes `{ writer: store.workspaceEventWriter() }` |
| `SqliteStore` | one repository + ONE writer over the store's single connection, exposed as `workspaceEventWriter()` |
| delete paths | `SqliteStore.deleteWorkspace`, `WorkspaceRepository.deleteById` |

Frozen ordering (section 8.3) is asserted: `memory.candidate_reviewed` first,
then `memory.entry_created` / `memory.entry_deduplicated` for the Entry the
review actually persisted (a `reject` appends one Event);
`memory.conflict_resolved` first, then one Event per Entry whose status the
disposition actually changed, carrying the PERSISTED Entry version.

Payloads stay inside the section 7.2 guards - ids, versions, scope metadata and
outcomes only, never Entry content (A16). A status change that would need a type
outside the allowlist (`memory.entry_conflicted` / `_archived` / `_expired`) is
refused by the writer, which fails the transaction closed instead of recording a
half-described fact.

### Deliberate, recorded gap

`openConflict` is NOT in the section 9 wiring table, so this slice does not
append `memory.conflict_opened` even though section 7.3 allowlists it for the
same-transaction conflict insert. Opening a conflict is therefore still a
fact-only write. Widening the wiring list is a new authorization decision, not
an implementation detail.
an implementation detail.

## 6. Acceptance matrix

| Gate | Evidence |
|---|---|
| MF5W-A1 | `integration.test.ts` fresh `001`-`025`; `27/27` PASS |
| MF5W-A2 | `mf5-migration-025.test.ts` upgrade from `024`: earlier objects byte-identical, `version` untouched, `next_event_sequence = 1` |
| MF5W-A3 | `mf5-migration-025.test.ts` idempotency + absent-prerequisite guard, no `025` record |
| MF5W-A4 | `mf5-migration-025.test.ts` update rejected by trigger; unsanctioned delete order blocked |
| MF5W-A5 | `WorkspaceEventWriter.test.ts` per-Workspace unique/contiguous sequences, rollback returns the counter, `workspaces.version` unmoved |
| MF5W-A6 | `WorkspaceEventWriter.test.ts` proven chain commits; foreign Workspace, pending/stale subject, forged correlation/causation, Run-derived origin, absent/malformed parent all refused with zero writes |
| MF5W-A7 | `WorkspaceEventWriter.test.ts` registered-but-not-allowlisted and unknown types refused before any sequence is consumed |
| MF5W-A8 | `WorkspaceEventWriter.test.ts` run-bound envelope keys refused by the registry; the writer's projection carries no such column |
| MF5W-A9 | `WorkspaceEventWriter.test.ts` and the route suite: no Outbox, `runtime_events`, `operations`, or Run-sequence row is created |
| MF5W-A10 | `WorkspaceEventWriter.test.ts` review/resolution fact + Events in one transaction, exact section 8.3 order; route suite proves the seam end to end |
| MF5W-A11 | `WorkspaceEventWriter.test.ts` injected failure on the second Event rolls back the fact, the first Event, and the sequence |
| MF5W-A12 | `WorkspaceEventWriter.test.ts` repeated review and repeated resolution append no second Event |
| MF5W-A13 | `WorkspaceEventWriter.test.ts` payload identity/version equal the persisted row, including a real version bump and append-only immutability |
| MF5W-A14 | Memory suites `73/73` + `66/66`, migrations `70/70`, routes `10/10`, shared harnesses; full Server run recorded in section 7 |
| MF5W-A15 | `WorkspaceEventWriter.test.ts` + `WorkspaceEventWorkspaceDeletion.test.ts`: delete succeeds with Events present, removes exactly that Workspace's rows, leaves no orphans; a bare `DELETE FROM workspaces` still fails |
| MF5W-A16 | `WorkspaceEventWriter.test.ts` no content/secret marker in any stored payload; the payload guard refuses a content-carrying payload |
| MF5W-A17 | `memoryCandidates.test.ts`: the legacy routes still behave identically, create no `workspace_events` row, and consume no sequence |
| MF5W-A18 | `WorkspaceEventWriter.test.ts` a lost resolution race is rejected by `changes === 1` with the fact and the stream untouched |

## 7. Findings

### 7.1 The authorization's section 5 inventory contradicts its own section 6.3

Section 5 describes "one column and one table" with "two append-only
triggers"; section 6.3 - the authoritative schema section - freezes exactly ONE
trigger (`BEFORE UPDATE`). The second trigger in the earlier drafts was a
`BEFORE DELETE` guard, which cannot coexist with the required Workspace
hard-delete path of section 6.5: a `BEFORE DELETE` trigger also fires for the
FK cascade a Workspace delete performs, so the sanctioned path would abort.
The implementation follows section 6.3 (one trigger) and the delete paths of
section 6.5. Section 5 is stale and should be corrected the next time that
document is edited.

### 7.2 Workspace hard delete is already blocked by earlier slices (pre-existing)

Both section 6.5 paths are proven for a Workspace whose rows are its Events,
its Candidates and its profile. They are NOT usable yet for a Workspace that
has actually used Memory or the Run runtime, because earlier merged slices
forbid deleting their rows and `deleteWorkspace` never removes them:

| Blocker | Source | Effect |
|---|---|---|
| `memory_entries_no_delete` (`RAISE(ABORT,'MEMORY_ENTRY_DELETE_FORBIDDEN')`) | migration `017` | `DELETE FROM workspaces` cascades into `memory_entries` and aborts |
| `memory_context_snapshots` delete rejection | migration `018` | same cascade abort |
| `runtime_events` FK `ON DELETE RESTRICT` and its reject-delete trigger | migration `012` | a Workspace with Run events cannot be deleted |
| `provider_sessions` / `runtime_processes` / `process_output_references` reject-delete | migration `014` | same for M4 process rows |

This is unchanged by, and independent of, this slice: none of those objects was
touched here, and the MF-5 rule only adds the `workspace_events` child delete
that the RESTRICT FK requires. Gate `MF5W-A15` is therefore proven on the
subset this slice owns (candidate review Events, no Entry), and the broader
question - whether a Workspace that has used Memory may be hard-deleted at all,
and if so how MF-1/MF-4 rows leave - needs its own authorization:
`deleteWorkspace` would have to gain explicit child handling, which section 14
of this package does not permit.

## 8. Verification

| Command / suite | Result |
|---|---|
| `npx tsc --noEmit -p tsconfig.json` (apps/server) | exit 0 |
| `src/store/WorkspaceEventWriter.test.ts` | 12/12 PASS |
| `src/store/WorkspaceEventWorkspaceDeletion.test.ts` | 1/1 PASS |
| `src/migrations/__tests__/mf5-migration-025.test.ts` | 3/3 PASS |
| `src/migrations/__tests__/integration.test.ts` | 27/27 PASS |
| `packages/shared/mf5-workspace-events.test.ts` | 8/8 PASS |
| Memory service/repository suites (9 files) | 66/66 PASS |
| Memory candidate/entry/emitter/authority suites (5 files) | 73/73 PASS |
| `src/routes/memoryRuntime.test.ts` + `memoryCandidates.test.ts` | 10/10 PASS |
| `pnpm --filter @agentos/shared build` | exit 0 |
| Full Server suite (`node --import tsx --test --test-concurrency=1 "src/**/*.test.ts"`, first run, not rerun) | 2673 total, 2666 passed, 4 failed, 3 skipped |

The 4 failures are the pre-existing Windows `ENOTEMPTY` teardown failures of
unrelated temp-root suites (`agentos-worktree-route-*`,
`agentos-conversation-service-*`, `agentos-m27-p3-tasks-*`), the same family the
Lite Fast-Track record already carries. They were not chased and no product code
was changed to mask them.

## 9. Ledger bookkeeping

Adding `025` to the registry required the same additive updates earlier
migrations made: every acceptance list that pins the applied ledger now ends at
`025` (`M2MigrationRegistryAcceptance.test.ts`, `integration.test.ts`,
`m2-4`/`m2-5`/`m2-6`/`m2-8-p3`/`m3-p2a`/`m3-p2c0`/`m4-p2`, `SqliteStore.test.ts`,
`TaskRunService.test.ts`), and the partial-schema registry builders that exclude
later migrations now also exclude `025`, so a test that intentionally stops at
`012`/`013`/`014`/`015` still stops there instead of silently applying the new
migration. `WorkspaceRepository.test.ts`'s hand-rolled fixture gained the
`workspace_events` child table because the repository's delete path now deletes
its rows first.
