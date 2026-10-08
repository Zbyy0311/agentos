# M2 memory management and preference confirmation

M2 extends M1 without changing historical context payloads or Lite receipts.
The memory center combines canonical Entries, Candidate review, conflict
resolution, source evidence, preference suggestions and frozen usage records.
Lifecycle changes require `expectedVersion` and append immutable before/after
audit records in the same transaction as the Entry and Workspace Event.
Archive, restore, explicit validity dates, revalidation and soft deletion affect
future selection only. Revalidation preserves dates rather than extending them.

Learned preference projections never inject text or record a successful
application. Migration 044 copies existing projections into pending suggestions
with their evidence; it leaves the old projections and application history
intact. Confirmation creates a user-explicit canonical preference Entry. Global
confirmation requires `confirmGlobal: true`; otherwise confirmation applies in
the selected workspace. Later learning creates a new pending suggestion rather
than changing a confirmed Entry. Revocation archives the bound Entry only when
its version has not changed since binding, preserving concurrent user edits.

Retrieval validates confirmed bindings and scene tags before ranking. For a
dimension, workspace preferences take precedence over global defaults; within
the same scope, scene-specific preferences take precedence over general ones.
Unbound explicit Entries with scene tags obey those tags. The current user's
instruction takes precedence over all historical preferences in chat, canonical
Run and compatibility execution prompts.

New management routes remain workspace-scoped:

- `POST /memory/entries/:entryId/lifecycle`
- `GET /memory/conflicts` and the existing conflict resolve route
- `GET /preferences/suggestions`
- `POST /preferences/:projectionId/confirm|reject|revoke`

Lifecycle and preference writes reject stale versions. Invalid fields, foreign
workspace access and audit/event failures leave the entire transaction unchanged.
The UI refreshes stale versions and preserves workspace isolation for delayed
responses. Preference evidence is loaded on demand and links to its source Run.

Validation separates unit/HTTP prompt capture from real Provider acceptance.
The M1 real Codex receipt applies only to its recorded commit; M2 does not
relabel that receipt as a new real Provider run. Browser checks target the local
disposable `memory-qa` workspace at `http://127.0.0.1:3221`: project knowledge,
archive/restore, frozen history, pending preference confirmation/revocation,
keyboard confirmation controls, desktop and mobile layout. Model execution is
not part of those Browser checks.

Run the server, Web, shared contract tests and workspace build, and require
terminal CI success for the M2 PR before merging.
