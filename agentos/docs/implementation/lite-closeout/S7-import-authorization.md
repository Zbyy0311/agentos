# S7 explicit Markdown import authorization (frozen v1)

Requirements: LITE-07-106, LITE-07-108. Authority: user-approved tightened plan
plus S1-workspace-candidate-contract.md. Base: S6 head `40265c7e` (stacked until
PR147/PR148 and S6 merge). Migration `030` is the next free number; 001–029 stay
unchanged.

## Fixed boundaries

- Import is user-selected only: a single UTF-8 Markdown file up to 1 MiB. No
  directory scan, no URL fetch, no remote content, no source-file mutation.
- Preview first, confirm second. The preview returns the bounded fragments and
  their source/hash metadata; nothing is persisted by the preview.
- Fragments are derived by Markdown heading; an oversized section is split
  further, and the fragment count is bounded. Parser version participates in
  the identity so a changed parser produces a new, traceable version.
- Idempotency: `(workspace_id, source_hash, fragment_index, parser_version)` is
  unique. Re-importing the same file converges on the existing record and
  creates no second Candidate or Event.
- Candidates are Workspace scope and review-required, authority
  `imported-verified`; the source file itself stays untouched on disk.
- Import produces one canonical Workspace Event per newly imported fragment
  under the new `memory.import` origin, proven against the persisted import
  record, its Candidate, and the `import` Candidate source. Run-scoped Runtime
  Events are not used and no Run is fabricated.
- No Memory redesign: the existing Candidate/Source/Entry review path is reused.

## Migration 030 contract

`memory_import_records`: immutable rows (`id`, `workspace_id`, `source_hash`,
`fragment_index`, `fragment_hash`, `parser_version`, `title`, `fragment_count`,
`byte_size`, `candidate_id`, `created_at`) with the unique idempotency tuple and a
same-Workspace Candidate FK. Rows are never updated or deleted by import.

This authorization is not implementation evidence; LITE-07-106/108 keep their
GAP state until their exits are demonstrated.

