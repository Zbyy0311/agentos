# Immutable injected Memory content: additive correction design

Status: design for implementation; no migration added by this document.
Audit base: `800d6dd2`; see `MF-integration-reaudit.md` finding 2.
Authority: Lite 07 sections 12 and 14 and the ongoing Lite implementation task.

## Required behavior

The text returned for Provider injection must be the exact text committed with
the snapshot. Replaying any earlier Run/Stage must recover that text after an
Entry is edited, archived or removed. A legacy snapshot without frozen text
must fail closed for injection rather than silently reconstruct new content.
Legacy snapshot inspection remains available.

## Persistence design

The next available migration is 024 at the audit base; recheck the registry
before implementation. Add `memory_context_snapshot_payloads` with:

```sql
CREATE TABLE memory_context_snapshot_payloads (
  snapshot_id TEXT NOT NULL PRIMARY KEY,
  context_text TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  FOREIGN KEY (snapshot_id) REFERENCES memory_context_snapshots(id)
);
```

Add UPDATE and DELETE rejection triggers for this table. Do not edit any old
migration or backfill old snapshots from current Entry content. Store only the
bounded selected Memory text already eligible for injection, never raw Provider
output. The header, selections, exclusions and payload must commit in the same
transaction. The repository computes the payload hash and verifies it on read.
No filesystem artifact is needed, avoiding a second commit boundary.

## Integration

The budget selector assembles text once from its selected Entries and passes it
into snapshot creation. It returns the persisted payload, including the empty
string for an empty selection. The resolver reuses this persisted payload and
does not read live Entries. Missing payload and hash mismatch block injection.
Snapshot lookup filters workspace, Run and nullable Stage exactly and orders
matching snapshots deterministically; a newer different Stage cannot hide an
earlier snapshot. Inspector reads may expose payload availability separately
without converting missing historical content into an empty injected context.

## Verification

- Fresh and 023-to-024 additive upgrade; repeated migration and prerequisite
  failure; unchanged historical checksums and no payload backfill.
- Payload insert failure rolls back header and selection rows.
- UPDATE/DELETE rejection, wrong-workspace lookup and hash mismatch rejection.
- First injection equals replay after modifying/deleting the underlying Entry.
- Replay of Stage A after Stage B reuses A's original snapshot and payload.
- Empty selection yields a persisted empty payload and remains replayable.
- Historical snapshot remains inspectable but cannot inject without payload.
- Focused resolver, snapshot, budget and dispatcher tests, TypeScript and CI.
