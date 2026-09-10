import {
  GROUP_STOP_REASONS,
  LOOP_GUARD_SIGNALS,
  validateGroupInteractionBudget,
  type GroupInteractionBudgetV1,
  type GroupStopReason,
  type LoopGuardSignal,
} from '@agentos/shared';
import { inTransaction, type TransactionDatabase } from './Transaction.js';

/**
 * CR-5 bounded Group Conversation persistence.
 *
 * Frozen design: docs/implementation/milestones/CR5-schema-authorization.md.
 * This is a narrow persistence seam ONLY: budget validation, reply accounting, and
 * terminal-state transitions. It contains no loop-guard detection policy, no
 * selector, no route, and no admission logic (those live in BoundedGroupService).
 */

export type GroupInteractionStatus = 'active' | 'stopped' | 'exhausted' | 'completed';

export interface GroupInteractionRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly maxAgentsPerTurn: number;
  readonly maxRepliesPerAgent: number;
  readonly maxTotalReplies: number;
  readonly maxAgentHops: number;
  readonly timeoutMs: number | null;
  readonly contextTokenBudget: number | null;
  readonly replyCount: number;
  readonly hopCount: number;
  readonly status: GroupInteractionStatus;
  readonly stopReason: GroupStopReason | null;
  readonly loopGuardSignal: LoopGuardSignal | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export interface GroupReplyRecord {
  readonly id: string;
  readonly interactionId: string;
  readonly agentId: string;
  readonly messageId: string;
  readonly turnId: string | null;
  readonly contentHash: string;
  readonly mentionTargetsJson: string | null;
  readonly hopFromAgentId: string | null;
  readonly hopOrder: number;
  readonly contextSnapshotId: string | null;
  readonly createdAt: string;
}

export interface CreateGroupInteractionInput {
  readonly id: string;
  readonly conversationId: string;
  readonly workspaceId: string;
  readonly budget: GroupInteractionBudgetV1;
  readonly createdAt: string;
}

export interface AppendGroupReplyInput {
  readonly id: string;
  readonly interactionId: string;
  readonly agentId: string;
  readonly messageId: string;
  readonly turnId?: string;
  readonly contentHash: string;
  readonly mentionTargetsJson?: string;
  readonly hopFromAgentId?: string;
  readonly hopOrder: number;
  readonly contextSnapshotId?: string;
  readonly createdAt: string;
}

export interface AdvanceGroupInteractionInput {
  readonly workspaceId: string;
  readonly interactionId: string;
  readonly expectedVersion: number;
  readonly replyIncrement: number;
  readonly hopIncrement: number;
  readonly status?: GroupInteractionStatus;
  readonly stopReason?: GroupStopReason;
  readonly loopGuardSignal?: LoopGuardSignal;
  readonly endedAt?: string;
  readonly updatedAt: string;
}

export type GroupInteractionRepositoryErrorCode =
  | 'INTERACTION_INPUT_INVALID'
  | 'INTERACTION_NOT_FOUND'
  | 'INTERACTION_NOT_TRANSITIONABLE'
  | 'REPLY_INPUT_INVALID'
  | 'REPLY_PERSISTENCE_FAILED';

export class GroupInteractionRepositoryError extends Error {
  constructor(readonly code: GroupInteractionRepositoryErrorCode) {
    super(`GROUP_INTERACTION_${code}`);
    this.name = 'GroupInteractionRepositoryError';
  }
}

interface InteractionRow {
  id: string;
  conversation_id: string;
  workspace_id: string;
  max_agents_per_turn: number;
  max_replies_per_agent: number;
  max_total_replies: number;
  max_agent_hops: number;
  timeout_ms: number | null;
  context_token_budget: number | null;
  reply_count: number;
  hop_count: number;
  status: string;
  stop_reason: string | null;
  loop_guard_signal: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

interface ReplyRow {
  id: string;
  interaction_id: string;
  agent_id: string;
  message_id: string;
  turn_id: string | null;
  content_hash: string;
  mention_targets_json: string | null;
  hop_from_agent_id: string | null;
  hop_order: number;
  context_snapshot_id: string | null;
  created_at: string;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isGroupStatus(value: unknown): value is GroupInteractionStatus {
  return value === 'active' || value === 'stopped' || value === 'exhausted' || value === 'completed';
}
function isStopReason(value: unknown): value is GroupStopReason {
  return (GROUP_STOP_REASONS as readonly unknown[]).includes(value);
}
function isLoopGuardSignal(value: unknown): value is LoopGuardSignal {
  return (LOOP_GUARD_SIGNALS as readonly unknown[]).includes(value);
}

export class GroupInteractionRepository {
  constructor(private readonly db: TransactionDatabase) {}

  createInteraction(input: CreateGroupInteractionInput): GroupInteractionRecord {
    if (!nonBlank(input.id) || !nonBlank(input.conversationId) || !nonBlank(input.workspaceId)
      || !nonBlank(input.createdAt)) {
      throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    }
    const budgetCheck = validateGroupInteractionBudget(input.budget);
    if (!budgetCheck.valid) throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    try {
      return inTransaction(this.db, () => {
        this.assertConversation(input.workspaceId, input.conversationId);
        this.db.prepare(
          `INSERT INTO cr_group_interactions (
            id, conversation_id, workspace_id, max_agents_per_turn, max_replies_per_agent,
            max_total_replies, max_agent_hops, timeout_ms, context_token_budget,
            reply_count, hop_count, status, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'active', 1, ?, ?)`,
        ).run(
          input.id, input.conversationId, input.workspaceId,
          input.budget.maxAgentsPerTurn, input.budget.maxRepliesPerAgent,
          input.budget.maxTotalReplies, input.budget.maxAgentHops,
          input.budget.timeoutMs ?? null, input.budget.contextTokenBudget ?? null,
          input.createdAt, input.createdAt,
        );
        return this.requireInteraction(input.workspaceId, input.id);
      });
    } catch (error) {
      throw this.publicError(error);
    }
  }

  findInteractionById(workspaceId: string, interactionId: string): GroupInteractionRecord | undefined {
    if (!nonBlank(workspaceId) || !nonBlank(interactionId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_group_interactions WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, interactionId) as InteractionRow | undefined;
    return row === undefined ? undefined : toInteractionRecord(row);
  }

  listInteractions(workspaceId: string, conversationId: string): GroupInteractionRecord[] {
    if (!nonBlank(workspaceId) || !nonBlank(conversationId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_group_interactions WHERE workspace_id = ? AND conversation_id = ? ORDER BY created_at ASC',
    ).all(workspaceId, conversationId) as InteractionRow[];
    return rows.map(toInteractionRecord);
  }

  appendReplyWithinTransaction(input: AppendGroupReplyInput): GroupReplyRecord {
    if (!nonBlank(input.id) || !nonBlank(input.interactionId) || !nonBlank(input.agentId)
      || !nonBlank(input.messageId) || !nonBlank(input.contentHash) || !nonBlank(input.createdAt)
      || !Number.isSafeInteger(input.hopOrder) || input.hopOrder < 0) {
      throw new GroupInteractionRepositoryError('REPLY_INPUT_INVALID');
    }
    try {
      this.db.prepare(
        `INSERT INTO cr_group_interaction_replies (
          id, interaction_id, agent_id, message_id, turn_id, content_hash,
          mention_targets_json, hop_from_agent_id, hop_order, context_snapshot_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id, input.interactionId, input.agentId, input.messageId,
        input.turnId ?? null, input.contentHash, input.mentionTargetsJson ?? null,
        input.hopFromAgentId ?? null, input.hopOrder, input.contextSnapshotId ?? null,
        input.createdAt,
      );
      const row = this.db.prepare('SELECT * FROM cr_group_interaction_replies WHERE id = ?')
        .get(input.id) as ReplyRow | undefined;
      if (row === undefined) throw new GroupInteractionRepositoryError('REPLY_PERSISTENCE_FAILED');
      return toReplyRecord(row);
    } catch (error) {
      if (error instanceof GroupInteractionRepositoryError) throw error;
      throw new GroupInteractionRepositoryError('REPLY_PERSISTENCE_FAILED');
    }
  }

  listReplies(interactionId: string): GroupReplyRecord[] {
    if (!nonBlank(interactionId)) return [];
    const rows = this.db.prepare(
      'SELECT * FROM cr_group_interaction_replies WHERE interaction_id = ? ORDER BY created_at ASC, id ASC',
    ).all(interactionId) as ReplyRow[];
    return rows.map(toReplyRecord);
  }

  countRepliesByAgent(interactionId: string, agentId: string): number {
    if (!nonBlank(interactionId) || !nonBlank(agentId)) return 0;
    return (this.db.prepare(
      'SELECT COUNT(*) AS n FROM cr_group_interaction_replies WHERE interaction_id = ? AND agent_id = ?',
    ).get(interactionId, agentId) as { n: number }).n;
  }

  countDistinctAgents(interactionId: string): number {
    if (!nonBlank(interactionId)) return 0;
    return (this.db.prepare(
      'SELECT COUNT(DISTINCT agent_id) AS n FROM cr_group_interaction_replies WHERE interaction_id = ?',
    ).get(interactionId) as { n: number }).n;
  }

  /** Loop-guard evidence: a prior reply in this interaction with the same content hash. */
  findReplyByContentHash(interactionId: string, contentHash: string): GroupReplyRecord | undefined {
    if (!nonBlank(interactionId) || !nonBlank(contentHash)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_group_interaction_replies WHERE interaction_id = ? AND content_hash = ? ORDER BY created_at ASC LIMIT 1',
    ).get(interactionId, contentHash) as ReplyRow | undefined;
    return row === undefined ? undefined : toReplyRecord(row);
  }

  /** Latest reply in the interaction, or undefined when none exists yet. */
  latestReply(interactionId: string): GroupReplyRecord | undefined {
    if (!nonBlank(interactionId)) return undefined;
    const row = this.db.prepare(
      'SELECT * FROM cr_group_interaction_replies WHERE interaction_id = ? ORDER BY hop_order DESC, created_at DESC LIMIT 1',
    ).get(interactionId) as ReplyRow | undefined;
    return row === undefined ? undefined : toReplyRecord(row);
  }

  /**
   * Advance counters and optionally terminate. One-way terminal transitions under
   * optimistic concurrency; replyCount/hopCount increments are applied even when no
   * status change is requested.
   */
  advanceInteractionWithinTransaction(input: AdvanceGroupInteractionInput): GroupInteractionRecord {
    if (!nonBlank(input.workspaceId) || !nonBlank(input.interactionId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || !Number.isSafeInteger(input.replyIncrement) || input.replyIncrement < 0
      || !Number.isSafeInteger(input.hopIncrement) || input.hopIncrement < 0
      || !nonBlank(input.updatedAt)
      || (input.status !== undefined && !isGroupStatus(input.status))
      || (input.stopReason !== undefined && !isStopReason(input.stopReason))
      || (input.loopGuardSignal !== undefined && !isLoopGuardSignal(input.loopGuardSignal))) {
      throw new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
    }
    const current = this.db.prepare(
      'SELECT * FROM cr_group_interactions WHERE workspace_id = ? AND id = ?',
    ).get(input.workspaceId, input.interactionId) as InteractionRow | undefined;
    if (current === undefined) throw new GroupInteractionRepositoryError('INTERACTION_NOT_FOUND');
    if (current.version !== input.expectedVersion) {
      throw new GroupInteractionRepositoryError('INTERACTION_NOT_TRANSITIONABLE');
    }
    const terminating = input.status !== undefined && input.status !== 'active';
    if (terminating && current.status !== 'active') {
      throw new GroupInteractionRepositoryError('INTERACTION_NOT_TRANSITIONABLE');
    }
    const ended = input.status !== undefined && input.status !== 'active' ? (input.endedAt ?? input.updatedAt) : null;
    this.db.prepare(
      `UPDATE cr_group_interactions SET
        reply_count = reply_count + ?,
        hop_count = hop_count + ?,
        status = COALESCE(?, status),
        stop_reason = COALESCE(?, stop_reason),
        loop_guard_signal = COALESCE(?, loop_guard_signal),
        ended_at = COALESCE(?, ended_at),
        version = version + 1, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND version = ?`,
    ).run(
      input.replyIncrement, input.hopIncrement,
      input.status ?? null, input.stopReason ?? null, input.loopGuardSignal ?? null,
      ended, input.updatedAt, input.workspaceId, input.interactionId, input.expectedVersion,
    );
    return this.requireInteraction(input.workspaceId, input.interactionId);
  }

  private assertConversation(workspaceId: string, conversationId: string): void {
    const row = this.db.prepare(
      'SELECT 1 AS present FROM cr_conversations WHERE workspace_id = ? AND id = ?',
    ).get(workspaceId, conversationId);
    if (row === undefined) throw new GroupInteractionRepositoryError('INTERACTION_NOT_FOUND');
  }

  private requireInteraction(workspaceId: string, interactionId: string): GroupInteractionRecord {
    const interaction = this.findInteractionById(workspaceId, interactionId);
    if (interaction === undefined) throw new GroupInteractionRepositoryError('INTERACTION_NOT_FOUND');
    return interaction;
  }

  private publicError(error: unknown): GroupInteractionRepositoryError {
    if (error instanceof GroupInteractionRepositoryError) return error;
    return new GroupInteractionRepositoryError('INTERACTION_INPUT_INVALID');
  }
}

function toInteractionRecord(row: InteractionRow): GroupInteractionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    maxAgentsPerTurn: row.max_agents_per_turn,
    maxRepliesPerAgent: row.max_replies_per_agent,
    maxTotalReplies: row.max_total_replies,
    maxAgentHops: row.max_agent_hops,
    timeoutMs: row.timeout_ms,
    contextTokenBudget: row.context_token_budget,
    replyCount: row.reply_count,
    hopCount: row.hop_count,
    status: row.status as GroupInteractionStatus,
    stopReason: row.stop_reason as GroupStopReason | null,
    loopGuardSignal: row.loop_guard_signal as LoopGuardSignal | null,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
  };
}

function toReplyRecord(row: ReplyRow): GroupReplyRecord {
  return {
    id: row.id,
    interactionId: row.interaction_id,
    agentId: row.agent_id,
    messageId: row.message_id,
    turnId: row.turn_id,
    contentHash: row.content_hash,
    mentionTargetsJson: row.mention_targets_json,
    hopFromAgentId: row.hop_from_agent_id,
    hopOrder: row.hop_order,
    contextSnapshotId: row.context_snapshot_id,
    createdAt: row.created_at,
  };
}

