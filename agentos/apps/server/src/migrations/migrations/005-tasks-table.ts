import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

const DDL_STATEMENTS = [
  `CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    legacy_task_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
    priority TEXT NOT NULL DEFAULT 'normal'
      CHECK (priority IN ('low','normal','high','critical')),
    source_conversation_id TEXT,
    source_message_id TEXT,
    accepted_run_id TEXT,
    pending_result_run_id TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    archived_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    UNIQUE (id, workspace_id)
  )`,

  `CREATE UNIQUE INDEX idx_tasks_workspace_legacy_id
    ON tasks(workspace_id, legacy_task_id)
    WHERE legacy_task_id IS NOT NULL`,

  `CREATE INDEX idx_tasks_workspace_status_updated
    ON tasks(workspace_id, status, updated_at DESC)`,
];

const CANONICAL_SOURCE = DDL_STATEMENTS.join('\n');

export const migration005Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration005: Migration = {
  id: '005',
  name: 'tasks-table',
  checksum: migration005Checksum,
  apply(ctx: MigrationContext): void {
    for (const stmt of DDL_STATEMENTS) {
      ctx.db.exec(stmt);
    }
  },
};
