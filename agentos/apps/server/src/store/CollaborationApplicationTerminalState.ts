import type { TransactionDatabase } from './Transaction.js';

/** Both the control and its own journal must prove a terminal application. */
export interface CollaborationApplicationFacts {
  workspace_id: string; control_id: string; collaboration_task_id: string;
  action: string; control_state: string; created_at: string;
  expected_version: number; control_epoch: number; control_candidate_id: string | null;
  control_run_id: string | null; idempotency_key: string;
  task_id: string | null; task_version: number | null; task_control_epoch: number | null;
  task_status: string | null; task_base_commit: string | null; apply_idempotency_key: string | null;
  journal_state: string | null; journal_workspace_id: string | null;
  journal_task_id: string | null; journal_candidate_id: string | null;
  journal_candidate_hash: string | null; journal_base_commit: string | null;
  candidate_id: string | null; candidate_task_id: string | null; candidate_run_id: string | null;
  candidate_hash: string | null; candidate_base_commit: string | null; candidate_status: string | null;
}

const FACTS_SQL = `SELECT c.workspace_id, c.id AS control_id, c.collaboration_task_id,
  c.action, c.state AS control_state, c.created_at, c.expected_version,
  c.epoch AS control_epoch, c.candidate_id AS control_candidate_id,
  c.canonical_run_id AS control_run_id, c.idempotency_key,
  t.id AS task_id, t.version AS task_version, t.control_epoch AS task_control_epoch,
  t.status AS task_status, t.base_commit AS task_base_commit, t.apply_idempotency_key,
  j.state AS journal_state, j.workspace_id AS journal_workspace_id,
  j.collaboration_task_id AS journal_task_id, j.candidate_id AS journal_candidate_id,
  j.candidate_hash AS journal_candidate_hash, j.base_commit AS journal_base_commit,
  k.id AS candidate_id, k.collaboration_task_id AS candidate_task_id,
  k.canonical_run_id AS candidate_run_id, k.diff_hash AS candidate_hash,
  k.base_commit AS candidate_base_commit, k.status AS candidate_status
  FROM collaboration_controls c
  LEFT JOIN collaboration_tasks t ON t.workspace_id = c.workspace_id AND t.id = c.collaboration_task_id
  LEFT JOIN collaboration_apply_journals j ON j.control_id = c.id
  LEFT JOIN collaboration_candidates k ON k.workspace_id = j.workspace_id AND k.id = j.candidate_id`;

export function readCollaborationApplicationFacts(db: TransactionDatabase, workspaceId: string, controlId: string): CollaborationApplicationFacts | undefined {
  return db.prepare(FACTS_SQL + ' WHERE c.workspace_id = ? AND c.id = ?')
    .get(workspaceId, controlId) as CollaborationApplicationFacts | undefined;
}

export function listCollaborationApplicationFacts(db: TransactionDatabase): CollaborationApplicationFacts[] {
  return db.prepare(FACTS_SQL + " WHERE c.action = 'apply' ORDER BY c.workspace_id, c.created_at, c.id")
    .all() as CollaborationApplicationFacts[];
}

export function collaborationApplicationTerminalReason(facts: CollaborationApplicationFacts):
  'APPLICATION_JOURNAL_COMMITTED' | 'APPLICATION_JOURNAL_RECOVERED' | 'APPLICATION_FAILED_BEFORE_JOURNAL' | undefined {
  if (facts.action !== 'apply' || facts.task_id !== facts.collaboration_task_id) return undefined;
  if (facts.journal_state === null) {
    return facts.control_state === 'failed' ? 'APPLICATION_FAILED_BEFORE_JOURNAL' : undefined;
  }
  if (facts.journal_workspace_id !== facts.workspace_id
    || facts.journal_task_id !== facts.collaboration_task_id
    || facts.control_candidate_id !== facts.journal_candidate_id
    || facts.candidate_id !== facts.journal_candidate_id
    || facts.candidate_task_id !== facts.collaboration_task_id
    || facts.control_run_id !== facts.candidate_run_id
    || facts.journal_candidate_hash !== facts.candidate_hash
    || facts.journal_base_commit !== facts.candidate_base_commit
    || facts.journal_base_commit !== facts.task_base_commit) return undefined;
  if (facts.control_state === 'failed' && facts.journal_state === 'recovered') {
    // A later request can legitimately advance the task epoch after this
    // immutable failed/recovered pair. It does not invalidate the old release.
    return 'APPLICATION_JOURNAL_RECOVERED';
  }
  if (facts.control_state === 'completed' && facts.journal_state === 'committed'
    && facts.task_status === 'applied' && facts.candidate_status === 'applied'
    && facts.task_version === facts.expected_version + 1
    && facts.task_control_epoch === facts.control_epoch
    && facts.apply_idempotency_key === facts.idempotency_key) {
    return 'APPLICATION_JOURNAL_COMMITTED';
  }
  return undefined;
}
