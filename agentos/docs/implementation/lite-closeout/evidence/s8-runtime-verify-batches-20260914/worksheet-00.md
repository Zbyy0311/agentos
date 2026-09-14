# RUNTIME-VERIFY 判读工作表（0..11 / 共 106 行待判读）

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

