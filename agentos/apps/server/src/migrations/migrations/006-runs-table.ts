import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

const DDL_STATEMENTS = [
  `CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    parent_run_id TEXT,
    root_run_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued','starting','running','waiting_approval','paused','completed','failed','cancelled')),
    reason TEXT NOT NULL DEFAULT 'initial'
      CHECK (reason IN ('initial','retry','resume-fallback','review-fix','provider-comparison','manual')),
    origin TEXT NOT NULL DEFAULT 'v2_api'
      CHECK (origin IN ('v2_api','legacy_pipeline')),
    objective TEXT,
    failure_code TEXT,
    failure_message TEXT,
    cancellation_requested_at TEXT,
    next_event_sequence INTEGER NOT NULL DEFAULT 1,
    started_at TEXT,
    completed_at TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    UNIQUE (id, task_id),
    FOREIGN KEY (task_id, workspace_id)
      REFERENCES tasks(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_run_id, task_id)
      REFERENCES runs(id, task_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (root_run_id, task_id)
      REFERENCES runs(id, task_id) DEFERRABLE INITIALLY DEFERRED
  )`,

  `CREATE INDEX idx_runs_task_created
    ON runs(workspace_id, task_id, created_at ASC, id ASC)`,

  `CREATE INDEX idx_runs_workspace_status
    ON runs(workspace_id, status)`,

  `CREATE UNIQUE INDEX idx_runs_one_active_per_task
    ON runs(task_id)
    WHERE status IN ('queued','starting','running','waiting_approval','paused')`,
];

const CANONICAL_SOURCE = DDL_STATEMENTS.join('\n');

export const migration006Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration006: Migration = {
  id: '006',
  name: 'runs-table',
  checksum: migration006Checksum,
  apply(ctx: MigrationContext): void {
    for (const stmt of DDL_STATEMENTS) {
      ctx.db.exec(stmt);
    }
  },
};
