import type { TransactionDatabase } from './Transaction.js';

/**
 * Append-only operational audit trail (migration 065; 10-Data-Model §83).
 *
 * The repository deliberately exposes NO update or delete methods, and the
 * migration 065 BEFORE UPDATE / BEFORE DELETE triggers fail closed at the
 * database level even for out-of-band writes.
 */
export class AuditRecordRepositoryError extends Error {
  constructor(readonly code: 'INPUT_INVALID' | 'PERSISTENCE_FAILED' | 'READ_FAILED', message: string) {
    super(code === 'PERSISTENCE_FAILED' || code === 'READ_FAILED' ? code : code + ': ' + message);
    this.name = 'AuditRecordRepositoryError';
  }
}

export type AuditActorType = 'user' | 'agent' | 'system';

export interface AuditRecordInput {
  readonly id: string;
  readonly workspaceId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly result: string;
  readonly summary: string;
  readonly detail?: Record<string, unknown>;
  readonly createdAt: string;
}

export interface AuditRecord {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly result: string;
  readonly summary: string;
  readonly detail: Record<string, unknown> | null;
  readonly createdAt: string;
}

export interface AuditRecordQuery {
  readonly workspaceId?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly actionType?: string;
  readonly actorId?: string;
  readonly limit?: number;
  /** 'asc' (oldest first, default) or 'desc' (newest first). */
  readonly order?: 'asc' | 'desc';
}

const ACTORS = new Set<string>(['user', 'agent', 'system']);

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toRecord(row: Record<string, unknown>): AuditRecord {
  return {
    id: row.id as string,
    workspaceId: (row.workspace_id as string | null) ?? null,
    taskId: (row.task_id as string | null) ?? null,
    runId: (row.run_id as string | null) ?? null,
    actorType: row.actor_type as AuditActorType,
    actorId: row.actor_id as string,
    actionType: row.action_type as string,
    resourceType: row.resource_type as string,
    resourceId: (row.resource_id as string | null) ?? null,
    result: row.result as string,
    summary: row.summary as string,
    detail: row.detail_json === null || row.detail_json === undefined
      ? null
      : JSON.parse(row.detail_json as string) as Record<string, unknown>,
    createdAt: row.created_at as string,
  };
}

export class AuditRecordRepository {
  constructor(private readonly db: TransactionDatabase) {}

  append(input: AuditRecordInput): AuditRecord {
    if (!nonBlank(input.id) || !nonBlank(input.actorId) || !nonBlank(input.actionType)
      || !nonBlank(input.resourceType) || !nonBlank(input.result) || !nonBlank(input.summary)
      || !nonBlank(input.createdAt)) {
      throw new AuditRecordRepositoryError('INPUT_INVALID', 'a required audit field is missing or blank');
    }
    if (!ACTORS.has(input.actorType)) {
      throw new AuditRecordRepositoryError('INPUT_INVALID', 'actorType must be one of user | agent | system');
    }
    try {
      this.db.prepare(
        `INSERT INTO audit_records (id, workspace_id, task_id, run_id, actor_type, actor_id,
           action_type, resource_type, resource_id, result, summary, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.id, input.workspaceId ?? null, input.taskId ?? null, input.runId ?? null,
        input.actorType, input.actorId, input.actionType, input.resourceType,
        input.resourceId ?? null, input.result, input.summary,
        input.detail === undefined ? null : JSON.stringify(input.detail), input.createdAt);
    } catch (error) {
      throw new AuditRecordRepositoryError('PERSISTENCE_FAILED', error instanceof Error ? error.message : 'audit record could not be appended');
    }
    const record = this.findById(input.id);
    if (record === undefined) {
      throw new AuditRecordRepositoryError('PERSISTENCE_FAILED', 'audit row not readable after append: ' + input.id);
    }
    return record;
  }

  findById(id: string): AuditRecord | undefined {
    if (!nonBlank(id)) return undefined;
    const row = this.db.prepare('SELECT * FROM audit_records WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  query(query: AuditRecordQuery = {}): AuditRecord[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.workspaceId !== undefined) { clauses.push('workspace_id = ?'); params.push(query.workspaceId); }
    if (query.resourceType !== undefined) { clauses.push('resource_type = ?'); params.push(query.resourceType); }
    if (query.resourceId !== undefined) { clauses.push('resource_id = ?'); params.push(query.resourceId); }
    if (query.actionType !== undefined) { clauses.push('action_type = ?'); params.push(query.actionType); }
    if (query.actorId !== undefined) { clauses.push('actor_id = ?'); params.push(query.actorId); }
    const limit = query.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new AuditRecordRepositoryError('INPUT_INVALID', 'limit must be an integer >= 1');
    }
    const direction = query.order === 'desc' ? 'DESC' : 'ASC';
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db.prepare(
      `SELECT * FROM audit_records${where} ORDER BY created_at ${direction}, id ${direction} LIMIT ?`,
    ).all(...params, limit) as Record<string, unknown>[];
    return rows.map(toRecord);
  }
}
