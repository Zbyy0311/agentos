import type { AgentTurnStatus } from '@agentos/shared';
import {
  AGENT_TURN_STATUSES,
  AGENT_TURN_TERMINAL_STATUSES,
  isAgentTurnTerminal,
} from '@agentos/shared';
import type { TransactionDatabase } from './Transaction.js';
import { inTransaction } from './Transaction.js';

export interface CreateAgentTurnInput {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly sourceMessageId?: string;
  readonly contextSnapshotId?: string;
  readonly createdAt: string;
}

export interface AgentTurnRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly sourceMessageId: string | null;
  readonly status: AgentTurnStatus;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly contextSnapshotId: string | null;
  readonly providerSessionId: string | null;
  readonly taskId: string | null;
  readonly runId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface TransitionAgentTurnInput {
  readonly workspaceId: string;
  readonly turnId: string;
  readonly expectedVersion: number;
  readonly to: AgentTurnStatus;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly providerSessionId?: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly updatedAt: string;
}

export interface AppendCheckpointInput {
  readonly id: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly cursor: number;
  readonly delta: string;
  readonly createdAt: string;
}

export interface CheckpointRecord {
  readonly id: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly ordinal: number;
  readonly cursor: number;
  readonly delta: string;
  readonly createdAt: string;
}

export class AgentTurnRepositoryError extends Error {
  constructor(
    readonly code:
      | 'TURN_INPUT_INVALID'
      | 'TURN_NOT_FOUND'
      | 'TURN_NOT_TRANSITIONABLE'
      | 'TURN_PERSISTENCE_FAILED'
      | 'CHECKPOINT_INPUT_INVALID'
      | 'CHECKPOINT_ORDINAL_CONFLICT'
      | 'CHECKPOINT_PERSISTENCE_FAILED',
  ) {
    super(`AGENT_TURN_${code}`);
    this.name = 'AgentTurnRepositoryError';
  }
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStatus(value: unknown): value is AgentTurnStatus {
  return (AGENT_TURN_STATUSES as readonly unknown[]).includes(value);
}

function canTransition(from: AgentTurnStatus, to: AgentTurnStatus): boolean {
  if (from === to) return false;
  if (isAgentTurnTerminal(from)) return false;
  if (from === 'created') return true;
  if (from === 'streaming') return to !== 'created';
  return false;
}

interface TurnRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  agent_id: string;
  source_message_id: string | null;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  context_snapshot_id: string | null;
  provider_session_id: string | null;
  task_id: string | null;
  run_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface CheckpointRow {
  id: string;
  message_id: string;
  turn_id: string;
  ordinal: number;
  cursor: number;
  delta: string;
  created_at: string;
}

export class AgentTurnRepository {
  constructor(private readonly db: TransactionDatabase) {}

  createTurn(input: CreateAgentTurnInput): AgentTurnRecord {
    if (!nonBlank(input.id) || !nonBlank(input.conversationId) || !nonBlank(input.workspaceId)
      || !nonBlank(input.agentId) || !nonBlank(input.createdAt)) {
      throw new AgentTurnRepositoryError('TURN_INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        this.assertConversation(input.workspaceId, input.conversationId);
        this.db.prepare(
          `INSERT INTO cr_agent_turns
            (id, conversation_id, workspace_id, agent_id, source_message_id,
             status, context_snapshot_id, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'created', ?, 1, ?, ?)`,
        ).run(
          input.id, input.conversationId, input.workspaceId, input.agentId,
          input.sourceMessageId ?? null, input.contextSnapshotId ?? null,
          input.createdAt, input.createdAt,
        );
        return this.requireTurn(input.workspaceId, input.id);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  findTurnById(workspaceId: string, turnId: string): AgentTurnRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(turnId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_agent_turns WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, turnId) as TurnRow | undefined;
    return row === undefined ? undefined : toTurnRecord(row);
  }

  listTurnsByConversation(workspaceId: string, conversationId: string): AgentTurnRecord[] {
    if (!nonBlank(workspaceId) || !nonBlank(conversationId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_agent_turns WHERE workspace_id = ? AND conversation_id = ? ORDER BY created_at ASC',
    ).all(workspaceId, conversationId) as TurnRow[];
    return rows.map(toTurnRecord);
  }

  transitionTurn(input: TransitionAgentTurnInput): AgentTurnRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.turnId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || !nonBlank(input.updatedAt) || !isStatus(input.to)) {
      throw new AgentTurnRepositoryError('TURN_INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        const current = this.db.prepare(
          'SELECT * FROM cr_agent_turns WHERE workspace_id = ? AND id = ?',
        ).get(input.workspaceId, input.turnId) as TurnRow | undefined;
        if (current === undefined) throw new AgentTurnRepositoryError('TURN_NOT_FOUND');
        if (current.version !== input.expectedVersion
          || !canTransition(current.status as AgentTurnStatus, input.to)) {
          throw new AgentTurnRepositoryError('TURN_NOT_TRANSITIONABLE');
        }
        const isTerminal = isAgentTurnTerminal(input.to);
        this.db.prepare(
          `UPDATE cr_agent_turns
           SET status = ?, failure_code = ?, failure_message = ?,
               provider_session_id = COALESCE(?, provider_session_id),
               task_id = COALESCE(?, task_id),
               run_id = COALESCE(?, run_id),
               completed_at = ?,
               version = version + 1, updated_at = ?
           WHERE workspace_id = ? AND id = ? AND version = ?`,
        ).run(
          input.to,
          input.failureCode ?? null,
          input.failureMessage ?? null,
          input.providerSessionId ?? null,
          input.taskId ?? null,
          input.runId ?? null,
          isTerminal ? input.updatedAt : null,
          input.updatedAt,
          input.workspaceId, input.turnId, input.expectedVersion,
        );
        return this.requireTurn(input.workspaceId, input.turnId);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  appendCheckpoint(input: AppendCheckpointInput): CheckpointRecord {
    if (!nonBlank(input.id) || !nonBlank(input.messageId) || !nonBlank(input.turnId)
      || !Number.isSafeInteger(input.ordinal) || input.ordinal < 1
      || !Number.isSafeInteger(input.cursor) || input.cursor < 0
      || typeof input.delta !== 'string' || !nonBlank(input.createdAt)) {
      throw new AgentTurnRepositoryError('CHECKPOINT_INPUT_INVALID');
    }
    try {
      return inTransaction(this.db, () => {
        this.db.prepare(
          `INSERT INTO cr_message_checkpoints
            (id, message_id, turn_id, ordinal, cursor, delta, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id, input.messageId, input.turnId, input.ordinal,
          input.cursor, input.delta, input.createdAt,
        );
        return this.requireCheckpoint(input.id);
      });
    } catch (error) {
      if (error instanceof AgentTurnRepositoryError) throw error;
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        throw new AgentTurnRepositoryError('CHECKPOINT_ORDINAL_CONFLICT');
      }
      throw new AgentTurnRepositoryError('CHECKPOINT_PERSISTENCE_FAILED');
    }
  }

  listCheckpointsByMessage(messageId: string, afterCursor = 0): CheckpointRecord[] {
    if (!nonBlank(messageId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_message_checkpoints WHERE message_id = ? AND cursor > ? ORDER BY ordinal ASC',
    ).all(messageId, afterCursor) as CheckpointRow[];
    return rows.map(toCheckpointRecord);
  }

  listCheckpointsByTurn(turnId: string): CheckpointRecord[] {
    if (!nonBlank(turnId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_message_checkpoints WHERE turn_id = ? ORDER BY ordinal ASC',
    ).all(turnId) as CheckpointRow[];
    return rows.map(toCheckpointRecord);
  }

  private assertConversation(workspaceId: string, conversationId: string): void {
    const row = this.db.prepare(
      'SELECT 1 AS present FROM cr_conversations WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, conversationId);
    if (row === undefined) throw new AgentTurnRepositoryError('TURN_INPUT_INVALID');
  }

  private requireTurn(workspaceId: string, turnId: string): AgentTurnRecord {
    const turn = this.findTurnById(workspaceId, turnId);
    if (turn === undefined) throw new AgentTurnRepositoryError('TURN_NOT_FOUND');
    return turn;
  }

  private requireCheckpoint(id: string): CheckpointRecord {
    const row = this.db.prepare(
      'SELECT * FROM cr_message_checkpoints WHERE id = ?',
    ).get(id) as CheckpointRow | undefined;
    if (row === undefined) throw new AgentTurnRepositoryError('CHECKPOINT_PERSISTENCE_FAILED');
    return toCheckpointRecord(row);
  }

  private publicError(error: unknown): AgentTurnRepositoryError {
    if (error instanceof AgentTurnRepositoryError) return error;
    return new AgentTurnRepositoryError('TURN_PERSISTENCE_FAILED');
  }
}

function toTurnRecord(row: TurnRow): AgentTurnRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    sourceMessageId: row.source_message_id,
    status: row.status as AgentTurnStatus,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    contextSnapshotId: row.context_snapshot_id,
    providerSessionId: row.provider_session_id,
    taskId: row.task_id,
    runId: row.run_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function toCheckpointRecord(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    turnId: row.turn_id,
    ordinal: row.ordinal,
    cursor: row.cursor,
    delta: row.delta,
    createdAt: row.created_at,
  };
}
