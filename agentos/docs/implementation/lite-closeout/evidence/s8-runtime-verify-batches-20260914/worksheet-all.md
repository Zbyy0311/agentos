# RUNTIME-VERIFY 判读工作表（0..105 / 共 106 行待判读）

## `LITE-00-002`  00-Vision.md · 17. Acceptance Expectations

**条款**：Conversation and Message records survive reconnect and restart;

- 点名文件：`(未记录)`（not-in-batch，raw exit null，计数 null）
- 该文件实际执行过的断言（0 条）：


## `LITE-00-003`  00-Vision.md · 17. Acceptance Expectations

**条款**：Task, Run, Process, and Event remain distinct and traceable;

- 点名文件：`(未记录)`（not-in-batch，raw exit null，计数 null）
- 该文件实际执行过的断言（0 条）：


## `LITE-00-004`  00-Vision.md · 17. Acceptance Expectations

**条款**：a Run survives browser disconnect;

- 点名文件：`(未记录)`（not-in-batch，raw exit null，计数 null）
- 该文件实际执行过的断言（0 条）：


## `LITE-00-006`  00-Vision.md · 17. Acceptance Expectations

**条款**：Windows cancellation handles the owned process tree;

- 点名文件：`(未记录)`（not-in-batch，raw exit null，计数 null）
- 该文件实际执行过的断言（0 条）：


## `LITE-00-007`  00-Vision.md · 17. Acceptance Expectations

**条款**：recovery classifies uncertainty without guessing completion;

- 点名文件：`(未记录)`（not-in-batch，raw exit null，计数 null）
- 该文件实际执行过的断言（0 条）：


## `LITE-00-009`  00-Vision.md · 17. Acceptance Expectations

**条款**：concurrent read-only Runs cannot mutate the Workspace because admission requires tested `enforcedWorkspaceReadOnly` evidence;

- 点名文件：`(未记录)`（not-in-batch，raw exit null，计数 null）
- 该文件实际执行过的断言（0 条）：


## `LITE-00-010`  00-Vision.md · 17. Acceptance Expectations

**条款**：Memory selection is reproducible and explainable;

- 点名文件：`apps/server/src/services/MemoryContextResolver.test.ts`（passed，raw exit 0，计数 {"passed":17,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（17 条）：

  - [pass] MF4I-01 resolve persists a snapshot and returns bounded context
  - [pass] MF4I-02 resolve is idempotent per run scope
  - [pass] MF4I-03 stage scope is distinct from run scope
  - [pass] replaying an earlier scope after a later Stage does not recreate its snapshot
  - [pass] MF4I-04 snapshot failure blocks injection
  - [pass] MF4I-05 invalid input fails closed
  - [pass] MF4I-06 injection gate rejects absent snapshot
  - [pass] MF4I-07 later entry edits do not rewrite the snapshot
  - [pass] frozen injection survives content edits and logical deletion of its Entry
  - [pass] historical metadata-only snapshot is inspectable but blocks injection
  - [pass] payload failure rolls back the snapshot and its selections
  - [pass] corrupt frozen payload blocks replay
  - [pass] MF4I-08 empty store still persists a snapshot
  - [pass] MF4I-09 default budget is frozen and valid
  - [pass] MF4I-10 workspace isolation
  - [pass] LITE-07-109: new snapshots exclude ineligible content while historical snapshots stay frozen
  - [pass] LITE-07-013 MF4I-DEGRADED the persisted snapshot records the retrieval degradation

## `LITE-00-011`  00-Vision.md · 17. Acceptance Expectations

**条款**：Git changes are observable without AgentOS owning Git workflow execution;

- 点名文件：`apps/server/src/services/GitObservationCollector.integration.test.ts`（passed，raw exit 0，计数 {"passed":29,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（36 条）：

  - [pass] gitSnapshot reports stable state/code facts without cwd or raw diagnostics
  - [pass] GitObservationCollector integration failure diagnostics
  - [pass] observes a clean committed repository: canonical root/HEAD, clean complete status, available empty diff
  - [pass] observes a tracked dirty file: dirty status entry and non-empty diff
  - [pass] observes an untracked file: untracked status entry with an available empty diff
  - [pass] observes a staged rename with the NUL-framed previous path
  - [pass] nested Workspace A excludes dirty and untracked sibling Workspace B in status and diff
  - [pass] non-Git directory yields the exact C-locale NOT_GIT snapshot
  - [pass] unborn git init repository: GIT, null commits, complete clean status, diff not_applicable
  - [pass] unborn repository with an untracked file: complete dirty status while diff stays not_applicable
  - [pass] workspace, repository, and file paths containing spaces and Unicode
  - [pass] junction at the Workspace path is resolved first and never reports the lexical repository (fail closed)
  - [pass] junction inside the Workspace is fail-closed: escaped sibling content never appears in status or diff
  - [pass] GitObservationCollector real Git integration (production factory)
  - [pass] preserves distinct first/final HEAD SHAs across a real commit boundary
  - [pass] malformed HEAD output stays unavailable and is never unborn
  - [pass] legacy ambiguous rev-parse HEAD diagnostic stays unavailable and is never unborn evidence
  - [pass] missing executable maps through the controlled driver seam to not_found -> GIT_EXECUTABLE_UNAVAILABLE
  - [pass] unknown spawn failure maps through the controlled driver seam to frozen unknown -> GIT_COMMAND_SPAWN_FAILED
  - [pass] GitObservationCollector controlled seams around real command results
  - [pass] holds real NodeProcessDriver spawn resolution under launch budget, then arms family runtime
  - [pass] GitCommandAdapter real Windows launch/runtime deadline separation
  - [pass] deterministic timeout on a live real Git command after real handle/identity observation
  - [pass] deterministic cancellation of a live real Git command after real handle/identity observation
  - [pass] bounded_diff beyond 4 MiB maps to adapter output_limit with bounded retained stdout and proven owned-tree cleanup
  - [pass] bounded_diff beyond 4 MiB yields a truncated collector diff with diffBytes null and the same owned cleanup proof
  - [pass] porcelain_v2_status beyond 1 MiB maps to adapter output_limit with bounded retained stdout
  - [pass] porcelain_v2_status beyond 1 MiB is never clean or complete in the collector snapshot
  - [pass] >16 KiB stderr on a real owned Git command stays bounded and truncated while stdout stays intact
  - [pass] truncated stderr diagnostics never prove NOT_GIT and no raw diagnostic reaches the public snapshot
  - [pass] a truncated discovery diagnostic on a non-Git directory fails closed as UNAVAILABLE, never NOT_GIT
  - [pass] GitObservationCollector real Git bounds and Windows process ownership (Phase B)
  - [pass] real adapter + controlled unproven verification aborts collection after first HEAD, with no status/diff/final HEAD
  - [pass] GitObservationCollector cleanup-unproven through the real adapter (HIGH-1)
  - [pass] real NodeProcessDriver maps a missing git executable to not_found -> GIT_EXECUTABLE_UNAVAILABLE
  - [pass] GitCommandAdapter real Windows owned-spawn missing-Git (MEDIUM-1)

## `LITE-00-013`  00-Vision.md · 17. Acceptance Expectations

**条款**：Group Conversation and workflow templates remain bounded.

- 点名文件：`apps/server/src/services/BoundedGroupService.test.ts`（passed，raw exit 0，计数 {"passed":17,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（17 条）：

  - [pass] CR5S-01 a valid budget creates an active interaction; an invalid budget fails closed
  - [pass] CR5S-02 recording replies increments counters transactionally
  - [pass] CR5S-03 reaching the total cap exhausts the interaction with a stable reason
  - [pass] CR5S-04 a reply beyond the total cap is blocked and not recorded
  - [pass] CR5S-05 a per-Agent budget breach ends the interaction
  - [pass] CR5S-06 a distinct-Agent budget breach ends the interaction
  - [pass] CR5S-07 Stop blocks new replies and never cancels a Run
  - [pass] CR5S-08 a same-Agent cycle terminates the interaction with loop-guard
  - [pass] CR5S-09 repeated content terminates the interaction with loop-guard
  - [pass] CR5S-10 hops beyond the configured limit terminate the interaction
  - [pass] CR5S-11 a repeated mention with no new information terminates the interaction
  - [pass] CR5S-12 every recorded reply stores a distinct Turn-scoped per-Agent context snapshot
  - [pass] CR5S-13 per-Agent snapshots are isolated for the same interaction
  - [pass] CR5S-14 reply content is stored as a hash only, never as text
  - [pass] CR5S-15 the timeout budget ends the interaction
  - [pass] CR5S-16 unknown interaction and invalid input fail closed
  - [pass] CR5S-17 within-transaction composition rolls back atomically

## `LITE-01-004`  01-Core-Concepts.md · 16. Acceptance Expectations

**条款**：Task supports zero or many Runs;

- 点名文件：`apps/server/src/store/Identity.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（38 条）：

  - [pass] all prefix constants map to valid EntityIdKind
  - [pass] createEntityId produces prefix_ulid format
  - [pass] ULID body is 26 Crockford Base32 characters, no ILOU
  - [pass] same kind produces unique IDs
  - [pass] same kind produces unique IDs under heavy load
  - [pass] different kinds have different prefixes
  - [pass] isValidEntityId validates prefix and body
  - [pass] no database dependency
  - [pass] ULID matches known reference (timestamp=0, random=0)
  - [pass] first character always in 0–7 range
  - [pass] real 13-digit Unix-ms timestamp round-trips
  - [pass] maximum timestamp 2^48-1 round-trips and first char is 7
  - [pass] timestamp = 2^48 is rejected
  - [pass] negative timestamp is rejected
  - [pass] NaN timestamp is rejected
  - [pass] Infinity timestamp is rejected
  - [pass] non-integer timestamp is rejected
  - [pass] randomness not exactly 10 bytes is rejected
  - [pass] time increase: same random, larger timestamp → strictly larger ID
  - [pass] same ms: 200 IDs within single generator are strictly increasing
  - [pass] clock regression: same generator with clock [100, 50] produces id1 < id2
  - [pass] two generators do not share state
  - [pass] Identity — canonical entity IDs
  - [pass] snapshot kind exists with snapshot prefix
  - [pass] createEntityId snapshot starts with snapshot_ and validates
  - [pass] snapshot ULID body is 26 Crockford Base32 characters
  - [pass] snapshot prefix is not confused with other kinds
  - [pass] Identity — M2.5 snapshot kind
  - [pass] idempotency kind exists with idem prefix
  - [pass] createEntityId idempotency starts with idem_ and validates
  - [pass] idempotency ULID body is 26 Crockford Base32 characters
  - [pass] idempotency ID is not recognized as snapshot/run/task
  - [pass] all pre-import kinds remain unchanged
  - [pass] Identity — M2.6 idempotency kind
  - [pass] operation kind exists with op prefix
  - [pass] createEntityId operation starts with op_ and validates
  - [pass] operation IDs remain distinct from all existing kinds
  - [pass] Identity — M3 P3A operation kind

## `LITE-01-005`  01-Core-Concepts.md · 16. Acceptance Expectations

**条款**：retry creates a new Run lineage;

- 点名文件：`apps/server/src/store/Identity.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（38 条）：

  - [pass] all prefix constants map to valid EntityIdKind
  - [pass] createEntityId produces prefix_ulid format
  - [pass] ULID body is 26 Crockford Base32 characters, no ILOU
  - [pass] same kind produces unique IDs
  - [pass] same kind produces unique IDs under heavy load
  - [pass] different kinds have different prefixes
  - [pass] isValidEntityId validates prefix and body
  - [pass] no database dependency
  - [pass] ULID matches known reference (timestamp=0, random=0)
  - [pass] first character always in 0–7 range
  - [pass] real 13-digit Unix-ms timestamp round-trips
  - [pass] maximum timestamp 2^48-1 round-trips and first char is 7
  - [pass] timestamp = 2^48 is rejected
  - [pass] negative timestamp is rejected
  - [pass] NaN timestamp is rejected
  - [pass] Infinity timestamp is rejected
  - [pass] non-integer timestamp is rejected
  - [pass] randomness not exactly 10 bytes is rejected
  - [pass] time increase: same random, larger timestamp → strictly larger ID
  - [pass] same ms: 200 IDs within single generator are strictly increasing
  - [pass] clock regression: same generator with clock [100, 50] produces id1 < id2
  - [pass] two generators do not share state
  - [pass] Identity — canonical entity IDs
  - [pass] snapshot kind exists with snapshot prefix
  - [pass] createEntityId snapshot starts with snapshot_ and validates
  - [pass] snapshot ULID body is 26 Crockford Base32 characters
  - [pass] snapshot prefix is not confused with other kinds
  - [pass] Identity — M2.5 snapshot kind
  - [pass] idempotency kind exists with idem prefix
  - [pass] createEntityId idempotency starts with idem_ and validates
  - [pass] idempotency ULID body is 26 Crockford Base32 characters
  - [pass] idempotency ID is not recognized as snapshot/run/task
  - [pass] all pre-import kinds remain unchanged
  - [pass] Identity — M2.6 idempotency kind
  - [pass] operation kind exists with op prefix
  - [pass] createEntityId operation starts with op_ and validates
  - [pass] operation IDs remain distinct from all existing kinds
  - [pass] Identity — M3 P3A operation kind

## `LITE-01-006`  01-Core-Concepts.md · 16. Acceptance Expectations

**条款**：Run and Process can be queried independently;

- 点名文件：`apps/server/src/store/Identity.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（38 条）：

  - [pass] all prefix constants map to valid EntityIdKind
  - [pass] createEntityId produces prefix_ulid format
  - [pass] ULID body is 26 Crockford Base32 characters, no ILOU
  - [pass] same kind produces unique IDs
  - [pass] same kind produces unique IDs under heavy load
  - [pass] different kinds have different prefixes
  - [pass] isValidEntityId validates prefix and body
  - [pass] no database dependency
  - [pass] ULID matches known reference (timestamp=0, random=0)
  - [pass] first character always in 0–7 range
  - [pass] real 13-digit Unix-ms timestamp round-trips
  - [pass] maximum timestamp 2^48-1 round-trips and first char is 7
  - [pass] timestamp = 2^48 is rejected
  - [pass] negative timestamp is rejected
  - [pass] NaN timestamp is rejected
  - [pass] Infinity timestamp is rejected
  - [pass] non-integer timestamp is rejected
  - [pass] randomness not exactly 10 bytes is rejected
  - [pass] time increase: same random, larger timestamp → strictly larger ID
  - [pass] same ms: 200 IDs within single generator are strictly increasing
  - [pass] clock regression: same generator with clock [100, 50] produces id1 < id2
  - [pass] two generators do not share state
  - [pass] Identity — canonical entity IDs
  - [pass] snapshot kind exists with snapshot prefix
  - [pass] createEntityId snapshot starts with snapshot_ and validates
  - [pass] snapshot ULID body is 26 Crockford Base32 characters
  - [pass] snapshot prefix is not confused with other kinds
  - [pass] Identity — M2.5 snapshot kind
  - [pass] idempotency kind exists with idem prefix
  - [pass] createEntityId idempotency starts with idem_ and validates
  - [pass] idempotency ULID body is 26 Crockford Base32 characters
  - [pass] idempotency ID is not recognized as snapshot/run/task
  - [pass] all pre-import kinds remain unchanged
  - [pass] Identity — M2.6 idempotency kind
  - [pass] operation kind exists with op prefix
  - [pass] createEntityId operation starts with op_ and validates
  - [pass] operation IDs remain distinct from all existing kinds
  - [pass] Identity — M3 P3A operation kind

## `LITE-01-008`  01-Core-Concepts.md · 16. Acceptance Expectations

**条款**：one Workspace cannot admit two modifying Runs;

- 点名文件：`apps/server/src/store/Identity.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（38 条）：

  - [pass] all prefix constants map to valid EntityIdKind
  - [pass] createEntityId produces prefix_ulid format
  - [pass] ULID body is 26 Crockford Base32 characters, no ILOU
  - [pass] same kind produces unique IDs
  - [pass] same kind produces unique IDs under heavy load
  - [pass] different kinds have different prefixes
  - [pass] isValidEntityId validates prefix and body
  - [pass] no database dependency
  - [pass] ULID matches known reference (timestamp=0, random=0)
  - [pass] first character always in 0–7 range
  - [pass] real 13-digit Unix-ms timestamp round-trips
  - [pass] maximum timestamp 2^48-1 round-trips and first char is 7
  - [pass] timestamp = 2^48 is rejected
  - [pass] negative timestamp is rejected
  - [pass] NaN timestamp is rejected
  - [pass] Infinity timestamp is rejected
  - [pass] non-integer timestamp is rejected
  - [pass] randomness not exactly 10 bytes is rejected
  - [pass] time increase: same random, larger timestamp → strictly larger ID
  - [pass] same ms: 200 IDs within single generator are strictly increasing
  - [pass] clock regression: same generator with clock [100, 50] produces id1 < id2
  - [pass] two generators do not share state
  - [pass] Identity — canonical entity IDs
  - [pass] snapshot kind exists with snapshot prefix
  - [pass] createEntityId snapshot starts with snapshot_ and validates
  - [pass] snapshot ULID body is 26 Crockford Base32 characters
  - [pass] snapshot prefix is not confused with other kinds
  - [pass] Identity — M2.5 snapshot kind
  - [pass] idempotency kind exists with idem prefix
  - [pass] createEntityId idempotency starts with idem_ and validates
  - [pass] idempotency ULID body is 26 Crockford Base32 characters
  - [pass] idempotency ID is not recognized as snapshot/run/task
  - [pass] all pre-import kinds remain unchanged
  - [pass] Identity — M2.6 idempotency kind
  - [pass] operation kind exists with op prefix
  - [pass] createEntityId operation starts with op_ and validates
  - [pass] operation IDs remain distinct from all existing kinds
  - [pass] Identity — M3 P3A operation kind

## `LITE-01-010`  01-Core-Concepts.md · 16. Acceptance Expectations

**条款**：prompt-only or user-forced capability claims never create read-only eligibility;

- 点名文件：`apps/server/src/store/Identity.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（38 条）：

  - [pass] all prefix constants map to valid EntityIdKind
  - [pass] createEntityId produces prefix_ulid format
  - [pass] ULID body is 26 Crockford Base32 characters, no ILOU
  - [pass] same kind produces unique IDs
  - [pass] same kind produces unique IDs under heavy load
  - [pass] different kinds have different prefixes
  - [pass] isValidEntityId validates prefix and body
  - [pass] no database dependency
  - [pass] ULID matches known reference (timestamp=0, random=0)
  - [pass] first character always in 0–7 range
  - [pass] real 13-digit Unix-ms timestamp round-trips
  - [pass] maximum timestamp 2^48-1 round-trips and first char is 7
  - [pass] timestamp = 2^48 is rejected
  - [pass] negative timestamp is rejected
  - [pass] NaN timestamp is rejected
  - [pass] Infinity timestamp is rejected
  - [pass] non-integer timestamp is rejected
  - [pass] randomness not exactly 10 bytes is rejected
  - [pass] time increase: same random, larger timestamp → strictly larger ID
  - [pass] same ms: 200 IDs within single generator are strictly increasing
  - [pass] clock regression: same generator with clock [100, 50] produces id1 < id2
  - [pass] two generators do not share state
  - [pass] Identity — canonical entity IDs
  - [pass] snapshot kind exists with snapshot prefix
  - [pass] createEntityId snapshot starts with snapshot_ and validates
  - [pass] snapshot ULID body is 26 Crockford Base32 characters
  - [pass] snapshot prefix is not confused with other kinds
  - [pass] Identity — M2.5 snapshot kind
  - [pass] idempotency kind exists with idem prefix
  - [pass] createEntityId idempotency starts with idem_ and validates
  - [pass] idempotency ULID body is 26 Crockford Base32 characters
  - [pass] idempotency ID is not recognized as snapshot/run/task
  - [pass] all pre-import kinds remain unchanged
  - [pass] Identity — M2.6 idempotency kind
  - [pass] operation kind exists with op prefix
  - [pass] createEntityId operation starts with op_ and validates
  - [pass] operation IDs remain distinct from all existing kinds
  - [pass] Identity — M3 P3A operation kind

## `LITE-01-011`  01-Core-Concepts.md · 16. Acceptance Expectations

**条款**：Stage remains optional and bounded;

- 点名文件：`apps/server/src/store/Identity.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（38 条）：

  - [pass] all prefix constants map to valid EntityIdKind
  - [pass] createEntityId produces prefix_ulid format
  - [pass] ULID body is 26 Crockford Base32 characters, no ILOU
  - [pass] same kind produces unique IDs
  - [pass] same kind produces unique IDs under heavy load
  - [pass] different kinds have different prefixes
  - [pass] isValidEntityId validates prefix and body
  - [pass] no database dependency
  - [pass] ULID matches known reference (timestamp=0, random=0)
  - [pass] first character always in 0–7 range
  - [pass] real 13-digit Unix-ms timestamp round-trips
  - [pass] maximum timestamp 2^48-1 round-trips and first char is 7
  - [pass] timestamp = 2^48 is rejected
  - [pass] negative timestamp is rejected
  - [pass] NaN timestamp is rejected
  - [pass] Infinity timestamp is rejected
  - [pass] non-integer timestamp is rejected
  - [pass] randomness not exactly 10 bytes is rejected
  - [pass] time increase: same random, larger timestamp → strictly larger ID
  - [pass] same ms: 200 IDs within single generator are strictly increasing
  - [pass] clock regression: same generator with clock [100, 50] produces id1 < id2
  - [pass] two generators do not share state
  - [pass] Identity — canonical entity IDs
  - [pass] snapshot kind exists with snapshot prefix
  - [pass] createEntityId snapshot starts with snapshot_ and validates
  - [pass] snapshot ULID body is 26 Crockford Base32 characters
  - [pass] snapshot prefix is not confused with other kinds
  - [pass] Identity — M2.5 snapshot kind
  - [pass] idempotency kind exists with idem prefix
  - [pass] createEntityId idempotency starts with idem_ and validates
  - [pass] idempotency ULID body is 26 Crockford Base32 characters
  - [pass] idempotency ID is not recognized as snapshot/run/task
  - [pass] all pre-import kinds remain unchanged
  - [pass] Identity — M2.6 idempotency kind
  - [pass] operation kind exists with op prefix
  - [pass] createEntityId operation starts with op_ and validates
  - [pass] operation IDs remain distinct from all existing kinds
  - [pass] Identity — M3 P3A operation kind

## `LITE-01-015`  01-Core-Concepts.md · 16. Acceptance Expectations

**条款**：archived or compatibility records do not disappear destructively.

- 点名文件：`apps/server/src/store/Identity.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（38 条）：

  - [pass] all prefix constants map to valid EntityIdKind
  - [pass] createEntityId produces prefix_ulid format
  - [pass] ULID body is 26 Crockford Base32 characters, no ILOU
  - [pass] same kind produces unique IDs
  - [pass] same kind produces unique IDs under heavy load
  - [pass] different kinds have different prefixes
  - [pass] isValidEntityId validates prefix and body
  - [pass] no database dependency
  - [pass] ULID matches known reference (timestamp=0, random=0)
  - [pass] first character always in 0–7 range
  - [pass] real 13-digit Unix-ms timestamp round-trips
  - [pass] maximum timestamp 2^48-1 round-trips and first char is 7
  - [pass] timestamp = 2^48 is rejected
  - [pass] negative timestamp is rejected
  - [pass] NaN timestamp is rejected
  - [pass] Infinity timestamp is rejected
  - [pass] non-integer timestamp is rejected
  - [pass] randomness not exactly 10 bytes is rejected
  - [pass] time increase: same random, larger timestamp → strictly larger ID
  - [pass] same ms: 200 IDs within single generator are strictly increasing
  - [pass] clock regression: same generator with clock [100, 50] produces id1 < id2
  - [pass] two generators do not share state
  - [pass] Identity — canonical entity IDs
  - [pass] snapshot kind exists with snapshot prefix
  - [pass] createEntityId snapshot starts with snapshot_ and validates
  - [pass] snapshot ULID body is 26 Crockford Base32 characters
  - [pass] snapshot prefix is not confused with other kinds
  - [pass] Identity — M2.5 snapshot kind
  - [pass] idempotency kind exists with idem prefix
  - [pass] createEntityId idempotency starts with idem_ and validates
  - [pass] idempotency ULID body is 26 Crockford Base32 characters
  - [pass] idempotency ID is not recognized as snapshot/run/task
  - [pass] all pre-import kinds remain unchanged
  - [pass] Identity — M2.6 idempotency kind
  - [pass] operation kind exists with op prefix
  - [pass] createEntityId operation starts with op_ and validates
  - [pass] operation IDs remain distinct from all existing kinds
  - [pass] Identity — M3 P3A operation kind

## `LITE-02-001`  02-Runtime-Lifecycle.md · 21. Acceptance Expectations

**条款**：Message-only turns do not create modifying Runs;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-02-002`  02-Runtime-Lifecycle.md · 21. Acceptance Expectations

**条款**：Task creation is idempotent and separate from Run creation;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-02-006`  02-Runtime-Lifecycle.md · 21. Acceptance Expectations

**条款**：transition-to-Event mappings remain exact;

- 点名文件：`apps/server/src/services/m3-p2c2a-lifecycle-transaction.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2A Run queued -> starting emits run.dequeued with service timestamp
  - [pass] P2C-2A Run starting -> failed persists failure fields and emits run.failed
  - [pass] P2C-2A Run running -> paused emits run.paused
  - [pass] P2C-2A Run running -> failed emits run.failed
  - [pass] P2C-2A Run paused -> running emits run.resumed
  - [pass] P2C-2A Run paused -> failed emits run.failed
  - [pass] P2C-2A Stage pending -> ready emits stage.ready
  - [pass] P2C-2A Stage pending -> skipped writes completed_at and emits stage.skipped
  - [pass] P2C-2A Stage ready -> starting emits stage.starting with service timestamp
  - [pass] P2C-2A Stage starting -> failed persists failure fields and emits stage.failed
  - [pass] P2C-2A Stage running -> paused emits stage.paused
  - [pass] P2C-2A Stage running -> completed writes completed_at without run completion
  - [pass] P2C-2A Stage running -> failed persists failure fields and emits stage.failed
  - [pass] P2C-2A Stage paused -> running emits stage.resumed
  - [pass] P2C-2A rejects supported Run composite transitions without writes
  - [pass] P2C-2A rejects all unsupported Stage composite transitions without writes
  - [pass] P2C-2A transition classification is exhaustive for every Run and Stage pair
  - [pass] P2C-2A invalid and composite routing never calls now
  - [pass] P2C-2A captures one canonical timestamp only after BEGIN IMMEDIATE
  - [pass] P2C-2A service validation errors are stable and do not leak repository errors
  - [pass] P2C-2A stored Stage not found has a stable error and does not call the clock
  - [pass] P2C-2A Stage/Run mismatch is reported before parent-state or clock checks
  - [pass] P2C-2A Run stale version fails before clock or mutation
  - [pass] P2C-2A Stage stale version fails before clock or mutation
  - [pass] P2C-2A caller lifecycle fields cannot override derived Event boundaries
  - [pass] P2C-2A caller Stage lifecycle fields cannot override derived Event boundaries
  - [pass] P2C-2A terminal parent Run fences all 8 Stage Single transitions
  - [pass] RunStageRepository reports non-Matrix transitions as INVALID_RUN_STAGE_TRANSITION
  - [pass] P2C-2A rollback matrix preserves current state, sequence, events, and outbox on every failure
  - [pass] P2C-2A file database concurrency allows one conditional transition and rejects the other

## `LITE-02-012`  02-Runtime-Lifecycle.md · 21. Acceptance Expectations

**条款**：retry creates a new Run with preserved lineage;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-02-013`  02-Runtime-Lifecycle.md · 21. Acceptance Expectations

**条款**：Process exit does not falsely complete a Run;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-02-016`  02-Runtime-Lifecycle.md · 21. Acceptance Expectations

**条款**：Worktree absence does not block a modifying Run after Workspace admission;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-04-006`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：errors normalize to stable codes with retryability;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（21 条）：

  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > normalizes the legacy kimi input token without changing canonical adapter identity
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > validates direct KimiCode fixtures without emitting the forbidden generic validation error
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > routes version, help, and auth probes through the injected Process Runtime port
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > uses the same Windows safe-environment semantics for validation, auth, and launch
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > keeps POSIX safe-environment matching case-sensitive
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > fails closed on conflicting Windows safe-environment aliases
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > distinguishes an explicitly configured inaccessible executable from no discovery candidate
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > sanitizes discovery warning text before returning validation evidence
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > builds a canonical direct launch plan with separated args and secret references only
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > freezes an absent persisted Kimi version to the manifest compatibility version
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > refuses to build an execution plan for an unfreezable missing-version adapter
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > uses canonical environment override before the legacy Kimi override when config is unset
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > does not fall back to another executable when a configured binary is inaccessible
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > marks authentication authenticated from a successful structured assistant response
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > marks authentication unauthenticated on explicit login-required evidence
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > fails closed to unknown for timeout, spawn, unrelated and malformed auth evidence
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > no longer probes the stale auth status command
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > parses golden, malformed, unknown and usage output without fabricating provider semantics
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > maps finalize outcomes and sends cancel only through an accepted Process port ticket
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > keeps precise auth-required, auth-expired, and generic session classifications
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > has no direct child_process or spawn/exec dependency in the adapter source

## `LITE-04-007`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：capability declarations match tested behavior;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（21 条）：

  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > normalizes the legacy kimi input token without changing canonical adapter identity
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > validates direct KimiCode fixtures without emitting the forbidden generic validation error
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > routes version, help, and auth probes through the injected Process Runtime port
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > uses the same Windows safe-environment semantics for validation, auth, and launch
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > keeps POSIX safe-environment matching case-sensitive
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > fails closed on conflicting Windows safe-environment aliases
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > distinguishes an explicitly configured inaccessible executable from no discovery candidate
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > sanitizes discovery warning text before returning validation evidence
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > builds a canonical direct launch plan with separated args and secret references only
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > freezes an absent persisted Kimi version to the manifest compatibility version
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > refuses to build an execution plan for an unfreezable missing-version adapter
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > uses canonical environment override before the legacy Kimi override when config is unset
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > does not fall back to another executable when a configured binary is inaccessible
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > marks authentication authenticated from a successful structured assistant response
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > marks authentication unauthenticated on explicit login-required evidence
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > fails closed to unknown for timeout, spawn, unrelated and malformed auth evidence
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > no longer probes the stale auth status command
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > parses golden, malformed, unknown and usage output without fabricating provider semantics
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > maps finalize outcomes and sends cancel only through an accepted Process port ticket
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > keeps precise auth-required, auth-expired, and generic session classifications
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > has no direct child_process or spawn/exec dependency in the adapter source

## `LITE-04-008`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：concurrent read-only admission is available only when attempted Workspace writes are technically denied and tested;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（21 条）：

  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > normalizes the legacy kimi input token without changing canonical adapter identity
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > validates direct KimiCode fixtures without emitting the forbidden generic validation error
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > routes version, help, and auth probes through the injected Process Runtime port
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > uses the same Windows safe-environment semantics for validation, auth, and launch
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > keeps POSIX safe-environment matching case-sensitive
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > fails closed on conflicting Windows safe-environment aliases
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > distinguishes an explicitly configured inaccessible executable from no discovery candidate
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > sanitizes discovery warning text before returning validation evidence
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > builds a canonical direct launch plan with separated args and secret references only
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > freezes an absent persisted Kimi version to the manifest compatibility version
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > refuses to build an execution plan for an unfreezable missing-version adapter
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > uses canonical environment override before the legacy Kimi override when config is unset
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > does not fall back to another executable when a configured binary is inaccessible
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > marks authentication authenticated from a successful structured assistant response
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > marks authentication unauthenticated on explicit login-required evidence
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > fails closed to unknown for timeout, spawn, unrelated and malformed auth evidence
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > no longer probes the stale auth status command
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > parses golden, malformed, unknown and usage output without fabricating provider semantics
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > maps finalize outcomes and sends cancel only through an accepted Process port ticket
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > keeps precise auth-required, auth-expired, and generic session classifications
  - [pass] src/providers/kimiCodeAdapter.test.ts > KimiCodeProviderAdapter > has no direct child_process or spawn/exec dependency in the adapter source

## `LITE-05-001`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：reserve-before-spawn ordering and idempotency;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（10 条）：

  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2: spawn capture and live probe carry the same CANONICAL FILETIME; classifier SAME (primitive-only)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W1: kill-on-close ownership loss via session close reaps the provider; recovery sees MISSING (no terminateTree on the proof path)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2 oracle: production helper FILETIME == independent .NET StartTime.ToFileTimeUtc oracle; real value > 2^53 (BigInt test-only)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W3: read-only probe fails closed on an invalid PID (never MISSING)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W3: probe failure / unreadable identity fails closed to unknown (not missing)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2 primitive: a live self PID reads a stable, repeatable canonical FILETIME
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > W4: persisted FILETIME A vs observed FILETIME B (B != A) -> MISMATCH, classification-only
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > W4: PID reuse is never classified same
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > V2-D: valid v2 with NULL birth in column and mirror + PID absent -> missing
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > V2-D guard: NULL birth + live PID -> unknown (not missing)

## `LITE-05-008`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：browser disconnect leaves the Process running;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（10 条）：

  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2: spawn capture and live probe carry the same CANONICAL FILETIME; classifier SAME (primitive-only)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W1: kill-on-close ownership loss via session close reaps the provider; recovery sees MISSING (no terminateTree on the proof path)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2 oracle: production helper FILETIME == independent .NET StartTime.ToFileTimeUtc oracle; real value > 2^53 (BigInt test-only)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W3: read-only probe fails closed on an invalid PID (never MISSING)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W3: probe failure / unreadable identity fails closed to unknown (not missing)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2 primitive: a live self PID reads a stable, repeatable canonical FILETIME
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > W4: persisted FILETIME A vs observed FILETIME B (B != A) -> MISMATCH, classification-only
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > W4: PID reuse is never classified same
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > V2-D: valid v2 with NULL birth in column and mirror + PID absent -> missing
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > V2-D guard: NULL birth + live PID -> unknown (not missing)

## `LITE-05-009`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：timeout, approval-wait exclusion, and race-safe terminal transitions;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（10 条）：

  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2: spawn capture and live probe carry the same CANONICAL FILETIME; classifier SAME (primitive-only)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W1: kill-on-close ownership loss via session close reaps the provider; recovery sees MISSING (no terminateTree on the proof path)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2 oracle: production helper FILETIME == independent .NET StartTime.ToFileTimeUtc oracle; real value > 2^53 (BigInt test-only)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W3: read-only probe fails closed on an invalid PID (never MISSING)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W3: probe failure / unreadable identity fails closed to unknown (not missing)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2 primitive: a live self PID reads a stable, repeatable canonical FILETIME
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > W4: persisted FILETIME A vs observed FILETIME B (B != A) -> MISMATCH, classification-only
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > W4: PID reuse is never classified same
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > V2-D: valid v2 with NULL birth in column and mirror + PID absent -> missing
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > V2-D guard: NULL birth + live PID -> unknown (not missing)

## `LITE-05-011`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：startup preflight never probes OS state inside a SQLite write transaction;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（10 条）：

  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2: spawn capture and live probe carry the same CANONICAL FILETIME; classifier SAME (primitive-only)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W1: kill-on-close ownership loss via session close reaps the provider; recovery sees MISSING (no terminateTree on the proof path)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2 oracle: production helper FILETIME == independent .NET StartTime.ToFileTimeUtc oracle; real value > 2^53 (BigInt test-only)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W3: read-only probe fails closed on an invalid PID (never MISSING)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W3: probe failure / unreadable identity fails closed to unknown (not missing)
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b Windows birth-identity gates > W2 primitive: a live self PID reads a stable, repeatable canonical FILETIME
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > W4: persisted FILETIME A vs observed FILETIME B (B != A) -> MISMATCH, classification-only
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > W4: PID reuse is never classified same
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > V2-D: valid v2 with NULL birth in column and mirror + PID absent -> missing
  - [pass] src/p6-m3b-windows-birth-identity.test.ts > P6-M3b W4 + version gates (deterministic seams) > V2-D guard: NULL birth + live PID -> unknown (not missing)

## `LITE-06-006`  06-Worktree-Runtime.md · 13. Acceptance Expectations

**条款**：non-Git Workspaces report `not-git` without silent fallback;

- 点名文件：`apps/server/src/services/WorkspaceAdmissionAuthority.test.ts`（passed，raw exit 0，计数 {"passed":43,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（46 条）：

  - [pass] L1D-U01 invalid input fails with stable INPUT_INVALID
  - [pass] L1D-U02 a missing Workspace fails with WORKSPACE_NOT_FOUND
  - [pass] L1D-U03 frozen classifier, not requested class, is effective authority
  - [pass] L1D-U04 stale evidence is collected outside and revalidated/classified inside BEGIN IMMEDIATE
  - [pass] L1D-U05 stale evidence that cannot be recollected fails closed with no write
  - [pass] L1D-U06 MODIFYING winner follows durable request_order FIFO
  - [pass] L1D-U07 contiguous READ_ONLY head requests retain durable FIFO order
  - [pass] L1D-U08 frozen V1 READ_ONLY capacity is exactly two and is never exceeded
  - [pass] L1D-U09 an active MODIFYING admission blocks every later request
  - [pass] L1D-U10 repeated advancement is idempotent
  - [pass] L1D-U11 RELEASED admissions are never re-granted
  - [pass] L1D-U12 a queued request stays byte-for-byte unchanged while capacity is full
  - [pass] L1D-U13 public errors redact collector and SQLite details
  - [pass] L1D-U14 a queue-head writer blocks later readers while readers are active
  - [pass] L1D-U15 a newly selected reader remains mutually exclusive with the next writer
  - [pass] L1D-U16 stale active READ_ONLY evidence is reclassified before occupancy is trusted
  - [pass] L1D-U17 collected evidence cannot be rebound to a different subject before BEGIN IMMEDIATE
  - [pass] L1D-U18 expired GRANTED READ_ONLY evidence with unavailable collection denies dispatch authorization
  - [pass] L1D-U19 expired GRANTED READ_ONLY evidence refreshes outside and commits authorization inside BEGIN IMMEDIATE
  - [pass] L1D-U20 stale active reader reclassified MODIFYING conflicts with its active reader peer and denies all authorization
  - [pass] WorkspaceAdmissionAuthority unit contract
  - [pass] L1D-R01 repository reads the queue by request_order then id
  - [pass] L1D-R02 grant state, timestamp, classification, and version commit atomically
  - [pass] L1D-R03 repository CAS rejects a stale version without changing the winner
  - [pass] L1D-R04 SQLite invariant rejects a second active MODIFYING admission
  - [pass] L1D-R05 one transaction never persists more than two active readers
  - [pass] L1D-R06 release and next grant commit in the same transaction
  - [pass] L1D-R07 a non-terminal subject cannot release its admission
  - [pass] L1D-R08 durable MISSING evidence alone is not a terminal release proof
  - [pass] WorkspaceAdmissionAuthority repository and transaction contract
  - [pass] L1D-I01 one MODIFYING request becomes GRANTED
  - [pass] L1D-I02 a second MODIFYING request remains QUEUED
  - [pass] L1D-I03 releasing the first writer advances the second writer
  - [pass] L1D-I04 contiguous head readers batch-grant to V1 capacity
  - [pass] L1D-I05 a reader over V1 capacity remains QUEUED
  - [pass] L1D-I06 real competing processes produce exactly one MODIFYING winner
  - [pass] L1D-I07 concurrent advancement cannot double-grant readers
  - [pass] L1D-I09 a running Run cannot release a GRANTED admission
  - [pass] L1D-I10 a committed terminal Run releases its admission
  - [pass] L1D-I11 MISSING without a terminal Run cannot release
  - [pass] L1D-I12 MISSING plus committed terminal failure permits release
  - [pass] L1D-I13 stale evidence is authoritatively replaced before grant
  - [pass] L1D-I14 a failure after release and grant writes rolls the whole transaction back
  - [pass] L1D-I15 a new service instance recovers the same durable authority state
  - [pass] L1D-I16 canonical and legacy subjects share one FIFO and release authority
  - [pass] WorkspaceAdmissionAuthority integration contract

## `LITE-06-007`  06-Worktree-Runtime.md · 13. Acceptance Expectations

**条款**：diff Artifacts are immutable and checksummed;

- 点名文件：`apps/server/src/services/WorkspaceAdmissionAuthority.test.ts`（passed，raw exit 0，计数 {"passed":43,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（46 条）：

  - [pass] L1D-U01 invalid input fails with stable INPUT_INVALID
  - [pass] L1D-U02 a missing Workspace fails with WORKSPACE_NOT_FOUND
  - [pass] L1D-U03 frozen classifier, not requested class, is effective authority
  - [pass] L1D-U04 stale evidence is collected outside and revalidated/classified inside BEGIN IMMEDIATE
  - [pass] L1D-U05 stale evidence that cannot be recollected fails closed with no write
  - [pass] L1D-U06 MODIFYING winner follows durable request_order FIFO
  - [pass] L1D-U07 contiguous READ_ONLY head requests retain durable FIFO order
  - [pass] L1D-U08 frozen V1 READ_ONLY capacity is exactly two and is never exceeded
  - [pass] L1D-U09 an active MODIFYING admission blocks every later request
  - [pass] L1D-U10 repeated advancement is idempotent
  - [pass] L1D-U11 RELEASED admissions are never re-granted
  - [pass] L1D-U12 a queued request stays byte-for-byte unchanged while capacity is full
  - [pass] L1D-U13 public errors redact collector and SQLite details
  - [pass] L1D-U14 a queue-head writer blocks later readers while readers are active
  - [pass] L1D-U15 a newly selected reader remains mutually exclusive with the next writer
  - [pass] L1D-U16 stale active READ_ONLY evidence is reclassified before occupancy is trusted
  - [pass] L1D-U17 collected evidence cannot be rebound to a different subject before BEGIN IMMEDIATE
  - [pass] L1D-U18 expired GRANTED READ_ONLY evidence with unavailable collection denies dispatch authorization
  - [pass] L1D-U19 expired GRANTED READ_ONLY evidence refreshes outside and commits authorization inside BEGIN IMMEDIATE
  - [pass] L1D-U20 stale active reader reclassified MODIFYING conflicts with its active reader peer and denies all authorization
  - [pass] WorkspaceAdmissionAuthority unit contract
  - [pass] L1D-R01 repository reads the queue by request_order then id
  - [pass] L1D-R02 grant state, timestamp, classification, and version commit atomically
  - [pass] L1D-R03 repository CAS rejects a stale version without changing the winner
  - [pass] L1D-R04 SQLite invariant rejects a second active MODIFYING admission
  - [pass] L1D-R05 one transaction never persists more than two active readers
  - [pass] L1D-R06 release and next grant commit in the same transaction
  - [pass] L1D-R07 a non-terminal subject cannot release its admission
  - [pass] L1D-R08 durable MISSING evidence alone is not a terminal release proof
  - [pass] WorkspaceAdmissionAuthority repository and transaction contract
  - [pass] L1D-I01 one MODIFYING request becomes GRANTED
  - [pass] L1D-I02 a second MODIFYING request remains QUEUED
  - [pass] L1D-I03 releasing the first writer advances the second writer
  - [pass] L1D-I04 contiguous head readers batch-grant to V1 capacity
  - [pass] L1D-I05 a reader over V1 capacity remains QUEUED
  - [pass] L1D-I06 real competing processes produce exactly one MODIFYING winner
  - [pass] L1D-I07 concurrent advancement cannot double-grant readers
  - [pass] L1D-I09 a running Run cannot release a GRANTED admission
  - [pass] L1D-I10 a committed terminal Run releases its admission
  - [pass] L1D-I11 MISSING without a terminal Run cannot release
  - [pass] L1D-I12 MISSING plus committed terminal failure permits release
  - [pass] L1D-I13 stale evidence is authoritatively replaced before grant
  - [pass] L1D-I14 a failure after release and grant writes rolls the whole transaction back
  - [pass] L1D-I15 a new service instance recovers the same durable authority state
  - [pass] L1D-I16 canonical and legacy subjects share one FIFO and release authority
  - [pass] WorkspaceAdmissionAuthority integration contract

## `LITE-06-008`  06-Worktree-Runtime.md · 13. Acceptance Expectations

**条款**：historical Worktree fields and Events remain readable;

- 点名文件：`apps/server/src/services/WorkspaceAdmissionAuthority.test.ts`（passed，raw exit 0，计数 {"passed":43,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（46 条）：

  - [pass] L1D-U01 invalid input fails with stable INPUT_INVALID
  - [pass] L1D-U02 a missing Workspace fails with WORKSPACE_NOT_FOUND
  - [pass] L1D-U03 frozen classifier, not requested class, is effective authority
  - [pass] L1D-U04 stale evidence is collected outside and revalidated/classified inside BEGIN IMMEDIATE
  - [pass] L1D-U05 stale evidence that cannot be recollected fails closed with no write
  - [pass] L1D-U06 MODIFYING winner follows durable request_order FIFO
  - [pass] L1D-U07 contiguous READ_ONLY head requests retain durable FIFO order
  - [pass] L1D-U08 frozen V1 READ_ONLY capacity is exactly two and is never exceeded
  - [pass] L1D-U09 an active MODIFYING admission blocks every later request
  - [pass] L1D-U10 repeated advancement is idempotent
  - [pass] L1D-U11 RELEASED admissions are never re-granted
  - [pass] L1D-U12 a queued request stays byte-for-byte unchanged while capacity is full
  - [pass] L1D-U13 public errors redact collector and SQLite details
  - [pass] L1D-U14 a queue-head writer blocks later readers while readers are active
  - [pass] L1D-U15 a newly selected reader remains mutually exclusive with the next writer
  - [pass] L1D-U16 stale active READ_ONLY evidence is reclassified before occupancy is trusted
  - [pass] L1D-U17 collected evidence cannot be rebound to a different subject before BEGIN IMMEDIATE
  - [pass] L1D-U18 expired GRANTED READ_ONLY evidence with unavailable collection denies dispatch authorization
  - [pass] L1D-U19 expired GRANTED READ_ONLY evidence refreshes outside and commits authorization inside BEGIN IMMEDIATE
  - [pass] L1D-U20 stale active reader reclassified MODIFYING conflicts with its active reader peer and denies all authorization
  - [pass] WorkspaceAdmissionAuthority unit contract
  - [pass] L1D-R01 repository reads the queue by request_order then id
  - [pass] L1D-R02 grant state, timestamp, classification, and version commit atomically
  - [pass] L1D-R03 repository CAS rejects a stale version without changing the winner
  - [pass] L1D-R04 SQLite invariant rejects a second active MODIFYING admission
  - [pass] L1D-R05 one transaction never persists more than two active readers
  - [pass] L1D-R06 release and next grant commit in the same transaction
  - [pass] L1D-R07 a non-terminal subject cannot release its admission
  - [pass] L1D-R08 durable MISSING evidence alone is not a terminal release proof
  - [pass] WorkspaceAdmissionAuthority repository and transaction contract
  - [pass] L1D-I01 one MODIFYING request becomes GRANTED
  - [pass] L1D-I02 a second MODIFYING request remains QUEUED
  - [pass] L1D-I03 releasing the first writer advances the second writer
  - [pass] L1D-I04 contiguous head readers batch-grant to V1 capacity
  - [pass] L1D-I05 a reader over V1 capacity remains QUEUED
  - [pass] L1D-I06 real competing processes produce exactly one MODIFYING winner
  - [pass] L1D-I07 concurrent advancement cannot double-grant readers
  - [pass] L1D-I09 a running Run cannot release a GRANTED admission
  - [pass] L1D-I10 a committed terminal Run releases its admission
  - [pass] L1D-I11 MISSING without a terminal Run cannot release
  - [pass] L1D-I12 MISSING plus committed terminal failure permits release
  - [pass] L1D-I13 stale evidence is authoritatively replaced before grant
  - [pass] L1D-I14 a failure after release and grant writes rolls the whole transaction back
  - [pass] L1D-I15 a new service instance recovers the same durable authority state
  - [pass] L1D-I16 canonical and legacy subjects share one FIFO and release authority
  - [pass] WorkspaceAdmissionAuthority integration contract

## `LITE-06-010`  06-Worktree-Runtime.md · 13. Acceptance Expectations

**条款**：no automatic or destructive Git command is executed by observation;

- 点名文件：`apps/server/src/services/WorkspaceAdmissionAuthority.test.ts`（passed，raw exit 0，计数 {"passed":43,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（46 条）：

  - [pass] L1D-U01 invalid input fails with stable INPUT_INVALID
  - [pass] L1D-U02 a missing Workspace fails with WORKSPACE_NOT_FOUND
  - [pass] L1D-U03 frozen classifier, not requested class, is effective authority
  - [pass] L1D-U04 stale evidence is collected outside and revalidated/classified inside BEGIN IMMEDIATE
  - [pass] L1D-U05 stale evidence that cannot be recollected fails closed with no write
  - [pass] L1D-U06 MODIFYING winner follows durable request_order FIFO
  - [pass] L1D-U07 contiguous READ_ONLY head requests retain durable FIFO order
  - [pass] L1D-U08 frozen V1 READ_ONLY capacity is exactly two and is never exceeded
  - [pass] L1D-U09 an active MODIFYING admission blocks every later request
  - [pass] L1D-U10 repeated advancement is idempotent
  - [pass] L1D-U11 RELEASED admissions are never re-granted
  - [pass] L1D-U12 a queued request stays byte-for-byte unchanged while capacity is full
  - [pass] L1D-U13 public errors redact collector and SQLite details
  - [pass] L1D-U14 a queue-head writer blocks later readers while readers are active
  - [pass] L1D-U15 a newly selected reader remains mutually exclusive with the next writer
  - [pass] L1D-U16 stale active READ_ONLY evidence is reclassified before occupancy is trusted
  - [pass] L1D-U17 collected evidence cannot be rebound to a different subject before BEGIN IMMEDIATE
  - [pass] L1D-U18 expired GRANTED READ_ONLY evidence with unavailable collection denies dispatch authorization
  - [pass] L1D-U19 expired GRANTED READ_ONLY evidence refreshes outside and commits authorization inside BEGIN IMMEDIATE
  - [pass] L1D-U20 stale active reader reclassified MODIFYING conflicts with its active reader peer and denies all authorization
  - [pass] WorkspaceAdmissionAuthority unit contract
  - [pass] L1D-R01 repository reads the queue by request_order then id
  - [pass] L1D-R02 grant state, timestamp, classification, and version commit atomically
  - [pass] L1D-R03 repository CAS rejects a stale version without changing the winner
  - [pass] L1D-R04 SQLite invariant rejects a second active MODIFYING admission
  - [pass] L1D-R05 one transaction never persists more than two active readers
  - [pass] L1D-R06 release and next grant commit in the same transaction
  - [pass] L1D-R07 a non-terminal subject cannot release its admission
  - [pass] L1D-R08 durable MISSING evidence alone is not a terminal release proof
  - [pass] WorkspaceAdmissionAuthority repository and transaction contract
  - [pass] L1D-I01 one MODIFYING request becomes GRANTED
  - [pass] L1D-I02 a second MODIFYING request remains QUEUED
  - [pass] L1D-I03 releasing the first writer advances the second writer
  - [pass] L1D-I04 contiguous head readers batch-grant to V1 capacity
  - [pass] L1D-I05 a reader over V1 capacity remains QUEUED
  - [pass] L1D-I06 real competing processes produce exactly one MODIFYING winner
  - [pass] L1D-I07 concurrent advancement cannot double-grant readers
  - [pass] L1D-I09 a running Run cannot release a GRANTED admission
  - [pass] L1D-I10 a committed terminal Run releases its admission
  - [pass] L1D-I11 MISSING without a terminal Run cannot release
  - [pass] L1D-I12 MISSING plus committed terminal failure permits release
  - [pass] L1D-I13 stale evidence is authoritatively replaced before grant
  - [pass] L1D-I14 a failure after release and grant writes rolls the whole transaction back
  - [pass] L1D-I15 a new service instance recovers the same durable authority state
  - [pass] L1D-I16 canonical and legacy subjects share one FIFO and release authority
  - [pass] WorkspaceAdmissionAuthority integration contract

## `LITE-06-011`  06-Worktree-Runtime.md · 13. Acceptance Expectations

**条款**：Git observation wording never implies AgentOS-owned Git workflow.

- 点名文件：`apps/server/src/services/WorkspaceAdmissionAuthority.test.ts`（passed，raw exit 0，计数 {"passed":43,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（46 条）：

  - [pass] L1D-U01 invalid input fails with stable INPUT_INVALID
  - [pass] L1D-U02 a missing Workspace fails with WORKSPACE_NOT_FOUND
  - [pass] L1D-U03 frozen classifier, not requested class, is effective authority
  - [pass] L1D-U04 stale evidence is collected outside and revalidated/classified inside BEGIN IMMEDIATE
  - [pass] L1D-U05 stale evidence that cannot be recollected fails closed with no write
  - [pass] L1D-U06 MODIFYING winner follows durable request_order FIFO
  - [pass] L1D-U07 contiguous READ_ONLY head requests retain durable FIFO order
  - [pass] L1D-U08 frozen V1 READ_ONLY capacity is exactly two and is never exceeded
  - [pass] L1D-U09 an active MODIFYING admission blocks every later request
  - [pass] L1D-U10 repeated advancement is idempotent
  - [pass] L1D-U11 RELEASED admissions are never re-granted
  - [pass] L1D-U12 a queued request stays byte-for-byte unchanged while capacity is full
  - [pass] L1D-U13 public errors redact collector and SQLite details
  - [pass] L1D-U14 a queue-head writer blocks later readers while readers are active
  - [pass] L1D-U15 a newly selected reader remains mutually exclusive with the next writer
  - [pass] L1D-U16 stale active READ_ONLY evidence is reclassified before occupancy is trusted
  - [pass] L1D-U17 collected evidence cannot be rebound to a different subject before BEGIN IMMEDIATE
  - [pass] L1D-U18 expired GRANTED READ_ONLY evidence with unavailable collection denies dispatch authorization
  - [pass] L1D-U19 expired GRANTED READ_ONLY evidence refreshes outside and commits authorization inside BEGIN IMMEDIATE
  - [pass] L1D-U20 stale active reader reclassified MODIFYING conflicts with its active reader peer and denies all authorization
  - [pass] WorkspaceAdmissionAuthority unit contract
  - [pass] L1D-R01 repository reads the queue by request_order then id
  - [pass] L1D-R02 grant state, timestamp, classification, and version commit atomically
  - [pass] L1D-R03 repository CAS rejects a stale version without changing the winner
  - [pass] L1D-R04 SQLite invariant rejects a second active MODIFYING admission
  - [pass] L1D-R05 one transaction never persists more than two active readers
  - [pass] L1D-R06 release and next grant commit in the same transaction
  - [pass] L1D-R07 a non-terminal subject cannot release its admission
  - [pass] L1D-R08 durable MISSING evidence alone is not a terminal release proof
  - [pass] WorkspaceAdmissionAuthority repository and transaction contract
  - [pass] L1D-I01 one MODIFYING request becomes GRANTED
  - [pass] L1D-I02 a second MODIFYING request remains QUEUED
  - [pass] L1D-I03 releasing the first writer advances the second writer
  - [pass] L1D-I04 contiguous head readers batch-grant to V1 capacity
  - [pass] L1D-I05 a reader over V1 capacity remains QUEUED
  - [pass] L1D-I06 real competing processes produce exactly one MODIFYING winner
  - [pass] L1D-I07 concurrent advancement cannot double-grant readers
  - [pass] L1D-I09 a running Run cannot release a GRANTED admission
  - [pass] L1D-I10 a committed terminal Run releases its admission
  - [pass] L1D-I11 MISSING without a terminal Run cannot release
  - [pass] L1D-I12 MISSING plus committed terminal failure permits release
  - [pass] L1D-I13 stale evidence is authoritatively replaced before grant
  - [pass] L1D-I14 a failure after release and grant writes rolls the whole transaction back
  - [pass] L1D-I15 a new service instance recovers the same durable authority state
  - [pass] L1D-I16 canonical and legacy subjects share one FIFO and release authority
  - [pass] WorkspaceAdmissionAuthority integration contract

## `LITE-07-002`  07-Memory-Runtime.md · 18. Acceptance Expectations

**条款**：source requirement for automatic Entries;

- 点名文件：`apps/server/src/services/MemoryContextResolver.test.ts`（passed，raw exit 0，计数 {"passed":17,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（17 条）：

  - [pass] MF4I-01 resolve persists a snapshot and returns bounded context
  - [pass] MF4I-02 resolve is idempotent per run scope
  - [pass] MF4I-03 stage scope is distinct from run scope
  - [pass] replaying an earlier scope after a later Stage does not recreate its snapshot
  - [pass] MF4I-04 snapshot failure blocks injection
  - [pass] MF4I-05 invalid input fails closed
  - [pass] MF4I-06 injection gate rejects absent snapshot
  - [pass] MF4I-07 later entry edits do not rewrite the snapshot
  - [pass] frozen injection survives content edits and logical deletion of its Entry
  - [pass] historical metadata-only snapshot is inspectable but blocks injection
  - [pass] payload failure rolls back the snapshot and its selections
  - [pass] corrupt frozen payload blocks replay
  - [pass] MF4I-08 empty store still persists a snapshot
  - [pass] MF4I-09 default budget is frozen and valid
  - [pass] MF4I-10 workspace isolation
  - [pass] LITE-07-109: new snapshots exclude ineligible content while historical snapshots stay frozen
  - [pass] LITE-07-013 MF4I-DEGRADED the persisted snapshot records the retrieval degradation

## `LITE-07-006`  07-Memory-Runtime.md · 18. Acceptance Expectations

**条款**：deterministic ranking with reasons;

- 点名文件：`apps/server/src/services/MemoryContextResolver.test.ts`（passed，raw exit 0，计数 {"passed":17,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（17 条）：

  - [pass] MF4I-01 resolve persists a snapshot and returns bounded context
  - [pass] MF4I-02 resolve is idempotent per run scope
  - [pass] MF4I-03 stage scope is distinct from run scope
  - [pass] replaying an earlier scope after a later Stage does not recreate its snapshot
  - [pass] MF4I-04 snapshot failure blocks injection
  - [pass] MF4I-05 invalid input fails closed
  - [pass] MF4I-06 injection gate rejects absent snapshot
  - [pass] MF4I-07 later entry edits do not rewrite the snapshot
  - [pass] frozen injection survives content edits and logical deletion of its Entry
  - [pass] historical metadata-only snapshot is inspectable but blocks injection
  - [pass] payload failure rolls back the snapshot and its selections
  - [pass] corrupt frozen payload blocks replay
  - [pass] MF4I-08 empty store still persists a snapshot
  - [pass] MF4I-09 default budget is frozen and valid
  - [pass] MF4I-10 workspace isolation
  - [pass] LITE-07-109: new snapshots exclude ineligible content while historical snapshots stay frozen
  - [pass] LITE-07-013 MF4I-DEGRADED the persisted snapshot records the retrieval degradation

## `LITE-07-010`  07-Memory-Runtime.md · 18. Acceptance Expectations

**条款**：no bulk transcript or Provider-history promotion;

- 点名文件：`apps/server/src/services/MemoryCandidateGenerationService.test.ts`（passed，raw exit 0，计数 {"passed":15,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（15 条）：

  - [pass] MF2R-G1 completed Run generates a review-required Candidate with bounded evidence
  - [pass] MF2R-G2 replay converges on the existing Candidate
  - [pass] MF2R-G3 exact duplicate content converges with no new Candidate
  - [pass] MF2R-G4 normalized-hash near-duplicate forces review-required
  - [pass] MF2R-G4b FTS-similar near-duplicate forces review-required
  - [pass] LITE-07-003 LITE-07-107 terminal dedup ignores another task
  - [pass] LITE-07-003 LITE-07-107 terminal dedup ignores workspace scope
  - [pass] LITE-07-003 LITE-07-107 terminal dedup ignores another category
  - [pass] LITE-07-003 LITE-07-107 terminal dedup ignores archived
  - [pass] LITE-07-003 LITE-07-107 terminal dedup ignores deleted
  - [pass] LITE-07-107 exact terminal dedup adds source once without changing accepted content
  - [pass] MF2R-G5 non-terminal or unknown Run generates nothing
  - [pass] MF2R-G6 failed Run generates one bounded failure Candidate, idempotent per Run
  - [pass] MF2R-G7 cancelled Run generates one bounded failure Candidate without a failure code
  - [pass] MF2R input validation fails closed

## `LITE-08-001`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：every high-impact action at an AgentOS-controlled or verified Provider pre-action boundary is decided before execution;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-08-002`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：DENY blocks AgentOS-owned spawn, destructive filesystem action, merge, push, and secret export;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-08-003`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：DENY blocks Provider-native merge or push only when a verified enforceable pre-action bridge exposes that action before execution;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-08-004`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：un-interceptable Provider-native actions are never reported as blocked; their Runs are modifying, single-writer admission applies, and unavailable enforcement is visible;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-08-008`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：snapshot hashes detect changed actions;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-08-012`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：browser disconnect does not decide;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-08-013`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：no policy path bypasses single-writer admission;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-08-014`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：modifying execution succeeds without an AgentOS-owned Worktree;

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-08-015`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：no full DSL, grants, simulation, or RBAC feature is active Lite scope.

- 点名文件：`apps/server/src/services/m3-p2c2b-composite-lifecycle.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（30 条）：

  - [pass] P2C-2B completeRunStartup commits Stage then Run started events with snapshots
  - [pass] P2C-2B requestApproval supports Run-only and Stage-specific approval envelopes
  - [pass] P2C-2B resolveApprovalToRunning emits only approval.resolved
  - [pass] P2C-2B resolveApprovalToFailure orders approval, Stage failure, and Run failure
  - [pass] P2C-2B resolveApprovalToCancellation fans out affected Stages in stable order
  - [pass] P2C-2B resolution retries return already-resolved before state, Stage, or version checks
  - [pass] P2C-2B approval resolution binds identity and exact Run/Stage scope before the clock
  - [pass] P2C-2B all three approval running decisions and strict composite version contract pass
  - [pass] P2C-2B resolveApprovalToFailure requires Stage-specific scope and expectedStageVersion
  - [pass] P2C-2B cancelRun handles zero and multiple non-terminal Stages and rejects waiting approval
  - [pass] P2C-2B caller-owned Run cancellation preserves lifecycle order and transaction ownership
  - [pass] P3D-2 operation cancel discovers Run-level and Stage-level unresolved approvals
  - [pass] P3D-2 approval cancel is ordered, contiguous, metadata-fixed, and one-outbox-per-event
  - [pass] P3D-2 approval history with zero, multiple, duplicate, or inconsistent records fails closed
  - [pass] P3D-2 unsafe unknown approval history fails closed
  - [pass] P3D-2 invalid approvalRequestId history fails closed and rolls back
  - [pass] P3D-2 operation cancel reuses non-approval caller-owned cancellation for all guarded Run states
  - [pass] P3D-2 operation approval Event and Outbox failures roll back all state
  - [pass] P2C-2B completeRun derives completedStageIds and enforces the completion rule
  - [pass] P2C-2B stale versions, invalid decisions, and terminal states fail before clock or mutation
  - [pass] P2C-2B every Event and Outbox position rolls back the composite transaction
  - [pass] P2C-2B same-file concurrency permits only one composite cancellation
  - [pass] HANDOFF-01 caller-supplied cancellation evidence reaches the canonical Run event unchanged
  - [pass] HANDOFF-02 stale caller Run version leaves Run, Stage, and Approval state unchanged
  - [pass] HANDOFF-03 waiting approval reuses the ordered cancellation composite with caller evidence
  - [pass] HANDOFF-04 generic caller-owned cancellation still rejects waiting_approval
  - [pass] HANDOFF-05 new evidence seam is safe inside a caller-owned transaction
  - [pass] HANDOFF-06 existing Operation cancellation seam remains behaviorally compatible
  - [pass] HANDOFF-07 evidence seam returns synchronously without an async transaction callback
  - [pass] P6C text stream seam persists Event and Outbox atomically without mutating Run or Stage lifecycle state

## `LITE-09-001`  09-Conversation-Runtime.md · 18. Acceptance Expectations

**条款**：Message-only Turns create no Task and no Run;

- 点名文件：`apps/server/src/services/ConversationTurnDriver.test.ts`（passed，raw exit 0，计数 {"passed":14,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（14 条）：

  - [pass] TD-01 a completed reply streams every delta as a durable checkpoint and finalizes
  - [pass] TD-02 a provider failure finalizes failed and preserves the checkpoints
  - [pass] TD-03 a cancelled reply finalizes the Turn cancelled and the Message failed
  - [pass] TD-04 an unknown Agent fails closed without reserving a stream
  - [pass] TD-05 waiting_user finalizes the Turn final with the question as content
  - [pass] TD-06 a runner crash finalizes failed instead of leaving an open stream
  - [pass] LITE-09-101 TD-07 freezes a bounded history and persists its selector result before the Provider
  - [pass] LITE-09-101 TD-08 a context snapshot persistence failure fails the Turn without invoking the Provider
  - [pass] LITE-09-102 chat refuses while another subject holds the Workspace modifying authority
  - [pass] LITE-09-102 a READ_ONLY holder does not block chat and D3 parallel-read-only stays unavailable
  - [pass] LITE-09-109 TD-11 a summary whose covered Message was edited is refused and the reason is recorded
  - [pass] LITE-09-109 TD-12 an unchanged source still adopts the summary and records it
  - [pass] LITE-09-101 TD-09 injects exactly the frozen selection into the Provider call
  - [pass] LITE-09-101 TD-10 an empty selection injects no context block

## `LITE-09-002`  09-Conversation-Runtime.md · 18. Acceptance Expectations

**条款**：Task creation and Run creation are distinct and idempotent;

- 点名文件：`apps/server/src/services/ConversationTurnDriver.test.ts`（passed，raw exit 0，计数 {"passed":14,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（14 条）：

  - [pass] TD-01 a completed reply streams every delta as a durable checkpoint and finalizes
  - [pass] TD-02 a provider failure finalizes failed and preserves the checkpoints
  - [pass] TD-03 a cancelled reply finalizes the Turn cancelled and the Message failed
  - [pass] TD-04 an unknown Agent fails closed without reserving a stream
  - [pass] TD-05 waiting_user finalizes the Turn final with the question as content
  - [pass] TD-06 a runner crash finalizes failed instead of leaving an open stream
  - [pass] LITE-09-101 TD-07 freezes a bounded history and persists its selector result before the Provider
  - [pass] LITE-09-101 TD-08 a context snapshot persistence failure fails the Turn without invoking the Provider
  - [pass] LITE-09-102 chat refuses while another subject holds the Workspace modifying authority
  - [pass] LITE-09-102 a READ_ONLY holder does not block chat and D3 parallel-read-only stays unavailable
  - [pass] LITE-09-109 TD-11 a summary whose covered Message was edited is refused and the reason is recorded
  - [pass] LITE-09-109 TD-12 an unchanged source still adopts the summary and records it
  - [pass] LITE-09-101 TD-09 injects exactly the frozen selection into the Provider call
  - [pass] LITE-09-101 TD-10 an empty selection injects no context block

## `LITE-09-007`  09-Conversation-Runtime.md · 18. Acceptance Expectations

**条款**：browser disconnect leaves Run and Process active;

- 点名文件：`apps/server/src/services/ConversationTurnDriver.test.ts`（passed，raw exit 0，计数 {"passed":14,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（14 条）：

  - [pass] TD-01 a completed reply streams every delta as a durable checkpoint and finalizes
  - [pass] TD-02 a provider failure finalizes failed and preserves the checkpoints
  - [pass] TD-03 a cancelled reply finalizes the Turn cancelled and the Message failed
  - [pass] TD-04 an unknown Agent fails closed without reserving a stream
  - [pass] TD-05 waiting_user finalizes the Turn final with the question as content
  - [pass] TD-06 a runner crash finalizes failed instead of leaving an open stream
  - [pass] LITE-09-101 TD-07 freezes a bounded history and persists its selector result before the Provider
  - [pass] LITE-09-101 TD-08 a context snapshot persistence failure fails the Turn without invoking the Provider
  - [pass] LITE-09-102 chat refuses while another subject holds the Workspace modifying authority
  - [pass] LITE-09-102 a READ_ONLY holder does not block chat and D3 parallel-read-only stays unavailable
  - [pass] LITE-09-109 TD-11 a summary whose covered Message was edited is refused and the reason is recorded
  - [pass] LITE-09-109 TD-12 an unchanged source still adopts the summary and records it
  - [pass] LITE-09-101 TD-09 injects exactly the frozen selection into the Provider call
  - [pass] LITE-09-101 TD-10 an empty selection injects no context block

## `LITE-09-008`  09-Conversation-Runtime.md · 18. Acceptance Expectations

**条款**：Event projection never duplicates cards;

- 点名文件：`apps/server/src/services/ConversationTurnDriver.test.ts`（passed，raw exit 0，计数 {"passed":14,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（14 条）：

  - [pass] TD-01 a completed reply streams every delta as a durable checkpoint and finalizes
  - [pass] TD-02 a provider failure finalizes failed and preserves the checkpoints
  - [pass] TD-03 a cancelled reply finalizes the Turn cancelled and the Message failed
  - [pass] TD-04 an unknown Agent fails closed without reserving a stream
  - [pass] TD-05 waiting_user finalizes the Turn final with the question as content
  - [pass] TD-06 a runner crash finalizes failed instead of leaving an open stream
  - [pass] LITE-09-101 TD-07 freezes a bounded history and persists its selector result before the Provider
  - [pass] LITE-09-101 TD-08 a context snapshot persistence failure fails the Turn without invoking the Provider
  - [pass] LITE-09-102 chat refuses while another subject holds the Workspace modifying authority
  - [pass] LITE-09-102 a READ_ONLY holder does not block chat and D3 parallel-read-only stays unavailable
  - [pass] LITE-09-109 TD-11 a summary whose covered Message was edited is refused and the reason is recorded
  - [pass] LITE-09-109 TD-12 an unchanged source still adopts the summary and records it
  - [pass] LITE-09-101 TD-09 injects exactly the frozen selection into the Provider call
  - [pass] LITE-09-101 TD-10 an empty selection injects no context block

## `LITE-09-012`  09-Conversation-Runtime.md · 18. Acceptance Expectations

**条款**：budgets, stop, and loop guard terminate every group interaction;

- 点名文件：`apps/server/src/services/ConversationTurnDriver.test.ts`（passed，raw exit 0，计数 {"passed":14,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（14 条）：

  - [pass] TD-01 a completed reply streams every delta as a durable checkpoint and finalizes
  - [pass] TD-02 a provider failure finalizes failed and preserves the checkpoints
  - [pass] TD-03 a cancelled reply finalizes the Turn cancelled and the Message failed
  - [pass] TD-04 an unknown Agent fails closed without reserving a stream
  - [pass] TD-05 waiting_user finalizes the Turn final with the question as content
  - [pass] TD-06 a runner crash finalizes failed instead of leaving an open stream
  - [pass] LITE-09-101 TD-07 freezes a bounded history and persists its selector result before the Provider
  - [pass] LITE-09-101 TD-08 a context snapshot persistence failure fails the Turn without invoking the Provider
  - [pass] LITE-09-102 chat refuses while another subject holds the Workspace modifying authority
  - [pass] LITE-09-102 a READ_ONLY holder does not block chat and D3 parallel-read-only stays unavailable
  - [pass] LITE-09-109 TD-11 a summary whose covered Message was edited is refused and the reason is recorded
  - [pass] LITE-09-109 TD-12 an unchanged source still adopts the summary and records it
  - [pass] LITE-09-101 TD-09 injects exactly the frozen selection into the Provider call
  - [pass] LITE-09-101 TD-10 an empty selection injects no context block

## `LITE-09-015`  09-Conversation-Runtime.md · 18. Acceptance Expectations

**条款**：@all never launches parallel modification;

- 点名文件：`apps/server/src/services/ConversationTurnDriver.test.ts`（passed，raw exit 0，计数 {"passed":14,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（14 条）：

  - [pass] TD-01 a completed reply streams every delta as a durable checkpoint and finalizes
  - [pass] TD-02 a provider failure finalizes failed and preserves the checkpoints
  - [pass] TD-03 a cancelled reply finalizes the Turn cancelled and the Message failed
  - [pass] TD-04 an unknown Agent fails closed without reserving a stream
  - [pass] TD-05 waiting_user finalizes the Turn final with the question as content
  - [pass] TD-06 a runner crash finalizes failed instead of leaving an open stream
  - [pass] LITE-09-101 TD-07 freezes a bounded history and persists its selector result before the Provider
  - [pass] LITE-09-101 TD-08 a context snapshot persistence failure fails the Turn without invoking the Provider
  - [pass] LITE-09-102 chat refuses while another subject holds the Workspace modifying authority
  - [pass] LITE-09-102 a READ_ONLY holder does not block chat and D3 parallel-read-only stays unavailable
  - [pass] LITE-09-109 TD-11 a summary whose covered Message was edited is refused and the reason is recorded
  - [pass] LITE-09-109 TD-12 an unchanged source still adopts the summary and records it
  - [pass] LITE-09-101 TD-09 injects exactly the frozen selection into the Provider call
  - [pass] LITE-09-101 TD-10 an empty selection injects no context block

## `LITE-09-018`  09-Conversation-Runtime.md · 18. Acceptance Expectations

**条款**：search excludes secrets.

- 点名文件：`apps/server/src/services/ConversationTurnDriver.test.ts`（passed，raw exit 0，计数 {"passed":14,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（14 条）：

  - [pass] TD-01 a completed reply streams every delta as a durable checkpoint and finalizes
  - [pass] TD-02 a provider failure finalizes failed and preserves the checkpoints
  - [pass] TD-03 a cancelled reply finalizes the Turn cancelled and the Message failed
  - [pass] TD-04 an unknown Agent fails closed without reserving a stream
  - [pass] TD-05 waiting_user finalizes the Turn final with the question as content
  - [pass] TD-06 a runner crash finalizes failed instead of leaving an open stream
  - [pass] LITE-09-101 TD-07 freezes a bounded history and persists its selector result before the Provider
  - [pass] LITE-09-101 TD-08 a context snapshot persistence failure fails the Turn without invoking the Provider
  - [pass] LITE-09-102 chat refuses while another subject holds the Workspace modifying authority
  - [pass] LITE-09-102 a READ_ONLY holder does not block chat and D3 parallel-read-only stays unavailable
  - [pass] LITE-09-109 TD-11 a summary whose covered Message was edited is refused and the reason is recorded
  - [pass] LITE-09-109 TD-12 an unchanged source still adopts the summary and records it
  - [pass] LITE-09-101 TD-09 injects exactly the frozen selection into the Provider call
  - [pass] LITE-09-101 TD-10 an empty selection injects no context block

## `LITE-10-002`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：checksum, backup, integrity, and foreign-key gates;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-003`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：opaque IDs and Process ID/PID distinction;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-004`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：Task zero/many Runs and retry child lineage;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-005`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：Snapshot immutability and child remapping;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-006`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：Event append-only and per-Run ordering;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-007`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：Event/Outbox atomicity and replay;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-008`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：idempotency convergence;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-009`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：optimistic race winner;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-010`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：Process reserve-before-spawn;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-011`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：immutable requested/effective mutation classification and `enforcedWorkspaceReadOnly` evidence per Run;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-012`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：fail-closed recovery evidence;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-013`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：bounded finalized output references;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-014`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：Workspace tombstones and non-cascading history;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-015`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：compatibility reads without data loss;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-016`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：no secret persistence;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-10-017`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：no clean-sheet schema replacement.

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":2,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（2 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated

## `LITE-11-001`  11-API-Specification.md · 20. Acceptance Expectations

**条款**：Message post creates no Task or Run;

- 点名文件：`apps/server/src/routes/canonicalRunStream.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0)
  - [pass] P5C afterSequence-only cursor replays strictly greater durable sequences
  - [pass] P5C Last-Event-ID-only cursor resolves the persisted Event sequence
  - [pass] P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native reconnect)
  - [pass] P5C-R05 monotonic cursor: query higher than Last-Event-ID lets the query win
  - [pass] P5C malformed afterSequence variants fail with 400 VALIDATION_FAILED before any SSE header
  - [pass] P5C unknown, foreign-Run and foreign-Workspace Last-Event-ID share one 400 representation
  - [pass] P5C unknown Run takes precedence over a malformed cursor with 404 RUN_NOT_FOUND
  - [pass] P5C live durable commits after subscribe are delivered exactly once with the persisted id
  - [pass] P5C unknown persisted runtime events stream losslessly with kind/raw/warning
  - [pass] P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
  - [pass] P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once
  - [pass] P5C overflow closes the SSE transport without synthetic frames or durable writes
  - [pass] P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed
  - [pass] P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)
  - [pass] P5C stream route does not shadow canonical Run, Events or Replay routes

## `LITE-11-002`  11-API-Specification.md · 20. Acceptance Expectations

**条款**：create-task and start-run are separate and idempotent;

- 点名文件：`apps/server/src/routes/canonicalRunStream.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0)
  - [pass] P5C afterSequence-only cursor replays strictly greater durable sequences
  - [pass] P5C Last-Event-ID-only cursor resolves the persisted Event sequence
  - [pass] P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native reconnect)
  - [pass] P5C-R05 monotonic cursor: query higher than Last-Event-ID lets the query win
  - [pass] P5C malformed afterSequence variants fail with 400 VALIDATION_FAILED before any SSE header
  - [pass] P5C unknown, foreign-Run and foreign-Workspace Last-Event-ID share one 400 representation
  - [pass] P5C unknown Run takes precedence over a malformed cursor with 404 RUN_NOT_FOUND
  - [pass] P5C live durable commits after subscribe are delivered exactly once with the persisted id
  - [pass] P5C unknown persisted runtime events stream losslessly with kind/raw/warning
  - [pass] P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
  - [pass] P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once
  - [pass] P5C overflow closes the SSE transport without synthetic frames or durable writes
  - [pass] P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed
  - [pass] P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)
  - [pass] P5C stream route does not shadow canonical Run, Events or Replay routes

## `LITE-11-005`  11-API-Specification.md · 20. Acceptance Expectations

**条款**：frozen start/retry/cancel semantics and errors remain exact;

- 点名文件：`apps/server/src/routes/canonicalRunStream.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0)
  - [pass] P5C afterSequence-only cursor replays strictly greater durable sequences
  - [pass] P5C Last-Event-ID-only cursor resolves the persisted Event sequence
  - [pass] P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native reconnect)
  - [pass] P5C-R05 monotonic cursor: query higher than Last-Event-ID lets the query win
  - [pass] P5C malformed afterSequence variants fail with 400 VALIDATION_FAILED before any SSE header
  - [pass] P5C unknown, foreign-Run and foreign-Workspace Last-Event-ID share one 400 representation
  - [pass] P5C unknown Run takes precedence over a malformed cursor with 404 RUN_NOT_FOUND
  - [pass] P5C live durable commits after subscribe are delivered exactly once with the persisted id
  - [pass] P5C unknown persisted runtime events stream losslessly with kind/raw/warning
  - [pass] P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
  - [pass] P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once
  - [pass] P5C overflow closes the SSE transport without synthetic frames or durable writes
  - [pass] P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed
  - [pass] P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)
  - [pass] P5C stream route does not shadow canonical Run, Events or Replay routes

## `LITE-11-008`  11-API-Specification.md · 20. Acceptance Expectations

**条款**：one Workspace never admits two modifying Runs;

- 点名文件：`apps/server/src/routes/canonicalRunStream.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0)
  - [pass] P5C afterSequence-only cursor replays strictly greater durable sequences
  - [pass] P5C Last-Event-ID-only cursor resolves the persisted Event sequence
  - [pass] P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native reconnect)
  - [pass] P5C-R05 monotonic cursor: query higher than Last-Event-ID lets the query win
  - [pass] P5C malformed afterSequence variants fail with 400 VALIDATION_FAILED before any SSE header
  - [pass] P5C unknown, foreign-Run and foreign-Workspace Last-Event-ID share one 400 representation
  - [pass] P5C unknown Run takes precedence over a malformed cursor with 404 RUN_NOT_FOUND
  - [pass] P5C live durable commits after subscribe are delivered exactly once with the persisted id
  - [pass] P5C unknown persisted runtime events stream losslessly with kind/raw/warning
  - [pass] P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
  - [pass] P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once
  - [pass] P5C overflow closes the SSE transport without synthetic frames or durable writes
  - [pass] P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed
  - [pass] P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)
  - [pass] P5C stream route does not shadow canonical Run, Events or Replay routes

## `LITE-11-009`  11-API-Specification.md · 20. Acceptance Expectations

**条款**：API clients cannot obtain concurrent read-only admission through prompt wording or a forced capability value;

- 点名文件：`apps/server/src/routes/canonicalRunStream.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0)
  - [pass] P5C afterSequence-only cursor replays strictly greater durable sequences
  - [pass] P5C Last-Event-ID-only cursor resolves the persisted Event sequence
  - [pass] P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native reconnect)
  - [pass] P5C-R05 monotonic cursor: query higher than Last-Event-ID lets the query win
  - [pass] P5C malformed afterSequence variants fail with 400 VALIDATION_FAILED before any SSE header
  - [pass] P5C unknown, foreign-Run and foreign-Workspace Last-Event-ID share one 400 representation
  - [pass] P5C unknown Run takes precedence over a malformed cursor with 404 RUN_NOT_FOUND
  - [pass] P5C live durable commits after subscribe are delivered exactly once with the persisted id
  - [pass] P5C unknown persisted runtime events stream losslessly with kind/raw/warning
  - [pass] P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
  - [pass] P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once
  - [pass] P5C overflow closes the SSE transport without synthetic frames or durable writes
  - [pass] P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed
  - [pass] P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)
  - [pass] P5C stream route does not shadow canonical Run, Events or Replay routes

## `LITE-11-010`  11-API-Specification.md · 20. Acceptance Expectations

**条款**：optimistic races have one winner;

- 点名文件：`apps/server/src/routes/canonicalRunStream.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0)
  - [pass] P5C afterSequence-only cursor replays strictly greater durable sequences
  - [pass] P5C Last-Event-ID-only cursor resolves the persisted Event sequence
  - [pass] P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native reconnect)
  - [pass] P5C-R05 monotonic cursor: query higher than Last-Event-ID lets the query win
  - [pass] P5C malformed afterSequence variants fail with 400 VALIDATION_FAILED before any SSE header
  - [pass] P5C unknown, foreign-Run and foreign-Workspace Last-Event-ID share one 400 representation
  - [pass] P5C unknown Run takes precedence over a malformed cursor with 404 RUN_NOT_FOUND
  - [pass] P5C live durable commits after subscribe are delivered exactly once with the persisted id
  - [pass] P5C unknown persisted runtime events stream losslessly with kind/raw/warning
  - [pass] P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
  - [pass] P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once
  - [pass] P5C overflow closes the SSE transport without synthetic frames or durable writes
  - [pass] P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed
  - [pass] P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)
  - [pass] P5C stream route does not shadow canonical Run, Events or Replay routes

## `LITE-11-011`  11-API-Specification.md · 20. Acceptance Expectations

**条款**：History is Agent-unified and Search is secret-free;

- 点名文件：`apps/server/src/routes/canonicalRunStream.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0)
  - [pass] P5C afterSequence-only cursor replays strictly greater durable sequences
  - [pass] P5C Last-Event-ID-only cursor resolves the persisted Event sequence
  - [pass] P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native reconnect)
  - [pass] P5C-R05 monotonic cursor: query higher than Last-Event-ID lets the query win
  - [pass] P5C malformed afterSequence variants fail with 400 VALIDATION_FAILED before any SSE header
  - [pass] P5C unknown, foreign-Run and foreign-Workspace Last-Event-ID share one 400 representation
  - [pass] P5C unknown Run takes precedence over a malformed cursor with 404 RUN_NOT_FOUND
  - [pass] P5C live durable commits after subscribe are delivered exactly once with the persisted id
  - [pass] P5C unknown persisted runtime events stream losslessly with kind/raw/warning
  - [pass] P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
  - [pass] P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once
  - [pass] P5C overflow closes the SSE transport without synthetic frames or durable writes
  - [pass] P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed
  - [pass] P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)
  - [pass] P5C stream route does not shadow canonical Run, Events or Replay routes

## `LITE-11-012`  11-API-Specification.md · 20. Acceptance Expectations

**条款**：Artifact DTOs leak no storage path;

- 点名文件：`apps/server/src/routes/canonicalRunStream.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0)
  - [pass] P5C afterSequence-only cursor replays strictly greater durable sequences
  - [pass] P5C Last-Event-ID-only cursor resolves the persisted Event sequence
  - [pass] P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native reconnect)
  - [pass] P5C-R05 monotonic cursor: query higher than Last-Event-ID lets the query win
  - [pass] P5C malformed afterSequence variants fail with 400 VALIDATION_FAILED before any SSE header
  - [pass] P5C unknown, foreign-Run and foreign-Workspace Last-Event-ID share one 400 representation
  - [pass] P5C unknown Run takes precedence over a malformed cursor with 404 RUN_NOT_FOUND
  - [pass] P5C live durable commits after subscribe are delivered exactly once with the persisted id
  - [pass] P5C unknown persisted runtime events stream losslessly with kind/raw/warning
  - [pass] P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
  - [pass] P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once
  - [pass] P5C overflow closes the SSE transport without synthetic frames or durable writes
  - [pass] P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed
  - [pass] P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)
  - [pass] P5C stream route does not shadow canonical Run, Events or Replay routes

## `LITE-11-013`  11-API-Specification.md · 20. Acceptance Expectations

**条款**：deferred API families are not active requirements.

- 点名文件：`apps/server/src/routes/canonicalRunStream.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] P5C-R01 GET run stream is implemented as SSE with inherited request id (default cursor 0)
  - [pass] P5C afterSequence-only cursor replays strictly greater durable sequences
  - [pass] P5C Last-Event-ID-only cursor resolves the persisted Event sequence
  - [pass] P5C-R05 monotonic cursor: query lower than Last-Event-ID lets the header win (native reconnect)
  - [pass] P5C-R05 monotonic cursor: query higher than Last-Event-ID lets the query win
  - [pass] P5C malformed afterSequence variants fail with 400 VALIDATION_FAILED before any SSE header
  - [pass] P5C unknown, foreign-Run and foreign-Workspace Last-Event-ID share one 400 representation
  - [pass] P5C unknown Run takes precedence over a malformed cursor with 404 RUN_NOT_FOUND
  - [pass] P5C live durable commits after subscribe are delivered exactly once with the persisted id
  - [pass] P5C unknown persisted runtime events stream losslessly with kind/raw/warning
  - [pass] P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
  - [pass] P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once
  - [pass] P5C overflow closes the SSE transport without synthetic frames or durable writes
  - [pass] P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed
  - [pass] P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)
  - [pass] P5C stream route does not shadow canonical Run, Events or Replay routes

## `LITE-12-002`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：shared semantic token coverage;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-004`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：reduced-motion behavior;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-005`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：batched streaming and stable scroll;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-006`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：cursor reconnect without gaps/duplicates;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-007`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：complete async states;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-008`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：explicit Chat/Task/Run actions;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-009`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：bounded Group controls;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-011`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：Memory selection explanation;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-013`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：Agent-unified History and secret-free Search;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-014`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：keyboard core flow and stable focus;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-015`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：API-client-only access;

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-12-016`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：absence of active Worktree manager, full Policy editor, and Provider Comparison.

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-13-002`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：Run, Stage, Provider, Process, and duration are distinct;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-13-003`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：Process ID is never confused with PID;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-13-004`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：strict Event order, gap recovery, and deduplication;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-13-005`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：bounded output without unbounded client state;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-13-007`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：Git wording never implies ownership;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-13-008`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：recovery never guesses success;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-13-009`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：no reattach/takeover/direct-kill control;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-13-010`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：Cancel/Retry route through API, Policy, Runtime, and committed Event;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-13-013`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：no secrets in DTOs;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-13-014`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：browser disconnect leaves execution active;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-13-015`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：replay has zero external side effects.

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（4 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)

## `LITE-04-101`  04-Provider-Specification.md · §14; §15.2

**条款**：Codex/Kimi/OpenCode 的实际生产链接入与真实调用

- 点名文件：`apps/server/src/services/run-engine/RunEngineProviderDispatcher.test.ts`（not-clean，raw exit 0，计数 {"passed":32,"failed":0,"skipped":4}）
- 该文件实际执行过的断言（33 条）：

  - [pass] LITE-08-005/006/007: ASK_USER pauses before spawn and one approved original Run continues once
  - [pass] LITE-08-006/007: reject is terminal, replay-safe, and a changed launch plan cannot execute
  - [pass] LITE-08-006: an approved request rejects a contradictory replay without changing the result
  - [pass] LITE-08-007: expiry after the first gate but before spawn blocks the Process side effect
  - [pass] LITE-08-005: startup resume never bypasses a Run already marked recovery-required
  - [pass] LITE-08-005: approved but unconsumed decisions are redriven after restart without a new start Operation
  - [pass] LITE-07-103: Candidate Event failure rolls back decision, lifecycle resume, and request evidence
  - [pass] LITE-07-104: completed adapter result reaches Artifact finalizer and Stage history before terminal Memory
  - [pass] LITE-07-104: active execution cannot finalize a review Artifact
  - [pass] L1D-I08 QUEUED admission causes zero engine, provider session, process, and spawn side effects
  - [pass] L1D-I17 stale GRANTED READ_ONLY authority cannot reach RunEngine, provider, process, or spawn
  - [pass] L1D-I18 freshly revalidated GRANTED READ_ONLY authority may pass the dispatcher gate
  - [pass] L1D-I19 QUEUED authorization never advances the queue and retains zero side effects
  - [pass] P5D maps only the exact proven stop identity into cancellation evidence
  - [pass] P5D rejects an unproven explicit stop before producing lifecycle evidence
  - [pass] consumes an internal stopped outcome without mutating canonical Stage or Run lifecycle
  - [pass] drives one accepted Run through RunEngine -> coordinator -> lifecycle to completed with one spawn per stage
  - [pass] MEDIUM-1A: joined-existing active stage causes ONE coordinator attempt per drive (no 128 no-progress loop)
  - [pass] replay after terminal never re-dispatches or spawns again
  - [pass] P5E composes Dispatcher cancellation, owned Process cleanup, and LTS handoff exactly once
  - [pass] auth failure fails the Run canonically with zero spawns
  - [pass] legacy-originated runs flow through the same authority to completion (legacy projection parity)
  - [pass] driveSafely drives one accepted run to completion (one spawn per stage)
  - [pass] driveSafely contains a post-claim coordinator failure into a canonical failure (no strand, no throw)
  - [pass] LITE-07-102: a contained post-claim failure still fires one terminal trigger for the failed Run
  - [pass] driveSafely contains a pre-claim failure into a canonical operation failure (no strand, no throw)
  - [pass] driveSafely is replay-safe: a second drive on a terminal run does not respawn
  - [pass] MF-4 integration: a configured resolver injects the persisted memory context into the stage prompt
  - [pass] MF-4 integration: a blocked injection prevents provider execution
  - [pass] MF-4 integration: a resolver snapshot failure prevents provider execution
  - [pass] MF-2R integration: terminal completion fires the candidate trigger once, Run-scoped
  - [pass] MF-2R integration: a failing generator never changes the terminal Run
  - [pass] RunEngineProviderDispatcher E2E

## `LITE-07-101`  07-Memory-Runtime.md · §7

**条款**：显式用户保存触发

- 点名文件：`apps/server/src/routes/memoryRuntime.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] MF5W-A10/A14: the review and resolve routes append Workspace Events, not Run-scoped rows
  - [pass] MF-5 retrieve: ranked results with reasons, filters, limit, and degraded flag
  - [pass] MF-5 retrieve: unknown Workspace is 404
  - [pass] MF-5 Run memory-context: 404 for unknown Run, ordered snapshots otherwise
  - [pass] MF-5 memory-context by id: frozen snapshot with selection and exclusion reasons
  - [pass] MF-5 conflict resolve: 200 once, 409 on replay or version skew, 404 unknown
  - [pass] MF-5 candidate queue: list, outcome filter, and version-guarded review
  - [pass] MF-5 candidate review: strict edits promote an Entry and retrieval sees only the active Entry
  - [pass] MF-2 explicit user save: creates the Entry and one Workspace Event in one transaction
  - [pass] LITE-07-003/107: explicit save validates invalid scope, category, sources, and owners before duplicate lookup
  - [pass] LITE-07-003: explicit save does not converge across category or global/workspace scope
  - [pass] LITE-07-003: an archived hash match does not swallow a legal explicit save
  - [pass] LITE-07-003: exact duplicate merges a new source once and emits one Workspace dedup event
  - [pass] LITE-07-003: Workspace Event failure rolls back exact-source merge, version, and sequence
  - [pass] LITE-07-003: source write failure rolls back dedup before any Event is published
  - [pass] LITE-07-003: simultaneous exact saves converge to one source mutation and one Event

## `LITE-12-101`  12-UI-Architecture.md · §5–§6; §16; §19

**条款**：四栏正文要求的导航、通知状态及键盘流覆盖

- 点名文件：`apps/web/src/components/layout/WorkbenchShell.test.tsx`（passed，raw exit 0，计数 {"passed":9,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（9 条）：

  - [pass] SHELL-01 wide mode renders all four columns with landmarks
  - [pass] SHELL-02 the shell consumes the token system through CSS variables
  - [pass] SHELL-03 standard mode collapses the Inspector into an affordance
  - [pass] SHELL-04 compact mode keeps Agents and Canvas only
  - [pass] SHELL-05 reduced motion collapses panel transitions to zero
  - [pass] SHELL-06 panel collapse is client-only UI state and the Canvas cannot collapse
  - [pass] SHELL-07 dark and light themes emit their own token values
  - [pass] SHELL-08 the Canvas keeps its minimum width
  - [pass] SHELL-09 an optional toolbar renders above the columns

## `LITE-13-102`  13-Runtime-Inspector.md · §6–§14

**条款**：Inspector各section规范字段及Cancel/Retry源链

- 点名文件：`apps/server/src/services/RuntimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":12,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（12 条）：

  - [pass] INSP-12 Run, Stage, Provider, Process and duration stay distinct
  - [pass] INSP-01 overview projects canonical run state
  - [pass] INSP-02 unknown run fails closed
  - [pass] INSP-03 invalid input fails closed
  - [pass] INSP-04 process PID is evidence-only
  - [pass] INSP-05 events are ordered and bounded
  - [pass] INSP-06 afterSequence cursor
  - [pass] INSP-07 inspect performs no writes
  - [pass] INSP-08 memory context projection
  - [pass] INSP-09 absent memory context is null
  - [pass] INSP-10 workspace isolation
  - [pass] INSP-11 stages are ordered

## `LITE-01-101`  01-Core-Concepts.md · §9; 00 §10; 09 §14

**条款**：有界Workflow templates及真实实例化

- 点名文件：`packages/shared/wf-template-instantiation.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（10 条）：

  - [pass] WFI-01 single agent compiles
  - [pass] WFI-02 plan-implement-review compiles
  - [pass] WFI-03 parallel-analysis compiles
  - [pass] WFI-04 optional security review
  - [pass] WFI-05 unbound role fails closed
  - [pass] WFI-06 invalid role fails closed
  - [pass] WFI-07 definition overrides
  - [pass] WFI-08 invalid input fails closed
  - [pass] WFI-09 deterministic and non-mutating
  - [pass] WFI-10 every template compiles

