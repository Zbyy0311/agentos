# S1-B design: non-Run candidate event provenance

Requirement: `LITE-07-108`; consumers `LITE-07-103/104/105/106`.
Status: design draft, not implementation evidence. Do not implement before
freezing the exact source-specific contract for the first real trigger.

## Observed gap

The Workspace Event allowlist has candidate review, but no candidate creation.
`DurableWorkspaceEventContextAuthority` proves candidate review, conflict
resolution or explicit entry save only. The existing accepted-decision route
writes a Candidate but no corresponding creation Event. The uncommitted
Artifact draft has the same gap and falsely assigns `user-explicit` authority
with no Artifact source when no Run is given.

## Intended narrow composition

- Keep the Run Event + Outbox and Workspace Event streams distinct. A known
  Run-bound trigger uses the existing Run emitter with proven durable causation.
  No-Run triggers never invent a Run or Operation.
- Register `memory.candidate_created` in the existing Workspace allowlist; reuse
  its existing payload schema. Do not create a second event store.
- A no-Run candidate's causal authority must prove BOTH the candidate row and
  the immutable source-specific completion/decision/import/compaction record
  in the same Workspace and transaction. A candidate ID alone is not proof
  that a meaningful transition occurred. No generic caller-provided source kind.
- Shared payloads carry IDs/category/scope/decision, not source content, paths,
  prompts, credentials or raw output. Unknown and cross-Workspace sources fail
  closed. Source-specific additions are registered with their migration slice.
- Candidate, sources, meaningful transition, Event and sequence must roll back
  together. Stable trigger IDs converge before emission; duplicates emit nothing.
- Automatic output remains `agent-derived` (or evidenced system fact authority)
  and review-required. Accepting the candidate is a separate existing review
  transaction; it does not prove or retroactively authorize execution.

## Sequencing constraints

027 remains reserved for the preserved Artifact draft. The accepted plan
supersedes its older awaiting-owner status, but its schema must be corrected
and re-frozen before copying any draft source into the closeout branch.
Do not alter applied 001–026 migrations. Later approval/compaction/import
migrations must take the next verified free number serially.

Test the first registered no-Run source on the real lifecycle path, including
review→Entry and a failed Event append. Infrastructure-only POST evidence
cannot close a trigger's matrix row.
