import { createHash } from 'node:crypto';
import type { Migration, MigrationContext } from '../types.js';

/** Durable state for the first bounded collaboration workflow slice. */
const DDL_STATEMENTS = [
  `CREATE TABLE collaboration_tasks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT,
    source_message_id TEXT,
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
    acceptance_commands_json TEXT NOT NULL CHECK (json_valid(acceptance_commands_json)),
    planner_agent_id TEXT NOT NULL,
    implementer_agent_id TEXT NOT NULL,
    reviewer_agent_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'awaiting_confirmation','queued','running','reviewing','changes_requested',
      'awaiting_application','applied','failed','blocked','cancelled'
    )),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    plan_hash TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    max_rework_rounds INTEGER NOT NULL DEFAULT 2 CHECK (max_rework_rounds BETWEEN 0 AND 2),
    rework_round INTEGER NOT NULL DEFAULT 0 CHECK (rework_round >= 0),
    canonical_task_id TEXT,
    canonical_run_id TEXT,
    current_candidate_id TEXT,
    confirmed_at TEXT,
    applied_at TEXT,
    cancelled_at TEXT,
    failure_reason TEXT,
    confirm_idempotency_key TEXT,
    apply_idempotency_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (canonical_task_id, workspace_id) REFERENCES tasks(id, workspace_id) ON DELETE SET NULL,
    FOREIGN KEY (canonical_run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE SET NULL,
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, confirm_idempotency_key),
    UNIQUE (workspace_id, apply_idempotency_key)
  )`,
  `CREATE INDEX collaboration_tasks_workspace_updated
    ON collaboration_tasks(workspace_id, updated_at DESC, id ASC)`,
  `CREATE TABLE collaboration_candidates (
    id TEXT PRIMARY KEY,
    collaboration_task_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    canonical_run_id TEXT NOT NULL,
    round INTEGER NOT NULL CHECK (round >= 0),
    base_commit TEXT NOT NULL,
    head_commit TEXT NOT NULL,
    diff_hash TEXT NOT NULL,
    diff_text TEXT NOT NULL,
    manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
    test_status TEXT NOT NULL CHECK (test_status IN ('passed','failed','unknown')),
    test_command TEXT,
    test_exit_code INTEGER,
    test_output TEXT,
    status TEXT NOT NULL CHECK (status IN ('created','reviewed','superseded','applied')),
    review_conclusion TEXT CHECK (review_conclusion IS NULL OR review_conclusion IN ('approved','changes_requested')),
    review_summary TEXT,
    review_agent_id TEXT,
    review_artifact_id TEXT,
    diff_artifact_id TEXT,
    manifest_artifact_id TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (collaboration_task_id, workspace_id) REFERENCES collaboration_tasks(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (canonical_run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE CASCADE,
    UNIQUE (collaboration_task_id, round),
    UNIQUE (id, workspace_id)
  )`,
  `CREATE INDEX collaboration_candidates_task_created
    ON collaboration_candidates(workspace_id, collaboration_task_id, round ASC, id ASC)`,
  `CREATE TABLE collaboration_reviews (
    id TEXT PRIMARY KEY,
    collaboration_task_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    canonical_run_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    stage_attempt INTEGER NOT NULL CHECK (stage_attempt >= 1),
    reviewer_agent_id TEXT NOT NULL,
    conclusion TEXT NOT NULL CHECK (conclusion IN ('approved','changes_requested')),
    summary TEXT NOT NULL,
    artifact_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (collaboration_task_id, workspace_id) REFERENCES collaboration_tasks(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (candidate_id, workspace_id) REFERENCES collaboration_candidates(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (canonical_run_id, workspace_id) REFERENCES runs(id, workspace_id) ON DELETE CASCADE,
    UNIQUE (candidate_id)
  )`,
  `CREATE INDEX collaboration_reviews_task_created
    ON collaboration_reviews(workspace_id, collaboration_task_id, created_at ASC, id ASC)`,
];

const CANONICAL_SOURCE = DDL_STATEMENTS.join('\n');

export const migration035Checksum = createHash('sha256')
  .update(CANONICAL_SOURCE)
  .digest('hex')
  .slice(0, 16);

export const migration035: Migration = {
  id: '035',
  name: 'collaboration-workflow',
  checksum: migration035Checksum,
  apply(ctx: MigrationContext): void {
    for (const statement of DDL_STATEMENTS) ctx.db.exec(statement);
  },
};
