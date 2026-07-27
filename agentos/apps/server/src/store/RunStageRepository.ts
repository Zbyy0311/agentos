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

function mapRow(row: RunStageRow): RunStage {
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
      'SELECT * FROM run_stages WHERE id = ? AND run_id = ?',
    ).get(id, input.runId) as RunStageRow | undefined;
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
