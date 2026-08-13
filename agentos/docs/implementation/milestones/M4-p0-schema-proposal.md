# AgentOS M4-P0 Minimal Schema Proposal

Status: CONCEPTUAL CONTRACT ONLY — NO SQL — NO MIGRATION AUTHORIZATION

## 1. Current schema evidence

The accepted base has migrations `001`–`013` and no Migration 014.

| Existing resource | Reusable evidence | Insufficiency for M4 |
|---|---|---|
| `provider_configurations` | canonical `kimicode` type, Adapter ID, executable, arguments, model, environment/secret references, capabilities, timeout/output policy, enabled/archive state and version | no Provider Session, native identity, Process state, output offset, or validation result history |
| `runs` | canonical Run identity/status/version, per-Run next Event sequence and `recovery_required` | Run state cannot represent OS Process identity/tree/exit/recovery and must not become a second Process state machine |
| `run_stages` | canonical Stage identity, workflow key, sequence, `attempt`, status and version | no unique root Provider execution reservation or Process ownership facts |
| `runtime_events` | append-only Event envelope already has optional `provider_session_id`, `process_id` and `artifact_id`; Run sequence and Stage FK exist | reference fields have no canonical Session/Process resources; Event history cannot be the mutable current Process/Session state |
| `outbox_messages` | one durable Event maps to one delivery record with immutable identity and fenced delivery | transport reliability only; not current Process/Session state |
| old `executions` / `run_cli_invocations` | historical Conversation CLI invocation/exit evidence | old aggregate, completed-invocation shape, no active tree/recovery/CAS semantics; cannot be repurposed |
| old `runtime_artifacts` | artifact metadata/storage for old `agent_runs` and `executions` | FKs bind it to the old Conversation aggregate; cannot own canonical M3 Process output |
| canonical ID allocator | existing `proc`, `psess`, `artifact` and `evt` prefixes | IDs exist conceptually but Session/Process resources do not |

Current verdict before P0 is `SCHEMA PARTIAL`. The optional M3 Event references
were intentionally forward-compatible; they do not eliminate the need for
durable targets and current-state CAS.

## 2. Required durable facts

The first M4 schema must durably answer, without inspecting a live handle:

1. which exact Workspace/Run/Stage attempt owns the one root Provider chain;
2. which frozen Provider Configuration/Adapter version the Session uses;
3. which AgentOS Process ID was reserved before spawn and whether it may spawn;
4. current Process/Session state and CAS version;
5. native PID plus identity evidence beyond PID and tree ownership mode;
6. redacted launch facts, activity/timeouts and terminal/cleanup evidence;
7. independent stdout/stderr artifact identity, source/retained offsets,
   truncation/finalization and integrity metadata;
8. whether restart evidence is same/missing/mismatch/unknown and why;
9. how every fact binds to existing Run/Stage/Event/Outbox contracts; and
10. enough immutable history references to diagnose races without turning
    mutable rows into an Event log.

The database and OS spawn remain a compensating saga. Reservation is durable
before spawn. No schema can make spawn part of the SQLite transaction.

## 3. Existing resource reuse

| Fact | Reused owner | Rule |
|---|---|---|
| Workspace/Task/Run/Stage identity and Stage attempt | existing canonical resources | new rows reference them; never duplicate their lifecycle state |
| Provider Configuration | `provider_configurations` plus immutable Run snapshot | Session stores ID/version and frozen Adapter identity, not secret values |
| command idempotency and lifecycle | M3 idempotency/Operation/Run/Stage services | no Process command/idempotency table in first schema |
| Event sequence/history/delivery | `runs.next_event_sequence`, `runtime_events`, `outbox_messages` | Process/Session mutations emit drafts through existing atomic Event/Outbox seam |
| Run uncertainty | `runs.recovery_required` | Process classification supplies evidence; it does not replace M3 recovery state |
| recovery history/report | Process current fields plus immutable Runtime Events | no separate Recovery Record table in first schema |
| validation for a Run | Provider validation Events tied to Run/config version | no validation-history table in first schema |
| standalone validation response | typed API result plus bounded non-authoritative cache | no fake Run may be created solely to persist an Event |

Old Conversation tables and old `runtime_artifacts` are never reused as
canonical Process, Session or output-reference storage.

## 4. Candidate entities

| Concept | Classification | First-schema representation / reason |
|---|---|---|
| Runtime Process | `REQUIRED_IN_FIRST_SCHEMA` | `runtime_processes`; required for pre-spawn reservation, exactly-one claim, CAS state, native/recovery/tree/terminal evidence |
| Provider Session | `REQUIRED_IN_FIRST_SCHEMA` | `provider_sessions`; required to freeze Provider/Adapter identity and distinguish Session outcome from Process exit |
| Provider Validation | `NOT YET JUSTIFIED` | Run-bound results are Events; standalone validation is typed response plus bounded cache. Durable cross-Run history needs later retention/query evidence |
| Process raw-output reference/metadata | `REQUIRED_IN_FIRST_SCHEMA` | `process_output_references`; one row per Process stream owns the canonical artifact identity and bounded offset/integrity metadata |
| Recovery Record | `REPRESENTABLE_BY_EXISTING_RESOURCE` | current Process recovery fields plus immutable recovery-classification Events and `runs.recovery_required`; no separate table |
| Process usage samples | `REQUIRED_LATER_IN_M4` | not needed for P1–P7 correctness; add only with Inspector/retention evidence and separate authorization |
| generalized Artifact entity | `NOT YET JUSTIFIED` for M4 first schema | M4 output rows own restricted stream artifact metadata; M5 may later project/migrate into a canonical general Artifact model |

Exactly three new relational resources are proposed. This does not authorize
their creation.

## 5. Exact conceptual fields

### `provider_sessions`

| Field | Required / meaning |
|---|---|
| `id` | required canonical `psess_*` primary identity |
| `workspace_id`, `task_id`, `run_id`, `stage_id`, `stage_attempt` | required Workspace isolation and exact current M3 Task/Run/Stage owner; Stage/attempt required for primary Provider Session |
| `authority_role` | required; first-schema value `primary-provider`; participates in exactly-one claim |
| `agent_id` | required frozen Agent identity from the accepted Run snapshot; physical FK uses existing `(workspace_id, id)` Agent primary key |
| `provider_config_id`, `provider_config_version` | required canonical configuration snapshot binding |
| `provider_type` | required canonical value such as `kimicode`; never legacy `kimi` |
| `adapter_id`, `adapter_version`, `config_schema_version` | exact Adapter/config compatibility binding used by execution/replay |
| `runtime_mode` | required `cli`, `api`, `ssh`, or `container`; first slice uses `cli` |
| `native_session_id` | optional Provider-native identity; restricted diagnostic, never AgentOS Session identity |
| `status` | required Runtime Specification vocabulary: `starting`, `active`, `waiting`, `paused`, `completed`, `failed`, `cancelled` |
| `claim_epoch`, `claim_owner_id`, `claim_lease_expires_at` | required positive Stage-attempt authority fence epoch; owner/deadline nullable outside an active claim; owner is service identity, never browser identity |
| `adapter_start_requested_at` | nullable one-way external-call marker; CAS-set once immediately before Adapter start and never cleared/reused |
| `capabilities_json` | required validated frozen capability manifest; no secret values |
| `error_code`, `error_detail_redacted` | nullable terminal/diagnostic stable code and safe detail |
| `started_at`, `last_activity_at`, `completed_at` | nullable canonical UTC milliseconds according to state |
| `version` | required positive CAS version starting at 1 |
| `created_at`, `updated_at`, `archived_at` | created/updated required canonical UTC milliseconds; archive marker nullable and cannot delete evidence |

The conceptual pre-reservation Session state is `created`; the first durable
row is `starting`. For a process-backed Adapter it is inserted in the same
transaction as the root Process `created` reservation; API/remote mode inserts
only the Session claim. `active` means the Adapter/Session is active; it is not
a Process `running` alias. Recovery uncertainty remains on Process facts and
`runs.recovery_required`; Session state is never changed to an invented
`unknown`. Session does not store `process_id`; Process lookup uses
`runtime_processes.provider_session_id`, avoiding a cyclic ownership FK and
allowing a Session to span more than one Process.

### `runtime_processes`

| Field | Required / meaning |
|---|---|
| `id` | required canonical `proc_*` primary identity allocated before spawn |
| `workspace_id`, `task_id`, `run_id`, `stage_id`, `stage_attempt` | Workspace/Task/Run required by current M3; Stage/attempt required for a root Provider Process |
| `provider_session_id` | required for Provider root; nullable for later non-Provider Process types |
| `parent_process_id` | nullable self-reference for managed child hierarchy |
| `authority_role` | nullable except root Provider; first-schema root value `primary-provider` |
| `claim_epoch`, `claim_owner_id`, `claim_lease_expires_at` | required positive Process-start fence epoch for process-backed execution; owner/deadline nullable outside active claim; owner is service identity, never browser identity |
| `process_type` | required: `provider`, `tool`, `command`, `git`, `test`, `system`, or `extension`; first M4 slice uses `provider` |
| `platform` | required normalized platform/capability family |
| `status` | required exact state from runtime contract: `created`, `starting`, `running`, `waiting`, `stopping`, `exited`, `failed`, `orphaned`, `unknown` |
| `executable_resolved`, `executable_fingerprint`, `args_redacted_json`, `cwd_resolved` | required validated/redacted launch identity; fingerprint nullable until resolved where platform cannot provide it |
| `shell`, `detached`, `stdin_mode`, `stdout_mode`, `stderr_mode` | required launch controls; booleans constrained to 0/1 |
| `timeout_policy_json`, `security_profile_ref` | required frozen safe policy/ref; no resolved secrets |
| `native_pid`, `native_parent_pid`, `native_started_at` | nullable until spawn; PID positive; native start time is identity evidence, not Process start time |
| `process_group_id`, `tree_ownership_mode`, `platform_handle_id` | nullable native ownership diagnostics; handle ID is not a reusable native handle |
| `recovery_token_hash`, `recovery_classification`, `recovery_evidence_json`, `recovery_checked_at`, `recovery_classifier_version` | hash and redacted evidence only; classification nullable or same/missing/mismatch/unknown |
| `started_at`, `ready_at`, `last_activity_at`, `stopping_at`, `exited_at` | canonical UTC milliseconds allowed by state |
| `exit_code`, `exit_signal`, `termination_reason` | terminal native facts; exit code signed/native normalized evidence may be internal metadata |
| `cleanup_result`, `survivor_pids_redacted_json` | nullable; result vocabulary from runtime contract; PID list restricted |
| `error_code`, `error_detail_redacted` | nullable stable Process error and safe detail |
| `version` | required positive CAS version starting at 1 |
| `created_at`, `updated_at`, `archived_at` | created/updated required canonical UTC milliseconds; archive marker nullable |

### `process_output_references`

| Field | Required / meaning |
|---|---|
| `process_id`, `stream` | composite primary identity; stream exactly `stdout` or `stderr` |
| `workspace_id`, `run_id` | required denormalized isolation keys, enforced by composite Process FK |
| `artifact_id` | required unique canonical `artifact_*`; this row owns M4 stream-artifact metadata and does not reference old `runtime_artifacts` |
| `storage_key` | required opaque managed-sink key; restricted, never an arbitrary client path |
| `content_type`, `encoding` | required classification; encoding may be `binary` when text decoding is unsafe |
| `access_classification` | required `restricted` in first schema |
| `redaction_mode` | required `scan` or `strict`; `none` is not allowed for M4 Provider output |
| `source_bytes_seen`, `retained_bytes`, `next_source_offset`, `segment_count` | required non-negative monotonic counts; offset is in original stream bytes; segment count is zero before bytes and counts managed immutable segments |
| `truncated`, `truncation_reason`, `finalized` | required boolean flags plus nullable bounded reason; finalized is terminal |
| `sha256` | nullable until finalization; then lowercase 64-hex hash of retained bytes |
| `version` | required positive CAS version starting at 1 |
| `created_at`, `updated_at`, `finalized_at`, `archived_at` | canonical UTC milliseconds; finalized time required when finalized; archive marker nullable |

Raw bytes live in the managed append-only sink keyed by `artifact_id` and
`storage_key`, not as a database BLOB or unbounded string. `storage_key` locates
the logical stream manifest; rolling segments are internal immutable children
ordered by that manifest, and the final hash covers their retained-byte
concatenation.

### Per-entity requirement coverage

| Requirement | Provider Session | Runtime Process | Output Reference |
|---|---|---|---|
| primary identity | `psess_*` | `proc_*` | `(process_id, stream)` plus unique `artifact_id` |
| Workspace / Run / Stage | direct required ownership | direct required ownership for current M4; exact rules by process type | denormalized Workspace/Run plus Process composite FK; Stage via Process |
| Provider Configuration | direct ID + version + Adapter freeze | indirect mandatory for Provider Process through Session | indirect through Process -> Session |
| state / CAS | specification Session state + `version` | exact Process state + `version`/claim epoch | truncation/finalization state + `version`/monotonic offsets |
| PID/native identity | Provider-native Session ID only; PID intentionally not owned | PID/start/executable/token/group/tree evidence | not applicable; never stores PID |
| termination | Session completed/failed/cancelled status, code/detail/time | exit/signal/reason/cleanup/survivors/error/time | finalized/truncated/reason/hash/time |
| recovery | no invented Session recovery state; Process Events + M3 uncertainty own it | classification/evidence/check time/version | durable offsets/finalized/hash permit artifact recovery scan |
| Artifact references | terminal Events reference Session artifacts; no first-schema list | output rows reference Process; terminal Events carry Artifact IDs | owns stream `artifact_id`, manifest storage key, segments/counts/hash |
| indexes/uniqueness | exact list in section 6 | exact list in section 6 | exact list in section 6 |
| immutability/delete | terminal immutable; archive + `RESTRICT` | terminal immutable; archive + `RESTRICT` | finalized immutable; archive + `RESTRICT` |
| sensitivity | native Session/error evidence restricted; no secrets | native/recovery/tree facts restricted; no secrets | bytes/storage key restricted; scan/strict before persistence |
| fresh/upgrade/rollback | additive empty rowset; no backfill; forward evidence preservation | same | same |

## 6. Constraints

1. IDs must match existing canonical ID kinds and be non-empty.
2. Workspace/Run/Stage/Task ownership must be mutually consistent through
   composite keys; `stage_attempt` must equal the referenced Stage attempt.
3. Exactly one primary Provider Session exists for each `(workspace_id, run_id,
   stage_id, stage_attempt, authority_role)`. A CLI/process-backed primary
   Session has exactly one root Process claim with that key; an API/remote
   Session may have none and must not fabricate a Process.
4. A primary Provider Process requires `provider_session_id`, has no parent, and
   uses the same Run/Stage/attempt as its Session. A Session may later span
   multiple non-root child/replacement Processes only under a separately frozen
   attempt/resume contract; the initial root claim remains unique.
5. Child Process cannot be its own parent and must share Workspace/Run with its
   parent; cycle prevention is repository-validated within one transaction.
6. `created` has no PID/native start; `running` requires PID, native start and
   `started_at`; terminal time/fields obey state rules from the runtime contract.
   Session `active` requires `started_at`; `completed`, `failed` and `cancelled`
   require `completed_at`; terminal Session states cannot transition.
7. `failed` after registration failure may retain historical PID only when
   cleanup result proves no survivor; otherwise state is `orphaned`/`unknown`.
8. Session authority and Process-start claim epochs and all versions are
   positive; every mutation increments exactly once under expected-version/
   fence checks. A stale Session owner cannot call Adapter start even when no
   Process exists. Once `adapter_start_requested_at` is non-null, no owner may
   invoke Adapter start again for that Session claim.
9. Output counters/offsets are monotonic; retained bytes never exceed source
   bytes seen; finalized references cannot append.
10. Secret values, raw arguments, full environment, recovery token and raw
    stderr are prohibited from relational fields.
11. JSON fields must be canonical, valid, size-bounded and schema-validated.
12. All timestamps use UTC ISO 8601 milliseconds and obey temporal ordering.

Conceptual indexes are exact requirements, with names deferred to the future
migration package:

| Entity | Uniqueness / indexes |
|---|---|
| `provider_sessions` | primary ID; supporting unique `(id, workspace_id, run_id)`; unique authority `(workspace_id, run_id, stage_id, stage_attempt, authority_role)`; indexes `(workspace_id, run_id, created_at, id)`, `(workspace_id, status, updated_at, id)`, `(provider_config_id, provider_config_version, created_at, id)`, and non-unique `(workspace_id, provider_type, native_session_id)` when native ID exists |
| `runtime_processes` | primary ID; supporting unique `(id, workspace_id, run_id)`; partial unique root claim `(workspace_id, run_id, stage_id, stage_attempt, authority_role)` where parent is absent and authority role exists; indexes `(workspace_id, run_id, created_at, id)`, `(workspace_id, stage_id, stage_attempt, created_at, id)`, `(workspace_id, status, updated_at, id)`, `(provider_session_id, created_at, id)`, `(parent_process_id, created_at, id)`, and non-unique `(platform, native_pid, native_started_at)` |
| `process_output_references` | composite primary `(process_id, stream)`; unique `artifact_id`; indexes `(workspace_id, run_id, process_id, stream)` and `(workspace_id, finalized, updated_at, process_id)` |

The future additive migration must also add supporting unique keys
`provider_configurations(id, workspace_id)`,
`runs(id, workspace_id, task_id)`, and
`run_stages(id, workspace_id, run_id, attempt)`. Existing
`agent_profiles(workspace_id, id)` already provides its named parent key. These
support indexes change no existing row semantics and are part of the same later
schema authorization, not additional entities.

## 7. Relationships/FKs

| From | To | Required? | Delete behavior |
|---|---|---:|---|
| Session Workspace | `workspace_id -> workspaces.id` | yes | `RESTRICT`; runtime evidence is archived, not cascade-deleted |
| Session Task/Run | `(run_id, workspace_id, task_id) -> runs(id, workspace_id, task_id)` using the supporting parent unique key | yes | `RESTRICT` |
| Session Stage | `(stage_id, workspace_id, run_id, stage_attempt) -> run_stages(id, workspace_id, run_id, attempt)` using the supporting parent unique key | yes for the primary Stage Session | `RESTRICT` |
| Session Provider Config | `(provider_config_id, workspace_id) -> provider_configurations(id, workspace_id)` using the supporting unique key; config version is checked against the frozen Run snapshot | yes | `RESTRICT`; configs archive instead of delete |
| Session Agent | `(workspace_id, agent_id) -> agent_profiles(workspace_id, id)` and equality with the frozen Run Snapshot Agent | yes | `RESTRICT` |
| Process Workspace | `workspace_id -> workspaces.id` | yes | `RESTRICT` |
| Process Task/Run | `(run_id, workspace_id, task_id) -> runs(id, workspace_id, task_id)` using the supporting parent unique key | yes in current M4 | `RESTRICT` |
| Process Stage | `(stage_id, workspace_id, run_id, stage_attempt) -> run_stages(id, workspace_id, run_id, attempt)` | yes for primary Provider Process; later process types follow their frozen contract | `RESTRICT` |
| Process Provider Session | `(provider_session_id, workspace_id, run_id) -> provider_sessions(id, workspace_id, run_id)` using the supporting parent unique key | Provider Process yes | `RESTRICT` |
| Process parent | `(parent_process_id, workspace_id, run_id) -> runtime_processes(id, workspace_id, run_id)` using the supporting parent unique key | no | `RESTRICT`; child evidence must be archived first |
| Output Process | `(process_id, workspace_id, run_id) -> runtime_processes(id, workspace_id, run_id)` using the supporting parent unique key | yes | `RESTRICT`; no output evidence deletion through Process deletion |

`runtime_events.process_id`, `provider_session_id`, and `artifact_id` remain
logical references in the append-only M3 table during M4. Adding physical FKs
would require rebuilding that accepted Event table and create avoidable
migration risk. The Event append service must validate referenced M4 resources,
Workspace and Run within the same transaction. A future Event schema revision
may add physical FKs only under separate authorization.

## 8. CAS/version model

- Session, Process and output-reference versions start at 1. Session and
  process-backed root Process claim epochs start at 1.
- Every mutable command supplies `expectedVersion`; Adapter start supplies the
  Session `expectedClaimEpoch`/owner, and process-backed spawn additionally
  supplies the root Process `expectedClaimEpoch`/owner.
- The same Session CAS that validates owner/epoch sets
  `adapter_start_requested_at` exactly once before the external Adapter call.
  Crash before/after that call is recovered as uncertain, never by clearing the
  marker or invoking start again.
- Updates match primary ID, Workspace, expected version, allowed source state
  and, where applicable, claim epoch/owner in one statement/transaction.
- Zero affected rows is classified as not-found, workspace mismatch, version
  conflict, fence conflict or invalid transition by a follow-up scoped read; it
  never retries a spawn implicitly.
- Session claim and, when process-backed, root Process initial row, uniqueness,
  first Event sequence, Event and Outbox are one SQLite transaction before
  Adapter start/OS spawn.
- OS spawn is outside the transaction. Success updates native identity through
  CAS; failure compensates to terminal `failed`; registration persistence
  failure triggers immediate verified tree termination and durable recovery
  evidence on the next available transaction.
- Output reference checkpoints use expected version plus monotonic offsets;
  duplicate checkpoint at the same offsets is idempotent.

## 9. Terminal immutability

Process `exited`/`failed`, Provider Session `completed`/`failed`/`cancelled`, and
a finalized output reference are immutable execution facts. After terminal state:

- no state, claim, native identity, launch, Provider binding, exit, error,
  offsets, artifact identity or checksum may change;
- archival metadata may be added only through a separate retention contract;
- later diagnostics/recovery attempts append Runtime Events instead of editing
  historical terminal facts;
- duplicate terminal observation reads and returns the existing result;
- inconsistent later evidence creates a restricted integrity diagnostic and
  stop condition, never an overwrite.

`orphaned` and `unknown` are non-terminal because later evidence may classify
them, but each transition still uses CAS and preserves prior evidence in Events.

## 10. Recovery identity

Durable recovery identity is AgentOS Process ID plus a platform-sufficient
combination of native PID, native start time, normalized executable
identity/fingerprint, recovery-token hash, parent/group/job metadata and
classifier version. PID alone is prohibited.

`recovery_evidence_json` is a bounded restricted summary of which checks were
performed and matched; it contains no raw token, environment, command line, or
unbounded OS dump. Classification is only same, missing, mismatch, or unknown
for the M4 minimum. It is accompanied by a durable classification Event and
interacts with existing `runs.recovery_required`; no separate Recovery Record
table is needed.

## 11. Raw output references

Each Process can have at most one `stdout` and one `stderr` reference. Both are
created before or with first retained bytes and append independently. The sink
uses original-stream byte offsets, incremental decoding, pre-persistence secret
scan, bounded flush/checkpoints, final SHA-256, and an opaque storage key.

Ordinary Runtime Events contain only artifact ID, stream, through-source offset,
retained-byte count, truncation/finalization flags and a safe bounded summary.
They never contain raw output or hidden reasoning. Reconnect/query resumes from
the durable reference; it does not require the old live handle.

The M4 output row is the canonical metadata owner for its restricted artifact.
It deliberately has no FK to old `runtime_artifacts`. A later M5 Artifact model
may import/project this identity without changing Process offsets or hashes.

## 12. Data sensitivity

| Data | Classification / persistence rule |
|---|---|
| Provider/Adapter/config identity and versions | internal/public diagnostic as API permits; durable |
| native PID/group/survivor list/start identity | restricted; durable only as needed for recovery/audit |
| executable/cwd | internal/restricted; normalized and workspace-safe |
| redacted arguments / environment key metadata | internal; durable and bounded; no values for secret keys |
| original arguments, resolved secret values, recovery token | ephemeral memory only; never persisted |
| recovery token hash | restricted durable; one-way hash with suitable random token |
| native Session ID | restricted durable when Provider supplies it |
| raw stdout/stderr retained bytes | restricted managed sink; scan/strict redaction before persistence |
| output storage key | restricted opaque locator; never public filesystem path |
| safe summaries and stable errors | public/internal according to Event/API contract; no raw stderr |

Workspace authorization applies before every read or mutation. Cross-workspace
not-found behavior must not reveal resource existence.

## 13. Upgrade/fresh DB implications

Fresh database after a separately authorized migration would create exactly the
three empty resources and their constraints/indexes after migrations 001–013,
plus the three supporting unique keys on existing parent tables defined in
section 6. No default Provider Session/Process/output rows or secret material is
seeded.

Upgrade from any valid 001–013 database is additive:

- create the same three empty resources/indexes and supporting parent unique
  keys after proving existing rows satisfy uniqueness;
- perform no scan/backfill of old `agent_runs`, `executions`,
  `run_cli_invocations`, old runtime artifacts or historical Event references;
- preserve all existing checksums/rows and M3 Event/Outbox semantics;
- new canonical execution writes only after application compatibility gate;
- old paths remain compatibility-only until their separately authorized phase.

Required future evidence is fresh DB, every supported 001–013 upgrade shape,
foreign-key check, constraint/CAS/race tests, migration checksum/registry test,
backup/restore, old-path compatibility, and forward-version refusal.

## 14. Rollback/forward boundary

Before any production writes, an authorized deployment may roll application
code back while leaving empty additive resources. After any Session/Process or
output evidence is written, rollback is forward-only application correction or
authorized backup restore. It is never silent table drop, row deletion, schema
downgrade, Event rewrite, ID reuse, or mapping into old Conversation tables.

The future migration package must declare the minimum application version that
understands these resources, deployment order, backup point, failure recovery,
and whether old binaries may open the upgraded database. P0 approves none of
those operational actions.

## 15. Migration necessity verdict

Migrations 001–013 cannot represent a durable Process reservation distinct from
PID, exactly-one active Stage-attempt claim, Provider Session/Adapter freeze,
native recovery/tree/terminal facts, or per-stream append offsets. Optional
Event references are not mutable resource state. Therefore a future additive
migration is technically necessary before P2 can implement this contract.

This is a design verdict, not migration authorization.

## 16. Explicit Migration 014 prohibition

```text
Migration registry: 001–013

Migration 014:
NOT CREATED
NOT AUTHORIZED
NOT RESERVED
NOT ALLOCATED BY P0
```

P0 defines no SQL, migration filename, registry entry, checksum, number, or
execution order. A later exact schema/migration package requires its own base,
file scope, DDL, tests, independent review and explicit entry authorization.

## 17. Owner Decision requirements

```text
CURRENT OWNER DECISION COUNT = 1
OWNER DECISIONS REQUIRED BEFORE M4-P1 = 0
OWNER DECISIONS REQUIRED BEFORE M4-P2 SCHEMA = 1
```

The three-resource additive design, restrictive output classification,
`RESTRICT` deletion, no-backfill policy and forward-only evidence preservation
follow technical safety and accepted M3 invariants. They are the recommended
technical design. However, once production rows exist, accepting the new
minimum compatible database and forward-only evidence-preservation boundary is
an irreversible data/compatibility commitment. Technical evidence can recommend
it but cannot grant Owner authority.

`OD-M4-01` therefore remains `UNDECIDED` and is required before any P2 schema or
migration file is created. It does not block P1. A separate P2 entry
authorization is also mandatory after the Owner decision and independent schema
review; neither one implies the other. P0 selects no option and authorizes no
migration.

SCHEMA_PROPOSAL_REQUIRES_FUTURE_MIGRATION
