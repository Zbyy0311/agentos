import type { RunStage } from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { createEntityId } from './Identity.js';

interface RunStageRow {
  id: string;
  workspace_id: string;
  run_id: string;
  run_snapshot_id: string;
  workflow_stage_key: string;
  name: string;
  sequence: number;
  attempt: number;
  status: 'pending';
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
  if (value.status !== 'pending') throw integrityFailure('status is invalid');
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
}
