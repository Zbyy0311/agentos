# S1-A: terminal evidence deduplication

Scope: `LITE-07-003`, `LITE-07-107`; baseline `b3c3a982`.
Status: implemented; PR #143 CI gate pending. No required check bypass.
Implementation authorized by the user-approved tightened plan, after S0 v1 freeze.

## Counterexample and boundary

`MemoryCandidateGenerationService` queries exact/normalized/FTS matches by
Workspace only. An active Entry owned by another Task can swallow a generated
Candidate; archived Entries can do the same. An exact hit returns without
adding the real Run source, a version, or a corresponding Event.

Only fix the existing terminal generator and the minimal MF-1/MF-5 helpers it
needs. Keep terminal success eligibility, IDs, evidence composition and review
gate unchanged. No migration, new event type, general Memory framework, or
approval/save/Artifact rewrite. Existing explicit-save defects remain under
the same open matrix ID for a later bounded slice.

## Contract

- Generator exact/normalized/FTS matches require the same Workspace, Scope,
  all owners, category, and active status. No cross-owner convergence.
- Exact convergence rereads the target inside BEGIN IMMEDIATE, validates the
  same boundary/hash and adds missing source references without changing content,
  authority, scope, confidence or previous Context Snapshots.
- A source-set change increments Entry version once and updates its timestamp;
  replay with the same source is a no-op.
- Production uses existing `memory.entry_deduplicated` Runtime Event + Outbox,
  with the real Run's existing durable causal authority in the SAME transaction.
  Candidate creation and near-duplicate review continue on existing MF-5 paths.
- Source/Event/Outbox failure rolls back sources, version and sequence together.

## Exit tests

1. Other Task/Scope/category and non-active exact matches do not converge.
2. Near-duplicate signals cannot cross Task ownership or non-active status.
3. Same boundary exact match preserves old sources, adds actual Run source,
   increments version once; replay adds neither version nor Event.
4. Production emission has one source mutation + Event + Outbox; injected
   Event/Outbox failure leaves the earlier Entry and sequence unchanged.
5. Existing generator/repository/emitter tests and server typecheck pass.

This slice alone does not mark either matrix ID PASS: explicit-save and
review-promotion convergence still require their own counterexample-driven work.

## Evidence (Windows, Node v24.18.0)

- RED: new generator regression tests against original product code: 7 pass,
  6 fail, 0 skip (five boundary leaks and missing provenance); preserved as
  `S1A-RED` in the matrix evidence ledger.
- GREEN: `node --import tsx --test --test-concurrency=1
  src/services/MemoryCandidateGenerationService.test.ts
  src/services/MemoryCandidateGenerationService.emission.test.ts
  src/services/MemoryRuntimeEventEmitter.test.ts
  src/store/MemoryEntryRepository.test.ts
  src/store/MemoryCandidateRepository.test.ts` in `apps/server`: 85 pass,
  0 fail, 0 skip. Includes source/Event/Outbox rollback, cross-Run causal rejection
  and no-op replay; no provider invocation claimed.
- `pnpm exec tsc --noEmit` in `apps/server`: exit 0. First typecheck caught
  a test-only duplicate `ownerTaskId` spread; test fixture now uses `Object.assign`.
- Independent Luna review raised a lookup-to-transaction archive race. The
  target is now rechecked before mutation and an ineligible match returns to
  normal Candidate generation. A deterministic emitter interposition test
  verifies the archived Entry stays unchanged and exactly one Candidate Event
  + Outbox is committed; actual persistence failures still roll back and throw.
- S0 validator tests: 8 pass, 0 fail; `--require-closed` intentionally refuses
  closure while 219 GAP/RUNTIME-VERIFY rows remain open.
- Additional affected-path regression at `8e4cc3ae`:
  `node --import tsx --test --test-concurrency=1 src/routes/memoryRuntime.test.ts
  src/services/MemoryContextResolver.test.ts src/store/MemoryContextSnapshotRepository.test.ts`
  in `apps/server`: 33 pass, 0 fail, 0 skip. Existing explicit save, review,
  injection and frozen Snapshot behavior retained; not evidence that their open
  GAP/RUNTIME-VERIFY rows are all closed.

No claim of S1, Artifact, or Lite completion is made by these local checks.

### First full local run (before the archive-race remediation)

Delegate: GPT-5.6 Luna, effort=max; no automatic rerun.

- `node --import tsx --test --test-concurrency=1 src/**/*.test.ts` in
  `apps/server`: exit 1; 2712 tests, 2705 pass, 4 fail, 3 skip, 0 cancelled.
- Failures are preserved, not counted as PASS:
  - `worktree routes keep path private and require clean/confirmed cleanup gates`:
    `ENOTEMPTY`, `routes/worktrees.test.ts:55`, final `rmSync(root)`.
  - `worktree cleanup requires a terminal Run before recovery confirmation`:
    `ENOTEMPTY`, `routes/worktrees.test.ts:81`, final `rmSync(root)`.
  - `parallel_isolated gives write-capable workers execution-specific worktrees and recovery bundles`:
    `ENOTEMPTY`, `services/ConversationService.test.ts:596`, final `rmSync(root)`.
  - `[M27-P3-T005] Source preflight runs under acquired-and-released Ownership with zero Backup and zero Attempt`:
    `ENOTEMPTY`, `services/LegacyTaskItemImportService.test.ts:126` via line 383,
    fixture cleanup after the junction rejection check.
- Source inspection: all four failure sites are temporary-directory teardown;
  these tests and their Worktree/Conversation/import product paths have no diff
  in S1-A. Evidence supports a teardown/environment failure, not a demonstrated
  S1-A assertion regression. A finally failure can mask an earlier error, so
  full-suite PASS is NOT inferred; exact-head CI must independently pass.
- `pnpm -r run build`: exit 0. The post-review product delta additionally passed
  the 85-test targeted set and fresh server typecheck documented above.

PR: https://github.com/Zbyy0311/agentos/pull/143
First CI head: `8e4cc3ae81bf2a92337662d329a2a10647aecfdb`.
First CI run: `34683702991`. Retain its result before any follow-up commit.
