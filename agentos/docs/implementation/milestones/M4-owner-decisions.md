# AgentOS M4 Process & Provider Runtime — Owner Decision Register

Status: PREPLANNING ONLY — NO PRODUCTION AUTHORIZATION

## 1. Current owner decision count

```text
CURRENT OWNER DECISION COUNT = 0

OWNER DECISIONS REQUIRED BEFORE M4-P0 = 0
```

No unresolved question found by the current-state audit requires the user Owner
to decide a product behavior, security policy, irreversible data change,
compatibility removal, external cost, cutover or destructive retirement before
the contract-only M4-P0 phase. This document does not invent Owner Decisions for
routine architecture or implementation details.

An empty Owner Decision register is not production authorization. Every M4
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

## 3. Technical decisions that do not require Owner

| ID | Technical decision | Evidence and recommended direction | Required before | Review status |
|---|---|---|---|---|
| M4-TD-01 | Single execution authority | `RunEngine -> Stage coordinator -> ProviderRegistry -> ProviderAdapter -> ProcessManager -> PlatformDriver`; no route/AgentRunner/Adapter direct provider spawn | P1 implementation | Must pass P0 independent review |
| M4-TD-02 | Process identity | AgentOS Process ID is durable and never OS PID; recovery evidence includes more than PID | schema design/P2 | Must pass schema and recovery review |
| M4-TD-03 | Initial Provider | KimiCode Direct only for first vertical slice; current main has dedicated adapter/tests and current machine `0.23.5` | P3/P4 | Must pass Provider contract review |
| M4-TD-04 | Additional Providers | Codex is second adapter proof after Kimi; OpenCode is deferred until executable/protocol/dedicated adapter evidence exists | after Kimi gate | Re-review after initial slice |
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
| M4-TD-17 | Legacy compatibility | preserve Legacy and Conversation behavior through adapters/projections; no deletion/default switch in M4 | P4/P7 | compatibility review |
| M4-TD-18 | Failure mapping | stable Provider and Process errors are mapped before lifecycle transition; raw stderr is never the public contract | P3/P4 | error-contract review |

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

No deferred item may be treated as implicitly selected.

## 5. Schema and migration decisions explicitly not authorized

Current audit verdict:

```text
SCHEMA CHANGE CANDIDATE
OWNER/ENTRY AUTHORIZATION REQUIRED BEFORE MIGRATION CREATION

Migration 014:
NOT CREATED
NOT AUTHORIZED
NOT RESERVED
NOT DECLARED REQUIRED
```

The likely need for durable Runtime Process (and possibly Provider Session /
Validation) records is technical evidence for a schema proposal, not approval
to mutate data. A future schema package must state exact tables/fields,
constraints, old-aggregate compatibility, upgrade/fresh database tests,
recovery identity, rollback/forward behavior and data sensitivity. Only then
can the responsible entry/Owner authority decide whether the irreversible data
change is authorized.

No SQL or migration number is part of this preplanning package.

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
| M4-P0 contract closure | TD-01 through TD-18 as applicable; exact port/schema proposal | 0 | Contract/docs only unless separately authorized |
| M4-P1 Process foundation | TD-01, 05, 08, 09 | 0 | Requires explicit P1 authorization after P0 review |
| M4-P2 persistence/output | TD-02, 10, 14, 16 | likely 1 only if schema creation is proposed and approved; currently 0 | Migration remains forbidden until separate authorization |
| M4-P3 Registry/validation/Kimi adapter contract | TD-03, 04, 13, 18 | 0 for fail-closed local validation | Requires P3 authorization |
| M4-P4 Run integration/Kimi slice | TD-01, 05, 06, 17 | 0 | Requires P4 authorization; no cutover |
| M4-P5 cancel/tree/timeout/disconnect | TD-07, 08, 09, 12 | 0 | Requires P5 authorization |
| M4-P6 minimum recovery | TD-02, 10, 11 | 0 if unknown remains fail-closed | Requires P6 authorization; generalized M7 recovery excluded |
| M4-P7 verification/closeout | all frozen decisions | 0 | Verification does not authorize Ready, merge or cutover |

If a future phase discovers an irreversible schema choice, product-visible auth
policy, compatibility removal, external cost, destructive cleanup, or cutover
choice, it must create a new `OD-M4-XX` with Question, why evidence cannot decide,
options, recommendation, impact, reversibility and required-before phase. It
must remain undecided until the Owner records an explicit selection.

## 8. Current decision conclusion

```text
CURRENT OWNER DECISION COUNT = 0
OWNER DECISIONS REQUIRED BEFORE M4-P0 = 0

M4-P0 ENTRY RECOMMENDATION:
ELIGIBLE FOR SEPARATE AUTHORIZATION

M4 PRODUCTION IMPLEMENTATION:
NOT AUTHORIZED

Migration 014:
NOT CREATED

Production Cutover:
NOT AUTHORIZED
```
