import { createHash } from 'node:crypto';
import type { CollaborationCandidateManifestEntry } from '@agentos/shared';
import type { CollaborationTask } from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { createEntityId } from './Identity.js';
import { CollaborationRepository } from './CollaborationRepository.js';
import { collaborationCandidateContentHash } from '../services/CollaborationCandidateContentHash.js';

export type CollaborationControlAction = 'confirm' | 'cancel' | 'apply' | 'rework';
export type CollaborationControlState = 'reserved' | 'running' | 'completed' | 'failed' | 'recovery_required';
export interface CollaborationControl {
  id: string; workspaceId: string; collaborationTaskId: string; action: CollaborationControlAction;
  idempotencyKey: string; requestHash: string; expectedVersion: number; epoch: number;
  runId?: string; candidateId?: string; state: CollaborationControlState; result?: CollaborationTask;
  errorCode?: string; errorMessage?: string; recoveryReference?: string; createdAt: string; updatedAt: string;
}
interface Row {
  id: string; workspace_id: string; collaboration_task_id: string; action: CollaborationControlAction;
  idempotency_key: string; request_hash: string; expected_version: number; epoch: number;
  canonical_run_id: string | null; candidate_id: string | null; state: CollaborationControlState;
  result_json: string | null; error_code: string | null; error_message: string | null;
  recovery_reference: string | null; created_at: string; updated_at: string;
}
export class CollaborationControlError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'CollaborationControlError'; }
}
const ALLOWED: Record<CollaborationControlAction, readonly string[]> = {
  confirm: ['awaiting_confirmation'],
  cancel: ['awaiting_confirmation', 'queued', 'running', 'reviewing', 'changes_requested'],
  apply: ['awaiting_application'], rework: ['changes_requested'],
};
function map(row: Row): CollaborationControl {
  return {
    id: row.id, workspaceId: row.workspace_id, collaborationTaskId: row.collaboration_task_id,
    action: row.action, idempotencyKey: row.idempotency_key, requestHash: row.request_hash,
    expectedVersion: row.expected_version, epoch: row.epoch, state: row.state,
    ...(row.canonical_run_id === null ? {} : { runId: row.canonical_run_id }),
    ...(row.candidate_id === null ? {} : { candidateId: row.candidate_id }),
    ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as CollaborationTask }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
    ...(row.recovery_reference === null ? {} : { recoveryReference: row.recovery_reference }),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
export class CollaborationControlRepository {
  private readonly tasks: CollaborationRepository;
  constructor(private readonly db: TransactionDatabase) { this.tasks = new CollaborationRepository(db); }

  find(workspaceId: string, id: string): CollaborationControl | undefined {
    const row = this.db.prepare('SELECT * FROM collaboration_controls WHERE workspace_id = ? AND id = ?').get(workspaceId, id) as Row | undefined;
    return row ? map(row) : undefined;
  }
  pending(workspaceId: string, taskId: string): CollaborationControl | undefined {
    const row = this.db.prepare("SELECT * FROM collaboration_controls WHERE workspace_id = ? AND collaboration_task_id = ? AND state IN ('reserved','running','recovery_required')")
      .get(workspaceId, taskId) as Row | undefined;
    return row ? map(row) : undefined;
  }
  listPending(): CollaborationControl[] {
    return (this.db.prepare("SELECT * FROM collaboration_controls WHERE state IN ('reserved','running','recovery_required') ORDER BY created_at,id").all() as Row[]).map(map);
  }

  /** Caller owns one short transaction. No external operation may precede this claim. */
  reserve(input: {
    workspaceId: string; collaborationId: string; action: CollaborationControlAction; expectedVersion: number; idempotencyKey?: string;
    candidateId?: string; candidateBaseCommit?: string; candidateContentHash?: string;
  }): { control: CollaborationControl; task: CollaborationTask; replay: boolean } {
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new CollaborationControlError('COLLABORATION_INVALID', 'expectedVersion must be a positive integer');
    if (!input.idempotencyKey || input.idempotencyKey.trim() !== input.idempotencyKey || input.idempotencyKey.length > 200) {
      throw new CollaborationControlError('COLLABORATION_IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required');
    }
    const requestFingerprint = { workspaceId: input.workspaceId, collaborationId: input.collaborationId, action: input.action, expectedVersion: input.expectedVersion };
    const requestHash = input.candidateId === undefined || input.candidateBaseCommit === undefined || input.candidateContentHash === undefined
      ? createHash('sha256').update(JSON.stringify(requestFingerprint)).digest('hex')
      : createHash('sha256').update(JSON.stringify({ ...requestFingerprint, candidateId: input.candidateId,
        candidateBaseCommit: input.candidateBaseCommit, candidateContentHash: input.candidateContentHash })).digest('hex');
    const existingRow = this.db.prepare('SELECT * FROM collaboration_controls WHERE workspace_id = ? AND idempotency_key = ?').get(input.workspaceId, input.idempotencyKey) as Row | undefined;
    const task = this.tasks.findById(input.workspaceId, input.collaborationId);
    if (!task) throw new CollaborationControlError('COLLABORATION_NOT_FOUND', 'Collaboration task not found');
    const hasCandidateBinding = input.candidateId !== undefined || input.candidateBaseCommit !== undefined || input.candidateContentHash !== undefined;
    if (hasCandidateBinding && (input.candidateId === undefined || input.candidateBaseCommit === undefined || input.candidateContentHash === undefined)) {
      throw new CollaborationControlError('COLLABORATION_INVALID', 'candidateId, candidateBaseCommit, and candidateContentHash must be provided together');
    }
    if (input.action === 'apply' && !hasCandidateBinding) {
      throw new CollaborationControlError('COLLABORATION_CANDIDATE_CHANGED', 'Load the current frozen candidate preview before applying');
    }
    if (input.candidateId !== undefined && input.candidateBaseCommit !== undefined && input.candidateContentHash !== undefined) {
      const candidate = this.db.prepare(`SELECT base_commit,diff_hash,snapshot_version,manifest_json,content_hash FROM collaboration_candidates
        WHERE workspace_id = ? AND collaboration_task_id = ? AND id = ?`).get(
        input.workspaceId, input.collaborationId, input.candidateId,
      ) as { base_commit: string; diff_hash: string; snapshot_version: number; manifest_json: string; content_hash: string } | undefined;
      let computedContentHash: string | undefined;
      if (candidate) {
        try {
          const manifest = JSON.parse(candidate.manifest_json) as CollaborationCandidateManifestEntry[];
          if (Array.isArray(manifest)) computedContentHash = collaborationCandidateContentHash({
            diffHash: candidate.diff_hash, snapshotVersion: candidate.snapshot_version, manifest,
          });
        } catch { computedContentHash = undefined; }
      }
      if (input.candidateId !== task.currentCandidateId || !candidate || candidate.base_commit !== input.candidateBaseCommit
        || task.baseCommit !== input.candidateBaseCommit || candidate.content_hash !== input.candidateContentHash
        || computedContentHash !== input.candidateContentHash || !/^[a-f0-9]{64}$/u.test(input.candidateContentHash)) {
        throw new CollaborationControlError('COLLABORATION_CANDIDATE_CHANGED', 'The candidate differs from the frozen preview; refresh before applying');
      }
    }
    if (existingRow) {
      if (existingRow.request_hash !== requestHash || existingRow.collaboration_task_id !== input.collaborationId) {
        throw new CollaborationControlError('COLLABORATION_CONFLICT', 'Idempotency key was already used with another request');
      }
      return { control: map(existingRow), task, replay: true };
    }
    if (task.version !== input.expectedVersion || !ALLOWED[input.action].includes(task.status) || this.pending(input.workspaceId, input.collaborationId)) {
      throw new CollaborationControlError('COLLABORATION_CONFLICT', 'Task version, state or active control changed; refresh before acting');
    }
    const epoch = (this.db.prepare('SELECT control_epoch FROM collaboration_tasks WHERE workspace_id = ? AND id = ?').get(input.workspaceId, input.collaborationId) as { control_epoch: number }).control_epoch + 1;
    const now = new Date().toISOString(); const id = createEntityId('operation');
    const updated = this.db.prepare('UPDATE collaboration_tasks SET control_epoch = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND version = ? AND control_epoch = ?')
      .run(epoch, now, input.workspaceId, input.collaborationId, input.expectedVersion, epoch - 1) as { changes: number };
    if (updated.changes !== 1) throw new CollaborationControlError('COLLABORATION_CONFLICT', 'Control claim lost');
    this.db.prepare(`INSERT INTO collaboration_controls(id,workspace_id,collaboration_task_id,action,idempotency_key,request_hash,expected_version,epoch,canonical_run_id,candidate_id,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?,?)`).run(id, input.workspaceId, input.collaborationId, input.action, input.idempotencyKey, requestHash, input.expectedVersion, epoch, task.canonicalRunId ?? null, task.currentCandidateId ?? null, now, now);
    return { control: this.find(input.workspaceId, id)!, task: this.tasks.findById(input.workspaceId, input.collaborationId)!, replay: false };
  }

  assertOwned(control: CollaborationControl): CollaborationTask {
    const current = this.find(control.workspaceId, control.id);
    const task = this.tasks.findById(control.workspaceId, control.collaborationTaskId);
    const epoch = this.db.prepare('SELECT control_epoch FROM collaboration_tasks WHERE workspace_id = ? AND id = ?').get(control.workspaceId, control.collaborationTaskId) as { control_epoch: number } | undefined;
    if (!current || !task || current.epoch !== control.epoch || epoch?.control_epoch !== control.epoch || !['reserved', 'running'].includes(current.state)) {
      throw new CollaborationControlError('COLLABORATION_CONFLICT', 'Control ownership changed');
    }
    return task;
  }
  bind(control: CollaborationControl, input: { runId?: string; candidateId?: string }): void {
    this.assertOwned(control);
    this.db.prepare('UPDATE collaboration_controls SET canonical_run_id = COALESCE(?,canonical_run_id),candidate_id = COALESCE(?,candidate_id),state = ?,updated_at = ? WHERE workspace_id = ? AND id = ? AND epoch = ?')
      .run(input.runId ?? null, input.candidateId ?? null, 'running', new Date().toISOString(), control.workspaceId, control.id, control.epoch);
  }
  finish(control: CollaborationControl, result: CollaborationTask): void {
    this.assertOwned(control);
    const updated = this.db.prepare("UPDATE collaboration_controls SET state = 'completed',result_json = ?,updated_at = ? WHERE workspace_id = ? AND id = ? AND epoch = ? AND state IN ('reserved','running')")
      .run(JSON.stringify(result), new Date().toISOString(), control.workspaceId, control.id, control.epoch) as { changes: number };
    if (updated.changes !== 1) throw new CollaborationControlError('COLLABORATION_CONFLICT', 'Control completion lost');
  }
  fail(control: CollaborationControl, error: unknown, recoveryRequired: boolean, recoveryReference?: string): void {
    const code = typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'COLLABORATION_CONTROL_FAILED';
    const message = error instanceof Error ? error.message : 'Control operation failed';
    this.db.prepare("UPDATE collaboration_controls SET state = ?,error_code = ?,error_message = ?,recovery_reference = ?,updated_at = ? WHERE workspace_id = ? AND id = ? AND epoch = ? AND state IN ('reserved','running')")
      .run(recoveryRequired ? 'recovery_required' : 'failed', code, message, recoveryReference ?? null, new Date().toISOString(), control.workspaceId, control.id, control.epoch);
  }
}
