import type { CreateV2TaskInput, Task, V2TaskPriority, V2TaskStatus } from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { assertVersionedMutation } from './Repository.js';
import { createEntityId } from './Identity.js';

export interface InsertTaskInput extends CreateV2TaskInput {
  workspaceId: string;
  legacyTaskId?: string;
}

export class TaskNotFoundError extends Error {
  readonly code = 'TASK_NOT_FOUND' as const;
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class InvalidTaskTransitionError extends Error {
  readonly code = 'INVALID_TASK_TRANSITION' as const;
  constructor(from: string, to: string) {
    super(`INVALID_TASK_TRANSITION: cannot transition task from '${from}' to '${to}'`);
    this.name = 'InvalidTaskTransitionError';
  }
}

export class TaskLegacyIdConflictError extends Error {
  readonly code = 'TASK_LEGACY_ID_CONFLICT' as const;
  constructor(workspaceId: string, legacyTaskId: string) {
    super(`legacy_task_id '${legacyTaskId}' already exists in workspace ${workspaceId}`);
    this.name = 'TaskLegacyIdConflictError';
  }
}

function isLegacyIdConflictError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const sqliteError = err as Error & { code?: unknown; errcode?: unknown };
  return sqliteError.code === 'ERR_SQLITE_ERROR'
    && Number(sqliteError.errcode) === 2067
    && sqliteError.message === 'UNIQUE constraint failed: tasks.workspace_id, tasks.legacy_task_id';
}

interface TaskRow {
  id: string;
  workspace_id: string;
  legacy_task_id: string | null;
  title: string;
  description: string | null;
  status: V2TaskStatus;
  priority: V2TaskPriority;
  source_conversation_id: string | null;
  source_message_id: string | null;
  accepted_run_id: string | null;
  pending_result_run_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  archived_at: string | null;
  version: number;
}

function mapRow(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    legacyTaskId: row.legacy_task_id ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    priority: row.priority,
    sourceConversationId: row.source_conversation_id ?? undefined,
    sourceMessageId: row.source_message_id ?? undefined,
    acceptedRunId: row.accepted_run_id ?? undefined,
    pendingResultRunId: row.pending_result_run_id ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    version: row.version,
  };
}

// M2.4 §24 Task state machine (repository level).
// done is only reachable via accept(); done/cancelled reopen via reopen().
const TASK_ALLOWED_TRANSITIONS: Record<V2TaskStatus, V2TaskStatus[]> = {
  open: ['in_progress', 'cancelled'],
  in_progress: ['in_progress', 'open', 'cancelled'],
  blocked: [],
  done: [],
  cancelled: [],
};

export class TaskRepository {
  constructor(private readonly db: TransactionDatabase) {}

  insert(input: InsertTaskInput): Task {
    const id = createEntityId('task');
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO tasks (
          id, workspace_id, legacy_task_id, title, description, status, priority,
          source_conversation_id, source_message_id, accepted_run_id, pending_result_run_id,
          created_by, created_at, updated_at, completed_at, archived_at, version
        ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, 1)
      `).run(
        id,
        input.workspaceId,
        input.legacyTaskId ?? null,
        input.title,
        input.description ?? null,
        input.priority ?? 'normal',
        input.sourceConversationId ?? null,
        input.sourceMessageId ?? null,
        input.createdBy,
        now,
        now,
      );
    } catch (err) {
      if (isLegacyIdConflictError(err)) {
        throw new TaskLegacyIdConflictError(input.workspaceId, input.legacyTaskId ?? '');
      }
      throw err;
    }
    return this.findById(input.workspaceId, id)!;
  }

  findById(workspaceId: string, taskId: string): Task | undefined {
    const row = this.db.prepare(
      'SELECT * FROM tasks WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, taskId) as TaskRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  findByLegacyTaskId(workspaceId: string, legacyTaskId: string): Task | undefined {
    const row = this.db.prepare(
      'SELECT * FROM tasks WHERE workspace_id = ? AND legacy_task_id = ?',
    ).get(workspaceId, legacyTaskId) as TaskRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  listByWorkspace(workspaceId: string, opts: { status?: V2TaskStatus; includeArchived?: boolean } = {}): Task[] {
    const conditions = ['workspace_id = ?'];
    const params: unknown[] = [workspaceId];
    if (opts.status) {
      conditions.push('status = ?');
      params.push(opts.status);
    }
    if (!opts.includeArchived) {
      conditions.push('archived_at IS NULL');
    }
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY updated_at DESC, id ASC`,
    ).all(...params) as TaskRow[];
    return rows.map(mapRow);
  }

  transitionStatus(
    workspaceId: string,
    taskId: string,
    expectedVersion: number,
    to: V2TaskStatus,
    extra: { pendingResultRunId?: string } = {},
  ): Task {
    const current = this.findById(workspaceId, taskId);
    if (!current) throw new TaskNotFoundError(taskId);
    if (!TASK_ALLOWED_TRANSITIONS[current.status].includes(to)) {
      throw new InvalidTaskTransitionError(current.status, to);
    }
    const now = new Date().toISOString();
    let result: unknown;
    if (to === 'cancelled') {
      result = this.db.prepare(`
        UPDATE tasks
        SET status = 'cancelled', accepted_run_id = NULL, pending_result_run_id = NULL,
          completed_at = NULL, updated_at = ?, version = version + 1
        WHERE workspace_id = ? AND id = ? AND version = ?
      `).run(now, workspaceId, taskId, expectedVersion);
    } else if (to === 'in_progress' && current.status === 'in_progress') {
      if (!extra.pendingResultRunId) {
        throw new InvalidTaskTransitionError(current.status, to);
      }
      result = this.db.prepare(`
        UPDATE tasks
        SET pending_result_run_id = ?, updated_at = ?, version = version + 1
        WHERE workspace_id = ? AND id = ? AND version = ?
      `).run(extra.pendingResultRunId, now, workspaceId, taskId, expectedVersion);
    } else {
      result = this.db.prepare(`
        UPDATE tasks
        SET status = ?, updated_at = ?, version = version + 1
        WHERE workspace_id = ? AND id = ? AND version = ?
      `).run(to, now, workspaceId, taskId, expectedVersion);
    }
    assertVersionedMutation(result as { changes: number }, {
      entityType: 'tasks', entityId: taskId, expectedVersion,
    });
    return this.findById(workspaceId, taskId)!;
  }

  /** Pure Task Aggregate transition in_progress → done; never reads or validates Runs. */
  accept(workspaceId: string, taskId: string, expectedVersion: number, acceptedRunId: string): Task {
    const current = this.findById(workspaceId, taskId);
    if (!current) throw new TaskNotFoundError(taskId);
    if (current.status !== 'in_progress') {
      throw new InvalidTaskTransitionError(current.status, 'done');
    }
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE tasks
      SET status = 'done', accepted_run_id = ?, pending_result_run_id = NULL,
        completed_at = ?, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ?
    `).run(acceptedRunId, now, now, workspaceId, taskId, expectedVersion);
    assertVersionedMutation(result as { changes: number }, {
      entityType: 'tasks', entityId: taskId, expectedVersion,
    });
    return this.findById(workspaceId, taskId)!;
  }

  reopen(workspaceId: string, taskId: string, expectedVersion: number): Task {
    const current = this.findById(workspaceId, taskId);
    if (!current) throw new TaskNotFoundError(taskId);
    if (current.status !== 'done' && current.status !== 'cancelled') {
      throw new InvalidTaskTransitionError(current.status, 'open');
    }
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE tasks
      SET status = 'open', accepted_run_id = NULL, pending_result_run_id = NULL,
        completed_at = NULL, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ?
    `).run(now, workspaceId, taskId, expectedVersion);
    assertVersionedMutation(result as { changes: number }, {
      entityType: 'tasks', entityId: taskId, expectedVersion,
    });
    return this.findById(workspaceId, taskId)!;
  }

  updateDetails(
    workspaceId: string,
    taskId: string,
    expectedVersion: number,
    patch: { title?: string; description?: string; priority?: V2TaskPriority },
  ): Task {
    const current = this.findById(workspaceId, taskId);
    if (!current) throw new TaskNotFoundError(taskId);
    if (current.status !== 'open' && current.status !== 'blocked') {
      throw new InvalidTaskTransitionError(current.status, 'updateDetails');
    }
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE tasks
      SET title = ?, description = ?, priority = ?, updated_at = ?, version = version + 1
      WHERE workspace_id = ? AND id = ? AND version = ?
    `).run(
      patch.title ?? current.title,
      patch.description !== undefined ? patch.description : (current.description ?? null),
      patch.priority ?? current.priority,
      now,
      workspaceId,
      taskId,
      expectedVersion,
    );
    assertVersionedMutation(result as { changes: number }, {
      entityType: 'tasks', entityId: taskId, expectedVersion,
    });
    return this.findById(workspaceId, taskId)!;
  }
}
