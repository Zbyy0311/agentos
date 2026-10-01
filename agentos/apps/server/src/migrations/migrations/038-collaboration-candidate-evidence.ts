import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

const DDL = [
  `ALTER TABLE collaboration_candidates ADD COLUMN snapshot_version INTEGER NOT NULL DEFAULT 1 CHECK (snapshot_version >= 1)`,
  `ALTER TABLE collaboration_reviews ADD COLUMN candidate_diff_hash TEXT`,
  `CREATE TABLE collaboration_stage_outputs (
    workspace_id TEXT NOT NULL,
    collaboration_task_id TEXT NOT NULL,
    canonical_run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    stage_attempt INTEGER NOT NULL CHECK (stage_attempt >= 1),
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('planner','implementer','reviewer','other')),
    output_status TEXT NOT NULL CHECK (output_status IN ('available','missing','invalid')),
    public_output TEXT,
    output_hash TEXT,
    missing_reason TEXT,
    review_candidate_id TEXT,
    review_candidate_hash TEXT,
    review_conclusion TEXT CHECK (review_conclusion IS NULL OR review_conclusion IN ('approved','changes_requested')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, canonical_run_id, stage_id, stage_attempt),
    FOREIGN KEY (collaboration_task_id, workspace_id) REFERENCES collaboration_tasks(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (canonical_run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE CASCADE,
    CHECK ((output_status = 'available' AND public_output IS NOT NULL AND output_hash IS NOT NULL)
      OR (output_status <> 'available' AND public_output IS NULL))
  )`,
  `CREATE INDEX collaboration_stage_outputs_task_run
    ON collaboration_stage_outputs(workspace_id, collaboration_task_id, canonical_run_id, stage_id, stage_attempt)`,
];

export const migration038Checksum = createHash('sha256').update(DDL.join('\n')).digest('hex').slice(0, 16);

export const migration038: Migration = {
  id: '038',
  name: 'collaboration-candidate-evidence',
  checksum: migration038Checksum,
  apply(ctx: MigrationContext): void {
    for (const statement of DDL) ctx.db.exec(statement);
  },
};
