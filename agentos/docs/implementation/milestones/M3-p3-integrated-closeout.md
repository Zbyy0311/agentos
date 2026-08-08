# M3 P3 Integrated Closeout — Run Engine, Workflow Executor and Operation

Status: M3 P3 INTEGRATED VERIFICATION COMPLETE (test/docs only)
P3E entry production baseline: `7efecc67a8f8cb8abe64a4ceefe7f144d22ec17e`
P3E integrated verification evidence: `400a3b29697b7185d29df2cb9da0417260549913`
P3E production behavior change: NONE
Migration 014: NOT REQUIRED / ABSENT
Production Cutover: NOT PERFORMED
Remote Checks: UNAVAILABLE — NOT PASS
P3 package merge state: authoritative Git history / PR record (this document
does not predict a future merge commit)

## A. Scope

This document is the integrated closeout record for M3 P3 (Run Engine,
Workflow Executor and Operation). It records the P3E integrated verification
stage and the final cross-stage evidence state.

- P3E stage scope: test-harness additions and documentation only.
- P3E production behavior change: NONE.
- P3E added exactly one integrated test file
  (`apps/server/src/services/m3-p3e-integrated-verification.test.ts`) and the
  P3E-2 documentation alignment recorded here.
- This closeout changes documentation only. It does not authorize Production
  Cutover, Migration 014, M4 work, or any new production implementation.

## B. Entry Baseline

- P3E entry production baseline (main):
  `7efecc67a8f8cb8abe64a4ceefe7f144d22ec17e` — the ordinary two-parent Merge
  Commit of PR #38
  (`Merge pull request #38 from Zbyy0311/runtime/m3-p3d3-operation-cancel-race-closure`).
- P3E integrated verification evidence commit:
  `400a3b29697b7185d29df2cb9da0417260549913`
  (`test: add M3 P3 integrated verification`), a test-only commit on branch
  `runtime/m3-p3e-integrated-verification`.
- P3E-2 documentation alignment is a docs-only commit on the same branch.

## C. Dependency Closure

All P3E dependencies are accepted and merged. Merge evidence verified from
Git history (`git merge-base --is-ancestor` against main):

| Stage | PR evidence | Merge commit | Status |
| --- | --- | --- | --- |
| P3A | #23 | `35d69eed` | ACCEPTED / MERGED |
| P3B-1 | #24 | `48a5d518` | ACCEPTED / MERGED |
| P3B-2A | #25 | `321fa278` | ACCEPTED / MERGED |
| P3B-2B | #26 | `74fffb94` | ACCEPTED / MERGED |
| P3C-0A | #27 | `293895df` | ACCEPTED / MERGED |
| P3C-0B | #28 / Option A #29 | `82bee504`, `8477e1f0` | ACCEPTED / MERGED |
| P3C-1 Start | #31 | `53b5fc78` | ACCEPTED / MERGED |
| P3C-1 Retry | #33 (closeout #34) | `de0b88fb`, `5bfa66d0` | ACCEPTED / MERGED |
| P3D-1 | #36 | `e737ba8e` | ACCEPTED / MERGED |
| P3D-2 | #37 | `eb2b437a` | ACCEPTED / MERGED |
| P3D-3 | #38 | `7efecc67` | COMPLETE / MERGED |

## D. Integrated Evidence (E1–E6)

New P3E evidence below refers to commit
`400a3b29697b7185d29df2cb9da0417260549913`; retained targeted evidence refers
to the previously merged suites, which remain authoritative for their layers
and were re-executed during P3E-1 as regression gates.

### E1 — Start integrated chain

- New P3E evidence (P3E-I01): one unbroken chain over the same persisted
  objects — Create Run, HTTP 202 `run.start` acceptance (queued Operation v1,
  `correlationId = operation.id`, Run stays queued), RunEngine
  execution-authorized claim of the HTTP-returned Operation, `run.dequeued`,
  atomic startup completion (first Stage running, Run running, Start
  Operation completed v3, `stage.started` before `run.started`),
  deterministic remaining Stage execution to Run `completed`, completed Start
  Operation never rewritten, HTTP GET Operation (no `progress`), HTTP GET
  Operation Events bound to the persisted runId/correlationId in ascending
  sequence, and immutable HTTP replay of the original queued/v1 Start
  snapshot after the Run reached a terminal state.
- Retained targeted evidence: route acceptance/replay suites
  (`runLifecycle.test.ts`), claim and startup atomicity suites
  (`RunEngine.test.ts`, `m3-p3b2-atomic-startup-completion.test.ts`),
  Operation read suites (`operations.test.ts`).

### E2 — Retry + independent Start (Option A)

- New P3E evidence (P3E-I02): failed Parent, HTTP 201 `run.retry` acceptance
  (queued Child v1 with correct parent/root lineage, completed v3 Retry
  Operation, Parent and Task unchanged, cloned persisted Snapshot V2, fresh
  pending Child Stages), Retry-only Engine tick returns `no-authorization`
  with zero claim writes, independent HTTP 202 `run.start` on the Child,
  Engine claim authorized only by the Start Operation, execution Events
  correlated to the Start Operation ID, Retry Operation remains completed v3
  and byte-identical, Retry Operation Events query returns an empty list
  (Child creation and independent Start execution excluded), and immutable
  HTTP replays of both the original 201 Retry envelope and the original 202
  Child Start snapshot after the Child reached a terminal state.
- Retained targeted evidence: Retry acceptance/lineage suites
  (`TaskRunService.test.ts`, `SnapshotService.test.ts`,
  `runLifecycle.test.ts`), Retry-no-authorization and Start-only claim
  (`RunEngine.test.ts`), correlation isolation (`operations.test.ts` R14/R15).

### E3 — Immutable replay after state changes

- New P3E evidence: replays in I01/I02 are performed after real Engine
  execution reached terminal states; both return the original acceptance-time
  HTTP snapshot with `Idempotency-Replayed: true` and a body byte-identical
  to the original acceptance response.
- Retained targeted evidence: service/route-level replay suites
  (`IdempotencyService.test.ts`, `TaskRunService.test.ts`,
  `runLifecycle.test.ts`).

### E4 — Failure classes

- A1 (Start acceptance rollback), A2 (Retry acceptance rollback), Class B
  (Engine claim transaction rollback), C1a (pre-claim failure recording),
  C1b Branch A (Stage entered starting), and C2 (post-start outcome;
  completed Start Operation never rewritten) remain covered by the retained
  merged suites (`TaskRunService.test.ts`, `RunEngine.test.ts`,
  `m3-p3b2-atomic-startup-completion.test.ts`).
- New P3E evidence (P3E-I03): C1b Branch B (Run starting, Operation running,
  no Stage entered starting) normal closure — Run and Operation fail
  atomically with `run.failed` only and no fabricated `stage.failed` — plus a
  rollback injection matrix over the real Branch B transaction positions (Run
  transition, `run.failed` Event insert, `run.failed` Outbox insert,
  Operation failed transition, outer commit boundary). Each injection proves
  full business-state and full persistence-state equality before/after, with
  `PRAGMA integrity_check = ok` and `PRAGMA foreign_key_check = []`.

### E5 — P3D Cancel / race matrix (retained evidence, re-verified)

The merged P3D suites remain the authoritative evidence and passed unchanged
during P3E-1 regression:

- Claim vs cancel, startup completion vs cancel, startup failure vs cancel,
  duplicate cancel, already-cancelled no-op, and terminal
  (`OPERATION_NOT_CANCELLABLE`) cancel: `RunEngine.test.ts` P3D-3 Race A–D,
  `operations.test.ts` C13–C27, `OperationService.test.ts` cancel suites.
- Race precedence: B2 (completion-first) cancel loser = `VERSION_CONFLICT`;
  C2 (failure-first) cancel loser = `VERSION_CONFLICT`.
- `OPERATION_NOT_CANCELLABLE` is not accepted as a B2/C2 race loser.
- Exactly one Cancel Operation exists; no second Cancel Operation is created.
- P3E added no new race machinery and no Cancel production behavior.

### E6 — Operation read / event query (retained evidence, extended by I01/I02)

- Retained targeted evidence: `operations.test.ts` R01–R17 (opaque locator,
  workspace isolation at repository/service layer, persisted
  runId/correlationId binding, ascending sequence, unknown future Event safe
  handling, retry correlation isolation, `progress` absent).
- New P3E evidence: I01/I02 exercise the same HTTP read surface against
  Events produced by real Engine execution on the same persisted Operation
  (no manually constructed Events), including Retry Operation Events returning an
  empty list after independent Child execution.
- P3E added no SSE and no new read surface.

## E. P3E-I01 / I02 / I03 (evidence commit `400a3b29`)

- **P3E-I01** (`P3E-I01 HTTP start acceptance drives real engine execution to
  terminal with HTTP operation read and immutable replay`): proves the Start
  chain recorded in E1 above, including contiguous Run event sequence,
  exactly one Outbox row per Runtime Event, completed Start Operation
  snapshot equality before/after terminal outcome, and integrity/FK checks.
- **P3E-I02** (`P3E-I02 retry acceptance requires independent child start
  with correlation isolation and immutable replays`): proves the Option A
  chain recorded in E2 above, including Retry-only `no-authorization` tick,
  Start-only claim, Retry/Start correlation isolation via HTTP, and both
  immutable replays.
- **P3E-I03** (`P3E-I03 C1b Branch B closes Run and Operation without
  fabricating stage failure` plus five `... rolls back completely when ...`
  injection cases): proves the Branch B normal closure and rollback matrix
  recorded in E4 above.

Test count: 8 tests, all passing (see section G).

## F. Failure / Race Closure

Failure classes:

- A1 Start acceptance rollback: retained evidence (`TaskRunService.test.ts`
  P3C1-S16/S17); no partial Operation, idempotency, Run, Task, Event, Outbox,
  or dead-letter state.
- A2 Retry acceptance rollback: retained evidence (`TaskRunService.test.ts`
  P3C1-RY-S09, nine injection positions); full cross-aggregate rollback.
- Class B Engine claim rollback: retained evidence (`RunEngine.test.ts`
  five-position claim rollback matrix).
- C1a pre-claim failure recording: retained evidence
  (`m3-p3b2-atomic-startup-completion.test.ts`, `OperationService.test.ts`).
- C1b Branch A: retained evidence (eight-position rollback matrix in
  `m3-p3b2-atomic-startup-completion.test.ts`).
- C1b Branch B: new P3E-I03 evidence (normal closure + five-position rollback
  matrix).
- C2 post-start outcome: retained evidence; completed Start Operation is
  never rewritten by a later Run terminal outcome.

Cancel races (retained P3D evidence, re-verified in P3E-1 regression):

- Claim vs cancel: exactly one winner per deterministic lock order; loser
  leaves no partial state.
- Startup completion vs cancel: B1 cancel-first loser =
  `RUN_ENGINE_AUTHORIZATION_NOT_RUNNING`; B2 completion-first cancel loser =
  `VERSION_CONFLICT`.
- Startup failure vs cancel: C1 cancel-first loser =
  `RUN_ENGINE_AUTHORIZATION_NOT_RUNNING`; C2 failure-first cancel loser =
  `VERSION_CONFLICT`.
- Duplicate cancel: one side-effect package in both caller orders; no second
  Cancel Operation.
- Already cancelled: stable no-op, including stale `expectedVersion`.
- Terminal cancel: completed/failed Operations are `OPERATION_NOT_CANCELLABLE`.

## G. Verification

### LOCAL EXECUTION EVIDENCE — NOT GITHUB CI

The following numbers were produced by local execution during P3E-1 on the
evidence commit. They are not remote CI results.

- P3E integrated (`m3-p3e-integrated-verification.test.ts`): 8 total, 8 pass,
  0 fail, 0 skip, exit 0.
- Targeted regression groups (total/pass):
  - RunEngine: 22/22
  - P3B-2B (`m3-p3b2-atomic-startup-completion.test.ts`): 33/33
  - runLifecycle: 51/51
  - operations: 46/46
  - OperationService: 29/29
  - TaskRunService: 92/92 and 34/34
  - SnapshotService: 12/12
  - IdempotencyService: 30/30
  - IdempotencyRepository: 43/43
  - OperationRepository: 22/22
  - RunRepository: 28/28
  - RunStageRepository: 9/9
  - SqliteStore: 36/36
- Full Server: 1453 total, 1451 pass, 0 fail, 2 skip, exit 0.
- Agent-core: 123 pass, exit 0.
- Shared M3 runtime targeted: 25/25, exit 0.
- Web: 86/86, exit 0.
- Web production build: PASS.
- WEB TSC: BASELINE REPRODUCED — NOT PASS (7 existing errors: 6 × TS5097,
  1 × TS2741; Web diff = 0).
- `git diff --check`: PASS.

### Remote checks

REMOTE CHECKS: UNAVAILABLE — NOT PASS

These two categories are not combined. The local numbers above are not
relabeled as remote CI.

## H. Schema / Data Boundary

- Migration Registry = 001–013 (registry entry count 13, last entry
  `migration013`).
- Migration 014 = ABSENT; schema blocker = NONE.
- Real `.agentos/agentos.sqlite` accessed: NO. All P3E tests use temporary,
  file-backed, isolated SQLite databases under temporary roots.
- Existing migration checksums unchanged; no DDL or schema change.
- Production Cutover: NOT PERFORMED.

## I. Deferred / Out-of-Scope

M3 P3 did not deliver, and this closeout does not claim:

- real ProviderAdapter execution
- ProcessManager runtime
- CLI process execution
- Worktree production runtime
- Policy implementation
- Approval implementation beyond the existing lifecycle contract
- SSE/Replay completion
- Web default cutover
- Legacy retirement
- Production migration/restore/cutover
- M4 or later milestone work

## J. Closeout Claim

M3 P3 INTEGRATED VERIFICATION:
COMPLETE

P3E PRODUCTION CODE CHANGE:
NONE

P3 PRODUCTION CUTOVER:
NOT PERFORMED

This document does not claim that the P3E branch has merged into main. Git
history and the PR record are authoritative for merge state.
