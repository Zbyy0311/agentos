import { getM3RunTransitionEventContract } from '@agentos/shared';
import type { CreateV2RunInput, Run, V2RunOrigin, V2RunReason, V2RunStatus } from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { assertVersionedMutation } from './Repository.js';
import { createEntityId } from './Identity.js';
import { isCanonicalUtcTimestamp } from './CanonicalTimestamp.js';
import { VersionConflictError } from './Version.js';

export interface InsertRunInput extends CreateV2RunInput {
  workspaceId: string;
  origin: V2RunOrigin;
}

export const ACTIVE_RUN_STATUSES: readonly V2RunStatus[] = [
  'queued', 'starting', 'running', 'waiting_approval', 'paused',
];

export class RunNotFoundError extends Error {
  readonly code = 'RUN_NOT_FOUND' as const;
  constructor(runId: string) {
    super(`Run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

export class InvalidRunTransitionError extends Error {
  readonly code = 'INVALID_RUN_TRANSITION' as const;
  constructor(from: string, to: string, detail?: string) {
    super(`INVALID_RUN_TRANSITION: cannot transition run from '${from}' to '${to}'${detail ? ` (${detail})` : ''}`);
    this.name = 'InvalidRunTransitionError';
  }
}

export class RunActiveExistsError extends Error {
  readonly code = 'RUN_ACTIVE_EXISTS' as const;
  constructor(taskId: string) {
    super(`RUN_ACTIVE_EXISTS: task ${taskId} already has an active run`);
    this.name = 'RunActiveExistsError';
  }
}

export class ParentRunNotFoundError extends Error {
  readonly code = 'PARENT_RUN_NOT_FOUND' as const;
  constructor(parentRunId: string) {
    super(`PARENT_RUN_NOT_FOUND: parent run not found: ${parentRunId}`);
    this.name = 'ParentRunNotFoundError';
  }
}

export class RunValidationError extends Error {
  readonly code = 'VALIDATION_FAILED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RunValidationError';
  }
}

export interface RunLifecycleTransitionWithinTransactionInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly expectedVersion: number;
  readonly expectedFrom: V2RunStatus;
  readonly to: V2RunStatus;
  readonly timestamp: string;
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

interface RunRow {
  id: string;
  workspace_id: string;
  task_id: string;
  parent_run_id: string | null;
  root_run_id: string;
  status: V2RunStatus;
  reason: V2RunReason;
  origin: V2RunOrigin;
  objective: string | null;
  failure_code: string | null;
  failure_message: string | null;
  cancellation_requested_at: string | null;
  recovery_required?: number | null;
  next_event_sequence: number;
  started_at: string | null;
  completed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  version: number;
}

function mapRow(row: RunRow): Run {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    parentRunId: row.parent_run_id ?? undefined,
    rootRunId: row.root_run_id,
    status: row.status,
    reason: row.reason,
    origin: row.origin,
    objective: row.objective ?? undefined,
    failureCode: row.failure_code ?? undefined,
    failureMessage: row.failure_message ?? undefined,
    cancellationRequestedAt: row.cancellation_requested_at ?? undefined,
    ...(row.recovery_required === undefined || row.recovery_required === null
      ? {}
      : { recoveryRequired: row.recovery_required === 1 }),
    nextEventSequence: row.next_event_sequence,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

// M2.4 §25 Run state machine. queued → failed is deliberately absent:
// Bridge claim compensation must go through failQueuedBridgeClaim.
const RUN_ALLOWED_TRANSITIONS: Record<V2RunStatus, V2RunStatus[]> = {
  queued: ['running', 'cancelled'],
  starting: [],
  running: ['completed', 'failed', 'cancelled'],
  waiting_approval: [],
  paused: [],
  completed: [],
  failed: [],
  cancelled: [],
};

export class RunRepository {
  constructor(private readonly db: TransactionDatabase) {}

  insert(input: InsertRunInput): Run {
    const id = createEntityId('run');
    const reason = input.reason ?? 'initial';
    let parentRunId: string | null = null;
    let rootRunId: string;

    if (reason === 'initial' || reason === 'manual') {
      if (input.parentRunId) {
        throw new RunValidationError(`parentRunId is not allowed for reason '${reason}'`);
      }
      rootRunId = id;
    } else if (reason === 'provider-comparison' && !input.parentRunId) {
      rootRunId = id;
    } else {
      if (!input.parentRunId) {
        throw new RunValidationError(`parentRunId is required for reason '${reason}'`);
      }
      const parent = this.db.prepare(
        'SELECT root_run_id FROM runs WHERE workspace_id = ? AND task_id = ? AND id = ?',
      ).get(input.workspaceId, input.taskId, input.parentRunId) as { root_run_id: string } | undefined;
      if (!parent) {
        throw new ParentRunNotFoundError(input.parentRunId);
      }
      parentRunId = input.parentRunId;
      rootRunId = parent.root_run_id;
    }

    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO runs (
          id, workspace_id, task_id, parent_run_id, root_run_id, status, reason, origin,
          objective, failure_code, failure_message, cancellation_requested_at, next_event_sequence,
          started_at, completed_at, created_by, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, NULL, NULL, NULL, 1, NULL, NULL, ?, ?, ?, 1)
      `).run(
        id,
        input.workspaceId,
        input.taskId,
        parentRunId,
        rootRunId,
        reason,
        input.origin,
        input.objective ?? null,
        input.createdBy,
        now,
        now,
      );
    } catch (err) {
      if (err instanceof Error && err.message.includes('UNIQUE constraint failed: runs.task_id')) {
        throw new RunActiveExistsError(input.taskId);
      }
      throw err;
    }
    return this.findById(input.workspaceId, id)!;
  }

  findById(workspaceId: string, runId: string): Run | undefined {
    const row = this.db.prepare(
      'SELECT * FROM runs WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, runId) as RunRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  /**
   * M3 P3C-1 opaque Run locator: the single global read used by the canonical
   * start route to resolve the owning workspace from an opaque runId, before
   * any body validation. Pure read — returns only the owning workspaceId,
   * never the Run, never reads status/version, never mutates. Every later
   * Run, Operation, and Idempotency access stays workspace-scoped.
   */
  findWorkspaceIdByOpaqueId(runId: string): string | undefined {
    const row = this.db.prepare(
      'SELECT workspace_id FROM runs WHERE id = ?',
    ).get(runId) as { workspace_id: string } | undefined;
    return row?.workspace_id;
  }

  listByTask(workspaceId: string, taskId: string): Run[] {
    const rows = this.db.prepare(
      'SELECT * FROM runs WHERE workspace_id = ? AND task_id = ? ORDER BY created_at ASC, id ASC',
    ).all(workspaceId, taskId) as RunRow[];
    return rows.map(mapRow);
  }

  findLatestByTask(workspaceId: string, taskId: string): Run | undefined {
    const row = this.db.prepare(
      'SELECT * FROM runs WHERE workspace_id = ? AND task_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
    ).get(workspaceId, taskId) as RunRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findActiveByTask(workspaceId: string, taskId: string): Run | undefined {
    const row = this.db.prepare(`
      SELECT * FROM runs
      WHERE workspace_id = ? AND task_id = ?
        AND status IN ('queued','starting','running','waiting_approval','paused')
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(workspaceId, taskId) as RunRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  transitionStatus(
    workspaceId: string,
    runId: string,
    expectedVersion: number,
    to: V2RunStatus,
    extra: { failureCode?: string; failureMessage?: string } = {},
  ): Run {
    const current = this.findById(workspaceId, runId);
    if (!current) throw new RunNotFoundError(runId);
    if (to === 'failed' && !extra.failureCode) {
      throw new InvalidRunTransitionError(current.status, to, 'failureCode is required');
    }
    if (!RUN_ALLOWED_TRANSITIONS[current.status].includes(to)) {
      throw new InvalidRunTransitionError(current.status, to);
    }
    const now = new Date().toISOString();
    const terminal = to === 'completed' || to === 'failed' || to === 'cancelled';
    const result = this.db.prepare(`
      UPDATE runs
      SET status = ?,
        started_at = CASE WHEN ? = 'running' THEN ? ELSE started_at END,
        completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
        failure_code = ?,
        failure_message = ?,
        cancellation_requested_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancellation_requested_at END,
        updated_at = ?,
        version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ?
    `).run(
      to,
      to, now,
      terminal ? 1 : 0, now,
      extra.failureCode ?? null,
      extra.failureMessage ?? null,
      to, now,
      now,
      workspaceId, runId, expectedVersion,
    );
    assertVersionedMutation(result as { changes: number }, {
      entityType: 'runs', entityId: runId, expectedVersion,
    });
    return this.findById(workspaceId, runId)!;
  }

  transitionLifecycleWithinTransaction(input: RunLifecycleTransitionWithinTransactionInput): Run {
    if (!input.workspaceId.trim() || !input.runId.trim()) {
      throw new RunValidationError('LIFECYCLE_VALIDATION_FAILED: workspaceId and runId are required');
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new RunValidationError('LIFECYCLE_VALIDATION_FAILED: expectedVersion must be a positive safe integer');
    }
    if (!isCanonicalUtcTimestamp(input.timestamp)) {
      throw new RunValidationError('LIFECYCLE_VALIDATION_FAILED: timestamp must be canonical UTC ISO 8601 milliseconds');
    }
    if (!getM3RunTransitionEventContract(input.expectedFrom, input.to)) {
      throw new InvalidRunTransitionError(input.expectedFrom, input.to);
    }
    if (input.to === 'failed'
      && (!input.failureCode?.trim() || !input.failureMessage?.trim())) {
      throw new InvalidRunTransitionError(input.expectedFrom, input.to, 'failureCode and failureMessage are required');
    }

    const result = this.db.prepare(`
      UPDATE runs
      SET status = ?,
        started_at = CASE
          WHEN ? = 'starting' AND ? = 'running' AND started_at IS NULL THEN ?
          ELSE started_at
        END,
        completed_at = CASE
          WHEN ? = 'running' AND ? = 'completed' AND completed_at IS NULL THEN ?
          ELSE completed_at
        END,
        failure_code = CASE WHEN ? = 'failed' THEN ? ELSE failure_code END,
        failure_message = CASE WHEN ? = 'failed' THEN ? ELSE failure_message END,
        cancellation_requested_at = CASE
          WHEN ? = 'cancelled' AND cancellation_requested_at IS NULL THEN ?
          ELSE cancellation_requested_at
        END,
        updated_at = ?,
        version = version + 1
      WHERE workspace_id = ? AND id = ? AND status = ? AND version = ?
    `).run(
      input.to,
      input.expectedFrom, input.to, input.timestamp,
      input.expectedFrom, input.to, input.timestamp,
      input.to, input.failureCode ?? null,
      input.to, input.failureMessage ?? null,
      input.to, input.timestamp,
      input.timestamp,
      input.workspaceId, input.runId, input.expectedFrom, input.expectedVersion,
    ) as { changes: number };

    if (result.changes !== 1) {
      const current = this.findById(input.workspaceId, input.runId);
      if (!current) throw new RunNotFoundError(input.runId);
      if (current.status !== input.expectedFrom) {
        throw new InvalidRunTransitionError(current.status, input.to, 'expectedFrom does not match current status');
      }
      throw new VersionConflictError('runs', input.runId, input.expectedVersion);
    }
    return this.findById(input.workspaceId, input.runId)!;
  }

  /** Bridge-claim compensation only: legacy_pipeline queued Run → failed (BRIDGE_CLAIM_FAILED). */
  failQueuedBridgeClaim(workspaceId: string, runId: string, expectedVersion: number, failureMessage: string): Run {
    const current = this.findById(workspaceId, runId);
    if (!current) throw new RunNotFoundError(runId);
    if (current.origin !== 'legacy_pipeline' || current.status !== 'queued') {
      throw new InvalidRunTransitionError(current.status, 'failed', 'failQueuedBridgeClaim requires a queued legacy_pipeline run');
    }
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE runs
      SET status = 'failed', failure_code = 'BRIDGE_CLAIM_FAILED', failure_message = ?,
        completed_at = ?, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ?
    `).run(failureMessage, now, now, workspaceId, runId, expectedVersion);
    assertVersionedMutation(result as { changes: number }, {
      entityType: 'runs', entityId: runId, expectedVersion,
    });
    return this.findById(workspaceId, runId)!;
  }

  /** Startup recovery only: an orphaned legacy_pipeline queued Run becomes failed. */
  failQueuedBridgeRestart(workspaceId: string, runId: string, expectedVersion: number, failureMessage: string): Run {
    const current = this.findById(workspaceId, runId);
    if (!current) throw new RunNotFoundError(runId);
    if (current.origin !== 'legacy_pipeline' || current.status !== 'queued') {
      throw new InvalidRunTransitionError(current.status, 'failed', 'failQueuedBridgeRestart requires a queued legacy_pipeline run');
    }
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE runs
      SET status = 'failed', failure_code = 'BRIDGE_PRESTART_INTERRUPTED', failure_message = ?,
        completed_at = ?, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ?
    `).run(failureMessage, now, now, workspaceId, runId, expectedVersion);
    assertVersionedMutation(result as { changes: number }, {
      entityType: 'runs', entityId: runId, expectedVersion,
    });
    return this.findById(workspaceId, runId)!;
  }

  listByWorkspace(workspaceId: string, opts: { status?: V2RunStatus } = {}): Run[] {
    const conditions = ['workspace_id = ?'];
    const params: unknown[] = [workspaceId];
    if (opts.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    const rows = this.db.prepare(
      `SELECT * FROM runs WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC, id ASC`,
    ).all(...params) as RunRow[];
    return rows.map(mapRow);
  }
}
