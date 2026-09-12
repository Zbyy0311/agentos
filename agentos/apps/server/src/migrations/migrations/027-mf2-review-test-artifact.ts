import { createHash } from 'node:crypto';
import type { Migration } from '../types.js';

// LITE-07-104/108: corrected preserved draft, frozen in S2-027-authorization.md.
export const MF2_ARTIFACT_027_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE artifact_completions (
    id TEXT NOT NULL PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL UNIQUE,
    artifact_type TEXT NOT NULL CHECK (artifact_type IN ('review','test')),
    run_id TEXT,
    conclusion TEXT NOT NULL,
    candidate_id TEXT NOT NULL UNIQUE,
    source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
    decided_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK ((artifact_type = 'review' AND conclusion IN ('approved','changes_requested'))
      OR (artifact_type = 'test' AND conclusion IN ('pass','fail'))),
    UNIQUE (workspace_id, source_key),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (artifact_id) REFERENCES runtime_artifacts(id) ON DELETE CASCADE,
    FOREIGN KEY (candidate_id) REFERENCES memory_candidate_entries(id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX artifact_completions_workspace_decided_at
    ON artifact_completions (workspace_id, decided_at, id)`,
  `CREATE TRIGGER artifact_completions_validate_source BEFORE INSERT ON artifact_completions
    WHEN NOT EXISTS (
      SELECT 1 FROM runtime_artifacts a JOIN memory_candidate_entries c ON c.id = NEW.candidate_id
      JOIN memory_candidate_sources s ON s.candidate_id = c.id
      WHERE a.id = NEW.artifact_id AND a.workspace_id = NEW.workspace_id
        AND a.artifact_type = NEW.artifact_type AND a.canonical_run_id IS NEW.run_id
        AND c.workspace_id = NEW.workspace_id AND s.source_kind = 'artifact' AND s.source_id = a.id
    )
    BEGIN SELECT RAISE(ABORT, 'ARTIFACT_COMPLETION_SOURCE_INVALID'); END`,
  `CREATE TRIGGER artifact_completions_reject_update BEFORE UPDATE ON artifact_completions
    BEGIN SELECT RAISE(ABORT, 'ARTIFACT_COMPLETION_IMMUTABLE'); END`,
]);

export const migration027Checksum = createHash('sha256')
  .update(MF2_ARTIFACT_027_DDL_STATEMENTS.join('\n')).digest('hex').slice(0, 16);

export const migration027: Migration = {
  id: '027', name: 'mf2-review-test-artifact', checksum: migration027Checksum, destructive: false,
  apply({ db }): void {
    for (const table of ['workspaces', 'runtime_artifacts', 'memory_candidate_entries', 'memory_candidate_sources']) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) === undefined) {
        throw new Error('MIGRATION_PREREQUISITE_MISSING: 027 requires ' + table);
      }
    }
    for (const sql of MF2_ARTIFACT_027_DDL_STATEMENTS) db.exec(sql);
  },
};
