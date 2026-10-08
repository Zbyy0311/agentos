import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

const DDL = [
  `ALTER TABLE collaboration_tasks ADD COLUMN control_epoch INTEGER NOT NULL DEFAULT 0 CHECK(control_epoch >= 0)`,
  `ALTER TABLE collaboration_tasks ADD COLUMN scope_policy_version INTEGER`,
  `CREATE TABLE collaboration_controls (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, collaboration_task_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('confirm','cancel','apply','rework')),
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, expected_version INTEGER NOT NULL CHECK(expected_version >= 1),
    epoch INTEGER NOT NULL CHECK(epoch >= 1), canonical_run_id TEXT, candidate_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('reserved','running','completed','failed','recovery_required')),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)), error_code TEXT, error_message TEXT,
    recovery_reference TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(collaboration_task_id,workspace_id) REFERENCES collaboration_tasks(id,workspace_id) ON DELETE CASCADE,
    UNIQUE(workspace_id,idempotency_key), UNIQUE(workspace_id,id), UNIQUE(workspace_id,collaboration_task_id,epoch)
  )`,
  `CREATE UNIQUE INDEX collaboration_controls_active_task ON collaboration_controls(workspace_id,collaboration_task_id)
    WHERE state IN ('reserved','running','recovery_required')`,
  `CREATE TABLE collaboration_apply_journals (
    control_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, collaboration_task_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL, candidate_hash TEXT NOT NULL, base_commit TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','written','committed','recovered','recovery_required')),
    recovery_path TEXT NOT NULL, images_json TEXT NOT NULL CHECK(json_valid(images_json)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY(control_id,workspace_id) REFERENCES collaboration_controls(id,workspace_id) ON DELETE CASCADE
  )`,
];

export const migration039Checksum = createHash('sha256').update(DDL.join('\n')).digest('hex').slice(0, 16);
export const migration039: Migration = {
  id: '039', name: 'collaboration-control', checksum: migration039Checksum,
  apply(ctx: MigrationContext): void { for (const statement of DDL) ctx.db.exec(statement); },
};
