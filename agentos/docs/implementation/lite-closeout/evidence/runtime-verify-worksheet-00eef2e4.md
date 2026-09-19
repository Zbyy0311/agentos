# RUNTIME-VERIFY 判读工作表（0..51 / 共 52 行待判读）

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

## `LITE-01-014`  01-Core-Concepts.md · 16. Acceptance Expectations

**条款**：unknown Provider details do not become invented facts;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


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

## `LITE-04-001`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：Adapter contract tests pass for discovery, validation, start, stream, cancel, finalize, redaction, and raw output;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-04-002`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：Mock Provider covers success, auth, rate-limit, non-zero exit, cancel, and process-crash scenarios;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-04-003`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：Kimi Code invocation does not route through OpenCode;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-04-006`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：errors normalize to stable codes with retryability;

- 点名文件：`packages/agent-core/src/providers/providerErrorRetryability.test.ts`（passed，raw exit 0，计数 {"passed":3,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-04-007`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：capability declarations match tested behavior;

- 点名文件：`packages/agent-core/src/providers/capabilityDeclaration.test.ts`（passed，raw exit 0，计数 {"passed":4,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-04-008`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：concurrent read-only admission is available only when attempted Workspace writes are technically denied and tested;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-04-009`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：unknown capability, prompt-only intent, user-forced values, `nativeSandbox`, and Provider-native worktrees never imply `enforcedWorkspaceReadOnly`;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-04-010`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：`nativeApprovals` proves an enforceable pre-action bridge rather than a Provider prompt or post-action notification;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-04-011`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：secrets are absent from Events, Snapshots, and debug bundles;

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-04-012`  04-Provider-Specification.md · 19. Acceptance Expectations

**条款**：no invented provider telemetry appears in canonical Events.

- 点名文件：`packages/agent-core/src/providers/kimiCodeAdapter.test.ts`（passed，raw exit 0，计数 {"passed":21,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-05-001`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：reserve-before-spawn ordering and idempotency;

- 点名文件：`packages/process-runtime/src/durable-coordinator.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-05-002`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：Windows Job assignment failure gate: provider instruction never executes, suspended provider is terminated, handles close, and spawn fails;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-05-003`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：Windows owned-spawn restart reaper gate: owned provider reaped, post-restart classification `MISSING`;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-05-004`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：Windows primitive identity gate: same creation identity -> `SAME`, different -> `MISMATCH`, unreadable -> `UNKNOWN`;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-05-005`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：production PID-reuse gate: persisted FILETIME A vs observed B, B != A -> `MISMATCH`, never `SAME`;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-05-006`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：evidence-version gates: v1 rows keep `MISSING`/`UNKNOWN`, v2 rows reach `SAME`/`MISMATCH`/`UNKNOWN`;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-05-007`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：cancel terminates the owned Windows process tree with survivor verification;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-05-009`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：timeout, approval-wait exclusion, and race-safe terminal transitions;

- 点名文件：`packages/process-runtime/src/manager.test.ts`（passed，raw exit 0，计数 {"passed":30,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-05-010`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：bounded independent stdout/stderr with Artifact fallback;

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-05-012`  05-Process-Runtime.md · 15. Acceptance Expectations

**条款**：classification never activates reattach, adoption, ownership transfer, or takeover.

- 点名文件：`packages/process-runtime/src/p6-m3b-windows-birth-identity.test.ts`（passed，raw exit 0，计数 {"passed":10,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-06-007`  06-Worktree-Runtime.md · 13. Acceptance Expectations

**条款**：diff Artifacts are immutable and checksummed;

- 点名文件：`packages/shared/p6-l1c-git-observation-contract.test.ts`（passed，raw exit 0，计数 {"passed":26,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（26 条）：

  - [pass] L1C-M1-01 versioned snapshot and changed-files contracts omit raw stderr
  - [pass] L1C-M1-02 changed files serialize deterministically with explicit limits
  - [pass] L1C-M1-03 command execution contract freezes C locale and side-effect guards
  - [pass] L1C-M1-04 GitCommandPort accepts only structured read families
  - [pass] L1C-M1-R01 raw stdout limits are finite per read family and not caller-sized
  - [pass] L1C-M1-05 ordinary bounded C-locale non-repository diagnostic maps to NOT_GIT
  - [pass] L1C-M1-06 dubious ownership maps to UNAVAILABLE
  - [pass] L1C-M1-07 permission-like discovery failure maps to UNAVAILABLE
  - [pass] L1C-M1-08 unknown exit 128 never maps to NOT_GIT
  - [pass] L1C-M1-R02 truncated discovery diagnostics cannot prove NOT_GIT
  - [pass] L1C-M1-09 timeout, cancellation, output overflow and spawn failure remain distinct
  - [pass] L1C-M1-10 successful repository discovery requires an absolute root
  - [pass] L1C-M1-R03 repository root output is one valid UTF-8 absolute record
  - [pass] L1C-M1-R04 HEAD classifier distinguishes valid, exact unborn and unavailable results
  - [pass] L1C-M1-R06 commit object IDs accept only lowercase 40/64 hex
  - [pass] L1C-M1-11 complete status maps zero entries to clean and entries to dirty
  - [pass] L1C-M1-12 incomplete status is never clean
  - [pass] L1C-M1-13 NOT_GIT has public not-applicable dirty state and Event unknown mapping
  - [pass] L1C-M1-13b snapshot union rejects contradictory state combinations
  - [pass] L1C-M1-14 malformed status fails the whole observation closed
  - [pass] L1C-M1-15 diff failure preserves successful GIT status facts
  - [pass] L1C-M1-16 truncated diff is explicit and never equivalent to no changes
  - [pass] L1C-M1-17 unborn repository remains GIT with null commits and non-applicable diff
  - [pass] L1C-M1-18 snapshot serialization is deterministic across subfailure order
  - [pass] L1C-M1-19 Event source and canonical causal-context seam are frozen
  - [pass] L1C-M1-20 canonical diff Artifact crash ordering forbids DB-first availability

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

## `LITE-08-014`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：modifying execution succeeds without an AgentOS-owned Worktree;

- 点名文件：`apps/server/src/services/run-engine/CanonicalArtifactResult.liveGate.test.ts`（not-clean，raw exit 0，计数 {"passed":0,"failed":0,"skipped":1}）
- 该文件实际执行过的断言（0 条）：


## `LITE-08-015`  08-Policy-Runtime.md · 15. Acceptance Expectations

**条款**：no full DSL, grants, simulation, or RBAC feature is active Lite scope.

- 点名文件：`apps/web/src/liteScopeBoundary.test.ts`（passed，raw exit 0，计数 {"passed":3,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（3 条）：

  - [pass] LITE-12-016 the UI ships only the Lite route surface
  - [pass] LITE-12-016 no web module implements a deferred product surface
  - [pass] LITE-12-016 the workspace shells expose no deferred product entry point

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

## `LITE-09-015`  09-Conversation-Runtime.md · 18. Acceptance Expectations

**条款**：@all never launches parallel modification;

- 点名文件：`apps/server/src/services/GroupSpeakerResolver.test.ts`（passed，raw exit 0，计数 {"passed":7,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（7 条）：

  - [pass] CG-S1: eligibility excludes muted, removed, never, and human members with stable reasons
  - [pass] CG-S1: a non-group or archived Conversation never yields speakers
  - [pass] CG-S2: sequential order is membership order; mentions always win and are reported
  - [pass] CG-S2: manual mode follows the caller order and reports the rest
  - [pass] CG-S3: orchestrated mode resolves the template order deterministically
  - [pass] CG-S4: the plan ends with the same stable budget reason recordReply would return
  - [pass] CG-S1/CG-S9: parallel-read-only declares intent but never claims an unproven read-only class

## `LITE-10-005`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：Snapshot immutability and child remapping;

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":3,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（3 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated
  - [pass] LITE-10-001 fresh install and supported upgrade both apply the complete registry

## `LITE-10-010`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：Process reserve-before-spawn;

- 点名文件：`packages/process-runtime/src/durable-coordinator.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-10-012`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：fail-closed recovery evidence;

- 点名文件：`packages/process-runtime/src/durable-coordinator.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-10-013`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：bounded finalized output references;

- 点名文件：`packages/process-runtime/src/durable-coordinator.test.ts`（passed，raw exit 0，计数 {"passed":34,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（0 条）：


## `LITE-10-017`  10-Data-Model.md · 18. Acceptance Expectations

**条款**：no clean-sheet schema replacement.

- 点名文件：`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts`（passed，raw exit 0，计数 {"passed":3,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（3 条）：

  - [pass] P2 Migration Registry contains exactly the registered migrations in contract order
  - [pass] P2 Migration Registry preserves the exact padded order when instantiated
  - [pass] LITE-10-001 fresh install and supported upgrade both apply the complete registry

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
  - [pass] LITE-04-005 / P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
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
  - [pass] LITE-04-005 / P5C-R06 browser disconnect is subscription-only: Run state untouched and lifecycle continues
  - [pass] P5C-R06 client disconnect unsubscribes the RunStreamService subscription exactly once
  - [pass] P5C overflow closes the SSE transport without synthetic frames or durable writes
  - [pass] P5C-R07 transport backpressure during initial replay closes transport and subscription fail-closed
  - [pass] P5C stream lifecycle writes zero runtime Event / Outbox rows (keepalive is non-durable)
  - [pass] P5C stream route does not shadow canonical Run, Events or Replay routes

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

## `LITE-12-014`  12-UI-Architecture.md · 22. Acceptance Expectations

**条款**：keyboard core flow and stable focus;

- 点名文件：`apps/web/src/lib/uiFoundation.test.ts`（passed，raw exit 0，计数 {"passed":15,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（15 条）：

  - [pass] UIF-01 both themes share semantic token names
  - [pass] UIF-02 color tokens are valid hex
  - [pass] UIF-03 body contrast meets 4.5:1 in both themes
  - [pass] UIF-04 contrast math
  - [pass] UIF-05 typography scale and stacks
  - [pass] UIF-06 spacing scale
  - [pass] UIF-07 radius tokens
  - [pass] UIF-08 four-column width guidance
  - [pass] UIF-09 adaptive layout modes
  - [pass] UIF-10 visible columns include canvas
  - [pass] UIF-11 canvas keeps its minimum width
  - [pass] UIF-12 reduced motion
  - [pass] UIF-13 accessibility rules
  - [pass] UIF-14 uiCssVariables flattens all semantic tokens
  - [pass] UIF-15 columnWidthPx follows guidance and visibility

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

- 点名文件：`apps/web/src/liteScopeBoundary.test.ts`（passed，raw exit 0，计数 {"passed":3,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（3 条）：

  - [pass] LITE-12-016 the UI ships only the Lite route surface
  - [pass] LITE-12-016 no web module implements a deferred product surface
  - [pass] LITE-12-016 the workspace shells expose no deferred product entry point

## `LITE-13-004`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：strict Event order, gap recovery, and deduplication;

- 点名文件：`apps/server/src/services/RuntimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":16,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（16 条）：

  - [pass] INSP-12 Run, Stage, Provider, Process and duration stay distinct
  - [pass] INSP-01 overview projects canonical run state
  - [pass] INSP-02 unknown run fails closed
  - [pass] INSP-03 invalid input fails closed
  - [pass] INSP-04 process PID is evidence-only
  - [pass] LITE-01-006 Run and Process records remain independently queryable
  - [pass] INSP-05 events are ordered and bounded
  - [pass] INSP-06 afterSequence cursor
  - [pass] INSP-07 inspect performs no writes
  - [pass] INSP-08 memory context projection
  - [pass] INSP-09 absent memory context is null
  - [pass] INSP-10 workspace isolation
  - [pass] INSP-11 stages are ordered
  - [pass] LITE-12-010 unknown or unavailable admission is projected as modifying
  - [pass] LITE-12-010 only complete verified enforcement is presented as read-only
  - [pass] LITE-13-102 Inspector projects canonical operation identity and version for actions

## `LITE-13-005`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：bounded output without unbounded client state;

- 点名文件：`apps/server/src/routes/runtimeInspector.test.ts`（passed，raw exit 0，计数 {"passed":5,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（5 条）：

  - [pass] GET /runs/:runId/inspector names the effective mutation class and the read-only enforcement state
  - [pass] GET /runs/:runId/inspector returns the redacted projection for a canonical Run
  - [pass] GET /runs/:runId/inspector fails closed for an unknown Run and workspace
  - [pass] GET /runs/:runId/inspector surfaces the frozen Memory Context (MF-5 wiring)
  - [pass] GET /runs/:runId/inspector explains the compaction of the Conversation behind the Run

## `LITE-13-007`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：Git wording never implies ownership;

- 点名文件：`apps/server/src/routes/runtimeInspector.redaction.test.ts`（passed，raw exit 0，计数 {"passed":3,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（3 条）：

  - [pass] LITE-13-013 the Inspector projection exposes no secret material and a frozen key set
  - [pass] LITE-13-009 the Inspector is read-only and carries no process control field
  - [pass] LITE-13-007 the Inspector describes Git work as observation and offers no Git mutation

## `LITE-13-013`  13-Runtime-Inspector.md · 19. Acceptance Expectations

**条款**：no secrets in DTOs;

- 点名文件：`apps/server/src/routes/runtimeInspector.redaction.test.ts`（passed，raw exit 0，计数 {"passed":3,"failed":0,"skipped":0}）
- 该文件实际执行过的断言（3 条）：

  - [pass] LITE-13-013 the Inspector projection exposes no secret material and a frozen key set
  - [pass] LITE-13-009 the Inspector is read-only and carries no process control field
  - [pass] LITE-13-007 the Inspector describes Git work as observation and offers no Git mutation

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

