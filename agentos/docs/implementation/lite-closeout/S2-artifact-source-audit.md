# S2 production source audit (before migration 027 remediation)

Requirements: `LITE-07-104`, `LITE-07-108`. Inspection base:
`b61bc50314625c6fc1244f3affbb3c0e7935ed25`. Status: source counterevidence;
not implementation/acceptance evidence. Original Artifact draft remains in
`E:/workspace/Multi-Agent/agentos`, untouched. No schema modified here.

## Actual production seams

- `ConversationService.recordRuntimeEvent` sends normalized tool observations
  to `RuntimeArtifactCollector.recordRuntimeEvent`; completion/finalization
  flushes tracked artifact work. Collector already creates a **report** from a
  recognized test command's tool.completed event. This is the existing producer
  to extend, not an HTTP-only completion fixture.
- `RuntimeArtifactService.create` verifies actual legacy Run/Execution/Agent,
  materializes immutable content, then uses `SqliteStore.createRuntimeArtifact`.
  These rows are explicitly `provenance_kind = LEGACY` and their run_id refers
  to agent_runs, NOT canonical runs.
- `SqliteStore.createCanonicalRuntimeArtifact` is a separate existing path.
  It proves canonical Run/Workspace and optional Process/Operation/Stage
  references. Canonical and legacy read methods intentionally do not mix rows.
- The canonical dispatcher currently forwards coordinator artifactIds into
  lifecycle completion. It does not turn successful process completion into a
  typed review verdict or finalized test report. `StageExecutionOutcome.output`
  is not a trusted review conclusion merely because the Stage is named review.

## Draft defects confirmed from original uncommitted files

- Completion input trusts artifactType, Workspace and optional runId instead
  of re-deriving them from runtime_artifacts and its provenance kind.
- Migration 027's workspace/artifact index is not unique; replay can create a
  second completion and Candidate. Its conclusion check permits test/approved
  and review/pass. The completion-to-Candidate identity is not durable.
- The route assigns user-explicit, omits the actual Artifact source, and emits
  no memory.candidate_created. It cannot prove the required lifecycle loop.
- Current collector's test-name regex can match a command that merely mentions
  a test tool; tool success may also reflect a wrapper masking a test failure.
  Do not promote that heuristic to a canonical pass verdict without tightening
  the recognized invocation/evidence contract. Unknown outcomes must not be
  guessed. A completed review process similarly does not mean approved.

## Required next bounded design/implementation decisions

Before copying the draft, freeze the exact 027 DDL and source-specific event
contract in this directory. Reuse the draft/table, but require one completion
per actual Artifact, type-matched immutable conclusion and stable Candidate
association. Derive canonical Run only from CANONICAL provenance; never copy a
legacy run_id into canonical Run event fields or invent a new Run.

The Workspace candidate-created origin must prove immutable completion plus
same-Workspace Candidate plus actual Artifact source in one transaction. Its
payload must name that Candidate, not an arbitrary caller-supplied candidateId.
Run-bound canonical production uses the existing proven Runtime Event/Outbox
boundary. The event allowlist expansion must not authorize generic candidate
creation under entry-save or candidate-review origins.

Integrate the actual collector/finalizer, durable replay and failures before
counting the trigger. Preserve file/DB rollback and keep auto-generated
Candidates review-required. The real review/test -> Artifact -> completion ->
Candidate/Event -> queue -> accept -> Entry path (including source navigation)
remains the exit condition. Tests that only POST a completion cannot close it.

Migration 027 remains reserved; applied 001-026 checksums stay unchanged. No
Policy product, new workflow editor, fabricated execution or Provider framework
is authorized by this audit. Canonical review verdict capture and lifecycle
proof must be explicit, not inferred from a Stage label or successful exit.
