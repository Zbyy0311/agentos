# AgentOS M4 Process & Provider Runtime — Implementation Plan

Status: P0 CONTRACT CLOSURE COMPLETE — PENDING INDEPENDENT P0 REVIEW — IMPLEMENTATION REQUIRES PHASE-BY-PHASE AUTHORIZATION

## 1. Baseline

```text
Authoritative main:
af3c684a0585d654d785ace9666620ee46f37728

Source:
PR #43 merge commit

M3 formal closeout:
COMPLETE

M3 post-merge main CI:
31594803731 PASS

Migration registry:
001–013

Migration 014:
NOT CREATED / NOT AUTHORIZED

PR #45:
OPEN / DRAFT / FROZEN / OUTSIDE M4
```

Any implementation authorization must name its exact base. This plan does not
silently transfer authorization if `main` moves.

## 2. M4 objective

Establish one durable, provider-agnostic execution authority that separates
Run lifecycle, Provider semantics and OS Process ownership; prove it end-to-end
with one directly invoked Provider (KimiCode) while preserving M3 lifecycle,
event, idempotency, recovery uncertainty and compatibility contracts.

The plan is deliberately sequential. It does not implement all Providers before
the Process Runtime is proven. KimiCode is the first delivery slice, not the
definition of the complete M4 milestone. After the Core/Kimi gate, the remaining
authoritative Roadmap M4 deliverables must be implemented and accepted, or
formally removed/deferred through an authorized scope/spec reconciliation,
before final M4 closeout.

## 3. Frozen invariants

1. **E01:** Run/RunEngine does not directly spawn Provider subprocesses.
2. **E02:** Provider Adapter cannot bypass Process Runtime.
3. **E03:** AgentOS Process ID is not OS PID.
4. **E04:** Cancel covers the complete owned Process Tree and reports survivors.
5. **E05:** raw stdout/stderr is traceable through restricted artifacts/refs.
6. **E06:** selected Provider vertical slice works end-to-end.
7. **E07:** auth failure maps to stable `PROVIDER_AUTH_REQUIRED` semantics.
8. **E08:** browser/SSE/HTTP disconnect does not terminate Process/Run.
9. **E09:** restart has an explicit no-guess Process recovery contract.
10. **E10:** M3 Run/Stage lifecycle, Event/Outbox ordering, replay,
    idempotency, Operation and `recovery_required` semantics do not regress.
11. Only existing M3 lifecycle transaction seams may mutate canonical Run/Stage.
12. Process Runtime handles bytes/process facts; Provider Adapter handles
    Provider semantics; neither declares Run success alone.
13. Provider Configuration is data; Adapter is code; Agent, Run, Stage,
    Execution attempt, Provider Session and Process identities remain distinct.
14. Secret values never enter ordinary config, snapshot, Event or log.
15. Replay and reconnect never re-execute a Provider.
16. No phase automatically authorizes the next phase.
17. `KIMI VERTICAL SLICE COMPLETE != M4 MILESTONE COMPLETE`.
18. Every deliverable in Roadmap §§55/59 remains required for M4 final closeout
    unless an authorized scope/spec reconciliation explicitly changes it.

## 4. Scope

Included in the proposed M4 sequence:

- Process Manager/Repository/identity/handle/platform contracts;
- provider process launch, tree ownership, cancellation and timeouts;
- bounded output observation and restricted raw output artifacts;
- Process facts integrated into canonical M3 Runtime Events;
- Provider Registry/Adapter/Validation/error contracts;
- KimiCode Direct initial vertical slice;
- RunEngine/Stage execution seam and exactly-one authority;
- transport independence for existing execution surfaces;
- minimum M4 restart classification using M3 recovery uncertainty;
- compatibility and Core/Kimi integrated verification;
- Codex as the separately authorized second-provider genericity proof;
- OpenCode adapter and Custom CLI Foundation after the second-provider gate;
- Provider Session API, Process Inspector API and Recovery Record completion;
- final Roadmap deliverable reconciliation and full M4 integrated closeout.

The following are sequenced after the initial Kimi gate and remain separately
authorized phases within current M4 closure scope:

- Codex adapter as the second proof of the generic seam;
- OpenCode adapter and Custom CLI Foundation;
- Provider Session API, Process Inspector API and Recovery Record breadth.

They are not pulled into P1/P3/P4. If evidence cannot support one safely, the
relevant later phase stops with `M4 FINAL CLOSEOUT BLOCKED ON ROADMAP DELIVERABLE
DISPOSITION`; it does not silently defer the deliverable.

Deferred outside M4 Provider breadth:

- migration of unrelated Git/tar/worktree/system subprocesses through the
  generic Process Runtime under their owning M5 packages.

## 5. Non-goals

- this preplanning task's M4 production implementation;
- Migration 014 creation or any schema mutation without separate authorization;
- M5 Worktree/Artifact implementation or semantics change;
- M6 Policy/Approval expansion;
- M7 Recovery Hardening beyond minimum M4 Process identity/classification;
- generalized native Provider resume/reattach/orphan cleanup;
- Memory, Conversation redesign, Group collaboration, UI redesign;
- Runtime Inspector UI implementation;
- Tauri/Desktop hosting;
- Production Cutover, Legacy retirement or Web default switch;
- PR #45 modification, merge or close;
- Ready or merge of any implementation PR.

## 6. Dependency graph

```text
M4-P0 contract/current-state closure
  -> M4-P1 Process Runtime foundation
  -> M4-P2 durable Process identity + raw output + Process facts
  -> M4-P3 Provider Registry/Validation + Kimi adapter contract
  -> M4-P4 RunEngine integration + Kimi vertical slice
  -> M4-P5 cancel/tree/timeout + transport independence
  -> M4-P6 minimum restart/recovery semantics
  -> M4-P7 Core Process + Kimi integrated verification gate
  -> M4-P8 Codex second-provider genericity proof
  -> M4-P9 OpenCode + Custom CLI Foundation
  -> M4-P10 Provider/Process API + Recovery Record breadth
  -> M4-P11 final Roadmap reconciliation + M4 integrated closeout

Outside this chain:
  M5-owned Git/Worktree/Artifact process migration; M7 generalized hardening
```

P2 is conditional on a separately reviewed and authorized schema package. If
no schema authorization exists, the implementation sequence stops; it does not
substitute old Conversation tables or in-memory state.

Every arrow is a dependency only. P7 does not authorize P8; P8 does not
authorize P9; P9 does not authorize P10; P10 does not authorize P11. Each phase
requires its own explicit entry authorization and independent review.

## 7. Phase decomposition

The proposed M4 sequence contains 12 bounded phases (`P0`–`P11`). P7 is the
Core/Kimi verification gate; P11 is the only proposed final M4 closeout gate.

### M4-P0 — Contract and current-state closure

**Goal:** freeze the smallest implementable architecture and evidence gates
without production code or schema mutation.

**Dependencies:** accepted preplanning package and exact authorized base.

**Included:** single authority chain; process/provider/session identity glossary;
Process/Adapter/driver/event/artifact ports; current direct-spawn allowlist;
`kimi`/`kimicode` reconciliation; error taxonomy; Windows fallback contract;
raw-output security and limits; minimal schema proposal; test fixtures and
phase file ownership; authoritative Roadmap §§55/59 deliverable matrix and the
final-scope rule separating Kimi/Core verification from M4 completion.

**Excluded:** implementation, SQL, migration file/number, Provider login,
cutover, Legacy deletion.

**Allowed files/packages:** separately authorized planning/ADR/schema-design
documents only. No existing Runtime Specification change unless independently
authorized for spec reconciliation.

**Forbidden scope:** all production/test/workflow/schema changes.

**Contract changes:** planning contracts only; explicitly freeze:
`ProcessManager`, `ProcessRepository`, `PlatformProcessDriver`,
`ProviderProcessPort`, `RuntimeProviderAdapter`, Process event drafts and stable
error codes.

**Schema impact:** proposal only. P0 verdict is
`SCHEMA_PROPOSAL_REQUIRES_FUTURE_MIGRATION`; `OD-M4-01` is UNDECIDED and blocks
P2 schema creation, not P1. Migration 014 stays absent and unallocated.

**Tests:** design mock Process scenarios; platform tree fixtures; Provider
auth/parse fixtures; architecture-negative searches; M3 regression set.

**Acceptance criteria:** all identities/ownership boundaries unambiguous; every
E01–E10 gate maps to a test; no unresolved BLOCKER/HIGH; schema proposal has a
separate authorization route; exactly one initial Kimi slice; every Roadmap
deliverable is mapped to a later accepted gate or formal reconciliation path;
P7 cannot establish `M4 COMPLETE`.

**Stop conditions:** base drift; inability to define one execution authority;
schema assumptions without evidence; Windows tree contract has no testable
fallback; spec conflict changes product semantics; a Roadmap deliverable is
silently omitted/deferred or Kimi/Core is treated as final M4 closeout.

**Rollback boundary:** revert P0 docs only.

**Independent review gate:** architecture + M3 contract + security/schema
review. Review approval closes P0 only.

**Next phase authorization:** explicit M4-P1 entry decision required.

### M4-P1 — Process Runtime foundation

**Goal:** implement a provider-agnostic, schema-light Process Manager over mock
and platform driver contracts, initially wrapping the existing provider launch
mechanics without changing canonical Run execution.

**Dependencies:** P0 accepted; explicit P1 authorization.

**Included:** launch request validation; AgentOS Process ID allocation in domain
object; executable/args/cwd/safe env contract; shell false; managed handle;
stdout/stderr byte channels; activity; startup/idle/total timers; idempotent stop;
platform capability interface; compensating spawn failure; mock driver.

**Excluded:** durable schema/repository, canonical Run wiring, real Kimi cutover,
Provider parser semantics, Legacy route behavior change, complete platform tree
implementation.

**Allowed files/packages:** new Process Runtime package or the P0-approved
minimal package boundary; package-local tests; narrowly scoped exports/root
workspace changes owned only by this phase.

**Forbidden scope:** RunEngine/TaskRunService/routes/AgentRunner migration,
schema/migrations, Provider-specific branching in Process Runtime.

**Contract changes:** introduce Process domain/ports and stable process errors;
no M3 Run/Event contract mutation.

**Schema impact:** none.

**Tests:** executable exists/missing; spawn error; exit 0/non-zero/signal;
stdout/stderr UTF-8 splits; startup/idle/total timeout; cancel idempotency; timer
races; argument/env redaction; shell disabled; mock child tree.

**Acceptance criteria:** Process Manager is the only new generic spawn API;
Process ID differs from PID; no Provider semantics; tests deterministic without
rerun-until-green; old production path unchanged.

**Stop conditions:** Process API requires Run state mutation; platform contract
cannot represent tree/survivor result; unbounded buffers; secret exposure.

**Rollback boundary:** remove new package/exports; old execution path remains.

**Independent review gate:** Process API, security, timer/concurrency and
cross-platform review.

**Next phase authorization:** explicit P2 entry plus schema authorization if
durable persistence is approved.

### M4-P2 — Durable Process identity, persistence, output and Process facts

**Goal:** make Process ownership, raw output and terminal facts durable and
queryable without redefining Run success.

**Dependencies:** P1 accepted; separate schema design accepted; migration
creation explicitly authorized. If not authorized, STOP.

**Included:** minimal Process persistence/repository; CAS state transitions;
Run/Stage/optional Provider Session references; PID/start/executable/recovery
identity; started/activity/exited/exit/signal/termination fields; restricted
append-oriented stdout/stderr artifacts and references; Process events through
the canonical M3 Event Store/Outbox; startup compensation.

**Excluded:** generalized Provider Session history unless the authorized schema
requires the minimal binding; Process Inspector UI/API breadth; retention
product policy; M7 reattach/orphan cleanup; Provider semantics.

**Allowed files/packages:** Process package, authorized migration and registry,
Process repository in storage boundary, shared Process event/types, artifact
sink integration and package-local tests. Migration registry is owned only by
this phase if authorized.

**Forbidden scope:** unrelated tables, old aggregate retirement, migration
renumbering, Runtime Specification edits, Run lifecycle changes.

**Contract changes:** add Process fact/event contracts and references without
changing existing M3 event envelope/order.

**Schema impact:** exact P0 three-resource proposal; `OD-M4-01` plus separate P2
entry/schema authorization required. No plan statement approves, reserves or
allocates Migration 014.

**Tests:** fresh and 001–013 upgrade DB; checksum/registry; repository identity
and CAS races; spawn reservation compensation; output append/range/offset;
UTF-8/redaction/classification/backpressure; Event/Outbox 1:1; PID reuse
identity mismatch; terminal transition races.

**Acceptance criteria:** no active Process exists without durable AgentOS ID;
OS PID never serves as ID; raw streams are traceable and bounded; Process facts
persist before broadcast; existing M3 tests remain green.

**Stop conditions:** schema authorization missing; output writes can leak
secrets; Process terminal fact changes Run directly; old Conversation table is
repurposed; migration recovery/upgrade evidence fails.

**Rollback boundary:** forward code revert while preserving already written
process/event/artifact evidence; database downgrade/restore is not implied.

**Independent review gate:** schema/data/security/event/recovery review.

**Next phase authorization:** explicit P3 entry required.

### M4-P3 — Provider Registry, Validation and Kimi adapter contract

**Goal:** create the provider protocol boundary and prove Kimi can build,
validate, parse and normalize without spawning outside Process Runtime.

**Dependencies:** P1 accepted; P2 Process/event ports available when needed;
explicit P3 authorization.

**Included:** versioned Provider Registry/manifest; configuration-to-adapter
matching; explicit `kimicode` boundary mapping; discovery and side-effect-light
validation; executable/version/auth/capability/output checks; validation API and
stable errors; Process port; Kimi launch plan/parser/finalize/cancel request;
fake/golden Kimi fixtures.

**Excluded:** real Run integration, Codex/OpenCode adapters, interactive login
UX, raw secret persistence, native resume, Process tree implementation.

**Allowed files/packages:** Provider core/registry, Kimi adapter, provider config
application/API seam, shared Provider DTO/errors, package/API tests. Any
`packages/agent-core` edits must be adapter extraction only and phase-owned.

**Forbidden scope:** Run lifecycle mutations in Adapter; `child_process` import
in Adapter; arbitrary route shell; OpenCode speculation; silent plain fallback
for a configured Kimi vertical slice.

**Contract changes:** stable validation response/error mapping including
`PROVIDER_NOT_FOUND`, `PROVIDER_CONFIG_INVALID`, `PROVIDER_AUTH_REQUIRED`,
`PROVIDER_VERSION_UNSUPPORTED`, `PROVIDER_VALIDATION_FAILED`, and
`PROVIDER_ADAPTER_NOT_FOUND`.

**Schema impact:** reuse Provider Configuration. Persisted validation/session
records require separate schema authorization; an in-memory bounded cache may
be used only if the frozen contract permits it and never as recovery truth.

**Tests:** adapter duplicate/lookup/type/version; invalid config; disabled/
archived config; executable found/missing; Kimi version/help structured mode;
auth authenticated/required/expired/unknown; command/args/env construction;
secret refs; parser golden/malformed/unknown/usage; redaction; stable API status.

**Acceptance criteria:** Kimi launch plan invokes Kimi directly; Adapter never
spawns or mutates Run; validation is side-effect-light; auth mapping is stable;
configuration snapshot and launch plan preserve identity/version.

**Stop conditions:** Kimi protocol cannot be proven from real/fake evidence;
adapter needs raw global secrets; command inference overrides configured
identity; auth errors expose stderr; Registry permits unversioned replacement.

**Rollback boundary:** remove new Registry/Kimi seams and validation endpoint;
preserve Provider Configuration data.

**Independent review gate:** Provider contract, identity, security and API
review.

**Next phase authorization:** explicit P4 entry required.

### M4-P4 — RunEngine integration and KimiCode Direct vertical slice

**Goal:** connect one accepted canonical Run/Stage attempt to exactly one Kimi
Provider Session/Process through the new authority chain.

**Dependencies:** P1–P3 accepted; explicit P4 authorization; required durable
Process model available.

**Included:** Stage execution coordinator/authority lease; snapshot-to-Provider
resolution; RunEngine async/background dispatch seam; Kimi Session/Process
start; normalized output to M3 Runtime Event; Provider finalization to existing
LifecycleTransactionService; Legacy route initiation/projection through the
same authority where in-scope; idempotent replay/no-double-start proof.

**Excluded:** Codex/OpenCode, active cancel/tree hardening (P5), native resume,
Legacy retirement, Web switch, all-provider pipeline cutover.

**Allowed files/packages:** RunEngine/StageExecutor integration, one scheduler or
background execution service approved by P0, server bootstrap, Process/Provider
ports, Kimi adapter, Lifecycle seam call sites, narrowly scoped compatibility
adapter and tests.

**Forbidden scope:** second Run state machine; route-owned spawn; Adapter direct
DB lifecycle update; AgentRunner and new coordinator both executing one Stage;
idempotency replay dispatch.

**Contract changes:** StageExecutor changes from synchronous placeholder result
to the P0-approved background contract while preserving M3 transition/event
ownership and atomicity.

**Schema impact:** no unapproved additions beyond P2.

**Tests:** Run Start accepted -> one authority claim -> one Process record ->
Kimi starts only through Process Runtime; output -> canonical Event/Outbox;
terminal Process -> Provider finalize -> correct Stage/Run transition; auth/
spawn/non-zero/finalize failures; duplicate ticks/replay/concurrency -> one
Process; Legacy projection parity.

**Acceptance criteria:** E01/E02/E03/E05/E06/E07/E10 pass; current-machine and
deterministic fake-Kimi gates pass; no direct Provider spawn remains in the new
chain; M3 full related regression passes.

**Stop conditions:** duplicate Process under concurrent dispatch; direct
AgentRunner fallback after claim; Adapter changes lifecycle; raw output becomes
Event truth; M3 idempotency/sequence changes.

**Rollback boundary:** disable/revert the additive new dispatch seam and retain
durable evidence; no production default switch is part of this phase.

**Independent review gate:** execution authority, M3 lifecycle/event,
Provider/Process separation and Kimi E2E review.

**Next phase authorization:** explicit P5 entry required.

### M4-P5 — Cancellation, Process Tree, timeout and transport independence

**Goal:** make active Run cancellation reliable across the owned tree and remove
HTTP/SSE ownership of execution.

**Dependencies:** P4 accepted; platform driver evidence; explicit P5
authorization.

**Included:** Run/Operation/Execution/Process cancel coordination; Provider
graceful stop; grace deadline; Job Object/process-group/fallback force tree
termination; survivor verification; startup/idle/total timeout terminal reasons;
approval-wait idle suspension only where M3 state proves it; initial Conversation
disconnect decoupling; explicit cancel API remains termination command.

**Excluded:** pause/resume product expansion, destructive orphan cleanup,
generalized M7 recovery, Legacy removal.

**Allowed files/packages:** Process platform drivers, cancel coordinator,
existing Run/Operation command application seam, Conversation/Legacy transport
cleanup only, tests/fixtures. Each shared core file has one phase owner.

**Forbidden scope:** `res.close -> abort Process`; killing only parent PID and
declaring success; force cancel without policy seam where required; terminal
state race outside LifecycleTransactionService.

**Contract changes:** active cancel command/result, process stopping/exited/
cleanup facts, stable timeout/cancel errors. M3 status vocabulary remains.

**Schema impact:** use P2 fields only; no new migration unless separately
authorized.

**Tests:** repeated cancel; cancel before/while spawn; exit-vs-cancel and
timeout-vs-exit races; Kimi child/grandchild; Windows `.exe`/`.cmd`, path with
spaces/Unicode, Job Object/fallback; POSIX group TERM/KILL; survivor failure;
idle activity; no-output timeout; browser socket close Process continues;
explicit cancel terminates tree.

**Acceptance criteria:** E04/E08 pass; no owned survivors after successful
cancel; survivor list is non-empty on cleanup failure; transport disconnect
does not mutate Run/Operation/Process; cancel idempotency and M3 events pass.

**Stop conditions:** driver cannot prove tree ownership; cancellation can mark
Run terminal before tree result is known; transport and explicit cancel remain
conflated; timing tests are flaky or accepted by rerun.

**Rollback boundary:** revert cancel/transport routing while preserving Process
facts; compatibility surfaces remain.

**Independent review gate:** Windows/POSIX platform, lifecycle race, transport
and security review.

**Next phase authorization:** explicit P6 entry required.

### M4-P6 — Minimum restart and recovery semantics

**Goal:** add safe Process evidence to existing M3 recovery without expanding
into generalized recovery hardening.

**Dependencies:** P2/P4/P5 accepted; explicit P6 authorization.

**Included:** shutdown mode recording as technically necessary; startup scan of
active Process records; same/missing/unknown identity classification; evidence
fold into M3 recovery; externally-running classification if and only if proven;
no guessed success; no automatic second Provider start; stable recovery events.

**Excluded:** generalized stream reattach, Provider-native resume by default,
automatic orphan destruction, Worktree/projection/artifact/lock recovery,
Recovery Inspector, chaos across all Providers (M7).

**Allowed files/packages:** Process recovery classifier/repository, existing
`TaskRunRecoveryService` evidence seam, server startup/shutdown ordering,
recovery tests. Conversation old recovery changes only if required for safe
compatibility and independently reviewed.

**Forbidden scope:** marking completed from PID/exit alone; retrying/resuming
Provider silently; changing terminal Runs; creating a second Start Operation;
using provider files as unverified truth.

**Contract changes:** M4 Process recovery evidence and stable classification;
retain `runs.recovery_required` as M3 Run uncertainty representation.

**Schema impact:** use authorized P2 recovery fields; no new Recovery Record or
migration without separate authorization.

**Tests:** crash/restart while reserved/starting/running/stopping; same PID wrong
start/executable/token; missing process; unknown platform capability; process
alive but no safe reattach; Process record without Run; Run without Process;
repeated recovery; atomic Event/Outbox; no second execution; no guessed success.

**Acceptance criteria:** E09/E10 pass; every active Process/Run receives an
explicit evidence-based classification; unknown remains `recovery_required` or
stable fail-closed outcome; recovery is idempotent.

**Stop conditions:** recovery requires generalized M7 behavior; identity proof
is PID-only; provider-native resume is assumed; uncertainty is converted to
completed; current M3 recovery matrix regresses.

**Rollback boundary:** revert Process evidence integration while preserving
stored Process/Run/Event facts and M3 uncertainty.

**Independent review gate:** recovery/no-guess/M3 contract review.

**Next phase authorization:** explicit P7 verification entry required.

### M4-P7 — Core Process + Kimi integrated verification gate

**Goal:** prove the Core Process Runtime and Kimi vertical slice against E01–E10
on one immutable head, record the remaining Roadmap work, and stop without
claiming final M4 closeout.

**Dependencies:** P1–P6 individually accepted; explicit P7 authorization.

**Included:** full Process/Provider/M3/schema/API/platform/compatibility tests;
current Kimi real gate; deterministic failure and mutation/negative evidence;
direct-spawn inventory re-audit; independent review/remediation; docs-only
Core/Kimi verification package; Roadmap deliverable matrix refresh.

**Excluded:** new behavior, Codex/OpenCode/Custom CLI and remaining API breadth,
final M4 closeout, production cutover, Ready/merge, Legacy retirement.

**Allowed files/packages:** tests/fixtures and verification docs expressly owned by
P7; production edits only as separately approved remediation, never hidden in
verification.

**Forbidden scope:** test weakening, retries until green, undocumented skip,
new migration, Provider expansion, default switch.

**Contract changes:** none unless a finding triggers STOP and re-entry review.

**Schema impact:** verify registry/checksum/fresh/upgrade only.

**Tests:** complete matrix in section 16 plus full M3 regression/build and
Windows real platform gate.

**Acceptance criteria:** E01–E10 PASS; BLOCKER/HIGH zero; working tree and
evidence reproducible; remaining direct subprocesses explicitly classified;
Process Core and Kimi vertical slice pass; every Roadmap M4 deliverable has an
explicit pending/accepted/reconciliation disposition; no unauthorized scope;
the evidence statuses are exactly `PROCESS CORE VERIFIED` and
`KIMI VERTICAL SLICE VERIFIED`, never `M4 COMPLETE`.

**Stop conditions:** any flaky/unreproducible gate; survivor; double execution;
raw secret; guessed recovery; M3 regression; unreviewed schema drift.

**Rollback boundary:** verification changes/docs only; implementation rollback
follows each prior phase boundary and preserves durable evidence.

**Independent review gate:** Core/Kimi cross-domain review. Acceptance verifies
only the Core Process Runtime and Kimi slice; it cannot close M4 or authorize
Codex, OpenCode, Custom CLI, cutover, Ready or merge.

**Next phase authorization:** explicit P8 authorization is required for the
Codex proof. P7 acceptance does not authorize P8, P9, P10, P11, M5, M7,
cutover, Ready or merge.

### M4-P8 — Codex second-provider genericity proof

**Goal:** prove that the accepted Process/Provider seam is generic by integrating
Codex without Provider-specific leakage into Process Runtime or Run lifecycle.

**Dependencies:** P7 accepted; Codex executable/protocol evidence revalidated;
explicit P8 authorization.

**Included:** dedicated Codex adapter contract; Provider Configuration and auth
validation; command/environment/output/finalize/error mapping; canonical Run
integration through the same authority; deterministic fixtures plus authorized
real gate; parity and non-regression evidence.

**Excluded:** OpenCode, Custom CLI product breadth, Provider Session/Inspector
API completion, production cutover, Legacy retirement.

**Allowed files/packages:** Provider core/registry, Codex adapter and fixtures,
existing Process port and narrowly scoped integration/tests. Shared Process and
M3 contracts are consumers, not redefinition targets.

**Forbidden scope:** second spawn path; Codex branching inside ProcessManager;
Adapter lifecycle mutation; importing OpenCode into this proof; weakening Kimi.

**Contract changes:** add Codex manifest/adapter/error normalization under the
already accepted Provider contract; no Process or M3 lifecycle semantic change.

**Schema impact:** reuse separately authorized Provider/Process schema; any new
field or migration requires its own authorization.

**Tests:** registry selection; Codex config/home/auth/version; launch plan;
structured output and malformed/error fixtures; direct-spawn negative search;
same Run/Process/Event/cancel/disconnect/recovery contracts as Kimi; Kimi/M3
regression; deterministic and separately authorized real gate.

**Acceptance criteria:** Codex runs through the identical Process port and
authority chain; Provider-specific behavior remains in Adapter; Kimi and E01–E10
stay green; second-provider genericity is independently accepted.

**Stop conditions:** Codex requires a parallel execution path; Process API must
be Provider-specific; auth/output protocol is not evidence-backed; shared-core
changes would regress Kimi or M3.

**Rollback boundary:** remove Codex registration/integration while preserving
Core/Kimi and durable facts; no schema rollback is implied.

**Independent review gate:** genericity, Provider identity/auth, Process
separation and Kimi/M3 regression review.

**Next phase authorization:** explicit P9 authorization required. P8 does not
authorize OpenCode, P10/P11, cutover, Ready or merge.

### M4-P9 — OpenCode adapter + Custom CLI Foundation

**Goal:** complete the remaining Roadmap Provider breadth without guessing
OpenCode protocol semantics or creating an unrestricted shell surface.

**Dependencies:** P8 accepted; OpenCode executable/version/protocol/auth evidence
captured; Custom CLI Foundation contract frozen; explicit P9 authorization.

**Included:** dedicated OpenCode adapter/manifest/validation/output/error path;
same Process port and Run authority; deterministic protocol fixtures and an
authorized real gate when available; bounded Custom CLI Foundation with explicit
identity/config/allowlist/output/error contracts and no silent fallback.

**Excluded:** speculative OpenCode parsing, arbitrary shell, provider-native
resume expansion, unrelated Git/tar/worktree subprocesses, product cutover.

**Allowed files/packages:** Provider registry/adapters/config/validation,
OpenCode/Custom CLI fixtures, narrow shared Provider DTO/API/tests. Process/M3
core changes require stop and separately authorized re-entry.

**Forbidden scope:** treating model discovery as an adapter; plain-output
fallback as successful OpenCode support; raw command injection; direct spawn;
moving the deliverables out of M4 without authorized scope/spec reconciliation.

**Contract changes:** add evidence-backed OpenCode and bounded Custom CLI
manifests/adapters under the accepted Provider contract.

**Schema impact:** no unapproved schema expansion; reuse authorized Provider
Configuration/Session/Process references.

**Tests:** executable missing/present/version; validation/auth/config; command/
env construction; protocol golden/malformed/error fixtures; Custom CLI allowlist
and shell-injection negative tests; Process tree/output/cancel/disconnect; all
Kimi/Codex/M3 regressions.

**Acceptance criteria:** OpenCode and Custom CLI Foundation satisfy Roadmap
contracts through Process Runtime; no speculative success or arbitrary shell;
all prior providers and E01–E10 remain green.

**Stop conditions:** no stable OpenCode evidence; safe Custom CLI boundary cannot
be frozen; direct spawn/silent fallback appears. Stop with
`M4 FINAL CLOSEOUT BLOCKED ON ROADMAP DELIVERABLE DISPOSITION` unless a separate
authorized scope/spec reconciliation changes Roadmap scope.

**Rollback boundary:** remove OpenCode/Custom registrations while retaining
accepted Core/Kimi/Codex and evidence; no hidden scope deferral.

**Independent review gate:** OpenCode evidence, Custom CLI security, adapter
genericity and full Provider regression review.

**Next phase authorization:** explicit P10 authorization required. P9 does not
authorize API breadth, P11, cutover, Ready or merge.

### M4-P10 — Provider/Process API + Recovery Record breadth

**Goal:** close the remaining Roadmap API and recovery-record deliverables over
accepted Process/Provider facts without expanding into UI or M7 hardening.

**Dependencies:** P7–P9 accepted under the preserved Roadmap, or any omitted
item has an authorized scope/spec reconciliation; API/security/schema contracts
and exact authorization frozen; explicit P10 authorization.

**Included:** Provider Session API; Process Inspector API as a bounded backend
inspection contract (not UI); Recovery Record representation/API evidence;
authorization/redaction/pagination/state/error contracts; all deliverable tests.

**Excluded:** Runtime Inspector UI, generalized reattach/resume/orphan cleanup,
M7 chaos hardening, schema creation without separate authorization, cutover.

**Allowed files/packages:** existing API/application/repository/shared DTO
boundaries and tests; schema only under independent explicit authorization.

**Forbidden scope:** raw secret/output exposure; API lifecycle mutation;
recovery guessing success; relabeling M7 behavior as M4; silent deliverable
deferral.

**Contract changes:** stable read/command API surfaces for Provider Session,
Process inspection and M4 Recovery Record over canonical durable facts.

**Schema impact:** CANDIDATE ONLY until separately designed and authorized; no
migration number is allocated by this plan.

**Tests:** authz/redaction; missing/invalid IDs; pagination/order; Process/
Session/Run identity separation; raw output references; recovery same/missing/
unknown and no-guess semantics; API/OpenAPI contract if present; full regression.

**Acceptance criteria:** all three Roadmap API/record deliverables are implemented
and independently accepted without UI/M7 expansion; durable facts remain the
truth; E01–E10 and provider regressions pass.

**Stop conditions:** API requires unapproved schema; exposes restricted data;
mutates lifecycle outside M3 seams; Recovery Record implies guessed success or
generalized M7 behavior.

**Rollback boundary:** revert additive API surfaces while retaining durable
Process/Session/Recovery facts; no destructive migration rollback.

**Independent review gate:** API, authorization/security, schema, recovery and
M3 contract review.

**Next phase authorization:** explicit P11 authorization required. P10 does not
authorize final closeout, cutover, Ready or merge.

### M4-P11 — Final Roadmap reconciliation + M4 integrated closeout

**Goal:** prove every authoritative M4 scope item/deliverable is accepted or has
been formally removed/deferred through an authorized scope/spec reconciliation,
then and only then establish final M4 milestone status on one immutable head.

**Dependencies:** P7 Core/Kimi gate accepted; P8–P10 work accepted for every
non-deferred deliverable; any omitted item carries prior authorized scope/spec
reconciliation; every Roadmap matrix row resolved; explicit P11 authorization.

**Included:** full E01–E10 and M3/provider/process/platform/API/recovery regression;
Roadmap §§55/59 reconciliation matrix; exact immutable-head evidence; direct-
spawn and unauthorized-scope audit; independent remediation and closeout record.

**Excluded:** new implementation hidden inside verification, M5/M7 expansion,
cutover, Ready/merge, Legacy retirement.

**Allowed files/packages:** verification tests/evidence/closeout docs; production
remediation requires STOP and a separately authorized implementation phase.

**Forbidden scope:** accepting unresolved Roadmap contradiction; treating Kimi,
Core or second-provider pass as M4 completion; undocumented deferral; flaky-pass
acceptance; migration/cutover authorization.

**Contract changes:** none. Any required change returns to a separately
authorized implementation/spec reconciliation phase.

**Schema impact:** verification only; Migration 014 remains absent unless a
separate future authorization changed repository state before this gate.

**Tests:** complete section 16 matrix across Kimi/Codex/OpenCode/Custom CLI and
all APIs; E01–E10; Windows/POSIX; M3; migration/schema integrity if authorized;
architecture/mutation/negative checks; reproducibility on exact head.

**Acceptance criteria:** section 21 final DoD passes; each matrix row is
`REQUIRED_BEFORE_M4_CLOSEOUT` and accepted, or carries recorded evidence of an
authorized `FORMALLY_DEFERRED_PENDING_SPEC_RECONCILIATION` decision; no unresolved
Roadmap contradiction; BLOCKER/HIGH zero; immutable-head evidence complete.

**Stop conditions:** any deliverable unresolved; reconciliation lacks authority;
test/evidence drift; direct spawn/survivor/secret/guessed recovery/M3 regression;
working head differs from reviewed head.

**Rollback boundary:** closeout/evidence changes only; failed gate leaves M4
open and returns findings to a separately authorized phase.

**Independent review gate:** final cross-domain, Roadmap-scope and immutable-head
review by reviewers independent from implementation owners.

**Next phase authorization:** P11 acceptance may establish `M4 COMPLETE` only;
it does not authorize M5, M7, production cutover, Ready, merge or Legacy
retirement. Those remain separate decisions.

## 8. Provider vertical-slice strategy

### Initial slice: KimiCode Direct

Evidence:

- Roadmap recommends KimiCode Direct first
  (`docs/Runtime-Specification/14-Roadmap.md:3630-3644`).
- current main registers a dedicated `KimiAdapter`, probes structured output,
  has a golden fixture/parser/CLIExecutor integration tests, and does not route
  Kimi through OpenCode (`packages/agent-core/src/adapters/kimiAdapter.ts`,
  `registry.ts:28-37`, `executor.test.ts:229-257`).
- current machine resolves KimiCode `0.23.5`; historical real Kimi Gate passed.

The installed version/path is current-machine supporting audit evidence only,
not a durable release contract. Future acceptance requires the separately
authorized real gate plus deterministic Provider fixtures.

The first slice must prove:

```text
accepted canonical Run/Stage
  -> one authority
  -> KimiCodeProviderAdapter
  -> ProviderProcessPort
  -> ProcessManager
  -> direct kimi.exe process tree
  -> raw output + normalized events
  -> Provider finalize
  -> existing M3 lifecycle transaction
```

### Additional adapters

- **Codex:** P8 is the separately authorized second-provider proof after the
  Core/Kimi gate. Current dedicated adapter and historical real evidence reduce
  risk, but Codex must not share P1/P3/P4.
- **OpenCode:** P9 remains in M4 final closure scope, but cannot enter the first
  slice. Current main lacks a dedicated registered adapter and the current
  machine lacks the executable; model discovery/usage delta are not an Adapter
  contract. If stable evidence is unavailable, M4 final closeout is blocked
  pending an authorized deliverable disposition.
- **Custom CLI:** P9 owns the bounded Foundation required by Roadmap §55. It is
  not a broad product shell and cannot use silent fallback.

### Roadmap M4 Deliverable Reconciliation Matrix

The matrix preserves both authoritative Roadmap truths: Kimi is first
(`14-Roadmap.md:3630-3688`), while every M4 scope/deliverable remains a final
closeout obligation (`14-Roadmap.md:1165-1249`). `Deferred? = No` means sequenced
later, not pulled into the initial slice. Any future deferral requires the exact
authority shown by `FORMALLY_DEFERRED_PENDING_SPEC_RECONCILIATION`; none is
claimed by this preplanning package.

| Roadmap Deliverable | Current Status | Initial Kimi Slice Required | Required Before M4 Final Closeout | Proposed Phase | Deferred? | Deferral Authority | Evidence / Reason |
|---|---|---|---|---|---|---|---|
| ProcessManager | MISSING | Yes, foundation | REQUIRED_BEFORE_M4_CLOSEOUT | P1/P5 | No | N/A — no deferral | covers Process Runtime scope and §59 deliverable; current spawn authority is `CLIExecutor` |
| Process Identity | MISSING | Yes, durable binding | REQUIRED_BEFORE_M4_CLOSEOUT | P1/P2 | No | N/A — no deferral | only transient OS PID exists; AgentOS Process identity is absent |
| ProcessRepository | MISSING | Yes, durable binding | REQUIRED_BEFORE_M4_CLOSEOUT | P2 | No | N/A — no deferral | no current Process repository/table; separate schema authorization remains required |
| ProcessEventNormalizer | MISSING | Yes, Process facts | REQUIRED_BEFORE_M4_CLOSEOUT | P2 | No | N/A — no deferral | M3 registry lacks Process fact normalization/events |
| Process Tree | MISSING | Yes, cancellation gate | REQUIRED_BEFORE_M4_CLOSEOUT | P1/P5 | No | N/A — no deferral | current execution owns/kills one child, not the complete tree |
| stdout / stderr | PARTIAL | Yes | REQUIRED_BEFORE_M4_CLOSEOUT | P1/P2 | No | N/A — no deferral | `CLIExecutor` observes text, but no Process-owned durable byte/output contract exists |
| Bounded Buffer | MISSING | Yes | REQUIRED_BEFORE_M4_CLOSEOUT | P1/P2 | No | N/A — no deferral | current stdout/stderr strings are unbounded |
| Raw Output Artifact | MISSING | Yes | REQUIRED_BEFORE_M4_CLOSEOUT | P2 | No | N/A — no deferral | persisted task log records counts/summaries, not restricted raw output artifacts |
| Idle Timeout | PARTIAL | Yes | REQUIRED_BEFORE_M4_CLOSEOUT | P1/P5 | No | N/A — no deferral | generic inactivity timer exists without durable Process reason/state semantics |
| Windows Job Object / fallback | MISSING | Yes, platform gate | REQUIRED_BEFORE_M4_CLOSEOUT | P1/P5 | No | N/A — no deferral | Windows uses `child.kill()` with no owned-tree/survivor proof |
| POSIX Process Group | MISSING | Yes, platform gate | REQUIRED_BEFORE_M4_CLOSEOUT | P1/P5 | No | N/A — no deferral | current POSIX TERM/KILL targets the child rather than a proven process group |
| ProviderRegistry | PARTIAL | Yes, Kimi registration | REQUIRED_BEFORE_M4_CLOSEOUT | P3/P8/P9 | No | N/A — no deferral | current per-execution Registry has Codex/Kimi only and no stable manifest breadth |
| Provider Adapter | PARTIAL | Yes | REQUIRED_BEFORE_M4_CLOSEOUT | P3/P8/P9 | No | N/A — no deferral | build/parser adapters exist, but their contract lacks the Process port/session/finalize/error boundary |
| Provider Configuration | IMPLEMENTED | Yes | REQUIRED_BEFORE_M4_CLOSEOUT | P3/P4/P8/P9 | No | N/A — no deferral | migration 003/repository/snapshot/secret references exist; launch-consumption parity remains a phase gate |
| Process Environment / Secret References | PARTIAL | Yes | REQUIRED_BEFORE_M4_CLOSEOUT | P1/P3/P4/P8/P9 | No | N/A — no deferral | env assembly exists, but Roadmap §58 precedence and reference-only secret resolution are not enforced by one canonical launch seam |
| Authentication | MISSING | Yes, stable failure minimum | REQUIRED_BEFORE_M4_CLOSEOUT | P3/P4/P8/P9 | No | N/A — no deferral | no canonical auth validation/state/error mapping exists |
| KimiCodeProviderAdapter | PARTIAL | Yes | REQUIRED_BEFORE_M4_CLOSEOUT | P3/P4/P7 | No | N/A — no deferral | dedicated adapter exists but still launches through raw `CLIExecutor` spawn |
| CodexProviderAdapter | PARTIAL | No, second proof | REQUIRED_BEFORE_M4_CLOSEOUT | P8 | No | N/A — no deferral | dedicated legacy adapter/evidence exists; generic Process-port integration is absent |
| OpenCodeProviderAdapter | MISSING | No, later breadth | REQUIRED_BEFORE_M4_CLOSEOUT | P9 | No | N/A — no deferral | no registered dedicated adapter or current executable/protocol evidence |
| Provider Validation API | PARTIAL | Yes, Kimi minimum | REQUIRED_BEFORE_M4_CLOSEOUT | P3/P8/P9 | No | N/A — no deferral | probes/CRUD checks exist; no canonical validation result/API contract |
| Provider Session API | MISSING | No | REQUIRED_BEFORE_M4_CLOSEOUT | P10 | No | N/A — no deferral | no canonical Session API/resource implementation |
| Process Inspector API | MISSING | No | REQUIRED_BEFORE_M4_CLOSEOUT | P10 | No | N/A — no deferral | no canonical Process query/inspection API; UI remains excluded |
| Stable Cancel | PARTIAL | Yes, Core/Kimi gate | REQUIRED_BEFORE_M4_CLOSEOUT | P5/P7 | No | N/A — no deferral | AbortSignal/child kill exists, not owned-tree cancellation |
| Recovery Record | MISSING | Minimum evidence starts with Kimi | REQUIRED_BEFORE_M4_CLOSEOUT | P6/P10 | No | N/A — no deferral | M3 `recovery_required` exists, but no M4 Process Recovery Record deliverable |
| Custom CLI Foundation | LEGACY | No, later breadth | REQUIRED_BEFORE_M4_CLOSEOUT | P9 | No | N/A — no deferral | generic raw CLI fallback exists without the bounded Foundation contract |

Allowed final row dispositions are only:

- `REQUIRED_BEFORE_M4_CLOSEOUT` — implemented, accepted and evidenced before
  P11; or
- `FORMALLY_DEFERRED_PENDING_SPEC_RECONCILIATION` — only after a separately
  authorized Roadmap/scope decision records the exact authority and evidence.

Nothing in this matrix makes the latter selection. In particular, lack of local
OpenCode evidence blocks its implementation/closeout phase; inconvenience is
not deferral authority.

## 9. Process ownership architecture

```text
HTTP/API/Legacy command surface
  -> TaskRunService / OperationService (acceptance and idempotency)
  -> one scheduler/dispatch authority
  -> RunEngine (Run/Stage orchestration only)
  -> StageExecutionCoordinator (authority lease/attempt)
  -> ProviderRegistry
  -> RuntimeProviderAdapter (launch plan, parse, finalize, normalize)
  -> ProviderProcessPort
  -> ProcessManager (identity, bytes, timers, stop, facts)
  -> PlatformProcessDriver (OS process/tree)
```

Responsibilities:

- Run owns the business attempt; Stage owns workflow progress.
- Stage coordinator owns exactly-once execution authority for an attempt.
- Provider Session owns Provider-native identity and semantics.
- AgentOS Process owns OS process/tree facts; PID is an attribute only.
- Platform driver owns OS differences, never Provider behavior.
- Browser owns only a subscription.

AgentRunner/ConversationAgentRunner may temporarily act as compatibility
facades, but once a canonical Stage is claimed they may not call CLIExecutor or
spawn independently. The final M4 direct-provider path has one authority.

## 10. Persistence strategy

Reuse:

- canonical Run/Stage/Operation/Snapshot/Event/Outbox and
  `runs.recovery_required`;
- Provider Configuration and Agent binding;
- artifact store/sink where its safety contract fits.

Candidate additions, subject to separate schema design/authorization:

- durable AgentOS Process record with Run/Stage/optional Session binding;
- native PID as nullable attribute, start/executable/recovery identity,
  state/version/activity/exit/signal/termination and raw output refs;
- minimal Provider Session/Validation records only if required by the accepted
  slice and not representable safely as immutable snapshot + Runtime Events.

Do not reuse old `executions` or `run_cli_invocations` as canonical Process
truth. They belong to the Conversation aggregate and lack active/tree/recovery
semantics.

Reservation/spawn is a compensating saga:

```text
validate + reserve durable Process identity
  -> spawn through platform driver
  -> persist PID/started fact + Event/Outbox
  -> register live handle

spawn failure
  -> CAS terminal Process failure + stable fact
  -> no orphan active record
```

Migration boundary:

```text
Migration 014: NOT CREATED / NOT AUTHORIZED
Schema change: CANDIDATE ONLY
```

## 11. Output / event architecture

```text
OS stdout/stderr bytes
  -> Process stream identity + bounded queue/backpressure
  -> incremental UTF-8 decoder/framer
  -> restricted raw artifact append + byte offset/hash
  -> Provider Adapter parser
  -> provider-specific intermediate fact
  -> canonical Runtime Event draft
  -> existing M3 validation/sequence/Event Store/Outbox
  -> replay/SSE/legacy/conversation projection
```

Rules:

- stdout/stderr are independent and untrusted.
- ProcessManager records bytes/process facts, never Tool/Reasoning semantics.
- Adapter never receives permission to mutate Run.
- malformed/unknown Provider output becomes safe diagnostic/raw reference, not
  invented Tool/File/Subagent behavior.
- raw output is restricted, redacted/classified and bounded; ordinary events
  contain references/summaries.
- Process exit is followed by Provider finalize and Stage output-contract
  evaluation; exit code 0 is not Run success.

## 12. Cancellation architecture

```text
explicit Run Cancel command
  -> M3 command/idempotency/concurrency validation
  -> durable cancellation request/fact
  -> Stage execution coordinator
  -> ProviderAdapter.cancel (protocol graceful request, if supported)
  -> ProcessManager.stop(processId)
  -> PlatformDriver graceful tree stop
  -> grace deadline
  -> force tree termination
  -> survivor verification/report
  -> Process exited/cleanup facts
  -> Provider finalize
  -> existing LifecycleTransactionService Stage/Run cancellation
```

Run cancel, Operation cancel, execution authority revocation, Provider cancel
and Process tree stop are related but not identical. M4 must document exact
ordering and race winners. Repeated cancel converges. Browser disconnect never
enters this chain.

## 13. Recovery boundary

M4 minimum classification combines:

- canonical Run/Stage/Start Operation/Event evidence;
- durable AgentOS Process record;
- native PID plus start/executable/recovery token/ownership evidence;
- platform capability and Process liveness evidence;
- optional Provider Session identity when actually persisted/proven.

Allowed outcomes are evidence-based: queued restoration under existing M3
rules, stable startup failure, externally-running/unknown with
`recovery_required`, missing Process failure/resumable classification, or
orphan flag. No outcome may infer `completed` from PID, exit code, missing
handle or provider files.

M7 retains generalized reattach, stream recovery, native resume, orphan
cleanup, Worktree/artifact/projection/lock recovery and broad chaos hardening.

## 14. Migration decision boundary

Before any migration creation, a separate authorization package must contain:

1. exact minimal schema and field semantics;
2. canonical identity and foreign-key ownership;
3. compatibility with 001–013 and old aggregates;
4. constraints/indexes/CAS terminal rules;
5. sensitive output/reference treatment;
6. fresh and existing database tests;
7. checksum/registry/backup/forward rollback boundary;
8. independent schema/security/recovery review;
9. explicit Owner/entry approval for the irreversible change.

Until then:

```text
Migration 014:
NOT CREATED
NOT AUTHORIZED
NOT RESERVED
```

## 15. File / package ownership

Expected conflict zones and serial owners:

| Conflict zone | Owning phase | Coordination rule |
|---|---|---|
| Process interfaces/package exports/root workspace config | P1 | one owner; later phases consume, do not redefine |
| database schema/migration registry/Process repository | P2 only if authorized | no parallel migration work |
| shared Runtime Event registry/envelope refs | P2 | preserve M3 definitions; Provider phase consumes |
| Provider core/Registry/Kimi adapter/config validation | P3 | no concurrent agent-core/provider edit |
| RunEngine/StageExecutor/background dispatch | P4 | one integration owner; lifecycle service reviewed, minimally changed |
| AgentRunner/LegacyCanonicalExecutionService/TaskRunService | P4 compatibility owner | do not refactor unrelated behavior; no parallel shared-core edits |
| Conversation routes/RunStreamRegistry | P5 transport owner | disconnect-only surgical changes |
| platform drivers/cancel coordinator | P5 | Windows/POSIX changes reviewed together |
| TaskRunRecoveryService/server startup/shutdown | P6 | one recovery owner; no concurrent lifecycle changes |
| Core/Kimi tests/fixtures/verification evidence | P7 | production remediation requires explicit re-entry |
| Codex adapter/integration/fixtures | P8 | consume accepted Process/Run contracts; no concurrent Provider core redefinition |
| OpenCode/Custom CLI adapter/config/fixtures | P9 | one Provider breadth owner; no parallel P8/P10 shared-core edits |
| Provider Session/Process Inspector/Recovery APIs | P10 | one API/schema boundary owner; no UI/M7 expansion |
| final Roadmap reconciliation/closeout evidence | P11 | production remediation requires explicit re-entry |

No two phases or agents may concurrently mutate RunEngine, AgentRunner,
TaskRunService, shared event types, schema, migration registry, package exports
or root workspace config without a new explicit coordination boundary.

## 16. Testing matrix

| Suite | Required cases |
|---|---|
| Process unit | executable exists/missing; spawn failure; exit 0/non-zero/signal; stdout/stderr; UTF-8 boundaries; startup/idle/total timeout; cancellation; repeated cancellation; tree cancellation; redaction; bounded output/backpressure |
| Platform contract | Windows `.exe`/`.cmd`/PowerShell, path spaces/Unicode, Job Object/fallback, child/grandchild/detached survivor; POSIX process group/TERM/KILL; signal/exit normalization |
| Provider contract | Registry lookup/version/type; validation; auth required/expired/unknown; invalid/disabled config; command/args/env construction; direct Kimi identity; output normalization; malformed/unknown output; stable errors/finalize |
| Integration | Run accepted; one authority claim; Process created before start fact; Provider starts only through Process Runtime; raw output refs; canonical Runtime Events; terminal mapping; replay/duplicate dispatch no spawn; browser disconnect continues; explicit cancel propagates |
| Recovery | server restart at reservation/start/running/stopping; same/missing/unknown process; PID reuse/mismatch; no guessed success; persisted identity integrity; repeated recovery; no second Start/Provider |
| Provider breadth | Kimi first gate; Codex second-adapter genericity; OpenCode evidence-backed adapter; bounded Custom CLI Foundation; no direct spawn/silent fallback; cross-provider Kimi/Codex/OpenCode regression |
| API breadth | Provider Validation API; Provider Session API; Process Inspector API authorization/redaction/pagination/identity; Recovery Record no-guess representation |
| M3 regression | lifecycle transaction, Event/Outbox 1:1 and sequence, Operation Start/Retry/Cancel, idempotency, replay/SSE, recovery uncertainty, Legacy projection/no-double-execution |
| Compatibility | Legacy task route/status/log projection; Conversation direct/group/cancel/resume; no default switch or retirement |
| Mutation/negative | architecture search forbids Provider/Run direct spawn; Adapter cannot import process implementation; ProcessManager cannot import Provider packages; injected Event/output/repository failures roll back/compensate; secret canaries absent |
| Real gate | installed Kimi direct validation and bounded task through AgentOS at P7; separately authorized Codex/OpenCode real gates in P8/P9 when required; current versions/paths are supporting evidence only; deterministic provider fixtures remain the required CI baseline |

Acceptance never means “rerun until green.” Timing/platform tests need bounded,
observable conditions and failure artifacts. A flaky pass is a failure.

## 17. Acceptance gates

| Gate | Required evidence |
|---|---|
| E01 | architecture test + runtime spy proves Run/RunEngine never calls `child_process` or platform driver directly |
| E02 | Adapter dependency graph and test prove all launches use `ProviderProcessPort`; no direct spawn import |
| E03 | persisted Process ID format and tests differ from PID; PID reuse/mismatch rejected |
| E04 | child/grandchild platform tests, force fallback and survivor report |
| E05 | stdout/stderr artifact refs, offset/hash/range, redaction and restricted-access tests |
| E06 | fake + current-machine Kimi direct E2E through canonical Run |
| E07 | validation/start auth fixture returns stable ApiProblem/Event semantics and no raw secret/stderr |
| E08 | socket-close E2E observes Process/Event/Run continue; explicit cancel separately terminates |
| E09 | restart matrix classifies same/missing/unknown and never marks uncertain success |
| E10 | full relevant M3 test matrix and no duplicate Event/Outbox/Operation/Process |

The Core/Kimi P7 gate requires all ten, but E01–E10 plus Kimi do not by
themselves close M4. Final M4 exit additionally requires the complete Roadmap
deliverable reconciliation in section 8 and the section 21 DoD. No subset
authorizes production cutover.

## 18. Independent review gates

Each phase needs an independent reviewer not acting as its primary implementer.
Review scopes:

- P0: contract, scope, schema boundary, M3 preservation;
- P1: API, concurrency/timers, security, platform abstraction;
- P2: schema/data/event/output/recovery identity;
- P3: Provider identity/auth/validation/parser/error;
- P4: exactly-one authority and M3 lifecycle integration;
- P5: process tree, races and transport independence;
- P6: no-guess recovery and M4/M7 boundary;
- P7: complete E01–E10 Core/Kimi evidence and prove it is not final M4 closeout;
- P8: Codex genericity and cross-provider regression;
- P9: OpenCode evidence, Custom CLI security and full Provider breadth;
- P10: Session/Inspector/Recovery API, authz/schema and M4/M7 boundary;
- P11: every Roadmap deliverable disposition, immutable-head evidence and final
  M4 closeout contract.

A gate may authorize only review completion. The next phase needs a separate
entry decision.

## 19. Rollback boundaries

- P1 is additive and removable while old execution remains unchanged.
- P2 preserves already-written durable Process/Event/Artifact evidence;
  rollback is forward code correction, not silent DB downgrade.
- P3 can remove Registry/validation/Kimi seams while preserving configs.
- P4 can disable/revert the additive dispatch seam without a production default
  switch; claimed durable evidence is retained.
- P5 can revert transport/cancel routing without deleting Process evidence.
- P6 can revert Process recovery integration while retaining M3
  `recovery_required` and all stored facts.
- P7 changes tests/evidence/docs; findings send Core/Kimi work back to an
  authorized phase and leave M4 open.
- P8 can remove Codex integration without changing accepted Core/Kimi facts.
- P9 can remove OpenCode/Custom registrations while leaving their Roadmap
  disposition unresolved and M4 open.
- P10 can revert additive API surfaces while preserving durable facts.
- P11 changes only evidence/closeout records; failure leaves M4 open.

Production Restore, data deletion, force cleanup and Legacy retirement are not
rollback mechanisms authorized by this plan.

## 20. Stop / no-go conditions

Stop the active phase if any occurs:

- base or authoritative contract drifts without re-entry decision;
- direct Provider spawn remains after the relevant migration gate;
- more than one execution authority can claim one Stage attempt;
- migration/schema change lacks explicit authorization;
- AgentOS Process identity equals or relies only on PID;
- tree survivor cannot be detected/reported;
- browser close can still terminate the selected canonical execution path;
- Adapter mutates Run/Stage or Process Runtime parses Provider semantics;
- raw output or errors expose secret/full environment/hidden reasoning;
- recovery guesses success, starts another Provider, or changes terminal Run;
- M3 lifecycle/Event/Outbox/idempotency/replay/recovery tests regress;
- Kimi direct identity/protocol cannot be validated;
- P1/P3/P4 broadens into Codex/OpenCode or any phase broadens into
  M5/M7/UI/cutover without authorization;
- P7/Core/Kimi evidence is presented as `M4 COMPLETE`;
- a Roadmap §§55/59 deliverable disappears, is marked deferred without an
  authorized scope/spec reconciliation, or lacks a final P11 disposition;
- BLOCKER or HIGH independent review finding remains open;
- a test is accepted only by rerun, sleep inflation or weakened assertion.

## 21. M4 final Definition of Done

M4 implementation may be declared complete only when:

1. E01–E10 all pass on one immutable reviewed head.
2. the KimiCode Direct vertical slice passes its deterministic and separately
   authorized real gates through the single authority chain.
3. the Core Process Runtime passes its own identity/tree/output/cancel/timeout/
   recovery/platform gates; `PROCESS CORE VERIFIED` is recorded independently.
4. every Roadmap M4 scope item and deliverable in §§55/59 is either implemented,
   independently accepted and evidenced, or formally removed/deferred by an
   authorized scope/spec reconciliation decision. Missing evidence, sequencing
   or inconvenience is not a deferral.
5. the Roadmap reconciliation matrix has no unresolved row or authoritative
   contradiction; P7/Core/Kimi success alone is explicitly insufficient.
6. AgentOS Process, PID, Run, Stage, Provider Configuration, Provider Session
   and old Execution identities are unambiguous.
7. durable Process state/raw output/Process facts satisfy schema, security and
   replay contracts.
8. active cancel kills/verifies the owned tree on Windows and POSIX contracts.
9. disconnect never cancels; explicit Cancel does.
10. restart classification never guesses success and preserves M3 uncertainty.
11. Provider auth/config/version/output failures have stable semantics.
12. M3 lifecycle/Event/Outbox/Operation/idempotency/compatibility tests pass.
13. remaining direct subprocesses are inventoried and assigned to M4/M5/other
    ownership; none is silently declared compliant.
14. no Legacy retirement, Web switch, cutover or M7 hardening was smuggled in.
15. final independent review has `BLOCKER = 0`, `HIGH = 0`.
16. final integrated evidence is bound to one exact immutable head and is
    reproducible without retries, hidden skips or mutable external assumptions.

The four milestone statuses are distinct:

```text
M4-P4 KIMI VERTICAL SLICE: may become COMPLETE
M4 CORE PROCESS RUNTIME: may become VERIFIED after its own gates
M4 ROADMAP PROVIDER BREADTH: remains PENDING until delivered or formally reconciled
M4 MILESTONE: cannot become COMPLETE merely because Process + Kimi passes
```

Codex/OpenCode/Custom CLI and the remaining API/Recovery deliverables are not
required for the *initial* Kimi gate, but their Roadmap disposition is required
for *final* M4 closeout. Under the current preserved Roadmap, they remain
`REQUIRED_BEFORE_M4_CLOSEOUT`.

## 22. Explicit production authorization boundary

This file is a plan, not an authorization.

```text
M4 PREPLANNING:
ACCEPTED INPUT TO P0

M4-P0 CONTRACT PACKAGE:
COMPLETE / PENDING INDEPENDENT P0 REVIEW

M4-P1 IMPLEMENTATION:
NOT AUTHORIZED

M4 PRODUCTION IMPLEMENTATION:
NOT AUTHORIZED

Migration 014:
NOT CREATED

Production Cutover:
NOT AUTHORIZED

Web Default Switch:
NOT AUTHORIZED

Legacy Retirement:
NOT AUTHORIZED

Ready:
NOT AUTHORIZED

Merge:
NOT AUTHORIZED
```

The next action is independent M4-P0 contract review. P0 completion cannot
authorize P1 automatically; only a later explicit P1 entry decision may do so.
