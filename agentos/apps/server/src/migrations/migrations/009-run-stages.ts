import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

const DDL_STATEMENTS = [
  `CREATE TABLE run_stages (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    run_snapshot_id TEXT NOT NULL,
    workflow_stage_key TEXT NOT NULL,
    name TEXT NOT NULL,
    sequence INTEGER NOT NULL
      CHECK (sequence >= 1),
    attempt INTEGER NOT NULL DEFAULT 1
      CHECK (attempt >= 1),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status = 'pending'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
      CHECK (version >= 1),
    UNIQUE(run_id, sequence),
    UNIQUE(run_id, workflow_stage_key, attempt),
    UNIQUE(id, run_id),
    FOREIGN KEY (run_id, workspace_id)
      REFERENCES runs(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (run_snapshot_id, run_id)
      REFERENCES run_snapshots(id, run_id) ON DELETE CASCADE
  )`,
];

const CANONICAL_SOURCE = DDL_STATEMENTS.join('\n');

export const migration009Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration009: Migration = {
  id: '009',
  name: 'run-stages',
  checksum: migration009Checksum,
  apply(ctx: MigrationContext): void {
    for (const stmt of DDL_STATEMENTS) {
      ctx.db.exec(stmt);
    }
  },
};
