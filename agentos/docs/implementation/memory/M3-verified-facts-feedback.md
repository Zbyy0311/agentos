# M3 verified facts and version feedback

The default workspace policy automatically accepts a bounded whitelist of facts:
test results from the server acceptance runner, observed runtime platform, and
known failure codes. All facts retain task scope. Durable Run, process/session,
snapshot, event, environment and commit identities are checked on the server.
Model-authored confidence or content is not an input to the verified-fact API.
Inferences, preferences, global scope and expanded scope remain review-required.

Migration 046 adds workspace policy CAS, immutable fact receipts, and immutable
collaboration test-runner receipts. A runner receipt binds the actual process
result and output hash to the frozen candidate HEAD. Candidate mutation or a
missing receipt prevents automatic acceptance. Deduplication, conflict checks,
the Candidate/Entry, Runtime Event/Outbox and receipt share a transaction.
Terminal dispatch and a bounded startup reconciler accumulate from durable
terminal events; failures do not alter the committed Run outcome. Disabled
workspace memory rejects accumulation.

Migration 047 adds immutable version feedback and correction/revalidation
actions. `helpful`, `wrong` and `outdated` refer to an actual frozen selection and
its entry version. `expectedVersion` checks the current Entry independently.
Feedback never replaces old context text; wrong/outdated queue review actions.
Resolving/rejecting an action uses CAS and writes an immutable transition audit.
Explicitly confirmed global Entries can receive feedback from a workspace that
actually selected them, retaining the origin Entry's ownership.

Routes under `/api/workspaces/:workspaceId`:

- `GET|POST /memory/feedback`
- `GET /memory/feedback-actions`
- `POST /memory/feedback-actions/:id/resolve`
- `GET|POST /memory/auto-accept-policy`

The use-record UI submits feedback on the frozen selected version. The memory
center exposes the resulting actions and workspace policy. Old compatibility
store selections remain distinguishable and cannot impersonate canonical Entries.

Acceptance includes source forgery, commit/output mismatch, immutable receipts,
disabled memory, dedup/conflicts, four context kinds, scope isolation, secret
comments, stale versions and rollback. Prompt capture, unit/HTTP and Browser
checks are distinct from real Provider execution. Full server/Web/shared tests
and workspace builds must pass in terminal CI on the PR head before merging.
Historical Lite receipts are unchanged.
