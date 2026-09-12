# S2 / 027 implementation authorization (frozen v1)

Requirements: LITE-07-104 and LITE-07-108; source counterevidence:
S2-ARTIFACT-SOURCE. Authority: user's approved tightened implementation plan;
main-agent schema/causation freeze after inspecting the actual production
and preserved draft. Base a1f00f42; 001-026 remain byte-identical. Original
uncommitted 027 files remain untouched; reuse their table and completion model
in the isolated S2 worktree with the corrections below.

## Persistence and atomic boundary

027 adds artifact_completions only (plus its indexes/triggers). Fields: id,
workspace_id, artifact_id, artifact_type, run_id (CANONICAL only, nullable),
conclusion, candidate_id, source_key, decided_at, created_at. All are immutable.
Unique artifact_id and unique (workspace_id, source_key) bind repeat finalization
to one completion/Candidate. candidate_id is unique and references the candidate
table. Artifact/Workspace/candidate FKs follow existing deletion semantics;
source deletion may make historical navigation unavailable, never authorize a
replacement source. No backfill or historical migration modification.

CHECK pairs review with approved/changes_requested and test with pass/fail.
Before insert, source validation proves the persisted Artifact's Workspace,
type and canonical_run_id; a LEGACY Artifact has no canonical Run. Candidate
and Artifact source must belong to the same Workspace. Repository inputs never
override these facts. Any supplied type/Run assertion must match the real row.
Source/Candidate/completion/Event (and canonical Outbox) share one transaction.
Artifact content is materialized before its DB transaction; failed creation
cleans its new directory, and a file is not considered complete without the
committed completion. Replay emits nothing; conflicting conclusion/source key
is rejected with a stable conflict code, not silently overwritten.

## Event contract

- Reuse existing memory.candidate_created payload and registry definition.
- Add it to Workspace allowlist ONLY for a new memory.artifact_completion
  origin (completionId; immutable version 1). Authority and writer re-prove
  actual LEGACY Artifact + completion + exact same-Workspace Candidate and its
  Artifact source. Payload must describe that Candidate. Existing entry-save,
  review and conflict origins cannot use this new event capability.
- Canonical Artifacts use Runtime Event + Outbox with actual same-Run durable
  operation/event provenance. Add a narrow caller-owned-transaction emission
  seam for an already persisted Candidate; keep existing creation paths intact.
- Automatic completion remains agent-derived and review-required. Artifact
  source is mandatory. Canonical Run is an additional source only when real.
  Completion is not approval to become an Entry or authorization to execute.

## Production lifecycle

1. Reuse RuntimeArtifactCollector's actual tool-completed producer. Typed test
   artifacts may finalize automatically only for an unambiguous direct test
   invocation with a completed tool result. Shell composition/echo/wrapper
   success cannot be reinterpreted as a test verdict; retain ordinary report
   behavior when ambiguous. Stable source key uses actual Execution/call id.
2. Reuse canonical artifact persistence and the canonical Stage result path.
   Review/test finalization requires an explicit bounded structured final
   result contract (type/conclusion/summary), never a Stage-name or exit-code
   guess. Unknown/invalid results remain unfinalized; no auto-approval.
3. Completion API is a reuse/finalization surface, not sole lifecycle evidence.
   Return the actual source and replay result; wire production composition,
   review queue and existing source navigation. Do not create a replacement Run.

## Required tests and closure

Fresh and 026 upgrade, checksums, FK/type/source/Workspace checks, immutable
and concurrent unique records; source, completion, Event/Outbox failure rollback;
same replay and conflicting conclusion; no fake Run; actual producer -> typed
Artifact -> completion -> Candidate/Event -> queue -> accept -> Entry. Test
ambiguous commands and invalid review results explicitly. Source navigation
and actual runtime/provider invocation remain required for S2 PASS; fixtures
that only POST a completion never close the trigger. This authorization itself
does not mark any GAP or RUNTIME-VERIFY PASS.
