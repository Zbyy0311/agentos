# AgentOS M4 Process & Provider Runtime — Owner Decision Register

Status: OD-M4-01 SELECTED — OPTION A — OD-M4-02 SELECTED — WINDOWS ONLY — P2 SCHEMA DESIGN FROZEN IN M4-p2-schema-design.md — MIGRATION 014 IMPLEMENTATION NOT AUTHORIZED — NO PRODUCTION AUTHORIZATION

## 1. Current owner decision count

```text
CURRENT OWNER DECISION COUNT = 2

OWNER DECISIONS REQUIRED BEFORE M4-P0 = 0

OWNER DECISIONS REQUIRED BEFORE M4-P1 = 0

OWNER DECISIONS REQUIRED BEFORE M4-P2 SCHEMA = 1
```

P0 produced one genuine unresolved Owner Decision for a future irreversible
database compatibility commitment. It does not block the schema-light P1
foundation. It blocks any P2 schema/migration creation until an explicit option
is selected. No Owner Decision is required before P0 or P1.

The register preserves the complete authoritative Roadmap M4 scope. Keeping
Codex, OpenCode, Custom CLI Foundation, Provider Session API, Process Inspector
API and Recovery Record as final M4 closeout obligations is not a new product
choice and needs no Owner Decision. It follows Roadmap §§55/59. Kimi-first is
delivery order only.

An undecided Owner Decision is not production or migration authorization. Every M4
implementation phase still requires its own explicit entry authorization and
independent review gate.

## 2. Classification rule

A `USER OWNER DECISION` is raised only for:

- irreversible schema/data behavior;
- user-visible product semantics with genuine alternatives;
- compatibility removal or destructive legacy retirement;
- security/auth policy beyond a fail-closed technical default;
- external cost/infrastructure commitment;
- production cutover/default switch.

A `TECHNICAL DECISION` is resolved from repository evidence, tests, safety
invariants and independent technical review. The user is not asked to choose
class names, package layout, platform libraries, retry mechanics, event
plumbing, test tools, or other routine implementation details.

### OD-M4-01 — First durable Process Runtime schema commitment

| Field | Value |
|---|---|
| ID | `OD-M4-01` |
| Question | After independent P0/schema review, should AgentOS authorize a future additive migration implementing exactly `runtime_processes`, `provider_sessions`, and `process_output_references` with the P0 forward-only evidence-preservation boundary? |
| Why evidence cannot decide | Evidence proves migrations 001–013 cannot represent the required reservation, Session identity and stream offsets, and it supports the three-resource design. It cannot grant acceptance of the irreversible minimum-database compatibility commitment once production rows exist. |
| Option A | Authorize a separately reviewed additive migration package matching the exact P0 resources, constraints, fresh/upgrade tests and forward-only boundary. |
| Option B | Keep P2 blocked and require a revised schema proposal; create no migration. |
| Recommendation | Option A, only after independent P0/schema review and a new authorization naming exact base, files, migration number, DDL, tests, backup and compatibility boundary. |
| Impact | Option A unlocks P2 durable Process/Session/output work and raises the minimum database understood by future application code. Option B preserves 001–013 and blocks P2/P4 execution authority. |
| Reversibility | Reversible before migration execution and before durable rows exist. After production evidence exists, rollback is forward correction or authorized restore, never silent table/row deletion. |
| Required-before phase | Before any P2 schema or migration file creation; not required for P1. |
| Status | `SELECTED — OPTION A` |

Owner selection recorded 2026-08-13 on authoritative base
`6a3a257af1d71ec5c8884311c4427c5f1ea1a543`: `OD-M4-01 = Option A — SELECTED`.
This selection authorizes only continued preparation of the P2 schema/migration
package, frozen in `M4-p2-schema-design.md`. It does not authorize Migration 014
implementation, and it does not authorize P2 production implementation; both
still require the separate P2 entry authorization and independent schema
review. Migration 014 remains uncreated; its number is reserved inside the
design document only.

## 3. Technical decisions that do not require Owner

| ID | Technical decision | Evidence and recommended direction | Required before | Review status |
|---|---|---|---|---|
| M4-TD-01 | Single execution authority | `RunEngine -> Stage coordinator -> ProviderRegistry -> ProviderAdapter -> ProcessManager -> PlatformDriver`; no route/AgentRunner/Adapter direct provider spawn | P1 implementation | Must pass P0 independent review |
| M4-TD-02 | Process identity | AgentOS Process ID is durable and never OS PID; recovery evidence includes more than PID | schema design/P2 | Must pass schema and recovery review |
| M4-TD-03 | Initial Provider | KimiCode Direct only for first vertical slice; current main has dedicated adapter/tests and current machine `0.23.5` | P3/P4 | Must pass Provider contract review |
| M4-TD-04 | Additional Providers | Codex is the second adapter proof after Core/Kimi; OpenCode and bounded Custom CLI follow in later M4 phases. Missing evidence stops closeout; it does not silently move them out of M4 | P8/P9 | Re-review at each separately authorized phase |
| M4-TD-05 | Process versus Provider output | Process Runtime owns bytes/raw artifacts/activity; Adapter owns provider parsing/finalization/error mapping; M3 Event layer owns durable canonical facts | P1/P2/P3 | Event/security review |
| M4-TD-06 | Lifecycle authority | Provider/Process components return facts; only existing M3 lifecycle transaction seams mutate Run/Stage | all implementation | M3 regression review |
| M4-TD-07 | Cancel | explicit Run/Operation command coordinates graceful Provider stop and Process tree termination; disconnect only unsubscribes | P5 | cancellation/platform review |
| M4-TD-08 | Windows tree strategy | encapsulate Job Object capability and bounded fallback behind platform driver; require survivor verification | P1/P5 | Windows contract review |
| M4-TD-09 | Timeout | separate startup, idle and total facts; pause idle accounting for approved waiting states; timeout never equals provider success | P1/P5 | timer/race review |
| M4-TD-10 | Recovery minimum | integrate durable Process evidence with M3 `recovery_required`; unknown stays unknown; do not auto-restart or guess success | P6 | recovery review |
| M4-TD-11 | Native resume | defer provider-native resume unless Kimi contract evidence proves safe native identity; generalized resume is M7 | P6 | recovery/Provider re-review |
| M4-TD-12 | Browser lifecycle | POST/SSE close handlers only release transport subscribers; explicit Cancel is the only termination request | P4/P5 | disconnect E2E review |
| M4-TD-13 | Provider identity mapping | freeze explicit boundary mapping between persisted `kimicode` and legacy runtime `kimi`; no command-name inference as canonical identity | P0/P3 | spec reconciliation review |
| M4-TD-14 | Raw output | bounded, append-oriented, restricted artifacts with pre-persistence redaction/classification; ordinary events carry references/safe summaries | P2 | security/output review |
| M4-TD-15 | Unrelated subprocesses | inventory remains open; Provider execution migrates first. Git/Worktree/tar semantics remain M5-owned and cannot broaden the first slice | all phases | scope review |
| M4-TD-16 | Schema process | produce minimal schema design first; no migration file or number before separate authorization | P0/P2 | independent schema review + entry authorization |
| M4-TD-17 | Legacy compatibility | preserve Legacy and Conversation behavior through adapters/projections; no deletion/default switch in M4 | P4/P7/P11 | compatibility review |
| M4-TD-18 | Failure mapping | stable Provider and Process errors are mapped before lifecycle transition; raw stderr is never the public contract | P3/P4 | error-contract review |
| M4-TD-19 | Milestone status separation | `KIMI VERTICAL SLICE COMPLETE != M4 MILESTONE COMPLETE`; P7 verifies Core/Kimi only; P11 can close M4 only after every Roadmap deliverable is accepted or formally reconciled | P0/P7/P11 | Roadmap-scope and final closeout review |
| M4-TD-20 | Roadmap deliverable disposition | Preserve all §§55/59 deliverables in M4. A later proposal to remove/defer one must stop and raise explicit scope/spec authority; inconvenience or missing local executable is insufficient | P0/P8-P11 | Matrix review on every gate |

## 4. Deferred product decisions

These topics may later require Owner input, but there is insufficient evidence
or no authorized phase presently needs the decision. They are not approved and
do not block M4-P0.

| Candidate topic | Why deferred | Earliest phase that may raise an Owner Decision |
|---|---|---|
| Raw output retention and user-visible access duration | technical minimum can be restrictive; product retention/visibility needs storage/security evidence | after P2 evidence, before any release/cutover |
| Provider auth UX and credential-store policy | M4 can use fail-closed references and stable `PROVIDER_AUTH_REQUIRED`; interactive login/product UX is not needed for core contracts | after P3 validation evidence |
| Legacy route retirement | explicitly outside M4; requires consumer/cutover evidence | post-M4 cutover planning |
| Web default switch | explicitly outside authorization | production cutover phase |
| Generalized native Provider resume UX | M7 hardening and user-visible semantics need multi-provider evidence | M7 planning |
| External broker/remote Process infrastructure | no current need or cost authorization | future scale/product phase |
| Moving an explicit Roadmap M4 deliverable to another milestone | current plan does not propose this; if later proposed, authoritative scope and user-visible delivery commitment must be reconciled without implicit selection | before the phase that would omit it and before P11 |

No deferred item may be treated as implicitly selected.

## 5. Schema and migration decisions explicitly not authorized

P0 schema verdict:

```text
SCHEMA_PROPOSAL_REQUIRES_FUTURE_MIGRATION
OD-M4-01 + ENTRY AUTHORIZATION REQUIRED BEFORE MIGRATION CREATION

Migration 014:
NOT CREATED
IMPLEMENTATION NOT AUTHORIZED
NUMBER RESERVED IN DESIGN DOC ONLY
FUTURE MIGRATION TECHNICALLY REQUIRED; NUMBER FROZEN AS 014 IN M4-p2-schema-design.md
```

P0 proposes exactly three first-schema resources: Runtime Process, Provider
Session and Process output references. Provider Validation and Recovery Record
use typed/cache/Event and Process/Event/M3 resources instead of new first-schema
tables. This technical necessity is not approval to mutate data. `OD-M4-01` is
now `SELECTED — OPTION A` (see section 2) and the exact schema design is frozen
in `M4-p2-schema-design.md`. The future implementation package must still add
exact DDL, checksum, registry entry, tests and independent review before any
P2 entry authorization may be granted; the Owner selection does not grant it.

No SQL or migration file is part of this register; the Migration 014 number
reservation lives only inside `M4-p2-schema-design.md`.

## 6. Cutover and compatibility decisions explicitly not authorized

```text
Production Cutover: NOT AUTHORIZED
Web Default Switch: NOT AUTHORIZED
Legacy API Retirement: NOT AUTHORIZED
Legacy JSON Retirement: NOT AUTHORIZED
Conversation aggregate unification: NOT AUTHORIZED
PR #45 change/merge/close: NOT AUTHORIZED
```

M4 implementation must be additive/compatibility-preserving. A technical phase
may route an existing surface through the new single authority only when its
parity tests pass and the old direct spawn is no longer a competing execution
path. That routing is not permission to remove the surface.

## 7. Decision dependencies by implementation phase

| Phase | Technical decisions required | User Owner Decision required | Authorization boundary |
|---|---|---:|---|
| M4-P0 contract closure | TD-01 through TD-20 as applicable; exact port/schema/final-scope proposal | 0 | Contract/docs complete; independent review still required |
| M4-P1 Process foundation | TD-01, 05, 08, 09 | 0 | Requires explicit P1 authorization after P0 review |
| M4-P2 persistence/output | TD-02, 10, 14, 16; exact P0 schema | 1 (`OD-M4-01`, SELECTED — OPTION A) | Migration implementation remains forbidden until separate P2 entry authorization |
| M4-P3 Registry/validation/Kimi adapter contract | TD-03, 04, 13, 18 | 0 for fail-closed local validation | Requires P3 authorization |
| M4-P4 Run integration/Kimi slice | TD-01, 05, 06, 17 | 0 | Requires P4 authorization; no cutover |
| M4-P5 cancel/tree/timeout/disconnect | TD-07, 08, 09, 12 | 0 | Requires P5 authorization |
| M4-P6 minimum recovery | TD-02, 10, 11 | 0 if unknown remains fail-closed | Requires P6 authorization; generalized M7 recovery excluded |
| M4-P7 Core/Kimi verification gate | TD-01 through TD-19 as applicable | 0 | Can verify Core/Kimi only; cannot close M4 or authorize P8 |
| M4-P8 Codex genericity proof | TD-04, 05, 06, 13, 18-20 | 0 under preserved Roadmap | Requires explicit P8 authorization; does not authorize P9 |
| M4-P9 OpenCode/Custom CLI | TD-04, 05, 18-20 | 0 under preserved Roadmap | Requires explicit P9 authorization and evidence; missing evidence blocks closeout |
| M4-P10 Session/Inspector/Recovery APIs | TD-02, 05, 10, 14, 16, 19-20 | 0 unless irreversible schema/product policy emerges | Requires explicit P10 and any separate schema authorization |
| M4-P11 final M4 closeout | TD-19-20 plus all accepted contracts | 0 if every Roadmap item is delivered | Requires explicit P11; unresolved or unauthorized deferral blocks M4 completion |

If a future phase discovers an irreversible schema choice, product-visible auth
policy, compatibility removal, external cost, destructive cleanup, or cutover
choice, it must create a new `OD-M4-XX` with Question, why evidence cannot decide,
options, recommendation, impact, reversibility and required-before phase. It
must remain undecided until the Owner records an explicit selection.

The same rule applies if a future plan proposes moving an explicit Roadmap M4
deliverable out of M4. That proposal is not approved here. It must record an
undecided Owner/scope-spec decision before omission, and P11 must reject an
unrecorded deferral.

## 8. Current decision conclusion

```text
CURRENT OWNER DECISION COUNT = 2
OWNER DECISIONS REQUIRED BEFORE M4-P0 = 0
OWNER DECISIONS REQUIRED BEFORE M4-P1 = 0
OWNER DECISIONS REQUIRED BEFORE M4-P2 SCHEMA = 1

AUTHORITATIVE M4 SCOPE:
PRESERVED, WITH CURRENT PRODUCTION PLATFORM NARROWED BY OD-M4-02

KIMI VERTICAL SLICE COMPLETE == M4 MILESTONE COMPLETE:
NO

SCOPE/SPEC RECONCILIATION:
P0 CONTRACTS FROZEN; EVENT ADDITIONS REQUIRE OWNING-PHASE REVIEW; CURRENT PRODUCTION PLATFORM = WINDOWS ONLY

M4-P0 CONTRACT PACKAGE:
COMPLETE / PENDING INDEPENDENT P0 REVIEW

M4-P1 ENTRY RECOMMENDATION:
ELIGIBLE FOR SEPARATE ENTRY DECISION AFTER P0 REVIEW

M4-P2 SCHEMA DESIGN:
OD-M4-01 SELECTED — OPTION A; PACKAGE FROZEN IN M4-p2-schema-design.md

M4-P2 IMPLEMENTATION:
BLOCKED ON SEPARATE P2 ENTRY AUTHORIZATION

M4 PRODUCTION IMPLEMENTATION:
NOT AUTHORIZED

Migration 014:
NOT CREATED

Migration 014 Number:
RESERVED IN DESIGN DOC ONLY; IMPLEMENTATION NOT AUTHORIZED

Production Cutover:
NOT AUTHORIZED
```

## 9. OD-M4-02 — Current production platform support

| Field | Value |
|---|---|
| ID | OD-M4-02 |
| Decision | SELECTED — WINDOWS ONLY |
| Current production-supported host platform | Windows |
| Current M4 production delivery | Windows is required; Windows process ownership, termination and Provider execution evidence is release-blocking; Windows CI and real-platform validation remain authoritative |
| Deferred production platforms | Linux / POSIX / macOS are not production-supported platforms for current M4 |
| Retained POSIX implementation | Future capability, experimental/best-effort implementation and deterministic regression coverage; no current production support promise |
| POSIX real-OS validation | Deferred and non-blocking for M4-P5B closeout, M4 completion, subsequent M4 phases and current Windows delivery |
| No-environment behavior | Missing WSL2/Linux/Docker/Podman must not produce PLATFORM_GATE_BLOCKED for current Windows-only production acceptance |
| Support claim boundary | This decision does not claim POSIX support is proven, does not authorize deleting POSIX code and does not weaken deterministic POSIX unit tests |
| Future POSIX production claim | Requires a new explicit platform-support Owner Decision plus real-OS acceptance evidence on that platform |
| Nature of decision | Scope/spec reconciliation, not a statement that the POSIX implementation is defective |
| Historical record | Historical documents and commits remain historical evidence and are not rewritten to erase earlier cross-platform intent |

OD-M4-01 remains unchanged. OD-M4-02 = SELECTED — WINDOWS ONLY.

The current Owner Decision count is 2. This decision supersedes the earlier
cross-platform production-acceptance condition only for current platform-release
scope; it does not change process-tree safety semantics or authorize the next
M4 phase.
