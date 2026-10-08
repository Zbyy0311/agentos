# MF-2 — Review/Test Artifact Trigger: Audit and Schema Authorization Package

Status: AWAITING OWNER DECISION — no implementation authorized by this document.

Base: `origin-https/main @ ca000d63` (post PR #140). Read-only seam inventory
verified against source at that revision.

## 1. Authorization basis and scope

`MF2-triggers-audit.md` (PR #135) listed the remaining MF-2 candidate-generation
triggers. This package addresses the "completed review or test Artifact"
trigger. Compaction and explicit import are NOT in scope.

## 2. Problem statement (source evidence)

The Artifact model has no review or test type, and no completion seam:

- `RuntimeArtifactType` (`packages/shared/src/types/index.ts:362`) is
  `'file' | 'diff' | 'report' | 'image' | 'log' | 'archive' | 'manifest'` — no
  `review`, no `test`.
- `RuntimeArtifact` (`index.ts:367-382`) has no lifecycle field — nothing marks
  an Artifact as completed, so there is no "completed review/test Artifact"
  moment to hang a trigger on.
- `RuntimeArtifactService.create` (`apps/server/src/services/RuntimeArtifactService.ts`)
  writes an Artifact but has no completion or review/test branch.

So the trigger needs BOTH a new Artifact type AND a completion seam. That is a
schema + contract change, which is why it is a separate authorization.

## 3. Design constraints (frozen)

- Migrations are additive and immutable; `027` appends, never edits `001`–`026`.
- The shared `RuntimeArtifactType` union is extended additively; no existing
  type is renamed or removed, and no consumer that pattern-matches on the old
  set is broken.
- A review/test Artifact record carries no secret value and no raw output.

## 4. Proposed migration number

`027`. `026` is the last registered migration
(`apps/server/src/migrations/M2MigrationRegistryAcceptance.test.ts:7`).

## 5. What this slice needs (two pieces)

### 5.1 Shared contract: extend `RuntimeArtifactType`

Add `'review'` and `'test'` to the union. This is a shared-type change, not a
migration; every existing Artifact type keeps its meaning.

### 5.2 Completion seam + trigger

A review/test Artifact is "completed" when a reviewer or a test run finalizes
it. Because `RuntimeArtifact` has no lifecycle field, the slice adds a durable
completion record keyed to the Artifact, written inside one transaction with
the Candidate it generates.

A new additive table (migration 027):

```sql
CREATE TABLE IF NOT EXISTS artifact_completions (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
  artifact_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('review','test')),
  run_id TEXT,
  conclusion TEXT NOT NULL CHECK (conclusion IN ('approved','changes_requested','pass','fail')),
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id) REFERENCES runtime_artifacts(id) ON DELETE CASCADE
);
```

The trigger: a completed review/test Artifact generates one review-required
Candidate (the conclusion, the Artifact id, and the Artifact type as evidence)
in the same transaction as the completion record.

## 6. Acceptance matrix (proposed)

| Gate | Requirement |
|---|---|
| AR-01 | Fresh DB applies `001`–`027` in order; upgrade from `026` is additive |
| AR-02 | `RuntimeArtifactType` gains 'review'/'test'; existing types unchanged |
| AR-03 | A completed review/test Artifact writes the completion record and one review-required Candidate in one transaction |
| AR-04 | The completion record is immutable once written |
| AR-05 | The record carries no secret value and no raw output |
| AR-06 | Non-review/test Artifact types are unaffected |

## 7. Explicit prohibitions

- No edit to migrations `001`–`026` or their checksums.
- No destructive rebuild, no backfill.
- No secret value storage; no raw output.
- No removal or rename of an existing Artifact type.
- No change to the legacy surfaces.

## 8. Deferred follow-ups (recorded, not authorized)

1. Conversation compaction (a whole feature) is a separate authorization.
2. Explicit import (Markdown import into Candidates) is a separate
   authorization.
3. Whether a review/test Artifact should also appear in the Inspector is a
   separate authorization.
