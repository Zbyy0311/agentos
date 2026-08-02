import { M3_STAGE_STATUSES, getM3StageTransitionEventContract } from '@agentos/shared';
import type { M3StageStatus, RunStage } from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { createEntityId } from './Identity.js';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { VersionConflictError } from './Version.js';

interface RunStageRow {
  id: string;
  workspace_id: string;
  run_id: string;
  run_snapshot_id: string;
  workflow_stage_key: string;
  name: string;
  sequence: number;
  attempt: number;
  status: M3StageStatus;
  failure_code: string | null;
  failure_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

function integrityFailure(reason: string): RunStageIntegrityError {
  return new RunStageIntegrityError(`RUN_STAGE_INTEGRITY_FAILED: ${reason}`);
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw integrityFailure(`${field} is invalid`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw integrityFailure(`${field} is invalid`);
  }
  return value;
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== null && typeof value !== 'string') {
    throw integrityFailure(`${field} is invalid`);
  }
}

function assertOptionalTimestamp(value: unknown, field: string): void {
  if (value !== null && (!isCanonicalUtcTimestamp(value) || typeof value !== 'string')) {
    throw integrityFailure(`${field} is invalid`);
  }
}

function validateRunStageRow(row: unknown): asserts row is RunStageRow {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw integrityFailure('row is invalid');
  }
  const value = row as Record<string, unknown>;
  const workflowStageKey = assertNonEmptyString(value.workflow_stage_key, 'workflow_stage_key');
  if (workflowStageKey !== workflowStageKey.trim()) {
    throw integrityFailure('workflow_stage_key is not trimmed');
  }
  const name = assertNonEmptyString(value.name, 'name');
  if (name !== workflowStageKey) throw integrityFailure('name does not match workflow_stage_key');
  assertNonEmptyString(value.id, 'id');
  assertNonEmptyString(value.workspace_id, 'workspace_id');
  assertNonEmptyString(value.run_id, 'run_id');
  assertNonEmptyString(value.run_snapshot_id, 'run_snapshot_id');
  assertPositiveInteger(value.sequence, 'sequence');
  assertPositiveInteger(value.attempt, 'attempt');
  if (!M3_STAGE_STATUSES.includes(value.status as M3StageStatus)) throw integrityFailure('status is invalid');
  assertOptionalString(value.failure_code, 'failure_code');
  assertOptionalString(value.failure_message, 'failure_message');
  assertOptionalTimestamp(value.started_at, 'started_at');
  assertOptionalTimestamp(value.completed_at, 'completed_at');
  assertNonEmptyString(value.created_at, 'created_at');
  assertNonEmptyString(value.updated_at, 'updated_at');
  assertPositiveInteger(value.version, 'version');
}

function mapRow(row: RunStageRow): RunStage {
  validateRunStageRow(row);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    runSnapshotId: row.run_snapshot_id,
    workflowStageKey: row.workflow_stage_key,
    name: row.name,
    sequence: row.sequence,
    attempt: row.attempt,
    status: row.status,
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    ...(row.failure_message === null ? {} : { failureMessage: row.failure_message }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export interface InsertInitialRunStageInput {
  workspaceId: string;
  runId: string;
  runSnapshotId: string;
  workflowStageKey: string;
  sequence: number;
}

export interface RunStageLifecycleTransitionWithinTransactionInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly stageId: string;
  readonly expectedVersion: number;
  readonly expectedFrom: M3StageStatus;
  readonly to: M3StageStatus;
  readonly timestamp: string;
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

export class RunStageValidationError extends Error {
  readonly code = 'RUN_STAGE_VALIDATION_FAILED' as const;

  constructor(message = 'RUN_STAGE_VALIDATION_FAILED') {
    super(message);
    this.name = 'RunStageValidationError';
  }
}

export class RunStageIntegrityError extends Error {
  readonly code = 'RUN_STAGE_INTEGRITY_FAILED' as const;

  constructor(message = 'RUN_STAGE_INTEGRITY_FAILED') {
    super(message);
    this.name = 'RunStageIntegrityError';
  }
}

export class RunStageRepository {
  constructor(private readonly db: TransactionDatabase) {}

  insertInitial(input: InsertInitialRunStageInput): RunStage {
    if (typeof input.workflowStageKey !== 'string' || input.workflowStageKey.trim().length === 0) {
      throw new RunStageValidationError('RUN_STAGE_VALIDATION_FAILED: workflowStageKey must be non-empty');
    }
    if (input.workflowStageKey !== input.workflowStageKey.trim()) {
      throw new RunStageValidationError('RUN_STAGE_VALIDATION_FAILED: workflowStageKey must not be trimmed');
    }
    if (!Number.isInteger(input.sequence) || input.sequence < 1) {
      throw new RunStageValidationError('RUN_STAGE_VALIDATION_FAILED: sequence must be a positive integer');
    }

    const id = createEntityId('stage');
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO run_stages (
        id, workspace_id, run_id, run_snapshot_id, workflow_stage_key, name,
        sequence, attempt, status, created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?, 1)
    `).run(
      id,
      input.workspaceId,
      input.runId,
      input.runSnapshotId,
      input.workflowStageKey,
      input.workflowStageKey,
      input.sequence,
      now,
      now,
    );
    const row = this.db.prepare(
      'SELECT * FROM run_stages WHERE id = ? AND workspace_id = ? AND run_id = ?',
    ).get(id, input.workspaceId, input.runId) as RunStageRow | undefined;
    if (!row) throw new RunStageValidationError('RUN_STAGE_VALIDATION_FAILED: inserted stage not found');
    return mapRow(row);
  }

  listByRun(workspaceId: string, runId: string): RunStage[] {
    const rows = this.db.prepare(`
      SELECT * FROM run_stages
      WHERE workspace_id = ? AND run_id = ?
      ORDER BY sequence ASC, id ASC
    `).all(workspaceId, runId) as RunStageRow[];
    return rows.map(mapRow);
  }

  findById(workspaceId: string, runId: string, stageId: string): RunStage | undefined {
    const row = this.db.prepare(`
      SELECT * FROM run_stages
      WHERE workspace_id = ? AND run_id = ? AND id = ?
    `).get(workspaceId, runId, stageId) as RunStageRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findByIdInWorkspace(workspaceId: string, stageId: string): RunStage | undefined {
    const row = this.db.prepare(`
      SELECT * FROM run_stages
      WHERE workspace_id = ? AND id = ?
    `).get(workspaceId, stageId) as RunStageRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  transitionLifecycleWithinTransaction(input: RunStageLifecycleTransitionWithinTransactionInput): RunStage {
    if (!input.workspaceId.trim() || !input.runId.trim() || !input.stageId.trim()) {
      throw new RunStageValidationError('LIFECYCLE_VALIDATION_FAILED: workspaceId, runId and stageId are required');
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new RunStageValidationError('LIFECYCLE_VALIDATION_FAILED: expectedVersion must be a positive safe integer');
    }
    if (!isCanonicalUtcTimestamp(input.timestamp)) {
      throw new RunStageValidationError('LIFECYCLE_VALIDATION_FAILED: timestamp must be canonical UTC ISO 8601 milliseconds');
    }
    if (!getM3StageTransitionEventContract(input.expectedFrom, input.to)) {
      throw new RunStageValidationError(
        `INVALID_RUN_STAGE_TRANSITION: cannot transition stage from '${input.expectedFrom}' to '${input.to}'`,
      );
    }
    if (input.to === 'failed'
      && (!input.failureCode?.trim() || !input.failureMessage?.trim())) {
      throw new RunStageValidationError('LIFECYCLE_VALIDATION_FAILED: failureCode and failureMessage are required');
    }

    const result = this.db.prepare(`
      UPDATE run_stages
      SET status = ?,
        started_at = CASE
          WHEN ? = 'starting' AND ? = 'running' AND started_at IS NULL THEN ?
          ELSE started_at
        END,
        completed_at = CASE
          WHEN ((? = 'running' AND ? = 'completed') OR (? = 'pending' AND ? = 'skipped'))
            AND completed_at IS NULL THEN ?
          ELSE completed_at
        END,
        failure_code = CASE WHEN ? = 'failed' THEN ? ELSE failure_code END,
        failure_message = CASE WHEN ? = 'failed' THEN ? ELSE failure_message END,
        updated_at = ?,
        version = version + 1
      WHERE workspace_id = ? AND run_id = ? AND id = ? AND status = ? AND version = ?
    `).run(
      input.to,
      input.expectedFrom, input.to, input.timestamp,
      input.expectedFrom, input.to, input.expectedFrom, input.to, input.timestamp,
      input.to, input.failureCode ?? null,
      input.to, input.failureMessage ?? null,
      input.timestamp,
      input.workspaceId, input.runId, input.stageId, input.expectedFrom, input.expectedVersion,
    ) as { changes: number };

    if (result.changes !== 1) {
      const row = this.db.prepare(`
        SELECT run_id, status, version FROM run_stages WHERE workspace_id = ? AND id = ?
      `).get(input.workspaceId, input.stageId) as {
        run_id: string;
        status: M3StageStatus;
        version: number;
      } | undefined;
      if (!row) throw new RunStageValidationError('LIFECYCLE_STAGE_NOT_FOUND: stage was not found');
      if (row.run_id !== input.runId) {
        throw new RunStageValidationError('LIFECYCLE_STAGE_RUN_MISMATCH: stage does not belong to run');
      }
      if (row.status !== input.expectedFrom) {
        throw new RunStageValidationError('LIFECYCLE_STATE_MISMATCH: expectedFrom does not match current status');
      }
      throw new VersionConflictError('run_stages', input.stageId, input.expectedVersion);
    }
    return this.findById(input.workspaceId, input.runId, input.stageId)!;
  }
}
