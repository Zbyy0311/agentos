import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/** P2 recovery lineage and idempotency. Register after planned migrations 049–053 during parent integration. */
export const P2_RECOVERY_054_DDL_STATEMENTS = Object.freeze([
  `CREATE TABLE p2_group_recovery_links (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    prior_interaction_id TEXT NOT NULL,
    prior_owner_id TEXT NOT NULL,
    prior_owner_epoch INTEGER NOT NULL CHECK(prior_owner_epoch >= 1),
    prior_interaction_version INTEGER NOT NULL CHECK(prior_interaction_version >= 1),
    new_interaction_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(workspace_id, idempotency_key),
    UNIQUE(workspace_id, conversation_id, prior_interaction_id),
    UNIQUE(workspace_id, new_interaction_id),
    FOREIGN KEY(prior_interaction_id, workspace_id, conversation_id)
      REFERENCES cr_group_interactions(id, workspace_id, conversation_id) ON DELETE RESTRICT,
    FOREIGN KEY(new_interaction_id, workspace_id, conversation_id)
      REFERENCES cr_group_interactions(id, workspace_id, conversation_id) ON DELETE RESTRICT,
    FOREIGN KEY(source_message_id) REFERENCES cr_messages(id) ON DELETE RESTRICT
  )`,
  `CREATE TABLE p2_collaboration_recoveries (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    collaboration_task_id TEXT NOT NULL,
    prior_run_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('retry-known-failure','new-linked-task')),
    expected_task_version INTEGER NOT NULL CHECK(expected_task_version >= 1),
    expected_run_version INTEGER NOT NULL CHECK(expected_run_version >= 1),
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','dispatching','completed','failed','recovery_required')),
    planned_collaboration_task_id TEXT,
    new_collaboration_task_id TEXT,
    new_run_id TEXT,
    checked_base_commit TEXT,
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(workspace_id, idempotency_key),
    UNIQUE(workspace_id, collaboration_task_id, prior_run_id, action),
    FOREIGN KEY(collaboration_task_id, workspace_id)
      REFERENCES collaboration_tasks(id, workspace_id) ON DELETE RESTRICT,
    FOREIGN KEY(prior_run_id, workspace_id)
      REFERENCES runs(id, workspace_id) ON DELETE RESTRICT,
    FOREIGN KEY(new_collaboration_task_id, workspace_id)
      REFERENCES collaboration_tasks(id, workspace_id) ON DELETE RESTRICT,
    FOREIGN KEY(new_run_id, workspace_id)
      REFERENCES runs(id, workspace_id) ON DELETE RESTRICT
  )`,
]);

export const migration054Checksum = createHash('sha256')
  .update(P2_RECOVERY_054_DDL_STATEMENTS.join('\n'))
  .digest('hex')
  .slice(0, 16);

export const migration054: Migration = {
  id: '054',
  name: 'p2-interrupted-failure-recovery',
  checksum: migration054Checksum,
  destructive: false,
  apply(ctx: MigrationContext): void {
    for (const statement of P2_RECOVERY_054_DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
