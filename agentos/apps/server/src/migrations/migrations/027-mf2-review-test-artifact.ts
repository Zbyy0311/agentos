import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/**
 * MF-2 review/test Artifact completion (authorization: PR #142,
 * `docs/implementation/milestones/MF2-review-test-artifact.md`).
 *
 * Additive only: one table. `artifact_completions` is the durable record that a
 * review or test Artifact was completed (approved / changes_requested / pass /
 * fail) — the seam the MF-2 "completed review or test Artifact" candidate
 * trigger needs, because `RuntimeArtifact` itself has no lifecycle field. The
 * row is immutable once written and leaves with its Workspace (FK CASCADE) and
 * its Artifact (FK CASCADE). It carries the conclusion, the Artifact id, and
 * the Artifact type only; never a secret value or raw output.
 */
export const MF2_ARTIFACT_027_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS artifact_completions (
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
  )`,
  `CREATE INDEX IF NOT EXISTS artifact_completions_workspace_artifact
  ON artifact_completions (workspace_id, artifact_id)`,
  `CREATE INDEX IF NOT EXISTS artifact_completions_workspace_decided_at
  ON artifact_completions (workspace_id, decided_at)`,
  `CREATE TRIGGER IF NOT EXISTS artifact_completions_reject_update
  BEFORE UPDATE ON artifact_completions
  BEGIN
  SELECT RAISE(ABORT, 'ARTIFACT_COMPLETION_IMMUTABLE');
  END`,
]);

const CANONICAL_SOURCE = MF2_ARTIFACT_027_DDL_STATEMENTS.join('\n');

export const migration027Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration027: Migration = {
  id: '027',
  name: 'mf2-review-test-artifact',
  checksum: migration027Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    if (!workspacesExists(ctx.db) || !artifactsExist(ctx.db)) {
      // Fail closed: an 027 success record must never be written against an
      // incomplete parent schema.
      throw new Error(
        'MIGRATION_PREREQUISITE_MISSING: 027 requires workspaces and runtime_artifacts',
      );
    }
    for (const statement of MF2_ARTIFACT_027_DDL_STATEMENTS) {
      ctx.db.exec(statement);
    }
  },
};

function tableExists(db: MigrationContext['db'], name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '" + name + "'")
    .get();
  return row !== undefined && row !== null;
}
function workspacesExists(db: MigrationContext['db']): boolean {
  return tableExists(db, 'workspaces');
}
function artifactsExist(db: MigrationContext['db']): boolean {
  return tableExists(db, 'runtime_artifacts');
}
