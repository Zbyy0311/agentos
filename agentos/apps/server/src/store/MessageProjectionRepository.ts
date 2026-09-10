import type { TransactionDatabase } from './Transaction.js';

/**
 * CR-4b idempotent Conversation message projection persistence.
 *
 * Frozen design: docs/implementation/milestones/CR4-schema-authorization.md section 5.
 * The durable projection key is the table's `UNIQUE (projector_id, source_event_id)`,
 * the storage form of `projectionKeyId()` from the CR-0 contracts. One Runtime Event
 * produces at most one Conversation card per projector, including under retry, race,
 * and restart.
 *
 * This is a narrow persistence seam ONLY: it contains no projector, no route, no
 * transport, and no Run wiring.
 */

export interface InsertProjectionInput {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly projectorId: string;
  readonly sourceEventId: string;
  readonly messageId: string;
  readonly createdAt: string;
}

export interface ProjectionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly projectorId: string;
  readonly sourceEventId: string;
  readonly messageId: string;
  readonly createdAt: string;
}

export type MessageProjectionRepositoryErrorCode =
  | 'PROJECTION_INPUT_INVALID'
  | 'PROJECTION_KEY_CONFLICT'
  | 'PROJECTION_PERSISTENCE_FAILED';

export class MessageProjectionRepositoryError extends Error {
  constructor(readonly code: MessageProjectionRepositoryErrorCode) {
    super(`MESSAGE_PROJECTION_${code}`);
    this.name = 'MessageProjectionRepositoryError';
  }
}

interface ProjectionRow {
  id: string;
  workspace_id: string;
  conversation_id: string;
  projector_id: string;
  source_event_id: string;
  message_id: string;
  created_at: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export class MessageProjectionRepository {
  constructor(private readonly db: TransactionDatabase) {}

  /**
   * Record one projection. The unique key makes a duplicate insert fail closed
   * with PROJECTION_KEY_CONFLICT so the caller can converge on the existing card
   * instead of creating a second one.
   */
  insertWithinTransaction(input: InsertProjectionInput): ProjectionRecord {
    if (!nonBlank(input.id) || !nonBlank(input.workspaceId) || !nonBlank(input.conversationId)
      || !nonBlank(input.projectorId) || !nonBlank(input.sourceEventId)
      || !nonBlank(input.messageId) || !nonBlank(input.createdAt)) {
      throw new MessageProjectionRepositoryError('PROJECTION_INPUT_INVALID');
    }
    try {
      this.db.prepare(
        'INSERT INTO cr_message_projections (id, workspace_id, conversation_id, projector_id, source_event_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        input.id, input.workspaceId, input.conversationId, input.projectorId,
        input.sourceEventId, input.messageId, input.createdAt,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        throw new MessageProjectionRepositoryError('PROJECTION_KEY_CONFLICT');
      }
      throw new MessageProjectionRepositoryError('PROJECTION_PERSISTENCE_FAILED');
    }
    const row = this.db.prepare(
      'SELECT * FROM cr_message_projections WHERE id = ?',
    ).get(input.id) as ProjectionRow | undefined;
    if (row === undefined) throw new MessageProjectionRepositoryError('PROJECTION_PERSISTENCE_FAILED');
    return toProjectionRecord(row);
  }

  /** Durable dedup lookup: the card already projected for this Event. */
  findByKey(workspaceId: string, projectorId: string, sourceEventId: string): ProjectionRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(projectorId) || !nonBlank(sourceEventId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_message_projections WHERE workspace_id = ? AND projector_id = ? AND source_event_id = ?',
    ).get(workspaceId, projectorId, sourceEventId) as ProjectionRow | undefined;
    return row === undefined ? undefined : toProjectionRecord(row);
  }

  findById(workspaceId: string, projectionId: string): ProjectionRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(projectionId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_message_projections WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, projectionId) as ProjectionRow | undefined;
    return row === undefined ? undefined : toProjectionRecord(row);
  }

  listByMessage(messageId: string): ProjectionRecord[] {
    if (!nonBlank(messageId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_message_projections WHERE message_id = ? ORDER BY created_at ASC, id ASC',
    ).all(messageId) as ProjectionRow[];
    return rows.map(toProjectionRecord);
  }

  listByConversation(workspaceId: string, conversationId: string): ProjectionRecord[] {
    if (!nonBlank(workspaceId) || !nonBlank(conversationId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_message_projections WHERE workspace_id = ? AND conversation_id = ? ORDER BY created_at DESC, id ASC',
    ).all(workspaceId, conversationId) as ProjectionRow[];
    return rows.map(toProjectionRecord);
  }
}

function toProjectionRecord(row: ProjectionRow): ProjectionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    projectorId: row.projector_id,
    sourceEventId: row.source_event_id,
    messageId: row.message_id,
    createdAt: row.created_at,
  };
}

